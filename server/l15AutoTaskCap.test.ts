/**
 * The other auto-task sources keep to a daily cap (audit 2026-10-20, L15;
 * final pass 2026-11-07).
 *
 * Task Autopilot had a per-workspace daily cap; website visits, Deal
 * Autopilot, the proposal follow-ups and escalations, and sequence task steps
 * had none. Each now files at most `autoTaskDailyCap` tasks a workspace day
 * (default 25, Task Autopilot's), counted by the task's autoSource. At the cap
 * a source skips and the skip is recorded; a sequence task step waits for the
 * next workspace day instead of being dropped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { AUTO_TASK_DAILY_CAP_DEFAULT, autoTaskBudget, autoTaskToday, mayFileAutoTask, resetAutoTaskSkips } from "./services/autoTaskCap";
import { _clearWorkspaceTimezoneCache, startOfNextWorkspaceDay } from "./services/workspaceTimezone";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const WS = 2;
const OTHER = 9;

function seed(tz = "America/New_York", cap?: number) {
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null });
  rows("users").push({ id: 1, openId: "o1", name: "Owner", email: "owner@lsi.example", role: "user", sessionVersion: 0, mfaTotpEnabledAt: null });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: 1, role: "admin", deactivatedAt: null, inviteToken: null });
  rows("workspace_settings").push({ workspaceId: WS, timezone: tz, ...(cap !== undefined ? { autoTaskDailyCap: cap } : {}) });
}
const task = (id: number, ws: number, autoSource: string | null, createdAt: Date) =>
  ({ id, workspaceId: ws, title: "t", status: "open", priority: "normal", type: "follow_up", source: "ai", autoSource, createdAt });
function caller() {
  return appRouter.createCaller({
    user: rows("users")[0],
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {}, cookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => { _clearWorkspaceTimezoneCache(); resetAutoTaskSkips(); });

describe("the cap", () => {
  it("defaults to Task Autopilot's 25", async () => {
    seed();
    expect(AUTO_TASK_DAILY_CAP_DEFAULT).toBe(25);
    expect((await autoTaskBudget(h.db, WS, "website_visit")).cap).toBe(25);
    expect(read("server/_core/rawMigrations.ts")).toContain("ADD COLUMN `autoTaskDailyCap` int NOT NULL DEFAULT 25");
    expect(read("drizzle/schema.ts")).toContain('autoTaskDailyCap: int("autoTaskDailyCap").default(25).notNull(),');
  });

  it("counts one source's tasks since the workspace's midnight, in this workspace only", async () => {
    seed("America/New_York", 3);
    const now = new Date("2026-11-07T15:00:00Z"); // 10 AM in New York
    rows("tasks").push(
      task(1, WS, "deal_autopilot", new Date("2026-11-07T06:00:00Z")), // 1 AM today in New York
      task(2, WS, "deal_autopilot", new Date("2026-11-07T03:00:00Z")), // 10 PM yesterday in New York: not today's
      task(3, WS, "website_visit", new Date("2026-11-07T14:00:00Z")), // another source
      task(4, OTHER, "deal_autopilot", new Date("2026-11-07T14:00:00Z")), // another workspace
      task(5, WS, null, new Date("2026-11-07T14:00:00Z")), // a person's task
    );
    expect(await autoTaskBudget(h.db, WS, "deal_autopilot", now)).toMatchObject({ cap: 3, used: 1, remaining: 2 });
  });

  it("at the cap a source is refused, and the skip is recorded, once logged", async () => {
    seed("UTC", 2);
    const now = new Date("2026-11-07T12:00:00Z");
    rows("tasks").push(task(1, WS, "proposal_followup", new Date("2026-11-07T01:00:00Z")), task(2, WS, "proposal_followup", new Date("2026-11-07T02:00:00Z")));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await mayFileAutoTask(h.db, WS, "proposal_followup", now)).toBe(false);
    expect(await mayFileAutoTask(h.db, WS, "proposal_followup", now)).toBe(false);
    expect(await mayFileAutoTask(h.db, WS, "sequence_step", now)).toBe(true);
    expect(log.mock.calls.filter((c) => String(c[0]).includes("[AutoTaskCap]"))).toHaveLength(1);
    log.mockRestore();
    const today = await autoTaskToday(h.db, WS, now);
    expect(today.find((t) => t.source === "proposal_followup")).toMatchObject({ filed: 2, cap: 2, skipped: 2 });
    expect(today.find((t) => t.source === "sequence_step")).toMatchObject({ filed: 0, skipped: 0 });
  });

  it("a cap of 0 stops a source filing at all", async () => {
    seed("UTC", 0);
    expect(await mayFileAutoTask(h.db, WS, "website_visit")).toBe(false);
  });

  it("a failed read lets the task through, as before the cap", async () => {
    seed();
    const broken = { select: () => { throw new Error("db down"); } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await mayFileAutoTask(broken as any, WS, "website_visit")).toBe(true);
    warn.mockRestore();
  });

  it("a held sequence step waits until the workspace's next midnight", async () => {
    seed("America/New_York");
    const now = new Date("2026-11-07T15:00:00Z");
    const next = await startOfNextWorkspaceDay(WS, now);
    const wall = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(next);
    expect(wall).toBe("2026-11-08, 00:00");
  });
});

describe("each source checks the cap and labels its tasks", () => {
  it("website visits", () => {
    const src = read("server/websiteTracking.ts");
    expect(src).toContain('(await mayFileAutoTask(db, ws.id, "website_visit"))');
    expect(src).toContain('autoSource: "website_visit",');
  });
  it("Deal Autopilot", () => {
    const src = read("server/services/dealAutopilot.ts");
    expect(src).toContain('if (nextStep && !busy.has(o.id) && (await mayFileAutoTask(db, workspaceId, "deal_autopilot"))) {');
    expect(src).toContain('autoSource: "deal_autopilot",');
  });
  it("proposal follow-ups and escalations", () => {
    const src = read("server/emailTracking.ts");
    expect(src).toContain('if (!(await mayFileAutoTask(db, proposal.workspaceId, "proposal_followup"))) continue;');
    expect(src).toContain('autoSource: "proposal_followup",');
    expect(src).toContain('if (!(await mayFileAutoTask(db, act72.workspaceId, "proposal_escalation"))) continue;');
    expect(src).toContain('autoSource: "proposal_escalation",');
  });
  it("sequence task steps wait for tomorrow rather than being dropped", () => {
    const src = read("server/sequenceEngine.ts");
    // The engine's task step (the file's first "task" branch is a title helper).
    const at = src.indexOf("// At the workspace's daily cap for sequence tasks");
    expect(at).toBeGreaterThan(-1);
    const step = src.slice(at, src.indexOf('if (step.type === "linkedin_dm" || step.type === "linkedin_invite") {', at));
    expect(step).toContain('if (!(await mayFileAutoTask(db, enrollment.workspaceId, "sequence_step", now))) {');
    expect(step).toContain("await hold(await startOfNextWorkspaceDay(enrollment.workspaceId, now));");
    expect(step.indexOf("mayFileAutoTask(")).toBeLessThan(step.indexOf("claimNow()"));
    expect(step).toContain('autoSource: "sequence_step",');
  });
});

describe("the cap is set beside Task Autopilot's, and shown on the engine status page", () => {
  it("reads and saves through the Task Autopilot settings, admins only", async () => {
    seed("UTC", 25);
    expect((await caller().tasks.getAutopilotSettings()).autoTaskDailyCap).toBe(25);
    await caller().tasks.setAutopilotSettings({ autoTaskDailyCap: 10 });
    // The fake upserts on unique indexes only, so look for the written row.
    const written = rows("workspace_settings").filter((r) => r.workspaceId === WS && r.autoTaskDailyCap === 10);
    expect(written).toHaveLength(1);
    expect(written[0].taskAutopilotMode ?? null).toBeNull(); // the mode is not written
  });

  it("the Tasks page offers it, and the engine status page lists today's", () => {
    const page = read("client/src/pages/usip/TasksV2.tsx");
    expect(page).toContain('aria-label="Automatic tasks a day from each source"');
    expect(page).toContain("onSave={(n) => setMode.mutate({ autoTaskDailyCap: n })}");
    expect(read("client/src/pages/usip/EngineStatus.tsx")).toContain('<Section title="Automatic tasks today">');
    expect(read("server/services/engineStatus.ts")).toContain("autoTaskToday(db, workspaceId, now)");
  });
});
