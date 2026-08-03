/**
 * "Which task statuses are still live" must have exactly one answer.
 *
 * Six places asked it and answered with their own array literal. Five agreed on
 * `open draft in_progress snoozed`; dealAutopilot.ts said `open in_progress
 * draft` — and that array is what decides whether an AI-sourced task ALREADY
 * EXISTS for a deal. Missing `snoozed` meant a task the rep had snoozed stopped
 * counting, the deal read as unattended, and the autopilot generated another
 * one. The user says "later", the engine says "again".
 *
 * The same concept also hid behind `eq(tasks.status, "open")`, which is not a
 * synonym: the proposal-followup cron deduped on it and so minted a fresh
 * duplicate follow-up EVERY DAY while a rep had the task in_progress.
 *
 * The enum is parsed out of schema.ts here, so a seventh status fails this
 * suite until somebody classifies it — rather than silently defaulting to "not
 * live" and disabling six dedupe checks at once.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import {
  ACTIVE_TASK_STATUSES,
  CLOSED_TASK_STATUSES,
  TASK_STATUSES,
  activeTaskStatuses,
  isActiveTaskStatus,
} from "@shared/taskStatus";

const ROOT = join(__dirname, "..");

/**
 * The `tasks.status` enum, read from the schema rather than retyped here.
 *
 * Comments are stripped FIRST. The enum block ends with
 *   "draft", // AI-proposed task awaiting approval (autopilot "approval" mode)
 * and the first version of this parser dutifully returned `approval` as a
 * seventh status. Scanning raw source matches the prose about the code — the
 * trap this repo has now hit six times, here inside the parser meant to be the
 * source of truth.
 */
function schemaTaskStatuses(): string[] {
  const src = readFileSync(join(ROOT, "drizzle/schema.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const table = src.slice(src.indexOf("export const tasks = mysqlTable"));
  const m = /status:\s*mysqlEnum\("status",\s*\[([\s\S]*?)\]\)/.exec(table);
  if (!m) throw new Error("could not find tasks.status enum in schema.ts");
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

describe("the shared list matches the database", () => {
  it("parses the enum out of schema.ts (guards the parser itself)", () => {
    expect(schemaTaskStatuses().length).toBeGreaterThanOrEqual(6);
  });

  it("TASK_STATUSES is exactly the enum", () => {
    expect([...TASK_STATUSES].sort()).toEqual(schemaTaskStatuses().sort());
  });

  it("every status is classified as either live or finished", () => {
    const union = [...ACTIVE_TASK_STATUSES, ...CLOSED_TASK_STATUSES].sort();
    expect(
      union,
      "\n\nA status is in neither list (or in both). Add it to ACTIVE_TASK_STATUSES\n" +
        "or CLOSED_TASK_STATUSES in @shared/taskStatus — leaving it out silently\n" +
        "excludes it from every dedupe check in the app.\n",
    ).toEqual(schemaTaskStatuses().sort());
  });

  it("the two lists are disjoint", () => {
    const overlap = ACTIVE_TASK_STATUSES.filter((s) => CLOSED_TASK_STATUSES.includes(s));
    expect(overlap).toEqual([]);
  });
});

describe("what counts as live", () => {
  it("snoozed counts — this is the bug dealAutopilot shipped", () => {
    expect(isActiveTaskStatus("snoozed")).toBe(true);
  });

  it("draft counts — an unapproved AI proposal is still a proposal", () => {
    expect(isActiveTaskStatus("draft")).toBe(true);
  });

  it("done and cancelled do not", () => {
    expect(isActiveTaskStatus("done")).toBe(false);
    expect(isActiveTaskStatus("cancelled")).toBe(false);
  });

  it("activeTaskStatuses() hands out a fresh mutable copy", () => {
    // Drizzle's inArray rejects a readonly array, and a shared mutable array
    // that a caller could sort or push to would be worse.
    const a = activeTaskStatuses();
    a.push("done");
    expect(activeTaskStatuses()).not.toContain("done");
  });
});

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

const FILES = sourceFiles(join(ROOT, "server"));
const stripped = (f: string) =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const rel = (f: string) => f.slice(ROOT.length + 1).split(sep).join("/");

describe("nobody re-declares the list", () => {
  it("finds source to scan (guards the scanner itself)", () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  it("no array literal enumerates task statuses", () => {
    // The fingerprint is an array containing BOTH "open" and "in_progress" —
    // "open" alone is far too common (email opens, open deals) to ban.
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = stripped(f);
      for (const m of src.matchAll(/\[[^\]\n]*"in_progress"[^\]\n]*\]/g)) {
        if (!m[0].includes('"open"')) continue;
        offenders.push(`${rel(f)}: ${m[0].slice(0, 70)}`);
      }
    }
    expect(
      offenders,
      offenders.length
        ? `\n\nInline task-status list(s) — use activeTaskStatuses() from\n` +
            `@shared/taskStatus:\n  ${offenders.join("\n  ")}\n\n` +
            `Five copies agreed and the sixth did not, which is how a snoozed\n` +
            `task stopped counting and the autopilot duplicated it.\n`
        : undefined,
    ).toEqual([]);
  });
});

/**
 * `eq(tasks.status, "open")` is NOT a synonym for "live", and the remaining
 * uses are deliberate. Each is named with its reason; a new one has to argue
 * its case here rather than quietly reintroducing the bug.
 */
const OPEN_ONLY_ALLOWED: Record<string, string> = {
  "server/db.ts":
    "Dashboard metric labelled 'open tasks' — a display count of literally-open tasks, not a dedupe.",
  "server/services/workflowEngine.ts":
    "task_overdue trigger. Whether an in_progress task should fire 'overdue' is a product decision, not drift — see the note in SESSION_STATUS.",
};

describe("eq(tasks.status, \"open\") is only used where it is meant", () => {
  const sites = FILES.filter((f) => /eq\(\s*tasks\.status\s*,\s*"open"\s*\)/.test(stripped(f))).map(rel);

  it("finds the known sites (floor)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(2);
  });

  it("every site is allowlisted with a reason", () => {
    const offenders = sites.filter((s) => !(s in OPEN_ONLY_ALLOWED));
    expect(
      offenders,
      offenders.length
        ? `\n\nNew eq(tasks.status, "open"):\n  ${offenders.join("\n  ")}\n\n` +
            `If this is a DEDUPE ("does a task already exist?"), it must use\n` +
            `inArray(tasks.status, activeTaskStatuses()) — otherwise an in_progress\n` +
            `or snoozed task stops counting and you create a duplicate. If it is a\n` +
            `deliberate display count, add it to OPEN_ONLY_ALLOWED with the reason.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const stale = Object.keys(OPEN_ONLY_ALLOWED).filter((f) => !sites.includes(f));
    expect(
      stale,
      stale.length ? `\n\nAllowlisted but no longer matches — drop it:\n  ${stale.join("\n  ")}\n` : undefined,
    ).toEqual([]);
  });
});

describe("the sites that had the bug", () => {
  it("dealAutopilot dedupes on the shared list", () => {
    const src = stripped(join(ROOT, "server/services/dealAutopilot.ts"));
    expect(src).toContain("activeTaskStatuses()");
  });

  it("the proposal-followup cron dedupes on the shared list", () => {
    const src = stripped(join(ROOT, "server/emailTracking.ts"));
    expect(src).toContain("activeTaskStatuses()");
    expect(src).not.toMatch(/eq\(tasks\.status,\s*"open"\)/);
  });
});

/**
 * THE SAME RULE, WRITTEN IN RAW SQL — where the scan above could not see it.
 *
 * The allowlist scan matches `eq(tasks.status, "open")`, the Drizzle form.
 * admin.ts said the identical thing four times as
 * `sql\`… AND status = 'open'\``, and every one of them slipped through:
 *
 *   · team.delete's owned-work COUNT — the gate that decides whether an admin
 *     is forced to reassign before removing someone. A member whose work was
 *     all in_progress or snoozed counted as owning ZERO tasks, so the delete
 *     proceeded unchallenged; team.delete then removes the user row when no
 *     memberships remain, leaving those tasks owned by a DELETED user id.
 *   · deactivate, team.delete and bulkDeactivate's reassignments — only the
 *     `open` tasks moved. in_progress is the task somebody is doing right now.
 *
 * Fixed by `liveTaskStatuses()` in admin.ts, which binds activeTaskStatuses()
 * into an IN list. This guard exists so the NEXT one is caught in the form it
 * is actually written in, rather than only in the form we thought to scan for.
 *
 * Comments are stripped first — admin.ts's own explanation of the bug quotes
 * `status = 'open'`, and matching your own prose about the code is a trap this
 * repo has hit repeatedly.
 */
describe("raw SQL cannot say status = 'open' either", () => {
  const RAW_OPEN = /\bstatus\s*=\s*'open'/;

  /** Raw-SQL sites, by file. */
  const sites = FILES.filter((f) => RAW_OPEN.test(stripped(f))).map(rel);

  it("scans real source (floor)", () => {
    // The same floor the rest of this file keeps: an empty scan reports clean.
    expect(FILES.length).toBeGreaterThan(150);
  });

  it("no offboarding path filters tasks by a bare 'open' in SQL", () => {
    expect(
      sites,
      sites.length
        ? `\n\nRaw-SQL \`status = 'open'\` in:\n  ${sites.join("\n  ")}\n\n` +
            `This is the same drift as eq(tasks.status, "open"), in the form the\n` +
            `allowlist scan above cannot see. If it decides whether work still\n` +
            `EXISTS — a dedupe, an owned-work count, a reassignment — it must use\n` +
            `the live set (open, draft, in_progress, snoozed). admin.ts binds it\n` +
            `via liveTaskStatuses(); do the same rather than inlining a literal.\n`
        : undefined,
    ).toEqual([]);
  });

  it("admin.ts reassigns and counts over the LIVE set, bound not inlined", () => {
    const admin = stripped(
      FILES.find((f) => rel(f) === "server/routers/admin.ts")!,
    );
    /**
     * Every tasks statement on the offboarding paths goes through the helper.
     *
     * ⚠️ THE FLOOR DROPPED FROM 4 TO 2, AND THAT IS A CONSOLIDATION, NOT A
     * REGRESSION. There used to be four hand-written statements — one count
     * plus three reassignments — each carrying its own `${liveTaskStatuses()}`.
     * They now share `countOwnedWork` / `reassignOwnedWork`, which iterate
     * `OWNABLE_TABLES` and apply the filter to the tables that ask for it, so
     * there is exactly one templated site each. The property being protected is
     * unchanged: no offboarding statement may filter tasks by a bare 'open'.
     *
     * Verified by mutation rather than assumed — dropping `liveOnly` from the
     * tasks entry, or the conditional from either statement, still fails here
     * and in server/ownedWorkReassign.test.ts.
     */
    const helperUses = (admin.match(/\$\{liveTaskStatuses\(\)\}/g) ?? []).length;
    expect(
      helperUses,
      "expected the shared count and reassign statements to use liveTaskStatuses()",
    ).toBeGreaterThanOrEqual(2);

    // The filter must be applied CONDITIONALLY, from the shared list's own flag
    // — hardcoding it onto every table would reassign closed tasks, and
    // dropping the conditional entirely would reassign none of them correctly.
    const conditionalUses = (admin.match(/o\.liveOnly \? sql`AND \$\{liveTaskStatuses\(\)\}` : sql``/g) ?? []).length;
    expect(
      conditionalUses,
      "the live-task filter is no longer driven by OWNABLE_TABLES.liveOnly",
    ).toBeGreaterThanOrEqual(2);

    // And no hand-rolled tasks statement may survive alongside the helper.
    expect(admin, "a raw tasks UPDATE reappeared outside the shared helper")
      .not.toMatch(/UPDATE\s+tasks\s+SET\s+ownerUserId/i);

    // And the helper must derive from the shared definition, not a local list.
    expect(admin).toMatch(/function liveTaskStatuses\(\)[\s\S]{0,200}?activeTaskStatuses\(\)/);
    expect(admin).toMatch(/import \{ activeTaskStatuses \} from "@shared\/taskStatus"/);
    // Bound parameters, not string-built.
    expect(admin).toMatch(/sql\.join\(/);
  });

  it("the owned-work gate counts the same set it reassigns", () => {
    /**
     * The gate and the fix have to agree. If the COUNT is narrower than the
     * UPDATE, an admin is never asked to reassign work that the UPDATE would
     * have moved — which is precisely how in_progress tasks were orphaned.
     */
    const admin = stripped(FILES.find((f) => rel(f) === "server/routers/admin.ts")!);
    /**
     * Re-anchored: the count no longer names `tasks` inline. Both statements
     * are templated over OWNABLE_TABLES, so what has to agree is that the COUNT
     * and the UPDATE carry the SAME conditional — checked here by isolating
     * each statement and requiring the filter in both.
     */
    const countStmt = /SELECT COUNT\(\*\) AS n FROM[\s\S]*?`,/.exec(admin)?.[0] ?? "";
    const updateStmt = /UPDATE \$\{sql\.raw[\s\S]*?`,/.exec(admin)?.[0] ?? "";
    expect(countStmt, "the owned-work count statement was not found — re-anchor this test").not.toBe("");
    expect(updateStmt, "the reassignment statement was not found — re-anchor this test").not.toBe("");
    expect(countStmt, "the count no longer filters tasks by the live set").toContain("liveTaskStatuses()");
    expect(updateStmt, "the reassignment no longer filters tasks by the live set").toContain("liveTaskStatuses()");
  });
});
