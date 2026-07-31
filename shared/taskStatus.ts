/**
 * The one definition of "which task statuses are still live".
 *
 * `tasks.status` has six values (migration 0099 added the last three). Six
 * places asked "does this thing already have a live task?" and answered it
 * with their own array literal — five agreed, and one did not:
 *
 *   crm.ts · linkedinEnrichment.ts · meetings.ts ·
 *   jobChangeReengagement.ts · taskAutopilot.ts      open draft in_progress snoozed
 *   dealAutopilot.ts                                 open draft in_progress
 *
 * 🔴 dealAutopilot's dedupe is what decides whether an AI-sourced task already
 * exists for a deal. Missing `snoozed` means a task the rep SNOOZED — the
 * explicit "not now" — stopped counting, so the engine read the deal as
 * unattended and generated another one. The user says later, the autopilot says
 * again.
 *
 * ACTIVE and CLOSED are exhaustive and disjoint over the enum, and the guard
 * parses the enum out of schema.ts — so adding a seventh status fails the build
 * until somebody decides which side it belongs on, rather than defaulting to
 * "not live" and quietly disabling six dedupe checks.
 */

/**
 * Every value of the `tasks.status` enum, in schema order.
 *
 * A `const` tuple, so `z.enum(TASK_STATUSES)` accepts it directly and the
 * TaskStatus union below is DERIVED rather than retyped — a hand-written union
 * beside a hand-written array is its own little drift pair.
 */
export const TASK_STATUSES = [
  "open",
  "done",
  "cancelled",
  "in_progress",
  "snoozed",
  "draft",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Statuses meaning "this task still exists as work".
 *
 * `snoozed` and `draft` COUNT. Snoozed is deferred, not gone — a dedupe that
 * ignores it duplicates the task the user just postponed. Draft is an
 * AI-proposed task awaiting approval; creating a second proposal for the same
 * thing is the same mistake one step earlier.
 */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = [
  "open",
  "draft",
  "in_progress",
  "snoozed",
];

/** Statuses meaning the task is finished with, one way or the other. */
export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];

/** Mutable copy for Drizzle's `inArray`, which does not take a readonly array. */
export function activeTaskStatuses(): TaskStatus[] {
  return [...ACTIVE_TASK_STATUSES];
}

export function isActiveTaskStatus(status: string): boolean {
  return (ACTIVE_TASK_STATUSES as readonly string[]).includes(status);
}
