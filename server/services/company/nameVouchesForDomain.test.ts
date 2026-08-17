/**
 * nameVouchesForDomain — the one extra witness for a prospect's stored
 * companyDomain when it equals their mailbox domain. Every fixture below is
 * a real pair from the 2026-08-17 CommunityForce dry run: the first block is
 * staff at their own organisation, the second is trustees/volunteers whose
 * day-job mailbox had been copied into the company field.
 */
import { describe, it, expect } from "vitest";
import { nameVouchesForDomain } from "./normalize";

describe("nameVouchesForDomain — vouches", () => {
  it.each([
    ["Marquette University", "marquette.edu"],
    ["Washington and Lee University", "wlu.edu"],
    ["Bowie State University", "bowiestate.edu"],
    ["Virginia Commonwealth University", "vcu.edu"],
    ["The San Francisco Foundation", "sff.org"],
    ["Milwaukee Area Technical College", "matc.edu"],
    ["Hewlett Foundation", "hewlett.org"],
    ["Carnegie Corporation of New York", "carnegie.org"],
    ["Driehaus Foundation", "driehausfoundation.org"],
    ["Reed College", "reed.edu"],
    ["Cornell Hotel Society", "cornellhotelsociety.com"],
    ["The Growing Place", "growingplace.org"],
    ["Battery Powered", "thebatterysf.com"],
    ["True Health", "mytruehealth.org"],
    ["Blue Water Thinking", "bw-thinking.com"],
    ["Gavi", "gavi.org"],
    ["Uthsc", "uthsc.edu"],
    ["MSU Denver", "msudenver.edu"],
  ])("%s ↔ %s", (name, domain) => {
    expect(nameVouchesForDomain(name, domain)).toBe(true);
  });
});

describe("nameVouchesForDomain — does not vouch (a mailbox that is not the org)", () => {
  it.each([
    ["Holy Cross Academy", "bluefrog.com"],
    ["Oxford Memorial Library", "stny.rr.com"],
    ["New Woodstock Free Library", "parks.ny.gov"],
    ["National Park Foundation", "nps.gov"],                  // npf ≠ nps
    ["Lyons Public Library", "providentiamanagement.com"],
    ["Greenwich Free Library", "sals.edu"],
    ["Community Free Library", "nioga.org"],
    ["Friends of the Central Library", "syr.edu"],
    ["CoHEsion", "astate.edu"],
    ["Macedon Public Library", "owwl.org"],
    ["Takoma Children's School", "dc.gov"],
    ["Community Foundation", "nioga.org"],                    // all generic words
    ["", "marquette.edu"],
    ["Marquette University", ""],
  ])("%s ↔ %s", (name, domain) => {
    expect(nameVouchesForDomain(name, domain)).toBe(false);
  });

  it("some real pairs are honestly underivable and go blank for the reconciler to fill", () => {
    // umn = University of MinNesota — no rule reaches that without guessing.
    expect(nameVouchesForDomain("University of Minnesota Twin Cities", "umn.edu")).toBe(false);
  });

  it("a generic word never vouches on its own", () => {
    // "university" appears in the domain but says nothing about WHICH one.
    expect(nameVouchesForDomain("Southern University", "university.edu")).toBe(false);
    expect(nameVouchesForDomain("State Library", "statelibrary.org")).toBe(false);
  });
});
