/**
 * Every meeting invite carries a Microsoft Teams link, unless the proposal
 * has an alternate link (owner ask 2026-09-24: "the MS Teams Meeting Link
 * should be enabled and included in the invite, I should also be able to
 * provide an alternate meeting link as well").
 *
 * Unipile creates the Teams meeting itself when the conference has provider
 * "teams" and NO url ("If not provided, it will automatically create a new
 * conference — only teams and google_meet available"); the create response
 * is the event id only, so the join link is read back from the event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const createCalendarEvent = vi.fn();
const getCalendarEvent = vi.fn();
vi.mock("./lib/unipile", async (importOriginal) => {
  const real = await importOriginal<typeof import("./lib/unipile")>();
  return { ...real, createCalendarEvent: (...a: unknown[]) => createCalendarEvent(...a), getCalendarEvent: (...a: unknown[]) => getCalendarEvent(...a) };
});

const { UnipileCalendarAdapter } = await import("./unipileCalendarAdapter");
const account = { id: 1, workspaceId: 4, userId: 2, provider: "outlook_oauth", unipileAccountId: "acc-1" } as never;
const base = { title: "CommunityForce intro", startAt: new Date("2026-09-28T14:00:00Z"), endAt: new Date("2026-09-28T14:30:00Z"), attendees: [{ email: "prospect@example.org" }] };

beforeEach(() => {
  createCalendarEvent.mockReset().mockResolvedValue({ object: "EventCreated", event_id: "evt-1" });
  getCalendarEvent.mockReset();
});

describe("the Unipile adapter", () => {
  it("asks Unipile to generate a Teams meeting (no url) and returns the link read back from the event", async () => {
    getCalendarEvent.mockResolvedValue({ id: "evt-1", conference: { provider: "teams", url: "https://teams.microsoft.com/l/meetup-join/abc" } });
    const res = await new UnipileCalendarAdapter(account).createEvent("cal-9", { ...base, onlineMeeting: "teams" });
    expect(createCalendarEvent.mock.calls[0][0].conference).toEqual({ provider: "teams" });
    expect(getCalendarEvent).toHaveBeenCalledWith("cal-9", "evt-1", "acc-1");
    expect(res.meetingUrl).toBe("https://teams.microsoft.com/l/meetup-join/abc");
  });

  it("attaches an alternate link as-is and does not generate a Teams meeting", async () => {
    const res = await new UnipileCalendarAdapter(account).createEvent("cal-9", { ...base, meetingUrl: "https://zoom.us/j/123", onlineMeeting: "teams" });
    expect(createCalendarEvent.mock.calls[0][0].conference).toEqual({ provider: "zoom", url: "https://zoom.us/j/123" });
    expect(getCalendarEvent).not.toHaveBeenCalled();
    expect(res.meetingUrl).toBe("https://zoom.us/j/123");
  });

  it("sends no conference at all when neither is asked for", async () => {
    await new UnipileCalendarAdapter(account).createEvent("cal-9", base);
    expect(createCalendarEvent.mock.calls[0][0].conference).toBeUndefined();
    expect(getCalendarEvent).not.toHaveBeenCalled();
  });

  it("a failed read-back never fails the invite that already went out", async () => {
    getCalendarEvent.mockRejectedValue(new Error("Unipile 500"));
    const res = await new UnipileCalendarAdapter(account).createEvent("cal-9", { ...base, onlineMeeting: "teams" });
    expect(res.externalId).toBe("evt-1");
    expect(res.meetingUrl).toBeUndefined();
  });
});

describe("the invite sender and the proposal editor", () => {
  const svc = readFileSync("server/services/meetingScheduler.ts", "utf8");
  const router = readFileSync("server/routers/meetings.ts", "utf8");
  const page = readFileSync("client/src/pages/usip/MeetingsV2.tsx", "utf8");

  it("sendMeetingInvite: alternate link wins and goes into the text; otherwise a Teams meeting is requested", () => {
    const send = svc.slice(svc.indexOf("export async function sendMeetingInvite("));
    expect(send).toContain("const altLink = m.meetingUrl?.trim() || null;");
    expect(send).toContain('meetingUrl: altLink ?? undefined,');
    expect(send).toContain('onlineMeeting: altLink ? undefined : "teams",');
    expect(send).toContain("altLink ? `Join: ${altLink}` : \"\"");
    // The generated link is what the meeting row keeps.
    expect(send).toContain("meetingUrl: result.meetingUrl ?? null");
  });

  it("updateProposal takes an https link, and an empty string clears it", () => {
    const upd = router.slice(router.indexOf("updateProposal: repProcedure"), router.indexOf("proposalOwners: workspaceProcedure"));
    expect(upd).toContain("meetingUrl: z.union([z.string().trim().url().max(1000)");
    expect(upd).toContain('set.meetingUrl = input.meetingUrl === "" ? null : input.meetingUrl;');
  });

  it("the card says which link the invite will carry, and the editor can set or clear one", () => {
    expect(page).toContain("Microsoft Teams link added to the invite when it is sent");
    expect(page).toContain('<Label className="text-[11px]">Meeting link (optional)</Label>');
    expect(page).toContain("meetingUrl: draftLink.trim(),");
  });
});
