/**
 * The sweeper spends real verification credits in a loop, so the rule that
 * stops the loop is the part that has to be right. Just as load-bearing is the
 * ORDER of its passes: the domain pre-pass is free and must run BEFORE the
 * Reoon key check, because the key gates only the paid email pass. That
 * ordering shipped inverted once — a keyless workspace's sweep did nothing at
 * all, including the half that costs nothing — so it is pinned here by
 * EXECUTING the real sweepWorkspace, not by reading its source.
 *
 * The fake db dispatches on the real drizzle table objects (the dangerZone
 * pattern). Known limitation, stated rather than papered over: it does not
 * interpret WHERE clauses — it returns its scripted rows whatever the query
 * says — so these tests pin pass ordering, gating, stamping and write-backs,
 * not row selection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CREDIT_FLOOR,
  shouldContinue,
  sweepWorkspace,
  runEnrichmentSweepAllWorkspaces,
} from "./enrichmentSweeper";
import { notifications, prospectQueue, workspaces, workspaceSettings } from "../../drizzle/schema";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getReoonKey: vi.fn(),
  reoonCheckBalance: vi.fn(),
  apolloResolveDomain: vi.fn(),
  resolveVerifiedEmail: vi.fn(),
  lookupContactInfo: vi.fn(),
  promoteProspectRow: vi.fn(),
  workspaceNotifyUserId: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: mocks.getDb }));
vi.mock("./reoon", () => ({
  getReoonKey: mocks.getReoonKey,
  reoonCheckBalance: mocks.reoonCheckBalance,
}));
// getApolloKey is here only because apolloEnrich (imported for its pure
// campaign predicate) names it at module load.
vi.mock("./apollo", () => ({
  apolloResolveDomain: mocks.apolloResolveDomain,
  getApolloKey: vi.fn(),
}));
vi.mock("./scraper", () => ({
  resolveVerifiedEmail: mocks.resolveVerifiedEmail,
  lookupContactInfo: mocks.lookupContactInfo,
}));
vi.mock("./prospectPromotion", () => ({ promoteProspectRow: mocks.promoteProspectRow }));
vi.mock("../_core/activeMembers", () => ({ workspaceNotifyUserId: mocks.workspaceNotifyUserId }));

describe("shouldContinue", () => {
  const plenty = { attempted: 0, cap: 50, dailyCreditsLeft: 4000 };

  it("runs while under the cap with credits to spare", () => {
    expect(shouldContinue(plenty)).toBe(true);
  });

  it("stops exactly at the cap, not one past it", () => {
    expect(shouldContinue({ ...plenty, attempted: 49 })).toBe(true);
    expect(shouldContinue({ ...plenty, attempted: 50 })).toBe(false);
    expect(shouldContinue({ ...plenty, attempted: 51 })).toBe(false);
  });

  it("leaves a floor of credits for interactive lookups", () => {
    expect(shouldContinue({ ...plenty, dailyCreditsLeft: CREDIT_FLOOR + 1 })).toBe(true);
    expect(shouldContinue({ ...plenty, dailyCreditsLeft: CREDIT_FLOOR })).toBe(false);
    expect(shouldContinue({ ...plenty, dailyCreditsLeft: 0 })).toBe(false);
  });

  it("never runs on a drained or negative balance", () => {
    expect(shouldContinue({ ...plenty, dailyCreditsLeft: -100 })).toBe(false);
  });

  it("honours the cap even with unlimited credits", () => {
    expect(shouldContinue({ attempted: 200, cap: 200, dailyCreditsLeft: 999999 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
interface Write { op: "update" | "insert"; table: unknown; payload: Row }

/** Chainable fake keyed on the table object handed to .from()/.update()/.insert(). */
function makeDb(data: Map<unknown, Row[]>) {
  const writes: Write[] = [];
  const db = {
    select: () => {
      let table: unknown;
      const q: any = {
        from: (t: unknown) => { table = t; return q; },
        innerJoin: () => q,
        leftJoin: () => q,
        where: () => q,
        orderBy: () => q,
        limit: () => q,
        // Resolve at await time, from whatever .from() actually received.
        then: (res: any, rej: any) => Promise.resolve((data.get(table) ?? []).slice()).then(res, rej),
      };
      return q;
    },
    update: (table: unknown) => ({
      set: (payload: Row) => ({
        where: async () => { writes.push({ op: "update", table, payload }); },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (payload: Row) => { writes.push({ op: "insert", table, payload }); },
    }),
  };
  return { db, writes };
}

/** One enrichable queue row; the fake serves it to every prospect_queue query. */
const queueRow = (): Row => ({
  id: 11,
  firstName: "Ada",
  lastName: "Li",
  companyName: "Acme",
  companyDomain: "acme.io",
  linkedinUrl: null,
  enrichedAt: null,
  campaignName: "Renewals",
});

const callOrder: string[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  callOrder.length = 0;
  mocks.apolloResolveDomain.mockImplementation(async () => {
    callOrder.push("domain");
    return { domain: "acme.io" };
  });
  mocks.resolveVerifiedEmail.mockImplementation(async () => {
    callOrder.push("email");
    return { email: "ada@acme.io", creditsQuick: 1, creditsPower: 1 };
  });
  mocks.lookupContactInfo.mockResolvedValue({});
  mocks.promoteProspectRow.mockResolvedValue({ promoted: false, alreadyLinked: false });
  mocks.workspaceNotifyUserId.mockResolvedValue(7);
  mocks.getReoonKey.mockResolvedValue("");
  mocks.reoonCheckBalance.mockResolvedValue({ remaining_daily_credits: 5000 });
});

describe("sweepWorkspace pass ordering", () => {
  it("runs the free domain pass even when there is no Reoon key, and spends nothing", async () => {
    const { db, writes } = makeDb(new Map([[prospectQueue, [queueRow()]]]));
    mocks.getDb.mockResolvedValue(db);

    const r = await sweepWorkspace(1);

    // The whole point of the ordering: the free pass ran…
    expect(mocks.apolloResolveDomain).toHaveBeenCalledWith(1, "Acme");
    expect(r.domainsAttempted).toBe(1);
    expect(r.domainsResolved).toBe(1);
    const domainWrite = writes.find((w) => w.op === "update" && w.table === prospectQueue);
    expect(domainWrite?.payload).toMatchObject({ companyDomain: "acme.io", enrichedAt: null });

    // …and the paid half did not, in any form.
    expect(r.stoppedBecause).toBe("no_key");
    expect(r.attempted).toBe(0);
    expect(mocks.reoonCheckBalance).not.toHaveBeenCalled();
    expect(mocks.resolveVerifiedEmail).not.toHaveBeenCalled();
    expect(mocks.lookupContactInfo).not.toHaveBeenCalled();
  });

  it("stamps lastRunAt on a keyless run, so the cron's 20-hour gate still engages", async () => {
    const { db, writes } = makeDb(new Map([[prospectQueue, [queueRow()]]]));
    mocks.getDb.mockResolvedValue(db);

    await sweepWorkspace(1);

    const stamp = writes.find((w) => w.op === "update" && w.table === workspaceSettings);
    expect(stamp?.payload.enrichmentSweepLastRunAt).toBeInstanceOf(Date);
  });

  it("persists the run's RESULT beside the stamp, on every exit (0147)", async () => {
    /**
     * The result used to live only in the caller's ~4s toast — manual runs
     * send no notification, so a user who blinked had no record of what their
     * own run did. Persisted in the same finally as the stamp so early exits
     * (the keyless run here IS one) are covered identically to full runs.
     */
    const { db, writes } = makeDb(new Map([[prospectQueue, [queueRow()]]]));
    mocks.getDb.mockResolvedValue(db);

    const returned = await sweepWorkspace(1);

    const stamp = writes.find((w) => w.op === "update" && w.table === workspaceSettings);
    const persisted = stamp?.payload.enrichmentSweepLastResult as Record<string, unknown>;
    expect(persisted).toBeTruthy();
    // What the card shows must be what the caller was told — same object.
    expect(persisted).toMatchObject({ ...returned });
    expect(persisted.stoppedBecause).toBe("no_key");
    expect(persisted.domainsResolved).toBe(1);
    expect(Number.isNaN(Date.parse(String(persisted.at))), "at is not a parseable timestamp").toBe(false);
  });

  it("persists the result on a no-candidates exit too", async () => {
    const { db, writes } = makeDb(new Map());
    mocks.getDb.mockResolvedValue(db);
    mocks.getReoonKey.mockResolvedValue("rk");

    await sweepWorkspace(1);

    const stamp = writes.find((w) => w.op === "update" && w.table === workspaceSettings);
    expect((stamp?.payload.enrichmentSweepLastResult as Record<string, unknown>)?.stoppedBecause).toBe("no_candidates");
  });

  it("persists the result of a full run, with its counts", async () => {
    const { db, writes } = makeDb(new Map([[prospectQueue, [queueRow()]]]));
    mocks.getDb.mockResolvedValue(db);
    mocks.getReoonKey.mockResolvedValue("rk");

    await sweepWorkspace(1);

    const stamp = writes.find((w) => w.op === "update" && w.table === workspaceSettings);
    const persisted = stamp?.payload.enrichmentSweepLastResult as Record<string, unknown>;
    expect(persisted?.stoppedBecause).toBe("done");
    expect(persisted?.emailsFound).toBe(1);
  });

  it("stamps lastRunAt on a no-candidates run for the same reason", async () => {
    const { db, writes } = makeDb(new Map());
    mocks.getDb.mockResolvedValue(db);
    mocks.getReoonKey.mockResolvedValue("rk");

    const r = await sweepWorkspace(1);

    expect(r.stoppedBecause).toBe("no_candidates");
    expect(mocks.reoonCheckBalance).not.toHaveBeenCalled();
    const stamp = writes.find((w) => w.op === "update" && w.table === workspaceSettings);
    expect(stamp?.payload.enrichmentSweepLastRunAt).toBeInstanceOf(Date);
  });

  it("with a key, resolves domains first and then works the email pass", async () => {
    const { db, writes } = makeDb(new Map([[prospectQueue, [queueRow()]]]));
    mocks.getDb.mockResolvedValue(db);
    mocks.getReoonKey.mockResolvedValue("rk");

    const r = await sweepWorkspace(1);

    expect(callOrder).toEqual(["domain", "email"]);
    expect(r.stoppedBecause).toBe("done");
    expect(r.domainsResolved).toBe(1);
    expect(r.fromQueue).toBe(1);
    expect(r.emailsFound).toBe(1);
    expect(
      writes.some((w) => w.table === prospectQueue && w.payload.email === "ada@acme.io"),
    ).toBe(true);
  });

  it("resolveDomains:false still short-circuits a keyless run entirely", async () => {
    const { db } = makeDb(new Map([[prospectQueue, [queueRow()]]]));
    mocks.getDb.mockResolvedValue(db);

    const r = await sweepWorkspace(1, { resolveDomains: false });

    expect(mocks.apolloResolveDomain).not.toHaveBeenCalled();
    expect(r.stoppedBecause).toBe("no_key");
    expect(r.domainsAttempted).toBe(0);
    expect(r.attempted).toBe(0);
  });
});

describe("the manual sweep UI matches what the engine actually does", () => {
  /**
   * 64f8ba3 moved the Reoon key check below the free domain pass, but the
   * WorkflowsV2 "Sweep 25" button stayed disabled without a key behind the
   * caption "nothing can be verified" — locking keyless workspaces out of work
   * the server would happily do. A UI gate is a claim about the engine, and
   * this suite is where the engine's behaviour is pinned, so the claim is
   * checked here too. Boolean asserts, not toMatch: a failure must not dump
   * the client file into the report (it contains strings guardAudit reads as
   * build breaks).
   */
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const ui = readFileSync(join(__dirname, "../../client/src/pages/usip/WorkflowsV2.tsx"), "utf8");

  it("does not disable the sweep button on a missing Reoon key", () => {
    const at = ui.indexOf("onClick={() => runSweep.mutate({ limit: 25 })}");
    expect(at, "sweep button not found — re-anchor").toBeGreaterThan(-1);
    const block = ui.slice(Math.max(0, at - 600), at);
    const disabled = /disabled=\{([^}]*)\}/.exec(block)?.[1] ?? "";
    expect(disabled.length > 0, "disabled expression not found — re-anchor").toBe(true);
    expect(disabled.includes("reoonConfigured"), "button is key-gated again — the free domain pass runs without a key").toBe(false);
  });

  it("the keyless caption says what still happens, not that nothing can", () => {
    expect(ui.includes("nothing can be verified"), "the overclaiming caption is back").toBe(false);
    expect(ui.includes("resolves domains only, email lookups skipped"), "keyless caption missing").toBe(true);
  });

  it("the result toast reports resolved domains, so a keyless run never reads as a no-op", () => {
    expect(ui.includes("domainsResolved"), "toast ignores the free pass's output").toBe(true);
  });

  it("the card renders the persisted last result, and shares ONE summariser with the toast", () => {
    /**
     * The whole point of 0147: the numbers survive the toast. And one
     * describeSweepResult feeds both surfaces — a second inline why-mapping is
     * how the toast and the card end up describing the same run differently
     * (the three-vocabularies class, at sentence scale).
     */
    /**
     * The exact conditional, not just the identifier: `{false && (…).lastResult
     * && (` keeps every substring a loose scan looks for while rendering
     * nothing — that mutation survived the first version of this test. A
     * source scan cannot prove a render, so this pins the shape and names the
     * limit; a cleverer neutering (opacity-0, an early return above) would
     * need a rendered-DOM test to catch.
     */
    expect(
      ui.includes("{(sweepAp.data as any).lastResult && ("),
      "the last-result line's conditional is gone or no longer starts the render expression",
    ).toBe(true);
    const calls = ui.split("describeSweepResult(").length - 1;
    expect(calls >= 3, "toast and card no longer share the one summariser (def + 2 calls)").toBe(true);
    const whyMaps = ui.split('stoppedBecause === "no_key"').length - 1;
    expect(whyMaps, "a second stop-reason vocabulary has appeared").toBe(1);
  });

  it("migration 0147 exists and matches the schema column", () => {
    const migrations = readFileSync(join(__dirname, "../_core/rawMigrations.ts"), "utf8");
    const at = migrations.indexOf("0147_sweep_last_result.sql");
    expect(at, "migration 0147 missing — schema-only columns break prod silently").toBeGreaterThan(-1);
    expect(migrations.slice(at, at + 300)).toContain("ADD COLUMN `enrichmentSweepLastResult` json NULL");
    const schema = readFileSync(join(__dirname, "../../drizzle/schema.ts"), "utf8");
    expect(schema).toContain('enrichmentSweepLastResult: json("enrichmentSweepLastResult")');
  });

  it("sweepStatus returns the persisted result to the card", () => {
    const router = readFileSync(join(__dirname, "../routers/prospects.ts"), "utf8");
    const start = router.indexOf("sweepStatus: workspaceProcedure");
    const end = router.indexOf("setSweepSettings", start);
    expect(start, "sweepStatus not found — re-anchor").toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = router.slice(start, end);
    expect(block.includes("lastResult: workspaceSettings.enrichmentSweepLastResult"), "sweepStatus does not select the column").toBe(true);
    expect(/lastResult: \(s\?\.lastResult \?\? null\)/.test(block), "sweepStatus does not return lastResult").toBe(true);
  });
});

describe("runEnrichmentSweepAllWorkspaces", () => {
  const autoWorkspace = (): Row => ({ id: 1, mode: "auto", cap: 100, lastRunAt: null });

  it("notifies a keyless workspace about the domains it did resolve, and says why emails were skipped", async () => {
    const { db, writes } = makeDb(new Map<unknown, Row[]>([
      [workspaces, [autoWorkspace()]],
      [prospectQueue, [queueRow()]],
    ]));
    mocks.getDb.mockResolvedValue(db);

    const out = await runEnrichmentSweepAllWorkspaces();

    expect(out.swept).toBe(1);
    const note = writes.find((w) => w.op === "insert" && w.table === notifications);
    expect(note?.payload.title).toBe("Enrichment Sweep: 1 company domain resolved");
    expect(String(note?.payload.body)).toContain("Reoon");
  });

  it("stays quiet when a keyless run had nothing to resolve", async () => {
    const { db, writes } = makeDb(new Map<unknown, Row[]>([[workspaces, [autoWorkspace()]]]));
    mocks.getDb.mockResolvedValue(db);

    const out = await runEnrichmentSweepAllWorkspaces();

    expect(out.swept).toBe(0);
    expect(writes.some((w) => w.op === "insert" && w.table === notifications)).toBe(false);
  });
});
