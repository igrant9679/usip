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
