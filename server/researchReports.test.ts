/**
 * Research reports (owner, 2026-10-15: "I should be able to see a full set of
 * reports like you see in the Downstream app"; chose "Research reports"). The
 * report math is pure (@shared/researchReports); the endpoint gathers one
 * market's research, in its own workspace only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, wsId: 2 }));
vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { cleanMarketContent, cleanSectorContent } from "@shared/researchShape";
import {
  DEFAULT_WEIGHTS, cleanWeights, competitorsByCategory, headlineFigure, intermediaries, openQuestions,
  programsByAgency, scorecard, sourceCounts, statusCounts, weightedScore,
} from "@shared/researchReports";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const sector = (id: number, over: Record<string, unknown>) => ({ id, content: cleanSectorContent({ name: `Sector ${id}`, ...over }).content });

const COUNTIES = sector(1, {
  name: "County governments",
  status: "researched",
  scores: { reach: 4, money: 2, pain: 4, fit: 5, access: 3 },
  facts: {
    marketSize: [{ value: "", label: "blank", source: "" }, { value: "3,069", label: "county governments", source: "https://www.naco.org/a" }],
    programs: [
      { name: "SLCGP", agency: "FEMA", flow: "State pass-through", purpose: "Cyber", typicalAward: "$50k", url: "https://fema.gov/slcgp" },
      { name: "ARPA SLFRF", agency: "Treasury", flow: "Direct", purpose: "Recovery", typicalAward: "", url: "" },
    ],
    moneyFlow: { sources: ["Property tax"], intermediaries: [{ name: "States", role: "Pass state funds through", count: "50" }], recipients: [] },
  },
  openQuestions: ["How many counties under 250k?"],
  sources: [{ title: "NACo", url: "https://www.naco.org/a/" }, { title: "FEMA", url: "https://fema.gov/slcgp" }],
});
const CITIES = sector(2, {
  name: "City governments",
  status: "draft",
  scores: { reach: 5, money: null, pain: 2, fit: 3, access: 4 },
  facts: {
    programs: [
      { name: "slcgp", agency: "fema", flow: "", purpose: "", typicalAward: "", url: "" },
      { name: "Unnamed agency grant", agency: "", flow: "", purpose: "", typicalAward: "", url: "" },
    ],
    moneyFlow: { sources: [], intermediaries: [{ name: "states", role: "", count: "" }, { name: "Councils of government", role: "", count: "" }], recipients: [] },
  },
  sources: [{ title: "NACo again", url: "HTTPS://WWW.NACO.ORG/a" }],
});
const UNSCORED = sector(3, { name: "Special districts", status: "verified" });
const MARKET = { id: 1, content: cleanMarketContent({
  name: "State and local government",
  openQuestions: ["Which co-ops cover web work?"],
  sources: [{ title: "Census", url: "https://census.gov/x" }],
  competitors: [
    { name: "CivicPlus", category: "Platform", positioning: "Websites", pricing: "", url: "" },
    { name: "Granicus", category: "Platform", positioning: "", pricing: "", url: "" },
    { name: "accessiBe", category: "Overlay", positioning: "", pricing: "", url: "" },
    { name: "Freelancers", category: "", positioning: "", pricing: "", url: "" },
  ],
}).content };

describe("the scorecard", () => {
  it("averages the set scores by weight, out of 100; an unset score is left out, not counted as zero", () => {
    expect(weightedScore(COUNTIES.content.scores, DEFAULT_WEIGHTS)).toBe(72); // 18 of 25
    expect(weightedScore(CITIES.content.scores, DEFAULT_WEIGHTS)).toBe(70); // 14 of 20, money unset
    expect(weightedScore({ ...COUNTIES.content.scores }, { ...DEFAULT_WEIGHTS, fit: 3 })).toBe(80); // (4+2+4+15+3) / 35
    expect(weightedScore(UNSCORED.content.scores, DEFAULT_WEIGHTS)).toBeNull();
    expect(weightedScore(COUNTIES.content.scores, { reach: 0, money: 0, pain: 0, fit: 0, access: 0 })).toBeNull();
  });

  it("ranks highest first, unscored last; weights come back from storage only as offered choices", () => {
    expect(scorecard([UNSCORED, CITIES, COUNTIES], DEFAULT_WEIGHTS).map((s) => [s.content.name, s.score])).toEqual([
      ["County governments", 72], ["City governments", 70], ["Special districts", null],
    ]);
    expect(scorecard([COUNTIES, CITIES], { ...DEFAULT_WEIGHTS, reach: 3 }).map((s) => s.id)).toEqual([2, 1]);
    expect(cleanWeights({ reach: 3, money: 9, pain: "2", fit: -1 })).toEqual({ reach: 3, money: 1, pain: 2, fit: 1, access: 1 });
    expect(cleanWeights(null)).toEqual(DEFAULT_WEIGHTS);
  });
});

describe("the overview and the funders", () => {
  it("a sector card leads with its first figure that has a value", () => {
    expect(headlineFigure(COUNTIES.content)).toEqual({ value: "3,069", label: "county governments" });
    expect(headlineFigure(UNSCORED.content)).toBeNull();
    expect(statusCounts([COUNTIES, CITIES, UNSCORED])).toEqual({ draft: 1, researched: 1, verified: 1 });
  });

  it("each program once, with every sector that names it, grouped by agency; an unnamed agency last", () => {
    const g = programsByAgency([COUNTIES, CITIES]);
    expect(g.map((x) => [x.agency, x.programs.map((p) => [p.name, p.sectors])])).toEqual([
      ["FEMA", [["SLCGP", ["County governments", "City governments"]]]],
      ["Treasury", [["ARPA SLFRF", ["County governments"]]]],
      ["Agency not named", [["Unnamed agency grant", ["City governments"]]]],
    ]);
  });

  it("each intermediary once, the most shared first", () => {
    expect(intermediaries([COUNTIES, CITIES]).map((i) => [i.name, i.sectors.length])).toEqual([["States", 2], ["Councils of government", 1]]);
  });
});

describe("sources, questions and competitors", () => {
  it("counts each page's sources, and distinct links across all of them", () => {
    const s = sourceCounts(MARKET, [COUNTIES, CITIES]);
    expect(s.pages.map((p) => [p.kind, p.name, p.sources])).toEqual([["market", "State and local government", 1], ["sector", "County governments", 2], ["sector", "City governments", 1]]);
    expect(s.distinct).toBe(3); // census, naco (three spellings), fema
  });

  it("every open question, with the page it belongs to", () => {
    expect(openQuestions(MARKET, [COUNTIES, CITIES])).toEqual([
      { kind: "market", id: 1, name: "State and local government", question: "Which co-ops cover web work?" },
      { kind: "sector", id: 1, name: "County governments", question: "How many counties under 250k?" },
    ]);
  });

  it("competitors grouped by category, the largest first, uncategorised last", () => {
    expect(competitorsByCategory(MARKET.content).map((g) => [g.category, g.competitors.length])).toEqual([["Platform", 2], ["Overlay", 1], ["Other", 1]]);
  });
});

/* ── The endpoint ───────────────────────────────────────────────────────── */

function caller(ws: number) {
  h.wsId = ws;
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

describe("a market's reports", () => {
  beforeEach(() => {
    h.db = makeSqlFakeDb({ roles: { 2: "rep", 4: "admin" }, wsId: () => h.wsId });
    const db = h.db;
    db.rowsOf("users").push({ id: 1, name: "Idris", email: "i@x.com" });
    db.rowsOf("research_markets").push({ id: 1, workspaceId: 2, ...MARKET.content }, { id: 5, workspaceId: 4, ...MARKET.content, name: "Theirs" });
    db.rowsOf("research_sectors").push(
      { id: 1, workspaceId: 2, marketId: 1, ...COUNTIES.content },
      { id: 2, workspaceId: 2, marketId: 1, ...CITIES.content },
      { id: 7, workspaceId: 4, marketId: 5, ...COUNTIES.content },
    );
    db.rowsOf("personas").push(
      { id: 36, workspaceId: 2, name: "County Administrator", sectorId: 1, cares: "Budget", pains: ["Staff"], objections: [], angle: "Fixed scope", email: "never@x.com" },
      { id: 37, workspaceId: 2, name: "No sector", sectorId: null, cares: "", pains: [], objections: [], angle: "" },
    );
    const run = (o: Record<string, unknown>) => ({ userId: 1, subject: "S", status: "done", outcome: "accepted", costUsd: "1", searches: 1, fetches: 1, createdAt: new Date(), ...o });
    db.rowsOf("research_jobs").push(
      run({ id: 10, workspaceId: 2, kind: "market", marketId: null, resultId: 1, brief: "Created the market", createdAt: new Date("2026-10-13") }),
      run({ id: 11, workspaceId: 2, kind: "sector", marketId: 1, sectorId: null, resultId: 1, brief: "County brief", createdAt: new Date("2026-10-14"), removedAt: new Date() }),
      run({ id: 12, workspaceId: 2, kind: "sector", marketId: 9, resultId: 3, brief: "Another market's sector" }),
      run({ id: 13, workspaceId: 4, kind: "sector", marketId: 1, brief: "Another workspace's" }),
    );
  });

  it("gathers the market, its sectors, their personas' research and every run, removed ones included", async () => {
    const r = await caller(2).research.reports.market({ id: 1 });
    expect(r.market.content.name).toBe("State and local government");
    expect(r.sectors.map((s) => s.content.name)).toEqual(["City governments", "County governments"]);
    expect(r.personas).toEqual([{ id: 36, name: "County Administrator", sectorId: 1, cares: "Budget", pains: ["Staff"], objections: [], angle: "Fixed scope" }]);
    expect(r.runs.map((x) => [x.id, x.brief, x.byName, !!x.removedAt])).toEqual([[11, "County brief", "Idris", true], [10, "Created the market", "Idris", false]]);
  });

  it("is the workspace's own: another workspace's market is not found", async () => {
    await expect(caller(2).research.reports.market({ id: 5 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(4).research.reports.market({ id: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(2).research.reports.results({ marketId: 5 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("results tally each sector's prospects", async () => {
    const db = h.db;
    db.rowsOf("prospect_intelligence").push({ id: 1, prospectQueueId: 100, workspaceId: 2, researchSectorId: 1 }, { id: 2, prospectQueueId: 101, workspaceId: 2, researchSectorId: 1 });
    db.rowsOf("are_execution_queue").push({ id: 1, workspaceId: 2, prospectQueueId: 100, status: "sent", stepIndex: 0, messageContent: { body: "Hi" } });
    db.rowsOf("are_signal_log").push({ workspaceId: 2, prospectQueueId: 100, signalType: "email_reply", sentiment: "positive" });
    expect(await caller(2).research.reports.results({ marketId: 1 })).toEqual({ 1: { written: 2, contacted: 1, replied: 1, positive: 1, meetings: 0, capped: false } });
  });

  it("the report pages are reachable, and the editor pages link to them", () => {
    const app = read("client/src/App.tsx");
    expect(app.indexOf('path="/research/markets/:id/report/:section"')).toBeLessThan(app.indexOf('path="/research/markets/:id"'));
    expect(app).toContain('<Route path="/research/sectors/:id/report"><AuthGate><ResearchSectorReport /></AuthGate></Route>');
    expect(read("client/src/pages/usip/research/ResearchMarket.tsx")).toContain("href={`/research/markets/${id}/report`}");
    expect(read("client/src/pages/usip/research/ResearchSector.tsx")).toContain("href={`/research/sectors/${id}/report`}");
    expect(read("client/src/pages/usip/research/ResearchHome.tsx")).toContain("href={`/research/markets/${m.id}/report`}");
  });
});
