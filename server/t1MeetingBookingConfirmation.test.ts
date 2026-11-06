/**
 * Tracker item 10 (2026-11-06): "Did not receive e-mail confirming the
 * meeting." The tester pressed Preview on Meetings, which opens their own
 * booking page, and booked a slot. The only message a booker ever got was the
 * calendar provider's invite, so whenever sendMeetingInvite did not send one
 * (no calendar connected, the calendar refused, or the address already had a
 * meeting) nothing reached them at all — and the rep was told "No calendar
 * connected" whatever the real reason was.
 *
 * Pinned: the booker is emailed a confirmation when no invite went, through
 * the proposal email's sender rules, suppression and cap; the rep's
 * notification names the real reason; the page says only what happened.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leads, meetings, notifications, activities, users } from "../drizzle/schema";
import { formatInZone } from "@shared/availability";

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  inserts: [] as Array<{ table: unknown; values: Row }>,
  updates: [] as Row[],
  hostName: "Host Person" as string | null,
}));

const fakeDb: any = {
  select: () => {
    const st: { table?: unknown } = {};
    const q: any = {
      from(t: unknown) { st.table = t; return q; },
      where() { return q; },
      orderBy() { return q; },
      limit() { return q; },
      then(res: any, rej: any) {
        // hostName null stands for a users read that fails.
        if (st.table === users && h.hostName === null) return Promise.reject(new Error("connection lost")).then(res, rej);
        const rows = st.table === users ? [{ name: h.hostName }] : [];
        return Promise.resolve(rows).then(res, rej);
      },
      catch(rej: any) { return q.then(undefined, rej); },
    };
    return q;
  },
  insert: (table: unknown) => ({
    values(v: Row) {
      h.inserts.push({ table, values: v });
      return Promise.resolve([{ insertId: table === leads ? 11 : table === meetings ? 21 : 1 }]);
    },
  }),
  update: () => ({ set: (v: Row) => ({ where: () => { h.updates.push(v); return Promise.resolve([]); } }) }),
};
vi.mock("./db", () => ({ getDb: async () => fakeDb }));
vi.mock("./_core/activeMembers", () => ({ isActiveMember: async () => true, activeMemberIds: async () => [] }));
vi.mock("./services/workflowEngine", () => ({ fireRecordCreated: async () => {} }));
vi.mock("./services/hostedChat", () => ({ hostedPageChatSlug: async () => null }));

const sendMeetingInvite = vi.fn();
vi.mock("./services/meetingScheduler", () => ({ sendMeetingInvite: (...a: any[]) => sendMeetingInvite(...a) }));

const sendBookingConfirmationEmail = vi.fn();
vi.mock("./services/bookingConfirmationEmail", async (orig) => ({
  ...(await orig<typeof import("./services/bookingConfirmationEmail")>()),
  sendBookingConfirmationEmail: (...a: any[]) => sendBookingConfirmationEmail(...a),
}));

// The confirmation service's own dependencies, for its tests below.
const findSuppression = vi.fn();
vi.mock("./services/suppression", () => ({ findSuppression: (...a: any[]) => findSuppression(...a) }));
const proposalSender = vi.fn();
vi.mock("./services/meetingProposalEmail", () => ({
  proposalSender: (...a: any[]) => proposalSender(...a),
  signatureFor: async () => "Host Person\nAcme",
}));
const sendEmail = vi.fn();
vi.mock("./emailAdapter", () => ({ createEmailAdapter: () => ({ sendEmail: (...a: any[]) => sendEmail(...a) }) }));
const assertSendAllowed = vi.fn();
vi.mock("./sendLimits", () => ({ assertSendAllowed: (...a: any[]) => assertSendAllowed(...a) }));

import { bookSlotForLink, openSlotsForLink, bookingOutcomeLine } from "./routers/bookingLinks";

const link: any = {
  id: 7, workspaceId: 2, userId: 5, slug: "host-5", title: "Intro call", description: null,
  durationMin: 30, active: true, bookingCount: 0,
  timezone: "America/New_York", startHour: 9, endHour: 17, workDays: "1,2,3,4,5",
};

async function bookFirstSlot() {
  const slots = await openSlotsForLink(link);
  expect(slots.length).toBeGreaterThan(0);
  const startAt = new Date(slots[0]);
  const res = await bookSlotForLink(link, { startAt, name: "Pat Booker", email: "pat@example.org" });
  return { res, startAt };
}

const notification = () => h.inserts.find((i) => i.table === notifications)?.values;
const activity = () => h.inserts.find((i) => i.table === activities)?.values;

beforeEach(() => {
  h.inserts.length = 0;
  h.updates.length = 0;
  h.hostName = "Host Person";
  sendMeetingInvite.mockReset();
  sendBookingConfirmationEmail.mockReset();
  sendBookingConfirmationEmail.mockResolvedValue({ ok: true, fromEmail: "host@acme.test" });
});

describe("a booking with no calendar invite emails the booker a confirmation", () => {
  it("no calendar connected: the confirmation goes, with the booking's details", async () => {
    sendMeetingInvite.mockResolvedValue({ sent: false, scheduledAt: null, reason: "no_calendar_connected" });
    const { res, startAt } = await bookFirstSlot();
    expect(sendBookingConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(sendBookingConfirmationEmail).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 2, meetingId: 21, title: "Intro call", startAt, durationMin: 30,
      timezone: "America/New_York", hostName: "Host Person", ownerUserId: 5,
      contactEmail: "pat@example.org", contactName: "Pat Booker", relatedType: "lead", relatedId: 11,
    }));
    expect(res).toMatchObject({ calendarBooked: false, confirmationSent: true });
    expect(notification()?.body).toContain("no calendar is connected");
    expect(notification()?.body).toContain("A confirmation email went to pat@example.org.");
    expect(activity()?.body).toContain("A confirmation email went to pat@example.org.");
  });

  it("an invite that went needs no confirmation email", async () => {
    sendMeetingInvite.mockResolvedValue({ sent: true, scheduledAt: new Date().toISOString() });
    const { res } = await bookFirstSlot();
    expect(sendBookingConfirmationEmail).not.toHaveBeenCalled();
    expect(res).toMatchObject({ calendarBooked: true, confirmationSent: false });
    expect(notification()?.body).toContain("Calendar invite sent.");
  });

  it("the rep is told the real reason, not 'No calendar connected' for every failure", async () => {
    sendMeetingInvite.mockResolvedValue({ sent: false, scheduledAt: null, reason: "already_invited" });
    await bookFirstSlot();
    expect(notification()?.body).toContain("they already have an upcoming meeting with you");
    expect(notification()?.body).not.toContain("No calendar connected");
    expect(notification()?.body).not.toContain("no calendar is connected");

    h.inserts.length = 0;
    sendMeetingInvite.mockResolvedValue({ sent: false, scheduledAt: null, reason: "provider_error" });
    await bookFirstSlot();
    expect(notification()?.body).toContain("your calendar refused the event");
  });

  it("a confirmation that could not go is said, so the rep contacts them", async () => {
    sendMeetingInvite.mockResolvedValue({ sent: false, scheduledAt: null, reason: "no_calendar_connected" });
    sendBookingConfirmationEmail.mockResolvedValue({ ok: false, reason: "suppressed" });
    const { res } = await bookFirstSlot();
    expect(res).toMatchObject({ confirmationSent: false });
    expect(notification()?.body).toContain("No confirmation email went either (they are on the suppression list) — contact them.");
  });

  it("a failed host-name lookup does not sink a booking that already happened", async () => {
    sendMeetingInvite.mockResolvedValue({ sent: false, scheduledAt: null, reason: "no_calendar_connected" });
    h.hostName = null;
    await bookFirstSlot();
    expect(sendBookingConfirmationEmail).toHaveBeenCalledWith(expect.objectContaining({ hostName: "your host" }));
  });

  it("bookingOutcomeLine: an unknown reason is named, never dressed up as no calendar", () => {
    expect(bookingOutcomeLine({ sent: false, reason: "time_in_past" }, "x@y.z", null)).toBe("No calendar invite went (time_in_past).");
  });
});

describe("the confirmation email itself", () => {
  let svc: typeof import("./services/bookingConfirmationEmail");
  const input = () => ({
    workspaceId: 2, meetingId: 21, title: "Intro call", startAt: new Date(Date.now() + 3 * 86400000),
    durationMin: 30, timezone: "America/New_York", hostName: "Host Person", ownerUserId: 5,
    contactEmail: "pat@example.org", contactName: "Pat Booker", relatedType: "lead", relatedId: 11,
  });
  beforeEach(async () => {
    svc = await vi.importActual<typeof import("./services/bookingConfirmationEmail")>("./services/bookingConfirmationEmail");
    findSuppression.mockReset().mockResolvedValue(null);
    proposalSender.mockReset().mockResolvedValue({ id: 9, fromEmail: "host@acme.test", fromName: "Host Person", name: "Host" });
    sendEmail.mockReset().mockResolvedValue({ messageId: "m-1" });
    assertSendAllowed.mockReset().mockResolvedValue(undefined);
  });

  it("goes from the host's mailbox, with the time in the link's zone, untracked, with an opt-out", async () => {
    const i = input();
    const r = await svc.sendBookingConfirmationEmail(i);
    expect(r).toEqual({ ok: true, fromEmail: "host@acme.test" });
    expect(proposalSender).toHaveBeenCalledWith(2, 5);
    expect(assertSendAllowed).toHaveBeenCalledWith(2, 9);
    const sent = sendEmail.mock.calls[0][0];
    const when = formatInZone(i.startAt, "America/New_York");
    expect(sent.to).toBe("pat@example.org");
    expect(sent.subject).toBe(`Confirmed: Intro call — ${when}`);
    expect(sent.bodyText).toContain(`${when} · 30 min`);
    expect(sent.bodyText).toContain("Your meeting with Host Person is booked.");
    expect(sent.bodyText).toContain("reply to this email");
    expect(sent.track).toBe(false);
    expect(sent.headers["List-Unsubscribe"]).toMatch(/^<.*\/api\/unsubscribe\/.+>$/);
    expect(sent.logMeta).toMatchObject({ source: "meeting_confirmation", leadId: 11 });
  });

  it("a suppressed address is not emailed", async () => {
    findSuppression.mockResolvedValue({ list: "email_suppressions", matched: "email", reason: "unsubscribe" });
    expect(await svc.sendBookingConfirmationEmail(input())).toEqual({ ok: false, reason: "suppressed" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("no mailbox, or a mailbox at its cap, sends nothing and says why", async () => {
    proposalSender.mockResolvedValue(null);
    expect(await svc.sendBookingConfirmationEmail(input())).toEqual({ ok: false, reason: "no_mailbox" });
    proposalSender.mockResolvedValue({ id: 9, fromEmail: "host@acme.test", name: "Host" });
    assertSendAllowed.mockRejectedValue(new Error("Daily limit reached"));
    expect(await svc.sendBookingConfirmationEmail(input())).toMatchObject({ ok: false, reason: "send_limit" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("never throws into the booking", async () => {
    sendEmail.mockRejectedValue(new Error("SMTP 550"));
    expect(await svc.sendBookingConfirmationEmail(input())).toMatchObject({ ok: false, reason: "send_failed", detail: "SMTP 550" });
    findSuppression.mockRejectedValue(new Error("Database unavailable"));
    expect(await svc.sendBookingConfirmationEmail(input())).toMatchObject({ ok: false, reason: "send_failed" });
  });

  it("the HTML escapes what the booker typed", () => {
    const b = svc.bookingConfirmationBodies({
      title: "<b>Intro</b>", startAt: new Date(Date.now() + 86400000), durationMin: 30, timezone: "UTC",
      hostName: "Host & Co", contactName: "<script>", signature: "", unsubscribeUrl: "https://x.test/u",
    });
    expect(b.html).not.toContain("<script>");
    expect(b.html).toContain("&lt;b&gt;Intro&lt;/b&gt;");
    expect(b.html).toContain("Host &amp; Co");
  });
});

describe("the page and the public procedure say what happened", () => {
  const router = readFileSync(path.join(__dirname, "routers", "bookingLinks.ts"), "utf8");
  const page = readFileSync(path.join(__dirname, "..", "client", "src", "pages", "BookingPage.tsx"), "utf8");
  it("book() returns whether a confirmation email went", () => {
    const book = router.slice(router.indexOf("  book: publicProcedure"));
    expect(book).toContain("confirmationSent: booked.confirmationSent,");
  });
  it("BookingPage has a line for each outcome, and no promise when nothing was sent", () => {
    expect(page).toContain("setConfirmationSent(!!r?.confirmationSent)");
    expect(page).toContain("A calendar invite is on its way to {email}.");
    expect(page).toContain("A confirmation email is on its way to {email}.");
    expect(page).toContain("no email could be sent to you");
    expect(page).not.toContain("will confirm shortly");
  });
});
