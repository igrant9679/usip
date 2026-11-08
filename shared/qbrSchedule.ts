/**
 * QBRs grouped the way follow-through needs them (audit 2026-10-20, U27):
 * upcoming (soonest first), overdue (scheduled, and its time or day has
 * passed with no Complete), completed (latest first) and cancelled. The page
 * was one flat list newest first, with a status word on each row.
 *
 * A QBR scheduled with a time carries `durationMinutes`; one scheduled for a
 * day only has none and is stored at noon UTC on that day (calendarDayFrom),
 * so its calendar day is the stored value's UTC date, and it is overdue once
 * that day is before today.
 *
 * Pure, so a test can read every rule.
 */

export type QbrLike = {
  id: number;
  status: string;
  scheduledAt: Date | string | null;
  completedAt?: Date | string | null;
  durationMinutes?: number | null;
};

export type QbrGroups<T> = { upcoming: T[]; overdue: T[]; completed: T[]; cancelled: T[] };

const at = (v: Date | string | null | undefined): number | null => {
  if (v == null) return null;
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isNaN(t) ? null : t;
};

/** Whether a QBR was given a time (rather than a day only). */
export function qbrHasTime(q: Pick<QbrLike, "durationMinutes">): boolean {
  return q.durationMinutes != null && q.durationMinutes > 0;
}

/** The calendar day ("YYYY-MM-DD") a day-only QBR is on. */
export function qbrDay(q: Pick<QbrLike, "scheduledAt">): string | null {
  const t = at(q.scheduledAt);
  return t == null ? null : new Date(t).toISOString().slice(0, 10);
}

/** When a timed QBR ends: its start plus its length. */
export function qbrEnd(q: QbrLike): Date | null {
  const t = at(q.scheduledAt);
  if (t == null) return null;
  return new Date(t + (qbrHasTime(q) ? q.durationMinutes! : 0) * 60_000);
}

export function isQbrOverdue(q: QbrLike, now: Date, today: string): boolean {
  if (q.status !== "scheduled") return false;
  const t = at(q.scheduledAt);
  if (t == null) return false;
  if (qbrHasTime(q)) return qbrEnd(q)!.getTime() < now.getTime();
  return (qbrDay(q) ?? "") < today;
}

/**
 * `today` is the viewer's calendar day ("YYYY-MM-DD"), so a day-only QBR is
 * not overdue on the day itself.
 */
export function groupQbrs<T extends QbrLike>(rows: readonly T[], now: Date, today: string): QbrGroups<T> {
  const g: QbrGroups<T> = { upcoming: [], overdue: [], completed: [], cancelled: [] };
  for (const q of rows) {
    if (q.status === "completed") g.completed.push(q);
    else if (q.status === "cancelled") g.cancelled.push(q);
    else if (isQbrOverdue(q, now, today)) g.overdue.push(q);
    else g.upcoming.push(q);
  }
  const asc = (a: T, b: T) => (at(a.scheduledAt) ?? Infinity) - (at(b.scheduledAt) ?? Infinity) || a.id - b.id;
  g.upcoming.sort(asc);
  g.overdue.sort(asc);
  g.completed.sort((a, b) => (at(b.completedAt) ?? at(b.scheduledAt) ?? 0) - (at(a.completedAt) ?? at(a.scheduledAt) ?? 0) || b.id - a.id);
  g.cancelled.sort((a, b) => (at(b.scheduledAt) ?? 0) - (at(a.scheduledAt) ?? 0) || b.id - a.id);
  return g;
}

/** QBR lengths offered when scheduling with a time. */
export const QBR_DURATIONS = [30, 45, 60, 90, 120] as const;
