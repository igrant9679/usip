/**
 * activityGate.ts — the ONE place that decides whether a LinkedIn action may
 * happen right now, and the ONE place that records that it did.
 *
 * Before this, four subsystems each enforced their own daily number and none
 * could see the others (see @shared/linkedinLimits for the full account). This
 * module is deliberately the same shape as the email-adapter wrapper and the
 * usage meter: a single chokepoint, so the fifth caller is governed without
 * anyone remembering to govern it.
 *
 * Two calls, in this order:
 *
 *   const gate = await checkLinkedInAction({...});
 *   if (!gate.allowed) { …skip, with gate.message… }
 *   …do the LinkedIn thing…
 *   await recordLinkedInAction({...});
 *
 * Recording AFTER the action, not before, because a refused or failed API call
 * is not activity LinkedIn saw. The window between the two is a race in
 * principle — two concurrent callers can both pass a cap boundary — and it is
 * accepted here rather than locked: the caps are conservative guesses well
 * below the real threshold, and one extra invite matters far less than a
 * reservation leak that permanently eats an account's budget when a send
 * throws. The pre-existing atomic reservation on lookups is left in place.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { linkedinActivityLimits, linkedinActivityLog, unipileAccounts } from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  DEFAULT_LINKEDIN_POLICY,
  clampPolicy,
  evaluateLinkedInAction,
  type ActionVerdict,
  type LinkedInActionKind,
  type LinkedInLimitPolicy,
  type LinkedInUsage,
} from "@shared/linkedinLimits";

const DAY_MS = 24 * 60 * 60 * 1000;

function rowToPolicy(row: typeof linkedinActivityLimits.$inferSelect): LinkedInLimitPolicy {
  return clampPolicy({
    enabled: row.enabled,
    weeklyInviteCap: row.weeklyInviteCap,
    dailyInviteCap: row.dailyInviteCap,
    dailyMessageCap: row.dailyMessageCap,
    dailyLookupCap: row.dailyLookupCap,
    dailyActionCap: row.dailyActionCap,
    minSpacingSeconds: row.minSpacingSeconds,
    jitterSeconds: row.jitterSeconds,
    workingHourStart: row.workingHourStart,
    workingHourEnd: row.workingHourEnd,
    workingDays: String(row.workingDays ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n)),
    timezone: row.timezone,
    warmupDays: row.warmupDays,
  });
}

/**
 * The policy governing one account: its own row if it has one, else the
 * workspace default row, else the built-in defaults.
 *
 * An account with no row is NOT unlimited — that is the whole point of having
 * a default row rather than treating absence as permission.
 */
export async function loadPolicy(
  workspaceId: number,
  unipileAccountId: string | null,
): Promise<{ policy: LinkedInLimitPolicy; source: "account" | "workspace" | "builtin" }> {
  const db = await getDb();
  if (!db) return { policy: DEFAULT_LINKEDIN_POLICY, source: "builtin" };
  const rows = await db
    .select()
    .from(linkedinActivityLimits)
    .where(eq(linkedinActivityLimits.workspaceId, workspaceId));
  const own = unipileAccountId
    ? rows.find((r) => r.unipileAccountId === unipileAccountId)
    : undefined;
  if (own) return { policy: rowToPolicy(own), source: "account" };
  const dflt = rows.find((r) => r.unipileAccountId === null);
  if (dflt) return { policy: rowToPolicy(dflt), source: "workspace" };
  return { policy: DEFAULT_LINKEDIN_POLICY, source: "builtin" };
}

/**
 * What this account has already done: today, over the trailing seven days, and
 * how long since its last action of any kind.
 *
 * The trailing week is a ROLLING window, not a calendar week. LinkedIn's
 * restriction does not reset because it became Monday, and a calendar week
 * lets an account send its whole allowance on Sunday night and again on Monday
 * morning.
 */
export async function getUsage(unipileAccountId: string, now = new Date()): Promise<LinkedInUsage> {
  const db = await getDb();
  if (!db) return { today: {}, week: {}, todayTotal: 0, lastActionAt: null };

  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);

  const rows = await db
    .select({
      kind: linkedinActivityLog.kind,
      inDay: sql<number>`sum(case when ${linkedinActivityLog.occurredAt} >= ${dayAgo} then 1 else 0 end)`,
      inWeek: sql<number>`count(*)`,
    })
    .from(linkedinActivityLog)
    .where(and(
      eq(linkedinActivityLog.unipileAccountId, unipileAccountId),
      gte(linkedinActivityLog.occurredAt, weekAgo),
    ))
    .groupBy(linkedinActivityLog.kind);

  const [last] = await db
    .select({ at: linkedinActivityLog.occurredAt })
    .from(linkedinActivityLog)
    .where(eq(linkedinActivityLog.unipileAccountId, unipileAccountId))
    .orderBy(desc(linkedinActivityLog.occurredAt))
    .limit(1);

  const today: Partial<Record<LinkedInActionKind, number>> = {};
  const week: Partial<Record<LinkedInActionKind, number>> = {};
  let todayTotal = 0;
  for (const r of rows) {
    const k = String(r.kind) as LinkedInActionKind;
    const d = Number(r.inDay) || 0;
    today[k] = d;
    week[k] = Number(r.inWeek) || 0;
    todayTotal += d;
  }
  return { today, week, todayTotal, lastActionAt: last?.at ?? null };
}

/** Days since this account was connected, for the warmup ramp. */
export async function accountAgeDays(unipileAccountId: string, now = new Date()): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select({ createdAt: unipileAccounts.createdAt })
    .from(unipileAccounts)
    .where(eq(unipileAccounts.unipileAccountId, unipileAccountId))
    .limit(1);
  if (!row?.createdAt) return null;
  return Math.floor((now.getTime() - new Date(row.createdAt).getTime()) / DAY_MS);
}

export interface GateInput {
  workspaceId: number;
  unipileAccountId: string;
  kind: LinkedInActionKind;
  now?: Date;
}

/**
 * May this action run? Never throws — a gate that fails closed on a database
 * blip would silently stop all outreach, and one that throws would take the
 * caller down with it. On an internal error it ALLOWS, because the individual
 * subsystem caps still stand behind this one.
 */
export async function checkLinkedInAction(input: GateInput): Promise<ActionVerdict> {
  const now = input.now ?? new Date();
  try {
    const [{ policy }, usage, ageDays] = await Promise.all([
      loadPolicy(input.workspaceId, input.unipileAccountId),
      getUsage(input.unipileAccountId, now),
      accountAgeDays(input.unipileAccountId, now),
    ]);
    return evaluateLinkedInAction({ policy, usage, kind: input.kind, now, accountAgeDays: ageDays });
  } catch (e) {
    console.error("[LinkedInGate] check failed, allowing:", (e as Error)?.message ?? e);
    return {
      allowed: true,
      reason: null,
      message: "Limit check unavailable — allowed, subsystem caps still apply",
      retryAfterMs: null,
      effectiveCaps: {
        dailyInvite: DEFAULT_LINKEDIN_POLICY.dailyInviteCap,
        dailyMessage: DEFAULT_LINKEDIN_POLICY.dailyMessageCap,
        dailyLookup: DEFAULT_LINKEDIN_POLICY.dailyLookupCap,
        dailyAction: DEFAULT_LINKEDIN_POLICY.dailyActionCap,
        weeklyInvite: DEFAULT_LINKEDIN_POLICY.weeklyInviteCap,
      },
    };
  }
}

/** Record an action that actually happened. Best-effort; never throws. */
export async function recordLinkedInAction(input: GateInput & {
  source?: string;
  targetIdentifier?: string | null;
}): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(linkedinActivityLog).values({
      workspaceId: input.workspaceId,
      unipileAccountId: input.unipileAccountId,
      kind: input.kind,
      source: input.source ?? null,
      targetIdentifier: input.targetIdentifier ? String(input.targetIdentifier).slice(0, 200) : null,
      occurredAt: input.now ?? new Date(),
    });
  } catch (e) {
    console.error("[LinkedInGate] record failed:", (e as Error)?.message ?? e);
  }
}
