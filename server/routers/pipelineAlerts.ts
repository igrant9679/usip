/**
 * Pipeline Health Alerts (CRMA-012)
 * Detects: no_activity, closing_soon_regression, past_close_date, no_champion
 * (the sweep), and amount_change (when a deal's amount is written).
 */
import { z } from "zod";
import { router } from "../_core/trpc";
import { adminWsProcedure, assertOwnerOrManager, managerProcedure, workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { changeOpportunityStage } from "../services/stageChange";
import { refreshDaysInStage } from "../services/dealDates";
import { closedStageKeys, stageIndexFor } from "../_core/stageSemantics";
import { workspaceNotifyUserId } from "../_core/activeMembers";
import { escapeHtml } from "@shared/escapeHtml";
import { storedToCalendarDate } from "@shared/calendarDate";
import { zonedYmd } from "../services/dealMetrics";
import { getWorkspaceTimezone, workspaceDayKeyOf } from "../services/workspaceTimezone";
import { TRPCError } from "@trpc/server";
import { eq, and, count, inArray, isNull, isNotNull, desc, gte, notInArray, or } from "drizzle-orm";
import {
  pipelineAlerts,
  opportunities,
  activities,
  opportunityContactRoles,
  workflowRules,
  users,
  crmPipelineStages,
} from "../../drizzle/schema";
import { affectedRowsOf } from "../_core/claim";

/**
 * Clearing an alert hides it from everyone (audit 2026-10-20, R37), so it is
 * for the deal's owner or a manager, as with anything one person owns. A deal
 * that no longer exists, or isn't here, leaves nothing to clear.
 */
async function assertMayClearForDeal(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  ctx: { workspace: { id: number }; user: { id: number }; member: { role: string } },
  opportunityId: number,
): Promise<boolean> {
  const [opp] = await db.select({ ownerUserId: opportunities.ownerUserId }).from(opportunities)
    .where(and(eq(opportunities.id, opportunityId), eq(opportunities.workspaceId, ctx.workspace.id)));
  if (!opp) return false;
  assertOwnerOrManager(ctx, opp.ownerUserId, "Only the deal's owner or a manager can clear its alerts.");
  return true;
}

const ALERT_THRESHOLDS = {
  noActivityDays: 14,        // no activity in 14 days
  closingSoonDays: 30,       // closing within 30 days
  // A person's dismissal holds this long; after it the alert comes back if the
  // deal still needs it (audit 2026-10-20, R15).
  snoozeDays: 7,
  // A change of at least this share of a deal's amount raises amount_change.
  amountChangeShare: 0.2,
};

/** The types the sweep decides from the deal's facts; amount_change is raised when the amount is written. */
const SCANNED_TYPES = ["no_activity", "closing_soon_regression", "past_close_date", "no_champion"] as const;
type ScannedType = (typeof SCANNED_TYPES)[number];

/** Deals read together by the 15-minute alert sweep. */
const ALERT_CHUNK = 500;

const DAY_MS = 86_400_000;
const dayNumber = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / DAY_MS);

/**
 * Workspace-scoped pipeline-alert scan, run by the 15-minute sweep and by the
 * page's "Run Health Scan". Returns { scanned, created, resolved }.
 *
 * Each (deal, type) pair has one live alert at most. What changed for R15:
 *   • a dismissal is a snooze — a person's dismissal holds for snoozeDays, and
 *     only then may the alert come back, if its cause has not cleared. Every
 *     scan regenerated it, so a dismissed alert was back within 15 minutes;
 *   • an alert whose cause has cleared (activity logged, a contact role added,
 *     a close date or win % changed) resolves itself, and so does every alert
 *     on a deal that has closed or is gone. Resolved alerts carry no
 *     dismissedByUserId, so they do not snooze anything.
 * And for R38: a close date that has passed is past_close_date, not "closing
 * soon"; closing soon means within closingSoonDays from today.
 */
export async function scanPipelineAlertsForWorkspace(
  wsId: number,
  opts: { changedSince?: Date | null; now?: Date } = {},
): Promise<{ scanned: number; created: number; resolved: number; full: boolean }> {
  const db = await getDb();
  const changedSince = opts.changedSince ?? null;
  if (!db) return { scanned: 0, created: 0, resolved: 0, full: !changedSince };
  const now = opts.now ?? new Date();
  // Days in stage, counted from when the deal entered it (R14) — before
  // anything below, or the stuck-deal rules read yesterday's number. Day
  // granular, so the full pass keeps it (at least once a workspace day).
  if (!changedSince) await refreshDaysInStage(db, wsId, now);
  const noActivityCutoff = new Date(now.getTime() - ALERT_THRESHOLDS.noActivityDays * DAY_MS);
  const snoozeCutoff = new Date(now.getTime() - ALERT_THRESHOLDS.snoozeDays * DAY_MS);
  // Close dates are calendar dates; "today" is the workspace's.
  const { y, m, day } = zonedYmd(await getWorkspaceTimezone(wsId), now);
  const today = dayNumber(`${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`);

  // The deals' facts in three reads per ALERT_CHUNK deals, not three or four
  // reads per deal (audit 2026-10-20, R66, X4.4): this runs every 15 minutes
  // for every workspace. Same checks, same alerts.
  // Incremental (audit X4.4): every 15 minutes only the deals that changed
  // since the last sweep are read, with those carrying a live no_champion
  // alert (a contact role has no timestamp of its own); the full pass reads
  // every open deal. What only time changes (no activity in 14 days, a close
  // date reached) is day granular, and the full pass runs at least once a
  // workspace day.
  const changedIds = changedSince ? await dealsChangedSince(db, wsId, changedSince) : null;
  if (changedIds && changedIds.length === 0) return { scanned: 0, created: 0, resolved: 0, full: false };
  const opps = await db.select({
    id: opportunities.id, name: opportunities.name, stage: opportunities.stage,
    closeDate: opportunities.closeDate, winProb: opportunities.winProb,
  }).from(opportunities).where(changedIds
    ? and(eq(opportunities.workspaceId, wsId), inArray(opportunities.id, changedIds))
    : eq(opportunities.workspaceId, wsId));
  const stages = await stageIndexFor(db, wsId);
  const activeOpps = opps.filter((o) => stages.isOpen(o.stage));
  const activeIds = new Set(activeOpps.map((o) => o.id));
  let created = 0;
  const toResolve: number[] = [];

  // Live alerts on a deal that has closed, or no longer exists, are resolved.
  // Incrementally, only the changed deals' (a deleted deal waits for the full pass).
  const live = await db.select({ id: pipelineAlerts.id, opportunityId: pipelineAlerts.opportunityId })
    .from(pipelineAlerts)
    .where(changedIds
      ? and(eq(pipelineAlerts.workspaceId, wsId), isNull(pipelineAlerts.dismissedAt), inArray(pipelineAlerts.opportunityId, changedIds))
      : and(eq(pipelineAlerts.workspaceId, wsId), isNull(pipelineAlerts.dismissedAt)));
  for (const a of live) if (!activeIds.has(a.opportunityId)) toResolve.push(a.id);

  for (let i = 0; i < activeOpps.length; i += ALERT_CHUNK) {
    const chunk = activeOpps.slice(i, i + ALERT_CHUNK);
    const ids = chunk.map((o) => o.id);
    const [recent, held, roles] = await Promise.all([
      db.select({ id: activities.relatedId }).from(activities)
        .where(and(
          eq(activities.workspaceId, wsId),
          eq(activities.relatedType, "opportunity"),
          inArray(activities.relatedId, ids),
          gte(activities.createdAt, noActivityCutoff),
        )).groupBy(activities.relatedId),
      // Live alerts, and those a person dismissed within the snooze.
      db.select({ id: pipelineAlerts.id, opp: pipelineAlerts.opportunityId, type: pipelineAlerts.alertType, dismissedAt: pipelineAlerts.dismissedAt })
        .from(pipelineAlerts)
        .where(and(
          eq(pipelineAlerts.workspaceId, wsId),
          inArray(pipelineAlerts.opportunityId, ids),
          or(
            isNull(pipelineAlerts.dismissedAt),
            and(isNotNull(pipelineAlerts.dismissedByUserId), gte(pipelineAlerts.dismissedAt, snoozeCutoff)),
          ),
        )),
      db.select({ id: opportunityContactRoles.opportunityId }).from(opportunityContactRoles)
        .where(inArray(opportunityContactRoles.opportunityId, ids)).groupBy(opportunityContactRoles.opportunityId),
    ]);
    const active = new Set(recent.map((r) => r.id));
    const blocked = new Set(held.map((r) => `${r.opp}:${r.type}`));
    const championed = new Set(roles.map((r) => r.id));
    const fresh: (typeof pipelineAlerts.$inferInsert)[] = [];
    for (const opp of chunk) {
      const closeDay = storedToCalendarDate(opp.closeDate);
      const daysUntilClose = closeDay ? dayNumber(closeDay) - today : null;
      const due: Partial<Record<ScannedType, Record<string, unknown>>> = {};
      if (!active.has(opp.id)) {
        due.no_activity = { daysSinceActivity: ALERT_THRESHOLDS.noActivityDays, oppName: opp.name };
      }
      if (daysUntilClose !== null && daysUntilClose < 0) {
        due.past_close_date = { daysPastClose: -daysUntilClose, winProb: opp.winProb, closeDate: closeDay, oppName: opp.name };
      } else if (daysUntilClose !== null && daysUntilClose <= ALERT_THRESHOLDS.closingSoonDays && opp.winProb < 50) {
        due.closing_soon_regression = { daysUntilClose, winProb: opp.winProb, closeDate: closeDay, oppName: opp.name };
      }
      if (!championed.has(opp.id)) {
        due.no_champion = { oppName: opp.name, stage: opp.stage };
      }
      for (const type of SCANNED_TYPES) {
        const details = due[type];
        if (details && !blocked.has(`${opp.id}:${type}`)) {
          fresh.push({ workspaceId: wsId, opportunityId: opp.id, alertType: type, details });
        }
      }
      // A live alert whose cause has cleared resolves.
      for (const r of held) {
        if (r.opp === opp.id && r.dismissedAt == null && (SCANNED_TYPES as readonly string[]).includes(r.type) && !due[r.type as ScannedType]) {
          toResolve.push(r.id);
        }
      }
    }
    if (fresh.length) await db.insert(pipelineAlerts).values(fresh);
    created += fresh.length;
  }

  for (let i = 0; i < toResolve.length; i += ALERT_CHUNK) {
    await db.update(pipelineAlerts).set({ dismissedAt: now, dismissedByUserId: null })
      .where(and(eq(pipelineAlerts.workspaceId, wsId), inArray(pipelineAlerts.id, toResolve.slice(i, i + ALERT_CHUNK))));
  }

  return { scanned: activeOpps.length, created, resolved: toResolve.length, full: !changedIds };
}

/**
 * Deals whose facts may have moved since `since`: the deal row was written
 * (stage, close date, win probability, amount), an activity was logged on it,
 * or it carries a live no_champion alert (contact roles have no timestamp).
 */
export async function dealsChangedSince(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, wsId: number, since: Date): Promise<number[]> {
  const [edited, logged, unchampioned] = await Promise.all([
    db.select({ id: opportunities.id }).from(opportunities)
      .where(and(eq(opportunities.workspaceId, wsId), gte(opportunities.updatedAt, since))),
    db.select({ id: activities.relatedId }).from(activities)
      .where(and(eq(activities.workspaceId, wsId), eq(activities.relatedType, "opportunity"), gte(activities.createdAt, since)))
      .groupBy(activities.relatedId),
    db.select({ id: pipelineAlerts.opportunityId }).from(pipelineAlerts)
      .where(and(eq(pipelineAlerts.workspaceId, wsId), eq(pipelineAlerts.alertType, "no_champion"), isNull(pipelineAlerts.dismissedAt))),
  ]);
  const ids = new Set<number>();
  for (const r of [...edited, ...logged, ...unchampioned]) if (r.id != null) ids.add(Number(r.id));
  return Array.from(ids);
}

/** The full pass runs at least this often, and at the first sweep of each workspace day. */
export const ALERT_FULL_PASS_MS = 6 * 3_600_000;
/** An incremental sweep reaches back this much further than the last one began, for clock skew. */
const ALERT_SWEEP_OVERLAP_MS = 60_000;

/** Per workspace: when the last sweep began, the last full pass, and the workspace day of that pass. */
const sweepState = new Map<number, { lastSweepAt: number; lastFullAt: number; fullDay: string }>();

/** Full when never run in this process, older than ALERT_FULL_PASS_MS, or from an earlier workspace day. */
export function alertSweepPlan(state: { lastSweepAt: number; lastFullAt: number; fullDay: string } | undefined, now: number, today: string): { full: boolean; since: Date | null } {
  if (!state || now - state.lastFullAt >= ALERT_FULL_PASS_MS || state.fullDay !== today) return { full: true, since: null };
  return { full: false, since: new Date(state.lastSweepAt - ALERT_SWEEP_OVERLAP_MS) };
}

/** For tests. */
export function resetAlertSweepState(): void { sweepState.clear(); }

/**
 * A deal's amount was written (audit 2026-10-20, R38: amount_change was named
 * on the alerts page and never raised). An open deal whose amount moves by at
 * least amountChangeShare of what it was gets one live amount_change alert; a
 * further change updates that alert's current amount. Best-effort: an alert
 * must never fail the write that caused it.
 */
export async function noteAmountChange(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  wsId: number,
  opp: { id: number; name: string; stage: string },
  previous: number,
  current: number,
): Promise<void> {
  try {
    if (!(previous > 0) || !Number.isFinite(current)) return;
    if (Math.abs(current - previous) < previous * ALERT_THRESHOLDS.amountChangeShare) return;
    if (!(await stageIndexFor(db, wsId)).isOpen(opp.stage)) return;
    const [open] = await db.select({ id: pipelineAlerts.id, details: pipelineAlerts.details }).from(pipelineAlerts)
      .where(and(
        eq(pipelineAlerts.workspaceId, wsId),
        eq(pipelineAlerts.opportunityId, opp.id),
        eq(pipelineAlerts.alertType, "amount_change"),
        isNull(pipelineAlerts.dismissedAt),
      )).limit(1);
    if (open) {
      const was = Number((open.details as { previousAmount?: number } | null)?.previousAmount ?? previous);
      await db.update(pipelineAlerts).set({ details: { previousAmount: was, currentAmount: current, oppName: opp.name } })
        .where(and(eq(pipelineAlerts.id, open.id), eq(pipelineAlerts.workspaceId, wsId)));
      return;
    }
    await db.insert(pipelineAlerts).values({
      workspaceId: wsId, opportunityId: opp.id, alertType: "amount_change",
      details: { previousAmount: previous, currentAmount: current, oppName: opp.name },
    });
  } catch (e) {
    console.error("[PipelineAlerts] amount change alert failed:", (e as Error).message);
  }
}

/**
 * Days in stage before an open deal counts as stuck (R38). A rule for the
 * deal's stage decides for that stage; the other stages take the lowest rule
 * that names no stage, else `defaultMinDays`. A rule for one stage used to
 * lower every stage's threshold, because the fallback was the minimum over
 * every rule.
 */
export function stuckThresholds(
  rules: Array<{ triggerConfig: unknown }>,
  defaultMinDays: number,
): (stage: string | null | undefined) => number {
  const byStage: Record<string, number> = {};
  let anyStage: number | null = null;
  for (const rule of rules) {
    const cfg = (rule.triggerConfig ?? {}) as { stage?: string; days?: number };
    const days = cfg.days ?? defaultMinDays;
    if (cfg.stage) byStage[cfg.stage] = Math.min(byStage[cfg.stage] ?? Infinity, days);
    else anyStage = Math.min(anyStage ?? Infinity, days);
  }
  const fallback = anyStage ?? defaultMinDays;
  return (stage) => (stage && byStage[stage] !== undefined ? byStage[stage]! : fallback);
}

/** Open deals past their stuck threshold, with the threshold each was held to. */
async function loadStuckDeals(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, wsId: number, defaultMinDays: number) {
  const rules = await db
    .select({ triggerConfig: workflowRules.triggerConfig })
    .from(workflowRules)
    .where(and(eq(workflowRules.workspaceId, wsId), eq(workflowRules.enabled, true), eq(workflowRules.triggerType, "deal_stuck")));
  const thresholdFor = stuckThresholds(rules, defaultMinDays);
  const openOpps = await db
    .select({
      id: opportunities.id,
      name: opportunities.name,
      stage: opportunities.stage,
      value: opportunities.value,
      winProb: opportunities.winProb,
      closeDate: opportunities.closeDate,
      daysInStage: opportunities.daysInStage,
      ownerId: opportunities.ownerUserId,
      pipelineId: opportunities.pipelineId,
    })
    .from(opportunities)
    .where(and(eq(opportunities.workspaceId, wsId), notInArray(opportunities.stage, await closedStageKeys(db, wsId))));
  return openOpps
    .map((d) => ({ ...d, threshold: thresholdFor(d.stage) }))
    .filter((d) => (d.daysInStage ?? 0) >= d.threshold);
}

/**
 * Cron driver — iterates every workspace and runs the alert scan.
 * Called from server/_core/index.ts on the same 3-min tick as the ARE
 * engine. Errors per workspace are isolated so one failure doesn't
 * abort the rest of the sweep.
 */
export async function runPipelineAlertsCron(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  // Source workspaces from the membership table — same approach the ARE
  // engine uses indirectly. Importing the schema avoids any extra round-trip.
  const { workspaces } = await import("../../drizzle/schema");
  const wsRows = await db.select({ id: workspaces.id }).from(workspaces);
  for (const ws of wsRows) {
    try {
      const now = Date.now();
      const today = workspaceDayKeyOf(await getWorkspaceTimezone(ws.id), now);
      const plan = alertSweepPlan(sweepState.get(ws.id), now, today);
      await scanPipelineAlertsForWorkspace(ws.id, { changedSince: plan.since, now: new Date(now) });
      const prev = sweepState.get(ws.id);
      sweepState.set(ws.id, plan.full ? { lastSweepAt: now, lastFullAt: now, fullDay: today } : { ...prev!, lastSweepAt: now });
    }
    catch (e) { console.error(`[PipelineAlertsCron] workspace ${ws.id} scan failed:`, e); }
  }
}

export const pipelineAlertsRouter = router({
  /**
   * Run the health scan now — the same scan as the sweep. This was a second
   * copy that read three or four rows per deal (R66) and, unlike the sweep,
   * never snoozed or resolved anything.
   */
  scan: workspaceProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    return scanPipelineAlertsForWorkspace(ctx.workspace.id);
  }),

  /** List active (undismissed) alerts for the workspace */
  list: workspaceProcedure
    // .optional(): DealsV2 calls this with NO input, and a required object
    // made the whole Deals batch return 207 — the alerts strip 400'd on
    // every page load (found live, 2026-09-20).
    .input(z.object({ limit: z.number().default(50) }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      /**
       * An alert about an opportunity that no longer exists is not an alert,
       * it is debris. These rows survive the opportunity being deleted (no FK
       * cleanup), and because the alert carries a denormalised
       * `details.oppName` the UI renders a plausible name for a record that
       * cannot be opened — live on 2026-08-16, ALL 50 alerts in LSI were
       * orphans of the sample-data removal, each offering a "View Opp" link
       * to nothing.
       *
       * Neither is an alert on a deal that has closed (audit 2026-10-20, R15):
       * the sweep resolves those, and until it runs this does not offer them.
       * Joined in the query, so the limit counts alerts that are shown, and
       * only the alerted deals are read, not the whole workspace's.
       */
      const closed = await closedStageKeys(db, ctx.workspace.id);
      const rows = await db
        .select({
          alert: pipelineAlerts,
          oppId: opportunities.id, oppName: opportunities.name, oppStage: opportunities.stage,
          oppValue: opportunities.value, oppWinProb: opportunities.winProb,
          // The owner too, so a card offers Dismiss only to who may (R37).
          oppOwnerUserId: opportunities.ownerUserId,
        })
        .from(pipelineAlerts)
        .innerJoin(opportunities, eq(opportunities.id, pipelineAlerts.opportunityId))
        .where(
          and(
            eq(pipelineAlerts.workspaceId, ctx.workspace.id),
            eq(opportunities.workspaceId, ctx.workspace.id),
            isNull(pipelineAlerts.dismissedAt),
            closed.length > 0 ? notInArray(opportunities.stage, closed) : undefined,
          )
        )
        .orderBy(desc(pipelineAlerts.createdAt))
        .limit(input?.limit ?? 50);
      return rows.map((r) => ({
        ...r.alert,
        opportunity: { id: r.oppId, name: r.oppName, stage: r.oppStage, value: r.oppValue, winProb: r.oppWinProb, ownerUserId: r.oppOwnerUserId },
      }));
    }),

  /** Dismiss an alert */
  dismiss: workspaceProcedure
    .input(z.object({ alertId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [alert] = await db.select({ opportunityId: pipelineAlerts.opportunityId }).from(pipelineAlerts)
        .where(and(eq(pipelineAlerts.id, input.alertId), eq(pipelineAlerts.workspaceId, ctx.workspace.id)));
      if (!alert) return { ok: true };
      // An alert on a deal that is gone is debris; anyone may clear it.
      await assertMayClearForDeal(db, ctx, alert.opportunityId);
      await db
        .update(pipelineAlerts)
        .set({ dismissedAt: new Date(), dismissedByUserId: ctx.user.id })
        .where(
          and(
            eq(pipelineAlerts.id, input.alertId),
            eq(pipelineAlerts.workspaceId, ctx.workspace.id)
          )
        );
      return { ok: true };
    }),

  /** Dismiss all alerts for an opportunity */
  dismissAllForOpp: workspaceProcedure
    .input(z.object({ opportunityId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await assertMayClearForDeal(db, ctx, input.opportunityId);
      await db
        .update(pipelineAlerts)
        .set({ dismissedAt: new Date(), dismissedByUserId: ctx.user.id })
        .where(
          and(
            eq(pipelineAlerts.opportunityId, input.opportunityId),
            eq(pipelineAlerts.workspaceId, ctx.workspace.id),
            isNull(pipelineAlerts.dismissedAt)
          )
        );
      return { ok: true };
    }),

  /** Live alerts by type — the same alerts the list shows, counted in SQL. */
  summary: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const closed = await closedStageKeys(db, ctx.workspace.id);
    const rows = await db
      .select({ type: pipelineAlerts.alertType, n: count() })
      .from(pipelineAlerts)
      .innerJoin(opportunities, eq(opportunities.id, pipelineAlerts.opportunityId))
      .where(
        and(
          eq(pipelineAlerts.workspaceId, ctx.workspace.id),
          eq(opportunities.workspaceId, ctx.workspace.id),
          isNull(pipelineAlerts.dismissedAt),
          closed.length > 0 ? notInArray(opportunities.stage, closed) : undefined,
        )
      )
      .groupBy(pipelineAlerts.alertType);
    const counts: Record<string, number> = {
      no_activity: 0,
      closing_soon_regression: 0,
      past_close_date: 0,
      amount_change: 0,
      no_champion: 0,
    };
    let total = 0;
    for (const r of rows) {
      counts[r.type] = (counts[r.type] ?? 0) + Number(r.n);
      total += Number(r.n);
    }
    return { total, byType: counts };
  }),

  /**
   * Return all open deals stuck in a stage for longer than the configured threshold.
   * Uses deal_stuck workflow rules as the source of thresholds; falls back to 7 days.
   */
  getStuckDeals: workspaceProcedure
    .input(z.object({ minDays: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const stuckDeals = await loadStuckDeals(db, ctx.workspace.id, input.minDays ?? 7);

      // Attach owner names
      const ownerIds = Array.from(new Set(stuckDeals.map((d) => d.ownerId).filter(Boolean) as number[]));
      const owners = ownerIds.length > 0
        ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ownerIds))
        : [];
      const ownerMap = Object.fromEntries(owners.map((u) => [u.id, u.name]));

      return stuckDeals.map((d) => ({
        ...d,
        ownerName: d.ownerId ? (ownerMap[d.ownerId] ?? null) : null,
      }));
    }),

  /** Log a quick activity note on an opportunity from the alerts page */
  logActivityOnDeal: workspaceProcedure
    .input(z.object({
      opportunityId: z.number(),
      note: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      /**
       * `activities` links by relatedType/relatedId and records its author in
       * `actorUserId`. This wrote `opportunityId` and `createdByUserId`, and
       * NEITHER COLUMN EXISTS — Drizzle maps an object key to a column and
       * silently ignores anything it does not recognise, so both were dropped
       * on the way to the INSERT with no error anywhere.
       *
       * The note was therefore saved attached to nothing and authored by
       * nobody: it never appeared in the deal's activity feed, which is the
       * only place anyone would look for it.
       */
      // ...and on a deal of this workspace (audit 2026-10-20, X1.1).
      const { assertRowInWorkspace } = await import("../services/foreignIds");
      await assertRowInWorkspace(db, "deal", input.opportunityId, ctx.workspace.id);
      await db.insert(activities).values({
        workspaceId: ctx.workspace.id,
        relatedType: "opportunity",
        relatedId: input.opportunityId,
        type: "note",
        body: input.note,
        actorUserId: ctx.user.id,
      });
      return { ok: true };
    }),

  /**
   * Move a deal to a new stage from the alerts page — through the one
   * stage-change service (audit 2026-10-20, R21). This path skipped the win %,
   * the history, the audit and the owner's notice.
   */
  moveDealStage: workspaceProcedure
    .input(z.object({
      opportunityId: z.number(),
      newStage: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const r = await changeOpportunityStage(db, {
        workspaceId: ctx.workspace.id,
        opportunityId: input.opportunityId,
        toStage: input.newStage,
        actorUserId: ctx.user.id,
        actorName: ctx.user.name ?? null,
        source: "alerts",
      });
      return { ok: true, changed: r.changed, customerCreated: r.customerCreated };
    }),

  /**
   * Send a digest email of stuck deals to the workspace's owner — a member of
   * this workspace — through its system sender.
   */
  sendDigest: workspaceProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    const wsId = ctx.workspace.id;

    // The same stuck deals, by the same thresholds, as the page lists.
    const stuckDeals = await loadStuckDeals(db, wsId, 7);

    if (stuckDeals.length === 0) {
      return { ok: true, sent: false, reason: "No stuck deals found" };
    }

    /**
     * The workspace's own owner, resolved to someone still in it, else the
     * member asking (audit 2026-10-20, R2). This read the PLATFORM owner
     * (ENV.ownerOpenId), the operator of the whole install, so every
     * workspace's stuck deals were mailed to one person outside it.
     */
    const ownerId = await workspaceNotifyUserId(wsId);
    const [ownerUser] = ownerId
      ? await db.select({ email: users.email }).from(users).where(eq(users.id, ownerId)).limit(1)
      : [];
    const recipientEmail = ownerUser?.email || ctx.user.email;
    if (!recipientEmail) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No recipient email found for workspace owner" });
    }

    // Build email HTML
    const rows = stuckDeals
      .map((d) => `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${escapeHtml(d.name)}</td><td style="padding:4px 8px;border-bottom:1px solid #eee">${escapeHtml(d.stage)}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${d.daysInStage ?? 0} days</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">$${Number(d.value ?? 0).toLocaleString()}</td></tr>`)
      .join("");
    const html = `<h2 style="font-family:sans-serif">Pipeline Alerts Digest</h2>
<p style="font-family:sans-serif">${stuckDeals.length} deal${stuckDeals.length !== 1 ? "s" : ""} are stuck in their current stage as of ${new Date().toLocaleDateString()}.</p>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;width:100%">
  <thead><tr style="background:#f5f5f5"><th style="padding:6px 8px;text-align:left">Deal</th><th style="padding:6px 8px;text-align:left">Stage</th><th style="padding:6px 8px;text-align:right">Days Stuck</th><th style="padding:6px 8px;text-align:right">Value</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p style="font-family:sans-serif;color:#666;font-size:12px;margin-top:16px">Sent by USIP Pipeline Alerts</p>`;

    // Send via workspace SMTP (Email Delivery settings — Settings → Email Delivery)
    const { sendSystemEmail } = await import("../emailDelivery");
    const emailResult = await sendSystemEmail(wsId, {
      to: recipientEmail,
      subject: `Pipeline Digest: ${stuckDeals.length} stuck deal${stuckDeals.length !== 1 ? "s" : ""} — ${new Date().toLocaleDateString()}`,
      html,
    });
    if (!emailResult.ok) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: emailResult.reason ?? "Email delivery failed. Please configure Email Delivery SMTP in Settings → Email Delivery.",
      });
    }
    return { ok: true, sent: true, count: stuckDeals.length, recipient: recipientEmail };
  }),

  /** Dismiss every undismissed alert for the whole workspace: a manager's (R37). */
  dismissAll: managerProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const res = await db
      .update(pipelineAlerts)
      .set({ dismissedAt: new Date(), dismissedByUserId: ctx.user.id })
      .where(
        and(
          eq(pipelineAlerts.workspaceId, ctx.workspace.id),
          isNull(pipelineAlerts.dismissedAt),
        ),
      );
    const dismissed = Number(
      affectedRowsOf(res),
    );
    return { ok: true, dismissed };
  }),

  /** Hard-delete every alert row for the workspace (dismissed or not): an admin's (R37). */
  clearAll: adminWsProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const res = await db
      .delete(pipelineAlerts)
      .where(eq(pipelineAlerts.workspaceId, ctx.workspace.id));
    const deleted = Number(
      affectedRowsOf(res),
    );
    return { ok: true, deleted };
  }),
});
