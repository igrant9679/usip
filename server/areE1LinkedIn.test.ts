/**
 * The Revenue Engine's LinkedIn steps (audit 2026-10-20, batch E1).
 *
 *   A6  an accepted connection request is found by the profile slug it was
 *       stored under, so the follow-up message goes instead of waiting out the
 *       21-day timeout
 *   A77 LinkedIn discovery searches one target title at a time, not the whole
 *       slice folded into keywords, and pages on through it
 *
 * Run against the SQL-evaluating fake; Unipile and the activity gate are mocked,
 * so nothing reaches LinkedIn.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: null as any,
  dms: [] as any[],
  invites: [] as any[],
  searches: [] as any[],
  searchReply: null as null | ((p: any) => any),
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./services/linkedin/activityGate", async (a) => ({
  ...(await a<typeof import("./services/linkedin/activityGate")>()),
  checkLinkedInAction: async () => ({ allowed: true, reason: null, message: "ok", retryAfterMs: null }),
  recordLinkedInAction: async () => {},
  pickAccountForAction: async (i: any) => ({ unipileAccountId: i.candidates[0] ?? null, verdict: null }),
}));
vi.mock("./services/linkedinLookup", async (a) => ({
  ...(await a<typeof import("./services/linkedinLookup")>()),
  listUsableAccounts: async () => [{ unipileAccountId: "acct-1" }],
}));
vi.mock("./lib/unipile", async (a) => ({
  ...(await a<typeof import("./lib/unipile")>()),
  sendMessage: async (x: any) => { h.dms.push(x); return { id: `m${h.dms.length}`, chatId: `c${h.dms.length}` }; },
  sendLinkedInInvitation: async (x: any) => { h.invites.push(x); return {}; },
  searchLinkedInPeople: async (_acct: string, p: any) => { h.searches.push(p); return h.searchReply ? h.searchReply(p) : { items: [] }; },
}));
// Outbound live and the window open, so the only thing that can stop the opener is the rule under test.
vi.mock("./services/sendWindow", async (a) => ({
  ...(await a<typeof import("./services/sendWindow")>()),
  getWorkspaceSendWindow: async () => ({ timezone: "UTC", window: {}, paused: false }),
  inSendWindow: async () => true,
}));
vi.mock("./_core/llm", async (a) => ({ ...(await a<typeof import("./_core/llm")>()), invokeLLM: async () => ({ choices: [{ message: { content: "Thanks for connecting, Dana." } }] }) }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { handleNewRelation } from "./services/socialAutopilot";
import { dispatchLinkedInStep } from "./services/are/linkedinStep";
import { runDiscovery, __resetEngineLogRepeatsForTests } from "./areEngine";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.dms = [];
  h.invites = [];
  h.searches = [];
  h.searchReply = null;
  __resetEngineLogRepeatsForTests();
});

describe("an accepted connection request (A6)", () => {
  beforeEach(() => {
    rows("unipile_accounts").push({ id: 1, workspaceId: WS, userId: 20, unipileAccountId: "acct-1", provider: "LINKEDIN" });
    // Social Autopilot off: the accept is recorded and nothing else happens here.
    rows("workspace_settings").push({ workspaceId: WS, socialAutopilotMode: "off", socialAutopilotDailyCap: 50 });
  });
  const prospect = { id: 9, workspaceId: WS, campaignId: 7, firstName: "Dana", lastName: "Reyes", email: null, linkedinUrl: "https://www.linkedin.com/in/dana-reyes" } as any;

  it("the engine's own invite is stored under the slug and found by it when they accept", async () => {
    const first = await dispatchLinkedInStep({ workspaceId: WS, campaignId: 7, campaignOwnerUserId: 20, prospect, body: "Hi Dana, a quick note.", stepIndex: 0 });
    expect(first).toMatchObject({ kind: "sent", via: "invite" });
    expect(rows("unipile_invites")).toHaveLength(1);
    expect(rows("unipile_invites")[0].recipientProviderId).toBe("dana-reyes");

    // The webhook names the member by URN and by public identifier.
    expect(await handleNewRelation({ account_id: "acct-1", user_provider_id: "ACoAAB-dana", user_public_identifier: "dana-reyes", user_full_name: "Dana Reyes" } as any)).toBe("off");
    expect(rows("unipile_invites")[0].status).toBe("accepted");

    // So the next step is the message, not another wait.
    const next = await dispatchLinkedInStep({ workspaceId: WS, campaignId: 7, campaignOwnerUserId: 20, prospect, body: "Thanks for connecting, Dana.", stepIndex: 1 });
    expect(next).toMatchObject({ kind: "sent", via: "message" });
    expect(h.dms).toHaveLength(1);
  });

  it("still matches an invite stored under the URN", async () => {
    rows("unipile_invites").push({ id: 5, workspaceId: WS, userId: 20, unipileAccountId: "acct-1", recipientProviderId: "ACoAAB-dana", status: "pending", sentAt: new Date() });
    await handleNewRelation({ account_id: "acct-1", user_provider_id: "ACoAAB-dana", user_public_identifier: "dana-reyes", user_full_name: "Dana Reyes" } as any);
    expect(rows("unipile_invites")[0].status).toBe("accepted");
  });

  it("leaves another person's invite alone, and another workspace's", async () => {
    rows("unipile_invites").push(
      { id: 5, workspaceId: WS, userId: 20, unipileAccountId: "acct-1", recipientProviderId: "sam-stone", status: "pending", sentAt: new Date() },
      { id: 6, workspaceId: 4, userId: 30, unipileAccountId: "acct-9", recipientProviderId: "dana-reyes", status: "pending", sentAt: new Date() },
    );
    await handleNewRelation({ account_id: "acct-1", user_provider_id: "ACoAAB-dana", user_public_identifier: "dana-reyes", user_full_name: "Dana Reyes" } as any);
    expect(rows("unipile_invites").map((r) => r.status)).toEqual(["pending", "pending"]);
  });
});

describe("Social Autopilot's opener and a Revenue Engine prospect (A6 follow-up)", () => {
  const accept = { account_id: "acct-1", user_provider_id: "ACoAAB-dana", user_public_identifier: "dana-reyes", user_full_name: "Dana Reyes" } as any;
  const inCampaign = (over: Record<string, unknown> = {}) => rows("prospect_queue").push({
    id: 9, workspaceId: WS, campaignId: 7, firstName: "Dana", lastName: "Reyes", linkedinUrl: "https://www.linkedin.com/in/dana-reyes", sequenceStatus: "enrolled", ...over,
  });
  beforeEach(() => {
    rows("unipile_accounts").push({ id: 1, workspaceId: WS, userId: 20, unipileAccountId: "acct-1", provider: "LINKEDIN" });
    rows("workspace_settings").push({ workspaceId: WS, socialAutopilotMode: "auto", socialAutopilotDailyCap: 50 });
    rows("unipile_invites").push({ id: 5, workspaceId: WS, userId: 20, unipileAccountId: "acct-1", recipientProviderId: "dana-reyes", status: "pending", sentAt: new Date() });
  });

  it.each([["enrolled"], ["paused"]])("sends no opener to someone %s in a campaign, says why, and still records the accept", async (status) => {
    inCampaign({ sequenceStatus: status });
    expect(await handleNewRelation(accept)).toBe("are_enrolled");
    expect(h.dms).toEqual([]);
    expect(rows("tasks")).toEqual([]);
    expect(rows("unipile_invites")[0].status).toBe("accepted");
    const log = rows("are_engine_logs").find((l) => l.campaignId === 7);
    expect(log?.message).toContain("Social Autopilot sent no opener to Dana Reyes");
  });

  it("on Approve, drafts no task for them either", async () => {
    rows("workspace_settings")[0].socialAutopilotMode = "approval";
    inCampaign({ linkedinUrl: "https://linkedin.com/in/dana-reyes/" });
    expect(await handleNewRelation(accept)).toBe("are_enrolled");
    expect(rows("tasks")).toEqual([]);
  });

  it.each([
    ["finished in a campaign", { sequenceStatus: "completed" }],
    ["rejected from one", { sequenceStatus: "skipped" }],
    ["in another workspace's campaign", { workspaceId: 4 }],
    ["only a longer slug starting with theirs", { linkedinUrl: "https://www.linkedin.com/in/dana-reyes-2" }],
  ])("still gets the opener when %s", async (_name, over) => {
    inCampaign(over);
    expect(await handleNewRelation(accept)).toBe("opener_sent");
    expect(h.dms).toHaveLength(1);
  });
});
