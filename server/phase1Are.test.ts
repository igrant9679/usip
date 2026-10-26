/**
 * Phase 1 of the 2026-10-20 audit — the Revenue Engine (ARE) half.
 *
 * The audit's gate, for campaigns: reply → stop, resume → spaced steps,
 * pause → held, a double tick → one send, a suppressed person → no send;
 * and the ARE items behind them (A1–A5, A8, A30, A31) plus the LinkedIn gate
 * on every remaining path (O11).
 *
 * The parts are run for real against __fakes__/sqlFakeDb: processSignal, the
 * prospect procedures, the step hold/release rules, the dispatch claim, the
 * pool send, the LinkedIn step, discovery's queue writer. The dispatch LOOP in
 * areEngine.tickCampaign runs raw SQL the fake does not evaluate (JSON_TYPE,
 * NOT EXISTS, LIKE) — as every other ARE engine test notes, it needs a live
 * database — so its wiring of those parts is pinned from source, and each pin
 * was mutation-checked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  llm: null as null | (() => Promise<any>),
  llmCalls: 0,
  sends: [] as any[],
  transport: null as null | ((input: any) => Promise<{ messageId?: string }>),
  gate: { allowed: true, reason: null, message: "ok", retryAfterMs: null } as any,
  gateChecks: [] as any[],
  recorded: [] as any[],
  dms: [] as any[],
  invites: [] as any[],
  reactions: [] as any[],
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async () => { h.llmCalls++; return h.llm ? h.llm() : { choices: [{ message: { content: "{}" } }] }; },
}));
vi.mock("./routers/are/notify", async (a) => ({ ...(await a<typeof import("./routers/are/notify")>()), areNotify: async () => {} }));
vi.mock("./routers/are/signalEnhancement", () => ({ runSignalEnhancement: async () => {} }));
vi.mock("./emailAdapter", async (a) => ({
  ...(await a<typeof import("./emailAdapter")>()),
  createEmailAdapter: () => ({ sendEmail: (input: any) => h.transport!(input) }),
}));
vi.mock("./sendLimits", async (a) => ({
  ...(await a<typeof import("./sendLimits")>()),
  accountsSentToday: async () => new Map<number, number>(),
  getAccountSentLastHour: async () => 0,
}));
vi.mock("./services/linkedin/activityGate", async (a) => ({
  ...(await a<typeof import("./services/linkedin/activityGate")>()),
  checkLinkedInAction: async (i: any) => { h.gateChecks.push(i); return h.gate; },
  recordLinkedInAction: async (i: any) => { h.recorded.push(i); },
}));
vi.mock("./lib/unipile", async (a) => ({
  ...(await a<typeof import("./lib/unipile")>()),
  sendMessage: async (x: any) => { h.dms.push(x); return { id: `m${h.dms.length}`, chatId: `c${h.dms.length}` }; },
  sendLinkedInInvitation: async (x: any) => { h.invites.push(x); return {}; },
  reactToPost: async (...x: any[]) => { h.reactions.push(x); return {}; },
  commentOnPost: async (...x: any[]) => { h.reactions.push(x); return { id: "cm1" }; },
}));
vi.mock("./services/outboundPause", async (a) => ({
  ...(await a<typeof import("./services/outboundPause")>()),
  assertOutboundNotPaused: async () => {},
}));
vi.mock("./services/crossEngineEnrollment", async (a) => ({
  ...(await a<typeof import("./services/crossEngineEnrollment")>()),
  activeSequencesForProspects: async () => new Map(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { processSignal } from "./routers/are/execution";
import {
  HELD_PAUSED,
  HELD_REPLIED,
  claimStepForDispatch,
  releaseProspectSteps,
  respaced,
  respaceOverdueSteps,
  resumeAreProspectAfterAutoReply,
} from "./services/are/stepHold";
import { sendCampaignEmailViaPool, SEND_STATE_UNKNOWN } from "./emailDelivery";
import { dispatchLinkedInStep, INVITE_ACCEPT_TIMEOUT_DAYS } from "./services/are/linkedinStep";
import { saveScrapeJobAndQueue } from "./routers/are/scraper";
import { pushPeopleIntoCampaign } from "./services/are/pushPeople";
import { startOfLocalDay } from "./services/workspaceTimezone";

const LSI = 2;
const ADMIN = 20;
const REP = 21;
const DAY = 86_400_000;
const T0 = new Date("2026-10-27T15:00:00Z").getTime();

const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
const setNow = (ms: number) => vi.setSystemTime(new Date(ms));
const steps = (pq: number) => rows("are_execution_queue").filter((s) => s.prospectQueueId === pq).sort((a, b) => a.stepIndex - b.stepIndex);
const engine = readFileSync(join(__dirname, "areEngine.ts"), "utf8").replace(/\r\n/g, "\n");

function seed() {
  rows("workspaces").push({ id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  const user = (id: number, email: string) => ({ id, openId: `local:${id}`, name: `User ${id}`, email, loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() });
  rows("users").push(user(ADMIN, "admin@lsi.example"), user(REP, "rep@lsi.example"));
  const member = (id: number, userId: number, role: string) => ({ id, workspaceId: LSI, userId, role, deactivatedAt: null, lastActiveAt: new Date(), inviteToken: null, createdAt: new Date() });
  rows("workspace_members").push(member(1, ADMIN, "admin"), member(2, REP, "rep"));
  rows("are_campaigns").push({ id: 7, workspaceId: LSI, name: "Q4 outreach", status: "active", ownerUserId: REP, stepGapDays: 7, dailySendCap: 50, channelsEnabled: { email: true, linkedin: true } });
}
function pq(id: number, over: Record<string, unknown> = {}) {
  rows("prospect_queue").push({
    id, workspaceId: LSI, campaignId: 7, firstName: "Ann", lastName: "Lee", email: `p${id}@acme.example`,
    linkedinUrl: `https://www.linkedin.com/in/p${id}`, companyDomain: "acme.example", companyName: "Acme",
    sequenceStatus: "enrolled", enrichmentStatus: "complete", ...over,
  });
}
function step(id: number, prospectQueueId: number, stepIndex: number, scheduledAt: number, over: Record<string, unknown> = {}) {
  rows("are_execution_queue").push({
    id, workspaceId: LSI, campaignId: 7, prospectQueueId, stepIndex, channel: "email", status: "scheduled",
    scheduledAt: new Date(scheduledAt), executedAt: null, failureReason: null, messageContent: { subject: "s", body: "b" }, ...over,
  });
}
function caller(userId = REP) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(LSI) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}
const llmSays = (recommendedAction: string) => async () => ({
  choices: [{ message: { content: JSON.stringify({ sentiment: "neutral", reason: "r", recommendedAction, urgency: "low" }) } }],
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setNow(T0);
  h.db = makeSqlFakeDb({ realMembers: true });
  h.llm = null;
  h.llmCalls = 0;
  h.sends = [];
  h.transport = async (input) => { h.sends.push(input); return { messageId: `mid-${h.sends.length}` }; };
  h.gate = { allowed: true, reason: null, message: "ok", retryAfterMs: null };
  h.gateChecks = [];
  h.recorded = [];
  h.dms = [];
  h.invites = [];
  h.reactions = [];
  seed();
});
afterEach(() => { vi.useRealTimers(); });

/* ═══ Gate 1 — a reply stops the sequence, before the model (A1) ═══════════ */

describe("gate (ARE): any reply stops the sequence before the model decides anything", () => {
  it('"not now" — the model says continue, and the follow-ups stop anyway', async () => {
    pq(1);
    step(10, 1, 0, T0 - DAY, { status: "sent", executedAt: new Date(T0 - DAY) });
    step(11, 1, 1, T0 + 6 * DAY);
    step(12, 1, 2, T0 + 13 * DAY);
    h.llm = llmSays("continue_sequence");
    await processSignal(LSI, 1, 7, "email_reply", { body: "Not now, thanks" });
    expect(row("prospect_queue", 1).sequenceStatus).toBe("replied");
    expect(steps(1).map((s) => [s.status, s.failureReason])).toEqual([["sent", null], ["paused", HELD_REPLIED], ["paused", HELD_REPLIED]]);
  });

  it("a model error still stops it", async () => {
    pq(1);
    step(11, 1, 1, T0 + DAY);
    h.llm = async () => { throw new Error("provider down"); };
    await processSignal(LSI, 1, 7, "email_reply", { body: "Please stop" }).catch(() => {});
    expect(row("prospect_queue", 1).sequenceStatus).toBe("replied");
    expect(row("are_execution_queue", 11).status).toBe("paused");
  });

  it("an empty reply stops it, with no model call at all", async () => {
    pq(1);
    step(11, 1, 1, T0 + DAY);
    await processSignal(LSI, 1, 7, "email_reply", { body: "" });
    expect(h.llmCalls).toBe(0);
    expect(row("prospect_queue", 1).sequenceStatus).toBe("replied");
  });

  it("does not reopen a prospect whose sequence is over", async () => {
    pq(1, { sequenceStatus: "completed" });
    h.llm = llmSays("continue_sequence");
    await processSignal(LSI, 1, 7, "email_reply", { body: "thanks" });
    expect(row("prospect_queue", 1).sequenceStatus).toBe("completed");
  });

  it("an auto-responder puts them back, the held steps re-spaced from the return date", async () => {
    pq(1);
    step(11, 1, 1, T0 - 2 * DAY);
    step(12, 1, 2, T0 + 5 * DAY);
    await processSignal(LSI, 1, 7, "email_reply", { body: "I am out of the office until Monday" });
    const back = new Date(T0 + 6 * DAY);
    expect(await resumeAreProspectAfterAutoReply(h.db, LSI, 1, back)).toBe(true);
    expect(row("prospect_queue", 1).sequenceStatus).toBe("enrolled");
    const [a, b] = steps(1);
    expect(a.status).toBe("scheduled");
    expect(new Date(a.scheduledAt).getTime()).toBe(back.getTime());
    expect(new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime()).toBe(7 * DAY);
    // The classifier's out_of_office branch is what calls it, for this reply's prospect.
    const rc = readFileSync(join(__dirname, "services", "replyClassifier.ts"), "utf8");
    const ooo = rc.slice(rc.indexOf('case "out_of_office": {'), rc.indexOf("    default:", rc.indexOf('case "out_of_office": {')));
    expect(ooo).toContain("resumeAreProspectAfterAutoReply(db, workspaceId, queueId, back)");
    expect(ooo).toContain("snoozesSoFar < OOO_MAX_SNOOZES");
  });

  it("a LinkedIn reply reaches the campaign prospect it answers (nothing produced linkedin_reply)", () => {
    const src = readFileSync(join(__dirname, "unipileWebhook.ts"), "utf8");
    const at = src.indexOf("socialReplyProfileUrls({");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 1400);
    expect(block).toContain("inArray(prospectQueue.linkedinUrl, urls)");
    expect(block).toContain('processSignal(acct.workspaceId, q.id, q.campaignId, "linkedin_reply"');
    expect(src.lastIndexOf("if (sc.tier)", at)).toBeGreaterThan(-1);
  });
});

/* ═══ Gate 2 — resume and re-approve space the steps (A2) ═════════════════ */

describe("gate (ARE): resuming or re-approving spaces the steps", () => {
  it("the spacing rule: the first no earlier than the start, each keeping its gap", () => {
    expect(respaced([T0 - 10 * DAY, T0 - 3 * DAY, T0 + 4 * DAY], T0)).toEqual([T0, T0 + 7 * DAY, T0 + 14 * DAY]);
    // Nothing overdue → nothing moves.
    expect(respaced([T0 + DAY, T0 + 8 * DAY], T0)).toEqual([T0 + DAY, T0 + 8 * DAY]);
  });

  it("resuming a paused prospect brings its held steps back from now, a gap apart — not all at once", async () => {
    pq(1);
    step(11, 1, 1, T0 + 2 * DAY);
    step(12, 1, 2, T0 + 9 * DAY);
    await caller().are.prospects.pauseSequence({ prospectId: 1 });
    expect(steps(1).map((s) => s.status)).toEqual(["paused", "paused"]);
    setNow(T0 + 30 * DAY); // a month later
    await caller().are.prospects.resumeSequence({ prospectId: 1 });
    const [a, b] = steps(1);
    expect(row("prospect_queue", 1).sequenceStatus).toBe("enrolled");
    expect(new Date(a.scheduledAt).getTime()).toBe(T0 + 30 * DAY);
    expect(new Date(b.scheduledAt).getTime()).toBe(T0 + 37 * DAY);
  });

  it("a step paused by hand stays paused when the prospect is resumed", async () => {
    pq(1, { sequenceStatus: "paused" });
    step(11, 1, 1, T0 + DAY, { status: "paused", failureReason: null });
    await caller().are.prospects.resumeSequence({ prospectId: 1 });
    expect(row("are_execution_queue", 11).status).toBe("paused");
  });

  it("approve refuses a prospect who replied or completed, and is a no-op on one already approved", async () => {
    pq(1, { sequenceStatus: "replied" });
    pq(2, { sequenceStatus: "completed" });
    pq(3, { sequenceStatus: "approved", approvedAt: new Date(T0 - DAY) });
    pq(4, { sequenceStatus: "canceled" });
    for (const id of [1, 2]) expect((await refusal(caller().are.prospects.approve({ prospectId: id }))).code).toBe("BAD_REQUEST");
    expect(row("prospect_queue", 1).sequenceStatus).toBe("replied");
    await caller().are.prospects.approve({ prospectId: 3 });
    await caller().are.prospects.approve({ prospectId: 4 });
    expect(row("prospect_queue", 4).sequenceStatus).toBe("approved");
  });

  it("enrolment re-spaces a resumed sequence instead of flooring every step at now", () => {
    const enrol = engine.slice(engine.indexOf("async function enrollApprovedForCampaignUnlocked"), engine.indexOf("async function tickCampaign"));
    expect(enrol).toContain("const dueTimes = respaced(");
    expect(enrol).toContain("scheduledAt: new Date(dueTimes[i])");
    expect(enrol).not.toContain("dueAtForDay(");
    // A prospect approved again after a pause gets its HELD steps back, not a second copy.
    const release = enrol.indexOf("if ((await releaseProspectSteps(db, wsId, row.id, new Date())) > 0) {");
    expect(release).toBeGreaterThan(-1);
    expect(release).toBeLessThan(enrol.indexOf("const priorSends"));
  });

  it("re-evaluating someone already in a sequence changes their score, not their status", () => {
    const src = readFileSync(join(__dirname, "routers", "are", "prospects.ts"), "utf8");
    const re = src.slice(src.indexOf("  reEvaluate: workspaceProcedure"), src.indexOf("  reEvaluate: workspaceProcedure") + 3000);
    expect(re).toContain('const mayRegrade = ["pending", "skipped", "sourcing", "canceled"].includes(prospect.sequenceStatus);');
    expect(re).toContain("const newStatus = !mayRegrade ? prospect.sequenceStatus :");
  });

  it("a campaign back from pause shifts each prospect's overdue steps so they do not all fall due", async () => {
    pq(1);
    step(11, 1, 1, T0 - 20 * DAY);
    step(12, 1, 2, T0 - 13 * DAY);
    step(13, 1, 3, T0 - 6 * DAY);
    pq(2);
    step(21, 2, 1, T0 + 3 * DAY); // not overdue: untouched
    await respaceOverdueSteps(h.db, LSI, 7, new Date(T0));
    expect(steps(1).map((s) => new Date(s.scheduledAt).getTime())).toEqual([T0, T0 + 7 * DAY, T0 + 14 * DAY]);
    expect(new Date(row("are_execution_queue", 21).scheduledAt).getTime()).toBe(T0 + 3 * DAY);
    const camp = readFileSync(join(__dirname, "routers", "are", "campaigns.ts"), "utf8");
    expect(camp).toContain('if (input.status === "active" && prior?.status === "paused") {\n        await respaceOverdueSteps(db, ctx.workspace.id, input.id);'.replace(/\n/g, camp.includes("\r\n") ? "\r\n" : "\n"));
  });

  it("one step per prospect per tick: a second one due is moved a campaign gap later", () => {
    const loop = engine.slice(engine.indexOf("for (const step of due) {"), engine.indexOf('if (step.channel === "linkedin") {'));
    expect(loop).toContain("if (stepsThisTick.has(step.prospectQueueId)) {");
    expect(loop).toContain("scheduledAt: new Date(Date.now() + gapMs)");
    expect(engine.split("stepsThisTick.add(step.prospectQueueId);").length - 1).toBe(2);
  });
});

/* ═══ Gate 3 — pausing holds (A3) ══════════════════════════════════════════ */

describe("gate (ARE): pausing holds the steps", () => {
  it("pause holds every scheduled step; nothing sent is touched", async () => {
    pq(1);
    step(10, 1, 0, T0 - DAY, { status: "sent" });
    step(11, 1, 1, T0 + DAY);
    const res = await caller().are.prospects.pauseSequence({ prospectId: 1 });
    expect(res.heldSteps).toBe(1);
    expect(row("are_execution_queue", 11)).toMatchObject({ status: "paused", failureReason: HELD_PAUSED });
    expect(row("are_execution_queue", 10).status).toBe("sent");
  });

  it("the dispatcher holds a paused or replied prospect's due step instead of skipping it for good", () => {
    for (const v of ["lp", "p"]) {
      const at = engine.indexOf(`if (${v}.sequenceStatus === "paused" || ${v}.sequenceStatus === "replied") {`);
      expect(at, v).toBeGreaterThan(-1);
      const block = engine.slice(at, at + 400);
      expect(block).toContain('status: "paused"');
      expect(block).not.toContain('"skipped"');
      expect(at).toBeLessThan(engine.indexOf(`if (${v}.sequenceStatus !== "enrolled") {`, at));
    }
  });

  it("cancel ends held steps too", async () => {
    pq(1, { sequenceStatus: "paused" });
    step(11, 1, 1, T0 + DAY, { status: "paused", failureReason: HELD_PAUSED });
    await caller().are.prospects.cancelSequence({ prospectId: 1 });
    expect(row("are_execution_queue", 11).status).toBe("skipped");
    expect(await releaseProspectSteps(h.db, LSI, 1, new Date())).toBe(0);
  });
});

/* ═══ Gate 4 — a double tick sends once (A30, A4) ══════════════════════════ */

describe("gate (ARE): a double tick sends once", () => {
  it("the dispatch claim is conditional: of two ticks that read the step as due, one takes it", async () => {
    pq(1);
    step(11, 1, 1, T0 - 60_000);
    expect(await claimStepForDispatch(h.db, 11)).toBe(true);
    expect(await claimStepForDispatch(h.db, 11)).toBe(false);
  });

  it("both channels claim through it before sending, and a deferred LinkedIn step goes back", () => {
    const li = engine.slice(engine.indexOf('if (step.channel === "linkedin") {'), engine.indexOf("// Channels still unwired"));
    const liClaim = li.indexOf("if (!(await claimStepForDispatch(db, step.id))) continue;");
    expect(liClaim).toBeGreaterThan(-1);
    expect(liClaim).toBeLessThan(li.indexOf("dispatchLinkedInStep({"));
    expect(li).toMatch(/outcome\.kind === "deferred"[\s\S]{0,700}status: "scheduled"[\s\S]{0,200}eq\(areExecutionQueue\.status, "failed"\)/);
    const email = engine.slice(engine.indexOf("// Channels still unwired"));
    const emailClaim = email.indexOf("if (!(await claimStepForDispatch(db, step.id))) continue;");
    expect(emailClaim).toBeGreaterThan(-1);
    expect(emailClaim).toBeLessThan(email.indexOf("sendCampaignEmailViaPool(wsId, {"));
  });

  it("resume puts back only a paused step — never a sent one", async () => {
    pq(1);
    step(10, 1, 0, T0 - DAY, { status: "sent" });
    expect((await refusal(caller().are.execution.resume({ id: 10 }))).code).toBe("BAD_REQUEST");
    expect(row("are_execution_queue", 10).status).toBe("sent");
  });

  describe("the pool send returns what happened (A4)", () => {
    beforeEach(() => {
      rows("sending_accounts").push({ id: 1, workspaceId: LSI, name: "Box", fromEmail: "box@lsi.example", fromName: "Box", enabled: true, dailySendLimit: 500 });
    });
    const send = () => sendCampaignEmailViaPool(LSI, { to: "x@acme.example", subject: "s", html: "<p>b</p>", text: "b" });

    it("success once the send resolves, even when the stats write after it fails", async () => {
      const realInsert = h.db.insert;
      h.db.insert = (t: any) => { if (String(t?.[Symbol.for("drizzle:Name")] ?? "").includes("daily_stats")) throw new Error("deadlock"); return realInsert(t); };
      const r = await send();
      expect(r.ok).toBe(true);
      expect(h.sends).toHaveLength(1);
    });

    it("an ambiguous error is 'state unknown' — not the prefix the heal retries", async () => {
      h.transport = async () => { throw new Error("Connection closed after DATA"); };
      const r = await send();
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(new RegExp(`^${SEND_STATE_UNKNOWN}`));
      expect(r.reason).not.toMatch(/^Pool send failed:/);
    });

    it("an error that proves nothing left stays retryable", async () => {
      h.transport = async () => { throw Object.assign(new Error("Invalid login"), { code: "EAUTH" }); };
      expect((await send()).reason).toMatch(/^Pool send failed:/);
    });
  });
});

/* ═══ Gate 5 — a suppressed person gets nothing (A8) ═══════════════════════ */

describe("gate (ARE): one suppression check at discovery, enrolment and both dispatch paths", () => {
  const supp = (over: Record<string, unknown>) => rows("are_suppression_list").push({ id: rows("are_suppression_list").length + 1, workspaceId: LSI, email: null, linkedinUrl: null, companyDomain: null, reason: "do_not_contact", ...over });

  it("discovery: a suppressed domain, profile or address never enters the queue", async () => {
    supp({ companyDomain: "competitor.example" });
    supp({ linkedinUrl: "https://www.linkedin.com/in/blocked-person" });
    rows("email_suppressions").push({ id: 1, workspaceId: LSI, email: "gone@acme.example", reason: "unsubscribe" });
    await saveScrapeJobAndQueue(LSI, 7, "apollo", "q", [
      { firstName: "A", lastName: "One", email: "a@competitor.example", companyDomain: "competitor.example" },
      { firstName: "B", lastName: "Two", email: "b@ok.example", linkedinUrl: "linkedin.com/in/blocked-person/" },
      { firstName: "C", lastName: "Three", email: "gone@acme.example" },
      { firstName: "D", lastName: "Four", email: "d@ok.example" },
    ]);
    expect(rows("prospect_queue").map((r) => r.email)).toEqual(["d@ok.example"]);
  });

  it("discovery: a bounce alone does not keep someone out", async () => {
    rows("email_suppressions").push({ id: 1, workspaceId: LSI, email: "old@acme.example", reason: "bounce" });
    await saveScrapeJobAndQueue(LSI, 7, "apollo", "q", [{ firstName: "E", lastName: "Five", email: "old@acme.example" }]);
    expect(rows("prospect_queue")).toHaveLength(1);
  });

  it("a person pushed from People is refused when suppressed", async () => {
    supp({ companyDomain: "competitor.example" });
    rows("prospects").push({ id: 501, workspaceId: LSI, firstName: "Z", lastName: "Q", email: "z@competitor.example", linkedinUrl: null, companyDomain: "competitor.example", company: "Comp" });
    const res = await pushPeopleIntoCampaign(LSI, 7, [501]);
    expect(res.added).toHaveLength(0);
    expect(res.skipped[0].reason).toMatch(/Suppressed/);
  });

  it("enrolment and both dispatch paths ask the one check, on the right channel", () => {
    const enrol = engine.slice(engine.indexOf("async function enrollApprovedForCampaignUnlocked"), engine.indexOf("async function tickCampaign"));
    expect(enrol).toContain('findSuppression(wsId, { email: row.email, linkedinUrl: row.linkedinUrl, companyDomain: row.companyDomain }, "any")');
    expect(engine).toContain('findSuppression(wsId, { email: lp.email, linkedinUrl: lp.linkedinUrl, companyDomain: lp.companyDomain }, "linkedin")');
    expect(engine).toContain('findSuppression(wsId, { email: p.email, linkedinUrl: p.linkedinUrl, companyDomain: p.companyDomain }, "email")');
    // The old by-address-only reads are gone.
    expect(engine).not.toMatch(/eq\(areSuppressionList\.email, (row|p)\.email\)/);
    // LinkedIn: checked before the send.
    const li = engine.slice(engine.indexOf('if (step.channel === "linkedin") {'), engine.indexOf("// Channels still unwired"));
    expect(li.indexOf('"linkedin")')).toBeLessThan(li.indexOf("dispatchLinkedInStep({"));
  });

  it("do-not-contact rows are written in the form the check reads", async () => {
    await caller(ADMIN).are.execution.addSuppression({ linkedinUrl: "HTTPS://uk.linkedin.com/in/Some-One/", companyDomain: "WWW.Rival.example", reason: "competitor" });
    expect(rows("are_suppression_list")[0]).toMatchObject({ linkedinUrl: "https://www.linkedin.com/in/some-one", companyDomain: "rival.example" });
  });
});

/* ═══ A5 — LinkedIn steps can no longer block email ═══════════════════════ */

describe("waiting LinkedIn steps can no longer block email (A5)", () => {
  it("email and the other channels read separate pages", () => {
    expect(engine).toContain('email ? eq(areExecutionQueue.channel, "email") : ne(areExecutionQueue.channel, "email")');
    expect(engine).toContain("...(await duePage(true, remaining)),");
    expect(engine).toContain("...(await duePage(false, Math.min(remaining, OTHER_CHANNEL_PER_TICK))),");
  });

  it("a held or waiting LinkedIn step steps aside instead of heading the page again", () => {
    const li = engine.slice(engine.indexOf('if (step.channel === "linkedin") {'), engine.indexOf("// Channels still unwired"));
    expect(li).toMatch(/if \(linkedinHeld\) \{[\s\S]{0,300}scheduledAt: new Date\(Date\.now\(\) \+ LINKEDIN_HELD_MS\)/);
    expect(li).toContain("scheduledAt: new Date(Date.now() + (outcome.stopChannel ? LINKEDIN_HELD_MS : LINKEDIN_WAIT_MS))");
  });

  it(`a connection request not accepted within ${INVITE_ACCEPT_TIMEOUT_DAYS} days ends the step`, async () => {
    rows("unipile_accounts").push({ id: 1, workspaceId: LSI, userId: REP, unipileAccountId: "acc-rep", provider: "LINKEDIN" });
    pq(1, { linkedinUrl: "https://www.linkedin.com/in/ann-lee" });
    const prospect = row("prospect_queue", 1);
    rows("unipile_invites").push({ id: 1, workspaceId: LSI, recipientProviderId: "ann-lee", status: "pending", sentAt: new Date(T0 - 2 * DAY) });
    const input = { workspaceId: LSI, campaignId: 7, campaignOwnerUserId: REP, prospect, body: "Hi", stepIndex: 1 };
    expect((await dispatchLinkedInStep(input)).kind).toBe("deferred");
    row("unipile_invites", 1).sentAt = new Date(T0 - (INVITE_ACCEPT_TIMEOUT_DAYS + 1) * DAY);
    expect(await dispatchLinkedInStep(input)).toMatchObject({ kind: "skipped" });
    expect(h.dms).toHaveLength(0);
  });
});

/* ═══ A31 — the cap's day is the workspace's ═══════════════════════════════ */

describe("the campaign cap counts the workspace's day (A31)", () => {
  it("local midnight, in the workspace zone", () => {
    expect(startOfLocalDay("America/New_York", new Date("2026-10-27T15:00:00Z")).toISOString()).toBe("2026-10-27T04:00:00.000Z");
    expect(startOfLocalDay("America/New_York", new Date("2026-10-27T03:00:00Z")).toISOString()).toBe("2026-10-26T04:00:00.000Z");
    expect(startOfLocalDay("not/a-zone", new Date("2026-10-27T15:00:00Z")).toISOString()).toBe("2026-10-27T00:00:00.000Z");
  });

  it("the dispatcher's sent-today count starts there", () => {
    expect(engine).toContain("const startOfDay = startOfLocalDay(await getWorkspaceTimezone(wsId));");
    expect(engine).toContain("gte(areExecutionQueue.executedAt, startOfDay),");
  });
});

/* ═══ O11 — the LinkedIn limit gate on every path ═════════════════════════ */

describe("the LinkedIn limit gate applies on every path (O11)", () => {
  beforeEach(() => {
    rows("unipile_accounts").push({ id: 1, workspaceId: LSI, userId: REP, unipileAccountId: "acc-rep", provider: "LINKEDIN" });
  });

  it("a person's own DM is gated, counted, and refused when the limits say no", async () => {
    await caller().unipile.sendMessage({ unipileAccountId: "acc-rep", attendeesIds: ["ann-lee"], text: "Hello" });
    expect(h.gateChecks[0]).toMatchObject({ kind: "message", personInitiated: true });
    expect(h.recorded[0]).toMatchObject({ kind: "message", source: "manual" });
    h.gate = { allowed: false, reason: "daily_cap", message: "Daily message cap reached", retryAfterMs: null };
    expect((await refusal(caller().unipile.sendMessage({ unipileAccountId: "acc-rep", attendeesIds: ["ann-lee"], text: "Again" }))).message).toMatch(/LinkedIn limits/);
    expect(h.dms).toHaveLength(1);
  });

  it("likes and comments are gated and counted too", async () => {
    await caller().unipile.reactToPost({ socialId: "urn:post:1", unipileAccountId: "acc-rep" });
    await caller().unipile.commentOnPost({ socialId: "urn:post:1", text: "Nice", unipileAccountId: "acc-rep" });
    expect(h.recorded.map((r) => r.kind)).toEqual(["reaction", "reaction"]);
    h.gate = { allowed: false, reason: "spacing", message: "Too soon", retryAfterMs: 60_000 };
    await refusal(caller().unipile.reactToPost({ socialId: "urn:post:2", unipileAccountId: "acc-rep" }));
    expect(h.reactions).toHaveLength(2);
  });

  it("the autopilot's booking-link DMs ask the gate, and wait when it says no", () => {
    const rc = readFileSync(join(__dirname, "services", "replyClassifier.ts"), "utf8");
    expect(rc.split("await socialDmGate(").length - 1).toBe(2);
    expect(rc).toContain("if (!(await inSendWindow(workspaceId)) || !gate.allowed) {");
    expect(rc).toContain("if (!gate.allowed) { out.held++; continue; }");
    expect(rc.split("await gate.record();").length - 1).toBe(2);
  });
});

/* ═══ O15 — campaign email carries a visible unsubscribe too ══════════════ */

describe("every campaign email carries an unsubscribe footer (O15)", () => {
  it("the workspace's wording when it has one, the standard footer when not — never neither", () => {
    const at = engine.indexOf("const unsubHeaders = unsubscribeHeaders(appBaseUrl, wsId, p.email);");
    const block = engine.slice(at, at + 1200);
    expect(block).toContain("(optOutMessage ? renderSequenceOptOut(optOutMessage, { unsubscribeUrl }) : null)");
    expect(block).toContain("?? (() => { const f = unsubscribeFooter(unsubscribeUrl);");
    expect(block).not.toMatch(/if \(optOutMessage\) \{/);
    expect(block.indexOf("unsubscribeFooter(")).toBeLessThan(engine.indexOf("sendCampaignEmailViaPool(wsId, {", at) - at);
  });
});
