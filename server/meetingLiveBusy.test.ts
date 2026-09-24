/**
 * Offered times avoid the owner's LIVE calendar (found 2026-09-24: asked to
 * regenerate CommunityForce's proposals "around Khaja's calendar", his
 * Microsoft 365 calendar had lastSyncAt null and no stored events — a
 * Unipile-bridged calendar only reaches calendar_events on a manual sync, so
 * drafting saw an empty calendar and offered times he could already be
 * booked in).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { calendarAccounts, calendarEvents, meetings, workspaceSettings, workspaces } from "../drizzle/schema";

const h = vi.hoisted(() => ({ db: null as any, listEvents: null as any }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));
vi.mock("./_core/llm", async (importActual) => ({
  ...(await importActual<typeof import("./_core/llm")>()),
  invokeLLM: async () => { throw new Error("no model in tests"); },
}));
vi.mock("./services/brandContext", async (importActual) => ({
  ...(await importActual<typeof import("./services/brandContext")>()),
  buildBrandContext: async () => "",
}));
vi.mock("./calendarAdapter", async (importActual) => ({
  ...(await importActual<typeof import("./calendarAdapter")>()),
  createCalendarAdapter: () => ({ listEvents: (...a: unknown[]) => h.listEvents(...a) }),
}));

import { createMeetingProposal, __resetLiveBusyCacheForTests } from "./services/meetingScheduler";

const DAY = 86_400_000;
const KHAJA = 5721;
type World = { accounts: unknown[]; inserts: any[] };
let w: World;

function makeDb() {
  const builder = () => {
    const st: { table?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      where() { return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void) {
        if (st.table === calendarAccounts) res(w.accounts);
        else if (st.table === workspaces) res([{ name: "CommunityForce" }]);
        else if (st.table === calendarEvents || st.table === workspaceSettings) res([]);
        else res([]);
      },
    };
    return b;
  };
  return {
    select: () => builder(),
    insert: (t: unknown) => ({
      values(v: any) { if (t === meetings) w.inserts.push(v); return Promise.resolve([{ insertId: 1 }]); },
    }),
  };
}

const target = { ownerUserId: KHAJA, relatedType: "prospect", relatedId: 7, name: "Ada Prospect", source: "ai" as const };
const times = (i = 0) => (w.inserts[i].proposedTimes as string[]).map((t) => Date.parse(t));

beforeEach(() => {
  __resetLiveBusyCacheForTests();
  w = { accounts: [{ id: 2, workspaceId: 4, userId: KHAJA, calendarId: null, unipileAccountId: "acc-ms365" }], inserts: [] };
  h.db = makeDb();
  h.listEvents = vi.fn();
});

describe("drafting reads the owner's calendar live", () => {
  it("a week the live calendar is booked solid is not offered", async () => {
    const busyUntil = Date.now() + 6 * DAY;
    h.listEvents.mockResolvedValue([{ externalId: "e1", title: "Offsite", startAt: new Date(Date.now() - DAY), endAt: new Date(busyUntil), allDay: false }]);
    await createMeetingProposal(4, target);
    expect(h.listEvents).toHaveBeenCalledTimes(1);
    expect(h.listEvents.mock.calls[0][0]).toBe("primary");
    expect(times().length).toBeGreaterThan(0);
    for (const t of times()) expect(t).toBeGreaterThanOrEqual(busyUntil);
  });

  it("with the same calendar empty, the first days ARE offered (the busy read is what moved them)", async () => {
    h.listEvents.mockResolvedValue([]);
    await createMeetingProposal(4, target);
    expect(Math.min(...times())).toBeLessThan(Date.now() + 6 * DAY);
  });

  it("a Regenerate all pass reads each calendar once, not once per proposal", async () => {
    h.listEvents.mockResolvedValue([]);
    await createMeetingProposal(4, target);
    await createMeetingProposal(4, target);
    expect(h.listEvents).toHaveBeenCalledTimes(1);
    __resetLiveBusyCacheForTests();
    await createMeetingProposal(4, target);
    expect(h.listEvents).toHaveBeenCalledTimes(2);
  });

  it("a provider failure still drafts the proposal, from the stored events", async () => {
    h.listEvents.mockRejectedValue(new Error("Unipile 503"));
    await createMeetingProposal(4, target);
    expect(times().length).toBeGreaterThan(0);
  });

  it("an owner with no calendar connected: no live read", async () => {
    w.accounts = [];
    await createMeetingProposal(4, target);
    expect(h.listEvents).not.toHaveBeenCalled();
    expect(times().length).toBeGreaterThan(0);
  });
});
