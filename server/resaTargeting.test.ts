/**
 * The ICP fallback per sector (audit 2026-10-20, F37; 2026-11-07, batch RESA).
 *
 * A campaign that leaves its targeting blank falls back to the researched
 * sectors. The fallback was the union of every sector's lists, so discovery's
 * rotating queries searched one sector's titles with another sector's
 * industries ("Superintendent Government Administration"). Now each sector's
 * titles are searched only with its own industries and places. This file is
 * the rotating queries; the vendor searches (one sector a run, in turn) are
 * vendorSectorPairing.test.ts (2026-11-07, batch ARES).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { buildQuerySlices } from "./areEngine";
import { perSectorSliceGroups, researchTargeting } from "./services/research/targetingPrior";
import { cleanSectorContent } from "@shared/researchShape";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const SCHOOLS = { titles: ["Superintendent", "CFO"], industries: ["Primary/Secondary Education"], geographies: ["Ohio"], keywords: [] as string[] };
const COUNTIES = { titles: ["County Administrator"], industries: ["Government Administration"], geographies: ["Virginia"], keywords: ["County of"] };
const NONE = { titles: [], industries: [], geos: [], keywords: [] };
const ICP = { titles: ["VP Operations"], industries: ["Logistics"], geos: ["Texas"] };

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { 2: "admin" }, wsId: () => 2 });
});

describe("the fallback keeps each sector's lists together (F37)", () => {
  it("research: one group per sector, its own titles with its own industries and places", () => {
    expect(perSectorSliceGroups({ mode: "research", own: NONE, inferred: ICP, researched: { groups: [SCHOOLS, COUNTIES] } })).toEqual([
      { titles: ["Superintendent", "CFO"], industries: ["Primary/Secondary Education"], geos: ["Ohio"], keywords: [] },
      { titles: ["County Administrator"], industries: ["Government Administration"], geos: ["Virginia"], keywords: ["County of"] },
    ]);
  });

  it("merged: the learned ICP is a group of its own beside each sector", () => {
    const g = perSectorSliceGroups({ mode: "merged", own: NONE, inferred: ICP, researched: { groups: [SCHOOLS, COUNTIES] } })!;
    expect(g.map((x) => x.titles)).toEqual([["VP Operations"], ["Superintendent", "CFO"], ["County Administrator"]]);
    expect(g[0]).toEqual({ titles: ["VP Operations"], industries: ["Logistics"], geos: ["Texas"], keywords: [] });
  });

  it("a field the campaign sets is used in every group; a sector with none falls back to the ICP's under research", () => {
    const g = perSectorSliceGroups({
      mode: "research",
      own: { titles: ["Grants Manager"], industries: [], geos: [], keywords: [] },
      inferred: ICP,
      researched: { groups: [SCHOOLS, { ...COUNTIES, geographies: [] }] },
    })!;
    expect(g.map((x) => x.titles)).toEqual([["Grants Manager"], ["Grants Manager"]]);
    expect(g.map((x) => x.industries)).toEqual([["Primary/Secondary Education"], ["Government Administration"]]);
    expect(g[1].geos).toEqual(["Texas"]);
  });

  it("nothing per sector when nothing falls back per sector: inferred, no research, one sector, or a fully set campaign", () => {
    const researched = { groups: [SCHOOLS, COUNTIES] };
    expect(perSectorSliceGroups({ mode: "inferred", own: NONE, inferred: ICP, researched })).toBeNull();
    expect(perSectorSliceGroups({ mode: "research", own: NONE, inferred: ICP, researched: null })).toBeNull();
    expect(perSectorSliceGroups({ mode: "research", own: NONE, inferred: ICP, researched: { groups: [SCHOOLS] } })).toBeNull();
    expect(perSectorSliceGroups({ mode: "research", own: { titles: ["A"], industries: ["B"], geos: ["C"], keywords: [] }, inferred: ICP, researched })).toBeNull();
  });

  it("the queries never pair one sector's titles with another's industries, and both sectors get turns", () => {
    const groups = perSectorSliceGroups({ mode: "research", own: NONE, inferred: ICP, researched: { groups: [SCHOOLS, COUNTIES] } });
    const slices = buildQuerySlices({ titles: [], industries: [], geos: [], keywords: [], sizeHint: "", groups }).map((s) => s.q);
    expect(slices).toEqual([
      "Superintendent Primary/Secondary Education Ohio",
      "County Administrator Government Administration Virginia County of",
      "CFO Primary/Secondary Education Ohio",
    ]);
    // The flat union, as before, crosses them.
    const union = buildQuerySlices({ titles: [...SCHOOLS.titles, ...COUNTIES.titles], industries: [...SCHOOLS.industries, ...COUNTIES.industries], geos: ["Ohio", "Virginia"], keywords: [], sizeHint: "" }).map((s) => s.q);
    expect(union).toContain("Superintendent Government Administration Virginia");
    expect(slices.some((q) => q.startsWith("Superintendent Government"))).toBe(false);
  });

  it("many groups share the cap in turn instead of the first taking it all", () => {
    const big = (n: number) => ({ titles: Array.from({ length: 12 }, (_, i) => `T${n}-${i}`), industries: Array.from({ length: 12 }, (_, i) => `I${n}-${i}`), geos: [], keywords: [] });
    const slices = buildQuerySlices({ titles: [], industries: [], geos: [], keywords: [], sizeHint: "", groups: [big(1), big(2)] });
    expect(slices).toHaveLength(120);
    expect(slices.filter((s) => s.q.startsWith("T1-")).length).toBe(60);
    expect(new Set(slices.map((s) => s.id)).size).toBe(120);
    // No groups: exactly the old build.
    expect(buildQuerySlices({ titles: ["A"], industries: ["B"], geos: [], keywords: [], sizeHint: "" , groups: null }))
      .toEqual(buildQuerySlices({ titles: ["A"], industries: ["B"], geos: [], keywords: [], sizeHint: "" }));
  });

  it("the research fallback carries each researched sector's own lists", async () => {
    const sector = (id: number, t: typeof SCHOOLS, status: string) => {
      const c = cleanSectorContent({ name: `S${id}`, status, targeting: t }).content;
      h.db.rowsOf("research_sectors").push({ id, workspaceId: 2, marketId: 1, revision: 1, ...c, source: "manual", sourceRef: null });
    };
    sector(1, SCHOOLS, "researched");
    sector(2, COUNTIES, "verified");
    sector(3, { titles: ["Draft title"], industries: [], geographies: [], keywords: [] }, "draft");
    const r = await researchTargeting(2);
    expect(r!.groups).toEqual([SCHOOLS, COUNTIES]);
    expect(r!.titles).toEqual(["Superintendent", "CFO", "County Administrator"]);
  });

  it("campaign discovery builds its rotating queries from the per-sector groups", () => {
    const engine = read("server/areEngine.ts");
    const fn = engine.slice(engine.indexOf("async function runDiscovery("), engine.indexOf("// Merge with persisted state so we know which slice to run next."));
    expect(fn).toContain("const sectorGroups = perSectorSliceGroups({\n    mode: fallback,");
    expect(fn).toContain("    researched,\n  });");
    expect(fn).toContain("const targetingSlices = buildQuerySlices({ titles, industries, geos, keywords, sizeHint, groups: sectorGroups });");
  });
});
