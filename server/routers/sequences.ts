import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, activities, campaigns, contacts, emailDrafts, emailReplies, enrollments, leads, senderPoolMembers, sendingAccounts, sequenceAbVariants, sequenceEdges, sequenceNodes, sequences, unipileAccounts, users, workspaces, workspaceSettings } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { getDb } from "../db";
import { createEmailAdapter } from "../emailAdapter";
import { invokeLLM } from "../_core/llm";
import { isSuppressed, makeUnsubscribeUrl } from "../unsubscribe";
import { bumpCampaignCounter } from "../campaignCounters";

/** App base URL for outbound footer links. Same env precedence as Unipile webhook URLs. */
function getAppBaseUrl(): string {
  return (
    process.env.MANUS_APP_URL ||
    process.env.VITE_FRONTEND_FORGE_API_URL ||
    "https://getvelocityai.app"
  ).replace(/\/$/, "");
}

/** Footer block appended to outbound HTML — single unsubscribe link, muted styling. */
function unsubscribeFooterHtml(unsubscribeUrl: string): string {
  return `<p style="margin:32px 0 0;color:#9ca3af;font-size:11px;text-align:center;line-height:1.5">
    Don't want these emails? <a href="${unsubscribeUrl}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a>
  </p>`;
}

/** Footer line appended to outbound plain text. Plain URL is fine — clients auto-link. */
function unsubscribeFooterText(unsubscribeUrl: string): string {
  return `\n\n—\nUnsubscribe: ${unsubscribeUrl}`;
}
import { router } from "../_core/trpc";
import { repProcedure, workspaceProcedure } from "../_core/workspace";

/** Minimal HTML-escaper (duplicated from crm.ts — separate router). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Same anchor wrapper used in crm.ts for click-tracking. */
function escapeHtmlWithLinks(s: string): string {
  const placeholders: Array<{ label: string; url: string }> = [];
  const mdRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const withSentinels = s.replace(mdRe, (_m, label: string, url: string) => {
    const i = placeholders.length;
    placeholders.push({ label, url });
    return `@MD${i}@`;
  });
  let escaped = escapeHtml(withSentinels);
  const urlRe = /(https?:\/\/[^\s<>"']+)/g;
  escaped = escaped.replace(urlRe, (raw) => {
    let url = raw;
    let trailing = "";
    while (/[.,;:)\]!?]$/.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    return `<a href="${url}" style="color:#2563eb;text-decoration:underline">${url}</a>${trailing}`;
  });
  return escaped.replace(/@MD(\d+)@/g, (_m, idxStr: string) => {
    const p = placeholders[Number(idxStr)];
    if (!p) return _m;
    return `<a href="${escapeHtml(p.url)}" style="color:#2563eb;text-decoration:underline">${escapeHtml(p.label)}</a>`;
  });
}

/**
 * Pick a sending account for a sequence/campaign-driven draft based on
 * the campaign's configured senderType + rotation strategy. Returns
 * null if the draft isn't sequence-bound or no live campaign owns its
 * sequence — caller then falls back to personal mailbox / workspace
 * default.
 *
 * Rotation strategies (current implementation):
 *   round_robin → pick the pool member with the LOWEST sent-today
 *                 count (naturally rotates without separate state).
 *   weighted    → weighted random by senderPoolMembers.weight.
 *   random      → uniform random across enabled members.
 *
 * Per-account dailySendLimit IS enforced — accounts at or above their
 * limit are skipped. The "lowest count" round-robin reads sentToday
 * via a one-shot count query against email_drafts so we don't need a
 * separate counter table.
 */
async function pickAccountForSequenceDraft(
  db: Awaited<ReturnType<typeof getDb>>,
  workspaceId: number,
  sequenceId: number,
): Promise<typeof sendingAccounts.$inferSelect | null> {
  if (!db) return null;

  // Find the most recent live/scheduled campaign that uses this sequence.
  const [camp] = await db
    .select({
      senderType: campaigns.senderType,
      sendingAccountId: campaigns.sendingAccountId,
      senderPoolId: campaigns.senderPoolId,
      rotationStrategy: campaigns.rotationStrategy,
    })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.workspaceId, workspaceId),
        eq(campaigns.sequenceId, sequenceId),
        inArray(campaigns.status, ["live", "scheduled"]),
      ),
    )
    .orderBy(desc(campaigns.id))
    .limit(1);

  if (!camp) return null;

  // senderType=account: just use it.
  if (camp.senderType === "account" && camp.sendingAccountId) {
    const [acct] = await db
      .select()
      .from(sendingAccounts)
      .where(
        and(
          eq(sendingAccounts.id, camp.sendingAccountId),
          eq(sendingAccounts.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return acct ?? null;
  }

  // senderType=pool: pick a member per the campaign's rotation strategy.
  if (camp.senderType === "pool" && camp.senderPoolId) {
    const members = await db
      .select({
        accountId: senderPoolMembers.accountId,
        weight: senderPoolMembers.weight,
        position: senderPoolMembers.position,
      })
      .from(senderPoolMembers)
      .where(eq(senderPoolMembers.poolId, camp.senderPoolId));
    if (members.length === 0) return null;

    const accountIds = members.map((m) => m.accountId);
    const accountRows = await db
      .select()
      .from(sendingAccounts)
      .where(
        and(
          eq(sendingAccounts.workspaceId, workspaceId),
          inArray(sendingAccounts.id, accountIds),
          eq(sendingAccounts.enabled, true),
        ),
      );
    if (accountRows.length === 0) return null;

    // Today's send count per account (drafts sent today with that account).
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const sentTodayRows = await db
      .select({
        accountId: emailDrafts.sendingAccountId,
        cnt: sql<number>`COUNT(*)`,
      })
      .from(emailDrafts)
      .where(
        and(
          eq(emailDrafts.workspaceId, workspaceId),
          eq(emailDrafts.status, "sent"),
          inArray(emailDrafts.sendingAccountId, accountIds),
          sql`${emailDrafts.sentAt} >= ${todayStart}`,
        ),
      )
      .groupBy(emailDrafts.sendingAccountId);
    const sentToday = new Map(sentTodayRows.map((r) => [r.accountId, Number(r.cnt) || 0]));

    // Filter out accounts at/over their dailySendLimit.
    const eligible = accountRows.filter((a) => {
      const used = sentToday.get(a.id) ?? 0;
      return used < (a.dailySendLimit ?? 500);
    });
    if (eligible.length === 0) {
      console.warn(
        `[pickAccountForSequenceDraft] all pool ${camp.senderPoolId} members at/over daily limit`,
      );
      return null;
    }

    const strat = camp.rotationStrategy ?? "round_robin";

    if (strat === "random") {
      return eligible[Math.floor(Math.random() * eligible.length)];
    }
    if (strat === "weighted") {
      const memberWeight = new Map(members.map((m) => [m.accountId, m.weight]));
      const totalW = eligible.reduce(
        (s, a) => s + (memberWeight.get(a.id) ?? 10),
        0,
      );
      let pick = Math.random() * totalW;
      for (const a of eligible) {
        pick -= memberWeight.get(a.id) ?? 10;
        if (pick <= 0) return a;
      }
      return eligible[eligible.length - 1];
    }
    // round_robin: lowest sent-today count (ties broken by position).
    const memberPosition = new Map(members.map((m) => [m.accountId, m.position]));
    eligible.sort((a, b) => {
      const aSent = sentToday.get(a.id) ?? 0;
      const bSent = sentToday.get(b.id) ?? 0;
      if (aSent !== bSent) return aSent - bSent;
      return (memberPosition.get(a.id) ?? 0) - (memberPosition.get(b.id) ?? 0);
    });
    return eligible[0];
  }

  return null;
}

/** Merge-field renderer (same forgiving matcher as crm.ts). */
function renderMergeFields(template: string, vars: Record<string, string | null | undefined>): string {
  if (!template) return template;
  const norm = (s: string) => s.toLowerCase().replace(/[_\s]/g, "");
  const lookup = new Map<string, string>();
  for (const [k, v] of Object.entries(vars)) {
    if (v == null) continue;
    lookup.set(norm(k), v);
  }
  return template.replace(/\{\{\s*([a-zA-Z0-9_\s]+?)\s*\}\}/g, (match, name: string) => {
    const hit = lookup.get(norm(name));
    return hit ?? match;
  });
}

const stepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("email"), subject: z.string(), body: z.string().optional() }),
  z.object({ type: z.literal("wait"), days: z.number().int().min(0).max(60) }),
  z.object({ type: z.literal("task"), body: z.string() }),
  z.object({ type: z.literal("linkedin_dm"), body: z.string().optional() }),
  z.object({ type: z.literal("linkedin_invite"), note: z.string().optional() }),
]);

export const sequencesRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(sequences).where(eq(sequences.workspaceId, ctx.workspace.id)).orderBy(desc(sequences.updatedAt));
  }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db.select().from(sequences).where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
    return row ?? null;
  }),

  create: repProcedure.input(z.object({ name: z.string().min(1), description: z.string().optional(), steps: z.array(stepSchema).default([]) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const r = await db.insert(sequences).values({ ...input, workspaceId: ctx.workspace.id, ownerUserId: ctx.user.id, status: "draft" });
    return { id: Number((r as any)[0]?.insertId ?? 0) };
  }),

  update: repProcedure.input(z.object({
    id: z.number(),
    patch: z.record(z.string(), z.any()),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(sequences).set(input.patch).where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
  updateMeta: repProcedure.input(z.object({
    id: z.number(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().optional(),
    dailyCap: z.number().int().min(1).max(10000).nullable().optional(),
    exitConditions: z.array(z.object({ type: z.enum(["reply","bounce","unsubscribe","goal_met","manual"]), enabled: z.boolean() })).optional(),
    settings: z.object({
      timezone: z.string().optional(),
      sendWindowStart: z.string().optional(),
      sendWindowEnd: z.string().optional(),
      skipWeekends: z.boolean().optional(),
      replyDetection: z.boolean().optional(),
    }).optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const { id, ...patch } = input;
    await db.update(sequences).set(patch).where(and(eq(sequences.id, id), eq(sequences.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
  updateSteps: repProcedure.input(z.object({
    id: z.number(),
    steps: z.array(stepSchema),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [seq] = await db.select().from(sequences).where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
    if (!seq) throw new TRPCError({ code: "NOT_FOUND" });
    // Steps are editable in draft + paused states. Pausing is precisely
    // the lever a user pulls when they want to make changes safely
    // without new sends going out. Only block while actively running
    // (status=active) or after archival.
    if (seq.status === "active" || seq.status === "archived") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot edit steps while sequence is running. Pause it first." });
    }
    await db.update(sequences).set({ steps: input.steps, updatedAt: new Date() }).where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(sequences).where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  setStatus: repProcedure.input(z.object({ id: z.number(), status: z.enum(["draft", "active", "paused", "archived"]) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(sequences).set({ status: input.status }).where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /* ── Canvas ── */
  getCanvas: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return { nodes: [], edges: [] };
    const [nodes, edges] = await Promise.all([
      db.select().from(sequenceNodes).where(and(eq(sequenceNodes.sequenceId, input.id), eq(sequenceNodes.workspaceId, ctx.workspace.id))),
      db.select().from(sequenceEdges).where(and(eq(sequenceEdges.sequenceId, input.id), eq(sequenceEdges.workspaceId, ctx.workspace.id))),
    ]);
    return { nodes, edges };
  }),

  saveCanvas: repProcedure
    .input(z.object({
      id: z.number(),
      nodes: z.array(z.object({
        id: z.string(),
        type: z.enum(["start", "email", "wait", "condition", "action", "goal", "linkedin_dm", "linkedin_invite"]),
        positionX: z.number(),
        positionY: z.number(),
        data: z.record(z.string(), z.any()),
      })),
      edges: z.array(z.object({
        id: z.string(),
        source: z.string(),
        target: z.string(),
        sourceHandle: z.string().nullable().optional(),
        label: z.string().nullable().optional(),
      })),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Verify sequence belongs to workspace
      const [seq] = await db.select().from(sequences).where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
      if (!seq) throw new TRPCError({ code: "NOT_FOUND" });
      // Canvas is editable in draft + paused states; paused means the
      // user explicitly stopped sending to make changes. Only running or
      // archived sequences are locked.
      if (seq.status === "active" || seq.status === "archived") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot edit canvas while sequence is running. Pause it first." });
      }
      // Replace all nodes + edges atomically
      await db.delete(sequenceNodes).where(and(eq(sequenceNodes.sequenceId, input.id), eq(sequenceNodes.workspaceId, ctx.workspace.id)));
      await db.delete(sequenceEdges).where(and(eq(sequenceEdges.sequenceId, input.id), eq(sequenceEdges.workspaceId, ctx.workspace.id)));
      if (input.nodes.length > 0) {
        await db.insert(sequenceNodes).values(input.nodes.map((n) => ({
          id: n.id,
          sequenceId: input.id,
          workspaceId: ctx.workspace.id,
          type: n.type,
          positionX: n.positionX,
          positionY: n.positionY,
          data: n.data,
        })));
      }
      if (input.edges.length > 0) {
        await db.insert(sequenceEdges).values(input.edges.map((e) => ({
          id: e.id,
          sequenceId: input.id,
          workspaceId: ctx.workspace.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle ?? null,
          label: e.label ?? null,
        })));
      }
      // updatedAt write must be scoped to workspace too — the earlier
      // ownership check filters the SELECT, but the final UPDATE was
      // running unscoped, which is a latent cross-tenant write risk.
      await db
        .update(sequences)
        .set({ updatedAt: new Date() })
        .where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  /* ── Enrollments ── */
  listEnrollments: workspaceProcedure.input(z.object({ sequenceId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db.select().from(enrollments).where(eq(enrollments.workspaceId, ctx.workspace.id));
    return input?.sequenceId ? rows.filter((r) => r.sequenceId === input.sequenceId) : rows;
  }),

  enroll: repProcedure.input(z.object({ sequenceId: z.number(), contactId: z.number().optional(), leadId: z.number().optional() })).mutation(async ({ ctx, input }) => {
    if (!input.contactId && !input.leadId) throw new TRPCError({ code: "BAD_REQUEST", message: "contactId or leadId required" });
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    // Enrollment guard: block contacts with invalid email if workspace setting is enabled
    if (input.contactId) {
      const [settings] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      if (settings?.blockInvalidEmailsFromSequences) {
        const [contact] = await db.select().from(contacts).where(and(eq(contacts.id, input.contactId), eq(contacts.workspaceId, ctx.workspace.id)));
        if (contact?.emailVerificationStatus === "invalid") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This contact has an invalid email address and is blocked from sequence enrollment. Verify or update their email to proceed." });
        }
      }
    }
    await db.insert(enrollments).values({
      workspaceId: ctx.workspace.id,
      sequenceId: input.sequenceId,
      contactId: input.contactId ?? null,
      leadId: input.leadId ?? null,
      status: "active",
      currentStep: 0,
      nextActionAt: new Date(),
    });
    return { ok: true };
  }),

  pauseEnrollment: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(enrollments).set({ status: "paused" }).where(and(eq(enrollments.id, input.id), eq(enrollments.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  resumeEnrollment: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(enrollments).set({ status: "active", nextActionAt: new Date() }).where(and(eq(enrollments.id, input.id), eq(enrollments.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  exitEnrollment: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(enrollments).set({ status: "exited" }).where(and(eq(enrollments.id, input.id), eq(enrollments.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  pauseOnReply: repProcedure.input(z.object({ enrollmentId: z.number() })).mutation(async ({ ctx, input }) => {
    const { pauseOnReply } = await import("../sequenceEngine");
    await pauseOnReply(input.enrollmentId, ctx.workspace.id);
    return { ok: true };
  }),

  getEnrollmentStats: workspaceProcedure.input(z.object({ sequenceId: z.number() })).query(async ({ ctx, input }) => {
    const { getEnrollmentStats } = await import("../sequenceEngine");
    return getEnrollmentStats(input.sequenceId, ctx.workspace.id);
  }),

  getEnrollmentStepStats: workspaceProcedure.input(z.object({ sequenceId: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db.select().from(enrollments).where(and(eq(enrollments.sequenceId, input.sequenceId), eq(enrollments.workspaceId, ctx.workspace.id)));
    // Count by currentStep
    const stepCounts: Record<number, number> = {};
    for (const r of rows) {
      stepCounts[r.currentStep] = (stepCounts[r.currentStep] ?? 0) + 1;
    }
    return Object.entries(stepCounts).map(([step, count]) => ({ step: Number(step), count }));
  }),

  /** Sequence performance analytics: open rate, click rate, reply rate, opt-out rate per sequence. */
  getPerformanceAnalytics: workspaceProcedure
    .input(z.object({
      sequenceId: z.number().optional(),
      /** ISO date string YYYY-MM-DD — filter emails sent on or after this date */
      dateFrom: z.string().optional(),
      /** ISO date string YYYY-MM-DD — filter emails sent on or before this date */
      dateTo: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const wsId = ctx.workspace.id;
      const fromTs = input.dateFrom ? new Date(input.dateFrom).getTime() : null;
      const toTs = input.dateTo ? new Date(input.dateTo + "T23:59:59Z").getTime() : null;

      // Get all sequences in workspace
      const seqRows = await db.select().from(sequences).where(eq(sequences.workspaceId, wsId));
      const targetSeqs = input.sequenceId ? seqRows.filter((s) => s.id === input.sequenceId) : seqRows;

      const results = await Promise.all(targetSeqs.map(async (seq) => {
        // Get all email drafts for this sequence, filtered by sent date range if provided
        let drafts = await db.select().from(emailDrafts).where(and(eq(emailDrafts.sequenceId, seq.id), eq(emailDrafts.workspaceId, wsId)));
        if (fromTs !== null) drafts = drafts.filter((d) => d.sentAt !== null && new Date(d.sentAt).getTime() >= fromTs);
        if (toTs !== null) drafts = drafts.filter((d) => d.sentAt !== null && new Date(d.sentAt).getTime() <= toTs);
        const sent = drafts.filter((d) => d.status === "sent").length;
        const totalOpens = drafts.reduce((s, d) => s + (d.openCount ?? 0), 0);
        const totalClicks = drafts.reduce((s, d) => s + (d.clickCount ?? 0), 0);
        const bounced = drafts.filter((d) => d.bouncedAt !== null).length;
        // Count unique opens (drafts with at least one open)
        const uniqueOpens = drafts.filter((d) => (d.openCount ?? 0) > 0).length;
        // Count unique clicks
        const uniqueClicks = drafts.filter((d) => (d.clickCount ?? 0) > 0).length;

        // Enrollment stats
        const enrs = await db.select().from(enrollments).where(and(eq(enrollments.sequenceId, seq.id), eq(enrollments.workspaceId, wsId)));
        const totalEnrolled = enrs.length;
        const active = enrs.filter((e) => e.status === "active").length;
        const finished = enrs.filter((e) => e.status === "finished").length;
        const exited = enrs.filter((e) => e.status === "exited").length;
        const paused = enrs.filter((e) => e.status === "paused").length;

        // Rates (based on sent emails)
        const openRate = sent > 0 ? Math.round((uniqueOpens / sent) * 100) : 0;
        const clickRate = sent > 0 ? Math.round((uniqueClicks / sent) * 100) : 0;
        const bounceRate = sent > 0 ? Math.round((bounced / sent) * 100) : 0;
        const exitRate = totalEnrolled > 0 ? Math.round((exited / totalEnrolled) * 100) : 0;

        return {
          sequenceId: seq.id,
          sequenceName: seq.name,
          status: seq.status,
          totalEnrolled,
          active,
          finished,
          exited,
          paused,
          sent,
          uniqueOpens,
          uniqueClicks,
          bounced,
          totalOpens,
          totalClicks,
          openRate,
          clickRate,
          bounceRate,
          exitRate,
        };
      }));

      return results;
    }),

  /**
   * Per-step performance breakdown for a single sequence.
   * Groups drafts by stepIndex (populated by the engine at insert time)
   * and rolls up sent / opens / clicks / bounces / replies + their rates.
   *
   * Drafts created before migration 0063 have stepIndex=null and are
   * bucketed under a synthetic "(unknown step)" entry so old data still
   * shows up but stays visually distinct.
   */
  getStepAnalytics: workspaceProcedure
    .input(z.object({ sequenceId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [seq] = await db
        .select()
        .from(sequences)
        .where(and(eq(sequences.id, input.sequenceId), eq(sequences.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!seq) throw new TRPCError({ code: "NOT_FOUND" });
      const steps = (seq.steps as Array<{ type: string; subject?: string }>) ?? [];

      const drafts = await db
        .select({
          stepIndex: emailDrafts.stepIndex,
          status: emailDrafts.status,
          openCount: emailDrafts.openCount,
          clickCount: emailDrafts.clickCount,
          bouncedAt: emailDrafts.bouncedAt,
          toEmail: emailDrafts.toEmail,
        })
        .from(emailDrafts)
        .where(
          and(
            eq(emailDrafts.workspaceId, ctx.workspace.id),
            eq(emailDrafts.sequenceId, seq.id),
          ),
        );

      // Build per-step rollup. -1 sentinel = legacy drafts with no stepIndex.
      const byStep = new Map<number, {
        sent: number; uniqueOpens: number; uniqueClicks: number;
        totalOpens: number; totalClicks: number; bounced: number; replied: number;
      }>();

      for (const d of drafts) {
        const idx = d.stepIndex ?? -1;
        const bucket = byStep.get(idx) ?? {
          sent: 0, uniqueOpens: 0, uniqueClicks: 0,
          totalOpens: 0, totalClicks: 0, bounced: 0, replied: 0,
        };
        if (d.status === "sent") bucket.sent += 1;
        const oc = d.openCount ?? 0;
        const cc = d.clickCount ?? 0;
        bucket.totalOpens += oc;
        bucket.totalClicks += cc;
        if (oc > 0) bucket.uniqueOpens += 1;
        if (cc > 0) bucket.uniqueClicks += 1;
        if (d.bouncedAt) bucket.bounced += 1;
        byStep.set(idx, bucket);
      }

      // Reply counts via email_replies — match by draftId via the matched
      // drafts (rather than re-querying, just count rows whose draftId
      // links to one of our drafts). Cheap one-shot query.
      const draftIds = (await db
        .select({ id: emailDrafts.id, stepIndex: emailDrafts.stepIndex })
        .from(emailDrafts)
        .where(
          and(
            eq(emailDrafts.workspaceId, ctx.workspace.id),
            eq(emailDrafts.sequenceId, seq.id),
          ),
        ));
      const idToStep = new Map(draftIds.map((d) => [d.id, d.stepIndex ?? -1]));
      if (draftIds.length > 0) {
        const replyRows = await db
          .select({ draftId: emailReplies.draftId })
          .from(emailReplies)
          .where(
            and(
              eq(emailReplies.workspaceId, ctx.workspace.id),
              inArray(
                emailReplies.draftId,
                draftIds.map((d) => d.id),
              ),
            ),
          );
        for (const r of replyRows) {
          if (r.draftId == null) continue;
          const step = idToStep.get(r.draftId);
          if (step === undefined) continue;
          const bucket = byStep.get(step);
          if (bucket) bucket.replied += 1;
        }
      }

      // Output: one row per defined step in the sequence + a row for
      // legacy/unknown drafts when applicable. Always emit a row for
      // each step (even with all zeros) so the UI can render the full
      // ladder. AB variants are skipped in this pass — separate query.
      const out: Array<{
        stepIndex: number;
        stepType: string;
        stepLabel: string;
        sent: number;
        uniqueOpens: number;
        uniqueClicks: number;
        bounced: number;
        replied: number;
        openRate: number;
        clickRate: number;
        replyRate: number;
        bounceRate: number;
      }> = [];

      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const b = byStep.get(i) ?? {
          sent: 0, uniqueOpens: 0, uniqueClicks: 0,
          totalOpens: 0, totalClicks: 0, bounced: 0, replied: 0,
        };
        out.push({
          stepIndex: i,
          stepType: s?.type ?? "unknown",
          stepLabel: s?.type === "email" ? (s.subject ?? `Email step ${i + 1}`) : `${s?.type ?? "?"} step ${i + 1}`,
          sent: b.sent,
          uniqueOpens: b.uniqueOpens,
          uniqueClicks: b.uniqueClicks,
          bounced: b.bounced,
          replied: b.replied,
          openRate: b.sent > 0 ? Math.round((b.uniqueOpens / b.sent) * 100) : 0,
          clickRate: b.sent > 0 ? Math.round((b.uniqueClicks / b.sent) * 100) : 0,
          replyRate: b.sent > 0 ? Math.round((b.replied / b.sent) * 100) : 0,
          bounceRate: b.sent > 0 ? Math.round((b.bounced / b.sent) * 100) : 0,
        });
      }

      const legacy = byStep.get(-1);
      if (legacy && legacy.sent > 0) {
        out.push({
          stepIndex: -1,
          stepType: "unknown",
          stepLabel: "(legacy / pre-0063 drafts)",
          sent: legacy.sent,
          uniqueOpens: legacy.uniqueOpens,
          uniqueClicks: legacy.uniqueClicks,
          bounced: legacy.bounced,
          replied: legacy.replied,
          openRate: legacy.sent > 0 ? Math.round((legacy.uniqueOpens / legacy.sent) * 100) : 0,
          clickRate: legacy.sent > 0 ? Math.round((legacy.uniqueClicks / legacy.sent) * 100) : 0,
          replyRate: legacy.sent > 0 ? Math.round((legacy.replied / legacy.sent) * 100) : 0,
          bounceRate: legacy.sent > 0 ? Math.round((legacy.bounced / legacy.sent) * 100) : 0,
        });
      }

      return { sequenceId: seq.id, sequenceName: seq.name, steps: out };
    }),
});

/* ─── Email Drafts ────────────────────────────────────────────────────── */

/**
 * Send an emailDrafts row through the EmailAdapter — the unified
 * delivery path for both the manual Approve & Send button and the
 * auto-send worker.
 *
 * Behavior:
 *  - Resolves recipient (draft.toEmail → linked contact → linked lead).
 *  - Resolves sending account (campaign pool if sequence-bound → rep's
 *    bridged personal Unipile mailbox → any workspace SMTP fallback).
 *  - Renders merge fields, prefers per-user signature over workspace
 *    default, anchor-wraps URLs for click tracking.
 *  - Opts in to Unipile open/click tracking and persists the returned
 *    tracking_id on emailDrafts.trackingToken.
 *  - Updates emailDrafts row + writes a Timeline activity on the
 *    linked record + audit log.
 *  - Returns alreadySent:true (without re-sending) for already-sent drafts.
 *  - Throws TRPCError on hard failures (no recipient, no account, etc.)
 *    so the manual mutation surfaces it; the auto-send worker catches.
 *
 * `userId` is the actor — the manual path passes ctx.user.id; the
 * auto-send worker passes draft.createdByUserId.
 */
export async function deliverEmailDraft(params: {
  workspaceId: number;
  userId: number;
  draftId: number;
}): Promise<{ ok: true; messageId?: string; alreadySent?: boolean; sentAt?: Date | null }> {
  const { workspaceId, userId, draftId } = params;
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  const [draft] = await db
    .select()
    .from(emailDrafts)
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.workspaceId, workspaceId)))
    .limit(1);
  if (!draft) throw new TRPCError({ code: "NOT_FOUND" });
  if (draft.status === "sent") {
    return { ok: true, alreadySent: true, sentAt: draft.sentAt };
  }

  // ── Resolve recipient ─────────────────────────────────────────────
  let toEmail = draft.toEmail ?? null;
  let firstName: string | null = null;
  let lastName: string | null = null;
  let title: string | null = null;
  let company: string | null = null;
  if (!toEmail && draft.toContactId) {
    const [c] = await db
      .select({
        email: contacts.email,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        title: contacts.title,
        accountName: accounts.name,
      })
      .from(contacts)
      .leftJoin(accounts, eq(accounts.id, contacts.accountId))
      .where(and(eq(contacts.id, draft.toContactId), eq(contacts.workspaceId, workspaceId)))
      .limit(1);
    if (c) {
      toEmail = c.email ?? null;
      firstName = c.firstName ?? null;
      lastName = c.lastName ?? null;
      title = c.title ?? null;
      company = c.accountName ?? null;
    }
  } else if (!toEmail && draft.toLeadId) {
    const [l] = await db
      .select()
      .from(leads)
      .where(and(eq(leads.id, draft.toLeadId), eq(leads.workspaceId, workspaceId)))
      .limit(1);
    if (l) {
      toEmail = l.email ?? null;
      firstName = l.firstName ?? null;
      lastName = l.lastName ?? null;
      title = l.title ?? null;
      company = l.company ?? null;
    }
  } else if (draft.toContactId) {
    const [c] = await db
      .select({
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        title: contacts.title,
        accountName: accounts.name,
      })
      .from(contacts)
      .leftJoin(accounts, eq(accounts.id, contacts.accountId))
      .where(and(eq(contacts.id, draft.toContactId), eq(contacts.workspaceId, workspaceId)))
      .limit(1);
    if (c) {
      firstName = c.firstName ?? null;
      lastName = c.lastName ?? null;
      title = c.title ?? null;
      company = c.accountName ?? null;
    }
  } else if (draft.toLeadId) {
    const [l] = await db
      .select({
        firstName: leads.firstName,
        lastName: leads.lastName,
        title: leads.title,
        company: leads.company,
      })
      .from(leads)
      .where(and(eq(leads.id, draft.toLeadId), eq(leads.workspaceId, workspaceId)))
      .limit(1);
    if (l) {
      firstName = l.firstName ?? null;
      lastName = l.lastName ?? null;
      title = l.title ?? null;
      company = l.company ?? null;
    }
  }
  if (!toEmail) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Draft has no recipient email and the linked contact/lead has none either.",
    });
  }

  // ── Suppression check ────────────────────────────────────────────
  // Don't send to recipients who unsubscribed, bounced, or were
  // manually added to email_suppressions. Mark the draft rejected so
  // it falls out of the pending queue and surfaces the reason in audit.
  if (await isSuppressed(workspaceId, toEmail)) {
    await db
      .update(emailDrafts)
      .set({ status: "rejected", reviewedByUserId: userId })
      .where(eq(emailDrafts.id, draft.id));
    await recordAudit({
      workspaceId,
      actorUserId: userId,
      action: "update",
      entityType: "email_draft",
      entityId: draft.id,
      after: { deliveryStatus: "suppressed", recipient: toEmail, reason: "on email_suppressions list" },
    });
    console.log(`[deliverEmailDraft] draft ${draft.id} → suppressed (${toEmail})`);
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Recipient ${toEmail} has unsubscribed or is on the suppression list. Draft marked rejected.`,
    });
  }

  // ── Resolve sending account ──────────────────────────────────────
  let fromAccount: typeof sendingAccounts.$inferSelect | undefined;
  if (draft.sequenceId) {
    const picked = await pickAccountForSequenceDraft(db, workspaceId, draft.sequenceId);
    if (picked) {
      fromAccount = picked;
      console.log(
        `[deliverEmailDraft] draft ${draft.id} sequence ${draft.sequenceId} → pool/account ${picked.id} (${picked.fromEmail})`,
      );
    }
  }
  if (!fromAccount) {
    const [personal] = await db
      .select({ sa: sendingAccounts })
      .from(sendingAccounts)
      .innerJoin(unipileAccounts, eq(sendingAccounts.unipileAccountId, unipileAccounts.unipileAccountId))
      .where(
        and(
          eq(sendingAccounts.workspaceId, workspaceId),
          eq(unipileAccounts.userId, userId),
          isNotNull(sendingAccounts.unipileAccountId),
        ),
      )
      .limit(1);
    if (personal) fromAccount = personal.sa;
  }
  if (!fromAccount) {
    const [fallback] = await db
      .select()
      .from(sendingAccounts)
      .where(eq(sendingAccounts.workspaceId, workspaceId))
      .limit(1);
    if (fallback) fromAccount = fallback;
  }
  if (!fromAccount) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "No sending account available. Connect your mailbox or have an admin add a workspace SMTP.",
    });
  }
  const adapter = createEmailAdapter(fromAccount);

  // Sender + signature precedence (user → workspace).
  const [senderRow] = await db
    .select({ name: users.name, email: users.email, emailSignature: users.emailSignature })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const senderName = senderRow?.name ?? fromAccount.fromName ?? fromAccount.name ?? "";
  const senderEmail = senderRow?.email ?? fromAccount.fromEmail ?? "";
  const [wsSettings] = await db
    .select({ emailSignature: workspaceSettings.emailSignature })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  const userSignature = senderRow?.emailSignature?.trim() ?? "";
  const sig =
    userSignature.length > 0 ? userSignature : (wsSettings?.emailSignature ?? "").trim();
  const bodyMentionsSignatureToken = /\{\{\s*signature\s*\}\}/i.test(draft.body ?? "");

  // Render merge fields.
  const mergeVars: Record<string, string> = {
    firstName: firstName ?? "",
    lastName: lastName ?? "",
    fullName: [firstName, lastName].filter(Boolean).join(" "),
    email: toEmail,
    title: title ?? "",
    company: company ?? "",
    accountName: company ?? "",
    senderName,
    senderEmail,
    signature: sig,
  };
  const renderedSubject = renderMergeFields(draft.subject ?? "", mergeVars);
  const mergeVarsNoSig = { ...mergeVars, signature: "" };
  const renderedBody = renderMergeFields(draft.body ?? "", mergeVarsNoSig);
  const renderedBodyText = bodyMentionsSignatureToken
    ? renderMergeFields(draft.body ?? "", mergeVars)
    : sig
      ? `${renderedBody.replace(/\s+$/, "")}\n\n${sig}`
      : renderedBody;
  const bodyHtmlBlock = renderedBody
    .split("\n")
    .map((line) => `<p style="margin:0 0 8px">${escapeHtmlWithLinks(line)}</p>`)
    .join("");
  const sigHtmlBlock = sig
    ? `<div style="margin-top:18px;color:#555;line-height:1.4">${sig.split("\n").map(escapeHtml).join("<br>")}</div>`
    : "";
  // Compliance footer — single tracked unsubscribe link per recipient.
  // Idempotent token (workspaceId + email + HMAC), so resending the same
  // draft produces the same URL.
  const unsubscribeUrl = makeUnsubscribeUrl(getAppBaseUrl(), workspaceId, toEmail);
  const unsubFooterHtml = unsubscribeFooterHtml(unsubscribeUrl);
  const fullBodyHtml = bodyHtmlBlock + sigHtmlBlock + unsubFooterHtml;
  const fullBodyText = renderedBodyText + unsubscribeFooterText(unsubscribeUrl);

  // ── Deliver ──────────────────────────────────────────────────────
  let sentMessageId: string | undefined;
  let deliveryError: string | undefined;
  try {
    const sendRes = await adapter.sendEmail({
      fromEmail: fromAccount.fromEmail,
      fromName: fromAccount.fromName ?? fromAccount.name,
      to: toEmail,
      subject: renderedSubject,
      bodyHtml: fullBodyHtml,
      bodyText: fullBodyText,
      track: true,
    });
    sentMessageId = sendRes.messageId;
  } catch (err) {
    deliveryError = err instanceof Error ? err.message : String(err);
    console.error(
      `[deliverEmailDraft] delivery failed for draft ${draft.id} (${toEmail}): ${deliveryError}`,
    );
  }

  if (sentMessageId) {
    await db
      .update(emailDrafts)
      .set({
        status: "sent",
        subject: renderedSubject,
        body: renderedBodyText,
        sentAt: new Date(),
        reviewedByUserId: userId,
        trackingToken: sentMessageId.slice(0, 64),
        toEmail,
        sendingAccountId: fromAccount.id,
      })
      .where(eq(emailDrafts.id, draft.id));

    const relatedType = draft.toContactId ? "contact" : draft.toLeadId ? "lead" : null;
    const relatedId = draft.toContactId ?? draft.toLeadId;
    if (relatedType && relatedId) {
      await db.insert(activities).values({
        workspaceId,
        type: "email",
        relatedType,
        relatedId,
        subject: renderedSubject,
        body: renderedBodyText,
        actorUserId: userId,
        occurredAt: new Date(),
      });
    }

    // Bump campaign totalSent if this draft belongs to a campaign-driven
    // sequence. Silently no-ops for ad-hoc / unparented drafts.
    if (draft.sequenceId) {
      await bumpCampaignCounter(workspaceId, draft.sequenceId, "totalSent");
    }
  }

  await recordAudit({
    workspaceId,
    actorUserId: userId,
    action: "update",
    entityType: "email_draft",
    entityId: draft.id,
    after: {
      deliveryStatus: sentMessageId ? "sent" : "failed",
      messageId: sentMessageId,
      fromAccountId: fromAccount.id,
      fromAccountName: fromAccount.name,
      fromAccountEmail: fromAccount.fromEmail,
      error: deliveryError,
    },
  });

  if (!sentMessageId) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: deliveryError ?? "Unknown delivery error",
    });
  }
  return { ok: true, messageId: sentMessageId };
}

/**
 * Worker: scan each workspace with aiAutoSendEnabled=true and dispatch
 * any sequence-bound pending_review drafts whose recipient meets the
 * configured score threshold.
 *
 * Eligibility per draft:
 *   - status = "pending_review"
 *   - aiGenerated = true (only auto-send AI work, not human drafts)
 *   - sequenceId IS NOT NULL (only outreach paths, not ad-hoc compose)
 *   - linked lead.score >= aiAutoSendScoreMin, OR
 *   - linked contact.relStrengthScore >= aiAutoSendScoreMin
 *
 * aiAutoSendConfidenceMin is currently unenforceable — no aiConfidence
 * column on emailDrafts yet. Falls through as "pass" with a one-time
 * warn log per worker run to make the gap visible.
 */
export async function autoSendForAllWorkspaces(): Promise<{
  workspacesProcessed: number;
  dispatched: number;
  skipped: number;
  skippedNullScore: number;
  skippedLowScore: number;
  failed: number;
}> {
  const db = await getDb();
  if (!db) return { workspacesProcessed: 0, dispatched: 0, skipped: 0, failed: 0 };

  const enabledWs = await db
    .select({
      workspaceId: workspaceSettings.workspaceId,
      aiAutoSendScoreMin: workspaceSettings.aiAutoSendScoreMin,
      aiAutoSendConfidenceMin: workspaceSettings.aiAutoSendConfidenceMin,
    })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.aiAutoSendEnabled, true));

  if (enabledWs.length === 0) {
    return { workspacesProcessed: 0, dispatched: 0, skipped: 0, skippedNullScore: 0, skippedLowScore: 0, failed: 0 };
  }

  let dispatched = 0;
  let skipped = 0;
  let skippedNullScore = 0;
  let skippedLowScore = 0;
  let failed = 0;

  for (const ws of enabledWs) {
    const scoreMin = ws.aiAutoSendScoreMin ?? 70;

    const candidateDrafts = await db
      .select({
        id: emailDrafts.id,
        toContactId: emailDrafts.toContactId,
        toLeadId: emailDrafts.toLeadId,
        createdByUserId: emailDrafts.createdByUserId,
      })
      .from(emailDrafts)
      .where(
        and(
          eq(emailDrafts.workspaceId, ws.workspaceId),
          eq(emailDrafts.status, "pending_review"),
          eq(emailDrafts.aiGenerated, true),
          isNotNull(emailDrafts.sequenceId),
        ),
      )
      .limit(50); // bounded per workspace per tick

    if (candidateDrafts.length === 0) continue;
    // aiAutoSendConfidenceMin is configurable in Settings but there's
    // no aiConfidence column on emailDrafts yet, so the threshold is a
    // no-op. We don't warn on every tick anymore — Settings shows the
    // explicit "no signal source yet" hint instead. (Critical-8.)

    for (const draft of candidateDrafts) {
      // Score gate
      let recipientScore: number | null = null;
      if (draft.toLeadId) {
        const [l] = await db
          .select({ score: leads.score })
          .from(leads)
          .where(eq(leads.id, draft.toLeadId))
          .limit(1);
        recipientScore = l?.score ?? null;
      } else if (draft.toContactId) {
        const [c] = await db
          .select({ score: contacts.relStrengthScore })
          .from(contacts)
          .where(eq(contacts.id, draft.toContactId))
          .limit(1);
        recipientScore = c?.score ?? null;
      }
      // Two distinct skip reasons — track them separately so the cron
      // summary can surface "you have 12 unscored contacts blocking
      // auto-send". Previously these were silently bucketed together
      // and contacts that hadn't been AI-scored just sat forever
      // pending review with no visible cause. (Critical-7.)
      if (recipientScore === null) {
        skipped++;
        skippedNullScore++;
        continue;
      }
      if (recipientScore < scoreMin) {
        skipped++;
        skippedLowScore++;
        continue;
      }

      // Actor: prefer draft.createdByUserId, fall back to workspace owner.
      // Used by deliverEmailDraft to look up the personal Unipile mailbox
      // and to attribute the activity/audit rows.
      let actorUserId = draft.createdByUserId ?? null;
      if (!actorUserId) {
        const [owner] = await db
          .select({ ownerUserId: workspaces.ownerUserId })
          .from(workspaces)
          .where(eq(workspaces.id, ws.workspaceId))
          .limit(1);
        actorUserId = owner?.ownerUserId ?? null;
      }
      if (!actorUserId) {
        skipped++;
        console.warn(
          `[autoSend] no actor user for draft ${draft.id} in workspace ${ws.workspaceId} — skipping`,
        );
        continue;
      }

      try {
        await deliverEmailDraft({
          workspaceId: ws.workspaceId,
          userId: actorUserId,
          draftId: draft.id,
        });
        dispatched++;
        console.log(
          `[autoSend] ws ${ws.workspaceId} draft ${draft.id} dispatched (score=${recipientScore} ≥ ${scoreMin})`,
        );
      } catch (err) {
        failed++;
        console.error(
          `[autoSend] ws ${ws.workspaceId} draft ${draft.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    workspacesProcessed: enabledWs.length,
    dispatched,
    skipped,
    skippedNullScore,
    skippedLowScore,
    failed,
  };
}

export const emailDraftsRouter = router({
  list: workspaceProcedure.input(z.object({ status: z.enum(["pending_review", "approved", "rejected", "sent"]).optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    let rows = await db.select().from(emailDrafts).where(eq(emailDrafts.workspaceId, ctx.workspace.id)).orderBy(desc(emailDrafts.createdAt));
    if (input?.status) rows = rows.filter((r) => r.status === input.status);
    return rows;
  }),

  /** Server-side AI compose. */
  compose: repProcedure
    .input(z.object({
      prompt: z.string().min(4),
      toContactId: z.number().optional(),
      toLeadId: z.number().optional(),
      tone: z.enum(["concise", "warm", "formal", "punchy"]).default("concise"),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      let contextLine = "";
      let toEmail: string | null = null;
      if (input.toContactId) {
        const [c] = await db.select().from(contacts).where(and(eq(contacts.id, input.toContactId), eq(contacts.workspaceId, ctx.workspace.id)));
        if (c) {
          contextLine = `Recipient: ${c.firstName} ${c.lastName}, ${c.title ?? "?"}`;
          toEmail = c.email ?? null;
        }
      } else if (input.toLeadId) {
        const [l] = await db.select().from(leads).where(and(eq(leads.id, input.toLeadId), eq(leads.workspaceId, ctx.workspace.id)));
        if (l) {
          contextLine = `Recipient: ${l.firstName} ${l.lastName}, ${l.title ?? "?"} at ${l.company ?? "?"}`;
          toEmail = l.email ?? null;
        }
      }

      let subject = "Quick question";
      let body = "";
      try {
        const out = await invokeLLM({
          messages: [
            {
              role: "system",
              content: `You write short B2B sales outreach emails that get replies.

OUTPUT
Return JSON only: { "subject": string, "body": string }.

VOICE
Tone: ${input.tone}. Sentence-case subject lines under 60 characters; no clickbait, no ALL CAPS, no emoji unless explicitly requested. Body should sound like one human writing to another — not a marketer. Write 80–120 words for cold outreach, fewer is better when there's nothing new to say.

STRUCTURE
- Open with one specific, relevant line about the recipient (their role, company, recent move). Avoid "I hope this email finds you well" and any variant of "I just wanted to reach out".
- One short paragraph of value or context. Lead with what's in it for them, not what you sell.
- One clear ask. A single question is fine. Time-suggest only if directly relevant ("Open to a 15-min call Thursday?").
- Do NOT include a signature, salutation block, or "Best regards" line — those are appended automatically.

MERGE FIELDS
You may use these placeholders and the send pipeline will substitute them per recipient:
  {{firstName}}, {{lastName}}, {{fullName}}, {{title}}, {{company}}
Use {{firstName}} for the greeting when one is appropriate. Skip a greeting entirely if the opening line works without one. Never invent placeholder names — leave the merge field as-is.

LINKS
If you include a hyperlink (case study, calendar, demo video, etc.), use Markdown syntax: [readable label](https://full-url). Both Markdown links and bare URLs are click-tracked, but Markdown produces a cleaner label. Only include a link if it materially helps the ask.

DO NOT
- Don't fabricate facts, metrics, customer names, or quotes.
- Don't start the body with "Hi {{firstName}}, I hope this email finds you well" or any near-variant.
- Don't write "As a [role]..." or "I came across your profile".
- Don't add "P.S." unless the prompt explicitly asks for one.`,
            },
            { role: "user", content: `${contextLine}\n\nGoal: ${input.prompt}` },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "email_draft",
              strict: true,
              schema: {
                type: "object",
                properties: { subject: { type: "string" }, body: { type: "string" } },
                required: ["subject", "body"],
                additionalProperties: false,
              },
            },
          },
        });
        const content = out.choices?.[0]?.message?.content;
        const parsed = typeof content === "string" ? JSON.parse(content) : content;
        subject = parsed.subject ?? subject;
        body = parsed.body ?? "";
      } catch (e) {
        console.warn("[compose] LLM failed; using fallback", e);
        subject = `Quick thought on ${input.prompt.slice(0, 40)}`;
        body = `Hi {{firstName}},\n\n${input.prompt}\n\nWould a 15-min call next week be useful?\n\nBest,\n{{senderName}}`;
      }

      const r = await db.insert(emailDrafts).values({
        workspaceId: ctx.workspace.id,
        subject, body,
        toContactId: input.toContactId ?? null,
        toLeadId: input.toLeadId ?? null,
        toEmail,
        status: "pending_review",
        aiGenerated: true,
        aiPrompt: input.prompt,
        createdByUserId: ctx.user.id,
      });
      return { id: Number((r as any)[0]?.insertId ?? 0), subject, body };
    }),

  approve: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(emailDrafts).set({ status: "approved", reviewedByUserId: ctx.user.id }).where(and(eq(emailDrafts.id, input.id), eq(emailDrafts.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "email_draft", entityId: input.id, after: { status: "approved" } });
    return { ok: true };
  }),

  reject: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(emailDrafts).set({ status: "rejected", reviewedByUserId: ctx.user.id }).where(and(eq(emailDrafts.id, input.id), eq(emailDrafts.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /**
   * Deliver an emailDrafts row through the EmailAdapter — the path used
   * for both "Approve & Send" on a pending_review draft and the sequence
   * runner's auto-send (once that's wired). Same merge-field, signature,
   * and tracking pipeline as crm.sendAdHocEmail so behavior is uniform
   * across all outbound sales touches.
   *
   * Recipient resolution: draft.toEmail wins; falling back to the linked
   * contact or lead email. Sender resolution mirrors crm.sendAdHocEmail.
   */
  send: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    return deliverEmailDraft({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      draftId: input.id,
    });
  }),


  update: repProcedure.input(z.object({ id: z.number(), subject: z.string(), body: z.string() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(emailDrafts).set({ subject: input.subject, body: input.body }).where(and(eq(emailDrafts.id, input.id), eq(emailDrafts.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(emailDrafts).where(and(eq(emailDrafts.id, input.id), eq(emailDrafts.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
});

/* ─────────────────────────────────────────────────────────────────────────────
   Sequence A/B Variants Router
   ───────────────────────────────────────────────────────────────────────── */

export const sequenceAbRouter = router({
  /** List all variants for a sequence (optionally filtered by stepIndex) */
  list: workspaceProcedure
    .input(z.object({ sequenceId: z.number(), stepIndex: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const conds: any[] = [
        eq(sequenceAbVariants.workspaceId, ctx.workspace.id),
        eq(sequenceAbVariants.sequenceId, input.sequenceId),
      ];
      if (input.stepIndex !== undefined) conds.push(eq(sequenceAbVariants.stepIndex, input.stepIndex));
      return db.select().from(sequenceAbVariants).where(and(...conds)).orderBy(sequenceAbVariants.stepIndex, sequenceAbVariants.variantLabel);
    }),

  /** Create a new A/B variant for a step */
  create: workspaceProcedure
    .input(z.object({
      sequenceId: z.number(),
      stepIndex: z.number().int().min(0),
      variantLabel: z.string().min(1).max(32),
      subject: z.string().min(1),
      body: z.string(),
      splitPct: z.number().int().min(1).max(99).default(50),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Verify sequence belongs to workspace
      const [seq] = await db.select({ id: sequences.id }).from(sequences)
        .where(and(eq(sequences.id, input.sequenceId), eq(sequences.workspaceId, ctx.workspace.id)));
      if (!seq) throw new TRPCError({ code: "NOT_FOUND", message: "Sequence not found" });
      const [inserted] = await db.insert(sequenceAbVariants).values({
        workspaceId: ctx.workspace.id,
        sequenceId: input.sequenceId,
        stepIndex: input.stepIndex,
        variantLabel: input.variantLabel,
        subject: input.subject,
        body: input.body,
        splitPct: input.splitPct,
      });
      return { id: (inserted as any).insertId };
    }),

  /** Update an existing variant */
  update: workspaceProcedure
    .input(z.object({
      id: z.number(),
      subject: z.string().optional(),
      body: z.string().optional(),
      splitPct: z.number().int().min(1).max(99).optional(),
      variantLabel: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { id, ...rest } = input;
      const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      if (Object.keys(patch).length > 0) {
        await db.update(sequenceAbVariants).set(patch)
          .where(and(eq(sequenceAbVariants.id, id), eq(sequenceAbVariants.workspaceId, ctx.workspace.id)));
      }
      return { ok: true };
    }),

  /** Delete a variant */
  delete: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.delete(sequenceAbVariants)
        .where(and(eq(sequenceAbVariants.id, input.id), eq(sequenceAbVariants.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  /** Get per-variant stats for a sequence step */
  getStats: workspaceProcedure
    .input(z.object({ sequenceId: z.number(), stepIndex: z.number().int().min(0) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const variants = await db.select().from(sequenceAbVariants)
        .where(and(
          eq(sequenceAbVariants.workspaceId, ctx.workspace.id),
          eq(sequenceAbVariants.sequenceId, input.sequenceId),
          eq(sequenceAbVariants.stepIndex, input.stepIndex),
        ));
      return variants.map((v) => ({
        id: v.id,
        variantLabel: v.variantLabel,
        subject: v.subject,
        splitPct: v.splitPct,
        sentCount: v.sentCount,
        openCount: v.openCount,
        replyCount: v.replyCount,
        isWinner: v.isWinner,
        promotedAt: v.promotedAt,
        minSendsForPromotion: v.minSendsForPromotion,
        openRate: v.sentCount > 0 ? Math.round((v.openCount / v.sentCount) * 100) : 0,
        replyRate: v.sentCount > 0 ? Math.round((v.replyCount / v.sentCount) * 100) : 0,
        score: v.sentCount > 0 ? (v.replyCount / v.sentCount) * 100 + (v.openCount / v.sentCount) * 10 : 0,
      }));
    }),

  /** Manually promote a variant as winner for a step */
  promoteWinner: workspaceProcedure
    .input(z.object({ sequenceId: z.number(), stepIndex: z.number().int().min(0), winnerId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Clear existing winner flags for this step
      await db.update(sequenceAbVariants)
        .set({ isWinner: false, promotedAt: null })
        .where(and(
          eq(sequenceAbVariants.workspaceId, ctx.workspace.id),
          eq(sequenceAbVariants.sequenceId, input.sequenceId),
          eq(sequenceAbVariants.stepIndex, input.stepIndex),
        ));
      // Set the new winner
      await db.update(sequenceAbVariants)
        .set({ isWinner: true, promotedAt: new Date() })
        .where(and(
          eq(sequenceAbVariants.id, input.winnerId),
          eq(sequenceAbVariants.workspaceId, ctx.workspace.id),
        ));
      return { ok: true };
    }),

  /** Update min-sends threshold for auto-promotion on a variant */
  setMinSends: workspaceProcedure
    .input(z.object({ id: z.number(), minSendsForPromotion: z.number().int().min(1).max(10000) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(sequenceAbVariants)
        .set({ minSendsForPromotion: input.minSendsForPromotion })
        .where(and(eq(sequenceAbVariants.id, input.id), eq(sequenceAbVariants.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),
});

/**
 * Standalone function called by the nightly batch to auto-promote A/B winners.
 * For each (sequenceId, stepIndex) group: if all variants meet their minSendsForPromotion
 * threshold and no winner has been set yet, promote the variant with the highest reply rate.
 */
export async function checkAndPromoteAbVariants(): Promise<{ promoted: number }> {
  const db = await getDb();
  if (!db) return { promoted: 0 };
  // Get all variants that haven't been promoted yet
  const variants = await db.select().from(sequenceAbVariants)
    .where(eq(sequenceAbVariants.isWinner, false));
  // Group by (sequenceId, stepIndex)
  const groups = new Map<string, typeof variants>();
  for (const v of variants) {
    const key = `${v.sequenceId}:${v.stepIndex}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(v);
  }
  let promoted = 0;
  for (const [, group] of groups) {
    // Skip if any variant in the group hasn't reached its min-sends threshold
    const allMeetThreshold = group.every(v => v.sentCount >= v.minSendsForPromotion);
    if (!allMeetThreshold || group.length < 2) continue;
    // Check if a winner already exists for this group
    const [existing] = await db.select({ id: sequenceAbVariants.id })
      .from(sequenceAbVariants)
      .where(and(
        eq(sequenceAbVariants.sequenceId, group[0].sequenceId),
        eq(sequenceAbVariants.stepIndex, group[0].stepIndex),
        eq(sequenceAbVariants.isWinner, true),
      ));
    if (existing) continue; // already promoted
    // Find the variant with the highest reply rate (open rate as tiebreaker)
    const winner = group.reduce((best, v) => {
      const score = v.sentCount > 0 ? (v.replyCount / v.sentCount) * 100 + (v.openCount / v.sentCount) * 10 : 0;
      const bestScore = best.sentCount > 0 ? (best.replyCount / best.sentCount) * 100 + (best.openCount / best.sentCount) * 10 : 0;
      return score > bestScore ? v : best;
    });
    // Clear all winner flags for this step then set the winner
    await db.update(sequenceAbVariants)
      .set({ isWinner: false, promotedAt: null })
      .where(and(
        eq(sequenceAbVariants.sequenceId, group[0].sequenceId),
        eq(sequenceAbVariants.stepIndex, group[0].stepIndex),
      ));
    await db.update(sequenceAbVariants)
      .set({ isWinner: true, promotedAt: new Date() })
      .where(eq(sequenceAbVariants.id, winner.id));
    promoted++;
  }
  return { promoted };
}
