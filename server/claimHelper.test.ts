/**
 * Claims, not check-then-write (audit 2026-10-20, X1.5; final pass 2026-11-07).
 *
 * A double click or a retry repeated a side effect wherever a procedure read
 * a row's state, saw it was still open, and then wrote with a WHERE on the id
 * alone. One helper (_core/claim.ts) reads rows changed the way insertIdOf
 * reads ids, and claimRow makes the conditional update the gate. Two guards
 * keep it that way: nothing else reads `.affectedRows`, and a status write
 * after a status check must carry the status in its WHERE or be reviewed here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, race: null as null | ((table: string) => void), stageChanges: 0, applies: 0 }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./services/stageChange", async (a) => ({
  ...(await a<typeof import("./services/stageChange")>()),
  changeOpportunityStage: async () => { h.stageChanges++; return { changed: true }; },
}));
vi.mock("./services/optimization/apply", async (a) => ({
  ...(await a<typeof import("./services/optimization/apply")>()),
  isApplicable: (rec: { kind?: string }) => rec.kind !== "advisory",
  applyRecommendation: async (_ws: number, rec: { id: number }) => {
    h.applies++;
    const row = h.db.rowsOf("optimization_recommendations").find((r: any) => r.id === rec.id);
    Object.assign(row, { status: "applied", appliedAt: new Date() });
    return { ok: true, detail: "applied" };
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { affectedRowsOf, claimRow } from "./_core/claim";
import { pauseOnReply } from "./sequenceEngine";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "latin1");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const WS = 2;

function seed() {
  h.db = makeSqlFakeDb({ realMembers: true, beforeUpdate: (t) => h.race?.(t) });
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null });
  rows("users").push({ id: 1, openId: "o1", name: "Owner", email: "owner@lsi.example", role: "user", sessionVersion: 0, mfaTotpEnabledAt: null });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: 1, role: "super_admin", deactivatedAt: null, inviteToken: null });
}
function caller() {
  return appRouter.createCaller({
    user: rows("users")[0],
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {}, cookie: () => {} },
  } as unknown as TrpcContext);
}
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return (e as { code?: string }).code ?? "ERR"; } };

beforeEach(() => { seed(); h.race = null; h.stageChanges = 0; h.applies = 0; });

describe("the helper", () => {
  it("reads rows changed off the driver's array and off a destructured header", () => {
    expect(affectedRowsOf([{ affectedRows: 1, insertId: 0 }, []])).toBe(1);
    expect(affectedRowsOf({ affectedRows: 3 })).toBe(3);
    expect(affectedRowsOf({ rowsAffected: 2 })).toBe(2);
    expect(affectedRowsOf(undefined)).toBe(0);
    expect(affectedRowsOf([{}])).toBe(0);
    expect(affectedRowsOf({ affectedRows: "nope" })).toBe(0);
  });

  it("a claim is won only when exactly the expected rows changed", async () => {
    expect(await claimRow(Promise.resolve([{ affectedRows: 1 }]))).toBe(true);
    expect(await claimRow(Promise.resolve([{ affectedRows: 0 }]))).toBe(false);
    expect(await claimRow(Promise.resolve([{ affectedRows: 2 }]))).toBe(false);
    expect(await claimRow(Promise.resolve([{ affectedRows: 2 }]), 2)).toBe(true);
  });
});

describe("the sites claim, so the second of two goes nowhere", () => {
  it("a stage-change review applies the stage once, even when another review lands first", async () => {
    rows("stage_approvals").push({ id: 5, workspaceId: WS, opportunityId: 9, requestedByUserId: 1, fromStage: "a", toStage: "b", status: "pending" });
    // Another manager's review commits between our read and our write.
    h.race = (t) => { if (t === "stage_approvals") rows("stage_approvals")[0].status = "rejected"; };
    expect(await code(caller().oppIntelligence.reviewStageChange({ approvalId: 5, approved: true }))).toBe("CONFLICT");
    expect(h.stageChanges).toBe(0);
    expect(rows("stage_approvals")[0].status).toBe("rejected");
    // Control: alone, it is approved and applied.
    h.race = null;
    rows("stage_approvals").push({ id: 6, workspaceId: WS, opportunityId: 9, requestedByUserId: 1, fromStage: "a", toStage: "b", status: "pending" });
    expect(await code(caller().oppIntelligence.reviewStageChange({ approvalId: 6, approved: true }))).toBe("OK");
    expect(h.stageChanges).toBe(1);
  });

  it("a recommendation is applied once when two approvals race, and the loser changes nothing", async () => {
    rows("optimization_recommendations").push({ id: 7, workspaceId: WS, kind: "cap", status: "pending", appliedAt: null, proposedValue: 5 });
    h.race = (t) => { if (t === "optimization_recommendations") rows("optimization_recommendations")[0].appliedAt = new Date(); };
    expect(await code(caller().optimization.approve({ id: 7 }))).toBe("CONFLICT");
    expect(h.applies).toBe(0);
    h.race = null;
    rows("optimization_recommendations")[0].appliedAt = null;
    expect(await code(caller().optimization.approve({ id: 7 }))).toBe("OK");
    expect(h.applies).toBe(1);
    // Approve all over the same id now skips it.
    const r = await caller().optimization.approveAll({ ids: [7] });
    expect(r).toMatchObject({ applied: 0, skipped: 1 });
    expect(h.applies).toBe(1);
  });

  it("a claim left by a crashed apply can be taken again after ten minutes", async () => {
    rows("optimization_recommendations").push({ id: 8, workspaceId: WS, kind: "cap", status: "pending", appliedAt: new Date(Date.now() - 11 * 60_000), proposedValue: 5 });
    expect(await code(caller().optimization.approve({ id: 8 }))).toBe("OK");
    expect(h.applies).toBe(1);
  });

  it("dismiss all leaves an applied recommendation applied, and counts what it changed", async () => {
    rows("optimization_recommendations").push(
      { id: 1, workspaceId: WS, kind: "cap", status: "pending" },
      { id: 2, workspaceId: WS, kind: "cap", status: "applied", appliedAt: new Date() },
    );
    const r = await caller().optimization.dismissAll({ ids: [1, 2] });
    expect(r.dismissed).toBe(1);
    expect(rows("optimization_recommendations").map((x) => x.status)).toEqual(["dismissed", "applied"]);
  });

  it("a dismissal that loses to an apply says so instead of hiding the applied change", async () => {
    rows("optimization_recommendations").push({ id: 3, workspaceId: WS, kind: "cap", status: "pending" });
    h.race = (t) => { if (t === "optimization_recommendations") rows("optimization_recommendations")[0].status = "applied"; };
    expect(await code(caller().optimization.dismiss({ id: 3 }))).toBe("CONFLICT");
    expect(rows("optimization_recommendations")[0].status).toBe("applied");
  });

  it("a quote marked sent twice is recorded once", async () => {
    rows("quotes").push({ id: 4, workspaceId: WS, quoteNumber: "Q-4", status: "draft", expiresAt: null });
    expect(await caller().quotes.send({ id: 4 })).toEqual({ ok: true });
    expect(await caller().quotes.send({ id: 4 })).toEqual({ ok: true, alreadySent: true });
    expect(rows("audit_log").filter((a) => a.entityType === "quote")).toHaveLength(1);
  });

  it("Send now twice inside a minute sends once; a failed send gives the claim back", async () => {
    rows("dashboards").push({ id: 10, workspaceId: WS, ownerUserId: 1, name: "Board" });
    const lastWeek = new Date(Date.now() - 7 * 86_400_000);
    rows("report_schedules").push(
      { id: 11, workspaceId: WS, dashboardId: 10, frequency: "weekly", recipients: ["owner@lsi.example"], enabled: true, lastSentAt: new Date(Date.now() - 10_000) },
      { id: 12, workspaceId: WS, dashboardId: 10, frequency: "weekly", recipients: ["owner@lsi.example"], enabled: true, lastSentAt: lastWeek },
    );
    expect(await code(caller().dashboards.sendScheduleNow({ id: 11 }))).toBe("CONFLICT");
    // No SMTP here, so this send fails after its claim, and hands it back.
    expect(await code(caller().dashboards.sendScheduleNow({ id: 12 }))).toBe("NOT_FOUND");
    expect(new Date(rows("report_schedules")[1].lastSentAt).getTime()).toBe(lastWeek.getTime());
  });

  it("a reply pauses an enrolment and files one review task, even when two replies race", async () => {
    rows("enrollments").push({ id: 20, workspaceId: WS, sequenceId: 1, contactId: 3, status: "active" });
    h.race = (t) => { if (t === "enrollments") rows("enrollments")[0].status = "paused"; };
    await pauseOnReply(20, WS);
    expect(rows("tasks")).toHaveLength(0);
  });

  it("a queued search run is claimed before it searches", () => {
    const src = read("server/services/prospectSources/searchRuns.ts");
    const at = src.indexOf('if (!run || run.status !== "queued") return;');
    const block = src.slice(at, src.indexOf("try {", at));
    expect(block).toContain('eq(prospectSearchRuns.status, "queued"))));');
    expect(block).toContain("if (!won) return;");
  });
});

/* ─── the guards ─────────────────────────────────────────────────────────── */

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) { if (name !== "__fakes__") walk(rel, out); }
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/[^\n"'`]*$/gm, "");
const sources = walk("server").map((f) => [f, stripComments(read(f))] as const);

/**
 * Files left for the merge while other batches had them in flight. ARES and
 * CRMP landed before this batch's final merge (2026-11-07), and their reads
 * were converted then, so the list is empty; it stays for the next time.
 */
const AFFECTED_ROWS_LEFT_FOR_MERGE: string[] = [];

describe("nothing reads rows changed except the helper", () => {
  const readers = sources.filter(([f, s]) => f !== "server/_core/claim.ts" && /\.affectedRows\b|affectedRows\s*\?\?|\{ affectedRows\?/.test(s)).map(([f]) => f);

  it("every affectedRows read goes through affectedRowsOf", () => {
    expect(readers.filter((f) => !AFFECTED_ROWS_LEFT_FOR_MERGE.includes(f))).toEqual([]);
  });

  it("each file left for the merge still needs it (drop it once converted)", () => {
    for (const f of AFFECTED_ROWS_LEFT_FOR_MERGE) expect(readers, f).toContain(f);
  });
});

/**
 * A status written after a status check, with no status in the write's WHERE:
 * the check-then-write shape. Each one here was read on 2026-11-07 and is not a
 * claim. A new one must claim (claimRow and the state in the WHERE) or be
 * added with why it is safe.
 */
const REVIEWED: Record<string, string> = {
  "server/demoSeedExtras.ts::areCampaigns": "the demo seed pausing its own campaign",
  "server/routers/chatAgents.ts::chatSessions": "a chat turn saving the transcript; not a status claim",
  "server/routers/discovery.ts::discoveryRuns": "reprocess marks a failed run complete after its finds saved; the save dedupes by identity",
  "server/services/discovery/index.ts::discoveryRuns": "a run's lifecycle, written by the process that created it or claimed its fan-out (fanOutStartedAt)",
  "server/routers/emailVerification.ts::emailVerificationJobs": "writes the outcome of the job this process just ran",
  "server/routers/operations.ts::quotes": "setStatus: the person sets the status they chose; last write wins by design",
  "server/routers/sequences.ts::sequences": "setStatus: the person sets the status they chose; last write wins by design",
  "server/routers/tours.ts::userTourProgress": "resuming a tour; the same write twice changes nothing",
  "server/services/approvalTasks.ts::tasks": "puts a claimed task back after a failed send: the release half of a claim",
  "server/services/jobs/runner.ts::bulkJobs": "fails a job whose kind has no worker; the runner claimed it first",
  "server/services/linkedinEnrichment/batchService.ts::linkedinEnrichmentBatches": "queues a batch; the queue's own claim (claimBatch) decides who runs it",
  "server/services/linkedinEnrichment/orchestrator.ts::linkedinEnrichmentJobs": "hands a claimed job back to the queue",
  "server/services/scoring/defaults.ts::scoreModels": "archives the old defaults while installing new ones",
  "server/services/voiceRelay.ts::voiceCalls": "records a call's outcome from the relay that owns the call",
};

function checkThenWriteSites(): string[] {
  const out: string[] = [];
  for (const [f, s] of sources) {
    const re = /\.update\((\w+)\)\s*\.set\(\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (!/\bstatus\s*:/.test(m[2])) continue;
      const stmt = s.slice(m.index, s.indexOf(";", m.index));
      const where = stmt.slice(stmt.indexOf(".where("));
      if (new RegExp(`${m[1]}\\.status\\b`).test(where)) continue;
      const before = s.slice(Math.max(0, m.index - 1500), m.index);
      if (!/\.status\s*(!==|===|!=|==)\s*["'`]|\.includes\([^)]*\.status\)/.test(before)) continue;
      out.push(`${f}::${m[1]}`);
    }
  }
  return Array.from(new Set(out));
}

describe("no new check-then-write", () => {
  const found = checkThenWriteSites();

  it("every status write after a status check claims, or is reviewed", () => {
    expect(found.filter((k) => !(k in REVIEWED)), "claim it (claimRow, state in the WHERE) or add it to REVIEWED with why").toEqual([]);
  });

  it("every reviewed site is still there (drop it once it claims)", () => {
    for (const k of Object.keys(REVIEWED)) expect(found, k).toContain(k);
  });

  it("the guard sees the shape it is for", () => {
    const shape = `const [row] = await db.select().from(t); if (row.status !== "pending") throw x; await db.update(widgets).set({ status: "done" }).where(eq(widgets.id, 1));`;
    const claimed = shape.replace("where(eq(widgets.id, 1))", "where(and(eq(widgets.id, 1), eq(widgets.status, \"pending\")))");
    const scan = (src: string) => /\.update\((\w+)\)\s*\.set\(\{([^}]*)\}/.test(src) && !/widgets\.status/.test(src.slice(src.indexOf(".where(")));
    expect(scan(shape)).toBe(true);
    expect(scan(claimed)).toBe(false);
  });
});
