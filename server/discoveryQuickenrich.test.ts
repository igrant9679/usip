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
import { ARE_DEFAULT_SOURCE_ORDER, ARE_SOURCE_IDS, resolveSourceOrder } from "../shared/areSources";

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

describe("QuickEnrich is the PRIMARY source (owner decision 2026-08-24), and the order is workspace-configurable", () => {
  // Task order IS dedup priority: settled results are walked in tasks order
  // and identity claims are first-wins, so an earlier source's row is the
  // one that enters the queue when two sources find the same person. The
  // order comes from resolveSourceOrder — EXECUTED here, not grepped.
  it("the default checking order puts quickenrich first and covers every source", () => {
    expect(ARE_DEFAULT_SOURCE_ORDER[0]).toBe("quickenrich");
    expect([...ARE_DEFAULT_SOURCE_ORDER].sort()).toEqual([...ARE_SOURCE_IDS].sort());
  });

  it("resolveSourceOrder: stored order wins, unmentioned sources append in default order", () => {
    const r = resolveSourceOrder(["news", "internal"], null, ARE_SOURCE_IDS);
    expect(r.slice(0, 2)).toEqual(["news", "internal"]);
    expect(r).toEqual(["news", "internal", ...ARE_DEFAULT_SOURCE_ORDER.filter((s) => s !== "news" && s !== "internal")]);
  });

  it("resolveSourceOrder: the workspace mask disables a source everywhere, unknown ids drop, selection filters", () => {
    expect(resolveSourceOrder(null, { apollo: false }, ARE_SOURCE_IDS)).not.toContain("apollo");
    // absent/true = enabled — an old sparse mask must not disable working sources
    expect(resolveSourceOrder(null, { apollo: true }, ARE_SOURCE_IDS)).toContain("quickenrich");
    expect(resolveSourceOrder(["events", "quickenrich"], null, ARE_SOURCE_IDS)[0]).toBe("quickenrich");
    expect(resolveSourceOrder(null, null, ["web"])).toEqual(["web"]);
  });

  it("the engine builds its tasks FROM the resolver and walks them in order", () => {
    expect(engine).toContain("resolveSourceOrder(wsSourceRow?.order, wsSourceRow?.mask, sources as AreSourceId[])");
    expect(engine).toContain("runOrder.map((id) => taskFactories[id]())");
    expect(engine).toContain("const settled = await Promise.allSettled(tasks)");
    expect(engine).toContain("for (const s of settled)");
  });

  it("the Find-prospects fan-out honours the same mask through the same resolver", () => {
    expect(svc).toContain("resolveSourceOrder(wsSourceRow?.order, wsSourceRow?.mask, ARE_SOURCE_IDS)");
    expect(svc).toContain("disabled in workspace Settings");
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
