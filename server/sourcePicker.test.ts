/**
 * Per-run source picker on Find Prospects and Source search (owner ask
 * 2026-09-22). The Revenue Engine already had a per-campaign picker; the two
 * manual surfaces ran a fixed fan-out. The rules that matter:
 *
 *   • the workspace mask still wins — a selection can never re-enable a
 *     source Settings disabled, nor add one the mode does not offer;
 *   • an absent selection means every enabled candidate (the old behaviour);
 *   • the picker's lists ARE the service's lists, pinned equal, so the page
 *     can never offer a source the run would not use or hide one it would —
 *     the old prose list under-reported the fan-out once already;
 *   • Source search passes the selection through eligibleFor's `only`, the
 *     same door the engine uses for a campaign's prospectSources, so mask,
 *     credentials, capability match, circuit and budget still apply.
 *
 * The rule is pure and tested directly; the wiring is checked structurally
 * because a picker nothing reads is exactly the defect shape this codebase
 * keeps finding.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { selectRunSources, type AreSourceId } from "@shared/areSources";

const svc = readFileSync("server/services/discovery/index.ts", "utf8");
const discoveryRouter = readFileSync("server/routers/discovery.ts", "utf8");
const finder = readFileSync("client/src/pages/usip/FindProspects.tsx", "utf8");
const sourceSearch = readFileSync("client/src/pages/usip/SourceSearch.tsx", "utf8");
const runs = readFileSync("server/services/prospectSources/searchRuns.ts", "utf8");
const psRouter = readFileSync("server/routers/prospectSources.ts", "utf8");
const registry = readFileSync("server/services/prospectSources/registry.ts", "utf8");

/** The `id: "x"` entries of one mode's candidates array in the service, in order. */
function serviceCandidates(mode: "person" | "account"): string[] {
  const start = svc.indexOf('mode === "person"\n    ? [');
  expect(start, "candidates block moved — re-anchor").toBeGreaterThan(-1);
  const split = svc.indexOf("    : [", start);
  const end = svc.indexOf("    ];", split);
  expect(split).toBeGreaterThan(start);
  expect(end).toBeGreaterThan(split);
  const block = mode === "person" ? svc.slice(start, split) : svc.slice(split, end);
  const ids = Array.from(block.matchAll(/\{ id: "([a-z_]+)"/g)).map((m) => m[1]);
  expect(ids.length, `${mode}: no candidates parsed — the scanner cannot see`).toBeGreaterThan(2);
  return ids;
}

/** One of the page's list constants, as written. */
function clientList(name: string): string[] {
  const m = finder.match(new RegExp(`const ${name}: AreSourceId\\[\\] = \\[([^\\]]+)\\]`));
  expect(m, `${name} missing from FindProspects.tsx`).not.toBeNull();
  return m![1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
}

const count = (src: string, needle: string) => src.split(needle).length - 1;

describe("selectRunSources — the mask wins, the selection narrows", () => {
  const cands: AreSourceId[] = ["linkedin", "web", "news", "apollo", "quickenrich"];
  const all = new Set<string>(cands);

  it("no selection runs every enabled candidate, in candidate order", () => {
    expect(selectRunSources(cands, all, null)).toEqual({ run: cands, masked: [], unselected: [] });
    expect(selectRunSources(cands, all, undefined).run).toEqual(cands);
  });

  it("a selection narrows to the chosen candidates, keeping candidate order", () => {
    const r = selectRunSources(cands, all, ["apollo", "web"]);
    expect(r.run).toEqual(["web", "apollo"]);
    expect(r.unselected).toEqual(["linkedin", "news", "quickenrich"]);
    expect(r.masked).toEqual([]);
  });

  it("cannot re-enable a source the workspace disabled", () => {
    const enabled = new Set<string>(["linkedin", "news", "apollo", "quickenrich"]); // web masked
    const r = selectRunSources(cands, enabled, ["web", "apollo"]);
    expect(r.run).toEqual(["apollo"]);
    expect(r.masked).toEqual(["web"]);
    // Masked is reported as masked, never as "you did not pick it".
    expect(r.unselected).toEqual(["linkedin", "news", "quickenrich"]);
  });

  it("ignores ids the mode does not offer", () => {
    expect(selectRunSources(cands, all, ["google_business", "web"]).run).toEqual(["web"]);
  });

  it("an explicit selection naming nothing valid runs nothing, and says so", () => {
    const r = selectRunSources(cands, all, ["bogus"]);
    expect(r.run).toEqual([]);
    expect(r.unselected).toEqual(cands);
  });
});

describe("Find Prospects — the picker is the fan-out", () => {
  it("offers exactly the sources the service runs, per mode, in the same order", () => {
    expect(clientList("PERSON_SOURCES")).toEqual(serviceCandidates("person"));
    expect(clientList("ACCOUNT_SOURCES")).toEqual(serviceCandidates("account"));
  });

  it("sends the selection with both modes and refuses an empty one", () => {
    expect(count(finder, "sources: runSources")).toBe(2);
    expect(finder).toContain('toast.error("Pick at least one source")');
    // A disabled source is shown locked, not hidden — the user sees why.
    expect(finder).toContain("Disabled in Settings → Revenue Engine");
  });

  it("the router accepts a selection and the service narrows AFTER the mask", () => {
    expect(count(discoveryRouter, "sources: z.array(")).toBe(2);
    expect(discoveryRouter).toContain("{ sources: input.sources ?? null }");
    expect(svc).toContain("selectRunSources(candidates.map((c) => c.id), enabledSources, opts?.sources)");
    // Order matters: the mask is resolved first, then the selection narrows it.
    const maskAt = svc.indexOf("resolveSourceOrder(wsSourceRow?.order, wsSourceRow?.mask, ARE_SOURCE_IDS)");
    const pickAt = svc.indexOf("selectRunSources(");
    expect(maskAt).toBeGreaterThan(-1);
    expect(pickAt).toBeGreaterThan(maskAt);
    // What was left out is in the run log, so "no results" is explainable.
    expect(svc).toContain('"discovery.select"');
    expect(svc).toContain("Skipped — not selected for this run");
  });
});

describe("Source search — the picker goes through the engine's own door", () => {
  it("offers a checkbox per usable source and sends the selection", () => {
    expect(sourceSearch).toContain("onCheckedChange={() => toggleSource(s.slug)}");
    expect(sourceSearch).toContain("sources: runSources");
    expect(sourceSearch).toContain("Pick at least one source.");
    // The combined allowance readout follows the selection.
    expect(sourceSearch).toContain("!s.enabled || !chosenSet.has(s.slug)");
  });

  it("the selection reaches eligibleFor through `only`", () => {
    expect(psRouter).toContain("sources: z.array(slugSchema).min(1).optional()");
    expect(psRouter).toContain("input.batchTarget, input.sources ?? null)");
    expect(runs).toContain("executeRun(workspaceId, runId, { only: only ?? null })");
    expect(runs).toContain("eligibleFor(workspaceId, criteria, { only: opts?.only ?? null })");
    // The skip reason the inspector shows for a source left out of the run.
    expect(registry).toContain('reason: "not_selected", detail: "not selected for this run"');
  });
});
