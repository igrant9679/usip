/**
 * ARE Engine — the autonomous orchestrator behind the Autonomous Revenue Engine.
 *
 * Until now the ARE Hub was a UI + data model with no engine: nothing drove
 * prospects through discovery → enrichment → approval → sequencing → send.
 * This module is that engine. It is invoked on a cron from _core/index.ts.
 *
 * Each run first performs a single GLOBAL enrichment pass
 * (enrichPendingGlobally): pending prospects across EVERY campaign — active or
 * paused — are enriched ONE AT A TIME (strictly serial), best-fit first,
 * bounded per cycle. Enrichment is deliberately decoupled from campaign status
 * so dossiers keep building even while a campaign is paused, and serial so it
 * never trips the LLM provider's concurrent-connection limit.
 *
 * Then, for every campaign with status='active', it performs one bounded
 * "tick" through the remaining pipeline phases:
 *
 *   1. SCREEN     — auto-approve / auto-reject enriched prospects per the
 *                   campaign's autonomyMode + autoApproveThreshold.
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
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  areCampaigns,
  areEngineLogs,
  areExecutionQueue,
  areSuppressionList,
  icpProfiles,
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
import { sendWorkspaceEmail, sendCampaignEmailViaPool } from "./emailDelivery";
import { resolveBookingUrl } from "./mergeVars";
import { ARE_DEFAULT_SOURCES, normalizeSources } from "@shared/areSources";

/* ─── Per-tick bounds (keep LLM cost + wall-time predictable) ───────────── */
/** Max prospects enriched per engine cycle. Enrichment runs ONE AT A TIME
 *  (strictly serial) across ALL campaigns regardless of status, so a paused
 *  campaign's prospects still get dossiers and the LLM provider never sees more
 *  than one concurrent enrichment call. Bounded so a large backlog drains
 *  steadily over multiple ticks instead of stalling dispatch for other work. */
const ENRICH_PER_TICK = 5;
const SEQUENCE_PER_TICK = 3;
const ENROLL_PER_TICK = 10;
/** icpMatchScore below this is auto-screened out even in human-approval modes. */
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
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

/** Resolve {{merge tags}} in an outreach body against the real prospect. */
function applyMerge(text: string, p: Prospect, bookingUrl = ""): string {
  return String(text ?? "")
    .replace(/\{\{\s*firstName\s*\}\}/gi, p.firstName ?? "there")
    .replace(/\{\{\s*lastName\s*\}\}/gi, p.lastName ?? "")
    .replace(/\{\{\s*(company|companyName)\s*\}\}/gi, p.companyName ?? "your company")
    .replace(/\{\{\s*title\s*\}\}/gi, p.title ?? "")
    .replace(/\{\{\s*bookingLink\s*\}\}/gi, bookingUrl)
    .replace(/\{\{[^}]+\}\}/g, ""); // strip any unresolved tags
}

/** Plain-text outreach body → minimal HTML for the email send. */
function textToHtml(text: string): string {
  const esc = String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

interface NormalizedStep {
  stepIndex: number;
  channel: "email" | "linkedin" | "sms" | "voice";
  subject: string;
  body: string;
  variantKey: string;
  /** Cumulative day offset from enrollment for scheduling. */
  dayOffset: number;
}

/**
 * Normalise a stored generatedSequence into schedulable steps. Handles both
 * the engine/agent shape ({stepIndex, day, channel, subject, body, variantKey})
 * and the older seed shape ({step, waitDays, channel, subject}).
 */
function normalizeSequence(raw: unknown): NormalizedStep[] {
  if (!Array.isArray(raw)) return [];
  const validChannels = ["email", "linkedin", "sms", "voice"];
  let cumulativeDay = 0;
  return raw.map((s, i) => {
    const step = (s ?? {}) as Record<string, unknown>;
    const ch = String(step.channel ?? "email").toLowerCase();
    const channel = (validChannels.includes(ch) ? ch : "email") as NormalizedStep["channel"];
    // `day` is a cumulative offset; `waitDays` is a gap from the previous step.
    let dayOffset: number;
    if (typeof step.day === "number") {
      dayOffset = step.day;
    } else {
      cumulativeDay += typeof step.waitDays === "number" ? step.waitDays : i === 0 ? 0 : 2;
      dayOffset = cumulativeDay;
    }
    return {
      stepIndex:
        typeof step.stepIndex === "number"
          ? step.stepIndex
          : typeof step.step === "number"
            ? step.step
            : i,
      channel,
      subject: String(step.subject ?? ""),
      body: String(step.body ?? ""),
      variantKey: String(step.variantKey ?? "A"),
      dayOffset: Math.max(0, dayOffset),
    };
  });
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
    // Global, serial, bounded enrichment FIRST — independent of campaign status
    // so paused campaigns' prospects still get dossiers, one LLM call at a time.
    try {
      await enrichPendingGlobally(result);
    } catch (e) {
      console.error("[AreEngine] global enrich pass failed:", e);
    }

    const active = await db
      .select()
      .from(areCampaigns)
      .where(eq(areCampaigns.status, "active"));

    for (const campaign of active) {
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

/* ─── Global enrichment pass (serial, bounded, status-agnostic) ─────────── */
/**
 * Enrich the next batch of pending prospects across EVERY campaign in EVERY
 * workspace — active or paused — ONE AT A TIME. This is intentionally separate
 * from the per-campaign tick (which only runs for active campaigns): a paused
 * campaign should keep building dossiers so the moment it's resumed, screening
 * and sequencing have data to work with.
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
        inArray(prospectQueue.enrichmentStatus, ["pending", "enriching"]),
        sql`(${prospectQueue.icpMatchScore} >= COALESCE(${areCampaigns.minConfidence}, 40) OR ${prospectQueue.icpMatchScore} = 0)`,
      ),
    )
    .orderBy(desc(prospectQueue.icpMatchScore))
    .limit(ENRICH_PER_TICK);

  if (pending.length === 0) return;

  // One enrichment at a time. A single prospect failing must not abort the rest.
  const perCampaign = new Map<number, { ws: number; ok: number; total: number }>();
  for (const p of pending) {
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
async function tickCampaign(campaign: Campaign, result: AreEngineResult): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const wsId = campaign.workspaceId;
  const campId = campaign.id;

  // NOTE: enrichment is NOT a per-campaign phase — it runs once, globally and
  // serially, in enrichPendingGlobally() before this loop (so paused campaigns
  // enrich too, one LLM call at a time). The tick below starts at SCREEN.

  /* ── Phase 1: SCREEN — auto-approve / auto-reject ──────────────────── */
  try {
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
    const needSequence = await db
      .select({ id: prospectQueue.id })
      .from(prospectQueue)
      .leftJoin(
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
      .limit(SEQUENCE_PER_TICK);
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
  try {
    const rows = await db
      .select({
        id: prospectQueue.id,
        email: prospectQueue.email,
        sequence: prospectIntelligence.generatedSequence,
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
        ),
      )
      .limit(ENROLL_PER_TICK);

    for (const row of rows) {
      // Idempotency — if execution rows already exist, just sync the status.
      const [existing] = await db
        .select({ n: sql<number>`count(*)` })
        .from(areExecutionQueue)
        .where(eq(areExecutionQueue.prospectQueueId, row.id));
      if (Number(existing?.n ?? 0) > 0) {
        await db
          .update(prospectQueue)
          .set({ sequenceStatus: "enrolled" })
          .where(eq(prospectQueue.id, row.id));
        continue;
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
      if (steps.length === 0) continue;

      const now = Date.now();
      const execRows = steps.map((s) => ({
        workspaceId: wsId,
        campaignId: campId,
        prospectQueueId: row.id,
        stepIndex: s.stepIndex,
        channel: s.channel,
        scheduledAt: new Date(now + s.dayOffset * 86_400_000),
        status: "scheduled" as const,
        messageContent: { subject: s.subject, body: s.body, variantKey: s.variantKey },
      }));
      await db.insert(areExecutionQueue).values(execRows as never);
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

  /* ── Phase 4: DISPATCH due email steps ─────────────────────────────── */
  try {
    const channels = (campaign.channelsEnabled ?? {}) as Record<string, boolean>;
    const emailEnabled = channels.email !== false; // null/undefined ⇒ enabled

    // Respect dailySendCap — count sends already made today for this campaign.
    const [sentToday] = await db
      .select({ n: sql<number>`count(*)` })
      .from(areExecutionQueue)
      .where(
        and(
          eq(areExecutionQueue.campaignId, campId),
          eq(areExecutionQueue.status, "sent"),
          sql`DATE(${areExecutionQueue.executedAt}) = CURDATE()`,
        ),
      );
    const remaining = Math.max(0, campaign.dailySendCap - Number(sentToday?.n ?? 0));

    if (remaining > 0) {
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
      for (const step of due) {
        // Non-email channels are not wired in v1 — skip cleanly so they
        // never block the queue.
        if (step.channel !== "email") {
          await db
            .update(areExecutionQueue)
            .set({
              status: "skipped",
              failureReason: `Channel '${step.channel}' not wired — ARE engine v1 sends email only`,
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
            .set({ status: "failed", failureReason: "Prospect has no email address", executedAt: new Date() })
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
        const sendRes = await sendCampaignEmailViaPool(wsId, {
          to: p.email,
          subject,
          html: textToHtml(body),
          text: body,
        });
        if (sendRes.ok) {
          await db
            .update(areExecutionQueue)
            .set({ status: "sent", executedAt: new Date() })
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
      const [stillScheduled] = await db
        .select({ n: sql<number>`count(*)` })
        .from(areExecutionQueue)
        .where(
          and(
            eq(areExecutionQueue.prospectQueueId, p.id),
            eq(areExecutionQueue.status, "scheduled"),
          ),
        );
      const [total] = await db
        .select({ n: sql<number>`count(*)` })
        .from(areExecutionQueue)
        .where(eq(areExecutionQueue.prospectQueueId, p.id));
      if (Number(total?.n ?? 0) > 0 && Number(stillScheduled?.n ?? 0) === 0) {
        await db
          .update(prospectQueue)
          .set({ sequenceStatus: "completed" })
          .where(eq(prospectQueue.id, p.id));
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

  // Seed the dedup set with everything already in the queue for this
  // campaign — keeps subsequent ticks from re-adding the same people.
  const existing = await db
    .select({
      email: prospectQueue.email,
      linkedinUrl: prospectQueue.linkedinUrl,
      firstName: prospectQueue.firstName,
      lastName: prospectQueue.lastName,
      companyDomain: prospectQueue.companyDomain,
      companyName: prospectQueue.companyName,
    })
    .from(prospectQueue)
    .where(
      and(
        eq(prospectQueue.campaignId, campaign.id),
        eq(prospectQueue.workspaceId, campaign.workspaceId),
      ),
    );
  const seen = new Set<string>();
  for (const e of existing) {
    if (e.email) seen.add("e:" + e.email.toLowerCase());
    if (e.linkedinUrl) seen.add("u:" + e.linkedinUrl.toLowerCase());
    const nk = nameOrgDedupKey(e);
    if (nk) seen.add(nk);
  }

  type SourceType =
    | "google_business"
    | "linkedin_people"
    | "news"
    | "web_scrape";
  type SourceResult = {
    sourceType: SourceType;
    query: string;
    raw: Array<Record<string, unknown>>;
  };

  const tasks: Array<Promise<SourceResult>> = [];
  if (sources.includes("linkedin")) {
    tasks.push(
      discoverViaLinkedIn(campaign, query).then((raw) => ({
        sourceType: "linkedin_people" as const,
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
    // Within-tick + cross-tick dedup by email and LinkedIn URL.
    const unique = raw.filter((p) => {
      const email = String(p.email ?? "").toLowerCase().trim();
      const url = String(p.linkedinUrl ?? "").toLowerCase().trim();
      const keyE = email ? "e:" + email : null;
      const keyU = url ? "u:" + url : null;
      const keyN = nameOrgDedupKey(p);
      if (keyE && seen.has(keyE)) return false;
      if (keyU && seen.has(keyU)) return false;
      if (keyN && seen.has(keyN)) return false;
      if (keyE) seen.add(keyE);
      if (keyU) seen.add(keyU);
      if (keyN) seen.add(keyN);
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

/**
 * Conservative dedup key on normalized name + company/domain, used alongside
 * exact email/LinkedIn-URL keys so the same person is caught even when their
 * email is missing or differs between sources. Deliberately a normalized
 * EXACT match (not edit-distance) to avoid false-merging two different people
 * at the same company. Returns null when there isn't enough to key on.
 */
function nameOrgDedupKey(p: Record<string, unknown>): string | null {
  const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  const name = `${norm(p.firstName)} ${norm(p.lastName)}`.trim();
  const org = norm(p.companyDomain) || norm(p.companyName);
  if (!name || !org) return null;
  return `n:${name}@${org}`;
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
        "LinkedIn source skipped — no bridged LinkedIn account in this workspace. Connect one at /my-linkedin or disable the LinkedIn source on this campaign.");
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
        // ("Rachele Thomas, BSN, RN, CDAL"). Strip everything after the
        // first comma BEFORE splitting, otherwise the last-space split
        // turns credentials into surnames (lastName "CDAL", "Belt", …).
        const stripCreds = (s: string) => s.split(",")[0].trim();
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
