/**
 * The paid vendor searches pair each sector's titles with its own industries
 * and places too (audit 2026-10-20, F37 — the remainder RESA left).
 *
 * RESA built discovery's rotating queries per researched sector. The vendor
 * searches (Apollo, QuickEnrich, LeadOcean, WarmySender) still took the union
 * of every sector's lists, so Apollo searched school superintendents in
 * county government. They now take one sector per run, in turn, so each
 * vendor is still asked once a run and its daily cap is spent no faster; each
 * sector keeps its own page cursor.
 *
 * Runs the real engine's runDiscovery against the SQL-evaluating fake.
 * Apollo and QuickEnrich are mocked at their HTTP-calling functions, so no
 * vendor is called; the other sources are masked off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "c".repeat(64);
  return { db: null as any, apollo: [] as any[], qe: [] as any[] };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./services/apollo", async (a) => ({
  ...(await a<typeof import("./services/apollo")>()),
  getApolloDailyCap: async () => 100,
  apolloPulledToday: async () => 0,
  apolloSearchPeople: async (_ws: number, input: any) => { h.apollo.push(input); return { ok: true, prospects: [], totalAvailable: 0, pageCount: 0 }; },
}));
vi.mock("./services/quickenrich", async (a) => ({
  ...(await a<typeof import("./services/quickenrich")>()),
  getQuickEnrichKey: async () => "qe-test",
  getQuickenrichDailyPullCap: async () => 100,
  quickenrichPulledToday: async () => 0,
  getQuickenrichIndustries: async () => null,
  quickenrichContactFinder: async (_k: string, body: any) => { h.qe.push(body); return { ok: true, people: [] }; },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { runDiscovery, __resetEngineLogRepeatsForTests } from "./areEngine";
import { sliceGroupKey, vendorGroupFor } from "./services/research/targetingPrior";
import { cleanSectorContent } from "@shared/researchShape";

const WS = 2, CAMPAIGN = 7;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const SCHOOLS = { titles: ["Superintendent", "CFO"], industries: ["Primary/Secondary Education"], geographies: ["Ohio"], keywords: [] as string[] };
const COUNTIES = { titles: ["County Administrator"], industries: ["Government Administration"], geographies: ["Virginia"], keywords: [] as string[] };

/** The campaign as the engine passes it, with its stored state "later": nothing resting. */
const campaign = () => {
  const c = rows("are_campaigns").find((x) => x.id === CAMPAIGN);
  const st = c.discoveryQueryState;
  const state = st ? { ...st, lastRunAt: 0, src: {}, slices: (st.slices ?? []).map((s: any) => ({ ...s, nextAt: null })) } : null;
  return { ...c, discoveryQueryState: state };
};
const sector = (id: number, t: typeof SCHOOLS) => {
  const content = cleanSectorContent({ name: `S${id}`, status: "researched", targeting: t }).content;
  rows("research_sectors").push({ id, workspaceId: WS, marketId: 1, revision: 1, ...content, source: "manual", sourceRef: null });
};

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.apollo = []; h.qe = [];
  __resetEngineLogRepeatsForTests();
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("workspace_settings").push({
    workspaceId: WS, areSourceOrder: null, icpFallback: "research",
    areScraperSources: { quickenrich: true, apollo: true, warmysender: false, linkedin: false, google_business: false, news: false, leadocean: false, internal: false },
  });
});

describe("with researched sectors, each vendor search takes one sector, in turn", () => {
  beforeEach(() => {
    sector(1, SCHOOLS);
    sector(2, COUNTIES);
    rows("are_campaigns").push({
      id: CAMPAIGN, workspaceId: WS, name: "Public sector", status: "active", targetProspectCount: 10,
      prospectSources: ["apollo", "quickenrich"], icpOverrides: {}, discoveryQueryState: null, researchSectorId: null, researchPersonaId: null,
    });
  });

  it("never pairs one sector's titles with another's industries, and asks each vendor once a run", async () => {
    for (let i = 0; i < 3; i++) await runDiscovery(campaign() as never, 5);
    expect(h.apollo).toHaveLength(3);
    // QuickEnrich asks twice when a state search by area finds nobody (area,
    // then the states' country), as it always has: two a run, never more.
    expect(h.qe).toHaveLength(6);
    expect(h.apollo.map((a) => [a.titles, a.industries, a.locations])).toEqual([
      [SCHOOLS.titles, SCHOOLS.industries, SCHOOLS.geographies],
      [COUNTIES.titles, COUNTIES.industries, COUNTIES.geographies],
      [SCHOOLS.titles, SCHOOLS.industries, SCHOOLS.geographies],
    ]);
    // QuickEnrich's searches name only that run's sector.
    const qe = h.qe.map((b) => JSON.stringify(b));
    for (const i of [0, 1, 4, 5]) {
      expect(qe[i]).toContain("Superintendent");
      expect(qe[i]).not.toContain("County Administrator");
    }
    for (const i of [2, 3]) {
      expect(qe[i]).toContain("County Administrator");
      expect(qe[i]).not.toContain("Superintendent");
    }
  });

  it("remembers the sector it took and keeps a page cursor per sector", async () => {
    await runDiscovery(campaign() as never, 5);
    await runDiscovery(campaign() as never, 5);
    const st = rows("are_campaigns")[0].discoveryQueryState;
    const keys = [SCHOOLS, COUNTIES].map((s) => sliceGroupKey({ titles: s.titles, industries: s.industries, geos: s.geographies, keywords: s.keywords }));
    expect(st.vg).toBe(keys[1]);
    expect(Object.keys(st.vgc).sort()).toEqual([...keys].sort());
    // The flat cursors are left alone while groups are in use.
    expect(st.ap ?? null).toBeNull();
    expect(rows("are_engine_logs").some((l) => /Vendor searches this run use researched group 2 of 2/.test(String(l.message)))).toBe(true);
  });
});

describe("without per-sector groups the vendors take the combined lists, as before", () => {
  it("a campaign that sets its own titles, industries and places", async () => {
    sector(1, SCHOOLS);
    sector(2, COUNTIES);
    rows("are_campaigns").push({
      id: CAMPAIGN, workspaceId: WS, name: "Own", status: "active", targetProspectCount: 10, prospectSources: ["apollo"],
      icpOverrides: { targetTitles: ["Grants Manager", "Development Director"], targetIndustries: ["Nonprofit Organization Management"], targetGeographies: ["Ohio"] },
      discoveryQueryState: null, researchSectorId: null, researchPersonaId: null,
    });
    await runDiscovery(campaign() as never, 5);
    await runDiscovery(campaign() as never, 5);
    expect(h.apollo.map((a) => a.titles)).toEqual([["Grants Manager", "Development Director"], ["Grants Manager", "Development Director"]]);
    expect(rows("are_campaigns")[0].discoveryQueryState.vg ?? null).toBeNull();
  });
});

describe("the turn", () => {
  const g = (t: string) => ({ titles: [t], industries: [], geos: [], keywords: [] });
  it("goes round by key, and a new group joins the turn without restarting it", () => {
    const groups = [g("A"), g("B"), g("C")];
    expect(vendorGroupFor(groups, null)!.index).toBe(0);
    expect(vendorGroupFor(groups, sliceGroupKey(groups[0]))!.index).toBe(1);
    expect(vendorGroupFor(groups, sliceGroupKey(groups[2]))!.index).toBe(0);
    // B was last; a sector inserted before it does not send the turn back to A.
    expect(vendorGroupFor([g("Z"), ...groups], sliceGroupKey(groups[1]))!.group.titles).toEqual(["C"]);
    // A key no longer present starts at the first.
    expect(vendorGroupFor(groups, "gone")!.index).toBe(0);
    expect(vendorGroupFor(null, "x")).toBeNull();
  });
  it("a group's key does not depend on list order or case", () => {
    expect(sliceGroupKey({ titles: ["CFO", "Superintendent"], industries: ["X"], geos: [], keywords: [] }))
      .toBe(sliceGroupKey({ titles: ["superintendent", "cfo"], industries: ["x"], geos: [], keywords: [] }));
  });
});
