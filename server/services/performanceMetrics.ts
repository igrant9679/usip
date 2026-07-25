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
 * HONESTY NOTE — opens are NOT available for ARE campaign sends. Sequence mail
 * goes out as email_drafts rows and gets a tracking pixel (emailTracking.ts
 * increments openCount), but the ARE engine dispatches through
 * sendCampaignEmailViaPool, which injects no pixel, and nothing in the codebase
 * emits the `email_open` ARE signal. So AbVariantStats reports opensTracked:
 * false instead of a 0 that would read as "nobody opened it". Adding ARE open
 * tracking is a separate change (a per-send token tied to prospect + step).
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  areAbVariants,
  areExecutionQueue,
  areSignalLog,
  emailDrafts,
  emailReplies,
} from "../../drizzle/schema";

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

/* ─── ARE A/B variant performance ───────────────────────────────────────── */

export interface AbVariantStats {
  stepIndex: number;
  variantKey: string;
  /** Metadata from are_ab_variants when a variant row exists. */
  subjectLine: string | null;
  hookType: string | null;
  bodyPreview: string | null;
  sent: number;
  replies: number;
  meetings: number;
  replyRate: number;
  meetingRate: number;
  /** Always false today — ARE pool sends carry no tracking pixel. */
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
}
export interface VariantSignalRow {
  prospectQueueId: number;
  signalType: string;
}
export interface VariantCell { sent: number; replies: number; meetings: number }

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
    const c = cells.get(k) ?? { sent: 0, replies: 0, meetings: 0 };
    c[field] += 1;
    cells.set(k, c);
  };

  const lastByProspect = new Map<number, { step: number; v: string; at: number }>();
  for (const s of sends) {
    const step = Number(s.stepIndex ?? 0);
    const v = String(s.variantKey ?? "A");
    bump(variantCellKey(step, v), "sent");
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
    sends.map((s) => ({
      prospectQueueId: Number(s.prospectQueueId),
      stepIndex: Number(s.stepIndex ?? 0),
      variantKey: String(s.variantKey ?? "A"),
      executedAt: (s.executedAt as Date | null) ?? null,
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
  for (const row of stored) {
    // Surface a defined variant even before its first send, so a freshly
    // generated A/B pair appears at 0 sends instead of vanishing.
    const k = cellKey(Number(row.stepIndex), String(row.variantKey));
    if (!cells.has(k)) cells.set(k, { sent: 0, replies: 0, meetings: 0 });
  }
  const metaMap = new Map(
    stored.map((r) => [cellKey(Number(r.stepIndex), String(r.variantKey)), r]),
  );

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
      replies: c.replies,
      meetings: c.meetings,
      replyRate: rate(c.replies, c.sent),
      meetingRate: rate(c.meetings, c.sent),
      opensTracked: false,
      sampleSufficient: c.sent >= MIN_VARIANT_SAMPLE,
    };
  });

  out.sort((a, b) => a.stepIndex - b.stepIndex || a.variantKey.localeCompare(b.variantKey));
  return out;
}
