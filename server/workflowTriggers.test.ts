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
