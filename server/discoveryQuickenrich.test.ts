/**
 * QuickEnrich in the Find-prospects fan-out (owner ask 2026-08-21).
 *
 * The contract: the SAME finder, the SAME budget, the SAME ranking as the
 * ARE campaigns' `quickenrich` source — one QuickEnrich allowance across
 * both surfaces. The budget only holds if every consumer WRITES the ledger
 * it reads; wiring this exposed that the discovery Apollo source consulted
 * its cap but never wrote a pull back (silent double-spend), fixed here for
 * both via one recordPullLedger.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { toRawFindRow } from "../server/services/discovery/index";

const svc = readFileSync("server/services/discovery/index.ts", "utf8");
const engine = readFileSync("server/areEngine.ts", "utf8");
const page = readFileSync("client/src/pages/usip/FindProspects.tsx", "utf8");

describe("QuickEnrich as a Find-prospects source", () => {
  it("person mode fans out to quickenrich; account mode does not (it is a people DB)", () => {
    const person = svc.slice(svc.indexOf('if (mode === "person") {'), svc.indexOf("} else {", svc.indexOf('if (mode === "person") {')));
    expect(person).toContain('({ source: "quickenrich", raw })');
    const account = svc.slice(svc.indexOf("// Account mode keeps the company-shaped sources"), svc.indexOf("const settled = await Promise.allSettled(tasks)"));
    expect(account).not.toContain("quickenrich");
  });

  it("shares the campaigns' budget vocabulary end to end — cap, used, headroom, ranking", () => {
    const fn = svc.slice(svc.indexOf("async function discoverViaQuickEnrich"), svc.indexOf("export type SearchMode"));
    expect(fn).toContain("getQuickenrichDailyPullCap(workspaceId)");
    expect(fn).toContain("quickenrichPulledToday(workspaceId)");
    expect(fn).toContain("buildQuickenrichFilters(");
    // has_email first — the paid lookup converts those, so they get headroom
    // before the maybes; identical rule to the ARE source.
    expect(fn).toContain("Number(b.hasEmail) - Number(a.hasEmail)");
    expect(fn).toContain(".slice(0, headroom)");
    // Refuses to search their whole database with no title/industry filter.
    expect(fn).toContain("if (!body) return []");
    // Same helpers the engine's source uses — one vocabulary, two callers.
    for (const sym of ["getQuickenrichDailyPullCap", "quickenrichPulledToday", "buildQuickenrichFilters", "quickenrichContactFinder"]) {
      expect(engine, `engine also uses ${sym}`).toContain(sym);
    }
  });

  it("every pull WRITES the ledger the caps read — quickenrich AND the Apollo leak found alongside", () => {
    const fn = svc.slice(svc.indexOf("async function discoverViaQuickEnrich"), svc.indexOf("export type SearchMode"));
    expect(fn).toContain('recordPullLedger(workspaceId, "quickenrich"');
    const apollo = svc.slice(svc.indexOf("async function discoverViaApollo"), svc.indexOf("export type SearchMode"));
    expect(apollo).toContain('recordPullLedger(workspaceId, "apollo"');
    const ledger = svc.slice(svc.indexOf("async function recordPullLedger"), svc.indexOf("async function discoverViaApollo"));
    expect(ledger).toContain("db.insert(areScrapeJobs)");
    expect(ledger).toContain('status: "complete"');
  });

  it("raw-find rows are clamped to COLUMN widths — one long headline must never lose a run", () => {
    // Live 2026-08-21: the generic 400-char clamp exceeded varchar(80/200)
    // columns, MySQL strict mode rejected the row, and the multi-row insert
    // took the whole run's finds down with it. QuickEnrich rows were merely
    // the first with a >200-char title.
    const long = "x".repeat(500);
    const row = toRawFindRow(1, 1, "quickenrich", {
      firstName: long, lastName: long, title: long, companyName: long,
      companyDomain: long, location: long, pageTitle: long,
    });
    expect(row.firstName!.length).toBeLessThanOrEqual(80);
    expect(row.lastName!.length).toBeLessThanOrEqual(80);
    expect(row.title!.length).toBeLessThanOrEqual(200);
    expect(row.companyName!.length).toBeLessThanOrEqual(200);
    expect(row.companyDomain!.length).toBeLessThanOrEqual(200);
    expect(row.location!.length).toBeLessThanOrEqual(200);
    expect(row.pageTitle!.length).toBeLessThanOrEqual(400);
    // And the insert has a per-row fallback so an unstorable row is skipped,
    // not fatal to every source's finds.
    expect(svc).toContain("raw_find row unstorable, skipped");
  });

  it("the wizard's source list matches the fan-out per mode, QuickEnrich and Apollo included", () => {
    expect(page).toContain("LinkedIn · Web · News · Apollo · QuickEnrich");
    expect(page).toContain("Google Business · Web · News · Apollo");
  });
});

describe("QuickEnrich is the PRIMARY external ARE source (owner decision 2026-08-24)", () => {
  // Task order IS dedup priority: settled results are walked in tasks order
  // and identity claims are first-wins, so an earlier source's row is the
  // one that enters the queue when two sources find the same person.
  const tasksBlock = engine.slice(
    engine.indexOf("const tasks: Array<Promise<SourceResult>>"),
    engine.indexOf("if (tasks.length === 0)"),
  );

  it("the tasks block boundary is where we think it is", () => {
    expect(tasksBlock.length).toBeGreaterThan(0);
    expect(tasksBlock).toContain('sources.includes("quickenrich")');
  });

  it("quickenrich is queued after internal CRM and before every scraper", () => {
    const at = (marker: string) => {
      const i = tasksBlock.indexOf(`sources.includes("${marker}")`);
      expect(i, `source "${marker}" missing from the tasks block`).toBeGreaterThan(-1);
      return i;
    };
    // Internal first: people the workspace already knows, with real emails
    // and history a fresh QuickEnrich row cannot match.
    expect(at("internal")).toBeLessThan(at("quickenrich"));
    // QuickEnrich ahead of every external scraper — its rows arrive
    // LinkedIn-keyed with has_email flags; scraper rows are what built the
    // email-less sediment.
    for (const scraper of ["linkedin", "apollo", "google_business", "news", "web"]) {
      expect(at("quickenrich"), `quickenrich must precede ${scraper}`).toBeLessThan(at(scraper));
    }
  });

  it("the settled walk preserves task order (first-claim-wins depends on it)", () => {
    expect(engine).toContain("const settled = await Promise.allSettled(tasks)");
    expect(engine).toContain("for (const s of settled)");
  });
});

describe("QuickEnrich page rotation is threaded through the engine", () => {
  it("the pull requests the persisted cursor's page, keyed to the filters actually sent", () => {
    expect(engine).toContain("body.page = currentQuickenrichPage(qePageState, qeKey)");
    expect(engine).toContain("nextQuickenrichPage(qePageState, qeKey, res.people.length)");
  });

  it("runDiscovery persists the advanced cursor WITHOUT clobbering it on a skipped pull", () => {
    expect(engine).toContain("qe: quickenrichNextPage ?? persistedState.qe ?? null");
  });

  it("a failed request holds the cursor (nextQe null) rather than skipping unseen people", () => {
    const fn = engine.slice(
      engine.indexOf("async function discoverViaQuickenrich"),
      engine.indexOf("async function discoverViaInternalCrm"),
    );
    const failBranch = fn.slice(fn.indexOf("if (!res.ok)"), fn.indexOf("const nextQe"));
    expect(failBranch).toContain("nextQe: null");
  });
});
