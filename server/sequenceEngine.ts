/**
 * Sequence Execution Engine (MKT-007, MKT-008)
 *
 * Responsibilities:
 *  1. processEnrollments() — runs every 5 minutes, advances active enrollments
 *     whose nextActionAt <= now. Handles email steps (creates emailDraft),
 *     wait steps (schedules next action), and task steps (creates task).
 *  2. autoEnrollByTriggers(workspaceId, event) — called when a contact status
 *     changes, a tag is applied, or a lead score crosses a threshold. Finds
 *     matching sequences with enrollmentTrigger rules and auto-enrolls.
 *  3. pauseOnReply(enrollmentId) — marks enrollment paused + creates a review task.
 *  4. enforceCapAndEnroll() — respects per-sequence dailyCap and per-workspace
 *     daily email cap (100 by default) before creating drafts.
 */

import { and, eq, isNull, lte, or } from "drizzle-orm";
import {
  contacts,
  emailDrafts,
  enrollments,
  leads,
  sequences,
  sequenceAbVariants,
  tasks,
} from "../drizzle/schema";
import { getDb } from "./db";

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = {
  type: "email" | "wait" | "task";
  subject?: string;
  body?: string;
  waitDays?: number;
  taskTitle?: string;
  taskDueOffsetDays?: number;
};

type EnrollmentTrigger = {
  type: "status_change" | "tag_applied" | "score_threshold";
  value: string; // e.g. "qualified", "hot", "75"
};

type AutoEnrollEvent =
  | { kind: "status_change"; workspaceId: number; contactId: number; newStatus: string }
  | { kind: "tag_applied"; workspaceId: number; contactId: number; tag: string }
  | { kind: "score_threshold"; workspaceId: number; contactId?: number; leadId?: number; score: number };

// ─── Daily email cap tracking (in-memory, resets at midnight) ─────────────────

const dailyEmailCounts: Map<string, number> = new Map();
const WORKSPACE_DAILY_CAP = 100;

function getDailyKey(workspaceId: number): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${workspaceId}:${today}`;
}

function incrementDailyCount(workspaceId: number): boolean {
  const key = getDailyKey(workspaceId);
  const current = dailyEmailCounts.get(key) ?? 0;
  if (current >= WORKSPACE_DAILY_CAP) return false;
  dailyEmailCounts.set(key, current + 1);
  return true;
}

// ─── Core processor ───────────────────────────────────────────────────────────

/**
 * Process all active enrollments whose nextActionAt is in the past.
 * Called every 5 minutes by the server cron.
 */
export async function processEnrollments(): Promise<{ processed: number; errors: number }> {
  const db = await getDb();
  if (!db) return { processed: 0, errors: 0 };

  const now = new Date();
  let processed = 0;
  let errors = 0;

  // Fetch all active enrollments due for processing
  const due = await db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.status, "active"),
        or(
          isNull(enrollments.nextActionAt),
          lte(enrollments.nextActionAt, now)
        )
      )
    )
    .limit(200); // process up to 200 per tick to avoid overload

  for (const enrollment of due) {
    try {
      // Fetch the sequence
      const [seq] = await db
        .select()
        .from(sequences)
        .where(eq(sequences.id, enrollment.sequenceId));

      if (!seq || seq.status !== "active") {
        // Sequence is no longer active — exit enrollment
        await db
          .update(enrollments)
          .set({ status: "exited" })
          .where(eq(enrollments.id, enrollment.id));
        continue;
      }

      const steps = (seq.steps as Step[]) ?? [];
      const stepIndex = enrollment.currentStep;

      if (stepIndex >= steps.length) {
        // All steps done — mark finished
        await db
          .update(enrollments)
          .set({ status: "finished" })
          .where(eq(enrollments.id, enrollment.id));
        processed++;
        continue;
      }

      const step = steps[stepIndex];
      const nextStepIndex = stepIndex + 1;
      const hasNextStep = nextStepIndex < steps.length;

      if (step.type === "email") {
        // Enforce daily caps
        const seqDailyCap = seq.dailyCap ?? Infinity;
        const seqKey = `seq:${seq.id}:${new Date().toISOString().slice(0, 10)}`;
        const seqCount = dailyEmailCounts.get(seqKey) ?? 0;

        if (seqCount >= seqDailyCap) {
          // Skip this tick — try again next run
          continue;
        }

        const wsCapOk = incrementDailyCount(enrollment.workspaceId);
        if (!wsCapOk) {
          // Workspace daily cap hit — skip
          continue;
        }
        dailyEmailCounts.set(seqKey, seqCount + 1);

        // Resolve recipient email
        let toEmail: string | undefined;
        let toContactId: number | undefined;
        let toLeadId: number | undefined;

        if (enrollment.contactId) {
          const [contact] = await db
            .select({ email: contacts.email })
            .from(contacts)
            .where(eq(contacts.id, enrollment.contactId));
          toEmail = contact?.email ?? undefined;
          toContactId = enrollment.contactId;
        } else if (enrollment.leadId) {
          const [lead] = await db
            .select({ email: leads.email })
            .from(leads)
            .where(eq(leads.id, enrollment.leadId));
          toEmail = lead?.email ?? undefined;
          toLeadId = enrollment.leadId;
        }

        if (toEmail) {
          // A/B variant assignment: pick a variant for this step if any exist
          let draftSubject = step.subject ?? "Follow-up";
          let draftBody = step.body ?? "";
          const variants = await db
            .select()
            .from(sequenceAbVariants)
            .where(
              and(
                eq(sequenceAbVariants.sequenceId, enrollment.sequenceId),
                eq(sequenceAbVariants.stepIndex, stepIndex),
              ),
            );
          if (variants.length > 0) {
            // Weighted random selection based on splitPct
            const totalWeight = variants.reduce((s, v) => s + v.splitPct, 0);
            let rand = Math.random() * totalWeight;
            let chosen = variants[0];
            for (const v of variants) {
              rand -= v.splitPct;
              if (rand <= 0) { chosen = v; break; }
            }
            draftSubject = chosen.subject;
            draftBody = chosen.body;
            // Increment sentCount on the chosen variant
            await db
              .update(sequenceAbVariants)
              .set({ sentCount: chosen.sentCount + 1 })
              .where(eq(sequenceAbVariants.id, chosen.id));
          }
          // Create email draft for review
          await db.insert(emailDrafts).values({
            workspaceId: enrollment.workspaceId,
            subject: draftSubject,
            body: draftBody,
            toContactId,
            toLeadId,
            toEmail,
            sequenceId: enrollment.sequenceId,
            enrollmentId: enrollment.id,
            status: "pending_review",
            aiGenerated: false,
          });
        }

        // Advance to next step
        if (hasNextStep) {
          const nextStep = steps[nextStepIndex];
          const nextActionAt = nextStep.type === "wait"
            ? new Date(now.getTime() + (nextStep.waitDays ?? 1) * 86400000)
            : new Date(now.getTime() + 60000); // 1 min delay for immediate steps
          await db
            .update(enrollments)
            .set({ currentStep: nextStepIndex, nextActionAt })
            .where(eq(enrollments.id, enrollment.id));
        } else {
          await db
            .update(enrollments)
            .set({ status: "finished" })
            .where(eq(enrollments.id, enrollment.id));
        }

      } else if (step.type === "wait") {
        // Wait step — just advance to next step and set nextActionAt
        if (hasNextStep) {
          const nextStep = steps[nextStepIndex];
          const waitDays = step.waitDays ?? 1;
          const nextActionAt = nextStep.type === "wait"
            ? new Date(now.getTime() + (nextStep.waitDays ?? 1) * 86400000)
            : new Date(now.getTime() + waitDays * 86400000);
          await db
            .update(enrollments)
            .set({ currentStep: nextStepIndex, nextActionAt })
            .where(eq(enrollments.id, enrollment.id));
        } else {
          await db
            .update(enrollments)
            .set({ status: "finished" })
            .where(eq(enrollments.id, enrollment.id));
        }

      } else if (step.type === "task") {
        // Create a task for the rep
        const dueAt = new Date(
          now.getTime() + (step.taskDueOffsetDays ?? 1) * 86400000
        );
        await db.insert(tasks).values({
          workspaceId: enrollment.workspaceId,
          title: step.taskTitle ?? "Follow up",
          dueAt,
          relatedType: enrollment.contactId ? "contact" : "lead",
          relatedId: (enrollment.contactId ?? enrollment.leadId) as number,
          status: "open",
          priority: "normal",
        });

        // Advance to next step
        if (hasNextStep) {
          const nextStep = steps[nextStepIndex];
          const nextActionAt = nextStep.type === "wait"
            ? new Date(now.getTime() + (nextStep.waitDays ?? 1) * 86400000)
            : new Date(now.getTime() + 60000);
          await db
            .update(enrollments)
            .set({ currentStep: nextStepIndex, nextActionAt })
            .where(eq(enrollments.id, enrollment.id));
        } else {
          await db
            .update(enrollments)
            .set({ status: "finished" })
            .where(eq(enrollments.id, enrollment.id));
        }
      }

      processed++;
    } catch (err) {
      errors++;
      console.error(`[SequenceEngine] Error processing enrollment ${enrollment.id}:`, err);
    }
  }

  if (processed > 0 || errors > 0) {
    console.log(`[SequenceEngine] Processed ${processed} enrollments, ${errors} errors`);
  }

  return { processed, errors };
}

// ─── Auto-enrollment triggers ─────────────────────────────────────────────────

/**
 * Check all active sequences in a workspace for matching enrollmentTrigger rules.
 * Auto-enroll the contact/lead if not already enrolled.
 */
export async function autoEnrollByTriggers(event: AutoEnrollEvent): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const { workspaceId } = event;

  // Get all active sequences with enrollment triggers
  const activeSeqs = await db
    .select()
    .from(sequences)
    .where(
      and(
        eq(sequences.workspaceId, workspaceId),
        eq(sequences.status, "active")
      )
    );

  for (const seq of activeSeqs) {
    const triggers = (seq.enrollmentTrigger as EnrollmentTrigger[] | null) ?? [];
    if (triggers.length === 0) continue;

    let matches = false;

    for (const trigger of triggers) {
      if (event.kind === "status_change" && trigger.type === "status_change") {
        if (trigger.value === event.newStatus) matches = true;
      } else if (event.kind === "tag_applied" && trigger.type === "tag_applied") {
        if (trigger.value === event.tag) matches = true;
      } else if (event.kind === "score_threshold" && trigger.type === "score_threshold") {
        const threshold = parseInt(trigger.value, 10);
        if (!isNaN(threshold) && event.score >= threshold) matches = true;
      }
    }

    if (!matches) continue;

    // Check if already enrolled
    const contactId = event.kind !== "score_threshold" ? event.contactId : event.contactId;
    const leadId = event.kind === "score_threshold" ? event.leadId : undefined;

    const existing = await db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.sequenceId, seq.id),
          eq(enrollments.workspaceId, workspaceId),
          contactId ? eq(enrollments.contactId, contactId) : isNull(enrollments.contactId),
          leadId ? eq(enrollments.leadId, leadId) : isNull(enrollments.leadId)
        )
      )
      .limit(1);

    if (existing.length > 0) continue; // already enrolled

    // Auto-enroll
    await db.insert(enrollments).values({
      workspaceId,
      sequenceId: seq.id,
      contactId: contactId ?? null,
      leadId: leadId ?? null,
      status: "active",
      currentStep: 0,
      nextActionAt: new Date(), // process immediately
    });

    console.log(
      `[SequenceEngine] Auto-enrolled ${contactId ? `contact:${contactId}` : `lead:${leadId}`} in sequence:${seq.id} via trigger:${event.kind}`
    );
  }
}

// ─── Pause on reply ───────────────────────────────────────────────────────────

/**
 * Pause an enrollment when a reply is detected.
 * Creates a review task for the rep.
 */
export async function pauseOnReply(
  enrollmentId: number,
  workspaceId: number
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const [enrollment] = await db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.id, enrollmentId),
        eq(enrollments.workspaceId, workspaceId)
      )
    );

  if (!enrollment || enrollment.status !== "active") return;

  // Pause enrollment
  await db
    .update(enrollments)
    .set({ status: "paused" })
    .where(eq(enrollments.id, enrollmentId));

  // Create review task
  await db.insert(tasks).values({
    workspaceId,
    title: "Reply detected — review sequence enrollment",
    dueAt: new Date(Date.now() + 86400000), // due tomorrow
    relatedType: enrollment.contactId ? "contact" : "lead",
    relatedId: (enrollment.contactId ?? enrollment.leadId) as number,
    status: "open",
    priority: "high" as const,
  });

  console.log(`[SequenceEngine] Paused enrollment ${enrollmentId} due to reply`);
}

// ─── Enrollment stats ─────────────────────────────────────────────────────────

/**
 * Get enrollment counts by status for a sequence.
 */
export async function getEnrollmentStats(
  sequenceId: number,
  workspaceId: number
): Promise<{ active: number; paused: number; finished: number; exited: number }> {
  const db = await getDb();
  if (!db) return { active: 0, paused: 0, finished: 0, exited: 0 };

  const rows = await db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.sequenceId, sequenceId),
        eq(enrollments.workspaceId, workspaceId)
      )
    );

  const stats = { active: 0, paused: 0, finished: 0, exited: 0 };
  for (const row of rows) {
    stats[row.status as keyof typeof stats]++;
  }
  return stats;
}
