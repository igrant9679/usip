/**
 * Segment → Sequence Auto-Enroll Rules router (Feature 46)
 *
 * Provides:
 *   - segmentRules.list        — list all rules for workspace, with their segment and sequence names
 *   - segmentRules.preview     — how many contacts a rule would enrol right now
 *   - segmentRules.save        — create or update a rule (segmentId + sequenceId)
 *   - segmentRules.delete      — remove a rule
 *   - segmentRules.runEnrollment — evaluate all enabled rules and enroll matching contacts
 *
 * The runEnrollment procedure is also called by the hourly cron in server/_core/index.ts
 *
 * Segments read the CRM contacts table, not People (audit 2026-10-20, P21), so
 * a rule enrols contacts only. Moving it to People would enrol a new, larger
 * set on the next hourly run without anyone turning a rule on again, so it
 * stays on contacts and the screens say so.
 */
import { archivedWorkspaceIds } from "../_core/workspaceArchive";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { notifyOwner } from "../_core/notification";
import { z } from "zod";
import {
  audienceSegments,
  contacts,
  enrollments,
  segmentSequenceRules,
  sequences,
  type AudienceSegment,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { screenEnrollmentCandidates } from "./sequences";
import { type SegmentRule } from "@shared/segmentRules";
import { segmentWhere } from "../services/segmentSql";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { router } from "../_core/trpc";
import { getWorkspaceTimezone } from "../services/workspaceTimezone";
import { assertRowInWorkspace } from "../services/foreignIds";

/* ─── Rule evaluation: the SQL segments.ts counts with (P19, P52) ─────── */
type Rule = SegmentRule;
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Screened = Awaited<ReturnType<typeof screenEnrollmentCandidates>>;

/**
 * The segment's contacts now, as ids, or why it gives none. The hourly run and
 * the count shown before a rule is turned on share it (audit 2026-10-20, P57),
 * so the number someone confirms comes from the run's own match.
 */
async function segmentContactIds(
  db: Db, workspaceId: number, segment: AudienceSegment | undefined,
): Promise<{ refused: string; ids: number[] } | { refused: null; ids: number[] }> {
  if (!segment) return { refused: "The segment no longer exists.", ids: [] };

  const segRules = (segment.rules as Rule[]) ?? [];
  const matchType = (segment.matchType ?? "all") as "all" | "any";

  // A segment with no rules matches EVERY contact (audit 2026-10-20, P1):
  // one saved by mistake enrolled the whole base on the next hourly run.
  if (segRules.length === 0) {
    return { refused: "The segment has no rules, so it would match every contact. Nothing was enrolled.", ids: [] };
  }

  // The segment's contacts, found in SQL: ids only, never the whole table (P52).
  const where = segmentWhere(workspaceId, segRules, matchType, await getWorkspaceTimezone(workspaceId));
  const matchingContacts = where ? await db.select({ id: contacts.id }).from(contacts).where(where) : [];
  return { refused: null, ids: matchingContacts.map((c) => c.id) };
}

/**
 * What turning a rule on would do now: the count a person confirms first (P57).
 *
 * `wouldEnrol` is at most: the matching contacts not already in the sequence.
 * The run also leaves out invalid addresses, the suppressed and anyone a
 * campaign is working, but that screen links contacts to People rows as it
 * goes, and a count must not write.
 */
export async function previewRule(db: Db, workspaceId: number, segmentId: number, sequenceId: number) {
  const [[segment], [seq], [{ n }]] = await Promise.all([
    db.select().from(audienceSegments)
      .where(and(eq(audienceSegments.id, segmentId), eq(audienceSegments.workspaceId, workspaceId))).limit(1),
    db.select({ status: sequences.status }).from(sequences)
      .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId))).limit(1),
    db.select({ n: sql<number>`count(*)` }).from(contacts).where(eq(contacts.workspaceId, workspaceId)),
  ]);
  const base = { contactsInWorkspace: Number(n), sequenceStatus: seq?.status ?? null };
  const found = await segmentContactIds(db, workspaceId, segment);
  if (found.refused !== null) return { ...base, refused: found.refused, matched: 0, alreadyEnrolled: 0, wouldEnrol: 0 };
  const enrolled: Array<{ contactId: number | null }> = found.ids.length
    ? await db.select({ contactId: enrollments.contactId }).from(enrollments).where(and(
        eq(enrollments.workspaceId, workspaceId),
        eq(enrollments.sequenceId, sequenceId),
        inArray(enrollments.status, ["active", "paused", "finished"]),
        inArray(enrollments.contactId, found.ids),
      ))
    : [];
  const alreadyEnrolled = new Set(enrolled.map((e) => e.contactId)).size;
  return { ...base, refused: null, matched: found.ids.length, alreadyEnrolled, wouldEnrol: found.ids.length - alreadyEnrolled };
}

/**
 * A rule is only turned on for as many contacts as someone was shown (P57).
 * A segment like "email is not empty" matches nearly everyone, and the next
 * hourly run enrolled them all with no number on the screen first.
 */
async function assertConfirmedCount(db: Db, workspaceId: number, segmentId: number, sequenceId: number, confirmed: number | undefined) {
  const { wouldEnrol } = await previewRule(db, workspaceId, segmentId, sequenceId);
  if (confirmed == null) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Turning this rule on would enrol up to ${wouldEnrol} contact${wouldEnrol === 1 ? "" : "s"}. Check the count and confirm it first.` });
  }
  if (wouldEnrol > confirmed) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This rule would now enrol up to ${wouldEnrol} contacts, more than the ${confirmed} you confirmed. Check the count and confirm again.` });
  }
}

const peopleSkippedIn = (s: Screened["skipped"]) => s.alreadyEnrolled + s.invalidEmail + s.inCampaign + s.suppressed;

/* ─── Core enrollment logic (exported for cron use) ─────────────────── */
/**
 * People skipped and rules refused are counted apart (audit 2026-10-20, P131):
 * one "skipped" total added each refused rule to the people it left out.
 */
export async function runSegmentEnrollmentForWorkspace(workspaceId: number): Promise<{ enrolled: number; peopleSkipped: number; rulesRefused: number; rules: number }> {
  const db = await getDb();
  if (!db) return { enrolled: 0, peopleSkipped: 0, rulesRefused: 0, rules: 0 };

  // Get all enabled rules for this workspace
  const rules = await db
    .select()
    .from(segmentSequenceRules)
    .where(and(eq(segmentSequenceRules.workspaceId, workspaceId), eq(segmentSequenceRules.enabled, true)));

  if (rules.length === 0) return { enrolled: 0, peopleSkipped: 0, rulesRefused: 0, rules: 0 };

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
  let totalRefused = 0;

  for (const rule of rules) {
    const record = (summary: Record<string, unknown>, enrolledNow = 0) => db.update(segmentSequenceRules)
      .set({ lastRunAt: new Date(), enrolledCount: (rule.enrolledCount ?? 0) + enrolledNow, lastRunSummary: { at: new Date().toISOString(), ...summary } } as never)
      .where(and(eq(segmentSequenceRules.id, rule.id), eq(segmentSequenceRules.workspaceId, workspaceId)));

    if (!activeSeqIds.has(rule.sequenceId)) {
      totalRefused++;
      await record({ matched: 0, enrolled: 0, refused: "The sequence is not active." });
      continue;
    }

    const found = await segmentContactIds(db, workspaceId, segmentMap.get(rule.segmentId));
    if (found.refused !== null) {
      totalRefused++;
      await record({ matched: 0, enrolled: 0, refused: found.refused });
      continue;
    }
    const matched = found.ids.length;
    if (matched === 0) {
      await record({ matched: 0, enrolled: 0 });
      continue;
    }

    // The same screen every enrolment passes (P2): invalid addresses, people
    // already in the sequence (by id or email), people an ARE campaign is
    // working, and anyone suppressed. This run skipped all four.
    const screened = await screenEnrollmentCandidates(db, workspaceId, rule.sequenceId, {
      contactIds: found.ids, leadIds: [], prospectIds: [],
    });
    const skipped = screened.skipped;
    totalSkipped += peopleSkippedIn(skipped);

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
    await record({ matched, enrolled: screened.contactIds.length, skipped }, screened.contactIds.length);
  }

  return { enrolled: totalEnrolled, peopleSkipped: totalSkipped, rulesRefused: totalRefused, rules: rules.length };
}

/* ─── Router ──────────────────────────────────────────────────────────── */
export const segmentRulesRouter = router({
  /**
   * List all segment → sequence rules for the workspace, each with its
   * segment's and sequence's names and the sequence's status: the Workflows
   * card read names the rows never carried, so every one said "Segment #id"
   * (audit 2026-10-20, P137), and a rule on a paused sequence read Active (P138).
   */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const rules = await db
      .select()
      .from(segmentSequenceRules)
      .where(eq(segmentSequenceRules.workspaceId, ctx.workspace.id));
    const segmentIds = Array.from(new Set(rules.map((r) => r.segmentId)));
    const sequenceIds = Array.from(new Set(rules.map((r) => r.sequenceId)));
    const [segs, seqs] = await Promise.all([
      segmentIds.length
        ? db.select({ id: audienceSegments.id, name: audienceSegments.name }).from(audienceSegments)
            .where(and(eq(audienceSegments.workspaceId, ctx.workspace.id), inArray(audienceSegments.id, segmentIds)))
        : [],
      sequenceIds.length
        ? db.select({ id: sequences.id, name: sequences.name, status: sequences.status }).from(sequences)
            .where(and(eq(sequences.workspaceId, ctx.workspace.id), inArray(sequences.id, sequenceIds)))
        : [],
    ]);
    const segById = new Map(segs.map((s) => [s.id, s]));
    const seqById = new Map(seqs.map((s) => [s.id, s]));
    return rules.map((r) => ({
      ...r,
      segmentName: segById.get(r.segmentId)?.name ?? null,
      sequenceName: seqById.get(r.sequenceId)?.name ?? null,
      sequenceStatus: seqById.get(r.sequenceId)?.status ?? null,
    }));
  }),

  /** How many contacts this segment would enrol into this sequence now, and why the rest would not be (P57). */
  preview: adminWsProcedure
    .input(z.object({ segmentId: z.number().int(), sequenceId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return previewRule(db, ctx.workspace.id, input.segmentId, input.sequenceId);
    }),

  /** Create or update a segment → sequence rule */
  save: adminWsProcedure
    .input(
      z.object({
        id: z.number().int().optional(),
        segmentId: z.number().int(),
        sequenceId: z.number().int(),
        enabled: z.boolean().default(true),
        /** The "would enrol" count the person was shown; needed to turn a rule on (P57). */
        confirmedWouldEnrol: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      if (input.id) {
        const [rule] = await db
          .select()
          .from(segmentSequenceRules)
          .where(and(eq(segmentSequenceRules.id, input.id), eq(segmentSequenceRules.workspaceId, ctx.workspace.id)));
        if (!rule) throw new TRPCError({ code: "NOT_FOUND", message: "That rule is not in this workspace." });
        if (input.enabled && !rule.enabled) {
          await assertConfirmedCount(db, ctx.workspace.id, rule.segmentId, rule.sequenceId, input.confirmedWouldEnrol);
        }
        await db
          .update(segmentSequenceRules)
          .set({ enabled: input.enabled })
          .where(and(eq(segmentSequenceRules.id, input.id), eq(segmentSequenceRules.workspaceId, ctx.workspace.id)));
        return { ok: true };
      }

      await assertRowInWorkspace(db, "segment", input.segmentId, ctx.workspace.id);
      await assertRowInWorkspace(db, "sequence", input.sequenceId, ctx.workspace.id);

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

      if (input.enabled && !existing?.enabled) {
        await assertConfirmedCount(db, ctx.workspace.id, input.segmentId, input.sequenceId, input.confirmedWouldEnrol);
      }

      if (existing) {
        await db
          .update(segmentSequenceRules)
          .set({ enabled: input.enabled })
          .where(and(eq(segmentSequenceRules.id, existing.id), eq(segmentSequenceRules.workspaceId, ctx.workspace.id)));
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
 * The hourly owner notification (Feature 56). It named /segment-auto-enroll,
 * a path the app has never had (audit 2026-10-20, P132); the page is
 * /segment-rules. People skipped and rules refused are separate lines (P131).
 */
export function segmentEnrollNotification(workspaceCount: number, totalEnrolled: number, peopleSkipped: number, rulesRefused: number) {
  const runDate = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const runTime = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return {
    title: `Segment Auto-Enroll: ${totalEnrolled} contact${totalEnrolled !== 1 ? "s" : ""} enrolled`,
    content:
      `Hourly segment → sequence auto-enroll completed on ${runDate} at ${runTime}.\n\n` +
      `• Workspaces with active rules: ${workspaceCount}\n` +
      `• Contacts enrolled in sequences: ${totalEnrolled}\n` +
      `• Contacts skipped (already enrolled, invalid email, in a campaign or suppressed): ${peopleSkipped}\n` +
      `• Rules that enrolled no one because they were refused: ${rulesRefused}\n` +
      `\nView and manage enrollment rules in Marketing → Segment Rules (/segment-rules).`,
  };
}

/**
 * Run segment enrollment for ALL workspaces that have enabled rules.
 * Called by the hourly cron in server/_core/index.ts
 */
export async function runSegmentEnrollmentForAllWorkspaces(): Promise<{ workspaces: number; enrolled: number; peopleSkipped: number; rulesRefused: number }> {
  const db = await getDb();
  if (!db) return { workspaces: 0, enrolled: 0, peopleSkipped: 0, rulesRefused: 0 };

  // Find distinct workspaceIds that have enabled rules
  const rows = await db
    .select({ workspaceId: segmentSequenceRules.workspaceId })
    .from(segmentSequenceRules)
    .where(eq(segmentSequenceRules.enabled, true));

  const workspaceIds = Array.from(new Set(rows.map((r) => r.workspaceId)));
  if (workspaceIds.length === 0) return { workspaces: 0, enrolled: 0, peopleSkipped: 0, rulesRefused: 0 };

  let totalEnrolled = 0;
  let totalSkipped = 0;
  let totalRefused = 0;

    const archivedWs = await archivedWorkspaceIds();
  for (const workspaceId of workspaceIds) {
    if (archivedWs.has(workspaceId)) continue; // archived workspaces are frozen (2026-08-12)
    try {
      const result = await runSegmentEnrollmentForWorkspace(workspaceId);
      totalEnrolled += result.enrolled;
      totalSkipped += result.peopleSkipped;
      totalRefused += result.rulesRefused;
    } catch (err) {
      console.error(`[SegmentEnroll] Failed for workspace ${workspaceId}:`, err);
    }
  }

  console.log(`[SegmentEnroll] Done. Workspaces: ${workspaceIds.length}, Enrolled: ${totalEnrolled}, People skipped: ${totalSkipped}, Rules refused: ${totalRefused}`);

  // Feature 56: Notify owner when at least one contact was enrolled
  if (totalEnrolled > 0) {
    try {
      await notifyOwner(segmentEnrollNotification(workspaceIds.length, totalEnrolled, totalSkipped, totalRefused));
    } catch (notifyErr) {
      // Notification failure must not affect the cron result
      console.warn("[SegmentEnroll] Owner notification failed:", notifyErr);
    }
  }

  return { workspaces: workspaceIds.length, enrolled: totalEnrolled, peopleSkipped: totalSkipped, rulesRefused: totalRefused };
}
