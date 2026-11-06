/**
 * The ICP Agent (audit 2026-10-20, batch E2).
 *
 *   A20 a field a person sets by hand survives the next inference; an Override
 *       opened on one version cannot save over a newer one
 *   A21 version history carries each version's lists, so its rows and Compare
 *       have something to show, and an Override is recorded as a version
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, answer: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./routers/are/notify", async (a) => ({ ...(await a<typeof import("./routers/are/notify")>()), areNotify: async () => {} }));
vi.mock("./services/research/targetingPrior", async (a) => ({ ...(await a<typeof import("./services/research/targetingPrior")>()), researchPriorForIcp: async () => "" }));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async () => ({ choices: [{ message: { content: JSON.stringify(h.answer) } }] }),
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { runIcpInference } from "./routers/are/icp";

const WS = 2, OTHER = 9;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const profiles = () => rows("icp_profiles").filter((p) => p.workspaceId === WS);
const active = () => profiles().find((p) => p.isActive);
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

const title = (t: string) => ({ title: t, seniority: "Director", role: "champion", weight: 40 });

beforeEach(() => {
  // 2026-11-06 (audit A36, batch S1c): ICP override, restore and regenerate
  // are a manager's, so the person editing the profile here is one. Nothing
  // below is about who may edit; s1cAreRoles.test.ts pins that a rep can't.
  h.db = makeSqlFakeDb({ roles: { [WS]: "manager" }, wsId: () => WS });
  rows("icp_profiles").push({
    id: 1, workspaceId: WS, version: 1, isActive: true, confidenceScore: 30, sampleWonDeals: 0,
    targetIndustries: [{ industry: "Government", weight: 60, examples: [] }],
    targetTitles: [title("County Administrator")], targetGeographies: [], targetTechStack: [], antiPatterns: [],
    topConversionSignals: [{ signal: "Budget season", correlation_score: 0.4 }],
    targetCompanySizeMin: 50, targetCompanySizeMax: 500, manualOverrides: null, createdAt: new Date(), generatedAt: new Date(),
  });
  rows("icp_profiles").push({ id: 50, workspaceId: OTHER, version: 4, isActive: true, targetTitles: [title("Theirs")], manualOverrides: null });
  h.answer = {
    targetIndustries: [{ industry: "Healthcare", weight: 100, examples: [] }],
    targetCompanySizeMin: 10, targetCompanySizeMax: 90, targetRevenueMin: 0, targetRevenueMax: 0,
    targetTitles: [title("Chief Nursing Officer")], targetGeographies: [], targetTechStack: [], antiPatterns: [],
    topConversionSignals: [], aiRationale: "From the model.",
  };
});

describe("manual edits survive the next inference (A20)", () => {
  it("an Override is a new version, and only the fields it changed are pinned", async () => {
    const r = await caller().are.icp.override({
      baseProfileId: 1,
      targetTitles: ["County Administrator", "IT Director"],
      targetIndustries: ["Government"],
      targetCompanySizeMin: 50,
    });
    expect(r).toMatchObject({ success: true, version: 2, pinned: ["targetTitles"] });
    expect(profiles()).toHaveLength(2);
    expect(profiles().find((p) => p.id === 1).isActive).toBe(false);
    const v2 = active();
    expect(v2.version).toBe(2);
    expect(v2.targetTitles.map((t: any) => t.title ?? t)).toEqual(["County Administrator", "IT Director"]);
    expect(Object.keys(v2.manualOverrides)).toEqual(["targetTitles"]);
    expect(rows("icp_profiles").find((p) => p.id === 50).isActive).toBe(true);
  });

  it("the next inference keeps the pinned field and takes the model's answer for the rest", async () => {
    await caller().are.icp.override({ baseProfileId: 1, targetTitles: ["County Administrator", "IT Director"] });
    await runIcpInference(WS);
    const v3 = active();
    expect(v3.version).toBe(3);
    expect(v3.targetTitles.map((t: any) => t.title ?? t)).toEqual(["County Administrator", "IT Director"]);
    expect(v3.targetIndustries).toEqual(h.answer.targetIndustries);
    expect(v3.targetCompanySizeMin).toBe(10);
    expect(Object.keys(v3.manualOverrides)).toEqual(["targetTitles"]);
  });

  it("with nothing pinned the inference is the model's alone", async () => {
    await runIcpInference(WS);
    expect(active().targetTitles).toEqual(h.answer.targetTitles);
    expect(active().manualOverrides).toBeNull();
  });

  it("Let the AI set these again releases the pins", async () => {
    await caller().are.icp.override({ baseProfileId: 1, targetTitles: ["IT Director"] });
    expect(Object.keys(active().manualOverrides ?? {})).toEqual(["targetTitles"]);
    await caller().are.icp.override({ baseProfileId: active().id, releasePins: true });
    expect(active().manualOverrides).toBeNull();
    await runIcpInference(WS);
    expect(active().targetTitles).toEqual(h.answer.targetTitles);
  });

  it("a dialog opened on an older version cannot save over the new one", async () => {
    await runIcpInference(WS);
    await expect(caller().are.icp.override({ baseProfileId: 1, targetTitles: ["Stale"] })).rejects.toThrow(/changed since you opened this; version 2 is active now/);
    expect(active().targetTitles).toEqual(h.answer.targetTitles);
  });

  it("the dialog is keyed by version and sends the version it opened on", () => {
    const page = read("client/src/pages/usip/AREIcpAgent.tsx");
    expect(page).toContain("<OverrideDialog key={icp.id} icp={icp}");
    expect(page).toContain("baseProfileId: icp?.id,");
    expect(page).not.toContain("The AI will incorporate these overrides in the");
  });
});

describe("version history has each version's lists (A21)", () => {
  it("returns the lists the rows and Compare read", async () => {
    await caller().are.icp.override({ baseProfileId: 1, targetTitles: ["IT Director"] });
    const history = await caller().are.icp.getHistory();
    expect(history.map((v) => v.version)).toEqual([2, 1]);
    const v1 = history.find((v) => v.version === 1)!;
    expect(v1.targetIndustries).toEqual([{ industry: "Government", weight: 60, examples: [] }]);
    expect(v1.topConversionSignals).toEqual([{ signal: "Budget season", correlation_score: 0.4 }]);
    for (const key of ["targetTitles", "targetGeographies", "targetTechStack", "antiPatterns", "manualOverrides"]) {
      expect(Object.keys(v1)).toContain(key);
    }
  });
});
