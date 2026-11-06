/**
 * The Emails page, audit 2026-10-20 O25 and O47.
 *
 * O47: the row's Send (emailDrafts.send → deliverEmailDraft) and "Send
 * approved" (smtpConfig.sendBulkApproved) were two delivery paths: different
 * mailbox, different footer builder. "Send approved" now sends each draft
 * through deliverEmailDraft, so the same draft leaves the same way whichever
 * button is pressed, and it still sends only approved drafts. The button is
 * admin-only on the server and is now hidden from reps.
 *
 * O25: the page said auto-send sends "AI drafts" by lead score and that
 * approved drafts are sent by auto-send or the sequence engine. Auto-send
 * takes only sequence drafts still awaiting review, a prospect has no score,
 * and approving takes a draft out of it. The copy now says so.
 *
 * Real routers over an in-memory database that evaluates their SQL; the
 * mailbox adapter is a recording mock, so nothing is sent anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, paused: false, emails: [] as any[] }));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/outboundPause", async (a) => ({
  ...(await a<typeof import("./services/outboundPause")>()),
  isOutboundPaused: async () => h.paused,
  assertOutboundNotPaused: async () => {
    const { TRPCError } = await import("@trpc/server");
    if (h.paused) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Outbound is paused" });
  },
}));
vi.mock("./emailAdapter", async (a) => ({
  ...(await a<typeof import("./emailAdapter")>()),
  createEmailAdapter: (account: any) => ({ sendEmail: async (input: any) => { h.emails.push({ ...input, accountId: account.id }); return { messageId: `mid-${h.emails.length}` }; } }),
}));
vi.mock("./sendLimits", async (a) => ({ ...(await a<typeof import("./sendLimits")>()), assertSendAllowed: async () => {}, accountsSentToday: async () => new Map<number, number>() }));
vi.mock("./mergeVars", async (a) => ({ ...(await a<typeof import("./mergeVars")>()), resolveBookingUrl: async () => "", buildMergeContextFromDb: async () => ({}) }));
vi.mock("./campaignCounters", async (a) => ({ ...(await a<typeof import("./campaignCounters")>()), bumpCampaignCounter: async () => {} }));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ verify: async () => true, sendMail: async () => { throw new Error("the workspace SMTP transporter must not be used"); } }) },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

const LSI = 2;
const ADMIN = 20;
const REP = 21;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
const read = (rel: string) => readFileSync(rel, "utf8").replace(/\r\n/g, "\n");

function caller(userId: number) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(LSI) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
function draft(id: number, over: Record<string, unknown> = {}) {
  rows("email_drafts").push({
    id, workspaceId: LSI, subject: "Hello {{firstName}}", body: "Hi {{firstName}}", toContactId: null, toLeadId: null,
    toProspectId: null, toEmail: null, sequenceId: null, enrollmentId: null, pipelineJobId: null, status: "approved",
    aiGenerated: false, createdByUserId: REP, reviewedByUserId: null, createdAt: new Date(), sentAt: null,
    sendingAccountId: null, stepIndex: null, abVariantId: null, firstReplyAt: null, trackingToken: null,
    sendError: null, sendClaimedAt: null, openCount: 0, machineOpenCount: 0, clickCount: 0, ...over,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T15:00:00Z"));
  h.db = makeSqlFakeDb({ realMembers: true });
  h.paused = false;
  h.emails = [];
  rows("workspaces").push({ id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  const user = (id: number, mail: string) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: mail, loginMethod: "password", role: "user",
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN, "admin@lsi.example"), user(REP, "rep@lsi.example"));
  const member = (id: number, userId: number, role: string) => ({
    id, workspaceId: LSI, userId, role, title: null, quota: null, deactivatedAt: null, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(member(1, ADMIN, "admin"), member(2, REP, "rep"));
  rows("sending_accounts").push({
    id: 7, workspaceId: LSI, name: "Team box", fromEmail: "team@lsi.example", fromName: "Team", enabled: true,
    provider: "smtp", dailySendLimit: 500, unipileAccountId: null, signature: null, optOutEnabled: false, optOutMessage: null,
  });
  rows("contacts").push(
    { id: 101, workspaceId: LSI, firstName: "Ann", lastName: "Lee", email: "ann@acme.example", accountId: null, title: null },
    { id: 102, workspaceId: LSI, firstName: "Ann", lastName: "Lee", email: "ann2@acme.example", accountId: null, title: null },
  );
  // A workspace SMTP config exists: the old "Send approved" sent through it.
  rows("smtp_configs").push({ id: 1, workspaceId: LSI, host: "smtp.lsi.example", port: 587, secure: false, username: "u", encryptedPassword: "x:y:z", fromEmail: "smtp@lsi.example", fromName: "SMTP", replyTo: null, enabled: true });
});
afterEach(() => { vi.useRealTimers(); });

/** What a recipient would see that depends on the path, with the address swapped out. */
const shape = (m: any, email: string) => ({
  from: m.fromEmail, accountId: m.accountId, subject: m.subject,
  // The unsubscribe link is signed per recipient; everything around it must match.
  html: String(m.bodyHtml).split(email).join("<to>").replace(/\/api\/unsubscribe\/[^"]+/g, "/api/unsubscribe/<token>"),
  headerKeys: Object.keys(m.headers ?? {}).sort(),
});

describe("O47: one delivery path for the row's Send and Send approved", () => {
  it("the same draft leaves from the same mailbox with the same footer, whichever button sent it", async () => {
    draft(1, { toContactId: 101, toEmail: "ann@acme.example" });
    draft(2, { toContactId: 102, toEmail: "ann2@acme.example" });
    await caller(ADMIN).emailDrafts.send({ id: 1 });
    const res = await caller(ADMIN).smtpConfig.sendBulkApproved({ draftIds: [2] });
    expect(res).toMatchObject({ sent: 1, failed: 0, skipped: 0 });
    expect(h.emails).toHaveLength(2);
    expect(shape(h.emails[1], "ann2@acme.example")).toEqual(shape(h.emails[0], "ann@acme.example"));
    expect(h.emails[1]).toMatchObject({ fromEmail: "team@lsi.example", subject: "Hello Ann" });
    expect(h.emails[1].bodyHtml).toContain("Unsubscribe</a>");
    expect(h.emails[1].headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect([row("email_drafts", 1).status, row("email_drafts", 2).status]).toEqual(["sent", "sent"]);
  }, 20_000);

  it("sends only approved drafts: nothing awaiting review, rejected or already sent", async () => {
    draft(3, { toEmail: "a@x.example", status: "pending_review" });
    draft(4, { toEmail: "b@x.example", status: "ai_pending_review" });
    draft(5, { toEmail: "c@x.example", status: "rejected" });
    draft(6, { toEmail: "d@x.example", status: "sent", sentAt: new Date() });
    const res = await caller(ADMIN).smtpConfig.sendBulkApproved({});
    expect(res).toMatchObject({ sent: 0, failed: 0, skipped: 0 });
    expect(h.emails).toHaveLength(0);
    expect([3, 4, 5].map((id) => row("email_drafts", id).status)).toEqual(["pending_review", "ai_pending_review", "rejected"]);
  });

  it("a suppressed recipient is not sent, and is reported as not sent", async () => {
    draft(8, { toEmail: "gone@x.example" });
    rows("email_suppressions").push({ id: 1, workspaceId: LSI, email: "gone@x.example", reason: "unsubscribe", source: "manual", createdAt: new Date() });
    const res = await caller(ADMIN).smtpConfig.sendBulkApproved({});
    expect(res).toMatchObject({ sent: 0, skipped: 1 });
    expect(h.emails).toHaveLength(0);
  });

  it("paused: refused before anything is read or sent", async () => {
    draft(9, { toEmail: "e@x.example" });
    h.paused = true;
    await expect(caller(ADMIN).smtpConfig.sendBulkApproved({})).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(h.emails).toHaveLength(0);
    expect(row("email_drafts", 9).status).toBe("approved");
  });

  it("a rep is refused by the server, and the page does not offer them the button", async () => {
    draft(10, { toEmail: "f@x.example" });
    await expect(caller(REP).smtpConfig.sendBulkApproved({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    const page = read("client/src/pages/usip/EmailsV2.tsx");
    const button = page.slice(page.indexOf("{isAdmin && ("), page.indexOf("</ConfirmButton>", page.indexOf("{isAdmin && (")));
    expect(button).toContain("onConfirm={() => sendBulkApproved.mutate({})}");
    expect(page.split("sendBulkApproved.mutate(").length - 1).toBe(1);
    expect(page).toContain("const { isAdmin } = useWorkspaceRole();");
  });
});

describe("O25: the Emails page says what auto-send and approving do", () => {
  const page = read("client/src/pages/usip/EmailsV2.tsx");
  const seq = read("server/routers/sequences.ts");
  const autoSend = seq.slice(seq.indexOf("export async function autoSendForAllWorkspaces"), seq.indexOf("export const emailDraftsRouter"));

  it("what auto-send does: sequence drafts awaiting review, scored by lead or contact, never an approved one", () => {
    expect(autoSend).toContain('eq(emailDrafts.status, "pending_review")');
    expect(autoSend).toContain("isNotNull(emailDrafts.sequenceId)");
    expect(autoSend).toContain("CASE WHEN ${emailDrafts.toLeadId} IS NOT NULL THEN ${leads.score} ELSE ${contacts.relStrengthScore} END");
    expect(autoSend).toContain('claimFrom: ["pending_review"]');
    expect(autoSend).not.toContain('"approved"]');
  });

  it("the switch says so, and no longer promises AI drafts by lead score", () => {
    expect(page).not.toContain("AI drafts send automatically when lead score");
    expect(page).toContain("sequence drafts still awaiting review send on their own");
    expect(page).toContain("Drafts to prospects have no score, so they wait for you.");
    expect(page).toContain("Approving a draft takes it out of auto-send");
  });

  it("Approve all no longer says approved drafts are sent by auto-send or the sequence engine", () => {
    expect(page).not.toContain("Approved drafts are sent by auto-send, the sequence engine");
    expect(page).toContain("auto-send does not pick up approved drafts");
  });
});
