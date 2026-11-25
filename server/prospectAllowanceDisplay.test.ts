/**
 * Where the monthly prospect-data allowance is SHOWN (owner approved
 * 2026-11-25): the line under Run discovery, Home's attention panel at 100%,
 * the launchers' budgets, Settings → Data sources (spend.allowance), and the
 * platform owner's plan picker (spend.setMembershipPlan / spend.platform).
 *
 * Real routers and services against the SQL-evaluating fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "f".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { buildAllowance } from "@shared/prospectAllowance";
import { launcherBudgetLine, type SourceBudgets } from "@shared/spendPreview";
import { sourceBudgets } from "./services/sourceBudgets";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

const WS = 5;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const settings = () => rows("workspace_settings").find((r) => r.workspaceId === WS);
const setUsed = (used: number) => {
  rows("prospect_allowance_usage").length = 0;
  rows("prospect_allowance_usage").push({ id: 1, workspaceId: WS, period: new Date().toISOString().slice(0, 7), used });
};

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  rows("workspaces").push({ id: WS, name: "Member", slug: "m", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("workspace_settings").push({ workspaceId: WS, membershipPlan: "trial" });
});

describe("the line under Run discovery", () => {
  it("puts the allowance first on the launchers' line, and only where a database runs", () => {
    const b = {
      apollo: { configured: true, allowance: { used: 0, cap: 50 } },
      quickenrich: { configured: true, allowance: { used: 0, cap: 50 } },
      linkedin: { accounts: 0, left: 0, cap: 0 },
      reoon: { configured: false, keySource: null, allowance: null },
      ai: { used: 0, cap: null },
      prospectData: buildAllowance("member", 1000, "2026-11"),
      labels: { quickenrich: "Source 2", apollo: "Source 3" },
    } satisfies SourceBudgets;
    expect(launcherBudgetLine(["quickenrich"], b)).toMatch(/^Prospect data: used up this month \(1,000 of 1,000\), resets 1 Dec; only your own keys run · Source 2/);
    expect(launcherBudgetLine(["linkedin"], b)).not.toContain("Prospect data");
    expect(launcherBudgetLine(["apollo"], { ...b, prospectData: buildAllowance("member", 400, "2026-11") })).toMatch(/^Prospect data: 600 of 1,000 left this month · Source 3/);
    expect(launcherBudgetLine(["apollo"], { ...b, prospectData: null })).toMatch(/^Source 3/);
    // Without the server's labels a source is "Prospect source", never a vendor.
    expect(launcherBudgetLine(["apollo"], { ...b, prospectData: null, labels: undefined })).toMatch(/^Prospect source: /);
  });
});

describe("where the allowance is shown", () => {
  const caller = (role: "admin" | "user" = "user") => appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);

  it("Home's attention panel has one item at 100%, and none below it or with no plan", async () => {
    setUsed(249);
    expect((await caller().attention.summary()).prospectDataUsedUp).toBeNull();
    const before = (await caller().attention.summary()).totalNeedingYou;
    setUsed(250);
    const s = await caller().attention.summary();
    expect(s.prospectDataUsedUp).toMatchObject({ used: 250, limit: 250, planLabel: "Trial" });
    expect(s.prospectDataUsedUp!.message).toMatch(/^Prospect data for this month is used up \(250 of 250\)/);
    expect(s.totalNeedingYou).toBe(before + 1);
    settings().membershipPlan = null;
    expect((await caller().attention.summary()).prospectDataUsedUp).toBeNull();
  });

  it("the launchers' budgets and Settings → Data sources read the same figure", async () => {
    setUsed(40);
    const b = await sourceBudgets(WS, 1, true);
    expect(b.prospectData).toMatchObject({ plan: "trial", used: 40, limit: 250, remaining: 210 });
    expect(await caller().spend.allowance()).toMatchObject({ plan: "trial", used: 40, remaining: 210 });
    settings().membershipPlan = null;
    expect((await sourceBudgets(WS, 1, true)).prospectData).toBeNull();
    expect(await caller().spend.allowance()).toEqual({ plan: null });
  });

  it("only the platform owner sets a plan, to a real one, and the platform screen shows it", async () => {
    await expect(caller("user").spend.setMembershipPlan({ workspaceId: WS, plan: "founder" })).rejects.toThrow();
    await expect(caller("admin").spend.setMembershipPlan({ workspaceId: WS, plan: "gold" as never })).rejects.toThrow();
    expect(settings().membershipPlan).toBe("trial");
    expect(await caller("admin").spend.setMembershipPlan({ workspaceId: WS, plan: "founder" })).toEqual({ ok: true, plan: "founder" });
    expect(settings().membershipPlan).toBe("founder");
    setUsed(12);
    const p = await caller("admin").spend.platform({ days: 7 });
    expect(p.workspaces.find((w) => w.id === WS)?.allowance).toMatchObject({ plan: "founder", used: 12, limit: 6000 });
    await caller("admin").spend.setMembershipPlan({ workspaceId: WS, plan: null });
    expect(settings().membershipPlan).toBeNull();
  });
});
