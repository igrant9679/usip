/**
 * Job title comes from the Experience tab, never the bio.
 *
 * Owner rule 2026-08-14: "For contact's job title, especially those scraped in
 * the revenue engine, use the job title listed under their current job under
 * the Experience tab in LinkedIn, not their bios."
 *
 * Before this, the mapper read `headline ?? occupation ?? experience.title` —
 * headline FIRST — so a CRM full of slogans was the expected output, and those
 * slogans then merge-rendered into outreach.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mapSearchHitToProfile, mapUnipileProfileToVelocitySchema } from "./services/linkedinEnrichment/mapper";

const profile = (over: Record<string, unknown> = {}) =>
  mapUnipileProfileToVelocitySchema({
    first_name: "Dana", last_name: "Reed",
    public_identifier: "danareed",
    headline: "Helping SaaS founders scale | ex-Google | girl dad",
    occupation: "Helping SaaS founders scale | ex-Google | girl dad",
    work_experience: [
      { company: "Acme Corp", position: "VP of Revenue Operations", start: "2023-01", current: true },
      { company: "Google", position: "Senior Analyst", start: "2018-01", end: "2022-12" },
    ],
    ...over,
  } as never, "https://www.linkedin.com/in/danareed");

describe("the title is the current Experience role", () => {
  it("takes the current job's title, not the headline", () => {
    const p = profile();
    expect(p.currentTitle).toBe("VP of Revenue Operations");
    expect(p.headline).toBe("Helping SaaS founders scale | ex-Google | girl dad");
  });

  it("picks the CURRENT role when a past one is listed first", () => {
    const p = profile({
      work_experience: [
        { company: "Google", position: "Senior Analyst", start: "2018-01", end: "2022-12" },
        { company: "Acme Corp", position: "Chief of Staff", start: "2023-01", current: true },
      ],
    });
    expect(p.currentTitle).toBe("Chief of Staff");
  });

  it("reads `title` as well as `position` — providers use both", () => {
    const p = profile({ work_experience: [{ company: "Acme", title: "Head of Partnerships", current: true }] });
    expect(p.currentTitle).toBe("Head of Partnerships");
  });

  it("reports NO title rather than a bio when experience is withheld", () => {
    // Out-of-network profiles come back with no experience section. Null emits
    // no title candidate, so the prospect keeps what it had — the merge never
    // deletes. Answering with the headline is the failure mode being fixed.
    const p = profile({ work_experience: [] });
    expect(p.currentTitle).toBeNull();
    expect(p.headline).toContain("Helping SaaS founders scale");
  });

  it("never falls back to `occupation` either — it is the headline again", () => {
    const p = profile({ work_experience: [], headline: null });
    expect(p.currentTitle).toBeNull();
  });

  it("a people-SEARCH hit reports no title at all", () => {
    const hit = mapSearchHitToProfile({
      name: "Dana Reed", headline: "Fractional CRO | speaker | dog mom",
      company: "Acme Corp", linkedinUrl: "https://www.linkedin.com/in/danareed",
    });
    expect(hit.currentTitle).toBeNull();
    expect(hit.headline).toBe("Fractional CRO | speaker | dog mom");
    expect(hit.currentCompanyName).toBe("Acme Corp");
  });
});

describe("headline consumers still read the headline", () => {
  // Company-from-headline recovery reads a DIFFERENT field. It used to read
  // currentTitle, which was the headline; now that currentTitle is a clean job
  // title ("VP of Revenue Operations") it names no employer, so any consumer
  // left pointing at it would silently stop finding companies.
  it("the sweeper parses the company from `headline`", () => {
    const src = readFileSync("server/services/enrichmentSweeper.ts", "utf8");
    const line = src.split("\n").find((l) => l.includes("const headlineCompany = companyFromHeadline"))!;
    expect(line).toContain("headline");
    expect(line).not.toContain("currentTitle");
  });

  it("comprehensivePass parses the company from the stored headline", () => {
    const src = readFileSync("server/services/enrichment/comprehensivePass.ts", "utf8");
    const line = src.split("\n").find((l) => l.includes("companyFromHeadline(enr."))!;
    expect(line).toContain("linkedinHeadline");
    expect(line).not.toContain("currentTitle");
  });

  it("the mapper itself no longer reads headline or occupation for the title", () => {
    const src = readFileSync("server/services/linkedinEnrichment/mapper.ts", "utf8");
    const line = src.split("\n").find((l) => l.trimStart().startsWith("const currentTitle ="))!;
    expect(line).toContain("currentExp?.title");
    expect(line).not.toContain("headline");
    expect(line).not.toContain("occupation");
  });
});
