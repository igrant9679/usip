/**
 * The ICP list shapes (2026-10-14, Phase 0 of the Research module plan).
 * runIcpInference stores every ICP list as weighted objects; discovery, the
 * scorer, the vendor searches and the ICP page read them as strings, so a
 * campaign that fell back to the workspace ICP crashed or searched for
 * "[object Object]". One reader now serves them all.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { icpGeographies, icpLabels, icpPromptList, icpStoredFromLabels, icpWeighted } from "@shared/icpShape";
import { buildEffectiveIcp, scoringTargetsOf } from "./services/are/effectiveIcp";
import { criteriaFromTargeting } from "./services/prospectSources/bridge";
import { buildQuickenrichFilters } from "./services/quickenrich";
import { buildQuerySlices, scoreIcpMatch } from "./areEngine";

// Exactly the json_schema output runIcpInference stores.
const AI = {
  targetTitles: [
    { title: "VP Revenue Operations", seniority: "VP", role: "Revenue Operations", weight: 0.9 },
    { title: "Chief Revenue Officer", seniority: "C-level", role: "Sales", weight: 0.7 },
  ],
  targetIndustries: [{ industry: "Computer Software", weight: 0.8, examples: ["Northwind"] }],
  targetGeographies: [{ country: "United States", region: "Kentucky", weight: 0.6 }, { country: "Canada", region: "", weight: 0.3 }],
  targetTechStack: [{ technology: "Salesforce", signal_type: "CRM", weight: 0.8 }],
  antiPatterns: [{ dimension: "Company size", value: "Agencies under 20 people", reason: "No deal under 20 closed" }],
  topConversionSignals: [{ signal: "Replied within 48h", correlation_score: 0.7 }],
};

describe("the reader", () => {
  it("reads every kind from the stored objects", () => {
    expect(icpLabels(AI.targetTitles, "title")).toEqual(["VP Revenue Operations", "Chief Revenue Officer"]);
    expect(icpLabels(AI.targetIndustries, "industry")).toEqual(["Computer Software"]);
    expect(icpLabels(AI.targetGeographies, "geography")).toEqual(["Kentucky, United States", "Canada"]);
    expect(icpLabels(AI.targetTechStack, "technology")).toEqual(["Salesforce"]);
    expect(icpLabels(AI.antiPatterns, "antiPattern")).toEqual(["Agencies under 20 people"]);
    expect(icpLabels(AI.topConversionSignals, "signal")).toEqual(["Replied within 48h"]);
  });

  it("reads plain strings, a JSON string, null, and drops corrupted rows and repeats", () => {
    expect(icpLabels(["CFO", " VP Sales "], "title")).toEqual(["CFO", "VP Sales"]);
    expect(icpLabels(JSON.stringify(AI.targetTitles), "title")).toEqual(["VP Revenue Operations", "Chief Revenue Officer"]);
    expect(icpLabels(null, "title")).toEqual([]);
    expect(icpLabels(undefined, "industry")).toEqual([]);
    // A row the old Override dialog saved: objects, "[object Object]" and strings mixed.
    expect(icpLabels([AI.targetTitles[0], "[object Object]", "vp revenue operations", "", "CFO"], "title")).toEqual(["VP Revenue Operations", "CFO"]);
    expect(icpLabels([{ dimension: "Industry", value: "", reason: "" }], "antiPattern")).toEqual(["Industry"]);
  });

  it("keeps weights and details for prompts", () => {
    expect(icpWeighted(AI.targetTitles, "title")[0]).toEqual({ label: "VP Revenue Operations", weight: 0.9, detail: "VP · Revenue Operations" });
    expect(icpWeighted(AI.topConversionSignals, "signal")[0].weight).toBe(0.7);
    expect(icpPromptList(AI.targetTitles, "title")).toBe("VP Revenue Operations (0.9), Chief Revenue Officer (0.7)");
    expect(icpPromptList(["CFO"], "title")).toBe("CFO");
  });

  it("geographies as country and region pairs, from objects or strings", () => {
    expect(icpGeographies(AI.targetGeographies)).toEqual([{ country: "United States", region: "Kentucky" }, { country: "Canada", region: "" }]);
    expect(icpGeographies(["Kentucky, United States", "Germany"])).toEqual([{ country: "United States", region: "Kentucky" }, { country: "Germany", region: "" }]);
  });
});

describe("an edited list keeps the stored shape", () => {
  it("unchanged labels keep their entry and weight; new ones get no weight; junk is dropped", () => {
    const out = icpStoredFromLabels(["vp revenue operations", "Director of Sales", "[object Object]", "Director of sales"], AI.targetTitles, "title");
    expect(out).toEqual([
      AI.targetTitles[0],
      { title: "Director of Sales", seniority: "", role: "", weight: null },
    ]);
  });

  it("each kind gets the inferred shape", () => {
    expect(icpStoredFromLabels(["Ohio, United States"], [], "geography")).toEqual([{ country: "United States", region: "Ohio", weight: null }]);
    expect(icpStoredFromLabels(["Canada"], AI.targetGeographies, "geography")).toEqual([AI.targetGeographies[1]]);
    expect(icpStoredFromLabels(["HubSpot"], [], "technology")).toEqual([{ technology: "HubSpot", signal_type: "", weight: null }]);
    expect(icpStoredFromLabels(["Government"], [], "antiPattern")).toEqual([{ dimension: "", value: "Government", reason: "" }]);
    expect(icpStoredFromLabels(["Fintech"], [], "industry")).toEqual([{ industry: "Fintech", weight: null, examples: [] }]);
  });
});

describe("every reader gets real values from an AI-inferred ICP", () => {
  const icp = { ...AI, targetCompanySizeMin: 100, targetCompanySizeMax: 2500 } as never;

  it("the scorer's targets, and the deterministic scorer matches a title", () => {
    const targets = scoringTargetsOf(buildEffectiveIcp(icp, {}), {});
    expect(targets.titles).toEqual(["VP Revenue Operations", "Chief Revenue Officer"]);
    expect(targets.geos).toEqual(["Kentucky, United States", "Canada"]);
    const onTarget = scoreIcpMatch({ title: "VP Revenue Operations", industry: "Computer Software" }, targets);
    const offTarget = scoreIcpMatch({ title: "Barista", industry: "Restaurants" }, targets);
    expect(onTarget).toBeGreaterThan(offTarget);
    // A campaign's own targeting still wins over the ICP.
    expect(scoringTargetsOf(buildEffectiveIcp(icp, { targetTitles: ["Grants Manager"] }), {}).titles).toEqual(["Grants Manager"]);
  });

  it("discovery's query slices build without crashing and carry the titles", () => {
    const slices = buildQuerySlices({
      titles: icpLabels(AI.targetTitles, "title"),
      industries: icpLabels(AI.targetIndustries, "industry"),
      geos: icpLabels(AI.targetGeographies, "geography"),
      keywords: [],
      sizeHint: "100-2500 employees",
    });
    expect(slices.length).toBe(4);
    expect(slices.map((s) => s.q)).toContain("VP Revenue Operations Computer Software Kentucky, United States 100-2500 employees");
    expect(slices.some((s) => s.q.includes("[object Object]"))).toBe(false);
  });

  it("the vendor search bridge gets real titles, and the country and state from a region", () => {
    const c = criteriaFromTargeting({ titles: AI.targetTitles, industries: AI.targetIndustries, geos: AI.targetGeographies });
    expect(c.jobTitles).toEqual(["VP Revenue Operations", "Chief Revenue Officer"]);
    expect(c.industries).toEqual(["Computer Software"]);
    expect(c.countries).toEqual(["US", "CA"]);
    expect(c.stateProvinces).toEqual(["Kentucky"]);
    expect(c.cities).toEqual([]);
    // Typed places keep their old reading: a state code after a comma is not a country.
    const typed = criteriaFromTargeting({ geos: ["Austin, TX", "United Kingdom", "Ohio"] });
    expect(typed.countries).toEqual(["GB"]);
    expect(typed.stateProvinces).toEqual(["Ohio"]);
    expect(typed.cities).toEqual(["Austin, TX"]);
  });

  it("QuickEnrich gets the titles and the country of a region", () => {
    const r = buildQuickenrichFilters({
      titles: icpLabels(AI.targetTitles, "title"),
      industries: [],
      geos: icpLabels(AI.targetGeographies, "geography"),
    }, null);
    expect((r.body as any).title.include).toEqual(["VP Revenue Operations", "Chief Revenue Officer"]);
    expect((r.body as any).country_code.include).toEqual(["US", "CA"]);
    expect(r.unmappedGeos).toEqual([]);
  });
});

const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

describe("wiring", () => {
  it("campaign discovery reads the ICP through the reader, and passes the ICP's size to Apollo", () => {
    const engine = read("server/areEngine.ts");
    const fn = engine.slice(engine.indexOf("async function runDiscovery("), engine.indexOf("const targetingSlices = buildQuerySlices("));
    expect(fn).toContain(': icpLabels(icp?.targetTitles, "title");');
    expect(fn).toContain(': icpLabels(icp?.targetIndustries, "industry");');
    expect(fn).toContain(': icpLabels(icp?.targetGeographies, "geography");');
    expect(fn).toContain("employeeMin: overrides.employeeMin ?? icp?.targetCompanySizeMin ?? undefined,");
    expect(engine).toContain("discoverViaApollo(campaign, { titles, industries, geos, keywords, overrides: size })");
  });

  it("the AI fit scorer is shown labels with weights, not raw JSON", () => {
    const prospects = read("server/routers/are/prospects.ts");
    const fn = prospects.slice(prospects.indexOf("async function scoreIcpMatch("), prospects.indexOf("Score each dimension 0-20"));
    expect(fn).toContain('- Target Titles: ${icpPromptList(icp.targetTitles, "title") || "any"}');
    expect(fn).not.toContain("JSON.stringify(icp.");
  });

  it("the Override takes clean lists and stores the inferred shape", () => {
    const router = read("server/routers/are/icp.ts");
    const fn = router.slice(router.indexOf("  override: workspaceProcedure"), router.indexOf("  restore: workspaceProcedure"));
    expect(fn).not.toContain("z.any()");
    for (const [field, kind] of [["targetTitles", "title"], ["targetIndustries", "industry"], ["targetGeographies", "geography"], ["targetTechStack", "technology"], ["antiPatterns", "antiPattern"]]) {
      expect(fn).toContain(`${field}: icpLabelList.optional(),`);
      expect(fn).toContain(`updates.${field} = icpStoredFromLabels(input.${field}, current.${field}, "${kind}");`);
    }
  });

  it("the ICP page reads through the reader and no longer reads columns that do not exist", () => {
    const page = read("client/src/pages/usip/AREIcpAgent.tsx");
    expect(page).toContain("const listOf = (v: unknown, kind: IcpListKind): string[] => icpLabels(v, kind);");
    expect(page).not.toMatch(/map\(String\)/);
    expect(page).not.toContain("buyingTriggers");
    expect(page).not.toContain("painPoints");
    expect(page).toContain('targetGeographies: toArray(geos, /\\n/),');
  });

  it("the demo ICP is stored in the shape the AI writes, so demos exercise the real path", () => {
    const seed = read("server/demoSeedExtras.ts");
    const block = seed.slice(seed.indexOf("await db.insert(icpProfiles).values({"), seed.indexOf("counts.icpProfiles = 1;"));
    expect(block).toContain('{ title: "VP Revenue Operations", seniority: "VP", role: "Revenue Operations", weight: 0.9 }');
    expect(block).not.toMatch(/targetTitles: \["/);
  });

  it("nothing casts an ICP list to strings any more", () => {
    // The bug's signature: an inferred ICP list read as `as string[]` or with map(String).
    const pattern = /icp\??\.(targetTitles|targetIndustries|targetGeographies|targetTechStack|antiPatterns|topConversionSignals)\s*(as\s|\)\s*as\s|\.map\(String\))/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts")) {
          if (pattern.test(readFileSync(p, "utf8"))) offenders.push(path.relative(path.join(__dirname, ".."), p));
        }
      }
    };
    walk(path.join(__dirname));
    walk(path.join(__dirname, "..", "client", "src"));
    expect(offenders).toEqual([]);
  });
});
