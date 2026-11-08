/**
 * The holes left between people and workspaces after Phase 0 (audit 2026-10-20:
 * A9, O18, O19, G5, G6, G28, G30, P4, P5, R11).
 *
 *   a member can't run the engine across other workspaces · a teammate's mailbox
 *   and calendar are theirs and their managers' · another workspace's dashboard,
 *   tour steps, segments and senders are out of reach · a dashboard or saved
 *   report changes only for its owner or a manager, though anyone may stop a
 *   delivery · only managers delete a customer and only admins wipe them all,
 *   audited · a pending invite, an archived workspace or missing 2FA stops the
 *   stream routes and the file proxy as it stops everything else · the public
 *   beacon has a rate limit and a ceiling on the tasks it can file.
 *
 * Everything runs through the real procedures against the SQL-evaluating fake,
 * with a real member table, so each caller's role is the one on their row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, user: null as any, mailboxCalls: [] as string[], calendarCalls: [] as string[] };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: async () => { if (!h.user) throw new Error("no session"); return h.user; } } }));
vi.mock("./emailAdapter", async (a) => ({
  ...(await a<typeof import("./emailAdapter")>()),
  createEmailAdapter: () => new Proxy({}, { get: (_t, name: string) => async () => { h.mailboxCalls.push(name); return name === "getAttachment" ? { data: Buffer.from("x"), contentType: "text/plain", filename: "x" } : { threads: [], items: [] }; } }),
}));
vi.mock("./calendarAdapter", () => ({
  createCalendarAdapter: () => new Proxy({}, { get: (_t, name: string) => async () => { h.calendarCalls.push(name); return name === "createEvent" ? { uid: "u", etag: "e", calendarId: "c" } : []; } }),
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { runAreEngine, __resetEngineLogRepeatsForTests } from "./areEngine";
import { resolveStreamAuth } from "./_core/streamHelpers";
import { registerStorageProxy } from "./_core/storageProxy";
import { invalidateSecurityPolicyCache } from "./_core/securityPolicy";
import { registerWebsiteTrackingRoutes, MAX_INTENT_TASKS_PER_DAY, signVisitorId } from "./websiteTracking";


const LSI = 2, FOREIGN = 9;
const OWNER = 21, TEAMMATE = 22, MANAGER = 23, ADMIN = 25, SUPER = 26, PENDING = 27, OUTSIDER = 30;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const find = (t: string, id: number) => rows(t).find((r) => r.id === id);

function caller(userId: number, ws = LSI) {
  return appRouter.createCaller({
    user: rows("users").find((u) => u.id === userId),
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function code(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e.code as string; }
  return "OK";
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.user = null;
  h.mailboxCalls = [];
  h.calendarCalls = [];
  __resetEngineLogRepeatsForTests();
  invalidateSecurityPolicyCache();
  const user = (id: number) => ({ id, openId: `u${id}`, email: `u${id}@example.com`, name: `U${id}`, loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), mfaTotpEnabledAt: null });
  rows("users").push(...[OWNER, TEAMMATE, MANAGER, ADMIN, SUPER, PENDING, OUTSIDER].map(user));
  rows("workspaces").push({ id: LSI, name: "LSI", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" }, { id: FOREIGN, name: "Other", slug: "other", ownerUserId: OUTSIDER, archivedAt: null, plan: "trial" });
  const member = (id: number, workspaceId: number, userId: number, role: string, extra = {}) => ({ id, workspaceId, userId, role, deactivatedAt: null, inviteToken: null, lastActiveAt: new Date(), ...extra });
  rows("workspace_members").push(
    member(1, LSI, OWNER, "rep"), member(2, LSI, TEAMMATE, "rep"), member(3, LSI, MANAGER, "manager"), member(5, LSI, ADMIN, "admin"), member(6, LSI, SUPER, "super_admin"),
    member(7, LSI, PENDING, "rep", { inviteToken: "pending" }), member(8, FOREIGN, OUTSIDER, "admin"),
  );
  rows("workspace_settings").push(
    { workspaceId: LSI, enforce2fa: false, areSourceOrder: null, icpFallback: null, areScraperSources: { quickenrich: false, warmysender: false, linkedin: false, apollo: false, google_business: false, news: false, leadocean: false } },
    { workspaceId: FOREIGN, enforce2fa: false, areSourceOrder: null, icpFallback: null, areScraperSources: { quickenrich: false, warmysender: false, linkedin: false, apollo: false, google_business: false, news: false, leadocean: false } },
  );
});

/* ── A9 ──────────────────────────────────────────────────────────────────── */

describe("running the engine by hand (A9)", () => {
  const campaign = (id: number, workspaceId: number) => ({
    id, workspaceId, name: `C${id}`, status: "active", targetProspectCount: 10, prospectSources: ["internal"],
    icpOverrides: { targetTitles: ["County Administrator"] }, discoveryQueryState: null, researchSectorId: null, researchPersonaId: null,
  });
  beforeEach(() => { rows("are_campaigns").push(campaign(1, LSI), campaign(2, FOREIGN)); });

  it.each([["runOnce"], ["runEngine"]])("%s is for managers and above", async (name) => {
    const proc = (id: number) => (name === "runOnce" ? caller(id).are.engine.runOnce() : caller(id).are.campaigns.runEngine());
    expect(await code(proc(OWNER))).toBe("FORBIDDEN");
    expect(await code(proc(MANAGER))).toBe("OK");
  });

  it("runs this workspace's campaigns and leaves every other workspace's alone", async () => {
    const r = await caller(MANAGER).are.engine.runOnce();
    expect(r.campaignsProcessed).toBe(1);
    expect(find("are_campaigns", 1).discoveryQueryState).not.toBeNull();
    expect(find("are_campaigns", 2).discoveryQueryState).toBeNull();
  });

  it("the scheduled tick still covers everyone", async () => {
    const r = await runAreEngine();
    expect(r.campaignsProcessed).toBe(2);
    expect(find("are_campaigns", 2).discoveryQueryState).not.toBeNull();
  });

  it("says when it didn't run because a tick was already going", async () => {
    const [a, b] = await Promise.all([runAreEngine(), caller(MANAGER).are.engine.runOnce()]);
    expect(a.skipped).toBeUndefined();
    expect(b.skipped).toBe(true);
    expect(b.campaignsProcessed).toBe(0);
  });

  it("a manual run asks for this workspace's enrichment only, and the schedule still asks for everyone's", async () => {
    // Enrichment spends AI budget, so read what the engine actually asks for. The
    // fake can't evaluate this query's raw SQL, and the engine logs that and moves on.
    const enrichQueries: { sql: string; params: unknown[] }[] = [];
    const real = h.db.select;
    h.db.select = (p?: Record<string, unknown>) => {
      const b = real(p);
      const where = b.where;
      b.where = (cond: any) => {
        const q = new MySqlDialect().sqlToQuery(cond);
        if (q.sql.includes("`prospect_queue`.`enrichmentStatus`") && q.sql.includes("`are_campaigns`.`status`")) enrichQueries.push(q);
        return where.call(b, cond);
      };
      return b;
    };
    await caller(MANAGER).are.engine.runOnce();
    expect(enrichQueries).toHaveLength(1);
    expect(enrichQueries[0]!.sql).toContain("`prospect_queue`.`workspaceId` = ?");
    expect(enrichQueries[0]!.params).toContain(LSI);
    await runAreEngine();
    expect(enrichQueries).toHaveLength(2);
    expect(enrichQueries[1]!.sql).not.toContain("`prospect_queue`.`workspaceId` = ?");
  });

  it("launching a campaign kicks its own workspace, and nothing else starts a whole tick for a person", () => {
    const src = read("server/routers/are/campaigns.ts");
    expect(src).toContain("runAreEngine({ workspaceId: ctx.workspace.id }).catch((e) =>");
    for (const file of ["server/routers/are/campaigns.ts", "server/routers/are/engine.ts"]) {
      expect(read(file), file).not.toContain("runAreEngine()");
    }
  });

  it("the Logs tab says so too, and offers the button only to those who can use it", () => {
    const src = read("client/src/pages/usip/ARECampaignDetail.tsx");
    expect(src).toContain("const r = await runOnce.mutateAsync();");
    expect(src).toContain("if (r.skipped)");
    expect(src).toContain("{rankOf(current?.role) >= rankOf(\"manager\") && (");
  });
});

/* ── O18 ─────────────────────────────────────────────────────────────────── */

describe("a teammate's mailbox (O18)", () => {
  beforeEach(() => {
    rows("sending_accounts").push({ id: 1, workspaceId: LSI, unipileAccountId: "personal", fromEmail: "owner@lsi.example" }, { id: 2, workspaceId: LSI, unipileAccountId: null, fromEmail: "team@lsi.example" }, { id: 3, workspaceId: FOREIGN, unipileAccountId: "theirs", fromEmail: "x@other.example" });
    rows("unipile_accounts").push({ id: 1, unipileAccountId: "personal", userId: OWNER, workspaceId: LSI });
  });
  const reads = (id: number, accountId: number) => [
    caller(id).mailbox.listFolders({ accountId }),
    caller(id).mailbox.listThreads({ accountId }),
    caller(id).mailbox.getThread({ accountId, threadId: "t" }),
    caller(id).mailbox.searchThreads({ accountId, query: "q" }),
    caller(id).mailbox.getAttachment({ accountId, messageId: "m", attachmentId: "a" }),
  ];

  it("no read of it is open to a teammate, and none reaches the provider", async () => {
    expect(await Promise.all(reads(TEAMMATE, 1).map(code))).toEqual(Array(5).fill("FORBIDDEN"));
    expect(h.mailboxCalls).toEqual([]);
  });
  it.each([["its owner", OWNER], ["a manager", MANAGER], ["an admin", ADMIN]])("%s can read it", async (_n, id) => {
    expect(await Promise.all(reads(id as number, 1).map(code))).toEqual(Array(5).fill("OK"));
  });
  it("a shared team mailbox stays open to members", async () => {
    expect(await Promise.all(reads(TEAMMATE, 2).map(code))).toEqual(Array(5).fill("OK"));
  });
  it("another workspace's mailbox doesn't exist from here", async () => {
    expect(await Promise.all(reads(MANAGER, 3).map(code))).toEqual(Array(5).fill("NOT_FOUND"));
  });
});

/* ── O19 ─────────────────────────────────────────────────────────────────── */

describe("a teammate's calendar (O19)", () => {
  beforeEach(() => {
    rows("calendar_accounts").push({ id: 1, workspaceId: LSI, userId: OWNER, provider: "caldav" }, { id: 3, workspaceId: FOREIGN, userId: OUTSIDER, provider: "caldav" });
    rows("calendar_events").push({ id: 10, workspaceId: LSI, userId: OWNER, calendarAccountId: 1, calendarId: "c", externalId: "e", title: "Sync", startAt: new Date("2026-12-01T10:00:00Z"), endAt: new Date("2026-12-01T11:00:00Z"), aiSummary: "done", relatedType: null, relatedId: null, attendees: [] });
    rows("opportunities").push({ id: 40, workspaceId: LSI, name: "Deal", stage: "discovery", value: 0, winProb: 0 });
  });
  const at = { startAt: new Date("2026-12-02T10:00:00Z"), endAt: new Date("2026-12-02T11:00:00Z") };
  const writes = (id: number, accountId: number) => [
    caller(id).calendar.listCalendars({ accountId }),
    caller(id).calendar.createEvent({ accountId, calendarId: "c", title: "X", ...at } as any),
    caller(id).calendar.updateEvent({ accountId, calendarId: "c", externalId: "e", title: "X", ...at }),
    caller(id).calendar.deleteEvent({ accountId, calendarId: "c", externalId: "e" }),
    caller(id).calendar.syncEvents({ accountId, from: at.startAt, to: at.endAt }),
  ];

  it("a teammate can't touch it, and nothing reaches the provider", async () => {
    expect(await Promise.all(writes(TEAMMATE, 1).map(code))).toEqual(Array(5).fill("FORBIDDEN"));
    expect(h.calendarCalls).toEqual([]);
  });
  it.each([["its owner", OWNER], ["a manager", MANAGER]])("%s gets past the check", async (_n, id) => {
    expect((await Promise.all(writes(id as number, 1).map(code))).filter((c) => c === "FORBIDDEN")).toEqual([]);
  });
  it("another workspace's calendar doesn't exist from here", async () => {
    expect(await Promise.all(writes(MANAGER, 3).map(code))).toEqual(Array(5).fill("NOT_FOUND"));
  });
  it("a teammate can't summarise an event or push its summary", async () => {
    expect(await code(caller(TEAMMATE).calendar.summarizeMeeting({ eventId: 10 }))).toBe("FORBIDDEN");
    expect(await code(caller(TEAMMATE).calendar.pushSummaryToOpportunity({ eventId: 10, opportunityId: 40 }))).toBe("FORBIDDEN");
    expect(await code(caller(OWNER).calendar.pushSummaryToOpportunity({ eventId: 10, opportunityId: 40 }))).toBe("OK");
  });
});

/* ── G5 and G28 ──────────────────────────────────────────────────────────── */

describe("dashboards (G5, G28)", () => {
  const widget = { type: "kpi" as const, title: "W", config: {} };
  beforeEach(() => {
    rows("dashboards").push({ id: 1, workspaceId: LSI, name: "Mine", ownerUserId: OWNER, layout: [] }, { id: 2, workspaceId: FOREIGN, name: "Theirs", ownerUserId: OUTSIDER, layout: [] }, { id: 3, workspaceId: LSI, name: "Nobody's", ownerUserId: null, layout: [] });
    rows("dashboard_widgets").push({ id: 11, workspaceId: LSI, dashboardId: 1, type: "kpi", title: "W", config: {}, position: { x: 0, y: 0, w: 1, h: 1 } }, { id: 12, workspaceId: FOREIGN, dashboardId: 1, type: "kpi", title: "Planted", config: {}, position: { x: 0, y: 0, w: 1, h: 1 } });
    rows("report_schedules").push({ id: 21, workspaceId: LSI, dashboardId: 1, frequency: "weekly", recipients: ["a@example.com"], enabled: false }, { id: 22, workspaceId: LSI, dashboardId: 1, frequency: "weekly", recipients: ["a@example.com"], enabled: true });
  });

  it("no widget can be written into another workspace's dashboard", async () => {
    expect(await code(caller(MANAGER).dashboards.addWidget({ dashboardId: 2, ...widget }))).toBe("NOT_FOUND");
    expect(rows("dashboard_widgets").filter((w) => w.dashboardId === 2)).toEqual([]);
  });

  it("a widget already planted from another workspace doesn't show", async () => {
    const d = await caller(OWNER).dashboards.get({ id: 1 });
    expect(d!.widgets.map((w: any) => w.id)).toEqual([11]);
  });

  it("no schedule can be put on another workspace's dashboard", async () => {
    expect(await code(caller(MANAGER).dashboards.createSchedule({ dashboardId: 2, frequency: "daily", recipients: ["a@example.com"] }))).toBe("NOT_FOUND");
  });

  const edits = (id: number) => [
    caller(id).dashboards.rename({ id: 1, name: "New" }),
    caller(id).dashboards.addWidget({ dashboardId: 1, ...widget }),
    caller(id).dashboards.updateWidget({ id: 11, patch: { title: "T" } }),
    caller(id).dashboards.saveLayout({ dashboardId: 1, positions: [{ id: 11, x: 1, y: 1, w: 1, h: 1 }] }),
    // 2026-11-06 (audit G26): a member's address, not a@example.com. An outside
    // address now needs a manager, which s1cPlatformRoles.test.ts pins; this
    // still pins that only the owner or a manager may schedule at all.
    caller(id).dashboards.createSchedule({ dashboardId: 1, frequency: "daily", recipients: ["u22@example.com"] }),
    caller(id).dashboards.toggleSchedule({ id: 21, enabled: true }),
  ];

  it("a teammate can't change someone's dashboard", async () => {
    expect(await Promise.all(edits(TEAMMATE).map(code))).toEqual(Array(6).fill("FORBIDDEN"));
    expect(await code(caller(TEAMMATE).dashboards.deleteWidget({ id: 11 }))).toBe("FORBIDDEN");
    expect(await code(caller(TEAMMATE).dashboards.delete({ id: 1 }))).toBe("FORBIDDEN");
    expect(find("dashboards", 1).name).toBe("Mine");
    expect(find("dashboard_widgets", 11).title).toBe("W");
    expect(find("report_schedules", 21).enabled).toBe(false);
  });
  it.each([["its owner", OWNER], ["a manager", MANAGER]])("%s can", async (_n, id) => {
    expect(await Promise.all(edits(id as number).map(code))).toEqual(Array(6).fill("OK"));
    expect(await code(caller(id as number).dashboards.deleteWidget({ id: 11 }))).toBe("OK");
    expect(await code(caller(id as number).dashboards.delete({ id: 1 }))).toBe("OK");
  });
  it("one with no owner is a manager's to change", async () => {
    expect(await code(caller(TEAMMATE).dashboards.rename({ id: 3, name: "N" }))).toBe("FORBIDDEN");
    expect(await code(caller(MANAGER).dashboards.rename({ id: 3, name: "N" }))).toBe("OK");
  });
  it("anyone can stop a delivery, but not start one", async () => {
    expect(await code(caller(TEAMMATE).dashboards.toggleSchedule({ id: 22, enabled: false }))).toBe("OK");
    expect(find("report_schedules", 22).enabled).toBe(false);
    expect(await code(caller(TEAMMATE).dashboards.toggleSchedule({ id: 22, enabled: true }))).toBe("FORBIDDEN");
  });
  it("sending a schedule now is the owner's or a manager's, because it mails whoever it names", async () => {
    expect(await code(caller(TEAMMATE).dashboards.sendScheduleNow({ id: 22 }))).toBe("FORBIDDEN");
    expect(await code(caller(OWNER).dashboards.sendScheduleNow({ id: 22 }))).not.toBe("FORBIDDEN");
    expect(await code(caller(MANAGER).dashboards.sendScheduleNow({ id: 22 }))).not.toBe("FORBIDDEN");
    expect(await code(caller(MANAGER).dashboards.sendScheduleNow({ id: 999 }))).toBe("NOT_FOUND");
  });
  it("the page offers Customize only to those who can use it", () => {
    const src = read("client/src/pages/usip/Dashboards.tsx");
    expect(src).toContain('const canEdit = !!dash.data && (dash.data.ownerUserId === user?.id || rankOf(current?.role) >= rankOf("manager"));');
    expect(src).toContain("{canEdit && (\n          <Button size=\"sm\" variant={customizeMode");
    expect(src).toContain("useEffect(() => { if (!canEdit) setCustomizeMode(false); }, [canEdit]);");
  });
  it("a layout save can't move a widget on some other dashboard", async () => {
    rows("dashboards").push({ id: 4, workspaceId: LSI, name: "Teammate's", ownerUserId: TEAMMATE, layout: [] });
    await caller(OWNER).dashboards.saveLayout({ dashboardId: 1, positions: [] });
    rows("dashboard_widgets").push({ id: 13, workspaceId: LSI, dashboardId: 4, type: "kpi", title: "T", config: {}, position: { x: 0, y: 0, w: 1, h: 1 } });
    await caller(OWNER).dashboards.saveLayout({ dashboardId: 1, positions: [{ id: 13, x: 9, y: 9, w: 9, h: 9 }] });
    expect(find("dashboard_widgets", 13).position.x).toBe(0);
  });
  it("the report email escapes what members typed", () => {
    const src = read("server/routers/operations.ts");
    const fn = src.slice(src.indexOf("export async function sendDashboardScheduleEmail"), src.indexOf("export async function sendDashboardScheduleEmail") + 4000);
    expect(fn).toContain('${escapeHtml(r?.title ?? "Widget")}');
    expect(fn).toContain("${escapeHtml(valStr)}");
    expect(fn).toContain("${escapeHtml(dash.name)}");
    expect(fn).toContain("eq(dashboardWidgets.workspaceId, workspaceId)");
  });
});

describe("saved reports (G28)", () => {
  const spec = { object: "leads", columns: ["id"], filters: [] } as any;
  beforeEach(() => {
    rows("saved_reports").push({ id: 1, workspaceId: LSI, ownerUserId: OWNER, name: "Mine", object: "leads", config: spec, scheduleFreq: "weekly", scheduleRecipients: "a@example.com" }, { id: 2, workspaceId: LSI, ownerUserId: OWNER, name: "Off", object: "leads", config: spec, scheduleFreq: "none", scheduleRecipients: null });
  });
  it("a teammate can't change, delete, schedule or send someone's report", async () => {
    expect(await code(caller(TEAMMATE).reports.save({ id: 1, name: "New", spec }))).toBe("FORBIDDEN");
    expect(await code(caller(TEAMMATE).reports.remove({ id: 1 }))).toBe("FORBIDDEN");
    expect(await code(caller(TEAMMATE).reports.setSchedule({ id: 2, freq: "daily", recipients: "x@example.com" }))).toBe("FORBIDDEN");
    expect(await code(caller(TEAMMATE).reports.sendNow({ id: 1 }))).toBe("FORBIDDEN");
    expect(find("saved_reports", 1).name).toBe("Mine");
    expect(find("saved_reports", 2).scheduleFreq).toBe("none");
  });
  it("anyone can stop a delivery", async () => {
    expect(await code(caller(TEAMMATE).reports.setSchedule({ id: 1, freq: "none", recipients: "" }))).toBe("OK");
    expect(find("saved_reports", 1).scheduleFreq).toBe("none");
  });
  it.each([["its owner", OWNER], ["a manager", MANAGER]])("%s can change and delete it", async (_n, id) => {
    expect(await code(caller(id as number).reports.save({ id: 1, name: "New", spec }))).toBe("OK");
    expect(await code(caller(id as number).reports.setSchedule({ id: 2, freq: "daily", recipients: "x@example.com" }))).toBe("OK");
    expect(await code(caller(id as number).reports.remove({ id: 1 }))).toBe("OK");
  });
  it("removing one that doesn't exist says so, rather than ok", async () => {
    expect(await code(caller(MANAGER).reports.remove({ id: 999 }))).toBe("NOT_FOUND");
  });
  it("saving a new one is still anyone's", async () => {
    expect(await code(caller(TEAMMATE).reports.save({ name: "Mine too", spec }))).toBe("OK");
  });
});

/* ── G6 ──────────────────────────────────────────────────────────────────── */

describe("tour steps (G6)", () => {
  const step = { sortOrder: 0, title: "Hello" };
  beforeEach(() => {
    rows("tours").push({ id: 1, workspaceId: LSI, name: "Ours", type: "feature", status: "draft" }, { id: 2, workspaceId: FOREIGN, name: "Theirs", type: "feature", status: "draft" });
    rows("tour_steps").push({ id: 20, tourId: 2, sortOrder: 0, title: "Their step" });
  });

  // 2026-11-07 (audit X6.2/G67): tours.upsert had no caller (TourBuilder saves through create and
  // update) and is deleted; update, the path that remains, is pinned here.
  it("update can't add or rewrite steps on another workspace's tour", async () => {
    expect(await code(caller(ADMIN).tours.update({ id: 2, steps: [step, { ...step, id: 20, title: "Rewritten" }] } as any))).toBe("NOT_FOUND");
    expect(rows("tour_steps").filter((s) => s.tourId === 2).map((s) => s.title)).toEqual(["Their step"]);
  });
  it("this workspace's own tours still save", async () => {
    expect(await code(caller(ADMIN).tours.update({ id: 1, steps: [step] } as any))).toBe("OK");
    expect(rows("tour_steps").filter((s) => s.tourId === 1).map((s) => s.title)).toEqual(["Hello"]);
  });
  it("a step can't carry a tour id or any other column of its own choosing", async () => {
    await caller(ADMIN).tours.create({ name: "New", steps: [{ ...step, tourId: 2, id: 20, createdBy: 999 }] } as any);
    const added = rows("tour_steps").filter((s) => s.title === "Hello");
    expect(added).toHaveLength(1);
    expect(added[0].tourId).not.toBe(2);
    expect(added[0]).not.toHaveProperty("createdBy");
    expect(find("tour_steps", 20).title).toBe("Their step");
    await caller(ADMIN).tours.update({ id: 1, steps: [{ ...step, tourId: 2, title: "Moved?" }] } as any);
    expect(rows("tour_steps").find((s) => s.title === "Moved?").tourId).toBe(1);
  });
  it("a step's shape is checked on every path", async () => {
    expect(await code(caller(ADMIN).tours.create({ name: "New", steps: [{ title: "No order" }] } as any))).toBe("BAD_REQUEST");
    expect(await code(caller(ADMIN).tours.update({ id: 1, steps: [{ sortOrder: 0 }] } as any))).toBe("BAD_REQUEST");
    expect(read("server/routers/tours.ts")).not.toContain("steps: z.array(z.any())");
  });
});

/* ── P4 ──────────────────────────────────────────────────────────────────── */

// 2026-11-07 (audit X6.2/G67): campaigns.updateOutreach and campaigns.getWithDetails served the
// legacy Broadcasts page, retired on 2026-10-27, and had no caller; they are
// deleted, so nothing can link a record to a legacy campaign or read one back.
// server/deadCode.test.ts pins that the legacy campaigns router keeps only list.

/* ── R11 ─────────────────────────────────────────────────────────────────── */

describe("deleting customer-success data (R11)", () => {
  beforeEach(() => {
    rows("customers").push({ id: 1, workspaceId: LSI, accountId: 5, arr: 100, tier: "gold" }, { id: 2, workspaceId: LSI, accountId: 6, arr: 200 }, { id: 3, workspaceId: FOREIGN, accountId: 7, arr: 300 });
    rows("qbrs").push({ id: 1, workspaceId: LSI, customerId: 1 });
  });
  const audits = () => rows("audit_log").filter((a) => a.entityType === "customer" || a.entityType === "customer_success");

  it("a rep can do neither", async () => {
    expect(await code(caller(OWNER).cs.delete({ id: 1 }))).toBe("FORBIDDEN");
    expect(await code(caller(OWNER).cs.clearAll())).toBe("FORBIDDEN");
    expect(rows("customers")).toHaveLength(3);
    expect(rows("qbrs")).toHaveLength(1);
  });
  it("a manager can delete one, and it's on the record who and what", async () => {
    await caller(MANAGER).cs.delete({ id: 1 });
    expect(rows("customers").map((c) => c.id)).toEqual([2, 3]);
    expect(rows("qbrs")).toEqual([]);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ workspaceId: LSI, actorUserId: MANAGER, action: "delete", entityId: 1 });
    expect(audits()[0].before).toMatchObject({ accountId: 5, arr: 100 });
  });
  it("deleting one that isn't here says so, deletes nothing and audits nothing", async () => {
    expect(await code(caller(MANAGER).cs.delete({ id: 3 }))).toBe("NOT_FOUND");
    expect(rows("customers")).toHaveLength(3);
    expect(audits()).toEqual([]);
  });
  it("wiping them all is an admin's, and it's on the record with the count", async () => {
    expect(await code(caller(MANAGER).cs.clearAll())).toBe("FORBIDDEN");
    await caller(ADMIN).cs.clearAll();
    expect(rows("customers").map((c) => c.id)).toEqual([3]);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ workspaceId: LSI, actorUserId: ADMIN, action: "delete" });
    expect(audits()[0].before).toMatchObject({ customers: 2 });
  });
  it("the page offers each only to those who can use it", () => {
    const src = read("client/src/pages/usip/Customers.tsx");
    expect(src).toContain("{isAdminRole(current?.role) && (list?.length ?? 0) > 0 && (");
    expect(src).toContain('rankOf(current?.role) >= rankOf("manager")');
  });
});

/* ── G30 ─────────────────────────────────────────────────────────────────── */

describe("the stream routes and the file proxy use the same gates (G30)", () => {
  const res = () => {
    const r: any = { statusCode: 200, body: null };
    r.status = (c: number) => { r.statusCode = c; return r; };
    r.json = (b: unknown) => { r.body = b; return r; };
    r.send = (b: unknown) => { r.body = b; return r; };
    r.set = () => r; r.setHeader = () => r; r.end = () => r; r.redirect = (c: number) => { r.statusCode = c; return r; };
    return r;
  };
  const stream = async (userId: number) => {
    h.user = rows("users").find((u) => u.id === userId);
    const out = res();
    const auth = await resolveStreamAuth({ headers: { "x-workspace-id": String(LSI) } } as any, out);
    return { allowed: !!auth, status: out.statusCode, body: out.body };
  };
  const file = async (userId: number) => {
    let handler: any;
    registerStorageProxy({ get: (_p: string, h2: any) => { handler = h2; } } as any);
    h.user = rows("users").find((u) => u.id === userId);
    const out = res();
    await handler({ params: { 0: `ws-${LSI}/a.png`, key: `ws-${LSI}/a.png` }, path: `/manus-storage/ws-${LSI}/a.png`, url: `/manus-storage/ws-${LSI}/a.png`, headers: {} }, out);
    return out.statusCode;
  };

  it("a member gets through", async () => {
    expect((await stream(OWNER)).allowed).toBe(true);
    expect(await file(OWNER)).not.toBe(403);
  });
  it("a pending invite isn't a member", async () => {
    expect(await stream(PENDING)).toMatchObject({ allowed: false, status: 403 });
    expect(await file(PENDING)).toBe(403);
  });
  it("someone from another workspace isn't either", async () => {
    expect(await stream(OUTSIDER)).toMatchObject({ allowed: false, status: 403 });
    expect(await file(OUTSIDER)).toBe(403);
  });
  it("an archived workspace is frozen, except for a super admin who can restore it", async () => {
    find("workspaces", LSI).archivedAt = new Date();
    expect(await stream(OWNER)).toMatchObject({ allowed: false, status: 403 });
    expect(await file(OWNER)).toBe(403);
    expect((await stream(SUPER)).allowed).toBe(true);
    expect(await file(SUPER)).not.toBe(403);
  });
  it("required 2FA is required, again except for a super admin", async () => {
    rows("workspace_settings").find((s) => s.workspaceId === LSI).enforce2fa = true;
    invalidateSecurityPolicyCache();
    expect(await stream(OWNER)).toMatchObject({ allowed: false, status: 403 });
    expect(await file(OWNER)).toBe(403);
    expect((await stream(SUPER)).allowed).toBe(true);
    find("users", OWNER).mfaTotpEnabledAt = new Date();
    expect((await stream(OWNER)).allowed).toBe(true);
    expect(await file(OWNER)).not.toBe(403);
  });
});

/* ── P5 ──────────────────────────────────────────────────────────────────── */

describe("the public beacon (P5)", () => {
  const beacon = async (body: Record<string, unknown>) => {
    let handler: any;
    registerWebsiteTrackingRoutes({ get: () => {}, options: () => {}, post: (_p: string, h2: any) => { handler = h2; } } as any);
    const res: any = { setHeader: () => {}, status: () => res, json: () => res, end: () => res };
    await handler({ body }, res);
  };
  const intentTasks = () => rows("tasks").filter((t) => String(t.title).startsWith("High-intent website visit"));
  beforeEach(() => {
    for (let id = 1; id <= 3; id++) rows("leads").push({ id, workspaceId: LSI, firstName: `L${id}`, lastName: "X", ownerUserId: null });
  });
  // 2026-11-06 (S1b, P5): only a SIGNED link id files a task now, so these
  // cases name the record with one. What they pin (the daily ceiling, counted
  // per workspace and per day) is unchanged; an unsigned id filing nothing is
  // pinned in s1bPortalAndTracking.test.ts.
  const vid = (id: number) => signVisitorId(LSI, "l", id);

  it("a known person on a high-intent page still files a task", async () => {
    await beacon({ slug: "lsi", visitorId: "v", path: "/pricing", vid: vid(1) });
    expect(intentTasks()).toHaveLength(1);
  });

  it("walking ids hits a ceiling: visits still count, tasks stop", async () => {
    for (let i = 0; i < MAX_INTENT_TASKS_PER_DAY; i++) rows("tasks").push({ id: 1000 + i, workspaceId: LSI, title: "High-intent website visit: someone", createdAt: new Date(), source: "ai", status: "open" });
    await beacon({ slug: "lsi", visitorId: "v", path: "/pricing", vid: vid(2) });
    expect(intentTasks()).toHaveLength(MAX_INTENT_TASKS_PER_DAY);
    expect(rows("website_visits").map((v) => v.leadId)).toEqual([2]);
  });

  it("another workspace's tasks, and yesterday's, don't count towards it", async () => {
    for (let i = 0; i < MAX_INTENT_TASKS_PER_DAY; i++) {
      rows("tasks").push({ id: 2000 + i, workspaceId: FOREIGN, title: "High-intent website visit: someone", createdAt: new Date(), source: "ai", status: "open" });
      rows("tasks").push({ id: 3000 + i, workspaceId: LSI, title: "High-intent website visit: someone", createdAt: new Date(Date.now() - 2 * 86_400_000), source: "ai", status: "open" });
    }
    await beacon({ slug: "lsi", visitorId: "v", path: "/pricing", vid: vid(3) });
    expect(rows("website_visits").map((v) => v.leadId)).toEqual([3]);
    expect(intentTasks().filter((t) => t.relatedId === 3)).toHaveLength(1);
  });

  it("has a rate limit, mounted before the route it limits", () => {
    const limits = read("server/publicRateLimit.ts");
    expect(limits).toContain("export const trackBeaconLimiter = rateLimit({");
    expect(limits).toContain('app.use("/api/track", (req: Request, res: Response, next: NextFunction) =>');
    const index = read("server/_core/index.ts");
    const limiter = index.indexOf("registerPublicRateLimits(app);");
    const route = index.indexOf("registerWebsiteTrackingRoutes(app);");
    expect(limiter).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(limiter);
  });
});
