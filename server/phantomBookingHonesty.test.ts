/**
 * A meeting whose invite was never delivered must never present as booked
 * (owner, 2026-08-28: "did it invent the meetings?" — functionally, yes:
 * auto mode with no calendar "booked locally", marking rows 'scheduled' for
 * times no attendee ever received, flipping prospects to 'replied', and
 * crediting campaign KPIs. Migration 0175 deleted the accumulated phantoms
 * and reverted the derived lies; these pins keep the fiction from returning).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const scheduler = readFileSync(join(__dirname, "services", "meetingScheduler.ts"), "utf8");
const migrations = readFileSync(join(__dirname, "_core", "rawMigrations.ts"), "utf8");
const meetingsPage = readFileSync(join(__dirname, "..", "client", "src", "pages", "usip", "MeetingsV2.tsx"), "utf8");

describe("sendMeetingInvite cannot fabricate a booking", () => {
  it("the no-calendar/provider-fail path books nothing and stamps no time", () => {
    expect(scheduler).not.toContain('status: "scheduled", scheduledAt: start, inviteSent: false');
    expect(scheduler).toMatch(/return \{ sent: false, scheduledAt: null, reason: acc \? "provider_error" : "no_calendar_connected" \}/);
  });

  it("a 'scheduled' status is only ever written alongside a real invite", () => {
    // The single booking write is the provider-success path (inviteSent: true).
    const writes = scheduler.match(/status: "scheduled"/g) ?? [];
    expect(writes.length).toBe(1);
    expect(scheduler).toContain('status: "scheduled", scheduledAt: start, inviteSent: true');
  });

  it("ARE attribution fires only on genuine delivery", () => {
    // Exactly ONE call site — the sent:true provider path; none in fallbacks.
    const calls = scheduler.match(/attributeMeetingBookingToAre\(/g) ?? [];
    expect(calls.length).toBe(1);
  });
});

describe("migration 0175 removes the phantoms and only the phantoms", () => {
  const start = migrations.indexOf("0175_delete_phantom_meetings");
  const block = migrations.slice(start, migrations.indexOf("];", start));

  it("exists and targets exactly the phantom predicate", () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain("m.inviteSent = 0 AND m.calendarEventId IS NULL");
    expect(block).toContain("DELETE FROM `meetings` WHERE source = 'ai' AND inviteSent = 0");
  });

  it("reverts the derived lies: KPI credit and 'replied' status", () => {
    expect(block).toContain("SET c.meetingsBooked = GREATEST(0, c.meetingsBooked - d.n)");
    expect(block).toContain("SET pq.sequenceStatus = 'enrolled'");
    // ...but never un-marks a prospect whose 'replied' a real reply justifies.
    expect(block).toContain("s2.signalType = 'email_reply'");
  });

  it("touches no scheduled-email data (explicitly out of the owner's authorization)", () => {
    expect(block).not.toContain("are_execution_queue");
    expect(block).not.toContain("email_log");
    expect(block).not.toContain("email_replies");
  });
});

describe("the UI stops claiming bookings that never happened", () => {
  it("the old 'Meeting booked … connect a calendar' fiction is gone", () => {
    expect(meetingsPage).not.toContain("connect a calendar to auto-send the invite");
    expect(meetingsPage).toContain('r.reason === "no_calendar_connected"');
  });
});
