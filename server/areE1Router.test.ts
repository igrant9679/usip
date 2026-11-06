/**
 * Revenue Engine procedures (audit 2026-10-20, batch E1).
 *
 *   A69 approveBatch, which approved any row whatever its state and which no
 *       screen called, is gone
 *   A75 re-evaluating one prospect uses the campaign's approve line, not a
 *       hard-coded 70, and only a workspace admin (not a platform role) may
 *       delete someone else's note
 *   A11 Re-evaluate All re-scores only the engine's own score rejections, keeps
 *       why they were rejected, and runs in the background with real progress
 *   A31 a campaign's first launch asks for the workspace's time zone while it
 *       is still the UTC default
 *
 * Through the real procedures against the SQL-evaluating fake, with a real
 * member table, so each caller's role is the one on their row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, score: 80 as number | null, scored: [] as number[] };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async (p: any) => {
    h.scored.push(1);
    if (h.score == null) return { choices: [{ message: { content: "" } }] };
    // "Name: Low …" scores 40, everyone else h.score.
    const low = JSON.stringify(p?.messages ?? "").includes("Name: Low");
    return { choices: [{ message: { content: JSON.stringify({ industry: 15, title: 15, companySize: 15, geography: 15, antiPatternPenalty: 0, total: low ? 40 : h.score }) } }] };
  },
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { TIMEZONE_UNSET_ON_LAUNCH } from "@shared/sendWindow";
import { __resetJobRunnerForTests, tickJobs } from "./services/jobs/runner";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const WS = 2;
const ADMIN = 20;
const REP = 21;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const find = (t: string, id: number) => rows(t).find((r) => r.id === id);
const caller = (userId: number, platformRole = "user") => appRouter.createCaller({
  user: { id: userId, openId: `u${userId}`, email: `u${userId}@example.com`, name: `U${userId}`, loginMethod: "password", role: platformRole, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), mfaTotpEnabledAt: null },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
async function code(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e.code as string; }
  return "OK";
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.score = 80;
  h.scored = [];
  const user = (id: number) => ({ id, openId: `u${id}`, email: `u${id}@example.com`, name: `U${id}`, loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), mfaTotpEnabledAt: null });
  rows("users").push(user(ADMIN), user(REP));
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  const member = (id: number, userId: number, role: string) => ({ id, workspaceId: WS, userId, role, deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
  rows("workspace_members").push(member(1, ADMIN, "admin"), member(2, REP, "rep"));
  rows("workspace_settings").push({ workspaceId: WS, enforce2fa: false, timezone: "America/New_York" });
  rows("icp_profiles").push({ id: 1, workspaceId: WS, isActive: true, targetTitles: ["County Administrator"], targetIndustries: [], targetGeographies: [], antiPatterns: [] });
  rows("are_campaigns").push({ id: 7, workspaceId: WS, name: "Counties", status: "active", autoApproveThreshold: 85, icpOverrides: {}, ownerUserId: ADMIN });
});

describe("approveBatch (A69)", () => {
  it("is not a procedure any more", () => {
    const procs = Object.keys((appRouter as any)._def.procedures);
    expect(procs).toContain("are.campaigns.approveAllPending");
    expect(procs).not.toContain("are.campaigns.approveBatch");
  });
});

describe("Re-evaluate All (A11)", () => {
  const AUTO = "Auto-screened: ICP match 40/100 below approve threshold 85";
  beforeEach(() => {
    __resetJobRunnerForTests();
    h.score = 90;
    const p = (id: number, firstName: string, over: Record<string, unknown>) => rows("prospect_queue").push({
      id, workspaceId: WS, campaignId: 7, firstName, lastName: `P${id}`, title: "Clerk", sequenceStatus: "skipped",
      enrichmentStatus: "complete", icpMatchScore: 40, rejectedAt: new Date("2026-11-01T12:00:00Z"), rejectedByUserId: null, ...over,
    });
    p(11, "Good", { rejectionReason: AUTO });
    p(12, "Good", { rejectionReason: "Not a fit for us", rejectedByUserId: REP });
    p(13, "Good", { rejectionReason: "On suppression list — not enrolled (unsubscribed)" });
    p(14, "Low", { rejectionReason: AUTO });
    p(15, "Good", { rejectionReason: AUTO, workspaceId: 4 });
  });

  it("answers at once with a background job, having asked the model nothing yet", async () => {
    const r = await caller(ADMIN).are.prospects.reEvaluateAll({ campaignId: 7 });
    expect(r).toMatchObject({ total: 2, threshold: 85, alreadyRunning: false });
    expect(r.jobId).toBeTruthy();
    expect(h.scored).toHaveLength(0);
  });

  it("re-scores only the engine's own score rejections, and keeps why they were rejected", async () => {
    const r = await caller(ADMIN).are.prospects.reEvaluateAll({ campaignId: 7 });
    await tickJobs();
    expect(h.scored).toHaveLength(2);
    expect(find("prospect_queue", 11)).toMatchObject({ sequenceStatus: "pending", icpMatchScore: 90, rejectionReason: AUTO });
    expect(find("prospect_queue", 14)).toMatchObject({ sequenceStatus: "skipped", icpMatchScore: 40, rejectionReason: AUTO });
    // A person's rejection, a suppression and another workspace's row are not touched.
    for (const id of [12, 13, 15]) expect(find("prospect_queue", id)).toMatchObject({ sequenceStatus: "skipped", icpMatchScore: 40 });
    // The progress the screen polls, and the history row.
    expect(await caller(ADMIN).are.prospects.getReevalJob({ jobId: r.jobId! })).toMatchObject({ status: "done", total: 2, done: 2, requalified: 1 });
    expect(rows("reeval_runs")[0]).toMatchObject({ processed: 2, requalified: 1, thresholdUsed: 85 });
  });

  it("leaves a row a person restored or rejected after the run began", async () => {
    await caller(ADMIN).are.prospects.reEvaluateAll({ campaignId: 7 });
    Object.assign(find("prospect_queue", 11), { rejectedByUserId: REP, rejectionReason: "Rejected by hand" });
    await tickJobs();
    expect(find("prospect_queue", 11)).toMatchObject({ sequenceStatus: "skipped", icpMatchScore: 40 });
  });

  it("a second click gets the running job back instead of paying again", async () => {
    const a = await caller(ADMIN).are.prospects.reEvaluateAll({ campaignId: 7 });
    const b = await caller(ADMIN).are.prospects.reEvaluateAll({ campaignId: 7 });
    expect(b).toMatchObject({ jobId: a.jobId, alreadyRunning: true });
    expect(rows("bulk_jobs")).toHaveLength(1);
  });

  it("reads only its own kind of job", async () => {
    rows("bulk_jobs").push({ id: 90, workspaceId: WS, kind: "are.bulk", status: "running", total: 3, done: 1, failed: 0, payload: {} });
    expect(await caller(ADMIN).are.prospects.getReevalJob({ jobId: 90 })).toBeNull();
  });

  it("the screen follows the job, and says which rejections it re-scores", () => {
    const page = read("client/src/pages/usip/ARECampaignDetail.tsx");
    expect(page).toContain("trpc.are.prospects.getReevalJob.useQuery(");
    expect(page).toContain("refetchInterval: reEvalJob ? 2000 : false");
    expect(page).toContain("Rejections a\n                person made, and rejections for any other reason, are left as they are.");
  });

  it("another workspace's job is not readable from here", async () => {
    const r = await caller(ADMIN).are.prospects.reEvaluateAll({ campaignId: 7 });
    rows("bulk_jobs")[0].workspaceId = 4;
    expect(await caller(ADMIN).are.prospects.getReevalJob({ jobId: r.jobId! })).toBeNull();
  });
});

describe("the prospects router in place (A75)", () => {
  it("re-evaluating one prospect uses the campaign's approve line, not 70", async () => {
    rows("prospect_queue").push({ id: 21, workspaceId: WS, campaignId: 7, firstName: "Good", lastName: "One", title: "Clerk", sequenceStatus: "skipped", icpMatchScore: 40, rejectionReason: "x" });
    const r = await caller(ADMIN).are.prospects.reEvaluate({ prospectId: 21 });
    // 80 clears 70 but not this campaign's 85.
    expect(r).toMatchObject({ newScore: 80, newStatus: "skipped" });
  });

  it("a note is deleted by its author or a workspace admin, whatever the platform role says", async () => {
    rows("prospect_notes").push(
      { id: 1, workspaceId: WS, prospectQueueId: 21, userId: ADMIN, body: "mine" },
      { id: 2, workspaceId: WS, prospectQueueId: 21, userId: REP, body: "the rep's" },
    );
    // A rep who happens to be a platform admin is still a rep here.
    expect(await code(caller(REP, "admin").are.prospects.deleteNote({ noteId: 1 }))).toBe("FORBIDDEN");
    expect(rows("prospect_notes")).toHaveLength(2);
    // A workspace admin whose platform role is plain user may.
    expect(await code(caller(ADMIN, "user").are.prospects.deleteNote({ noteId: 2 }))).toBe("OK");
    expect(await code(caller(REP).are.prospects.deleteNote({ noteId: 1 }))).toBe("FORBIDDEN");
  });
});

describe("a campaign's first launch on the UTC default (A31)", () => {
  beforeEach(() => {
    rows("are_campaigns").push({ id: 8, workspaceId: WS, name: "New", status: "draft", startedAt: null, ownerUserId: ADMIN });
  });
  const utc = () => { rows("workspace_settings")[0].timezone = "UTC"; };

  it("asks first: refused with the message the screens recognise, and nothing changes", async () => {
    utc();
    await expect(caller(ADMIN).are.campaigns.setStatus({ id: 8, status: "active" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: TIMEZONE_UNSET_ON_LAUNCH });
    expect(find("are_campaigns", 8).status).toBe("draft");
  });

  it("launches on UTC when the person says so", async () => {
    utc();
    await caller(ADMIN).are.campaigns.setStatus({ id: 8, status: "active", confirmTimezone: true });
    expect(find("are_campaigns", 8).status).toBe("active");
  });

  it("does not ask a workspace that chose its zone", async () => {
    await caller(ADMIN).are.campaigns.setStatus({ id: 8, status: "active" });
    expect(find("are_campaigns", 8).status).toBe("active");
  });

  it("does not ask again when a campaign that has run is resumed, or paused", async () => {
    utc();
    Object.assign(find("are_campaigns", 8), { status: "paused", startedAt: new Date("2026-10-01T12:00:00Z") });
    await caller(ADMIN).are.campaigns.setStatus({ id: 8, status: "active" });
    expect(find("are_campaigns", 8).status).toBe("active");
    await caller(ADMIN).are.campaigns.setStatus({ id: 7, status: "paused" });
    expect(find("are_campaigns", 7).status).toBe("paused");
  });

  it("creating with Launch asks too, and creates nothing until answered; a draft never asks", async () => {
    utc();
    const before = rows("are_campaigns").length;
    await expect(caller(ADMIN).are.campaigns.create({ name: "Launch me", launch: true } as any)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(rows("are_campaigns")).toHaveLength(before);
    await caller(ADMIN).are.campaigns.create({ name: "Draft me", launch: false } as any);
    expect(rows("are_campaigns")).toHaveLength(before + 1);
  });

  it("every launch button hands its error to the question, and retries with confirmTimezone", () => {
    const list = read("client/src/pages/usip/ARECampaigns.tsx");
    const detail = read("client/src/pages/usip/ARECampaignDetail.tsx");
    for (const [src, name] of [[list, "create"], [list, "setStatus"], [detail, "setStatus"]] as const) {
      const at = src.indexOf(`const ${name} = trpc.are.campaigns.${name}.useMutation({`);
      expect(at, name).toBeGreaterThan(-1);
      const block = src.slice(at, src.indexOf("\n  });", at));
      expect(block).toContain("if (askLaunchOnUtc(e.message, () =>");
      expect(block).toContain("confirmTimezone: true");
    }
  });
});
