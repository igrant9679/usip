/**
 * A daily cap on the tasks the machine files by itself (audit 2026-10-20,
 * L15; final pass 2026-11-07).
 *
 * LSI Media had 493 overdue tasks, most of them filed automatically. Task
 * Autopilot had a per-workspace daily cap (taskAutopilotDailyCap, 25); the
 * other sources had none: high-intent website visits, Deal Autopilot, the
 * proposal follow-up and escalation tasks, and sequence task steps. Each of
 * those now files at most `autoTaskDailyCap` tasks a workspace day (the
 * workspace's own midnight), default 25, the same as Task Autopilot.
 *
 * At the cap a source skips, never errors, and the skip is recorded: a line
 * in the log once per workspace, source and day, and a count the engine
 * status page shows. A sequence task step is held to the next workspace day
 * rather than dropped, so no step is lost.
 *
 * Tasks a source files carry `autoSource` (migration 0321), which is what is
 * counted.
 */
import { and, count, eq, gte } from "drizzle-orm";
import { tasks, workspaceSettings } from "../../drizzle/schema";
import type { getDb } from "../db";
import { getWorkspaceTimezone, startOfLocalDay } from "./workspaceTimezone";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const AUTO_TASK_DAILY_CAP_DEFAULT = 25;

export const AUTO_TASK_SOURCES = {
  website_visit: "High-intent website visits",
  deal_autopilot: "Deal Autopilot",
  proposal_followup: "Proposal follow-ups",
  proposal_escalation: "Proposal extension escalations",
  sequence_step: "Sequence task steps",
} as const;
export type AutoTaskSource = keyof typeof AUTO_TASK_SOURCES;

/** Skips since this process started, by workspace day: `${ws}:${day}:${source}` → count. */
const skips = new Map<string, number>();

function dayKey(tz: string, now: Date): string {
  return startOfLocalDay(tz, now).toISOString();
}

export async function autoTaskDailyCap(db: Db, workspaceId: number): Promise<number> {
  const [row] = await db.select({ cap: workspaceSettings.autoTaskDailyCap }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId));
  const cap = Number(row?.cap ?? AUTO_TASK_DAILY_CAP_DEFAULT);
  return Number.isFinite(cap) && cap >= 0 ? cap : AUTO_TASK_DAILY_CAP_DEFAULT;
}

/** How many tasks this source filed today in this workspace, and how many more it may. */
export async function autoTaskBudget(db: Db, workspaceId: number, source: AutoTaskSource, now: Date = new Date()) {
  const tz = await getWorkspaceTimezone(workspaceId, now.getTime());
  const since = startOfLocalDay(tz, now);
  const cap = await autoTaskDailyCap(db, workspaceId);
  const [row] = await db.select({ n: count() }).from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.autoSource, source), gte(tasks.createdAt, since)));
  const used = Number(row?.n ?? 0);
  return { cap, used, remaining: Math.max(0, cap - used), since, tz };
}

/**
 * May this source file one more task now? False at the cap, with the skip
 * recorded; never throws (a failed read lets the task through, as before).
 */
export async function mayFileAutoTask(db: Db, workspaceId: number, source: AutoTaskSource, now: Date = new Date()): Promise<boolean> {
  try {
    const b = await autoTaskBudget(db, workspaceId, source, now);
    if (b.remaining > 0) return true;
    const key = `${workspaceId}:${dayKey(b.tz, now)}:${source}`;
    const n = (skips.get(key) ?? 0) + 1;
    skips.set(key, n);
    if (n === 1) console.log(`[AutoTaskCap] workspace ${workspaceId}: ${AUTO_TASK_SOURCES[source]} reached today's cap of ${b.cap}; more are skipped until tomorrow.`);
    if (skips.size > 10_000) skips.clear(); // a bound on memory, not a policy
    return false;
  } catch (e) {
    console.warn("[AutoTaskCap] budget read failed; filing anyway:", (e as Error).message);
    return true;
  }
}

/** Today's tasks and skips per source, for the engine status page. */
export async function autoTaskToday(db: Db, workspaceId: number, now: Date = new Date()) {
  const tz = await getWorkspaceTimezone(workspaceId, now.getTime());
  const day = dayKey(tz, now);
  const out = [];
  for (const source of Object.keys(AUTO_TASK_SOURCES) as AutoTaskSource[]) {
    const b = await autoTaskBudget(db, workspaceId, source, now);
    out.push({ source, label: AUTO_TASK_SOURCES[source], cap: b.cap, filed: b.used, skipped: skips.get(`${workspaceId}:${day}:${source}`) ?? 0 });
  }
  return out;
}

/** For tests. */
export function resetAutoTaskSkips(): void { skips.clear(); }
