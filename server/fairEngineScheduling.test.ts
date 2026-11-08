/**
 * Fair engine scheduling (audit 2026-10-20, F13).
 *
 * Campaigns ticked in table order, so a workspace with many busy campaigns
 * went first on every tick and the rest waited behind it; a tick that ran
 * long made the cron skip, and the campaigns at the end of the order waited
 * longest every time. Now campaigns go one workspace at a time in turn (each
 * workspace's campaigns in turn, both rotating), a tick stops starting
 * campaigns once its budget is spent, and the ones it did not reach go first
 * next tick. A step put back unsent for lack of sending capacity counts its
 * tries and waits before it is asked again, instead of heading the page.
 *
 * Already in place before this row (A7/A27/A28, migration 0245): enrichment
 * shared round-robin between workspaces, and enrichment and sequence attempts
 * with a retry time on prospect_queue. Discovery keeps its slower cadence.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DISCOVERY_REST_MS, ENGINE_TICK_BUDGET_MS, __resetFairCursorForTests, dispatchRetryMs, fairCampaignOrder, runCampaignsFairly,
} from "./areEngine";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const A = 2, B = 4;
/** Workspace A has six campaigns, B has one. */
const campaigns = [1, 2, 3, 4, 5, 6].map((id) => ({ id, workspaceId: A })).concat([{ id: 7, workspaceId: B }]);

beforeEach(() => __resetFairCursorForTests());

describe("the order", () => {
  it("takes workspaces in turn, so the small one is second, not seventh", () => {
    expect(fairCampaignOrder(campaigns, 0).map((c) => c.id)).toEqual([1, 7, 2, 3, 4, 5, 6]);
  });
  it("rotates which workspace and which campaign go first", () => {
    expect(fairCampaignOrder(campaigns, 1).map((c) => c.id)).toEqual([7, 2, 3, 4, 5, 6, 1]);
    expect(fairCampaignOrder(campaigns, 2).map((c) => c.id)).toEqual([3, 7, 4, 5, 6, 1, 2]);
  });
  it("puts the campaigns a tick could not reach first in their workspace's turn, and their workspace first", () => {
    expect(fairCampaignOrder(campaigns, 1, [5, 6]).map((c) => c.id)).toEqual([5, 7, 6, 2, 3, 4, 1]);
    expect(fairCampaignOrder(campaigns, 0, [7]).map((c) => c.id)).toEqual([7, 1, 2, 3, 4, 5, 6]);
  });
  it("is every campaign exactly once", () => {
    for (let t = 0; t < 9; t++) expect(fairCampaignOrder(campaigns, t, [3]).map((c) => c.id).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("one busy workspace cannot starve another", () => {
  it("over many ticks, the small workspace's campaign runs every tick, and every busy campaign within two", async () => {
    // Each of A's campaigns takes 3 minutes; B's takes none. Budget: 8 minutes.
    let clock = 0;
    const ranIn: number[][] = [];
    for (let tick = 0; tick < 6; tick++) {
      const r = await runCampaignsFairly(campaigns, async (c) => { clock += c.workspaceId === A ? 3 * 60_000 : 0; }, { now: () => clock, budgetMs: 8 * 60_000 });
      ranIn.push(r.ran);
    }
    for (const ran of ranIn) expect(ran).toContain(7);
    // No busy campaign waits more than one tick past the one it was cut from.
    for (const id of [1, 2, 3, 4, 5, 6]) {
      const ticks = ranIn.map((ran, i) => (ran.includes(id) ? i : -1)).filter((i) => i >= 0);
      expect(ticks.length, `campaign ${id}`).toBeGreaterThanOrEqual(2);
      for (let k = 1; k < ticks.length; k++) expect(ticks[k] - ticks[k - 1], `campaign ${id} gap`).toBeLessThanOrEqual(2);
    }
  });

  it("a tick always runs its first campaign, and stops starting new ones once the budget is spent", async () => {
    let clock = 0;
    const r = await runCampaignsFairly(campaigns, async () => { clock += 20 * 60_000; }, { now: () => clock, budgetMs: 8 * 60_000 });
    expect(r.ran).toEqual([1]);
    expect(r.deferred).toEqual([7, 2, 3, 4, 5, 6]);
    // …and the next tick starts with what was left: B's campaign first.
    const next = await runCampaignsFairly(campaigns, async () => { clock += 20 * 60_000; }, { now: () => clock, budgetMs: 8 * 60_000 });
    expect(next.ran).toEqual([7]);
  });

  it("a person's tick of one workspace leaves the schedule's turn and carry-over alone", async () => {
    let clock = 0;
    await runCampaignsFairly(campaigns, async () => { clock += 20 * 60_000; }, { now: () => clock, budgetMs: 8 * 60_000 });
    // Scoped: B only. It runs, and the schedule still owes A's leftovers first.
    await runCampaignsFairly(campaigns.filter((c) => c.workspaceId === B), async () => {}, { remember: false });
    expect(fairCampaignOrder(campaigns, 1, [7, 2, 3, 4, 5, 6]).map((c) => c.id)[0]).toBe(7);
    const next = await runCampaignsFairly(campaigns, async () => { clock += 20 * 60_000; }, { now: () => clock, budgetMs: 8 * 60_000 });
    expect(next.ran).toEqual([7]);
    expect(read("server/areEngine.ts")).toContain("}, { remember: !scope });");
  });

  it("the engine ticks its campaigns through the fair scheduler, under the budget", () => {
    const eng = read("server/areEngine.ts");
    const fn = eng.slice(eng.indexOf("export async function runAreEngine("), eng.indexOf("/* ─── Global enrichment pass"));
    expect(fn).toContain("const run = await runCampaignsFairly(live, async (campaign) => {");
    expect(fn).not.toContain("for (const campaign of active) {");
    expect(ENGINE_TICK_BUDGET_MS).toBe(8 * 60_000);
  });
});

describe("a step put back unsent waits its turn", () => {
  it("waits 15 minutes, doubling, at most 6 hours", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map((n) => dispatchRetryMs(n) / 60_000)).toEqual([15, 30, 60, 120, 240, 360, 360]);
  });
  it("dispatch skips a step whose wait has not ended, and a capacity hold counts a try and sets the wait", () => {
    const eng = read("server/areEngine.ts");
    const page = eng.slice(eng.indexOf("const duePage = (email: boolean, limit: number) => db"), eng.indexOf(".limit(limit);"));
    expect(page).toContain("or(isNull(areExecutionQueue.nextAttemptAt), lte(areExecutionQueue.nextAttemptAt, new Date())),");
    const hold = eng.slice(eng.indexOf("} else if (sendRes.blocked) {"), eng.indexOf('poolHeld = sendRes.reason ?? "sending capacity exhausted";'));
    expect(hold).toContain("attempts: sql`${areExecutionQueue.attempts} + 1`,");
    expect(hold).toContain("nextAttemptAt: new Date(Date.now() + dispatchRetryMs(Number(step.attempts ?? 0) + 1)),");
    // Still nothing sent and nothing failed: the row stays scheduled.
    expect(hold).toContain('status: "scheduled", failureReason: null, executedAt: null,');
  });
  it("migration 0334 adds the columns, defaulted", () => {
    const m = read("server/_core/rawMigrations.ts");
    expect(m).toContain('name: "0334_execution_queue_attempts.sql"');
    expect(m).toContain("ALTER TABLE `are_execution_queue` ADD COLUMN `attempts` int NOT NULL DEFAULT 0");
    expect(m).toContain("ALTER TABLE `are_execution_queue` ADD COLUMN `nextAttemptAt` timestamp NULL");
  });
});

describe("what was already fair stays", () => {
  it("discovery keeps its own slower rest, and enrichment its round-robin and retry times", () => {
    expect(DISCOVERY_REST_MS).toBe(30 * 60 * 1000);
    const eng = read("server/areEngine.ts");
    expect(eng).toContain("const pending = roundRobinByWorkspace(candidates, ENRICH_PER_TICK);");
    expect(eng).toContain("or(isNull(prospectQueue.enrichRetryAt), lte(prospectQueue.enrichRetryAt, now)),");
  });
});
