/**
 * Platform role and ownership checks (audit 2026-10-20, G26, G38, G39).
 *
 *   G26 · a dashboard schedule goes to this workspace's members; an outside
 *         address needs a manager and is audited; a deactivated member stops
 *         receiving it, a deleted one is taken off it; and each recipient gets
 *         their own message
 *   G38 · the assistant's query_data applies the screens' gates: the audit log
 *         is an admin's, notifications are each person's own, calendars a
 *         rep's own and anyone's for a manager
 *   G39 · the assistant's conversation is cleared on a workspace switch, and
 *         the server won't continue one from another workspace
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, audits: [] as any[], mailed: [] as string[], failFor: null as string | null, metered: 0 };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async (e: unknown) => { h.audits.push(e); } }));
vi.mock("./routers/smtpConfig", async (a) => ({
  ...(await a<typeof import("./routers/smtpConfig")>()),
  decrypt: () => "pw",
  buildTransporter: () => ({
    sendMail: async (m: { to: string }) => {
      if (m.to === h.failFor) throw new Error("mailbox refused");
      h.mailed.push(m.to);
    },
  }),
}));
vi.mock("./services/email/logSend", async (a) => ({ ...(await a<typeof import("./services/email/logSend")>()), logEmailSend: async () => {} }));
vi.mock("./usageCounters", async (a) => ({ ...(await a<typeof import("./usageCounters")>()), recordEmailsSent: async (_w: number, n = 1) => { h.metered += n; } }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { sendDashboardScheduleEmail } from "./routers/operations";
import { runExplorerQuery, viewerScope } from "./services/assistantDataExplorer";

const WS = 2, FOREIGN = 9, ME = 1, ANN = 21, GONE = 22, NEWBIE = 23, MGR = 24, ADMIN = 25;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = (userId = ME) => appRouter.createCaller({
  user: { id: userId, openId: `u${userId}`, email: `u${userId}@acme.example`, name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.audits = [];
  h.mailed = [];
  h.failFor = null;
  h.metered = 0;
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  const user = (id: number) => ({ id, name: `U${id}`, email: `u${id}@acme.example`, mfaTotpEnabledAt: null });
  rows("users").push(user(ME), user(ANN), user(GONE), user(NEWBIE), user(MGR), user(ADMIN));
  const member = (id: number, userId: number, role: string, extra = {}) => ({ id, workspaceId: WS, userId, role, deactivatedAt: null, inviteToken: null, lastActiveAt: new Date(), notifEmail: null, ...extra });
  rows("workspace_members").push(
    member(1, ME, "rep"),
    member(2, ANN, "rep", { notifEmail: "ann.alerts@home.example" }),
    member(3, GONE, "rep", { deactivatedAt: new Date(), notifEmail: "gone.alerts@home.example" }),
    member(4, NEWBIE, "rep", { inviteToken: "pending" }),
    member(5, MGR, "manager"),
    member(6, ADMIN, "admin"),
  );
  rows("dashboards").push({ id: 1, workspaceId: WS, name: "Mine", ownerUserId: ME, layout: [] });
});

describe("G26: dashboard schedules", () => {
  const schedule = (recipients: string[], userId = ME) =>
    caller(userId).dashboards.createSchedule({ dashboardId: 1, frequency: "weekly", recipients });

  it("a rep may send to members, by sign-in or notification address, in any case", async () => {
    await schedule(["U21@acme.example", "ann.alerts@home.example", "u1@acme.example"]);
    expect(rows("report_schedules")).toHaveLength(1);
    expect(h.audits.filter((a) => a.entityType === "dashboard_schedule_outside_recipients")).toEqual([]);
  });

  it("a rep may not add an address outside the workspace, nor a leaver's, nor an unaccepted invite's", async () => {
    for (const outside of ["cfo@client.example", "u22@acme.example", "gone.alerts@home.example", "u23@acme.example"]) {
      await expect(schedule(["u21@acme.example", outside])).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining(outside) });
    }
    expect(rows("report_schedules")).toHaveLength(0);
  });

  it("a manager may, and the outside address is in the audit log", async () => {
    await schedule(["u21@acme.example", "cfo@client.example"], MGR);
    expect(rows("report_schedules")).toHaveLength(1);
    const audit = h.audits.find((a) => a.entityType === "dashboard_schedule_outside_recipients");
    expect(audit).toMatchObject({ actorUserId: MGR, entityId: 1, after: { recipients: ["cfo@client.example"] } });
  });

  describe("sending", () => {
    beforeEach(() => {
      rows("smtp_configs").push({ id: 1, workspaceId: WS, enabled: true, host: "smtp.example", port: 587, secure: false, username: "u", encryptedPassword: "x", fromEmail: "reports@acme.example", fromName: "Reports" });
      rows("report_schedules").push({ id: 7, workspaceId: WS, dashboardId: 1, frequency: "weekly", recipients: ["u21@acme.example", "U22@acme.example", "gone.alerts@home.example", "cfo@client.example"], enabled: true });
    });

    it("skips a deactivated member and mails each of the rest on their own", async () => {
      const r = await sendDashboardScheduleEmail(WS, 7, null);
      expect(r.ok).toBe(true);
      expect(h.mailed).toEqual(["u21@acme.example", "cfo@client.example"]);
      expect(h.metered).toBe(2);
    });

    it("says so when everyone on it has been deactivated, and sends nothing", async () => {
      rows("report_schedules")[0].recipients = ["u22@acme.example"];
      const r = await sendDashboardScheduleEmail(WS, 7, null);
      expect(r).toMatchObject({ ok: false, reason: "no_recipients" });
      expect(h.mailed).toEqual([]);
    });

    it("one address failing doesn't stop the others, and the run counts as sent", async () => {
      h.failFor = "u21@acme.example";
      const r = await sendDashboardScheduleEmail(WS, 7, null);
      expect(r.ok).toBe(true);
      expect(h.mailed).toEqual(["cfo@client.example"]);
      expect(rows("report_schedules")[0].lastSentAt).toBeInstanceOf(Date);
    });
  });

  it("deleting a member takes their address off every dashboard schedule here, and turns one left empty off", async () => {
    rows("report_schedules").push(
      { id: 8, workspaceId: WS, dashboardId: 1, frequency: "weekly", recipients: ["U21@acme.example", "cfo@client.example"], enabled: true },
      { id: 9, workspaceId: WS, dashboardId: 1, frequency: "weekly", recipients: ["u21@acme.example"], enabled: true },
      { id: 10, workspaceId: FOREIGN, dashboardId: 5, frequency: "weekly", recipients: ["u21@acme.example"], enabled: true },
    );
    await caller(ADMIN).team.delete({ memberId: 2 });
    const byId = (id: number) => rows("report_schedules").find((s) => s.id === id);
    expect(byId(8)).toMatchObject({ recipients: ["cfo@client.example"], enabled: true });
    expect(byId(9)).toMatchObject({ recipients: [], enabled: false });
    expect(byId(10).recipients).toEqual(["u21@acme.example"]);
  });

  it("the schedule dialog says who may be a recipient", () => {
    const src = read("client/src/pages/usip/Dashboards.tsx");
    expect(src).toContain("Members of this workspace only; a manager can add an address outside it.");
  });
});

describe("G38: query_data applies the screens' gates", () => {
  const dialect = new MySqlDialect();
  /** A db that answers nothing and keeps every WHERE it is given. */
  function capturing() {
    const wheres: Array<{ sql: string; params: unknown[] }> = [];
    const b: any = {
      from: () => b, $dynamic: () => b, groupBy: () => b, orderBy: () => b,
      where: (c: any) => { wheres.push(dialect.sqlToQuery(c)); return b; },
      limit: async () => [],
      then: (res: (v: unknown) => void) => res([{ n: 0 }]),
    };
    h.db = { select: () => b };
    return wheres;
  }

  it("the audit log is an admin's", async () => {
    capturing();
    await expect(runExplorerQuery(WS, { entity: "audit_log" }, { userId: MGR, role: "manager" })).rejects.toThrow(/admins only/);
    await expect(runExplorerQuery(WS, { entity: "audit_log" }, { userId: ADMIN, role: "admin" })).resolves.toBeDefined();
  });

  it("notifications are each person's own, an admin's included", async () => {
    const wheres = capturing();
    await runExplorerQuery(WS, { entity: "notifications" }, { userId: ADMIN, role: "admin" });
    expect(wheres).toHaveLength(2);
    for (const w of wheres) {
      expect(w.sql).toContain("`notifications`.`userId` = ?");
      expect(w.params).toEqual([WS, ADMIN]);
    }
  });

  it("calendars are a rep's own and anyone's for a manager", async () => {
    let wheres = capturing();
    await runExplorerQuery(WS, { entity: "calendar_events", groupBy: ["userId"] }, { userId: ME, role: "rep" });
    expect(wheres[0].sql).toContain("`calendar_events`.`userId` = ?");
    expect(wheres[0].params).toEqual([WS, ME]);
    wheres = capturing();
    await runExplorerQuery(WS, { entity: "calendar_events" }, { userId: MGR, role: "manager" });
    expect(wheres[0].sql).not.toContain("`calendar_events`.`userId`");
  });

  it("everything else is the workspace frame alone, and an unknown role reads no gated entity", () => {
    expect(viewerScope("people", { userId: ME, role: "rep" })).toBeUndefined();
    expect(() => viewerScope("audit_log", { userId: ME, role: "owner" })).toThrow(/admins only/);
    expect(viewerScope("constructor", { userId: ME, role: "rep" })).toBeUndefined();
  });

  it("the assistant asks as the person asking", () => {
    expect(read("server/routers/assistant.ts")).toContain("runExplorerQuery(ctx.workspace.id, args, { userId: ctx.user.id, role: ctx.member.role })");
  });
});

describe("G39: the assistant's conversation stays in its workspace", () => {
  beforeEach(() => {
    rows("ai_help_conversations").push({ id: 50, workspaceId: FOREIGN, userId: ME }, { id: 51, workspaceId: WS, userId: ME });
    rows("ai_help_messages").push({ id: 60, conversationId: 50, role: "user", body: "about Pat at pat@acme.example" });
  });

  it("one opened in another workspace can't be continued or read from here", async () => {
    await expect(caller().assistant.chat({ conversationId: 50, message: "and?" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller().helpCenter.getConversationMessages({ conversationId: 50 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller().helpCenter.askAI({ conversationId: 50, message: "and?" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rows("ai_help_messages")).toHaveLength(1);
    await expect(caller().helpCenter.getConversationMessages({ conversationId: 51 })).resolves.toEqual([]);
  });

  it("a workspace switch clears it on the screen", async () => {
    const { assistantStore } = await import("../client/src/lib/assistantStore");
    assistantStore.setConversationId(51);
    assistantStore.push({ role: "user", body: "about Pat" });
    assistantStore.reset();
    expect(assistantStore.get()).toMatchObject({ conversationId: null, messages: [] });
    const ctx = read("client/src/contexts/WorkspaceContext.tsx");
    const clear = ctx.slice(ctx.indexOf("const clearWorkspaceData = useCallback(() => {"), ctx.indexOf("}, [queryClient]);"));
    expect(clear).toContain("void queryClient.resetQueries(");
    expect(clear).toContain("assistantStore.reset();");
    // …and both ways a tab changes workspace go through it.
    expect(ctx.slice(ctx.indexOf("const switchTo = useCallback("), ctx.indexOf("[clearWorkspaceData],"))).toContain("clearWorkspaceData();");
    expect(ctx).toContain("if (moved) clearWorkspaceData();");
  });
});
