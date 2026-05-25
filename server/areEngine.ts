/**
 * ARE Engine — the autonomous orchestrator behind the Autonomous Revenue Engine.
 *
 * Until now the ARE Hub was a UI + data model with no engine: nothing drove
 * prospects through discovery → enrichment → approval → sequencing → send.
 * This module is that engine. It is invoked on a cron from _core/index.ts.
 *
 * Each run, for every campaign with status='active', it performs one bounded
 * "tick" through the pipeline phases:
 *
 *   1. ENRICH     — runEnrichAgent on pending prospects (ICP score + dossier).
 *   2. SCREEN     — auto-approve / auto-reject enriched prospects per the
 *                   campaign's autonomyMode + autoApproveThreshold.
 *   3. SEQUENCE   — runSequenceAgent on approved prospects with no sequence.
 *   4. ENROLL     — turn a prospect's generatedSequence into are_execution_queue
 *                   rows (one per step) and mark it 'enrolled'.
 *   5. DISPATCH   — send due email steps via the workspace SMTP config,
 *                   respecting dailySendCap and the suppression list.
 *   6. COMPLETE   — mark prospects whose every step has been actioned.
 *   7. COUNTERS   — recompute the campaign's denormalised funnel counters.
 *   8. DISCOVERY  — if the queue is drained and below target, scrape one
 *                   source to top it up.
 *
 * Everything is bounded per tick (LLM cost) and idempotent (safe to re-run).
 * Per-campaign and per-phase try/catch so one failure never blocks the rest.
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";
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
  scrapeLinkedIn,
  scrapeNews,
  scrapeWeb,
} from "./routers/are/scraper";
import { searchLinkedInPeople, type UnipileLinkedInSearchHit } from "./lib/unipile";
import { listUsableAccounts } from "./services/linkedinLookup";
import { sendWorkspaceEmail } from "./emailDelivery";

/* ─── Per-tick bounds (keep LLM cost + wall-time predictable) ───────────── */
const ENRICH_PER_TICK = 4;
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
function applyMerge(text: string, p: Prospect): string {
  return String(text ?? "")
    .replace(/\{\{\s*firstName\s*\}\}/gi, p.firstName ?? "there")
    .replace(/\{\{\s*lastName\s*\}\}/gi, p.lastName ?? "")
    .replace(/\{\{\s*(company|companyName)\s*\}\}/gi, p.companyName ?? "your company")
    .replace(/\{\{\s*title\s*\}\}/gi, p.title ?? "")
    .replace(/\{\{[^}]+\}\}/g, ""); // strip any unresolved tags
}

/** Plain-text outreach body → minimal HTML for the email send. */
function textToHtml(text: string): string {
  const esc = String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
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

  if (result.campaignsProcessed > 0) {
    console.log(
      `[AreEngine] tick complete — campaigns=${result.campaignsProcessed} ` +
        `enriched=${result.enriched} approved=${result.approved} rejected=${result.rejected} ` +
        `sequences=${result.sequencesGenerated} enrolled=${result.enrolled} sent=${result.sent} ` +
        `discovered=${result.discovered}`,
    );
  }
  return result;
}

/* ─── Per-campaign tick ─────────────────────────────────────────────────── */
async function tickCampaign(campaign: Campaign, result: AreEngineResult): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const wsId = campaign.workspaceId;
  const campId = campaign.id;

  /* ── Phase 1: ENRICH pending prospects ─────────────────────────────── */
  try {
    // 'enriching' is included to recover rows left stuck by a crashed run —
    // runEnrichAgent is idempotent (it re-runs and overwrites cleanly).
    const pending = await db
      .select({ id: prospectQueue.id })
      .from(prospectQueue)
      .where(
        and(
          eq(prospectQueue.campaignId, campId),
          eq(prospectQueue.workspaceId, wsId),
          inArray(prospectQueue.enrichmentStatus, ["pending", "enriching"]),
        ),
      )
      .limit(ENRICH_PER_TICK);
    if (pending.length > 0) {
      const settled = await Promise.allSettled(
        pending.map((p) => runEnrichAgent(p.id, wsId)),
      );
      const ok = settled.filter((s) => s.status === "fulfilled").length;
      result.enriched += ok;
      await emitLog(wsId, campId, "enrich", "info",
        `Enriched ${ok}/${pending.length} prospects`);
    }
  } catch (e) {
    console.error(`[AreEngine] campaign ${campId} enrich phase failed:`, e);
    await emitLog(wsId, campId, "enrich", "error", String((e as Error)?.message ?? e), errorDetails(e));
  }

  /* ── Phase 2: SCREEN — auto-approve / auto-reject ──────────────────── */
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

  /* ── Phase 3: SEQUENCE generation for approved prospects ───────────── */
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

  /* ── Phase 4: ENROLL — generatedSequence → are_execution_queue rows ── */
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

  /* ── Phase 5: DISPATCH due email steps ─────────────────────────────── */
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
        const subject = applyMerge(mc.subject || `A quick note for ${p.firstName ?? "you"}`, p);
        const body = applyMerge(mc.body ?? "", p);
        const sendRes = await sendWorkspaceEmail(wsId, {
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

  /* ── Phase 6: COMPLETE — mark prospects whose every step is actioned ─ */
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

  /* ── Phase 7: COUNTERS — recompute the campaign funnel ─────────────── */
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

  /* ── Phase 8: DISCOVERY — replenish a fully drained queue ──────────── */
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

  const query = [titles[0], industries[0], geos[0], keywords[0], sizeHint]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!query) {
    await emitLog(campaign.workspaceId, campaign.id, "discovery", "warn",
      "Discovery skipped — campaign has no targeting (titles/industries/geos/keywords). Open the campaign and add targets, or apply a Persona.");
    return 0;
  }

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
  const sources = (campaign.prospectSources as string[] | null) ?? ["linkedin"];

  // Seed the dedup set with everything already in the queue for this
  // campaign — keeps subsequent ticks from re-adding the same people.
  const existing = await db
    .select({
      email: prospectQueue.email,
      linkedinUrl: prospectQueue.linkedinUrl,
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
      if (keyE && seen.has(keyE)) return false;
      if (keyU && seen.has(keyU)) return false;
      if (keyE) seen.add(keyE);
      if (keyU) seen.add(keyU);
      return true;
    });
    try {
      await saveScrapeJobAndQueue(campaign.workspaceId, campaign.id, sourceType, q, unique);
      totalNew += unique.length;
      perSource[sourceType] = { raw: raw.length, new: unique.length };
    } catch (e) {
      console.error(`[AreEngine] saveScrapeJobAndQueue (${sourceType}) failed:`, e);
      perSource[sourceType] = { raw: raw.length, new: 0, error: String((e as Error)?.message ?? e) };
      await emitLog(campaign.workspaceId, campaign.id, "discovery", "error",
        `Failed to save ${sourceType} results: ${(e as Error)?.message ?? e}`, errorDetails(e));
    }
  }
  // One info-level summary log per call carrying the per-source breakdown
  // in `details` — expand the row in the Logs tab to see what each source
  // returned vs how many survived dedup.
  await emitLog(campaign.workspaceId, campaign.id, "discovery", "info",
    `Discovery query "${query}" → ${totalNew} new across ${Object.keys(perSource).length} sources`,
    { query, perSource });
  return totalNew;
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
    const { items } = await searchLinkedInPeople(acct.unipileAccountId, {
      keywords,
      limit: 15,
    });
    return items
      .map((h: UnipileLinkedInSearchHit) => {
        let firstName = h.first_name ?? "";
        let lastName = h.last_name ?? "";
        const fullName = (h.name ?? `${firstName} ${lastName}`).trim();
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
