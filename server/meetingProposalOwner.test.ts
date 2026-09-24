/**
 * Who owns NEW meeting proposals (owner ask 2026-09-24: "Add the new
 * proposals owner setting"). An invite sends from its owner's calendar, and
 * the autopilot handed every CommunityForce proposal to Idris Grant (the
 * top-ranked member; "Find meetings with AI" hands it to whoever clicked).
 * workspace_settings.meetingProposalOwnerUserId, when set, owns every new
 * proposal; null keeps the old routing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { auditLog, calendarEvents, meetings, workspaceMembers, workspaceSettings, workspaces } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));
// Drafting falls back to its fixed copy when the model fails; the owner is
// what is under test here, not the copy.
vi.mock("./_core/llm", async (importActual) => ({
  ...(await importActual<typeof import("./_core/llm")>()),
  invokeLLM: async () => { throw new Error("no model in tests"); },
}));
vi.mock("./services/brandContext", async (importActual) => ({
  ...(await importActual<typeof import("./services/brandContext")>()),
  buildBrandContext: async () => "",
}));

import { appRouter } from "./routers";
import { createMeetingProposal } from "./services/meetingScheduler";

const WS = { id: 4, name: "CommunityForce" };
const IDRIS = 2;
const KHAJA = 5721;
const dialect = new MySqlDialect();
const render = (x: unknown) => dialect.sqlToQuery(x as any);

type World = {
  role: string;
  /** The stored workspace_settings row, by DB column name; reads get only the columns they select. */
  settings: Record<string, unknown> | null;
  active: number[];
  busyWhere: unknown[];
  inserts: { table: unknown; values: any; upsert?: any }[];
};
let w: World;

function makeDb() {
  const builder = (fields?: Record<string, { name: string }>) => {
    const st: { table?: unknown; join?: unknown; where?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin(t: unknown) { st.join = t; return b; },
      where(c: unknown) { st.where = c; return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void) {
        if (st.join === workspaces) {
          res([{
            ws: { ...WS, ownerUserId: IDRIS, archivedAt: null },
            mb: { id: 1, userId: IDRIS, workspaceId: WS.id, role: w.role, deactivatedAt: null, lastActiveAt: new Date() },
          }]);
        } else if (st.table === workspaceSettings) {
          const row = w.settings;
          res(row && fields ? [Object.fromEntries(Object.entries(fields).map(([k, col]) => [k, row[col.name] ?? null]))] : []);
        }
        else if (st.table === workspaceMembers) res(w.active.map((userId) => ({ userId })));
        else if (st.table === calendarEvents) { w.busyWhere.push(st.where); res([]); }
        else if (st.table === workspaces) res([{ name: WS.name }]);
        else res([]);
      },
    };
    return b;
  };
  return {
    select: (fields?: Record<string, { name: string }>) => builder(fields),
    insert: (t: unknown) => ({
      values(v: unknown) {
        const rec: { table: unknown; values: any; upsert?: any } = { table: t, values: v };
        w.inserts.push(rec);
        const done = Promise.resolve([{ insertId: 99 }]);
        return {
          then: done.then.bind(done),
          onDuplicateKeyUpdate(u: unknown) { rec.upsert = u; return done; },
        };
      },
    }),
    update: () => { const b: any = { set() { return b; }, where() { return Promise.resolve([]); } }; return b; },
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

const target = { ownerUserId: IDRIS, relatedType: "prospect", relatedId: 7, name: "Ada Prospect", email: "ada@example.org", company: "Acme", source: "ai" as const };
const inserted = () => w.inserts.find((i) => i.table === meetings)?.values;

beforeEach(() => {
  w = { role: "admin", settings: null, active: [IDRIS, KHAJA], busyWhere: [], inserts: [] };
  h.db = makeDb();
});

describe("createMeetingProposal: the configured owner owns every new proposal", () => {
  it("set: the proposal is the configured member's, and its times come from THEIR calendar", async () => {
    w.settings = { meetingProposalOwnerUserId: KHAJA };
    expect(await createMeetingProposal(WS.id, target)).toBe(99);
    expect(inserted().ownerUserId).toBe(KHAJA);
    // The busy-time read (offered times) was for the configured owner.
    expect(w.busyWhere).toHaveLength(1);
    const q = render(w.busyWhere[0]);
    expect(q.sql).toContain("`calendar_events`.`userId` = ?");
    expect(q.params).toContain(KHAJA);
    expect(q.params).not.toContain(IDRIS);
  });

  it("set to someone who has since left: the caller's owner stands", async () => {
    w.settings = { meetingProposalOwnerUserId: KHAJA };
    w.active = [IDRIS];
    await createMeetingProposal(WS.id, target);
    expect(inserted().ownerUserId).toBe(IDRIS);
    expect(render(w.busyWhere[0]).params).toContain(IDRIS);
  });

  it("unset: the old routing, unchanged", async () => {
    await createMeetingProposal(WS.id, target);
    expect(inserted().ownerUserId).toBe(IDRIS);
    await createMeetingProposal(WS.id, { ...target, ownerUserId: null });
    expect(w.inserts.filter((i) => i.table === meetings)[1].values.ownerUserId).toBeNull();
  });
});

describe("meetings.setProposalOwner", () => {
  it("stores the member (admins only) and audits it", async () => {
    expect(await caller().meetings.setProposalOwner({ userId: KHAJA })).toEqual({ ok: true });
    const up = w.inserts.find((i) => i.table === workspaceSettings);
    expect(up?.values).toEqual({ workspaceId: WS.id, meetingProposalOwnerUserId: KHAJA });
    expect(up?.upsert).toEqual({ set: { meetingProposalOwnerUserId: KHAJA } });
    expect(w.inserts.find((i) => i.table === auditLog)?.values.after).toEqual({ proposalOwnerUserId: KHAJA });
  });

  it("null goes back to each prospect's rep", async () => {
    w.active = [];
    await caller().meetings.setProposalOwner({ userId: null });
    expect(w.inserts.find((i) => i.table === workspaceSettings)?.upsert).toEqual({ set: { meetingProposalOwnerUserId: null } });
  });

  it("refuses a member who left, and writes nothing", async () => {
    w.active = [IDRIS];
    await expect(caller().meetings.setProposalOwner({ userId: KHAJA })).rejects.toThrow("Choose an active member of this workspace.");
    expect(w.inserts).toEqual([]);
  });

  it("a rep cannot change it", async () => {
    w.role = "rep";
    await expect(caller().meetings.setProposalOwner({ userId: KHAJA })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.inserts.find((i) => i.table === workspaceSettings)).toBeUndefined();
  });

  it("the page reads it back with the autopilot settings", async () => {
    w.settings = { meetingAutopilotMode: "approval", meetingAutopilotDailyCap: 10, meetingAutopilotLastRunAt: null, meetingProposalOwnerUserId: KHAJA };
    expect((await caller().meetings.getAutopilotSettings()).proposalOwnerUserId).toBe(KHAJA);
  });
});

describe("wiring", () => {
  it("every proposal path goes through createMeetingProposal, which applies the setting", () => {
    const svc = readFileSync("server/services/meetingScheduler.ts", "utf8");
    expect(svc).toContain("const ownerUserId = (await configuredProposalOwner(workspaceId)) ?? target.ownerUserId ?? null;");
    // proposeMeetingForProspect (autopilot, Find meetings with AI, Propose
    // meeting) and both reply-classifier paths delegate to it.
    expect(svc).toContain("  return createMeetingProposal(workspaceId, {");
    const rc = readFileSync("server/services/replyClassifier.ts", "utf8");
    expect(rc.split("meetingId = await createMeetingProposal(workspaceId, {").length - 1).toBe(2);
    expect(svc.split("db.insert(meetings)").length - 1).toBe(1);
  });

  it("the migration adds the column", () => {
    const mig = readFileSync("server/_core/rawMigrations.ts", "utf8");
    expect(mig).toContain("\"ALTER TABLE `workspace_settings` ADD COLUMN `meetingProposalOwnerUserId` int NULL\"");
  });

  it("the Meetings page chooses it, with a way back to the default", () => {
    const page = readFileSync("client/src/pages/usip/MeetingsV2.tsx", "utf8");
    expect(page).toContain("<span>New proposals go to</span>");
    expect(page).toContain('onValueChange={(v) => setProposalOwner.mutate({ userId: v === "rep" ? null : Number(v) })}>');
    expect(page).toContain("<SelectItem value=\"rep\">Each prospect's rep (default)</SelectItem>");
  });
});
