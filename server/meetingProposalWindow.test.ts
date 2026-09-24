/**
 * Meeting proposals offer times from 9:00 to 16:00 in the workspace's zone
 * (owner ask 2026-09-24: "suggested dates/times range from 9am - 4pm EST"),
 * and every proposal already in the queue that offers something else is
 * regenerated.
 *
 * The window is tested through the real generator, including the fallback
 * path a busy calendar takes, because the preferred 10:00/14:00 hours sit
 * inside ANY sane window and would hide a wrong bound. The outdated rule is
 * pure and tested directly. The wiring is checked structurally.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeSlots,
  proposalIsOutdated,
  PROPOSAL_FIRST_START_HOUR,
  PROPOSAL_LAST_START_HOUR,
} from "./services/meetingScheduler";

const NY = "America/New_York";
const svc = readFileSync("server/services/meetingScheduler.ts", "utf8");
const router = readFileSync("server/routers/meetings.ts", "utf8");
const page = readFileSync("client/src/pages/usip/MeetingsV2.tsx", "utf8");

function minutesIn(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")!.value) % 24;
  const m = Number(parts.find((p) => p.type === "minute")!.value);
  return h * 60 + m;
}

/** Busy blocks covering every local hour of the next 20 days EXCEPT `freeHours`, in `tz`. */
function busyExcept(freeHours: number[], tz: string): Array<{ startAt: Date; endAt: Date }> {
  const busy: Array<{ startAt: Date; endAt: Date }> = [];
  const now = Date.now();
  for (let h = 0; h < 24 * 21; h++) {
    const start = new Date(Math.floor(now / 3600000) * 3600000 + h * 3600000);
    const local = Math.floor(minutesIn(start.toISOString(), tz) / 60);
    if (freeHours.includes(local)) continue;
    busy.push({ startAt: start, endAt: new Date(start.getTime() + 3600000) });
  }
  return busy;
}

describe("the window is 9:00 to 16:00", () => {
  it("is declared as 9 and 16", () => {
    expect(PROPOSAL_FIRST_START_HOUR).toBe(9);
    expect(PROPOSAL_LAST_START_HOUR).toBe(16);
  });

  it("offers 16:00 when it is the only free hour, and never 17:00 or later", () => {
    const slots = computeSlots(busyExcept([16, 17, 18], NY), 3, 30, NY);
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(minutesIn(s, NY)).toBe(16 * 60);
  });

  it("offers 9:00 when it is the only free hour, and never 8:00 or earlier", () => {
    const slots = computeSlots(busyExcept([7, 8, 9], NY), 3, 30, NY);
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(minutesIn(s, NY)).toBe(9 * 60);
  });

  it("offers nothing when only out-of-window hours are free", () => {
    expect(computeSlots(busyExcept([7, 8, 17, 18, 19], NY), 3, 30, NY)).toEqual([]);
  });

  it("keeps every fallback slot inside the window on a busy calendar", () => {
    // Preferred 10:00 and 14:00 taken every day: the fallback walks the rest.
    const slots = computeSlots(busyExcept([9, 11, 12, 13, 15, 16, 17], NY), 3, 30, NY);
    expect(slots.length).toBe(3);
    for (const s of slots) {
      const m = minutesIn(s, NY);
      expect(m).toBeGreaterThanOrEqual(9 * 60);
      expect(m).toBeLessThanOrEqual(16 * 60);
    }
  });
});

describe("proposalIsOutdated", () => {
  const NOW = Date.parse("2026-09-24T12:00:00Z"); // Thu 08:00 New York
  const at = (isoLocalNy: string) => new Date(`${isoLocalNy}-04:00`).toISOString(); // EDT

  it("leaves an all-future, all-in-window proposal alone", () => {
    expect(proposalIsOutdated([at("2026-09-25T10:00:00"), at("2026-09-25T14:00:00"), at("2026-09-28T16:00:00")], NY, NOW)).toBe(false);
  });

  it("flags any time starting after 16:00, the old window's 17:00 included", () => {
    expect(proposalIsOutdated([at("2026-09-25T10:00:00"), at("2026-09-25T17:00:00")], NY, NOW)).toBe(true);
    expect(proposalIsOutdated([at("2026-09-25T16:30:00")], NY, NOW)).toBe(true);
  });

  it("flags any time before 9:00", () => {
    expect(proposalIsOutdated([at("2026-09-25T08:00:00"), at("2026-09-25T14:00:00")], NY, NOW)).toBe(true);
  });

  it("flags a proposal whose every time has passed", () => {
    expect(proposalIsOutdated([at("2026-09-22T10:00:00"), at("2026-09-23T14:00:00")], NY, NOW)).toBe(true);
  });

  it("reads the window in the workspace zone, not UTC", () => {
    // 10:00 UTC is 6:00 in New York: fine for a UTC workspace, outdated for an Eastern one.
    const t = ["2026-09-25T10:00:00.000Z"];
    expect(proposalIsOutdated(t, "UTC", NOW)).toBe(false);
    expect(proposalIsOutdated(t, NY, NOW)).toBe(true);
  });

  it("leaves a proposal with no times alone — a creation failure, not staleness", () => {
    expect(proposalIsOutdated([], NY, NOW)).toBe(false);
    expect(proposalIsOutdated(null, NY, NOW)).toBe(false);
  });

  it("treats an unreadable time as outdated", () => {
    expect(proposalIsOutdated(["not a date"], NY, NOW)).toBe(true);
  });
});

describe("the queue is regenerated", () => {
  const sweep = svc.slice(svc.indexOf("export async function regenerateStaleProposals("), svc.indexOf("/** Draft + persist a proposed meeting for one prospect."));

  it("the sweep selects by the outdated rule in the workspace zone", () => {
    expect(sweep.length).toBeGreaterThan(200);
    expect(sweep).toContain("const tz = await getWorkspaceTimezone(workspaceId);");
    expect(sweep).toContain("proposalIsOutdated(r.proposedTimes, tz, nowMs)");
    expect(sweep).toContain("return { regenerated: done, remaining: outdated.length - done };");
  });

  it("unattended stays autopilot-only; attended reaches every proposal without an agreed time", () => {
    expect(sweep).toContain('if (!opts?.anySource) where.push(eq(meetings.source, "ai"));');
    expect(sweep).toContain("isNull(meetings.scheduledAt)");
    expect(router).toContain("regenerateStaleProposals(ctx.workspace.id, 10, { anySource: true })");
    const tick = svc.slice(svc.indexOf("export async function runMeetingAutopilotAllWorkspaces"));
    expect(tick).toContain("regenerateStaleProposals(ws.workspaceId, 10)");
    expect(tick).not.toContain("anySource");
  });

  it("the tick regenerates BEFORE the daily cap can skip the workspace", () => {
    const tick = svc.slice(svc.indexOf("export async function runMeetingAutopilotAllWorkspaces"));
    const tryAt = tick.indexOf("try {");
    const sweepAt = tick.indexOf("regenerateStaleProposals(");
    const capAt = tick.indexOf("if (remaining <= 0) continue;");
    expect(tryAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeGreaterThan(tryAt);
    expect(capAt).toBeGreaterThan(sweepAt);
    // No skip of ANY kind may sit between the start of a workspace's work and
    // the sweep: regeneration creates nothing, so nothing about new-proposal
    // budgets may gate it.
    expect(tick.slice(tryAt, sweepAt)).not.toMatch(/\bcontinue\b|\breturn\b|\bbreak\b/);
  });

  it("regeneration never sends", () => {
    const regen = svc.slice(svc.indexOf("export async function regenerateMeetingProposal("), svc.indexOf("export function proposalIsOutdated("));
    expect(regen.length).toBeGreaterThan(200);
    expect(regen).not.toContain("sendMeetingInvite(");
    expect(sweep).not.toContain("sendMeetingInvite(");
  });

  it("the page offers the attended pass and reports what is left", () => {
    expect(page).toContain("trpc.meetings.regenerateAllOutdated.useMutation");
    expect(page).toContain("onClick={() => regenerateAllOutdated.mutate()}");
    expect(page).toContain("still outdated — click again");
    expect(page).not.toContain("regenerateAllExpired");
  });
});
