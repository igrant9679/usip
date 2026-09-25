/**
 * Meeting actions reach the audit log (found 2026-09-25: nobody could tell who
 * had approved a Casey Grants invite). audit_log.action is a MySQL ENUM, and
 * "book", "propose" and "ai_generate" are not in it: the database rejected
 * those rows and recordAudit swallows the error, so Approve & send, Propose
 * meeting and Find meetings with AI were never recorded.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { auditLog, workspaces } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, inserts: [] as { table: unknown; values: any }[] }));
vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));
vi.mock("./services/meetingScheduler", async (importActual) => ({
  ...(await importActual<typeof import("./services/meetingScheduler")>()),
  sendMeetingInvite: async () => ({ sent: true, scheduledAt: "2026-10-06T17:00:00.000Z" }),
}));

import { appRouter } from "./routers";

function makeDb() {
  const b = () => {
    const st: { join?: unknown } = {};
    const q: any = {
      from() { return q; }, innerJoin(t: unknown) { st.join = t; return q; }, where() { return q; }, orderBy() { return q; }, limit() { return q; },
      then(res: (v: unknown) => void) {
        res(st.join === workspaces ? [{ ws: { id: 4, name: "CommunityForce", ownerUserId: 2, archivedAt: null },
          mb: { id: 1, userId: 5721, workspaceId: 4, role: "rep", deactivatedAt: null, lastActiveAt: new Date() } }] : []);
      },
    };
    return q;
  };
  return {
    select: () => b(),
    insert: (t: unknown) => ({ values(v: any) { h.inserts.push({ table: t, values: v }); return Promise.resolve([{ insertId: 1 }]); } }),
    update: () => { const u: any = { set() { return u; }, where() { return Promise.resolve([]); } }; return u; },
  };
}

beforeEach(() => { h.inserts = []; h.db = makeDb(); });

const enumValues = () => {
  const schema = readFileSync("drizzle/schema.ts", "utf8");
  const m = schema.match(/export const auditLog = mysqlTable\([\s\S]*?action: mysqlEnum\("action", \[([^\]]+)\]\)/);
  expect(m, "audit_log.action enum not found").toBeTruthy();
  return m![1].split(",").map((s) => s.trim().replace(/"/g, ""));
};

describe("Approve & send is audited", () => {
  it("writes a row the database accepts: update, with who, which meeting and book: true", async () => {
    const caller = appRouter.createCaller({
      user: { id: 5721, openId: "u", email: "k@example.org", name: "Khaja Syed", loginMethod: "manus", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
      req: { protocol: "https", headers: {} }, res: { clearCookie: () => {} },
    } as unknown as TrpcContext);
    await caller.meetings.approveAndSend({ id: 554 });
    const row = h.inserts.find((i) => i.table === auditLog)?.values;
    expect(row).toMatchObject({ actorUserId: 5721, action: "update", entityType: "meeting", entityId: 554 });
    expect(row.after).toMatchObject({ sent: true, book: true });
    expect(enumValues()).toContain(row.action);
  });
});

describe("every meetings audit action is one the database accepts", () => {
  it("no recordAudit in the meetings router uses a value outside audit_log.action", () => {
    const router = readFileSync("server/routers/meetings.ts", "utf8");
    const actions = Array.from(router.matchAll(/recordAudit\(\{[^}]*?action: "([a-z_]+)"/g)).map((m) => m[1]);
    expect(actions.length).toBeGreaterThan(10);
    const allowed = new Set(enumValues());
    expect(actions.filter((a) => !allowed.has(a))).toEqual([]);
  });
});
