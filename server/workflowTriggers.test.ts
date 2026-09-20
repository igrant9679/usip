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
  ACTION_ENTITY_SUPPORT,
  actionSupportsEntity,
  ALL_TRIGGER_IDS,
  CONDITION_OP_IDS,
  DEAD_TRIGGERS,
  isDeadTrigger,
  LIVE_TRIGGER_IDS,
  RECORD_COMMON_FIELDS,
  RECORD_ENTITY_IDS,
  RECORD_FIELDS,
  RECORD_PAYLOAD_ENTITIES,
  recordFieldsFor,
} from "../shared/workflowTriggers";
import {
  buildRecordPayload, burstExceeded, entityGateAllows, evalConditions, __resetBurstWindows,
} from "./services/workflowEngine";

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

/**
 * 2026-09-20 — the trigger INVENTORY.
 *
 * The vocabularies above were already pinned to each other, and the dead half
 * of the problem was fixed. The live half was not: a trigger can have "a
 * dispatch site" and still be a half-feature, because the site covers one
 * entity or one of several doors. The inventory found exactly that:
 *
 *   • record_created / record_updated fired ONLY from leads.create /
 *     leads.update, while the builder offered "when a record is created" with
 *     no entity in sight — a contact or opportunity rule looked healthy and
 *     never ran
 *   • stage_changed fired from crm.setStage, which is ONE of the five places
 *     that write opportunities.stage — so "when a deal is won" was dead on the
 *     Alerts move control, the approval queue and BOTH proposal-accept paths,
 *     which is the most valuable rule anyone builds
 *   • deal_stuck ran its actions on every stuck deal and never evaluated the
 *     rule's own conditions
 *
 * Every regex below is CRLF-tolerant ([\s\S], never a bare \n) — the server
 * tree is CRLF on disk.
 */
describe("trigger coverage (the inventory)", () => {
  it("record_created covers every entity the builder offers", () => {
    const src = read("server/routers/crm.ts");
    expect(src, "contacts.create does not announce itself").toMatch(/fireRecordCreated\([\s\S]{0,80}"contact"/);
    expect(src, "opportunities.create does not announce itself").toMatch(/fireRecordCreated\([\s\S]{0,80}"opportunity"/);
    const n = [...src.matchAll(/fireRecordCreated\(/g)].length;
    expect(
      n,
      `crm.ts has ${n} record_created dispatches; expected at least 4 (leads.create, contacts.create, opportunities.create, and the contact + opportunity a lead conversion makes).`,
    ).toBeGreaterThanOrEqual(4);
  });

  /**
   * THE pin that would have caught the original bug: an update mutation that
   * writes the row and returns without telling the engine.
   */
  it("record_updated covers every entity with an update mutation", () => {
    const src = read("server/routers/crm.ts");
    const mutations: Array<[string, string]> = [
      ["contacts.update", "db.update(contacts).set(input.patch)"],
      ["leads.update", "db.update(leads).set(input.patch)"],
      ["opportunities.update", "db.update(opportunities).set(patch)"],
    ];
    const silent: string[] = [];
    for (const [name, anchor] of mutations) {
      const from = src.indexOf(anchor);
      expect(from, `${name}: anchor "${anchor}" not found — the pin needs updating`).toBeGreaterThan(-1);
      const to = src.indexOf("return { ok: true };", from);
      if (!src.slice(from, to).includes("fireRecordUpdated(")) silent.push(name);
    }
    expect(
      silent,
      silent.length
        ? `\n\nThese mutations write the record and fire nothing: ${silent.join(", ")}.\n` +
            `A "when a record is updated" rule scoped to that entity saves, shows enabled\n` +
            `and never runs — the exact shape this file exists to prevent.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the lead-conversion path announces all three records", () => {
    const src = read("server/routers/crm.ts");
    const slice = src.slice(src.indexOf("convert: repProcedure"), src.indexOf("rescore: repProcedure"));
    expect(slice.length, "convert mutation not found").toBeGreaterThan(0);
    // The contact and the opportunity it creates, plus the lead going
    // `converted` — the "when a lead converts" rule people actually want.
    expect([...slice.matchAll(/fireRecordCreated\(/g)].length).toBe(2);
    expect([...slice.matchAll(/fireRecordUpdated\(/g)].length).toBe(1);
    // The ACCOUNT is deliberately silent: accounts are out of scope for v1.
    expect(slice).not.toMatch(/fireRecordCreated\([\s\S]{0,80}"account"/);
  });

  it("stage_changed fires from every door that writes a stage", () => {
    /**
     * setStage is not the only door — pipelineAlerts.moveDealStage,
     * opportunityIntelligence.reviewStageChange and both proposal-accept paths
     * write opportunities.stage too. Counted per file rather than by proximity
     * because crm.setStage runs ~90 lines of closed-won / closed-lost handling
     * between the UPDATE and its fire.
     */
    const files = [
      "server/routers/crm.ts",
      "server/routers/pipelineAlerts.ts",
      "server/routers/opportunityIntelligence.ts",
      "server/routers/proposals.ts",
    ];
    const short: string[] = [];
    for (const f of files) {
      const src = read(f);
      const doors = [...src.matchAll(/update\(opportunities\)[\s\S]{0,200}?stage:/g)].length;
      const announced = [...src.matchAll(/fireStageChanged\(|"stage_changed"/g)].length;
      if (announced < doors) short.push(`${f}: ${doors} stage write(s), ${announced} announcement(s)`);
    }
    expect(
      short,
      short.length
        ? `\n\nA stage write with nothing telling the rule engine:\n  ${short.join("\n  ")}\n` +
            `stage_changed has FIVE doors: crm.setStage, pipelineAlerts.moveDealStage,\n` +
            `opportunityIntelligence.reviewStageChange, and both proposal-accept paths.\n` +
            `"When a deal is WON" is the first rule anyone builds — it must fire from all of them.\n`
        : undefined,
    ).toEqual([]);
  });

  it("no bulk or engine path fires a rule", () => {
    /**
     * A 5,000-row import must not fire 5,000 webhooks. Note that "one tRPC
     * mutation = one record" is NOT a structural guard in this codebase:
     * are/prospectsBulk.ts loops an appRouter.createCaller over a whole
     * campaign, so anything such a loop can reach counts as bulk.
     */
    const bulk = [
      "server/routers/imports.ts",
      "server/routers/prospectImports.ts",
      "server/routers/unipile.ts",
      "server/routers/linkedinFinder.ts",
      "server/routers/placesSearch.ts",
      "server/routers/urlScraper.ts",
      "server/services/linkedinEnrichment/batchService.ts",
      "server/services/discovery/consolidate.ts",
      "server/services/leadBridge.ts",
      "server/services/personLink.ts",
      "server/services/company/associationService.ts",
      "server/services/crmMatching.ts",
      "server/services/prospectPromotion.ts",
      "server/routers/are/execution.ts",
      "server/seed.ts",
      "server/demoSeedExtras.ts",
    ];
    // are/execution.ts legitimately emits signal_received for the same moment,
    // so only the record/stage helpers are forbidden there.
    const signalOnly = new Set(["server/routers/are/execution.ts"]);
    const offenders: string[] = [];
    for (const f of bulk) {
      const src = read(f);
      const patterns = signalOnly.has(f)
        ? [/fireRecordCreated\(/, /fireRecordUpdated\(/, /fireStageChanged\(/]
        : [/fireRecordCreated\(/, /fireRecordUpdated\(/, /fireStageChanged\(/, /fireWorkflowRules\(/];
      for (const p of patterns) if (p.test(src)) offenders.push(`${f} → ${p.source}`);
    }
    expect(
      offenders,
      offenders.length
        ? `\n\nA bulk or engine path is dispatching workflow rules:\n  ${offenders.join("\n  ")}\n` +
            `A 5,000-row import must not fire 5,000 rules. Fire from the single-record,\n` +
            `human-originated door instead — see the do-not-fire list in workflowEngine.ts.\n`
        : undefined,
    ).toEqual([]);
  });

  it("prospect promotion only fires when it really created something", () => {
    const src = read("server/routers/prospects.ts");
    const start = src.indexOf("promoteToLead:");
    expect(start, "promoteToLead not found").toBeGreaterThan(-1);
    const slice = src.slice(start);
    const guard = slice.indexOf("if (!leadId) {");
    const fire = slice.indexOf("fireRecordCreated(");
    const ret = slice.indexOf("created: true");
    expect(guard, "the insert guard moved").toBeGreaterThan(-1);
    expect(
      fire,
      "promoteToLead reuses an existing lead on two of its three paths — firing outside the insert branch announces a new lead every time someone re-clicks Save",
    ).toBeGreaterThan(guard);
    expect(fire).toBeLessThan(ret);
    // promoteToContact is idempotent the same way.
    expect(src).toMatch(/if \(!outcome\.alreadyLinked\)[\s\S]{0,600}?fireRecordCreated\(/);
  });

  it("fireWorkflowRules is burst-capped and archive-gated", () => {
    const src = read("server/services/workflowEngine.ts");
    // forms/landingPages/chatAgents/bookingLinks are PUBLIC and unthrottled —
    // without a cap, a form-spam run becomes an outbound webhook flood.
    expect(src).toContain("BURST_MAX");
    expect(src).toContain("isWorkspaceArchived(");
    expect(src, "the burst branch must record its suppression as a `skipped` run")
      .toMatch(/burstExceeded\([\s\S]{0,1200}?status: "skipped"/);
  });

  it("the burst window passes BURST_MAX events and reports one suppression", () => {
    __resetBurstWindows();
    let passed = 0;
    let suppressions = 0;
    for (let i = 0; i < 60; i++) {
      const r = burstExceeded(99001, "record_created");
      if (!r.capped) passed++;
      if (r.firstOverflow) suppressions++;
    }
    expect(passed).toBe(50);
    // Logged ONCE per window: a row per rule per event would cost more writes
    // than the webhooks the cap is preventing.
    expect(suppressions).toBe(1);
    // Windows are per workspace AND per trigger.
    expect(burstExceeded(99002, "record_created").capped).toBe(false);
    expect(burstExceeded(99001, "stage_changed").capped).toBe(false);
    __resetBurstWindows();
  });

  it("both cross-workspace crons skip archived workspaces", () => {
    // Deliberately NOT added to archiveEnforcement.test.ts's engine-fleet sweep:
    // that contract is "every *AllWorkspaces per-workspace engine", and
    // operations.ts is a request-path router that happens to export one cron.
    for (const f of ["server/services/workflowEngine.ts", "server/routers/operations.ts"]) {
      const src = read(f);
      expect(src, `${f} never consults the archive gate`).toContain("archivedWorkspaceIds");
      expect(src, `${f} loads the archived ids but never checks them`).toContain("archivedWs.has(");
    }
    const eng = read("server/services/workflowEngine.ts");
    const loop = eng.indexOf("for (const t of due) {");
    const skip = eng.indexOf("archivedWs.has(");
    const notify = eng.indexOf(`event: "taskOverdue"`);
    // Inside the per-task loop and before the notify, so an archived workspace
    // gets neither the notification nor the rule.
    expect(skip).toBeGreaterThan(loop);
    expect(skip).toBeLessThan(notify);
  });

  it("deal_stuck honours its conditions", () => {
    const src = read("server/routers/operations.ts");
    const gates = [...src.matchAll(/evalConditions\(normalizeConditions\(/g)];
    expect(
      gates.length,
      "both deal_stuck loops (the nightly cron and the tRPC check) must evaluate the rule's conditions",
    ).toBeGreaterThanOrEqual(2);
    const execs = [...src.matchAll(/executeRuleActions\(/g)].map((m) => m.index ?? 0);
    // Each gate precedes an action run — a gate after the actions is no gate.
    for (let i = 0; i < gates.length; i++) {
      const g = gates[i]!.index ?? 0;
      expect(execs.some((e) => e > g), "a conditions gate sits after its executeRuleActions call").toBe(true);
    }
    // The payload must carry what the condition editor offers, or wiring the
    // gate in silently kills every existing "stuck deals over $50k" rule.
    const payloads = [...src.matchAll(/daysInStage: deal\.daysInStage,[\s\S]{0,300}?ruleName: rule\.name,/g)];
    expect(payloads.length, "both deal_stuck payloads not found").toBe(2);
    for (const p of payloads) {
      expect(p[0]).toContain("value:");
      expect(p[0]).toContain("winProb:");
    }
  });

  it("the condition editor only offers fields that exist", () => {
    // `ownerId` and `leadGrade` are not columns on anything — the schema spells
    // them ownerUserId and grade — so a rule using either compared against
    // undefined and evaluated false forever.
    const src = read("client/src/pages/usip/Workflows.tsx");
    expect(src.includes(`"ownerId"`), "Workflows.tsx still offers the non-existent field ownerId").toBe(false);
    expect(src.includes(`"leadGrade"`), "Workflows.tsx still offers the non-existent field leadGrade").toBe(false);
  });

  it("the record_* entity scope is offered in the builder and defaulted in the engine", () => {
    const page = read("client/src/pages/usip/Workflows.tsx");
    expect(page, "the entity selector is missing — record_* now covers three entities").toContain("triggerConfig.entity");
    // 2026-09-20: the inline `cfg.entity ?? "lead"` branch this used to regex
    // became the exported predicate entityGateAllows, which the unit tests
    // below exercise properly. A source scan cannot tell whether the default
    // is applied, only that a literal is present.
    const engine = read("server/services/workflowEngine.ts");
    expect(engine).toContain("entityGateAllows(");
    // Absent entity means "lead": every rule saved before the dispatch widened
    // was authored against leads, and the AI generator still omits it.
    expect(entityGateAllows("record_created", undefined, "lead")).toBe(true);
  });

  it("the seeder ships no enabled rule that cannot fire", () => {
    const src = read("server/seed.ts");
    const block = src.slice(src.indexOf("for (const wf of ["), src.indexOf("// Campaigns (3)"));
    expect(block.length, "the seeded workflow-rule array moved").toBeGreaterThan(0);
    const entries = block.split("{ name: SEED_WORKFLOW_NAMES").slice(1);
    expect(entries.length, "sampleDataCoverage pins three seeded workflow names").toBe(3);
    const bad: string[] = [];
    for (const e of entries) {
      for (const op of e.matchAll(/op: "([^"]+)"/g)) {
        if (!(CONDITION_OP_IDS as readonly string[]).includes(op[1])) bad.push(`op "${op[1]}" is not a real comparator`);
      }
      const trigger = e.match(/triggerType: "([a-z_]+)"/)?.[1] ?? "";
      if (isDeadTrigger(trigger) && !/enabled: false/.test(e)) {
        bad.push(`the ${trigger} rule ships enabled and can never fire`);
      }
    }
    expect(
      bad,
      bad.length
        ? `\n\nDemo workspaces would ship broken automation:\n  ${bad.join("\n  ")}\n` +
            `A seeded rule is the first one a new user reads — one that cannot fire\n` +
            `teaches them the feature is decorative.\n`
        : undefined,
    ).toEqual([]);
  });

  it("workflows.update cannot write a dead trigger", () => {
    const src = read("server/routers/operations.ts");
    const router = src.slice(src.indexOf("export const workflowsRouter"), src.indexOf("/* ───── Campaigns"));
    expect(router.length, "workflowsRouter not found").toBeGreaterThan(0);
    expect(
      router.includes("patch: z.record("),
      "workflows.update takes a free-form record again — every gate `create` enforces (live trigger, workspaceId, fireCount) can be walked around by editing the rule afterwards",
    ).toBe(false);
    expect([...router.matchAll(/z\.enum\(LIVE_TRIGGER_IDS/g)].length).toBe(2);
  });

  it("run history names the record that set it off", () => {
    for (const f of ["server/services/workflowEngine.ts", "server/routers/operations.ts"]) {
      const chunks = read(f).split("insert(workflowRuns)").slice(1);
      expect(chunks.length, `${f} writes no run history`).toBeGreaterThan(0);
      chunks.forEach((c, i) => {
        const w = c.slice(0, 900);
        expect(w, `${f}: workflowRuns insert #${i + 1} has no relatedType`).toContain("relatedType:");
        expect(w, `${f}: workflowRuns insert #${i + 1} has no relatedId`).toContain("relatedId:");
      });
    }
  });
});

/**
 * 2026-09-20 — the record PAYLOAD, the half a dispatch site does not fix.
 *
 * Widening record_created to three entities made the trigger fire. It did not
 * make a rule on it WORK: the builder's condition list and the dispatch payload
 * were two independently hand-written lists with NO keys in common — the editor
 * offered industry / region / healthScore / npsScore, the payload carried
 * company / title / source. Every conditioned record rule compared against
 * `undefined`, and `undefined` is a silent false: the trigger fired, the run
 * was never logged, the rule sat at fireCount 0 looking exactly like one whose
 * event simply had not happened yet.
 *
 * So both sides now come from one declaration (RECORD_FIELDS), and these tests
 * pin them to each other rather than to a snapshot of today's spelling.
 */
describe("record payload vocabulary", () => {
  it("an unscoped record rule means LEAD, not 'any'", () => {
    // The default is not cosmetic: every rule saved before the dispatch widened
    // carries triggerConfig {} — the builder, workflows.create and the AI apply
    // path all wrote it — so reading absent as "any" would have made each of
    // them start firing on contacts and opportunities on deploy day.
    expect(entityGateAllows("record_created", undefined, "lead")).toBe(true);
    expect(entityGateAllows("record_created", undefined, "contact")).toBe(false);
    expect(entityGateAllows("record_updated", undefined, "opportunity")).toBe(false);
    expect(entityGateAllows("record_created", "contact", "contact")).toBe(true);
    expect(entityGateAllows("record_created", "contact", "lead")).toBe(false);
    // "any" is the explicit opt-in the builder offers for all three.
    expect(entityGateAllows("record_created", "any", "opportunity")).toBe(true);
    // Other triggers keep the legacy shape: entity is an optional filter with
    // no default, so a legacy signal rule carrying a stray entity still fires.
    expect(entityGateAllows("signal_received", undefined, "are_prospect")).toBe(true);
    expect(entityGateAllows("stage_changed", undefined, "opportunity")).toBe(true);
    expect(entityGateAllows("signal_received", "lead", "contact")).toBe(false);
  });

  it("a condition on a field the payload lacks is silently false — which is why the lists must match", () => {
    // The evidence for this whole describe block. `eq` against a missing key is
    // false forever with nothing to explain it in the UI.
    expect(evalConditions({ all: [{ field: "healthScore", op: "eq", value: "40" }] }, { entity: "lead" })).toBe(false);
    // And the counterexample that makes "a conditioned rule is dead" too broad:
    // neq against a missing key is TRUE, so such a rule fires on everything.
    expect(evalConditions({ all: [{ field: "healthScore", op: "neq", value: "40" }] }, { entity: "lead" })).toBe(true);
  });

  it("every field the builder offers is a key the payload carries", () => {
    const missing: string[] = [];
    for (let i = 0; i < RECORD_PAYLOAD_ENTITIES.length; i++) {
      const entity = RECORD_PAYLOAD_ENTITIES[i]!;
      // Nothing passed in: the payload must still declare every key, because a
      // seam that does not know a field is exactly the case that used to make
      // it absent and the condition dead.
      const payload = buildRecordPayload(entity, 1, {});
      const offered = recordFieldsFor("record_created", entity);
      for (let j = 0; j < offered.length; j++) {
        const f = offered[j]!;
        if (f === "ownerUserId") continue; // stamped by fireRecordCreated, not the builder
        if (!Object.prototype.hasOwnProperty.call(payload, f)) missing.push(`${entity}.${f}`);
      }
    }
    expect(
      missing,
      missing.length
        ? `\n\nThe rule builder offers condition field(s) no payload carries:\n  ${missing.join("\n  ")}\n` +
            `A condition on a missing key evaluates false forever (or true, for neq) and the\n` +
            `rule looks healthy either way. Declare the key in RECORD_FIELDS or stop offering it.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the payload carries the declared keys and nothing else", () => {
    // The other direction, and the PII half: ctx.payload goes verbatim into a
    // webhook action's POST body, so a dispatch site must not be able to spread
    // a whole tRPC input into it.
    const payload = buildRecordPayload("lead", 7, {
      company: "Acme", firstName: "Jane", lastName: "Doe", phone: "+1 555 0100",
    });
    expect(payload.entity).toBe("lead");
    expect(payload.id).toBe(7);
    expect(payload.company).toBe("Acme");
    expect(payload.title, "a declared key the seam did not supply must be null, never absent").toBe(null);
    for (const leaked of ["firstName", "lastName", "phone"]) {
      expect(
        Object.prototype.hasOwnProperty.call(payload, leaked),
        `${leaked} reached the payload — it is not in RECORD_FIELDS, and the payload is POSTed to a customer-configured webhook URL`,
      ).toBe(false);
    }
    // An entity with no declaration gets the common keys only, never a crash.
    expect(Object.keys(buildRecordPayload("account", 3, { name: "Acme" })).sort()).toEqual(["entity", "id"]);
  });

  it("no dispatch site spreads a whole input object into the payload", () => {
    // How the leak would come back: `{ ...input }` at a call site. Cheap to
    // write, invisible in review, and it ships the submitter's phone number to
    // whatever URL the rule's webhook action names.
    const files = [
      "server/routers/crm.ts", "server/routers/forms.ts", "server/routers/landingPages.ts",
      "server/routers/chatAgents.ts", "server/routers/bookingLinks.ts", "server/routers/prospects.ts",
    ];
    const offenders: string[] = [];
    for (const f of files) {
      if (/fireRecordCreated\([\s\S]{0,200}?\.\.\.\w+/.test(read(f))) offenders.push(f);
    }
    expect(
      offenders,
      offenders.length ? `\n\nSpread into a record_created payload:\n  ${offenders.join("\n  ")}\n` : undefined,
    ).toEqual([]);
  });

  it("score and grade are offered on record_updated only", () => {
    // leadScoring writes both asynchronously AFTER the insert, so on
    // record_created they can only ever be the column default — "new lead with
    // score >= 60" is unfireable however the operator is spelled, and that was
    // the seeded sample rule for months.
    expect(recordFieldsFor("record_created", "lead")).not.toContain("score");
    expect(recordFieldsFor("record_updated", "lead")).toContain("score");
    expect(recordFieldsFor("record_updated", "lead")).toContain("changed");
    // Scope "any" offers the union of the three, so a rule can still condition
    // on a key only one of them carries.
    const anyFields = recordFieldsFor("record_created", "any");
    expect(anyFields).toContain("stage");
    expect(anyFields).toContain("company");
    // …and an unknown entity falls back to the union rather than to nothing.
    expect(recordFieldsFor("record_created", "account")).toEqual(anyFields);
  });

  it("the entity ids the builder offers are the ones the engine can gate on", () => {
    // RECORD_ENTITY_IDS is the selector's own list; every id but "any" must be
    // an entity a payload actually reports, or the option is dead wiring.
    const dispatchable = (RECORD_PAYLOAD_ENTITIES as readonly string[]).concat(["any"]);
    expect([...RECORD_ENTITY_IDS].sort()).toEqual([...dispatchable].sort());
    for (let i = 0; i < RECORD_PAYLOAD_ENTITIES.length; i++) {
      expect(RECORD_FIELDS[RECORD_PAYLOAD_ENTITIES[i]!], `${RECORD_PAYLOAD_ENTITIES[i]} has no field declaration`).toBeTruthy();
    }
    expect(RECORD_COMMON_FIELDS).toContain("entity");
  });

  it("ACTION_ENTITY_SUPPORT matches the engine's own allowlists", () => {
    /**
     * The builder greys out "enroll in sequence" on an opportunity rule. That
     * claim has to come from the engine or it becomes a second, drifting truth
     * — the exact failure this file was written for. Parsed from runAction.
     */
    const engine = read("server/services/workflowEngine.ts");
    const allowedStart = engine.indexOf("const ALLOWED: Record<string");
    expect(allowedStart, "update_field's ALLOWED map moved").toBeGreaterThan(-1);
    const allowedBlock = engine.slice(allowedStart, engine.indexOf("};", allowedStart));
    const updateField = [...allowedBlock.matchAll(/([a-z]+):\s*\{/g)].map((m) => m[1]!);

    const enrollBlock = engine.slice(engine.indexOf(`case "enroll_sequence":`), engine.indexOf(`case "update_field":`));
    const enroll = [...enrollBlock.matchAll(/target !== "([a-z_]+)"/g)].map((m) => m[1]!);

    const draftStart = engine.indexOf(`case "send_email_draft":`);
    const draftBlock = engine.slice(draftStart, draftStart + 600);
    const draft = [...draftBlock.matchAll(/entity !== "([a-z_]+)"/g)].map((m) => m[1]!);

    // Only the record entities matter here — enroll_sequence also accepts a
    // prospect, which no record_* trigger can ever be scoped to.
    const recordOnly = (list: string[]) =>
      list.filter((e) => (RECORD_PAYLOAD_ENTITIES as readonly string[]).indexOf(e) >= 0).sort();
    const declared = (t: string) => [...(ACTION_ENTITY_SUPPORT[t] ?? [])].sort();

    expect(recordOnly(updateField), "update_field").toEqual(declared("update_field"));
    expect(recordOnly(enroll), "enroll_sequence").toEqual(declared("enroll_sequence"));
    expect(recordOnly(draft), "send_email_draft").toEqual(declared("send_email_draft"));
    // The predicate the builder calls, over the map above.
    expect(actionSupportsEntity("enroll_sequence", "opportunity")).toBe(false);
    expect(actionSupportsEntity("create_task", "opportunity"), "an unlisted action works everywhere").toBe(true);
    expect(actionSupportsEntity("enroll_sequence", "any"), "a scope of 'any' covers entities it does support").toBe(true);
  });

  it("the builder takes its record vocabulary from the shared declaration", () => {
    const page = read("client/src/pages/usip/Workflows.tsx");
    expect(page, "the condition list is hand-written again").toContain("recordFieldsFor(");
    expect(page, "the entity selector is hand-written again").toContain("RECORD_ENTITIES");
    expect(page, "unsupported actions are no longer labelled").toContain("actionSupportsEntity(");
    // A new rule is saved WITH its scope rather than relying on the engine's
    // default, so the editor shows what the rule will actually do.
    expect(page).toMatch(/t === "record_created"[\s\S]{0,120}?entity: "lead"/);
  });

  it("the seeded record rule conditions on a field its payload carries", () => {
    // It shipped `score >= 60` on record_created: wrong operator AND a field
    // written after the insert. Both fixed; this pins the field half, which the
    // operator-vocabulary test above cannot see.
    const src = read("server/seed.ts");
    const block = src.slice(src.indexOf("for (const wf of ["), src.indexOf("// Campaigns (3)"));
    const entries = block.split("{ name: SEED_WORKFLOW_NAMES").slice(1);
    const bad: string[] = [];
    for (const e of entries) {
      const trigger = e.match(/triggerType: "([a-z_]+)"/)?.[1] ?? "";
      if (trigger !== "record_created" && trigger !== "record_updated") continue;
      const entity = e.match(/entity: "([a-z]+)"/)?.[1] ?? "lead";
      const offered = recordFieldsFor(trigger, entity);
      for (const f of e.matchAll(/field: "([A-Za-z]+)"/g)) {
        // `field:` also names the column an update_field ACTION writes, which is
        // a different vocabulary; only conditions are checked here.
        if (e.indexOf(`{ field: "${f[1]}", op:`) < 0) continue;
        if (offered.indexOf(f[1]!) < 0) bad.push(`${trigger}/${entity}: "${f[1]}" is not in the payload`);
      }
    }
    expect(
      bad,
      bad.length
        ? `\n\nA seeded rule conditions on a field its trigger does not carry:\n  ${bad.join("\n  ")}\n` +
            `It is the first rule a new user reads, and it would sit at fireCount 0 forever.\n`
        : undefined,
    ).toEqual([]);
  });
});
