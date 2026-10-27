/**
 * Phase 3 of the 2026-10-20 audit, part 3 — engine load (A24, A25, A68,
 * P62, P63), against the real engine and the SQL-evaluating fake.
 *
 *   "web" is not a discovery source any more (it needed a URL and was handed
 *   search text) · a refusal page is not search results · a campaign whose
 *   last discovery run found nobody rests, an angle or a source that keeps
 *   coming back empty waits longer each time · an engine log line that
 *   repeats is counted on its first row, and logs go after 30 days · counts
 *   in the log are this campaign's · Find Prospects says why a source found
 *   nothing.
 *
 * Time is frozen at T0 — Wednesday 2026-11-18, 15:00 UTC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { ARE_DEFAULT_SOURCE_ORDER, ARE_SOURCE_IDS, normalizeSources, resolveSourceOrder } from "@shared/areSources";
import { refusalOf } from "./routers/are/scraper";
import {
  DISCOVERY_REST_MS, discoveryBackoffMs, purgeOldEngineLogs, runDiscovery, __resetEngineLogRepeatsForTests,
} from "./areEngine";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const LSI = 2;
const T0 = new Date("2026-11-18T15:00:00Z").getTime();
const MIN = 60 * 1000;

const rows = (t: string) => h.db.rowsOf(t) as any[];

function seed() {
  rows("workspaces").push({ id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: 20, archivedAt: null, plan: "trial" });
  rows("workspace_settings").push({ workspaceId: LSI, areScraperSources: null, areSourceOrder: null, icpFallback: null });
  rows("are_campaigns").push({
    id: 7, workspaceId: LSI, name: "Counties", status: "active", targetProspectCount: 10,
    prospectSources: ["internal"], icpOverrides: { targetTitles: ["County Administrator"] },
    discoveryQueryState: null, researchSectorId: null, researchPersonaId: null,
  });
}
const campaign = () => rows("are_campaigns").find((c) => c.id === 7);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  h.db = makeSqlFakeDb({ realMembers: true });
  __resetEngineLogRepeatsForTests();
  seed();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ── A25 / P62: the web source ──────────────────────────────────────────── */

describe("web scraping is not a discovery source (A25, P62)", () => {
  it("is gone from the vocabulary, and stored campaigns and settings drop it", () => {
    expect(ARE_SOURCE_IDS).not.toContain("web");
    expect(ARE_DEFAULT_SOURCE_ORDER).not.toContain("web");
    expect(normalizeSources(["web", "apollo"])).toEqual(["apollo"]);
    expect(resolveSourceOrder(["web", "news"], null, ["web", "news"] as never)).toEqual(["news"]);
  });

  it("neither the engine nor Find Prospects runs it; the Scraper tab still reads a URL a person names", () => {
    const engine = read("server/areEngine.ts");
    expect(engine).not.toMatch(/scrapeWeb\(/);
    const find = read("server/services/discovery/index.ts");
    expect(find).not.toMatch(/id: "web"/);
    const scraper = read("server/routers/are/scraper.ts");
    expect(scraper).toMatch(/scrapeWeb: workspaceProcedure/);
  });
});

describe("a refusal page is not search results (A25)", () => {
  it("throttles, errors and Google's own block pages are refusals; a normal page is not", () => {
    expect(refusalOf(429, "")).toBe("rate limited (HTTP 429)");
    expect(refusalOf(503, "")).toBe("HTTP 503");
    expect(refusalOf(403, "")).toBe("HTTP 403");
    expect(refusalOf(404, "<html>gone</html>")).toBe("HTTP 404");
    expect(refusalOf(200, "<html>Our systems have detected unusual traffic from your computer network.</html>")).toMatch(/captcha or consent/);
    expect(refusalOf(200, '<html><form action="https://www.google.com/sorry/index"></form></html>')).toMatch(/captcha or consent/);
    expect(refusalOf(200, '<html><script src="https://www.google.com/recaptcha/api.js"></script><h1>Our team</h1></html>')).toBeNull();
  });

  it("the fetch every scraper uses throws on one, so no model call is spent reading it", () => {
    const scraper = read("server/routers/are/scraper.ts");
    const fetchFn = scraper.slice(scraper.indexOf("async function fetchWithTimeout("), scraper.indexOf("/* ─── Google Business scraper"));
    expect(fetchFn).toMatch(/const refused = refusalOf\(res\.status, text\);\s*if \(refused\) throw new Error/);
  });
});

/* ── A25: discovery rests and backs off ─────────────────────────────────── */

describe("discovery that keeps finding nobody slows down (A25)", () => {
  it("15 minutes, doubling, at most a day", () => {
    expect([0, 1, 2, 3, 4].map(discoveryBackoffMs)).toEqual([0, 15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN]);
    expect(discoveryBackoffMs(20)).toBe(24 * 60 * MIN);
  });

  it("an empty run rests the campaign, then backs off the angle and the source", async () => {
    expect(await runDiscovery(campaign(), 5)).toBe(0);
    const s1 = campaign().discoveryQueryState;
    expect(s1).toEqual(expect.objectContaining({ lastRunAt: T0, lastRunNew: 0, src: { internal: { empty: 1, nextAt: T0 + 15 * MIN } } }));
    expect(s1.slices[0]).toEqual(expect.objectContaining({ emptyRuns: 1, nextAt: T0 + 15 * MIN }));

    // Three minutes later (the next tick): resting, nothing runs.
    vi.setSystemTime(new Date(T0 + 3 * MIN));
    expect(await runDiscovery(campaign(), 5)).toBe(0);
    expect(campaign().discoveryQueryState.lastRunAt).toBe(T0);
    const resting = rows("are_engine_logs").filter((l) => /Discovery resting — the last run found nobody new/.test(l.message));
    expect(resting).toHaveLength(1);

    // After the rest: the angle runs again, empty again, and waits twice as long.
    vi.setSystemTime(new Date(T0 + DISCOVERY_REST_MS + MIN));
    await runDiscovery(campaign(), 5);
    const s2 = campaign().discoveryQueryState;
    expect(s2.slices[0]).toEqual(expect.objectContaining({ emptyRuns: 2, nextAt: T0 + DISCOVERY_REST_MS + MIN + 30 * MIN }));
    expect(s2.src.internal.empty).toBe(2);
  });

  it("an angle backing off is not searched, even when the campaign is not resting", async () => {
    await runDiscovery(campaign(), 5);
    const state = campaign().discoveryQueryState;
    // As if the last run found someone (no campaign rest), with every angle waiting.
    campaign().discoveryQueryState = { ...state, lastRunNew: 1, slices: state.slices.map((s: any) => ({ ...s, nextAt: T0 + 2 * 60 * MIN })) };
    vi.setSystemTime(new Date(T0 + 5 * MIN));
    expect(await runDiscovery(campaign(), 5)).toBe(0);
    expect(campaign().discoveryQueryState.lastRunAt).toBe(T0);
    expect(rows("are_engine_logs").some((l) => /every angle of this campaign's targeting has come back empty lately/.test(l.message))).toBe(true);
  });

  it("a source still resting is skipped while its angle runs", async () => {
    await runDiscovery(campaign(), 5); // internal: 1 empty run, resting until T0 + 15 min
    const state = campaign().discoveryQueryState;
    campaign().discoveryQueryState = { ...state, lastRunNew: 1, slices: state.slices.map((s: any) => ({ ...s, nextAt: null })) };
    vi.setSystemTime(new Date(T0 + 5 * MIN));
    await runDiscovery(campaign(), 5);
    const after = campaign().discoveryQueryState;
    expect(after.lastRunAt).toBe(T0 + 5 * MIN); // the angle ran…
    expect(after.src.internal).toEqual({ empty: 1, nextAt: T0 + 15 * MIN }); // …the source did not
  });

  it("a run that finds someone clears the back-off", () => {
    // Read from the source: the internal-CRM scan (the one source a test can
    // feed) uses a NOT EXISTS subquery the SQL fake cannot evaluate.
    const engine = read("server/areEngine.ts");
    expect(engine).toMatch(/if \(raw\.length === 0\) \{[\s\S]{0,200}\} else \{\s*delete sourceState\[id\];\s*\}/);
    expect(engine).toContain("updatedSlice.emptyRuns = totalNew === 0 ? (updatedSlice.emptyRuns ?? 0) + 1 : 0;");
    expect(engine).toContain("updatedSlice.nextAt = totalNew === 0 ? now + discoveryBackoffMs(updatedSlice.emptyRuns) : null;");
  });
});

/* ── A24: engine logs ───────────────────────────────────────────────────── */

describe("the engine log records changes and keeps 30 days (A24)", () => {
  it("a line that repeats is counted on its first row", async () => {
    await runDiscovery(campaign(), 5);
    for (const m of [3, 6, 9]) {
      vi.setSystemTime(new Date(T0 + m * MIN));
      await runDiscovery(campaign(), 5);
    }
    const resting = rows("are_engine_logs").filter((l) => /Discovery resting/.test(l.message));
    expect(resting).toEqual([expect.objectContaining({ repeatCount: 3, lastSeenAt: new Date(T0 + 9 * MIN) })]);
  });

  it("a line repeating every few hours stays one row: the window runs from the last time, not the first", async () => {
    // Every source switched off in Settings: the same warning each tick.
    rows("workspace_settings")[0].areScraperSources = Object.fromEntries(ARE_SOURCE_IDS.map((s) => [s, false]));
    for (const hours of [0, 20, 40]) {
      vi.setSystemTime(new Date(T0 + hours * 60 * MIN));
      await runDiscovery(campaign(), 5);
    }
    const skipped = rows("are_engine_logs").filter((l) => /Discovery skipped — no usable sources/.test(l.message));
    expect(skipped).toEqual([expect.objectContaining({ repeatCount: 3, lastSeenAt: new Date(T0 + 40 * 60 * MIN) })]);
  });

  it("logs older than 30 days are deleted daily, in batches", async () => {
    expect(await purgeOldEngineLogs(new Date(T0))).toBe(2);
    expect(h.db.executed).toEqual([
      "DELETE FROM `are_engine_logs` WHERE `are_engine_logs`.`createdAt` < ? LIMIT 5000",
      "DELETE FROM `discovery_logs` WHERE `discovery_logs`.`createdAt` < ? LIMIT 5000",
    ]);
    expect(read("server/_core/index.ts")).toMatch(/m\.purgeOldEngineLogs\(\)[\s\S]{0,300}setInterval\(runLogRetention, 24 \* 60 \* 60 \* 1000\)/);
  });

  it("the Logs tab filters by level and phase, and shows a repeated line's count", () => {
    const page = read("client/src/pages/usip/ARECampaignDetail.tsx");
    expect(page).toContain('...(levelFilter === "error" ? { level: "error" } : {}),');
    expect(page).toContain('...(phaseFilter !== "all" ? { phase: phaseFilter } : {}),');
    expect(page).toContain("×{log.repeatCount}");
  });
});

/* ── A68 / P63 ──────────────────────────────────────────────────────────── */

describe("the counts in a log line are what they say (A68, P63)", () => {
  it("dispatch and enrol report this campaign's own numbers", () => {
    const engine = read("server/areEngine.ts");
    expect(engine).toContain("`Dispatched (sent this tick: ${result.sent - sentBeforeThisCampaign}, daily remaining cap: ${remaining})`");
    expect(engine).not.toContain("`Enrolled ${rows.length} prospects into execution queue`");
    expect(engine).toMatch(/enrolledHere\+\+;/);
  });

  it("Find Prospects says why a source that could not run found nothing", () => {
    const find = read("server/services/discovery/index.ts");
    expect(find).toContain("perSource[source] = { found: raw.length, ...(note ? { note } : {}) };");
    expect(find).toMatch(/note \? "warn" : "info"/);
    expect(find).toMatch(/note: `today's Apollo record cap is used up/);
    expect(find).toMatch(/note: "no QuickEnrich key for this workspace/);
    expect(find).toMatch(/if \(!res\.ok\) return \{ raw: \[\], note: res\.message \};/);
  });
});
