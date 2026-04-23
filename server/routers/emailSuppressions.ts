/**
 * Email Suppressions Router (Feature 51)
 *
 * Handles:
 * - Unsubscribe token validation and recording (called from emailTracking.ts)
 * - tRPC procedures for listing, adding, removing suppressions
 * - Pre-send suppression check (used by smtpConfig.sendDraft)
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { emailSuppressions, contacts } from "../../drizzle/schema";
import { getDb } from "../db";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";

export const emailSuppressionsRouter = {
  /** List all suppressions for the workspace */
  list: workspaceProcedure
    .input(
      z.object({
        reason: z.enum(["unsubscribe", "bounce", "spam_complaint", "manual", "all"]).default("all"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select()
        .from(emailSuppressions)
        .where(
          and(
            eq(emailSuppressions.workspaceId, ctx.workspace.id),
            input.reason !== "all"
              ? eq(emailSuppressions.reason, input.reason as any)
              : undefined
          )
        )
        .orderBy(desc(emailSuppressions.createdAt))
        .limit(input.limit)
        .offset(input.offset);
      return rows;
    }),

  /** Check if one or more emails are suppressed */
  check: workspaceProcedure
    .input(z.object({ emails: z.array(z.string().email()).min(1).max(100) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select({ email: emailSuppressions.email, reason: emailSuppressions.reason })
        .from(emailSuppressions)
        .where(
          and(
            eq(emailSuppressions.workspaceId, ctx.workspace.id),
            inArray(emailSuppressions.email, input.emails)
          )
        );
      const suppressed = new Set(rows.map((r) => r.email.toLowerCase()));
      return {
        suppressed: input.emails.filter((e) => suppressed.has(e.toLowerCase())),
        details: rows,
      };
    }),

  /** Manually add a suppression */
  add: adminWsProcedure
    .input(
      z.object({
        email: z.string().email(),
        reason: z.enum(["unsubscribe", "bounce", "spam_complaint", "manual"]),
        notes: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Find linked contact if any
      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, ctx.workspace.id), eq(contacts.email, input.email)))
        .limit(1);
      await db.insert(emailSuppressions).ignore().values({
        workspaceId: ctx.workspace.id,
        email: input.email.toLowerCase(),
        reason: input.reason,
        contactId: contact?.id,
        notes: input.notes,
      });
      return { ok: true };
    }),

  /** Remove a suppression by id */
  remove: adminWsProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .delete(emailSuppressions)
        .where(
          and(
            eq(emailSuppressions.id, input.id),
            eq(emailSuppressions.workspaceId, ctx.workspace.id)
          )
        );
      return { ok: true };
    }),

  /** Summary counts by reason */
  summary: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const rows = await db
      .select()
      .from(emailSuppressions)
      .where(eq(emailSuppressions.workspaceId, ctx.workspace.id));
    const counts = { unsubscribe: 0, bounce: 0, spam_complaint: 0, manual: 0, total: rows.length };
    for (const r of rows) counts[r.reason]++;
    return counts;
  }),

  /** Remove ALL suppression records for a given email address (Feature 60) */
  removeByEmail: adminWsProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .delete(emailSuppressions)
        .where(
          and(
            eq(emailSuppressions.workspaceId, ctx.workspace.id),
            eq(emailSuppressions.email, input.email.toLowerCase()),
          )
        );
      return { ok: true, email: input.email.toLowerCase() };
    }),
};

/**
 * Standalone helper — check if an email is suppressed for a given workspace.
 * Used by smtpConfig.sendDraft before calling transporter.sendMail.
 */
export async function isEmailSuppressed(workspaceId: number, email: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const [row] = await db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.workspaceId, workspaceId),
        eq(emailSuppressions.email, email.toLowerCase())
      )
    )
    .limit(1);
  return !!row;
}

/**
 * Standalone helper — record an unsubscribe from a tracking token.
 * Called by the GET /api/track/unsubscribe/:token Express route.
 */
export async function recordUnsubscribeByToken(
  token: string,
  userAgent?: string
): Promise<{ ok: boolean; email?: string }> {
  const { emailDrafts } = await import("../../drizzle/schema");
  const db = await getDb();
  if (!db) return { ok: false };
  const [draft] = await db
    .select({
      id: emailDrafts.id,
      workspaceId: emailDrafts.workspaceId,
      toEmail: emailDrafts.toEmail,
      toContactId: emailDrafts.toContactId,
    })
    .from(emailDrafts)
    .where(eq(emailDrafts.trackingToken, token))
    .limit(1);
  if (!draft || !draft.toEmail) return { ok: false };
  const email = draft.toEmail.toLowerCase();
  // Insert suppression (ignore duplicate)
  await db.insert(emailSuppressions).ignore().values({
    workspaceId: draft.workspaceId,
    email,
    reason: "unsubscribe",
    draftId: draft.id,
    contactId: draft.toContactId ?? undefined,
    notes: userAgent ? `UA: ${userAgent.slice(0, 200)}` : undefined,
  });
  return { ok: true, email };
}
