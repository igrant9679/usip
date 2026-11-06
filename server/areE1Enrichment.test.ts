/**
 * Enrichment in the Revenue Engine (audit 2026-10-20, batch E1).
 *
 *   A35 a double click, or a manual enrich overlapping the engine's pass, runs
 *       one enrichment: the row is claimed with a conditional UPDATE
 *   A67 an ICP score that comes back empty is a retryable failure, never a
 *       stored 0 that Full Auto would then reject
 *   A27 a failed enrichment is retried, then rejected with its reason, instead
 *       of holding a queue slot for ever
 *   A7  the global pass shares its five slots between workspaces, leaves
 *       archived workspaces out in SQL, and lets a failing row wait
 *
 * Against the SQL-evaluating fake, with the AI provider mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return {
    db: null as any,
    llm: [] as string[],
    score: { content: "" as string, fail: null as null | Error },
    hold: null as null | Promise<void>,
    enriched: [] as number[],
  };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./routers/are/notify", async (a) => ({ ...(await a<typeof import("./routers/are/notify")>()), areNotify: async () => {} }));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async (p: any) => {
    const name = p?.response_format?.json_schema?.name ?? "?";
    h.llm.push(name);
    if (h.hold) await h.hold;
    if (name === "icp_match_score") {
      if (h.score.fail) throw h.score.fail;
      return { choices: [{ message: { content: h.score.content } }] };
    }
    if (name === "prospect_enrichment") {
      return { choices: [{ message: { content: JSON.stringify({
        triggerEvents: [], painSignals: [], personalisationHooks: [], techStack: [], recentNews: [], industryEvents: [],
        linkedinSummary: "s", companyOneLiner: "c", inferredCompanyName: "", recommendedChannel: "email",
        recommendedTiming: { dayOfWeek: "Tue", hourOfDay: 10, timezone: "UTC" }, enrichmentConfidence: 70,
      }) } }] };
    }
    return { choices: [{ message: { content: "{}" } }] };
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { ENRICH_STALE_MS, runEnrichAgent } from "./routers/are/prospects";
import { rejectExhaustedEnrichment, roundRobinByWorkspace } from "./areEngine";
import { ENRICH_MAX_ATTEMPTS, retryBackoffMs } from "./services/are/retryBackoff";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const pq = (id: number) => rows("prospect_queue").find((r) => r.id === id);
const SCORE = JSON.stringify({ industry: 15, title: 15, companySize: 15, geography: 15, antiPatternPenalty: 0, total: 64 });

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.llm = [];
  h.score = { content: SCORE, fail: null };
  h.hold = null;
  rows("icp_profiles").push({ id: 1, workspaceId: WS, isActive: true, targetTitles: ["Clerk"], targetIndustries: [], targetGeographies: [], antiPatterns: [] });
  rows("are_campaigns").push({ id: 7, workspaceId: WS, name: "Counties", status: "active", icpOverrides: {}, researchSectorId: null });
  rows("prospect_queue").push({
    id: 1, workspaceId: WS, campaignId: 7, firstName: "Pat", lastName: "Lee", email: "pat@acme.example", title: "Clerk",
    companyName: "Acme", companyDomain: "acme.example", sourceType: "apollo", icpMatchScore: 40,
    enrichmentStatus: "pending", sequenceStatus: "pending", enrichAttempts: 0, enrichRetryAt: null, updatedAt: new Date(),
  });
});

describe("one enrichment per prospect at a time (A35)", () => {
  it("a double click runs it once", async () => {
    let open!: () => void;
    h.hold = new Promise<void>((r) => { open = r; });
    const a = runEnrichAgent(1, WS);
    const b = runEnrichAgent(1, WS);
    await new Promise((r) => setTimeout(r, 5));
    open();
    expect((await Promise.all([a, b])).sort()).toEqual([false, true]);
    expect(h.llm.filter((n) => n === "prospect_enrichment")).toHaveLength(1);
    expect(rows("prospect_intelligence")).toHaveLength(1);
    expect(pq(1).enrichmentStatus).toBe("complete");
  });

  it("a row another run is enriching is left to it", async () => {
    Object.assign(pq(1), { enrichmentStatus: "enriching", updatedAt: new Date(Date.now() - 60_000) });
    expect(await runEnrichAgent(1, WS)).toBe(false);
    expect(h.llm).toEqual([]);
  });

  it("a claim older than a run can last belongs to a run that died, and is taken", async () => {
    Object.assign(pq(1), { enrichmentStatus: "enriching", updatedAt: new Date(Date.now() - ENRICH_STALE_MS - 60_000) });
    expect(await runEnrichAgent(1, WS)).toBe(true);
    expect(pq(1).enrichmentStatus).toBe("complete");
  });

  it("another workspace's prospect is not claimed", async () => {
    expect(await runEnrichAgent(1, 4)).toBe(false);
    expect(pq(1).enrichmentStatus).toBe("pending");
  });
});

describe("an empty ICP score (A67)", () => {
  it("is not stored as 0: the row goes back to wait and retry, its score untouched", async () => {
    h.score.content = "";
    await expect(runEnrichAgent(1, WS)).rejects.toThrow(/no ICP score/i);
    expect(pq(1).icpMatchScore).toBe(40);
    expect(pq(1).enrichmentStatus).toBe("pending");
    expect(pq(1).enrichmentError).toMatch(/no ICP score/i);
    expect(pq(1).enrichAttempts).toBe(1);
    expect(new Date(pq(1).enrichRetryAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("a score that is not a number is the same", async () => {
    h.score.content = JSON.stringify({ industry: 1, title: 1, companySize: 1, geography: 1, antiPatternPenalty: 0, total: "high" });
    await expect(runEnrichAgent(1, WS)).rejects.toThrow(/no ICP score/i);
    expect(pq(1).icpMatchScore).toBe(40);
  });
});

describe("a failed enrichment (A27)", () => {
  it("counts the attempt and waits longer each time", async () => {
    h.score.fail = new Error("Unexpected token < in JSON");
    await expect(runEnrichAgent(1, WS)).rejects.toThrow();
    expect(pq(1)).toMatchObject({ enrichmentStatus: "failed", enrichAttempts: 1 });
    const first = new Date(pq(1).enrichRetryAt).getTime() - Date.now();
    expect(first).toBeGreaterThan(retryBackoffMs(1) - 5_000);
    pq(1).enrichRetryAt = null;
    await expect(runEnrichAgent(1, WS)).rejects.toThrow();
    expect(pq(1).enrichAttempts).toBe(2);
    expect(new Date(pq(1).enrichRetryAt).getTime() - Date.now()).toBeGreaterThan(first);
  });

  it("a success clears the count", async () => {
    Object.assign(pq(1), { enrichmentStatus: "failed", enrichAttempts: 2, enrichRetryAt: new Date(Date.now() - 1000) });
    expect(await runEnrichAgent(1, WS)).toBe(true);
    expect(pq(1)).toMatchObject({ enrichmentStatus: "complete", enrichAttempts: 0, enrichRetryAt: null });
  });

  it("after the last attempt the prospect is rejected with the reason, and frees its slot", async () => {
    Object.assign(pq(1), { enrichmentStatus: "failed", enrichAttempts: ENRICH_MAX_ATTEMPTS, enrichmentError: "The AI provider refused the request" });
    rows("prospect_queue").push(
      { id: 2, workspaceId: WS, campaignId: 7, enrichmentStatus: "failed", sequenceStatus: "pending", enrichAttempts: ENRICH_MAX_ATTEMPTS - 1, enrichmentError: "x" },
      { id: 3, workspaceId: WS, campaignId: 7, enrichmentStatus: "failed", sequenceStatus: "approved", enrichAttempts: ENRICH_MAX_ATTEMPTS, enrichmentError: "x" },
      { id: 4, workspaceId: 4, campaignId: 7, enrichmentStatus: "failed", sequenceStatus: "pending", enrichAttempts: ENRICH_MAX_ATTEMPTS, enrichmentError: "x" },
    );
    expect(await rejectExhaustedEnrichment(h.db, WS, 7)).toBe(1);
    expect(pq(1).sequenceStatus).toBe("skipped");
    expect(pq(1).rejectionReason).toBe(`Enrichment failed ${ENRICH_MAX_ATTEMPTS} times: The AI provider refused the request`);
    // One more try left; a person approved it; another workspace's.
    expect([2, 3, 4].map((id) => pq(id).sequenceStatus)).toEqual(["pending", "approved", "pending"]);
  });
});

describe("the screen pass's part (A27)", () => {
  // The screen's statements are raw SQL the fake records without running, so
  // their wiring is read: the give-up waits for the retries, and the reject runs.
  const engine = readFileSync(join(__dirname, "areEngine.ts"), "utf8").replace(/\r\n/g, "\n");
  const screen = engine.slice(engine.indexOf("/* ── Phase 1: SCREEN"), engine.indexOf("/* ── Phase 2")).replace(/\\`/g, "`");
  it("the no-email door gives up on a failed row only after its last try", () => {
    expect(screen).toContain("AND `enrichmentStatus` IN ('complete', 'failed')\n        AND (`enrichmentStatus` = 'complete' OR `enrichAttempts` >= ${ENRICH_MAX_ATTEMPTS})`);");
  });
  it("rejects the exhausted ones every tick", () => {
    expect(screen).toContain("const exhausted = await rejectExhaustedEnrichment(db, wsId, campId);");
  });
});

describe("the global enrichment pass (A7)", () => {
  it("shares the slots between workspaces instead of giving one all five", () => {
    const c = (id: number, workspaceId: number) => ({ id, workspaceId, campaignId: workspaceId * 10 });
    const page = [c(1, 2), c(2, 2), c(3, 2), c(4, 2), c(5, 2), c(6, 2), c(7, 4), c(8, 5), c(9, 4)];
    expect(roundRobinByWorkspace(page, 5).map((r) => r.id)).toEqual([1, 7, 8, 2, 9]);
    // Best first within each workspace, and nobody invented when the page is short.
    expect(roundRobinByWorkspace([c(1, 2), c(2, 2)], 5).map((r) => r.id)).toEqual([1, 2]);
  });

  it("asks for archived workspaces' rows to be left out, failed rows under the limit, and resting rows to wait", async () => {
    const { runAreEngine } = await import("./areEngine");
    rows("workspaces").push({ id: WS, name: "LSI", archivedAt: null }, { id: 9, name: "Old", archivedAt: new Date() });
    const dialect = new MySqlDialect();
    const seen: { sql: string; params: unknown[] }[] = [];
    const real = h.db.select;
    h.db.select = (p?: Record<string, unknown>) => {
      const b = real(p);
      const where = b.where;
      b.where = (cond: any) => {
        const q = dialect.sqlToQuery(cond);
        if (q.sql.includes("`prospect_queue`.`enrichmentStatus`") && q.sql.includes("`are_campaigns`.`status`")) seen.push(q);
        return where.call(b, cond);
      };
      return b;
    };
    await runAreEngine();
    expect(seen).toHaveLength(1);
    const { sql, params } = seen[0]!;
    expect(sql).toContain("`prospect_queue`.`workspaceId` not in (?)");
    expect(params).toContain(9);
    expect(sql).toContain("(`prospect_queue`.`enrichmentStatus` = ? and `prospect_queue`.`enrichAttempts` < ?)");
    expect(params).toContain(ENRICH_MAX_ATTEMPTS);
    expect(sql).toContain("(`prospect_queue`.`enrichRetryAt` is null or `prospect_queue`.`enrichRetryAt` <= ?)");
  });
});
