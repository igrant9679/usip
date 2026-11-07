/**
 * Replies are matched by the sent email's full Message-ID (audit 2026-10-20,
 * F5). Matching looked only at email_drafts.trackingToken, varchar(64), so a
 * full RFC Message-ID never matched and the reply attached to the newest
 * draft to that address; campaign (ARE) sends kept no id at all.
 *
 * The poller runs on the SQL fake; adapters, the ARE signal and the counters
 * are mocked, so nothing is sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  db: null as any,
  signals: [] as any[],
  sendRes: { messageId: "trk-1" } as any,
  sent: [] as any[],
  sgCalls: [] as any[],
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./campaignCounters", async (a) => ({ ...(await a<typeof import("./campaignCounters")>()), bumpCampaignCounter: async () => {} }));
vi.mock("./routers/are/execution", async (a) => ({
  ...(await a<typeof import("./routers/are/execution")>()),
  processSignal: async (...args: unknown[]) => { h.signals.push(args); },
}));
vi.mock("./sendLimits", async (a) => ({ ...(await a<typeof import("./sendLimits")>()), assertSendAllowed: async () => {} }));
vi.mock("./mergeVars", async (a) => ({ ...(await a<typeof import("./mergeVars")>()), resolveBookingUrl: async () => "" }));
vi.mock("./emailAdapter", async (a) => ({
  ...(await a<typeof import("./emailAdapter")>()),
  createEmailAdapter: () => ({ sendEmail: async (input: unknown) => { h.sent.push(input); return h.sendRes; } }),
}));
vi.mock("./services/sendgrid", async (a) => ({
  ...(await a<typeof import("./services/sendgrid")>()),
  sendViaSendGrid: async (_key: string, msg: any) => { h.sgCalls.push(msg); return { ok: true, messageId: "sg-api-id" }; },
}));
vi.mock("./services/sendgridKey", async (a) => ({ ...(await a<typeof import("./services/sendgridKey")>()), getWorkspaceSendgridKey: async () => "SG.test-key" }));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: async () => ({ messageId: "<nm-0001@lsi.example>" }) }) },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { processInboundReply } from "./inboundReplyPoller";
import { deliverEmailDraft } from "./routers/sequences";
import { matchSentByMessageId, recordBridgedSendMessageId, referencedMessageIds } from "./services/email/messageIds";
import { ImapSmtpAdapter, SendGridAdapter } from "./emailAdapter";

const WS = 2;
const OTHER = 4;
const ANN = "ann@acme.example";
/** A real-looking Message-ID, longer than the 64 characters trackingToken holds. */
const LONG = "<CAH8y-1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8@mail.gmail-relay.lsi.example>";
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);

function draft(id: number, over: Record<string, unknown> = {}) {
  rows("email_drafts").push({
    id, workspaceId: WS, subject: "Hello", body: "Hi", toContactId: null, toLeadId: null, toProspectId: null,
    toEmail: ANN, sequenceId: null, enrollmentId: null, status: "sent", aiGenerated: false, createdByUserId: 1,
    sentAt: new Date(Date.now() - (100 - id) * 60_000), sendingAccountId: 1, trackingToken: null, messageId: null,
    firstReplyAt: null, sendError: null, sendClaimedAt: null, ...over,
  });
}
const reply = (over: Record<string, unknown> = {}) => processInboundReply({
  workspaceId: WS, sendingAccountId: 1, userId: 1, fromEmail: ANN, fromName: "Ann", subject: "Re: Hello",
  bodyText: "Sounds good", bodyHtml: "", messageId: `<r${Math.random()}@acme.example>`, inReplyTo: "", references: "",
  receivedAt: new Date(), ...over,
} as any);
const lastReply = () => rows("email_replies").at(-1);

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.signals = [];
  h.sent = [];
  h.sgCalls = [];
  h.sendRes = { messageId: "trk-1" };
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null });
  rows("users").push({ id: 1, name: "Rep", email: "rep@lsi.example", emailSignature: null });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: 1, role: "admin", deactivatedAt: null });
  rows("sending_accounts").push({ id: 1, workspaceId: WS, name: "Rep box", fromEmail: "rep@lsi.example", fromName: "Rep", enabled: true, provider: "smtp", unipileAccountId: null });
});

describe("the ids a reply names", () => {
  it("reads In-Reply-To first, then References from the parent back, bare and once each", () => {
    expect(referencedMessageIds("<b@x>", "<a@x> <b@x>")).toEqual(["b@x", "a@x"]);
    expect(referencedMessageIds("", "<a@x>\r\n <b@x>")).toEqual(["b@x", "a@x"]);
    expect(referencedMessageIds(undefined, undefined)).toEqual([]);
  });
});

describe("a reply attaches to the send it answers, by full Message-ID (F5)", () => {
  it("matches a Message-ID longer than 64 characters, not the newest draft to that address", async () => {
    draft(10, { messageId: LONG, trackingToken: LONG.slice(0, 64) });
    draft(11); // newer, same address: the old fallback's pick
    await reply({ inReplyTo: LONG });
    expect(lastReply().draftId).toBe(10);
    expect(row("email_drafts", 10).firstReplyAt).toBeTruthy();
    expect(row("email_drafts", 11).firstReplyAt).toBeNull();
  });

  it("matches through References when In-Reply-To is missing", async () => {
    draft(10, { messageId: LONG });
    draft(11);
    await reply({ references: `<root@acme.example> ${LONG}` });
    expect(lastReply().draftId).toBe(10);
  });

  it("matches through the send's log row when the draft has no Message-ID of its own", async () => {
    draft(10);
    draft(11);
    rows("email_log").push({ id: 1, workspaceId: WS, source: "sequence", draftId: 10, messageId: LONG, rfcMessageId: null, sentAt: new Date() });
    await reply({ inReplyTo: LONG });
    expect(lastReply().draftId).toBe(10);
  });

  it("never matches another workspace's send", async () => {
    draft(10, { workspaceId: OTHER, messageId: LONG });
    draft(11);
    await reply({ inReplyTo: LONG });
    expect(lastReply().draftId).toBe(11); // the address fallback, inside this workspace
  });

  it("keeps the tracking-id match as a fallback", async () => {
    draft(10, { trackingToken: "unipile-trk-22" });
    draft(11);
    await reply({ inReplyTo: "<unipile-trk-22>" });
    expect(lastReply().draftId).toBe(10);
  });

  it("matches a bridged mailbox's send through its sent copy's Message-ID", async () => {
    draft(10, { trackingToken: "trk-77" });
    draft(11);
    rows("unipile_emails_cache").push({ id: 1, workspaceId: WS, unipileAccountId: "U1", emailId: "e1", providerMessageId: LONG, trackingId: "trk-77" });
    await reply({ inReplyTo: LONG });
    expect(lastReply().draftId).toBe(10);
  });

  it("a campaign reply goes to the campaign whose send it answers, not the newest queue row for that address", async () => {
    rows("prospect_queue").push(
      { id: 501, workspaceId: WS, campaignId: 7, email: ANN },
      { id: 502, workspaceId: WS, campaignId: 8, email: ANN }, // newer, other campaign
    );
    rows("are_execution_queue").push({ id: 900, workspaceId: WS, campaignId: 7, prospectQueueId: 501, stepIndex: 0, channel: "email", status: "sent", externalId: LONG, scheduledAt: new Date() });
    await reply({ inReplyTo: LONG });
    expect(lastReply()).toMatchObject({ prospectQueueId: 501, campaignId: 7 });
    // With no Message-ID it still falls back to the newest row, as before.
    await reply({ inReplyTo: "" });
    expect(lastReply()).toMatchObject({ prospectQueueId: 502, campaignId: 8 });
  });
});

describe("every send keeps its Message-ID (F5)", () => {
  it("a draft send stores the full Message-ID the adapter reports, beside the tracking id", async () => {
    draft(20, { status: "approved", sentAt: null, trackingToken: null });
    h.sendRes = { messageId: "trk-20", rfcMessageId: LONG };
    await deliverEmailDraft({ workspaceId: WS, userId: 1, draftId: 20, claimFrom: ["approved"] });
    expect(row("email_drafts", 20)).toMatchObject({ status: "sent", trackingToken: "trk-20", messageId: LONG });
  });

  it("the SMTP adapter reports the Message-ID header nodemailer wrote", async () => {
    const res = await new ImapSmtpAdapter({ id: 1, smtpHost: "smtp.x", smtpUsername: "u", smtpPassword: "p" } as any)
      .sendEmail({ to: ANN, subject: "s", bodyHtml: "<p>x</p>", fromEmail: "rep@lsi.example" });
    expect(res.rfcMessageId).toBe("<nm-0001@lsi.example>");
  });

  it("SendGrid sends carry our own Message-ID header, and the adapter reports it", async () => {
    const res = await new SendGridAdapter({ id: 1, workspaceId: WS, fromEmail: "rep@lsi.example", sendgridApiKeyEnc: null, replyTo: "r@lsi.example" } as any)
      .sendEmail({ to: ANN, subject: "s", bodyHtml: "<p>x</p>", fromEmail: "rep@lsi.example", headers: { "List-Unsubscribe": "<https://u>" } });
    expect(h.sgCalls).toHaveLength(1);
    expect(h.sgCalls[0].headers["Message-ID"]).toMatch(/^<[0-9a-f-]{36}@lsi\.example>$/);
    expect(h.sgCalls[0].headers["List-Unsubscribe"]).toBe("<https://u>");
    expect(res.rfcMessageId).toBe(h.sgCalls[0].headers["Message-ID"]);
  });

  it("a bridged mailbox's mail_sent webhook stamps the Message-ID on its draft and log row", async () => {
    draft(30, { trackingToken: "trk-30" });
    draft(31, { workspaceId: OTHER, trackingToken: "trk-30" });
    rows("email_log").push({ id: 2, workspaceId: WS, source: "sequence", draftId: 30, messageId: "trk-30", rfcMessageId: null, sentAt: new Date() });
    await recordBridgedSendMessageId(h.db, WS, "trk-30", LONG);
    expect(row("email_drafts", 30).messageId).toBe(LONG);
    expect(row("email_drafts", 31).messageId).toBeNull();
    expect(rows("email_log")[0].rfcMessageId).toBe(LONG);
    const src = readFileSync(join(__dirname, "unipileWebhook.ts"), "utf8");
    const block = src.slice(src.indexOf("The sent copy's Message-ID (mail_sent)"), src.indexOf("Bounce detection (mail_received only)"));
    expect(block).toContain('event === "mail_sent" && payload.tracking_id && payload.message_id');
    expect(block).toContain("recordBridgedSendMessageId(db, acct.workspaceId, payload.tracking_id, payload.message_id)");
  });

  it("the adapter wrapper logs the header, campaign sends keep it, and CRM sends store it on their draft", () => {
    const adapter = readFileSync(join(__dirname, "emailAdapter.ts"), "utf8");
    expect(adapter).toContain("rfcMessageId: result?.rfcMessageId ?? null");
    const delivery = readFileSync(join(__dirname, "emailDelivery.ts"), "utf8");
    const pool = delivery.slice(delivery.indexOf("export async function sendCampaignEmailViaPool"), delivery.indexOf("export async function choosePoolAccount"));
    expect(pool).toContain("sentMessageId = (sent?.rfcMessageId || sent?.messageId) || undefined;");
    expect(pool).toContain("messageId: sentMessageId };");
    const engine = readFileSync(join(__dirname, "areEngine.ts"), "utf8");
    const sentArm = engine.slice(engine.indexOf("if (sendRes.ok) {"), engine.indexOf("} else if (sendRes.blocked) {"));
    expect(sentArm).toContain("externalId: sendRes.messageId ? sendRes.messageId.slice(0, 256) : null,");
    const crm = readFileSync(join(__dirname, "routers", "crm.ts"), "utf8");
    expect(crm.split("messageId: sentRfcMessageId ? sentRfcMessageId.slice(0, 500) : null,").length - 1).toBe(2);
  });

  it("the lookup is scoped to the workspace at every step", async () => {
    rows("email_log").push({ id: 3, workspaceId: OTHER, source: "campaign", draftId: null, prospectQueueId: 1, campaignId: 1, messageId: LONG, rfcMessageId: LONG, sentAt: new Date() });
    rows("are_execution_queue").push({ id: 1, workspaceId: OTHER, campaignId: 1, prospectQueueId: 1, externalId: LONG, scheduledAt: new Date() });
    rows("unipile_emails_cache").push({ id: 2, workspaceId: OTHER, unipileAccountId: "U9", emailId: "e9", providerMessageId: LONG, trackingId: "t9" });
    draft(40, { workspaceId: OTHER, trackingToken: "t9", messageId: LONG });
    const m = await matchSentByMessageId(h.db, WS, [LONG.slice(1, -1)]);
    expect(m).toEqual({ draft: null, queue: null, via: null });
  });
});
