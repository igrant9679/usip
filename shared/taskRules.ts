/**
 * The rules both task pages read (audit 2026-10-20, R72). /tasks and
 * /v2/tasks are both still live — which one stays is the owner's call — and
 * they had drifted apart:
 *
 *   - Overdue. /tasks called a task overdue only from the start of today on
 *     the viewer's clock; /v2/tasks and the server's stat cards from the
 *     moment it fell due. A task due at 10:00 was "Today" on one page and
 *     "Overdue" on the other at 15:00. Since R29 a picked due day is a
 *     deadline at the END of that day in the workspace's zone, so "due before
 *     now" is the rule, and "today" ends at the workspace's midnight.
 *   - Whose tasks. /v2/tasks listed every owner's tasks to everyone; a rep now
 *     sees their own and a manager everyone's, on both pages and in the
 *     counts above them (tasks.list / tasks.stats with `mine`).
 *   - "Recently closed" took the first ten rows of a list sorted by due date,
 *     i.e. the OLDEST closed tasks. It is the latest closed, by when.
 */
import { endOfZonedDay } from "./availability";
import { rankOf } from "./roleRank";

export type TaskDueState = "overdue" | "today" | "upcoming" | "none";

/** Statuses a task is still to be done in. Snoozed is not one until it wakes. */
export const WORKABLE_TASK_STATUSES = ["open", "in_progress"] as const;

export function taskDueState(dueAt: Date | string | null | undefined, nowMs: number, timeZone: string): TaskDueState {
  if (!dueAt) return "none";
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return "none";
  if (due < nowMs) return "overdue";
  if (due <= endOfZonedDay(timeZone, nowMs)) return "today";
  return "upcoming";
}

/** A manager or above sees every task; anyone else sees their own. */
export function seesAllTasks(role: string | null | undefined): boolean {
  return rankOf(role) >= rankOf("manager");
}

/** Closed tasks, latest closed first. Cancelled ones carry no completedAt. */
export function recentlyClosed<T extends { status: string; completedAt?: Date | string | null; updatedAt?: Date | string | null }>(
  rows: readonly T[],
  limit?: number,
): T[] {
  const at = (t: T) => new Date(t.completedAt ?? t.updatedAt ?? 0).getTime() || 0;
  const closed = rows.filter((t) => t.status === "done" || t.status === "cancelled").sort((a, b) => at(b) - at(a));
  return limit == null ? closed : closed.slice(0, limit);
}
