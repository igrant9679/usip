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
import { ARE_SOURCES } from "@shared/areSources";
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

describe("nothing claims a success time, because none is stored", () => {
  it("recordSuccess still writes no timestamp, so the field is lastAttempt", () => {
    // If someone adds a lastSuccessAt column later, this test should be
    // updated deliberately — that is the point of pinning the absence.
    expect(circuit).toContain("export async function recordSuccess(");
    const body = circuit.slice(circuit.indexOf("export async function recordSuccess("));
    expect(body.slice(0, body.indexOf("}\n\n"))).not.toMatch(/lastSuccess/i);
    expect(router).toContain("lastAttempt: attempt");
    expect(router).not.toMatch(/lastSuccessAt/);
    expect(strip).toContain("is the engine's last discovery summary for this campaign, not a success time");
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
    expect(strip).toContain("Not instrumented — no key status, breaker or budget is tracked for this source.");
    expect(strip).toContain("not tracked");
  });

  it("selection and order are resolved exactly as the engine resolves them", () => {
    // Reading the campaign's sources any other way would show sources that
    // will not run, or hide ones that will. The explicit-empty rule matters:
    // an engine-proposed campaign stores [] on purpose, and reading that as
    // "every source" once pulled 68 strangers into a 32-person campaign.
    expect(router).toContain("const explicitlyNone = Array.isArray(rawSources) && rawSources.length === 0;");
    expect(router).toContain("configured.length > 0 ? configured : explicitlyNone ? [] : [...ARE_DEFAULT_SOURCES]");
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
