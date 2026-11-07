/**
 * SMTP Delivery Config router (Feature 44)
 *
 * Provides:
 *   - smtpConfig.get            — return masked config for workspace
 *   - smtpConfig.save           — upsert SMTP config (password AES-256-GCM encrypted)
 *   - smtpConfig.test           — send a test email to the calling user's email
 *   - smtpConfig.sendDraft      — send a single approved draft through deliverEmailDraft (F24)
 *   - smtpConfig.sendBulkApproved — send approved drafts through deliverEmailDraft, oldest first (1/sec, 25 a request)
 */
import { TRPCError } from "@trpc/server";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "crypto";
import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import { z } from "zod";
import {
  emailDrafts,
  emailSuppressions,
  emailTrackingEvents,
  smtpConfigs,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { router } from "../_core/trpc";
import { buildMergeContextFromDb, resolveMergeVars, bodyToHtmlDocument, resolveBookingUrl } from "../mergeVars";
import { areExecutionQueue } from "../../drizzle/schema";
import { assertOutboundNotPaused, isOutboundPaused } from "../services/outboundPause";
import { assertSendAllowed } from "../sendLimits";
import { getWorkspaceTimezone } from "../services/workspaceTimezone";
import { seriesSince, trackingSeries } from "../services/email/trackingSeries";

/**
 * "Send approved" sends at most this many drafts a request, oldest first, one
 * a second (audit 2026-10-20, O16). It took 200, so one request ran for over
 * three minutes: long enough for a proxy to time it out while it kept
 * sending, and for the admin to press it again.
 */
export const BULK_SEND_MAX = 25;
/**
 * Workspaces with a "Send approved" run in progress in this process. A second
 * press, a retried request or a second admin is refused while one runs; the
 * per-draft claim still stops a double send across processes.
 */
const bulkSendRuns = new Set<number>();


/* ─── AES-256-GCM helpers ─────────────────────────────────────────────── */
export function getEncKey(): Buffer {
  const secret = process.env.JWT_SECRET ?? "fallback-dev-secret-32-bytes!!!";
  return Buffer.from(secret.padEnd(32, "0").slice(0, 32));
}
function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}
export function decrypt(ciphertext: string): string {
  const [ivHex, tagHex, encHex] = ciphertext.split(":");
  if (!ivHex || !tagHex || !encHex) throw new Error("Invalid ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", getEncKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(encHex, "hex")).toString("utf8") + decipher.final("utf8");
}

/* ─── Nodemailer transporter factory ─────────────────────────────────── */
export function buildTransporter(cfg: {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.username, pass: cfg.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

/* ─── Sleep helper for rate-limiting ─────────────────────────────────── */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ─── Router ──────────────────────────────────────────────────────────── */
/**
 * One "Send approved" run: up to BULK_SEND_MAX approved drafts, each claimed
 * (approved → sending) right before its own send, with pause and the daily
 * caps asked again before every one (audit 2026-10-20, O16).
 */
async function sendApprovedBatch(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  ctx: { workspace: { id: number }; user: { id: number } },
  input: { draftIds?: number[] },
) {
  /**
   * What a run leaves: drafts still approved, for the next press, and drafts
   * already claimed by a sender. A retry that arrives after a run was cut off
   * finds that run's draft claimed and reports it instead of sending it again.
   */
  const leftOver = async () => {
    const scope = input.draftIds?.length ? inArray(emailDrafts.id, input.draftIds) : undefined;
    const [[approved], [sending]] = await Promise.all([
      db.select({ n: count() }).from(emailDrafts).where(and(eq(emailDrafts.workspaceId, ctx.workspace.id), eq(emailDrafts.status, "approved"), scope)),
      db.select({ n: count() }).from(emailDrafts).where(and(eq(emailDrafts.workspaceId, ctx.workspace.id), eq(emailDrafts.status, "sending"), scope)),
    ]);
    return { remaining: Number(approved?.n ?? 0), inProgress: Number(sending?.n ?? 0) };
  };

  // Approved drafts, oldest first, BULK_SEND_MAX a run.
  const whereClause = input.draftIds?.length
    ? and(eq(emailDrafts.workspaceId, ctx.workspace.id), eq(emailDrafts.status, "approved"), inArray(emailDrafts.id, input.draftIds))
    : and(eq(emailDrafts.workspaceId, ctx.workspace.id), eq(emailDrafts.status, "approved"));
  const drafts = await db
    .select({ id: emailDrafts.id, sendingAccountId: emailDrafts.sendingAccountId })
    .from(emailDrafts)
    .where(whereClause)
    .orderBy(asc(emailDrafts.id))
    .limit(BULK_SEND_MAX);
  if (!drafts.length) return { ok: true, sent: 0, failed: 0, skipped: 0, ...(await leftOver()) };

  // Imported here, not at the top: sequences.ts reaches emailDelivery,
  // which imports this file.
  const { deliverEmailDraft } = await import("./sequences");
  let sent = 0, failed = 0, skipped = 0;
  for (const draft of drafts) {
    // Pause and the daily caps are asked again before EVERY draft (O16):
    // either one ends the run, and what is left stays approved for later.
    // deliverEmailDraft checks the cap of the mailbox it picks as well.
    if (await isOutboundPaused(ctx.workspace.id)) { skipped += drafts.length - (sent + failed + skipped); break; }
    try {
      await assertSendAllowed(ctx.workspace.id, draft.sendingAccountId ?? null);
    } catch {
      skipped += drafts.length - (sent + failed + skipped);
      break;
    }

    try {
      // Claimed from 'approved' only, so a second admin, a retried request
      // or the row's own Send cannot send the same draft again.
      const r = await deliverEmailDraft({ workspaceId: ctx.workspace.id, userId: ctx.user.id, draftId: draft.id, claimFrom: ["approved"] });
      if (r.alreadySent) skipped++;
      else sent++;
    } catch (err) {
      const code = err instanceof TRPCError ? err.code : null;
      const [now] = code === "CONFLICT"
        ? []
        : await db.select({ status: emailDrafts.status }).from(emailDrafts).where(eq(emailDrafts.id, draft.id)).limit(1).catch(() => []);
      if (code === "CONFLICT") skipped++; // another sender has it
      else if (now?.status === "sent") sent++; // sent; only the bookkeeping after it failed
      else if (code === "INTERNAL_SERVER_ERROR") failed++; // the mail server refused or failed it
      else skipped++; // held, suppressed, no address, no mailbox or a cap: nothing was sent
    }

    // Rate limit: 1 email per second
    await sleep(1000);
  }

  return { ok: true, sent, failed, skipped, ...(await leftOver()) };
}

export const smtpConfigRouter = router({
  /** Return the current SMTP config (password masked) */
  get: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [cfg] = await db
      .select()
      .from(smtpConfigs)
      .where(eq(smtpConfigs.workspaceId, ctx.workspace.id));
    if (!cfg) return null;
    return {
      ...cfg,
      encryptedPassword: "••••••••", // never expose ciphertext to frontend
    };
  }),

  /** Upsert SMTP config — password is encrypted before storage */
  save: adminWsProcedure
    .input(
      z.object({
        host: z.string().min(1).max(255),
        port: z.number().int().min(1).max(65535).default(587),
        secure: z.boolean().default(false),
        username: z.string().min(1).max(255),
        /** Pass the raw password; omit to keep existing password unchanged */
        password: z.string().min(1).optional(),
        fromName: z.string().max(120).optional(),
        fromEmail: z.string().email().max(255),
        replyTo: z.string().email().max(255).optional(),
        enabled: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [existing] = await db
        .select()
        .from(smtpConfigs)
        .where(eq(smtpConfigs.workspaceId, ctx.workspace.id));

      // Determine password to store
      let encryptedPassword: string;
      if (input.password) {
        encryptedPassword = encrypt(input.password);
      } else if (existing?.encryptedPassword) {
        encryptedPassword = existing.encryptedPassword;
      } else {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Password is required for new SMTP config" });
      }

      if (existing) {
        await db
          .update(smtpConfigs)
          .set({
            host: input.host,
            port: input.port,
            secure: input.secure,
            username: input.username,
            encryptedPassword,
            fromName: input.fromName ?? null,
            fromEmail: input.fromEmail,
            replyTo: input.replyTo ?? null,
            enabled: input.enabled,
          })
          .where(eq(smtpConfigs.workspaceId, ctx.workspace.id));
      } else {
        await db.insert(smtpConfigs).values({
          workspaceId: ctx.workspace.id,
          host: input.host,
          port: input.port,
          secure: input.secure,
          username: input.username,
          encryptedPassword,
          fromName: input.fromName ?? null,
          fromEmail: input.fromEmail,
          replyTo: input.replyTo ?? null,
          enabled: input.enabled,
        });
      }
      return { ok: true };
    }),

  /** Send a test email to the calling user's email address */
  test: adminWsProcedure
    .input(z.object({ toEmail: z.string().email() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [cfg] = await db
        .select()
        .from(smtpConfigs)
        .where(eq(smtpConfigs.workspaceId, ctx.workspace.id));
      if (!cfg) throw new TRPCError({ code: "NOT_FOUND", message: "No SMTP config found. Save a config first." });

      let password: string;
      try { password = decrypt(cfg.encryptedPassword); }
      catch { throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to decrypt SMTP password" }); }

      const transporter = buildTransporter({ host: cfg.host, port: cfg.port, secure: cfg.secure, username: cfg.username, password });

      try {
        await transporter.sendMail({
          from: cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail,
          to: input.toEmail,
          replyTo: cfg.replyTo ?? undefined,
          subject: "USIP SMTP Test — Connection Verified",
          text: "This is a test email from your USIP SMTP configuration. If you received this, your SMTP settings are working correctly.",
          html: `<p>This is a test email from your <strong>USIP SMTP configuration</strong>.</p><p>If you received this, your SMTP settings are working correctly.</p><p style="color:#888;font-size:12px;">Sent from USIP Sales Intelligence Platform</p>`,
        });
        // Update test status
        await db.update(smtpConfigs).set({ lastTestedAt: new Date(), lastTestStatus: "ok", lastTestError: null })
          .where(eq(smtpConfigs.workspaceId, ctx.workspace.id));
        return { ok: true };
      } catch (err: any) {
        await db.update(smtpConfigs).set({ lastTestedAt: new Date(), lastTestStatus: "error", lastTestError: err?.message ?? "Unknown error" })
          .where(eq(smtpConfigs.workspaceId, ctx.workspace.id));
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `SMTP test failed: ${err?.message}` });
      }
    }),

  /**
   * Send a single approved email draft.
   *
   * ONE delivery path for every draft send (audit 2026-10-20, F24, after O47).
   * This built its own nodemailer transporter from the workspace SMTP config,
   * so the same draft left from a different mailbox, with a different footer
   * and outside the per-mailbox cap, depending on which button sent it. It now
   * goes through deliverEmailDraft, as the row's Send, "Send approved" and
   * auto-send do: the campaign's sender or the sender's own mailbox, the
   * signature, the unsubscribe footer and headers, the tracking switches, the
   * workspace and per-mailbox daily caps, the hold (reply, paused enrolment,
   * paused sequence), suppression, and the claim — taken from 'approved' only,
   * as before, so a second click or "Send approved" cannot send it again.
   */
  sendDraft: workspaceProcedure
    .input(z.object({ draftId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      // Pause all outbound holds person sends too (owner, 2026-10-06: "Block everything").
      await assertOutboundNotPaused(ctx.workspace.id);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [draft] = await db.select({ id: emailDrafts.id, status: emailDrafts.status }).from(emailDrafts)
        .where(and(eq(emailDrafts.id, input.draftId), eq(emailDrafts.workspaceId, ctx.workspace.id)));
      if (!draft) throw new TRPCError({ code: "NOT_FOUND", message: "Draft not found" });
      if (draft.status !== "approved") throw new TRPCError({ code: "BAD_REQUEST", message: "Only approved drafts can be sent" });

      // Imported here, not at the top: sequences.ts reaches emailDelivery,
      // which imports this file.
      const { deliverEmailDraft } = await import("./sequences");
      await deliverEmailDraft({ workspaceId: ctx.workspace.id, userId: ctx.user.id, draftId: draft.id, claimFrom: ["approved"] });
      const [sent] = await db.select({ toEmail: emailDrafts.toEmail }).from(emailDrafts).where(eq(emailDrafts.id, draft.id)).limit(1);
      return { ok: true, sentTo: sent?.toEmail ?? null };
    }),

  /**
   * Send approved drafts for the workspace (or the given ones), oldest first:
   * one a second, BULK_SEND_MAX a request, one run per workspace at a time
   * (audit 2026-10-20, O16).
   *
   * ONE delivery path with the row's Send (audit 2026-10-20, O47). Each draft
   * goes through deliverEmailDraft, as emailDrafts.send does: the same mailbox
   * choice, signature, footer, unsubscribe headers, tracking switches, daily
   * caps, claim and hold. This used to build its own message and send
   * everything through the workspace SMTP config, so the same draft left from
   * a different mailbox with a different footer depending on which button was
   * pressed. It sends the same drafts as before: approved ones, nothing still
   * awaiting review.
   */
  sendBulkApproved: adminWsProcedure
    .input(z.object({ draftIds: z.array(z.number().int()).max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      // Pause all outbound holds person sends too (owner, 2026-10-06: "Block everything").
      await assertOutboundNotPaused(ctx.workspace.id);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // One run per workspace at a time (O16). Checked and taken with no await
      // in between, so two presses cannot both get past it.
      if (bulkSendRuns.has(ctx.workspace.id)) {
        throw new TRPCError({ code: "CONFLICT", message: "Send approved is already running in this workspace. Wait for it to finish, then press it again for what is left." });
      }
      bulkSendRuns.add(ctx.workspace.id);
      try {
        return await sendApprovedBatch(db, ctx, input);
      } finally {
        bulkSendRuns.delete(ctx.workspace.id);
      }
    }),

  /** Get tracking stats (open/click counts + recent events) for a sent draft */
  getTrackingStats: workspaceProcedure
    .input(z.object({ draftId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [draft] = await db
        .select({
          id: emailDrafts.id,
          subject: emailDrafts.subject,
          status: emailDrafts.status,
          sentAt: emailDrafts.sentAt,
          openCount: emailDrafts.openCount,
          clickCount: emailDrafts.clickCount,
          lastOpenedAt: emailDrafts.lastOpenedAt,
          lastClickedAt: emailDrafts.lastClickedAt,
          trackingToken: emailDrafts.trackingToken,
        })
        .from(emailDrafts)
        .where(and(eq(emailDrafts.id, input.draftId), eq(emailDrafts.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!draft) throw new TRPCError({ code: "NOT_FOUND" });
      // Fetch last 20 events
      const events = await db
        .select()
        .from(emailTrackingEvents)
        .where(eq(emailTrackingEvents.draftId, draft.id))
        .orderBy(desc(emailTrackingEvents.createdAt))
        .limit(20);
      return { draft, events };
    }),

  /** Get aggregate tracking stats for all sent drafts in the workspace */
  getTrackingOverview: workspaceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const drafts = await db
        .select({
          id: emailDrafts.id,
          subject: emailDrafts.subject,
          toEmail: emailDrafts.toEmail,
          toContactId: emailDrafts.toContactId,
          sentAt: emailDrafts.sentAt,
          openCount: emailDrafts.openCount,
          clickCount: emailDrafts.clickCount,
          lastOpenedAt: emailDrafts.lastOpenedAt,
          lastClickedAt: emailDrafts.lastClickedAt,
        })
        .from(emailDrafts)
        .where(and(eq(emailDrafts.workspaceId, ctx.workspace.id), eq(emailDrafts.status, "sent")))
        .orderBy(desc(emailDrafts.sentAt))
        .limit(input.limit);
      return drafts;
    }),
  /** Preview a draft with merge vars resolved — no email is sent */
  previewResolved: workspaceProcedure
    .input(z.object({ draftId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [draft] = await db
        .select()
        .from(emailDrafts)
        .where(and(eq(emailDrafts.id, input.draftId), eq(emailDrafts.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!draft) throw new TRPCError({ code: "NOT_FOUND" });

      // Build merge context from DB (contact, lead, or prospect recipient)
      const mergeCtx = await buildMergeContextFromDb({
        contactId: draft.toContactId,
        leadId: draft.toLeadId,
        prospectId: draft.toProspectId,
      });
      // Inject sender info into context. (Was assigned as top-level
      // senderName/senderEmail keys, which buildVarMap never reads — so
      // {{senderName}}/{{senderEmail}} stayed unresolved in previews.)
      mergeCtx.sender = {
        name: ctx.user.name ?? "", email: ctx.user.email ?? "",
        bookingUrl: await resolveBookingUrl(ctx.workspace.id, ctx.user.id),
      };

      const resolvedSubject = resolveMergeVars(draft.subject ?? "", mergeCtx);
      const resolvedBody = resolveMergeVars(draft.body ?? "", mergeCtx);

      // Detect unresolved tokens (still contain {{...}})
      const unresolvedPattern = /\{\{[^}]+\}\}/g;
      const unresolvedInSubject = resolvedSubject.match(unresolvedPattern) ?? [];
      const unresolvedInBody = resolvedBody.match(unresolvedPattern) ?? [];
      const unresolvedTokens = Array.from(new Set([...unresolvedInSubject, ...unresolvedInBody]));

      // Convert to HTML for rendering — format-aware, matching the send path
      // exactly so the preview cannot show a different email than gets sent.
      const htmlBody = bodyToHtmlDocument(resolvedBody);

      return {
        draftId: draft.id,
        originalSubject: draft.subject ?? "",
        originalBody: draft.body ?? "",
        resolvedSubject,
        resolvedBody,
        htmlBody,
        unresolvedTokens,
        contactId: draft.toContactId,
        toEmail: draft.toEmail,
      };
    }),

  /** Time-series opens + clicks for a configurable date range (Feature 53) */
  getTrackingTimeSeries: workspaceProcedure
    .input(z.object({ days: z.number().int().min(7).max(365).default(30) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // The workspace's days, and only the rows that can land in them (audit
      // 2026-10-20, O42): UTC days, over every event the workspace ever had.
      const nowMs = Date.now();
      const tz = await getWorkspaceTimezone(ctx.workspace.id, nowMs);
      const since = seriesSince(input.days, nowMs);

      // Opens + clicks from tracking events
      const events = await db
        .select({ type: emailTrackingEvents.type, createdAt: emailTrackingEvents.createdAt })
        .from(emailTrackingEvents)
        .where(and(eq(emailTrackingEvents.workspaceId, ctx.workspace.id), gte(emailTrackingEvents.createdAt, since)));

      // Daily bounces from emailDrafts.bouncedAt (Feature 59)
      const bouncedDrafts = await db
        .select({ bouncedAt: emailDrafts.bouncedAt })
        .from(emailDrafts)
        .where(and(eq(emailDrafts.workspaceId, ctx.workspace.id), gte(emailDrafts.bouncedAt, since)));

      // Zero-filled for a continuous x-axis.
      return trackingSeries(events, bouncedDrafts, input.days, tz, nowMs);
    }),

  /** Aggregate analytics summary for the workspace */
  getAnalyticsSummary: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const allSent = await db
      .select({
        id: emailDrafts.id,
        sentAt: emailDrafts.sentAt,
        openCount: emailDrafts.openCount,
        clickCount: emailDrafts.clickCount,
      })
      .from(emailDrafts)
      .where(and(eq(emailDrafts.workspaceId, ctx.workspace.id), eq(emailDrafts.status, "sent")));

    // Campaign (ARE) sends live in are_execution_queue, not email_drafts —
    // this summary read drafts only, so the Email Analytics page showed zero
    // for every campaign send while Analytics (fixed 2026-08-26) counted
    // them. Same two-source funnel emailActivity.stats uses; kept in step.
    const [areEng] = await db
      .select({
        sent: sql<number>`count(*)`,
        opened: sql<number>`sum(case when ${areExecutionQueue.openedAt} is not null then 1 else 0 end)`,
      })
      .from(areExecutionQueue)
      .where(and(
        eq(areExecutionQueue.workspaceId, ctx.workspace.id),
        eq(areExecutionQueue.channel, "email"),
        eq(areExecutionQueue.status, "sent"),
      ));
    const areSent = Number(areEng?.sent ?? 0);
    const areOpened = Number(areEng?.opened ?? 0);

    /**
     * Draft-path mail (sequence, CRM, AI drafts) and Revenue Engine mail are
     * counted SEPARATELY, and each rate is over the sends that can produce it
     * (audit 2026-10-20, O42). The click rate divided draft clicks by draft
     * AND campaign sends, though a campaign send records no click of its own,
     * so every campaign email pulled it down; and campaign opens were added
     * to the draft open COUNTER as if they were counts. "Opened" is the same
     * on both paths (opened at least once), so the open rate is still over
     * all sends, as the Emails page computes it.
     */
    const draftSent = allSent.length;
    const totalSent = draftSent + areSent;
    const draftOpened = allSent.filter((d) => (d.openCount ?? 0) > 0).length;
    const uniqueClicked = allSent.filter((d) => (d.clickCount ?? 0) > 0).length;
    const uniqueOpened = draftOpened + areOpened;
    const rate = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);
    // Opens and clicks counted per event: draft-path mail only, the one path with counters.
    const totalOpens = allSent.reduce((s, d) => s + (d.openCount ?? 0), 0);
    const totalClicks = allSent.reduce((s, d) => s + (d.clickCount ?? 0), 0);

    // Daily breakdown for the last 30 workspace days, read for those days only.
    const nowMs = Date.now();
    const tz = await getWorkspaceTimezone(ctx.workspace.id, nowMs);
    const recentEvents = await db
      .select({ type: emailTrackingEvents.type, createdAt: emailTrackingEvents.createdAt })
      .from(emailTrackingEvents)
      .where(and(eq(emailTrackingEvents.workspaceId, ctx.workspace.id), gte(emailTrackingEvents.createdAt, seriesSince(30, nowMs))));
    // Days with activity only, as before.
    const dailyBreakdown = trackingSeries(recentEvents, [], 30, tz, nowMs)
      .filter((p) => p.opens > 0 || p.clicks > 0)
      .map(({ date, opens, clicks }) => ({ date, opens, clicks }));

    return {
      totalSent, draftSent, campaignSent: areSent,
      uniqueOpened, draftOpened, campaignOpened: areOpened,
      openRate: rate(uniqueOpened, totalSent),
      draftOpenRate: rate(draftOpened, draftSent),
      campaignOpenRate: rate(areOpened, areSent),
      uniqueClicked, clickRate: rate(uniqueClicked, draftSent),
      totalOpens, totalClicks, dailyBreakdown,
    };
  }),

  /** Bounce health stats for the workspace (Feature 55) */
  getBounceStats: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    // Count bounced drafts by bounceType
    const bounceTypeRows = await db
      .select({ bounceType: emailDrafts.bounceType, cnt: count(emailDrafts.id) })
      .from(emailDrafts)
      .where(
        and(
          eq(emailDrafts.workspaceId, ctx.workspace.id),
          sql`${emailDrafts.bouncedAt} IS NOT NULL`,
        ),
      )
      .groupBy(emailDrafts.bounceType);

    const byType = Object.fromEntries(bounceTypeRows.map((r) => [r.bounceType ?? "hard", r.cnt]));
    const hardBounces = byType["hard"] ?? 0;
    const softBounces = byType["soft"] ?? 0;
    const spamComplaints = byType["spam"] ?? 0;
    const totalBounced = hardBounces + softBounces + spamComplaints;

    // Total suppressed emails (all reasons)
    const suppressionRows = await db
      .select({ reason: emailSuppressions.reason, cnt: count(emailSuppressions.id) })
      .from(emailSuppressions)
      .where(eq(emailSuppressions.workspaceId, ctx.workspace.id))
      .groupBy(emailSuppressions.reason);
    const suppressedEmails = suppressionRows.reduce((s, r) => s + r.cnt, 0);

    // Total sent for bounce rate — drafts AND campaign mail. ARE sends write
    // no draft row, so on a campaign-heavy workspace the denominator was a
    // fraction of real volume and the bounce rate read several times too high
    // (audit 2026-09-20). The numerator's bounce webhooks resolve campaign
    // bounces into email_suppressions/drafts either way.
    const [sentRow] = await db
      .select({ cnt: count(emailDrafts.id) })
      .from(emailDrafts)
      .where(and(eq(emailDrafts.workspaceId, ctx.workspace.id), eq(emailDrafts.status, "sent")));
    const [areSentRow] = await db
      .select({ cnt: count(areExecutionQueue.id) })
      .from(areExecutionQueue)
      .where(and(eq(areExecutionQueue.workspaceId, ctx.workspace.id), eq(areExecutionQueue.status, "sent")));
    const totalSent = (sentRow?.cnt ?? 0) + (areSentRow?.cnt ?? 0);
    const bounceRate = totalSent > 0 ? Math.round((totalBounced / totalSent) * 1000) / 10 : 0;

    return { hardBounces, softBounces, spamComplaints, totalBounced, totalSent, bounceRate, suppressedEmails };
  }),

});
