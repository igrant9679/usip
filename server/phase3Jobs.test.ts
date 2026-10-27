/**
 * Phase 3 of the 2026-10-20 audit, part 2a — background work that survives a
 * restart (A37, P11), against the real runner, routers and the SQL fake.
 *
 *   a job is worked in slices from its saved place, a dead worker's job is
 *   picked up again, a canceled one stops, and only registered kinds are
 *   claimed · a job's model calls skip the clicking user's per-minute ceiling
 *   but not the workspace budget · bulk "Generate sequences" becomes one job,
 *   and a second click gets it back · "Recompute all" lead scores is one job
 *   per workspace, asked first, shown while it runs.
 *
 * Time is frozen at T0 — Wednesday 2026-11-18, 15:00 UTC — except where a
 * test needs the clock to move.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "c".repeat(64);
  return { db: null as any, calls: 0, audits: [] as any[] };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages: any;
    constructor() {
      this.messages = {
        create: async () => {
          h.calls++;
          return {
            id: "m", model: "claude-haiku-4-5-20251001", stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify({ fit_score: 0.5, pain_points: [], recommended_products: [], objection_risks: [] }) }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      };
    }
  },
}));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async (x: unknown) => { h.audits.push(x); } }));
vi.mock("./_core/env", async (a) => {
  const actual = await a<typeof import("./_core/env")>();
  return { ...actual, ENV: { ...actual.ENV, anthropicApiKey: "env-anthropic", aiDefaultProvider: "anthropic" } };
});
// Scoring's side effects are not this file's subject.
vi.mock("./services/policyNotify", async (a) => ({ ...(await a<typeof import("./services/policyNotify")>()), notifyIfEnabled: async () => {} }));
vi.mock("./sequenceEngine", async (a) => ({ ...(await a<typeof import("./sequenceEngine")>()), autoEnrollByTriggers: async () => {} }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invokeLLM, __resetLlmBurstForTests } from "./_core/llm";
import { runWithRequestContext } from "./_core/requestContext";
import {
  JOB_STALE_MS, cancelJob, enqueueJob, getJob, registerJobKind, tickJobs, __resetJobRunnerForTests,
} from "./services/jobs/runner";
import { runBulkAction } from "./routers/are/prospectsBulk";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const LSI = 2;
const ADMIN = 20;
const REP = 21;
const T0 = new Date("2026-11-18T15:00:00Z").getTime();

const rows = (t: string) => h.db.rowsOf(t) as any[];

function seed() {
  rows("workspaces").push({ id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  const user = (id: number, mail: string) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: mail, loginMethod: "password", role: "user",
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN, "admin@lsi.example"), user(REP, "rep@lsi.example"));
  const member = (id: number, userId: number, role: string) => ({
    id, workspaceId: LSI, userId, role, title: null, quota: null, deactivatedAt: null, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(member(1, ADMIN, "admin"), member(2, REP, "rep"));
  rows("workspace_settings").push({ workspaceId: LSI, llmMonthlyTokenCap: null });
}

function caller(userId: number) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(LSI) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

/** A test job kind: works items 0..n-1, `perSlice` at a time. */
const worked: number[] = [];
registerJobKind<{ n: number; perSlice: number; failAt?: number }>("test.count", {
  async step(job, p) {
    let i = job.resumeFrom;
    let done = 0;
    const failures: Array<{ id: number; error: string }> = [];
    const stop = Math.min(p.n, i + p.perSlice);
    for (; i < stop; i++) {
      worked.push(i);
      if (i === p.failAt) failures.push({ id: i, error: "boom" });
      else done++;
    }
    return { cursor: i, done, failures, finished: i >= p.n, message: `${i} of ${p.n}` };
  },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  h.db = makeSqlFakeDb({ realMembers: true });
  h.calls = 0;
  h.audits = [];
  worked.length = 0;
  __resetLlmBurstForTests();
  __resetJobRunnerForTests();
  seed();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ── The runner ─────────────────────────────────────────────────────────── */

describe("a persisted job is worked in slices from its saved place", () => {
  it("each tick runs slices until the job is done; counts, failures and the cursor are saved", async () => {
    const { job } = await enqueueJob({ workspaceId: LSI, userId: ADMIN, kind: "test.count", payload: { n: 5, perSlice: 2, failAt: 3 }, total: 5 });
    await tickJobs();
    const row = rows("bulk_jobs").find((r) => r.id === job.id);
    expect(worked).toEqual([0, 1, 2, 3, 4]);
    expect(row).toEqual(expect.objectContaining({ status: "done", resumeFrom: 5, done: 4, failed: 1, message: "5 of 5" }));
    expect(row.failures).toEqual([{ id: 3, error: "boom" }]);
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it("a job whose worker died is picked up again from where it saved", async () => {
    const { job } = await enqueueJob({ workspaceId: LSI, userId: ADMIN, kind: "test.count", payload: { n: 4, perSlice: 4 }, total: 4 });
    // A worker took it, saved after item 2, and died (heartbeat goes stale).
    Object.assign(rows("bulk_jobs").find((r) => r.id === job.id), { status: "running", resumeFrom: 2, done: 2, heartbeatAt: new Date(T0 - JOB_STALE_MS - 1000) });
    await tickJobs();
    expect(worked).toEqual([2, 3]);
    expect(rows("bulk_jobs")[0]).toEqual(expect.objectContaining({ status: "done", done: 4 }));
  });

  it("a live worker's job is left alone, and a canceled one is not resumed", async () => {
    const a = await enqueueJob({ workspaceId: LSI, userId: ADMIN, kind: "test.count", payload: { n: 3, perSlice: 3 }, total: 3 });
    Object.assign(rows("bulk_jobs").find((r) => r.id === a.job.id), { status: "running", heartbeatAt: new Date(T0 - 1000) });
    const b = await enqueueJob({ workspaceId: LSI, userId: ADMIN, kind: "test.count", payload: { n: 3, perSlice: 3 }, total: 3 });
    expect(await cancelJob(LSI, b.job.id)).toBe(true);
    await tickJobs();
    expect(worked).toEqual([]);
    expect((await getJob(LSI, b.job.id))?.status).toBe("canceled");
  });

  it("only kinds this process registered are claimed", async () => {
    rows("bulk_jobs").push({ id: 50, workspaceId: LSI, userId: ADMIN, kind: "not.registered", status: "queued", total: 1, done: 0, failed: 0, resumeFrom: 0, payload: {}, failures: null });
    await tickJobs();
    expect(rows("bulk_jobs").find((r) => r.id === 50).status).toBe("queued");
  });

  it("one at a time when asked: the second request gets the running job back", async () => {
    const first = await enqueueJob({ workspaceId: LSI, userId: ADMIN, kind: "test.count", payload: { n: 1, perSlice: 1 }, total: 1, oneAtATime: true });
    const second = await enqueueJob({ workspaceId: LSI, userId: ADMIN, kind: "test.count", payload: { n: 1, perSlice: 1 }, total: 1, oneAtATime: true });
    expect(second).toEqual({ job: expect.objectContaining({ id: first.job.id }), existing: true });
    expect(rows("bulk_jobs")).toHaveLength(1);
  });
});

describe("a job's model calls are paced by the job, not refused by the clicking user's ceiling (A37)", () => {
  const say = () => invokeLLM({ workspaceId: LSI, messages: [{ role: "user", content: "hi" }] });

  it("interactive: the 31st call in a minute is refused", async () => {
    await expect(runWithRequestContext({ workspaceId: LSI, userId: REP }, async () => { for (let i = 0; i < 31; i++) await say(); })).rejects.toThrow(/LLM rate limit/);
  });

  it("background work started by the same person is not", async () => {
    await runWithRequestContext({ workspaceId: LSI, userId: REP, background: true }, async () => { for (let i = 0; i < 40; i++) await say(); });
    expect(h.calls).toBe(40);
  });

  it("the workspace's monthly budget still applies to it", async () => {
    const WS = 93; // its own workspace: the budget check caches per workspace
    rows("workspace_settings").push({ workspaceId: WS, llmMonthlyTokenCap: 10 });
    rows("usage_counters").push({ id: 1, workspaceId: WS, month: "2026-11", llmTokens: 10, emailsSent: 0 });
    await expect(runWithRequestContext({ workspaceId: WS, background: true }, () => invokeLLM({ workspaceId: WS, messages: [{ role: "user", content: "hi" }] }))).rejects.toThrow(/monthly AI budget/);
  });

  it("the runner marks its slices as background work", () => {
    expect(read("server/services/jobs/runner.ts")).toMatch(/runWithRequestContext\(\{ feature: `job \$\{job\.kind\}`, background: true \}/);
  });
});

/* ── A37: bulk AI actions on a campaign ─────────────────────────────────── */

describe("bulk Generate sequences becomes one persisted job (A37)", () => {
  const queueRow = (id: number) => rows("prospect_queue").push({ id, workspaceId: LSI, campaignId: 7, firstName: `P${id}`, lastName: "Lee", sequenceStatus: "pending" });

  it("more than a handful of rows is queued as a job, and a second click gets it back", async () => {
    for (let id = 1; id <= 7; id++) queueRow(id);
    const ctx = { workspace: { id: LSI }, user: { id: ADMIN } };
    const r = await runBulkAction(ctx, { campaignId: 7, prospectIds: [1, 2, 3, 4, 5, 6, 7], action: "generateSequence" } as any);
    expect(r).toEqual(expect.objectContaining({ ok: 7, jobId: expect.any(Number) }));
    expect(rows("bulk_jobs")).toEqual([expect.objectContaining({
      kind: "are.bulk", status: "queued", total: 7, userId: ADMIN,
      payload: { campaignId: 7, action: "generateSequence", prospectIds: [1, 2, 3, 4, 5, 6, 7], force: false },
    })]);
    expect(rows("are_engine_logs").some((l) => /running in the background \(job \d+\)/.test(l.message))).toBe(true);

    const again = await runBulkAction(ctx, { campaignId: 7, prospectIds: [2, 3, 4, 5, 6, 7], action: "generateSequence" } as any);
    expect(again).toEqual(expect.objectContaining({ ok: 0, jobId: r.jobId, summary: expect.stringMatching(/already running/) }));
    expect(rows("bulk_jobs")).toHaveLength(1);
  });

  it("the job runs each row as the person who started it, through the row's own procedure", () => {
    const src = read("server/routers/are/prospectsBulk.ts");
    const kind = src.slice(src.indexOf('registerJobKind<BulkJobPayload>("are.bulk"'), src.indexOf("export async function runBulkAction("));
    expect(kind).toContain("appRouter.createCaller((await callerContextFor(job)) as never)");
    expect(kind).toContain("caller.are.prospects.generateSequence({ prospectId: id, campaignId: payload.campaignId, force: payload.force ?? false })");
    expect(kind).toContain("let i = job.resumeFrom;");
    // …and the old promise the request left behind is gone.
    expect(src).not.toMatch(/void \(async \(\) => \{\s*const bg: BulkResult/);
  });
});

/* ── P11: Recompute all ─────────────────────────────────────────────────── */

describe("Recompute all lead scores is a confirmed, one-at-a-time background job (P11)", () => {
  const lead = (id: number) => rows("leads").push({
    id, workspaceId: LSI, firstName: `L${id}`, lastName: "Lee", title: "Director", company: "County", email: `l${id}@county.gov`,
    source: "import", score: 0, ownerUserId: ADMIN, createdAt: new Date(T0 - 86_400_000),
  });

  it("the preview says how many; the job scores every lead, in slices, and is audited at the end", async () => {
    for (let id = 1; id <= 3; id++) lead(id);
    const admin = caller(ADMIN);
    expect(await admin.leadScoring.recomputeAllPreview()).toEqual({ leads: 3, running: null });
    const started = await admin.leadScoring.recomputeAll();
    expect(started).toEqual({ jobId: expect.any(Number), total: 3, existing: false });
    // A second click gets the same job back.
    expect(await admin.leadScoring.recomputeAll()).toEqual(expect.objectContaining({ jobId: started.jobId, existing: true }));
    expect((await admin.leadScoring.recomputeAllPreview()).running).toEqual(expect.objectContaining({ id: started.jobId, status: "queued" }));

    await tickJobs();
    const job = await admin.leadScoring.recomputeJob();
    expect(job).toEqual(expect.objectContaining({ id: started.jobId, status: "done", done: 3, failed: 0, total: 3 }));
    expect(rows("lead_score_history").map((r) => r.leadId).sort()).toEqual([1, 2, 3]);
    expect(h.audits).toEqual([expect.objectContaining({ entityType: "lead_score_config", after: expect.objectContaining({ recomputed: 3, outcome: "done" }) })]);
  });

  it("is for admins, and can be canceled", async () => {
    lead(1);
    expect((await refusal(caller(REP).leadScoring.recomputeAll())).code).toBe("FORBIDDEN");
    const { jobId } = await caller(ADMIN).leadScoring.recomputeAll();
    expect(await caller(ADMIN).leadScoring.cancelRecompute({ jobId })).toEqual({ canceled: true });
    await tickJobs();
    expect(rows("lead_score_history")).toHaveLength(0);
  });

  it("the page asks first, with the count and what it costs, and shows the job", () => {
    const page = read("client/src/pages/usip/LeadScoring.tsx");
    expect(page).toContain("await utils.leadScoring.recomputeAllPreview.fetch()");
    expect(page).toMatch(/confirmAction\(\{\s*title: `Re-score \$\{p\.leads\.toLocaleString\(\)\} leads\?`/);
    expect(page).toContain("one AI call on this workspace's AI budget");
    expect(page).toContain("onClick={askRecompute}");
    expect(page).toContain("cancelRecompute.mutate({ jobId: job.id })");
  });
});

describe("the runner is scheduled", () => {
  it("ticks every 15 seconds from boot", () => {
    const boot = read("server/_core/index.ts");
    expect(boot).toMatch(/m\.tickJobs\(\)[\s\S]{0,200}setInterval\(runBulkJobs, 15_000\)/);
  });
});
