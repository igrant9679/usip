/**
 * "No event until accepted" (owner, 2026-10-06: "why are you still booking
 * meetings on my calendar for meetings that haven't been accepted yet!").
 * A proposal is emailed with each offered time as a link to /m/:token; the
 * page only shows the times, and the calendar event is made when the
 * prospect presses Confirm on one that is still free.
 */
import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activities, calendarAccounts, calendarEvents, meetings, notifications, users, workspaces } from "../drizzle/schema";

const h = vi.hoisted(() => ({
  db: null as any,
  createEvent: vi.fn(),
  listEvents: vi.fn(),
  attribute: vi.fn(),
  email: vi.fn(),
}));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./services/workspaceTimezone", () => ({ getWorkspaceTimezone: async () => "America/New_York" }));
vi.mock("./calendarAdapter", async (a) => ({
  ...(await a<typeof import("./calendarAdapter")>()),
  createCalendarAdapter: () => ({ listEvents: (...x: unknown[]) => h.listEvents(...x), createEvent: (...x: unknown[]) => h.createEvent(...x) }),
}));
vi.mock("./routers/are/execution", async (a) => ({ ...(await a<typeof import("./routers/are/execution")>()), attributeMeetingBookingToAre: (...x: unknown[]) => h.attribute(...x) }));
vi.mock("./services/meetingProposalEmail", async (a) => ({
  ...(await a<typeof import("./services/meetingProposalEmail")>()),
  sendProposalEmail: (...x: unknown[]) => h.email(...x),
}));

import { confirmProposalPick, expireUnpickedProposals, proposalForPick, sendMeetingInvite, __resetLiveBusyCacheForTests } from "./services/meetingScheduler";
import { proposalEmailBodies, proposalPickUrl } from "./services/meetingProposalEmail";

const DAY = 86_400_000;
// Two weekdays ahead, 10:00 and 14:00 New York (14:00 / 18:00 UTC in October).
const day = (() => { let d = Date.now() + 3 * DAY; while ([0, 6].includes(new Date(d).getUTCDay())) d += DAY; return Math.floor(d / DAY) * DAY; })();
const T = [day + 14 * 3_600_000, day + 18 * 3_600_000, day + DAY + 14 * 3_600_000].map((ms) => new Date(ms).toISOString());
const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz0123456789";

type Row = Record<string, any>;
const st = {
  meeting: {} as Row,
  others: [] as Row[],
  claimOk: true,
  updates: [] as { table: unknown; set: Row }[],
  inserts: [] as { table: unknown; v: Row }[],
};

function makeDb() {
  const select = (fields?: Row) => {
    let table: unknown;
    const rows = (): Row[] => {
      if (table === meetings) {
        if (fields && Object.keys(fields).length === 1 && "id" in fields) return []; // one invite per person
        if (fields && "meetingUrl" in fields && Object.keys(fields).length === 1) return [{ meetingUrl: st.meeting.meetingUrl ?? null }];
        if (fields && "proposedTimes" in fields) return st.others; // ownerCommitments, the expiry sweep
        return [st.meeting];
      }
      if (table === calendarAccounts) return [{ id: 2, workspaceId: 4, userId: 5721, calendarId: null, unipileAccountId: "acc" }];
      if (table === users) return [{ name: "Khaja Syed" }];
      if (table === workspaces) return [{ name: "CommunityForce" }];
      return [];
    };
    const q: any = {
      from(t: unknown) { table = t; return q; }, where() { return q; }, orderBy() { return q; }, limit() { return q; }, innerJoin() { return q; },
      then(res: any, rej: any) { return Promise.resolve(rows()).then(res, rej); },
    };
    return q;
  };
  return {
    select,
    insert: (table: unknown) => ({ values(v: Row) { st.inserts.push({ table, v }); return Promise.resolve([{ insertId: 50 }]); } }),
    update: (table: unknown) => ({
      set(set: Row) {
        return {
          where() {
            st.updates.push({ table, set });
            const claim = table === meetings && "scheduledAt" in set && set.scheduledAt instanceof Date && !("status" in set);
            if (claim && !st.claimOk) return Promise.resolve([{ affectedRows: 0 }]);
            if (table === meetings) Object.assign(st.meeting, set);
            return Promise.resolve([{ affectedRows: 1 }]);
          },
        };
      },
    }),
  };
}

const invited = (): Row => ({
  id: 9, workspaceId: 4, ownerUserId: 5721, status: "invited", proposedTimes: [...T], scheduledAt: null, durationMin: 30,
  contactEmail: "ada@example.org", contactName: "Ada", title: "Intro", inviteMessage: "Hi Ada", meetingUrl: null,
  relatedType: "prospect", relatedId: 77, proposalToken: TOKEN, proposalSentAt: new Date(),
});

beforeEach(() => {
  __resetLiveBusyCacheForTests();
  st.meeting = invited();
  st.others = [];
  st.claimOk = true;
  st.updates = [];
  st.inserts = [];
  h.db = makeDb();
  h.listEvents.mockReset().mockResolvedValue([]);
  h.createEvent.mockReset().mockImplementation(async (_c: string, e: any) => ({ externalId: "evt", title: e.title, startAt: e.startAt, endAt: e.endAt, meetingUrl: "https://teams.microsoft.com/l/x" }));
  h.attribute.mockReset();
  h.email.mockReset().mockResolvedValue({ ok: true, fromEmail: "khaja@communityforce.com", messageId: "m1" });
});

describe("the email", () => {
  const bodies = () => proposalEmailBodies({
    inviteMessage: "Hi Ada,\nWould one of these suit? <b>bold</b>",
    times: T.slice(0, 2).map((t) => new Date(t)),
    timezone: "America/New_York",
    token: TOKEN,
    signature: "Khaja Syed\nCommunityForce",
    unsubscribeUrl: "https://getvelocityai.app/u/x",
  });

  it("each offered time is a link to the pick page, that time preselected", () => {
    const { html, text } = bodies();
    expect(html).toContain(`href="${proposalPickUrl(TOKEN, 0)}"`);
    expect(html).toContain(`href="${proposalPickUrl(TOKEN, 1)}"`);
    expect(proposalPickUrl(TOKEN, 1)).toMatch(new RegExp(`/m/${TOKEN}\\?t=1$`));
    expect(text).toContain(proposalPickUrl(TOKEN, 0));
    expect(html).toContain("EDT"); // the zone is named
  });

  it("says a calendar invite follows a confirmation, and that a reply works too", () => {
    const { html, text } = bodies();
    for (const s of [html, text]) {
      expect(s).toContain("Each link opens a page to confirm that time, and the calendar invite follows.");
      expect(s).toContain("If none of these work, just reply to this email.");
    }
  });

  it("the invite text is escaped, and the signature and unsubscribe link are there", () => {
    const { html } = bodies();
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("Khaja Syed<br>CommunityForce");
    expect(html).toContain('href="https://getvelocityai.app/u/x"');
  });
});

describe("sending a proposal", () => {
  beforeEach(() => { st.meeting = { ...invited(), status: "proposed", proposalToken: null, proposalSentAt: null }; });

  it("emails the free times and records it; no calendar event, no booking", async () => {
    const res = await sendMeetingInvite(4, 9);
    expect(res).toEqual({ sent: true, scheduledAt: null, offered: T });
    expect(h.email).toHaveBeenCalledTimes(1);
    expect(h.createEvent).not.toHaveBeenCalled();
    expect(h.attribute).not.toHaveBeenCalled();
    expect(st.meeting).toMatchObject({ status: "invited", inviteSent: true, scheduledAt: null });
    expect(st.meeting.proposalToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("once only: a second send of the same proposal (double click, two runs) sends nothing", async () => {
    st.claimOk = true;
    h.db.update = (table: unknown) => ({ set: (set: Row) => ({ where: () => { st.updates.push({ table, set }); return Promise.resolve([{ affectedRows: 0 }]); } }) });
    expect(await sendMeetingInvite(4, 9)).toEqual({ sent: false, scheduledAt: null, reason: "already_sent" });
    expect(h.email).not.toHaveBeenCalled();
  });

  it("a send that fails releases the claim, so it can be tried again", async () => {
    h.email.mockResolvedValue({ ok: false, reason: "no_mailbox" });
    expect(await sendMeetingInvite(4, 9)).toEqual({ sent: false, scheduledAt: null, reason: "no_mailbox" });
    expect(st.meeting.proposalToken).toBeNull();
    expect(st.meeting.status).toBe("proposed");
  });
});

describe("the prospect confirms a time", () => {
  it("a free offered time: booked on the calendar with them invited, counted, and the owner told", async () => {
    const res = await confirmProposalPick(TOKEN, T[1]);
    expect(res).toEqual({ ok: true, scheduledAt: T[1], meetingUrl: "https://teams.microsoft.com/l/x" });
    expect(h.createEvent).toHaveBeenCalledTimes(1);
    const [, ev] = h.createEvent.mock.calls[0] as any[];
    expect(ev.startAt.toISOString()).toBe(T[1]);
    expect(ev.attendees).toEqual([{ email: "ada@example.org", name: "Ada" }]);
    expect(st.meeting).toMatchObject({ status: "scheduled", attendeeResponse: "accepted" });
    expect(h.attribute).toHaveBeenCalledTimes(1);
    expect(st.inserts.find((i) => i.table === notifications)?.v).toMatchObject({ userId: 5721, title: "Meeting confirmed: Ada" });
    expect(st.inserts.some((i) => i.table === activities)).toBe(true);
  });

  it("a time that was not offered is refused", async () => {
    expect(await confirmProposalPick(TOKEN, new Date(Date.parse(T[0]) + 3_600_000).toISOString())).toEqual({ ok: false, reason: "not_offered" });
    expect(h.createEvent).not.toHaveBeenCalled();
  });

  it("a time taken since the email went is refused, and nothing is booked", async () => {
    st.others = [{ id: 1, status: "scheduled", proposedTimes: [], scheduledAt: new Date(T[0]), durationMin: 30 }];
    expect(await confirmProposalPick(TOKEN, T[0])).toEqual({ ok: false, reason: "time_taken" });
    expect(h.createEvent).not.toHaveBeenCalled();
  });

  it("a busy live calendar counts as taken too", async () => {
    h.listEvents.mockResolvedValue([{ startAt: new Date(Date.parse(T[0]) - 600_000), endAt: new Date(Date.parse(T[0]) + 600_000) }]);
    expect(await confirmProposalPick(TOKEN, T[0])).toEqual({ ok: false, reason: "time_taken" });
  });

  it("a day that already has 3 meetings is refused (the owner's per-day limit)", async () => {
    const at = (hour: number) => { const d = new Date(T[0]); d.setUTCHours(hour, 0, 0, 0); return d; };
    st.others = [15, 16, 17].map((hr, i) => ({ id: i + 1, status: "scheduled", proposedTimes: [], scheduledAt: at(hr), durationMin: 30 }));
    expect(await confirmProposalPick(TOKEN, T[0])).toEqual({ ok: false, reason: "time_taken" });
  });

  it("a past time is refused", async () => {
    st.meeting.proposedTimes = [new Date(Date.now() - DAY).toISOString(), ...T];
    expect(await confirmProposalPick(TOKEN, st.meeting.proposedTimes[0])).toEqual({ ok: false, reason: "time_passed" });
  });

  it("two confirmations at once: only one books", async () => {
    st.claimOk = false;
    expect(await confirmProposalPick(TOKEN, T[0])).toEqual({ ok: false, reason: "closed" });
    expect(h.createEvent).not.toHaveBeenCalled();
  });

  it("confirming again (a second click) is fine for the same time, refused for another", async () => {
    st.meeting = { ...st.meeting, status: "scheduled", scheduledAt: new Date(T[1]), meetingUrl: "https://teams/x" };
    expect(await confirmProposalPick(TOKEN, T[1])).toEqual({ ok: true, scheduledAt: T[1], meetingUrl: "https://teams/x", already: true });
    expect(await confirmProposalPick(TOKEN, T[2])).toEqual({ ok: false, reason: "closed" });
    expect(h.createEvent).not.toHaveBeenCalled();
  });

  it("if the calendar refuses, the time is released so they can try again", async () => {
    h.createEvent.mockRejectedValue(new Error("Unipile 500"));
    expect(await confirmProposalPick(TOKEN, T[0])).toEqual({ ok: false, reason: "booking_failed" });
    expect(st.meeting).toMatchObject({ status: "invited", scheduledAt: null });
    expect(h.attribute).not.toHaveBeenCalled();
  });

  it("an unknown link books nothing", async () => {
    st.meeting = { ...invited(), proposalToken: "other" };
    h.db.select = () => { const q: any = { from: () => q, where: () => q, limit: () => q, then: (r: any) => r([]) }; return q; };
    expect(await confirmProposalPick("tok_nope_nope_nope_nope", T[0])).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("what the page shows", () => {
  it("open, with taken times marked unavailable", async () => {
    st.others = [{ id: 1, status: "scheduled", proposedTimes: [], scheduledAt: new Date(T[0]), durationMin: 30 }];
    const v = await proposalForPick(TOKEN);
    expect(v).toMatchObject({ state: "open", title: "Intro", ownerName: "Khaja Syed", company: "CommunityForce", durationMin: 30, timezone: "America/New_York" });
    expect(v!.times).toEqual([{ iso: T[0], available: false }, { iso: T[1], available: true }, { iso: T[2], available: true }]);
    expect(v!.scheduledAt).toBeNull();
  });

  it("confirmed, with the time and the meeting link", async () => {
    st.meeting = { ...st.meeting, status: "scheduled", scheduledAt: new Date(T[1]), meetingUrl: "https://teams/x" };
    expect(await proposalForPick(TOKEN)).toMatchObject({ state: "confirmed", scheduledAt: T[1], meetingUrl: "https://teams/x" });
  });

  it("expired once every offered time has passed; closed once cancelled", async () => {
    st.meeting.proposedTimes = [new Date(Date.now() - DAY).toISOString()];
    expect((await proposalForPick(TOKEN))!.state).toBe("expired");
    st.meeting = { ...invited(), status: "cancelled" };
    expect((await proposalForPick(TOKEN))!.state).toBe("closed");
  });

  it("opening the page books nothing", async () => {
    await proposalForPick(TOKEN);
    expect(h.createEvent).not.toHaveBeenCalled();
    expect(st.updates).toEqual([]);
  });
});

describe("times that all pass without a pick", () => {
  it("close the proposal as no time picked, so they can be offered new ones", async () => {
    st.others = [
      { id: 1, workspaceId: 4, proposedTimes: [new Date(Date.now() - DAY).toISOString()] },
      { id: 2, workspaceId: 4, proposedTimes: [new Date(Date.now() - DAY).toISOString(), T[0]] },
    ];
    expect(await expireUnpickedProposals()).toBe(1);
    expect(st.updates).toEqual([{ table: meetings, set: { status: "cancelled", disposition: "no_time_picked" } }]);
  });
});

describe("wiring", () => {
  const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

  it("the page reads with a query and books only through the Confirm button's mutation", () => {
    const router = read("server/routers/meetingPicks.ts");
    expect(router).toContain("get: publicProcedure.input(z.object({ token })).query(");
    expect(router).toContain("confirm: publicProcedure");
    expect(router).toContain(".mutation(async ({ input }) => {");
    const page = read("client/src/pages/MeetingPickPage.tsx");
    // Never on load: a mail scanner opens every link.
    expect(page).not.toContain("useEffect");
    expect(page.match(/confirm\.mutate\(/g)).toHaveLength(1);
    expect(page).toContain("onClick={() => confirm.mutate({ token, time: chosen })}");
    expect(read("client/src/App.tsx")).toContain('<Route path="/m/:token"><MeetingPickPage /></Route>');
  });

  it("an emailed proposal still waiting counts as already invited, and its times as offered", () => {
    const s = read("server/services/meetingScheduler.ts");
    expect(s).toContain("or(gte(meetings.scheduledAt, new Date()), and(isNull(meetings.scheduledAt), isNotNull(meetings.proposalSentAt))),");
    expect(s).toContain('} else if (r.status === "proposed" || r.status === "invited") {');
  });

  it("the sweep runs with the invite-response check, no new timer", () => {
    expect(read("server/_core/index.ts")).toContain("expireUnpickedProposals().catch((e) =>");
  });

  it("migration 0200 adds the token (unique) and when it was sent", () => {
    const m = read("server/_core/rawMigrations.ts");
    expect(m).toContain("CREATE UNIQUE INDEX `ux_meetings_proposal_token` ON `meetings` (`proposalToken`)");
    expect(m).toContain("ALTER TABLE `meetings` ADD COLUMN `proposalSentAt` timestamp NULL");
  });
});
