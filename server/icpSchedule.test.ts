/**
 * The ICP Re-inference Schedule was the quietest kind of dead control: a
 * column, a save path, a card that redisplayed what you picked — and a cron
 * that read none of it. "Manual Only" did not stop anything, and a workspace
 * that picked Weekly still paid for an LLM call a day. It sat in
 * areSettingsWiring.test.ts's KNOWN_UNENFORCED list as a tracked fact for
 * months; this file is what let that entry be deleted (2026-09-20).
 *
 * Pinned by EXECUTING runIcpInferenceAllWorkspaces, not by reading its source:
 * a text pin on "areIcpRegenSchedule" is satisfied by a variable nothing
 * branches on, which is exactly the failure being fixed. The assertion that
 * would have caught the original bug is "manual → invokeLLM never called".
 *
 * The fake db dispatches on the real drizzle table objects and the selected
 * field names (the enrichmentSweeper.test.ts pattern). Stated rather than
 * papered over: it does NOT interpret WHERE clauses. It emulates exactly one
 * clause — ORDER BY createdAt DESC on icp_profiles — because that ordering IS
 * the restore fix, and it does so only when the query actually asked to be
 * ordered, so a regression to the old `where(isActive = true).limit(1)` shape
 * reads the stale active row and the last test here fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { icpProfiles, opportunities, workspaces } from "../drizzle/schema";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  invokeLLM: vi.fn(),
  getSegmentPerformance: vi.fn(),
  archivedWorkspaceIds: vi.fn(),
}));

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDb: mocks.getDb,
}));
vi.mock("./_core/llm", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invokeLLM: mocks.invokeLLM,
}));
vi.mock("./services/performanceMetrics", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSegmentPerformance: mocks.getSegmentPerformance,
}));
vi.mock("./_core/workspaceArchive", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  archivedWorkspaceIds: mocks.archivedWorkspaceIds,
}));

type Row = Record<string, any>;

interface Script {
  /** What the workspaces-leftJoin-workspaceSettings query returns. */
  fleet: Row[];
  /** The one aggregate row: total closed deals and total won deals. */
  closed: Row;
  /** icp_profiles rows, written ACTIVE-FIRST — the order the old query used. */
  profiles: Row[];
}

function makeDb(script: Script) {
  const writes: Array<{ op: "update" | "insert"; table: unknown; payload: Row }> = [];
  const db: any = {
    select: (fields?: Record<string, unknown>) => {
      let table: unknown;
      let ordered = false;
      let lim: number | undefined;
      const resolve = (): Row[] => {
        let out: Row[] = [];
        if (table === workspaces) out = script.fleet;
        else if (table === opportunities) out = fields && "n" in fields ? [script.closed] : [];
        else if (table === icpProfiles) {
          // Step 6 of runIcpInference asks for the max version, not freshness.
          if (fields && "version" in fields) out = [{ version: 9 }];
          else {
            out = script.profiles;
            if (ordered) out = out.slice().sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
          }
        }
        return lim === undefined ? out.slice() : out.slice(0, lim);
      };
      const q: any = {
        from: (t: unknown) => { table = t; return q; },
        innerJoin: () => q,
        leftJoin: () => q,
        where: () => q,
        orderBy: () => { ordered = true; return q; },
        limit: (n: number) => { lim = n; return q; },
        then: (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej),
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

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000);

/** One workspace with real evidence and an existing profile of a given age. */
function scriptFor(opts: {
  schedule: string | null;
  profileAgeHours?: number;
  wonCount?: number;
  sampleWonDeals?: number;
}): Script {
  const won = opts.wonCount ?? 4;
  return {
    fleet: [{ id: 1, schedule: opts.schedule }],
    closed: { n: won + 2, won },
    profiles:
      opts.profileAgeHours === undefined
        ? []
        : [{ createdAt: hoursAgo(opts.profileAgeHours), sampleWonDeals: opts.sampleWonDeals ?? won }],
  };
}

async function run(script: Script) {
  const { db, writes } = makeDb(script);
  mocks.getDb.mockResolvedValue(db);
  const { runIcpInferenceAllWorkspaces } = await import("./routers/are/icp");
  const result = await runIcpInferenceAllWorkspaces();
  return { result, writes };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.archivedWorkspaceIds.mockResolvedValue(new Set<number>());
  mocks.getSegmentPerformance.mockResolvedValue([]);
  mocks.invokeLLM.mockResolvedValue({
    choices: [{
      message: {
        content: JSON.stringify({
          targetIndustries: [], targetCompanySizeMin: 10, targetCompanySizeMax: 500,
          targetRevenueMin: 0, targetRevenueMax: 1000, targetTitles: [],
          targetGeographies: [], targetTechStack: [], antiPatterns: [],
          topConversionSignals: [], aiRationale: "ok",
        }),
      },
    }],
  });
});

describe("the ICP cron honours the workspace's re-inference schedule", () => {
  it('"manual" spends nothing at all — the Off position the card always promised', async () => {
    const { result, writes } = await run(scriptFor({ schedule: "manual", profileAgeHours: 72 }));
    expect(result.regenerated).toBe(0);
    expect(result.skipped).toBe(1);
    // The whole point: no LLM call, and no new profile row over the user's.
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
    expect(writes.some((w) => w.op === "insert")).toBe(false);
  });

  it('"daily" regenerates a 3-day-old profile', async () => {
    const { result } = await run(scriptFor({ schedule: "daily", profileAgeHours: 72 }));
    expect(result.regenerated).toBe(1);
    expect(mocks.invokeLLM).toHaveBeenCalledTimes(1);
  });

  it("a NULL column keeps the daily cadence the cron has always run", async () => {
    // Every workspace that never opened the card stores NULL. Wiring the
    // setting up must not silently re-time them.
    const { result } = await run(scriptFor({ schedule: null, profileAgeHours: 72 }));
    expect(result.regenerated).toBe(1);
  });

  it('"weekly" holds a 3-day-old profile back', async () => {
    const { result } = await run(scriptFor({ schedule: "weekly", profileAgeHours: 72 }));
    expect(result.regenerated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
  });

  it('"weekly" releases a 9-day-old profile', async () => {
    const { result } = await run(scriptFor({ schedule: "weekly", profileAgeHours: 9 * 24 }));
    expect(result.regenerated).toBe(1);
  });

  it('"on_new_deal" waits for the won count to actually move', async () => {
    const still = await run(scriptFor({ schedule: "on_new_deal", profileAgeHours: 72, wonCount: 4, sampleWonDeals: 4 }));
    expect(still.result.regenerated).toBe(0);
    expect(mocks.invokeLLM).not.toHaveBeenCalled();

    const moved = await run(scriptFor({ schedule: "on_new_deal", profileAgeHours: 72, wonCount: 5, sampleWonDeals: 4 }));
    expect(moved.result.regenerated).toBe(1);
  });

  it('"on_new_deal" still respects the age floor', async () => {
    // It shares the function with POST /api/scheduled/icp-regen, which an
    // external scheduler can call at any rate — a count-moved check with no age
    // floor would buy one LLM call per won deal per request.
    const { result } = await run(scriptFor({ schedule: "on_new_deal", profileAgeHours: 2, wonCount: 9, sampleWonDeals: 4 }));
    expect(result.regenerated).toBe(0);
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
  });

  it("an archived workspace is frozen whatever its schedule says", async () => {
    mocks.archivedWorkspaceIds.mockResolvedValue(new Set<number>([1]));
    const { result } = await run(scriptFor({ schedule: "daily", profileAgeHours: 72 }));
    expect(result.regenerated).toBe(0);
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
  });

  it("a workspace with no evidence at all is skipped before any schedule applies", async () => {
    const script = scriptFor({ schedule: "daily", profileAgeHours: 72 });
    script.closed = { n: 0, won: 0 };
    const { result } = await run(script);
    expect(result.regenerated).toBe(0);
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
  });

  it("bootstraps a workspace that has no profile yet", async () => {
    const { result } = await run(scriptFor({ schedule: "daily" }));
    expect(result.regenerated).toBe(1);
  });

  it("a restored older version is not overwritten on the next pass", async () => {
    /**
     * The freshness gate used to read the ACTIVE profile. icp.restore
     * re-activates an old version and only flips isActive — createdAt is
     * defaultNow with no onUpdateNow — so the active row's timestamp was
     * already stale and the very next pass regenerated over the version a
     * human had just chosen. Asking for the NEWEST row instead answers "when
     * did we last generate", which is the question the spend gate means.
     */
    const script = scriptFor({ schedule: "daily" });
    script.profiles = [
      { createdAt: hoursAgo(30 * 24), sampleWonDeals: 4 }, // the restored, ACTIVE version
      { createdAt: hoursAgo(2), sampleWonDeals: 4 },       // the generation it was restored over
    ];
    const { result } = await run(script);
    expect(result.regenerated).toBe(0);
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
  });

  it("counts failures instead of swallowing them", async () => {
    // The scheduled endpoint reports this number; before it existed a run that
    // failed for every workspace returned regenerated=0 and looked like a
    // quiet day.
    mocks.invokeLLM.mockRejectedValue(new Error("model unavailable"));
    const { result } = await run(scriptFor({ schedule: "daily", profileAgeHours: 72 }));
    expect(result.regenerated).toBe(0);
    expect(result.failed).toBe(1);
  });
});
