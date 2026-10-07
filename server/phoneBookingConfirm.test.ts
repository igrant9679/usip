/**
 * Owner, 2026-10-06: "make phone bookings wait for email confirmation too".
 * A time agreed on an AI call is a proposal with that one time: it is
 * emailed as a link to confirm, and nothing is on the calendar, or counted,
 * until the person presses Confirm.
 */
import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { meetings } from "../drizzle/schema";

type Row = Record<string, any>;
const st = { current: null as Row | null, inserts: [] as Row[], updates: [] as Row[] };
const fakeDb: any = {
  select: () => { const q: any = { from: () => q, where: () => q, limit: () => Promise.resolve(st.current ? [st.current] : []) }; return q; },
  insert: (t: unknown) => ({ values: (v: Row) => { if (t === meetings) st.inserts.push(v); return Promise.resolve([{ insertId: 600 }]); } }),
  update: () => ({ set: (v: Row) => ({ where: () => { st.updates.push(v); return Promise.resolve([{ affectedRows: 1 }]); } }) }),
};
vi.mock("./db", () => ({ getDb: async () => fakeDb }));
const sendMeetingInvite = vi.fn(async () => ({ sent: true, scheduledAt: null, offered: ["2026-10-08T19:00:00.000Z"] }));
vi.mock("./services/meetingScheduler", async (a) => ({ ...(await a<typeof import("./services/meetingScheduler")>()), sendMeetingInvite: (...x: unknown[]) => (sendMeetingInvite as any)(...x) }));

import { realDeps } from "./services/voiceRelay";
import { proposalEmailBodies } from "./services/meetingProposalEmail";

const ctx: any = {
  workspaceId: 4, ownerUserId: 5721, prospectId: 77, personName: "Dana Reyes", personCompany: "Acme",
  personTz: "America/Chicago", companyName: "CommunityForce", isTest: false, callRowId: 31,
};
const ISO = "2026-10-08T19:00:00.000Z";

beforeEach(() => {
  st.current = null;
  st.inserts = [];
  st.updates = [];
  sendMeetingInvite.mockClear();
});

describe("a time agreed on a call", () => {
  it("is a proposal of that one time, never an agreed (scheduled) one, sent through the one send path", async () => {
    expect(await realDeps.book(ctx, ISO, "dana@acme.com", null)).toEqual({ ok: true, meetingId: 600, reason: undefined });
    const row = st.inserts[0];
    expect(row).toMatchObject({ status: "proposed", proposedTimes: [ISO], contactEmail: "dana@acme.com", relatedType: "prospect", relatedId: 77 });
    // No scheduledAt: that is what sends it as a link to confirm rather than a calendar event.
    expect(row).not.toHaveProperty("scheduledAt");
    expect(row.inviteMessage).toContain("Please confirm the time we agreed");
    expect(sendMeetingInvite).toHaveBeenCalledWith(4, 600, ISO);
  });

  it("a second pick on the same call goes back to a proposal, so a fresh link replaces the first", async () => {
    st.current = { scheduledAt: null };
    const later = "2026-10-09T15:00:00.000Z";
    await realDeps.book(ctx, later, "dana@acme.com", 600);
    expect(st.updates[0]).toMatchObject({ status: "proposed", proposalToken: null, proposalSentAt: null, inviteSent: false, proposedTimes: [later] });
    expect(sendMeetingInvite).toHaveBeenCalledWith(4, 600, later);
  });

  it("if they already confirmed from the email during the call, nothing is changed or re-sent", async () => {
    st.current = { scheduledAt: new Date(ISO) };
    expect(await realDeps.book(ctx, "2026-10-09T15:00:00.000Z", "dana@acme.com", 600)).toEqual({ ok: false, meetingId: 600, reason: "already_confirmed" });
    expect(st.updates).toEqual([]);
    expect(sendMeetingInvite).not.toHaveBeenCalled();
  });
});

describe("the email for one agreed time", () => {
  it("asks them to confirm it, not to pick one", () => {
    const { html, text } = proposalEmailBodies({
      inviteMessage: "Thanks for taking the call. Please confirm the time we agreed: Thursday at 2 PM.",
      times: [new Date(ISO)], timezone: "America/Chicago", token: "tok_abcdefghijklmnopqrstuvwxyz0123", signature: "", unsubscribeUrl: "https://x/u",
    });
    for (const s of [html, text]) {
      expect(s).toContain("Confirm this time:");
      expect(s).not.toContain("Pick a time that works for you");
      expect(s).toContain("The link opens a page to confirm it, and the calendar invite follows.");
    }
  });
});

describe("what the agent says", () => {
  const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

  it("tells them to confirm from the email, and never that an invite is on its way", () => {
    const script = read("services/voiceCallScript.ts");
    expect(script).toContain("Tell them you have emailed them a link to confirm that time: once they open it and press Confirm, the calendar invite follows.");
    expect(script).not.toContain("Tell them the calendar invite is on its way");
    const relay = read("services/voiceRelay.ts");
    expect(relay).toContain('say: "I\'ve emailed you a link to confirm that time. Once you press Confirm, the calendar invite follows."');
    expect(relay).not.toContain("they need to accept it in their calendar");
  });

  it("the owner is told the time was agreed and is waiting for their confirmation", () => {
    const relay = read("services/voiceRelay.ts");
    expect(relay).toContain("agreed a time with ${who} and emailed them a link to confirm it. It goes on your calendar, and counts, once they confirm.");
  });
});
