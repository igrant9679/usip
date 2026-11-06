/**
 * Audit 2026-10-20, O30 (the part left open): meeting reminders printed the
 * time in UTC, skipped the suppression check that invites already make, and
 * carried no way to opt out.
 *
 * The cron runs against a fake db; the send is mocked. The expected time is
 * computed from the zone for that date (formatInZone), never a frozen offset.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatInZone } from "@shared/availability";

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  due: [] as Row[],
  stamps: [] as Row[],
  sent: [] as Row[],
  suppressed: new Set<string>(),
  suppressionFails: false,
}));

const fakeDb: any = {
  select: () => {
    const q: any = {
      from() { return q; }, where() { return q; },
      limit() { return Promise.resolve(h.due); },
    };
    return q;
  },
  update: () => ({ set: (v: Row) => ({ where: () => { h.stamps.push(v); return Promise.resolve([]); } }) }),
};
vi.mock("./db", () => ({ getDb: async () => fakeDb }));
vi.mock("./_core/workspaceArchive", () => ({ archivedWorkspaceIds: async () => new Set<number>() }));
vi.mock("./services/sendWindow", () => ({ inSendWindow: async () => true }));
vi.mock("./mergeVars", () => ({ resolveBookingUrl: async () => "https://app.test/b/host-5" }));
vi.mock("./services/workspaceTimezone", () => ({ getWorkspaceTimezone: async () => "America/New_York" }));
vi.mock("./services/suppression", () => ({
  findSuppression: async (_ws: number, t: { email: string }) => {
    if (h.suppressionFails) throw new Error("Database unavailable — suppression could not be checked");
    return h.suppressed.has(t.email) ? { list: "email_suppressions", matched: "email", reason: "unsubscribe" } : null;
  },
}));
vi.mock("./emailDelivery", () => ({
  sendWorkspaceEmail: async (_ws: number, opts: Row) => { h.sent.push(opts); return { ok: true }; },
}));

import { sendDueMeetingReminders } from "./services/meetingReminders";

const meeting = (over: Row = {}) => ({
  id: 1, workspaceId: 2, ownerUserId: 5, status: "scheduled", title: "Intro call",
  contactEmail: "pat@example.org", contactName: "Pat",
  scheduledAt: new Date(Date.now() + 6 * 3600_000), meetingUrl: null, reminderSentAt: null,
  ...over,
});

beforeEach(() => {
  h.due = [meeting()];
  h.stamps.length = 0;
  h.sent.length = 0;
  h.suppressed.clear();
  h.suppressionFails = false;
});

describe("meeting reminders", () => {
  it("name the time in the workspace's zone, not UTC", async () => {
    await sendDueMeetingReminders();
    expect(h.sent).toHaveLength(1);
    const when = formatInZone(h.due[0].scheduledAt, "America/New_York");
    expect(h.sent[0].subject).toBe(`Reminder: Intro call — ${when}`);
    expect(h.sent[0].html).toContain(when);
    expect(h.sent[0].html).not.toMatch(/ UTC</);
  });

  it("carry an unsubscribe link and the List-Unsubscribe headers", async () => {
    await sendDueMeetingReminders();
    const s = h.sent[0];
    expect(s.headers?.["List-Unsubscribe"]).toMatch(/^<.*\/api\/unsubscribe\/.+>$/);
    expect(s.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const url = s.headers["List-Unsubscribe"].slice(1, -1);
    expect(s.html).toContain(`href="${url}"`);
    expect(s.html).toContain("Unsubscribe");
  });

  it("are not sent to a suppressed address, and that is asked once (stamped)", async () => {
    h.suppressed.add("pat@example.org");
    const r = await sendDueMeetingReminders();
    expect(h.sent).toEqual([]);
    expect(r.sent).toBe(0);
    expect(h.stamps).toHaveLength(1);
    expect(h.stamps[0].reminderSentAt).toBeInstanceOf(Date);
  });

  it("a suppression check that fails sends nothing and stamps nothing, so it is asked again", async () => {
    h.suppressionFails = true;
    await sendDueMeetingReminders();
    expect(h.sent).toEqual([]);
    expect(h.stamps).toEqual([]);
  });

  it("one suppressed attendee does not hold back the others", async () => {
    h.suppressed.add("pat@example.org");
    h.due = [meeting(), meeting({ id: 2, contactEmail: "sam@example.org" })];
    await sendDueMeetingReminders();
    expect(h.sent.map((s) => s.to)).toEqual(["sam@example.org"]);
  });
});
