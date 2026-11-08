/**
 * Sequence performance, counted in SQL (audit 2026-10-20, G58, X4.1).
 *
 * getPerformanceAnalytics read every draft of every sequence — subject, body
 * and all — and every enrollment, two queries per sequence, to count them in
 * JavaScript. Now it is seven grouped counts for the whole workspace,
 * whatever the number of sequences, and no draft body leaves the database.
 * The numbers are the ones the old code produced: sent counts drafts marked
 * sent; opens, clicks and bounces count every draft in the date range; a
 * date range keeps only drafts with a send time inside it.
 *
 * The range is picked as days, and they are the workspace's days. Read as UTC
 * days, filtering a New York workspace on the 3rd counted the evening of the
 * 2nd and dropped the evening of the 3rd.
 */
import { and, asc, eq, gt, gte, inArray, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import { emailDrafts, emailReplies, enrollments, sequences } from "../../drizzle/schema";
import { getDb } from "../db";
import { dayRangeBounds } from "./calendarDeadline";
import { genuineReplyScope } from "./replyScope";
import { getWorkspaceTimezone } from "./workspaceTimezone";

export type SequencePerformance = {
  sequenceId: number; sequenceName: string; status: string;
  totalEnrolled: number; active: number; finished: number; exited: number; paused: number;
  sent: number; uniqueOpens: number; uniqueClicks: number; bounced: number;
  totalOpens: number; totalClicks: number;
  openRate: number; clickRate: number; bounceRate: number; exitRate: number;
};

const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);

export async function sequencePerformance(
  ws: number,
  opts: { sequenceId?: number; dateFrom?: string; dateTo?: string },
): Promise<SequencePerformance[]> {
  const db = await getDb();
  if (!db) return [];
  const seqs = await db.select({ id: sequences.id, name: sequences.name, status: sequences.status })
    .from(sequences)
    .where(opts.sequenceId ? and(eq(sequences.workspaceId, ws), eq(sequences.id, opts.sequenceId)) : eq(sequences.workspaceId, ws))
    .orderBy(asc(sequences.id));
  if (!seqs.length) return [];
  const ids = seqs.map((s) => s.id);

  const drafts: SQL[] = [eq(emailDrafts.workspaceId, ws), inArray(emailDrafts.sequenceId, ids)];
  if (opts.dateFrom || opts.dateTo) {
    const range = dayRangeBounds(opts.dateFrom, opts.dateTo, await getWorkspaceTimezone(ws));
    if (range.from) drafts.push(gte(emailDrafts.sentAt, range.from));
    if (range.to) drafts.push(lte(emailDrafts.sentAt, range.to));
  }
  const countWhere = (...more: SQL[]) =>
    db.select({ seq: emailDrafts.sequenceId, n: sql<number>`count(*)` }).from(emailDrafts)
      .where(and(...drafts, ...more)).groupBy(emailDrafts.sequenceId);

  const [sent, bounced, opened, clicked, totals, enr] = await Promise.all([
    countWhere(eq(emailDrafts.status, "sent")),
    countWhere(isNotNull(emailDrafts.bouncedAt)),
    countWhere(gt(emailDrafts.openCount, 0)),
    countWhere(gt(emailDrafts.clickCount, 0)),
    db.select({ seq: emailDrafts.sequenceId, opens: sql<number>`sum(${emailDrafts.openCount})`, clicks: sql<number>`sum(${emailDrafts.clickCount})` })
      .from(emailDrafts).where(and(...drafts)).groupBy(emailDrafts.sequenceId),
    db.select({ seq: enrollments.sequenceId, status: enrollments.status, n: sql<number>`count(*)` }).from(enrollments)
      .where(and(eq(enrollments.workspaceId, ws), inArray(enrollments.sequenceId, ids)))
      .groupBy(enrollments.sequenceId, enrollments.status),
  ]);
  const by = (rows: { seq: number | null; n: number }[]) => new Map(rows.map((r) => [r.seq, Number(r.n)]));
  const [sentBy, bouncedBy, openedBy, clickedBy] = [by(sent), by(bounced), by(opened), by(clicked)];
  const totalsBy = new Map(totals.map((r) => [r.seq, { opens: Number(r.opens ?? 0), clicks: Number(r.clicks ?? 0) }]));
  const enrBy = new Map<number, Record<string, number>>();
  for (const r of enr) {
    const m = enrBy.get(r.seq) ?? {};
    m[String(r.status)] = (m[String(r.status)] ?? 0) + Number(r.n);
    enrBy.set(r.seq, m);
  }

  return seqs.map((seq) => {
    const e = enrBy.get(seq.id) ?? {};
    const totalEnrolled = Object.values(e).reduce((a, b) => a + b, 0);
    const s = sentBy.get(seq.id) ?? 0;
    const uniqueOpens = openedBy.get(seq.id) ?? 0;
    const uniqueClicks = clickedBy.get(seq.id) ?? 0;
    const b = bouncedBy.get(seq.id) ?? 0;
    const exited = e.exited ?? 0;
    return {
      sequenceId: seq.id, sequenceName: seq.name, status: seq.status,
      totalEnrolled, active: e.active ?? 0, finished: e.finished ?? 0, exited, paused: e.paused ?? 0,
      sent: s, uniqueOpens, uniqueClicks, bounced: b,
      totalOpens: totalsBy.get(seq.id)?.opens ?? 0, totalClicks: totalsBy.get(seq.id)?.clicks ?? 0,
      openRate: pct(uniqueOpens, s), clickRate: pct(uniqueClicks, s), bounceRate: pct(b, s), exitRate: pct(exited, totalEnrolled),
    };
  });
}

/* ── One sequence, step by step (audit 2026-10-20, O41) ──────────────────────
 *
 * getStepAnalytics read every draft of the sequence, then every draft id
 * again, to count them per step in JavaScript; getEnrollmentStepStats and
 * getEnrollmentStats read every enrolment row to count them. These count in
 * SQL, grouped by step or status, and give the numbers the old code gave:
 * sent is drafts marked sent; opens, clicks and bounces count every draft of
 * the step; replies count every matched reply row whose draft is the step's;
 * a draft from before migration 0063 (no step) is the -1 row, shown only when
 * one of them was sent.
 */

export type StepAnalyticsRow = {
  stepIndex: number; stepType: string; stepLabel: string;
  sent: number; uniqueOpens: number; uniqueClicks: number; bounced: number; replied: number;
  openRate: number; clickRate: number; replyRate: number; bounceRate: number;
};

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export async function stepAnalytics(
  db: Db,
  ws: number,
  seq: { id: number; steps: unknown },
): Promise<StepAnalyticsRow[]> {
  const steps = (Array.isArray(seq.steps) ? seq.steps : []) as Array<{ type?: string; subject?: string } | null>;
  const mine = [eq(emailDrafts.workspaceId, ws), eq(emailDrafts.sequenceId, seq.id)];
  const countWhere = (...more: SQL[]) =>
    db.select({ step: emailDrafts.stepIndex, n: sql<number>`count(*)` }).from(emailDrafts)
      .where(and(...mine, ...more)).groupBy(emailDrafts.stepIndex);
  const [sent, opened, clicked, bounced, replied] = await Promise.all([
    countWhere(eq(emailDrafts.status, "sent")),
    countWhere(gt(emailDrafts.openCount, 0)),
    countWhere(gt(emailDrafts.clickCount, 0)),
    countWhere(isNotNull(emailDrafts.bouncedAt)),
    db.select({ step: emailDrafts.stepIndex, n: sql<number>`count(*)` }).from(emailReplies)
      .innerJoin(emailDrafts, and(eq(emailDrafts.id, emailReplies.draftId), eq(emailDrafts.workspaceId, emailReplies.workspaceId)))
      .where(and(eq(emailReplies.workspaceId, ws), genuineReplyScope(), ...mine))
      .groupBy(emailDrafts.stepIndex),
  ]);
  const by = (rows: Array<{ step: number | null; n: number }>) => {
    const m = new Map<number, number>();
    for (const r of rows) m.set(r.step ?? -1, (m.get(r.step ?? -1) ?? 0) + Number(r.n));
    return m;
  };
  const [sentBy, openedBy, clickedBy, bouncedBy, repliedBy] = [by(sent), by(opened), by(clicked), by(bounced), by(replied)];
  const row = (stepIndex: number, stepType: string, stepLabel: string): StepAnalyticsRow => {
    const s = sentBy.get(stepIndex) ?? 0;
    const o = openedBy.get(stepIndex) ?? 0;
    const c = clickedBy.get(stepIndex) ?? 0;
    const b = bouncedBy.get(stepIndex) ?? 0;
    const r = repliedBy.get(stepIndex) ?? 0;
    return {
      stepIndex, stepType, stepLabel, sent: s, uniqueOpens: o, uniqueClicks: c, bounced: b, replied: r,
      openRate: pct(o, s), clickRate: pct(c, s), replyRate: pct(r, s), bounceRate: pct(b, s),
    };
  };
  // One row per defined step, zeros included, so the ladder is whole.
  const out = steps.map((s, i) => row(
    i,
    s?.type ?? "unknown",
    s?.type === "email" ? (s.subject ?? `Email step ${i + 1}`) : `${s?.type ?? "?"} step ${i + 1}`,
  ));
  if ((sentBy.get(-1) ?? 0) > 0) out.push(row(-1, "unknown", "(legacy / pre-0063 drafts)"));
  return out;
}

/** How many of a sequence's enrolments stand on each step, counted in SQL. */
export async function enrollmentStepCounts(db: Db, ws: number, sequenceId: number): Promise<Array<{ step: number; count: number }>> {
  const rows = await db.select({ step: enrollments.currentStep, n: sql<number>`count(*)` }).from(enrollments)
    .where(and(eq(enrollments.sequenceId, sequenceId), eq(enrollments.workspaceId, ws)))
    .groupBy(enrollments.currentStep);
  return rows.map((r) => ({ step: Number(r.step), count: Number(r.n) })).sort((a, b) => a.step - b.step);
}

/** A sequence's enrolments by status, counted in SQL. */
export async function enrollmentStatusCounts(db: Db, ws: number, sequenceId: number): Promise<{ active: number; paused: number; finished: number; exited: number }> {
  const rows = await db.select({ status: enrollments.status, n: sql<number>`count(*)` }).from(enrollments)
    .where(and(eq(enrollments.sequenceId, sequenceId), eq(enrollments.workspaceId, ws)))
    .groupBy(enrollments.status);
  const out = { active: 0, paused: 0, finished: 0, exited: 0 };
  for (const r of rows) if (r.status in out) out[r.status as keyof typeof out] = Number(r.n);
  return out;
}
