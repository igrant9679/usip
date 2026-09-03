/**
 * performanceMetrics.ts — the ONE place that answers "what is actually working?"
 *
 * Every optimisation surface (the A/B tab, the Phase-1 "What's working"
 * dashboard, and later the per-module analyzers that propose tweaks) reads its
 * numbers from here. Deliberately ONE module so two surfaces can never disagree
 * about the same metric — the failure mode when each screen writes its own SQL.
 *
 * Design rule: DERIVE, don't denormalise. Every figure below is computed from
 * source-of-truth rows that the app already writes:
 *
 *   sequence steps → email_drafts (sequenceId + stepIndex + openCount/clickCount)
 *                    joined to email_replies (draftId → replyClass, meetingId)
 *   ARE A/B        → are_execution_queue (status='sent', messageContent.variantKey)
 *                    joined to are_signal_log (email_reply / meeting_booked)
 *
 * This is why Phase 0 needed no migration: the linkage columns already existed,
 * only the aggregation was missing. `are_ab_variants.sentCount/openCount/
 * replyCount/meetingCount` are the legacy denormalised counters — they were
 * NEVER written by any code path (the A/B tab therefore rendered permanent 0%
 * reply-rate bars). Rather than start writing four counters that can drift, the
 * A/B tab now reads computed stats from here; those columns stay untouched and
 * the table keeps only its metadata role (subject line, hook type).
 *
 * OPENS — available for both paths as of migration 0129. Sequence mail carries a
 * pixel via email_drafts; ARE campaign sends now carry a per-SEND token on
 * are_execution_queue (so an open resolves to an exact campaign + step +
 * variant). Two deliberate rules:
 *   • Opens count DISTINCT MESSAGES opened, never raw pixel hits. Apple Mail
 *     Privacy Protection and security scanners prefetch images, so a hit count
 *     measures proxies as much as people.
 *   • The open rate is computed over TRACKABLE sends only. Sends dispatched
 *     before 0129 have no token and can never report an open; leaving them in
 *     the denominator would understate the rate forever. `opensTracked` is
 *     false for those cells, so the UI can say "not tracked" rather than "0%".
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { genuineReplyScope } from "./replyScope";
import { getDb } from "../db";
import {
  areAbVariants,
  areExecutionQueue,
  areSignalLog,
  chatSessions,
  emailDrafts,
  emailReplies,
  opportunities,
  prospectQueue,
  voiceCalls,
} from "../../drizzle/schema";
import { normalizeVariantKey } from "@shared/variantKeys";

/** Percentage (0-100, one decimal) guarded against a zero denominator. */
export function rate(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/* ─── Sequence step performance ─────────────────────────────────────────── */

export interface SequenceStepStats {
  sequenceId: number;
  stepIndex: number;
  sent: number;
  opens: number;
  clicks: number;
  replies: number;
  /** Replies classified `willing_to_meet` — the signal that actually matters. */
  positiveReplies: number;
  /** Replies that produced a meetings row. */
  meetings: number;
  openRate: number;
  replyRate: number;
  positiveRate: number;
  meetingRate: number;
}

/**
 * Per-step outcomes for the workspace's sequences (optionally one sequence).
 *
 * Answers the question the app could not answer before: "which step actually
 * books meetings?" Only `status='sent'` drafts count toward `sent`, so drafts
 * awaiting review never inflate the denominator.
 */
export async function getSequenceStepStats(
  workspaceId: number,
  opts: { sequenceId?: number } = {},
): Promise<SequenceStepStats[]> {
  const db = await getDb();
  if (!db) return [];

  const sentWhere = [
    eq(emailDrafts.workspaceId, workspaceId),
    isNotNull(emailDrafts.sequenceId),
    isNotNull(emailDrafts.stepIndex),
    eq(emailDrafts.status, "sent" as never),
  ];
  if (opts.sequenceId !== undefined) sentWhere.push(eq(emailDrafts.sequenceId, opts.sequenceId));

  const sentRows = await db
    .select({
      sequenceId: emailDrafts.sequenceId,
      stepIndex: emailDrafts.stepIndex,
      sent: sql<number>`count(*)`,
      opens: sql<number>`coalesce(sum(${emailDrafts.openCount}), 0)`,
      clicks: sql<number>`coalesce(sum(${emailDrafts.clickCount}), 0)`,
    })
    .from(emailDrafts)
    .where(and(...sentWhere))
    .groupBy(emailDrafts.sequenceId, emailDrafts.stepIndex);

  // Replies are attributed through the draft that produced them, so a reply
  // always lands on the exact step that earned it.
  const replyWhere = [
    eq(emailDrafts.workspaceId, workspaceId),
    isNotNull(emailDrafts.sequenceId),
    isNotNull(emailDrafts.stepIndex),
  ];
  if (opts.sequenceId !== undefined) replyWhere.push(eq(emailDrafts.sequenceId, opts.sequenceId));

  const replyRows = await db
    .select({
      sequenceId: emailDrafts.sequenceId,
      stepIndex: emailDrafts.stepIndex,
      replies: sql<number>`count(*)`,
      positiveReplies: sql<number>`sum(case when ${emailReplies.replyClass} = 'willing_to_meet' then 1 else 0 end)`,
      meetings: sql<number>`sum(case when ${emailReplies.meetingId} is not null then 1 else 0 end)`,
    })
    .from(emailReplies)
    .innerJoin(emailDrafts, eq(emailReplies.draftId, emailDrafts.id))
    .where(and(...replyWhere))
    .groupBy(emailDrafts.sequenceId, emailDrafts.stepIndex);

  const key = (s: unknown, i: unknown) => `${Number(s)}:${Number(i)}`;
  const replyMap = new Map<string, { replies: number; positiveReplies: number; meetings: number }>();
  for (const r of replyRows) {
    replyMap.set(key(r.sequenceId, r.stepIndex), {
      replies: Number(r.replies ?? 0),
      positiveReplies: Number(r.positiveReplies ?? 0),
      meetings: Number(r.meetings ?? 0),
    });
  }

  const out: SequenceStepStats[] = sentRows.map((row) => {
    const o = replyMap.get(key(row.sequenceId, row.stepIndex));
    const sent = Number(row.sent ?? 0);
    const opens = Number(row.opens ?? 0);
    const replies = o?.replies ?? 0;
    const positiveReplies = o?.positiveReplies ?? 0;
    const meetings = o?.meetings ?? 0;
    return {
      sequenceId: Number(row.sequenceId),
      stepIndex: Number(row.stepIndex),
      sent,
      opens,
      clicks: Number(row.clicks ?? 0),
      replies,
      positiveReplies,
      meetings,
      openRate: rate(opens, sent),
      replyRate: rate(replies, sent),
      positiveRate: rate(positiveReplies, sent),
      meetingRate: rate(meetings, sent),
    };
  });

  out.sort((a, b) => a.sequenceId - b.sequenceId || a.stepIndex - b.stepIndex);
  return out;
}

/* ─── Sourcing yield by source ──────────────────────────────────────────── */

export interface SourceYieldStats {
  sourceType: string;
  discovered: number;
  contacted: number;
  replied: number;
  meetings: number;
  /** Mean ICP match score of prospects this source produced (0-100). */
  avgIcpScore: number;
  contactedRate: number;
  /** replied / contacted — reply quality of the people this source found. */
  replyRate: number;
  /** meetings / contacted — THE metric that matters. */
  meetingRate: number;
}

/**
 * Per-source sourcing yield, scored on OUTCOMES rather than volume.
 *
 * A source that finds 500 prospects and books nothing is worse than one that
 * finds 20 and books three; ranking by `prospectsDiscovered` (what the campaign
 * cards show) actively misleads. `meetingRate` is therefore the headline column.
 *
 * Counts are DISTINCT prospects, so a prospect who got four sends still counts
 * once toward `contacted` and can't inflate a source's apparent reach.
 */
export async function getSourceYieldStats(workspaceId: number): Promise<SourceYieldStats[]> {
  const db = await getDb();
  if (!db) return [];

  const discovered = await db
    .select({
      sourceType: prospectQueue.sourceType,
      n: sql<number>`count(*)`,
      avgIcp: sql<number>`coalesce(avg(${prospectQueue.icpMatchScore}), 0)`,
    })
    .from(prospectQueue)
    .where(eq(prospectQueue.workspaceId, workspaceId))
    .groupBy(prospectQueue.sourceType);

  // Contacted = at least one dispatched send, counted once per prospect.
  const contacted = await db
    .select({
      sourceType: prospectQueue.sourceType,
      n: sql<number>`count(distinct ${prospectQueue.id})`,
    })
    .from(areExecutionQueue)
    .innerJoin(prospectQueue, eq(areExecutionQueue.prospectQueueId, prospectQueue.id))
    .where(and(
      eq(areExecutionQueue.workspaceId, workspaceId),
      eq(areExecutionQueue.status, "sent" as never),
    ))
    .groupBy(prospectQueue.sourceType);

  const outcomes = await db
    .select({
      sourceType: prospectQueue.sourceType,
      signalType: areSignalLog.signalType,
      n: sql<number>`count(distinct ${prospectQueue.id})`,
    })
    .from(areSignalLog)
    .innerJoin(prospectQueue, eq(areSignalLog.prospectQueueId, prospectQueue.id))
    .where(eq(areSignalLog.workspaceId, workspaceId))
    .groupBy(prospectQueue.sourceType, areSignalLog.signalType);

  const contactedMap = new Map(contacted.map((r) => [String(r.sourceType), Number(r.n ?? 0)]));
  const repliedMap = new Map<string, number>();
  const meetingMap = new Map<string, number>();
  for (const row of outcomes) {
    const src = String(row.sourceType);
    const t = String(row.signalType);
    if (t === "email_reply") repliedMap.set(src, (repliedMap.get(src) ?? 0) + Number(row.n ?? 0));
    else if (t === "meeting_booked") meetingMap.set(src, (meetingMap.get(src) ?? 0) + Number(row.n ?? 0));
  }

  const out: SourceYieldStats[] = discovered.map((row) => {
    const src = String(row.sourceType);
    const disc = Number(row.n ?? 0);
    const cont = contactedMap.get(src) ?? 0;
    const rep = repliedMap.get(src) ?? 0;
    const mtg = meetingMap.get(src) ?? 0;
    return {
      sourceType: src,
      discovered: disc,
      contacted: cont,
      replied: rep,
      meetings: mtg,
      avgIcpScore: Math.round(Number(row.avgIcp ?? 0)),
      contactedRate: rate(cont, disc),
      replyRate: rate(rep, cont),
      meetingRate: rate(mtg, cont),
    };
  });

  // Best outcome first; volume only breaks ties.
  out.sort((a, b) => b.meetingRate - a.meetingRate || b.replyRate - a.replyRate || b.discovered - a.discovered);
  return out;
}

/* ─── Inbound reply mix ─────────────────────────────────────────────────── */

export interface ReplyClassStats {
  replyClass: string;
  count: number;
  share: number;
}

export interface ReplyMix {
  /** Class breakdown of replies to OUR outbound only. */
  classes: ReplyClassStats[];
  /** Replies matched to a draft we sent — the denominator for `classes`. */
  attributed: number;
  /**
   * Inbound mail with no matching outbound draft. Reported so the number is
   * visible rather than silently dropped, but deliberately EXCLUDED from the
   * mix above.
   */
  unattributedInbound: number;
}

/**
 * Breakdown of replies by the 8-class taxonomy, scoped to replies that answer
 * something WE sent (`draftId IS NOT NULL`).
 *
 * The scope is the whole point. inboundReplyPoller inserts a row for every
 * processed inbound message, with `draftId` null when it matches no outbound
 * draft — so `email_replies` is the workspace's entire synced mailbox, not its
 * campaign replies. Measured unscoped on live data this read 61k rows, 98%
 * unclassified: the user's personal inbox, swamping the few hundred real
 * campaign replies. Any analyzer that later reasons over "reply mix" would have
 * been learning from private mail against a meaningless denominator.
 */
export async function getReplyMix(workspaceId: number): Promise<ReplyMix> {
  const db = await getDb();
  if (!db) return { classes: [], attributed: 0, unattributedInbound: 0 };

  const rows = await db
    .select({
      replyClass: emailReplies.replyClass,
      n: sql<number>`count(*)`,
    })
    .from(emailReplies)
    // Attributed = the shared genuine-reply scope (draft- OR campaign-matched).
    .where(and(eq(emailReplies.workspaceId, workspaceId), genuineReplyScope()))
    .groupBy(emailReplies.replyClass);

  const [unmatched] = await db
    .select({ n: sql<number>`count(*)` })
    .from(emailReplies)
    .where(and(eq(emailReplies.workspaceId, workspaceId), isNull(emailReplies.draftId), isNull(emailReplies.campaignId)));

  const attributed = rows.reduce((n, r) => n + Number(r.n ?? 0), 0);
  const classes = rows.map((r) => ({
    // A matched reply the classifier hasn't processed is still a real reply.
    replyClass: r.replyClass ? String(r.replyClass) : "unclassified",
    count: Number(r.n ?? 0),
    share: rate(Number(r.n ?? 0), attributed),
  }));
  classes.sort((a, b) => b.count - a.count);
  return { classes, attributed, unattributedInbound: Number(unmatched?.n ?? 0) };
}

/* ─── Segment performance (feeds ICP learning) ──────────────────────────── */

export interface SegmentStats {
  dimension: "industry" | "title" | "companySize" | "geography";
  value: string;
  prospects: number;
  contacted: number;
  replied: number;
  meetings: number;
  replyRate: number;
  meetingRate: number;
}

/**
 * Outbound outcomes grouped by ICP dimension.
 *
 * This is the input the ICP inference never had: it learns only from CLOSED
 * deals, so a workspace with no won deals (the common early case) produced a
 * zero-confidence profile even when hundreds of prospects had been worked.
 * Reply and meeting rates per industry/title/size/geography are real learning
 * signal available long before the first close.
 */
export async function getSegmentPerformance(
  workspaceId: number,
  opts: { minProspects?: number } = {},
): Promise<SegmentStats[]> {
  const db = await getDb();
  if (!db) return [];
  const minProspects = opts.minProspects ?? 5;

  // Prospects that were actually contacted, and their outcome signals.
  const contactedRows = await db
    .selectDistinct({
      id: prospectQueue.id,
      industry: prospectQueue.industry,
      title: prospectQueue.title,
      companySize: prospectQueue.companySize,
      geography: prospectQueue.geography,
    })
    .from(prospectQueue)
    .innerJoin(areExecutionQueue, eq(areExecutionQueue.prospectQueueId, prospectQueue.id))
    .where(and(
      eq(prospectQueue.workspaceId, workspaceId),
      eq(areExecutionQueue.status, "sent" as never),
    ));
  if (contactedRows.length === 0) return [];

  const signals = await db
    .select({ prospectQueueId: areSignalLog.prospectQueueId, signalType: areSignalLog.signalType })
    .from(areSignalLog)
    .where(eq(areSignalLog.workspaceId, workspaceId));

  const repliedIds = new Set<number>();
  const meetingIds = new Set<number>();
  for (const s of signals) {
    const t = String(s.signalType);
    if (t === "email_reply") repliedIds.add(Number(s.prospectQueueId));
    else if (t === "meeting_booked") meetingIds.add(Number(s.prospectQueueId));
  }

  const DIMS: Array<SegmentStats["dimension"]> = ["industry", "title", "companySize", "geography"];
  const buckets = new Map<string, SegmentStats>();
  for (const row of contactedRows) {
    for (const dim of DIMS) {
      const raw = (row as any)[dim];
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value) continue; // never bucket under "unknown" — it teaches nothing
      const key = `${dim}:${value.toLowerCase()}`;
      const b = buckets.get(key) ?? {
        dimension: dim, value, prospects: 0, contacted: 0, replied: 0,
        meetings: 0, replyRate: 0, meetingRate: 0,
      };
      b.prospects += 1;
      b.contacted += 1;
      if (repliedIds.has(Number(row.id))) b.replied += 1;
      if (meetingIds.has(Number(row.id))) b.meetings += 1;
      buckets.set(key, b);
    }
  }

  const out = [...buckets.values()]
    .filter((b) => b.contacted >= minProspects)
    .map((b) => ({ ...b, replyRate: rate(b.replied, b.contacted), meetingRate: rate(b.meetings, b.contacted) }));
  out.sort((a, b) => b.meetingRate - a.meetingRate || b.replyRate - a.replyRate || b.contacted - a.contacted);
  return out;
}

/* ─── Per-rep outbound performance (SDR coaching) ───────────────────────── */

export interface RepStats {
  userId: number;
  sent: number;
  replies: number;
  positiveReplies: number;
  replyRate: number;
  positiveRate: number;
}

/**
 * Per-rep send/reply performance from their own drafts.
 *
 * Replies are joined through `draftId`, which also scopes them correctly — see
 * getReplyMix: email_replies holds ALL synced inbound mail, so an unscoped
 * per-rep count would be measuring each rep's personal inbox.
 */
export async function getRepPerformance(workspaceId: number): Promise<RepStats[]> {
  const db = await getDb();
  if (!db) return [];

  const sent = await db
    .select({
      userId: emailDrafts.createdByUserId,
      sent: sql<number>`count(*)`,
    })
    .from(emailDrafts)
    .where(and(
      eq(emailDrafts.workspaceId, workspaceId),
      eq(emailDrafts.status, "sent" as never),
      isNotNull(emailDrafts.createdByUserId),
    ))
    .groupBy(emailDrafts.createdByUserId);
  if (sent.length === 0) return [];

  const replies = await db
    .select({
      userId: emailDrafts.createdByUserId,
      replies: sql<number>`count(*)`,
      positive: sql<number>`sum(case when ${emailReplies.replyClass} = 'willing_to_meet' then 1 else 0 end)`,
    })
    .from(emailReplies)
    .innerJoin(emailDrafts, eq(emailReplies.draftId, emailDrafts.id))
    .where(and(
      eq(emailDrafts.workspaceId, workspaceId),
      isNotNull(emailDrafts.createdByUserId),
    ))
    .groupBy(emailDrafts.createdByUserId);

  const rmap = new Map(replies.map((r) => [Number(r.userId), r]));
  const out = sent.map((s) => {
    const r = rmap.get(Number(s.userId));
    const n = Number(s.sent ?? 0);
    const rep = Number(r?.replies ?? 0);
    const pos = Number(r?.positive ?? 0);
    return {
      userId: Number(s.userId),
      sent: n,
      replies: rep,
      positiveReplies: pos,
      replyRate: rate(rep, n),
      positiveRate: rate(pos, n),
    };
  });
  out.sort((a, b) => b.replyRate - a.replyRate);
  return out;
}

/* ─── Win/loss + pipeline shape (CRM) ───────────────────────────────────── */

export interface WinLossStats {
  won: number;
  lost: number;
  open: number;
  winRate: number;
  /** Lost-reason clusters, most common first. */
  lostReasons: Array<{ reason: string; count: number; share: number }>;
  /** Open pipeline by stage — reveals where deals pile up. */
  openByStage: Array<{ stage: string; count: number }>;
  avgWonValue: number;
}

export async function getWinLossStats(workspaceId: number): Promise<WinLossStats> {
  const empty: WinLossStats = { won: 0, lost: 0, open: 0, winRate: 0, lostReasons: [], openByStage: [], avgWonValue: 0 };
  const db = await getDb();
  if (!db) return empty;

  const byStage = await db
    .select({
      stage: opportunities.stage,
      n: sql<number>`count(*)`,
      avgValue: sql<number>`coalesce(avg(${opportunities.value}), 0)`,
    })
    .from(opportunities)
    .where(eq(opportunities.workspaceId, workspaceId))
    .groupBy(opportunities.stage);
  if (byStage.length === 0) return empty;

  let won = 0, lost = 0, open = 0, avgWonValue = 0;
  const openByStage: Array<{ stage: string; count: number }> = [];
  for (const row of byStage) {
    const stage = String(row.stage);
    const n = Number(row.n ?? 0);
    if (stage === "won") { won = n; avgWonValue = Math.round(Number(row.avgValue ?? 0)); }
    else if (stage === "lost") lost = n;
    else { open += n; openByStage.push({ stage, count: n }); }
  }
  openByStage.sort((a, b) => b.count - a.count);

  const reasonRows = await db
    .select({ reason: opportunities.lostReason, n: sql<number>`count(*)` })
    .from(opportunities)
    .where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.stage, "lost")))
    .groupBy(opportunities.lostReason);
  const reasonTotal = reasonRows.reduce((n, r) => n + Number(r.n ?? 0), 0);
  const lostReasons = reasonRows
    .map((r) => ({
      reason: r.reason ? String(r.reason) : "not recorded",
      count: Number(r.n ?? 0),
      share: rate(Number(r.n ?? 0), reasonTotal),
    }))
    .sort((a, b) => b.count - a.count);

  return { won, lost, open, winRate: rate(won, won + lost), lostReasons, openByStage, avgWonValue };
}

/* ─── Voice call outcomes ───────────────────────────────────────────────── */

export interface VoiceStats {
  direction: "inbound" | "outbound";
  calls: number;
  connected: number;
  noAnswer: number;
  failed: number;
  connectRate: number;
  avgDurationSec: number;
}

export async function getVoiceStats(workspaceId: number): Promise<VoiceStats[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      direction: voiceCalls.direction,
      status: voiceCalls.status,
      n: sql<number>`count(*)`,
      avgDur: sql<number>`coalesce(avg(${voiceCalls.durationSec}), 0)`,
    })
    .from(voiceCalls)
    .where(eq(voiceCalls.workspaceId, workspaceId))
    .groupBy(voiceCalls.direction, voiceCalls.status);
  if (rows.length === 0) return [];

  const acc = new Map<string, VoiceStats & { durWeight: number }>();
  for (const r of rows) {
    const dir = String(r.direction) as VoiceStats["direction"];
    const cur = acc.get(dir) ?? {
      direction: dir, calls: 0, connected: 0, noAnswer: 0, failed: 0,
      connectRate: 0, avgDurationSec: 0, durWeight: 0,
    };
    const n = Number(r.n ?? 0);
    const status = String(r.status);
    cur.calls += n;
    if (status === "completed") {
      cur.connected += n;
      cur.durWeight += Number(r.avgDur ?? 0) * n;
    } else if (status === "no_answer") cur.noAnswer += n;
    else if (status === "failed") cur.failed += n;
    acc.set(dir, cur);
  }
  return [...acc.values()].map(({ durWeight, ...v }) => ({
    ...v,
    connectRate: rate(v.connected, v.calls),
    avgDurationSec: v.connected > 0 ? Math.round(durWeight / v.connected) : 0,
  }));
}

/* ─── ARE A/B variant performance ───────────────────────────────────────── */

export interface AbVariantStats {
  stepIndex: number;
  variantKey: string;
  /** Metadata from are_ab_variants when a variant row exists. */
  subjectLine: string | null;
  hookType: string | null;
  bodyPreview: string | null;
  sent: number;
  /** Distinct messages opened at least once (not raw pixel hits). */
  opens: number;
  openRate: number;
  replies: number;
  meetings: number;
  replyRate: number;
  meetingRate: number;
  /**
   * True once sends in this cell carry a tracking pixel (migration 0129).
   * Sends dispatched BEFORE that migration have no token and can never report
   * opens, so this stays false for them rather than showing a misleading 0%.
   */
  opensTracked: boolean;
  /** Below this, differences are noise — the UI must not crown a winner. */
  sampleSufficient: boolean;
}

/** Minimum sends per variant before a reply-rate comparison means anything. */
export const MIN_VARIANT_SAMPLE = 20;

export interface VariantSendRow {
  prospectQueueId: number;
  stepIndex: number;
  variantKey: string;
  executedAt: Date | string | null;
  /** Set on the first open of this message (migration 0129). */
  openedAt?: Date | string | null;
  /** Absent on sends dispatched before open tracking existed. */
  trackingToken?: string | null;
}
export interface VariantSignalRow {
  prospectQueueId: number;
  signalType: string;
}
export interface VariantCell {
  sent: number;
  replies: number;
  meetings: number;
  /** Distinct messages opened at least once. */
  opens: number;
  /** Sends in this cell that carry a tracking pixel and so COULD report an open. */
  trackable: number;
}

export const variantCellKey = (stepIndex: number, variantKey: string) => `${stepIndex}:${variantKey}`;

/**
 * Fold sends + signals into per-(step, variant) counts. Pure — extracted from
 * the DB query so the attribution rules are unit-testable, since this is the
 * part most likely to be subtly wrong.
 *
 * Attribution: a signal row records the PROSPECT, not the message that provoked
 * it, so each reply/meeting is credited to that prospect's most recent send
 * (last-touch). Ties on timestamp (or missing timestamps) resolve to the higher
 * step index, i.e. the later message in the sequence.
 */
export function computeVariantCells(
  sends: VariantSendRow[],
  signals: VariantSignalRow[],
): Map<string, VariantCell> {
  const cells = new Map<string, VariantCell>();
  const bump = (k: string, field: keyof VariantCell) => {
    const c = cells.get(k) ?? { sent: 0, replies: 0, meetings: 0, opens: 0, trackable: 0 };
    c[field] += 1;
    cells.set(k, c);
  };

  const lastByProspect = new Map<number, { step: number; v: string; at: number }>();
  for (const s of sends) {
    const step = Number(s.stepIndex ?? 0);
    // Normalised, not just defaulted: `variantKey` was an unconstrained string
    // an LLM supplied for the whole life of this feature, so historical rows
    // can carry anything. An unrecognised key must fold into A rather than
    // render as a second "variant" splitting the sample — shared/variantKeys.ts.
    const v = normalizeVariantKey(s.variantKey);
    bump(variantCellKey(step, v), "sent");
    // Only sends carrying a pixel can ever report an open; counting pre-0129
    // sends in the denominator would understate the open rate forever.
    if (s.trackingToken) bump(variantCellKey(step, v), "trackable");
    if (s.openedAt) bump(variantCellKey(step, v), "opens");
    const pid = Number(s.prospectQueueId);
    const at = s.executedAt ? new Date(s.executedAt).getTime() : 0;
    const prev = lastByProspect.get(pid);
    if (!prev || at > prev.at || (at === prev.at && step >= prev.step)) {
      lastByProspect.set(pid, { step, v, at });
    }
  }

  for (const sig of signals) {
    const t = String(sig.signalType);
    if (t !== "email_reply" && t !== "meeting_booked") continue;
    const last = lastByProspect.get(Number(sig.prospectQueueId));
    if (!last) continue; // signal with no recorded send — nothing to attribute to
    bump(variantCellKey(last.step, last.v), t === "email_reply" ? "replies" : "meetings");
  }

  return cells;
}

/* ─── Step funnel (Sankey) ───────────────────────────────────────────────── */

/**
 * What the funnel needs from a send. Deliberately NOT `VariantSendRow`: the
 * funnel groups by prospect and step and never looks at a variant, so it must
 * not have to invent a variant key to describe a row (`areAbVariantWiring`
 * rightly rejects a hardcoded one — a variant label is a value this system
 * ASSIGNS, and inventing one here would put a fictional "A" in a type that
 * flows on to code which does care).
 */
export interface FunnelSendRow {
  prospectQueueId: number;
  stepIndex: number;
  openedAt?: Date | string | null;
  trackingToken?: string | null;
}

export interface FunnelNode {
  /** Stable id, referenced by links. */
  id: string;
  name: string;
  /** step | opened | unopened | replied | meeting | dormant */
  kind: "step" | "opened" | "unopened" | "replied" | "meeting" | "dormant";
  /** Present on step/opened/unopened nodes. Zero-based, as stored. */
  stepIndex: number | null;
  value: number;
}

export interface FunnelLink {
  source: string;
  target: string;
  value: number;
}

export interface StepFunnel {
  nodes: FunnelNode[];
  links: FunnelLink[];
  /** Prospects with at least one dispatched send — the funnel's entry width. */
  totalProspects: number;
  /**
   * WHO is behind each node and each link — prospect_queue ids, recorded in
   * the same pass that counts them, so a click on the chart lists exactly the
   * people the band counted (owner ask 2026-08-19). Links keyed "source|target".
   */
  members: { nodes: Record<string, number[]>; links: Record<string, number[]> };
  /**
   * True when NO send in this campaign carries a tracking pixel, so the
   * opened/not-opened split cannot mean anything and the chart says so instead
   * of drawing every prospect as unopened.
   */
  opensTracked: boolean;
}

/**
 * Per-prospect journey through the sequence, as Sankey nodes and links.
 *
 * Pure, and separate from `computeVariantCells`, because this answers a
 * different question. The cards count per step ("how did step 2 do"); this
 * follows PEOPLE ("of those who did not open step 1, how many got step 2, and
 * how many of those replied"). The two use the same attribution rule — a
 * signal names a prospect, not a message, so a reply is credited to that
 * prospect's most recent send — so their totals reconcile.
 *
 * Shape, left to right:
 *
 *   Step 1 ─▶ Opened ─▶ Step 2 ─▶ … ─▶ Replied ─▶ Meeting booked
 *          └▶ Not opened ─┘              └▶ No further contact
 *
 * A prospect leaves the flow at their LAST send: into `Replied` if a reply or
 * meeting was attributed to them, else into `No further contact` — which
 * includes people still mid-sequence, so it reads as "not yet", not "lost".
 *
 * Every link is a real count of real prospects. Nothing is inferred: a
 * prospect who received step 3 without step 2 flows straight from 1 to 3.
 */
export function computeStepFunnel(
  sends: FunnelSendRow[],
  signals: VariantSignalRow[],
): StepFunnel {
  const opensTracked = sends.some((s) => !!s.trackingToken);

  // Plain records rather than Maps throughout: this project's tsconfig target
  // predates downlevel Map iteration, so `for…of` over one is a type error.
  const byProspect: Record<string, FunnelSendRow[]> = {};
  for (const s of sends) {
    const pid = String(s.prospectQueueId);
    (byProspect[pid] ??= []).push(s);
  }
  const prospectIds = Object.keys(byProspect);
  for (const pid of prospectIds) {
    byProspect[pid].sort(
      (a: FunnelSendRow, b: FunnelSendRow) => Number(a.stepIndex ?? 0) - Number(b.stepIndex ?? 0),
    );
    // ONE visit per prospect per step. The engine can dispatch the same step
    // to a prospect twice (a retry, a re-send after an edit), and this funnel
    // is a per-PROSPECT journey: two rows at step 0 drew a band from "No open
    // on step 1" BACK into "Step 1" — a cycle. Recharts' Sankey walks depth
    // recursively with no cycle guard, so it recursed until the stack blew,
    // the chart threw, and the Step performance tab lost it (CF campaigns 19
    // and 21, found 2026-09-03). Same-step rows merge: opened if any was,
    // a pixel if any carried one — so the step still counts that person once.
    const merged: FunnelSendRow[] = [];
    for (const s of byProspect[pid]) {
      const last = merged[merged.length - 1];
      if (last && Number(last.stepIndex ?? 0) === Number(s.stepIndex ?? 0)) {
        merged[merged.length - 1] = {
          ...last,
          openedAt: last.openedAt || s.openedAt || null,
          trackingToken: last.trackingToken || s.trackingToken || null,
        };
      } else {
        merged.push(s);
      }
    }
    byProspect[pid] = merged;
  }

  const replied: Record<string, true> = {};
  const booked: Record<string, true> = {};
  for (const sig of signals) {
    const t = String(sig.signalType);
    if (t === "email_reply") replied[String(sig.prospectQueueId)] = true;
    if (t === "meeting_booked") booked[String(sig.prospectQueueId)] = true;
  }

  const linkTotals: Record<string, number> = {};
  const linkMembers: Record<string, number[]> = {};
  const nodeMembers: Record<string, number[]> = {};
  let currentPid = 0;
  const addLink = (source: string, target: string) => {
    const k = `${source}|${target}`;
    linkTotals[k] = (linkTotals[k] ?? 0) + 1;
    (linkMembers[k] ??= []).push(currentPid);
  };
  const addMember = (nodeId: string) => { (nodeMembers[nodeId] ??= []).push(currentPid); };

  const stepCount: Record<number, number> = {};
  const openedCount: Record<number, number> = {};
  const unopenedCount: Record<number, number> = {};
  let repliedTotal = 0;
  let meetingTotal = 0;
  let dormantTotal = 0;

  for (const pid of prospectIds) {
    const timeline = byProspect[pid];
    currentPid = Number(pid);
    for (let i = 0; i < timeline.length; i++) {
      const send = timeline[i];
      const step = Number(send.stepIndex ?? 0);
      stepCount[step] = (stepCount[step] ?? 0) + 1;
      addMember(`step:${step}`);

      // The engagement branch. With no pixel on the send there is no honest
      // split to draw, so everyone takes the "not opened" side and the caller
      // is told opens are untracked rather than shown a 0% open rate.
      const opened = !!send.openedAt;
      const branch = opened ? `opened:${step}` : `unopened:${step}`;
      if (opened) openedCount[step] = (openedCount[step] ?? 0) + 1;
      else unopenedCount[step] = (unopenedCount[step] ?? 0) + 1;
      addMember(branch);
      addLink(`step:${step}`, branch);

      const next = timeline[i + 1];
      if (next) {
        addLink(branch, `step:${Number(next.stepIndex ?? 0)}`);
        continue;
      }
      // Last send for this prospect — where do they end up?
      if (replied[pid] || booked[pid]) {
        addLink(branch, "replied");
        addMember("replied");
        repliedTotal++;
        if (booked[pid]) {
          addLink("replied", "meeting");
          addMember("meeting");
          meetingTotal++;
        }
      } else {
        addLink(branch, "dormant");
        addMember("dormant");
        dormantTotal++;
      }
    }
  }

  const nodes: FunnelNode[] = [];
  const steps = Object.keys(stepCount).map(Number).sort((a, b) => a - b);
  for (const step of steps) {
    nodes.push({ id: `step:${step}`, name: `Step ${step + 1}`, kind: "step", stepIndex: step, value: stepCount[step] ?? 0 });
    if ((openedCount[step] ?? 0) > 0) {
      nodes.push({ id: `opened:${step}`, name: `Opened step ${step + 1}`, kind: "opened", stepIndex: step, value: openedCount[step] });
    }
    if ((unopenedCount[step] ?? 0) > 0) {
      nodes.push({
        id: `unopened:${step}`,
        name: opensTracked ? `No open on step ${step + 1}` : `Step ${step + 1} — opens untracked`,
        kind: "unopened",
        stepIndex: step,
        value: unopenedCount[step],
      });
    }
  }
  if (repliedTotal > 0) nodes.push({ id: "replied", name: "Replied", kind: "replied", stepIndex: null, value: repliedTotal });
  if (meetingTotal > 0) nodes.push({ id: "meeting", name: "Meeting booked", kind: "meeting", stepIndex: null, value: meetingTotal });
  if (dormantTotal > 0) nodes.push({ id: "dormant", name: "No reply yet", kind: "dormant", stepIndex: null, value: dormantTotal });

  const present: Record<string, true> = {};
  for (const n of nodes) present[n.id] = true;
  const links: FunnelLink[] = [];
  for (const k of Object.keys(linkTotals)) {
    const [source, target] = k.split("|");
    // A link to a node that was never emitted would break the chart.
    if (present[source] && present[target]) links.push({ source, target, value: linkTotals[k] });
  }

  // Only members of nodes/links that were actually emitted.
  const memberNodes: Record<string, number[]> = {};
  for (const n of nodes) if (nodeMembers[n.id]) memberNodes[n.id] = nodeMembers[n.id];
  const memberLinks: Record<string, number[]> = {};
  for (const l of links) { const k = `${l.source}|${l.target}`; if (linkMembers[k]) memberLinks[k] = linkMembers[k]; }

  return { nodes, links, totalProspects: prospectIds.length, opensTracked, members: { nodes: memberNodes, links: memberLinks } };
}

/**
 * The step funnel for one ARE campaign, from live execution rows.
 *
 * Reads the same two tables `getAbVariantStats` does, so the Sankey and the
 * step cards can never disagree about what happened.
 */
export async function getStepFunnel(
  workspaceId: number,
  campaignId: number,
): Promise<StepFunnel> {
  const db = await getDb();
  if (!db) return { nodes: [], links: [], totalProspects: 0, opensTracked: false, members: { nodes: {}, links: {} } };

  const sends = await db
    .select({
      prospectQueueId: areExecutionQueue.prospectQueueId,
      stepIndex: areExecutionQueue.stepIndex,
      executedAt: areExecutionQueue.executedAt,
      openedAt: areExecutionQueue.openedAt,
      trackingToken: areExecutionQueue.trackingToken,
    })
    .from(areExecutionQueue)
    .where(and(
      eq(areExecutionQueue.workspaceId, workspaceId),
      eq(areExecutionQueue.campaignId, campaignId),
      eq(areExecutionQueue.status, "sent" as never),
    ));

  const signals = await db
    .select({
      prospectQueueId: areSignalLog.prospectQueueId,
      signalType: areSignalLog.signalType,
    })
    .from(areSignalLog)
    .where(and(
      eq(areSignalLog.workspaceId, workspaceId),
      eq(areSignalLog.campaignId, campaignId),
    ));

  return computeStepFunnel(
    sends.map((s) => ({
      prospectQueueId: Number(s.prospectQueueId),
      stepIndex: Number(s.stepIndex ?? 0),
      openedAt: (s.openedAt as Date | null) ?? null,
      trackingToken: (s.trackingToken as string | null) ?? null,
    })),
    signals.map((s) => ({ prospectQueueId: Number(s.prospectQueueId), signalType: String(s.signalType) })),
  );
}

/**
 * Live A/B performance for one ARE campaign.
 *
 * `sent` comes from dispatched execution-queue rows (the only durable record of
 * an ARE send). Replies/meetings come from are_signal_log and are attributed to
 * the prospect's MOST RECENT sent step — last-touch attribution, because a
 * signal row records the prospect, not which message triggered it. Documented
 * rather than silently assumed.
 */
export async function getAbVariantStats(
  workspaceId: number,
  campaignId: number,
): Promise<AbVariantStats[]> {
  const db = await getDb();
  if (!db) return [];

  const variantKeyExpr = sql<string>`coalesce(json_unquote(json_extract(${areExecutionQueue.messageContent}, '$.variantKey')), 'A')`;

  const sends = await db
    .select({
      prospectQueueId: areExecutionQueue.prospectQueueId,
      stepIndex: areExecutionQueue.stepIndex,
      variantKey: variantKeyExpr,
      executedAt: areExecutionQueue.executedAt,
      // Migration 0129. Counted as distinct messages opened, NOT raw pixel hits
      // — mail privacy proxies prefetch images, so a hit count overstates
      // interest while "was it opened at all" stays meaningful.
      openedAt: areExecutionQueue.openedAt,
      trackingToken: areExecutionQueue.trackingToken,
    })
    .from(areExecutionQueue)
    .where(and(
      eq(areExecutionQueue.workspaceId, workspaceId),
      eq(areExecutionQueue.campaignId, campaignId),
      eq(areExecutionQueue.status, "sent" as never),
    ));

  const signals = await db
    .select({
      prospectQueueId: areSignalLog.prospectQueueId,
      signalType: areSignalLog.signalType,
    })
    .from(areSignalLog)
    .where(and(
      eq(areSignalLog.workspaceId, workspaceId),
      eq(areSignalLog.campaignId, campaignId),
    ));

  const cells = computeVariantCells(
    /**
     * ⚠️ `openedAt` and `trackingToken` MUST be carried through here.
     *
     * They were selected above (with a comment explaining why), read by
     * computeVariantCells (`if (s.trackingToken) bump(…, "trackable")`), and
     * dropped by this object literal in between — so `trackable` and `opens`
     * were structurally always 0 and every ARE step card read
     * "Opens: not tracked", no matter how many opens had been recorded.
     * Nothing failed; the seam between producer and consumer just lost two
     * fields. Owner spotted the contradiction: a step showing "not tracked"
     * beside a Signals feed showing that very message opened (2026-08-14).
     */
    sends.map((s) => ({
      prospectQueueId: Number(s.prospectQueueId),
      stepIndex: Number(s.stepIndex ?? 0),
      variantKey: String(s.variantKey ?? "A"),
      executedAt: (s.executedAt as Date | null) ?? null,
      openedAt: (s.openedAt as Date | null) ?? null,
      trackingToken: (s.trackingToken as string | null) ?? null,
    })),
    signals.map((s) => ({ prospectQueueId: Number(s.prospectQueueId), signalType: String(s.signalType) })),
  );
  const cellKey = variantCellKey;

  // Metadata (subject/hook) for cells that have a stored variant row.
  const stored = await db
    .select()
    .from(areAbVariants)
    .where(and(
      eq(areAbVariants.workspaceId, workspaceId),
      eq(areAbVariants.campaignId, campaignId),
    ));
  // Both sides of this join normalise the key the same way — a stored row whose
  // key or step index disagrees with the sends does not merely fail to label
  // them, it mints an extra cell here and the tab shows one variant twice.
  const storedKey = (r: typeof stored[number]) =>
    cellKey(Number(r.stepIndex), normalizeVariantKey(r.variantKey));
  for (const row of stored) {
    // Surface a defined variant even before its first send, so a freshly
    // generated variant appears at 0 sends instead of vanishing.
    const k = storedKey(row);
    if (!cells.has(k)) cells.set(k, { sent: 0, replies: 0, meetings: 0, opens: 0, trackable: 0 });
  }
  const metaMap = new Map(stored.map((r) => [storedKey(r), r]));

  const out: AbVariantStats[] = [...cells.entries()].map(([k, c]) => {
    const [stepStr, variantKey] = k.split(":");
    const meta = metaMap.get(k);
    return {
      stepIndex: Number(stepStr),
      variantKey,
      subjectLine: (meta?.subjectLine as string | null) ?? null,
      hookType: (meta?.hookType as string | null) ?? null,
      bodyPreview: (meta?.bodyPreview as string | null) ?? null,
      sent: c.sent,
      opens: c.opens,
      // Rate is over TRACKABLE sends, not all sends — mixing pre- and
      // post-pixel sends in the denominator would permanently understate it.
      openRate: rate(c.opens, c.trackable),
      replies: c.replies,
      meetings: c.meetings,
      replyRate: rate(c.replies, c.sent),
      meetingRate: rate(c.meetings, c.sent),
      opensTracked: c.trackable > 0,
      sampleSufficient: c.sent >= MIN_VARIANT_SAMPLE,
    };
  });

  out.sort((a, b) => a.stepIndex - b.stepIndex || a.variantKey.localeCompare(b.variantKey));
  return out;
}

/* ─── Per-dispatch step performance ────────────────────────────────────── */

/**
 * One row per SENT message — the individual dispatches that the per-step
 * aggregate above rolls up.
 *
 * Owner (2026-08-17): "It says 31 Step 1's were dispatched, so there should
 * be 31 Step 1 cards." The engine writes uniquely personalised copy for every
 * prospect, so a step is not one message sent 31 times; it is 31 different
 * messages. A card per step showed one specimen (the newest send) and gave
 * no way to see the other 30. This returns every one, with the prospect it
 * went to and THAT message's own open/reply/meeting state.
 *
 * Reads the same two tables getAbVariantStats and computeStepFunnel read, so
 * a per-dispatch card can never disagree with the Sankey or the aggregate
 * above it. Same last-touch attribution: a reply or meeting signal belongs to
 * the prospect's most recent send at or before the signal.
 */
export interface DispatchStat {
  executionId: number;
  prospectQueueId: number;
  prospectName: string;
  prospectTitle: string | null;
  companyName: string | null;
  stepIndex: number;
  variantKey: string;
  subject: string | null;
  bodyPreview: string | null;
  sentAt: Date | null;
  /** Whether this send carried a tracking pixel — older sends cannot report opens. */
  opensTracked: boolean;
  opened: boolean;
  openedAt: Date | null;
  replied: boolean;
  meeting: boolean;
}

export async function getDispatchStats(
  workspaceId: number,
  campaignId: number,
): Promise<DispatchStat[]> {
  const db = await getDb();
  if (!db) return [];

  const variantKeyExpr = sql<string>`coalesce(json_unquote(json_extract(${areExecutionQueue.messageContent}, '$.variantKey')), 'A')`;
  const subjectExpr = sql<string | null>`json_unquote(json_extract(${areExecutionQueue.messageContent}, '$.subject'))`;
  const bodyExpr = sql<string | null>`left(json_unquote(json_extract(${areExecutionQueue.messageContent}, '$.body')), 240)`;

  const sends = await db
    .select({
      executionId: areExecutionQueue.id,
      prospectQueueId: areExecutionQueue.prospectQueueId,
      stepIndex: areExecutionQueue.stepIndex,
      variantKey: variantKeyExpr,
      subject: subjectExpr,
      bodyPreview: bodyExpr,
      executedAt: areExecutionQueue.executedAt,
      openedAt: areExecutionQueue.openedAt,
      trackingToken: areExecutionQueue.trackingToken,
      firstName: prospectQueue.firstName,
      lastName: prospectQueue.lastName,
      title: prospectQueue.title,
      companyName: prospectQueue.companyName,
    })
    .from(areExecutionQueue)
    .leftJoin(prospectQueue, eq(prospectQueue.id, areExecutionQueue.prospectQueueId))
    .where(and(
      eq(areExecutionQueue.workspaceId, workspaceId),
      eq(areExecutionQueue.campaignId, campaignId),
      eq(areExecutionQueue.status, "sent" as never),
    ));

  const signals = await db
    .select({
      prospectQueueId: areSignalLog.prospectQueueId,
      signalType: areSignalLog.signalType,
      // The log stamps `processedAt`, not createdAt — same column the
      // aggregate's attribution reads.
      at: areSignalLog.processedAt,
    })
    .from(areSignalLog)
    .where(and(
      eq(areSignalLog.workspaceId, workspaceId),
      eq(areSignalLog.campaignId, campaignId),
    ));

  // Last-touch attribution, per prospect: each reply/meeting signal is credited
  // to the most recent send at or before it. Same rule as computeVariantCells,
  // so the per-dispatch view and the aggregate agree on which step earned it.
  type SendRow = (typeof sends)[number];
  const sendsByProspect = new Map<number, SendRow[]>();
  for (const s of sends) {
    const k = Number(s.prospectQueueId);
    const arr = sendsByProspect.get(k) ?? [];
    arr.push(s);
    sendsByProspect.set(k, arr);
  }
  sendsByProspect.forEach((arr) => {
    arr.sort((a: SendRow, b: SendRow) => (new Date(a.executedAt ?? 0).getTime()) - (new Date(b.executedAt ?? 0).getTime()));
  });
  const replied = new Set<number>();
  const meeting = new Set<number>();
  for (const sig of signals) {
    const t = String(sig.signalType);
    // EXACTLY the two types computeVariantCells credits — `email_reply` and
    // `meeting_booked`, nothing wider. Counting linkedin_reply/sms_reply here
    // would put a reply on a card that the aggregate and the Sankey do not
    // show, and the whole point of reading the same tables is that they agree.
    const isReply = t === "email_reply";
    const isMeeting = t === "meeting_booked";
    if (!isReply && !isMeeting) continue;
    const arr = sendsByProspect.get(Number(sig.prospectQueueId));
    if (!arr?.length) continue;
    const at = new Date(sig.at ?? 0).getTime();
    let owner = arr[0]!;
    for (const s of arr) {
      if (new Date(s.executedAt ?? 0).getTime() <= at) owner = s;
      else break;
    }
    if (isReply) replied.add(Number(owner.executionId));
    if (isMeeting) meeting.add(Number(owner.executionId));
  }

  const out: DispatchStat[] = sends.map((s) => ({
    executionId: Number(s.executionId),
    prospectQueueId: Number(s.prospectQueueId),
    prospectName: `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() || "(no name)",
    prospectTitle: (s.title as string | null) ?? null,
    companyName: (s.companyName as string | null) ?? null,
    stepIndex: Number(s.stepIndex ?? 0),
    variantKey: normalizeVariantKey(String(s.variantKey ?? "A")),
    subject: (s.subject as string | null) ?? null,
    bodyPreview: (s.bodyPreview as string | null) ?? null,
    sentAt: (s.executedAt as Date | null) ?? null,
    opensTracked: !!s.trackingToken,
    opened: !!s.openedAt,
    openedAt: (s.openedAt as Date | null) ?? null,
    replied: replied.has(Number(s.executionId)),
    meeting: meeting.has(Number(s.executionId)),
  }));

  // Step first, then newest send first within a step — the most recent
  // dispatch is the one someone auditing copy wants at the top.
  out.sort((a, b) => a.stepIndex - b.stepIndex
    || (new Date(b.sentAt ?? 0).getTime()) - (new Date(a.sentAt ?? 0).getTime()));
  return out;
}

/* ─── Sequence A/B variant performance ──────────────────────────────────── */

export interface SequenceAbVariantStats {
  variantId: number;
  sent: number;
  /** Distinct messages opened at least once — NOT raw pixel hits. */
  opens: number;
  replies: number;
  openRate: number;
  replyRate: number;
}

/**
 * Sequence A/B performance, DERIVED from email_drafts (migration 0141's
 * `abVariantId` / `firstReplyAt`) rather than read from the counter columns.
 *
 * Written to correct a decision I made an hour earlier in the same session.
 * `sequence_ab_variants.openCount` / `replyCount` were dead columns, so 0141
 * added the attribution column AND started writing the counters. The ARE side of
 * the identical feature had already gone the other way, and its comment explains
 * why: nothing ever wrote `are_ab_variants`' counters, "the A/B tab rendered
 * permanent 0% bars for months", and those are now dead columns with performance
 * computed on read. performanceMetrics' own header states the rule — everything
 * is DERIVED from source rows, do not add denormalised counters — and this repo
 * has already moved sidebar counters off write-time columns for the same reason.
 * Maintaining counters would have been a third opinion about the same numbers.
 *
 * Deriving also fixes something the counters could not. The engine bumped
 * sentCount when it CREATED a draft, but a draft is `pending_review` and may
 * never send — suppressed recipients being the obvious case. `sent` here counts
 * drafts that actually reached status 'sent', so the denominator is real.
 *
 * `opens` counts drafts opened at least once rather than summing openCount, for
 * the reason the ARE version gives: mail privacy proxies prefetch images, so a
 * hit count overstates interest while "was it opened at all" stays meaningful.
 */
export async function getSequenceAbVariantStats(
  workspaceId: number,
  sequenceId: number,
): Promise<Map<number, SequenceAbVariantStats>> {
  const out = new Map<number, SequenceAbVariantStats>();
  const db = await getDb();
  if (!db) return out;

  const rows = await db
    .select({
      variantId: emailDrafts.abVariantId,
      sent: sql<number>`SUM(CASE WHEN ${emailDrafts.status} = 'sent' THEN 1 ELSE 0 END)`,
      opens: sql<number>`SUM(CASE WHEN ${emailDrafts.status} = 'sent' AND ${emailDrafts.openCount} > 0 THEN 1 ELSE 0 END)`,
      replies: sql<number>`SUM(CASE WHEN ${emailDrafts.firstReplyAt} IS NOT NULL THEN 1 ELSE 0 END)`,
    })
    .from(emailDrafts)
    .where(and(
      eq(emailDrafts.workspaceId, workspaceId),
      eq(emailDrafts.sequenceId, sequenceId),
      isNotNull(emailDrafts.abVariantId),
    ))
    .groupBy(emailDrafts.abVariantId);

  for (const r of rows) {
    const id = Number(r.variantId);
    if (!Number.isFinite(id)) continue;
    const sent = Number(r.sent ?? 0);
    const opens = Number(r.opens ?? 0);
    const replies = Number(r.replies ?? 0);
    out.set(id, {
      variantId: id,
      sent,
      opens,
      replies,
      openRate: sent > 0 ? (opens / sent) * 100 : 0,
      replyRate: sent > 0 ? (replies / sent) * 100 : 0,
    });
  }
  return out;
}

/* ─── Inbound chat funnel ───────────────────────────────────────────────── */

/**
 * The chat's own funnel, derived entirely from chat_sessions rows.
 *
 * Every stage is a strict subset of the one above it, which is what makes the
 * drop-offs meaningful: you cannot have a lead without an email, and the agent
 * cannot book without one either. `emailCaptured` is therefore the gate the
 * whole feature turns on, and it is the number to look at first.
 *
 * Nothing here is denormalised. The agent's own sessionCount/leadCount columns
 * exist but are incremented at write time and can drift; these are counted from
 * the rows themselves so this can never disagree with the transcript list.
 */
export interface ChatFunnelStats {
  sessions: number;
  /** Said enough to be worth counting — more than the opening greeting. */
  engaged: number;
  emailCaptured: number;
  qualified: number;
  leads: number;
  meetings: number;
  /** Abandoned conversations the follow-up engine has acted on (0137). */
  followUpsActioned: number;
  /** Conversion of the stage above, in percent. */
  engagedRate: number;
  emailRate: number;
  qualifiedRate: number;
  meetingRate: number;
  /** Median messages in a session that produced an email — how long it takes. */
  medianMessagesToEmail: number;
  /** The stage losing the most people, in absolute terms. */
  biggestDropStage: "engagement" | "email" | "qualification" | "booking" | "none";
  biggestDropCount: number;
}

/** Sessions with only the seeded greeting are not conversations. */
const CHAT_ENGAGED_MIN_MESSAGES = 3;

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** The minimum a row needs to be placed in the funnel. */
export interface ChatFunnelRow {
  messageCount?: number | null;
  visitorEmail?: string | null;
  qualified?: boolean | null;
  meetingId?: number | null;
}

/**
 * Split rows into the funnel's stages. Pure and exported so the SUBSET
 * INVARIANT can be tested against the real implementation.
 *
 * Every stage is a strict subset of the one above it. That property is the
 * whole reason a drop-off between two of them means anything, and the UI says
 * so in as many words — so it has to be structural, not argued. The previous
 * version was argued, and wrong: `meetings` was computed over ALL rows while
 * the stages above it narrowed, and the old test asserted the invariant against
 * a REIMPLEMENTATION of this logic rather than against this logic, so it passed.
 *
 * A booking carries its row up the whole chain rather than being counted beside
 * it, because a booked-but-unqualified session is a DESIGNED outcome: a visitor
 * who explicitly asks for a meeting books from MEETING_REQUEST_FLOOR (40) even
 * when the qualify threshold is 60. Two of those rendered a booking rate above
 * 100% and a negative drop-off.
 */
export function chatFunnelStages<T extends ChatFunnelRow>(rows: T[]): {
  engaged: T[]; withEmail: T[]; qualified: T[]; meetings: T[];
} {
  const all = rows ?? [];
  const booked = (r: T) => !!r.meetingId;
  const engaged = all.filter((r) => (r.messageCount ?? 0) >= CHAT_ENGAGED_MIN_MESSAGES || booked(r));
  const withEmail = engaged.filter((r) => !!r.visitorEmail || booked(r));
  const qualified = withEmail.filter((r) => !!r.qualified || booked(r));
  return { engaged, withEmail, qualified, meetings: qualified.filter(booked) };
}

export async function getChatFunnelStats(workspaceId: number): Promise<ChatFunnelStats> {
  const empty: ChatFunnelStats = {
    sessions: 0, engaged: 0, emailCaptured: 0, qualified: 0, leads: 0, meetings: 0,
    followUpsActioned: 0, engagedRate: 0, emailRate: 0, qualifiedRate: 0, meetingRate: 0,
    medianMessagesToEmail: 0, biggestDropStage: "none", biggestDropCount: 0,
  };
  const db = await getDb();
  if (!db) return empty;

  const rows = await db
    .select({
      messageCount: chatSessions.messageCount,
      visitorEmail: chatSessions.visitorEmail,
      qualified: chatSessions.qualified,
      leadId: chatSessions.leadId,
      meetingId: chatSessions.meetingId,
      followUpAt: chatSessions.followUpAt,
    })
    .from(chatSessions)
    .where(eq(chatSessions.workspaceId, workspaceId));

  if (!rows.length) return empty;

  const sessions = rows.length;
  const { engaged: engagedRows, withEmail, qualified, meetings } = chatFunnelStages(rows);

  const stats: ChatFunnelStats = {
    sessions,
    engaged: engagedRows.length,
    emailCaptured: withEmail.length,
    qualified: qualified.length,
    leads: rows.filter((r) => !!r.leadId).length,
    meetings: meetings.length,
    followUpsActioned: rows.filter((r) => !!r.followUpAt).length,
    engagedRate: rate(engagedRows.length, sessions),
    emailRate: rate(withEmail.length, engagedRows.length),
    qualifiedRate: rate(qualified.length, withEmail.length),
    meetingRate: rate(meetings.length, qualified.length),
    medianMessagesToEmail: median(withEmail.map((r) => r.messageCount ?? 0)),
    biggestDropStage: "none",
    biggestDropCount: 0,
  };

  const drops: Array<[ChatFunnelStats["biggestDropStage"], number]> = [
    ["engagement", sessions - engagedRows.length],
    ["email", engagedRows.length - withEmail.length],
    ["qualification", withEmail.length - qualified.length],
    ["booking", qualified.length - meetings.length],
  ];
  drops.sort((a, b) => b[1] - a[1]);
  if (drops[0][1] > 0) {
    stats.biggestDropStage = drops[0][0];
    stats.biggestDropCount = drops[0][1];
  }
  return stats;
}
