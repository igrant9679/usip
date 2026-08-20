/**
 * ARE Engine — the autonomous orchestrator behind the Autonomous Revenue Engine.
 *
 * Until now the ARE Hub was a UI + data model with no engine: nothing drove
 * prospects through discovery → enrichment → approval → sequencing → send.
 * This module is that engine. It is invoked on a cron from _core/index.ts.
 *
 * Each run first performs a single GLOBAL enrichment pass
 * (enrichPendingGlobally): pending prospects across every ACTIVE campaign are
 * enriched ONE AT A TIME (strictly serial), best-fit first, bounded per cycle.
 * Pausing a campaign pauses its enrichment too — no background LLM spend on a
 * paused campaign (user directive 2026-07-23; manual are.prospects.enrich /
 * enrichBatch remain available regardless of status). Serial so it never trips
 * the LLM provider's concurrent-connection limit.
 *
 * Then, for every campaign with status='active', it performs one bounded
 * "tick" through the remaining pipeline phases:
 *
 *   1. SCREEN     — auto-approve / auto-reject enriched prospects per the
 *                   campaign's autonomyMode + autoApproveThreshold. Also
 *                   rejects rows scored BELOW the enrichment gate, which can
 *                   never be enriched and so could never reach this pass at
 *                   all — they used to sit 'pending' forever with no reason
 *                   recorded anywhere.
 *   2. SEQUENCE   — runSequenceAgent on approved prospects with no sequence.
 *   3. ENROLL     — turn a prospect's generatedSequence into are_execution_queue
 *                   rows (one per step) and mark it 'enrolled'.
 *   4. DISPATCH   — send due email steps via the workspace SMTP config,
 *                   respecting dailySendCap and the suppression list.
 *   5. COMPLETE   — mark prospects whose every step has been actioned.
 *   6. COUNTERS   — recompute the campaign's denormalised funnel counters.
 *   7. DISCOVERY  — if the queue is drained and below target, scrape one
 *                   source to top it up.
 *
 * Everything is bounded per tick (LLM cost) and idempotent (safe to re-run).
 * Per-campaign and per-phase try/catch so one failure never blocks the rest.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, lte, ne, notExists, notInArray, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  areCampaigns,
  areEngineLogs,
  areExecutionQueue,
  areSuppressionList,
  contacts,
  icpProfiles,
  leads,
  prospectIntelligence,
  prospectQueue,
} from "../drizzle/schema";
import { runEnrichAgent, runSequenceAgent } from "./routers/are/prospects";
import {
  saveScrapeJobAndQueue,
  scrapeGoogleBusiness,
  scrapeNews,
  scrapeWeb,
} from "./routers/are/scraper";
import { searchLinkedInPeople, type UnipileLinkedInSearchHit } from "./lib/unipile";
import { listUsableAccounts } from "./services/linkedinLookup";
import { randomUUID } from "node:crypto";
import { sendWorkspaceEmail, sendCampaignEmailViaPool } from "./emailDelivery";
import { dispatchLinkedInStep, HEALABLE_NO_LINKEDIN } from "./services/are/linkedinStep";
import { injectTracking } from "./mergeVars";
import { resolveBookingUrl } from "./mergeVars";
import { ARE_DEFAULT_SOURCES, normalizeSources } from "@shared/areSources";
// One rule for a step's index + variant key, shared with the A/B metadata
// upsert in routers/are/prospects.ts — see shared/areSequenceSteps.ts.
import { normalizeSequence } from "@shared/areSequenceSteps";
import { effectiveStepGapDays, dueAtForDay, dayOffsetForPosition, sanitizeDayOffsets } from "@shared/areStepCadence";
import { apolloPulledToday, apolloSearchPeople, getApolloDailyCap } from "./services/apollo";
import { archivedWorkspaceIds } from "./_core/workspaceArchive";
import { queueIdentityKeys } from "./services/are/queueIdentity";
import {
  buildQuickenrichFilters,
  getQuickEnrichKey,
  getQuickenrichDailyPullCap,
  quickenrichContactFinder,
  quickenrichPulledToday,
} from "./services/quickenrich";
import { stripNameCredentials } from "./services/enrichment/personName";
import {
  HEALABLE_NO_EMAIL,
  HEALABLE_POOL_PREFIX,
  sequenceCompletionVerdict,
} from "./services/sequenceCompletion";
import { appBaseUrl as publicAppOrigin } from "./appUrl";
import { escapeHtml } from "@shared/escapeHtml";
import { isHtmlBody, htmlBodyToText } from "@shared/emailBody";
import { buildMergeLookup, isEmptyLinkToken, parseMergeToken, resolveMergeName, stripEmptyLinkCarriers } from "@shared/mergeKeys";

/* ─── Per-tick bounds (keep LLM cost + wall-time predictable) ───────────── */
/** Max prospects enriched per engine cycle. Enrichment runs ONE AT A TIME
 *  (strictly serial) across all ACTIVE campaigns, so the LLM provider never
 *  sees more than one concurrent enrichment call. Bounded so a large backlog
 *  drains steadily over multiple ticks instead of stalling dispatch for other
 *  work. */
const ENRICH_PER_TICK = 5;
/**
 * ⚠️ These two are PER CAMPAIGN, not per tick — they are applied inside
 * tickCampaign(), which runs once for every ACTIVE campaign. Only
 * ENRICH_PER_TICK above is genuinely global (enrichPendingGlobally runs once,
 * before the campaign loop).
 *
 * So the LLM work in a tick scales with the number of active campaigns: four
 * campaigns means twelve sequence generations and forty enrolments, not three
 * and ten. The names said otherwise, which is exactly the wrong thing to
 * believe while tuning them or reasoning about how long a tick takes.
 *
 * Left per-campaign deliberately — making them global would silently starve
 * later campaigns in the loop, which is a product decision, not a cleanup.
 */
const SEQUENCE_PER_CAMPAIGN_TICK = 3;
const ENROLL_PER_CAMPAIGN_TICK = 10;
// Final checks can spend Reoon credits and seconds — bound them per tick so
// the 3-minute engine cadence never stalls. Unchecked rows still enroll.
const FINAL_CHECKS_PER_TICK = 5;
/** icpMatchScore below this is auto-screened out even in human-approval modes. */
/** The ICP score a prospect needs before enrichment will spend LLM budget on
 *  it, when the campaign does not set its own `minConfidence`.
 *
 *  ONE definition on purpose. It is used by the enrichment selector AND by the
 *  screen pass that rejects rows falling below it, and those two must be exact
 *  inverses of each other. If they drift, the screen pass rejects prospects
 *  that enrichment would have accepted — which destroys work rather than
 *  tidying up. `areEnrichGate.test.ts` asserts both sites use this constant. */
const ENRICH_MIN_CONFIDENCE_DEFAULT = 40;

const AUTO_REJECT_FLOOR = 30;
/** Fallback approve line for `full` autonomy when autoApproveThreshold is null. */
const DEFAULT_APPROVE_THRESHOLD = 70;

type Campaign = typeof areCampaigns.$inferSelect;
type Prospect = typeof prospectQueue.$inferSelect;

export interface AreEngineResult {
  campaignsProcessed: number;
  enriched: number;
  approved: number;
  rejected: number;
  sequencesGenerated: number;
  enrolled: number;
  sent: number;
  discovered: number;
  /** Sequences the completion sweep found cut short (all steps settled, more
   *  skipped than sent) and marked `canceled` rather than `completed`. */
  canceled?: number;
  /** Enrol passes refused because another was in flight for the campaign.
   *  Non-zero means "call again", NOT "nothing left". */
  enrolSkippedInFlight?: number;
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

/**
 * Resolve {{merge tags}} in an outreach body against the real prospect.
 *
 * Matching is @shared/mergeKeys, the same rule as every other substitution
 * path. The literal `firstName`/`lastName` regexes this used to carry were
 * case-insensitive but not separator-tolerant, so `{{first_name}}` — which the
 * sibling renderers resolve — fell through to the strip pass below and left a
 * hole in the sentence. This body is written by an LLM and mailed to a stranger
 * without a human in the loop, so it is the worst of the four places to
 * disagree about what a token means.
 *
 * The STRIP policy on unresolved tags is kept: it is the one implementation
 * that cannot leak braces to a prospect, and that is deliberate.
 */
export function applyMerge(text: string, p: Prospect, bookingUrl = ""): string {
  const lookup = buildMergeLookup(Object.entries({
    firstName: p.firstName ?? "there",
    lastName: p.lastName ?? "",
    company: p.companyName ?? "your company",
    companyName: p.companyName ?? "your company",
    title: p.title ?? "",
    bookingLink: bookingUrl,
  }));
  /**
   * A dead {{bookingLink}} takes its sentence with it, rather than sending a
   * stranger "Book a time here: ". Runs BEFORE substitution — afterwards the
   * token is gone and its carrier can no longer be found.
   */
  const carried = stripEmptyLinkCarriers(String(text ?? ""), (tok) =>
    isEmptyLinkToken(tok, lookup),
  );

  return carried.replace(/\{\{([^}]+)\}\}/g, (_match, inner: string) => {
    const { name, fallback } = parseMergeToken(inner);
    const hit = name ? resolveMergeName(lookup, name) : undefined;
    if (hit === undefined) return ""; // strip unresolved tags
    return hit || fallback || hit;
  });
}

/** Plain-text outreach body → minimal HTML for the email send. */
function textToHtml(text: string): string {
  // escapeHtml, not a local 3-char chain: the link pass below emits
  // `<a href="${mdUrl}">`, so a URL carrying a double quote closed the attribute
  // and everything after it parsed as more attributes — in outreach HTML that
  // goes to a prospect.
  const esc = escapeHtml(text);
  // Render Markdown links [label](url) AND bare URLs in one pass (no double-wrap),
  // so a {{bookingLink}} CTA — or any link — is actually clickable.
  const linked = esc.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"]+)/g,
    (_m, label: string, mdUrl: string, bareUrl: string) =>
      mdUrl ? `<a href="${mdUrl}">${label}</a>` : `<a href="${bareUrl}">${bareUrl}</a>`,
  );
  return linked
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** Serialize an unknown thrown value into a JSON-friendly details object
 *  (name + message + stack + cause). Goes into are_engine_logs.details so
 *  the Logs tab can expand a row to show the full stack. */
function errorDetails(e: unknown): Record<string, unknown> {
  if (e instanceof Error) {
    return {
      name: e.name,
      message: e.message,
      stack: e.stack,
      cause: (e as any).cause ? String((e as any).cause) : undefined,
    };
  }
  return { value: String(e) };
}

/**
 * Best-effort engine log emitter — surfaces per-phase activity to the
 * campaign detail "Logs" tab so the user can see what the engine is actually
 * doing. Never throws; logging must not break a tick.
 */
async function emitLog(
  workspaceId: number,
  campaignId: number | null,
  phase: string,
  level: "info" | "warn" | "error",
  message: string,
  details?: unknown,
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(areEngineLogs).values({
      workspaceId,
      campaignId: campaignId ?? null,
      phase,
      level,
      message: message.slice(0, 500),
      details: details === undefined ? null : (details as any),
    });
  } catch (e) {
    // Logging failures are non-fatal — fall back to console.
    console.error("[AreEngine] emitLog failed:", e);
  }
}

/* ─── Engine entrypoint ─────────────────────────────────────────────────── */

/** In-flight guard — a slow tick must never overlap the next cron firing. */
let engineRunning = false;

export async function runAreEngine(): Promise<AreEngineResult> {
  const result: AreEngineResult = {
    campaignsProcessed: 0,
    enriched: 0,
    approved: 0,
    rejected: 0,
    sequencesGenerated: 0,
    enrolled: 0,
    sent: 0,
    discovered: 0,
  };
  if (engineRunning) {
    console.log("[AreEngine] previous tick still running — skipping this run");
    return result;
  }
  const db = await getDb();
  if (!db) return result;

  engineRunning = true;
  try {
    // Global, serial, bounded enrichment FIRST — active campaigns only, one
    // LLM call at a time. Paused campaigns spend nothing until resumed.
    try {
      await enrichPendingGlobally(result);
    } catch (e) {
      console.error("[AreEngine] global enrich pass failed:", e);
    }

    const active = await db
      .select()
      .from(areCampaigns)
      .where(eq(areCampaigns.status, "active"));

    const archivedWs = await archivedWorkspaceIds();
    for (const campaign of active) {
      if (archivedWs.has(campaign.workspaceId)) continue; // archived workspaces are frozen (2026-08-12)
      try {
        await tickCampaign(campaign, result);
        result.campaignsProcessed++;
      } catch (e) {
        console.error(`[AreEngine] campaign ${campaign.id} tick failed:`, e);
      }
    }
  } finally {
    engineRunning = false;
  }

  if (result.campaignsProcessed > 0 || result.enriched > 0) {
    console.log(
      `[AreEngine] tick complete — campaigns=${result.campaignsProcessed} ` +
        `enriched=${result.enriched} approved=${result.approved} rejected=${result.rejected} ` +
        `sequences=${result.sequencesGenerated} enrolled=${result.enrolled} sent=${result.sent} ` +
        `discovered=${result.discovered}`,
    );
  }
  return result;
}

/* ─── Global enrichment pass (serial, bounded, active campaigns only) ───── */
/**
 * Enrich the next batch of pending prospects across every ACTIVE campaign in
 * EVERY workspace, ONE AT A TIME. This is kept separate from the per-campaign
 * tick so ordering is global (best-fit first across campaigns) and strictly
 * serial. Paused/draft/completed campaigns are skipped: pausing a campaign
 * must stop ALL its background LLM spend, not just dispatch (user directive
 * 2026-07-23). Manual enrichment (are.prospects.enrich / enrichBatch /
 * reEvaluateAll) still works on any campaign regardless of status.
 *
 * Strictly serial (await each enrichment before the next) so only one LLM call
 * is ever in flight — the whole point of the request: never overload the API.
 * Bounded by ENRICH_PER_TICK so a large backlog drains steadily over multiple
 * ticks rather than stalling the rest of the engine in a single long tick.
 */
async function enrichPendingGlobally(result: AreEngineResult): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Next batch, best-fit first, gated by each campaign's own minConfidence
  // (default 40) so enrichment budget only goes to prospects that clear the bar.
  // Rows scored 0 are legacy (queued before scoring existed) and always pass.
  // 'enriching' is included to recover rows left stuck by a crashed run —
  // runEnrichAgent is idempotent and overwrites cleanly.
  //
  // APPROVED rows pass regardless of score (ARE audit, 2026-08-20). The gate
  // is a screening-budget rule: don't spend enrichment on prospects we may
  // never contact. A row a HUMAN approved is past screening — we WILL contact
  // them, and without a dossier sequence generation refuses them. Live: four
  // owner-approved prospects scored 33 against gates of 35 sat
  // approved/pending, invisible to this selector, while phase 2 waited on
  // dossiers that could never come. The approval decision outranks the score
  // — override supremacy, same as everywhere else the owner has spoken.
  const pending = await db
    .select({
      id: prospectQueue.id,
      workspaceId: prospectQueue.workspaceId,
      campaignId: prospectQueue.campaignId,
    })
    .from(prospectQueue)
    .innerJoin(areCampaigns, eq(areCampaigns.id, prospectQueue.campaignId))
    .where(
      and(
        eq(areCampaigns.status, "active"),
        inArray(prospectQueue.enrichmentStatus, ["pending", "enriching"]),
        sql`(${prospectQueue.icpMatchScore} >= COALESCE(${areCampaigns.minConfidence}, ${ENRICH_MIN_CONFIDENCE_DEFAULT}) OR ${prospectQueue.icpMatchScore} = 0 OR ${prospectQueue.sequenceStatus} = 'approved')`,
      ),
    )
    .orderBy(desc(prospectQueue.icpMatchScore))
    .limit(ENRICH_PER_TICK);

  if (pending.length === 0) return;

  // One enrichment at a time. A single prospect failing must not abort the rest.
  const archivedWs = await archivedWorkspaceIds();
  const perCampaign = new Map<number, { ws: number; ok: number; total: number }>();
  for (const p of pending) {
    if (archivedWs.has(p.workspaceId)) continue; // archived workspaces are frozen (2026-08-12)
    const bucket = perCampaign.get(p.campaignId) ?? { ws: p.workspaceId, ok: 0, total: 0 };
    bucket.total++;
    try {
      await runEnrichAgent(p.id, p.workspaceId);
      bucket.ok++;
      result.enriched++;
    } catch (e) {
      console.error(`[AreEngine] enrich prospect ${p.id} (campaign ${p.campaignId}) failed:`, e);
    }
    perCampaign.set(p.campaignId, bucket);
  }

  // One summary log per campaign so each campaign's Logs tab shows its activity.
  for (const [campId, b] of perCampaign) {
    await emitLog(b.ws, campId, "enrich", "info",
      `Enriched ${b.ok}/${b.total} prospects (serial, global pass)`);
  }
}

/* ─── Per-campaign tick ─────────────────────────────────────────────────── */
/**
 * Phase 3 — ENROLL, as a callable. Turns each approved prospect's
 * generatedSequence into are_execution_queue rows and marks it enrolled.
 *
 * Extracted from tickCampaign so it can be run ON ITS OWN, against a
 * PAUSED campaign, without the surrounding tick. The reason is operational:
 * on 2026-08-17 the only way to enrol 112 partly-sent prospects was to
 * unpause, run a full engine tick, and re-pause before dispatch could find
 * anything due — from a browser session whose calls could time out and
 * complete late, leaving campaigns active with nobody watching. Enrolment
 * is bookkeeping and dispatch is outreach; they must be separable.
 *
 * ONE implementation. tickCampaign calls this; so does
 * are.engine.enrollOnly. They cannot drift.
 */
/**
 * Per-campaign in-flight set for enrolment. Two concurrent enrol runs on the
 * same campaign both read a prospect as `approved`, both pass the scheduled-
 * rows guard (neither has inserted yet), and both insert — the prospect gets
 * every remaining step twice. Live on 2026-08-17: Heather Daughtery, 12 rows
 * for a 6-step remainder, from two enrollOnly calls 18 seconds apart. The
 * guard is a read-then-write and cannot be made atomic without a lock; this
 * is the lock. Same shape as `engineRunning`, scoped to the campaign so
 * different campaigns still enrol in parallel.
 */
const enrollInFlight = new Set<number>();

export async function enrollApprovedForCampaign(
  campaign: Campaign,
  result: AreEngineResult,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const wsId = campaign.workspaceId;
  const campId = campaign.id;
  if (enrollInFlight.has(campId)) {
    await emitLog(wsId, campId, "enroll", "warn",
      "Enrol pass skipped — another enrol run for this campaign is still in flight");
    // Surface it on the result too. A caller looping "until enrolled hits
    // zero" would otherwise read a lock-skip as "done" — the same silent
    // no-op that made a wedged engineRunning flag look like success.
    result.enrolSkippedInFlight = (result.enrolSkippedInFlight ?? 0) + 1;
    return;
  }
  enrollInFlight.add(campId);
  try {
    await enrollApprovedForCampaignUnlocked(db, campaign, result);
  } finally {
    enrollInFlight.delete(campId);
  }
}

async function enrollApprovedForCampaignUnlocked(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  campaign: Campaign,
  result: AreEngineResult,
): Promise<void> {
  const wsId = campaign.workspaceId;
  const campId = campaign.id;

  try {
    const rows = await db
      .select({
        id: prospectQueue.id,
        email: prospectQueue.email,
        personProspectId: prospectQueue.personProspectId,
        sequence: prospectIntelligence.generatedSequence,
        cadence: prospectIntelligence.cadenceDayOffsets,
      })
      .from(prospectQueue)
      .innerJoin(
        prospectIntelligence,
        eq(prospectIntelligence.prospectQueueId, prospectQueue.id),
      )
      .where(
        and(
          eq(prospectQueue.campaignId, campId),
          eq(prospectQueue.workspaceId, wsId),
          eq(prospectQueue.sequenceStatus, "approved"),
          sql`${prospectIntelligence.generatedSequence} IS NOT NULL`,
          /**
           * THE EMAIL GATE (owner decision 2026-08-20). An email-less
           * prospect whose sequence contains an email step used to be
           * enrolled anyway, and every such step could only fail at its due
           * time ("Prospect has no email address") — three identical 29-row
           * failure batches between 08-16 and 08-20. Now enrolment waits:
           * the row stays `approved`, and this WHERE re-admits it the moment
           * enrichment lands an address. The dispatch-time fail + heal stay
           * as the backstop for an address that vanishes AFTER enrolment.
           * In SQL, not the loop — a loop `continue` leaves the row matching
           * this WHERE, and ten of them starve the page (the 320072b shape,
           * same as the zero-step case below).
           *
           * "Contains an email step" must agree with normalizeSequence,
           * which defaults a MISSING channel to email: JSON_SEARCH finds
           * explicit 'email' channels, and the JSON_EXTRACT length compare
           * catches steps with no channel key at all. (A channel spelled
           * "Email" escapes both arms — that row enrolls and its email steps
           * fail healably at dispatch: the pre-gate behaviour, not a new
           * failure mode.) LinkedIn-only sequences enroll regardless — they
           * need no address.
           */
          sql`((${prospectQueue.email} IS NOT NULL AND ${prospectQueue.email} <> '')
               OR NOT (
                 JSON_SEARCH(${prospectIntelligence.generatedSequence}, 'one', 'email', NULL, '$[*].channel') IS NOT NULL
                 OR COALESCE(JSON_LENGTH(JSON_EXTRACT(${prospectIntelligence.generatedSequence}, '$[*].channel')), 0)
                    < JSON_LENGTH(${prospectIntelligence.generatedSequence})
               ))`,
          // A stored sequence that yields no steps is the one exit from the
          // loop below that does not change the row: status stays `approved`
          // and generatedSequence stays non-null, so it matches this WHERE
          // again on the very next tick. Ten of them (the whole per-tick
          // allowance) and this campaign never enrols anyone again.
          //
          // Exactly equivalent to `normalizeSequence(raw).length === 0`, and
          // that is checkable rather than hopeful: normalizeSequence is a
          // pure .map, so it never drops a step — it returns [] only when the
          // stored value is not an array, or is an empty one. JSON_TYPE
          // covers the first (an LLM writing an object instead of a list),
          // JSON_LENGTH the second.
          sql`(JSON_TYPE(${prospectIntelligence.generatedSequence}) = 'ARRAY'
               AND JSON_LENGTH(${prospectIntelligence.generatedSequence}) > 0)`,
        ),
      )
      // Oldest approved first. Anything but an arbitrary page.
      .orderBy(prospectQueue.id)
      .limit(ENROLL_PER_CAMPAIGN_TICK);

    // Those rows are now out of the page — which fixes the starvation and,
    // on its own, would make them invisible instead: approved forever, never
    // enrolled, nothing saying why. Counted and logged so the campaign log
    // names the defect. Same trade as the auto-send fix: filter in SQL, keep
    // the number.
    const [unusable] = await db
      .select({ n: sql<number>`count(*)` })
      .from(prospectQueue)
      .innerJoin(
        prospectIntelligence,
        eq(prospectIntelligence.prospectQueueId, prospectQueue.id),
      )
      .where(
        and(
          eq(prospectQueue.campaignId, campId),
          eq(prospectQueue.workspaceId, wsId),
          eq(prospectQueue.sequenceStatus, "approved"),
          sql`${prospectIntelligence.generatedSequence} IS NOT NULL`,
          sql`NOT (JSON_TYPE(${prospectIntelligence.generatedSequence}) = 'ARRAY'
                   AND JSON_LENGTH(${prospectIntelligence.generatedSequence}) > 0)`,
        ),
      );
    const unusableCount = Number(unusable?.n ?? 0);
    if (unusableCount > 0) {
      await emitLog(wsId, campId, "enroll", "warn",
        `${unusableCount} approved prospect${unusableCount === 1 ? " has" : "s have"} a generated sequence with no usable steps — not enrolled. Regenerate the sequence for these prospects.`);
    }

    // Held by the email gate, and SAID so — same trade as the unusable
    // counter: the SQL filter keeps these rows off the page, the count keeps
    // them from being invisible (approved forever, no reason given).
    const [waitingEmail] = await db
      .select({ n: sql<number>`count(*)` })
      .from(prospectQueue)
      .innerJoin(
        prospectIntelligence,
        eq(prospectIntelligence.prospectQueueId, prospectQueue.id),
      )
      .where(
        and(
          eq(prospectQueue.campaignId, campId),
          eq(prospectQueue.workspaceId, wsId),
          eq(prospectQueue.sequenceStatus, "approved"),
          sql`${prospectIntelligence.generatedSequence} IS NOT NULL`,
          sql`(JSON_TYPE(${prospectIntelligence.generatedSequence}) = 'ARRAY'
               AND JSON_LENGTH(${prospectIntelligence.generatedSequence}) > 0)`,
          sql`(${prospectQueue.email} IS NULL OR ${prospectQueue.email} = '')`,
          sql`(JSON_SEARCH(${prospectIntelligence.generatedSequence}, 'one', 'email', NULL, '$[*].channel') IS NOT NULL
               OR COALESCE(JSON_LENGTH(JSON_EXTRACT(${prospectIntelligence.generatedSequence}, '$[*].channel')), 0)
                  < JSON_LENGTH(${prospectIntelligence.generatedSequence}))`,
        ),
      );
    const waitingEmailCount = Number(waitingEmail?.n ?? 0);
    if (waitingEmailCount > 0) {
      await emitLog(wsId, campId, "enroll", "info",
        `${waitingEmailCount} approved prospect${waitingEmailCount === 1 ? " is" : "s are"} waiting for an email address — email steps are not scheduled until enrichment finds one`);
    }

    let finalChecksThisTick = 0;
    for (const row of rows) {
      // Idempotency — if LIVE execution rows already exist, just sync the status.
      //
      // "Live" is the word that was missing. This counted ALL execution rows,
      // so a prospect whose sequence had been canceled (every step `skipped`)
      // and then re-approved with a freshly generated sequence was treated as
      // already enrolled: status flipped to `enrolled`, no rows were minted,
      // and the completion sweep — which sees zero scheduled and calls that
      // done — marked the prospect `completed` within the hour. Live on
      // 2026-08-16: 141 regenerated sequences, ZERO enrolled steps, 112 of
      // them "completed" without a single follow-up ever being scheduled.
      // The user saw sequences finish in hours that were written to run for
      // fourteen days.
      //
      // Only rows that still represent PENDING work — status scheduled — mean
      // "this prospect is enrolled and needs nothing from us". Everything
      // else, sent included, is history.
      //
      // The first version of this fix counted `scheduled OR sent`, and that
      // re-broke it from the other side within the hour: a prospect whose
      // step 1 had gone out and whose steps 2–7 were skipped has ONE sent row,
      // tripped the guard, got flipped to enrolled with nothing scheduled, and
      // the resume logic below — written for exactly that prospect — never
      // ran. 112 people, same afternoon. Sent rows are what resume READS; they
      // cannot also be what stops it running.
      const [existing] = await db
        .select({ n: sql<number>`count(*)` })
        .from(areExecutionQueue)
        .where(and(
          eq(areExecutionQueue.prospectQueueId, row.id),
          eq(areExecutionQueue.status, "scheduled"),
        ));
      if (Number(existing?.n ?? 0) > 0) {
        await db
          .update(prospectQueue)
          .set({ sequenceStatus: "enrolled" })
          .where(eq(prospectQueue.id, row.id));
        continue;
      }

      // Final record-detail validation via the canonical person (QuickEnrich
      // + stored LinkedIn + Reoon through the ONE comprehensive pass).
      // Best-effort and tick-bounded: enrollment NEVER blocks on it. Runs
      // BEFORE the suppression check so suppression evaluates the address
      // that will actually be used.
      if (row.personProspectId && finalChecksThisTick < FINAL_CHECKS_PER_TICK) {
        finalChecksThisTick++;
        const { runFinalCheckForQueueRow } = await import("./services/enrichment/finalCheck");
        const check = await runFinalCheckForQueueRow(wsId, row.id);
        if (check.mirroredEmail) {
          row.email = check.mirroredEmail;
          await emitLog(wsId, campId, "enroll", "info",
            `Final check upgraded prospect ${row.id} to verified person email before enrollment`);
        }
      }

      // Suppressed? Skip rather than enroll.
      if (row.email) {
        const [supp] = await db
          .select({ n: sql<number>`count(*)` })
          .from(areSuppressionList)
          .where(
            and(
              eq(areSuppressionList.workspaceId, wsId),
              eq(areSuppressionList.email, row.email),
            ),
          );
        if (Number(supp?.n ?? 0) > 0) {
          await db
            .update(prospectQueue)
            .set({
              sequenceStatus: "skipped",
              rejectedAt: new Date(),
              rejectionReason: "On suppression list — not enrolled",
            })
            .where(eq(prospectQueue.id, row.id));
          continue;
        }
      }

      const steps = normalizeSequence(row.sequence);
      if (steps.length === 0) {
        // Unreachable: the WHERE above excludes these. Kept, and no longer a
        // bare `continue`, because the two ways of asking the same question
        // sit in different languages — if they ever disagree, falling through
        // inserts zero execution rows and then marks the prospect `enrolled`,
        // which is a person in a campaign that will never touch them. Better
        // to stop, say so, and drain the row so it cannot cycle.
        await db
          .update(prospectQueue)
          .set({
            sequenceStatus: "skipped",
            rejectedAt: new Date(),
            rejectionReason: "Generated sequence has no usable steps",
          })
          .where(eq(prospectQueue.id, row.id));
        await emitLog(wsId, campId, "enroll", "warn",
          `Prospect ${row.id} skipped — generated sequence normalised to zero steps (SQL and normalizeSequence disagree; investigate).`);
        continue;
      }

      /**
       * Enrolment must RESUME a sequence, not restart it.
       *
       * This minted every step from `now + dayOffset`, which is right for a
       * prospect nobody has touched and wrong for anyone else. A prospect
       * whose earlier steps already SENT — a re-enrolment after a cancel, a
       * regenerated sequence, a heal — would get a second copy of the steps
       * they had already received, and the whole cadence re-anchored to today
       * instead of to the day their first email actually went. Live on
       * 2026-08-17: 112 prospects with step 1 delivered, about to be handed
       * step 1 again.
       *
       * So: read what has been sent, skip those stepIndexes, and anchor the
       * remaining offsets to the FIRST send so the day-3 follow-up lands on
       * day 3 of the conversation the prospect is actually having. Nothing
       * sent yet → identical to before (anchor = now, all steps).
       */
      const priorSends = await db
        .select({ stepIndex: areExecutionQueue.stepIndex, executedAt: areExecutionQueue.executedAt })
        .from(areExecutionQueue)
        .where(and(
          eq(areExecutionQueue.prospectQueueId, row.id),
          eq(areExecutionQueue.status, "sent"),
        ));
      const sentIdx = new Set(priorSends.map((r) => r.stepIndex));
      const firstSendMs = priorSends
        .map((r) => (r.executedAt ? new Date(r.executedAt).getTime() : NaN))
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => a - b)[0];
      const now = Date.now();
      const anchor = firstSendMs ?? now;
      // The CAMPAIGN owns the cadence (0169): step k is due at anchor + k × gap,
      // whatever `day` the generated sequence carried. Position counts ALL
      // steps (sent ones included) so a resumed prospect stays on its grid.
      const gapDays = effectiveStepGapDays((campaign as { stepGapDays?: number | null }).stepGapDays);
      // The prospect's own timeline (0170) wins over the campaign grid when
      // set — through the ONE sanitiser, never the raw column.
      const dayOffsets = sanitizeDayOffsets(row.cadence);
      const positionOf = new Map<number, number>(steps.map((s, i) => [s.stepIndex, i]));
      const remaining = steps.filter((s) => !sentIdx.has(s.stepIndex));
      if (remaining.length === 0) {
        // Everything already sent: nothing to enrol, and the completion sweep
        // will settle it. Not a `continue` that leaves the row matching its own
        // WHERE — status changes to enrolled here so the sweep can see it.
        await db.update(prospectQueue).set({ sequenceStatus: "enrolled" }).where(eq(prospectQueue.id, row.id));
        continue;
      }
      const execRows = remaining.map((s) => ({
        workspaceId: wsId,
        campaignId: campId,
        prospectQueueId: row.id,
        stepIndex: s.stepIndex,
        channel: s.channel,
        // Never in the past: a resumed step whose slot has already gone is due
        // now, not overdue-and-dispatched-in-a-burst.
        scheduledAt: dueAtForDay(anchor, dayOffsetForPosition(dayOffsets, positionOf.get(s.stepIndex) ?? 0, gapDays), now),
        status: "scheduled" as const,
        messageContent: { subject: s.subject, body: s.body, variantKey: s.variantKey },
      }));
      await db.insert(areExecutionQueue).values(execRows as never);
      if (sentIdx.size > 0) {
        await emitLog(wsId, campId, "enroll", "info",
          `Prospect ${row.id} resumed: ${sentIdx.size} step${sentIdx.size === 1 ? "" : "s"} already sent, ${remaining.length} scheduled from first-send anchor`);
      }
      await db
        .update(prospectQueue)
        .set({ sequenceStatus: "enrolled" })
        .where(eq(prospectQueue.id, row.id));
      result.enrolled++;
    }
    if (rows.length > 0) {
      await emitLog(wsId, campId, "enroll", "info",
        `Enrolled ${rows.length} prospects into execution queue`);
    }
  } catch (e) {
    console.error(`[AreEngine] campaign ${campId} enroll phase failed:`, e);
    await emitLog(wsId, campId, "enroll", "error", String((e as Error)?.message ?? e));
  }
}

async function tickCampaign(campaign: Campaign, result: AreEngineResult): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const wsId = campaign.workspaceId;
  const campId = campaign.id;

  // NOTE: enrichment is NOT a per-campaign phase — it runs once, globally and
  // serially, in enrichPendingGlobally() before this loop (active campaigns
  // only, one LLM call at a time). The tick below starts at SCREEN.

  /* ── Phase 1: SCREEN — auto-approve / auto-reject ──────────────────── */
  try {
    /* 1a. Reject what can never be enriched, and so can never be screened.
     *
     * enrichPendingGlobally selects only
     *   icpMatchScore >= COALESCE(minConfidence, ENRICH_MIN_CONFIDENCE_DEFAULT)
     *   OR icpMatchScore = 0
     * so a row scored between 1 and the gate satisfies neither branch. It is
     * never enriched, so enrichmentStatus stays 'pending', so the pass below
     * (which reads only 'complete') never sees it, so sequenceStatus stays
     * 'pending' — forever, with no record anywhere of why.
     *
     * Measured on prod 2026-08-16: 44 of CommunityForce's 258 queued
     * prospects, and EVERY enrichment-pending row across all three active
     * campaigns sat in this band while not one eligible row did. Enrichment
     * had already taken everything it was allowed to touch; what remained was
     * not a backlog, it was sediment.
     *
     * Same rule this file applies everywhere else: a row that cannot proceed
     * must leave the set rather than linger in it. `skipped` is the existing
     * vocabulary for that and it surfaces in Rejections with a reason, which
     * is the point — the previous state was indistinguishable from "we have
     * not got to it yet".
     *
     * ⚠️ Note what this does NOT do: `targetProspectCount` is checked with an
     * unfiltered count(*), so rejected rows still count toward it. This does
     * not free queue headroom and will not unblock discovery.
     *
     * The predicate is deliberately the exact inverse of the selector's and
     * shares its constant. Written out in full rather than assembled from
     * variables, because an UPDATE whose WHERE cannot be read at the statement
     * is one edit away from losing its workspace scope unnoticed. */
    const gate = campaign.minConfidence ?? ENRICH_MIN_CONFIDENCE_DEFAULT;
    const [gateReject] = await db.execute(sql`
      UPDATE \`prospect_queue\`
      SET \`sequenceStatus\` = 'skipped',
          \`rejectedAt\` = NOW(),
          \`rejectionReason\` = CONCAT('Auto-screened: ICP match ', \`icpMatchScore\`,
            '/100 is below this campaign''s enrichment gate of ', ${gate},
            ' — never eligible for enrichment, so never screenable')
      WHERE \`campaignId\` = ${campId}
        AND \`workspaceId\` = ${wsId}
        AND \`sequenceStatus\` = 'pending'
        AND \`enrichmentStatus\` IN ('pending', 'enriching')
        AND \`icpMatchScore\` > 0
        AND \`icpMatchScore\` < ${gate}`);
    const gateRejected = (gateReject as { affectedRows?: number })?.affectedRows ?? 0;
    if (gateRejected > 0) {
      result.rejected += gateRejected;
      await emitLog(wsId, campId, "screen", "info",
        `${gateRejected} prospect${gateRejected === 1 ? "" : "s"} rejected — ICP match below the enrichment gate of ${gate}, so they could never be enriched or screened.`);
    }

    const enriched = await db
      .select()
      .from(prospectQueue)
      .where(
        and(
          eq(prospectQueue.campaignId, campId),
          eq(prospectQueue.workspaceId, wsId),
          eq(prospectQueue.enrichmentStatus, "complete"),
          eq(prospectQueue.sequenceStatus, "pending"),
        ),
      );
    const mode = campaign.autonomyMode;
    const threshold = campaign.autoApproveThreshold ?? DEFAULT_APPROVE_THRESHOLD;
    for (const p of enriched) {
      const score = p.icpMatchScore ?? 0;
      if (mode === "full") {
        // Fully autonomous — the threshold IS the approve/reject line.
        if (score >= threshold) {
          await db
            .update(prospectQueue)
            .set({ sequenceStatus: "approved", approvedAt: new Date() })
            .where(eq(prospectQueue.id, p.id));
          result.approved++;
        } else {
          await db
            .update(prospectQueue)
            .set({
              sequenceStatus: "skipped",
              rejectedAt: new Date(),
              rejectionReason: `Auto-screened: ICP match ${score}/100 below approve threshold ${threshold}`,
            })
            .where(eq(prospectQueue.id, p.id));
          result.rejected++;
        }
      } else if (mode === "batch_approval") {
        // Engine screens out obvious junk; humans approve the rest in batches.
        if (score < AUTO_REJECT_FLOOR) {
          await db
            .update(prospectQueue)
            .set({
              sequenceStatus: "skipped",
              rejectedAt: new Date(),
              rejectionReason: `Auto-screened: ICP match ${score}/100 below floor ${AUTO_REJECT_FLOOR}`,
            })
            .where(eq(prospectQueue.id, p.id));
          result.rejected++;
        }
        // else: leave 'pending' for human batch approval
      }
      // review_release: leave everything 'pending' for individual review
    }
    if (enriched.length > 0) {
      await emitLog(wsId, campId, "screen", "info",
        `Screened ${enriched.length} (mode=${mode}, threshold=${threshold})`);
    }
  } catch (e) {
    console.error(`[AreEngine] campaign ${campId} screen phase failed:`, e);
    await emitLog(wsId, campId, "screen", "error", String((e as Error)?.message ?? e));
  }

  /* ── Phase 2: SEQUENCE generation for approved prospects ───────────── */
  try {
    /* 2a. Heal the lie that wedges this phase (found live 2026-08-20, ARE
     * audit): an approved row with enrichmentStatus 'complete' but NO
     * prospect_intelligence row. runSequenceAgent refuses it ("no enrichment
     * data" — correctly: there is nowhere to store a sequence and nothing to
     * personalise from), but the page below kept re-selecting it: it stays
     * approved with a NULL sequence, so it matches every tick, and with a
     * page of SEQUENCE_PER_CAMPAIGN_TICK the same few rows occupied every
     * slot forever — campaigns 19 and 20 retried the same 1+3 prospects each
     * tick while 8 more approved prospects behind them never got a turn.
     * The 320072b starvation shape, in phase 2.
     *
     * 'complete' with no dossier is a lie whichever way it arose, and the
     * honest state is un-enriched: flip it back to 'pending' so the global
     * enrichment pass writes the dossier and re-marks it complete. The
     * selector admits approved rows REGARDLESS of score for exactly this
     * hand-off — the four live wedgers were owner-approved at score 33
     * against gates of 35, so "approved rows always clear the gate" is an
     * assumption a human can falsify with one click. Generation then
     * proceeds on a later tick. Self-healing, no papering over — the
     * refusal in runSequenceAgent stays exactly as is.
     */
    const [reQueue] = await db.execute(sql`
      UPDATE \`prospect_queue\` pq
      LEFT JOIN \`prospect_intelligence\` pi ON pi.\`prospectQueueId\` = pq.\`id\`
      SET pq.\`enrichmentStatus\` = 'pending'
      WHERE pq.\`campaignId\` = ${campId}
        AND pq.\`workspaceId\` = ${wsId}
        AND pq.\`sequenceStatus\` = 'approved'
        AND pq.\`enrichmentStatus\` = 'complete'
        AND pi.\`id\` IS NULL`);
    const reQueued = (reQueue as { affectedRows?: number })?.affectedRows ?? 0;
    if (reQueued > 0) {
      await emitLog(wsId, campId, "sequence", "warn",
        `${reQueued} approved prospect${reQueued === 1 ? "" : "s"} said enrichment was complete but had no stored intelligence — re-queued for enrichment so sequence generation can proceed`);
    }

    // The page holds only rows generation can actually act on: INNER join —
    // a dossier must exist (2a re-queues the ones that lack it). Ordered, so
    // the page is deterministic rather than whatever MySQL felt like.
    const needSequence = await db
      .select({ id: prospectQueue.id })
      .from(prospectQueue)
      .innerJoin(
        prospectIntelligence,
        eq(prospectIntelligence.prospectQueueId, prospectQueue.id),
      )
      .where(
        and(
          eq(prospectQueue.campaignId, campId),
          eq(prospectQueue.workspaceId, wsId),
          eq(prospectQueue.sequenceStatus, "approved"),
          sql`${prospectIntelligence.generatedSequence} IS NULL`,
        ),
      )
      .orderBy(prospectQueue.id)
      .limit(SEQUENCE_PER_CAMPAIGN_TICK);
    if (needSequence.length > 0) {
      const settled = await Promise.allSettled(
        needSequence.map((p) => runSequenceAgent(p.id, wsId, campId)),
      );
      const ok = settled.filter((s) => s.status === "fulfilled").length;
      result.sequencesGenerated += ok;
      await emitLog(wsId, campId, "sequence", "info",
        `Generated ${ok}/${needSequence.length} sequences`);
    }
  } catch (e) {
    console.error(`[AreEngine] campaign ${campId} sequence phase failed:`, e);
    await emitLog(wsId, campId, "sequence", "error", String((e as Error)?.message ?? e));
  }

  /* ── Phase 3: ENROLL — generatedSequence → are_execution_queue rows ── */
  await enrollApprovedForCampaign(campaign, result);

  /* ── Phase 4: DISPATCH due email steps ─────────────────────────────── */
  try {
    const channels = (campaign.channelsEnabled ?? {}) as Record<string, boolean>;
    const emailEnabled = channels.email !== false; // null/undefined ⇒ enabled

    // Respect dailySendCap — count sends already made today for this campaign.
    //
    // "Today" is the UTC day, computed here rather than in SQL. This used to be
    // `DATE(executedAt) = CURDATE()`, which resolves in the DATABASE SERVER's
    // timezone — a setting nothing in this app pins (`drizzle(DATABASE_URL)`
    // passes no timezone). Every other send budget in the codebase uses
    // `todayUtc()`, so on a non-UTC database the campaign cap and the
    // per-account limits would roll over at different hours and disagree about
    // which sends counted. Whether that bites depends on a server setting no
    // one here controls, which is not a property a spend limit should have.
    //
    // A range comparison is also sargable: `DATE(col) = …` wraps the column in
    // a function and cannot use an index, so the old form scanned every row for
    // the campaign on every tick.
    const startOfUtcDay = new Date();
    startOfUtcDay.setUTCHours(0, 0, 0, 0);
    const [sentToday] = await db
      .select({ n: sql<number>`count(*)` })
      .from(areExecutionQueue)
      .where(
        and(
          eq(areExecutionQueue.campaignId, campId),
          eq(areExecutionQueue.status, "sent"),
          gte(areExecutionQueue.executedAt, startOfUtcDay),
        ),
      );
    const remaining = Math.max(0, campaign.dailySendCap - Number(sentToday?.n ?? 0));

    if (remaining > 0) {
      // Self-heal: a step that failed ONLY because the prospect had no email
      // yet becomes schedulable again once enrichment resolves an address —
      // otherwise the whole sequence sits dormant until its next step's day
      // arrives, even though the prospect is now reachable.
      try {
        const healable = await db
          .select({ id: areExecutionQueue.id, prospectQueueId: areExecutionQueue.prospectQueueId })
          .from(areExecutionQueue)
          .innerJoin(prospectQueue, eq(areExecutionQueue.prospectQueueId, prospectQueue.id))
          .where(
            and(
              eq(areExecutionQueue.campaignId, campId),
              eq(areExecutionQueue.workspaceId, wsId),
              eq(areExecutionQueue.status, "failed"),
              // Two retryable failure classes: (a) the prospect had no email
              // at send time but enrichment has since resolved one, and
              // (b) the pool send itself failed (SMTP/TLS/infra) — a fact
              // about the moment or a since-fixed account config, not about
              // the prospect. Retries are harmless: only SENT steps count
              // against the daily cap, and a still-broken account simply
              // re-fails the same bounded batch next tick.
              or(
                eq(areExecutionQueue.failureReason, HEALABLE_NO_EMAIL),
                like(areExecutionQueue.failureReason, `${HEALABLE_POOL_PREFIX}%`),
              ),
              isNotNull(prospectQueue.email),
              /**
               * "enrolled" — the normal case — OR "completed" with ZERO sent
               * steps. The second arm is the lockout repair: sequences whose
               * every step died unreachably were marked completed (see
               * sequenceCompletionVerdict for the 2026-08-08 incident), which
               * put them beyond this heal exactly when enrichment found their
               * emails. Zero-sent is the guard that matters: a sequence that
               * ever SENT anything genuinely ran and stays finished — this
               * arm can only revive sequences that never started.
               */
              or(
                eq(prospectQueue.sequenceStatus, "enrolled"),
                and(
                  eq(prospectQueue.sequenceStatus, "completed"),
                  sql`NOT EXISTS (SELECT 1 FROM \`are_execution_queue\` AS sent_probe WHERE sent_probe.\`prospectQueueId\` = ${prospectQueue.id} AND sent_probe.\`status\` = 'sent')`,
                ),
              ),
            ),
          );
        if (healable.length > 0) {
          await db
            .update(areExecutionQueue)
            .set({ status: "scheduled", failureReason: null, executedAt: null })
            .where(inArray(areExecutionQueue.id, healable.map((h) => h.id)));
          // Revive the completed prospects the steps belong to, or the
          // completion sweep (which only scans "enrolled") never re-evaluates
          // them and the re-scheduled steps dispatch under a lying status.
          const revivedIds = Array.from(new Set(healable.map((h) => h.prospectQueueId)));
          const revived = await db
            .update(prospectQueue)
            .set({ sequenceStatus: "enrolled" })
            .where(and(
              inArray(prospectQueue.id, revivedIds),
              eq(prospectQueue.sequenceStatus, "completed"),
            ));
          void revived;
          await emitLog(wsId, campId, "dispatch", "info",
            `Re-scheduled ${healable.length} failed step(s) (email resolved or send infra recovered)`);
        }

        /**
         * The same heal for LinkedIn steps (2026-08-15). A step that failed
         * only because the prospect had no LinkedIn URL becomes schedulable
         * once enrichment finds one — and enrichment adds them continuously,
         * so without this the step dies permanently on a fact that stopped
         * being true.
         *
         * Separate from the email heal above because its predicate is
         * different: that one requires an email address, this one a LinkedIn
         * profile. One query with both would revive each on the other's
         * evidence.
         */
        const linkedinHealable = await db
          .select({ id: areExecutionQueue.id, prospectQueueId: areExecutionQueue.prospectQueueId })
          .from(areExecutionQueue)
          .innerJoin(prospectQueue, eq(areExecutionQueue.prospectQueueId, prospectQueue.id))
          .where(and(
            eq(areExecutionQueue.campaignId, campId),
            eq(areExecutionQueue.workspaceId, wsId),
            eq(areExecutionQueue.status, "failed"),
            eq(areExecutionQueue.channel, "linkedin"),
            eq(areExecutionQueue.failureReason, HEALABLE_NO_LINKEDIN),
            isNotNull(prospectQueue.linkedinUrl),
          ));
        if (linkedinHealable.length > 0) {
          await db
            .update(areExecutionQueue)
            .set({ status: "scheduled", failureReason: null, executedAt: null })
            .where(inArray(areExecutionQueue.id, linkedinHealable.map((h) => h.id)));
          await emitLog(wsId, campId, "dispatch", "info",
            `Re-scheduled ${linkedinHealable.length} LinkedIn step(s) (profile URL resolved)`);
        }
      } catch (e) {
        console.error(`[AreEngine] campaign ${campId} step heal failed:`, e);
      }

      const due = await db
        .select()
        .from(areExecutionQueue)
        .where(
          and(
            eq(areExecutionQueue.campaignId, campId),
            eq(areExecutionQueue.workspaceId, wsId),
            eq(areExecutionQueue.status, "scheduled"),
            lte(areExecutionQueue.scheduledAt, new Date()),
          ),
        )
        .orderBy(areExecutionQueue.scheduledAt)
        .limit(remaining);

      // Resolved lazily on the first email step, then reused for the batch.
      let bookingUrl: string | undefined;
      /**
       * Set once a LinkedIn step is refused for a reason every other LinkedIn
       * step this tick would share — throttled by the activity gate, or no
       * account connected. Re-asking once per queued step would spend three
       * queries each to be told the same thing.
       */
      let linkedinHeld: string | null = null;

      for (const step of due) {
        /**
         * LINKEDIN (wired 2026-08-15). Previously every non-email step was
         * skipped with "not wired" — on campaign 13 that was 57 of 126 steps,
         * so a multi-channel cadence silently ran as email-only.
         *
         * Safe to wire now ONLY because the activity gate exists (migration
         * 0167): adding a second automated source of LinkedIn activity to an
         * account that already runs Social Autopilot, with no shared budget
         * between them, is how accounts get restricted.
         */
        if (step.channel === "linkedin") {
          if (!channels.linkedin) {
            await db
              .update(areExecutionQueue)
              .set({
                status: "skipped",
                failureReason: "LinkedIn channel disabled on campaign",
                executedAt: new Date(),
              })
              .where(eq(areExecutionQueue.id, step.id));
            continue;
          }
          if (linkedinHeld) continue; // already established for this tick

          const [lp] = await db
            .select()
            .from(prospectQueue)
            .where(eq(prospectQueue.id, step.prospectQueueId))
            .limit(1);
          if (!lp) {
            await db
              .update(areExecutionQueue)
              .set({ status: "failed", failureReason: "Prospect not found", executedAt: new Date() })
              .where(eq(areExecutionQueue.id, step.id));
            continue;
          }
          if (lp.sequenceStatus !== "enrolled") {
            await db
              .update(areExecutionQueue)
              .set({
                status: "skipped",
                failureReason: `Prospect no longer enrolled (status: ${lp.sequenceStatus})`,
                executedAt: new Date(),
              })
              .where(eq(areExecutionQueue.id, step.id));
            continue;
          }

          const lmc = (step.messageContent ?? {}) as { body?: string };
          const outcome = await dispatchLinkedInStep({
            workspaceId: wsId,
            campaignId: campId,
            campaignOwnerUserId: campaign.ownerUserId ?? null,
            prospect: lp,
            body: applyMerge(lmc.body ?? "", lp),
            stepIndex: step.stepIndex ?? 0,
          });

          if (outcome.kind === "deferred") {
            // Row stays SCHEDULED — this is a wait, not a failure.
            if (outcome.stopChannel) {
              linkedinHeld = outcome.reason;
              await emitLog(wsId, campId, "dispatch", "info", `LinkedIn steps held: ${outcome.reason}`);
            }
            continue;
          }
          await db
            .update(areExecutionQueue)
            .set(
              outcome.kind === "sent"
                ? { status: "sent", executedAt: new Date(), failureReason: null }
                : { status: outcome.kind === "skipped" ? "skipped" : "failed", failureReason: outcome.reason, executedAt: new Date() },
            )
            .where(eq(areExecutionQueue.id, step.id));
          if (outcome.kind === "sent") {
            result.sent++;
            await emitLog(wsId, campId, "dispatch", "info",
              `LinkedIn ${outcome.via} sent to ${lp.firstName ?? ""} ${lp.lastName ?? ""}`.trim());
          }
          continue;
        }

        // Channels still unwired (sms, voice) — skip cleanly so they never
        // block the queue.
        if (step.channel !== "email") {
          await db
            .update(areExecutionQueue)
            .set({
              status: "skipped",
              failureReason: `Channel '${step.channel}' not wired — the ARE engine sends email and LinkedIn`,
              executedAt: new Date(),
            })
            .where(eq(areExecutionQueue.id, step.id));
          continue;
        }
        if (!emailEnabled) {
          await db
            .update(areExecutionQueue)
            .set({
              status: "skipped",
              failureReason: "Email channel disabled on campaign",
              executedAt: new Date(),
            })
            .where(eq(areExecutionQueue.id, step.id));
          continue;
        }

        const [p] = await db
          .select()
          .from(prospectQueue)
          .where(eq(prospectQueue.id, step.prospectQueueId))
          .limit(1);
        if (!p) {
          await db
            .update(areExecutionQueue)
            .set({ status: "failed", failureReason: "Prospect not found", executedAt: new Date() })
            .where(eq(areExecutionQueue.id, step.id));
          continue;
        }
        // Prospect replied / was skipped / completed → stop the sequence.
        if (p.sequenceStatus !== "enrolled") {
          await db
            .update(areExecutionQueue)
            .set({
              status: "skipped",
              failureReason: `Prospect no longer enrolled (status: ${p.sequenceStatus})`,
              executedAt: new Date(),
            })
            .where(eq(areExecutionQueue.id, step.id));
          continue;
        }
        if (!p.email) {
          await db
            .update(areExecutionQueue)
            .set({ status: "failed", failureReason: HEALABLE_NO_EMAIL, executedAt: new Date() })
            .where(eq(areExecutionQueue.id, step.id));
          continue;
        }
        // Suppression re-check at send time (may have been added since enroll).
        const [supp] = await db
          .select({ n: sql<number>`count(*)` })
          .from(areSuppressionList)
          .where(
            and(
              eq(areSuppressionList.workspaceId, wsId),
              eq(areSuppressionList.email, p.email),
            ),
          );
        if (Number(supp?.n ?? 0) > 0) {
          await db
            .update(areExecutionQueue)
            .set({ status: "skipped", failureReason: "On suppression list", executedAt: new Date() })
            .where(eq(areExecutionQueue.id, step.id));
          continue;
        }

        const mc = (step.messageContent ?? {}) as { subject?: string; body?: string };
        // The owner's booking link, so a {{bookingLink}} CTA lets the prospect
        // self-book from fully-autonomous ARE outreach. Resolved once per campaign.
        if (bookingUrl === undefined) bookingUrl = await resolveBookingUrl(wsId, campaign.ownerUserId);
        const subject = applyMerge(mc.subject || `A quick note for ${p.firstName ?? "you"}`, p);
        const body = applyMerge(mc.body ?? "", p, bookingUrl);
        // Send through the workspace sender POOL (rotates across connected
        // accounts, per-account daily-limit enforced) — better cold-outreach
        // deliverability than blasting one address. Falls back to the single
        // Email-Delivery config when no sending accounts exist.
        // Open tracking (migration 0129). A per-SEND token means an open
        // resolves to this exact campaign + step + variant, which is what the
        // A/B and step metrics need — a per-prospect token could not.
        const trackingToken = randomUUID().replace(/-/g, "");
        // The ONE public origin (server/appUrl.ts). This used to read
        // VITE_OAUTH_PORTAL_URL — the identity provider — so every pixel we
        // sent pointed at manus.im and recorded nothing.
        const appBaseUrl = publicAppOrigin();
        // Open pixel only — links are NOT click-wrapped here. Cold outbound is
        // deliverability-sensitive and rewriting every URL to a tracking domain
        // is a well-known spam signal; the open pixel is the cheaper trade.
        // Rich-editor step bodies are HTML fragments and pass through as
        // markup; AI-generated plain text keeps the escape+linkify contract
        // (shared/emailBody decides, same as every other send path).
        const bodyIsHtml = isHtmlBody(body);
        const html = injectTracking(
          bodyIsHtml ? `<!DOCTYPE html><html><body>${body}</body></html>` : textToHtml(body),
          trackingToken,
          appBaseUrl,
          {
            open: true,
            click: false,
          },
        );

        /**
         * CLAIM THE ROW BEFORE SENDING — this is cold outbound, so a duplicate
         * is a reputation cost, not an inconvenience.
         *
         * The status used to be written only AFTER the send returned. If that
         * write failed (connection blip, deadlock) the mail was already gone
         * while the row stayed `scheduled`, and the next dispatch tick picked
         * it up and emailed the same prospect again. The surrounding try/catch
         * aborts the whole dispatch loop on such an error, so the row was
         * guaranteed to still be pending.
         *
         * Pre-marking as `failed` with a reason that is deliberately NOT one of
         * the two auto-healable ones ("Prospect has no email address" / "Pool
         * send failed:…") means an interrupted send settles as a visible
         * failure nobody retries automatically, rather than as a silent resend.
         * A clean failure below overwrites this with the real reason, which IS
         * healable, so genuine retries keep working exactly as before.
         */
        await db
          .update(areExecutionQueue)
          .set({
            status: "failed",
            failureReason: "Dispatch interrupted — send state unknown",
            executedAt: new Date(),
          })
          .where(eq(areExecutionQueue.id, step.id));

        const sendRes = await sendCampaignEmailViaPool(wsId, {
          to: p.email,
          subject,
          html,
          text: bodyIsHtml ? htmlBodyToText(body) : body,
          // What puts this send on the Emails page as campaign mail, named,
          // and linked back to its campaign, step and prospect (migration
          // 0163). Campaign mail used to be recorded ONLY on the execution
          // queue row, so the Emails page — which read email_drafts — showed
          // none of it.
          logMeta: {
            source: "campaign",
            sourceLabel: campaign.name ?? null,
            campaignId: campId,
            prospectQueueId: p.id,
            executionQueueId: step.id,
          },
        });
        if (sendRes.ok) {
          await db
            .update(areExecutionQueue)
            .set({
              status: "sent",
              executedAt: new Date(),
              trackingToken,
              // CLEAR the pre-mark's reason. Without this every successfully
              // sent row keeps "Dispatch interrupted — send state unknown"
              // forever beside status='sent' — a contradiction that stayed
              // invisible only because the ARE tabs read `status` and nothing
              // read `failureReason` on a sent row. The Emails page does, and
              // showed "send state unknown" on a message with three recorded
              // opens (owner report 2026-08-14).
              failureReason: null,
              // WHICH MAILBOX SENT IT (migration 0166). The pool has always
              // returned this and it was always discarded, so "Sent from" was
              // blank on every campaign message and nothing could say which
              // inbox a prospect had heard from.
              sendingAccountId: sendRes.accountId ?? null,
              fromEmail: sendRes.fromEmail ?? null,
            })
            .where(eq(areExecutionQueue.id, step.id));
          result.sent++;
        } else {
          await db
            .update(areExecutionQueue)
            .set({
              status: "failed",
              failureReason: sendRes.reason ?? "send failed",
              executedAt: new Date(),
            })
            .where(eq(areExecutionQueue.id, step.id));
        }
      }
    }
    await emitLog(wsId, campId, "dispatch", "info",
      `Dispatched (sent so far this tick: ${result.sent}, daily remaining cap: ${remaining})`);
  } catch (e) {
    console.error(`[AreEngine] campaign ${campId} dispatch phase failed:`, e);
    await emitLog(wsId, campId, "dispatch", "error", String((e as Error)?.message ?? e));
  }

  /* ── Phase 5: COMPLETE — mark prospects whose every step is actioned ─ */
  try {
    const enrolledProspects = await db
      .select({ id: prospectQueue.id })
      .from(prospectQueue)
      .where(
        and(
          eq(prospectQueue.campaignId, campId),
          eq(prospectQueue.workspaceId, wsId),
          eq(prospectQueue.sequenceStatus, "enrolled"),
        ),
      );
    for (const p of enrolledProspects) {
      // One aggregated read instead of two counts — and the two extra facts
      // (sent, healable-failed) are what the completion decision was missing
      // when it marked zero-send sequences finished and disarmed the heal.
      const [c] = await db
        .select({
          total: sql<number>`count(*)`,
          stillScheduled: sql<number>`sum(case when ${areExecutionQueue.status} = 'scheduled' then 1 else 0 end)`,
          sent: sql<number>`sum(case when ${areExecutionQueue.status} = 'sent' then 1 else 0 end)`,
          // HEALABLE_NO_LINKEDIN joins the two email reasons here (2026-08-15).
          // The completion sweep and the heal must agree on what "revivable"
          // means — them disagreeing is exactly how the 08-08 lockout happened,
          // where sequences were marked complete while still healable and so
          // put beyond the heal that would have revived them.
          healableFailed: sql<number>`sum(case when ${areExecutionQueue.status} = 'failed' and (${areExecutionQueue.failureReason} = ${HEALABLE_NO_EMAIL} or ${areExecutionQueue.failureReason} = ${HEALABLE_NO_LINKEDIN} or ${areExecutionQueue.failureReason} like ${`${HEALABLE_POOL_PREFIX}%`}) then 1 else 0 end)`,
          skipped: sql<number>`sum(case when ${areExecutionQueue.status} = 'skipped' then 1 else 0 end)`,
        })
        .from(areExecutionQueue)
        .where(eq(areExecutionQueue.prospectQueueId, p.id));
      const verdict = sequenceCompletionVerdict({
        total: Number(c?.total ?? 0),
        stillScheduled: Number(c?.stillScheduled ?? 0),
        sent: Number(c?.sent ?? 0),
        healableFailed: Number(c?.healableFailed ?? 0),
        skipped: Number(c?.skipped ?? 0),
      });
      if (verdict === "completed") {
        await db
          .update(prospectQueue)
          .set({ sequenceStatus: "completed" })
          .where(eq(prospectQueue.id, p.id));
      } else if (verdict === "abandoned") {
        // Cut short, not carried through. `canceled` is the honest status
        // (the steps WERE canceled) and it keeps the prospect visible as one
        // that needs re-enrolling, instead of hiding inside a healthy-looking
        // "completed" count. Reason recorded so the row can say why.
        await db
          .update(prospectQueue)
          .set({
            sequenceStatus: "canceled",
            rejectedAt: new Date(),
            rejectionReason: `Sequence cut short: ${Number(c?.skipped ?? 0)} of ${Number(c?.total ?? 0)} steps skipped, ${Number(c?.sent ?? 0)} sent — re-approve to re-enrol`,
          })
          .where(eq(prospectQueue.id, p.id));
        result.canceled = (result.canceled ?? 0) + 1;
      }
    }
  } catch (e) {
    console.error(`[AreEngine] campaign ${campId} complete phase failed:`, e);
  }

  /* ── Phase 6: COUNTERS — recompute the campaign funnel ─────────────── */
  try {
    const [agg] = await db
      .select({
        total: sql<number>`count(*)`,
        enriched: sql<number>`sum(case when ${prospectQueue.enrichmentStatus} = 'complete' then 1 else 0 end)`,
        approved: sql<number>`sum(case when ${prospectQueue.sequenceStatus} in ('approved','enrolled','completed','replied') then 1 else 0 end)`,
        enrolled: sql<number>`sum(case when ${prospectQueue.sequenceStatus} in ('enrolled','completed','replied') then 1 else 0 end)`,
        replied: sql<number>`sum(case when ${prospectQueue.sequenceStatus} = 'replied' then 1 else 0 end)`,
      })
      .from(prospectQueue)
      .where(and(eq(prospectQueue.campaignId, campId), eq(prospectQueue.workspaceId, wsId)));
    const [contacted] = await db
      .select({ n: sql<number>`count(distinct ${areExecutionQueue.prospectQueueId})` })
      .from(areExecutionQueue)
      .where(
        and(
          eq(areExecutionQueue.campaignId, campId),
          eq(areExecutionQueue.status, "sent"),
        ),
      );
    // Only the funnel counters this engine owns are recomputed; meetingsBooked
    // and opportunitiesCreated are incremented by the Signal Feedback Agent.
    await db
      .update(areCampaigns)
      .set({
        prospectsDiscovered: Number(agg?.total ?? 0),
        prospectsEnriched: Number(agg?.enriched ?? 0),
        prospectsApproved: Number(agg?.approved ?? 0),
        prospectsEnrolled: Number(agg?.enrolled ?? 0),
        prospectsContacted: Number(contacted?.n ?? 0),
        prospectsReplied: Number(agg?.replied ?? 0),
      })
      .where(eq(areCampaigns.id, campId));
  } catch (e) {
    console.error(`[AreEngine] campaign ${campId} counter phase failed:`, e);
  }

  /* ── Phase 7: DISCOVERY — replenish a fully drained queue ──────────── */
  try {
    const [counts] = await db
      .select({
        total: sql<number>`count(*)`,
        pending: sql<number>`sum(case when ${prospectQueue.enrichmentStatus} = 'pending' then 1 else 0 end)`,
      })
      .from(prospectQueue)
      .where(and(eq(prospectQueue.campaignId, campId), eq(prospectQueue.workspaceId, wsId)));
    const total = Number(counts?.total ?? 0);
    // Continuous discovery: run every tick while we're below target. The
    // scraper sources are bounded per call and the engine itself is bounded
    // per tick, so this can't blow up cost. Earlier we gated on
    // pendingCount===0 which stalled new prospects whenever even one row was
    // still enriching — that made the engine appear "idle" for hours.
    if (total < campaign.targetProspectCount) {
      // runDiscovery emits its own detailed per-source summary log.
      result.discovered += await runDiscovery(campaign);
    } else {
      await emitLog(wsId, campId, "discovery", "info",
        `Discovery skipped — queue full (${total}/${campaign.targetProspectCount})`);
    }
  } catch (e) {
    console.error(`[AreEngine] campaign ${campId} discovery phase failed:`, e);
    await emitLog(wsId, campId, "discovery", "error", String((e as Error)?.message ?? e));
  }
}

/* ─── Discovery — scrape one source to top up a drained campaign ────────── */
async function runDiscovery(campaign: Campaign): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  // Per-campaign targeting from the wizard takes precedence; fall back to
  // the workspace's active ICP for any field left blank.
  const overrides = (campaign.icpOverrides ?? {}) as {
    targetTitles?: string[];
    targetIndustries?: string[];
    targetGeographies?: string[];
    employeeMin?: number;
    employeeMax?: number;
    keywords?: string[];
  };
  const [icp] = await db
    .select()
    .from(icpProfiles)
    .where(
      and(
        eq(icpProfiles.workspaceId, campaign.workspaceId),
        eq(icpProfiles.isActive, true),
      ),
    )
    .limit(1);
  const titles =
    (overrides.targetTitles && overrides.targetTitles.length > 0
      ? overrides.targetTitles
      : (icp?.targetTitles as string[] | null) ?? []) as string[];
  const industries =
    (overrides.targetIndustries && overrides.targetIndustries.length > 0
      ? overrides.targetIndustries
      : (icp?.targetIndustries as string[] | null) ?? []) as string[];
  const geos =
    (overrides.targetGeographies && overrides.targetGeographies.length > 0
      ? overrides.targetGeographies
      : (icp?.targetGeographies as string[] | null) ?? []) as string[];
  const keywords = overrides.keywords ?? [];
  const sizeHint =
    overrides.employeeMin || overrides.employeeMax
      ? `${overrides.employeeMin ?? 1}-${overrides.employeeMax ?? "5000+"} employees`
      : "";

  // ── Query slice fan-out ───────────────────────────────────────────
  // Old behaviour: build ONE query from titles[0]+industries[0]+geos[0]
  // +keywords[0] and run it every tick forever — the engine kept
  // hitting the same top-of-funnel results.
  //
  // New behaviour: enumerate the Cartesian product of (title × industry
  // × geo × keyword?), capped at MAX_SLICES. Each slice is identified
  // by a stable hash. The campaign's discoveryQueryState JSON tracks
  // lastSearchedAt and lastNewCount per slice. Every tick the engine
  // picks the STALEST slice (null first, then oldest) so over time it
  // covers the full ICP grid without increasing per-tick API spend.
  const targetingSlices = buildQuerySlices({ titles, industries, geos, keywords, sizeHint });
  if (targetingSlices.length === 0) {
    await emitLog(campaign.workspaceId, campaign.id, "discovery", "warn",
      "Discovery skipped — campaign has no targeting (titles/industries/geos/keywords). Open the campaign and add targets, or apply a Persona.");
    return 0;
  }
  // The campaign wizard's Targeting step is optional; when it was left blank
  // discovery silently inherits the WORKSPACE ICP, which can search for a
  // completely different audience than the campaign's name suggests. Say so
  // loudly in the logs instead of letting the user wonder why "NonProfit
  // Executives" is hunting for healthcare practice managers.
  const hasOwnTargeting =
    (overrides.targetTitles?.length ?? 0) > 0 ||
    (overrides.targetIndustries?.length ?? 0) > 0 ||
    (overrides.targetGeographies?.length ?? 0) > 0 ||
    (overrides.keywords?.length ?? 0) > 0;
  if (!hasOwnTargeting) {
    await emitLog(campaign.workspaceId, campaign.id, "discovery", "warn",
      `Campaign has no targeting of its own — discovery is using the workspace ICP profile instead (titles: ${titles.slice(0, 3).join(", ") || "—"}; industries: ${industries.slice(0, 3).join(", ") || "—"}). If that's not this campaign's audience, add Targeting to the campaign or apply a Persona.`);
  }

  // Merge with persisted state so we know which slice to run next.
  const persistedState =
    (campaign as { discoveryQueryState?: { slices?: Array<{ id: string; q: string; lastSearchedAt?: number | null; lastNewCount?: number | null }> } | null }).discoveryQueryState
    ?? { slices: [] };
  const stateById = new Map<string, { id: string; q: string; lastSearchedAt: number | null; lastNewCount: number | null }>();
  for (const s of persistedState.slices ?? []) {
    stateById.set(s.id, { id: s.id, q: s.q, lastSearchedAt: s.lastSearchedAt ?? null, lastNewCount: s.lastNewCount ?? null });
  }
  // Ensure every current slice has a row; drop persisted rows that no
  // longer match the targeting (ICP edits invalidate stale slice IDs).
  const liveSliceIds = new Set(targetingSlices.map((s) => s.id));
  for (const id of Array.from(stateById.keys())) {
    if (!liveSliceIds.has(id)) stateById.delete(id);
  }
  for (const s of targetingSlices) {
    if (!stateById.has(s.id)) stateById.set(s.id, { id: s.id, q: s.q, lastSearchedAt: null, lastNewCount: null });
  }

  // Pick the stalest slice (null lastSearchedAt first, then oldest).
  const ordered = Array.from(stateById.values()).sort((a, b) => {
    const aTs = a.lastSearchedAt ?? 0;
    const bTs = b.lastSearchedAt ?? 0;
    return aTs - bTs;
  });
  const slice = ordered[0];
  const query = slice.q;

  const icpContext =
    `Industries: ${industries.join(", ")}; ` +
    `Titles: ${titles.join(", ")}; ` +
    `Geographies: ${geos.join(", ")}` +
    (keywords.length > 0 ? `; Keywords: ${keywords.join(", ")}` : "") +
    (sizeHint ? `; Company size: ${sizeHint}` : "");

  // Multi-source discovery: every configured scraper-capable source runs
  // in parallel (Promise.allSettled — one source failing never blocks the
  // others). Results are deduped both within this tick and against
  // existing prospect_queue rows so cross-source overlap doesn't create
  // duplicate prospects. Each source still gets its own scrape_jobs
  // row so the Scraper tab shows per-source activity.
  // Campaigns created before the vocabulary was unified may carry dead ids
  // ('ai_research', 'events') or null. normalizeSources strips the dead ones;
  // a campaign with nothing left falls back to the full default set rather
  // than the old lone "linkedin" guess.
  const configured = normalizeSources(campaign.prospectSources);
  const sources: string[] = configured.length > 0 ? configured : [...ARE_DEFAULT_SOURCES];

  // Seed the dedup index with everything already in the queue for the WHOLE
  // workspace, remembering which campaign owns each identity. Two jobs in
  // one pass: same-campaign dedup (keeps subsequent ticks from re-adding the
  // same people — the original behavior) and CAMPAIGN EXCLUSIVITY (owner
  // directive 2026-08-12: a prospect may belong to only one ARE campaign, so
  // a person already claimed by a sibling campaign is never added here).
  const existing = await db
    .select({
      campaignId: prospectQueue.campaignId,
      email: prospectQueue.email,
      linkedinUrl: prospectQueue.linkedinUrl,
      firstName: prospectQueue.firstName,
      lastName: prospectQueue.lastName,
      companyDomain: prospectQueue.companyDomain,
      companyName: prospectQueue.companyName,
    })
    .from(prospectQueue)
    .where(eq(prospectQueue.workspaceId, campaign.workspaceId))
    .orderBy(prospectQueue.id);
  const claimed = new Map<string, number | null>();
  for (const e of existing) {
    for (const k of queueIdentityKeys(e)) {
      if (!claimed.has(k)) claimed.set(k, e.campaignId);
    }
  }
  let excludedOtherCampaign = 0;

  type SourceType =
    | "google_business"
    | "linkedin_people"
    | "news"
    | "web_scrape"
    | "internal"
    | "apollo"
    | "quickenrich";
  type SourceResult = {
    sourceType: SourceType;
    query: string;
    raw: Array<Record<string, unknown>>;
  };

  const tasks: Array<Promise<SourceResult>> = [];
  if (sources.includes("internal")) {
    tasks.push(
      discoverViaInternalCrm(campaign, titles).then((raw) => ({
        sourceType: "internal" as const,
        query,
        raw,
      })),
    );
  }
  if (sources.includes("linkedin")) {
    tasks.push(
      discoverViaLinkedIn(campaign, query).then((raw) => ({
        sourceType: "linkedin_people" as const,
        query,
        raw,
      })),
    );
  }
  if (sources.includes("apollo")) {
    tasks.push(
      discoverViaApollo(campaign, { titles, industries, geos, keywords, overrides }).then((raw) => ({
        sourceType: "apollo" as const,
        query,
        raw,
      })),
    );
  }
  if (sources.includes("quickenrich")) {
    tasks.push(
      discoverViaQuickenrich(campaign, { titles, industries, geos }).then((raw) => ({
        sourceType: "quickenrich" as const,
        query,
        raw,
      })),
    );
  }
  if (sources.includes("google_business")) {
    tasks.push(
      scrapeGoogleBusiness(campaign.workspaceId, campaign.id, query, icpContext).then(
        (raw) => ({ sourceType: "google_business" as const, query, raw }),
      ),
    );
  }
  if (sources.includes("news")) {
    tasks.push(
      scrapeNews(campaign.workspaceId, campaign.id, query, icpContext).then((raw) => ({
        sourceType: "news" as const,
        query,
        raw,
      })),
    );
  }
  if (sources.includes("web")) {
    tasks.push(
      scrapeWeb(campaign.workspaceId, campaign.id, query, icpContext).then((raw) => ({
        sourceType: "web_scrape" as const,
        query,
        raw,
      })),
    );
  }

  if (tasks.length === 0) {
    await emitLog(campaign.workspaceId, campaign.id, "discovery", "warn",
      `Discovery skipped — no usable sources configured (campaign.prospectSources=${JSON.stringify(sources)})`);
    return 0;
  }

  const settled = await Promise.allSettled(tasks);
  let totalNew = 0;
  const perSource: Record<string, { raw: number; new: number; error?: string }> = {};
  for (const s of settled) {
    if (s.status !== "fulfilled") {
      console.error(`[AreEngine] discovery source failed for campaign ${campaign.id}:`, s.reason);
      const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
      perSource["unknown"] = { raw: 0, new: 0, error: reason };
      await emitLog(campaign.workspaceId, campaign.id, "discovery", "error",
        `Discovery source failed: ${reason}`, errorDetails(s.reason));
      continue;
    }
    const { sourceType, query: q, raw } = s.value;
    // Within-tick + cross-tick dedup AND cross-campaign exclusivity, one
    // vocabulary (services/are/queueIdentity).
    const unique = raw.filter((p) => {
      const keys = queueIdentityKeys(p);
      for (const k of keys) {
        const owner = claimed.get(k);
        if (owner !== undefined) {
          if (owner !== campaign.id) excludedOtherCampaign++;
          return false;
        }
      }
      for (const k of keys) claimed.set(k, campaign.id);
      return true;
    });
    // Validate + score before queueing. Drop rows with no anchor at all
    // (neither a company domain nor a title — nothing to enrich or verify),
    // attach a deterministic ICP-match score, and rank highest-fit first so
    // the enrichment/enroll picks at the top of the queue are the best ones.
    const scored = unique
      .filter((p) => String(p.companyDomain ?? "").trim() !== "" || String(p.title ?? "").trim() !== "")
      .map((p) => ({ ...p, icpMatchScore: scoreIcpMatch(p, { titles, industries, geos, keywords }) }))
      .sort((a, b) => (b.icpMatchScore as number) - (a.icpMatchScore as number));
    try {
      await saveScrapeJobAndQueue(campaign.workspaceId, campaign.id, sourceType, q, scored);
      totalNew += scored.length;
      perSource[sourceType] = { raw: raw.length, new: scored.length };
    } catch (e) {
      console.error(`[AreEngine] saveScrapeJobAndQueue (${sourceType}) failed:`, e);
      perSource[sourceType] = { raw: raw.length, new: 0, error: String((e as Error)?.message ?? e) };
      await emitLog(campaign.workspaceId, campaign.id, "discovery", "error",
        `Failed to save ${sourceType} results: ${(e as Error)?.message ?? e}`, errorDetails(e));
    }
  }
  if (excludedOtherCampaign > 0) {
    await emitLog(campaign.workspaceId, campaign.id, "discovery", "info",
      `${excludedOtherCampaign} prospect${excludedOtherCampaign === 1 ? "" : "s"} excluded — already active in another campaign in this workspace (one campaign per prospect).`);
  }

  // Persist slice rotation state — bump lastSearchedAt + lastNewCount
  // for the slice we just ran so the next tick picks a different angle.
  const now = Date.now();
  const updatedSlice = stateById.get(slice.id);
  if (updatedSlice) {
    updatedSlice.lastSearchedAt = now;
    updatedSlice.lastNewCount = totalNew;
  }
  const newState = {
    slices: Array.from(stateById.values()),
    updatedAt: now,
  };
  try {
    await db.update(areCampaigns).set({ discoveryQueryState: newState as any })
      .where(eq(areCampaigns.id, campaign.id));
  } catch (e) {
    console.warn(`[AreEngine] failed to persist discoveryQueryState for campaign ${campaign.id}:`, e);
  }

  // One info-level summary log per call carrying the per-source breakdown
  // in `details` — expand the row in the Logs tab to see what each source
  // returned vs how many survived dedup. `sliceId` + `sliceIdx` show
  // which angle of the ICP grid this tick covered.
  const sliceIdx = targetingSlices.findIndex((s) => s.id === slice.id);
  await emitLog(campaign.workspaceId, campaign.id, "discovery", "info",
    `Discovery slice ${sliceIdx + 1}/${targetingSlices.length} "${query}" → ${totalNew} new across ${Object.keys(perSource).length} sources`,
    { query, sliceId: slice.id, sliceIdx: sliceIdx + 1, sliceCount: targetingSlices.length, perSource });
  return totalNew;
}

/* ─── Query slice builder ───────────────────────────────────────────── */

/**
 * Builds the Cartesian product of (title × industry × geo × keyword?)
 * capped at MAX_SLICES (30). Each slice gets a stable hash id so the
 * rotation state survives ICP edits that don't change a given slice.
 *
 * Strategy:
 *   - If keywords are present, include them in the product (multiplies
 *     by keywords.length). Otherwise keyword is omitted from the query.
 *   - sizeHint is appended to every slice (it's a filter, not an axis).
 *   - Build the FULL product (bounded by a safety ceiling), then if it
 *     exceeds MAX_SLICES, stride-sample so the kept slices stay spread
 *     across every axis instead of clustering on titles[0]. The old
 *     "first N" truncation meant combos past slot 30 never ran at all.
 *
 * Returns [] when there's not enough targeting to form a single slice.
 */
function buildQuerySlices(args: {
  titles: string[];
  industries: string[];
  geos: string[];
  keywords: string[];
  sizeHint: string;
}): Array<{ id: string; q: string }> {
  const MAX_SLICES = 120;
  // Safety ceiling on the raw build so a pathological ICP (e.g. 10×10×10×10)
  // can't blow up memory; we stride-sample down to MAX_SLICES afterwards.
  const BUILD_CEILING = MAX_SLICES * 12;
  const ts = args.titles.length > 0 ? args.titles : [""];
  const is = args.industries.length > 0 ? args.industries : [""];
  const gs = args.geos.length > 0 ? args.geos : [""];
  const ks = args.keywords.length > 0 ? args.keywords : [""];
  const all: Array<{ id: string; q: string }> = [];
  outer: for (const t of ts) {
    for (const i of is) {
      for (const g of gs) {
        for (const k of ks) {
          const q = [t, i, g, k, args.sizeHint].map((p) => p?.trim() ?? "").filter((p) => p.length > 0).join(" ").trim();
          if (!q) continue;
          const id = createHash("sha1").update(q).digest("hex").slice(0, 16);
          all.push({ id, q });
          if (all.length >= BUILD_CEILING) break outer;
        }
      }
    }
  }
  if (all.length <= MAX_SLICES) return all;
  // Stride-sample to MAX_SLICES so kept slices interleave across the axes.
  const step = all.length / MAX_SLICES;
  const out: Array<{ id: string; q: string }> = [];
  for (let n = 0; n < MAX_SLICES; n++) {
    out.push(all[Math.floor(n * step)]);
  }
  return out;
}

/**
 * Deterministic 0–100 relevance score of a discovered prospect against the
 * campaign ICP. No LLM — pure string matching on title/industry/geo/keywords
 * plus B2B anchor bonuses (company domain, having a title at all). Used to
 * rank within a tick and to gate enrichment (campaign.minConfidence).
 */
function scoreIcpMatch(
  p: Record<string, unknown>,
  icp: { titles: string[]; industries: string[]; geos: string[]; keywords: string[] },
): number {
  const norm = (s: unknown) => String(s ?? "").toLowerCase().trim();
  const title = norm(p.title);
  const industry = norm(p.industry);
  const geo = norm(p.geography);
  const company = norm(p.companyName);
  const domain = norm(p.companyDomain);
  const hay = `${title} ${industry} ${geo} ${company}`;
  let score = 0;
  // Title / seniority match (the strongest signal).
  if (icp.titles.length > 0) {
    const full = icp.titles.some((t) => { const tt = norm(t); return tt && title.includes(tt); });
    const token = !full && icp.titles.some((t) => norm(t).split(/\s+/).some((tok) => tok.length > 2 && title.includes(tok)));
    score += full ? 35 : token ? 18 : 0;
  } else {
    score += title ? 10 : 0;
  }
  if (icp.industries.length > 0) {
    score += icp.industries.some((i) => { const ii = norm(i); return ii && hay.includes(ii); }) ? 20 : 0;
  }
  if (icp.geos.length > 0) {
    score += icp.geos.some((g) => { const gg = norm(g); return gg && geo.includes(gg); }) ? 15 : 0;
  }
  if (icp.keywords.length > 0) {
    score += icp.keywords.some((k) => { const kk = norm(k); return kk && hay.includes(kk); }) ? 10 : 0;
  }
  if (domain) score += 15; // B2B anchor — enables email pattern lookup
  if (title) score += 5;
  return Math.min(100, score);
}

/* nameOrgDedupKey moved to services/are/queueIdentity.ts (2026-08-12): the
   dedup and the campaign-exclusivity check must share ONE identity
   vocabulary, and two copies of a normalization rule is how they stop
   agreeing. */

/**
 * Apollo.io discovery — structured people search against the campaign's ICP.
 *
 * Unlike the LLM scrapers, Apollo takes the targeting as real filters rather
 * than a flattened query string, so titles/locations/headcount are applied by
 * Apollo rather than hoped for in an extraction prompt.
 *
 * Search-only: zero Apollo credits, and no email comes back. What DOES come
 * back is the company domain, which is precisely the input the enrichment
 * step's resolveVerifiedEmail() needs and never had from LinkedIn. So Apollo
 * finds the person and Velocity's own verifier finds the address.
 *
 * The daily cap is enforced here rather than inside the service so the
 * remaining headroom can shrink the page size instead of dropping the tick.
 */
async function discoverViaApollo(
  campaign: Campaign,
  targeting: {
    titles: string[];
    industries: string[];
    geos: string[];
    keywords: string[];
    overrides: { employeeMin?: number; employeeMax?: number };
  },
): Promise<Array<Record<string, unknown>>> {
  const cap = await getApolloDailyCap(campaign.workspaceId);
  const used = await apolloPulledToday(campaign.workspaceId);
  const headroom = cap - used;
  if (headroom <= 0) {
    await emitLog(campaign.workspaceId, campaign.id, "discovery", "warn",
      `Apollo skipped — daily record cap reached (${used}/${cap}). Raise it in ARE Settings → Apollo.io if you want more per day.`);
    return [];
  }

  const res = await apolloSearchPeople(campaign.workspaceId, {
    titles: targeting.titles,
    industries: targeting.industries,
    locations: targeting.geos,
    keywords: targeting.keywords,
    employeeMin: targeting.overrides.employeeMin,
    employeeMax: targeting.overrides.employeeMax,
    perPage: Math.min(headroom, 25),
  });

  if (!res.ok) {
    await emitLog(campaign.workspaceId, campaign.id, "discovery", "error",
      `Apollo search failed: ${res.error}`);
    return [];
  }

  // Apollo returns no emails on this path by design; the enrich phase resolves
  // them from companyDomain. Say so once per tick so a queue full of
  // email-less prospects doesn't read as a bug.
  const withDomain = res.prospects.filter((p) => p.companyDomain).length;
  await emitLog(campaign.workspaceId, campaign.id, "discovery", "info",
    `Apollo returned ${res.prospects.length} people (${withDomain} with a company domain) from ${res.totalAvailable.toLocaleString()} matches. Emails are resolved during enrichment — Apollo search never includes them.`);

  return res.prospects.map((p) => ({ ...p }));
}

/**
 * QuickEnrich discovery — their FREE contact-finder against the campaign's
 * titles/industries (geos only where they map cleanly to a country code).
 *
 * Discovery costs nothing by the endpoint's design: it returns people with
 * LinkedIn URLs and has_email FLAGS, never addresses. The credit is spent
 * later, per row, by the sweep's QuickEnrich lookup pass — only on delivery,
 * and Reoon-verified before anything is written. has_email rows are taken
 * first, so the daily pull headroom goes to the rows most likely to convert.
 * Measured basis for this source existing at all: ~85% enrichment hit rate on
 * this workspace's ICP, 2026-08-07.
 */
async function discoverViaQuickenrich(
  campaign: Campaign,
  targeting: { titles: string[]; industries: string[]; geos: string[] },
): Promise<Array<Record<string, unknown>>> {
  const apiKey = await getQuickEnrichKey(campaign.workspaceId);
  if (!apiKey) {
    await emitLog(campaign.workspaceId, campaign.id, "discovery", "warn",
      "QuickEnrich skipped — no API key configured (Settings → Data sources).");
    return [];
  }

  const cap = await getQuickenrichDailyPullCap(campaign.workspaceId);
  const used = await quickenrichPulledToday(campaign.workspaceId);
  const headroom = cap - used;
  if (headroom <= 0) {
    await emitLog(campaign.workspaceId, campaign.id, "discovery", "warn",
      `QuickEnrich skipped — daily pull cap reached (${used}/${cap}). Raise it in Settings → Data sources if you want more per day.`);
    return [];
  }

  const { body, unmappedGeos } = buildQuickenrichFilters(targeting);
  if (!body) {
    await emitLog(campaign.workspaceId, campaign.id, "discovery", "warn",
      "QuickEnrich skipped — no target titles or industries configured (refusing to search their entire database).");
    return [];
  }

  const res = await quickenrichContactFinder(apiKey, body);
  if (!res.ok) {
    await emitLog(campaign.workspaceId, campaign.id, "discovery", "error",
      `QuickEnrich search failed: ${res.error}`);
    return [];
  }

  // has_email first: those rows are the ones the paid lookup will convert, so
  // they get the pull headroom before the maybes.
  const ranked = [...res.people].sort((a, b) => Number(b.hasEmail) - Number(a.hasEmail));
  const kept = ranked.slice(0, headroom);
  const withEmailFlag = kept.filter((p) => p.hasEmail).length;

  await emitLog(campaign.workspaceId, campaign.id, "discovery", "info",
    `QuickEnrich returned ${res.people.length} people (kept ${kept.length}, ${withEmailFlag} flagged has_email). `
    + `Emails are resolved during enrichment — discovery is free and never includes them.`
    + (unmappedGeos.length > 0
      ? ` Geo filters not sent (no clean country mapping): ${unmappedGeos.join(", ")}.`
      : ""));

  return kept.map((p) => ({
    firstName: p.firstName,
    lastName: p.lastName,
    title: p.title,
    linkedinUrl: p.linkedinUrl,
    companyName: p.companyName,
    companyDomain: p.companyDomain,
  }));
}

/**
 * Internal CRM discovery — seeds a campaign from people the workspace ALREADY
 * has, instead of only hunting strangers.
 *
 * This source was offered in the wizard for a long time but never implemented:
 * runDiscovery had no 'internal' branch, so ticking "Internal CRM" silently
 * did nothing. The prospect_queue enum already carried internal_contact and
 * internal_lead, so the data model was waiting for it.
 *
 * Matching is deliberately conservative — title LIKE against the campaign's
 * target titles. Contacts and leads are already-known people, so a loose match
 * would flood the queue with the entire CRM. With no target titles configured
 * we return nothing rather than everything, since "every contact you have" is
 * never a sensible campaign audience.
 *
 * Converted and unqualified leads are excluded: they're respectively already
 * customers and already rejected.
 */
async function discoverViaInternalCrm(
  campaign: Campaign,
  titles: string[],
  limit = 50,
): Promise<Array<Record<string, unknown>>> {
  const db = await getDb();
  if (!db) return [];

  const wanted = titles.map((t) => t.trim()).filter(Boolean).slice(0, 12);
  if (wanted.length === 0) {
    console.warn(
      `[AreEngine] campaign ${campaign.id} — internal CRM source skipped: no target titles configured (refusing to enqueue the entire CRM)`,
    );
    return [];
  }

  const out: Array<Record<string, unknown>> = [];

  try {
    const contactRows = await db
      .select({
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        title: contacts.title,
        email: contacts.email,
        phone: contacts.phone,
        linkedinUrl: contacts.linkedinUrl,
        city: contacts.city,
        companyName: contacts.companyName,
        companyDomain: contacts.companyDomain,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.workspaceId, campaign.workspaceId),
          or(...wanted.map((t) => like(contacts.title, `%${t}%`))),
          // Both discards below used to happen AFTER this LIMIT, which is how
          // this source could return its full 50 and contribute nothing —
          // every tick, forever, with thousands of usable contacts behind the
          // window. A LIMIT must be applied to the set the caller can use.
          //
          // (1) Un-actionable: no email AND no company. Discarded by the loop.
          //     This workspace had 1,500+ such rows, so they alone could fill
          //     the page.
          or(
            and(isNotNull(contacts.email), ne(contacts.email, "")),
            and(isNotNull(contacts.companyDomain), ne(contacts.companyDomain, "")),
            and(isNotNull(contacts.companyName), ne(contacts.companyName, "")),
          ),
          // (2) Already queued. Discarded further downstream by the
          //     queueIdentity claim, so it is invisible from in here — but it
          //     spends a slot just the same, and in a mature workspace it is
          //     the LARGER population of the two. Matched on email only: the
          //     claim vocabulary is richer than this (name+company, LinkedIn),
          //     so this narrows the waste rather than eliminating it, and the
          //     claim stays the authority on exclusivity.
          or(
            isNull(contacts.email),
            eq(contacts.email, ""),
            notExists(
              db
                .select({ one: sql`1` })
                .from(prospectQueue)
                .where(and(
                  eq(prospectQueue.workspaceId, campaign.workspaceId),
                  eq(prospectQueue.email, contacts.email),
                )),
            ),
          ),
        ),
      )
      // Newest contacts first. Any stable order beats none, and a CRM's
      // recent additions are the rows least likely to have been queued
      // already — which is the waste this page cannot see.
      .orderBy(desc(contacts.id))
      .limit(limit);

    for (const c of contactRows) {
      // Belt-and-braces: the WHERE above owns this now. Kept because the
      // predicate here is the readable statement of what "actionable" means
      // and the SQL is a translation of it.
      if (!c.email && !c.companyDomain && !c.companyName) continue;
      out.push({
        firstName: c.firstName,
        lastName: c.lastName,
        title: c.title,
        email: c.email,
        phone: c.phone,
        linkedinUrl: c.linkedinUrl,
        companyName: c.companyName,
        companyDomain: c.companyDomain,
        geography: c.city,
        sourceUrl: "",
        __queueSourceType: "internal_contact",
      });
    }
  } catch (e) {
    console.error(`[AreEngine] internal CRM contact scan failed for campaign ${campaign.id}:`, e);
  }

  try {
    const remaining = Math.max(limit - out.length, 0);
    if (remaining > 0) {
      const leadRows = await db
        .select({
          firstName: leads.firstName,
          lastName: leads.lastName,
          title: leads.title,
          email: leads.email,
          phone: leads.phone,
          company: leads.company,
        })
        .from(leads)
        .where(
          and(
            eq(leads.workspaceId, campaign.workspaceId),
            notInArray(leads.status, ["converted", "unqualified"]),
            or(...wanted.map((t) => like(leads.title, `%${t}%`))),
          ),
        )
        // The loop below discards nothing, so this page was never starved the
        // way the contact one was — but an unordered LIMIT still means an
        // arbitrary slice, so which leads a campaign sources is a coin flip.
        // (It CAN still spend slots on already-queued leads; that waste is
        // invisible from here and is not addressed.)
        .orderBy(desc(leads.id))
        .limit(remaining);

      for (const l of leadRows) {
        out.push({
          firstName: l.firstName,
          lastName: l.lastName,
          title: l.title,
          email: l.email,
          phone: l.phone,
          companyName: l.company,
          companyDomain: "",
          geography: "",
          sourceUrl: "",
          __queueSourceType: "internal_lead",
        });
      }
    }
  } catch (e) {
    console.error(`[AreEngine] internal CRM lead scan failed for campaign ${campaign.id}:`, e);
  }

  return out;
}

/**
 * Real LinkedIn discovery for ARE — picks a bridged LinkedIn account from
 * the workspace pool (most headroom first) and runs Unipile's classic
 * people-search, then normalises the raw hits into the prospect-queue shape
 * (same shape the LLM scrapers return so saveScrapeJobAndQueue handles both).
 * Returns [] on any error so the engine can fall through to the next source.
 */
async function discoverViaLinkedIn(
  campaign: Campaign,
  keywords: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const accounts = await listUsableAccounts({
      workspaceId: campaign.workspaceId,
      userId: campaign.ownerUserId ?? 0,
      isAdmin: true, // engine runs without a user; pull from the whole workspace pool
    });
    const acct = accounts.find((a) => a.remainingToday > 0) ?? accounts[0];
    if (!acct) {
      console.warn(
        `[AreEngine] campaign ${campaign.id} — no bridged LinkedIn account in workspace ${campaign.workspaceId}, LinkedIn discovery skipped`,
      );
      await emitLog(campaign.workspaceId, campaign.id, "discovery", "warn",
        "LinkedIn source skipped — no bridged LinkedIn account in this workspace. Connect one in Settings › Social accounts or disable the LinkedIn source on this campaign.");
      return [];
    }
    // 25 is the Unipile wrapper's per-call max (searchLinkedInPeople clamps
    // there). True cursor-based multi-page paging needs Unipile's paging
    // contract confirmed against a live account before we spend daily-cap
    // credits on it — tracked as a follow-up.
    const { items } = await searchLinkedInPeople(acct.unipileAccountId, {
      keywords,
      limit: 25,
    });
    return items
      .map((h: UnipileLinkedInSearchHit) => {
        // LinkedIn display names routinely carry credential suffixes
        // ("Rachele Thomas, BSN, RN, CDAL"). Strip BEFORE splitting,
        // otherwise the last-space split turns credentials into surnames
        // (lastName "CDAL", "Belt", …). Shared stripper: unlike the old
        // first-comma cut it also survives "Doe, Jane" and keeps ", Jr.".
        const stripCreds = (s: string) => stripNameCredentials(s) ?? "";
        let firstName = stripCreds(h.first_name ?? "");
        let lastName = stripCreds(h.last_name ?? "");
        const fullName = stripCreds((h.name ?? `${firstName} ${lastName}`).trim());
        if (!firstName && !lastName && fullName) {
          const sp = fullName.lastIndexOf(" ");
          firstName = sp === -1 ? fullName : fullName.slice(0, sp);
          lastName = sp === -1 ? "" : fullName.slice(sp + 1);
        }
        const c = h.current_company ?? h.company;
        const company = !c ? "" : typeof c === "string" ? c : (c.name ?? "");
        const linkedinUrl =
          h.public_profile_url ??
          h.profile_url ??
          (h.public_identifier
            ? `https://www.linkedin.com/in/${h.public_identifier}`
            : "");
        return {
          firstName,
          lastName,
          title: h.headline ?? h.title ?? "",
          companyName: company,
          linkedinUrl,
          sourceUrl: linkedinUrl,
          geography: h.location ?? "",
          industry: h.industry ?? "",
        } as Record<string, unknown>;
      })
      .filter((p) => String(p.firstName).length > 0);
  } catch (e) {
    console.error(`[AreEngine] LinkedIn discovery for campaign ${campaign.id} failed:`, e);
    return [];
  }
}
