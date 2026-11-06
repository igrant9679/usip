/**
 * Batch S1b (audit 2026-10-20), G19: workflow webhooks and test runs.
 *
 *   - A webhook carries only Authorization and custom X- headers from the
 *     rule, and the rule can't replace Content-Type. (Where it may go is the
 *     SSRF guard's job, already closed: services/scraper/ssrfGuard.ts.)
 *   - Test runs nothing, and is a manager's.
 *   - An AI suggestion becomes a rule that is switched off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, fetched: [] as Array<{ url: string; init: any }> }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./services/scraper/ssrfGuard", async (a) => ({
  ...(await a<typeof import("./services/scraper/ssrfGuard")>()),
  safeFetch: async (url: string, init: any) => { h.fetched.push({ url, init }); return new Response("ok", { status: 200 }); },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { executeRuleActions } from "./services/workflowEngine";
import { safeWebhookHeaders } from "./services/webhookHeaders";
import { describeRuleActions } from "./services/workflowDryRun";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
function caller(role: string) {
  h.db.roles[WS] = role;
  return appRouter.createCaller({
    user: { id: 1, openId: "o1", email: "m@lsi.example", name: "M", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

const RULE_ACTIONS = [
  { type: "webhook", params: { url: "https://hooks.example.com/in", headers: { Authorization: "Bearer s3cret", Host: "internal.svc", "Content-Type": "text/plain", "X-Forwarded-For": "10.0.0.1", Cookie: "a=b", "X-Api-Key": "k1", "X-Evil": "a\r\nInjected: 1" } } },
  { type: "create_task", params: { title: "Call them" } },
  { type: "notify_user", params: { userId: 1, title: "Heads up" } },
  { type: "post_slack", params: { message: "hi" } },
];

beforeEach(() => {
  const roles: Record<number, string> = { [WS]: "manager" };
  h.db = Object.assign(makeSqlFakeDb({ roles, wsId: () => WS }), { roles });
  h.fetched = [];
  rows("workspace_settings").push({ id: 1, workspaceId: WS, slackWebhookUrl: "https://hooks.slack.example/T1", teamsWebhookUrl: null });
  rows("workflow_rules").push({
    id: 9, workspaceId: WS, name: "Hot lead", description: null, enabled: true, triggerType: "record_created",
    triggerConfig: { entity: "lead" }, conditions: [], actions: RULE_ACTIONS, fireCount: 3, lastFiredAt: null,
  });
});

describe("G19: what a webhook may carry", () => {
  it("only Authorization and custom X- headers pass, without line breaks", () => {
    expect(safeWebhookHeaders(RULE_ACTIONS[0].params.headers)).toEqual({ authorization: "Bearer s3cret", "x-api-key": "k1" });
    expect(safeWebhookHeaders(null)).toEqual({});
    expect(safeWebhookHeaders(["Authorization", "x"])).toEqual({});
    expect(safeWebhookHeaders({ "X-Real-IP": "1.2.3.4", "X-Workspace-Id": "4", "x-ok": 7 })).toEqual({ "x-ok": "7" });
  });

  it("the engine's webhook sends those and its own Content-Type", async () => {
    await executeRuleActions(WS, { id: 9, name: "Hot lead", actions: [RULE_ACTIONS[0]] }, { payload: { email: "a@b.example" }, relatedType: "lead", relatedId: 5, ownerUserId: 1 });
    expect(h.fetched).toHaveLength(1);
    expect(h.fetched[0].url).toBe("https://hooks.example.com/in");
    expect(h.fetched[0].init.headers).toEqual({ authorization: "Bearer s3cret", "x-api-key": "k1", "Content-Type": "application/json" });
    expect(h.fetched[0].init.maxRedirects).toBe(0);
  });
});

describe("G19: Test runs nothing", () => {
  it("no webhook, no Slack post, no task, no notification, not counted as a fire; it says what would happen", async () => {
    const out = await caller("manager").workflows.testFire({ id: 9 });
    expect(h.fetched).toHaveLength(0);
    expect(rows("tasks")).toHaveLength(0);
    expect(rows("notifications")).toHaveLength(0);
    const rule = rows("workflow_rules")[0];
    expect([rule.fireCount, rule.lastFiredAt]).toEqual([3, null]);
    expect(out).toMatchObject({ ok: true, dryRun: true, errors: [] });
    expect(out.plan).toEqual([
      "Would POST the event to hooks.example.com",
      'Would create a task "Call them"',
      "Would notify user 1",
      "Would post a message to Slack",
    ]);
    const [run] = rows("workflow_runs");
    expect(run).toMatchObject({ ruleId: 9, triggeredBy: "test (nothing was run)", status: "skipped", errorMessage: null });
  });

  it("what can't run is said, and recorded as failed", async () => {
    rows("workflow_rules")[0].actions = [{ type: "notify_teams", params: {} }, { type: "webhook", params: { url: "ftp://x" } }, { type: "launch_rocket", params: {} }];
    const out = await caller("manager").workflows.testFire({ id: 9 });
    expect(out.errors).toEqual([
      "notify_teams: no Teams webhook configured",
      'webhook: "ftp://x" is not an http(s) URL',
      'unsupported action type "launch_rocket"',
    ]);
    expect(rows("workflow_runs")[0].status).toBe("failed");
  });

  it("a rep can't run it", async () => {
    expect((await refusal(caller("rep").workflows.testFire({ id: 9 }))).code).toBe("FORBIDDEN");
    expect(rows("workflow_runs")).toHaveLength(0);
  });

  it("the describer covers every action the engine runs", () => {
    const types = ["webhook", "post_slack", "notify_teams", "create_task", "notify", "notify_user", "enroll_sequence", "update_field", "send_email_draft"];
    const out = describeRuleActions(types.map((type) => ({ type, params: { url: "https://x.example", sequenceId: 1, field: "status", title: "t" } })), { slackWebhookUrl: "s", teamsWebhookUrl: "t" });
    expect(out.problems).toEqual([]);
    expect(out.plan).toHaveLength(types.length);
  });
});

describe("G19: an AI suggestion becomes a rule that is switched off", () => {
  it("Add creates it disabled", async () => {
    rows("ai_workflow_suggestions").push({
      id: 4, workspaceId: WS, title: "Post leads to a URL", description: "d", triggerType: "record_created", triggerConfig: {},
      conditions: [], actions: [{ type: "webhook", params: { url: "https://invented.example/hook" } }], dismissed: false, appliedRuleId: null,
    });
    const { ruleId } = await caller("admin").workflowsAi.applySuggestion({ id: 4 });
    const rule = rows("workflow_rules").find((r) => r.id === ruleId);
    expect(rule.enabled).toBe(false);
    expect(rows("ai_workflow_suggestions")[0].appliedRuleId).toBe(ruleId);
  });
});
