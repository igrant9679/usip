/**
 * The Scraper tab's discovery launcher says what it will do before it spends
 * money. Until 2026-11-01 it said four wrong things in one sentence:
 *
 *   "One-click search across LinkedIn + Web + News + Google Business using
 *    this campaign's targeting. Results are consolidated, scored, and saved
 *    to /prospects"
 *
 *   • Web was removed as a source on 2026-10-27 (P62/A25): it reads a page at
 *     a URL and discovery hands it search text, so it found nobody, every
 *     tick. It is not in ARE_SOURCES and not a candidate here.
 *   • Google Business is an ACCOUNT-mode candidate. This button sends
 *     `mode: "person"`, so it never runs it.
 *   • Apollo and QuickEnrich ARE run, and were not mentioned — half the list,
 *     including the only source that returned anything on ws 2 campaign 38.
 *   • /prospects was retired in Phase 5 item 2 and redirects to /v2/people.
 *
 * So this reads the candidate list out of the service and fails if the
 * sentence and the list disagree. The point is not the wording: it is that a
 * control which spends vendor credits must not describe a different run from
 * the one it performs.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARE_SOURCE_IDS } from "@shared/areSources";
import { RETIRED_ROUTES } from "@/lib/retiredRoutes";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

const service = read("server/services/discovery/index.ts");
const page = read("client/src/pages/usip/ARECampaignDetail.tsx");

/**
 * The launcher COMPONENT, from its signature to the next one — deliberately
 * not including its doc comment, which names Web and Google Business in order
 * to record why neither is claimed. Asserting against the comment as well made
 * "names nothing it does not run" fail on the explanation of itself.
 */
const launcher = (() => {
  const start = page.indexOf("function CampaignDiscoveryLauncher(");
  const end = page.indexOf("function LogsTab", start);
  expect(start, "CampaignDiscoveryLauncher").toBeGreaterThan(-1);
  expect(end, "LogsTab after the launcher").toBeGreaterThan(start);
  return page.slice(start, end);
})();

/** Its doc comment, where the exclusions are explained rather than claimed. */
const launcherDoc = (() => {
  const start = page.indexOf("/** One-click multi-source discovery launcher");
  expect(start, "launcher doc comment").toBeGreaterThan(-1);
  return page.slice(start, page.indexOf("function CampaignDiscoveryLauncher(", start));
})();

/** Candidate ids in one branch of the mode split. */
function candidates(mode: "person" | "account"): string[] {
  const split = service.indexOf('const candidates: SourceTask[] = mode === "person"');
  expect(split, "the mode split in runDiscovery").toBeGreaterThan(-1);
  const q = service.indexOf("\n    ? [", split);
  const colon = service.indexOf("\n    : [", split);
  const close = service.indexOf("\n    ];", colon);
  expect(q, "person branch").toBeGreaterThan(split);
  expect(colon, "account branch").toBeGreaterThan(q);
  expect(close, "end of the account branch").toBeGreaterThan(colon);
  const block = mode === "person" ? service.slice(q, colon) : service.slice(colon, close);
  return [...block.matchAll(/\{ id: "([a-z_]+)"/g)].map((m) => m[1]);
}

/** What the sentence has to call each source for a reader to recognise it. */
const SPOKEN: Record<string, string> = {
  linkedin: "LinkedIn",
  news: "news",
  apollo: "Apollo",
  quickenrich: "QuickEnrich",
  google_business: "Google Business",
  internal: "Internal CRM",
  warmysender: "WarmySender",
};

describe("the discovery launcher describes the run it actually performs", () => {
  it("runs person mode, so its candidates are the person-mode four", () => {
    // If this fails, a source was added or removed and the sentence below it
    // is now wrong. Fix the sentence, not this list.
    expect(candidates("person")).toEqual(["linkedin", "news", "apollo", "quickenrich"]);
    expect(launcher).toContain('mode: "person"');
  });

  it("names every source it runs", () => {
    for (const id of candidates("person")) {
      const word = SPOKEN[id];
      expect(word, "no spoken name for source '" + id + "' — add one and put it in the copy").toBeTruthy();
      expect(launcher, id).toContain(word);
    }
  });

  it("names nothing it does not run", () => {
    // Google Business is real, and belongs to the other mode. Claiming it here
    // is the same error as claiming Web: a source the reader will look for in
    // the results and never find.
    expect(candidates("account")).toContain("google_business");
    expect(launcher).not.toContain("Google Business");
    // Web is not a source anywhere any more.
    expect(ARE_SOURCE_IDS as readonly string[]).not.toContain("web");
    expect(launcher).not.toMatch(/\bWeb\b/);
    // Both exclusions stay explained next to the control, so the next person
    // to "fix" the copy by adding them back reads why first.
    expect(launcherDoc).toContain("Google Business runs in ACCOUNT");
    expect(launcherDoc).toContain("Web was removed as a source");
  });

  it("links where the people actually land, and not at a retired path", () => {
    // consolidate.ts inserts into `prospects`, the People table.
    expect(read("server/services/discovery/consolidate.ts")).toContain("await db.insert(prospects).values({");
    expect(launcher).toContain('href="/v2/people"');
    expect(launcher).not.toContain('href="/prospects"');
    // And the destination agrees with the retirement map, so the copy and the
    // redirect cannot point two different ways.
    expect(RETIRED_ROUTES["/prospects"]).toBe("/v2/people");
    expect(read("client/src/App.tsx")).toContain('<Route path="/v2/people">');
  });

  it("keeps the two 'needs review' nouns apart", () => {
    /**
     * Corrected mid-PR, 2026-11-01. This first asserted the doc comment did
     * NOT mention Needs Review at all, on the reasoning that the run summary's
     * needs-review count is about ACCOUNTS from company association. That
     * reasoning was wrong by omission: discovered PEOPLE also carry a
     * needs_review state, as a `verificationStatus` set by confidence tier. So
     * banning the phrase deleted something true. Both exist, they are
     * different, and the comment has to say which it means.
     */
    // The people: a status on the row, by confidence tier.
    expect(read("server/services/discovery/consolidate.ts"))
      .toContain('const status: ScoredCandidate["status"] = tier === "high" ? "verified" : "needs_review";');
    // The accounts: a count in the run summary, from company association.
    expect(service).toContain("accounts created, ${s.needsReview} need review");
    // And the comment names both rather than one or neither.
    expect(launcherDoc).toContain("verificationStatus");
    expect(launcherDoc).toContain("counts ACCOUNTS from company association");
  });

  it("the Find Prospects help article names the same two lists", () => {
    // Found by the repo-wide sweep, 2026-11-01: it carried "Web" in BOTH the
    // Person and the Account list. Everything else in it was already right.
    const seed = read("server/seedHelpContent.ts");
    const i = seed.indexOf("**Find Prospects** (sidebar");
    expect(i, "the Find Prospects article").toBeGreaterThan(-1);
    const article = seed.slice(i, seed.indexOf("`,", i));
    expect(article).toContain("Person: LinkedIn, News, Apollo, QuickEnrich");
    expect(article).toContain("Account: Google Business, News, Apollo");
    expect(article).not.toMatch(/\bWeb\b/);
  });

  it("the engine's own explainer names the real sources, and no removed one", () => {
    /**
     * The worst instance the sweep found. It claimed "web scraping" AND
     * "industry event attendee lists" — and `events` was not merely removed,
     * it was disabled for FABRICATING attendees (see shared/areSources.ts), so
     * the page explaining how the engine works advertised a source taken out
     * for inventing people. It also omitted the three vendor databases, which
     * are the sources that actually return rows.
     */
    const hub = read("client/src/pages/usip/AREHub.tsx");
    const i = hub.indexOf('title: "Prospect Discovery"');
    expect(i, "the Prospect Discovery card").toBeGreaterThan(-1);
    const card = hub.slice(i, hub.indexOf("},", i));
    for (const word of ["CRM", "QuickEnrich", "Apollo", "WarmySender", "Google Business", "LinkedIn", "news"]) {
      expect(card, word).toContain(word);
    }
    // One word per ARE source, so an eighth source makes this fail rather than
    // leaving the explainer quietly short.
    expect(ARE_SOURCE_IDS).toHaveLength(7);
  });

  it("no copy file advertises a source that was taken out", () => {
    /**
     * The point of the sweep, kept. The defect was never "stale copy on one
     * control" — it was one wrong source list copied into several homes, and
     * three of the four were found only by looking for the others.
     *
     * Both phrases are banned outright. "web scraping" because the source is
     * gone; a URL scrape still exists on the campaign's Scraper tab and should
     * be called that, so if this fails on legitimate Scraper-tab copy, name the
     * tab rather than widening the ban. "event attendee" because `events` was
     * disabled for fabricating them, which no copy should ever offer.
     */
    const COPY = [
      "server/seedHelpContent.ts",
      "server/seedHelpOperatorManual.ts",
      "server/productKnowledge.ts",
      "client/src/pages/usip/AREHub.tsx",
      "client/src/pages/usip/ARECampaignDetail.tsx",
      "client/src/pages/usip/ARECampaigns.tsx",
      "client/src/pages/usip/ARESettings.tsx",
    ];
    for (const f of COPY) {
      const text = read(f);
      expect(text, f + " claims web scraping").not.toMatch(/web scraping/i);
      expect(text, f + " claims event attendees").not.toMatch(/event attendee/i);
    }
    expect(ARE_SOURCE_IDS as readonly string[]).not.toContain("events");
  });

  it("the Find Prospects tour names the same sources, and not web", () => {
    /**
     * The fourth home for this claim, found while checking the other three
     * (2026-11-01). The seeded tour step for /find-prospects read "Results fan
     * out across LinkedIn, web, and news" — the same removed source, and the
     * same two missing ones, one surface over. That page runs BOTH modes, so
     * it names both lists.
     */
    const seed = read("server/seedHelpContent.ts");
    const step = seed.slice(seed.indexOf('{ title: "Run discovery"'));
    const body = step.slice(0, step.indexOf("},") + 2);
    expect(body).not.toMatch(/\bweb\b/i);
    for (const word of ["LinkedIn", "Apollo", "QuickEnrich", "news", "Google Business"]) {
      expect(body, word).toContain(word);
    }
  });
});
