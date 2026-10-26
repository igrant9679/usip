/**
 * Phase 1 of the 2026-10-20 audit — "stop wrong, duplicate and unwanted
 * sends" — for the sequence engine and every draft sender, run against the
 * real engine and routers and an in-memory database that evaluates the SQL
 * they render (`__fakes__/sqlFakeDb`), so a conditional claim is a WHERE the
 * fake actually applies, not a condition object that looks right.
 *
 * The doc's gate, one describe each:
 *   reply → stop · resume → spaced steps · pause → held ·
 *   a double tick → one send · a suppressed person → no send
 * and the rest of the phase's sequence items: waits counted once and the
 * workspace time zone (O2, O9), held rows stepping aside (O23), draft claims
 * and status guards (O14, O16, O17), unsubscribe links and headers (O15),
 * LinkedIn limits and accounts (O11, O12).
 *
 * Time is frozen at T0 (a Tuesday, 15:00 UTC) and moved by hand; only Date is
 * faked, so the real timers the SMTP bulk loop waits on still run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  archived: new Set<number>(),
  windowOpen: true,
  tz: "UTC",
  paused: false,
  capHit: false,
  liVerdict: { allowed: true, reason: null, message: "ok", retryAfterMs: null } as any,
  gateChecks: [] as any[],
  liRecorded: [] as any[],
  dms: [] as any[],
  invites: [] as any[],
  emails: [] as any[],
  transport: null as null | ((input: any) => Promise<{ messageId?: string }>),
  smtp: [] as any[],
  smtpFail: null as null | Error,
  signals: [] as any[],
}));

// checkPermission resolves through db.ts's own getDb, which the mock cannot reach; every
// caller here holds the permission, so it is granted outright.
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./_core/workspaceArchive", async (a) => ({
  ...(await a<typeof import("./_core/workspaceArchive")>()),
  archivedWorkspaceIds: async () => h.archived,
}));
vi.mock("./services/sendWindow", async (a) => ({
  ...(await a<typeof import("./services/sendWindow")>()),
  inSendWindow: async () => h.windowOpen,
}));
vi.mock("./services/workspaceTimezone", async (a) => ({
  ...(await a<typeof import("./services/workspaceTimezone")>()),
  getWorkspaceTimezone: async () => h.tz,
}));
vi.mock("./services/outboundPause", async (a) => ({
  ...(await a<typeof import("./services/outboundPause")>()),
  isOutboundPaused: async () => h.paused,
  assertOutboundNotPaused: async () => {
    if (h.paused) throw Object.assign(new Error("Outbound is paused"), { code: "PRECONDITION_FAILED" });
  },
}));
vi.mock("./lib/unipile", async (a) => ({
  ...(await a<typeof import("./lib/unipile")>()),
  sendMessage: async (x: any) => { h.dms.push(x); return { id: `msg-${h.dms.length}`, chatId: `chat-${h.dms.length}` }; },
  sendLinkedInInvitation: async (x: any) => { h.invites.push(x); return {}; },
}));
vi.mock("./services/linkedin/activityGate", async (a) => ({
  ...(await a<typeof import("./services/linkedin/activityGate")>()),
  checkLinkedInAction: async (i: any) => { h.gateChecks.push(i); return h.liVerdict; },
  recordLinkedInAction: async (i: any) => { h.liRecorded.push(i); },
}));
vi.mock("./emailAdapter", async (a) => ({
  ...(await a<typeof import("./emailAdapter")>()),
  createEmailAdapter: () => ({ sendEmail: (input: any) => h.transport!(input) }),
}));
vi.mock("./sendLimits", async (a) => ({
  ...(await a<typeof import("./sendLimits")>()),
  assertSendAllowed: async () => { if (h.capHit) throw new Error("Workspace daily send cap reached"); },
  accountsSentToday: async () => new Map<number, number>(),
}));
vi.mock("./mergeVars", async (a) => ({
  ...(await a<typeof import("./mergeVars")>()),
  resolveBookingUrl: async () => "",
  buildMergeContextFromDb: async () => ({}),
}));
vi.mock("./campaignCounters", async (a) => ({ ...(await a<typeof import("./campaignCounters")>()), bumpCampaignCounter: async () => {} }));
vi.mock("./routers/are/execution", async (a) => ({
  ...(await a<typeof import("./routers/are/execution")>()),
  processSignal: async (...args: unknown[]) => { h.signals.push(args); },
}));
vi.mock("./services/crossEngineEnrollment", async (a) => ({
  ...(await a<typeof import("./services/crossEngineEnrollment")>()),
  resolveToPeopleIds: async () => ({ prospectIds: [] }),
  activeCampaignsForProspects: async () => new Map(),
}));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      verify: async () => true,
      sendMail: async (m: any) => {
        if (h.smtpFail) throw h.smtpFail;
        h.smtp.push(m);
        return { messageId: `smtp-${h.smtp.length}` };
      },
    }),
  },
}));

import express from "express";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { pauseEnrollmentsForSocialReply, processEnrollments, resumeDueEnrollments } from "./sequenceEngine";
import { deliverEmailDraft } from "./routers/sequences";
import { processInboundReply } from "./inboundReplyPoller";
import { getEncKey } from "./routers/smtpConfig";
import { registerEmailTrackingRoutes } from "./emailTracking";
import { findSuppression, normalizeDomain, normalizeLinkedinUrl } from "./services/suppression";
import { claimDraftForSend, isDefinitelyNotSent, sweepStaleSendingDrafts } from "./services/draftSend";
import { statusApplies } from "@shared/emailActivity";
import { createCipheriv, randomBytes } from "node:crypto";

const LSI = 2;
const CF = 4;
const ADMIN = 20;
const REP = 21;
const DAY = 86_400_000;
const MIN = 60_000;
/** Tuesday 2026-10-27, 15:00 UTC. */
const T0 = new Date("2026-10-27T15:00:00Z").getTime();
const OPEN = { sendWindowStart: "00:00", sendWindowEnd: "23:59", skipWeekends: false };
const ANN = "ann@acme.example";

const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
const drafts = () => rows("email_drafts");
const now = () => Date.now();
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
    currentStep: 0, startedAt: new Date(), nextActionAt: new Date(now() - MIN), resumeAt: null, ...who, ...over,
  });
}
function draft(id: number, over: Record<string, unknown> = {}) {
  rows("email_drafts").push({
    id, workspaceId: LSI, subject: "Hello", body: "Hello {{firstName}}", toContactId: null, toLeadId: null,
    toProspectId: null, toEmail: null, sequenceId: null, enrollmentId: null, pipelineJobId: null, status: "pending_review",
    aiGenerated: false, createdByUserId: REP, reviewedByUserId: null, createdAt: new Date(), sentAt: null,
    sendingAccountId: null, stepIndex: null, abVariantId: null, firstReplyAt: null, trackingToken: null,
    sendError: null, sendClaimedAt: null, openCount: 0, machineOpenCount: 0, clickCount: 0, ...over,
  });
}
const email = (subject = "Step", body = "Hi {{firstName}}") => ({ type: "email", subject, body });
const wait = (days: number) => ({ type: "wait", days });

function seed() {
  rows("workspaces").push(
    { id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" },
    { id: CF, name: "CommunityForce", slug: "cf", ownerUserId: 10, archivedAt: null, plan: "trial" },
  );
  const user = (id: number, mail: string) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: mail, loginMethod: "password", role: "user",
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN, "admin@lsi.example"), user(REP, "rep@lsi.example"));
  const member = (id: number, workspaceId: number, userId: number, role: string) => ({
    id, workspaceId, userId, role, title: null, quota: null, deactivatedAt: null, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(member(1, LSI, ADMIN, "admin"), member(2, LSI, REP, "rep"));
  rows("sending_accounts").push({
    id: 1, workspaceId: LSI, name: "Rep box", fromEmail: "rep@lsi.example", fromName: "Rep", enabled: true,
    provider: "smtp", dailySendLimit: 500, unipileAccountId: null, signature: null, optOutEnabled: false, optOutMessage: null,
  });
  rows("contacts").push({ id: 101, workspaceId: LSI, firstName: "Ann", lastName: "Lee", email: ANN, linkedinUrl: "https://www.linkedin.com/in/ann-lee", companyDomain: null, accountId: null, title: null });
  rows("leads").push({ id: 201, workspaceId: LSI, firstName: "Ann", lastName: "Lee", email: ANN, title: null, company: "Acme" });
  rows("prospects").push(
    { id: 301, workspaceId: LSI, firstName: "Ann", lastName: "Lee", email: ANN, linkedinUrl: "linkedin.com/in/ann-lee/", companyDomain: "acme.example", title: null, company: "Acme" },
    { id: 302, workspaceId: LSI, firstName: "Bo", lastName: "Ng", email: "bo@beta.example", linkedinUrl: "https://www.linkedin.com/in/bo-ng", companyDomain: "beta.example", title: null, company: "Beta" },
    { id: 303, workspaceId: LSI, firstName: "Ann", lastName: "Lee", email: "ann.old@acme.example", linkedinUrl: null, companyDomain: null, title: null, company: "Acme" },
  );
  rows("unipile_accounts").push(
    { id: 1, workspaceId: LSI, userId: ADMIN, unipileAccountId: "acc-admin", provider: "LINKEDIN" },
    { id: 2, workspaceId: LSI, userId: REP, unipileAccountId: "acc-rep", provider: "LINKEDIN" },
  );
}

function caller(userId: number, ws = LSI) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

/** Every draft the engine wrote for this enrolment, oldest first. */
const draftsOf = (enrollmentId: number) => drafts().filter((d) => d.enrollmentId === enrollmentId).sort((a, b) => a.id - b.id);
/** Mark every open draft sent, as the sender would. */
function sendOpenDrafts() {
  for (const d of drafts()) if (["pending_review", "approved"].includes(d.status)) { d.status = "sent"; d.sentAt = new Date(); }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setNow(T0);
  h.db = makeSqlFakeDb({ realMembers: true });
  h.archived = new Set();
  h.windowOpen = true;
  h.tz = "UTC";
  h.paused = false;
  h.capHit = false;
  h.liVerdict = { allowed: true, reason: null, message: "ok", retryAfterMs: null };
  h.gateChecks = [];
  h.liRecorded = [];
  h.dms = [];
  h.invites = [];
  h.emails = [];
  h.smtp = [];
  h.smtpFail = null;
  h.signals = [];
  h.transport = async (input: any) => { h.emails.push(input); return { messageId: `mid-${h.emails.length}` }; };
  seed();
});
afterEach(() => { vi.useRealTimers(); });

/* ═══ Gate 1 — a reply stops the sequence ═══════════════════════════════════ */

describe("gate: a reply stops the sequence", () => {
  const reply = (over: Partial<Parameters<typeof processInboundReply>[0]> = {}) => processInboundReply({
    workspaceId: LSI, sendingAccountId: 1, userId: REP, fromEmail: ANN, fromName: "Ann Lee", subject: "Re: Hello",
    bodyText: "Not now, thanks", bodyHtml: "", messageId: `<r${Math.random()}@acme.example>`, inReplyTo: "", references: "",
    receivedAt: new Date(), ...over,
  });

  it("pauses EVERY enrolment of the person who replied — contact, lead, prospect and the draft's own (O5)", async () => {
    seq(1, [email(), wait(3), email()]);
    seq(2, [email(), wait(3), email()]);
    seq(3, [email(), wait(3), email()]);
    seq(4, [email(), wait(3), email()]);
    enr(11, 1, { contactId: 101 }, { currentStep: 2, nextActionAt: new Date(now() - MIN) });
    enr(12, 2, { leadId: 201 }, { currentStep: 2 });
    enr(13, 3, { prospectId: 301 }, { currentStep: 2 });
    // Sent to Ann's OLD address from a prospect enrolment; she answers from the new one.
    enr(14, 4, { prospectId: 303 }, { currentStep: 2 });
    draft(90, { enrollmentId: 14, sequenceId: 4, toProspectId: 303, toEmail: "ann.old@acme.example", status: "sent", sentAt: new Date(now() - DAY), trackingToken: "tok-90" });

    await reply({ inReplyTo: "<tok-90>" });

    expect([11, 12, 13, 14].map((id) => row("enrollments", id).status)).toEqual(["paused", "paused", "paused", "paused"]);
    // …and the next tick writes nothing for any of them.
    const before = drafts().length;
    await processEnrollments();
    expect(drafts().length).toBe(before);
  });

  it("holds a draft written BEFORE the reply: it is not sent (O4)", async () => {
    seq(1, [email(), wait(3), email()]);
    enr(11, 1, { contactId: 101 }, { currentStep: 1 });
    draft(91, { enrollmentId: 11, sequenceId: 1, toContactId: 101, toEmail: ANN, status: "approved" });

    await reply();
    expect(row("enrollments", 11).status).toBe("paused");

    const r = await refusal(deliverEmailDraft({ workspaceId: LSI, userId: REP, draftId: 91 }));
    expect(r.code).toBe("PRECONDITION_FAILED");
    expect(r.message).toMatch(/enrolment is paused/);
    expect(h.emails).toHaveLength(0);
    // Back where it was, so it can go if the enrolment is resumed.
    expect(row("email_drafts", 91).status).toBe("approved");
  });

  it("auto-send does not pick up a held draft at all", async () => {
    rows("workspace_settings").push({ id: 1, workspaceId: LSI, aiAutoSendEnabled: true, aiAutoSendScoreMin: 0, aiAutoSendAllowUnscored: true });
    seq(1, [email(), wait(3), email()]);
    enr(11, 1, { leadId: 201 }, { status: "paused" });
    draft(92, { enrollmentId: 11, sequenceId: 1, toLeadId: 201, toEmail: ANN });
    // Auto-send's score expression is raw SQL the fake does not evaluate; the
    // hold is the WHERE it now carries, read from the source.
    const src = readFileSync(join(__dirname, "routers", "sequences.ts"), "utf8");
    const at = src.indexOf("export async function autoSendForAllWorkspaces");
    const body = src.slice(at, src.indexOf("export const emailDraftsRouter", at));
    expect(body).toContain('eq(sequences.status, "active")');
    expect(body).toContain("enrollments.status} IN ('active', 'finished')");
    expect(body).toContain('claimFrom: ["pending_review"]');
  });

  it("a sequence with 'Pause enrollment on reply' off keeps running", async () => {
    seq(1, [email(), wait(3), email()], { settings: { ...OPEN, replyDetection: false } });
    enr(11, 1, { contactId: 101 });
    await reply();
    expect(row("enrollments", 11).status).toBe("active");
  });

  it("a LinkedIn reply pauses the person's sequences — contact and prospect enrolments (O6)", async () => {
    seq(1, [{ type: "linkedin_dm", body: "Hi Ann" }, wait(3), email()]);
    seq(2, [email(), wait(3), email()]);
    enr(11, 1, { contactId: 101 }, { currentStep: 1 });
    enr(13, 2, { prospectId: 301 }, { currentStep: 1 });
    enr(15, 2, { prospectId: 302 }, { currentStep: 1 }); // someone else
    rows("unipile_messages").push({ id: 1, workspaceId: LSI, unipileAccountId: "acc-rep", provider: "LINKEDIN", chatId: "chat-ann", messageId: "out-1", direction: "outbound", recipientProviderId: "ann-lee", linkedContactId: 101, linkedLeadId: null });

    const paused = await pauseEnrollmentsForSocialReply({ workspaceId: LSI, chatId: "chat-ann", senderProviderId: "ACoAAAnn", linkedContactId: 101, linkedLeadId: null });

    expect(paused.sort()).toEqual([11, 13]);
    expect(row("enrollments", 15).status).toBe("active");
  });

  it("a LinkedIn reply leaves a sequence with 'Pause enrollment on reply' off running", async () => {
    seq(1, [{ type: "linkedin_dm", body: "Hi Ann" }, wait(3), email()], { settings: { ...OPEN, replyDetection: false } });
    enr(11, 1, { contactId: 101 }, { currentStep: 1 });
    const paused = await pauseEnrollmentsForSocialReply({ workspaceId: LSI, chatId: "chat-x", senderProviderId: "ann-lee", linkedContactId: 101, linkedLeadId: null });
    expect(paused).toEqual([]);
    expect(row("enrollments", 11).status).toBe("active");
  });

  it("the messaging webhook pauses before any classifier, in every autopilot mode", () => {
    const src = readFileSync(join(__dirname, "unipileWebhook.ts"), "utf8");
    const pause = src.indexOf("pauseEnrollmentsForSocialReply(");
    const classify = src.indexOf("classifyAndHandleSocialMessage(acct.workspaceId");
    const modeGate = src.indexOf('ws.mode !== "off"');
    expect(pause).toBeGreaterThan(-1);
    expect(pause).toBeLessThan(classify);
    expect(pause).toBeLessThan(modeGate);
    expect(src.slice(pause - 400, pause)).toContain("if (sc.tier)");
  });
});

/* ═══ Gate 2 — resume → spaced steps ══════════════════════════════════════ */

describe("gate: resuming spaces the steps", () => {
  it("Resume keeps a wait that was still running", async () => {
    seq(1, [email(), wait(3), email()]);
    const end = new Date(now() + 2 * DAY);
    enr(11, 1, { contactId: 101 }, { status: "paused", currentStep: 2, nextActionAt: end });

    await caller(REP).sequences.resumeEnrollment({ id: 11 });

    expect(row("enrollments", 11).status).toBe("active");
    expect(new Date(row("enrollments", 11).nextActionAt).getTime()).toBe(end.getTime());
    await processEnrollments();
    expect(drafts()).toHaveLength(0);
  });

  it("the out-of-office wake-up keeps it too", async () => {
    seq(1, [email(), wait(3), email()]);
    const end = new Date(now() + 2 * DAY);
    enr(11, 1, { contactId: 101 }, { status: "paused", currentStep: 2, nextActionAt: end, resumeAt: new Date(now() - MIN) });
    await resumeDueEnrollments();
    expect(row("enrollments", 11).status).toBe("active");
    expect(new Date(row("enrollments", 11).nextActionAt).getTime()).toBe(end.getTime());
  });

  it("only a paused enrolment can be resumed", async () => {
    seq(1, [email()]);
    enr(11, 1, { contactId: 101 }, { status: "exited" });
    expect((await refusal(caller(REP).sequences.resumeEnrollment({ id: 11 }))).code).toBe("BAD_REQUEST");
    expect(row("enrollments", 11).status).toBe("exited");
  });

  it("after a long pause ONE email goes, and the next waits for it to be sent", async () => {
    seq(1, [email("one"), wait(3), email("two"), wait(3), email("three")]);
    // Paused at the wait after "one", which went 10 days ago.
    enr(11, 1, { contactId: 101 }, { status: "paused", currentStep: 1, nextActionAt: new Date(now() - 9 * DAY) });
    draft(80, { enrollmentId: 11, sequenceId: 1, status: "sent", sentAt: new Date(now() - 10 * DAY), toContactId: 101 });

    await caller(REP).sequences.resumeEnrollment({ id: 11 });
    // An hour of ticks, with every draft sent the moment it appears.
    for (let t = 0; t < 12; t++) {
      setNow(T0 + t * 5 * MIN);
      await processEnrollments();
      sendOpenDrafts();
    }
    const written = draftsOf(11).filter((d) => d.id !== 80);
    expect(written.map((d) => d.subject)).toEqual(["two"]);
    // "three" is three days after "two" went out — not due inside the hour.
    expect(new Date(row("enrollments", 11).nextActionAt).getTime()).toBeGreaterThan(written[0].sentAt.getTime() + 3 * DAY - MIN);
  });
});

/* ═══ Gate 3 — pausing holds ═════════════════════════════════════════════ */

describe("gate: pausing holds the steps", () => {
  it("a paused sequence's enrolments are left exactly where they are, and continue on reactivation (O1)", async () => {
    seq(1, [email("one"), wait(2), email("two")], { status: "paused" });
    enr(11, 1, { contactId: 101 });
    const before = JSON.stringify(row("enrollments", 11));

    await processEnrollments();
    expect(JSON.stringify(row("enrollments", 11))).toBe(before);
    expect(drafts()).toHaveLength(0);

    await caller(ADMIN).sequences.setStatus({ id: 1, status: "active" });
    await processEnrollments();
    expect(draftsOf(11).map((d) => d.subject)).toEqual(["one"]);
  });

  it("a draft sequence holds the same way, and enrolling into it says so", async () => {
    seq(1, [email("one")], { status: "draft" });
    const res = await caller(REP).sequences.enroll({ sequenceId: 1, contactId: 101 });
    expect(res.heldUntilActive).toBe(true);
    await processEnrollments();
    expect(rows("enrollments")[0].status).toBe("active");
    expect(drafts()).toHaveLength(0);
  });

  it("archiving is the one transition that ends them", async () => {
    seq(1, [email("one")]);
    enr(11, 1, { contactId: 101 }, { nextActionAt: new Date(now() + DAY) });
    enr(12, 1, { leadId: 201 }, { status: "paused" });
    enr(13, 1, { prospectId: 302 }, { status: "finished" });
    await caller(ADMIN).sequences.setStatus({ id: 1, status: "archived" });
    expect([11, 12, 13].map((id) => row("enrollments", id).status)).toEqual(["exited", "exited", "finished"]);
  });

  it("an archived sequence's due row is ended by the engine, not sent", async () => {
    seq(1, [email("one")], { status: "archived" });
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(row("enrollments", 11).status).toBe("exited");
    expect(drafts()).toHaveLength(0);
  });

  it("a paused sequence's drafts already in the queue are held at send (O4)", async () => {
    seq(1, [email("one")], { status: "paused" });
    enr(11, 1, { contactId: 101 }, { currentStep: 1 });
    draft(93, { enrollmentId: 11, sequenceId: 1, toContactId: 101, toEmail: ANN, status: "approved" });
    const r = await refusal(caller(REP).emailDrafts.send({ id: 93 }));
    expect(r.code).toBe("PRECONDITION_FAILED");
    expect(r.message).toMatch(/sequence is paused/);
    expect(h.emails).toHaveLength(0);
    expect(row("email_drafts", 93).status).toBe("approved");
  });
});

/* ═══ Gate 4 — a double tick sends once ═══════════════════════════════════ */

describe("gate: a double tick sends once", () => {
  it("two overlapping ticks write one draft for one step", async () => {
    seq(1, [email("one"), wait(3), email("two")]);
    enr(11, 1, { contactId: 101 });
    await Promise.all([processEnrollments(), processEnrollments()]);
    expect(draftsOf(11)).toHaveLength(1);
    expect(row("enrollments", 11).currentStep).toBe(1);
  });

  it("a tick that read the row before another advanced it does nothing (the conditional claim)", async () => {
    let raced = false;
    h.db = makeSqlFakeDb({
      realMembers: true,
      // The first write to enrollments finds the row already moved on by a
      // tick that read the same snapshot and claimed first.
      beforeUpdate: (table) => {
        if (table === "enrollments" && !raced) { raced = true; row("enrollments", 11).currentStep = 1; }
      },
    });
    seed();
    seq(1, [email("one"), wait(3), email("two")]);
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(raced).toBe(true);
    expect(drafts()).toHaveLength(0);
  });

  it("two Send clicks on one draft send one email; the second is told it is taken", async () => {
    draft(94, { toContactId: 101, toEmail: ANN, status: "approved" });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    h.transport = async (input) => { h.emails.push(input); await gate; return { messageId: "mid-1" }; };
    const first = deliverEmailDraft({ workspaceId: LSI, userId: REP, draftId: 94 });
    await vi.waitFor(() => expect(row("email_drafts", 94).status).toBe("sending"));
    const second = await refusal(deliverEmailDraft({ workspaceId: LSI, userId: REP, draftId: 94 }));
    release();
    await first;
    expect(second.code).toBe("CONFLICT");
    expect(h.emails).toHaveLength(1);
    expect(row("email_drafts", 94).status).toBe("sent");
  });

  it("the draft claim is conditional: of two senders that read 'approved', one takes it", async () => {
    draft(104, { status: "approved" });
    expect(await claimDraftForSend(h.db, LSI, 104, "approved", ["approved"])).toBe("approved");
    expect(await claimDraftForSend(h.db, LSI, 104, "approved", ["approved"])).toBeNull();
    expect(row("email_drafts", 104).status).toBe("sending");
    // …and only from a status the caller names.
    draft(105, { status: "rejected" });
    expect(await claimDraftForSend(h.db, LSI, 105, "rejected", ["approved"])).toBeNull();
  });

  it("auto-send's claim and a person's Send cannot both send", async () => {
    draft(95, { toContactId: 101, toEmail: ANN, status: "pending_review", sequenceId: null });
    await deliverEmailDraft({ workspaceId: LSI, userId: REP, draftId: 95, claimFrom: ["pending_review"] });
    const again = await caller(REP).emailDrafts.send({ id: 95 });
    expect(again.alreadySent).toBe(true);
    expect(h.emails).toHaveLength(1);
  });

  it("two overlapping ticks send one LinkedIn DM", async () => {
    seq(1, [{ type: "linkedin_dm", body: "Hi Ann" }, wait(2), email()]);
    enr(11, 1, { contactId: 101 });
    await Promise.all([processEnrollments(), processEnrollments()]);
    expect(h.dms).toHaveLength(1);
  });

  it("one step per person per tick, across their enrolments", async () => {
    seq(1, [email("a1")]);
    seq(2, [email("b1")]);
    enr(11, 1, { contactId: 101 });
    enr(12, 2, { contactId: 101 });
    await processEnrollments();
    expect(drafts()).toHaveLength(1);
  });
});

/* ═══ Gate 5 — a suppressed person gets nothing ══════════════════════════ */

describe("gate: a suppressed person gets nothing", () => {
  const supp = (over: Record<string, unknown>) => rows("are_suppression_list").push({ id: rows("are_suppression_list").length + 1, workspaceId: LSI, email: null, linkedinUrl: null, companyDomain: null, reason: "do_not_contact", ...over });

  it("an unsubscribed address: no draft, and the step is passed", async () => {
    rows("email_suppressions").push({ id: 1, workspaceId: LSI, email: ANN, reason: "unsubscribe" });
    seq(1, [email("one"), { type: "task", body: "Call Ann" }]);
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(drafts()).toHaveLength(0);
    expect(row("enrollments", 11).currentStep).toBe(1);
  });

  it("a do-not-contact COMPANY DOMAIN stops the email (A8: domains were never read)", async () => {
    supp({ companyDomain: "https://www.acme.example/" });
    seq(1, [email("one")]);
    enr(11, 1, { prospectId: 301 });
    await processEnrollments();
    expect(drafts()).toHaveLength(0);
  });

  it("a do-not-contact LINKEDIN PROFILE, spelled differently, stops the email and the DM", async () => {
    supp({ linkedinUrl: "linkedin.com/in/ann-lee" });
    seq(1, [email("one")]);
    seq(2, [{ type: "linkedin_dm", body: "Hi Ann" }]);
    enr(11, 1, { contactId: 101 });
    enr(12, 2, { prospectId: 301 });
    await processEnrollments();
    setNow(T0 + 5 * MIN);
    await processEnrollments();
    expect(drafts()).toHaveLength(0);
    expect(h.dms).toHaveLength(0);
  });

  it("a bounce stops email only; an unsubscribe stops LinkedIn too", async () => {
    rows("email_suppressions").push({ id: 1, workspaceId: LSI, email: "bo@beta.example", reason: "bounce" });
    seq(1, [{ type: "linkedin_dm", body: "Hi Bo" }]);
    enr(11, 1, { prospectId: 302 });
    await processEnrollments();
    expect(h.dms).toHaveLength(1);

    rows("email_suppressions").push({ id: 2, workspaceId: LSI, email: ANN, reason: "unsubscribe" });
    seq(2, [{ type: "linkedin_dm", body: "Hi Ann" }]);
    enr(12, 2, { contactId: 101 });
    await processEnrollments();
    expect(h.dms).toHaveLength(1);
  });

  it("a queued draft to a suppressed domain is rejected at send, not sent", async () => {
    supp({ companyDomain: "acme.example" });
    draft(96, { toContactId: 101, toEmail: ANN, status: "approved" });
    const r = await refusal(deliverEmailDraft({ workspaceId: LSI, userId: REP, draftId: 96 }));
    expect(r.code).toBe("PRECONDITION_FAILED");
    expect(h.emails).toHaveLength(0);
    expect(row("email_drafts", 96).status).toBe("rejected");
  });

  it("is checked at enrolment: single refuses, bulk skips and counts", async () => {
    supp({ email: ANN, reason: "competitor" });
    seq(1, [email("one")]);
    expect((await refusal(caller(REP).sequences.enroll({ sequenceId: 1, contactId: 101 }))).message).toMatch(/do-not-contact/);
    const res = await caller(REP).sequences.bulkEnroll({ sequenceId: 1, prospectIds: [301, 302] });
    expect(res.enrolled).toBe(1);
    expect(res.skippedSuppressed).toBe(1);
    expect(rows("enrollments").map((e) => e.prospectId)).toEqual([302]);
  });

  it("matching is by normalised address, profile path and host", () => {
    expect(normalizeLinkedinUrl("https://uk.linkedin.com/in/Ann-Lee/?trk=x")).toBe("in/ann-lee");
    expect(normalizeLinkedinUrl("ann-lee")).toBe("in/ann-lee");
    expect(normalizeDomain("HTTPS://www.Acme.example:443/about")).toBe("acme.example");
  });

  it("fails closed: a lookup that cannot run is an error, not a yes", async () => {
    h.db = null;
    await expect(findSuppression(LSI, { email: ANN }, "email")).rejects.toThrow(/could not be checked/);
  });
});

/* ═══ Waits and time zones (O2, O9) ════════════════════════════════════════ */

describe("waits count once and run from the send; windows use the workspace zone", () => {
  /** Tick every 5 minutes until `until`, sending each draft `sendAfterMs` after it appears. */
  async function run(until: number, sendAfterMs = 0) {
    for (let t = now(); t <= until; t += 5 * MIN) {
      setNow(t);
      await processEnrollments();
      for (const d of drafts()) if (d.status === "pending_review" && t - new Date(d.createdAt).getTime() >= sendAfterMs) { d.status = "sent"; d.sentAt = new Date(t); }
    }
  }

  it('"email, wait 3, wait 4, email" sends the second email 7 days after the first, not 15 (O2)', async () => {
    seq(1, [email("one"), wait(3), wait(4), email("two")]);
    enr(11, 1, { contactId: 101 });
    await run(T0 + 8 * DAY);
    const [one, two] = draftsOf(11);
    const gap = new Date(two.createdAt).getTime() - new Date(one.sentAt).getTime();
    expect(gap).toBeGreaterThanOrEqual(7 * DAY);
    expect(gap).toBeLessThan(7 * DAY + 30 * MIN);
  }, 30_000);

  it("a wait counts from when the email actually went out, not from when its draft was written (O3)", async () => {
    seq(1, [email("one"), wait(2), email("two")]);
    enr(11, 1, { contactId: 101 });
    // The first draft sits in review for three days.
    await run(T0 + 6 * DAY, 3 * DAY);
    const [one, two] = draftsOf(11);
    expect(new Date(one.sentAt).getTime() - T0).toBeGreaterThanOrEqual(3 * DAY);
    expect(new Date(two.createdAt).getTime() - new Date(one.sentAt).getTime()).toBeGreaterThanOrEqual(2 * DAY);
  }, 30_000);

  it("back-to-back emails never go out together: the second waits for the first to be sent", async () => {
    seq(1, [email("one"), email("two")]);
    enr(11, 1, { contactId: 101 });
    for (let t = 0; t < 6; t++) { setNow(T0 + t * 5 * MIN); await processEnrollments(); }
    expect(draftsOf(11).map((d) => d.subject)).toEqual(["one"]);
  });

  it("a sequence with no zone of its own uses the WORKSPACE's (O9)", async () => {
    h.tz = "America/New_York";
    seq(1, [email("one")], { settings: {} }); // 08:00–18:00, skip weekends
    setNow(Date.parse("2026-10-27T11:00:00Z")); // 07:00 in New York
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(drafts()).toHaveLength(0);
    // Held until the window opens — 08:00 New York — not left at the head of the page.
    expect(new Date(row("enrollments", 11).nextActionAt).toISOString()).toBe("2026-10-27T12:00:00.000Z");
    setNow(Date.parse("2026-10-27T12:00:00Z"));
    await processEnrollments();
    expect(drafts()).toHaveLength(1);
  });

  it('"Skip weekends" unset means on, as the screens show it', async () => {
    seq(1, [email("one")], { settings: { sendWindowStart: "00:00", sendWindowEnd: "23:59" } });
    enr(11, 1, { contactId: 101 });
    setNow(Date.parse("2026-10-31T15:00:00Z")); // Saturday
    await processEnrollments();
    expect(drafts()).toHaveLength(0);
    expect(new Date(row("enrollments", 11).nextActionAt).toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });

  it("saving the settings dialog keeps the time zone it does not show (merge, not replace)", async () => {
    seq(1, [email("one")], { status: "paused", settings: { timezone: "Europe/London", sendWindowStart: "09:00" } });
    await caller(ADMIN).sequences.updateMeta({ id: 1, settings: { skipWeekends: true, sendWindowEnd: "17:00" } });
    expect(row("sequences", 1).settings).toEqual({ timezone: "Europe/London", sendWindowStart: "09:00", skipWeekends: true, sendWindowEnd: "17:00" });
    await caller(ADMIN).sequences.updateMeta({ id: 1, settings: { timezone: null } });
    expect(row("sequences", 1).settings.timezone).toBeUndefined();
  });
});

/* ═══ Held rows step aside (O23) ══════════════════════════════════════════ */

describe("held enrolments cannot block anyone else", () => {
  it("rows waiting on a draft are pushed forward, so the next tick reaches the rows behind them", async () => {
    seq(1, [email("one"), wait(1), email("two")]);
    for (let i = 0; i < 200; i++) {
      enr(1000 + i, 1, { leadId: 5000 + i }, { currentStep: 1, nextActionAt: new Date(now() - 2 * DAY) });
      draft(9000 + i, { enrollmentId: 1000 + i, sequenceId: 1, status: "pending_review" });
    }
    rows("sequences").push({ ...row("sequences", 1), id: 2, workspaceId: CF });
    rows("contacts").push({ id: 401, workspaceId: CF, email: "zed@cf.example", linkedinUrl: null, companyDomain: null });
    rows("enrollments").push({ id: 50, workspaceId: CF, sequenceId: 2, contactId: 401, leadId: null, prospectId: null, status: "active", currentStep: 0, nextActionAt: new Date(now() - DAY), resumeAt: null });

    await processEnrollments(); // the 200 held rows fill the page…
    expect(drafts().filter((d) => d.workspaceId === CF)).toHaveLength(0);
    expect(new Date(row("enrollments", 1000).nextActionAt).getTime()).toBeGreaterThan(now());
    setNow(T0 + 5 * MIN);
    await processEnrollments(); // …and step aside.
    expect(drafts().filter((d) => d.workspaceId === CF)).toHaveLength(1);
  });

  it("an archived workspace's rows are excluded in SQL, not skipped in the loop", async () => {
    h.archived = new Set([CF]);
    rows("sequences").push({ id: 2, workspaceId: CF, status: "active", steps: [email()], settings: OPEN });
    for (let i = 0; i < 200; i++) rows("enrollments").push({ id: 2000 + i, workspaceId: CF, sequenceId: 2, contactId: null, leadId: 6000 + i, prospectId: null, status: "active", currentStep: 0, nextActionAt: new Date(now() - 3 * DAY) });
    seq(1, [email("one")]);
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(draftsOf(11)).toHaveLength(1);
    expect(drafts().filter((d) => d.workspaceId === CF)).toHaveLength(0);
  });
});

/* ═══ Draft claims and status guards (O14, O17) ═══════════════════════════ */

describe("a send is claimed, and never retried once the email may have left", () => {
  it("an ambiguous transport error ends in 'failed' with the reason, and auto-send never retries it", async () => {
    draft(97, { toContactId: 101, toEmail: ANN, status: "pending_review" });
    h.transport = async () => { throw new Error("socket hang up after DATA"); };
    await refusal(deliverEmailDraft({ workspaceId: LSI, userId: REP, draftId: 97, claimFrom: ["pending_review"] }));
    expect(row("email_drafts", 97).status).toBe("failed");
    expect(row("email_drafts", 97).sendError).toMatch(/socket hang up/);
    // A person may decide to send it again: approving a failed draft is allowed.
    await caller(REP).emailDrafts.approve({ id: 97 });
    expect(row("email_drafts", 97).status).toBe("approved");
  });

  it("an error that proves nothing left (a refused login) puts it back where it was", async () => {
    draft(98, { toContactId: 101, toEmail: ANN, status: "pending_review" });
    h.transport = async () => { throw Object.assign(new Error("Invalid login"), { code: "EAUTH" }); };
    await refusal(deliverEmailDraft({ workspaceId: LSI, userId: REP, draftId: 98, claimFrom: ["pending_review"] }));
    expect(row("email_drafts", 98).status).toBe("pending_review");
    expect(row("email_drafts", 98).sendError).toMatch(/Invalid login/);
  });

  it("stopping before the transport (a daily cap) releases the claim", async () => {
    draft(99, { toContactId: 101, toEmail: ANN, status: "approved" });
    h.capHit = true;
    await refusal(deliverEmailDraft({ workspaceId: LSI, userId: REP, draftId: 99 }));
    expect(row("email_drafts", 99).status).toBe("approved");
    expect(h.emails).toHaveLength(0);
  });

  it("classifies transport errors conservatively", () => {
    expect(isDefinitelyNotSent(Object.assign(new Error("x"), { code: "ECONNECTION" }))).toBe(true);
    expect(isDefinitelyNotSent(Object.assign(new Error("x"), { command: "RCPT TO", responseCode: 550 }))).toBe(true);
    expect(isDefinitelyNotSent(Object.assign(new Error("x"), { status: 422 }))).toBe(true);
    expect(isDefinitelyNotSent(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(false);
    expect(isDefinitelyNotSent(Object.assign(new Error("x"), { status: 502 }))).toBe(false);
    expect(isDefinitelyNotSent(new Error("unknown"))).toBe(false);
  });

  it("a claim whose sender died becomes 'failed' after 30 minutes, never sendable again", async () => {
    draft(100, { status: "sending", sendClaimedAt: new Date(now() - 31 * MIN) });
    draft(101, { status: "sending", sendClaimedAt: new Date(now() - 5 * MIN) });
    expect(await sweepStaleSendingDrafts(h.db)).toBe(1);
    expect(row("email_drafts", 100).status).toBe("failed");
    expect(row("email_drafts", 101).status).toBe("sending");
  });

  it("approve, reject, edit and delete refuse a sent draft (approving one queued it again)", async () => {
    draft(102, { status: "sent", sentAt: new Date(), toEmail: ANN });
    const c = caller(REP).emailDrafts;
    for (const p of [c.approve({ id: 102 }), c.reject({ id: 102 }), c.update({ id: 102, subject: "x", body: "y" }), c.delete({ id: 102 })]) {
      expect((await refusal(p)).code).toBe("CONFLICT");
    }
    expect(row("email_drafts", 102)).toMatchObject({ status: "sent", subject: "Hello" });
    // …and still act on one awaiting review.
    draft(103, { status: "pending_review" });
    await c.approve({ id: 103 });
    expect(row("email_drafts", 103).status).toBe("approved");
  });
});

/* ═══ The SMTP paths (O15, O16) ═══════════════════════════════════════════ */

describe("the SMTP draft paths claim each draft and always carry an unsubscribe", () => {
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

  it("sendDraft: one email for two clicks, with the footer and RFC 8058 headers", async () => {
    smtpConfig();
    draft(110, { toEmail: ANN, status: "approved" });
    const c = caller(REP).smtpConfig;
    const both = await Promise.allSettled([c.sendDraft({ draftId: 110 }), c.sendDraft({ draftId: 110 })]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(h.smtp).toHaveLength(1);
    expect(h.smtp[0].headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(h.smtp[0].html).toContain("Unsubscribe</a>");
    expect(h.smtp[0].text).toMatch(/Unsubscribe: https?:\/\//);
    expect(row("email_drafts", 110).status).toBe("sent");
  });

  it("sendDraft: an ambiguous SMTP error leaves it failed, not approved", async () => {
    smtpConfig();
    draft(111, { toEmail: ANN, status: "approved" });
    h.smtpFail = new Error("Connection closed unexpectedly");
    await refusal(caller(REP).smtpConfig.sendDraft({ draftId: 111 }));
    expect(row("email_drafts", 111).status).toBe("failed");
  });

  it('"Send approved" claims per draft, re-checks pause, and every message has headers and a footer', async () => {
    smtpConfig();
    rows("workspace_settings").push({ id: 1, workspaceId: LSI, emailUnsubscribeHeader: false, emailSequenceOptOutEnabled: false, emailOpenTracking: true, emailClickTracking: true });
    draft(120, { toEmail: ANN, status: "approved" });
    draft(121, { toEmail: "bo@beta.example", status: "sending", sendClaimedAt: new Date() }); // another sender has it
    const res = await caller(ADMIN).smtpConfig.sendBulkApproved({});
    expect(res.sent).toBe(1);
    expect(h.smtp).toHaveLength(1);
    expect(h.smtp[0].headers["List-Unsubscribe"]).toContain("/api/track/unsubscribe/");
    expect(h.smtp[0].html).toContain("Unsubscribe</a>");
    expect(row("email_drafts", 121).status).toBe("sending");

    // Two admins pressing it at once send each draft once.
    draft(123, { toEmail: "bo@beta.example", status: "approved" });
    const runs = await Promise.all([caller(ADMIN).smtpConfig.sendBulkApproved({}), caller(ADMIN).smtpConfig.sendBulkApproved({})]);
    expect(runs[0].sent + runs[1].sent).toBe(1);
    expect(h.smtp).toHaveLength(2);

    // Pause, the daily cap and the claim are asked per draft, before its send.
    const src = readFileSync(join(__dirname, "routers", "smtpConfig.ts"), "utf8");
    const loop = src.slice(src.indexOf("for (const draft of drafts)"), src.indexOf("await sleep(1000)"));
    expect(loop.indexOf("isOutboundPaused(")).toBeLessThan(loop.indexOf("transporter.sendMail("));
    expect(loop.indexOf("assertSendAllowed(")).toBeLessThan(loop.indexOf("transporter.sendMail("));
    expect(loop.indexOf("claimDraftForSend(")).toBeLessThan(loop.indexOf("transporter.sendMail("));
  }, 20_000);
});

/* ═══ Unsubscribe links ask before they act (O15) ══════════════════════════ */

describe("the tracked unsubscribe link asks before it acts, and escapes the address", () => {
  async function serve() {
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    registerEmailTrackingRoutes(app);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it("GET shows a form and writes nothing; POST records it", async () => {
    vi.useRealTimers();
    draft(130, { toEmail: '"><script>alert(1)</script>@x.example', status: "sent", trackingToken: "tok-130" });
    const s = await serve();
    try {
      const page = await (await fetch(`${s.base}/api/track/unsubscribe/tok-130`)).text();
      expect(rows("email_suppressions")).toHaveLength(0);
      expect(page).toContain('method="POST"');
      expect(page).not.toContain("<script>alert(1)</script>");
      expect(page).toContain("&lt;script&gt;");

      const done = await fetch(`${s.base}/api/track/unsubscribe/tok-130`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click",
      });
      expect(done.status).toBe(200);
      expect(rows("email_suppressions")).toHaveLength(1);
      expect(rows("email_suppressions")[0]).toMatchObject({ reason: "unsubscribe", source: "one_click_header", draftId: 130 });
      expect(await done.text()).not.toContain("<script>alert(1)</script>");
    } finally {
      await s.close();
    }
  });
});

/* ═══ LinkedIn steps: the gate on every path, the owner's account (O11, O12) ═ */

describe("sequence LinkedIn steps go through the limit gate and the owner's account", () => {
  it("a DM the gate refuses is HELD on its step, not sent and not skipped", async () => {
    h.liVerdict = { allowed: false, reason: "daily_cap", message: "Daily message cap reached", retryAfterMs: 3 * 3_600_000 };
    seq(1, [{ type: "linkedin_dm", body: "Hi Ann" }, email()]);
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(h.dms).toHaveLength(0);
    expect(h.gateChecks[0]).toMatchObject({ kind: "message", unipileAccountId: "acc-rep" });
    expect(row("enrollments", 11).currentStep).toBe(0);
    expect(new Date(row("enrollments", 11).nextActionAt).getTime()).toBe(T0 + 3 * 3_600_000);
  });

  it("an invite the gate refuses is held too (it used to be skipped for good)", async () => {
    h.liVerdict = { allowed: false, reason: "weekly_cap", message: "Weekly invite cap", retryAfterMs: null };
    seq(1, [{ type: "linkedin_invite", note: "Hi" }, email()]);
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(h.invites).toHaveLength(0);
    expect(row("enrollments", 11).currentStep).toBe(0);
  });

  it("sends from the sequence owner's account and records the action", async () => {
    // acc-admin is the first LinkedIn account the database returns; the
    // owner's is the second. "Any account, limit 1" picked the first.
    seq(1, [{ type: "linkedin_dm", body: "Hi Ann" }], { ownerUserId: REP });
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(h.dms[0]).toMatchObject({ accountId: "acc-rep", attendeesIds: ["ann-lee"] });
    expect(h.liRecorded[0]).toMatchObject({ kind: "message", unipileAccountId: "acc-rep" });
  });

  it("an assigned rep's account wins over the owner's", async () => {
    seq(1, [{ type: "linkedin_dm", body: "Hi Ann" }], { ownerUserId: REP, assignedToUserId: ADMIN });
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(h.dms[0].accountId).toBe("acc-admin");
  });

  it("never invites someone already invited", async () => {
    rows("unipile_invites").push({ id: 1, workspaceId: LSI, userId: REP, unipileAccountId: "acc-rep", recipientProviderId: "ann-lee", status: "pending" });
    seq(1, [{ type: "linkedin_invite", note: "Hi" }, email()]);
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(h.invites).toHaveLength(0);
    expect(row("enrollments", 11).currentStep).toBe(1);
  });
});

/* ═══ The engine's older guarantees, on the real query ═════════════════════
   Moved from sequenceEngine.test.ts on 2026-10-26: those ran against a queued
   chain of mocked selects, which cannot express a join, an ordered page or a
   conditional claim. Same guarantees, same reasons. */

describe("the engine's older guarantees, on the real query", () => {
  it("honours the configured wait duration (regression: days vs waitDays)", async () => {
    // The engine read `step.waitDays`; the schema stores `{type:"wait", days}`,
    // so every wait fell through to 1 day.
    seq(1, [{ type: "wait", days: 3 }, { type: "task", body: "Call them about the proposal." }]);
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    const days = (new Date(row("enrollments", 11).nextActionAt).getTime() - now()) / DAY;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThan(3.1);
  });

  it("derives a task title from the step body instead of a generic label", async () => {
    seq(1, [{ type: "task", body: "Call about the renewal. Ask about seat count." }]);
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(rows("tasks")[0]).toMatchObject({
      title: "Call about the renewal",
      description: "Call about the renewal. Ask about seat count.",
      relatedType: "contact",
      relatedId: 101,
    });
  });

  it("never queues an email with an empty body, and still advances", async () => {
    seq(1, [{ type: "email", subject: "", body: "" }, wait(2)]);
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(drafts()).toHaveLength(0);
    expect(row("enrollments", 11).currentStep).toBe(1);
  });

  it("advances past a step type it cannot execute instead of stalling forever", async () => {
    seq(1, [{ type: "sms", body: "Quick nudge" }, email()]);
    enr(11, 1, { contactId: 101 });
    const res = await processEnrollments();
    expect(res.processed).toBe(1);
    expect(row("enrollments", 11).currentStep).toBe(1);
    expect(new Date(row("enrollments", 11).nextActionAt).getTime()).toBeGreaterThan(now());
  });

  it("advances past a step with no type at all", async () => {
    seq(1, [{}, { type: "task", body: "Call them" }]);
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    expect(row("enrollments", 11).currentStep).toBe(1);
  });

  it("finishes the enrollment when the unexecutable step is the last one", async () => {
    seq(1, [{ type: "voice" }]);
    enr(11, 1, { contactId: 101 });
    await processEnrollments();
    setNow(T0 + 5 * MIN);
    await processEnrollments();
    expect(row("enrollments", 11).status).toBe("finished");
  });

  it("marks the enrollment finished when all steps are done", async () => {
    seq(1, [email("Step 1"), { type: "wait", days: 2 }]);
    enr(11, 1, { contactId: 101 }, { currentStep: 2 });
    const res = await processEnrollments();
    expect(res.processed).toBe(1);
    expect(row("enrollments", 11).status).toBe("finished");
  });

  it("does not finish while the last email is still waiting to go out", async () => {
    seq(1, [email("only")]);
    enr(11, 1, { contactId: 101 }, { currentStep: 1 });
    draft(140, { enrollmentId: 11, sequenceId: 1, status: "pending_review" });
    await processEnrollments();
    // Still active, so a reply pauses it and holds the draft.
    expect(row("enrollments", 11).status).toBe("active");
  });
});

/* ═══ The two writes that happened just from opening a page (L1, L2) ═══════ */

describe("opening a page writes nothing", () => {
  const client = (p: string) => readFileSync(join(__dirname, "..", "client", "src", p), "utf8").replace(/\r\n/g, "\n");

  it("the proposal page snapshots its score from an effect, once a day, never from render (L1)", () => {
    const src = client("pages/usip/ProposalDetail.tsx");
    const fn = src.slice(src.indexOf("function ScoreSparkline"), src.indexOf("if (!history || history.length < 2) return null;"));
    const mutate = fn.indexOf("snapshotMutation.mutate(");
    expect(mutate).toBeGreaterThan(fn.indexOf("useEffect(() => {"));
    expect(fn).toContain("attempted.current = true;");
    expect(fn).toContain("window.localStorage.getItem(key) === today");
    // No retry loop: nothing re-arms the attempt on failure.
    expect(fn).not.toMatch(/isPending|isSuccess/);
  });

  it("the canvas saves edits only — not the sizes and selections React Flow reports on open (L2)", () => {
    const src = client("pages/usip/SequenceCanvas.tsx");
    const nodes = src.slice(src.indexOf("const onNodesChange"), src.indexOf("const onEdgesChange"));
    expect(nodes).toContain('c.type !== "dimensions" && c.type !== "select"');
    expect(nodes).toContain("if (edited) triggerAutosave(");
    const edges = src.slice(src.indexOf("const onEdgesChange"), src.indexOf("const onConnect"));
    expect(edges).toContain('c.type !== "select"');
    expect(src.split("baseVersion: baseVersion.current").length - 1).toBe(2);
  });

  it("a canvas save made on an older version is refused, not written over a teammate's (L2)", async () => {
    seq(1, [email("one")], { status: "paused" });
    const view = await caller(REP).sequences.getCanvas({ id: 1 });
    const nodes = [{ id: "start-1", type: "start" as const, positionX: 0, positionY: 0, data: {} }];
    // A teammate saves first…
    const theirs = await caller(ADMIN).sequences.saveCanvas({ id: 1, nodes, edges: [], baseVersion: view.version });
    expect(theirs.version).not.toBe(view.version);
    // …so the stale view's save is refused, and theirs is still there.
    const mine = await refusal(caller(REP).sequences.saveCanvas({ id: 1, nodes: [], edges: [], baseVersion: view.version }));
    expect(mine.code).toBe("CONFLICT");
    expect(rows("sequence_nodes")).toHaveLength(1);
  });
});

describe("the Emails page shows a draft whose send failed", () => {
  it("the Failed filter reads the draft rows too", () => {
    expect(statusApplies({ status: "failed" } as never, "draft")).toBe(true);
    expect(statusApplies({ status: "sent" } as never, "draft")).toBe(false);
  });
});
