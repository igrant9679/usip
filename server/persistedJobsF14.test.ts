/**
 * Bulk work on the persisted runner (audit 2026-10-20, F14).
 *
 *   · Rewriting not-started sequences ran in an in-memory loop: a restart
 *     lost its progress part-way and the status said nothing had run. It is a
 *     bulk_jobs job now: progress and each prospect's outcome on the row, a
 *     restart resumes from the last prospect done, one per workspace, started
 *     at once through the runner's kick.
 *   · Re-evaluate All was already a job (A11); it now starts at once through
 *     the same kick rather than at the runner's next tick.
 *
 * Executed against the SQL-evaluating fake through the real runner
 * (tickJobs). The sequence writer is mocked; nothing is sent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "a".repeat(64);
  return { db: null as any, agent: [] as number[], held: new Set<number>() };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./routers/are/prospects", async (a) => ({
  ...(await a<typeof import("./routers/are/prospects")>()),
  runSequenceAgent: async (prospectId: number) => {
    h.agent.push(prospectId);
    if (h.held.has(prospectId)) return { ok: false, held: "Breaks an avoid rule" };
    const intel = h.db.rowsOf("prospect_intelligence").find((r: any) => r.prospectQueueId === prospectId);
    intel.generatedSequence = [{ stepIndex: 0, channel: "email", subject: `New ${prospectId}`, body: "b" }];
    return { ok: true };
  },
}));

// Who is eligible is a raw EXISTS the fake cannot read; pinned in rewriteNotStarted.test.ts.
vi.mock("./services/are/rewriteNotStarted", async (a) => ({
  ...(await a<typeof import("./services/are/rewriteNotStarted")>()),
  findNotStartedEnrolled: async () => [{ prospectQueueId: 1, campaignId: 7 }],
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { tickJobs } from "./services/jobs/runner";
import { REWRITE_NOT_STARTED_JOB, rewriteJobState, startRewriteNotStarted } from "./services/are/rewriteNotStarted";

const WS = 2, ADMIN = 20;
const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ADMIN, openId: "u", email: "a@example.com", name: "A", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

/** An enrolled prospect whose one step is still scheduled. */
const enrolled = (id: number) => {
  rows("prospect_queue").push({ id, workspaceId: WS, campaignId: 7, sequenceStatus: "enrolled", firstName: "P", lastName: String(id) });
  rows("prospect_intelligence").push({ id: 100 + id, prospectQueueId: id, workspaceId: WS, generatedSequence: [{ stepIndex: 0, subject: "Old", body: "Old" }], copyHoldReason: null });
  rows("are_execution_queue").push({ id: 500 + id, workspaceId: WS, campaignId: 7, prospectQueueId: id, stepIndex: 0, channel: "email", status: "scheduled", scheduledAt: new Date(Date.now() + 86_400_000), messageContent: { subject: "Old", body: "Old" } });
};
const targets = (ids: number[]) => ids.map((prospectQueueId) => ({ prospectQueueId, campaignId: 7 }));

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.agent = []; h.held = new Set();
  rows("are_campaigns").push({ id: 7, workspaceId: WS, name: "C", status: "active" });
  rows("users").push({ id: ADMIN, openId: "u", email: "a@example.com", name: "A", role: "user" });
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
});

describe("rewriting not-started sequences is a persisted job", () => {
  it("is queued as a job, one per workspace, and the runner works it with an outcome per prospect", async () => {
    [1, 2, 3].forEach(enrolled);
    h.held.add(2);
    expect(await startRewriteNotStarted(WS, ADMIN, targets([1, 2, 3]))).toBe(true);
    expect(await startRewriteNotStarted(WS, ADMIN, targets([1, 2, 3]))).toBe(false);
    const [job] = rows("bulk_jobs");
    expect(job).toMatchObject({ kind: REWRITE_NOT_STARTED_JOB, status: "queued", total: 3 });
    await tickJobs(60_000);
    expect(rows("bulk_jobs")[0]).toMatchObject({ status: "done", done: 2, failed: 1 });
    const s = await rewriteJobState(WS);
    expect(s).toMatchObject({ running: false, total: 3, done: 3, rewritten: 2, held: 1, startedMeanwhile: 0, failed: 0 });
    expect(s.outcomes).toEqual([{ prospectQueueId: 2, outcome: expect.stringMatching(/^held: /) }]);
    // The sends were rewritten only for the clean ones.
    expect(rows("are_execution_queue").map((r) => r.messageContent.subject)).toEqual(["New 1", "Old", "New 3"]);
  });

  it("a restart resumes from the last prospect done, without writing the first again", async () => {
    [1, 2].forEach(enrolled);
    // A job a dead worker left part-way: running, a stale heartbeat, one done.
    rows("bulk_jobs").push({
      id: 9, workspaceId: WS, userId: ADMIN, kind: REWRITE_NOT_STARTED_JOB, status: "running", total: 2, done: 1, failed: 0,
      resumeFrom: 1, payload: { targets: targets([1, 2]) }, failures: [], message: null,
      heartbeatAt: new Date(Date.now() - 10 * 60_000), startedAt: new Date(Date.now() - 11 * 60_000), finishedAt: null, createdAt: new Date(),
    });
    await tickJobs(60_000);
    expect(h.agent).toEqual([2]);
    expect(rows("bulk_jobs")[0]).toMatchObject({ status: "done", done: 2 });
    expect((await rewriteJobState(WS)).rewritten).toBe(2);
  });

  it("the endpoint starts it (not a dry run), and the status reads the job row", async () => {
    [1].forEach(enrolled);
    const dry = await caller().are.campaigns.rewriteNotStartedSequences();
    expect(dry).toMatchObject({ dryRun: true, eligible: 1, started: false });
    expect(rows("bulk_jobs")).toHaveLength(0);
    const run = await caller().are.campaigns.rewriteNotStartedSequences({ dryRun: false });
    expect(run).toMatchObject({ dryRun: false, eligible: 1, started: true });
    expect(await caller().are.campaigns.rewriteNotStartedStatus()).toMatchObject({ running: true, total: 1, rewritten: 0 });
  });

  it("keeps no progress in memory, registers its kind at boot, and starts through the kick", () => {
    const svc = read("server/services/are/rewriteNotStarted.ts");
    expect(svc).not.toContain("const jobs = new Map");
    expect(svc).not.toContain("runOutsideRequestContext(");
    expect(svc).toContain("registerJobKind<RewritePayload>(REWRITE_NOT_STARTED_JOB, {");
    const start = svc.slice(svc.indexOf("export async function startRewriteNotStarted("));
    expect(start).toContain("oneAtATime: true");
    expect(start).toContain("kickJobs();");
    expect(read("server/routers/are/campaigns.ts")).toContain('import "../../services/are/rewriteNotStarted";');
  });
});

describe("Re-evaluate All starts at once through the same kick", () => {
  it("kicks the runner after enqueueing", () => {
    const pros = read("server/routers/are/prospects.ts");
    const fn = pros.slice(pros.indexOf("reEvaluateAll: workspaceProcedure"), pros.indexOf("getReevalJob: workspaceProcedure"));
    const enq = fn.indexOf("await enqueueJob({ workspaceId: ctx.workspace.id, userId: ctx.user.id, kind: REEVAL_ALL_JOB");
    expect(enq).toBeGreaterThan(0);
    expect(fn.slice(enq, enq + 400)).toContain("kickJobs();");
  });
});
