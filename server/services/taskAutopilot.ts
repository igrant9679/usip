/**
 * Task Autopilot — the autonomous "next best action" engine behind /v2/tasks.
 *
 * Goal: keep every promising prospect moving toward a booked sales meeting with
 * limited-to-no human interaction. For each candidate the autopilot asks the
 * workspace's configured LLM (via the shared `invokeLLM` abstraction — Anthropic
 * primary, per-workspace BYOK) for the single best next action, then persists it
 * as a `tasks` row with `source='ai'`.
 *
 * Two autonomy modes (per workspace, on `workspace_settings.taskAutopilotMode`):
 *   - "approval": tasks are created as `status='draft'` — a human approves them
 *                 on the Tasks page before they go live.
 *   - "auto":     tasks are created live (`status='open'`) with no human step —
 *                 100% autonomous operation.
 *   - "off":      the autopilot never runs for that workspace.
 *
 * Compliance: prospects with `verificationStatus='rejected'` (suppressed) are
 * NEVER targeted. The engine is best-effort — a single LLM/DB failure for one
 * candidate never aborts the batch, and failures never surface to the user.
 */
import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { prospects, tasks, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";

export type AutopilotMode = "off" | "approval" | "auto";

export interface AutopilotResult {
  created: number;      // total tasks created
  drafts: number;       // created as draft (approval mode)
  live: number;         // created as open (auto mode)
  skipped: number;      // candidates skipped (already had an active task)
  considered: number;   // candidates evaluated by the LLM
}

const EMPTY: AutopilotResult = { created: 0, drafts: 0, live: 0, skipped: 0, considered: 0 };

/** task types the autopilot is allowed to propose (subset of the tasks enum) */
const ALLOWED_TYPES = ["call", "manual_email", "social_touch", "follow_up", "meeting_prep", "generic_action"] as const;
const ALLOWED_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
// statuses that mean "this prospect already has a live action" — don't pile on.
const ACTIVE_STATUSES = ["open", "draft", "in_progress", "snoozed"];

function clampDays(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 2;
  return Math.max(0, Math.min(14, n));
}

/**
 * Generate AI next-best-action tasks for a single workspace.
 * `mode` decides whether tasks land as drafts (approval) or live (auto).
 */
export async function generateTasksForWorkspace(
  workspaceId: number,
  opts: { mode?: "approval" | "auto"; limit?: number; ownerUserId?: number | null } = {},
): Promise<AutopilotResult> {
  const db = await getDb();
  if (!db) return { ...EMPTY };

  const limit = Math.max(1, Math.min(opts.limit ?? 15, 50));
  const mode = opts.mode ?? "approval";
  const targetStatus = mode === "auto" ? "open" : "draft";

  // Candidate prospects: never suppressed/rejected (compliance); most promising
  // first. Oversample so we can drop those that already have an active task.
  const candidates = await db
    .select()
    .from(prospects)
    .where(and(
      eq(prospects.workspaceId, workspaceId),
      or(isNull(prospects.verificationStatus), ne(prospects.verificationStatus, "rejected")),
    ))
    .orderBy(desc(prospects.confidenceScore), desc(prospects.updatedAt))
    .limit(limit * 5);

  if (candidates.length === 0) return { ...EMPTY };

  // Which candidate prospects already have an active task? Skip those.
  const ids = candidates.map((p) => p.id);
  const existing = await db
    .select({ relatedId: tasks.relatedId })
    .from(tasks)
    .where(and(
      eq(tasks.workspaceId, workspaceId),
      eq(tasks.relatedType, "prospect"),
      inArray(tasks.relatedId, ids),
      inArray(tasks.status, ACTIVE_STATUSES),
    ));
  const busy = new Set(existing.map((t) => t.relatedId));

  const result: AutopilotResult = { ...EMPTY };

  for (const p of candidates) {
    if (result.created >= limit) break;
    if (busy.has(p.id)) { result.skipped++; continue; }

    const name = `${p.firstName} ${p.lastName}`.trim();
    const prompt = `You are an autonomous SDR working outbound. Decide the SINGLE best next action to move this prospect toward booking a sales meeting. Be pragmatic; prefer low-friction touches when the relationship is cold. Return JSON only.

Prospect: ${name}, ${p.title ?? "unknown title"} at ${p.company ?? "unknown company"}
Industry: ${p.industry ?? "unknown"}
Seniority: ${p.seniority ?? "unknown"}
Fit/confidence score: ${p.confidenceScore ?? "unscored"}/100
Email on file: ${p.email ? "yes" : "no"}; LinkedIn on file: ${p.linkedinUrl ? "yes" : "no"}

Return: {
  "type": "call|manual_email|social_touch|follow_up|meeting_prep|generic_action",
  "title": "<short imperative task title, <=80 chars>",
  "priority": "low|normal|high|urgent",
  "dueInDays": <integer 0-14>,
  "reasoning": "<one sentence: why this action, now>",
  "confidence": <integer 0-100>
}`;

    try {
      const res = await invokeLLM({
        messages: [{ role: "user", content: prompt }],
        // outputSchema (not response_format) — the invokeLLM layer only forces
        // valid JSON for Anthropic via the json_schema path; response_format
        // json_object returns prose for Anthropic and JSON.parse would throw.
        outputSchema: {
          name: "next_action",
          schema: {
            type: "object",
            properties: {
              type: { type: "string", enum: [...ALLOWED_TYPES] },
              title: { type: "string" },
              priority: { type: "string", enum: [...ALLOWED_PRIORITIES] },
              dueInDays: { type: "integer" },
              reasoning: { type: "string" },
              confidence: { type: "integer" },
            },
            required: ["type", "title", "priority", "dueInDays", "reasoning", "confidence"],
          },
        },
        max_tokens: 300,
        workspaceId,
      });
      const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");

      const type = (ALLOWED_TYPES as readonly string[]).includes(parsed.type) ? parsed.type : "follow_up";
      const priority = (ALLOWED_PRIORITIES as readonly string[]).includes(parsed.priority) ? parsed.priority : "normal";
      const title = String(parsed.title ?? `Follow up with ${name}`).slice(0, 200) || `Follow up with ${name}`;
      const reasoning = String(parsed.reasoning ?? "").slice(0, 500);
      const confidence = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence ?? 60)) || 60));
      const dueAt = new Date(Date.now() + clampDays(parsed.dueInDays) * 86400000);

      await db.insert(tasks).values({
        workspaceId,
        title,
        description: reasoning || null,
        type,
        priority,
        status: targetStatus,
        dueAt,
        ownerUserId: opts.ownerUserId ?? null,
        relatedType: "prospect",
        relatedId: p.id,
        source: "ai",
        aiReasoning: reasoning || null,
        aiConfidence: confidence,
      } as never);

      result.created++;
      if (targetStatus === "open") result.live++; else result.drafts++;
      result.considered++;
      busy.add(p.id);
    } catch (e) {
      // best-effort: skip this candidate, keep the batch going
      result.considered++;
      console.error(`[TaskAutopilot] ws ${workspaceId} prospect ${p.id} failed:`, e);
    }
  }

  return result;
}

/** UTC start-of-day, for the per-workspace daily cap. */
function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Cron entry: run the autopilot for every workspace whose mode != 'off'.
 * Respects the per-workspace daily cap (counts AI tasks created since UTC
 * midnight) and records `taskAutopilotLastRunAt`. One workspace failing never
 * blocks the others.
 */
export async function runTaskAutopilotAllWorkspaces(): Promise<{ workspaces: number; created: number }> {
  const db = await getDb();
  if (!db) return { workspaces: 0, created: 0 };

  const settingsRows = await db
    .select()
    .from(workspaceSettings)
    .where(ne(workspaceSettings.taskAutopilotMode, "off"));

  let workspaces = 0;
  let created = 0;
  const dayStart = startOfUtcDay();

  for (const ws of settingsRows) {
    const mode = ws.taskAutopilotMode as "approval" | "auto";
    const cap = ws.taskAutopilotDailyCap ?? 25;
    try {
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(tasks)
        .where(and(
          eq(tasks.workspaceId, ws.workspaceId),
          eq(tasks.source, "ai"),
          gte(tasks.createdAt, dayStart),
        ));
      const createdToday = Number(row?.n ?? 0);
      const remaining = cap - createdToday;
      if (remaining <= 0) continue;

      const r = await generateTasksForWorkspace(ws.workspaceId, {
        mode,
        limit: Math.min(remaining, 15),
      });
      created += r.created;
      workspaces++;
      await db
        .update(workspaceSettings)
        .set({ taskAutopilotLastRunAt: new Date() })
        .where(eq(workspaceSettings.workspaceId, ws.workspaceId));
      if (r.created > 0) {
        console.log(`[TaskAutopilot] ws ${ws.workspaceId} (${mode}): +${r.created} tasks (${r.drafts} draft, ${r.live} live), ${r.skipped} skipped`);
      }
    } catch (e) {
      console.error(`[TaskAutopilot] ws ${ws.workspaceId} run failed:`, e);
    }
  }

  return { workspaces, created };
}
