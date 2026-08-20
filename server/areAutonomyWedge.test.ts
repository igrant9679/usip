/**
 * ARE audit 2026-08-20 — two defects that stopped fully-autonomous campaigns
 * from running properly, both found live:
 *
 * 1. PHASE-2 STARVATION: an approved row with enrichmentStatus 'complete'
 *    but NO prospect_intelligence row is refused by runSequenceAgent ("no
 *    enrichment data" — correctly), but never leaves phase 2's page: it
 *    stays approved with a NULL sequence, matches every tick, and with a
 *    SEQUENCE_PER_CAMPAIGN_TICK-sized page the same few rows occupied every
 *    slot forever. Campaigns 19 and 20 retried the same 1+3 prospects every
 *    3 minutes while 8 more approved prospects never got a turn. The
 *    320072b starvation shape, in phase 2.
 *
 * 2. INTEL TYPE DRIFT: intelligence JSON is written from LLM output, and
 *    `(x as Array) ?? []` only catches null. A STRING painSignals reached
 *    `.slice(0,2).map(...)` and killed sequence generation for a campaign-21
 *    prospect on every attempt ("painSignals.slice(...).map is not a
 *    function"). Same family as the sequence-step `??`-default lesson:
 *    normalise at the read.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { intelArray, primaryHookOf } from "./routers/are/prospects";

const engine = readFileSync("server/areEngine.ts", "utf8");
const phase2 = engine.slice(engine.indexOf("/* ── Phase 2: SEQUENCE"), engine.indexOf("/* ── Phase 3: ENROLL"));
const router = readFileSync("server/routers/are/prospects.ts", "utf8");

describe("intelArray — the drift guard", () => {
  it("passes arrays through and reads everything else as empty", () => {
    expect(intelArray([1, 2])).toEqual([1, 2]);
    expect(intelArray(null)).toEqual([]);
    expect(intelArray(undefined)).toEqual([]);
    expect(intelArray("manual reporting is painful")).toEqual([]); // the live crash shape
    expect(intelArray({ signal: "x" })).toEqual([]);
    expect(intelArray(42)).toEqual([]);
  });
});

describe("primaryHookOf survives drifted intelligence", () => {
  const base = { personalisationHooks: null, triggerEvents: null, painSignals: null } as never;
  it("string and object columns fall through to the generic hook instead of crashing", () => {
    expect(primaryHookOf({ ...base, painSignals: "not an array" } as never).hookType).toBe("generic");
    expect(primaryHookOf({ ...base, personalisationHooks: { hook: "x" } } as never).hookType).toBe("generic");
  });
  it("a real pain signal still wins", () => {
    expect(primaryHookOf({ ...base, painSignals: [{ signal: "manual grant reporting" }] } as never))
      .toEqual({ hook: "manual grant reporting", hookType: "pain_signal" });
  });
  it("array members that are not objects fall through safely", () => {
    expect(primaryHookOf({ ...base, painSignals: ["just a string"] } as never).hookType).toBe("generic");
  });
});

describe("phase 2 — wiring", () => {
  it("re-queues complete-but-dossierless approved rows for enrichment, and says so", () => {
    // The SQL lives in a sql`` template, so the source text carries \` — match
    // the file as written, not the string the database sees.
    expect(phase2).toContain("SET pq.\\`enrichmentStatus\\` = 'pending'");
    expect(phase2).toContain("AND pi.\\`id\\` IS NULL");
    expect(phase2).toContain("re-queued for enrichment");
    // The heal must not touch rows still awaiting screening or already done —
    // only approved rows claiming completeness.
    expect(phase2).toContain("AND pq.\\`sequenceStatus\\` = 'approved'");
    expect(phase2).toContain("AND pq.\\`enrichmentStatus\\` = 'complete'");
  });

  it("the generation page admits only rows with a dossier, in a deterministic order", () => {
    expect(phase2).toContain("innerJoin(");
    expect(phase2).not.toContain("leftJoin(");
    expect(phase2).toContain("orderBy(prospectQueue.id)");
    expect(phase2).toContain("SEQUENCE_PER_CAMPAIGN_TICK");
  });

  it("runSequenceAgent's refusal is untouched — the fix drains the set, it does not paper over the gap", () => {
    expect(router).toContain("Prospect has no enrichment data");
  });

  it("the re-queue hand-off actually lands: the enricher admits approved rows regardless of score", () => {
    // Without this arm the heal moves a human-approved below-gate row from a
    // loud wedge into a silent parking lot (live: 4 rows at score 33, gates
    // 35, approved/pending forever). The full check lives in
    // areEnrichGate.test.ts; asserted here too because the 2a heal DEPENDS
    // on it — these two pieces drifting apart recreates the dead state.
    const enricher = engine.slice(engine.indexOf("async function enrichPendingGlobally"), engine.indexOf("\nasync function tickCampaign"));
    expect(enricher).toContain("OR ${prospectQueue.sequenceStatus} = 'approved'");
  });

  it("the generation prompt reads pain signals through the guard", () => {
    const fn = router.slice(router.indexOf("async function personalizeForProspect"), router.indexOf("export async function runSequenceAgent"));
    expect(fn).toContain("intelArray<{ signal?: string; evidence?: string }>(intel.painSignals)");
    expect(fn).not.toContain("as Array<{ signal: string; evidence: string }>");
  });
});
