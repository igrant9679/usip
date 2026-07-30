/**
 * A destructive statement must not be reachable with someone else's id.
 *
 * This guard started life inside quoteTotals.test.ts, scoped to one router,
 * written for ONE bug: `quotes.delete` ran
 * `delete(quoteLineItems).where(eq(quoteId, input.id))` first, unscoped, so any
 * authenticated user could strip every line item off any workspace's quote — and
 * the call returned ok:true, because the `quotes` delete beside it WAS scoped and
 * simply matched nothing. On its first run it immediately found a second instance
 * (`dashboards.delete`, identical shape, whose comment showed the ROLE gate had
 * been considered and the TENANT boundary had not).
 *
 * Run over all of `server/` it found FOUR more, in two flavours:
 *
 *   • **Verify parent A, delete child B, where B is a separate caller-supplied
 *     id.** `calendar.deleteEvent` verified `accountId` and then deleted
 *     `calendarEvents` by `input.dbId` — pass your own account with another
 *     workspace's event id and their row went. `proposals.deleteMilestone` did
 *     the same with `proposalId` + `milestoneId`. A parent check is only a check
 *     when the child is tied to that parent.
 *   • **The quotes.delete shape, twice more.** `tours.deleteTour` and
 *     `tours.delete` (two near-identical procedures) each deleted `tourSteps` by
 *     caller-supplied `tourId` with no filter and no ownership check, before a
 *     correctly-scoped parent delete that no-oped.
 *
 * 10 of the 14 flagged sites were false positives — a workspace-scoped ownership
 * select preceded them. Every one was read before being believed, and the four
 * real ones were the minority.
 *
 * THE RULE: a destructive statement whose WHERE is driven by caller input must
 * either filter on `workspaceId`, or be named below with the reason it is safe.
 * Deliberately not heuristic — "there seems to be a check above it" is the same
 * reasoning that wrote the bugs, so a test applying it would agree with the code
 * by construction. Where the table HAS a workspaceId column, the fix is to add
 * it rather than to earn an entry here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = join(__dirname, "..");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

interface Site {
  /** `file::table::where` — stable across line shifts, unlike a line number. */
  key: string;
  rel: string;
  table: string;
  where: string;
  /** From RAW source: line numbers taken from comment-stripped text are wrong. */
  line: number;
}

/** `.delete(table).where(...)` — the chain may wrap across lines. */
const DELETE_RE = /\.delete\((\w+)\)\s*\n?\s*\.where\(([\s\S]{0,300}?)\)\s*;/g;

function collectSites(): { sites: Site[]; files: number; statements: number } {
  const files = sourceFiles(join(ROOT, "server"));
  const sites: Site[] = [];
  let statements = 0;
  for (const f of files) {
    const rel = f.slice(ROOT.length + 1).split(sep).join("/");
    const raw = readFileSync(f, "utf8");
    const src = stripComments(raw);
    const nth = new Map<string, number>();
    for (const m of src.matchAll(DELETE_RE)) {
      const table = m[1];
      const where = m[2].split(/\s+/).join(" ").trim();
      statements++;
      const n = (nth.get(table) ?? 0) + 1;
      nth.set(table, n);
      // Only statements a caller can steer are interesting: a cleanup keyed on a
      // constant or an internal id cannot be aimed at another tenant.
      if (!/input\.\w+|\bctx\.user\.id\b/.test(where)) continue;
      if (/workspaceId/.test(where)) continue;
      let idx = -1;
      for (let k = 0; k < n; k++) idx = raw.indexOf(`.delete(${table})`, idx + 1);
      const line = idx >= 0 ? raw.slice(0, idx).split("\n").length : 0;
      sites.push({ key: `${rel}::${table}::${where}`, rel, table, where, line });
    }
  }
  return { sites, files: files.length, statements };
}

/**
 * Statements that may stay unscoped by workspace, with the reason. Every entry
 * here is a CHILD table with no workspaceId column of its own, whose parent is
 * verified against the workspace in the same procedure — so the parent id IS the
 * tenant boundary rather than a redundant second one.
 */
const ALLOWED: Record<string, string> = {
  "server/routers/proposals.ts::proposalMilestones::and( eq(proposalMilestones.id, input.milestoneId), eq(proposalMilestones.proposalId, input.proposalId), )":
    "deleteMilestone — getProposalOrThrow(proposalId, workspace) above, and the milestone is tied to that proposal. proposal_milestones has no workspaceId column.",
  "server/routers/proposals.ts::proposalMilestones::eq(proposalMilestones.proposalId, input.id)":
    "proposals.delete cascade — getProposalOrThrow(input.id, workspace) above and the cascade keys on that same verified id. No workspaceId column.",
  "server/routers/proposals.ts::proposalSections::eq(proposalSections.proposalId, input.id)":
    "Same cascade, same verified parent id. No workspaceId column.",
  "server/routers/proposals.ts::proposalFeedback::eq(proposalFeedback.proposalId, input.id)":
    "Same cascade, same verified parent id. No workspaceId column.",
  "server/routers/tours.ts::tourSteps::and(eq(tourSteps.id, input.stepId), eq(tourSteps.tourId, input.tourId))":
    "deleteStep — the tour is verified against the workspace immediately above and the step is tied to it. tour_steps has no workspaceId column.",
};

describe("no destructive statement can be aimed at another tenant", () => {
  const { sites, files, statements } = collectSites();

  it("finds source and statements to scan (guards the scanner itself)", () => {
    // Three separate scans in this repo have returned ~0 hits and looked like a
    // clean codebase; all three were broken. Assert a floor on both dimensions.
    expect(files).toBeGreaterThan(150);
    expect(statements).toBeGreaterThan(100);
  });

  it("every caller-steerable delete is workspace-scoped or explicitly excused", () => {
    const offenders = sites
      .filter((s) => !(s.key in ALLOWED))
      .map((s) => `${s.rel}:${s.line} delete(${s.table}) — where: ${s.where}`);
    expect(
      offenders,
      offenders.length
        ? `\n\nDestructive statement(s) keyed on caller input with no workspace filter:\n  ${offenders.join("\n  ")}\n\n` +
            `Add eq(<table>.workspaceId, ctx.workspace.id) to the WHERE. If the table has\n` +
            `no workspaceId column, verify its parent in the same procedure, key the\n` +
            `delete on that verified parent, and add an entry to ALLOWED saying so.\n` +
            `A tenant boundary that depends on the caller passing their own id is not a\n` +
            `boundary — and the statement still returns ok.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    // An allowlist with no staleness check is the "attempt marker" class: entries
    // outlive the code they excuse and the next offender inherits an exemption
    // nobody granted.
    const live = new Set(sites.map((s) => s.key));
    const stale = Object.keys(ALLOWED).filter((k) => !live.has(k));
    expect(
      stale,
      stale.length
        ? `\n\nAllowlisted but no longer present (the code changed — re-verify, don't re-add):\n  ${stale.join("\n  ")}\n`
        : undefined,
    ).toEqual([]);
  });

  it("every allowlisted table genuinely lacks a workspaceId column", () => {
    // The excuse is "this table cannot be scoped". If someone adds the column
    // later, the excuse expires and the statement should just be scoped.
    const schema = readFileSync(join(ROOT, "drizzle", "schema.ts"), "utf8");
    const unscopable = (table: string) => {
      const start = schema.indexOf(`export const ${table} = mysqlTable`);
      expect(start, `${table} not found in schema`).toBeGreaterThan(-1);
      const block = schema.slice(start, schema.indexOf("export const", start + 50));
      expect(block.length).toBeGreaterThan(120); // floor: real block
      return !/^\s*workspaceId:/m.test(block);
    };
    const scopable = [...new Set(Object.keys(ALLOWED).map((k) => k.split("::")[1]))]
      .filter((t) => !unscopable(t));
    expect(
      scopable,
      scopable.length
        ? `\n\nAllowlisted table(s) that DO have a workspaceId column — scope the delete instead:\n  ${scopable.join("\n  ")}\n`
        : undefined,
    ).toEqual([]);
  });

  it("the two originally-reported bugs stay fixed", () => {
    // Named explicitly: these are the sites the guard was written for, and a
    // regression in either should say so by name rather than as a generic hit.
    const ops = stripComments(readFileSync(join(ROOT, "server/routers/operations.ts"), "utf8"));
    for (const [table, parent] of [["quoteLineItems", "quotes"], ["dashboardWidgets", "dashboards"]]) {
      const at = ops.indexOf(`delete(${table})`);
      expect(at, table).toBeGreaterThan(-1);
      const stmt = ops.slice(at, at + 260);
      expect(stmt, table).toMatch(new RegExp(`${table}\\.workspaceId`));
      // …and the ownership check must still come FIRST, not just exist.
      const check = ops.lastIndexOf(`select({ id: ${parent}.id })`, at);
      expect(check, `${table}: ownership check must precede the delete`).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(check);
    }
  });
});
