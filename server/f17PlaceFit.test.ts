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
      expect(fit(place, []), `no targets: ${place}`).toBe("unknown");
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
    const scorer = engine.slice(engine.indexOf("function scoreIcpMatch"), engine.indexOf("function scoreIcpMatch") + 2000);
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
  it("has three distinct labels and a neutral one for unknown", () => {
    const badge = read("client/src/components/usip/are/PlaceVerdictBadge.tsx");
    expect(badge).toContain('label: "In target area"');
    expect(badge).toContain('label: "Outside target area"');
    expect(badge).toContain('label: "Place unknown"');
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

  it("never penalises a place it could not read", () => {
    // Mutant m7 scored `unknown` at -15 and nothing noticed, because no test
    // looked at the number. An unreadable place must cost nothing: two
    // discovery sources write an empty string and a third writes none at all,
    // so penalising unknown would push whole sources down the queue for a
    // property of our own data rather than of the person.
    const icp = { titles: [], industries: [], geos: ["Virginia"], keywords: [] };
    const blank = scoreIcpMatch({}, icp);
    const elsewhere = scoreIcpMatch({ geography: "Columbus, Ohio, United States" }, icp);
    const inside = scoreIcpMatch({ geography: "Richmond, Virginia, United States" }, icp);
    expect(blank).toBe(0);
    expect(elsewhere).toBe(0);
    expect(inside).toBe(15);
    // Nothing in the scorer may go negative: the column is an unsigned 0-100.
    expect(blank).toBeGreaterThanOrEqual(0);
    expect(elsewhere).toBeGreaterThanOrEqual(0);
  });

  it("keeps both early guards, though either alone yields the same answer", () => {
    /**
     * Mutants m2 and m6 removed the `targets.empty` and the blank-place
     * early returns, and the suite stayed green — correctly, because the
     * `targeted.size > 0` check independently makes both cases `unknown`.
     * They are redundant by construction, not dead by accident, and the
     * redundancy is deliberate: the two traps this module exists to avoid are
     * each guarded where a reader will look for them. Pinned as source, with
     * this comment, so a later removal is a decision rather than a drift.
     */
    const fitSrc = read("server/services/placeFit.ts");
    expect(fitSrc).toContain('if (targets.empty) return "unknown";');
    expect(fitSrc).toContain('if (parts.length === 0) return "unknown";');
    expect(fitSrc).toContain("if (placeCountry && targeted.size > 0) {");
  });
});
