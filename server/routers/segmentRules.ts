/**
 * Segment → Sequence Auto-Enroll Rules router (Feature 46)
 *
 * Provides:
 *   - segmentRules.list        — list all rules for workspace
 *   - segmentRules.save        — create or update a rule (segmentId + sequenceId)
 *   - segmentRules.delete      — remove a rule
 *   - segmentRules.runEnrollment — evaluate all enabled rules and enroll matching contacts
 *
 * The runEnrollment procedure is also called by the hourly cron in server/_core/index.ts
 */
import { archivedWorkspaceIds } from "../_core/workspaceArchive";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { notifyOwner } from "../_core/notification";
import { z } from "zod";
import {
  audienceSegments,
  contacts,
  enrollments,
  segmentSequenceRules,
  sequences,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { screenEnrollmentCandidates } from "./sequences";
import { type SegmentRule } from "@shared/segmentRules";
import { segmentWhere } from "../services/segmentSql";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { router } from "../_core/trpc";

/* ─── Rule evaluation: the SQL segments.ts counts with (P19, P52) ─────── */
type Rule = SegmentRule;

/* ─── Core enrollment logic (exported for cron use) ─────────────────── */
export async function runSegmentEnrollmentForWorkspace(workspaceId: number): Promise<{ enrolled: number; skipped: number; rules: number }> {
  const db = await getDb();
  if (!db) return { enrolled: 0, skipped: 0, rules: 0 };

  // Get all enabled rules for this workspace
  const rules = await db
    .select()
    .from(segmentSequenceRules)
    .where(and(eq(segmentSequenceRules.workspaceId, workspaceId), eq(segmentSequenceRules.enabled, true)));

  if (rules.length === 0) return { enrolled: 0, skipped: 0, rules: 0 };

  // Get all active sequences for this workspace (to verify they're still active)
  const sequenceIds = Array.from(new Set(rules.map((r) => r.sequenceId)));
  const activeSeqs = await db
    .select({ id: sequences.id })
    .from(sequences)
    .where(and(eq(sequences.workspaceId, workspaceId), eq(sequences.status, "active"), inArray(sequences.id, sequenceIds)));
  const activeSeqIds = new Set(activeSeqs.map((s) => s.id));

  // Get all segment definitions for the rules
  const segmentIds = Array.from(new Set(rules.map((r) => r.segmentId)));
  const segments = await db
    .select()
    .from(audienceSegments)
    .where(and(eq(audienceSegments.workspaceId, workspaceId), inArray(audienceSegments.id, segmentIds)));
  const segmentMap = new Map(segments.map((s) => [s.id, s]));

  let totalEnrolled = 0;
  let totalSkipped = 0;

  for (const rule of rules) {
    const record = (summary: Record<string, unknown>, enrolledNow = 0) => db.update(segmentSequenceRules)
      .set({ lastRunAt: new Date(), enrolledCount: (rule.enrolledCount ?? 0) + enrolledNow, lastRunSummary: { at: new Date().toISOString(), ...summary } } as never)
      .where(and(eq(segmentSequenceRules.id, rule.id), eq(segmentSequenceRules.workspaceId, workspaceId)));

    if (!activeSeqIds.has(rule.sequenceId)) {
      totalSkipped++;
      await record({ matched: 0, enrolled: 0, refused: "The sequence is not active." });
      continue;
    }

    const segment = segmentMap.get(rule.segmentId);
    if (!segment) { totalSkipped++; await record({ matched: 0, enrolled: 0, refused: "The segment no longer exists." }); continue; }

    const segRules = (segment.rules as Rule[]) ?? [];
    const matchType = (segment.matchType ?? "all") as "all" | "any";

    // A segment with no rules matches EVERY contact (audit 2026-10-20, P1):
    // one saved by mistake enrolled the whole base on the next hourly run.
    if (segRules.length === 0) {
      await record({ matched: 0, enrolled: 0, refused: "The segment has no rules, so it would match every contact. Nothing was enrolled." });
      continue;
    }

    // The segment's contacts, found in SQL: ids only, never the whole table (P52).
    const where = segmentWhere(workspaceId, segRules, matchType);
    const matchingContacts = where ? await db.select({ id: contacts.id }).from(contacts).where(where) : [];

    if (matchingContacts.length === 0) {
      await record({ matched: 0, enrolled: 0 });
      continue;
    }

    // The same screen every enrolment passes (P2): invalid addresses, people
    // already in the sequence (by id or email), people an ARE campaign is
    // working, and anyone suppressed. This run skipped all four.
    const screened = await screenEnrollmentCandidates(db, workspaceId, rule.sequenceId, {
      contactIds: matchingContacts.map((c) => c.id), leadIds: [], prospectIds: [],
    });
    const skipped = screened.skipped;
    totalSkipped += skipped.alreadyEnrolled + skipped.invalidEmail + skipped.inCampaign + skipped.suppressed;

    const now = new Date();
    if (screened.contactIds.length > 0) {
      await db.insert(enrollments).values(screened.contactIds.map((contactId) => ({
        workspaceId,
        sequenceId: rule.sequenceId,
        contactId,
        status: "active" as const,
        currentStep: 0,
        nextActionAt: now,
      })));
    }
    totalEnrolled += screened.contactIds.length;
    await record({ matched: matchingContacts.length, enrolled: screened.contactIds.length, skipped }, screened.contactIds.length);
  }

  return { enrolled: totalEnrolled, skipped: totalSkipped, rules: rules.length };
}

/* ─── Router ──────────────────────────────────────────────────────────── */
export const segmentRulesRouter = router({
  /** List all segment → sequence rules for the workspace */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const rules = await db
      .select()
      .from(segmentSequenceRules)
      .where(eq(segmentSequenceRules.workspaceId, ctx.workspace.id));
    return rules;
  }),

  /** Create or update a segment → sequence rule */
  save: adminWsProcedure
    .input(
      z.object({
        id: z.number().int().optional(),
        segmentId: z.number().int(),
        sequenceId: z.number().int(),
        enabled: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      if (input.id) {
        await db
          .update(segmentSequenceRules)
          .set({ enabled: input.enabled })
          .where(and(eq(segmentSequenceRules.id, input.id), eq(segmentSequenceRules.workspaceId, ctx.workspace.id)));
        return { ok: true };
      }

      // Check if rule already exists
      const [existing] = await db
        .select()
        .from(segmentSequenceRules)
        .where(
          and(
            eq(segmentSequenceRules.workspaceId, ctx.workspace.id),
            eq(segmentSequenceRules.segmentId, input.segmentId),
            eq(segmentSequenceRules.sequenceId, input.sequenceId),
          ),
        );

      if (existing) {
        await db
          .update(segmentSequenceRules)
          .set({ enabled: input.enabled })
          .where(eq(segmentSequenceRules.id, existing.id));
      } else {
        await db.insert(segmentSequenceRules).values({
          workspaceId: ctx.workspace.id,
          segmentId: input.segmentId,
          sequenceId: input.sequenceId,
          enabled: input.enabled,
        });
      }
      return { ok: true };
    }),

  /** Delete a segment → sequence rule */
  delete: adminWsProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .delete(segmentSequenceRules)
        .where(and(eq(segmentSequenceRules.id, input.id), eq(segmentSequenceRules.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  /** Manually trigger enrollment for all enabled rules in this workspace */
  runEnrollment: adminWsProcedure.mutation(async ({ ctx }) => {
    const result = await runSegmentEnrollmentForWorkspace(ctx.workspace.id);
    return { ok: true, ...result };
  }),
});

/**
 * Run segment enrollment for ALL workspaces that have enabled rules.
 * Called by the hourly cron in server/_core/index.ts
 */
export async function runSegmentEnrollmentForAllWorkspaces(): Promise<{ workspaces: number; enrolled: number; skipped: number }> {
  const db = await getDb();
  if (!db) return { workspaces: 0, enrolled: 0, skipped: 0 };

  // Find distinct workspaceIds that have enabled rules
  const rows = await db
    .select({ workspaceId: segmentSequenceRules.workspaceId })
    .from(segmentSequenceRules)
    .where(eq(segmentSequenceRules.enabled, true));

  const workspaceIds = Array.from(new Set(rows.map((r) => r.workspaceId)));
  if (workspaceIds.length === 0) return { workspaces: 0, enrolled: 0, skipped: 0 };

  let totalEnrolled = 0;
  let totalSkipped = 0;

    const archivedWs = await archivedWorkspaceIds();
  for (const workspaceId of workspaceIds) {
    if (archivedWs.has(workspaceId)) continue; // archived workspaces are frozen (2026-08-12)
    try {
      const result = await runSegmentEnrollmentForWorkspace(workspaceId);
      totalEnrolled += result.enrolled;
      totalSkipped += result.skipped;
    } catch (err) {
      console.error(`[SegmentEnroll] Failed for workspace ${workspaceId}:`, err);
    }
  }

  console.log(`[SegmentEnroll] Done. Workspaces: ${workspaceIds.length}, Enrolled: ${totalEnrolled}, Skipped: ${totalSkipped}`);

  // Feature 56: Notify owner when at least one contact was enrolled
  if (totalEnrolled > 0) {
    try {
      const runDate = new Date().toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const runTime = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      await notifyOwner({
        title: `Segment Auto-Enroll: ${totalEnrolled} contact${totalEnrolled !== 1 ? "s" : ""} enrolled`,
        content:
          `Hourly segment → sequence auto-enroll completed on ${runDate} at ${runTime}.\n\n` +
          `• Workspaces with active rules: ${workspaceIds.length}\n` +
          `• Contacts enrolled in sequences: ${totalEnrolled}\n` +
          `• Contacts skipped (already enrolled): ${totalSkipped}\n` +
          `\nView and manage enrollment rules in Settings → Segment Auto-Enroll (/segment-auto-enroll).`,
      });
    } catch (notifyErr) {
      // Notification failure must not affect the cron result
      console.warn("[SegmentEnroll] Owner notification failed:", notifyErr);
    }
  }

  return { workspaces: workspaceIds.length, enrolled: totalEnrolled, skipped: totalSkipped };
}
