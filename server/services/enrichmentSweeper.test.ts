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
  reoonVerifySingle: vi.fn(),
  resolveVerifiedEmail: vi.fn(),
  lookupContactInfo: vi.fn(),
  promoteProspectRow: vi.fn(),
  workspaceNotifyUserId: vi.fn(),
  getQuickEnrichKey: vi.fn(),
  quickenrichFindEmailByLinkedIn: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: mocks.getDb }));
// importOriginal keeps reoonStatusToUsip REAL: the QE pass's verdict handling
// depends on that mapping, and a re-implementation here would be a mirror.
vi.mock("./reoon", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReoonKey: mocks.getReoonKey,
  reoonCheckBalance: mocks.reoonCheckBalance,
  reoonVerifySingle: mocks.reoonVerifySingle,
}));
vi.mock("./quickenrich", () => ({
  getQuickEnrichKey: mocks.getQuickEnrichKey,
  quickenrichFindEmailByLinkedIn: mocks.quickenrichFindEmailByLinkedIn,
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
  mocks.resolveVerifiedEmail.mockImplementation(async () => {
    callOrder.push("email");
    return { email: "ada@acme.io", creditsQuick: 1, creditsPower: 1 };
  });
  mocks.lookupContactInfo.mockResolvedValue({});
  mocks.promoteProspectRow.mockResolvedValue({ promoted: false, alreadyLinked: false });
  mocks.workspaceNotifyUserId.mockResolvedValue(7);
  mocks.getReoonKey.mockResolvedValue("");
  mocks.reoonCheckBalance.mockResolvedValue({ remaining_daily_credits: 5000 });
  // QE defaults OFF so every pre-integration test keeps its exact behaviour;
  // QE-specific tests opt in.
  mocks.getQuickEnrichKey.mockResolvedValue("");
  mocks.quickenrichFindEmailByLinkedIn.mockResolvedValue({ email: null, reason: "no_match" });
  mocks.reoonVerifySingle.mockResolvedValue({ status: "safe" });
});

describe("sweepWorkspace pass ordering", () => {
  it("a keyless run does nothing and says so — the free Apollo pre-pass is gone (2026-08-12)", async () => {
    const { db, writes } = makeDb(new Map([[prospectQueue, [queueRow()]]]));
    mocks.getDb.mockResolvedValue(db);

    const r = await sweepWorkspace(1);

    expect(r.stoppedBecause).toBe("no_key");
    expect(r.attempted).toBe(0);
    expect(mocks.reoonCheckBalance).not.toHaveBeenCalled();
    expect(mocks.resolveVerifiedEmail).not.toHaveBeenCalled();
    expect(mocks.lookupContactInfo).not.toHaveBeenCalled();
    // No queue row is touched — the old domain pre-pass wrote here.
    expect(writes.some((w) => w.op === "update" && w.table === prospectQueue)).toBe(false);
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

  it("with a key, works the email pass (no Apollo domain step anywhere in the run)", async () => {
    const { db, writes } = makeDb(new Map([[prospectQueue, [queueRow()]]]));
    mocks.getDb.mockResolvedValue(db);
    mocks.getReoonKey.mockResolvedValue("rk");

    const r = await sweepWorkspace(1);

    expect(callOrder).toEqual(["email"]);
    expect(r.stoppedBecause).toBe("done");
    expect(r.fromQueue).toBe(1);
    expect(r.emailsFound).toBe(1);
    expect(
      writes.some((w) => w.table === prospectQueue && w.payload.email === "ada@acme.io"),
    ).toBe(true);
  });

  it("QuickEnrich pass works the rows every other pass is blind to", async () => {
    /**
     * The fake serves the SAME scripted rows to every prospect_queue query
     * (it cannot read WHERE clauses — stated in the header), so this row is
     * seen by the QE pass AND the pattern pass. The QE counters are asserted
     * specifically, which is unaffected by that overlap.
     */
    const { db, writes } = makeDb(new Map([[prospectQueue, [queueRow()]]]));
    mocks.getDb.mockResolvedValue(db);
    mocks.getReoonKey.mockResolvedValue("rk");
    mocks.getQuickEnrichKey.mockResolvedValue("qk");
    mocks.quickenrichFindEmailByLinkedIn.mockResolvedValue({ email: "ada@acme.io", reason: "found" });

    // The pattern pass finds nothing this test — so emailsFound below can ONLY
    // come from the QE pass. A mutation dropping QE finds from the shared total
    // survived while the pattern mock was also returning an address.
    mocks.resolveVerifiedEmail.mockResolvedValue({ email: null, reason: "no_valid_pattern", creditsQuick: 0, creditsPower: 0 });

    const r = await sweepWorkspace(1);

    expect(r.quickenrichAttempted).toBeGreaterThanOrEqual(1);
    expect(r.quickenrichFound).toBeGreaterThanOrEqual(1);
    expect(r.quickenrichCredits).toBeGreaterThanOrEqual(1);
    expect(r.emailsFound, "QE finds must count in the shared total the card and cron report").toBe(r.quickenrichFound);
    // The hit was Reoon POWER-verified before being written — never their word.
    expect(mocks.reoonVerifySingle).toHaveBeenCalledWith("ada@acme.io", "rk", "power");
    expect(writes.some((w) => w.table === prospectQueue && w.payload.email === "ada@acme.io")).toBe(true);
  });

  it("the QE pass honours the shared cap, at the boundary", async () => {
    // Boundary, not slack: cap 1 with 2 candidates. The fake serves both rows
    // to the QE pass; a compliant loop attempts exactly one and stops the run.
    const { db } = makeDb(new Map([[prospectQueue, [queueRow(), { ...queueRow(), id: 12 }]]]));
    mocks.getDb.mockResolvedValue(db);
    mocks.getReoonKey.mockResolvedValue("rk");
    mocks.getQuickEnrichKey.mockResolvedValue("qk");
    mocks.quickenrichFindEmailByLinkedIn.mockResolvedValue({ email: "ada@acme.io", reason: "found" });

    const r = await sweepWorkspace(1, { limit: 1 });

    expect(r.quickenrichAttempted).toBe(1);
    expect(r.attempted).toBe(1);
    expect(r.stoppedBecause).toBe("cap");
  });

  it("an invalid Reoon verdict means the QuickEnrich address is NOT written", async () => {
    // A wrong database entry looks exactly like a right one — unlike a pattern
    // guess there is no shape to distrust, so the verifier's no is final.
    const { db, writes } = makeDb(new Map([[prospectQueue, [queueRow()]]]));
    mocks.getDb.mockResolvedValue(db);
    mocks.getReoonKey.mockResolvedValue("rk");
    mocks.getQuickEnrichKey.mockResolvedValue("qk");
    mocks.quickenrichFindEmailByLinkedIn.mockResolvedValue({ email: "bad@acme.io", reason: "found" });
    mocks.reoonVerifySingle.mockResolvedValue({ status: "invalid" });
    // Keep the pattern pass out of the email column for this assertion.
    mocks.resolveVerifiedEmail.mockResolvedValue({ email: null, reason: "no_valid_pattern", creditsQuick: 0, creditsPower: 0 });

    const r = await sweepWorkspace(1);

    expect(r.quickenrichFound).toBe(0);
    expect(r.quickenrichCredits).toBe(1); // their billing charged on delivery regardless
    expect(writes.some((w) => w.table === prospectQueue && w.payload.email === "bad@acme.io")).toBe(false);
    expect(writes.some((w) =>
      w.table === prospectQueue && String(w.payload.enrichmentError ?? "").includes("failed Reoon verification"),
    )).toBe(true);
  });

  it("no QuickEnrich key → the pass does not run and nothing else changes", async () => {
    const { db } = makeDb(new Map([[prospectQueue, [queueRow()]]]));
    mocks.getDb.mockResolvedValue(db);
    mocks.getReoonKey.mockResolvedValue("rk");

    const r = await sweepWorkspace(1);

    expect(mocks.quickenrichFindEmailByLinkedIn).not.toHaveBeenCalled();
    expect(r.quickenrichAttempted).toBe(0);
    expect(r.stoppedBecause).toBe("done");
  });

});

describe("the manual sweep UI matches what the engine actually does", () => {
  /**
   * A UI gate is a claim about the engine, and this suite is where the
   * engine's behaviour is pinned, so the claims are checked here too. The
   * claims FLIPPED on 2026-08-12: 64f8ba3 had un-gated the button because a
   * keyless run still did the free Apollo domain pass — that pass is gone
   * (owner removed Apollo from the waterfall), a keyless sweep now does
   * nothing, so the key-gate is honest again. Boolean asserts, not toMatch:
   * a failure must not dump the client file into the report (it contains
   * strings guardAudit reads as build breaks).
   */
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const ui = readFileSync(join(__dirname, "../../client/src/pages/usip/WorkflowsV2.tsx"), "utf8");

  it("disables the sweep button without a Reoon key — a keyless run does nothing now", () => {
    const at = ui.indexOf("onClick={() => runSweep.mutate({ limit: 25 })}");
    expect(at, "sweep button not found — re-anchor").toBeGreaterThan(-1);
    const block = ui.slice(Math.max(0, at - 600), at);
    const disabled = /disabled=\{([^}]*)\}/.exec(block)?.[1] ?? "";
    expect(disabled.length > 0, "disabled expression not found — re-anchor").toBe(true);
    expect(disabled.includes("reoonConfigured"), "button lost its key-gate — but the free domain pass it once justified is gone").toBe(true);
  });

  it("the keyless caption asks for the key instead of promising free work", () => {
    expect(ui.includes("resolves domains only, email lookups skipped"), "stale free-pass caption is back").toBe(false);
    expect(ui.includes("add a Reoon key to run the sweep"), "keyless caption missing").toBe(true);
  });

  it("the summariser still reads domainsResolved — persisted results from before the removal carry it", () => {
    expect(ui.includes("domainsResolved"), "historical sweep results would lose their domain counts").toBe(true);
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

  it("a QE-only workspace is not dismissed as no_candidates (structural — the fake cannot isolate it)", () => {
    /**
     * The fake db serves identical rows to every prospect_queue query, so a
     * "QE candidates exist but pattern candidates don't" state cannot be
     * scripted — whenever qeRows is non-empty, queueRows is too, and a mutation
     * dropping qeRows from the exit condition would survive every executed
     * test. Pinned structurally instead, with the limitation named.
     */
    const src = readFileSync(join(__dirname, "enrichmentSweeper.ts"), "utf8");
    expect(
      src.includes("if (rows.length === 0 && queueRows.length === 0 && qeRows.length === 0)"),
      "the no_candidates exit ignores QuickEnrich candidates",
    ).toBe(true);
  });

  it("QE candidates exclude rows WITH a domain (structural — the fake cannot see WHERE)", () => {
    /**
     * The disjointness that prevents double-spend: rows with a domain stay on
     * the cheaper pattern path. The fake returns scripted rows whatever the
     * query says, so this predicate is invisible to every executed test — a
     * mutation deleting it survived. Pinned at the source, inside the QE
     * candidates function's own window.
     */
    const src = readFileSync(join(__dirname, "enrichmentSweeper.ts"), "utf8");
    const at = src.indexOf("async function quickenrichCandidatesFor");
    expect(at, "quickenrichCandidatesFor not found — re-anchor").toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf("async function", at + 10));
    expect(fn.length).toBeGreaterThan(300);
    expect(
      fn.includes('or(isNull(prospectQueue.companyDomain), eq(prospectQueue.companyDomain, ""))'),
      "the no-domain predicate is gone — domained rows will be spent on twice",
    ).toBe(true);
    expect(fn.includes("isNotNull(prospectQueue.linkedinUrl)")).toBe(true);
  });

  it("every LIMITed candidate query enforces enrichability in SQL, not only in JS", () => {
    /**
     * The window-eclipse class, caught live 2026-08-08: isEnrichableCampaign
     * ran only AFTER the SQL `LIMIT`, so the N lowest-id rows could all be
     * demo rows, the JS filter emptied the page, and the sweep said "nothing
     * was waiting" while the unlimited count said "46 reachable" — the same
     * predicate, disagreeing because one was windowed before filtering.
     * Every LIMITed query must carry the SQL half; the JS filter stays as the
     * belt on all of them.
     */
    const src = readFileSync(join(__dirname, "enrichmentSweeper.ts"), "utf8");
    expect(src.includes("function enrichableCampaignSql()"), "the SQL predicate helper is gone").toBe(true);
    for (const fn of ["queueCandidatesFor", "quickenrichCandidatesFor"]) {
      const at = src.indexOf(`async function ${fn}`);
      expect(at, `${fn} not found — re-anchor`).toBeGreaterThan(-1);
      /**
       * Window ends at the NEXT function declaration, not the next `export`:
       * these are private functions, so an export-anchored window swallowed
       * the neighbouring function — and its intact predicate satisfied the
       * assertion while this one's was deleted. The ambiguous-anchor trap,
       * once more, caught by the battery rather than by reading.
       */
      const rest = src.slice(at + 10);
      const next = rest.search(/\r?\n(?:export )?(?:async )?function /);
      const body = next === -1 ? src.slice(at) : src.slice(at, at + 10 + next);
      expect(body.length, `${fn} window is not the one function`).toBeLessThan(3500);
      expect(body.includes("...enrichableCampaignSql()"), `${fn} lost the SQL enrichability predicate — its LIMIT window can be eclipsed by demo rows again`).toBe(true);
      expect(body.includes("isEnrichableCampaign"), `${fn} lost the JS belt filter`).toBe(true);
    }
    // The SQL half must mirror the JS definition's two rules: non-empty name,
    // not a [demo] campaign.
    const helper = src.slice(src.indexOf("function enrichableCampaignSql()"), src.indexOf("function enrichableCampaignSql()") + 400);
    expect(helper.includes('ne(areCampaigns.name, "")')).toBe(true);
    expect(helper.includes('notLike(areCampaigns.name, "[demo]%")')).toBe(true);
  });

  it("the result carries its own diagnosis: key presence and candidate counts", async () => {
    // Added because a "nothing was waiting" verdict was undiagnosable from the
    // persisted record alone. These fields make the NEXT contradiction
    // self-explanatory on the card's Last-sweep data.
    const { db } = makeDb(new Map([[prospectQueue, [queueRow()]]]));
    mocks.getDb.mockResolvedValue(db);
    mocks.getReoonKey.mockResolvedValue("rk");
    mocks.getQuickEnrichKey.mockResolvedValue("qk");
    mocks.quickenrichFindEmailByLinkedIn.mockResolvedValue({ email: "ada@acme.io", reason: "found" });

    const r = await sweepWorkspace(1);

    expect(r.qeKeyPresent).toBe(true);
    expect(r.qeCandidates).toBeGreaterThanOrEqual(1);
    expect(r.patternCandidates).toBeGreaterThanOrEqual(1);

    const { db: db2 } = makeDb(new Map());
    mocks.getDb.mockResolvedValue(db2);
    const empty = await sweepWorkspace(1);
    expect(empty.stoppedBecause).toBe("no_candidates");
    expect(empty.qeKeyPresent).toBe(true);
    expect(empty.qeCandidates).toBe(0);
  });

  it("QE skips only its OWN prior attempts, never another pass's stamp", () => {
    /**
     * 76e5f74's lesson, recurring: ~183 rows carry enrichedAt from
     * sourcing-time PATTERN attempts that failed for lack of a domain — a
     * failure mode that says nothing about a LinkedIn lookup. A bare
     * isNull(enrichedAt) in the QE candidate query reduced the first
     * production run to 1 candidate out of a measured 59, which is how this
     * assertion came to exist. The marker must be pass-specific: the
     * `quickenrich…` error prefix this pass writes itself.
     */
    const src = readFileSync(join(__dirname, "enrichmentSweeper.ts"), "utf8");
    const at = src.indexOf("async function quickenrichCandidatesFor");
    const fn = src.slice(at, src.indexOf("async function", at + 10));
    expect(
      fn.includes('notLike(prospectQueue.enrichmentError, "quickenrich%")'),
      "the pass-specific marker predicate is gone",
    ).toBe(true);
    expect(
      fn.includes("isNull(prospectQueue.enrichedAt)"),
      "bare enrichedAt filter is back — stale pattern-attempt stamps will starve the pass again",
    ).toBe(false);
    // And the misses the predicate keys on must still be written with that
    // prefix, or every miss gets retried forever.
    expect(src.includes("`quickenrich: ${found.reason}`")).toBe(true);
    expect(src.includes('"quickenrich hit failed Reoon verification (invalid)"')).toBe(true);
  });

  it("the card caption and summariser surface the QuickEnrich numbers", () => {
    expect(ui.includes("quickenrichReady"), "caption hides QE-reachable rows — '0 ready to verify' lies again").toBe(true);
    expect(ui.includes("quickenrichFound"), "summariser hides QE finds").toBe(true);
  });

  it("sweepStatus reports quickenrichReady, zeroed without a key", () => {
    const router = readFileSync(join(__dirname, "../routers/prospects.ts"), "utf8");
    expect(
      /quickenrichReady: qeKey \? await countQuickenrichCandidates\(ctx\.workspace\.id\) : 0/.test(router),
      "sweepStatus does not gate quickenrichReady on the key",
    ).toBe(true);
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

  it("stays quiet for a keyless workspace — with the Apollo pre-pass gone there is nothing to report", async () => {
    // Until 2026-08-12 this test asserted the opposite: a keyless run still
    // resolved domains for free and the cron said so. That pass was removed
    // with Apollo; a notification about a run that did nothing would be noise.
    const { db, writes } = makeDb(new Map<unknown, Row[]>([
      [workspaces, [autoWorkspace()]],
      [prospectQueue, [queueRow()]],
    ]));
    mocks.getDb.mockResolvedValue(db);

    const out = await runEnrichmentSweepAllWorkspaces();

    expect(out.swept).toBe(0);
    expect(writes.some((w) => w.op === "insert" && w.table === notifications)).toBe(false);
  });

  it("stays quiet when a keyless run had nothing to resolve", async () => {
    const { db, writes } = makeDb(new Map<unknown, Row[]>([[workspaces, [autoWorkspace()]]]));
    mocks.getDb.mockResolvedValue(db);

    const out = await runEnrichmentSweepAllWorkspaces();

    expect(out.swept).toBe(0);
    expect(writes.some((w) => w.op === "insert" && w.table === notifications)).toBe(false);
  });
});
