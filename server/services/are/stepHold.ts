/**
 * stepHold.ts — holding a campaign prospect's steps, and putting them back on
 * the calendar without a burst (audit 2026-10-20, A1/A2/A3; Phase 1).
 *
 * 🔴 THE BUGS. Pausing a prospect left their steps `scheduled`; each one that
 * fell due while paused was marked `skipped` by the dispatcher, for good, and
 * resuming brought none of them back (A3). A reply stopped the sequence only
 * if the model recommended it (A1). And anything that put steps back — a
 * re-approval, a resume — left every overdue step due at once, so a prospect
 * got several emails in one tick (A2).
 *
 * Now a stop HOLDS the steps (status `paused`, reason `Held: …`), a resume
 * RELEASES them from a start time keeping their spacing, and a campaign
 * coming back from pause shifts each prospect's overdue steps the same way.
 * A step a person paused by hand (execution.pause) carries no `Held:` reason
 * and is left alone.
 */
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { areExecutionQueue, prospectQueue } from "../../../drizzle/schema";

type Db = any;

export const HELD_PREFIX = "Held: ";
export const HELD_PAUSED = "Held: sequence paused";
export const HELD_REPLIED = "Held: the prospect replied";

/** What a claimed step reads as until its send settles (never auto-healed). */
export const DISPATCH_INTERRUPTED = "Dispatch interrupted — send state unknown";

/**
 * Take a due step for sending (audit 2026-10-20, A30): scheduled → failed
 * with DISPATCH_INTERRUPTED, ONLY while it is still scheduled. False means an
 * overlapping tick took it first, and this one must not send it.
 */
export async function claimStepForDispatch(db: Db, stepId: number): Promise<boolean> {
  const res = await db
    .update(areExecutionQueue)
    .set({ status: "failed", failureReason: DISPATCH_INTERRUPTED, executedAt: new Date() })
    .where(and(eq(areExecutionQueue.id, stepId), eq(areExecutionQueue.status, "scheduled")));
  return affectedOf(res) === 1;
}

/** Take a prospect's scheduled steps off the calendar. Returns how many. */
export async function holdProspectSteps(db: Db, workspaceId: number, prospectQueueId: number, reason: string): Promise<number> {
  const res = await db
    .update(areExecutionQueue)
    .set({ status: "paused", failureReason: reason })
    .where(and(
      eq(areExecutionQueue.workspaceId, workspaceId),
      eq(areExecutionQueue.prospectQueueId, prospectQueueId),
      eq(areExecutionQueue.status, "scheduled"),
    ));
  return affectedOf(res);
}

/**
 * Put a prospect's held steps back, the first at `startAt` (or its own time
 * if later) and each later one keeping its distance from the one before, so
 * time spent held never turns into steps due together. Scheduled steps of the
 * prospect move with them. Returns how many steps were released from hold.
 */
export async function releaseProspectSteps(db: Db, workspaceId: number, prospectQueueId: number, startAt: Date): Promise<number> {
  const rows: Array<{ id: number; status: string; failureReason: string | null; scheduledAt: Date | string }> = await db
    .select({
      id: areExecutionQueue.id,
      status: areExecutionQueue.status,
      failureReason: areExecutionQueue.failureReason,
      scheduledAt: areExecutionQueue.scheduledAt,
    })
    .from(areExecutionQueue)
    .where(and(
      eq(areExecutionQueue.workspaceId, workspaceId),
      eq(areExecutionQueue.prospectQueueId, prospectQueueId),
      inArray(areExecutionQueue.status, ["scheduled", "paused"]),
    ))
    .orderBy(asc(areExecutionQueue.scheduledAt), asc(areExecutionQueue.stepIndex));
  const live = rows.filter((r) => r.status === "scheduled" || (r.failureReason ?? "").startsWith(HELD_PREFIX));
  if (live.length === 0) return 0;
  const times = respaced(live.map((r) => new Date(r.scheduledAt).getTime()), startAt.getTime());
  let released = 0;
  for (let i = 0; i < live.length; i++) {
    const r = live[i];
    if (r.status === "paused") released++;
    await db
      .update(areExecutionQueue)
      .set({ status: "scheduled", failureReason: null, scheduledAt: new Date(times[i]) })
      .where(and(eq(areExecutionQueue.id, r.id), eq(areExecutionQueue.status, r.status as "scheduled" | "paused")));
  }
  return released;
}

/**
 * A campaign back from pause: each prospect whose next step is overdue has
 * their steps shifted so the first is due now and the rest keep their gaps.
 * The engine ticks only active campaigns, so a long pause otherwise left a
 * prospect with several steps due in the same minute.
 */
export async function respaceOverdueSteps(db: Db, workspaceId: number, campaignId: number, now: Date = new Date()): Promise<number> {
  const overdue: Array<{ prospectQueueId: number }> = await db
    .select({ prospectQueueId: areExecutionQueue.prospectQueueId })
    .from(areExecutionQueue)
    .where(and(
      eq(areExecutionQueue.workspaceId, workspaceId),
      eq(areExecutionQueue.campaignId, campaignId),
      eq(areExecutionQueue.status, "scheduled"),
      lt(areExecutionQueue.scheduledAt, now),
    ));
  const ids = Array.from(new Set(overdue.map((r) => r.prospectQueueId)));
  let moved = 0;
  for (const id of ids) {
    const rows: Array<{ id: number; scheduledAt: Date | string }> = await db
      .select({ id: areExecutionQueue.id, scheduledAt: areExecutionQueue.scheduledAt })
      .from(areExecutionQueue)
      .where(and(
        eq(areExecutionQueue.workspaceId, workspaceId),
        eq(areExecutionQueue.prospectQueueId, id),
        eq(areExecutionQueue.status, "scheduled"),
      ))
      .orderBy(asc(areExecutionQueue.scheduledAt), asc(areExecutionQueue.stepIndex));
    const times = respaced(rows.map((r) => new Date(r.scheduledAt).getTime()), now.getTime());
    for (let i = 0; i < rows.length; i++) {
      if (times[i] === new Date(rows[i].scheduledAt).getTime()) continue;
      await db.update(areExecutionQueue).set({ scheduledAt: new Date(times[i]) })
        .where(and(eq(areExecutionQueue.id, rows[i].id), eq(areExecutionQueue.status, "scheduled")));
      moved++;
    }
  }
  return moved;
}

/**
 * Times in order, the first no earlier than `startMs`, each later one at
 * least as far after the one before as it was originally.
 */
export function respaced(times: number[], startMs: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < times.length; i++) {
    const own = times[i];
    const gap = i === 0 ? 0 : Math.max(0, own - times[i - 1]);
    out.push(i === 0 ? Math.max(own, startMs) : Math.max(own, out[i - 1] + gap));
  }
  return out;
}

/**
 * A reply stops the prospect's sequence: they become `replied` and their
 * scheduled steps are held. Only from a state that is still sending (or about
 * to). Returns whether this call stopped it.
 */
export async function markAreProspectReplied(db: Db, workspaceId: number, prospectQueueId: number): Promise<boolean> {
  const res = await db
    .update(prospectQueue)
    .set({ sequenceStatus: "replied" })
    .where(and(
      eq(prospectQueue.id, prospectQueueId),
      eq(prospectQueue.workspaceId, workspaceId),
      inArray(prospectQueue.sequenceStatus, ["enrolled", "paused", "approved"]),
    ));
  if (affectedOf(res) !== 1) return false;
  await holdProspectSteps(db, workspaceId, prospectQueueId, HELD_REPLIED);
  return true;
}

/**
 * The reply was an auto-responder: the prospect goes back to `enrolled` and
 * the steps the reply held are released from `at` (the return date).
 */
export async function resumeAreProspectAfterAutoReply(db: Db, workspaceId: number, prospectQueueId: number, at: Date): Promise<boolean> {
  const res = await db
    .update(prospectQueue)
    .set({ sequenceStatus: "enrolled" })
    .where(and(
      eq(prospectQueue.id, prospectQueueId),
      eq(prospectQueue.workspaceId, workspaceId),
      eq(prospectQueue.sequenceStatus, "replied"),
    ));
  if (affectedOf(res) !== 1) return false;
  await releaseProspectSteps(db, workspaceId, prospectQueueId, at);
  return true;
}

function affectedOf(res: unknown): number {
  const r = res as any;
  return Number(r?.[0]?.affectedRows ?? r?.affectedRows ?? 0);
}
