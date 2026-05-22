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
      result.enriched += settled.filter((s) => s.status === "fulfilled").length;
    }
  } catch (e) {
    console.error(`[AreEngine] campaign ${campId} enrich phase failed:`, e);
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
  } catch (e) {
    console.error(`[AreEngine] campaign ${campId} screen phase failed:`, e);
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
      result.sequencesGenerated += settled.filter((s) => s.status === "fulfilled").length;
    }
  } catch (e) {
    console.error(`[AreEngine] campaign ${campId} sequence phase failed:`, e);
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
  } catch (e) {
    console.error(`[AreEngine] campaign ${campId} enroll phase failed:`, e);
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
  } catch (e) {
    console.error(`[AreEngine] campaign ${campId} dispatch phase failed:`, e);
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
    const pendingCount = Number(counts?.pending ?? 0);
    // Discover only when the queue is fully drained and we're below target,
    // so we never run up LLM cost while there is still work to do.
    if (pendingCount === 0 && total < campaign.targetProspectCount) {
      result.discovered += await runDiscovery(campaign);
    }
  } catch (e) {
    console.error(`[AreEngine] campaign ${campId} discovery phase failed:`, e);
  }
}

/* ─── Discovery — scrape one source to top up a drained campaign ────────── */
async function runDiscovery(campaign: Campaign): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  // Build a search query + ICP context from the workspace's active ICP.
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
  const titles = (icp?.targetTitles as string[] | null) ?? [];
  const industries = (icp?.targetIndustries as string[] | null) ?? [];
  const geos = (icp?.targetGeographies as string[] | null) ?? [];
  const query = [titles[0], industries[0], geos[0]].filter(Boolean).join(" ").trim();
  if (!query) return 0; // no ICP signal to search on — skip discovery

  const icpContext =
    `Industries: ${industries.join(", ")}; ` +
    `Titles: ${titles.join(", ")}; ` +
    `Geographies: ${geos.join(", ")}`;

  // Pick the first configured source that maps to a scraper.
  const sources = (campaign.prospectSources as string[] | null) ?? ["google_business"];
  const source =
    sources.find((s) => ["google_business", "linkedin", "news", "web"].includes(s)) ??
    "google_business";

  let prospects: Array<Record<string, unknown>> = [];
  let sourceType: "google_business" | "linkedin_people" | "news" | "web_scrape" = "google_business";
  if (source === "linkedin") {
    prospects = await scrapeLinkedIn(campaign.workspaceId, campaign.id, query, "people", icpContext);
    sourceType = "linkedin_people";
  } else if (source === "news") {
    prospects = await scrapeNews(campaign.workspaceId, campaign.id, query, icpContext);
    sourceType = "news";
  } else if (source === "web") {
    prospects = await scrapeWeb(campaign.workspaceId, campaign.id, query, icpContext);
    sourceType = "web_scrape";
  } else {
    prospects = await scrapeGoogleBusiness(campaign.workspaceId, campaign.id, query, icpContext);
    sourceType = "google_business";
  }

  await saveScrapeJobAndQueue(campaign.workspaceId, campaign.id, sourceType, query, prospects);
  return prospects.length;
}
