/**
 * "Is this deal won?" must have exactly one answer, and it must be the FLAGS.
 *
 * `crm_pipeline_stages.isWon` / `.isLost` shipped with migration 0081 and are
 * editable at /settings/pipelines. Exactly two code paths read them. Around
 * seventy others string-matched the stage key, in three dialects that did not
 * even agree with each other:
 *
 *   crm.ts · operations.ts · reports.ts · …   stage === "won" / "lost"
 *   dealAutopilot.ts                          + closed_won / closed_lost / closed
 *   assistant.ts                              /closed/i — matches NEITHER
 *   Home.tsx                                  startsWith("closed") — same
 *
 * 🔴 The concrete failure: a workspace renames its closing stage to `signed`
 * and ticks Won. Its closed-won revenue reads zero, its won deals stay in the
 * open forecast, the autopilot keeps writing next-steps for deals that already
 * closed, the account never becomes a Customer, and the AI assistant reads the
 * won and lost deals out loud as OPEN ones. Nothing errors. Every number is
 * simply wrong, in the direction of "you have more pipeline than you do".
 *
 * Two halves, same as taskStatus.test.ts:
 *   1. The pure resolver (buildStageIndex) is CALLED, not scanned — precedence
 *      is a decision procedure and deserves real assertions.
 *   2. The call sites are SOURCE-SCANNED, because every one of them is a DB
 *      read with no pure function to invoke. The scans carry a floor so a
 *      broken walker cannot report a clean sweep by finding nothing, and every
 *      surviving literal is allowlisted WITH A REASON.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import {
  DEFAULT_LOST_KEYS,
  DEFAULT_WON_KEYS,
  buildStageIndex,
} from "@shared/stageSemantics";

const ROOT = join(__dirname, "..");

function sourceFiles(dir: string, keep: RegExp): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p, keep));
    else if (keep.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Comments stripped everywhere: this repo has repeatedly caught its own prose
 *  about a bug instead of the bug. Every explanatory comment added with this
 *  change quotes the literals it replaced. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (f: string) => strip(readFileSync(f, "utf8"));
const rel = (f: string) => f.slice(ROOT.length + 1).split(sep).join("/");

/**
 * Slice between two anchors, asserting BOTH were found. A one-arg `slice(-1)`
 * on a missing anchor yields the file's last character, against which every
 * `not.toContain` passes for the wrong reason — the failure mode
 * departedOwnerCascade.test.ts documents and guards the same way.
 */
function windowBetween(src: string, startAnchor: string, endAnchor: string, minLen = 120): string {
  const at = src.indexOf(startAnchor);
  expect(at, `start anchor not found, the window would be meaningless: ${startAnchor}`).toBeGreaterThan(-1);
  const end = src.indexOf(endAnchor, at + startAnchor.length);
  expect(end, `end anchor not found after the start, the window would run to EOF: ${endAnchor}`).toBeGreaterThan(at);
  const w = src.slice(at, end);
  expect(w.length, `window is too small to be the real block: ${startAnchor}`).toBeGreaterThan(minLen);
  return w;
}

/* ─── 1. the resolver ─────────────────────────────────────────────────────── */

describe("buildStageIndex — the name defaults", () => {
  it("an unconfigured workspace behaves exactly as the code did before", () => {
    const idx = buildStageIndex([]);
    for (const k of DEFAULT_WON_KEYS) {
      expect(idx.isWon(k), k).toBe(true);
      expect(idx.isClosed(k), k).toBe(true);
    }
    for (const k of DEFAULT_LOST_KEYS) {
      expect(idx.isLost(k), k).toBe(true);
      expect(idx.isClosed(k), k).toBe(true);
    }
    // dealAutopilot's fifth literal: closed, but neither won nor lost.
    expect(idx.isClosed("closed")).toBe(true);
    expect(idx.isWon("closed")).toBe(false);
    expect(idx.isLost("closed")).toBe(false);
    for (const k of ["discovery", "qualified", "proposal", "negotiation"]) {
      expect(idx.isOpen(k), k).toBe(true);
      expect(idx.isClosed(k), k).toBe(false);
    }
  });

  it("a key nobody has ever heard of is OPEN, not revenue", () => {
    // Deleting a stage leaves its opportunities holding the stored key — the
    // delete confirm at /settings/pipelines says so — so orphans are real.
    const idx = buildStageIndex([{ key: "discovery", isWon: false, isLost: false }]);
    expect(idx.isOpen("stage_1758300000000")).toBe(true);
    expect(idx.isWon("stage_1758300000000")).toBe(false);
  });

  it("does not inherit an answer from Object.prototype", () => {
    // Stage keys are workspace-supplied strings.
    const idx = buildStageIndex([]);
    expect(idx.isOpen("constructor")).toBe(true);
    expect(idx.isOpen("toString")).toBe(true);
  });
});

describe("buildStageIndex — precedence: a configured row beats the name default", () => {
  it("a custom Won stage counts as won, and `won` still does", () => {
    const idx = buildStageIndex([{ key: "signed", isWon: 1, isLost: 0 }]);
    expect(idx.isWon("signed")).toBe(true);
    expect(idx.isOpen("signed")).toBe(false);
    expect(idx.isWon("won")).toBe(true);
  });

  it("UNTICKING Won on the stage keyed `won` is honoured", () => {
    // The whole point of precedence. A blanket "union in the name defaults"
    // would make the flags one-way: addable, never removable.
    const idx = buildStageIndex([{ key: "won", isWon: 0, isLost: 0 }]);
    expect(idx.isWon("won")).toBe(false);
    expect(idx.isOpen("won")).toBe(true);
    expect(idx.wonKeys()).not.toContain("won");
    // A key the workspace does NOT configure keeps its default.
    expect(idx.isWon("closed_won")).toBe(true);
  });

  it("ticking Lost on the stage keyed `won` moves it to the lost side", () => {
    const idx = buildStageIndex([{ key: "won", isWon: 0, isLost: 1 }]);
    expect(idx.isLost("won")).toBe(true);
    expect(idx.isWon("won")).toBe(false);
  });

  it("accepts mysql2 tinyints as well as booleans", () => {
    // mysql2 hands tinyint back as 1/0; drizzle can hand back true/false.
    expect(buildStageIndex([{ key: "a", isWon: 1, isLost: 0 }]).isWon("a")).toBe(true);
    expect(buildStageIndex([{ key: "a", isWon: true, isLost: false }]).isWon("a")).toBe(true);
    expect(buildStageIndex([{ key: "a", isWon: 0, isLost: 1 }]).isLost("a")).toBe(true);
    expect(buildStageIndex([{ key: "a", isWon: null, isLost: null }]).isOpen("a")).toBe(true);
  });

  it("both flags set resolves to LOST, once, in closedKeys()", () => {
    // createStage/updateStage accept both even though the UI clears the other.
    // Counting a mis-configured stage as revenue is the expensive way to be wrong.
    const idx = buildStageIndex([{ key: "weird", isWon: 1, isLost: 1 }]);
    expect(idx.isLost("weird")).toBe(true);
    expect(idx.isWon("weird")).toBe(false);
    expect(idx.closedKeys().filter((k) => k === "weird")).toHaveLength(1);
    expect(new Set(idx.closedKeys()).size).toBe(idx.closedKeys().length);
  });

  it("two pipelines disagreeing on one key resolve to lost, then won, then open", () => {
    // The clone path can produce this.
    const bothWays = buildStageIndex([
      { key: "k", isWon: 1, isLost: 0 },
      { key: "k", isWon: 0, isLost: 1 },
    ]);
    expect(bothWays.isLost("k")).toBe(true);
    const wonOrOpen = buildStageIndex([
      { key: "k", isWon: 0, isLost: 0 },
      { key: "k", isWon: 1, isLost: 0 },
    ]);
    expect(wonOrOpen.isWon("k")).toBe(true);
  });

  it("closedKeys() is won ∪ lost ∪ closed-but-neither", () => {
    const idx = buildStageIndex([{ key: "signed", isWon: 1, isLost: 0 }]);
    const closed = idx.closedKeys();
    expect(closed).toEqual(expect.arrayContaining(["signed", "won", "lost", "closed"]));
    expect(closed).not.toContain("discovery");
  });

  it("the key arrays are fresh and mutable — Drizzle's inArray rejects readonly", () => {
    const idx = buildStageIndex([]);
    const first = idx.wonKeys();
    first.push("tampered");
    expect(idx.wonKeys()).not.toContain("tampered");
    expect(idx.isWon("tampered")).toBe(false);
  });
});

/* ─── 2. the call sites ───────────────────────────────────────────────────── */

/**
 * The shapes that decide won/lost from a NAME. Each was a real site before
 * 2026-09-20; the last two are the heuristics that matched neither "won" nor
 * "lost" and so reported every closed deal as open.
 */
/**
 * 2026-09-20: every key-matching shape now carries the LEGACY CLOSED FAMILY
 * (`closed_won` / `closed_lost` / `closed`) and the leading `[Ss]`, and the
 * array shape no longer demands exactly two elements. The first cut of this
 * table matched none of the following, all of which are the same bug:
 *
 *   const FINISHED = ["won", "lost", "closed_won", "closed_lost", "closed"];
 *   if (o.stage === "closed_won") return true;
 *   inArray(opportunities.stage, ["won", "lost", "closed"])
 *   .where(ne(opportunities.stage, "won"))
 *   suggestedStage !== "won"            ← capital S
 *
 * so dealAutopilot's five-element list could come back anywhere under any other
 * name and the sweep stayed green. DEFAULT_WON_KEYS lists `closed_won` as a
 * live stage key, so these are spellings the product actually stores.
 *
 * The literals are deliberately NOT matched bare: `"closed_won"` is also a
 * WIDGET METRIC id in operations.ts / Dashboards.tsx / seed.ts, and
 * allowlisting those three files wholesale would blind the sweep to a real
 * stage comparison living next door.
 */
const LITERAL_SHAPES: Array<{ name: string; re: RegExp }> = [
  { name: `raw SQL NOT IN ('won'…)`, re: /NOT IN \('(won|lost|closed)/ },
  { name: `raw SQL IN ('won'…)`, re: /[^T] IN \('(won|lost|closed)/ },
  { name: `eq(opportunities.stage, "won"|…)`, re: /eq\(\s*opportunities\.stage\s*,\s*"(won|lost|closed_won|closed_lost|closed)"\s*\)/ },
  // ne() and a literal inArray() list are the same decision written as SQL —
  // `.where(ne(opportunities.stage, "won"))` matched nothing before.
  { name: `ne(opportunities.stage, …)`, re: /ne\(\s*opportunities\.stage\s*,/ },
  { name: `inArray(opportunities.stage, [literal])`, re: /inArray\(\s*opportunities\.stage\s*,\s*\[/ },
  // `stage)? ===` rather than `.stage ===`, so the String(o.stage) === "won"
  // spelling is caught too — that is how demoSeedExtras writes it. `[Ss]tage`
  // because Pipeline.tsx's was `suggestedStage !== "won"`.
  { name: `stage === "won"|…`, re: /[Ss]tage\)? === "(won|lost|closed_won|closed_lost|closed)"/ },
  { name: `stage !== "won"|…`, re: /[Ss]tage\)? !== "(won|lost|closed_won|closed_lost|closed)"/ },
  { name: `["won", …] array literal`, re: /\[\s*"(won|lost|closed_won|closed_lost)"\s*,[^\]]*\]/ },
  { name: `stage: "won"|… write`, re: /stage: "(won|lost|closed_won|closed_lost|closed)"/ },
  { name: `/closed/i on a stage`, re: /\/closed\/i/ },
  { name: `startsWith("closed") on a stage`, re: /startsWith\("closed"\)/ },
];

function literalHits(files: string[]): Array<{ file: string; shape: string }> {
  const out: Array<{ file: string; shape: string }> = [];
  for (const f of files) {
    const src = read(f);
    for (const s of LITERAL_SHAPES) {
      if (s.re.test(src)) out.push({ file: rel(f), shape: s.name });
    }
  }
  return out;
}

const SERVER_FILES = sourceFiles(join(ROOT, "server"), /\.ts$/);

/**
 * shared/ is walked too (2026-09-20). It was the one directory neither sweep
 * touched — SERVER_FILES is server/**, CLIENT_FILES is client/src/** — so a
 * helper there deciding won/lost by name would have been invisible to both
 * halves while being imported by both.
 */
const SHARED_FILES = sourceFiles(join(ROOT, "shared"), /\.tsx?$/);
const BACKEND_FILES = SERVER_FILES.concat(SHARED_FILES);

/** Every surviving name-match on the server, and why it is allowed to survive. */
const SERVER_ALLOWED: Record<string, string> = {
  "server/seed.ts":
    "Demo/bootstrap data. It seeds the DEFAULT pipeline by definition, so the default keys are the right literals — they are what it is creating.",
  "server/demoSeedExtras.ts":
    "Same: demo saved reports, notifications and deals for the seeded default pipeline. The saved report it plants uses neq won / neq lost, which still runs — the literal ops were kept precisely so old saved specs keep working.",
  "shared/stageSemantics.ts":
    "The defaults themselves. DEFAULT_WON_KEYS / DEFAULT_LOST_KEYS are where the legacy names are ALLOWED to live — every other file is supposed to ask this module instead of re-spelling them.",
};

describe("no server or shared file decides won/lost from the stage NAME", () => {
  it("walks real source (guards the walker itself)", () => {
    expect(SERVER_FILES.length).toBeGreaterThan(150);
    // Its own floor: concat()ing an empty shared walk onto 300 server files
    // would look like a clean sweep of shared/ forever.
    expect(SHARED_FILES.length).toBeGreaterThan(20);
  });

  it("every surviving literal is allowlisted with a reason", () => {
    const offenders = literalHits(BACKEND_FILES).filter((h) => !(h.file in SERVER_ALLOWED));
    expect(
      offenders,
      offenders.length
        ? `\n\nStage decided by NAME in:\n  ${offenders.map((o) => `${o.file}  [${o.shape}]`).join("\n  ")}\n\n` +
            `A workspace can rename its closing stage and tick Won on the new one\n` +
            `(/settings/pipelines). A custom won stage that escapes the revenue\n` +
            `math reads as zero closed-won and leaves the deal in open forecast.\n` +
            `Use server/_core/stageSemantics.ts: stageIndexFor / wonStageKeys /\n` +
            `lostStageKeys / closedStageKeys for reads, resolvedStageFor and\n` +
            `canonicalWonStageKey for writes.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const hit = new Set(literalHits(BACKEND_FILES).map((h) => h.file));
    const stale = Object.keys(SERVER_ALLOWED).filter((f) => !hit.has(f));
    expect(
      stale,
      stale.length ? `\n\nAllowlisted but no longer matches — drop it:\n  ${stale.join("\n  ")}\n` : undefined,
    ).toEqual([]);
  });
});

const CLIENT_FILES = sourceFiles(join(ROOT, "client/src"), /\.tsx?$/);

/**
 * The client shapes, plus `.key === "won"` — the form the colour fallbacks use.
 * A colour is not a revenue decision, which is why one of them is allowed.
 */
const CLIENT_SHAPES = LITERAL_SHAPES.concat([
  { name: `.key === "won"|"lost"`, re: /\.key === "(won|lost)"/ },
]);

function clientHits(): Array<{ file: string; shape: string }> {
  const out: Array<{ file: string; shape: string }> = [];
  for (const f of CLIENT_FILES) {
    const src = read(f);
    for (const s of CLIENT_SHAPES) {
      if (s.re.test(src)) out.push({ file: rel(f), shape: s.name });
    }
  }
  return out;
}

const CLIENT_ALLOWED: Record<string, string> = {
  "client/src/pages/usip/DealsV2.tsx":
    "stageHue's `st.isWon || st.key === \"won\"` picks a COLOUR for a column and already prefers the flag; the key is only the fallback for a stage row that predates the flags. No number depends on it.",
};

describe("no client file decides won/lost from the stage NAME", () => {
  it("walks real source (guards the walker itself)", () => {
    expect(CLIENT_FILES.length).toBeGreaterThan(50);
  });

  it("every surviving literal is allowlisted with a reason", () => {
    const offenders = clientHits().filter((h) => !(h.file in CLIENT_ALLOWED));
    expect(
      offenders,
      offenders.length
        ? `\n\nStage decided by NAME in:\n  ${offenders.map((o) => `${o.file}  [${o.shape}]`).join("\n  ")}\n\n` +
            `crmPipelines.get returns isWon/isLost on every stage row — read those.\n` +
            `A hardcoded key list is fine ONLY as a loading fallback (see the\n` +
            `LEGACY_STAGES constants), never as the test for "did this deal close?".\n`
        : undefined,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const hit = new Set(clientHits().map((h) => h.file));
    const stale = Object.keys(CLIENT_ALLOWED).filter((f) => !hit.has(f));
    expect(stale).toEqual([]);
  });
});

/* ─── 3. the write paths, individually ────────────────────────────────────── */

describe("every path that moves a deal into a closing stage consults the flags", () => {
  it("crm.setStage no longer skips the flags when pipelineId is null", () => {
    // `if (before.pipelineId)` gated the ONLY flag read on a nullable column
    // that nothing backfills, so every legacy deal — and everything
    // proposals.ts creates — fell back to matching the string "won".
    const w = windowBetween(read("server/routers/crm.ts"), "setStage: repProcedure", "if (isWon) winProb = 100;");
    expect(w).toContain("resolvedStageFor(");
    expect(w).not.toContain("if (before.pipelineId)");
    expect(w).not.toMatch(/input\.stage === "won"/);
  });

  it("pipelineAlerts.moveDealStage handles BOTH flags and owns the task properly", () => {
    const w = windowBetween(
      read("server/routers/pipelineAlerts.ts"),
      "moveDealStage: workspaceProcedure",
      "return { ok: true, customerCreated };",
    );
    expect(w).toContain("resolvedStageFor(");
    expect(w).toContain("ensureCustomerForWonOpp(");
    // Closed-lost had no downstream step on this endpoint at all, so the same
    // gesture behaved differently depending on which screen the rep used.
    expect(w).toContain("meta.isLost");
    expect(w).toContain("Win-back:");
    expect(w).toContain("activeOwnerOrNull(");
  });

  it("opportunityIntelligence.reviewStageChange scopes its UPDATE and runs the close handling", () => {
    const src = read("server/routers/opportunityIntelligence.ts");
    const w = windowBetween(src, "if (input.approved) {", "insert(opportunityStageHistory)");
    expect(w).toContain("resolvedStageFor(");
    /**
     * 2026-09-20: the tenant scope is pinned on the UPDATE STATEMENT, not on
     * the branch. The same change added a SELECT two statements above the
     * UPDATE, and that SELECT carries its own eq(opportunities.workspaceId,
     * ctx.workspace.id) — so a branch-wide `toContain("opportunities.
     * workspaceId")` stayed green with the UPDATE's WHERE reverted to
     * `eq(opportunities.id, approval.opportunityId)` alone, which is the
     * cross-tenant write this test is named after. The slice starts inside the
     * approved branch so the unrelated `.update(opportunities)` earlier in the
     * file cannot anchor it.
     */
    const upd = windowBetween(
      src.slice(src.indexOf("if (input.approved) {")),
      ".update(opportunities)",
      "db.insert(opportunityStageHistory)",
    );
    expect(upd).toContain("eq(opportunities.workspaceId, ctx.workspace.id)");
    expect(upd).not.toMatch(/where\(eq\(opportunities\.id, approval\.opportunityId\)\)/);
    // Approving a move to Won used to leave the account un-converted.
    const after = windowBetween(src, "insert(opportunityStageHistory)", "listPendingApprovals");
    expect(after).toContain("ensureCustomerForWonOpp(");
    expect(after).toContain("Win-back:");
  });

  it("proposals.ts writes the workspace's own won stage and creates the Customer", () => {
    const src = read("server/routers/proposals.ts");
    expect(src).not.toMatch(/stage: "won"/);
    expect(src).toContain("canonicalWonStageKey(");
    expect(src).toContain("ensureCustomerForWonOpp(");
    // Both accept paths — authenticated and the public share-link one.
    expect(src.match(/canonicalWonStageKey\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(src.match(/ensureCustomerForWonOpp\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  /**
   * 2026-09-20. The two READ surfaces the literal sweep cannot see, because
   * what they used to hold matches no shape in LITERAL_SHAPES: operations.ts
   * had `const stages = ["discovery", "qualified", "proposal", "negotiation",
   * "won"]` (five elements, not the two-element array shape) and Pipeline.tsx
   * had `.id !== "lost"` (not `stage !==`). Both could be reverted wholesale
   * without turning anything red, and the symptom is silent: a workspace with
   * custom stages gets a funnel of empty columns and a kanban whose closing
   * column is never recognised.
   */
  it("the operations widgets order columns from the workspace's own stages", () => {
    const src = read("server/routers/operations.ts");
    const funnel = windowBetween(
      src,
      `if (w.type === "funnel" || w.type === "pipeline_stage") {`,
      `if (["bar", "line", "area", "stacked_bar"]`,
    );
    expect(funnel).toContain("orderedStageKeys(");
    // "excluded from the funnel" means FLAGGED lost, not named "lost".
    expect(funnel).toContain("stages.isLost(k)");
    expect(funnel).not.toMatch(/"negotiation", "won"/);

    const pie = windowBetween(src, `if (cfg.metric === "stage_distribution") {`, `if (w.type === "scatter")`);
    expect(pie).toContain("orderedStageKeys(");
    expect(pie).toContain("stages.isWon(o.stage)");
    expect(pie).toContain("stages.isLost(o.stage)");
    expect(pie).not.toMatch(/"negotiation", "won"/);

    // The seed order is a DISPLAY fallback for an unseeded pipeline only; the
    // helper must still read the table first.
    const helper = windowBetween(src, "async function orderedStageKeys(", "function dateRange(");
    expect(helper).toContain("from(crmPipelineStages)");
    expect(helper).toContain("defs.length > 0 ? defs.map((d) => d.key) : DEFAULT_STAGE_ORDER");
  });

  it("the classic pipeline board carries the flags down to the cards", () => {
    const src = read("client/src/pages/usip/Pipeline.tsx");
    const hook = windowBetween(src, "function useStagesFor(", "function WinProbBadge(");
    expect(hook).toContain("isWon: !!s.isWon");
    expect(hook).toContain("isLost: !!s.isLost");
    // The AI stage suggestion must not be offered for a closing stage. This was
    // `suggestedStage !== "won" && suggestedStage !== "lost"`.
    const card = windowBetween(src, "const suggestedStage: string | null =", "const stageLabel = (id: string)");
    expect(card).toContain("suggestedMeta.isWon");
    expect(card).toContain("suggestedMeta.isLost");
    // The "move to next stage" column list hid Lost by key (`.id !== "lost"`).
    expect(src).toContain("STAGES.filter((s) => !s.isLost)");
  });

  it("the Deals board resolves through the shared index, not a bare row lookup", () => {
    /**
     * A `stageRows.find((s) => s.key === key)` returns UNDEFINED for a key no
     * configured row covers, and `!undefined?.isWon` reads as "not won" — so
     * this page dropped the name-default layer that shared/stageSemantics.ts
     * applies and that the server has always had. Rename the stage keyed `won`
     * to `signed` and the 40 deals still holding `won` counted as open pipeline
     * here while crm.forecast counted them as closed-won. stageHue keeps its
     * `st.key === "won"` fallback on purpose: that picks a COLOUR.
     */
    const src = read("client/src/pages/usip/DealsV2.tsx");
    expect(src).toContain(`from "@shared/stageSemantics"`);
    expect(src).toContain("buildStageIndex(");
    expect(src).toContain("stageIdx.isOpen(o.stage)");
    expect(src).toContain("stageIdx.isWon(o.stage)");
    expect(src).toContain("stageIdx.isWon(vars.stage)");
    expect(src).not.toMatch(/stageRows\.find\(/);
  });

  it("dealAutopilot asks the workspace instead of carrying its own five literals", () => {
    const src = read("server/services/dealAutopilot.ts");
    expect(src).not.toContain("CLOSED_STAGES");
    expect(src).toContain("closedStageKeys(");
    // Two guards this file already carries; the refactor must not disturb them.
    expect(src).toContain("activeTaskStatuses()");
    expect(src).toContain("archivedWorkspaceIds");
    expect(src).toContain("archivedWs.has(");
  });
});

/* ─── 4. the cache, and the reports vocabulary ────────────────────────────── */

describe("every mutation that changes the answer drops the memo", () => {
  /** Seven, not five: setDefault changes which pipeline the write paths fall
   *  back to, and reorderStages changes the funnel/stage-distribution order. */
  const MUTATIONS = [
    "createPipeline",
    "setDefault",
    "deletePipeline",
    "createStage",
    "updateStage",
    "deleteStage",
    "reorderStages",
  ];

  const src = read("server/routers/crm.ts");

  /**
   * Every procedure key of crmPipelinesRouter that follows `get`, in source
   * order — `renamePipeline` included even though it invalidates nothing,
   * because it is what ENDS createPipeline's window.
   *
   * 2026-09-20: these windows used to be a flat 2500 characters from the
   * mutation's key, which overran into the next two or three procedures. Six of
   * the seven pins were satisfied by a NEIGHBOUR's invalidateStageIndex and
   * could not fail for the mutation they name: deleting the call from
   * createPipeline, setDefault, deletePipeline, createStage, updateStage or
   * deleteStage left all seven green. Only reorderStages, the last entry in the
   * file, was honest. The concrete loss: an admin UNTICKS Won at
   * /settings/pipelines and every widget keeps counting those deals as
   * closed-won revenue for up to 60s, with a clean sweep reported.
   */
  const ROUTER_KEYS = [
    "createPipeline",
    "renamePipeline",
    "setDefault",
    "deletePipeline",
    "createStage",
    "updateStage",
    "deleteStage",
    "reorderStages",
  ];

  /** The named procedure's OWN body: from its key to whichever key comes next. */
  function bodyOf(m: string): string {
    const at = src.indexOf(`${m}:`);
    expect(at, `${m} not found in crm.ts`).toBeGreaterThan(-1);
    // forEach, not Math.min(...ends): the build targets es5 and spreading is
    // how this repo keeps tripping TS2802.
    let end = src.length;
    ROUTER_KEYS.forEach((o) => {
      if (o === m) return;
      const i = src.indexOf(`${o}:`, at + m.length);
      if (i > at && i < end) end = i;
    });
    const w = src.slice(at, end);
    expect(w.length, `${m}'s body is too small to be the real procedure`).toBeGreaterThan(120);
    return w;
  }

  it("stageIndexFor is memoized at all (otherwise this suite guards nothing)", () => {
    expect(read("server/_core/stageSemantics.ts")).toContain("TTL_MS");
  });

  it("the windows are one procedure wide — renamePipeline borrows nobody's call", () => {
    // The control for every pin below. renamePipeline changes no stage answer
    // and calls nothing; if its window picks an invalidateStageIndex up off a
    // neighbour, then so do the others and none of them mean anything.
    expect(bodyOf("renamePipeline")).not.toContain("invalidateStageIndex(");
  });

  for (const m of MUTATIONS) {
    it(`${m} invalidates the stage index`, () => {
      const calls = bodyOf(m).match(/invalidateStageIndex\(/g)?.length ?? 0;
      expect(calls, `${m} changes the stage answer but never calls invalidateStageIndex`).toBe(1);
    });
  }
});

describe("the reports builder can ask the semantic question", () => {
  const server = read("server/routers/reports.ts");
  const client = read("client/src/pages/usip/Reports.tsx");

  it("the filter op enum carries all three", () => {
    for (const op of ["is_won", "is_lost", "is_open"]) {
      expect(server, `reports.ts filterSchema is missing ${op}`).toContain(`"${op}"`);
    }
  });

  it("the client op list carries all three, so server and client cannot drift", () => {
    for (const op of ["is_won", "is_lost", "is_open"]) {
      expect(client, `Reports.tsx OPS is missing ${op}`).toContain(`value: "${op}"`);
    }
  });

  it("the three stage presets no longer hardcode the stage key", () => {
    const presets = windowBetween(server, "export const PRESET_REPORTS", "export const reportsRouter", 500);
    expect(presets).not.toMatch(/value: "won"/);
    expect(presets).not.toMatch(/value: "lost"/);
    expect(presets).toContain(`op: "is_won"`);
    expect(presets).toContain(`op: "is_lost"`);
    expect(presets).toContain(`op: "is_open"`);
  });

  it("the literal ops survive, so every saved report keeps running", () => {
    // demoSeedExtras plants one with neq won / neq lost, and customers have
    // saved their own. Removing eq/neq would break them silently.
    expect(server).toContain(`case "eq":`);
    expect(server).toContain(`case "neq":`);
  });
});

/* ─── 5. the new modules stay es5-safe ────────────────────────────────────── */

/**
 * The build targets es5 without downlevelIteration, so spreading or for-of'ing
 * a Set or Map is TS2802 — 78 of the repo's 325 pinned errors are exactly that.
 * Cheaper and more precise than shelling out to tsc from a test: assert the two
 * new modules never reach for a Set or Map at all, which is why buildStageIndex
 * dedupes through a null-prototype object.
 */
describe("the shared resolver stays es5-safe", () => {
  for (const f of ["shared/stageSemantics.ts", "server/_core/stageSemantics.ts"]) {
    it(`${f} builds no Set or Map`, () => {
      const src = read(join(ROOT, f));
      expect(src).not.toMatch(/new (Set|Map)\b/);
      expect(src).not.toMatch(/\.\.\.(new )?(Set|Map)\b/);
    });
  }
});
