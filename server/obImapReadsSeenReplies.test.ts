/**
 * Audit 2026-10-20, O36: IMAP reply detection read only UNSEEN messages, 50
 * at most. Confirmed from the code: `client.search({ seen: false })`, then
 * `.slice(-50)`. So a reply the rep opened on a phone before the next poll
 * came round was never read, never recorded, and its sequence kept sending.
 *
 * Now each poll reads every message from the last two days, seen or not,
 * skipping what is already recorded (or was read and deliberately skipped),
 * newest first and at most 50 downloads. The mailbox is opened read-only:
 * nothing is marked seen or changed.
 *
 * The IMAP server is an in-memory fake with flags and dates; the database
 * evaluates the SQL the poller and processInboundReply render.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Msg = { uid: number; seen: boolean; date: Date; source: string };
const h = vi.hoisted(() => ({
  db: null as any,
  mailbox: [] as Array<{ uid: number; seen: boolean; date: Date; source: string }>,
  searches: [] as any[],
  fetched: [] as number[][],
  lockOpts: [] as any[],
  flagWrites: 0,
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./routers/are/execution", async (a) => ({ ...(await a<typeof import("./routers/are/execution")>()), processSignal: async () => {} }));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    mailbox = { uidValidity: 7, exists: 0 };
    async connect() { this.mailbox.exists = h.mailbox.length; }
    async getMailboxLock(_path: string, opts?: any) { h.lockOpts.push(opts ?? null); return { release() {} }; }
    async search(q: any) {
      h.searches.push(q);
      const out = h.mailbox
        .filter((m) => (q.seen === false ? !m.seen : true))
        .filter((m) => (q.since ? m.date.getTime() >= new Date(q.since).setUTCHours(0, 0, 0, 0) : true))
        .map((m) => m.uid);
      return out.length ? out : false;
    }
    async *fetch(range: string) {
      const uids = range.split(",").map(Number);
      h.fetched.push(uids);
      for (const m of h.mailbox) if (uids.includes(m.uid)) yield { uid: m.uid, flags: new Set(m.seen ? ["\\Seen"] : []), source: Buffer.from(m.source) };
    }
    async messageFlagsAdd() { h.flagWrites++; }
    async messageFlagsSet() { h.flagWrites++; }
    async logout() {}
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { pollImapAccount, REPLY_LOOKBACK_DAYS } from "./inboundReplyPoller";

const LSI = 2;
const REP = 21;
const DAY = 86_400_000;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const ACCOUNT = { id: 1, workspaceId: LSI, userId: REP, fromEmail: "rep@lsi.example", imapHost: "imap.lsi.example", imapPort: 993, imapSecure: true, imapUsername: "rep", imapPassword: "plain" };

function mail(uid: number, over: { from?: string; seen?: boolean; ageDays?: number; inReplyTo?: string; headers?: string } = {}): Msg {
  const date = new Date(Date.now() - (over.ageDays ?? 0) * DAY);
  const from = over.from ?? "Ann Lee <ann@acme.example>";
  const source = [
    `From: ${from}`, "To: rep@lsi.example", "Subject: Re: Hello", `Message-ID: <m${uid}@acme.example>`,
    ...(over.inReplyTo ? [`In-Reply-To: <${over.inReplyTo}>`] : []), ...(over.headers ? [over.headers] : []),
    `Date: ${date.toUTCString()}`, "", "Not now, thanks.",
  ].join("\r\n");
  return { uid, seen: over.seen ?? false, date, source };
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.mailbox = [];
  h.searches = [];
  h.fetched = [];
  h.lockOpts = [];
  h.flagWrites = 0;
  rows("workspaces").push({ id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: REP, archivedAt: null, plan: "trial" });
  rows("users").push({ id: REP, name: "Rep", email: "rep@lsi.example" });
  rows("workspace_members").push({ id: 1, workspaceId: LSI, userId: REP, role: "rep", deactivatedAt: null, lastActiveAt: new Date(), createdAt: new Date() });
  rows("sending_accounts").push({ ...ACCOUNT, name: "Rep box", enabled: true, provider: "smtp" });
  rows("contacts").push({ id: 101, workspaceId: LSI, firstName: "Ann", lastName: "Lee", email: "ann@acme.example", accountId: null });
  rows("sequences").push({ id: 1, workspaceId: LSI, name: "Seq", status: "active", steps: [], settings: {} });
  rows("enrollments").push({ id: 11, workspaceId: LSI, sequenceId: 1, contactId: 101, leadId: null, prospectId: null, status: "active", currentStep: 1 });
});

describe("a reply opened on a phone first is still found", () => {
  it("a SEEN reply is read, recorded, and stops the sequence", async () => {
    h.mailbox = [mail(500, { seen: true })];
    await pollImapAccount(ACCOUNT);
    expect(rows("email_replies")).toHaveLength(1);
    expect(rows("email_replies")[0]).toMatchObject({ fromEmail: "ann@acme.example", imapUid: 500, contactId: 101 });
    expect(rows("enrollments")[0].status).toBe("paused");
  });

  it("the search asks for everything since the look-back day, not for unseen mail", async () => {
    h.mailbox = [mail(500)];
    await pollImapAccount(ACCOUNT);
    expect(h.searches).toHaveLength(1);
    expect(h.searches[0].seen).toBeUndefined();
    const since = new Date(h.searches[0].since).getTime();
    expect(Date.now() - since).toBeGreaterThanOrEqual(REPLY_LOOKBACK_DAYS * DAY - 1000);
    expect(Date.now() - since).toBeLessThan(REPLY_LOOKBACK_DAYS * DAY + 60_000);
  });
});

describe("bounded, and nothing in the mailbox changes", () => {
  it("mail older than the look-back window is not read", async () => {
    h.mailbox = [mail(400, { ageDays: REPLY_LOOKBACK_DAYS + 3, seen: true }), mail(500, { seen: true })];
    await pollImapAccount(ACCOUNT);
    expect(h.fetched.flat()).toEqual([500]);
  });

  it("at most 50 messages are downloaded per poll, the newest", async () => {
    h.mailbox = Array.from({ length: 60 }, (_, i) => mail(1000 + i, { from: `P${i} <p${i}@x.example>`, seen: true }));
    await pollImapAccount(ACCOUNT);
    expect(h.fetched[0]).toHaveLength(50);
    expect(Math.min(...h.fetched[0])).toBe(1010);
    // The next poll takes the ten left over.
    await pollImapAccount(ACCOUNT);
    expect(h.fetched[1].sort()).toEqual(Array.from({ length: 10 }, (_, i) => 1000 + i));
  });

  it("what is already recorded is not downloaded again", async () => {
    h.mailbox = [mail(500, { seen: true })];
    await pollImapAccount(ACCOUNT);
    await pollImapAccount(ACCOUNT);
    expect(h.fetched).toEqual([[500]]);
    expect(rows("email_replies")).toHaveLength(1);
  });

  it("mail from our own mailbox is skipped once and not downloaded on every poll", async () => {
    h.mailbox = [mail(600, { from: "Rep <rep@lsi.example>", seen: true })];
    await pollImapAccount(ACCOUNT);
    await pollImapAccount(ACCOUNT);
    expect(h.fetched).toEqual([[600]]);
    expect(rows("email_replies")).toHaveLength(0);
  });

  it("the mailbox is opened read-only and no flag is touched", async () => {
    h.mailbox = [mail(500), mail(501, { seen: true })];
    await pollImapAccount(ACCOUNT);
    expect(h.lockOpts).toEqual([{ readOnly: true }]);
    expect(h.flagWrites).toBe(0);
    expect(h.mailbox.map((m) => m.seen)).toEqual([false, true]);
  });
});
