/**
 * F12 — per-source health for one campaign (built 2026-10-30).
 *
 * The spec reads: "Per-source health strip: key status, circuit breaker, budget
 * left today, last success or error, raw to kept to admitted yield, tokens
 * spent, automatic back-off after repeated empty results." Four of those were
 * already on screen in the workspace back office, one does not exist as state,
 * and one was already built and running. So these guards protect the decisions
 * that came out of reading, not a feature list:
 *
 *   1. The back-off is SURFACED, NOT DISABLED. The brief asked for it "default
 *      off"; it already ships and is on, at three levels, and defaulting it off
 *      would reinstate paying a vendor to search for the same nobody every ten
 *      minutes (A25). The owner chose "surface, don't disable" on 2026-10-30,
 *      and the test below fails if the mechanism is weakened.
 *   2. No per-source SUCCESS time exists, so nothing claims one. `recordSuccess`
 *      zeroes the failure counter and writes no timestamp, and `lastValidatedAt`
 *      is a key check rather than a search — so the field is `lastAttempt` and
 *      the surface says what it is.
 *   3. A breaker reading is only called durable for `table` sources; legacy ones
 *      keep it in a process-local Map that a deploy forgets.
 *   4. All seven ARE sources are listed. Four have no credential row, breaker or
 *      ledger at all, and a strip whose job is "which sources earn their cost"
 *      must not answer by leaving four of them out.
 *   5. Spend is labelled a WORKSPACE total for a UTC day, because the ledger has
 *      no campaign column and its `day` is a sliced ISO string.
 *
 * No jsdom here, so the client assertions are source pins; the rendered
 * behaviour belongs to a browser.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARE_SOURCES, ARE_SOURCE_IDS } from "@shared/areSources";
import { PROSPECT_SOURCE_SLUGS } from "@shared/prospectSources";
import { inRunOrder, verdict } from "@/components/usip/are/CampaignSourceHealth";
import { DISCOVERY_REST_MS, discoveryBackoffMs } from "./areEngine";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

const router = read("server/routers/are/campaigns.ts");
const engine = read("server/areEngine.ts");
const registry = read("server/services/prospectSources/registry.ts");
const circuit = read("server/services/prospectSources/circuit.ts");
const strip = read("client/src/components/usip/are/CampaignSourceHealth.tsx");
const stallPanel = read("client/src/components/usip/are/CampaignStallPanel.tsx");
const page = read("client/src/pages/usip/ARECampaignDetail.tsx");

describe("the empty-result back-off is surfaced, not disabled", () => {
  /**
   * Behaviour, not a source pin. A pin on the function's existence would pass
   * for a body neutered to `return 0`, which is "default off" smuggled in — the
   * exact change the owner decided against. This is the test that cannot be
   * satisfied by a mechanism that no longer backs anything off.
   */
  it("actually backs off, doubling from 15 minutes and capping at a day", () => {
    const MIN = 60_000;
    expect(discoveryBackoffMs(0)).toBe(0);
    expect(discoveryBackoffMs(-1)).toBe(0);
    expect(discoveryBackoffMs(1)).toBe(15 * MIN);
    expect(discoveryBackoffMs(2)).toBe(30 * MIN);
    expect(discoveryBackoffMs(3)).toBe(60 * MIN);
    expect(discoveryBackoffMs(4)).toBe(120 * MIN);
    // Capped, and never shrinking as failures accumulate.
    expect(discoveryBackoffMs(99)).toBe(24 * 60 * MIN);
    for (let n = 1; n < 20; n++) {
      expect(discoveryBackoffMs(n + 1), `run ${n + 1} vs ${n}`).toBeGreaterThanOrEqual(discoveryBackoffMs(n));
    }
    expect(DISCOVERY_REST_MS).toBe(30 * MIN);
  });

  it("still exists in the engine at all three levels, with no default-off flag", () => {
    // The owner's instruction on 2026-10-30 was "surface, don't disable", after
    // the read-only pass found the brief's "default off" would switch OFF a
    // live safeguard. If someone later adds a flag that defaults this off, this
    // test is the thing that should stop them.
    expect(engine).toContain("export const DISCOVERY_REST_MS = 30 * 60 * 1000;");
    expect(engine).toContain("export function discoveryBackoffMs(emptyRuns: number): number {");
    // Per source, per targeting angle, and campaign-wide: three call sites.
    const perSource = engine.split("sourceState[id] = { empty, nextAt: Date.now() + discoveryBackoffMs(empty) };").length - 1;
    expect(perSource, "per-source back-off assignments").toBeGreaterThanOrEqual(2);
    expect(engine).toContain("updatedSlice.nextAt = totalNew === 0 ? now + discoveryBackoffMs(updatedSlice.emptyRuns) : null;");
    expect(engine).toContain("if (persistedState.lastRunNew === 0 && persistedState.lastRunAt && now0 - persistedState.lastRunAt < DISCOVERY_REST_MS) {");
  });

  it("is read from the campaign's own live state and shown with its reason", () => {
    expect(router).toContain("state.src?.[meta.id]");
    expect(router).toContain("{ emptyRuns: rest.empty, until: new Date(rest.nextAt).toISOString() }");
    expect(strip).toContain("Resting after ${s.rest.emptyRuns} empty ${plural(s.rest.emptyRuns, \"run\", \"runs\")}");
    // And the campaign-wide rest explains itself rather than just showing a time.
    expect(strip).toContain("rather than asking the same");
    expect(strip).toContain("{d.restWindowMinutes} minutes");
  });

  it("the F11 panel no longer claims discovery is running while it rests", () => {
    // The row said "Below target — discovery runs on every tick" unconditionally
    // when F11 shipped, which is false during a rest. Below target and
    // searching are different claims.
    const note = stallPanel.indexOf("Queue full, so discovery stays idle");
    const resting = stallPanel.indexOf("g.queue.discoveryRestingUntil", note);
    const everyTick = stallPanel.indexOf("Below target — discovery runs on every tick.", note);
    expect(note, "the queue gate note").toBeGreaterThan(-1);
    expect(resting, "the resting branch").toBeGreaterThan(-1);
    expect(everyTick, "the every-tick default").toBeGreaterThan(-1);
    // The resting branch must be tested BEFORE the default, or it is dead code.
    expect(resting).toBeLessThan(everyTick);
    expect(router).toContain("discoveryRestingUntil: restUntilMs && restUntilMs > Date.now()");
  });
});

describe("the engine's per-source breakdown stays pinned to its wording", () => {
  it("the summary marker is a literal substring of the engine's log line", () => {
    const marker = /const DISCOVERY_SUMMARY_MARKER = "([^"]+)";/.exec(router)?.[1];
    expect(marker, "DISCOVERY_SUMMARY_MARKER").toBeTruthy();
    // Same drift guard as POOL_HELD_MARKER: if the engine rewords this line and
    // the router does not follow, every source reads "no attempt on record"
    // while discovery is running perfectly.
    expect(engine).toContain(marker!);
    // And the breakdown it carries is still shaped the way the router reads it.
    expect(engine).toContain("const perSource: Record<string, { raw: number; new: number; error?: string; skipped?: string }> = {};");
    expect(engine).toContain("sliceCount: targetingSlices.length,");
  });
});

describe("a success time is claimed only where one is stored", () => {
  // 2026-11-07 (audit F12, batch RESB): updated deliberately, as this test
  // asked. The engine now stores each source's last success per campaign
  // (discoveryQueryState.ok, written only when a source returned people and
  // the save succeeded), and the router reads that and nothing else. The
  // breaker's recordSuccess still writes no timestamp, and "Last attempt"
  // still means the last summary, so both are kept pinned.
  it("lastSuccessAt comes from the engine's stored success, never from the breaker or a key check", () => {
    expect(circuit).toContain("export async function recordSuccess(");
    const body = circuit.slice(circuit.indexOf("export async function recordSuccess("));
    expect(body.slice(0, body.indexOf("}\n\n"))).not.toMatch(/lastSuccess/i);
    expect(router).toContain("lastAttempt: attempt");
    expect(router).toContain("lastSuccessAt: state.ok?.[meta.id] ? new Date(state.ok[meta.id]).toISOString() : null,");
    expect(engine).toContain("if (raw.length > 0) lastOk[id] = Date.now();");
    expect(strip).toContain("\"Last attempt\" is the engine's last discovery summary for this campaign.");
  });

  it("an absent attempt reads as 'no attempt on record', bounded by the retention constant", () => {
    expect(strip).toContain("no attempt on record");
    expect(router).toContain("logRetentionDays: ENGINE_LOG_RETENTION_DAYS");
    expect(strip).toContain("{data.logRetentionDays} days");
    // The horizon must come from the constant, not be transcribed beside it.
    expect(strip).not.toMatch(/kept 30 days/);
  });
});

describe("a breaker reading is only called durable when it is", () => {
  it("durability comes from credentialMode, which the registry now reports", () => {
    expect(registry).toContain("credentialMode: \"table\" | \"legacy\";");
    expect(registry).toContain("credentialMode: s.credentialMode,");
    expect(router).toContain("durable: d.credentialMode === \"table\"");
    // Legacy state really is process-local, which is why this matters.
    expect(circuit).toContain("const memory = new Map<string, { failures: number; openUntil: number | null }>();");
  });

  it("the non-durable case is said on the surface, not left to be assumed", () => {
    expect(strip).toContain("s.breaker && !s.breaker.durable");
    expect(strip).toContain("held in memory, not stored");
  });
});

describe("all seven ARE sources are listed, instrumented or not", () => {
  it("the router maps the source registry, not just the vendors with credentials", () => {
    expect(ARE_SOURCES.length, "ARE sources").toBeGreaterThanOrEqual(7);
    expect(router).toContain("const sources = ARE_SOURCES.map((meta) => {");
    expect(router).toContain("instrumented: d != null,");
  });

  it("an uninstrumented source says so rather than showing blanks", () => {
    // 2026-10-31: the sentence this pinned was true and still read as a
    // footnote to the green "Ready" beside it, so it was rewritten to carry
    // the consequence instead. The old wording ("no key status, breaker or
    // budget is tracked for this source") is deliberately gone; what must
    // survive is that the absence is stated at all.
    expect(strip).toContain("Not instrumented — no credential, breaker or budget record exists for this source");
    expect(strip).toContain("there is nothing to");
    expect(strip).toContain("read a verdict from");
    expect(strip).toContain("not tracked");
  });

  it("selection and order are resolved exactly as the engine resolves them", () => {
    // Reading the campaign's sources any other way would show sources that
    // will not run, or hide ones that will. The explicit-empty rule matters:
    // an engine-proposed campaign stores [] on purpose, and reading that as
    // "every source" once pulled 68 strangers into a 32-person campaign.
    // 2026-11-03: the rule moved to shared/areSources so the tab reads it too, and
    // campaignSourcesRead.test.ts runs it through the router and the engine.
    expect(router).toContain("const explicitlyNone = discoveryIsOff(campaign.prospectSources);");
    expect(router).toContain("const selected = campaignSources(campaign.prospectSources);");
    expect(engine).toContain("const sources: string[] = campaignSources(campaign.prospectSources);");
    expect(router).toContain("resolveSourceOrder(wsRow?.order, wsRow?.mask, selected as AreSourceId[])");
    expect(engine).toContain("resolveSourceOrder(wsSourceRow?.order, wsSourceRow?.mask, sources as AreSourceId[])");
  });
});

describe("the one reason shown is the operative one", () => {
  it("the verdict checks gates in the order the engine applies them", () => {
    const fn = strip.indexOf("function verdict(");
    expect(fn, "verdict()").toBeGreaterThan(-1);
    const body = strip.slice(fn, strip.indexOf("\n}", fn));
    // Each anchor is asserted present BEFORE its position is compared: an
    // absent anchor makes indexOf return -1, which is less than everything,
    // and that is how a mutant survived the F11 pass.
    const at = (needle: string) => {
      const i = body.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const notSelected = at("!s.selectedOnCampaign");
    const disabled = at("!s.enabledInWorkspace");
    const resting = at("if (s.rest)");
    const paused = at("s.breaker?.open");
    const noKey = at("!s.key.configured");
    const ready = at('text: "Ready"');
    expect(notSelected).toBeLessThan(disabled);
    expect(disabled).toBeLessThan(resting);
    expect(resting).toBeLessThan(paused);
    expect(paused).toBeLessThan(noKey);
    expect(noKey).toBeLessThan(ready);
  });
});

describe("spend says whose it is and which day", () => {
  it("is labelled a workspace total for a UTC day, in the header", () => {
    // spend_ledger has no campaign column and spendDay() slices an ISO string,
    // so neither a per-campaign figure nor a workspace-day one is derivable.
    expect(router).toContain('spendScope: "workspace" as const');
    expect(router).toContain("const today = spendDay();");
    expect(strip).toContain("Spend · workspace, {data.spendDay} UTC");
    expect(strip).toContain("nothing recorded");
  });

  it("an allowance the vendor does not publish reads as tracked locally, never zero", () => {
    expect(strip).toContain("tracked locally — the vendor publishes no allowance");
    expect(router).toContain("fundedBy: b.fundedBy ?? null");
  });
});

describe("it adds to the workspace back office rather than duplicating it", () => {
  it("links to Settings → Data sources and does not reprint the capability manifest", () => {
    expect(strip).toContain('href="/v2/settings/data-sources"');
    // The registry card owns capability chips and the run inspector; repeating
    // them here is the duplication phase 5 exists to remove.
    expect(strip).not.toMatch(/supportedFilters|CapChips|approximatedFilters/);
  });

  it("sits above the discovery launcher, where the spending decision is made", () => {
    const stripMount = page.indexOf("<CampaignSourceHealth campaignId={campaignId} />");
    const launcher = page.indexOf("<CampaignDiscoveryLauncher campaignId={campaignId}");
    expect(stripMount, "the strip is mounted").toBeGreaterThan(-1);
    expect(stripMount).toBeLessThan(launcher);
  });
});

describe("the table is in the order its own sentence promises (2026-10-31)", () => {
  /**
   * Found in the live app, not in the code. The header says the sources are
   * listed "in the order they run — which is also dedup precedence, so a lower
   * source is never paid for a person a higher one already found". The list
   * was the server's registry order and nothing sorted it, so on ws 2 campaign
   * 38 the real order read, top to bottom: 2nd, 4th, 3rd, 5th, —, 1st, —.
   *
   * QuickEnrich runs FIRST and sat SIXTH, below four sources that run after
   * it, and it was the only source returning rows (10 returned → 7 kept, every
   * other one "skipped — target met by earlier sources"). A reader following
   * the sentence would have had precedence exactly backwards on the one row it
   * mattered for.
   *
   * The ORDER column was correct throughout. That is what made the list worth
   * believing, and why this is a sort rather than a rewrite of the sentence.
   */
  const order = (rows: { slug: string; runsAt: number | null }[]) =>
    inRunOrder(rows as unknown as Parameters<typeof inRunOrder>[0]).map((s) => s.slug);

  it("sorts by runsAt, which registry order does not", () => {
    // The exact shape the live campaign returned, in the order the server
    // returns it.
    const live = [
      { slug: "internal", runsAt: 1 },
      { slug: "google_business", runsAt: 3 },
      { slug: "linkedin", runsAt: 2 },
      { slug: "news", runsAt: 4 },
      { slug: "apollo", runsAt: null },
      { slug: "quickenrich", runsAt: 0 },
      { slug: "warmysender", runsAt: null },
    ];
    expect(order(live)).toEqual([
      "quickenrich", "internal", "linkedin", "google_business", "news", "apollo", "warmysender",
    ]);
    // The bug, stated as the thing that must not come back: the source that
    // runs first must not be below one that runs later.
    const sorted = order(live);
    expect(sorted.indexOf("quickenrich")).toBeLessThan(sorted.indexOf("internal"));
  });

  it("puts sources that will not run last, keeping their order among themselves", () => {
    // `runsAt: null` is "no position in the order", not "position zero" — a
    // comparator reading null as 0 would float them to the top, above the
    // source that actually runs first.
    const rows = [
      { slug: "apollo", runsAt: null },
      { slug: "warmysender", runsAt: null },
      { slug: "quickenrich", runsAt: 0 },
    ];
    expect(order(rows)).toEqual(["quickenrich", "apollo", "warmysender"]);
  });

  it("does not mutate the array it was given", () => {
    // It sorts react-query's cached data; sorting in place would reorder the
    // cache under every other reader of that query.
    const rows = [{ slug: "b", runsAt: 1 }, { slug: "a", runsAt: 0 }];
    order(rows);
    expect(rows.map((r) => r.slug)).toEqual(["b", "a"]);
  });

  it("is actually what the table renders, and the sentence still says so", () => {
    expect(strip).toContain("{inRunOrder(data.sources).map((s) => <SourceRow");
    expect(strip).not.toContain("{data.sources.map((s) => <SourceRow");
    // If the sentence goes, the sort is no longer load-bearing and this whole
    // block should be revisited rather than quietly kept.
    expect(strip).toContain("in the order they run");
  });
});

/**
 * "Ready" was asserted from the absence of evidence (2026-10-31).
 *
 * Found live on ws 2 campaign 38: internal, google_business, linkedin and news
 * each showed the green "Ready" on the same row as "no key status, breaker or
 * budget is tracked for this source". They have no credential row, no breaker
 * and no ledger, so every gate in verdict() that could have failed them is
 * unreachable, and they fell through to the last line. The panel exists to
 * stop a zero being read as a measurement; this was the same error one layer
 * up — an unknown read as a pass, in the surface built to prevent it.
 *
 * The honest reading is that the engine will call their branch and nothing
 * checks whether that branch can do anything.
 */
describe("an uninstrumented source is unknown, not ready (2026-10-31)", () => {
  type Row = Parameters<typeof verdict>[0];
  const row = (over: Record<string, unknown>): Row => ({
    slug: "internal",
    label: "Internal CRM",
    runsAt: 0,
    selectedOnCampaign: true,
    enabledInWorkspace: true,
    instrumented: false,
    key: null,
    breaker: null,
    budget: null,
    rest: null,
    lastAttempt: null,
    spendToday: null,
    ...over,
  }) as unknown as Row;

  it("never reads Ready, and never reads green", () => {
    const v = verdict(row({}));
    expect(v.text).not.toBe("Ready");
    expect(v.text).toBe("Will run — nothing here checks that it can");
    // Muted, not emerald: an absence of evidence is a quiet fact, which is
    // also how F17 renders an unknown place. "ok" would be the same lie in a
    // different font.
    expect(v.tone).toBe("muted");
    expect(v.tone).not.toBe("ok");
  });

  it("still says Ready for a source that something actually checked", () => {
    // The fix must not have been to delete the state. An instrumented source
    // with a configured key, a closed breaker and a place in the order has
    // evidence behind the word.
    const v = verdict(row({
      slug: "quickenrich",
      instrumented: true,
      key: { configured: true, status: "valid", validatedAt: null, error: null },
      breaker: { open: false, failures: 0, openUntil: null, durable: false },
    }));
    expect(v).toEqual({ text: "Ready", tone: "ok" });
  });

  it("says 'will not run' ahead of it, because that one is known", () => {
    // Order matters: a source with no position in the waterfall will not run
    // at all, which is a fact, and it beats "nothing checks it".
    const v = verdict(row({ runsAt: null }));
    expect(v.text).toBe("Will not run");
  });

  it("checks instrumentation after every gate it could fail, and before Ready", () => {
    const fn = strip.indexOf("function verdict(");
    expect(fn, "verdict()").toBeGreaterThan(-1);
    // Bounded by the declaration that follows verdict(), rather than by a
    // brace: an anchor with no escapes in it.
    const end = strip.indexOf("const TONE_CLASS", fn);
    expect(end, "TONE_CLASS after verdict()").toBeGreaterThan(fn);
    const body = strip.slice(fn, end);
    const at = (needle: string) => {
      const i = body.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    expect(at("s.runsAt == null")).toBeLessThan(at("!s.instrumented"));
    expect(at("!s.instrumented")).toBeLessThan(at('text: "Ready"'));
  });

  it("pins the four sources this applies to, so a fifth cannot arrive quietly", () => {
    /**
     * `instrumented` is the server's `d != null` from describeSources, and
     * describeSources only knows the registry — so an ARE source with no
     * adapter in SOURCE_FACTORIES is an uninstrumented one. These four are
     * hand-written branches in runDiscovery.
     *
     * Pinned as a set rather than a count: adding an eighth ARE source without
     * an adapter would otherwise inherit the new state silently, and whoever
     * adds it should decide that on purpose. If this fails, the question is
     * whether the new source really has no credential, breaker or budget — not
     * whether to widen the list.
     */
    const registered = new Set<string>(PROSPECT_SOURCE_SLUGS as readonly string[]);
    const uninstrumented = (ARE_SOURCE_IDS as readonly string[]).filter((id) => !registered.has(id));
    expect(uninstrumented).toEqual(["internal", "google_business", "linkedin", "news"]);
    // And the others are instrumented, so the split is real rather than an
    // empty assertion about an empty set. (LeadOcean joined them 2026-11-02.)
    const instrumented = (ARE_SOURCE_IDS as readonly string[]).filter((id) => registered.has(id));
    expect(instrumented).toEqual(["apollo", "quickenrich", "warmysender", "leadocean"]);
  });
});
