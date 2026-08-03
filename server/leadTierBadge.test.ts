/**
 * The tier badge and the letter grade are ONE FACT, and the browser was
 * computing its own answer.
 *
 * 🔴 THE DRIFT. The server picks a tier with PER-WORKSPACE thresholds
 * (`lead_score_config.tierWarmMin / tierHotMin / tierSalesReadyMin`, defaults
 * 31/61/81) and stores the derived letter on `leads.grade`. The Leads table
 * rendered both badges in the same cell — the stored grade, and a tier it
 * re-derived from `leads.score` against 81/61/31 HARDCODED.
 *
 * Default workspaces agree, which is why it survived. Raise
 * `tierSalesReadyMin` to 90 and a lead scoring 85 shows grade **B** next to the
 * label **Sales Ready**, in the same cell — and the "A lead becomes
 * Sales-Ready" notification (f8cfdf9) fires on the server's answer, not the one
 * on screen.
 *
 * The mapping is a bijection, so the client needs no thresholds at all.
 * @shared/leadTier owns both directions and is exercised here for real.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  LEAD_GRADES,
  LEAD_TIERS,
  gradeForTier,
  leadTierLabel,
  tierForGrade,
  type LeadGrade,
  type LeadTier,
} from "@shared/leadTier";
import { tierFor, DEFAULT_SCORE_CONFIG } from "./leadScoring";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ── The mapping, run for real ───────────────────────────────────────────── */

describe("tier ⇄ grade", () => {
  it("round-trips in both directions for every value", () => {
    for (const t of LEAD_TIERS) expect(tierForGrade(gradeForTier(t))).toBe(t);
    for (const g of LEAD_GRADES) expect(gradeForTier(tierForGrade(g)!)).toBe(g);
  });

  it("is a bijection — no two tiers share a grade", () => {
    const grades = LEAD_TIERS.map(gradeForTier);
    expect(new Set(grades).size).toBe(LEAD_TIERS.length);
    expect(grades.length).toBe(LEAD_GRADES.length);
  });

  it("keeps the ladder the right way up", () => {
    // A is the best. Inverting this silently promotes every cold lead.
    expect(gradeForTier("sales_ready")).toBe("A");
    expect(gradeForTier("hot")).toBe("B");
    expect(gradeForTier("warm")).toBe("C");
    expect(gradeForTier("cold")).toBe("D");
  });

  it("returns null for a grade that is absent or unrecognised", () => {
    /**
     * The important half. A lead nobody has scored has no tier, and calling it
     * "Cold" asserts a measurement never taken — the mistake 96b161d corrected
     * when an unmeasured intent signal counted as a real zero.
     */
    expect(tierForGrade(null)).toBeNull();
    expect(tierForGrade(undefined)).toBeNull();
    expect(tierForGrade("")).toBeNull();
    expect(tierForGrade("E")).toBeNull();
    expect(tierForGrade("a")).toBeNull(); // case-sensitive: stored values are upper
  });

  it("labels the absence rather than inventing a tier", () => {
    expect(leadTierLabel(null)).toBe("Unscored");
    expect(leadTierLabel("sales_ready")).toBe("Sales Ready");
    expect(leadTierLabel("hot")).toBe("Hot");
    expect(leadTierLabel("warm")).toBe("Warm");
    expect(leadTierLabel("cold")).toBe("Cold");
  });

  it("has a label for every tier — no underscore leaks to a user", () => {
    for (const t of LEAD_TIERS) {
      const label = leadTierLabel(t);
      expect(label, `${t} has no label`).toBeTruthy();
      expect(label, `${t} renders its raw enum value`).not.toContain("_");
    }
  });
});

/* ── The server still agrees with its own thresholds ─────────────────────── */

describe("the grade stored on a lead follows the workspace's thresholds", () => {
  it("tracks a CUSTOM sales-ready threshold, which the old client could not", () => {
    /**
     * The exact scenario the hardcoded 81 got wrong: at tierSalesReadyMin 90, a
     * lead scoring 85 is HOT (grade B). The browser used to label it "Sales
     * Ready" from the same row.
     */
    const cfg = { ...DEFAULT_SCORE_CONFIG, tierSalesReadyMin: 90 };
    expect(tierFor(85, cfg)).toBe("hot");
    expect(gradeForTier(tierFor(85, cfg))).toBe("B");
    // …and the client, given that grade, now says Hot too.
    expect(leadTierLabel(tierForGrade("B"))).toBe("Hot");

    // Under the default config the same score IS sales-ready — which is why
    // the bug was invisible on an untouched workspace.
    expect(tierFor(85, DEFAULT_SCORE_CONFIG)).toBe("sales_ready");
  });

  it("every threshold boundary maps to the grade the client will show", () => {
    const cfg = DEFAULT_SCORE_CONFIG;
    const cases: Array<[number, LeadTier, LeadGrade]> = [
      [0, "cold", "D"],
      [cfg.tierWarmMin - 1, "cold", "D"],
      [cfg.tierWarmMin, "warm", "C"],
      [cfg.tierHotMin - 1, "warm", "C"],
      [cfg.tierHotMin, "hot", "B"],
      [cfg.tierSalesReadyMin - 1, "hot", "B"],
      [cfg.tierSalesReadyMin, "sales_ready", "A"],
      [100, "sales_ready", "A"],
    ];
    for (const [score, tier, grade] of cases) {
      expect(tierFor(score, cfg), `score ${score}`).toBe(tier);
      expect(gradeForTier(tierFor(score, cfg)), `score ${score}`).toBe(grade);
      expect(tierForGrade(grade), `grade ${grade}`).toBe(tier);
    }
  });
});

/* ── Nobody re-derives it ────────────────────────────────────────────────── */

describe("the client no longer computes tiers from scores", () => {
  const leads = strip(read("client/src/pages/usip/Leads.tsx"));

  it("the hardcoded threshold ladder is gone", () => {
    /**
     * Scans for the SHAPE, not the old function name: any of the three default
     * thresholds compared against a score is the bug returning under whatever
     * it gets called next time.
     */
    expect(leads, "a hardcoded tier threshold is back").not.toMatch(/>=\s*81\b/);
    expect(leads, "a hardcoded tier threshold is back").not.toMatch(/>=\s*61\b/);
    expect(leads, "a hardcoded tier threshold is back").not.toMatch(/>=\s*31\b/);
    expect(leads).not.toMatch(/tierFromScore/);
  });

  it("the badge is derived from the stored grade", () => {
    expect(leads).toMatch(/^import \{ leadTierLabel, tierForGrade, type LeadTier \} from "@shared\/leadTier";$/m);
    expect(leads).toMatch(/function tierBadge\(grade: string \| null \| undefined\)/);
    expect(leads).toMatch(/const tier = tierForGrade\(grade\);/);
    // …and the cell calls it with the grade, not the score.
    expect(leads).toMatch(/tierBadge\(l\.grade\)/);
    expect(leads, "the tier badge still reads the raw score").not.toMatch(/tierBadge\(l\.score\)/);
  });

  it("an unscored lead reads neutral in BOTH badges", () => {
    /**
     * It used to show "—" tinted as if it were a C, beside the label "Cold" —
     * two different fabrications of a score nobody took, in one cell.
     */
    expect(leads).toMatch(/l\.grade \? GRADE_TONE\[l\.grade\] \?\? NEUTRAL_TONE : NEUTRAL_TONE/);
    expect(leads, "an absent grade is tinted as a C again").not.toMatch(/GRADE_TONE\[l\.grade \?\? "C"\]/);
  });

  it("the record drawer labels tiers from the shared definition too", () => {
    // It already read the SERVER's tier, but formatted the label by hand with a
    // special case for sales_ready plus capitalise-first-letter — which is how
    // one surface says "Sales Ready" and another "Sales_ready".
    const drawer = strip(read("client/src/components/usip/RecordDrawer.tsx"));
    expect(drawer).toMatch(/leadTierLabel\(/);
    expect(drawer, "the hand-rolled label formatter is back")
      .not.toMatch(/tier\.charAt\(0\)\.toUpperCase\(\)/);
  });
});

describe("the server derives the grade from the shared mapping", () => {
  const src = strip(read("server/routers/leadScoring.ts"));

  it("calls gradeForTier rather than re-listing the tiers", () => {
    expect(src).toMatch(/const grade = gradeForTier\(breakdown\.tier\);/);
    expect(src, "the inline tier→grade ladder is back")
      .not.toMatch(/breakdown\.tier === "sales_ready" \? "A"/);
  });

  it("the tier vocabulary has one home", () => {
    // server/leadScoring.ts re-exports the type; the values live in shared.
    const scoring = strip(read("server/leadScoring.ts"));
    expect(scoring).toMatch(/export type \{ LeadTier \} from "@shared\/leadTier";/);
    expect(scoring, "the tier union was re-declared locally")
      .not.toMatch(/type LeadTier = "cold"/);
  });
});
