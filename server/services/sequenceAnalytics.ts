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
 */
import { and, asc, eq, gt, gte, inArray, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import { emailDrafts, enrollments, sequences } from "../../drizzle/schema";
import { getDb } from "../db";

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
  if (opts.dateFrom) drafts.push(gte(emailDrafts.sentAt, new Date(opts.dateFrom)));
  if (opts.dateTo) drafts.push(lte(emailDrafts.sentAt, new Date(`${opts.dateTo}T23:59:59Z`)));
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
