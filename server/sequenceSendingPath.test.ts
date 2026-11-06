/**
 * The sending path of sequences, batch Oa of the 2026-10-20 audit: every fix
 * here makes sends fewer, safer or more correct.
 *
 *   O44 daily caps are counted from the database, on the workspace's day ·
 *   O13 a sequence draft goes out as its sequence's sender, or is held ·
 *   O12 LinkedIn steps use only the sender's own account, in a fixed order,
 *       and never invite a 1st-degree connection · O16 "Send approved" sends
 *   a capped batch, one run at a time · O22 deleting a sequence keeps the
 *   emails it sent · O52 a reply task names the prospect · O60 a canvas wait
 *   of 0 is 0.
 *
 * Run against the real engine and routers and the SQL-evaluating fake
 * (`__fakes__/sqlFakeDb`), with the harness of phase1Sends.test.ts. Time is
 * frozen at T0, a Tuesday at 15:00 UTC (11:00 in New York, still on daylight
 * time); only Date is faked unless a test says otherwise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  windowOpen: true,
  tz: "UTC",
  paused: false,
  liVerdict: { allowed: true, reason: null, message: "ok", retryAfterMs: null } as any,
  dms: [] as any[],
  invites: [] as any[],
  emails: [] as any[],
  smtp: [] as any[],
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./_core/workspaceArchive", async (a) => ({ ...(await a<typeof import("./_core/workspaceArchive")>()), archivedWorkspaceIds: async () => new Set<number>() }));
vi.mock("./services/sendWindow", async (a) => ({ ...(await a<typeof import("./services/sendWindow")>()), inSendWindow: async () => h.windowOpen }));
vi.mock("./services/workspaceTimezone", async (a) => ({ ...(await a<typeof import("./services/workspaceTimezone")>()), getWorkspaceTimezone: async () => h.tz }));
vi.mock("./services/outboundPause", async (a) => ({
  ...(await a<typeof import("./services/outboundPause")>()),
  isOutboundPaused: async () => h.paused,
  assertOutboundNotPaused: async () => { if (h.paused) throw Object.assign(new Error("Outbound is paused"), { code: "PRECONDITION_FAILED" }); },
}));
vi.mock("./lib/unipile", async (a) => ({
  ...(await a<typeof import("./lib/unipile")>()),
  sendMessage: async (x: any) => { h.dms.push(x); return { id: `msg-${h.dms.length}`, chatId: `chat-${h.dms.length}` }; },
  sendLinkedInInvitation: async (x: any) => { h.invites.push(x); return {}; },
}));
vi.mock("./services/linkedin/activityGate", async (a) => ({
  ...(await a<typeof import("./services/linkedin/activityGate")>()),
  checkLinkedInAction: async () => h.liVerdict,
  recordLinkedInAction: async () => {},
}));
vi.mock("./emailAdapter", async (a) => ({
  ...(await a<typeof import("./emailAdapter")>()),
  createEmailAdapter: (acct: any) => ({ sendEmail: async (input: any) => { h.emails.push({ ...input, accountId: acct.id }); return { messageId: `mid-${h.emails.length}` }; } }),
}));
vi.mock("./sendLimits", async (a) => ({
  ...(await a<typeof import("./sendLimits")>()),
  assertSendAllowed: async () => {},
  accountsSentToday: async () => new Map<number, number>(),
}));
vi.mock("./mergeVars", async (a) => ({ ...(await a<typeof import("./mergeVars")>()), resolveBookingUrl: async () => "", buildMergeContextFromDb: async () => ({}) }));
vi.mock("./campaignCounters", async (a) => ({ ...(await a<typeof import("./campaignCounters")>()), bumpCampaignCounter: async () => {} }));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      verify: async () => true,
      sendMail: async (m: any) => { h.smtp.push(m); return { messageId: `smtp-${h.smtp.length}` }; },
    }),
  },
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { processEnrollments } from "./sequenceEngine";
import { deliverEmailDraft, sequenceDraftSender } from "./routers/sequences";
import { BULK_SEND_MAX, getEncKey } from "./routers/smtpConfig";
import { unsubscribeTargetByToken } from "./routers/emailSuppressions";
import { isFirstDegree, pickLinkedInAccount } from "./services/are/linkedinStep";

const LSI = 2;
const ADMIN = 20;
const REP = 21;
const GONE = 22;
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Tuesday 2026-10-27, 15:00 UTC — 11:00 EDT. */
const T0 = new Date("2026-10-27T15:00:00Z").getTime();
const OPEN = { sendWindowStart: "00:00", sendWindowEnd: "23:59", skipWeekends: false };
const ANN = "ann@acme.example";

const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
const drafts = () => rows("email_drafts");
const setNow = (ms: number) => vi.setSystemTime(new Date(ms));

function seq(id: number, steps: unknown[], over: Record<string, unknown> = {}) {
  rows("sequences").push({
    id, workspaceId: LSI, name: `Sequence ${id}`, description: null, status: "active", steps, settings: OPEN,
    dailyCap: null, ownerUserId: REP, assignedToUserId: null, enrollmentTrigger: null, exitConditions: null,
    isTemplate: false, visibility: "team", sourceTemplateId: null, enrolledCount: 0, createdAt: new Date(), updatedAt: new Date(),
    ...over,
  });
}
function enr(id: number, sequenceId: number, who: Record<string, number>, over: Record<string, unknown> = {}) {
  rows("enrollments").push({
    id, workspaceId: LSI, sequenceId, contactId: null, leadId: null, prospectId: null, status: "active",
    currentStep: 0, startedAt: new Date(), nextActionAt: new Date(Date.now() - MIN), resumeAt: null, ...who, ...over,
  });
}
function draft(id: number, over: Record<string, unknown> = {}) {
  rows("email_drafts").push({
    id, workspaceId: LSI, subject: "Hello", body: "Hello {{firstName}}", toContactId: null, toLeadId: null,
    toProspectId: null, toEmail: ANN, sequenceId: null, enrollmentId: null, pipelineJobId: null, status: "pending_review",
    aiGenerated: false, createdByUserId: REP, reviewedByUserId: null, createdAt: new Date(), sentAt: null,
    sendingAccountId: null, stepIndex: null, abVariantId: null, firstReplyAt: null, trackingToken: null,
    sendError: null, sendClaimedAt: null, openCount: 0, machineOpenCount: 0, clickCount: 0, ...over,
  });
}
const email = (subject = "Step", body = "Hi {{firstName}}") => ({ type: "email", subject, body });

function seed() {
  rows("workspaces").push({ id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  const user = (id: number, mail: string) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: mail, loginMethod: "password", role: "user",
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN, "admin@lsi.example"), user(REP, "rep@lsi.example"), user(GONE, "gone@lsi.example"));
  const member = (id: number, userId: number, role: string, deactivatedAt: Date | null = null) => ({
    id, workspaceId: LSI, userId, role, title: null, quota: null, deactivatedAt, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(member(1, ADMIN, "admin"), member(2, REP, "rep"), member(3, GONE, "rep", new Date(T0 - 30 * 24 * HOUR)));
  // The workspace's first mailbox, connected by nobody in particular.
  rows("sending_accounts").push({
    id: 1, workspaceId: LSI, name: "Shared box", fromEmail: "team@lsi.example", fromName: "LSI", enabled: true,
    provider: "generic_smtp", dailySendLimit: 500, unipileAccountId: null, signature: null, optOutEnabled: false, optOutMessage: null,
  });
  rows("contacts").push({ id: 101, workspaceId: LSI, firstName: "Ann", lastName: "Lee", email: ANN, linkedinUrl: "https://www.linkedin.com/in/ann-lee", companyDomain: null, accountId: null, title: null, personProspectId: 301 });
  rows("prospects").push(
    { id: 301, workspaceId: LSI, firstName: "Ann", lastName: "Lee", email: ANN, linkedinUrl: "linkedin.com/in/ann-lee/", companyDomain: "acme.example", title: null, company: "Acme" },
    { id: 302, workspaceId: LSI, firstName: "Bo", lastName: "Ng", email: "bo@beta.example", linkedinUrl: "https://www.linkedin.com/in/bo-ng", companyDomain: "beta.example", title: null, company: "Beta" },
  );
  rows("unipile_accounts").push(
    { id: 1, workspaceId: LSI, userId: ADMIN, unipileAccountId: "acc-admin", provider: "LINKEDIN" },
    { id: 2, workspaceId: LSI, userId: REP, unipileAccountId: "acc-rep", provider: "LINKEDIN" },
  );
}

function caller(userId: number) {
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
const newDrafts = (before: number) => drafts().filter((d) => d.id > before);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setNow(T0);
  h.db = makeSqlFakeDb({ realMembers: true });
  h.windowOpen = true;
  h.tz = "UTC";
  h.paused = false;
  h.liVerdict = { allowed: true, reason: null, message: "ok", retryAfterMs: null };
  h.dms = [];
  h.invites = [];
  h.emails = [];
  h.smtp = [];
  seed();
});
afterEach(() => { vi.useRealTimers(); });

/* ═══ O44 — daily caps from the database, on the workspace's day ═══════════ */

describe("daily caps count real sends from the database (O44)", () => {
  it("what already went out today counts, so a restart does not reset the cap", async () => {
    seq(1, [email()], { dailyCap: 1 });
    // Sent this morning, before the process that is running now started.
    draft(500, { sequenceId: 1, status: "sent", sentAt: new Date(T0 - 4 * HOUR) });
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(newDrafts(500)).toHaveLength(0);
    expect(row("enrollments", 11).currentStep).toBe(0);
    expect(new Date(row("enrollments", 11).nextActionAt).getTime()).toBe(T0 + HOUR);
  });

  it("a draft waiting to go out counts; a rejected one never goes, so it does not", async () => {
    seq(1, [email()], { dailyCap: 2 });
    draft(500, { sequenceId: 1, status: "rejected" });
    draft(501, { sequenceId: 1, status: "pending_review" });
    enr(11, 1, { contactId: 101 });
    enr(12, 1, { prospectId: 302 });
    await processEnrollments();
    // One more fits under the cap of two; the second person waits.
    expect(newDrafts(501)).toHaveLength(1);
  });

  it("yesterday's sends do not count", async () => {
    seq(1, [email()], { dailyCap: 1 });
    draft(500, { sequenceId: 1, status: "sent", sentAt: new Date(T0 - 20 * HOUR) });
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(newDrafts(500)).toHaveLength(1);
  });

  it("the workspace cap runs on the workspace's day, not UTC's", async () => {
    h.tz = "America/New_York";
    // 22:00 on Tuesday in New York is already Wednesday in UTC.
    setNow(Date.parse("2026-10-28T02:00:00Z"));
    seq(1, [email()]);
    // 100 sent at 16:00 New York time on Tuesday: today there, yesterday in UTC.
    for (let i = 0; i < 100; i++) draft(1000 + i, { sequenceId: 9, status: "sent", sentAt: new Date("2026-10-27T20:00:00Z") });
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(newDrafts(1099)).toHaveLength(0);
  });

  it("the same 100 sent the evening before, New York time, leave today's cap free", async () => {
    h.tz = "America/New_York";
    setNow(Date.parse("2026-10-28T02:00:00Z"));
    seq(1, [email()]);
    // 23:00 on Monday in New York: Tuesday in UTC, but yesterday there.
    for (let i = 0; i < 100; i++) draft(1000 + i, { sequenceId: 9, status: "sent", sentAt: new Date("2026-10-27T03:00:00Z") });
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(newDrafts(1099)).toHaveLength(1);
  });
});

/* ═══ O13 — a sequence draft goes out as the sequence's sender ═════════════ */

describe("a sequence draft goes out as its sequence's sender, never the owner in their place (O13)", () => {
  it("the engine stamps the assigned rep, else the sequence's owner, on the draft", async () => {
    seq(1, [email()], { ownerUserId: ADMIN, assignedToUserId: REP });
    seq(2, [email()], { ownerUserId: REP });
    enr(11, 1, { contactId: 101 });
    enr(12, 2, { prospectId: 302 });
    await processEnrollments();
    expect(drafts().find((d) => d.sequenceId === 1)?.createdByUserId).toBe(REP);
    expect(drafts().find((d) => d.sequenceId === 2)?.createdByUserId).toBe(REP);
  });

  it("a draft written before the stamp is read off its sequence; a leaver or nobody holds it", async () => {
    seq(1, [email()], { ownerUserId: ADMIN, assignedToUserId: REP });
    seq(2, [email()], { ownerUserId: GONE });
    seq(3, [email()], { ownerUserId: null });
    expect(await sequenceDraftSender(h.db, LSI, { createdByUserId: null, sequenceId: 1 })).toEqual({ userId: REP });
    expect(await sequenceDraftSender(h.db, LSI, { createdByUserId: REP, sequenceId: 2 })).toEqual({ userId: REP });
    const gone = await sequenceDraftSender(h.db, LSI, { createdByUserId: null, sequenceId: 2 });
    expect(gone).toMatchObject({ hold: expect.stringMatching(/^Not sent automatically: .*no longer an active member/) });
    const nobody = await sequenceDraftSender(h.db, LSI, { createdByUserId: null, sequenceId: 3 });
    expect(nobody).toMatchObject({ hold: expect.stringMatching(/nobody to send as/) });
  });

  it("auto-send holds a draft whose sender has no mailbox of their own, with the reason, instead of using the workspace's", async () => {
    seq(1, [email()]);
    enr(11, 1, { contactId: 101 }, { currentStep: 1 });
    draft(600, { sequenceId: 1, enrollmentId: 11, toContactId: 101, createdByUserId: REP });
    const r = await refusal(deliverEmailDraft({ workspaceId: LSI, userId: REP, draftId: 600, claimFrom: ["pending_review"], ownMailboxOnly: true }));
    expect(r.code).toBe("PRECONDITION_FAILED");
    expect(r.message).toMatch(/^Not sent automatically: User 21 has no mailbox of their own connected/);
    expect(h.emails).toHaveLength(0);
    // Back in the queue, saying why.
    expect(row("email_drafts", 600)).toMatchObject({ status: "pending_review", sendError: r.message });
  });

  it("it sends from that person's own mailbox when they have one", async () => {
    rows("sending_accounts").push({
      id: 2, workspaceId: LSI, name: "Rep's box", fromEmail: "rep@lsi.example", fromName: "Rep", enabled: true,
      provider: "google_oauth", dailySendLimit: 500, unipileAccountId: "mail-rep", signature: null, optOutEnabled: false, optOutMessage: null,
    });
    rows("unipile_accounts").push({ id: 3, workspaceId: LSI, userId: REP, unipileAccountId: "mail-rep", provider: "GOOGLE" });
    seq(1, [email()]);
    enr(11, 1, { contactId: 101 }, { currentStep: 1 });
    draft(600, { sequenceId: 1, enrollmentId: 11, toContactId: 101, createdByUserId: REP });
    await deliverEmailDraft({ workspaceId: LSI, userId: REP, draftId: 600, claimFrom: ["pending_review"], ownMailboxOnly: true });
    expect(h.emails.map((e) => e.accountId)).toEqual([2]);
    expect(row("email_drafts", 600).status).toBe("sent");
  });

  it("a person pressing Send still sends as they always did (the hold is for the unattended worker)", async () => {
    seq(1, [email()]);
    enr(11, 1, { contactId: 101 }, { currentStep: 1 });
    draft(600, { sequenceId: 1, enrollmentId: 11, toContactId: 101, createdByUserId: REP });
    await deliverEmailDraft({ workspaceId: LSI, userId: REP, draftId: 600 });
    expect(h.emails.map((e) => e.accountId)).toEqual([1]);
  });

  it("the worker resolves the sender, asks for an own mailbox, and reads on past held drafts", () => {
    const src = readFileSync(join(__dirname, "routers", "sequences.ts"), "utf8");
    const at = src.indexOf("export async function autoSendForAllWorkspaces");
    const fn = src.slice(at, src.indexOf("export const emailDraftsRouter", at));
    expect(at).toBeGreaterThan(-1);
    expect(fn).toContain("sender = await sequenceDraftSender(db, ws.workspaceId, draft);");
    expect(fn).toContain("userId: sender.userId,");
    expect(fn).toContain("ownMailboxOnly: true,");
    // No owner stand-in: that is what every rep's sequence used to send as.
    expect(fn).not.toContain("workspaceNotifyUserId");
    // Held drafts stay in the queue, so it pages on by id rather than stopping at one page.
    expect(fn).toContain("gt(emailDrafts.id, afterId)");
    expect(fn).toMatch(/for \(let pageNo = 0; pageNo < AUTO_SEND_MAX_PAGES && attempts < AUTO_SEND_PER_TICK; pageNo\+\+\)/);
  });
});

/* ═══ O12 — LinkedIn: the sender's own account, in order, never a connection ═ */

describe("sequence LinkedIn steps use only the sender's account and never invite a connection (O12)", () => {
  it("a sender with no LinkedIn account of their own is skipped, not sent from a colleague's", async () => {
    seq(1, [{ type: "linkedin_dm", body: "Hi Ann" }], { ownerUserId: GONE });
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(h.dms).toHaveLength(0);
    expect(row("enrollments", 11).currentStep).toBe(1);
  });

  it("a sender with two accounts always uses the older one", async () => {
    rows("unipile_accounts").unshift({ id: 5, workspaceId: LSI, userId: REP, unipileAccountId: "acc-rep-newer", provider: "LINKEDIN" });
    expect(await pickLinkedInAccount(LSI, REP, { ownerOnly: true })).toEqual({ unipileAccountId: "acc-rep", userId: REP });
    expect(await pickLinkedInAccount(LSI, GONE, { ownerOnly: true })).toBeNull();
    // Without ownerOnly (the Revenue Engine's call) the fallback is the oldest account too.
    expect(await pickLinkedInAccount(LSI, GONE)).toEqual({ unipileAccountId: "acc-admin", userId: ADMIN });
  });

  it("no invite to someone this account's profile read says is 1st degree", async () => {
    rows("prospect_linkedin_enrichments").push({
      id: 1, workspaceId: LSI, prospectId: 301, linkedinProfileUrl: "https://www.linkedin.com/in/ann-lee", linkedinProfileIdentifier: "ann-lee",
      linkedinConnectionDegree: "FIRST_DEGREE", linkedinSourceAccountId: "acc-rep",
    });
    seq(1, [{ type: "linkedin_invite", note: "Hi" }, email()]);
    enr(11, 1, { prospectId: 301 });
    enr(12, 1, { contactId: 101 }, { prospectId: null });
    await processEnrollments();
    expect(h.invites).toHaveLength(0);
    expect(row("enrollments", 11).currentStep).toBe(1);
  });

  it("…or to someone this account has already messaged", async () => {
    rows("unipile_messages").push({ id: 1, workspaceId: LSI, unipileAccountId: "acc-rep", provider: "LINKEDIN", chatId: "c1", messageId: "m1", direction: "outbound", recipientProviderId: "bo-ng" });
    seq(1, [{ type: "linkedin_invite", note: "Hi" }]);
    enr(11, 1, { prospectId: 302 });
    await processEnrollments();
    expect(h.invites).toHaveLength(0);
  });

  it("a colleague's connection is not this sender's: the invite goes", async () => {
    rows("prospect_linkedin_enrichments").push({
      id: 1, workspaceId: LSI, prospectId: 301, linkedinProfileUrl: "https://www.linkedin.com/in/ann-lee", linkedinProfileIdentifier: "ann-lee",
      linkedinConnectionDegree: "FIRST_DEGREE", linkedinSourceAccountId: "acc-admin",
    });
    seq(1, [{ type: "linkedin_invite", note: "Hi" }]);
    enr(11, 1, { prospectId: 301 });
    await processEnrollments();
    expect(h.invites.map((i) => i.accountId)).toEqual(["acc-rep"]);
  });

  it("reads every spelling of 1st degree, and nothing else", () => {
    for (const d of ["FIRST_DEGREE", "first_degree", "DISTANCE_1", "1", 1, "1st"]) expect(isFirstDegree(d), String(d)).toBe(true);
    for (const d of ["SECOND_DEGREE", "DISTANCE_2", "2", "OUT_OF_NETWORK", "", null, undefined]) expect(isFirstDegree(d as any), String(d)).toBe(false);
  });
});

/* ═══ O52 — a reply task names the prospect ════════════════════════════════ */

describe("a manual reply on a prospect enrolment files the task on the prospect (O52)", () => {
  it("not as a lead with no id", async () => {
    seq(1, [email(), email()]);
    enr(13, 1, { prospectId: 302 }, { currentStep: 1 });
    await caller(REP).sequences.pauseOnReply({ enrollmentId: 13 });
    expect(row("enrollments", 13).status).toBe("paused");
    expect(rows("tasks")[0]).toMatchObject({ relatedType: "prospect", relatedId: 302 });
  });
});

/* ═══ O16 — "Send approved": a capped batch, one run at a time ═════════════ */

describe('"Send approved" sends a capped batch, oldest first, one run at a time (O16)', () => {
  function smtpConfig() {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", getEncKey(), iv);
    const enc = Buffer.concat([cipher.update("secret", "utf8"), cipher.final()]);
    rows("smtp_configs").push({
      id: 1, workspaceId: LSI, host: "smtp.lsi.example", port: 587, secure: false, username: "u",
      encryptedPassword: `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc.toString("hex")}`,
      fromEmail: "rep@lsi.example", fromName: "Rep", replyTo: null, enabled: true,
    });
  }

  it(`sends at most ${25} a press, oldest first, and says how many are left`, async () => {
    // The one-a-second spacing runs on fake time that moves 1 s per 20 ms.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    setNow(T0);
    smtpConfig();
    expect(BULK_SEND_MAX).toBe(25);
    // Newest first in the table, so the order has to come from the query.
    for (let i = 29; i >= 0; i--) draft(200 + i, { status: "approved", toEmail: `p${i}@acme.example` });
    const res = await caller(ADMIN).smtpConfig.sendBulkApproved({});
    expect(res).toMatchObject({ sent: 25, failed: 0, remaining: 5, inProgress: 0 });
    expect(h.smtp.map((m) => m.to)).toEqual(Array.from({ length: 25 }, (_, i) => `p${i}@acme.example`));
    expect(drafts().filter((d) => d.status === "approved").map((d) => d.id).sort()).toEqual([225, 226, 227, 228, 229]);
  }, 30_000);

  it("a second press while one runs is refused, and a retry finds a claimed draft instead of sending it again", async () => {
    smtpConfig();
    draft(300, { status: "approved", toEmail: "bo@beta.example" });
    // Claimed by a run that was cut off mid-send.
    draft(301, { status: "sending", sendClaimedAt: new Date(T0 - 2 * MIN), toEmail: ANN });
    const [first, second] = await Promise.allSettled([caller(ADMIN).smtpConfig.sendBulkApproved({}), caller(ADMIN).smtpConfig.sendBulkApproved({})]);
    expect(first).toMatchObject({ status: "fulfilled", value: { sent: 1, remaining: 0, inProgress: 1 } });
    expect(second).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
    expect(h.smtp.map((m) => m.to)).toEqual(["bo@beta.example"]);
    expect(row("email_drafts", 301).status).toBe("sending");
    // The run let go: the next press works.
    draft(302, { status: "approved", toEmail: "cy@gamma.example" });
    expect((await caller(ADMIN).smtpConfig.sendBulkApproved({})).sent).toBe(1);
  }, 20_000);

  it("pause is asked before the run starts, and again inside it before every send", () => {
    const src = readFileSync(join(__dirname, "routers", "smtpConfig.ts"), "utf8");
    const proc = src.slice(src.indexOf("  sendBulkApproved: adminWsProcedure"), src.indexOf("  getTrackingStats: workspaceProcedure"));
    expect(proc.indexOf("await assertOutboundNotPaused(ctx.workspace.id);")).toBeGreaterThan(-1);
    expect(proc.indexOf("await assertOutboundNotPaused(ctx.workspace.id);")).toBeLessThan(proc.indexOf("sendApprovedBatch("));
    const run = src.slice(src.indexOf("async function sendApprovedBatch("), src.indexOf("export const smtpConfigRouter"));
    const loop = run.slice(run.indexOf("for (const draft of drafts)"));
    expect(loop.indexOf("isOutboundPaused(")).toBeGreaterThan(-1);
    expect(loop.indexOf("isOutboundPaused(")).toBeLessThan(loop.indexOf("transporter.sendMail("));
  });
});

/* ═══ O22 — deleting a sequence keeps what it sent ═════════════════════════ */

describe("deleting a sequence keeps the emails it sent, so their unsubscribe links still work (O22)", () => {
  it("deletes only the drafts that never went out", async () => {
    seq(1, [email()], { status: "paused" });
    draft(700, { sequenceId: 1, status: "sent", sentAt: new Date(T0 - 48 * HOUR), trackingToken: "tok-700" });
    draft(701, { sequenceId: 1, status: "failed", sendError: "Connection closed" });
    draft(702, { sequenceId: 1, status: "sending", sendClaimedAt: new Date(T0 - MIN) });
    draft(703, { sequenceId: 1, status: "pending_review" });
    draft(704, { sequenceId: 1, status: "approved" });
    draft(705, { sequenceId: 1, status: "rejected" });
    draft(706, { sequenceId: 1, status: "ai_pending_review" });
    draft(707, { sequenceId: 2, status: "pending_review" }); // another sequence's
    await caller(ADMIN).sequences.delete({ id: 1 });
    expect(row("sequences", 1)).toBeUndefined();
    expect(drafts().map((d) => d.id).sort()).toEqual([700, 701, 702, 707]);
    // The link in the email that went out still finds its address.
    expect(await unsubscribeTargetByToken("tok-700")).toEqual({ email: ANN });
  });
});

/* ═══ O60 — a canvas wait of 0 is 0, and the cap is the server's 60 ════════ */

describe("a canvas wait keeps what was set (O60)", () => {
  it("0 stays 0, an unset wait is a day, and more than 60 days is 60", async () => {
    seq(1, [], { status: "draft" });
    const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type: type as any, positionX: 0, positionY: 0, data });
    await caller(ADMIN).sequences.saveCanvas({
      id: 1,
      nodes: [
        node("start", "start"),
        node("w0", "wait", { delayDays: 0, delayHours: 0 }),
        node("wh", "wait", { delayDays: 0, delayHours: 12 }),
        node("wu", "wait", {}),
        node("wl", "wait", { delayDays: 90 }),
        node("wd", "wait", { days: 3 }),
      ],
      edges: [
        { id: "e1", source: "start", target: "w0" },
        { id: "e2", source: "w0", target: "wh" },
        { id: "e3", source: "wh", target: "wu" },
        { id: "e4", source: "wu", target: "wl" },
        { id: "e5", source: "wl", target: "wd" },
      ],
    });
    expect((row("sequences", 1).steps as any[]).map((s) => s.days)).toEqual([0, 0.5, 1, 60, 3]);
  });
});
