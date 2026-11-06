/**
 * Sequences in the Revenue Engine (audit 2026-10-20, batch E1).
 *
 *   A28 a campaign's skeleton is written once per tick, not once per prospect,
 *       and a prospect whose generation fails waits before it is tried again
 *       instead of taking the head of the page every tick
 *   A71 the skeleton offers only the channels dispatch will send: one reading
 *       of a null or partial channelsEnabled
 *   A13 rewriting not-started sequences commits only copy that breaks no avoid
 *       rule; held copy leaves the scheduled sends as they were
 *   A40 regenerating a sequence that is already scheduled is refused, since it
 *       would change nothing that sends
 *   A70 a step whose send state is unknown counts as sent when a prospect is
 *       enrolled again, so it is not minted a second time
 *
 * Against the SQL-evaluating fake, with the AI provider mocked by schema name.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return {
    db: null as any,
    calls: [] as { name: string; user: string }[],
    violations: [] as { rule: string; quote: string }[],
  };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./routers/are/notify", async (a) => ({ ...(await a<typeof import("./routers/are/notify")>()), areNotify: async () => {} }));
vi.mock("./services/research/avoidCheck", async (a) => ({
  ...(await a<typeof import("./services/research/avoidCheck")>()),
  checkBrief: async () => ({ checked: true, rules: 1, violations: h.violations, pains: [], leads: [], sectorId: null, personaId: null, matchedBy: null }),
}));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async (p: any) => {
    const name = p?.response_format?.json_schema?.name ?? "?";
    const user = String(p?.messages?.find((m: any) => m.role === "user")?.content ?? "");
    h.calls.push({ name, user });
    const reply = (o: unknown) => ({ choices: [{ message: { content: JSON.stringify(o) } }] });
    if (name === "campaign_template") {
      return reply({ steps: [0, 1].map((i) => ({ stepIndex: i, day: i * 3, channel: "email", archetype: "opener", skeleton: "Say hello", ctaPattern: "Ask" })) });
    }
    if (name === "personalized_sequence") {
      if (user.includes("Name: Fay Fails")) throw new Error("The model returned nonsense");
      return reply({ steps: [0, 1].map((i) => ({ stepIndex: i, day: i * 3, channel: "email", subject: `New subject ${i}`, body: `New body ${i}` })) });
    }
    if (name === "sequence_quality") return reply({ specificity: 8, clarity: 8, brevity: 8, cta: 8, totalScore: 32, feedback: "ok" });
    return reply({});
  },
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { runAreEngine, stepsAlreadySent, __resetEngineLogRepeatsForTests } from "./areEngine";
import { generateCampaignTemplate, REGENERATE_SCHEDULED_MESSAGE } from "./routers/are/prospects";
import { rewriteOneNotStarted } from "./services/are/rewriteNotStarted";
import { campaignChannelOn } from "@shared/areSequenceSteps";
import { DISPATCH_INTERRUPTED } from "./services/are/stepHold";
import { SEND_STATE_UNKNOWN } from "./emailDelivery";

const WS = 2;
const ADMIN = 20;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const find = (t: string, id: number) => rows(t).find((r) => r.id === id);
const templateCalls = () => h.calls.filter((c) => c.name === "campaign_template").length;
const caller = () => appRouter.createCaller({
  user: { id: ADMIN, openId: "u", email: "a@example.com", name: "A", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

function campaign(over: Record<string, unknown> = {}) {
  rows("are_campaigns").push({
    id: 7, workspaceId: WS, name: "Counties", status: "active", ownerUserId: ADMIN, autonomyMode: "batch_approval",
    channelsEnabled: { email: true, linkedin: false }, sequenceTemplate: "standard_7step", generatedTemplate: null,
    targetProspectCount: 0, dailySendCap: 50, stepGapDays: 3, prospectSources: [], icpOverrides: {}, discoveryQueryState: null,
    goalType: "reply", copyMode: "generated", ...over,
  });
}
function prospect(id: number, over: Record<string, unknown> = {}, intel: Record<string, unknown> = {}) {
  rows("prospect_queue").push({
    id, workspaceId: WS, campaignId: 7, firstName: "Pat", lastName: `P${id}`, email: `p${id}@example.com`, title: "Clerk",
    companyName: "Acme", sequenceStatus: "approved", enrichmentStatus: "complete", icpMatchScore: 80,
    sequenceAttempts: 0, sequenceRetryAt: null, ...over,
  });
  rows("prospect_intelligence").push({ id: 100 + id, prospectQueueId: id, workspaceId: WS, generatedSequence: null, copyHoldReason: null, painSignals: [], personalisationHooks: [], triggerEvents: [], ...intel });
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.calls = [];
  h.violations = [];
  __resetEngineLogRepeatsForTests();
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  rows("workspace_settings").push({ workspaceId: WS, timezone: "UTC" });
});

describe("sequence generation in a tick (A28)", () => {
  it("writes the campaign's skeleton once for the three prospects it generates", async () => {
    campaign();
    prospect(1); prospect(2); prospect(3);
    await runAreEngine({ workspaceId: WS });
    expect(templateCalls()).toBe(1);
    expect([1, 2, 3].map((id) => Array.isArray(find("prospect_intelligence", 100 + id).generatedSequence))).toEqual([true, true, true]);
  });

  it("a prospect whose generation fails waits, so the one behind it gets the slot", async () => {
    campaign({ generatedTemplate: { steps: [0, 1].map((i) => ({ stepIndex: i, day: i * 3, channel: "email", archetype: "opener", skeleton: "s", ctaPattern: "c" })) } });
    prospect(1, { firstName: "Fay", lastName: "Fails" });
    prospect(2); prospect(3); prospect(4);
    await runAreEngine({ workspaceId: WS });
    const fay = find("prospect_queue", 1);
    expect(fay.sequenceAttempts).toBe(1);
    expect(new Date(fay.sequenceRetryAt).getTime()).toBeGreaterThan(Date.now());
    expect(find("prospect_intelligence", 104).generatedSequence).toBeNull();

    await runAreEngine({ workspaceId: WS });
    // Fay is resting; prospect 4 had its turn.
    expect(Array.isArray(find("prospect_intelligence", 104).generatedSequence)).toBe(true);
    expect(h.calls.filter((c) => c.name === "personalized_sequence" && c.user.includes("Name: Fay Fails"))).toHaveLength(1);
  });
});

describe("the channels a skeleton may use (A71)", () => {
  const offered = () => {
    const user = h.calls.find((c) => c.name === "campaign_template")!.user;
    return JSON.parse(user.match(/## Channels enabled\n(\[[^\n]*\])/)![1]);
  };
  it.each([
    ["null", null, ["email"]],
    ["email only, no LinkedIn key", { email: true }, ["email"]],
    ["LinkedIn ticked", { email: true, linkedin: true }, ["email", "linkedin"]],
    ["LinkedIn unticked", { email: true, linkedin: false }, ["email"]],
  ])("%s offers what dispatch sends", async (_n, channelsEnabled, want) => {
    campaign({ channelsEnabled });
    await generateCampaignTemplate(find("are_campaigns", 7), true);
    expect(offered()).toEqual(want);
    // And dispatch reads the same switches the same way.
    for (const ch of ["email", "linkedin"]) expect(campaignChannelOn(channelsEnabled, ch)).toBe(want.includes(ch));
  });
});

describe("rewriting not-started sequences (A13)", () => {
  beforeEach(() => {
    campaign({ generatedTemplate: { steps: [0, 1].map((i) => ({ stepIndex: i, day: i * 3, channel: "email", archetype: "opener", skeleton: "s", ctaPattern: "c" })) } });
    const old = [0, 1].map((i) => ({ stepIndex: i, day: i * 3, channel: "email", subject: `Old subject ${i}`, body: `Old body ${i}`, variantKey: "A" }));
    prospect(1, { sequenceStatus: "enrolled" }, { generatedSequence: old });
    for (const i of [0, 1]) {
      rows("are_execution_queue").push({ id: 50 + i, workspaceId: WS, campaignId: 7, prospectQueueId: 1, stepIndex: i, channel: "email", status: "scheduled", scheduledAt: new Date(Date.now() + (i + 1) * 86_400_000), messageContent: { subject: `Old subject ${i}`, body: `Old body ${i}`, variantKey: "A" } });
    }
  });

  it("copy that breaks an avoid rule is not written into the scheduled sends, nor saved", async () => {
    h.violations = [{ rule: "Never promise savings", quote: "save 40%" }];
    expect(await rewriteOneNotStarted(WS, { prospectQueueId: 1, campaignId: 7 })).toBe("held");
    expect([50, 51].map((id) => find("are_execution_queue", id).messageContent.subject)).toEqual(["Old subject 0", "Old subject 1"]);
    expect(find("prospect_intelligence", 101).generatedSequence[0].subject).toBe("Old subject 0");
    expect(find("prospect_intelligence", 101).copyHoldReason).toBeNull();
  });

  it("clean copy still replaces the scheduled sends", async () => {
    expect(await rewriteOneNotStarted(WS, { prospectQueueId: 1, campaignId: 7 })).toBe("rewritten");
    expect([50, 51].map((id) => find("are_execution_queue", id).messageContent.subject)).toEqual(["New subject 0", "New subject 1"]);
  });
});

describe("regenerating a scheduled sequence (A40)", () => {
  beforeEach(() => {
    campaign({ generatedTemplate: { steps: [0, 1].map((i) => ({ stepIndex: i, day: i * 3, channel: "email", archetype: "opener", skeleton: "s", ctaPattern: "c" })) } });
    prospect(1, { sequenceStatus: "enrolled" }, { generatedSequence: [{ stepIndex: 0, channel: "email", subject: "Old", body: "Old" }] });
  });

  it.each([["scheduled"], ["paused"]])("is refused while a step is %s, and nothing is written", async (status) => {
    rows("are_execution_queue").push({ id: 50, workspaceId: WS, campaignId: 7, prospectQueueId: 1, stepIndex: 0, channel: "email", status, scheduledAt: new Date(), messageContent: { subject: "Old", body: "Old" } });
    await expect(caller().are.prospects.generateSequence({ prospectId: 1, campaignId: 7, force: true })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: REGENERATE_SCHEDULED_MESSAGE });
    expect(h.calls).toHaveLength(0);
    expect(find("prospect_intelligence", 101).generatedSequence[0].subject).toBe("Old");
  });

  it("goes ahead once nothing is left to send", async () => {
    rows("are_execution_queue").push({ id: 50, workspaceId: WS, campaignId: 7, prospectQueueId: 1, stepIndex: 0, channel: "email", status: "skipped", scheduledAt: new Date(), messageContent: {} });
    const r = await caller().are.prospects.generateSequence({ prospectId: 1, campaignId: 7, force: true });
    expect(r.reused).toBe(false);
    expect(find("prospect_intelligence", 101).generatedSequence[0].subject).toBe("New subject 0");
  });
});

describe("re-enrolment and a step whose send state is unknown (A70)", () => {
  it("counts it as sent, alongside the sent ones, and nothing else", async () => {
    const at = new Date("2026-11-01T15:00:00Z");
    const s = (id: number, stepIndex: number, status: string, failureReason: string | null) =>
      rows("are_execution_queue").push({ id, workspaceId: WS, campaignId: 7, prospectQueueId: 1, stepIndex, channel: "email", status, failureReason, executedAt: at, scheduledAt: at });
    s(1, 0, "sent", null);
    s(2, 1, "failed", DISPATCH_INTERRUPTED);
    s(3, 2, "failed", `${SEND_STATE_UNKNOWN}: socket hang up`);
    s(4, 3, "failed", "Pool send failed: TLS handshake");
    s(5, 4, "skipped", "Prospect no longer enrolled");
    s(6, 5, "scheduled", null);
    rows("are_execution_queue").push({ id: 7, workspaceId: 4, campaignId: 9, prospectQueueId: 1, stepIndex: 6, channel: "email", status: "sent", executedAt: at, scheduledAt: at });
    const got = await stepsAlreadySent(h.db, WS, 1);
    expect(got.map((r) => r.stepIndex).sort()).toEqual([0, 1, 2]);
  });

  it("the enrolment pass resumes from that read", () => {
    // Enrolment's own page uses JSON SQL the fake can't run, so its wiring is read.
    const engine = readFileSync(join(__dirname, "areEngine.ts"), "utf8").replace(/\r\n/g, "\n");
    const enrol = engine.slice(engine.indexOf("async function enrollApprovedForCampaignUnlocked"), engine.indexOf("async function tickCampaign"));
    expect(enrol).toContain("const priorSends = await stepsAlreadySent(db, wsId, row.id);");
    expect(enrol).toContain("const sentIdx = new Set(priorSends.map((r) => r.stepIndex));");
  });
});
