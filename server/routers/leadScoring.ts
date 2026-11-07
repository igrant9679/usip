import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { genuineReplyScope } from "../services/replyScope";
import { z } from "zod";
import {
  accounts,
  activities,
  bulkJobs,
  crmTerritoryRules,
  emailDrafts,
  emailReplies,
  emailSuppressions,
  enrollments,
  leadRoutingRules,
  leadScoreConfig,
  leadScoreHistory,
  leads,
  workspaces,
} from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { getDb } from "../db";
import {
  type AiFitOutput,
  composeScore,
  DEFAULT_SCORE_CONFIG,
  firmoFacts,
  type LeadBehaviorInput,
  type LeadFirmoInput,
  pickRoutingMatch,
  type RoutingPayload,
  type RoutingRule,
  ruleMatches,
  type ScoreBreakdown,
  type ScoreConfig,
  scoreAiFit,
  scoreBehavioral,
  scoreFirmographic,
  tierFor,
  titleHeuristicFit,
} from "../leadScoring";
import { invokeLLM } from "../_core/llm";
import { router } from "../_core/trpc";
import { adminWsProcedure, repProcedure, workspaceProcedure } from "../_core/workspace";
import { activeMemberIds } from "../_core/activeMembers";
import { archivedWorkspaceIds } from "../_core/workspaceArchive";
import { notifyIfEnabled } from "../services/policyNotify";
import { isOutboundPaused } from "../services/outboundPause";
import { gradeForTier } from "@shared/leadTier";
import { componentMaxes, tierThresholdProblem } from "@shared/leadScoreModel";
import { normalizeRoutingConditions, routingConditionsMatch, routingConditionsProblem } from "@shared/leadRouting";
import { takeEngagedLeads, noteLeadEngagement } from "../services/leadRescoreQueue";
import { activeJob, cancelJob, enqueueJob, getJob as getBulkJob, registerJobKind } from "../services/jobs/runner";

/* ───────── helpers ───────── */

async function loadConfig(workspaceId: number): Promise<ScoreConfig> {
  const db = await getDb();
  if (!db) return DEFAULT_SCORE_CONFIG;
  const [row] = await db.select().from(leadScoreConfig).where(eq(leadScoreConfig.workspaceId, workspaceId));
  if (!row) return DEFAULT_SCORE_CONFIG;
  return {
    firmoOrgTypeWeight: row.firmoOrgTypeWeight,
    firmoTitleWeight: row.firmoTitleWeight,
    firmoCompletenessWeight: row.firmoCompletenessWeight,
    behavOpenPoints: row.behavOpenPoints,
    behavOpenMax: row.behavOpenMax,
    behavClickPoints: row.behavClickPoints,
    behavClickMax: row.behavClickMax,
    behavReplyPoints: row.behavReplyPoints,
    behavStepPoints: row.behavStepPoints,
    behavBouncePenalty: row.behavBouncePenalty,
    behavUnsubPenalty: row.behavUnsubPenalty,
    behavDecayPctPer30d: row.behavDecayPctPer30d,
    aiFitMax: row.aiFitMax,
    tierWarmMin: row.tierWarmMin,
    tierHotMin: row.tierHotMin,
    tierSalesReadyMin: row.tierSalesReadyMin,
  };
}

/** A lead with no engagement on record, as the scorer reads one. */
const NO_BEHAVIOR: LeadBehaviorInput = { opens: 0, clicks: 0, replies: 0, completedSteps: 0, bounces: 0, unsubscribes: 0, daysSinceLastEngagement: 999 };

async function aggregateBehavior(workspaceId: number, leadId: number): Promise<LeadBehaviorInput> {
  return (await aggregateBehaviorMany(workspaceId, [leadId])).get(leadId) ?? { ...NO_BEHAVIOR };
}

/**
 * Each lead's engagement, read for many leads at once: six reads for the
 * whole set, not six per lead, so the Lead Scoring page's what-if can score a
 * sample of leads (audit 2026-10-20, U17). One lead's score reads through
 * here too, so the sample and a saved score count the same things.
 */
async function aggregateBehaviorMany(workspaceId: number, leadIds: number[]): Promise<Map<number, LeadBehaviorInput>> {
  const ids = Array.from(new Set(leadIds));
  const out = new Map<number, LeadBehaviorInput>(ids.map((id) => [id, { ...NO_BEHAVIOR }]));
  const db = await getDb();
  if (!db || ids.length === 0) return out;
  const byLead = <T,>(rows: T[], key: (r: T) => number | null | undefined) => {
    const m = new Map<number, T[]>();
    for (const r of rows) { const k = key(r); if (k == null) continue; const a = m.get(k) ?? []; a.push(r); m.set(k, a); }
    return m;
  };

  // Real engagement, not a stub model.
  //
  // This used to FABRICATE every behavioural input:
  //   opens   = sentDrafts.length          (every send counted as an open)
  //   clicks  = sentDrafts.length / 3      (invented outright)
  //   replies = drafts whose aiPrompt TEXT contained the word "reply"
  //
  // So a prospect who ignored everything scored identically to one who read
  // and clicked every message — and the tracking pixel's real counters
  // (emailDrafts.openCount / clickCount, maintained by server/emailTracking.ts)
  // were never consulted despite existing all along. That matters more now
  // that a lead's score can auto-enrol them in a sequence: fabricated
  // engagement would have started real outreach.
  const drafts = byLead(
    // The counters and times only: a sample of leads can have thousands of
    // drafts, and their bodies are not read here.
    await db
      .select({
        toLeadId: emailDrafts.toLeadId, status: emailDrafts.status, openCount: emailDrafts.openCount, clickCount: emailDrafts.clickCount,
        bouncedAt: emailDrafts.bouncedAt, sentAt: emailDrafts.sentAt, lastOpenedAt: emailDrafts.lastOpenedAt, lastClickedAt: emailDrafts.lastClickedAt,
      })
      .from(emailDrafts)
      .where(and(eq(emailDrafts.workspaceId, workspaceId), inArray(emailDrafts.toLeadId, ids))),
    (d) => d.toLeadId,
  );

  /**
   * Replies come from the emailReplies table the inbound poller writes, not from
   * pattern-matching the outbound draft's own prompt text.
   *
   * `draftId IS NOT NULL` is load-bearing. inboundReplyPoller inserts a row for
   * EVERY inbound message and sets `leadId` from a bare address match
   * (`leads.email = fromEmail`, poller line ~266) — with no requirement that we
   * ever sent that person anything. Scoping on leadId alone therefore counted
   * ordinary private correspondence from anyone who happens to be a lead as a
   * reply to outreach, and a reply is the strongest positive signal in this
   * score. On this workspace that is ~62,000 inbound rows against zero genuine
   * campaign replies.
   *
   * Same table and same omission as the Conversation Autopilot bug fixed in
   * `aecfbbe`; that pass scoped the classifier and missed this consumer. The
   * shared genuine-reply scope (replyScope.ts) counts a campaign reply from
   * this lead as engagement too, not just draft-matched ones.
   */
  const replies = byLead(
    await db
      .select({ leadId: emailReplies.leadId, receivedAt: emailReplies.receivedAt })
      .from(emailReplies)
      .where(and(eq(emailReplies.workspaceId, workspaceId), inArray(emailReplies.leadId, ids), genuineReplyScope())),
    (r) => r.leadId,
  );

  /**
   * Activity rows no longer count as replies (audit 2026-10-20, P37). Any
   * email activity whose subject contained "re:" did, so "Feature: …" was a
   * reply, and so was every "Re: …" follow-up WE sent: sends log an email
   * activity, and nothing records a direction. The one inbound email activity
   * is the reply poller's "Email reply received: …", and that same message is
   * the emailReplies row counted above, inside the genuine-reply scope.
   *
   * What does count from activities is a meeting or a call that reached the
   * person: that is the prospect engaging, for the decay clock below.
   */
  const acts = byLead(
    await db
      .select({ relatedId: activities.relatedId, type: activities.type, occurredAt: activities.occurredAt, callDisposition: activities.callDisposition })
      .from(activities)
      .where(and(
        eq(activities.workspaceId, workspaceId),
        eq(activities.relatedType, "lead"),
        inArray(activities.relatedId, ids),
        inArray(activities.type, ["meeting", "call"]),
      )),
    (a) => a.relatedId,
  );

  // Unsubscribes were hardcoded to 0, so opting out never dented a lead's
  // score — they could keep climbing toward "sales ready" (and now toward
  // auto-enrolment) after asking not to be contacted. email_suppressions is
  // the real record. Addresses compare without case, as MySQL's collation does.
  const leadRows = await db.select({ id: leads.id, email: leads.email }).from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), inArray(leads.id, ids)));
  const emails = Array.from(new Set(leadRows.map((l) => l.email).filter((e): e is string => !!e)));
  const suppressed = new Set<string>();
  if (emails.length) {
    const sup = await db
      .select({ email: emailSuppressions.email })
      .from(emailSuppressions)
      .where(and(
        eq(emailSuppressions.workspaceId, workspaceId),
        inArray(emailSuppressions.email, emails),
        inArray(emailSuppressions.reason, ["unsubscribe", "spam_complaint"]),
      ));
    for (const s of sup) if (s.email) suppressed.add(s.email.toLowerCase());
  }
  const emailOf = new Map(leadRows.map((l) => [l.id, l.email]));

  // Sequence step completion (proxy: enrollments.currentStep)
  const enr = byLead(
    await db.select({ leadId: enrollments.leadId, currentStep: enrollments.currentStep }).from(enrollments)
      .where(and(eq(enrollments.workspaceId, workspaceId), inArray(enrollments.leadId, ids))),
    (e) => e.leadId,
  );

  const ts = (t: Date | string | null | undefined) => (t ? new Date(t).getTime() : null);
  for (const leadId of ids) {
    const mine = drafts.get(leadId) ?? [];
    const sentDrafts = mine.filter((d) => d.status === "sent");
    const replyRows = replies.get(leadId) ?? [];
    const twoWay = (acts.get(leadId) ?? []).filter((a) => a.type === "meeting" || a.callDisposition === "connected" || a.callDisposition === "callback_requested");
    /**
     * Decay runs from the prospect's last action: an open, a click, a reply, a
     * meeting or a call that connected (P117). Our own sends were in this list,
     * so each step we sent reset the clock for someone who never responded.
     * Someone who has never acted decays from our first send to them, when they
     * could first have.
     */
    const prospectTimes = [
      ...twoWay.map((a) => ts(a.occurredAt)),
      ...sentDrafts.map((d) => ts(d.lastOpenedAt)),
      ...sentDrafts.map((d) => ts(d.lastClickedAt)),
      ...replyRows.map((r) => ts(r.receivedAt)),
    ].filter((t): t is number => t != null);
    const sendTimes = sentDrafts.map((d) => ts(d.sentAt)).filter((t): t is number => t != null);
    const since = prospectTimes.length > 0 ? Math.max(...prospectTimes) : sendTimes.length > 0 ? Math.min(...sendTimes) : null;
    const email = emailOf.get(leadId);
    out.set(leadId, {
      opens: sentDrafts.reduce((n, d) => n + (d.openCount ?? 0), 0),
      clicks: sentDrafts.reduce((n, d) => n + (d.clickCount ?? 0), 0),
      replies: replyRows.length,
      completedSteps: (enr.get(leadId) ?? []).reduce((s, e) => s + (e.currentStep ?? 0), 0),
      bounces: mine.filter((d) => d.bouncedAt != null).length,
      unsubscribes: email && suppressed.has(email.toLowerCase()) ? 1 : 0,
      daysSinceLastEngagement: since != null ? Math.max(0, Math.floor((Date.now() - since) / 86400000)) : 999,
    });
  }
  return out;
}

async function fetchAiFit(lead: typeof leads.$inferSelect): Promise<AiFitOutput | null> {
  try {
    const out = await invokeLLM({
      // Named: lead scoring also runs from background recalculations.
      workspaceId: lead.workspaceId,
      // Research phase 4: "fit" means fit to the lead's researched market.
      research: { surface: "research", prospectTitle: lead.title },
      messages: [
        { role: "system", content: "You assess B2B lead/product fit. Output JSON only." },
        {
          role: "user",
          // No name (audit 2026-10-20, P128): fit is judged on the role and
          // the organization, and the person's name told the model nothing.
          content: `Assess fit on a 0..1 scale.\n\nTitle: ${lead.title ?? ""}\nCompany: ${lead.company ?? ""}\nSource: ${lead.source ?? ""}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "lead_fit",
          strict: true,
          schema: {
            type: "object",
            properties: {
              fit_score: { type: "number" },
              pain_points: { type: "array", items: { type: "string" } },
              recommended_products: { type: "array", items: { type: "string" } },
              objection_risks: { type: "array", items: { type: "string" } },
            },
            required: ["fit_score", "pain_points", "recommended_products", "objection_risks"],
            additionalProperties: false,
          },
        },
      },
    });
    const content = out.choices?.[0]?.message?.content;
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    return parsed as AiFitOutput;
  } catch (e) {
    console.warn("[leadScoring] AI fit failed", e);
    // A guess from the title keeps the score deterministic without the model,
    // and says it is a guess (P38): it was stored and shown as "AI fit".
    return titleHeuristicFit(lead.title);
  }
}

/** The lead's latest stored score, with the AI fit assessment it used. */
async function latestScore(workspaceId: number, leadId: number) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select().from(leadScoreHistory)
    .where(and(eq(leadScoreHistory.workspaceId, workspaceId), eq(leadScoreHistory.leadId, leadId)))
    .orderBy(desc(leadScoreHistory.id))
    .limit(1);
  return row ?? null;
}

/**
 * Score one lead and save it.
 *
 * `ai: true` (Recompute, Recompute all) asks the model for the fit, one call
 * on the workspace's AI budget. `ai: false` is everything that runs on its own
 * (audit 2026-10-20, P12: a new lead, engagement, the daily sweep): the
 * profile and engagement are scored again and the fit is the last assessment,
 * so no schedule ever calls a model. A lead never assessed has no fit points
 * until someone presses Recompute.
 *
 * `trigger` says who asked, which decides what a score may set off:
 *  - "person" (Recompute, Recompute all): the Sales-Ready alert on a crossing
 *    and score-threshold enrolment at or above a threshold, as always.
 *  - "create" (a lead just made by leads.create, a form, a landing page or
 *    chat): the same, except no enrolment while the workspace's outbound is
 *    paused.
 *  - "schedule" (the hourly re-score): a lead's first score is the backfill
 *    and sets off nothing; after that only an upward crossing alerts or
 *    enrols (previous stored score below the threshold, new at or above),
 *    and never an enrolment while outbound is paused. Without this, the first
 *    sweeps after deploy would enrol every lead already above a trigger and
 *    alert on every lead past Sales Ready (review of P12, 2026-11-06).
 */
type ScoreTrigger = "person" | "create" | "schedule";

async function recomputeOne(workspaceId: number, leadId: number, opts: { ai: boolean; trigger: ScoreTrigger } = { ai: true, trigger: "person" }) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.workspaceId, workspaceId)));
  if (!lead) throw new TRPCError({ code: "NOT_FOUND" });
  const cfg = await loadConfig(workspaceId);

  const firmo = scoreFirmographic(lead, cfg);
  const behaviorInput = await aggregateBehavior(workspaceId, leadId);
  const behav = scoreBehavioral(behaviorInput, cfg);
  const last = await latestScore(workspaceId, leadId);
  const aiFitJson = opts.ai ? await fetchAiFit(lead) : ((last?.aiFitPayload as AiFitOutput | null) ?? null);
  const ai = scoreAiFit(aiFitJson, cfg);
  const breakdown = composeScore({ firmo, behav, aiFit: ai, cfg });

  // One mapping, shared with the client — see @shared/leadTier.
  const grade = gradeForTier(breakdown.tier);

  const previousTotal = lead.score ?? 0;
  // The schedule's first score of a lead is the backfill: stored, nothing fired.
  const backfill = opts.trigger === "schedule" && lead.scoredAt == null;
  // Scoped like the read above it (audit 2026-10-20, P127).
  await db.update(leads).set({ score: breakdown.total, grade, scoreReasons: breakdown.reasons, scoredAt: new Date() }).where(and(eq(leads.id, leadId), eq(leads.workspaceId, workspaceId)));
  // A scheduled re-score that changed nothing adds no history row, so the
  // 90-day history shows changes, not the schedule.
  const changed = !last || last.total !== breakdown.total || last.firmographic !== breakdown.firmographic
    || last.behavioral !== breakdown.behavioral || last.aiFit !== breakdown.aiFit;
  if (opts.ai || changed) {
    await db.insert(leadScoreHistory).values({
      workspaceId,
      leadId,
      firmographic: breakdown.firmographic,
      behavioral: breakdown.behavioral,
      aiFit: breakdown.aiFit,
      total: breakdown.total,
      tier: breakdown.tier,
      aiFitPayload: aiFitJson as any,
    });
  }

  /**
   * Threshold-cross notification → assigned owner only.
   *
   * ⚠️ TWO SWITCHES CONTROL THIS ONE NOTIFICATION, and they are ANDed rather
   * than one silently winning. `lead_score_config.notifyOnSalesReady` predates
   * the Settings → Notifications panel, which offers "A lead becomes
   * Sales-Ready" as well — and until now only the older one worked, so an admin
   * could switch it off in Settings and go on receiving them. Either being off
   * is a user saying no; neither is a good reason to override the other. The
   * duplication is recorded rather than resolved, because deleting a setting
   * somebody may be relying on is a product call.
   *
   * The owner also went in RAW. A lead owned by a departed member had the
   * notification addressed to them; `notifyIfEnabled` re-resolves it.
   */
  const [cfgRow] = await db.select().from(leadScoreConfig).where(eq(leadScoreConfig.workspaceId, workspaceId));
  const crossed = previousTotal < cfg.tierSalesReadyMin && breakdown.total >= cfg.tierSalesReadyMin;
  if (crossed && !backfill) {
    await notifyIfEnabled({
      workspaceId,
      userId: lead.ownerUserId,
      event: "salesReadyCrossed",
      alsoRequire: cfgRow?.notifyOnSalesReady ?? true,
      kind: "system",
      title: `Lead is Sales Ready: ${lead.firstName} ${lead.lastName}`,
      body: `Score crossed ${cfg.tierSalesReadyMin} (${previousTotal} → ${breakdown.total}). ${lead.company ?? ""}`,
      relatedType: "lead",
      relatedId: leadId,
    });
  }

  // Auto-enrol into any active sequence whose enrollmentTrigger is a
  // score_threshold this lead has now crossed.
  //
  // sequenceEngine.autoEnrollByTriggers was fully implemented AND unit-tested,
  // but its only caller in the entire repo was its own test file — so scores
  // were computed, stored, displayed and sorted on, and never actually started
  // any outreach. This is the score → sequence handoff that was missing.
  //
  // Scoring must not fail because enrolment did. The function is idempotent
  // (it checks for an existing enrolment first), so re-scoring the same lead
  // never double-enrols. Awaited since scores re-run on a schedule (P12), so
  // a sweep's enrolments run one lead at a time rather than piling up.
  //
  // The schedule asks only when the score rose, since only a rise can cross a
  // threshold upward, and passes the previous score so a sequence matches only
  // on that crossing. Neither the schedule nor a new lead enrols anyone while
  // the workspace's outbound is paused: nothing is queued, and the skip is
  // logged (by the tick, once per workspace, for the schedule).
  let enrolment: "checked" | "skipped_paused" | "not_asked" = "not_asked";
  const askEnrol = opts.trigger !== "schedule" || (!backfill && breakdown.total > previousTotal);
  if (askEnrol) {
    if (opts.trigger !== "person" && (await isOutboundPaused(workspaceId))) {
      enrolment = "skipped_paused";
      if (opts.trigger === "create") {
        console.log(`[LeadScoring] lead ${leadId}: outbound is paused in workspace ${workspaceId}, so no score-threshold enrolment`);
      }
    } else {
      enrolment = "checked";
      try {
        const m = await import("../sequenceEngine");
        await m.autoEnrollByTriggers({
          kind: "score_threshold",
          workspaceId,
          leadId,
          score: breakdown.total,
          ...(opts.trigger === "schedule" ? { previousScore: previousTotal } : {}),
        });
      } catch (e) {
        console.error(`[LeadScoring] auto-enroll failed for lead ${leadId}:`, e);
      }
    }
  }

  return { ...breakdown, grade, aiFit: aiFitJson, enrolment };
}

/**
 * Score a lead just created, without a model call (P12): leads.create, forms,
 * landing pages and chat. Never throws; a score is not worth failing the
 * thing that asked for it. No enrolment while outbound is paused.
 */
export async function rescoreLead(workspaceId: number, leadId: number): Promise<void> {
  try {
    await recomputeOne(workspaceId, leadId, { ai: false, trigger: "create" });
  } catch (e) {
    console.error(`[LeadScoring] re-score failed for lead ${leadId}:`, (e as Error)?.message ?? e);
  }
}

/** A lead with no engagement yet: what a new lead's behaviour scores. */
const NO_ENGAGEMENT = { opens: 0, clicks: 0, replies: 0, completedSteps: 0, bounces: 0, unsubscribes: 0, daysSinceLastEngagement: 0 };

/**
 * What a lead scores the moment it is created, before the insert, so routing
 * rules on Score see a real number (audit 2026-10-20, P13: every entry point
 * passed 0). It is the profile's points: a new lead has no engagement, and the
 * AI fit waits for Recompute. `rescoreLead` after the insert saves the same
 * number.
 */
export async function createTimeScore(workspaceId: number, lead: LeadFirmoInput): Promise<ScoreBreakdown> {
  const cfg = await loadConfig(workspaceId);
  return composeScore({ firmo: scoreFirmographic(lead, cfg), behav: scoreBehavioral(NO_ENGAGEMENT, cfg), aiFit: scoreAiFit(null, cfg), cfg });
}

/* ───────── Scores that keep themselves current (audit P12) ───────── */

/** Engaged leads re-scored per hourly tick, across every workspace. */
export const RESCORE_ENGAGED_PER_TICK = 500;
/** Stale leads re-scored per workspace per hourly tick. */
export const RESCORE_STALE_PER_WORKSPACE = 200;
/** A lead not scored for this long is due again, so decay is applied daily. */
export const RESCORE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** A tick stops starting new leads after this long. */
export const RESCORE_TICK_BUDGET_MS = 10 * 60 * 1000;

/**
 * The hourly lead re-score (P12). Scores only changed when a rep pressed
 * Recompute, so decay never applied, a lead never crossed into Sales Ready on
 * its own, and sequences that start on a score never started. Each tick:
 *
 *  1. leads with new engagement (an open, a click, a reply) noted by the
 *     tracking and reply paths, up to RESCORE_ENGAGED_PER_TICK;
 *  2. leads never scored or not scored for a day, oldest first, up to
 *     RESCORE_STALE_PER_WORKSPACE in each workspace.
 *
 * No model calls (`ai: false`), archived workspaces skipped, and a time budget,
 * so one tick is bounded however many leads there are. What a score sets off
 * is `trigger: "schedule"` (see recomputeOne): a lead's first score is the
 * backfill and sets off nothing; after that only an upward crossing alerts or
 * enrols, and nothing enrols while the workspace's outbound is paused.
 */
export async function runLeadRescoreTick(): Promise<{ engaged: number; swept: number; failed: number; pausedSkips: number }> {
  const out = { engaged: 0, swept: 0, failed: 0, pausedSkips: 0 };
  const db = await getDb();
  if (!db) return out;
  const until = Date.now() + RESCORE_TICK_BUDGET_MS;
  const archived = await archivedWorkspaceIds();
  const pausedByWs = new Map<number, number>();
  const one = async (workspaceId: number, leadId: number) => {
    try {
      const r = await recomputeOne(workspaceId, leadId, { ai: false, trigger: "schedule" });
      if (r.enrolment === "skipped_paused") pausedByWs.set(workspaceId, (pausedByWs.get(workspaceId) ?? 0) + 1);
      return true;
    } catch (e) {
      out.failed++;
      console.error(`[LeadRescore] lead ${leadId} failed:`, (e as Error)?.message ?? e);
      return false;
    }
  };
  // The run log says when a paused workspace held back enrolments.
  const done = () => {
    pausedByWs.forEach((n, ws) => {
      out.pausedSkips += n;
      console.log(`[LeadRescore] workspace ${ws}: outbound is paused, so ${n} score-threshold enrolment check${n === 1 ? " was" : "s were"} skipped`);
    });
    return out;
  };

  const engaged = takeEngagedLeads(RESCORE_ENGAGED_PER_TICK);
  for (let i = 0; i < engaged.length; i++) {
    const { workspaceId, leadId } = engaged[i]!;
    if (Date.now() >= until) {
      // Out of time: the rest wait for the next tick.
      for (const rest of engaged.slice(i)) noteLeadEngagement(rest.workspaceId, rest.leadId);
      return done();
    }
    if (archived.has(workspaceId)) continue;
    if (await one(workspaceId, leadId)) out.engaged++;
  }

  const cutoff = new Date(Date.now() - RESCORE_STALE_AFTER_MS);
  const wsRows = await db.select({ id: workspaces.id }).from(workspaces);
  for (const { id: workspaceId } of wsRows) {
    if (archived.has(workspaceId)) continue;
    const due = await db.select({ id: leads.id }).from(leads)
      .where(and(eq(leads.workspaceId, workspaceId), or(isNull(leads.scoredAt), lt(leads.scoredAt, cutoff))))
      .orderBy(asc(leads.scoredAt), asc(leads.id))
      .limit(RESCORE_STALE_PER_WORKSPACE);
    for (const { id } of due) {
      if (Date.now() >= until) return done();
      if (await one(workspaceId, id)) out.swept++;
    }
  }
  return done();
}

/* ───────── "Recompute all" as a background job (audit P11) ───────── */

const RECOMPUTE_JOB = "leadScoring.recomputeAll";
/** Leads per read; a slice keeps reading until its time is up. */
const RECOMPUTE_PAGE = 25;

registerJobKind(RECOMPUTE_JOB, {
  // resumeFrom is the last lead id scored: leads added during the run are
  // scored too, and a restart picks up after the last one saved.
  async step(job, _payload, budgetMs) {
    const until = Date.now() + budgetMs;
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    let last = job.resumeFrom;
    let done = 0;
    const failures: Array<{ id: number; error: string }> = [];
    for (;;) {
      const page = await db.select({ id: leads.id }).from(leads)
        .where(and(eq(leads.workspaceId, job.workspaceId), gt(leads.id, last)))
        .orderBy(asc(leads.id))
        .limit(RECOMPUTE_PAGE);
      if (page.length === 0) return { cursor: last, done, failures, finished: true, message: `Scored ${job.done + done} of ${job.total}` };
      for (const r of page) {
        if (Date.now() >= until) return { cursor: last, done, failures, finished: false, message: `Scored ${job.done + done} of ${job.total}` };
        try { await recomputeOne(job.workspaceId, r.id); done++; }
        catch (e) { failures.push({ id: r.id, error: ((e as Error)?.message ?? String(e)).slice(0, 200) }); }
        last = r.id;
      }
    }
  },
  async finish(job, _payload, outcome) {
    await recordAudit({ workspaceId: job.workspaceId, actorUserId: job.userId, action: "update", entityType: "lead_score_config",
      after: { recomputed: job.done, failed: job.failed, outcome, jobId: job.id } });
  },
});

/** The weights and thresholds a workspace can set: as saved, and as previewed unsaved (P118). */
const SCORE_CONFIG_SHAPE = {
  firmoOrgTypeWeight: z.number().int().min(0).max(40),
  firmoTitleWeight: z.number().int().min(0).max(40),
  firmoCompletenessWeight: z.number().int().min(0).max(40),
  behavOpenPoints: z.number().int().min(0).max(50),
  behavOpenMax: z.number().int().min(0).max(50),
  behavClickPoints: z.number().int().min(0).max(50),
  behavClickMax: z.number().int().min(0).max(50),
  behavReplyPoints: z.number().int().min(0).max(50),
  behavStepPoints: z.number().int().min(0).max(20),
  behavBouncePenalty: z.number().int().min(-50).max(0),
  behavUnsubPenalty: z.number().int().min(-50).max(0),
  behavDecayPctPer30d: z.number().int().min(0).max(100),
  aiFitMax: z.number().int().min(0).max(50),
  tierWarmMin: z.number().int().min(0).max(100),
  tierHotMin: z.number().int().min(0).max(100),
  tierSalesReadyMin: z.number().int().min(0).max(100),
};

/* ───────── tRPC router ───────── */

export const leadScoringRouter = router({
  /** Get current config (creates default row lazily). */
  getConfig: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return DEFAULT_SCORE_CONFIG;
    let [row] = await db.select().from(leadScoreConfig).where(eq(leadScoreConfig.workspaceId, ctx.workspace.id));
    if (!row) {
      await db.insert(leadScoreConfig).values({ workspaceId: ctx.workspace.id });
      [row] = await db.select().from(leadScoreConfig).where(eq(leadScoreConfig.workspaceId, ctx.workspace.id));
    }
    return row ?? DEFAULT_SCORE_CONFIG;
  }),

  saveConfig: adminWsProcedure
    .input(z.object({ ...SCORE_CONFIG_SHAPE, notifyOnSalesReady: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      // Thresholds out of order put a lead in a tier its score is below
      // (audit 2026-10-20, P116).
      const tierProblem = tierThresholdProblem(input);
      if (tierProblem) throw new TRPCError({ code: "BAD_REQUEST", message: tierProblem });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [exists] = await db.select().from(leadScoreConfig).where(eq(leadScoreConfig.workspaceId, ctx.workspace.id));
      if (exists) {
        await db.update(leadScoreConfig).set(input).where(eq(leadScoreConfig.workspaceId, ctx.workspace.id));
      } else {
        await db.insert(leadScoreConfig).values({ ...input, workspaceId: ctx.workspace.id });
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "lead_score_config", after: input });
      return { ok: true };
    }),

  /** Recompute one lead, return the breakdown. */
  recompute: repProcedure.input(z.object({ leadId: z.number() })).mutation(async ({ ctx, input }) => {
    return recomputeOne(ctx.workspace.id, input.leadId);
  }),

  /**
   * What "Recompute all" would do, for its confirmation (audit P11): how many
   * leads, each one AI call on this workspace's budget, and the job already
   * running if there is one.
   */
  recomputeAllPreview: adminWsProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [{ n }] = await db.select({ n: count() }).from(leads).where(eq(leads.workspaceId, ctx.workspace.id));
    return { leads: Number(n ?? 0), running: await activeJob(ctx.workspace.id, RECOMPUTE_JOB) };
  }),

  /**
   * Re-score every lead, as a background job (audit 2026-10-20, P11). This
   * was one request making an AI call per lead; a second click ran it all
   * again, and a long run died with the request. Now it is one persisted job
   * per workspace (a second click gets the running one back), worked in
   * slices by services/jobs/runner, which the page shows and can cancel.
   */
  recomputeAll: adminWsProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [{ n }] = await db.select({ n: count() }).from(leads).where(eq(leads.workspaceId, ctx.workspace.id));
    const { job, existing } = await enqueueJob({
      workspaceId: ctx.workspace.id, userId: ctx.user.id, kind: RECOMPUTE_JOB, payload: {}, total: Number(n ?? 0), oneAtATime: true,
    });
    return { jobId: job.id, total: job.total, existing };
  }),

  /** The latest "Recompute all" job, for the progress line (polled while it runs). */
  recomputeJob: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return null;
    const [latest] = await db.select({ id: bulkJobs.id }).from(bulkJobs)
      .where(and(eq(bulkJobs.workspaceId, ctx.workspace.id), eq(bulkJobs.kind, RECOMPUTE_JOB)))
      .orderBy(desc(bulkJobs.id))
      .limit(1);
    return latest ? getBulkJob(ctx.workspace.id, latest.id) : null;
  }),

  cancelRecompute: adminWsProcedure.input(z.object({ jobId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    return { canceled: await cancelJob(ctx.workspace.id, input.jobId) };
  }),

  /**
   * A lead's score component by component, for the lead panel and the Lead
   * Scoring page's preview, plus its 90-day history.
   *
   * The components are worked out now (profile and engagement from today's
   * data, the AI fit from its last assessment) and the total is their sum, so
   * the bars and the total agree (audit 2026-10-20, P34: AI Fit was the stored
   * total minus today's other two, and said whatever made the sum work). This
   * is what the next re-score saves. With `cfg`, the page's unsaved weights
   * are used instead of the saved ones (P118). `saved` is what the lead holds
   * now; its tier is null for a lead never scored (P119: that read Cold).
   */
  breakdown: workspaceProcedure.input(z.object({ leadId: z.number(), cfg: z.object(SCORE_CONFIG_SHAPE).optional() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [lead] = await db.select().from(leads).where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, ctx.workspace.id)));
    if (!lead) throw new TRPCError({ code: "NOT_FOUND" });
    const savedCfg = await loadConfig(ctx.workspace.id);
    const cfg = input.cfg ?? savedCfg;

    const firmo = scoreFirmographic(lead, cfg);
    const behaviorInput = await aggregateBehavior(ctx.workspace.id, input.leadId);
    const behav = scoreBehavioral(behaviorInput, cfg);
    const last = await latestScore(ctx.workspace.id, input.leadId);
    const aiFitJson = (last?.aiFitPayload as AiFitOutput | null) ?? null;
    const ai = scoreAiFit(aiFitJson, cfg);
    const now = composeScore({ firmo, behav, aiFit: ai, cfg });
    const max = componentMaxes(cfg);
    const scored = lead.scoredAt != null || last != null;
    const fit = aiFitDetails(aiFitJson, last?.computedAt ?? null);

    // 90-day history
    const cutoff = new Date(Date.now() - 90 * 86400000);
    const history = await db
      .select()
      .from(leadScoreHistory)
      .where(and(eq(leadScoreHistory.workspaceId, ctx.workspace.id), eq(leadScoreHistory.leadId, input.leadId), gte(leadScoreHistory.computedAt, cutoff)))
      .orderBy(leadScoreHistory.computedAt);

    return {
      cfg,
      tier: now.tier,
      total: now.total,
      grade: gradeForTier(now.tier),
      reasons: now.reasons,
      firmographic: { value: firmo.value, max: max.firmographic, reasons: firmo.reasons },
      // The real maximum (P22): this said 30 while behaviour could reach 75.
      behavioral: { value: behav.value, max: max.behavioral, reasons: behav.reasons, raw: behaviorInput },
      // The stored assessment's pains, recommended products and objection
      // risks, which only its first two pains and risks reached (audit U32).
      aiFit: { value: ai.value, max: max.aiFit, reasons: ai.reasons, assessed: aiFitJson != null, details: fit },
      // What the page's what-if scores in the browser with the weights on
      // screen (U17): facts, never the lead's email or phone.
      inputs: { firmo: firmoFacts(lead), behavior: behaviorInput, aiFit: whatIfFit(aiFitJson) },
      maxSum: max.sum,
      saved: {
        scored,
        total: lead.score ?? 0,
        tier: scored ? tierFor(lead.score ?? 0, savedCfg) : null,
        grade: lead.grade,
        scoredAt: lead.scoredAt ?? last?.computedAt ?? null,
      },
      history: history.map((h) => ({ at: h.computedAt, total: h.total, firmographic: h.firmographic, behavioral: h.behavioral, aiFit: h.aiFit, tier: h.tier })),
    };
  }),

  /**
   * The newest leads as the Lead Scoring page's what-if scores them (audit
   * 2026-10-20, U17): each lead's firmographic facts, engagement and last AI
   * fit, so the page can sort them into tiers with the weights on screen,
   * saved or not, without asking the server again. Facts only: no names,
   * emails or phones leave for this.
   */
  whatIfSample: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const ws = ctx.workspace.id;
    const [{ n }] = await db.select({ n: count() }).from(leads).where(eq(leads.workspaceId, ws));
    const rows = await db
      .select({ id: leads.id, title: leads.title, company: leads.company, email: leads.email, phone: leads.phone, source: leads.source })
      .from(leads)
      .where(eq(leads.workspaceId, ws))
      .orderBy(desc(leads.id))
      .limit(WHAT_IF_SAMPLE);
    const ids = rows.map((r) => r.id);
    const behavior = await aggregateBehaviorMany(ws, ids);
    const fits = await latestFits(ws, ids);
    return {
      totalLeads: Number(n ?? 0),
      leads: rows.map((r) => ({
        firmo: firmoFacts(r),
        behavior: behavior.get(r.id)!,
        aiFit: whatIfFit(fits.get(r.id) ?? null),
      })),
    };
  }),
});

/** How many of the newest leads the what-if sorts into tiers (U17). */
export const WHAT_IF_SAMPLE = 500;

/** The part of a stored AI fit the score uses: the fit and whether it was a guess. */
function whatIfFit(ai: AiFitOutput | null): { fit_score: number; source?: "title_heuristic" } | null {
  if (!ai || typeof ai.fit_score !== "number") return null;
  return ai.source === "title_heuristic" ? { fit_score: ai.fit_score, source: "title_heuristic" } : { fit_score: ai.fit_score };
}

/**
 * A stored AI fit as the breakdown shows it (audit 2026-10-20, U32): every
 * pain, recommended product and objection risk the model gave, whether it was
 * a guess from the title instead, and when it was assessed.
 */
export function aiFitDetails(ai: AiFitOutput | null, assessedAt: Date | string | null) {
  if (!ai || typeof ai.fit_score !== "number") return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);
  return {
    fitPct: Math.round(Math.max(0, Math.min(1, ai.fit_score)) * 100),
    estimated: ai.source === "title_heuristic",
    painPoints: list(ai.pain_points),
    recommendedProducts: list(ai.recommended_products),
    objectionRisks: list(ai.objection_risks),
    assessedAt,
  };
}

/** Each lead's latest stored AI fit assessment, read for many leads at once. */
async function latestFits(workspaceId: number, leadIds: number[]): Promise<Map<number, AiFitOutput | null>> {
  const out = new Map<number, AiFitOutput | null>();
  const db = await getDb();
  if (!db || leadIds.length === 0) return out;
  const rows = await db
    .select({ leadId: leadScoreHistory.leadId, aiFitPayload: leadScoreHistory.aiFitPayload })
    .from(leadScoreHistory)
    .where(and(eq(leadScoreHistory.workspaceId, workspaceId), inArray(leadScoreHistory.leadId, leadIds)))
    .orderBy(desc(leadScoreHistory.id));
  for (const r of rows) if (!out.has(r.leadId)) out.set(r.leadId, (r.aiFitPayload as AiFitOutput | null) ?? null);
  return out;
}

/* ───────── Routing ───────── */

export const leadRoutingRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    // The order the router runs them in (P124): priority, then oldest.
    return db.select().from(leadRoutingRules).where(eq(leadRoutingRules.workspaceId, ctx.workspace.id)).orderBy(leadRoutingRules.priority, leadRoutingRules.id);
  }),

  save: adminWsProcedure
    .input(z.object({
      id: z.number().optional(),
      name: z.string().min(1),
      priority: z.number().int().min(1).max(1000),
      enabled: z.boolean(),
      conditions: z.any(),
      strategy: z.enum(["round_robin", "geography", "industry", "direct"]),
      targetUserIds: z.array(z.number()).default([]),
      /** Most open leads a target may own before this rule passes them by (F43); null = no limit. */
      capacityPerRep: z.number().int().min(1).max(100_000).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // A blank value, an operator the field can't take, or a Score that isn't
      // a number would save a condition that matches everything or nothing
      // (audit 2026-10-20, P42).
      const problem = routingConditionsProblem(normalizeRoutingConditions(input.conditions));
      if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Every target works here now (audit 2026-10-20, P127): any user id was
      // stored, and the router then skipped it on every lead.
      const active = await activeMemberIds(ctx.workspace.id, input.targetUserIds);
      if (input.targetUserIds.some((u) => !active.has(u))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Every target must be an active member of this workspace." });
      }
      const values = {
        name: input.name, priority: input.priority, enabled: input.enabled,
        conditions: input.conditions, strategy: input.strategy, targetUserIds: input.targetUserIds,
        // Absent (an older client): an existing limit is left as it is.
        ...(input.capacityPerRep !== undefined ? { capacityPerRep: input.capacityPerRep } : {}),
      };
      // Who changed which rule is kept, like the scoring weights (P127).
      if (input.id) {
        const [before] = await db.select().from(leadRoutingRules)
          .where(and(eq(leadRoutingRules.id, input.id), eq(leadRoutingRules.workspaceId, ctx.workspace.id)));
        if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "That rule is not in this workspace." });
        await db.update(leadRoutingRules).set(values)
          .where(and(eq(leadRoutingRules.id, input.id), eq(leadRoutingRules.workspaceId, ctx.workspace.id)));
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "lead_routing_rule", entityId: input.id, before, after: values });
        return { id: input.id };
      }
      const r = await db.insert(leadRoutingRules).values({ workspaceId: ctx.workspace.id, ...values, rrCursor: 0 });
      const id = Number((r as any)[0]?.insertId ?? 0);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "lead_routing_rule", entityId: id, after: values });
      return { id };
    }),

  remove: adminWsProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(leadRoutingRules)
      .where(and(eq(leadRoutingRules.id, input.id), eq(leadRoutingRules.workspaceId, ctx.workspace.id)));
    if (!before) return { ok: true };
    await db.delete(leadRoutingRules).where(and(eq(leadRoutingRules.id, input.id), eq(leadRoutingRules.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "lead_routing_rule", entityId: input.id, before });
    return { ok: true };
  }),

  reorder: adminWsProcedure.input(z.object({ orderedIds: z.array(z.number()) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    // One transaction (audit 2026-10-20, P124): the per-row writes went out
    // together, so two quick reorders interleaved and left a mix of both
    // orders. Rows are written in id order, so two reorders lock them in the
    // same order and one waits for the other instead of deadlocking.
    const positions = input.orderedIds.map((id, idx) => ({ id, priority: (idx + 1) * 10 })).sort((a, b) => a.id - b.id);
    await db.transaction(async (tx) => {
      for (const p of positions) {
        await tx.update(leadRoutingRules).set({ priority: p.priority })
          .where(and(eq(leadRoutingRules.id, p.id), eq(leadRoutingRules.workspaceId, ctx.workspace.id)));
      }
    });
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "lead_routing_rule", entityId: 0, after: { order: input.orderedIds } });
    return { ok: true };
  }),

  /** Manually run all routing rules against a specific lead (debugging tool). */
  applyToLead: repProcedure.input(z.object({ leadId: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [lead] = await db.select().from(leads).where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, ctx.workspace.id)));
    if (!lead) throw new TRPCError({ code: "NOT_FOUND" });
    const owner = await routeLeadOwner(ctx.workspace.id, {
      title: lead.title, company: lead.company, source: lead.source, score: lead.score ?? 0,
      industry: null, country: null, state: null, city: null,
    });
    if (owner != null) {
      await db.update(leads).set({ ownerUserId: owner }).where(and(eq(leads.id, lead.id), eq(leads.workspaceId, ctx.workspace.id)));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "lead", entityId: lead.id, after: { ownerUserId: owner, routed: true } });
    }
    return { ownerUserId: owner };
  }),

  /**
   * "Test a lead" (audit 2026-10-20, F41): which rule would take a lead and
   * who would get it, changing nothing: no owner set, no round-robin turn
   * used, no match counted. A saved lead is tested as applyToLead routes it;
   * typed values test a lead that does not exist yet.
   */
  testLead: workspaceProcedure
    .input(z.object({
      leadId: z.number().int().positive().optional(),
      lead: z.object({
        title: z.string().max(200).optional(),
        company: z.string().max(200).optional(),
        source: z.string().max(100).optional(),
        industry: z.string().max(200).optional(),
        country: z.string().max(100).optional(),
        state: z.string().max(100).optional(),
        score: z.number().int().min(0).max(100).optional(),
      }).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
      let payload: RoutingPayload;
      if (input.leadId) {
        const [lead] = await db.select().from(leads).where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, ctx.workspace.id)));
        if (!lead) throw new TRPCError({ code: "NOT_FOUND", message: "That lead is not in this workspace." });
        payload = { title: lead.title, company: lead.company, source: lead.source, score: lead.score ?? 0, industry: null, country: null, state: null, city: null };
      } else if (input.lead) {
        const l = input.lead;
        payload = { title: blank(l.title), company: blank(l.company), source: blank(l.source), industry: blank(l.industry), country: blank(l.country), state: blank(l.state), city: null, score: l.score ?? 0 };
      } else {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a lead or type one in." });
      }
      return previewRouting(ctx.workspace.id, payload);
    }),
});

/** Lead statuses that still sit on a rep's plate: what a routing capacity counts (F43). */
export const OPEN_LEAD_STATUSES = ["new", "working", "qualified"] as const;

/** Open leads each of these users owns in the workspace, counted in SQL. */
async function openLeadsByOwner(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, workspaceId: number, userIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (userIds.length === 0) return out;
  const rows = await db.select({ owner: leads.ownerUserId, n: sql<number>`count(*)` }).from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), inArray(leads.ownerUserId, userIds), inArray(leads.status, [...OPEN_LEAD_STATUSES])))
    .groupBy(leads.ownerUserId);
  for (const r of rows) if (r.owner != null) out.set(r.owner, Number(r.n));
  return out;
}

/**
 * Public helper: choose an owner for a new/imported lead. Side-effect: advances
 * the round-robin cursor on the matched rule.
 */
export async function routeLeadOwner(workspaceId: number, payload: RoutingPayload): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;

  // Industry, country and state from the lead's account (enrichRoutingPayload).
  payload = await enrichRoutingPayload(db, workspaceId, payload);

  /**
   * Geography and Industry rules take the owner from the matching territory
   * rule (audit 2026-10-20, P41). Both strategies passed no lookup, so they
   * always gave the first target, exactly like Direct. A Geography rule uses
   * territory rules that name a country or state; an Industry rule, those that
   * name an industry. With no match, or an owner who has left, the rule still
   * falls back to its first target.
   */
  const territory = await db.select().from(crmTerritoryRules)
    .where(and(eq(crmTerritoryRules.workspaceId, workspaceId), eq(crmTerritoryRules.active, true)))
    .orderBy(crmTerritoryRules.priority, crmTerritoryRules.id);
  const same = (rule: string | null, lead: string | null | undefined) =>
    rule == null || rule.trim() === "" || rule.trim().toLowerCase() === (lead ?? "").trim().toLowerCase();
  const company = (payload.company ?? "").toLowerCase();

  /**
   * The round-robin cursor is claimed, not overwritten (P43). Two leads routed
   * at once both read the same cursor, both picked the same rep and both wrote
   * the same next value. Now the cursor only moves by +1 from the value this
   * pick read; if another route moved it first, the rules are read again.
   * It only ever grows, and the pick takes it modulo the target list.
   */
  for (let attempt = 1; ; attempt++) {
    const rows = await db.select().from(leadRoutingRules).where(eq(leadRoutingRules.workspaceId, workspaceId));

    /**
     * 🔴 `targetUserIds` is a STORED LIST OF USER IDS and nothing revalidated it.
     * A rep who leaves keeps their place in the round-robin: every Nth inbound
     * lead is filed under someone who cannot sign in, indefinitely, and the rule
     * still reports a rising `matchCount` so it looks like it is working.
     *
     * Filtered here, once, over every rule — `pickRoutingMatch` is pure and must
     * stay that way. It already treats an empty target list as "no match" and
     * falls through to the NEXT rule, so a rule whose whole team has gone
     * degrades to the next-best rule and finally to an unowned lead, rather than
     * to a ghost. The stored cursor is taken modulo the surviving length, so it
     * stays in range; the rotation shifts, which is the correct outcome when the
     * roster changes. Territory owners are checked the same way.
     */
    const active = await activeMemberIds(
      workspaceId,
      [...rows.flatMap((r) => ((r.targetUserIds as number[] | null) ?? [])), ...territory.map((t) => t.ownerUserId)],
    );
    const rules: RoutingRule[] = rows.map((r) => ({
      id: r.id,
      enabled: r.enabled,
      priority: r.priority,
      conditions: (r.conditions as any) ?? {},
      strategy: r.strategy,
      targetUserIds: (((r.targetUserIds as number[] | null) ?? []).filter((u) => active.has(u))),
      rrCursor: r.rrCursor,
      capacityPerRep: r.capacityPerRep ?? null,
    }));
    // Capacity-aware routing (audit 2026-10-20, F43): open leads per owner,
    // read only when a rule sets a capacity, so other workspaces pay nothing.
    const load = rules.some((r) => r.capacityPerRep != null && r.capacityPerRep > 0)
      ? await openLeadsByOwner(db, workspaceId, Array.from(active))
      : null;
    const territoryOwner = (rule: RoutingRule, p: RoutingPayload): number | null => {
      for (const t of territory) {
        if (rule.strategy === "geography" ? !(t.country || t.state) : !t.industry) continue;
        if (!same(t.industry, p.industry) || !same(t.country, p.country) || !same(t.state, p.state)) continue;
        if (t.companyContains && !company.includes(t.companyContains.toLowerCase())) continue;
        if (t.ownerUserId != null && active.has(t.ownerUserId)) return t.ownerUserId;
      }
      return null;
    };
    // Typed conditions (P42): case-blind text, numeric Score.
    const m = pickRoutingMatch(rules, payload, routingConditionsMatch, territoryOwner, load ? (uid) => load.get(uid) ?? 0 : undefined);
    if (!m) return null;
    const counted = { matchCount: sql`${leadRoutingRules.matchCount} + 1`, lastMatchedAt: new Date() };
    if (m.newCursor === undefined) {
      await db.update(leadRoutingRules).set(counted)
        .where(and(eq(leadRoutingRules.id, m.ruleId), eq(leadRoutingRules.workspaceId, workspaceId)));
      return m.ownerUserId;
    }
    // After a few lost races, take the pick rather than leave the lead unowned.
    const seen = attempt < 5 ? rules.find((r) => r.id === m.ruleId)!.rrCursor : undefined;
    // A pick that passed reps at capacity moves the cursor past them too (F43).
    const step = m.cursorStep ?? 1;
    const res = await db.update(leadRoutingRules).set({ rrCursor: sql`${leadRoutingRules.rrCursor} + ${step}`, ...counted })
      .where(and(
        eq(leadRoutingRules.id, m.ruleId),
        eq(leadRoutingRules.workspaceId, workspaceId),
        seen === undefined ? undefined : eq(leadRoutingRules.rrCursor, seen),
      ));
    if (Number((res as any)?.[0]?.affectedRows ?? (res as any)?.affectedRows ?? 0) > 0 || seen === undefined) return m.ownerUserId;
  }
}

/**
 * The routing payload with what the lead's account knows filled in, for the
 * router and its dry run alike.
 *
 * The routing-rule builder offers industry / country / state conditions, but
 * ALL THREE call sites passed null for them (leads have no such columns), so
 * any rule using those conditions could never match — it silently never
 * fired, with nothing to tell the admin who built it.
 *
 * Leads don't carry that data, but the matching Account does: accounts have
 * `industry` and `region` (which is where CSV import now puts state +
 * country). Enrich here rather than at each call site so all three paths
 * — CRM lead create, webform submit, landing-page submit — benefit alike.
 */
async function enrichRoutingPayload(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, workspaceId: number, payload: RoutingPayload): Promise<RoutingPayload> {
  if (payload.company && (!payload.industry || (!payload.country && !payload.state))) {
    try {
      const [acct] = await db
        .select({ industry: accounts.industry, region: accounts.region })
        .from(accounts)
        .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.name, payload.company)))
        .limit(1);
      if (acct) {
        return {
          ...payload,
          industry: payload.industry ?? acct.industry ?? null,
          // region is a free-text "State, Country" string; expose it to BOTH
          // condition fields so either spelling of a rule can match it.
          country: payload.country ?? acct.region ?? null,
          state: payload.state ?? acct.region ?? null,
        };
      }
    } catch (e) {
      // Enrichment is a bonus — never fail routing because of it.
      console.error("[leadRouting] account enrichment failed:", (e as Error)?.cause ?? e);
    }
  }
  return payload;
}

/** One rule as the dry run saw it, in the order the router runs them (F41). */
export type RoutingRuleVerdict = {
  ruleId: number;
  name: string;
  /** disabled, conditions not met, met with nobody to give it to, the pick, or after the pick. */
  verdict: "disabled" | "no_match" | "no_owner" | "picked" | "not_reached";
  ownerUserId: number | null;
};

/**
 * What routing would do with a lead, changing nothing (audit 2026-10-20, F41:
 * "Test a lead"): the payload as the router sees it (the account's industry
 * and region filled in), each rule's verdict in run order, and who the first
 * rule that can assign would give the lead to. It reads what routeLeadOwner
 * reads and picks with the same pickRoutingMatch and evaluator, but advances
 * no round-robin cursor and counts no match: the round-robin pick shown is
 * whoever is next in turn now.
 */
export async function previewRouting(workspaceId: number, input: RoutingPayload): Promise<{ payload: RoutingPayload; rules: RoutingRuleVerdict[]; pick: { ruleId: number; ownerUserId: number } | null }> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const payload = await enrichRoutingPayload(db, workspaceId, input);
  const rows = await db.select().from(leadRoutingRules).where(eq(leadRoutingRules.workspaceId, workspaceId));
  const territory = await db.select().from(crmTerritoryRules)
    .where(and(eq(crmTerritoryRules.workspaceId, workspaceId), eq(crmTerritoryRules.active, true)))
    .orderBy(crmTerritoryRules.priority, crmTerritoryRules.id);
  const active = await activeMemberIds(
    workspaceId,
    [...rows.flatMap((r) => ((r.targetUserIds as number[] | null) ?? [])), ...territory.map((t) => t.ownerUserId)],
  );
  const same = (rule: string | null, lead: string | null | undefined) =>
    rule == null || rule.trim() === "" || rule.trim().toLowerCase() === (lead ?? "").trim().toLowerCase();
  const company = (payload.company ?? "").toLowerCase();
  const territoryOwner = (rule: RoutingRule, p: RoutingPayload): number | null => {
    for (const t of territory) {
      if (rule.strategy === "geography" ? !(t.country || t.state) : !t.industry) continue;
      if (!same(t.industry, p.industry) || !same(t.country, p.country) || !same(t.state, p.state)) continue;
      if (t.companyContains && !company.includes(t.companyContains.toLowerCase())) continue;
      if (t.ownerUserId != null && active.has(t.ownerUserId)) return t.ownerUserId;
    }
    return null;
  };
  const rules: Array<RoutingRule & { name: string }> = rows.map((r) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    priority: r.priority,
    conditions: (r.conditions as any) ?? {},
    strategy: r.strategy,
    targetUserIds: (((r.targetUserIds as number[] | null) ?? []).filter((u) => active.has(u))),
    rrCursor: r.rrCursor,
  })).sort((x, y) => x.priority - y.priority || x.id - y.id);
  // The pick over every rule, exactly as the router makes it.
  const pick = pickRoutingMatch(rules, payload, routingConditionsMatch, territoryOwner);
  let reached = true;
  const verdicts: RoutingRuleVerdict[] = rules.map((r) => {
    if (!reached) return { ruleId: r.id, name: r.name, verdict: "not_reached", ownerUserId: null };
    if (!r.enabled) return { ruleId: r.id, name: r.name, verdict: "disabled", ownerUserId: null };
    if (!ruleMatches(r, payload, routingConditionsMatch)) return { ruleId: r.id, name: r.name, verdict: "no_match", ownerUserId: null };
    if (pick?.ruleId === r.id) {
      reached = false;
      return { ruleId: r.id, name: r.name, verdict: "picked", ownerUserId: pick.ownerUserId };
    }
    return { ruleId: r.id, name: r.name, verdict: "no_owner", ownerUserId: null };
  });
  return { payload, rules: verdicts, pick: pick ? { ruleId: pick.ruleId, ownerUserId: pick.ownerUserId } : null };
}
