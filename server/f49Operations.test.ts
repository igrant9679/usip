/**
 * Operational visibility (audit 2026-10-20, F49; final pass 2026-11-07):
 * browser errors are reported and kept scrubbed, slow queries are timed and
 * sampled, and an admin page shows each engine's last tick, each queue's depth
 * and failures, both of those, from what the engines already record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, user: null as any }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./_core/sdk", async (a) => {
  const real = await a<typeof import("./_core/sdk")>();
  return { ...real, sdk: { ...real.sdk, authenticateRequest: async () => { if (!h.user) throw new Error("no session"); return h.user; } } };
});

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { guardOverlap, engineRunStatuses } from "./_core/cronGuard";
import { instrumentPool, noteQuery, querySignature, resetSlowQueryStats, slowQueryStats, slowQuerySampleRate, slowQueryThresholdMs } from "./_core/slowQuery";
import { allowForUser, cleanPath, cleanReport, handleClientError, pruneOldClientErrors, resetClientErrorLimits, scrubClientText } from "./clientErrors";
import { clientErrorPayload } from "../client/src/lib/clientErrors";
import { ago, engineHealth } from "../client/src/pages/usip/EngineStatus";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const WS = 2;
const OTHER = 9;

function seed() {
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null }, { id: OTHER, name: "Other", slug: "other", ownerUserId: 9, archivedAt: null });
  rows("users").push(
    { id: 1, openId: "o1", name: "Owner", email: "owner@lsi.example", role: "user", sessionVersion: 0, mfaTotpEnabledAt: null },
    { id: 2, openId: "o2", name: "Admin", email: "admin@lsi.example", role: "user", sessionVersion: 0, mfaTotpEnabledAt: null },
    { id: 3, openId: "o3", name: "Rep", email: "rep@lsi.example", role: "user", sessionVersion: 0, mfaTotpEnabledAt: null },
    { id: 9, openId: "o9", name: "Stranger", email: "s@other.example", role: "user", sessionVersion: 0, mfaTotpEnabledAt: null },
  );
  rows("workspace_members").push(
    { id: 1, workspaceId: WS, userId: 1, role: "super_admin", deactivatedAt: null, inviteToken: null },
    { id: 2, workspaceId: WS, userId: 2, role: "admin", deactivatedAt: null, inviteToken: null },
    { id: 3, workspaceId: WS, userId: 3, role: "rep", deactivatedAt: null, inviteToken: null },
    { id: 9, workspaceId: OTHER, userId: 9, role: "super_admin", deactivatedAt: null, inviteToken: null },
  );
}

function caller(userId: number) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {}, cookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => { seed(); h.user = null; resetClientErrorLimits(); resetSlowQueryStats(); });

/* ─── slow queries ───────────────────────────────────────────────────────── */

describe("slow queries are timed and sampled", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("the threshold and the sample rate come from the environment, with defaults", () => {
    expect(slowQueryThresholdMs({} as any)).toBe(500);
    expect(slowQueryThresholdMs({ SLOW_QUERY_MS: "250" } as any)).toBe(250);
    expect(slowQueryThresholdMs({ SLOW_QUERY_MS: "nonsense" } as any)).toBe(500);
    expect(slowQuerySampleRate({} as any)).toBe(0.2);
    expect(slowQuerySampleRate({ SLOW_QUERY_SAMPLE: "1" } as any)).toBe(1);
    expect(slowQuerySampleRate({ SLOW_QUERY_SAMPLE: "7" } as any)).toBe(1);
    expect(slowQuerySampleRate({ SLOW_QUERY_SAMPLE: "0" } as any)).toBe(0);
  });

  it("a fast query is not counted; a slow one is counted, and kept only when sampled", () => {
    const env = { SLOW_QUERY_MS: "500", SLOW_QUERY_SAMPLE: "0.2" } as any;
    expect(noteQuery("select 1", 499, () => 0, env)).toBe(false);
    expect(noteQuery("select 2", 800, () => 0.5, env)).toBe(false); // counted, not sampled
    expect(noteQuery("select 3", 900, () => 0.1, env)).toBe(true);
    const s = slowQueryStats();
    expect(s.slow).toBe(2);
    expect(s.slowestMs).toBe(900);
    expect(s.samples.map((x) => x.sql)).toEqual(["select 3"]);
  });

  it("a statement keeps its shape, never its values", () => {
    expect(querySignature("select * from `prospects` where `email` = 'jane@acme.example' and `phone` = \"555 0100\" and `id` = 123456"))
      .toBe("select * from `prospects` where `email` = '?' and `phone` = \"?\" and `id` = ?");
    expect(querySignature("select\n  `a`\n from `t` where `workspaceId` = ?")).toBe("select `a` from `t` where `workspaceId` = ?");
  });

  it("the pool's query and execute are timed through their callbacks, once", () => {
    vi.stubEnv("SLOW_QUERY_MS", "100");
    vi.stubEnv("SLOW_QUERY_SAMPLE", "1");
    let clock = 0;
    const calls: unknown[][] = [];
    const pool: any = {
      query: (...args: any[]) => { calls.push(args); clock += 150; args[args.length - 1](null, [{ ok: 1 }]); return "q"; },
      execute: (...args: any[]) => { calls.push(args); clock += 20; args[args.length - 1](null, []); return "e"; },
    };
    instrumentPool(pool, () => clock);
    instrumentPool(pool, () => clock); // a second call must not wrap twice
    let got: unknown;
    expect(pool.query("select `x` from `t` where `name` = 'Ann'", [], (_e: unknown, r: unknown) => { got = r; })).toBe("q");
    expect(got).toEqual([{ ok: 1 }]);
    pool.execute({ sql: "select 1" }, [], () => {});
    const s = slowQueryStats();
    expect(s.slow).toBe(1);
    expect(s.samples[0]).toMatchObject({ ms: 150, sql: "select `x` from `t` where `name` = '?'" });
    expect(calls).toHaveLength(2);
  });

  it("getDb times the real pool", () => {
    const db = read("server/db.ts");
    expect(db).toContain("instrumentPool((_db as unknown as { $client: Parameters<typeof instrumentPool>[0] }).$client)");
  });
});

/* ─── engine ticks ───────────────────────────────────────────────────────── */

describe("every guarded engine records its ticks and failures", () => {
  it("listed from the moment it is wired, then each run, failure and skipped overlap", async () => {
    const name = `TestEngine${Math.random()}`;
    let fail = false;
    let release: () => void = () => {};
    const runner = guardOverlap(name, () => new Promise<void>((res, rej) => { release = () => (fail ? rej(new Error("provider said 500")) : res()); }));
    const now = () => engineRunStatuses().find((e) => e.name === name)!;
    expect(now()).toMatchObject({ runs: 0, running: false, lastStartedAt: null });
    runner();
    await new Promise((r) => setTimeout(r, 0));
    expect(now().running).toBe(true);
    runner(); // overlaps: skipped
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(now()).toMatchObject({ runs: 1, failures: 0, skipped: 1, running: false, consecutiveFailures: 0 });
    expect(now().lastOkAt).toBeInstanceOf(Date);
    fail = true;
    runner();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(now()).toMatchObject({ runs: 2, failures: 1, consecutiveFailures: 1, lastError: "provider said 500" });
    expect(now().lastDurationMs).not.toBeNull();
  });
});

/* ─── client errors ──────────────────────────────────────────────────────── */

describe("browser errors are kept scrubbed, rate-limited, and for the workspace", () => {
  const res = () => {
    const r: any = { statusCode: 200, body: null, headersSent: false };
    r.status = (c: number) => { r.statusCode = c; return r; };
    r.json = (b: unknown) => { r.body = b; r.headersSent = true; return r; };
    r.end = () => { r.headersSent = true; return r; };
    return r;
  };
  const req = (body: unknown, ws: string | null = String(WS)) => ({ body, headers: ws ? { "x-workspace-id": ws } : {} }) as any;

  it("no email, query string or token survives", () => {
    const out = scrubClientText("Failed for jane.doe@acme.example at https://app.example/p/abc?token=s3cret#x and /leads/7?tab=notes with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.c2ln and 0123456789abcdef0123456789abcdef");
    expect(out).not.toContain("jane.doe@acme.example");
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("tab=notes");
    expect(out).not.toContain("eyJhbGci");
    expect(out).not.toContain("0123456789abcdef0123456789abcdef");
    expect(out).toContain("<email>");
    expect(out).toContain("https://app.example/p/abc");
    expect(out).toContain("/leads/7");
  });

  it("only the known fields are kept: a form value or a cookie in the body goes nowhere", () => {
    const r = cleanReport({ kind: "boundary", message: "x is undefined", stack: "at Foo", path: "/leads/7?email=a@b.co", release: "abc123", formValues: { password: "hunter2" }, cookie: "app_session_id=1" });
    expect(r).toEqual({ kind: "boundary", message: "x is undefined", stack: "at Foo", path: "/leads/7", release: "abc123" });
    expect(cleanReport({ message: "" })).toBeNull();
    expect(cleanReport({ kind: "weird", message: "m" })!.kind).toBe("error");
    expect(cleanPath("https://app.example/x/y?q=1#h")).toBe("/x/y");
    expect(cleanPath("javascript:alert(1)")).toBeNull();
  });

  it("a member's report is stored against their workspace, scrubbed", async () => {
    h.user = rows("users").find((u) => u.id === 3);
    const r = res();
    await handleClientError(req({ kind: "error", message: "Cannot read 'id' for owner@lsi.example", path: "/v2/people?search=ann" }), r);
    expect(r.statusCode).toBe(204);
    const saved = rows("client_errors");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ workspaceId: WS, userId: 3, kind: "error", message: "Cannot read 'id' for <email>", path: "/v2/people" });
  });

  it("anyone else's report is not stored: not signed in, or not a member of the workspace named", async () => {
    await handleClientError(req({ message: "boom" }), res());
    h.user = rows("users").find((u) => u.id === 9);
    await handleClientError(req({ message: "boom" }), res());
    await handleClientError(req({ message: "boom" }, null), res());
    expect(rows("client_errors")).toHaveLength(0);
  });

  it("a person is limited to 20 reports in ten minutes; the route is limited per address", async () => {
    expect(Array.from({ length: 20 }, () => allowForUser(77, 1000)).every(Boolean)).toBe(true);
    expect(allowForUser(77, 2000)).toBe(false);
    expect(allowForUser(77, 1000 + 10 * 60_000 + 1)).toBe(true);
    h.user = rows("users").find((u) => u.id === 3);
    for (let i = 0; i < 20; i++) await handleClientError(req({ message: `m${i}` }), res());
    const r = res();
    await handleClientError(req({ message: "one too many" }), r);
    expect(r.statusCode).toBe(429);
    expect(rows("client_errors")).toHaveLength(20);
    const route = read("server/clientErrors.ts");
    expect(route).toContain('app.post("/api/client-errors", clientErrorIpLimiter,');
    expect(read("server/_core/index.ts")).toContain("registerClientErrorRoute(app);");
  });

  it("rows older than 30 days are pruned, and only those", async () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    rows("client_errors").push(
      { id: 1, workspaceId: WS, userId: 3, kind: "error", message: "old", createdAt: new Date(now - 31 * 86_400_000) },
      { id: 2, workspaceId: WS, userId: 3, kind: "error", message: "recent", createdAt: new Date(now - 29 * 86_400_000) },
    );
    await pruneOldClientErrors(h.db, now);
    expect(rows("client_errors").map((r) => r.message)).toEqual(["recent"]);
  });

  it("the page reports window errors, rejections and boundary catches, without query strings", () => {
    const p = clientErrorPayload("rejection", { message: "fetch failed for ann@x.example", stack: "at https://app.example/assets/a.js?v=1:2:3" }, "/leads/7?tab=x");
    expect(p).toEqual({ kind: "rejection", message: "fetch failed for <email>", stack: "at https://app.example/assets/a.js", path: "/leads/7" });
    expect(read("client/src/main.tsx")).toContain("installClientErrorReporting();");
    const lib = read("client/src/lib/clientErrors.ts");
    expect(lib).toContain('window.addEventListener("error",');
    expect(lib).toContain('window.addEventListener("unhandledrejection",');
    expect(lib).toContain("if (sent.has(key) || sent.size >= MAX_PER_LOAD) return;");
    expect(read("client/src/components/ErrorBoundary.tsx")).toContain('if (!isStaleChunkError(error)) reportClientError("boundary", error);');
  });
});

/* ─── the page ───────────────────────────────────────────────────────────── */

describe("the engine status page", () => {
  beforeEach(() => {
    const now = Date.now();
    const old = new Date(now - 3_600_000);
    rows("email_drafts").push(
      { id: 1, workspaceId: WS, status: "approved", createdAt: old },
      { id: 2, workspaceId: WS, status: "sending", sendClaimedAt: new Date(now - 30 * 60_000), createdAt: old },
      { id: 3, workspaceId: WS, status: "failed", sendClaimedAt: new Date(now - 60_000), createdAt: old },
      { id: 4, workspaceId: OTHER, status: "approved", createdAt: old },
    );
    rows("enrollments").push(
      { id: 1, workspaceId: WS, sequenceId: 1, status: "active", nextActionAt: old },
      { id: 2, workspaceId: WS, sequenceId: 1, status: "active", nextActionAt: new Date(now + 3_600_000) },
      { id: 3, workspaceId: OTHER, sequenceId: 1, status: "active", nextActionAt: old },
    );
    rows("are_execution_queue").push(
      { id: 1, workspaceId: WS, campaignId: 1, prospectQueueId: 1, stepIndex: 0, channel: "email", status: "scheduled", scheduledAt: old },
      { id: 2, workspaceId: WS, campaignId: 1, prospectQueueId: 1, stepIndex: 1, channel: "email", status: "failed", scheduledAt: old, executedAt: new Date(now - 60_000) },
    );
    rows("bulk_jobs").push(
      { id: 1, workspaceId: WS, kind: "x", status: "running", heartbeatAt: new Date(now - 20 * 60_000), createdAt: old },
      { id: 2, workspaceId: OTHER, kind: "x", status: "failed", finishedAt: new Date(now - 60_000), createdAt: old },
    );
    rows("client_errors").push(
      { id: 1, workspaceId: WS, userId: 3, kind: "error", message: "boom", path: "/a", createdAt: new Date(now - 60_000) },
      { id: 2, workspaceId: WS, userId: 3, kind: "error", message: "boom", path: "/a", createdAt: new Date(now - 120_000) },
      { id: 3, workspaceId: OTHER, userId: 9, kind: "error", message: "theirs", path: "/b", createdAt: new Date(now - 60_000) },
      { id: 4, workspaceId: WS, userId: 3, kind: "error", message: "yesterday's", path: "/c", createdAt: new Date(now - 2 * 86_400_000) },
    );
  });

  it("counts this workspace's queues only: waiting, due, stuck, failed today", async () => {
    const s = await caller(2).system.engineStatus();
    const q = Object.fromEntries(s.queues.map((x: any) => [x.key, x]));
    expect(q.email_drafts).toMatchObject({ waiting: 1, stuck: 1, failed24h: 1 });
    expect(q.enrollments).toMatchObject({ waiting: 2, dueNow: 1 });
    expect(q.are_execution_queue).toMatchObject({ waiting: 1, dueNow: 1, failed24h: 1 });
    expect(q.bulk_jobs).toMatchObject({ waiting: 0, stuck: 1, failed24h: 0 });
    expect(q.email_drafts.oldestDueAt).toBeInstanceOf(Date);
  });

  it("groups this workspace's browser errors of the last day", async () => {
    const s = await caller(2).system.engineStatus();
    expect(s.clientErrors.total).toBe(2);
    expect(s.clientErrors.groups).toEqual([expect.objectContaining({ message: "boom", count: 2, path: "/a" })]);
  });

  it("an admin sees engine counts; error text and statements are a super admin's", async () => {
    const name = `FailingEngine${Math.random()}`;
    const run = guardOverlap(name, async () => { throw new Error("secret detail from workspace 4"); });
    run();
    await new Promise((r) => setTimeout(r, 0));
    noteQuery("select 1 from `t`", 10_000, () => 0);
    const asAdmin = await caller(2).system.engineStatus();
    const asSuper = await caller(1).system.engineStatus();
    expect(asAdmin.engines.find((e: any) => e.name === name)).toMatchObject({ failures: 1, lastError: "(shown to super admins)" });
    expect(asSuper.engines.find((e: any) => e.name === name)).toMatchObject({ lastError: "secret detail from workspace 4" });
    expect(asAdmin.slowQueries.slow).toBe(1);
    expect(asAdmin.slowQueries.samples).toEqual([]);
    expect(asSuper.slowQueries.samples).toHaveLength(1);
  });

  it("a rep cannot open it", async () => {
    await expect(caller(3).system.engineStatus()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("it is a lazy route, listed for admins in the one registry, with an error branch", () => {
    const app = read("client/src/App.tsx");
    expect(app).toContain('const EngineStatus = lazyChunk(() => import("@/pages/usip/EngineStatus"));');
    expect(app).toContain('<Route path="/engine-status"><AuthGate><EngineStatus /></AuthGate></Route>');
    expect(read("client/src/lib/toolRegistry.ts")).toMatch(/\{ href: "\/engine-status", label: "Engine Status", icon: Activity, group: "Configuration", adminOnly: true,/);
    const page = read("client/src/pages/usip/EngineStatus.tsx");
    expect(page).toContain("trpc.system.engineStatus.useQuery(");
    expect(page).toContain('{q.error && !data ? (\n          <QueryError what="engine status"');
  });

  it("says when an engine last ran in words, and which need a look", () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    expect(ago(null, now)).toBe("never");
    expect(ago(new Date(now - 30_000), now)).toBe("just now");
    expect(ago(new Date(now - 5 * 60_000), now)).toBe("5 min ago");
    expect(ago(new Date(now - 3 * 3_600_000), now)).toBe("3 h ago");
    expect(engineHealth({ running: false, consecutiveFailures: 2, runs: 5 })).toBe("failing");
    expect(engineHealth({ running: true, consecutiveFailures: 0, runs: 5 })).toBe("running");
    expect(engineHealth({ running: false, consecutiveFailures: 0, runs: 0 })).toBe("idle");
  });
});

describe("migration 0320 adds the table, and nothing else changes", () => {
  it("is additive", () => {
    const m = read("server/_core/rawMigrations.ts");
    const block = m.slice(m.indexOf('name: "0320_client_errors.sql"'), m.indexOf("],", m.indexOf('name: "0320_client_errors.sql"')));
    expect(block).toContain("CREATE TABLE IF NOT EXISTS `client_errors`");
    expect(block).not.toMatch(/ALTER|DROP|UPDATE|DELETE/);
    expect(read("drizzle/schema.ts")).toContain('export const clientErrors = mysqlTable(\n  "client_errors",');
  });
});
