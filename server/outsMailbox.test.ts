/**
 * My Mailbox, OUTS batch (2026-11-07): audit rows F26 / O35 (Reply all, and a
 * forward that carries the original's attachments) and L8 (the provider's
 * thread list read on every open, with no cache).
 *
 * The router runs through createCaller on the SQL fake; the adapter is
 * mocked, so nothing is sent or read from a real mailbox.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return {
    db: null as any,
    sent: [] as any[],
    fetched: [] as Array<[string, string]>,
    attachments: new Map<string, { data: Buffer; contentType: string; filename: string }>(),
    attachmentFails: false,
    listCalls: 0,
    folderCalls: 0,
    listFails: false,
  };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./emailAdapter", async (a) => ({
  ...(await a<typeof import("./emailAdapter")>()),
  createEmailAdapter: () => ({
    sendEmail: async (input: unknown) => { h.sent.push(input); return { messageId: "m1" }; },
    getAttachment: async (messageId: string, attachmentId: string) => {
      h.fetched.push([messageId, attachmentId]);
      if (h.attachmentFails) throw new Error("Unipile GET attachment → 500");
      const a = h.attachments.get(attachmentId);
      if (!a) throw new Error("not found");
      return a;
    },
    listThreads: async () => {
      h.listCalls++;
      if (h.listFails) throw new Error("provider timeout");
      return { threads: [{ threadId: `t${h.listCalls}`, subject: "Hi" }] };
    },
    listFolders: async () => { h.folderCalls++; return [{ name: "INBOX", path: "INBOX", unreadCount: 0, totalCount: 1 }]; },
    markRead: async () => {},
    moveToTrash: async () => {},
    moveToFolder: async () => {},
  }),
}));
vi.mock("./sendLimits", async (a) => ({ ...(await a<typeof import("./sendLimits")>()), assertSendAllowed: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { MAILBOX_ATTACHMENT_LIMIT_BYTES, addressList, forwardedAttachmentRefs, replyAllAddressing } from "@shared/mailCompose";
import { MAILBOX_CACHE_TTL_MS, cachedMailboxRead, invalidateMailboxCache } from "./services/mailboxCache";

const WS = 2;
const ME = "rep@velocity.test";
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];

function caller(userId = 1) {
  return appRouter.createCaller({
    user: { id: userId, openId: `u${userId}`, email: userId === 1 ? ME : `u${userId}@velocity.test`, name: "Rep", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e; }
  throw new Error("expected a refusal");
}
const base = { accountId: 7, subject: "Fwd: Q4", bodyHtml: "<p>See below</p>", bodyText: "See below" };
const pdf = { data: Buffer.from("%PDF-1.4 hello"), contentType: "application/pdf", filename: "attachment" };

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  h.sent = [];
  h.fetched = [];
  h.attachments = new Map([["att-1", pdf]]);
  h.attachmentFails = false;
  h.listCalls = 0;
  h.folderCalls = 0;
  h.listFails = false;
  invalidateMailboxCache();
  rows("sending_accounts").push({ id: 7, workspaceId: WS, name: "Rep", fromEmail: ME, provider: "outlook_oauth", unipileAccountId: "U1", enabled: true });
  rows("unipile_accounts").push({ id: 1, workspaceId: WS, userId: 1, unipileAccountId: "U1", provider: "OUTLOOK" });
  rows("users").push({ id: 1, email: ME, emailSignature: null });
});

/* ── F26: Reply all ─────────────────────────────────────────────────────── */

describe("Reply all copies everyone else on the message (F26)", () => {
  const first = { messageId: "<m1@client.test>", fromEmail: "Ana@Client.test", toEmail: `${ME}, Bo <bo@client.test>`, ccEmail: "cy@partner.test, REP@velocity.test", references: undefined };
  const mine = { messageId: "<m2@velocity.test>", fromEmail: ME, toEmail: "ana@client.test", references: "<m1@client.test>" };

  it("answers the last other sender and copies the rest of that message, never this mailbox", () => {
    const r = replyAllAddressing([first, mine], ME);
    expect(r?.to).toBe("Ana@Client.test");
    expect(r?.cc).toBe("bo@client.test, cy@partner.test");
    expect(r?.inReplyTo).toBe("<m1@client.test>");
    expect(r?.references).toBe("<m1@client.test>");
  });

  it("is plain Reply when nobody else was on it", () => {
    expect(replyAllAddressing([{ messageId: "<x@a>", fromEmail: "ana@client.test", toEmail: ME }], ME)?.cc).toBe("");
    expect(addressList("A <a@x.test>, a@X.test; b@y.test")).toEqual(["a@x.test", "b@y.test"]);
  });

  it("the thread offers it beside Reply, with Cc filled and Reply's threading", () => {
    const src = read("client/src/pages/usip/Mailbox.tsx");
    const view = src.slice(src.indexOf("function ThreadView("), src.indexOf("// ─── Thread Row"));
    expect(view).toContain("const replyAll = replyAllAddressing(messages, ownEmail);");
    const btn = view.slice(view.indexOf("{replyAll?.cc ? ("), view.indexOf('mode: "forward"'));
    expect(btn).toContain('aria-label="Reply all"');
    expect(btn).toContain("cc: replyAll.cc");
    expect(btn).toContain("inReplyTo: replyAll.inReplyTo, references: replyAll.references");
  });
});

/* ── F26 / O35: a forward carries the original's attachments ────────────── */

describe("Forward carries the original's attachments (F26, O35)", () => {
  it("fetches each named attachment from the mailbox and sends it with the forward", async () => {
    await caller().mailbox.sendNew({
      ...base, to: "dee@client.test",
      attachments: [{ filename: "note.txt", contentType: "text/plain", content: "aGVsbG8=" }],
      quoted: { html: "<div>ORIGINAL</div>", text: "\n\nORIGINAL" },
      forwardAttachmentsOf: { messageId: "orig-1", attachments: [{ attachmentId: "att-1", filename: "Q4 plan.pdf" }] },
    });
    expect(h.fetched).toEqual([["orig-1", "att-1"]]);
    expect(h.sent).toHaveLength(1);
    const atts = h.sent[0].attachments;
    expect(atts.map((a: any) => a.filename)).toEqual(["note.txt", "Q4 plan.pdf"]);
    expect(Buffer.from(atts[1].content, "base64").toString()).toBe("%PDF-1.4 hello");
    expect(atts[1].contentType).toBe("application/pdf");
    expect(h.sent[0].bodyHtml).toContain("<div>ORIGINAL</div>");
  });

  it("counts the fetched files toward the 20 MB limit, and sends nothing past it", async () => {
    h.attachments.set("big", { data: Buffer.alloc(MAILBOX_ATTACHMENT_LIMIT_BYTES + 10), contentType: "application/zip", filename: "big.zip" });
    const e = await refusal(caller().mailbox.sendNew({ ...base, to: "dee@client.test", forwardAttachmentsOf: { messageId: "orig-1", attachments: [{ attachmentId: "big", filename: "big.zip" }] } }));
    expect(e.code).toBe("PAYLOAD_TOO_LARGE");
    expect(h.sent).toEqual([]);
  });

  it("an attachment the mailbox cannot return stops the forward, saying which", async () => {
    h.attachmentFails = true;
    const e = await refusal(caller().mailbox.sendNew({ ...base, to: "dee@client.test", forwardAttachmentsOf: { messageId: "orig-1", attachments: [{ attachmentId: "att-1", filename: "Q4 plan.pdf" }] } }));
    expect(e.code).toBe("BAD_GATEWAY");
    expect(e.message).toContain("Q4 plan.pdf");
    expect(h.sent).toEqual([]);
  });

  it("a refused recipient is refused before anything is fetched", async () => {
    rows("email_suppressions").push({ id: 1, workspaceId: WS, email: "dee@client.test", reason: "unsubscribe" });
    const e = await refusal(caller().mailbox.sendNew({ ...base, to: "dee@client.test", forwardAttachmentsOf: { messageId: "orig-1", attachments: [{ attachmentId: "att-1", filename: "a.pdf" }] } }));
    expect(e.code).toBe("BAD_REQUEST");
    expect(h.fetched).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("a forward may go to several addresses, as it could before; a bad one is refused", async () => {
    await caller().mailbox.sendNew({ ...base, to: "dee@client.test, Eve <eve@client.test>" });
    expect(h.sent[0].to).toBe("dee@client.test, Eve <eve@client.test>");
    expect((await refusal(caller().mailbox.sendNew({ ...base, to: "dee@client.test, not-an-address" }))).code).toBe("BAD_REQUEST");
  });

  it("names each original attachment by its provider id, else its position, as the download does", () => {
    expect(forwardedAttachmentRefs({ messageId: "m", attachments: [{ filename: "a.pdf", attachmentId: "x9" }, { filename: "b.png" }] }))
      .toEqual({ messageId: "m", attachments: [{ attachmentId: "x9", filename: "a.pdf" }, { attachmentId: "1", filename: "b.png" }] });
    expect(forwardedAttachmentRefs({ messageId: "m", attachments: [] })).toBeUndefined();
    const adapter = read("server/unipileMailAdapter.ts");
    expect(adapter.split("attachmentId:").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("the page sends a forward as a new message carrying them, and no longer says they are left out", () => {
    const src = read("client/src/pages/usip/Mailbox.tsx");
    const send = src.slice(src.indexOf("function handleSend()"), src.indexOf("function regenerateAI()"));
    const fwd = send.slice(send.indexOf("} else if (o) {"), send.lastIndexOf("} else {"));
    expect(fwd).toContain("forwardedAttachmentRefs({ messageId: o.messageId, attachments: forwardedAtts })");
    expect(fwd).toContain("sendNew.mutate({");
    expect(fwd).toContain("forwardAttachmentsOf: carried");
    expect(src).not.toContain("Its attachments are not forwarded");
    expect(src).toContain("Forwarded with its attachments:");
  });
});

/* ── L8: the provider's lists are kept briefly, and dropped on change ───── */

describe("Mailbox keeps the provider's thread list briefly (L8)", () => {
  const list = (c = caller()) => c.mailbox.listThreads({ accountId: 7, folder: "INBOX", maxResults: 50 });

  it("a second open reads the kept list, not the provider", async () => {
    const a = await list();
    const b = await list();
    expect(h.listCalls).toBe(1);
    expect(b.threads).toEqual(a.threads);
    await caller().mailbox.listFolders({ accountId: 7 });
    await caller().mailbox.listFolders({ accountId: 7 });
    expect(h.folderCalls).toBe(1);
  });

  it("each page and folder is its own entry", async () => {
    await list();
    await caller().mailbox.listThreads({ accountId: 7, folder: "Sent", maxResults: 50 });
    await caller().mailbox.listThreads({ accountId: 7, folder: "INBOX", maxResults: 50, pageToken: "50" });
    expect(h.listCalls).toBe(3);
  });

  it("a send, a read mark, a move, a trash and Refresh each drop it", async () => {
    const changes: Array<() => Promise<unknown>> = [
      () => caller().mailbox.sendNew({ ...base, to: "dee@client.test" }),
      () => caller().mailbox.sendReply({ ...base, threadId: "t", to: "dee@client.test" }),
      () => caller().mailbox.markRead({ accountId: 7, messageId: "x", read: true }),
      () => caller().mailbox.moveToTrash({ accountId: 7, messageId: "x" }),
      () => caller().mailbox.moveToFolder({ accountId: 7, messageId: "x", destFolder: "Archive" }),
      () => caller().mailbox.refresh({ accountIds: [7] }),
    ];
    await list();
    let expected = 1;
    for (const change of changes) {
      await change();
      await list();
      expected++;
      expect(h.listCalls).toBe(expected);
    }
  });

  it("a failed read is not kept", async () => {
    h.listFails = true;
    const bad = await list();
    expect(bad.error).toContain("provider timeout");
    h.listFails = false;
    const good = await list();
    expect(good.error).toBeNull();
    expect(h.listCalls).toBe(2);
  });

  it("someone who may not read the mailbox is refused, even when its list is kept", async () => {
    await list();
    const e = await refusal(list(caller(3)));
    expect(e.code).toBe("FORBIDDEN");
    expect((await refusal(caller(3).mailbox.refresh({ accountIds: [7] }))).code).toBe("FORBIDDEN");
  });

  it("expires after the TTL", async () => {
    let t = 1_000;
    const load = vi.fn(async () => "fresh");
    const acc = { id: 99, unipileAccountId: "U9" };
    await cachedMailboxRead(acc, "threads", ["INBOX"], load, () => true, () => t);
    t += MAILBOX_CACHE_TTL_MS - 1;
    await cachedMailboxRead(acc, "threads", ["INBOX"], load, () => true, () => t);
    expect(load).toHaveBeenCalledTimes(1);
    t += 2;
    await cachedMailboxRead(acc, "threads", ["INBOX"], load, () => true, () => t);
    expect(load).toHaveBeenCalledTimes(2);
    // New mail announced by the provider drops it by the Unipile account too.
    expect(invalidateMailboxCache({ unipileAccountId: "U9" })).toBe(1);
  });

  it("the provider's webhook drops it, and both Refresh buttons ask the server to read again", () => {
    const hook = read("server/unipileWebhook.ts");
    expect(hook).toContain("invalidateMailboxCache({ unipileAccountId: account_id });");
    const page = read("client/src/pages/usip/Mailbox.tsx");
    expect(page).toContain("onClick={() => refresh.mutate({ accountIds: [accountId] })}");
    expect(page).toContain("onClick={() => refreshAll.mutate({ accountIds: accounts.slice(0, 5).map((a) => a.id) })}");
  });
});
