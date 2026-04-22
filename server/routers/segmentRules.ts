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
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  audienceSegments,
  contacts,
  enrollments,
  segmentSequenceRules,
  sequences,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { router } from "../_core/trpc";

/* ─── Rule evaluation helpers (mirrors segments.ts) ─────────────────── */
type Rule = { field: string; operator: string; value: string };

function applyRule(contact: Record<string, any>, rule: Rule): boolean {
  const raw = contact[rule.field];
  const val = raw === null || raw === undefined ? "" : String(raw);
  const ruleVal = rule.value.toLowerCase();
  const valLower = val.toLowerCase();
  switch (rule.operator) {
    case "equals": return valLower === ruleVal;
    case "not_equals": return valLower !== ruleVal;
    case "contains": return valLower.includes(ruleVal);
    case "not_contains": return !valLower.includes(ruleVal);
    case "is_empty": return val === "";
    case "is_not_empty": return val !== "";
    case "gt": return new Date(val) > new Date(rule.value);
    case "lt": return new Date(val) < new Date(rule.value);
    default: return true;
  }
}

function evaluateRules(contact: Record<string, any>, rules: Rule[], matchType: "all" | "any"): boolean {
  if (rules.length === 0) return true;
  if (matchType === "all") return rules.every((r) => applyRule(contact, r));
  return rules.some((r) => applyRule(contact, r));
}

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

  // Get all contacts for this workspace
  const allContacts = await db
    .select()
    .from(contacts)
    .where(eq(contacts.workspaceId, workspaceId));

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
    if (!activeSeqIds.has(rule.sequenceId)) {
      totalSkipped++;
      continue;
    }

    const segment = segmentMap.get(rule.segmentId);
    if (!segment) { totalSkipped++; continue; }

    const segRules = (segment.rules as Rule[]) ?? [];
    const matchType = (segment.matchType ?? "all") as "all" | "any";

    // Find contacts matching the segment
    const matchingContacts = allContacts.filter((c) =>
      evaluateRules(c as Record<string, any>, segRules, matchType)
    );

    if (matchingContacts.length === 0) {
      await db.update(segmentSequenceRules).set({ lastRunAt: new Date() }).where(eq(segmentSequenceRules.id, rule.id));
      continue;
    }

    // Get already-enrolled contact IDs for this sequence
    const matchingContactIds = matchingContacts.map((c) => c.id);
    const existingEnrollments = await db
      .select({ contactId: enrollments.contactId })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.workspaceId, workspaceId),
          eq(enrollments.sequenceId, rule.sequenceId),
          inArray(enrollments.contactId, matchingContactIds)
        )
      );
    const alreadyEnrolledIds = new Set(existingEnrollments.map((e) => e.contactId));

    // Enroll contacts not yet enrolled
    let ruleEnrolled = 0;
    for (const contact of matchingContacts) {
      if (alreadyEnrolledIds.has(contact.id)) { totalSkipped++; continue; }

      await db.insert(enrollments).values({
        workspaceId,
        sequenceId: rule.sequenceId,
        contactId: contact.id,
        status: "active",
        currentStep: 0,
        nextActionAt: new Date(),
      });
      ruleEnrolled++;
      totalEnrolled++;
    }

    // Update rule stats
    await db.update(segmentSequenceRules)
      .set({ lastRunAt: new Date(), enrolledCount: (rule.enrolledCount ?? 0) + ruleEnrolled })
      .where(eq(segmentSequenceRules.id, rule.id));
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

  for (const workspaceId of workspaceIds) {
    try {
      const result = await runSegmentEnrollmentForWorkspace(workspaceId);
      totalEnrolled += result.enrolled;
      totalSkipped += result.skipped;
    } catch (err) {
      console.error(`[SegmentEnroll] Failed for workspace ${workspaceId}:`, err);
    }
  }

  console.log(`[SegmentEnroll] Done. Workspaces: ${workspaceIds.length}, Enrolled: ${totalEnrolled}, Skipped: ${totalSkipped}`);
  return { workspaces: workspaceIds.length, enrolled: totalEnrolled, skipped: totalSkipped };
}
