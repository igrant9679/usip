/**
 * Pipeline alerts as a work queue (audit 2026-10-20, U25).
 *
 *   - snooze until a day: the alert stays live but leaves the queue and the
 *     counts until then; "wake now" brings it back; only who may clear it
 *     may snooze it;
 *   - an alert whose deal has new activity after it was raised resolves, and
 *     is held like a snooze so a cause that is still there does not come
 *     straight back; logging a note from the alerts page does it at once;
 *   - the page groups the queue by deal, and every group and card still
 *     opens the deal.
 *
 * Procedures run through the real router against the SQL-evaluating fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "e".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";
import { scanPipelineAlertsForWorkspace } from "./routers/pipelineAlerts";
import { groupAlertsByDeal } from "../client/src/pages/usip/PipelineAlerts";

const WS = 2, ME = 1, OTHER_REP = 3;
const DAY = 86_400_000;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = (userId = ME) => appRouter.createCaller({
  user: { id: userId, openId: `u${userId}`, email: `u${userId}@example.com`, name: "U", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const member = (id: number, userId: number, role: string) =>
  ({ id, workspaceId: WS, userId, role, deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
const deal = (id: number, o: Record<string, unknown> = {}) => rows("opportunities").push({
  id, workspaceId: WS, accountId: 1, name: `Deal ${id}`, stage: "discovery", value: "1000", winProb: 60,
  closeDate: null, pipelineId: 1, daysInStage: 0, stageEnteredAt: new Date(), ownerUserId: ME, ...o,
});
const alert = (id: number, opp: number, type: string, o: Record<string, unknown> = {}) => rows("pipeline_alerts").push({
  id, workspaceId: WS, opportunityId: opp, alertType: type, details: {}, dismissedAt: null, dismissedByUserId: null,
  snoozedUntil: null, resolvedReason: null, createdAt: new Date(Date.now() - 2 * DAY), ...o,
});
const live = () => rows("pipeline_alerts").filter((a) => a.dismissedAt == null).map((a) => `${a.opportunityId}:${a.alertType}`).sort();
/** "YYYY-MM-DD" n days from today, UTC (the test workspace's zone). */
const ymd = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  invalidateStageIndex();
  _clearWorkspaceTimezoneCache();
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: ME, archivedAt: null, plan: "trial" });
  rows("users").push({ id: ME, name: "Me" }, { id: OTHER_REP, name: "Other" });
  rows("workspace_members").push(member(1, ME, "rep"), member(2, OTHER_REP, "rep"));
  rows("crm_pipelines").push({ id: 1, workspaceId: WS, name: "Default", isDefault: true, sortOrder: 0 });
  rows("crm_pipeline_stages").push(
    { id: 11, workspaceId: WS, pipelineId: 1, key: "discovery", label: "Discovery", sortOrder: 10, defaultWinProb: 20, isWon: false, isLost: false },
    { id: 15, workspaceId: WS, pipelineId: 1, key: "signed", label: "Signed", sortOrder: 50, defaultWinProb: 100, isWon: true, isLost: false },
  );
});

describe("U25: snooze until a day", () => {
  beforeEach(() => {
    deal(1);
    deal(2);
    alert(10, 1, "no_champion");
    alert(11, 2, "no_champion");
  });

  it("a snoozed alert leaves the queue and its count, and is listed under Snoozed", async () => {
    const r = await caller().pipelineAlerts.snooze({ alertId: 10, until: ymd(3) });
    expect(new Date(r.snoozedUntil).getTime()).toBeGreaterThan(Date.now());
    expect((await caller().pipelineAlerts.list()).map((a: any) => a.id)).toEqual([11]);
    expect((await caller().pipelineAlerts.list({ limit: 50, snoozed: true })).map((a: any) => a.id)).toEqual([10]);
    expect(await caller().pipelineAlerts.summary()).toMatchObject({ total: 1, snoozed: 1 });
    // Still live: it is not dismissed, and the sweep does not raise a twin.
    expect(live()).toEqual(["1:no_champion", "2:no_champion"]);
    await scanPipelineAlertsForWorkspace(WS);
    expect(live()).toEqual(["1:no_activity", "1:no_champion", "2:no_activity", "2:no_champion"]);
    expect(rows("pipeline_alerts").find((a) => a.id === 10).dismissedAt).toBeNull();
  });

  it("it is back on the queue when the day comes, or at once on Wake now", async () => {
    await caller().pipelineAlerts.snooze({ alertId: 10, until: ymd(3) });
    rows("pipeline_alerts").find((a) => a.id === 10).snoozedUntil = new Date(Date.now() - 1000);
    expect((await caller().pipelineAlerts.list()).map((a: any) => a.id).sort()).toEqual([10, 11]);
    await caller().pipelineAlerts.snooze({ alertId: 10, until: ymd(2) });
    await caller().pipelineAlerts.unsnooze({ alertId: 10 });
    expect((await caller().pipelineAlerts.list()).map((a: any) => a.id).sort()).toEqual([10, 11]);
  });

  it("refuses today or the past, another rep's deal, and an alert already off the queue", async () => {
    await expect(caller().pipelineAlerts.snooze({ alertId: 10, until: ymd(-1) })).rejects.toThrow(/after today/);
    await expect(caller(OTHER_REP).pipelineAlerts.snooze({ alertId: 10, until: ymd(3) })).rejects.toThrow(/owner or a manager/);
    rows("pipeline_alerts").find((a) => a.id === 11).dismissedAt = new Date();
    await expect(caller().pipelineAlerts.snooze({ alertId: 11, until: ymd(3) })).rejects.toThrow(/already off the queue/);
  });
});

describe("U25: new activity on the deal resolves its alerts", () => {
  it("an alert older than the deal's newest activity resolves, held so it does not come straight back", async () => {
    deal(1);
    alert(10, 1, "no_champion");
    rows("activities").push({ id: 1, workspaceId: WS, relatedType: "opportunity", relatedId: 1, type: "call", createdAt: new Date(Date.now() - DAY) });
    const r = await scanPipelineAlertsForWorkspace(WS);
    expect(r.resolved).toBe(1);
    const a = rows("pipeline_alerts").find((x) => x.id === 10);
    expect(a).toMatchObject({ resolvedReason: "activity", dismissedByUserId: null });
    expect(new Date(a.snoozedUntil).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    // Still no champion, but held: the next sweeps raise nothing for it.
    expect((await scanPipelineAlertsForWorkspace(WS)).created).toBe(0);
    expect(live()).toEqual([]);
    // After the hold, it comes back if the cause is still there.
    a.snoozedUntil = new Date(Date.now() - 1000);
    expect((await scanPipelineAlertsForWorkspace(WS)).created).toBe(1);
    expect(live()).toEqual(["1:no_champion"]);
  });

  it("activity from before the alert resolves nothing", async () => {
    deal(1);
    rows("activities").push({ id: 1, workspaceId: WS, relatedType: "opportunity", relatedId: 1, type: "call", createdAt: new Date(Date.now() - 3 * DAY) });
    alert(10, 1, "no_champion");
    expect((await scanPipelineAlertsForWorkspace(WS)).resolved).toBe(0);
    expect(live()).toEqual(["1:no_champion"]);
  });

  it("logging a note from the alerts page takes that deal's alerts off the queue at once", async () => {
    deal(1);
    deal(2);
    alert(10, 1, "no_champion");
    alert(11, 1, "past_close_date");
    alert(12, 2, "no_champion");
    const r = await caller().pipelineAlerts.logActivityOnDeal({ opportunityId: 1, note: "Called the CFO" });
    expect(r.resolved).toBe(2);
    expect(live()).toEqual(["2:no_champion"]);
    expect(rows("pipeline_alerts").filter((a) => a.opportunityId === 1).map((a) => a.resolvedReason)).toEqual(["activity", "activity"]);
  });

  it("a person's dismissal says so", async () => {
    deal(1);
    alert(10, 1, "no_champion");
    await caller().pipelineAlerts.dismiss({ alertId: 10 });
    expect(rows("pipeline_alerts")[0]).toMatchObject({ resolvedReason: "dismissed", dismissedByUserId: ME });
  });
});

describe("U25: the queue is grouped by deal and still opens the deal", () => {
  it("groups by deal, the deal with most alerts first, each deal's newest first", () => {
    const g = groupAlertsByDeal([
      { id: 1, opportunityId: 7, createdAt: "2026-11-01T00:00:00Z" },
      { id: 2, opportunityId: 8, createdAt: "2026-11-05T00:00:00Z" },
      { id: 3, opportunityId: 7, createdAt: "2026-11-03T00:00:00Z" },
    ] as any[]);
    expect(g.map((x) => [x.opportunityId, x.alerts.map((a: any) => a.id)])).toEqual([[7, [3, 1]], [8, [2]]]);
  });

  it("the page renders groups, offers Snooze and Wake now, and keeps the deal links", () => {
    const page = read("client/src/pages/usip/PipelineAlerts.tsx");
    expect(page).toContain("const dealGroups = groupAlertsByDeal(filteredAlerts as any[]);");
    expect(page).toContain("<DealAlertGroup key={g.opportunityId} group={g} onChange={handleRefresh} />");
    expect(page).toContain("<Link href={`/opportunities/${group.opportunityId}`}");
    expect(page).toContain("<Link href={`/opportunities/${alert.opportunityId}`}>");
    expect(page).toContain("snooze.mutate({ alertId: alert.id, until })");
    expect(page).toContain("wake.mutate({ alertId: alert.id })");
    expect(page).toContain("{ limit: 100, snoozed: showSnoozed }");
    expect(read("server/_core/rawMigrations.ts")).toContain("ALTER TABLE `pipeline_alerts` ADD COLUMN `snoozedUntil` timestamp NULL");
  });
});
