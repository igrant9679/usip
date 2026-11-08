/**
 * Workflow rules do what their editor says (audit 2026-10-20, G61).
 *
 *   - "equals" compared with ===, and the editor stores what the user typed as
 *     a string, so "value equals 50000" never matched a deal worth 50000;
 *   - the editor offered one list of fields for every trigger, most of which the
 *     event never carries;
 *   - "deal is stuck" re-ran its actions for every stuck deal every night, so a
 *     create-task rule added a task per stuck deal per night;
 *   - a new rule, and every applied AI suggestion, went live at once, the new
 *     rule with a placeholder "Follow up" task and no conditions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { checkDealAging } from "./routers/operations";
import { evalConditions, executeRuleActions } from "./services/workflowEngine";
import { invalidateSendWindowCache } from "./services/sendWindow";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { conditionFieldsFor, LIVE_TRIGGER_IDS, TRIGGER_FIELDS } from "@shared/workflowTriggers";

const WS = 2;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const DAY = 86_400_000;

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  invalidateStageIndex();
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("users").push({ id: 1, name: "Me" });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: 1, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
});

describe("equals on a number (G61)", () => {
  const rule = (op: string, value: unknown) => ({ all: [{ field: "value", op, value }] });
  it("a typed number equals the payload's number", () => {
    expect(evalConditions(rule("eq", "50000"), { value: 50000 })).toBe(true);
    expect(evalConditions(rule("eq", " 50000 "), { value: 50000 })).toBe(true);
    expect(evalConditions(rule("neq", "50000"), { value: 50000 })).toBe(false);
    expect(evalConditions(rule("eq", "50001"), { value: 50000 })).toBe(false);
  });
  it("an empty value is not zero, and a missing field equals nothing", () => {
    expect(evalConditions(rule("eq", ""), { value: 0 })).toBe(false);
    expect(evalConditions(rule("eq", "0"), {})).toBe(false);
  });
  it("a boolean compares as one; strings stay exact", () => {
    expect(evalConditions({ all: [{ field: "isWon", op: "eq", value: "true" }] }, { isWon: true })).toBe(true);
    expect(evalConditions({ all: [{ field: "isWon", op: "eq", value: "false" }] }, { isWon: true })).toBe(false);
    expect(evalConditions({ all: [{ field: "stage", op: "eq", value: "proposal" }] }, { stage: "proposal" })).toBe(true);
    expect(evalConditions({ all: [{ field: "stage", op: "eq", value: "Proposal" }] }, { stage: "proposal" })).toBe(false);
  });
});

describe("each trigger offers the fields its event carries (G61)", () => {
  const sites: Record<string, string[]> = {
    stage_changed: ["server/services/workflowEngine.ts"],
    // 2026-11-07 (F46): both deal_stuck sites in operations.ts now build their
    // payload with buildDealStuckPayload in workflowEngine.ts, which the dry
    // run shares. The keys are checked where they are set.
    deal_stuck: ["server/routers/operations.ts", "server/services/workflowEngine.ts"],
    task_overdue: ["server/services/workflowEngine.ts"],
    signal_received: [
      "server/services/linkedinEnrichment/jobChangeReengagement.ts",
      "server/services/company/brandReconciler.ts",
      "server/routers/are/execution.ts",
    ],
  };
  it("every non-record trigger has a list", () => {
    for (const t of LIVE_TRIGGER_IDS) {
      if (t === "record_created" || t === "record_updated") continue;
      expect(TRIGGER_FIELDS[t], t).toBeDefined();
      expect(conditionFieldsFor(t, null)).toEqual([...TRIGGER_FIELDS[t]!]);
    }
  });
  it("every offered key is set at its trigger's dispatch site", () => {
    for (const [t, files] of Object.entries(sites)) {
      const src = files.map(read).join("\n");
      for (const f of TRIGGER_FIELDS[t]!) {
        expect(new RegExp(`(\\b${f}\\??:|payload\\.${f} =)`).test(src), `${t}.${f}`).toBe(true);
      }
    }
  });
  it("the editor takes them from there, not from one shared list", () => {
    const s = read("client/src/pages/usip/Workflows.tsx");
    expect(s).toContain("const fieldOptions = conditionFieldsFor(trigger, entity);");
    expect(s).not.toMatch(/const FIELDS = \[/);
  });
});

describe('"deal is stuck" fires once per stay in a stage (G61)', () => {
  beforeEach(() => {
    rows("workflow_rules").push({
      id: 30, workspaceId: WS, name: "Nudge stuck deals", enabled: true, triggerType: "deal_stuck",
      triggerConfig: { days: 7 }, conditions: [], actions: [{ type: "create_task", params: { title: "Nudge" } }], fireCount: 0,
    });
    rows("opportunities").push(
      { id: 1, workspaceId: WS, accountId: 1, name: "Stuck", stage: "proposal", value: 1000, winProb: 40, ownerUserId: 1, daysInStage: 10, stageEnteredAt: new Date(Date.now() - 10 * DAY) },
      { id: 2, workspaceId: WS, accountId: 1, name: "Moving", stage: "proposal", value: 1000, winProb: 40, ownerUserId: 1, daysInStage: 2, stageEnteredAt: new Date(Date.now() - 2 * DAY) },
    );
  });
  const nudges = () => rows("tasks").filter((t) => t.title === "Nudge");

  it("the second night adds nothing for a deal it already flagged", async () => {
    await checkDealAging();
    expect(nudges().map((t) => t.relatedId)).toEqual([1]);
    await checkDealAging();
    await checkDealAging();
    expect(nudges()).toHaveLength(1);
  });

  it("the manual check agrees with the nightly one", async () => {
    await checkDealAging();
    const out = await caller().workflows.checkDealAging({});
    expect(out.fired).toBe(0);
    expect(nudges()).toHaveLength(1);
  });

  it("a deal that moves on and gets stuck again is flagged again", async () => {
    await checkDealAging();
    const deal = rows("opportunities").find((o) => o.id === 1);
    // Ran a day ago, then moved stage today and has sat there past the threshold
    // by the time of the next check (simulated by back-dating the first run).
    rows("workflow_runs").forEach((r) => { r.runAt = new Date(Date.now() - 20 * DAY); });
    deal.stage = "negotiation";
    deal.stageEnteredAt = new Date(Date.now() - 8 * DAY);
    deal.daysInStage = 8;
    await checkDealAging();
    expect(nudges()).toHaveLength(2);
  });

  it("with no stageEnteredAt, the stay is read off daysInStage", async () => {
    const deal = rows("opportunities").find((o) => o.id === 1);
    deal.stageEnteredAt = null;
    await checkDealAging();
    await checkDealAging();
    expect(nudges()).toHaveLength(1);
  });
});

describe("a new rule starts switched off (G61)", () => {
  it("workflows.create defaults to off", async () => {
    const { id } = await caller().workflows.create({
      name: "R", triggerType: "stage_changed", triggerConfig: {}, conditions: [],
      actions: [{ type: "create_task", params: { title: "Follow up" } }],
    });
    expect(rows("workflow_rules").find((r) => r.id === id).enabled).toBe(false);
  });

  it("the New rule dialog sends off, and an applied AI suggestion is created off", () => {
    const page = read("client/src/pages/usip/Workflows.tsx");
    const create = page.slice(page.indexOf("create.mutate({"), page.indexOf("<Field name=\"name\""));
    expect(create).toContain("enabled: false,");
    expect(create).not.toContain("enabled: true");
    const ai = read("server/routers/aiFeatures.ts");
    const apply = ai.slice(ai.indexOf("db.insert(workflowRules).values({"), ai.indexOf("}).$returningId();", ai.indexOf("db.insert(workflowRules).values({")));
    expect(apply).toContain("enabled: false,");
  });
});

describe("a rule enrols nobody while outbound is paused (2026-11-06)", () => {
  const enrolRule = { id: 9, name: "Enrol", actions: [{ type: "enroll_sequence", params: { sequenceId: 5 } }] };
  const ctx = { relatedType: "contact", relatedId: 7 } as never;
  beforeEach(() => {
    invalidateSendWindowCache();
    rows("sequences").push({ id: 5, workspaceId: WS, name: "S", status: "active" });
  });

  it("a paused workspace gets no enrolment, and the run says why", async () => {
    rows("workspace_settings").push({ workspaceId: WS, timezone: "UTC", outboundPausedAt: new Date() });
    const errors = await executeRuleActions(WS, enrolRule, ctx);
    expect(rows("enrollments")).toHaveLength(0);
    expect(errors).toEqual(["enroll_sequence: skipped, outbound is paused for this workspace"]);
  });

  it("a live workspace still enrols", async () => {
    rows("workspace_settings").push({ workspaceId: WS, timezone: "UTC", outboundPausedAt: null });
    expect(await executeRuleActions(WS, enrolRule, ctx)).toEqual([]);
    expect(rows("enrollments").map((e) => [e.sequenceId, e.contactId, e.status])).toEqual([[5, 7, "active"]]);
  });
});
