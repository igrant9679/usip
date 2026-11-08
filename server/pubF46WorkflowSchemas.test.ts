/**
 * F46 (audit 2026-10-20; final pass 2026-11-07): declared payload schemas for
 * every live workflow trigger, used by the editor, the AI rule prompt and these
 * tests, and a dry run of a rule against a chosen record.
 *
 *   1 · Every key any trigger's payload carries has a declaration (label,
 *       type, what it refers to), and the fixed value sets match the schema's
 *       own enums.
 *   2 · Each dispatch site's payload is built by an engine builder whose keys
 *       are exactly the declared ones — the dry run builds through the same
 *       builders, so what it shows is what the engine would send.
 *   3 · The AI rule generator's prompt is generated from the declaration.
 *   4 · The dry run reads a real record, runs the engine's gates and
 *       conditions, and says what each action would do to it. It writes
 *       nothing, sends nothing and calls no model.
 *
 * Run against the SQL-evaluating fake; the model, fetch and the pause check
 * are mocked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "a".repeat(64);
  return { db: null as any, paused: false, llmCalls: 0, fetches: 0 };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./_core/llm", async (a) => ({ ...(await a<typeof import("./_core/llm")>()), invokeLLM: async () => { h.llmCalls++; throw new Error("no model in tests"); } }));
vi.mock("./services/outboundPause", async (a) => ({
  ...(await a<typeof import("./services/outboundPause")>()),
  isOutboundPaused: async () => h.paused,
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateArchivedWorkspaceCache } from "./_core/workspaceArchive";
import {
  LEAD_STATUSES, LIVE_TRIGGERS, LIVE_TRIGGER_IDS, PAYLOAD_FIELDS, RECORD_COMMON_FIELDS, RECORD_FIELDS, RECORD_PAYLOAD_ENTITIES,
  RECORD_UPDATE_ONLY_FIELDS, SIGNAL_NAMES, TASK_PRIORITIES, TASK_TYPES, TRIGGER_FIELDS, describeTriggerPayloadsForPrompt,
  dryRunRecordTypesFor, payloadSchemaFor,
} from "@shared/workflowTriggers";
import { leads, tasks } from "../drizzle/schema";
import {
  buildDealStuckPayload, buildRecordPayload, buildRecordUpdatedPayload, buildStageChangedPayload, buildTaskOverduePayload,
} from "./services/workflowEngine";
import { dryRunRuleAgainstRecord } from "./services/workflowRecordDryRun";
import { autoAuditSkipped } from "./_core/autoAudit";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const WS = 2, OTHER = 4, MGR = 20, REP = 22, OWNER = 23;
const sorted = (xs: Iterable<string>) => Array.from(xs).sort();

const caller = (userId: number) => appRouter.createCaller({
  user: rows("users").find((u) => u.id === userId),
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) }, socket: { remoteAddress: "127.0.0.1" } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.paused = false;
  h.llmCalls = 0;
  h.fetches = 0;
  invalidateArchivedWorkspaceCache();
  vi.stubGlobal("fetch", async () => { h.fetches++; return new Response("{}", { status: 200 }); });
  rows("workspaces").push(
    { id: WS, name: "Acme", slug: "acme", ownerUserId: MGR, archivedAt: null, plan: "trial" },
    { id: OTHER, name: "Other", slug: "other", ownerUserId: 99, archivedAt: null, plan: "trial" },
  );
  rows("users").push(
    { id: MGR, openId: "local:20", name: "Mia Manager", email: "mia@acme.example", role: "user", loginMethod: "password" },
    { id: REP, openId: "local:22", name: "Ray Rep", email: "ray@acme.example", role: "user", loginMethod: "password" },
    { id: OWNER, openId: "local:23", name: "Olu Owner", email: "olu@acme.example", role: "user", loginMethod: "password" },
    { id: 24, openId: "local:24", name: "Left Long Ago", email: "gone@acme.example", role: "user", loginMethod: "password" },
  );
  const m = (id: number, userId: number, role: string, deactivatedAt: Date | null = null) => ({ id, workspaceId: WS, userId, role, deactivatedAt, inviteToken: null, lastActiveAt: new Date(), createdAt: new Date() });
  rows("workspace_members").push(m(1, MGR, "manager"), m(2, REP, "rep"), m(3, OWNER, "rep"), m(4, 24, "rep", new Date()));
  rows("leads").push(
    { id: 101, workspaceId: WS, firstName: "Ada", lastName: "Lane", email: "ada@acme-client.example", company: "Acme Client", title: "CTO", source: "webform", status: "new", ownerUserId: OWNER, score: 40 },
    { id: 201, workspaceId: OTHER, firstName: "Not", lastName: "Ours", email: "x@other.example", company: "Other", status: "new", ownerUserId: 99 },
  );
  rows("opportunities").push({ id: 301, workspaceId: WS, name: "Big deal", stage: "negotiation", value: "50000", winProb: 60, daysInStage: 3, ownerUserId: OWNER, pipelineId: null });
  rows("tasks").push({ id: 401, workspaceId: WS, title: "Call Ada", type: "call", priority: "high", status: "open", dueAt: new Date(Date.now() - 3_600_000), ownerUserId: OWNER, relatedType: "lead", relatedId: 101 });
  rows("sequences").push({ id: 501, workspaceId: WS, name: "Warm intro", status: "active" }, { id: 502, workspaceId: OTHER, name: "Theirs", status: "active" });
});
afterEach(() => vi.unstubAllGlobals());

/* ── 1 · the declaration ──────────────────────────────────────────────── */

describe("every payload key is declared (F46)", () => {
  it("each key in every trigger's list has a label and a type", () => {
    const keys = new Set<string>([...RECORD_COMMON_FIELDS, "changed"]);
    for (const e of Object.keys(RECORD_FIELDS)) for (const k of RECORD_FIELDS[e]!) keys.add(k);
    for (const e of Object.keys(RECORD_UPDATE_ONLY_FIELDS)) for (const k of RECORD_UPDATE_ONLY_FIELDS[e]!) keys.add(k);
    for (const t of Object.keys(TRIGGER_FIELDS)) for (const k of TRIGGER_FIELDS[t]!) keys.add(k);
    const missing = sorted(keys).filter((k) => !PAYLOAD_FIELDS[k]);
    expect(missing).toEqual([]);
    for (const k of keys) expect(PAYLOAD_FIELDS[k]!.label.length, k).toBeGreaterThan(0);
  });

  it("every live trigger has a declared payload, scoped by entity for the record triggers", () => {
    for (const t of LIVE_TRIGGER_IDS) {
      const schema = payloadSchemaFor(t, t.startsWith("record_") ? "opportunity" : null);
      expect(schema.length, t).toBeGreaterThan(0);
      for (const f of schema) expect(f.type, `${t}.${f.key}`).toBeTruthy();
    }
    expect(payloadSchemaFor("record_created", "lead").map((f) => f.key)).toEqual(["entity", "id", "ownerUserId", "company", "title", "source", "status", "email"]);
    // What a key refers to is declared, so the editor can offer names.
    expect(PAYLOAD_FIELDS.ownerUserId!.ref).toBe("user");
    expect(PAYLOAD_FIELDS.accountId!.ref).toBe("account");
    expect(PAYLOAD_FIELDS.stage!.ref).toBe("stage");
    expect(PAYLOAD_FIELDS.campaignId!.ref).toBe("campaign");
  });

  it("the fixed value sets are the schema's own enums", () => {
    expect([...LEAD_STATUSES]).toEqual([...(leads.status as any).enumValues]);
    expect([...TASK_TYPES]).toEqual([...(tasks.type as any).enumValues]);
    expect([...TASK_PRIORITIES]).toEqual([...(tasks.priority as any).enumValues]);
  });

  it("every signal a dispatch site sends is a declared signal", () => {
    const sent = new Set<string>();
    for (const f of ["server/services/linkedinEnrichment/jobChangeReengagement.ts", "server/services/company/brandReconciler.ts"]) {
      for (const m of read(f).matchAll(/signal: "([a-z_]+)"/g)) sent.add(m[1]!);
    }
    const bridged = read("server/routers/are/execution.ts").match(/WORKFLOW_BRIDGED_SIGNALS = new Set\(\[([^\]]+)\]/)![1]!;
    for (const m of bridged.matchAll(/"([a-z_]+)"/g)) sent.add(m[1]!);
    expect(sorted(sent)).toEqual(sorted(SIGNAL_NAMES));
  });
});

/* ── 2 · dispatch sites build exactly the declared payload ────────────── */

describe("each dispatch site's payload is the declared one (F46)", () => {
  it("task_overdue", () => {
    const p = buildTaskOverduePayload({ id: 1, title: "t", type: "call", priority: "high", dueAt: new Date() });
    expect(sorted(Object.keys(p))).toEqual(sorted(TRIGGER_FIELDS.task_overdue!));
  });

  it("stage_changed (with every extra the stage-change service passes)", () => {
    const p = buildStageChangedPayload(1, "proposal", "won", { value: 10, winProb: 100, isWon: true, isLost: false, name: "d" });
    expect(sorted(Object.keys(p))).toEqual(sorted(TRIGGER_FIELDS.stage_changed!));
    expect(read("server/services/stageChange.ts")).toContain("winProb, isWon: meta.isWon, isLost: meta.isLost, name: before.name ?? null,");
  });

  it("deal_stuck, from both of its sites", () => {
    const p = buildDealStuckPayload({ id: 1, name: "d", stage: "s", daysInStage: 9, value: "5", winProb: 20, ownerId: 3 });
    expect(sorted(Object.keys(p))).toEqual(sorted(TRIGGER_FIELDS.deal_stuck!));
    expect(Object.keys(buildDealStuckPayload({ id: 1, name: "d", stage: "s", daysInStage: 9, value: "5", winProb: 20 }, "Rule")).filter((k) => k !== "ruleName").sort()).toEqual(sorted(TRIGGER_FIELDS.deal_stuck!));
    const ops = read("server/routers/operations.ts");
    expect([...ops.matchAll(/buildDealStuckPayload\(deal, rule\.name\)/g)].length).toBe(2);
  });

  it("record_created for each entity, and record_updated adds `changed`", () => {
    for (const e of RECORD_PAYLOAD_ENTITIES) {
      const p = buildRecordPayload(e, 1, {});
      p.ownerUserId = null;
      expect(sorted(Object.keys(p)), e).toEqual(sorted([...RECORD_COMMON_FIELDS, ...RECORD_FIELDS[e]!]));
    }
    expect(buildRecordUpdatedPayload("lead", 1, { status: "new" }, { status: "working" }, 5)).toMatchObject({ entity: "lead", id: 1, ownerUserId: 5, status: "working", changed: ["status"] });
  });

  it("the engine fires through these builders", () => {
    const engine = read("server/services/workflowEngine.ts");
    expect(engine).toContain("payload: buildTaskOverduePayload(t),");
    expect(engine).toContain("const payload = buildStageChangedPayload(opportunityId, fromStage, toStage, extra);");
    expect(engine).toContain("const payload = buildRecordUpdatedPayload(entity, recordId, before, patch, ownerUserId);");
  });
});

/* ── 3 · the AI prompt ────────────────────────────────────────────────── */

describe("the AI rule prompt describes each trigger from the declaration (F46)", () => {
  it("names every live trigger and every key it carries", () => {
    const text = describeTriggerPayloadsForPrompt();
    for (const t of LIVE_TRIGGERS) {
      const line = text.split("\n").find((l) => l.startsWith(`- "${t.id}":`));
      expect(line, t.id).toBeTruthy();
      const keys = t.id.startsWith("record_")
        ? Array.from(new Set(RECORD_PAYLOAD_ENTITIES.flatMap((e) => payloadSchemaFor(t.id, e).map((f) => f.key))))
        : payloadSchemaFor(t.id, null).map((f) => f.key);
      for (const k of keys) expect(line!, `${t.id}.${k}`).toContain(k);
    }
    expect(text).toContain("status (text: new|working|qualified|unqualified|converted)");
    expect(text).toContain(`signal (text: ${SIGNAL_NAMES.join("|")})`);
  });

  it("aiFeatures uses it rather than a hand-written list", () => {
    const ai = read("server/routers/aiFeatures.ts");
    expect(ai).toContain("${describeTriggerPayloadsForPrompt()}");
    expect(ai).not.toContain("payload has stage/fromStage/value/winProb/isWon/isLost");
  });
});

/* ── 4 · the dry run ──────────────────────────────────────────────────── */

const snapshot = () => JSON.stringify(Object.fromEntries(
  ["leads", "contacts", "opportunities", "tasks", "notifications", "enrollments", "email_drafts", "workflow_runs", "workflow_rules", "activities"]
    .map((t) => [t, rows(t)]),
));

const richRule = {
  triggerType: "record_created",
  triggerConfig: { entity: "lead" },
  conditions: [{ field: "company", op: "contains", value: "acme" }],
  actions: [
    { type: "create_task", params: { title: "Call them", dueInDays: "2", ownerUserId: "" } },
    { type: "update_field", params: { field: "status", value: "working" } },
    { type: "enroll_sequence", params: { sequenceId: "501" } },
    { type: "send_email_draft", params: { tone: "warm", goal: "intro" } },
    { type: "notify_user", params: { userId: String(REP), message: "New lead" } },
    { type: "webhook", params: { url: "https://hooks.example.com/x" } },
  ],
};

describe("a dry run against a chosen record (F46)", () => {
  it("says, by name, what each action would do to the record, and changes and sends nothing", async () => {
    const before = snapshot();
    const out = await dryRunRuleAgainstRecord(h.db, WS, richRule, { recordType: "lead", recordId: 101 });
    expect(out.record).toEqual({ type: "lead", id: 101, label: "Ada Lane" });
    expect(out.wouldFire).toBe(true);
    expect(out.payload).toMatchObject({ entity: "lead", id: 101, ownerUserId: OWNER, company: "Acme Client", status: "new" });
    expect(out.conditions).toEqual([{ field: "company", label: "Company", op: "contains", value: "acme", actual: "Acme Client", pass: true }]);
    const text = out.steps.map((s) => s.text);
    expect(text[0]).toBe('Would create the task "Call them", due in 2 days, for Olu Owner, linked to this lead.');
    expect(text[1]).toBe('Would set lead status from "new" to "working".');
    expect(text[2]).toBe('Would enrol this lead in "Warm intro".');
    expect(text[3]).toBe("Would write an AI email draft to ada@acme-client.example for review. Nothing is sent without approval.");
    expect(text[4]).toBe('Would notify Ray Rep: "New lead".');
    expect(text[5]).toBe("Would POST this payload to hooks.example.com.");
    expect(snapshot()).toBe(before);
    expect(h.fetches).toBe(0);
    expect(h.llmCalls).toBe(0);
  });

  it("a condition that fails shows the record's real value, and the rule would not fire", async () => {
    const out = await dryRunRuleAgainstRecord(h.db, WS, { ...richRule, conditions: [{ field: "status", op: "eq", value: "qualified" }] }, { recordType: "lead", recordId: 101 });
    expect(out.wouldFire).toBe(false);
    expect(out.conditions[0]).toMatchObject({ label: "Lead status", actual: "new", pass: false });
    expect(out.notes).toContain("The rule would not fire for this record, so none of the steps would run.");
  });

  it("while outbound is paused, the enrolment step says it would be skipped", async () => {
    h.paused = true;
    const out = await dryRunRuleAgainstRecord(h.db, WS, richRule, { recordType: "lead", recordId: 101 });
    expect(out.steps[2]!).toEqual({ action: "enroll_sequence", ok: false, text: 'Would skip "Warm intro": outbound is paused for this workspace.' });
  });

  // Merged with SEC (G49) 2026-11-07: workspace mutations leave an automatic
  // audit entry; the dry run promises to log nothing, so it is on the skip list.
  it("the dry run leaves no automatic audit entry", () => {
    expect(autoAuditSkipped("workflows.dryRun")).toBe(true);
  });

  it("deal_stuck: the days gate is read off the deal", async () => {
    const out = await dryRunRuleAgainstRecord(h.db, WS, { triggerType: "deal_stuck", triggerConfig: { days: "7" }, conditions: [], actions: [{ type: "notify_user", params: { userId: "" } }] }, { recordType: "opportunity", recordId: 301 });
    expect(out.gates).toEqual([{ label: "Days in stage", pass: false, detail: '3 days in "negotiation"; the rule waits for 7.' }]);
    expect(out.wouldFire).toBe(false);
    // A blank person means the record's owner, as the editor says.
    expect(out.steps[0]!.text).toBe("Would notify Olu Owner.");
  });

  it("task_overdue: actions act on the record the task is about", async () => {
    const out = await dryRunRuleAgainstRecord(h.db, WS, { triggerType: "task_overdue", triggerConfig: {}, conditions: [{ field: "priority", op: "eq", value: "high" }], actions: [{ type: "update_field", params: { field: "status", value: "working" } }] }, { recordType: "task", recordId: 401 });
    expect(out.payload).toEqual(buildTaskOverduePayload({ id: 401, title: "Call Ada", type: "call", priority: "high", dueAt: rows("tasks")[0].dueAt }));
    expect(out.wouldFire).toBe(true);
    expect(out.steps[0]!.text).toBe('Would set lead status to "working".');
  });

  it("refuses a record of the wrong type, or one from another workspace", async () => {
    await expect(dryRunRuleAgainstRecord(h.db, WS, richRule, { recordType: "task", recordId: 401 })).rejects.toThrow(/not a task/);
    await expect(dryRunRuleAgainstRecord(h.db, WS, richRule, { recordType: "lead", recordId: 201 })).rejects.toThrow(/isn't in this workspace/);
  });

  it("which records each trigger is tried against", () => {
    expect(dryRunRecordTypesFor("record_created", undefined)).toEqual(["lead"]);
    expect(dryRunRecordTypesFor("record_updated", "any")).toEqual(["lead", "contact", "opportunity"]);
    expect(dryRunRecordTypesFor("deal_stuck", null)).toEqual(["opportunity"]);
    expect(dryRunRecordTypesFor("task_overdue", null)).toEqual(["task"]);
    expect(dryRunRecordTypesFor("schedule", null)).toEqual([]);
  });

  it("workflows.dryRun: a manager tries a draft or a saved rule; a rep can't; nothing is logged", async () => {
    const draft = { triggerType: "record_created" as const, triggerConfig: { entity: "lead" }, conditions: [], actions: [{ type: "create_task", params: { title: "x" } }] };
    const out = await caller(MGR).workflows.dryRun({ draft, recordType: "lead", recordId: 101 });
    expect(out.wouldFire).toBe(true);
    rows("workflow_rules").push({ id: 61, workspaceId: WS, name: "Saved", triggerType: "deal_stuck", triggerConfig: { days: 1 }, conditions: [], actions: [{ type: "create_task", params: { title: "Nudge" } }], enabled: false, fireCount: 0 });
    const saved = await caller(MGR).workflows.dryRun({ id: 61, recordType: "opportunity", recordId: 301 });
    expect(saved.wouldFire).toBe(true);
    expect((await refusal(caller(MGR).workflows.dryRun({ id: 61, recordType: "lead", recordId: 101 }))).code).toBe("BAD_REQUEST");
    expect((await refusal(caller(REP).workflows.dryRun({ draft, recordType: "lead", recordId: 101 }))).code).toBe("FORBIDDEN");
    expect(rows("workflow_runs")).toHaveLength(0);
    expect(rows("tasks")).toHaveLength(1);
  });
});

describe("the editor's names come from the workspace (F46, G71)", () => {
  it("editorOptions: people still here, sequences, stages (legacy keys with no pipeline) and campaigns", async () => {
    rows("are_campaigns").push({ id: 71, workspaceId: WS, name: "Q4 push", status: "active" }, { id: 72, workspaceId: OTHER, name: "Theirs", status: "active" });
    const o = await caller(REP).workflows.editorOptions();
    expect(o.users.map((u) => u.name)).toEqual(["Mia Manager", "Olu Owner", "Ray Rep"]);
    expect(o.sequences).toEqual([{ id: 501, name: "Warm intro", status: "active" }]);
    expect(o.stages.map((s) => s.key)).toEqual(["discovery", "qualified", "proposal", "negotiation", "won", "lost"]);
    expect(o.campaigns).toEqual([{ id: 71, name: "Q4 push" }]);
  });

  it("searchRecords finds this workspace's records by name, and resolves saved ids to names", async () => {
    rows("accounts").push({ id: 801, workspaceId: WS, name: "Acme Client Inc", domain: "acme-client.example" }, { id: 802, workspaceId: OTHER, name: "Acme Elsewhere", domain: "else.example" });
    expect((await caller(REP).workflows.searchRecords({ type: "lead", q: "Ada" })).map((r) => r.label)).toEqual(["Ada Lane"]);
    expect((await caller(REP).workflows.searchRecords({ type: "lead", q: "Ours" }))).toEqual([]);
    expect((await caller(REP).workflows.searchRecords({ type: "account", q: "Acme" })).map((r) => r.id)).toEqual([801]);
    expect((await caller(REP).workflows.searchRecords({ type: "account", ids: [801, 802] })).map((r) => r.label)).toEqual(["Acme Client Inc"]);
    expect((await caller(REP).workflows.searchRecords({ type: "opportunity" }))[0]).toEqual({ id: 301, label: "Big deal", sub: "negotiation" });
  });
});
