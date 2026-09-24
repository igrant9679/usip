/**
 * Reassigning meeting proposals (owner ask 2026-09-24: "Add the control to
 * reassign proposals to Khaja"). An invite sends from its OWNER's calendar
 * (sendMeetingInvite), so ownership decides whether an invite can go out at
 * all and whether it carries a Teams link. All 154 CommunityForce proposals
 * belonged to Idris Grant, who has no calendar there.
 *
 * Through the real procedures via createCaller, against a recording db.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { auditLog, calendarAccounts, meetings, users, workspaceMembers, workspaces } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { appRouter } from "./routers";

const WS = { id: 4, name: "CommunityForce" };
const IDRIS = 2;
const KHAJA = 5721;
const dialect = new MySqlDialect();
const render = (x: unknown) => dialect.sqlToQuery(x as any);

type World = {
  /** Active members, as activeMemberIds sees them. */
  active: number[];
  members: { userId: number; name: string | null; email: string | null }[];
  calendars: { userId: number; unipileAccountId: string | null }[];
  proposals: { id: number; ownerUserId: number | null }[];
  updates: { set: Record<string, unknown>; where: unknown }[];
  inserts: { table: unknown; values: any }[];
  /** The WHERE of the member-list query (joined to users). */
  memberWhere?: unknown;
};
let w: World;

function makeDb() {
  const builder = () => {
    const st: { table?: unknown; join?: unknown; where?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin(t: unknown) { st.join = t; return b; },
      where(c: unknown) { st.where = c; return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void) {
        if (st.join === workspaces) {
          // The workspace middleware. lastActiveAt fresh, so its touch-update
          // never fires and every captured update is the procedure's own.
          res([{
            ws: { ...WS, ownerUserId: IDRIS, archivedAt: null },
            mb: { id: 1, userId: IDRIS, workspaceId: WS.id, role: "rep", deactivatedAt: null, lastActiveAt: new Date() },
          }]);
        } else if (st.join === users) { w.memberWhere = st.where; res(w.members); }
        else if (st.table === workspaceMembers) res(w.active.map((userId) => ({ userId })));
        else if (st.table === calendarAccounts) res(w.calendars);
        else if (st.table === meetings) res(w.proposals);
        else res([]);
      },
    };
    return b;
  };
  return {
    select: () => builder(),
    insert: (t: unknown) => ({
      values(v: unknown) { w.inserts.push({ table: t, values: v }); return Promise.resolve([{ insertId: 1 }]); },
    }),
    update: () => {
      const u: any = {};
      const b: any = {
        set(v: Record<string, unknown>) { u.set = v; return b; },
        where(c: unknown) { u.where = c; w.updates.push(u); return Promise.resolve([]); },
      };
      return b;
    },
  };
}

function caller() {
  return appRouter.createCaller({
    user: {
      id: IDRIS, openId: "user-2", email: "idris@example.com", name: "Idris Grant",
      loginMethod: "manus", role: "user",
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  w = {
    active: [IDRIS, KHAJA],
    members: [
      { userId: IDRIS, name: "Idris Grant", email: "idris@example.com" },
      { userId: KHAJA, name: "Khaja Syed", email: "khaja@example.org" },
      { userId: 77, name: null, email: "caldav@example.org" },
    ],
    calendars: [
      { userId: KHAJA, unipileAccountId: "acc-ms365" },
      { userId: 77, unipileAccountId: null },
    ],
    proposals: [{ id: 10, ownerUserId: IDRIS }, { id: 11, ownerUserId: null }],
    updates: [],
    inserts: [],
  };
  h.db = makeDb();
});

describe("meetings.reassignProposals", () => {
  it("moves every open proposal to the member, and only open proposals of this workspace", async () => {
    const res = await caller().meetings.reassignProposals({ toUserId: KHAJA });
    expect(res).toEqual({ reassigned: 2 });
    expect(w.updates).toHaveLength(1);
    const { set, where } = w.updates[0];
    expect(set.ownerUserId).toBe(KHAJA);
    const q = render(where);
    expect(q.sql).toContain("`meetings`.`workspaceId` = ?");
    expect(q.sql).toContain("`meetings`.`status` = ?");
    expect(q.params).toEqual(expect.arrayContaining([WS.id, "proposed"]));
    // Rows the member already owns are left alone; unowned ones move too.
    expect(q.sql).toContain("(`meetings`.`ownerUserId` is null or `meetings`.`ownerUserId` <> ?)");
    // The write is bounded to the rows that were read.
    expect(q.sql).toMatch(/`meetings`\.`id` in \(\?, \?\)/);
    expect(q.params).toEqual(expect.arrayContaining([10, 11]));
  });

  it("keeps updatedAt as it was, so a Regenerate all pass still reaches the rows", async () => {
    await caller().meetings.reassignProposals({ toUserId: KHAJA });
    expect(render(w.updates[0].set.updatedAt).sql).toBe("`meetings`.`updatedAt`");
  });

  it("one proposal: the id is part of what is read and written", async () => {
    w.proposals = [{ id: 10, ownerUserId: IDRIS }];
    const res = await caller().meetings.reassignProposals({ toUserId: KHAJA, ids: [10] });
    expect(res).toEqual({ reassigned: 1 });
    const q = render(w.updates[0].where);
    // Once from the caller's ids, once from the rows read.
    expect(q.sql.match(/`meetings`\.`id` in \(\?\)/g)).toHaveLength(2);
  });

  it("audits who owned each proposal before", async () => {
    await caller().meetings.reassignProposals({ toUserId: KHAJA });
    const audit = w.inserts.find((i) => i.table === auditLog);
    expect(audit?.values.before).toEqual({ owners: [{ id: 10, ownerUserId: IDRIS }, { id: 11, ownerUserId: null }] });
    expect(audit?.values.after).toEqual({ reassignedTo: KHAJA, count: 2 });
  });

  it("refuses a member who left (or never belonged), and writes nothing", async () => {
    w.active = [IDRIS];
    await expect(caller().meetings.reassignProposals({ toUserId: KHAJA })).rejects.toThrow("Choose an active member of this workspace.");
    expect(w.updates).toEqual([]);
    expect(w.inserts.find((i) => i.table === auditLog)).toBeUndefined();
  });

  it("nothing to move: no write, no audit", async () => {
    w.proposals = [];
    expect(await caller().meetings.reassignProposals({ toUserId: KHAJA })).toEqual({ reassigned: 0 });
    expect(w.updates).toEqual([]);
    expect(w.inserts.find((i) => i.table === auditLog)).toBeUndefined();
  });
});

describe("meetings.proposalOwners", () => {
  it("each active member with the calendar an invite would send from", async () => {
    expect(await caller().meetings.proposalOwners()).toEqual([
      { userId: IDRIS, name: "Idris Grant", calendar: "none" },
      { userId: KHAJA, name: "Khaja Syed", calendar: "teams" },
      { userId: 77, name: "caldav@example.org", calendar: "no_teams" },
    ]);
  });

  it("lists only this workspace's ACTIVE members: a leaver cannot be picked", async () => {
    await caller().meetings.proposalOwners();
    const q = render(w.memberWhere);
    expect(q.sql).toContain("`workspace_members`.`deactivatedAt` is null");
    expect(q.sql).toContain("`workspace_members`.`workspaceId` = ?");
    expect(q.params).toContain(WS.id);
  });
});

describe("the Meetings page", () => {
  const page = readFileSync("client/src/pages/usip/MeetingsV2.tsx", "utf8");

  it("reassigns one proposal from its card, or all of them from the header", () => {
    expect(page).toContain("onReassign={(toUserId) => reassign.mutate({ toUserId, ids: [m.id] })}");
    expect(page).toContain("onClick={() => reassign.mutate({ toUserId: to })}>");
    expect(page).toContain("<UserRound className=\"size-3.5\" /> Reassign all…");
  });

  it("says whose calendar each invite sends from, and when it can't send", () => {
    expect(page).toContain("<span>Sends from</span>");
    expect(page).toContain('none: "no calendar connected, so invites can\'t send yet",');
    expect(page).toContain("calendar can't create Teams meetings. Add a link with Edit.");
  });
});
