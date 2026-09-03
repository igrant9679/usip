/**
 * Step performance dispatch table: filter + sort (owner ask 2026-09-03:
 * "filter and sort table buttons"). The behaviour lives in a pure module
 * (client/src/components/usip/are/dispatchTableModel.ts) and is tested here
 * as IMPORTED functions — a test that reimplemented "sort by opened, unopened
 * last" would agree with itself. The wiring pins at the end check the page
 * actually calls the module and exposes the controls.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_DISPATCH_TABLE_STATE, DEFAULT_DIR, filterDispatches, groupDispatchesByStep, isFiltered, nextSort,
  outcomeCounts, outcomeOf, sortDispatches, type DispatchRowLike,
} from "@/components/usip/are/dispatchTableModel";

const row = (id: number, extra: Partial<DispatchRowLike> = {}): DispatchRowLike => ({
  executionId: id, stepIndex: 0, prospectName: `Person ${id}`, prospectTitle: null, companyName: null,
  subject: null, bodyPreview: null, sentAt: new Date(2026, 8, 1, 9, id), opensTracked: true,
  opened: false, openedAt: null, replied: false, meeting: false, ...extra,
});
const ids = (rows: DispatchRowLike[]) => rows.map((r) => r.executionId);

describe("outcomeOf — the same last-touch vocabulary the cards used", () => {
  it("ranks meeting over reply over open, and tells untracked from unopened", () => {
    expect(outcomeOf(row(1, { meeting: true, replied: true, opened: true }))).toBe("meeting");
    expect(outcomeOf(row(1, { replied: true, opened: true }))).toBe("replied");
    expect(outcomeOf(row(1, { opened: true }))).toBe("opened");
    expect(outcomeOf(row(1))).toBe("no_open");
    expect(outcomeOf(row(1, { opensTracked: false }))).toBe("untracked");
  });
});

describe("filterDispatches", () => {
  const rows = [
    row(1, { prospectName: "Ada Lovelace", companyName: "Analytical Engines", subject: "Grant compliance" }),
    row(2, { prospectName: "Grace Hopper", prospectTitle: "Rear Admiral", stepIndex: 1, opened: true, openedAt: new Date() }),
    row(3, { prospectName: "Linus T", subject: "Kernel budget", stepIndex: 1, replied: true, opensTracked: false }),
  ];
  it("the default state passes everything through", () => {
    expect(isFiltered(DEFAULT_DISPATCH_TABLE_STATE)).toBe(false);
    expect(ids(filterDispatches(rows, DEFAULT_DISPATCH_TABLE_STATE))).toEqual([1, 2, 3]);
  });
  it("query is case-insensitive over name, title, company and subject", () => {
    const q = (query: string) => ids(filterDispatches(rows, { ...DEFAULT_DISPATCH_TABLE_STATE, query }));
    expect(q("ada")).toEqual([1]);
    expect(q("ENGINES")).toEqual([1]);
    expect(q("admiral")).toEqual([2]);
    expect(q("budget")).toEqual([3]);
    expect(q("  ")).toEqual([1, 2, 3]);
    expect(q("nobody")).toEqual([]);
  });
  it("step and outcome narrow the whole list, and combine", () => {
    expect(ids(filterDispatches(rows, { ...DEFAULT_DISPATCH_TABLE_STATE, step: 1 }))).toEqual([2, 3]);
    expect(ids(filterDispatches(rows, { ...DEFAULT_DISPATCH_TABLE_STATE, outcome: "replied" }))).toEqual([3]);
    expect(ids(filterDispatches(rows, { ...DEFAULT_DISPATCH_TABLE_STATE, outcome: "no_open" }))).toEqual([1]);
    expect(ids(filterDispatches(rows, { ...DEFAULT_DISPATCH_TABLE_STATE, step: 1, outcome: "opened" }))).toEqual([2]);
    expect(ids(filterDispatches(rows, { ...DEFAULT_DISPATCH_TABLE_STATE, step: 0, outcome: "opened" }))).toEqual([]);
  });
});

describe("sortDispatches", () => {
  const t = (h: number) => new Date(2026, 8, 1, h);
  const rows = [
    row(1, { prospectName: "zoe", subject: "B", sentAt: t(10), opened: true, openedAt: t(12) }),
    row(2, { prospectName: "Adam", subject: null, sentAt: t(9), meeting: true }),
    row(3, { prospectName: "mia", subject: "a", sentAt: t(11), replied: true }),
    row(4, { prospectName: "Bea", subject: "C", sentAt: null, opened: true, openedAt: t(8) }),
  ];
  it("prospect A→Z is case-insensitive, and desc reverses it", () => {
    expect(ids(sortDispatches(rows, { key: "prospect", dir: "asc" }))).toEqual([2, 4, 3, 1]);
    expect(ids(sortDispatches(rows, { key: "prospect", dir: "desc" }))).toEqual([1, 3, 4, 2]);
  });
  it("a missing value sorts LAST in both directions", () => {
    expect(ids(sortDispatches(rows, { key: "subject", dir: "asc" }))).toEqual([3, 1, 4, 2]);
    expect(ids(sortDispatches(rows, { key: "subject", dir: "desc" }))).toEqual([4, 1, 3, 2]);
    expect(ids(sortDispatches(rows, { key: "sent", dir: "desc" }))).toEqual([3, 1, 2, 4]);
    expect(ids(sortDispatches(rows, { key: "sent", dir: "asc" }))).toEqual([2, 1, 3, 4]);
  });
  it("opened newest-first never starts with people who never opened", () => {
    expect(ids(sortDispatches(rows, { key: "opened", dir: "desc" }))).toEqual([1, 4, 2, 3]);
    expect(ids(sortDispatches(rows, { key: "opened", dir: "asc" }))).toEqual([4, 1, 2, 3]);
  });
  it("outcome asc is best first: meeting, replied, opened, then silence", () => {
    expect(ids(sortDispatches(rows, { key: "outcome", dir: "asc" }))).toEqual([2, 3, 1, 4]);
  });
  it("is stable: ties keep their incoming order, and the input is not mutated", () => {
    const copy = rows.slice();
    const out = sortDispatches(rows, { key: "outcome", dir: "asc" });
    expect(out.slice(2).map((r) => r.executionId)).toEqual([1, 4]); // both "opened", original order
    expect(rows).toEqual(copy);
  });
});

describe("header clicks and grouping", () => {
  it("clicking a new column starts at that column's default direction; clicking again flips", () => {
    let s = DEFAULT_DISPATCH_TABLE_STATE.sort;
    s = nextSort(s, "opened");
    expect(s).toEqual({ key: "opened", dir: DEFAULT_DIR.opened });
    expect(DEFAULT_DIR.opened).toBe("desc");
    s = nextSort(s, "opened");
    expect(s).toEqual({ key: "opened", dir: "asc" });
    s = nextSort(s, "prospect");
    expect(s).toEqual({ key: "prospect", dir: "asc" });
  });
  it("groups by step ascending, keeping each step's row order", () => {
    const g = groupDispatchesByStep([row(1, { stepIndex: 2 }), row(2, { stepIndex: 0 }), row(3, { stepIndex: 2 })]);
    expect(g.map(([s]) => s)).toEqual([0, 2]);
    expect(ids(g[1][1])).toEqual([1, 3]);
  });
  it("outcome counts cover the whole list, one bucket per row", () => {
    const c = outcomeCounts([row(1, { meeting: true }), row(2, { opened: true }), row(3), row(4, { opensTracked: false })]);
    expect(c).toEqual({ meeting: 1, replied: 0, opened: 1, no_open: 1, untracked: 1 });
  });
});

describe("the tab is wired to the model", () => {
  const page = readFileSync(join(__dirname, "../client/src/pages/usip/ARECampaignDetail.tsx"), "utf8");
  const tab = page.slice(page.indexOf('<TabsContent value="ab"'), page.indexOf('<TabsContent value="signals"'));

  it("filters, sorts and groups through the module — not inline copies", () => {
    expect(page).toContain('from "@/components/usip/are/dispatchTableModel"');
    expect(tab).toContain("const shown = sortDispatches(filterDispatches(list, perf), perf.sort);");
    expect(tab).toContain("const bySteps = groupDispatchesByStep(shown);");
    expect(tab).toContain("outcomeOf(d)");
  });

  it("exposes the controls: a search box, a step select, outcome chips, sortable headers, a reset", () => {
    expect(tab).toContain('aria-label="Filter dispatches"');
    expect(tab).toContain('aria-label="Filter by step"');
    expect(tab).toContain('aria-label="Filter by outcome"');
    for (const k of ["prospect", "subject", "sent", "opened", "outcome"]) expect(tab).toContain(`<SortHead k="${k}"`);
    expect(tab).toContain("sort: nextSort(p.sort, k)");
    expect(tab).toContain("setPerf(DEFAULT_DISPATCH_TABLE_STATE)");
  });

  it("says what a filter did — shown-of-total, and the step header's true total", () => {
    expect(tab).toContain("Showing {shown.length} of {list.length}");
    expect(tab).toContain("{items.length} dispatched{filtered && items.length !== stepTotal ? ` (of ${stepTotal})` : \"\"}");
    expect(tab).toContain("No dispatches match these filters.");
  });
});
