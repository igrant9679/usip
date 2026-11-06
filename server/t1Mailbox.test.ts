/**
 * My Mailbox, T1 batch (2026-11-06): tracker items 1 and 5 (no way to
 * compose, and no word on what to connect), audit rows O34 (compose ignored
 * the account's switch and suppression), O35 (Forward dropped the original,
 * Reply could address yourself, References lost the parent) and O59 (plain
 * text sent as markup, no attachment limit).
 *
 * The router runs through createCaller on the SQL fake; the adapter is
 * mocked, so nothing is sent. The page is pinned by rendering its empty state
 * and by reading the send and reply paths.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, sent: [] as any[] };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./emailAdapter", async (a) => ({
  ...(await a<typeof import("./emailAdapter")>()),
  createEmailAdapter: () => ({ sendEmail: async (input: unknown) => { h.sent.push(input); return { messageId: "m1" }; } }),
}));
vi.mock("./sendLimits", async (a) => ({ ...(await a<typeof import("./sendLimits")>()), assertSendAllowed: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import {
  MAILBOX_ATTACHMENT_LIMIT_BYTES, base64Bytes, composeBodyHtml, forwardedBlock, replyAddressing,
} from "@shared/mailCompose";
import { NoMailboxConnected } from "../client/src/components/usip/NoMailboxConnected";

const WS = 2;
const ME = "rep@velocity.test";
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];

function caller() {
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: ME, name: "Rep", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e; }
  throw new Error("expected a refusal");
}
const base = { accountId: 7, subject: "Hello", bodyHtml: "<p>Hi</p>", bodyText: "Hi" };

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  h.sent = [];
  rows("sending_accounts").push({ id: 7, workspaceId: WS, name: "Rep", fromEmail: ME, provider: "outlook_oauth", unipileAccountId: "U1", enabled: true });
  rows("unipile_accounts").push({ id: 1, workspaceId: WS, userId: 1, unipileAccountId: "U1", provider: "OUTLOOK" });
  rows("users").push({ id: 1, email: ME, emailSignature: "Rep Name" });
});

/* ── O34: the account's switch and suppression ───────────────────────────── */

describe("compose and reply refuse what the account or the recipient rules out (O34)", () => {
  it("refuses a mailbox switched off in Sending Accounts, and sends nothing", async () => {
    rows("sending_accounts")[0].enabled = false;
    const e1 = await refusal(caller().mailbox.sendNew({ ...base, to: "ana@client.test" }));
    expect(e1.code).toBe("PRECONDITION_FAILED");
    expect(e1.message).toContain("switched off in Sending Accounts");
    const e2 = await refusal(caller().mailbox.sendReply({ ...base, threadId: "t", to: "ana@client.test" }));
    expect(e2.code).toBe("PRECONDITION_FAILED");
    expect(h.sent).toEqual([]);
  });

  it("refuses an address on the suppression list, naming it and the reason", async () => {
    rows("email_suppressions").push({ id: 1, workspaceId: WS, email: "ana@client.test", reason: "unsubscribe" });
    const e = await refusal(caller().mailbox.sendNew({ ...base, to: "ana@client.test" }));
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toContain("ana@client.test");
    expect(e.message).toContain("unsubscribe");
    expect(h.sent).toEqual([]);
  });

  it("checks cc on a reply too, with names around the address", async () => {
    rows("are_suppression_list").push({ id: 1, workspaceId: WS, email: "bo@client.test", linkedinUrl: null, companyDomain: null, reason: "do_not_contact" });
    const e = await refusal(caller().mailbox.sendReply({ ...base, threadId: "t", to: "Ana <ana@client.test>", cc: "Bo <bo@client.test>" }));
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toContain("bo@client.test");
    expect(h.sent).toEqual([]);
  });

  it("does not refuse a person because their company's domain is on the do-not-prospect list", async () => {
    rows("are_suppression_list").push({ id: 1, workspaceId: WS, email: null, linkedinUrl: null, companyDomain: "client.test", reason: "existing_customer" });
    await caller().mailbox.sendNew({ ...base, to: "ana@client.test" });
    expect(h.sent).toHaveLength(1);
  });

  it("sends from a switched-on mailbox to an address nobody suppressed", async () => {
    await caller().mailbox.sendNew({ ...base, to: "ana@client.test" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe("ana@client.test");
  });

  it("lists whether each mailbox is switched on, so the page can say so before a send", async () => {
    rows("sending_accounts")[0].enabled = false;
    const listSrc = read("server/routers/mailbox.ts");
    const block = listSrc.slice(listSrc.indexOf("listAccounts: workspaceProcedure"), listSrc.indexOf("locateReply: workspaceProcedure"));
    expect(block).toContain("enabled: sendingAccounts.enabled");
    expect(block).toContain("enabled: a.enabled !== false");
  });
});

/* ── O59: escaping and the attachment limit ──────────────────────────────── */

describe("plain text is sent as text and attachments have a limit (O59)", () => {
  it("escapes a plain-text body and leaves the editor's HTML alone", () => {
    expect(composeBodyHtml("Q3 < Q4 & up\nthanks")).toBe("<p>Q3 &lt; Q4 &amp; up<br>thanks</p>");
    expect(composeBodyHtml("<p>a &lt; b</p>")).toBe("<p>a &lt; b</p>");
  });

  it("the page builds the HTML part with it, not by turning newlines into <br/>", () => {
    const src = read("client/src/pages/usip/Mailbox.tsx");
    const send = src.slice(src.indexOf("function handleSend()"), src.indexOf("function regenerateAI()"));
    expect(send).toContain("const bodyHtml = composeBodyHtml(body);");
    expect(send).not.toContain('body.replace(/\\n/g, "<br/>")');
  });

  it("refuses attachments past the limit on the server", async () => {
    const big = "A".repeat(Math.ceil(((MAILBOX_ATTACHMENT_LIMIT_BYTES + 1024) * 4) / 3));
    expect(base64Bytes(big)).toBeGreaterThan(MAILBOX_ATTACHMENT_LIMIT_BYTES);
    const e = await refusal(caller().mailbox.sendNew({ ...base, to: "ana@client.test", attachments: [{ filename: "a.bin", contentType: "application/octet-stream", content: big }] }));
    expect(e.code).toBe("PAYLOAD_TOO_LARGE");
    expect(h.sent).toEqual([]);
    await caller().mailbox.sendNew({ ...base, to: "ana@client.test", attachments: [{ filename: "a.txt", contentType: "text/plain", content: "aGVsbG8=" }] });
    expect(h.sent).toHaveLength(1);
  });

  it("the page refuses files past the limit before reading them", () => {
    const src = read("client/src/pages/usip/Mailbox.tsx");
    const pick = src.slice(src.indexOf("function handleFileSelect("), src.indexOf("function removeAttachment("));
    expect(pick).toContain("attachmentLimitProblem(total)");
    expect(pick.slice(0, pick.indexOf("files.forEach(")).includes("return;")).toBe(true);
  });
});

/* ── O35: forward, reply, references ─────────────────────────────────────── */

describe("Forward carries the original and Reply answers someone else (O35)", () => {
  const other = { messageId: "<m1@client.test>", fromEmail: "ana@client.test", toEmail: ME, references: "<m0@client.test>" };
  const mine = { messageId: "<m2@velocity.test>", fromEmail: ME, toEmail: "ana@client.test", references: "<m0@client.test> <m1@client.test>" };

  it("answers the last message someone else sent, not the rep's own", () => {
    const r = replyAddressing([other, mine], ME.toUpperCase());
    expect(r?.to).toBe("ana@client.test");
    expect(r?.inReplyTo).toBe("<m1@client.test>");
  });

  it("puts the replied-to message on the end of References", () => {
    expect(replyAddressing([other], ME)?.references).toBe("<m0@client.test> <m1@client.test>");
    expect(replyAddressing([{ ...other, references: undefined }], ME)?.references).toBe("<m1@client.test>");
  });

  it("a thread of only the rep's own messages is a follow-up to whoever it went to", () => {
    expect(replyAddressing([mine], ME)?.to).toBe("ana@client.test");
  });

  it("the Reply button uses it instead of the last sender and the parent's References", () => {
    const src = read("client/src/pages/usip/Mailbox.tsx");
    const view = src.slice(src.indexOf("function ThreadView("), src.indexOf("// ─── Thread Row"));
    const replyBtn = view.slice(view.indexOf('mode: "reply"'), view.indexOf('mode: "forward"'));
    expect(replyBtn).toContain("to: reply?.to ?? lastMsg.fromEmail");
    expect(replyBtn).toContain("references: reply?.references");
    expect(replyBtn).not.toContain("references: lastMsg.references");
    expect(src).toContain("ownEmail={(accounts as Account[]).find((a) => a.id === readingPaneAccountId)?.email}");
  });

  it("quotes the original under the note, its HTML when it had some, else its text escaped", () => {
    const f = forwardedBlock({ fromName: "Ana", fromEmail: "ana@client.test", dateLabel: "Nov 5", subject: "Q4 & you", bodyHtml: "<p>Original <b>body</b></p>", bodyText: "Original body" });
    expect(f.html).toContain("---------- Forwarded message ----------");
    expect(f.html).toContain("From: Ana &lt;ana@client.test&gt;");
    expect(f.html).toContain("Subject: Q4 &amp; you");
    expect(f.html).toContain("<p>Original <b>body</b></p>");
    expect(f.text).toContain("Original body");
    expect(forwardedBlock({ fromEmail: "a@b.test", dateLabel: "", subject: "s", bodyText: "x < y" }).html).toContain("x &lt; y");
  });

  it("the server puts the quote under the signature, and the page sends it on Forward", async () => {
    await caller().mailbox.sendReply({ ...base, threadId: "t", to: "bo@client.test", quoted: { html: "<div>QUOTE</div>", text: "\n\nQUOTE" } });
    const { bodyHtml, bodyText } = h.sent[0];
    expect(bodyHtml.indexOf("Rep Name")).toBeGreaterThan(-1);
    expect(bodyHtml.indexOf("<div>QUOTE</div>")).toBeGreaterThan(bodyHtml.indexOf("Rep Name"));
    expect(bodyText.endsWith("QUOTE")).toBe(true);
    const src = read("client/src/pages/usip/Mailbox.tsx");
    const send = src.slice(src.indexOf("function handleSend()"), src.indexOf("function regenerateAI()"));
    expect(send).toContain('state.mode === "forward" ? state.originalMessage : undefined');
    expect(send).toContain("quoted,");
  });
});

/* ── Items 1 and 5: what to connect, and where ───────────────────────────── */

describe("with no mailbox, the page says what to connect and where (tracker 1, 5)", () => {
  const empty = (viewingRep: boolean) =>
    renderToStaticMarkup(createElement(Router, { ssrPath: "/mailbox" }, createElement(NoMailboxConnected, { viewingRep })));

  it("names Microsoft 365 / Outlook and links to Connected Accounts", () => {
    const html = empty(false);
    expect(html).toContain("Microsoft 365 / Outlook");
    expect(html).toContain('href="/connected-accounts"');
    expect(html).not.toContain("Configure IMAP in Sending Accounts");
  });

  it("a manager viewing a rep is told it is the rep's, with no connect link", () => {
    const html = empty(true);
    expect(html).toContain("connected a mailbox yet.");
    expect(html).not.toContain("/connected-accounts");
  });

  it("the page uses it, and Compose says why it is off", () => {
    const src = read("client/src/pages/usip/Mailbox.tsx");
    expect(src).toContain("<NoMailboxConnected viewingRep={!!repUserId} />");
    expect(src).not.toContain("Configure IMAP in Sending Accounts");
    expect(src).toContain('"Connect a mailbox on Connected Accounts to compose"');
  });

  it("Sending Accounts no longer says IMAP is required for My Mailbox", () => {
    expect(read("client/src/pages/usip/SendingAccounts.tsx")).not.toContain("Required for My Mailbox");
  });
});
