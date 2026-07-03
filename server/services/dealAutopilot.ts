/**
 * Deal Autopilot — autonomous pipeline manager behind /v2/deals.
 *
 * Keeps open opportunities moving toward close with no human step. For each open
 * deal it asks the workspace LLM (shared invokeLLM) for the single best next
 * step + an updated win probability + any risk, writes those onto the deal, and
 * — in 'auto' mode — materializes the next step as a follow-up task (reusing the
 * tasks system) so nothing stalls silently.
 *
 * Modes (workspace_settings.dealAutopilotMode):
 *   off      — never runs.
 *   approval — AI writes nextStep + winProb per open deal for the rep to act on.
 *   auto     — AI also creates the follow-up task automatically.
 *
 * Best-effort: one deal failing never aborts the batch.
 */
import { and, asc, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import { opportunities, tasks, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";

const CLOSED_STAGES = ["won", "lost", "closed_won", "closed_lost", "closed"];

function daysSince(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((Date.now() - t) / 86400000);
}

/** Analyze open deals for a workspace; in 'auto' mode also create follow-up tasks. */
export async function runDealAutopilotForWorkspace(
  workspaceId: number,
  mode: "approval" | "auto",
  limit: number,
  staleBefore?: Date | null,
): Promise<{ analyzed: number; tasksCreated: number }> {
  const db = await getDb();
  if (!db) return { analyzed: 0, tasksCreated: 0 };

  // When staleBefore is set (cron), skip deals already touched since then so we
  // don't re-analyze the same stalest deals every tick (analyzing writes updatedAt).
  const opps = await db.select().from(opportunities)
    .where(and(
      eq(opportunities.workspaceId, workspaceId),
      notInArray(opportunities.stage, CLOSED_STAGES),
      staleBefore ? lt(opportunities.updatedAt, staleBefore) : undefined,
    ))
    .orderBy(asc(opportunities.lastActivityAt))
    .limit(limit);
  if (!opps.length) return { analyzed: 0, tasksCreated: 0 };

  // In auto mode, skip deals that already have an open AI-sourced task.
  let busy = new Set<number>();
  if (mode === "auto") {
    const ids = opps.map((o: any) => o.id);
    const existing = await db.select({ relatedId: tasks.relatedId }).from(tasks)
      .where(and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.relatedType, "opportunity"),
        inArray(tasks.relatedId, ids),
        eq(tasks.source, "ai"),
        inArray(tasks.status, ["open", "in_progress", "draft"]),
      ));
    busy = new Set(existing.map((t: any) => t.relatedId));
  }

  let analyzed = 0, tasksCreated = 0;
  for (const o of opps) {
    const prompt = `You are an autonomous B2B sales pipeline manager. Recommend the single best next step to advance this deal toward close. Return JSON only.

Deal: ${o.name}
Stage: ${o.stage}
Value: ${o.value ?? 0}
Current win probability: ${o.winProb ?? "?"}%
Days in stage: ${o.daysInStage ?? "?"}
Days since last activity: ${daysSince(o.lastActivityAt) ?? "unknown"}
Close date: ${o.closeDate ? new Date(o.closeDate).toLocaleDateString() : "none set"}
Existing next step: ${o.nextStep ?? "none"}

Return: {
  "nextStep": "<short imperative next action, <=90 chars>",
  "winProb": <integer 0-100, your updated estimate>,
  "risk": "<one short phrase if at risk, else empty>",
  "reasoning": "<one sentence>",
  "priority": "low|normal|high|urgent"
}`;

    try {
      const res = await invokeLLM({
        messages: [{ role: "user", content: prompt }],
        // outputSchema forces valid JSON for Anthropic (see taskAutopilot note).
        outputSchema: {
          name: "deal_next_step",
          schema: {
            type: "object",
            properties: {
              nextStep: { type: "string" },
              winProb: { type: "integer" },
              risk: { type: "string" },
              reasoning: { type: "string" },
              priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
            },
            required: ["nextStep", "winProb", "risk", "reasoning", "priority"],
          },
        },
        max_tokens: 300,
        workspaceId,
      });
      const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");
      const nextStep = String(parsed.nextStep ?? "").slice(0, 250) || o.nextStep;
      const winProb = Math.max(0, Math.min(100, Math.round(Number(parsed.winProb)) ));
      const priority = ["low", "normal", "high", "urgent"].includes(parsed.priority) ? parsed.priority : "normal";
      const risk = String(parsed.risk ?? "").slice(0, 120);

      const patch: any = {};
      if (nextStep) patch.nextStep = nextStep;
      if (Number.isFinite(winProb)) patch.winProb = winProb;
      if (Object.keys(patch).length) {
        await db.update(opportunities).set(patch as never)
          .where(and(eq(opportunities.id, o.id), eq(opportunities.workspaceId, workspaceId)));
      }
      analyzed++;

      if (mode === "auto" && nextStep && !busy.has(o.id)) {
        await db.insert(tasks).values({
          workspaceId,
          title: nextStep,
          description: risk ? `Deal at risk: ${risk}` : `Advance deal: ${o.name}`,
          type: "follow_up",
          priority,
          status: "open",
          dueAt: new Date(Date.now() + 2 * 86400000),
          ownerUserId: o.ownerUserId ?? null,
          relatedType: "opportunity",
          relatedId: o.id,
          source: "ai",
        } as never);
        tasksCreated++;
        busy.add(o.id);
      }
    } catch (e) {
      console.error(`[DealAutopilot] ws ${workspaceId} opp ${o.id} failed:`, e);
    }
  }
  return { analyzed, tasksCreated };
}

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Cron entry: run the deal autopilot for every workspace with mode != 'off'. */
export async function runDealAutopilotAllWorkspaces(): Promise<{ workspaces: number; analyzed: number }> {
  const db = await getDb();
  if (!db) return { workspaces: 0, analyzed: 0 };

  const rows = await db.select().from(workspaceSettings).where(sql`${workspaceSettings.dealAutopilotMode} <> 'off'`);
  const dayStart = startOfUtcDay();
  let workspaces = 0, analyzed = 0;

  for (const ws of rows) {
    const mode = ws.dealAutopilotMode as "approval" | "auto";
    const cap = ws.dealAutopilotDailyCap ?? 50;
    try {
      // Both modes respect the cap; the staleBefore=dayStart filter keeps each
      // deal to at most one analysis per day so we never re-burn LLM budget.
      let limit = Math.min(cap, 25);
      if (mode === "auto") {
        const [row] = await db.select({ n: sql<number>`count(*)` }).from(tasks)
          .where(and(
            eq(tasks.workspaceId, ws.workspaceId),
            eq(tasks.source, "ai"),
            eq(tasks.relatedType, "opportunity"),
            gte(tasks.createdAt, dayStart),
          ));
        const remaining = cap - Number(row?.n ?? 0);
        if (remaining <= 0) continue;
        limit = Math.min(remaining, 20);
      }
      const r = await runDealAutopilotForWorkspace(ws.workspaceId, mode, limit, dayStart);
      analyzed += r.analyzed;
      workspaces++;
      await db.update(workspaceSettings).set({ dealAutopilotLastRunAt: new Date() } as never)
        .where(eq(workspaceSettings.workspaceId, ws.workspaceId));
      if (r.analyzed > 0) console.log(`[DealAutopilot] ws ${ws.workspaceId} (${mode}): analyzed ${r.analyzed}, tasks ${r.tasksCreated}`);
    } catch (e) {
      console.error(`[DealAutopilot] ws ${ws.workspaceId} failed:`, e);
    }
  }
  return { workspaces, analyzed };
}
