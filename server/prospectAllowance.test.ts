/**
 * The monthly prospect-data allowance by membership plan (owner approved
 * 2026-11-25): the shared definitions, the service that meters it, and the
 * one choke point every QuickEnrich email lookup passes.
 *
 *   - NULL plan = unlimited: nothing is counted, nothing is held back
 *   - a request larger than what is left is granted what is left (partial)
 *   - a new UTC month is a new row: the old month's usage does not carry over
 *   - two runs at the last units cannot both take them (conditional UPDATE)
 *   - own keys are never counted; shared (env) and lent keys are
 *   - a failed read is not an answer: shared data stops, own keys go on
 *
 * Real service and real key resolution against the SQL-evaluating fake; only
 * fetch (QuickEnrich's HTTP) is a stub. The wiring at each acquisition point
 * is in prospectAllowanceWiring.test.ts, where it is shown in
 * prospectAllowanceDisplay.test.ts, and the help content in
 * prospectAllowanceCopy.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "d".repeat(64);
  return { db: null as any, beforeUpdate: null as null | ((table: string) => void) };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { encryptSecret } from "./_core/crypto";
import {
  ALLOWANCE_UNKNOWN_REASON,
  MEMBERSHIP_PLANS,
  PLAN_MONTHLY_LIMIT,
  allowancePeriod,
  allowanceSummaryLine,
  allowanceUsedUpReason,
  buildAllowance,
  periodResetsOn,
  resetDayLong,
  resetDayShort,
} from "@shared/prospectAllowance";
import {
  allowanceFor,
  holdAllowance,
  keyOrigin,
  membershipPlanOf,
  refund,
  setMembershipPlan,
  tryConsume,
} from "./services/prospectAllowance";
import { quickenrichFindEmailByLinkedIn } from "./services/quickenrich";

const WS = 5;
const LENDER = 1;
const NOV = new Date("2026-11-25T12:00:00Z");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const settings = (ws: number) => {
  let r = rows("workspace_settings").find((x) => x.workspaceId === ws);
  if (!r) { r = { workspaceId: ws }; rows("workspace_settings").push(r); }
  return r;
};
const usage = (ws = WS, period = "2026-11") => rows("prospect_allowance_usage").find((r) => r.workspaceId === ws && r.period === period)?.used;
const setUsed = (used: number, ws = WS, period = "2026-11") => {
  const r = rows("prospect_allowance_usage").find((x) => x.workspaceId === ws && x.period === period);
  if (r) r.used = used; else rows("prospect_allowance_usage").push({ id: rows("prospect_allowance_usage").length + 1, workspaceId: ws, period, used });
};
const fetchCalls: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOV);
  h.beforeUpdate = null;
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS, beforeUpdate: (t) => h.beforeUpdate?.(t) });
  rows("workspaces").push({ id: WS, name: "Member", slug: "m", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("workspaces").push({ id: LENDER, name: "Platform", slug: "p", ownerUserId: 1, archivedAt: null, plan: "trial" });
  settings(WS);
  settings(LENDER).quickenrichApiKeyEnc = encryptSecret("lender-qe-key");
  delete process.env.QUICKENRICH_API_KEY;
  fetchCalls.length = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify({ data: { email: "pat@acme.example", company_name: "Acme", company_domain: "acme.example" } }), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.QUICKENRICH_API_KEY;
});

describe("the shared definition", () => {
  it("has the five plans and the approved monthly numbers", () => {
    expect([...MEMBERSHIP_PLANS]).toEqual(["trial", "member", "contributor", "steward", "founder"]);
    expect(PLAN_MONTHLY_LIMIT).toEqual({ trial: 250, member: 1000, contributor: 3000, steward: 5000, founder: 6000 });
  });

  it("counts by UTC month and resets on the 1st, December into January", () => {
    expect(allowancePeriod(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11");
    expect(allowancePeriod(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
    expect(periodResetsOn("2026-11")).toBe("2026-12-01");
    expect(periodResetsOn("2026-12")).toBe("2027-01-01");
    expect(resetDayLong("2026-12-01")).toBe("1 December");
    expect(resetDayShort("2026-12-01")).toBe("1 Dec");
  });

  it("says the sentences the design approved", () => {
    const a = buildAllowance("contributor", 412, "2026-11");
    expect(a).toMatchObject({ plan: "contributor", limit: 3000, used: 412, remaining: 2588, resetsOn: "2026-12-01" });
    expect(allowanceSummaryLine(a)).toBe("Prospect data is included with your plan: 412 of 3,000 used this month · resets 1 Dec");
    expect(allowanceUsedUpReason(buildAllowance("contributor", 3000, "2026-11")))
      .toBe("Prospect data for this month is used up (3,000 of 3,000). It resets on 1 December. Add your own key under Data sources to keep going.");
  });
});

describe("no plan is unlimited and uncounted", () => {
  it("grants the whole ask, writes no usage row, and reads as no plan", async () => {
    expect(await membershipPlanOf(WS)).toBeNull();
    expect(await allowanceFor(WS)).toEqual({ plan: null });
    expect(await tryConsume(WS, 5000)).toBe(5000);
    const hold = await holdAllowance(WS, "quickenrich", 40);
    expect(hold).toMatchObject({ metered: false, granted: 40, reason: null });
    await hold.settle(40);
    expect(rows("prospect_allowance_usage")).toEqual([]);
  });
});

describe("tryConsume", () => {
  beforeEach(() => { settings(WS).membershipPlan = "trial"; });

  it("grants what is left when the ask is larger, then nothing", async () => {
    setUsed(240);
    expect(await tryConsume(WS, 25)).toBe(10);
    expect(usage()).toBe(250);
    expect(await tryConsume(WS, 1)).toBe(0);
    expect(usage()).toBe(250);
    expect(await allowanceFor(WS)).toMatchObject({ plan: "trial", limit: 250, used: 250, remaining: 0 });
  });

  it("makes the month's row on first use", async () => {
    expect(await tryConsume(WS, 3)).toBe(3);
    expect(rows("prospect_allowance_usage").filter((r) => r.workspaceId === WS)).toHaveLength(1);
    expect(usage()).toBe(3);
  });

  it("a new month is a new row with the whole allowance; the old month is left as it was", async () => {
    setUsed(250);
    expect(await tryConsume(WS, 5)).toBe(0);
    vi.setSystemTime(new Date("2026-12-01T00:00:01Z"));
    expect(await tryConsume(WS, 5)).toBe(5);
    expect(usage(WS, "2026-11")).toBe(250);
    expect(usage(WS, "2026-12")).toBe(5);
    expect(await allowanceFor(WS)).toMatchObject({ period: "2026-12", used: 5, remaining: 245, resetsOn: "2027-01-01" });
  });

  it("never passes the limit when another run takes units between the read and the write", async () => {
    setUsed(240);
    // Another run takes 8 of the last 10 just before this run's UPDATE lands.
    let raced = false;
    h.beforeUpdate = (t) => {
      if (t !== "prospect_allowance_usage" || raced) return;
      raced = true;
      rows("prospect_allowance_usage").find((r) => r.workspaceId === WS).used += 8;
    };
    const granted = await tryConsume(WS, 10);
    // Its conditional UPDATE matched no row; it read again and took the 2 left.
    expect(granted).toBe(2);
    expect(usage()).toBe(250);
  });

  it("two runs asking at once share what is left and never overspend", async () => {
    setUsed(244);
    const [a, b] = await Promise.all([tryConsume(WS, 5), tryConsume(WS, 5)]);
    expect(a + b).toBe(6);
    expect(usage()).toBe(250);
  });

  it("holds the conditional UPDATE in SQL, not in a read the caller trusts", () => {
    const src = readFileSync(join(__dirname, "services/prospectAllowance.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function tryConsume"), src.indexOf("export async function refund"));
    expect(fn).toContain("lte(prospectAllowanceUsage.used, limit - take)");
    expect(fn).toContain("if (affectedRowsOf(res) > 0) return take;");
  });
});

describe("refund and settle", () => {
  beforeEach(() => { settings(WS).membershipPlan = "member"; });

  it("refund gives units back and never goes below zero", async () => {
    setUsed(10);
    await refund(WS, 4);
    expect(usage()).toBe(6);
    await refund(WS, 50);
    expect(usage()).toBe(0);
  });

  it("a hold counts only what was delivered, and settles once", async () => {
    process.env.QUICKENRICH_API_KEY = "env-qe-key";
    settings(WS).sharedQuickenrichKey = true;
    const hold = await holdAllowance(WS, "quickenrich", 30);
    expect(hold).toMatchObject({ metered: true, granted: 30, reason: null });
    expect(usage()).toBe(30);
    await hold.settle(12);
    expect(usage()).toBe(12);
    await hold.settle(0);
    expect(usage()).toBe(12);
  });

  it("a short grant says why, in the shrink sentence; none left says used up", async () => {
    process.env.QUICKENRICH_API_KEY = "env-qe-key";
    settings(WS).sharedQuickenrichKey = true;
    setUsed(995);
    const part = await holdAllowance(WS, "quickenrich", 25);
    expect(part.granted).toBe(5);
    expect(part.reason).toBe("Only 5 of the 25 asked for fit in this month's prospect data (1,000 of 1,000 used; it resets on 1 December).");
    const none = await holdAllowance(WS, "quickenrich", 25);
    expect(none).toMatchObject({ metered: true, granted: 0 });
    expect(none.reason).toBe("Prospect data for this month is used up (1,000 of 1,000). It resets on 1 December. Add your own key under Data sources to keep going.");
  });
});

describe("whose key decides whether it counts", () => {
  beforeEach(() => { settings(WS).membershipPlan = "trial"; });

  it("the workspace's own key is never counted", async () => {
    settings(WS).quickenrichApiKeyEnc = encryptSecret("own-qe-key");
    expect(await keyOrigin(WS, "quickenrich")).toBe("own");
    const hold = await holdAllowance(WS, "quickenrich", 300);
    expect(hold).toMatchObject({ metered: false, granted: 300 });
    expect(rows("prospect_allowance_usage")).toEqual([]);
  });

  it("the deployment's shared key is counted where the owner allowed it", async () => {
    process.env.QUICKENRICH_API_KEY = "env-qe-key";
    expect(await keyOrigin(WS, "quickenrich")).toBe("none");
    settings(WS).sharedQuickenrichKey = true;
    expect(await keyOrigin(WS, "quickenrich")).toBe("borrowed");
    expect((await holdAllowance(WS, "quickenrich", 7)).metered).toBe(true);
    expect(usage()).toBe(7);
  });

  it("the deployment's key pasted as the workspace's own is still the platform's account", async () => {
    process.env.QUICKENRICH_API_KEY = "env-qe-key";
    settings(WS).quickenrichApiKeyEnc = encryptSecret("env-qe-key");
    expect(await keyOrigin(WS, "quickenrich", "env-qe-key")).toBe("borrowed");
  });

  it("a key another workspace lends is counted, for the legacy columns and the source rows alike", async () => {
    rows("workspace_key_shares").push({ id: 1, ownerWorkspaceId: LENDER, targetWorkspaceId: WS, keyKind: "quickenrich" });
    expect(await keyOrigin(WS, "quickenrich")).toBe("borrowed");
    rows("prospect_source_credentials").push({ id: 1, workspaceId: LENDER, sourceSlug: "warmysender", status: "valid", credentialsEnc: encryptSecret(JSON.stringify({ apiKey: "ws-lender" })), config: {} });
    expect(await keyOrigin(WS, "warmysender")).toBe("none");
    rows("workspace_key_shares").push({ id: 2, ownerWorkspaceId: LENDER, targetWorkspaceId: WS, keyKind: "warmysender" });
    expect(await keyOrigin(WS, "warmysender")).toBe("borrowed");
    rows("prospect_source_credentials").push({ id: 2, workspaceId: WS, sourceSlug: "warmysender", status: "valid", credentialsEnc: encryptSecret(JSON.stringify({ apiKey: "ws-own" })), config: {} });
    expect(await keyOrigin(WS, "warmysender")).toBe("own");
  });

  it("no key at all is not metered: the source finds nothing and says why itself", async () => {
    expect(await keyOrigin(WS, "apollo")).toBe("none");
    expect(await holdAllowance(WS, "apollo", 9)).toMatchObject({ metered: false, granted: 9 });
  });
});

describe("a failed read is not an answer", () => {
  beforeEach(() => {
    process.env.QUICKENRICH_API_KEY = "env-qe-key";
    settings(WS).sharedQuickenrichKey = true;
  });

  it("a stored value that is not a plan stops shared data and is never read as no plan", async () => {
    settings(WS).membershipPlan = "gold";
    await expect(membershipPlanOf(WS)).rejects.toThrow(/not a plan/);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const hold = await holdAllowance(WS, "quickenrich", 10);
    expect(hold).toMatchObject({ metered: true, granted: 0, reason: ALLOWANCE_UNKNOWN_REASON });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("an unreadable plan stops shared data, loudly, and leaves the workspace's own key alone", async () => {
    const realSelect = h.db.select;
    const failFirst = () => {
      let n = 0;
      h.db.select = (...a: unknown[]) => { if (n++ === 0) throw new Error("connection lost"); return realSelect(...a); };
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    failFirst();
    expect(await holdAllowance(WS, "quickenrich", 10)).toMatchObject({ metered: true, granted: 0, reason: ALLOWANCE_UNKNOWN_REASON });
    expect(String(err.mock.calls[0]?.[0] ?? "")).toMatch(/could not read the membership plan of workspace 5/);
    settings(WS).quickenrichApiKeyEnc = encryptSecret("own-qe-key");
    failFirst();
    expect(await holdAllowance(WS, "quickenrich", 10)).toMatchObject({ metered: false, granted: 10 });
    h.db.select = realSelect;
    err.mockRestore();
  });
});

describe("the setter", () => {
  it("sets and clears a plan, returns what it replaced, and refuses a value that is not a plan", async () => {
    expect(await setMembershipPlan(WS, "steward")).toEqual({ previous: null, plan: "steward" });
    expect(await membershipPlanOf(WS)).toBe("steward");
    expect(await setMembershipPlan(WS, null)).toEqual({ previous: "steward", plan: null });
    expect(await membershipPlanOf(WS)).toBeNull();
    await expect(setMembershipPlan(WS, "gold" as never)).rejects.toThrow(/not a membership plan/);
    // A workspace with no settings row gets one.
    rows("workspaces").push({ id: 9, name: "New", slug: "n", ownerUserId: 1, archivedAt: null, plan: "trial" });
    await setMembershipPlan(9, "founder");
    expect(await membershipPlanOf(9)).toBe("founder");
  });
});

describe("every QuickEnrich email lookup passes the allowance", () => {
  const lookup = () => quickenrichFindEmailByLinkedIn("lent-or-shared-key", "https://www.linkedin.com/in/pat", { workspaceId: WS, feature: "test" });

  beforeEach(() => { settings(WS).membershipPlan = "trial"; });

  it("an email found on a borrowed key is one unit", async () => {
    setUsed(100);
    const r = await lookup();
    expect(r.reason).toBe("found");
    expect(usage()).toBe(101);
    expect(fetchCalls).toHaveLength(1);
  });

  it("a miss costs nothing", async () => {
    setUsed(100);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const r = await lookup();
    expect(r.reason).toBe("no_match");
    expect(usage()).toBe(100);
  });

  it("used up, nothing is asked and the reason is not a verdict about the person", async () => {
    setUsed(250);
    const r = await lookup();
    expect(r).toMatchObject({ email: null, reason: "allowance_exhausted" });
    expect(r.note).toMatch(/^Prospect data for this month is used up \(250 of 250\)/);
    expect(fetchCalls).toEqual([]);
    expect(usage()).toBe(250);
  });

  it("the workspace's own key looks up whatever the month says", async () => {
    setUsed(250);
    settings(WS).quickenrichApiKeyEnc = encryptSecret("own-qe-key");
    const r = await quickenrichFindEmailByLinkedIn("own-qe-key", "https://www.linkedin.com/in/pat", { workspaceId: WS, feature: "test" });
    expect(r.reason).toBe("found");
    expect(usage()).toBe(250);
  });
});
