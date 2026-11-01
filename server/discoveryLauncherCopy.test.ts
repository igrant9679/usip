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

  it("does not promise a review queue for the people it finds", () => {
    // The doc comment said results land in "/prospects (verified) or the Needs
    // Review queue". The needs-review count in the run summary is ACCOUNTS
    // needing review from company association — every person found is
    // persisted. Two different nouns, one of which sent a reader looking for a
    // queue that was never holding their prospects.
    expect(launcher).not.toContain("Needs Review");
    expect(launcherDoc).not.toContain("Needs Review");
    expect(service).toContain("accounts created, ${s.needsReview} need review");
  });
});
