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
