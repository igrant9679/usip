/**
 * Research phase 4: research drives targeting (owner, 2026-10-14). Done when a
 * sector produces a draft campaign whose discovery finds on-target titles and
 * screens out off-target ones with the reason shown.
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
import { campaignNeverTarget } from "./services/research/neverTarget";
import { combineTargeting, pickFallback, priorSection } from "./services/research/targetingPrior";
import { cleanSectorContent } from "@shared/researchShape";
import {
  cleanNeverTarget,
  dropNeverTarget,
  neverTargetFromOverrides,
  neverTargetHit,
  neverTargetReason,
  overridesFromSector,
} from "@shared/researchTargeting";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const COUNTIES = cleanSectorContent({
  name: "County governments",
  status: "researched",
  scores: { fit: 5 },
  buyers: { painPoints: ["No staff to own compliance"] },
  targeting: {
    titles: ["County Administrator", "ADA Coordinator", "IT Director"],
    industries: ["Government Administration"],
    geographies: ["Virginia"],
    keywords: ["County of"],
    employeeMin: 50,
    employeeMax: 2500,
    exclude: ["student", "intern", "Inc", "volunteer fire", "Student"],
  },
}).content;

function ctx(ws: number) {
  h.wsId = ws;
  return {
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext;
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { 2: "admin", 4: "admin", 7: "manager" }, wsId: () => h.wsId });
});

describe("never-target words", () => {
  const words = cleanNeverTarget(COUNTIES.targeting.exclude);

  it("are deduplicated and matched as whole words, title first, then company, then industry", () => {
    expect(words).toEqual(["student", "intern", "Inc", "volunteer fire"]);
    expect(neverTargetHit(words, { title: "Student Services Coordinator" })).toEqual({ word: "student", field: "title" });
    expect(neverTargetHit(words, { title: "International Programs Director" })).toBeNull();
    expect(neverTargetHit(words, { title: "Summer Intern" })).toEqual({ word: "intern", field: "title" });
    expect(neverTargetHit(words, { title: "Director", company: "Acme Inc." })).toEqual({ word: "Inc", field: "company" });
    expect(neverTargetHit(words, { title: "Chief", company: "Loudoun County", industry: "Volunteer Fire Department" })).toEqual({ word: "volunteer fire", field: "industry" });
    expect(neverTargetHit(words, { title: "Incident Commander", company: "Fairfax County" })).toBeNull();
    expect(neverTargetHit([], { title: "Student" })).toBeNull();
  });

  it("say which word and where, for the Rejections tab", () => {
    expect(neverTargetReason({ word: "student", field: "title" })).toBe('Never-target word "student" in title');
    expect(neverTargetReason({ word: "Inc", field: "company" })).toBe('Never-target word "Inc" in company name');
  });

  it("drop found people before they are queued, reading companyName or company", () => {
    const rows = [
      { firstName: "A", title: "County Administrator", companyName: "Loudoun County" },
      { firstName: "B", title: "Graduate Student", companyName: "Virginia Tech" },
      { firstName: "C", title: "IT Director", company: "Smith Consulting Inc" },
    ];
    const { kept, dropped } = dropNeverTarget(rows, words);
    expect(kept.map((r) => r.firstName)).toEqual(["A"]);
    expect(dropped.map((d) => [d.row.firstName, neverTargetReason(d.hit)])).toEqual([
      ["B", 'Never-target word "student" in title'],
      ["C", 'Never-target word "Inc" in company name'],
    ]);
    expect(dropNeverTarget(rows, []).kept).toHaveLength(3);
  });
});

describe("a sector as a campaign's targeting", () => {
  it("carries titles (a persona's own win), industries, places, keywords, size and never-target words", () => {
    expect(overridesFromSector(COUNTIES.targeting)).toEqual({
      targetTitles: ["County Administrator", "ADA Coordinator", "IT Director"],
      targetIndustries: ["Government Administration"],
      targetGeographies: ["Virginia"],
      keywords: ["County of"],
      employeeMin: 50,
      employeeMax: 2500,
      exclude: ["student", "intern", "Inc", "volunteer fire"],
    });
    expect(overridesFromSector(COUNTIES.targeting, ["ADA Coordinator"]).targetTitles).toEqual(["ADA Coordinator"]);
    expect(neverTargetFromOverrides(overridesFromSector(COUNTIES.targeting))).toHaveLength(4);
    expect(neverTargetFromOverrides({ exclude: "student" })).toEqual([]);
  });

  it("Create campaign makes a draft campaign that keeps the sector, the persona and the never-target words", async () => {
    h.db.rowsOf("research_markets").push({ id: 1, workspaceId: 2, name: "SLG" });
    h.db.rowsOf("research_sectors").push({ id: 10, workspaceId: 2, marketId: 1, ...COUNTIES, status: "draft" });
    h.db.rowsOf("personas").push({ id: 100, workspaceId: 2, name: "ADA Coordinator", sectorId: 10, targetTitles: ["ADA Coordinator"], targetIndustries: [], targetGeographies: [], keywords: [] });
    const r = await appRouter.createCaller(ctx(2)).are.campaigns.create({
      name: "Counties (Research)",
      personaId: 100,
      icpOverrides: overridesFromSector(COUNTIES.targeting, ["ADA Coordinator"]),
      launch: false,
    } as any);
    const row = h.db.rowsOf("are_campaigns").find((c: any) => c.id === r.id);
    expect(r.launched).toBe(false);
    expect(row.status ?? "draft").toBe("draft");
    // The persona's sector comes along when none is named.
    expect([row.researchSectorId, row.personaId]).toEqual([10, 100]);
    expect(row.icpOverrides.targetTitles).toEqual(["ADA Coordinator"]);
    expect(row.icpOverrides.exclude).toEqual(["student", "intern", "Inc", "volunteer fire"]);

    await expect(appRouter.createCaller(ctx(4)).are.campaigns.create({ name: "Theirs", researchSectorId: 10 } as any)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("a campaign's never-target words", () => {
  it("are its own, plus its sector's while that sector is Researched or Verified, in its own workspace", async () => {
    h.db.rowsOf("research_sectors").push(
      { id: 10, workspaceId: 2, marketId: 1, targeting: { exclude: ["retired"] }, status: "researched" },
      { id: 11, workspaceId: 2, marketId: 1, targeting: { exclude: ["vendor"] }, status: "draft" },
      { id: 12, workspaceId: 4, marketId: 1, targeting: { exclude: ["theirs"] }, status: "verified" },
    );
    const own = { exclude: ["student"] };
    expect(await campaignNeverTarget({ workspaceId: 2, icpOverrides: own, researchSectorId: 10 })).toEqual(["student", "retired"]);
    expect(await campaignNeverTarget({ workspaceId: 2, icpOverrides: own, researchSectorId: 11 })).toEqual(["student"]);
    expect(await campaignNeverTarget({ workspaceId: 2, icpOverrides: own, researchSectorId: 12 })).toEqual(["student"]);
    expect(await campaignNeverTarget({ workspaceId: 2, icpOverrides: null, researchSectorId: null })).toEqual([]);
  });

  it("reach discovery, scoring and screening", () => {
    const engine = read("server/areEngine.ts");
    // Discovery: dropped before they are queued, and said so.
    expect(engine).toContain("const neverTarget = await campaignNeverTarget(campaign);");
    expect(engine).toContain("const { kept, dropped } = dropNeverTarget(unique, neverTarget);");
    expect(engine).toMatch(/const scored = kept\n\s+\.filter\(/);
    expect(engine).toContain(" not queued: never-target words from the campaign's targeting. For example: ");
    // Screening: before the score, in every mode, with the reason, inside the workspace.
    const loop = engine.slice(engine.indexOf("const screenNeverTarget = await campaignNeverTarget(campaign);"));
    expect(loop.indexOf("neverTargetHit(screenNeverTarget")).toBeLessThan(loop.indexOf("const score = p.icpMatchScore ?? 0;"));
    expect(loop).toContain(
      "const offTarget = neverTargetHit(screenNeverTarget, { title: p.title, company: p.companyName, industry: p.industry });\n      if (offTarget) {\n        await db\n          .update(prospectQueue)",
    );
    expect(loop).toContain("result.rejected++;\n        neverTargeted++;\n        continue;");
    expect(loop).toContain(".set({ sequenceStatus: \"skipped\", rejectedAt: new Date(), rejectionReason: neverTargetReason(offTarget) })");
    expect(loop).toContain(".where(and(eq(prospectQueue.id, p.id), eq(prospectQueue.workspaceId, wsId)));");
    // Scoring: 0 without asking the model.
    const enrich = read("server/routers/are/prospects.ts");
    expect(enrich).toMatch(/if \(offTarget\) \{\n\s+icpMatchScore = 0;\n\s+icpMatchBreakdown = \{ neverTarget: 0 \};\n\s+\} else if \(effectiveIcp\) \{/);
  });
});

describe("the ICP and the research", () => {
  const b = cleanSectorContent({ name: "Cities", status: "verified", targeting: { titles: ["City Manager", "county administrator"], industries: ["Government Administration"], employeeMin: 20, employeeMax: 5000 } }).content;

  it("combine every usable sector's targeting, widest size range", () => {
    expect(combineTargeting([COUNTIES, b])).toEqual({
      titles: ["County Administrator", "ADA Coordinator", "IT Director", "City Manager"],
      industries: ["Government Administration"],
      geographies: ["Virginia"],
      keywords: ["County of"],
      employeeMin: 20,
      employeeMax: 5000,
    });
  });

  it("a blank campaign field falls back to the learned ICP (as before), the research, or both", () => {
    expect(pickFallback("inferred", ["CFO"], ["County Administrator"])).toEqual(["CFO"]);
    expect(pickFallback("research", ["CFO"], ["County Administrator"])).toEqual(["County Administrator"]);
    expect(pickFallback("research", ["CFO"], [])).toEqual(["CFO"]);
    expect(pickFallback("merged", ["CFO", "County Administrator"], ["county administrator", "IT Director"])).toEqual(["CFO", "County Administrator", "IT Director"]);
    const engine = read("server/areEngine.ts");
    expect(engine).toContain('const researched = fallback === "inferred" ? null : await researchTargeting(campaign.workspaceId);');
    expect(engine).toContain('pickFallback(fallback, icpLabels(icp?.targetTitles, "title"), researched?.titles)');
  });

  it("ICP inference reads the research as prior knowledge", () => {
    const s = priorSection([COUNTIES]);
    expect(s).toContain("## Your own market research (sectors marked Researched or Verified)");
    expect(s).toContain("- County governments (fit 5/5): titles: County Administrator, ADA Coordinator, IT Director");
    expect(s).toContain("never target: student, intern, Inc, volunteer fire");
    expect(priorSection([])).toBe("");
    expect(read("server/routers/are/icp.ts")).toContain("const researchPrior = await researchPriorForIcp(workspaceId);");
  });

  it("the fallback setting defaults to the learned ICP and only an admin changes it", async () => {
    expect((await appRouter.createCaller(ctx(7)).research.settings.get()).icpFallback).toBe("inferred");
    await expect(appRouter.createCaller(ctx(7)).research.settings.setIcpFallback({ icpFallback: "research" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await appRouter.createCaller(ctx(2)).research.settings.setIcpFallback({ icpFallback: "merged" });
    expect((await appRouter.createCaller(ctx(2)).research.settings.get()).icpFallback).toBe("merged");
    await expect(appRouter.createCaller(ctx(2)).research.settings.setIcpFallback({ icpFallback: "anything" as any })).rejects.toBeTruthy();
  });
});
