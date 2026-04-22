/**
 * SMTP Delivery Config router (Feature 44)
 *
 * Provides:
 *   - smtpConfig.get            — return masked config for workspace
 *   - smtpConfig.save           — upsert SMTP config (password AES-256-GCM encrypted)
 *   - smtpConfig.test           — send a test email to the calling user's email
 *   - smtpConfig.sendDraft      — send a single approved draft via Nodemailer
 *   - smtpConfig.sendBulkApproved — send all approved drafts (rate-limited 1/sec, max 200)
 */
import { TRPCError } from "@trpc/server";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import nodemailer from "nodemailer";
import { z } from "zod";
import {
  activities,
  contacts,
  emailDrafts,
  leads,
  smtpConfigs,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { router } from "../_core/trpc";

/* ─── AES-256-GCM helpers ─────────────────────────────────────────────── */
function getEncKey(): Buffer {
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
function decrypt(ciphertext: string): string {
  const [ivHex, tagHex, encHex] = ciphertext.split(":");
  if (!ivHex || !tagHex || !encHex) throw new Error("Invalid ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", getEncKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(encHex, "hex")).toString("utf8") + decipher.final("utf8");
}

/* ─── Nodemailer transporter factory ─────────────────────────────────── */
function buildTransporter(cfg: {
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

  /** Send a single approved email draft */
  sendDraft: workspaceProcedure
    .input(z.object({ draftId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Load draft
      const [draft] = await db.select().from(emailDrafts)
        .where(and(eq(emailDrafts.id, input.draftId), eq(emailDrafts.workspaceId, ctx.workspace.id)));
      if (!draft) throw new TRPCError({ code: "NOT_FOUND", message: "Draft not found" });
      if (draft.status !== "approved") throw new TRPCError({ code: "BAD_REQUEST", message: "Only approved drafts can be sent" });

      // Resolve recipient email
      let toEmail = draft.toEmail ?? null;
      if (!toEmail && draft.toContactId) {
        const [c] = await db.select({ email: contacts.email }).from(contacts).where(eq(contacts.id, draft.toContactId));
        toEmail = c?.email ?? null;
      }
      if (!toEmail && draft.toLeadId) {
        const [l] = await db.select({ email: leads.email }).from(leads).where(eq(leads.id, draft.toLeadId));
        toEmail = l?.email ?? null;
      }
      if (!toEmail) throw new TRPCError({ code: "BAD_REQUEST", message: "No recipient email address found for this draft" });

      // Load SMTP config
      const [cfg] = await db.select().from(smtpConfigs)
        .where(and(eq(smtpConfigs.workspaceId, ctx.workspace.id), eq(smtpConfigs.enabled, true)));
      if (!cfg) throw new TRPCError({ code: "NOT_FOUND", message: "No active SMTP config. Configure SMTP in Settings → Email Delivery." });

      let password: string;
      try { password = decrypt(cfg.encryptedPassword); }
      catch { throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to decrypt SMTP password" }); }

      const transporter = buildTransporter({ host: cfg.host, port: cfg.port, secure: cfg.secure, username: cfg.username, password });

      try {
        await transporter.sendMail({
          from: cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail,
          to: toEmail,
          replyTo: cfg.replyTo ?? undefined,
          subject: draft.subject,
          text: draft.body,
          html: draft.body.replace(/\n/g, "<br>"),
        });
      } catch (err: any) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to send email: ${err?.message}` });
      }

      // Mark as sent
      await db.update(emailDrafts).set({ status: "sent", sentAt: new Date() }).where(eq(emailDrafts.id, draft.id));

      // Log to activities
      if (draft.toContactId || draft.toLeadId) {
        await db.insert(activities).values({
          workspaceId: ctx.workspace.id,
          type: "email",
          relatedType: draft.toContactId ? "contact" : "lead",
          relatedId: (draft.toContactId ?? draft.toLeadId)!,
          subject: draft.subject,
          body: draft.body,
          actorUserId: ctx.user.id,
        });
      }

      return { ok: true, sentTo: toEmail };
    }),

  /** Send all approved drafts for the workspace (rate-limited 1/sec, max 200) */
  sendBulkApproved: adminWsProcedure
    .input(z.object({ draftIds: z.array(z.number().int()).max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Load SMTP config
      const [cfg] = await db.select().from(smtpConfigs)
        .where(and(eq(smtpConfigs.workspaceId, ctx.workspace.id), eq(smtpConfigs.enabled, true)));
      if (!cfg) throw new TRPCError({ code: "NOT_FOUND", message: "No active SMTP config. Configure SMTP in Settings → Email Delivery." });

      let password: string;
      try { password = decrypt(cfg.encryptedPassword); }
      catch { throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to decrypt SMTP password" }); }

      // Load approved drafts
      const whereClause = input.draftIds?.length
        ? and(eq(emailDrafts.workspaceId, ctx.workspace.id), eq(emailDrafts.status, "approved"), inArray(emailDrafts.id, input.draftIds))
        : and(eq(emailDrafts.workspaceId, ctx.workspace.id), eq(emailDrafts.status, "approved"));

      const drafts = await db.select().from(emailDrafts).where(whereClause).limit(200);
      if (!drafts.length) return { ok: true, sent: 0, failed: 0, skipped: 0 };

      // Load contact/lead emails in bulk
      const contactIds = drafts.filter((d) => d.toContactId).map((d) => d.toContactId!);
      const leadIds = drafts.filter((d) => d.toLeadId).map((d) => d.toLeadId!);
      const contactEmails = contactIds.length
        ? await db.select({ id: contacts.id, email: contacts.email }).from(contacts).where(inArray(contacts.id, contactIds))
        : [];
      const leadEmails = leadIds.length
        ? await db.select({ id: leads.id, email: leads.email }).from(leads).where(inArray(leads.id, leadIds))
        : [];
      const contactEmailMap = new Map(contactEmails.map((c) => [c.id, c.email]));
      const leadEmailMap = new Map(leadEmails.map((l) => [l.id, l.email]));

      const transporter = buildTransporter({ host: cfg.host, port: cfg.port, secure: cfg.secure, username: cfg.username, password });
      let sent = 0, failed = 0, skipped = 0;

      for (const draft of drafts) {
        const toEmail =
          draft.toEmail ??
          (draft.toContactId ? contactEmailMap.get(draft.toContactId) : null) ??
          (draft.toLeadId ? leadEmailMap.get(draft.toLeadId) : null) ??
          null;

        if (!toEmail) { skipped++; continue; }

        try {
          await transporter.sendMail({
            from: cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail,
            to: toEmail,
            replyTo: cfg.replyTo ?? undefined,
            subject: draft.subject,
            text: draft.body,
            html: draft.body.replace(/\n/g, "<br>"),
          });
          await db.update(emailDrafts).set({ status: "sent", sentAt: new Date() }).where(eq(emailDrafts.id, draft.id));
          if (draft.toContactId || draft.toLeadId) {
            await db.insert(activities).values({
              workspaceId: ctx.workspace.id,
              type: "email",
              relatedType: draft.toContactId ? "contact" : "lead",
              relatedId: (draft.toContactId ?? draft.toLeadId)!,
              subject: draft.subject,
              body: draft.body,
              actorUserId: ctx.user.id,
            });
          }
          sent++;
        } catch {
          failed++;
        }

        // Rate limit: 1 email per second
        await sleep(1000);
      }

      return { ok: true, sent, failed, skipped };
    }),
});
