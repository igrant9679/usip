/**
 * Guard for the dead-wiring shape that hit workflow rules twice:
 *
 *   "an option the UI offers that nothing on the server acts on."
 *
 * A rule built on a dead trigger, or a condition using an unimplemented
 * operator, saves cleanly, shows as enabled, and simply never happens. There is
 * no error to notice, which is what makes this class expensive — the feature
 * looks finished from every angle except the one nobody checks.
 *
 * Two independent instances existed at once:
 *   • the condition editor offered `in`; evalConditions had no case for it and
 *     fell through to `default: return false`
 *   • the AI rule generator advertised `schedule` to the model as VALID, under
 *     a prompt line reading "anything else is ignored by the engine", and its
 *     accept path also let `nps_submitted` and `field_equals` through — all
 *     three dispatched by nothing
 *
 * These tests pin the vocabularies to each other. They are cheap and they fail
 * loudly the moment someone adds an option without adding its implementation.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_TRIGGER_IDS,
  CONDITION_OP_IDS,
  DEAD_TRIGGERS,
  isDeadTrigger,
  LIVE_TRIGGER_IDS,
} from "../shared/workflowTriggers";
import { evalConditions } from "./services/workflowEngine";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("workflow trigger vocabulary", () => {
  it("live and dead trigger sets are disjoint", () => {
    const overlap = LIVE_TRIGGER_IDS.filter((t) => (DEAD_TRIGGERS as readonly string[]).includes(t));
    expect(overlap).toEqual([]);
  });

  it("every LIVE trigger has a dispatch site in server source", () => {
    // deal_stuck runs through its own path in routers/operations.ts rather than
    // fireWorkflowRules, so match the trigger name anywhere in the server tree
    // rather than assuming one dispatch shape.
    const sources = [
      "server/routers/crm.ts",
      "server/routers/operations.ts",
      "server/services/workflowEngine.ts",
      "server/services/linkedinEnrichment/jobChangeReengagement.ts",
      "server/nightlyBatch.ts",
    ].map(read).join("\n");

    const undispatched = LIVE_TRIGGER_IDS.filter((t) => !new RegExp(`"${t}"`).test(sources));
    expect(
      undispatched,
      undispatched.length
        ? `\n\nThese triggers are offered as LIVE but no dispatch site mentions them:\n  ${undispatched.join("\n  ")}\n` +
            `Either add the dispatch in the same commit, or move them to DEAD_TRIGGERS.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the AI rule generator only offers triggers that dispatch", () => {
    const src = read("server/routers/aiFeatures.ts");
    const offendersInPrompt = (DEAD_TRIGGERS as readonly string[]).filter((t) =>
      new RegExp(`"${t}"`).test(src),
    );
    expect(
      offendersInPrompt,
      offendersInPrompt.length
        ? `\n\naiFeatures.ts still references dead trigger(s): ${offendersInPrompt.join(", ")}.\n` +
            `The generator must not propose a rule that can never fire.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the Workflows page offers exactly the live triggers, and no dead ones", () => {
    const src = read("client/src/pages/usip/Workflows.tsx");
    // It must build its picker from the shared list rather than a local literal.
    expect(src).toContain("LIVE_TRIGGERS");
    for (const dead of DEAD_TRIGGERS) {
      expect(src.includes(`"${dead}"`), `Workflows.tsx hardcodes dead trigger ${dead}`).toBe(false);
    }
  });

  it("isDeadTrigger recognises saved rules on retired triggers", () => {
    expect(isDeadTrigger("schedule")).toBe(true);
    expect(isDeadTrigger("record_created")).toBe(false);
    expect(ALL_TRIGGER_IDS).toContain("schedule");
  });
});

describe("condition operator vocabulary", () => {
  it("every operator the UI offers is implemented by evalConditions", () => {
    // Probe each operator through the real evaluator. An unimplemented one hits
    // `default: return false` and can never return true for ANY input, so a
    // pair of probes that both return false is the signature of a dead op.
    const probes: Record<string, { pass: [any, any]; fail: [any, any] }> = {
      eq: { pass: ["won", "won"], fail: ["won", "lost"] },
      neq: { pass: ["won", "lost"], fail: ["won", "won"] },
      gt: { pass: [10, 5], fail: [5, 10] },
      gte: { pass: [10, 10], fail: [5, 10] },
      lt: { pass: [5, 10], fail: [10, 5] },
      lte: { pass: [10, 10], fail: [10, 5] },
      contains: { pass: ["Healthcare", "health"], fail: ["Healthcare", "tech"] },
      in: { pass: ["negotiation", ["proposal", "negotiation"]], fail: ["discovery", ["proposal"]] },
    };

    const missing: string[] = [];
    for (const op of CONDITION_OP_IDS) {
      const probe = probes[op];
      if (!probe) { missing.push(`${op} (no probe — add one to this test)`); continue; }
      const truthy = evalConditions({ all: [{ field: "f", op, value: probe.pass[1] }] }, { f: probe.pass[0] });
      const falsy = evalConditions({ all: [{ field: "f", op, value: probe.fail[1] }] }, { f: probe.fail[0] });
      if (truthy !== true || falsy !== false) missing.push(op);
    }

    expect(
      missing,
      missing.length
        ? `\n\nOperator(s) offered by the condition editor that evalConditions does not\n` +
            `implement: ${missing.join(", ")}. Any rule using one evaluates false forever\n` +
            `and never fires, with nothing in the UI to explain why.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the Workflows page builds its operator list from the shared vocabulary", () => {
    expect(read("client/src/pages/usip/Workflows.tsx")).toContain("CONDITION_OPS");
  });
});

describe("workflow action dispatch", () => {
  /** The action-type ids the rule builder offers, read from its own source. */
  function offeredActionTypes(): string[] {
    const src = read("client/src/pages/usip/Workflows.tsx");
    const block = src.match(/const ACTION_TYPES = \[([\s\S]*?)\] as const;/);
    if (!block) throw new Error("ACTION_TYPES not found in Workflows.tsx");
    return [...block[1].matchAll(/\["([a-z_]+)",/g)].map((m) => m[1]);
  }

  it("every action the builder offers has a handler in workflowEngine", () => {
    const engine = read("server/services/workflowEngine.ts");
    const missing = offeredActionTypes().filter((t) => !new RegExp(`case "${t}":`).test(engine));
    expect(
      missing,
      missing.length
        ? `\n\nAction type(s) offered by the rule builder with no handler in\n` +
            `workflowEngine.runAction: ${missing.join(", ")}. runAction returns an error\n` +
            `string for unknown types, so the rule is at least logged as failed — but the\n` +
            `user picked an action that can never happen.\n`
        : undefined,
    ).toEqual([]);
  });

  /**
   * deal_stuck used to run its actions through a SECOND dispatcher that lived
   * in operations.ts and understood four action types, two of which the builder
   * never emits. Six of the eight builder actions did nothing on that trigger,
   * silently, and the run was still logged "success" because no branch had set
   * an error. One dispatcher or this happens again.
   */
  it("operations.ts does not re-implement action dispatch", () => {
    const src = read("server/routers/operations.ts");
    const localBranches = [...src.matchAll(/action\.type === "([a-z_]+)"/g)].map((m) => m[1]);
    expect(
      localBranches,
      localBranches.length
        ? `\n\noperations.ts is branching on action.type again (${[...new Set(localBranches)].join(", ")}).\n` +
            `Route rule actions through executeRuleActions() instead — a second dispatcher\n` +
            `drifts from the builder and fails silently.\n`
        : undefined,
    ).toEqual([]);
    expect(src).toContain("executeRuleActions");
  });

  it("nothing writes an out-of-enum workflowRuns.status", () => {
    // enum is success | failed | skipped. "error" fails the INSERT outright, so
    // the only run worth logging — one that had errors — was the one that could
    // not be written. Two of the three call sites had it; the third carried a
    // comment explaining the bug it had already been fixed for.
    const files = ["server/routers/operations.ts", "server/services/workflowEngine.ts"];
    const allowed = new Set(["success", "failed", "skipped"]);
    const bad: string[] = [];
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/insert\(workflowRuns\)[\s\S]{0,400}?status:\s*([^,\n]+)/g)) {
        for (const lit of m[1].matchAll(/"([a-z_]+)"/g)) {
          if (!allowed.has(lit[1])) bad.push(`${f}: "${lit[1]}"`);
        }
      }
    }
    expect(
      bad,
      bad.length ? `\n\nworkflowRuns.status must be success|failed|skipped:\n  ${bad.join("\n  ")}\n` : undefined,
    ).toEqual([]);
  });

  it("nothing writes an out-of-enum notifications.kind", () => {
    // The removed create_notification branch inserted kind "deal_stuck", which
    // is not in the enum — a runtime-only failure of exactly the `as never`
    // class. Parsed from the schema so the list cannot go stale here.
    const schema = read("drizzle/schema.ts");
    const enumBlock = schema.match(/kind: mysqlEnum\("kind",\s*\[([\s\S]*?)\]/);
    const allowed = new Set([...enumBlock![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
    const files = ["server/routers/operations.ts", "server/services/workflowEngine.ts"];
    const bad: string[] = [];
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/insert\(notifications\)[\s\S]{0,300}?kind:\s*"([a-z_]+)"/g)) {
        if (!allowed.has(m[1])) bad.push(`${f}: "${m[1]}"`);
      }
    }
    expect(
      bad,
      bad.length
        ? `\n\nnotifications.kind must be one of: ${[...allowed].join(", ")}\n  ${bad.join("\n  ")}\n`
        : undefined,
    ).toEqual([]);
  });
});
