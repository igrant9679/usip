/**
 * The campaign targeting editor (owner, 2026-10-15: "add a targeting editor
 * to campaign Settings"). are.campaigns.update replaces icpOverrides whole, so
 * the editor must send it back complete: only the fields a person changed are
 * rewritten, everything else keeps its stored form.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { overridesWithTargeting, sameTargeting, targetingFromOverrides, targetingProblem } from "@shared/campaignTargeting";
import { icpLabels } from "@shared/icpShape";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

// Campaign 38 as Create campaign from a sector made it (trimmed).
const FROM_SECTOR = {
  employeeMax: 2500,
  employeeMin: 50,
  exclude: ["Sheriff's Office", "court", "Inc"],
  keywords: ["County of", "Board of Supervisors"],
  targetGeographies: ["Virginia", "Maryland", "North Carolina", "United States"],
  targetIndustries: ["Government Administration", "Executive Offices"],
  targetTitles: ["County Administrator", "IT Director"],
};

// A campaign seeded from an ICP or persona: weighted objects, and keys the editor does not show.
const WEIGHTED = {
  targetTitles: [{ title: "VP Sales", weight: 0.9, seniority: "VP" }, { title: "CFO", weight: 0.6 }],
  targetGeographies: [{ country: "United States", region: "Texas" }],
  targetTechnologies: ["Salesforce"],
  personaId: 12,
};

describe("reading a campaign's targeting", () => {
  it("lists become labels, sizes numbers, junk nothing", () => {
    expect(targetingFromOverrides(FROM_SECTOR)).toEqual({
      titles: ["County Administrator", "IT Director"],
      industries: ["Government Administration", "Executive Offices"],
      places: ["Virginia", "Maryland", "North Carolina", "United States"],
      keywords: ["County of", "Board of Supervisors"],
      exclude: ["Sheriff's Office", "court", "Inc"],
      employeeMin: 50,
      employeeMax: 2500,
    });
    expect(targetingFromOverrides(WEIGHTED)).toMatchObject({ titles: ["VP Sales", "CFO"], places: ["Texas, United States"], keywords: [], employeeMin: null });
    expect(targetingFromOverrides(null)).toEqual({ titles: [], industries: [], places: [], keywords: [], exclude: [], employeeMin: null, employeeMax: null });
    expect(targetingFromOverrides({ keywords: ["a", " A ", "", 3], employeeMin: "-5", employeeMax: "40" })).toMatchObject({ keywords: ["a"], employeeMin: null, employeeMax: 40 });
  });
});

describe("saving an edit", () => {
  it("removing one place rewrites only the places", () => {
    const t = targetingFromOverrides(FROM_SECTOR);
    const next = overridesWithTargeting(FROM_SECTOR, { ...t, places: t.places.filter((p) => p !== "United States") });
    expect(next).toEqual({ ...FROM_SECTOR, targetGeographies: ["Virginia", "Maryland", "North Carolina"] });
  });

  it("an untouched field keeps its stored form, and keys the editor does not show survive", () => {
    const t = targetingFromOverrides(WEIGHTED);
    expect(overridesWithTargeting(WEIGHTED, t)).toEqual(WEIGHTED);
    const next = overridesWithTargeting(WEIGHTED, { ...t, keywords: ["pipeline"], employeeMax: 500 });
    expect(next).toEqual({ ...WEIGHTED, keywords: ["pipeline"], employeeMax: 500 });
    // Edited lists are written as plain labels, which the engine reads the same way.
    const edited = overridesWithTargeting(WEIGHTED, { ...t, titles: [...t.titles, "COO"] });
    expect(edited.targetTitles).toEqual(["VP Sales", "CFO", "COO"]);
    expect(icpLabels(edited.targetTitles, "title")).toEqual(["VP Sales", "CFO", "COO"]);
    expect(edited.targetGeographies).toBe(WEIGHTED.targetGeographies);
  });

  it("an emptied field is removed, so discovery falls back as for a field never set", () => {
    const t = targetingFromOverrides(FROM_SECTOR);
    const next = overridesWithTargeting(FROM_SECTOR, { ...t, keywords: [], exclude: [], employeeMin: null });
    expect(next).not.toHaveProperty("keywords");
    expect(next).not.toHaveProperty("exclude");
    expect(next).not.toHaveProperty("employeeMin");
    expect(next.employeeMax).toBe(2500);
  });

  it("knows when nothing changed, and refuses a size range that cannot match", () => {
    const t = targetingFromOverrides(FROM_SECTOR);
    expect(sameTargeting(t, targetingFromOverrides(FROM_SECTOR))).toBe(true);
    expect(sameTargeting(t, { ...t, places: [...t.places].reverse() })).toBe(false);
    expect(targetingProblem({ ...t, employeeMin: 3000 })).toBe("The smallest company size is larger than the largest.");
    expect(targetingProblem(t)).toBeNull();
  });

  it("the Settings tab shows the editor and sends the whole overrides back", () => {
    expect(read("client/src/pages/usip/ARECampaignDetail.tsx")).toContain("{campaign && <CampaignTargetingCard campaign={campaign} />}");
    expect(read("client/src/components/usip/are/CampaignTargetingCard.tsx")).toContain("save.mutate({ id: campaign.id, icpOverrides: overridesWithTargeting(campaign.icpOverrides, t) })");
  });
});
