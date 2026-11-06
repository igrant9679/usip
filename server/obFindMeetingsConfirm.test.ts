/**
 * Audit 2026-10-20, O29: in Autonomous, "Find meetings with AI" sent up to 8
 * invites on one click, with only a toast afterwards.
 *
 * Now the page asks first: previewFindMeetings says whether a run would send
 * and to whom, reading only; a confirmed run is kept to the people the
 * confirm named; an unconfirmed one (allowSend: false) drafts and sends
 * nothing. The pause check is unchanged: paused, nothing sends either way.
 *
 * Real routers and scheduler over an in-memory database that evaluates their
 * SQL; the proposal email and the calendar are recording mocks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, paused: false, emailed: [] as any[] };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./_core/llm", async (a) => ({ ...(await a<typeof import("./_core/llm")>()), invokeLLM: async () => { throw new Error("no model in tests"); } }));
vi.mock("./services/brandContext", async (a) => ({ ...(await a<typeof import("./services/brandContext")>()), buildBrandContext: async () => "" }));
vi.mock("./calendarAdapter", async (a) => ({
  ...(await a<typeof import("./calendarAdapter")>()),
  createCalendarAdapter: () => ({ listEvents: async () => [], createEvent: async () => { throw new Error("nothing goes on the calendar"); } }),
}));
vi.mock("./services/meetingProposalEmail", async (a) => ({
  ...(await a<typeof import("./services/meetingProposalEmail")>()),
  sendProposalEmail: async (input: any) => { h.emailed.push(input); return { ok: true, fromEmail: "owner@lsi.example", messageId: `m${h.emailed.length}` }; },
}));
vi.mock("./routers/are/execution", async (a) => ({ ...(await a<typeof import("./routers/are/execution")>()), attributeMeetingBookingToAre: async () => {} }));
vi.mock("./services/sendWindow", async (a) => ({
  ...(await a<typeof import("./services/sendWindow")>()),
  getWorkspaceSendWindow: async () => ({ timezone: "America/New_York", window: { startHour: 0, endHour: 24, days: [0, 1, 2, 3, 4, 5, 6] }, paused: h.paused }),
  inSendWindow: async () => !h.paused,
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

const WS = 2;
const ME = 1;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "owner@lsi.example", name: "Owner", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

function prospect(id: number, first: string, email: string | null, score: number, over: Record<string, unknown> = {}) {
  rows("prospects").push({
    id, workspaceId: WS, firstName: first, lastName: "Test", email, company: `Co ${id}`, title: "VP",
    confidenceScore: score, verificationStatus: null, linkedContactId: null, linkedLeadId: null,
    createdAt: new Date(), updatedAt: new Date(Date.UTC(2026, 9, 1, 12, id)), ...over,
  });
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.paused = false;
  h.emailed = [];
  rows("workspaces").push({ id: WS, name: "LSI Media", slug: "lsi", ownerUserId: ME, archivedAt: null, plan: "trial" });
  rows("workspace_settings").push({ id: 1, workspaceId: WS, meetingAutopilotMode: "auto", timezone: "America/New_York" });
  rows("users").push({ id: ME, name: "Owner", email: "owner@lsi.example" });
  rows("calendar_accounts").push({ id: 2, workspaceId: WS, userId: ME, calendarId: null, unipileAccountId: "acc", provider: "outlook" });
  prospect(11, "Ada", "ada@example.org", 90);
  prospect(12, "Bo", "bo@example.org", 80);
  prospect(13, "Cy", "cy@example.org", 70);
  prospect(14, "Dup", "ADA@example.org ", 60); // the same person as Ada
  prospect(15, "Nomail", null, 99);
  prospect(16, "Busy", "busy@example.org", 95);
  rows("meetings").push({ id: 500, workspaceId: WS, relatedType: "prospect", relatedId: 16, status: "proposed", contactEmail: "busy@example.org", title: "Existing", createdAt: new Date() });
});

describe("previewFindMeetings: what a click would do, before it does it", () => {
  it("in Autonomous it would send, and names the people it would pick, best first", async () => {
    const p = await caller().meetings.previewFindMeetings({ limit: 8 });
    expect(p.send).toBe(true);
    expect(p.paused).toBe(false);
    // No email, an open meeting and a second row for Ada's address are skipped, as the run skips them.
    expect(p.candidates.map((c) => c.email)).toEqual(["ada@example.org", "bo@example.org", "cy@example.org"]);
    expect(p.candidates[0]).toMatchObject({ id: 11, name: "Ada Test", company: "Co 11" });
  });

  it("reads only: nothing is proposed or sent", async () => {
    await caller().meetings.previewFindMeetings({ limit: 8 });
    expect(rows("meetings")).toHaveLength(1);
    expect(h.emailed).toHaveLength(0);
  });

  it("the limit is the number it names", async () => {
    const p = await caller().meetings.previewFindMeetings({ limit: 2 });
    expect(p.candidates.map((c) => c.id)).toEqual([11, 12]);
  });

  it("in Approve, or paused, it would not send", async () => {
    rows("workspace_settings")[0].meetingAutopilotMode = "approval";
    expect((await caller().meetings.previewFindMeetings({ limit: 8 })).send).toBe(false);
    rows("workspace_settings")[0].meetingAutopilotMode = "auto";
    h.paused = true;
    expect(await caller().meetings.previewFindMeetings({ limit: 8 })).toMatchObject({ send: false, paused: true });
  });
});

describe("generateProposals after the confirm", () => {
  it("a confirmed run sends only to the people the confirm named", async () => {
    const r = await caller().meetings.generateProposals({ limit: 8, prospectIds: [12], allowSend: true });
    expect(r).toMatchObject({ proposed: 1, send: true });
    expect(rows("meetings").filter((m) => m.id !== 500).map((m) => m.contactEmail)).toEqual(["bo@example.org"]);
    expect(h.emailed.map((e) => e.meeting.contactEmail)).toEqual(["bo@example.org"]);
  });

  it("not confirmed (allowSend: false): proposals are drafted for review, and nothing is sent", async () => {
    const r = await caller().meetings.generateProposals({ limit: 8, allowSend: false });
    expect(r).toMatchObject({ send: false, sent: 0 });
    expect(r.proposed).toBeGreaterThan(0);
    expect(h.emailed).toHaveLength(0);
  });

  it("paused: nothing is sent even with a confirm", async () => {
    h.paused = true;
    const r = await caller().meetings.generateProposals({ limit: 8, prospectIds: [11], allowSend: true });
    expect(r).toMatchObject({ send: false, paused: true, sent: 0 });
    expect(h.emailed).toHaveLength(0);
  });
});

describe("the Meetings page asks before an Autonomous send", () => {
  const page = readFileSync("client/src/pages/usip/MeetingsV2.tsx", "utf8").replace(/\r\n/g, "\n");
  const find = page.slice(page.indexOf("const findMeetings = async () => {"), page.indexOf("const approveSend = trpc.meetings.approveAndSend"));

  it("both Find meetings buttons run the preview first, not the send", () => {
    // The header button and the empty state's.
    expect(page.split("onClick={findMeetings}").length - 1).toBe(2);
    expect(page).not.toContain("onClick={() => generate.mutate(");
    // Word-bounded: regenerate.mutate( is another button.
    expect(page.match(/\bgenerate\.mutate\(/g)?.length).toBe(2);
    expect(find).toContain("utils.client.meetings.previewFindMeetings.query({ limit: 8 })");
  });

  it("a send happens only from the confirm, kept to the people it named", () => {
    const confirm = find.slice(find.indexOf("confirmAction({"));
    expect(confirm).toContain("p.candidates.map((c) => (");
    expect(confirm).toContain("generate.mutate({ limit: 8, prospectIds: p.candidates.map((c) => c.id), allowSend: true })");
    // Before the confirm, the only call is the one that cannot send.
    const before = find.slice(0, find.indexOf("confirmAction({"));
    expect(before.match(/\bgenerate\.mutate\(/g)?.length).toBe(1);
    expect(before).toContain("generate.mutate({ limit: 8, allowSend: false })");
  });
});
