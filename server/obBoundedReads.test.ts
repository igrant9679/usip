/**
 * Unbounded reads, audit 2026-10-20 O41 and L8.
 *
 * O41: the Dashboard read every draft in the workspace, bodies included, for a
 * card that shows five; sequences.listEnrollments read every enrolment in the
 * workspace to keep one sequence's; meetings.list read every meeting ever
 * made, for a page that shows the live ones and fifteen past and a calendar
 * that shows a few weeks. Each is now filtered, counted or bounded in SQL.
 *
 * L8: IMAP's listThreads ignored the page token, so the Mailbox could never
 * page past the newest 50.
 *
 * Real routers over an in-memory database that evaluates their SQL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, imap: { exists: 0, fetched: [] as string[] } };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    mailbox = { exists: h.imap.exists };
    async connect() {}
    async logout() {}
    async getMailboxLock() { return { release() {} }; }
    async search() { throw new Error("listing must not search the folder"); }
    async *fetch(range: string) {
      h.imap.fetched.push(range);
      const [a, b] = range.split(":");
      const lo = Number(a), hi = b === "*" ? h.imap.exists : Number(b);
      for (let seq = lo; seq <= hi; seq++) {
        yield { uid: 1000 + seq, flags: new Set<string>(), envelope: { subject: `m${seq}`, date: new Date(2026, 0, 1, 0, seq), from: [{ address: `p${seq}@x.example`, name: "" }] } };
      }
    }
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { encryptSecret } from "./_core/crypto";
import { ImapSmtpAdapter } from "./emailAdapter";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const read = (rel: string) => readFileSync(rel, "utf8").replace(/\r\n/g, "\n");
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "rep@lsi.example", name: "Rep", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
});

describe("O41: the Dashboard's drafts card reads five and counts the rest", () => {
  beforeEach(() => {
    const at = (i: number) => new Date(Date.UTC(2026, 9, 1, 12, i));
    for (let i = 1; i <= 8; i++) rows("email_drafts").push({ id: i, workspaceId: WS, subject: `S${i}`, body: "b".repeat(2000), status: "pending_review", createdAt: at(i) });
    for (let i = 9; i <= 12; i++) rows("email_drafts").push({ id: i, workspaceId: WS, subject: `S${i}`, body: "b", status: "ai_pending_review", createdAt: at(i) });
    rows("email_drafts").push({ id: 13, workspaceId: WS, subject: "sent", body: "b", status: "sent", createdAt: at(13) });
    rows("email_drafts").push({ id: 14, workspaceId: 99, subject: "theirs", body: "b", status: "pending_review", createdAt: at(14) });
  });

  it("list takes a limit, newest first, awaiting review meaning both statuses", async () => {
    const five = await caller().emailDrafts.list({ status: "pending_review", limit: 5 });
    expect(five.map((d: any) => d.id)).toEqual([12, 11, 10, 9, 8]);
  });

  it("count gives the whole number for the badge, in this workspace only", async () => {
    expect(await caller().emailDrafts.count({ status: "pending_review" })).toEqual({ count: 12 });
    expect(await caller().emailDrafts.count({ status: "sent" })).toEqual({ count: 1 });
  });

  it("with no limit it is still bounded", async () => {
    const all = await caller().emailDrafts.list({});
    expect(all).toHaveLength(13);
    const src = read("server/routers/sequences.ts");
    const list = src.slice(src.indexOf("export const emailDraftsRouter = router({"), src.indexOf("/** Server-side AI compose. */"));
    expect(list).toContain(".limit(input?.limit ?? 100)");
    expect(list).not.toContain(".filter((r) =>");
  });

  it("the Dashboard asks for five and badges the count", () => {
    const dash = read("client/src/pages/usip/Dashboard.tsx");
    expect(dash).toContain('trpc.emailDrafts.list.useQuery({ status: "pending_review", limit: 5 })');
    expect(dash).toContain('trpc.emailDrafts.count.useQuery({ status: "pending_review" })');
    expect(dash).toContain("{awaitingDrafts}");
    expect(dash).not.toContain("{(drafts ?? []).length}\n");
  });
});

describe("O41: listEnrollments keeps to the sequence in SQL", () => {
  it("returns that sequence's enrolments, filtered in the query", async () => {
    rows("enrollments").push(
      { id: 1, workspaceId: WS, sequenceId: 5, contactId: null, leadId: null, prospectId: null, status: "active" },
      { id: 2, workspaceId: WS, sequenceId: 6, contactId: null, leadId: null, prospectId: null, status: "active" },
      { id: 3, workspaceId: 99, sequenceId: 5, contactId: null, leadId: null, prospectId: null, status: "active" },
    );
    expect((await caller().sequences.listEnrollments({ sequenceId: 5 })).map((e: any) => e.id)).toEqual([1]);
    const src = read("server/routers/sequences.ts");
    const fn = src.slice(src.indexOf("  listEnrollments: workspaceProcedure"), src.indexOf("  enroll: repProcedure"));
    expect(fn).toContain("input?.sequenceId ? eq(enrollments.sequenceId, input.sequenceId) : undefined");
    expect(fn).not.toContain("rows.filter((r) => r.sequenceId === input.sequenceId)");
  });
});

describe("O41: meetings are read by status, range and limit in SQL", () => {
  beforeEach(() => {
    const m = (id: number, status: string, scheduledAt: Date | null, createdMin: number) =>
      rows("meetings").push({ id, workspaceId: WS, status, scheduledAt, title: `M${id}`, ownerUserId: 1, relatedType: null, relatedId: null, createdAt: new Date(Date.UTC(2026, 9, 1, 0, createdMin)) });
    m(1, "proposed", null, 1);
    m(2, "scheduled", new Date("2026-11-10T15:00:00Z"), 2);
    m(3, "scheduled", new Date("2026-12-20T15:00:00Z"), 3);
    m(4, "invited", new Date("2026-11-12T15:00:00Z"), 4);
    for (let i = 0; i < 20; i++) m(100 + i, "completed", new Date("2026-09-01T15:00:00Z"), 10 + i);
    m(200, "cancelled", null, 40);
  });

  it("the live ones in full, the closed ones only as many as asked, newest first", async () => {
    const live = await caller().meetings.list({ statuses: ["proposed", "invited", "scheduled", "rescheduled"] });
    expect(live.map((m: any) => m.id)).toEqual([4, 3, 2, 1]);
    const closed = await caller().meetings.list({ statuses: ["completed", "no_show", "cancelled"], limit: 15 });
    expect(closed).toHaveLength(15);
    expect(closed[0].id).toBe(200);
  });

  it("the Calendar's weeks only", async () => {
    const r = await caller().meetings.list({ statuses: ["invited", "scheduled", "rescheduled"], scheduledFrom: new Date("2026-11-01T00:00:00Z"), scheduledTo: new Date("2026-12-01T00:00:00Z") });
    expect(r.map((m: any) => m.id).sort()).toEqual([2, 4]);
  });

  it("the pages ask for exactly that", () => {
    const page = read("client/src/pages/usip/MeetingsV2.tsx");
    expect(page).toContain("trpc.meetings.list.useQuery({ statuses: liveMeetingStatuses() })");
    expect(page).toContain("trpc.meetings.list.useQuery({ statuses: [...CLOSED_MEETING_STATUSES], limit: PAST_SHOWN })");
    expect(page).not.toContain("trpc.meetings.list.useQuery({})");
    const cal = read("client/src/pages/usip/Calendar.tsx");
    expect(cal).toContain("statuses: remindableMeetingStatuses(), scheduledFrom: dateRange.from, scheduledTo: dateRange.to,");
    expect(cal).not.toContain("trpc.meetings.list.useQuery({})");
  });
});

describe("L8: the IMAP mailbox list pages", () => {
  const adapter = () => new ImapSmtpAdapter({ id: 1, imapHost: "imap.example", imapUsername: "u", imapPassword: encryptSecret("p") } as any);
  beforeEach(() => { h.imap = { exists: 120, fetched: [] }; });

  it("page one is the newest 50 and hands back where it started", async () => {
    const r = await adapter().listThreads("INBOX", undefined, 50);
    expect(h.imap.fetched).toEqual(["71:*"]);
    expect(r.threads[0].threadId).toBe("1120");
    expect(r.nextPageToken).toBe("71");
  });

  it("the token reaches the older mail, down to the first message, then stops", async () => {
    const p2 = await adapter().listThreads("INBOX", "71", 50);
    expect(h.imap.fetched).toEqual(["21:70"]);
    expect(p2.threads.map((t) => t.threadId)[0]).toBe("1070");
    expect(p2.nextPageToken).toBe("21");
    const p3 = await adapter().listThreads("INBOX", "21", 50);
    expect(h.imap.fetched[1]).toBe("1:20");
    expect(p3.threads).toHaveLength(20);
    expect(p3.nextPageToken).toBeUndefined();
  });

  it("a nonsense token lists nothing rather than the whole folder", async () => {
    expect((await adapter().listThreads("INBOX", "abc", 50)).threads).toEqual([]);
    expect((await adapter().listThreads("INBOX", "1", 50)).threads).toEqual([]);
    expect(h.imap.fetched).toEqual([]);
  });
});
