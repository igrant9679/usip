/**
 * F17 — territory fit (built 2026-10-30).
 *
 * `placeFit` is pure, so almost all of this is REAL BEHAVIOUR rather than
 * source pins. That matters more here than in F11 or F12: this verdict decides
 * whether a prospect is dropped before a paid acquisition and whether they are
 * auto-rejected, so a wrong "elsewhere" costs a real person we would have
 * mailed, and a wrong "inside" costs an email lookup. The two cases the
 * evidence pass measured on the old code are pinned first.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { _clearTargetPlaceCache, parseTargetPlaces, placeFit, placeStringOf } from "./services/placeFit";
import { quickenrichPlaceCheck } from "./services/quickenrich";
import { scoreIcpMatch, territoryModeOf } from "./areEngine";
import { icpLabels } from "@shared/icpShape";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

const fit = (place: string | null | undefined, geos: string[]) => placeFit(place, parseTargetPlaces(geos));

describe("the two cases the old code got wrong", () => {
  it("does not read West Virginia as Virginia, which the substring test did", () => {
    // Measured before building: "charleston, west virginia, united states"
    // .includes("virginia") is true, and scoreIcpMatch awarded 15 points of
    // ICP fit for it. That is the whole reason this module exists.
    expect(fit("Charleston, West Virginia, United States", ["Virginia"])).toBe("elsewhere");
    expect(fit("Richmond, Virginia, United States", ["Virginia"])).toBe("inside");
    // And the reverse direction, which the substring test got right by luck
    // and this gets right by construction.
    expect(fit("Richmond, Virginia, United States", ["West Virginia"])).toBe("elsewhere");
  });

  it("calls nobody 'elsewhere' when the campaign targets no places", () => {
    // The trap inherited from quickenrichPlaceCheck, which this module guards
    // against on its first line. Proven here against BOTH implementations so
    // the difference is on the record.
    expect(quickenrichPlaceCheck("Richmond, Virginia, United States", [])).toBe("elsewhere");
    for (const place of ["Richmond, Virginia, United States", "Toronto, Ontario, Canada", "Paris, France", ""]) {
      // 2026-10-31: was "unknown". Still not "elsewhere" — that is the trap
      // this test was written for and it is untouched — but it now says WHOSE
      // gap it is. See the no_targets describe block below.
      expect(fit(place, []), `no targets: ${place}`).toBe("no_targets");
    }
  });
});

describe("inside, on positive evidence only", () => {
  it("matches a whole country", () => {
    expect(fit("Austin, Texas, United States", ["United States"])).toBe("inside");
    expect(fit("Toronto, Ontario, Canada", ["Canada"])).toBe("inside");
    // A state inside a targeted country is inside it.
    expect(fit("Virginia, United States", ["United States"])).toBe("inside");
  });

  it("matches a state or province by name", () => {
    expect(fit("Richmond, Virginia, United States", ["Maryland", "Virginia", "North Carolina"])).toBe("inside");
    expect(fit("Ottawa, Ontario, Canada", ["Ontario"])).toBe("inside");
    expect(fit("Virginia, United States", ["Virginia"])).toBe("inside");
  });

  it("matches a city only when the city is named exactly", () => {
    expect(fit("Austin, Texas, United States", ["Austin"])).toBe("inside");
    expect(fit("Austin, Texas, United States", ["Austin, United States"])).toBe("inside");
    // And does NOT resolve a bare city to its state: no gazetteer, no guess.
    expect(fit("Austin", ["Texas"])).toBe("unknown");
  });
});

describe("elsewhere, also on positive evidence only", () => {
  it("is a country nothing targets", () => {
    expect(fit("Paris, France", ["United States"])).toBe("elsewhere");
    expect(fit("Toronto, Ontario, Canada", ["Virginia"])).toBe("elsewhere");
    // The county-campaign incident's shape: US states targeted, person in Canada.
    expect(fit("Vancouver, British Columbia, Canada", ["Virginia", "Maryland"])).toBe("elsewhere");
  });

  it("is the right country but a state the targets exclude", () => {
    expect(fit("Columbus, Ohio, United States", ["Virginia", "Maryland"])).toBe("elsewhere");
    expect(fit("Ohio, United States", ["Virginia"])).toBe("elsewhere");
  });

  it("is NOT the right country when the targets are only cities there", () => {
    // Targets name a city and its country; another state in that country is
    // not evidence of being outside a city-level target.
    expect(fit("Columbus, Ohio, United States", ["Austin, United States"])).toBe("unknown");
  });
});

describe("unknown is the honest default, and it will be common", () => {
  it("covers every blank shape the sources actually write", () => {
    // internal leads write "", linkedin writes "" when the area is missing,
    // quickenrich writes no key at all, and a null column reads as null.
    for (const blank of ["", "   ", null, undefined]) {
      expect(fit(blank, ["Virginia"]), `blank: ${JSON.stringify(blank)}`).toBe("unknown");
    }
  });

  it("covers a place that names nothing we can resolve", () => {
    expect(fit("Greater Richmond Region", ["Virginia"])).toBe("unknown");
    expect(fit("Washington DC-Baltimore Area", ["Virginia"])).toBe("unknown");
    expect(fit("remote", ["Virginia"])).toBe("unknown");
  });

  it("treats a broad region TARGET as matching nothing rather than a country", () => {
    // Widening a SEARCH to the whole US for "Northeast" is a cheap
    // approximation the QuickEnrich adapter makes on purpose. Declaring a
    // Texan "inside" a Northeast campaign is a different and wrong claim.
    expect(fit("Boston, Massachusetts, United States", ["Northeast"])).toBe("unknown");
    expect(fit("Austin, Texas, United States", ["Northeast"])).toBe("unknown");
  });
});

describe("the place string prefers the canonical person's structured fields", () => {
  it("builds city, state, country when the person is linked", () => {
    expect(placeStringOf({ personCity: "Richmond", personState: "Virginia", personCountry: "United States" }))
      .toBe("Richmond, Virginia, United States");
    // Partial structured data still beats free text.
    expect(placeStringOf({ personState: "Virginia", personCountry: "United States", geography: "somewhere" }))
      .toBe("Virginia, United States");
  });

  it("falls back to the queue row's free text, and to empty", () => {
    expect(placeStringOf({ geography: "Austin, TX" })).toBe("Austin, TX");
    expect(placeStringOf({ personCity: "  ", geography: "  " })).toBe("");
    expect(placeStringOf({})).toBe("");
  });

  it("and the fallback really does carry a verdict", () => {
    // Apollo and WarmySender write "city, state, country" into geography, so
    // the free-text path is not a second-class one for them.
    expect(fit(placeStringOf({ geography: "Richmond, Virginia, United States" }), ["Virginia"])).toBe("inside");
  });
});

describe("target parsing", () => {
  it("separates countries, states and cities", () => {
    _clearTargetPlaceCache();
    const t = parseTargetPlaces(["United States", "Virginia", "Austin", "Kentucky, United States"]);
    expect(t.countries).toEqual(["US"]);
    expect(t.states.map((s) => s.name).sort()).toEqual(["kentucky", "virginia"]);
    expect(t.cities.map((c) => c.name)).toEqual(["austin"]);
    expect(t.empty).toBe(false);
  });

  it("reports empty for nothing, and for nothing usable", () => {
    expect(parseTargetPlaces([]).empty).toBe(true);
    expect(parseTargetPlaces(null).empty).toBe(true);
    expect(parseTargetPlaces(["", "   "]).empty).toBe(true);
  });

  it("is cacheable without becoming stale across different ICPs", () => {
    _clearTargetPlaceCache();
    const a = parseTargetPlaces(["Virginia"]);
    const b = parseTargetPlaces(["Ohio"]);
    expect(a.states[0].name).toBe("virginia");
    expect(b.states[0].name).toBe("ohio");
    // Same list, case-insensitively, is the same entry.
    expect(parseTargetPlaces(["virginia"])).toBe(a);
  });
});

describe("the scorer no longer uses a substring test", () => {
  it("scoreIcpMatch asks placeFit, and the old includes() is gone", () => {
    const engine = read("server/areEngine.ts");
    // 2026-11-01: this was a fixed 2000-character window, which stopped
    // reaching the geo block when the comment above it was corrected — the
    // test failed on a comment edit while the code it guards was untouched.
    // Anchored to the function's own last line instead, so it covers the whole
    // scorer however long the prose inside it gets.
    const scorerStart = engine.indexOf("function scoreIcpMatch");
    const scorerEnd = engine.indexOf("return Math.min(100, score);", scorerStart);
    expect(scorerEnd, "end of scoreIcpMatch").toBeGreaterThan(scorerStart);
    const scorer = engine.slice(scorerStart, scorerEnd);
    expect(scorer).toContain("placeFit(");
    // The exact expression measured as wrong in the evidence pass.
    expect(scorer).not.toContain("geo.includes(gg)");
  });
});

describe("the mode, its default, and its vocabulary", () => {
  it("defaults to flag — visible, nothing thrown away", () => {
    // Behaviour, not a pin: "unknown" is a common verdict here, so a default
    // that rejected would throw away people whose place we simply could not
    // read. Off and reject must both be explicit choices.
    expect(territoryModeOf(null)).toBe("flag");
    expect(territoryModeOf(undefined)).toBe("flag");
    expect(territoryModeOf({})).toBe("flag");
    expect(territoryModeOf({ territoryCheck: "nonsense" })).toBe("flag");
    expect(territoryModeOf({ territoryCheck: "flag" })).toBe("flag");
    expect(territoryModeOf({ territoryCheck: "off" })).toBe("off");
    expect(territoryModeOf({ territoryCheck: "reject" })).toBe("reject");
  });

  it("the client offers exactly the three values the server accepts", () => {
    const card = read("client/src/components/usip/are/CampaignTargetingCard.tsx");
    const engine = read("server/areEngine.ts");
    expect(engine).toContain('export type TerritoryMode = "off" | "flag" | "reject";');
    expect(card).toContain('type TerritoryMode = "off" | "flag" | "reject";');
    for (const v of ["off", "flag", "reject"]) {
      expect(card, `option ${v}`).toContain(`<option value="${v}">`);
    }
    // A fourth option on the client would be stored and silently read as
    // "flag" by territoryModeOf, so the two lists have to stay equal.
    expect((card.match(/<option value="/g) ?? []).length).toBe(3);
  });

  it("the auto-reject reason is the string the manual dialog already offers", () => {
    // One bucket in the Rejections tab for one fact. A near-identical second
    // label is the vocabulary drift this codebase keeps removing.
    const page = read("client/src/pages/usip/ARECampaignDetail.tsx");
    const reason = /export const TERRITORY_REJECT_REASON = "([^"]+)";/.exec(read("server/areEngine.ts"))?.[1];
    expect(reason, "TERRITORY_REJECT_REASON").toBeTruthy();
    const templates = page.slice(page.indexOf("const REJECT_TEMPLATES = ["), page.indexOf("];", page.indexOf("const REJECT_TEMPLATES = [")));
    expect(templates).toContain(`"${reason}"`);
  });
});

describe("what the check does, and what it refuses to do", () => {
  it("rejects only 'elsewhere', never 'unknown'", () => {
    const engine = read("server/areEngine.ts");
    // Auto-reject at queue time.
    expect(engine).toContain('territoryMode === "reject" && verdict === "elsewhere"');
    // And the paid-preview screen.
    expect(engine).toContain('targetPlaces) === "elsewhere"');
    // Nothing anywhere rejects on unknown.
    expect(engine).not.toMatch(/verdict === "unknown"[^\n]*reject/i);
  });

  it("screens the paid previews, where it saves the money F17 was written about", () => {
    const engine = read("server/areEngine.ts");
    const screen = engine.slice(engine.indexOf("screen: (rec) => {"), engine.indexOf("  });", engine.indexOf("screen: (rec) => {")));
    expect(screen.indexOf("placeFit("), "the place check inside screen()").toBeGreaterThan(-1);
    // The 83 prospects each cost an email lookup, so the check has to be on
    // the free masked preview rather than only after queueing.
    expect(screen).toContain("territoryMode !== \"off\"");
  });

  it("auto-reject queues the person as skipped with a reason, rather than dropping them", () => {
    // Dropped rows are invisible and unrecoverable; a verdict this often
    // "unknown" has to stay reviewable. skipped rows show in the Rejections
    // tab, restore puts them back, and discovery's working count already
    // excludes them so they cannot hold the queue at "full".
    const scraper = read("server/routers/are/scraper.ts");
    expect(scraper).toContain("__territoryReject");
    expect(scraper).toContain('? "skipped"');
    expect(scraper).toContain("rejectionReason: String((p as { __territoryReject?: string }).__territoryReject)");
    expect(scraper).toContain("rejectedAt: new Date()");
  });

  it("says what it did, and says which mode said it", () => {
    const engine = read("server/areEngine.ts");
    expect(engine).toContain("outsideTerritory.slice(0, 50), mode: territoryMode");
    // Literal substrings only: the singular/plural choice sits inside an
    // interpolation, so "were auto-rejected" never appears in the source.
    expect(engine).toContain("auto-rejected — restore any from the Rejections tab");
    expect(engine).toContain("flagged but kept (the territory check is set to flag only)");
  });
});

describe("the verdict is computed, never stored", () => {
  it("is derived per request from the campaign's CURRENT places", () => {
    // A stored verdict goes stale the moment someone retargets the campaign,
    // and a stale "outside" is the kind of wrong number this phase removes.
    const router = read("server/routers/are/prospects.ts");
    expect(router).toContain("const placeVerdict = placeFit(placeJudged, targetPlaces);");
    expect(router).toContain("return { ...queue, person, placeVerdict, placeJudged };");
    // No column was added for it.
    expect(read("drizzle/schema.ts")).not.toMatch(/placeVerdict|territoryVerdict/);
  });

  it("returns the place it judged, so the verdict can be argued with", () => {
    const router = read("server/routers/are/prospects.ts");
    expect(router).toContain("placeStringOf({ personCity, personState, personCountry, geography: r.geography })");
  });
});

describe("the badge never dresses unknown as outside", () => {
  // 2026-10-31: four, since `no_targets` split off from `unknown`. Its own
  // assertions live in the no_targets block; what this one still guards is
  // that every label is distinct and only `elsewhere` gets a warning colour.
  it("has four distinct labels and a neutral one for unknown", () => {
    const badge = read("client/src/components/usip/are/PlaceVerdictBadge.tsx");
    const labels = (badge.match(/label: "[^"]+"/g) ?? []);
    expect(labels).toHaveLength(4);
    expect(new Set(labels).size, "no two verdicts share a label").toBe(4);
    expect(badge).toContain('label: "In target area"');
    expect(badge).toContain('label: "Outside target area"');
    expect(badge).toContain('label: "Place unknown"');
    expect(badge).toContain('label: "No target area"');
    // Unknown is muted, not a warning colour, and says what it means.
    expect(badge).toContain("not the same as being outside the area");
    const unknown = badge.slice(badge.indexOf("unknown: {"), badge.indexOf("};", badge.indexOf("unknown: {")));
    expect(unknown).toContain("text-muted-foreground");
    expect(unknown).not.toMatch(/rose|amber|destructive/);
  });

  it("is the SAME component on the row and in the dossier", () => {
    for (const f of [
      "client/src/pages/usip/ARECampaignDetail.tsx",
      "client/src/components/usip/are/IntelligenceDossier.tsx",
    ]) {
      expect(read(f), f).toContain('from "@/components/usip/are/PlaceVerdictBadge"');
      expect(read(f), f).toContain("<PlaceVerdictBadge verdict=");
    }
  });
});

describe("no_targets is the campaign's gap, not the person's (2026-10-31)", () => {
  /**
   * Found by looking at the live app rather than at the code. ws 5 campaign 30
   * has neither an ICP profile nor overrides, so it names no places and every
   * one of its 11 rows read "Place unknown" — tooltip "Not enough place detail
   * to judge", above a prospect whose place said "Boston, MA".
   *
   * The verdict was right and the sentence was wrong, and wrong in the
   * expensive direction: it sent the reader to the prospect records when the
   * only thing that could fix it was the campaign's targeting.
   */
  it("judges a perfectly readable place as no_targets when nothing is targeted", () => {
    for (const place of ["Boston, MA", "Austin, Texas, United States", "Toronto, Ontario, Canada"]) {
      expect(fit(place, []), place).toBe("no_targets");
      // The distinction only earns its keep if it is NOT the person's verdict.
      expect(fit(place, []), place).not.toBe("unknown");
    }
  });

  it("still says unknown when the campaign DOES target and the place is unreadable", () => {
    // The two must not collapse in the other direction either: a real target
    // list plus a place we cannot read is the person's gap, and stays so.
    expect(fit("", ["Virginia"])).toBe("unknown");
    expect(fit("remote", ["Virginia"])).toBe("unknown");
    expect(fit("Greater Boston Area", ["Virginia"])).toBe("unknown");
  });

  it("changes nothing that acts on a verdict", () => {
    /**
     * The whole safety argument for a fourth member: every consumer tests for
     * `inside` or `elsewhere`, and `no_targets` is neither, so scoring, the
     * free-preview screen and auto-reject all behave exactly as before.
     */
    const engine = read("server/areEngine.ts");
    // An untargeted campaign scores every place the same, and never below zero.
    const noGeos = { titles: [], industries: [], geos: [], keywords: [] };
    expect(scoreIcpMatch({ geography: "Boston, MA" }, noGeos)).toBe(scoreIcpMatch({}, noGeos));
    expect(scoreIcpMatch({ geography: "Boston, MA" }, noGeos)).toBeGreaterThanOrEqual(0);
    // Every engine call site decides on `inside` or `elsewhere` within a few
    // lines of the call — a window, because the ternary that assigns the
    // verdict wraps and the comparison lands on a different line from the
    // call. `no_targets` is neither, so none of these change.
    let from = engine.indexOf("placeFit(");
    let sites = 0;
    while (from !== -1) {
      const around = engine.slice(Math.max(0, from - 250), from + 400);
      expect(around, `call site ${sites} decides on inside/elsewhere`).toMatch(/=== "(inside|elsewhere)"/);
      sites += 1;
      from = engine.indexOf("placeFit(", from + 1);
    }
    expect(sites, "engine call sites found").toBeGreaterThanOrEqual(3);
    // Nothing branches on the new member. (Not a blanket ban on `=== "unknown"`
    // in this file: `quickenrichPlaceCheck` is a different function with its
    // own three verdicts, and line ~3064 tallies them for a log.)
    expect(engine).not.toContain('=== "no_targets"');
  });

  it("gives the badge its own sentence, and stops blaming a place it never read", () => {
    const badge = read("client/src/components/usip/are/PlaceVerdictBadge.tsx");
    expect(badge).toContain('label: "No target area"');
    const block = badge.slice(badge.indexOf("no_targets: {"), badge.indexOf("};", badge.indexOf("no_targets: {")));
    expect(block).toContain("nothing to judge anyone against");
    // Neutral, like unknown: a campaign without targeting is a setup gap, not
    // a warning about this person.
    expect(block).toContain("text-muted-foreground");
    expect(block).not.toMatch(/rose|amber|destructive/);
    // And the "no place was recorded" tail must not reach it — that sentence
    // is the exact blame this verdict exists to remove.
    expect(badge).toContain('verdict === "no_targets" ? ""');
  });
});

describe("gaps found by mutation testing, 2026-10-30", () => {
  it("matches a city target exactly, never as a substring", () => {
    // Mutant m5 loosened the city comparison to `place.includes(target)`, and
    // nothing caught it. "York" is a real place and so is "New York"; a
    // substring match makes every New Yorker a hit for a York campaign.
    expect(fit("New York, New York, United States", ["York"])).toBe("unknown");
    expect(fit("New York, New York, United States", ["New York"])).toBe("inside");
    // And the same trap in the other direction.
    expect(fit("Kansas City, Missouri, United States", ["Kansas"])).toBe("elsewhere");
  });

  it("costs an unreadable place no more than being elsewhere — and that is 15", () => {
    /**
     * Renamed 2026-11-01. It was "never penalises a place it could not read",
     * which is what the scorer's own comment claimed and what the handoff note
     * repeated — and it is not what these numbers say: blank and elsewhere are
     * equal, and both sit 15 below inside. The old title was the over-claim,
     * the assertions under it were right all along, and nothing read the gap.
     * So the gap is asserted and named now, because that is the sentence the
     * comment in areEngine.ts is allowed to make.
     *
     * The original reason the assertions exist is unchanged: mutant m7 scored
     * `unknown` at -15 and nothing noticed, because no test looked at the
     * number. Two discovery sources write an empty string for place and a
     * third writes none at all, so scoring unknown BELOW elsewhere would push
     * whole sources down the queue for a property of our own data.
     */
    const icp = { titles: [], industries: [], geos: ["Virginia"], keywords: [] };
    const blank = scoreIcpMatch({}, icp);
    const elsewhere = scoreIcpMatch({ geography: "Columbus, Ohio, United States" }, icp);
    const inside = scoreIcpMatch({ geography: "Richmond, Virginia, United States" }, icp);
    expect(blank).toBe(0);
    expect(elsewhere).toBe(0);
    expect(inside).toBe(15);
    // Equal to each other, and both a full 15 behind in-territory. Either half
    // of that is a product decision; this records which one is in force.
    expect(blank).toBe(elsewhere);
    expect(inside - blank).toBe(15);
    // Nothing in the scorer may go negative: the column is an unsigned 0-100.
    expect(blank).toBeGreaterThanOrEqual(0);
    expect(elsewhere).toBeGreaterThanOrEqual(0);
  });

  it("and the comment above the scorer says that, rather than the opposite", () => {
    const engine = read("server/areEngine.ts");
    const scorer = engine.slice(engine.indexOf("function scoreIcpMatch"));
    const block = scorer.slice(0, scorer.indexOf("if (icp.geos.length > 0)"));
    // The clause that made the comment a claimed fix for something unfixed.
    expect(block).not.toContain("gave a row with NO place the same 0");
    // What it must say instead: the shared 0 is still here, the 15 is a real
    // cost, and nobody decided otherwise in passing.
    expect(block).toContain("WHAT DID NOT CHANGE");
    expect(block).toContain("IS a penalty");
    expect(block).toContain("is a product call and is NOT taken here");
  });

  it("keeps both early guards — and the first one now carries its own answer", () => {
    /**
     * Mutants m2 and m6 removed the `targets.empty` and the blank-place early
     * returns, and the suite stayed green — correctly, because the
     * `targeted.size > 0` check independently made both cases `unknown`.
     * Pinned as source, with that reasoning, so a later removal would be a
     * decision rather than a drift.
     *
     * 2026-10-31: that reasoning expired for the FIRST guard. `targets.empty`
     * now returns `no_targets`, which no other path produces, so deleting it
     * changes the answer rather than arriving at it another way. It is
     * load-bearing, and the "no_targets is the campaign's gap" block proves it
     * behaviourally — which is why only the blank-place guard still needs a
     * source pin.
     */
    const fitSrc = read("server/services/placeFit.ts");
    expect(fitSrc).toContain('if (parts.length === 0) return "unknown";');
    expect(fitSrc).toContain("if (placeCountry && targeted.size > 0) {");
  });
});

/**
 * Item 6 of the 2026-11-01 sweep, checked rather than assumed.
 *
 * The worry was that `no_targets` is reachable for a campaign that DOES name
 * places which `parseTargetPlaces` then fails to parse — in which case the
 * badge would tell the owner "This campaign names no places" about a campaign
 * that names several, hiding a silent data problem behind a wrong message.
 *
 * It is not reachable, for two independent reasons, and both are asserted here
 * because the conclusion rests on them:
 *
 *   1. An unparseable name is not dropped. Anything that is neither a country
 *      nor a region becomes a `cities` entry matched by exact name, so targets
 *      are non-empty for ANY non-blank string. "Northeast", "EMEA" and a typo
 *      all parse to something; they produce `unknown` or `elsewhere`, never
 *      `no_targets`.
 *   2. A blank name cannot reach `geos` at all. `icpLabels` trims and drops
 *      empty labels, so `icp.geos.length > 0` — the guard on the engine's
 *      scoring call site — implies at least one non-blank target.
 *
 * So `no_targets` means exactly "nothing was named", which is what the badge
 * says. The router's call site has no `geos.length` guard, which is why the
 * verdict reaches the badge on a campaign with no ICP at all: that is the live
 * case it was built for, not a second one.
 */
describe("no_targets means nothing was named, and cannot mean 'unparseable'", () => {
  it("gives every non-blank target name a verdict other than no_targets", () => {
    _clearTargetPlaceCache();
    const unparseable = ["Northeast", "EMEA", "APAC", "Virginai", "the midwest", "Zzzz, Qqqq", "12345"];
    for (const name of unparseable) {
      expect(parseTargetPlaces([name]).empty, name).toBe(false);
      expect(fit("Boston, Massachusetts, United States", [name]), name).not.toBe("no_targets");
      // And a blank place against them is still the PERSON's gap.
      expect(fit("", [name]), name).toBe("unknown");
    }
  });

  it("is empty only when the list reduces to nothing", () => {
    _clearTargetPlaceCache();
    expect(parseTargetPlaces([]).empty).toBe(true);
    expect(parseTargetPlaces(null).empty).toBe(true);
    expect(parseTargetPlaces(undefined).empty).toBe(true);
    // Blank strings are the only non-empty input that reduces to empty — and
    // the next test shows they never get this far.
    expect(parseTargetPlaces(["", "   "]).empty).toBe(true);
    expect(parseTargetPlaces(["   ", "Virginia"]).empty).toBe(false);
  });

  it("cannot be reached from a stored ICP, because icpLabels drops blanks", () => {
    // If this stops holding, `geos.length > 0` no longer implies a parseable
    // target and the engine's scoring site can see no_targets — harmless to
    // the score, which tests for "inside", but the premise above would need
    // rewriting rather than patching.
    expect(icpLabels(["", "   ", "Virginia"], "geography")).toEqual(["Virginia"]);
    expect(icpLabels(["", "   "], "geography")).toEqual([]);
    expect(icpLabels([{ region: "", country: "" }], "geography")).toEqual([]);
  });

  it("tells that sentence only to someone whose campaign named nothing", () => {
    const badge = read("client/src/components/usip/are/PlaceVerdictBadge.tsx");
    expect(badge).toContain("This campaign names no places");
    // The call site that feeds the badge computes the verdict unguarded, which
    // is how the live ws 5 campaign 30 case renders it. Nothing may start
    // treating no_targets as a judgement about the person.
    const router = read("server/routers/are/prospects.ts");
    expect(router).toContain("const placeVerdict = placeFit(placeJudged, targetPlaces);");
    expect(router).not.toContain('placeVerdict === "no_targets"');
  });
});

/**
 * One country vocabulary, not two (2026-11-01).
 *
 * `services/quickenrich.ts` kept a byte-identical private copy of the table
 * `services/prospectSources/bridge.ts` exports. Noted on 2026-10-30 and
 * deliberately left alone then — quickenrich.ts is a live vendor path and that
 * was not the change to destabilise — so this collapses it as its own change,
 * after checking the two were still identical character for character. They
 * were, all 24 entries, so there was no side to pick.
 *
 * It matters because of what the two copies are FOR. `quickenrichPlaceCheck`
 * decides whether to spend a credit on a person; `placeFit` decides what the
 * badge tells the owner about that same person. Let the tables drift and one
 * surface calls someone inside the territory while the other calls them
 * elsewhere — the class of bug F17 exists to remove, arriving through the back
 * door as a maintenance accident rather than a logic error.
 */
describe("the country table has one definition", () => {
  it("is defined once in the server tree, and quickenrich imports it", () => {
    const quickenrich = read("server/services/quickenrich.ts");
    expect(quickenrich).toContain('import { COUNTRY_CODES, regionCountry } from "./prospectSources/bridge";');
    // The definition, not the uses.
    expect(quickenrich).not.toContain("const COUNTRY_CODES: Record<string, string> = {");
    expect(read("server/services/prospectSources/bridge.ts")).toContain("export const COUNTRY_CODES: Record<string, string> = {");
  });

  it("is the same vocabulary both callers read, tested through both", () => {
    // Not a source pin: the two functions are asked the same question about
    // the same person and must not disagree about what country they are in.
    // "england" is in the table and is not a US state, which makes it the case
    // a drifted copy would get wrong in opposite directions.
    expect(quickenrichPlaceCheck("London, England", [{ place: "Virginia, United States", name: "Virginia", country: "US" }])).toBe("elsewhere");
    expect(fit("London, England", ["Virginia, United States"])).toBe("elsewhere");
    // And agreement on the shared country, where neither may say "elsewhere".
    expect(quickenrichPlaceCheck("Richmond, Virginia, United States", [{ place: "Virginia, United States", name: "Virginia", country: "US" }])).toBe("inside");
    expect(fit("Richmond, Virginia, United States", ["Virginia, United States"])).toBe("inside");
  });
});
