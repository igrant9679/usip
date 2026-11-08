/**
 * Incremental background work (audit 2026-10-20, X4.4; final pass 2026-11-07).
 *
 * The pipeline alert sweep read every open deal every 15 minutes. It now reads
 * only the deals that changed since the last sweep (an edit, an activity, or a
 * live no_champion alert, since contact roles carry no timestamp), with a full
 * pass at least every six hours and at the first sweep of each workspace day,
 * which is what catches what only time changes. And "Enrich" on up to 500
 * selected companies runs as a background job (the bulk job "all matching"
 * already used), instead of one by one inside the request; the procedure the
 * job calls is bounded to its 25-company slice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
// The runner's tick is the cron's business; here the queued job is what is checked.
vi.mock("./services/jobs/runner", async (a) => ({ ...(await a<typeof import("./services/jobs/runner")>()), kickJobs: () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { ALERT_FULL_PASS_MS, alertSweepPlan, dealsChangedSince, resetAlertSweepState, scanPipelineAlertsForWorkspace } from "./routers/pipelineAlerts";
import { BULK_JOB } from "./services/bulkByFilter";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const WS = 2;

function seed() {
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null });
  rows("users").push({ id: 1, openId: "o1", name: "Owner", email: "owner@lsi.example", role: "user", sessionVersion: 0, mfaTotpEnabledAt: null });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: 1, role: "admin", deactivatedAt: null, inviteToken: null });
  rows("workspace_settings").push({ workspaceId: WS, timezone: "UTC" });
}
function caller() {
  return appRouter.createCaller({
    user: rows("users")[0],
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {}, cookie: () => {} },
  } as unknown as TrpcContext);
}
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return (e as { code?: string }).code ?? "ERR"; } };

beforeEach(() => { seed(); resetAlertSweepState(); });

describe("the alert sweep runs incrementally, with a slow full pass", () => {
  it("plans a full pass first, then incremental from the last sweep, and full again after six hours or a new day", () => {
    const t0 = Date.parse("2026-11-07T10:00:00Z");
    expect(alertSweepPlan(undefined, t0, "2026-11-07")).toEqual({ full: true, since: null });
    const state = { lastSweepAt: t0, lastFullAt: t0, fullDay: "2026-11-07" };
    const later = alertSweepPlan(state, t0 + 15 * 60_000, "2026-11-07");
    expect(later.full).toBe(false);
    expect(later.since!.getTime()).toBeLessThanOrEqual(t0); // reaches back past the last start
    expect(alertSweepPlan(state, t0 + ALERT_FULL_PASS_MS, "2026-11-07").full).toBe(true);
    expect(alertSweepPlan(state, t0 + 60 * 60_000, "2026-11-08").full).toBe(true);
    expect(ALERT_FULL_PASS_MS).toBe(6 * 3_600_000);
  });

  it("the changed deals are the edited ones, the ones with new activity, and the unchampioned", async () => {
    const since = new Date("2026-11-07T10:00:00Z");
    const before = new Date("2026-11-07T09:00:00Z");
    const after = new Date("2026-11-07T10:05:00Z");
    rows("opportunities").push(
      { id: 1, workspaceId: WS, name: "Edited", stage: "discovery", updatedAt: after },
      { id: 2, workspaceId: WS, name: "Quiet", stage: "discovery", updatedAt: before },
      { id: 3, workspaceId: WS, name: "Logged", stage: "discovery", updatedAt: before },
      { id: 4, workspaceId: WS, name: "No champion", stage: "discovery", updatedAt: before },
      { id: 5, workspaceId: 9, name: "Theirs", stage: "discovery", updatedAt: after },
    );
    rows("activities").push({ id: 1, workspaceId: WS, relatedType: "opportunity", relatedId: 3, createdAt: after, type: "note" });
    rows("pipeline_alerts").push({ id: 1, workspaceId: WS, opportunityId: 4, alertType: "no_champion", dismissedAt: null });
    expect((await dealsChangedSince(h.db, WS, since)).sort()).toEqual([1, 3, 4]);
  });

  it("an incremental scan reads only the changed deals; with none changed it reads no deal", async () => {
    const since = new Date(Date.now() - 60_000);
    rows("opportunities").push(
      { id: 1, workspaceId: WS, name: "Edited", stage: "discovery", winProb: 30, updatedAt: new Date() },
      { id: 2, workspaceId: WS, name: "Untouched", stage: "discovery", winProb: 30, updatedAt: new Date(Date.now() - 86_400_000) },
    );
    const inc = await scanPipelineAlertsForWorkspace(WS, { changedSince: since });
    expect(inc).toMatchObject({ full: false, scanned: 1 });
    expect(rows("pipeline_alerts").length).toBeGreaterThan(0);
    expect(rows("pipeline_alerts").every((a) => a.opportunityId === 1)).toBe(true);
    const full = await scanPipelineAlertsForWorkspace(WS);
    expect(full).toMatchObject({ full: true, scanned: 2 });
    rows("opportunities").forEach((o) => { o.updatedAt = new Date(Date.now() - 86_400_000); });
    rows("pipeline_alerts").length = 0;
    expect(await scanPipelineAlertsForWorkspace(WS, { changedSince: since })).toMatchObject({ full: false, scanned: 0 });
  });

  it("the cron keeps the plan per workspace, and Run Health Scan stays a full scan", () => {
    const src = read("server/routers/pipelineAlerts.ts");
    const cron = src.slice(src.indexOf("export async function runPipelineAlertsCron"), src.indexOf("export const pipelineAlertsRouter"));
    expect(cron).toContain("const plan = alertSweepPlan(sweepState.get(ws.id), now, today);");
    expect(cron).toContain("await scanPipelineAlertsForWorkspace(ws.id, { changedSince: plan.since, now: new Date(now) });");
    const scan = src.slice(src.indexOf("scan: workspaceProcedure"), src.indexOf("list: workspaceProcedure"));
    expect(scan).toContain("return scanPipelineAlertsForWorkspace(ctx.workspace.id);");
  });
});

describe("Enrich on selected companies runs as a background job", () => {
  beforeEach(() => {
    rows("accounts").push({ id: 11, workspaceId: WS, name: "A" }, { id: 12, workspaceId: WS, name: "B" }, { id: 90, workspaceId: 9, name: "Theirs" });
  });

  it("queues one job for this workspace's companies and returns at once", async () => {
    const r = await caller().companies.enrichSelection({ accountIds: [12, 11, 90, 11] });
    expect(r).toMatchObject({ total: 2 });
    const jobs = rows("bulk_jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: BULK_JOB, workspaceId: WS, userId: 1, status: "queued", total: 2 });
    expect(jobs[0].payload).toMatchObject({ entity: "companies", action: "enrich", ids: [11, 12], scope: "selection" });
  });

  it("another workspace's companies alone are refused, and a selection keeps the 500 cap", async () => {
    expect(await code(caller().companies.enrichSelection({ accountIds: [90] }))).toBe("NOT_FOUND");
    expect(await code(caller().companies.enrichSelection({ accountIds: Array.from({ length: 501 }, (_, i) => i + 1) }))).toBe("BAD_REQUEST");
    expect(rows("bulk_jobs")).toHaveLength(0);
  });

  it("the request-time loop is bounded to the job's slice", async () => {
    expect(await code(caller().companies.bulkEnrich({ accountIds: Array.from({ length: 26 }, (_, i) => i + 1) }))).toBe("BAD_REQUEST");
    expect(read("server/services/bulkByFilter.ts")).toMatch(/enrichFull: 1, enrich: 25 \}/);
  });

  it("the page queues a selection and follows it like all matching", () => {
    const page = read("client/src/pages/usip/Companies.tsx");
    expect(page).toContain("const bulkEnrich = trpc.companies.enrichSelection.useMutation({");
    expect(page).toContain("onSuccess: (r) => { setMatchingJob(r.jobId);");
    expect(page).not.toContain("trpc.companies.bulkEnrich.useMutation(");
  });
});
