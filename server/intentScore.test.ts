/**
 * Intent was structurally 0 for every row in the system, and counted as if it
 * had been measured.
 *
 * `intentScoreFromRow` read intentTopics / hiringSignals / websiteKeywords /
 * recentFunding / recentExecChange / recentNews out of a JSON blob. NOTHING IN
 * THE REPO WRITES ANY OF THEM — every occurrence is a read. So the calculator
 * returned 0 for everyone, and because it returned 0 rather than null, `blend()`
 * counted it at its full 0.15 weight instead of renormalizing it away. A flat
 * ~15% haircut on every priority score: harmless to the ORDER, but it pushed
 * records down through the absolute hot/warm/cold thresholds.
 *
 * Every other layer was already built for "not measured" — the interface types
 * intentScore as `number | null`, persistPriority's `dec()` maps null through,
 * the column is nullable, and blend() skips nulls. One function in the middle
 * answered a question it could not measure.
 *
 * The second half is that a REAL intent signal was already being collected:
 * `website_visits.intent`, classified at write time by @shared/pageIntent, read
 * by nothing but the visitors list page.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { intentFromVisitRows } from "./services/scoring/priorityService";

const ROOT = join(__dirname, "..");
const DAY = 86400000;
const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const daysAgo = (n: number) => new Date(NOW - n * DAY);

describe("intentFromVisitRows", () => {
  it("returns null for no visits — not zero", () => {
    // The whole point: "we have never seen this person on the site" is not the
    // same claim as "this person has no intent".
    expect(intentFromVisitRows([], NOW)).toBeNull();
  });

  it("returns null when no visit carries a recognised band", () => {
    expect(intentFromVisitRows([{ intent: null, createdAt: daysAgo(1) }], NOW)).toBeNull();
    expect(intentFromVisitRows([{ intent: "weird", createdAt: daysAgo(1) }], NOW)).toBeNull();
  });

  it("scores a fresh high-intent visit at the top of the range", () => {
    expect(intentFromVisitRows([{ intent: "high", createdAt: daysAgo(1) }], NOW)).toBe(100);
  });

  it("ranks the bands", () => {
    const at = (band: string) => intentFromVisitRows([{ intent: band, createdAt: daysAgo(1) }], NOW)!;
    expect(at("high")).toBeGreaterThan(at("medium"));
    expect(at("medium")).toBeGreaterThan(at("low"));
    expect(at("low")).toBeGreaterThan(0);
  });

  it("takes the STRONGEST signal, not the sum", () => {
    // Bands BELOW the clamp, or this proves nothing: five fresh `high` visits
    // sum to 500 and clamp back to 100, so a summing implementation passes.
    // Three fresh `low` visits are 20 taken as a max and 60 taken as a sum.
    // (The first version of this test used the `high` case and a summing
    // mutation slipped straight through it.)
    const threeLow = Array.from({ length: 3 }, () => ({ intent: "low", createdAt: daysAgo(1) }));
    expect(intentFromVisitRows(threeLow, NOW)).toBe(20);

    // Mixed bands: max is the medium one, a sum would be 20 + 55 = 75.
    expect(intentFromVisitRows(
      [{ intent: "low", createdAt: daysAgo(1) }, { intent: "medium", createdAt: daysAgo(1) }],
      NOW,
    )).toBe(55);

    // Five visits to /pricing is one person interested in pricing.
    const many = Array.from({ length: 5 }, () => ({ intent: "high", createdAt: daysAgo(1) }));
    expect(intentFromVisitRows(many, NOW)).toBe(100);
  });

  it("lets a strong old visit lose to a weaker recent one only when decay says so", () => {
    const oldHigh = intentFromVisitRows([{ intent: "high", createdAt: daysAgo(200) }], NOW)!;
    const freshLow = intentFromVisitRows([{ intent: "low", createdAt: daysAgo(1) }], NOW)!;
    expect(oldHigh).toBe(10); // 100 * 0.1
    expect(freshLow).toBe(20);
    expect(freshLow).toBeGreaterThan(oldHigh);
  });

  it("decays on the same curve as engagement", () => {
    // One recency rule in this file, not a second one invented here.
    const h = (d: number) => intentFromVisitRows([{ intent: "high", createdAt: daysAgo(d) }], NOW)!;
    expect(h(3)).toBe(100);   // <= 7d  → 1.0
    expect(h(20)).toBe(75);   // <= 30d → 0.75
    expect(h(60)).toBe(50);   // <= 90d → 0.5
    expect(h(120)).toBe(25);  // <= 180d→ 0.25
    expect(h(365)).toBe(10);  // beyond → 0.1
  });

  it("is case-insensitive about the band and survives rubbish dates", () => {
    expect(intentFromVisitRows([{ intent: "HIGH", createdAt: daysAgo(1) }], NOW)).toBe(100);
    expect(intentFromVisitRows([{ intent: "high", createdAt: "not-a-date" }], NOW)).toBeNull();
  });

  it("never exceeds 100 or drops below 0", () => {
    const v = intentFromVisitRows(
      [{ intent: "high", createdAt: daysAgo(0) }, { intent: "low", createdAt: daysAgo(0) }],
      NOW,
    )!;
    expect(v).toBeLessThanOrEqual(100);
    expect(v).toBeGreaterThanOrEqual(0);
  });
});

/**
 * The JSON calculator must distinguish "no data" from "measured zero". It is
 * not exported (it is an internal of the blend), so this is asserted on the
 * source — narrowly, and alongside the behavioural tests above.
 */
describe("intentScoreFromRow distinguishes absent from zero", () => {
  const src = readFileSync(join(ROOT, "server/services/scoring/priorityService.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("declares the signal keys it understands", () => {
    expect(src).toContain("INTENT_JSON_KEYS");
    for (const k of ["intentTopics", "hiringSignals", "websiteKeywords", "recentFunding"]) {
      expect(src, k).toContain(k);
    }
  });

  it("returns null rather than 0 when the row has no intent keys", () => {
    // The two guard clauses: no blob at all, and a blob with none of the keys.
    expect(src).toMatch(/if \(!cf \|\| typeof cf !== "object"\) return null;/);
    expect(src).toMatch(/INTENT_JSON_KEYS\.some\(\(k\) => k in cf\)\) return null;/);
  });

  it("still counts an explicit empty array as a real zero", () => {
    // `intentTopics: []` is a measurement. Only an ABSENT key means unmeasured,
    // which is why the guard tests key presence rather than truthiness.
    expect(src).toContain("k in cf");
  });
});

/**
 * The gap itself: the JSON keys have readers and no writers. If that ever
 * changes — an enrichment provider starts populating them — this test fails and
 * whoever wired it up gets to delete the note instead of inheriting a stale one.
 */
describe("the intent JSON keys still have no writer", () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...sourceFiles(p));
      else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name)) out.push(p);
    }
    return out;
  }
  const files = sourceFiles(join(ROOT, "server"));

  it("finds source to scan (guards the scanner itself)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  const KEYS = ["intentTopics", "hiringSignals", "websiteKeywords", "recentFunding", "recentExecChange", "recentNews"];

  /**
   * Only writes into the TWO BLOBS THE SCORER READS count.
   *
   * ⚠️ The first version of this scan matched `recentNews:` anywhere and
   * flagged `routers/are/prospects.ts` + `seedAreDemo.ts` — which write
   * `recentNews` onto the ARE **prospect-intelligence** record, a different
   * table with a same-named field that intentScoreFromRow never reads. A key
   * name is not a location. (That intelligence record is a real candidate
   * source one day — it also carries techStack and triggerEvents — but it is
   * keyed by prospectQueueId, not by the scored entity.)
   */
  function intentKeysWrittenToScoredBlobs(): string[] {
    const writers: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const rel = f.slice(ROOT.length + 1).split(sep).join("/");
      for (const m of src.matchAll(/(customFields|enrichmentData):\s*(?:[^{;\n]{0,80}\?\s*)?\{/g)) {
        let depth = 0;
        let i = m.index! + m[0].length - 1;
        const start = i + 1;
        for (; i < src.length; i++) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") { depth--; if (depth === 0) break; }
        }
        const body = src.slice(start, i);
        for (const k of KEYS) {
          if (new RegExp(`(?:^|[{,])\\s*${k}\\s*:`).test(body)) writers.push(`${rel}: ${m[1]}.${k}`);
        }
      }
    }
    return writers;
  }

  it("finds the blob literals to scan (floor — the scan must not be vacuous)", () => {
    // unipile/imports/leadBridge all write one of these blobs; if the scanner
    // matches nothing it is broken, not the repo.
    const anyBlob = files.some((f) =>
      /(customFields|enrichmentData):\s*(?:[^{;\n]{0,80}\?\s*)?\{/.test(readFileSync(f, "utf8")),
    );
    expect(anyBlob).toBe(true);
  });

  it("documents that website visits are the only live source", () => {
    const writers = intentKeysWrittenToScoredBlobs();
    expect(
      writers,
      writers.length
        ? `\n\nSomething now WRITES an intent signal key:\n  ${writers.join("\n  ")}\n\n` +
            `Good — that closes the other half of the gap. Update the note in\n` +
            `priorityService's header and delete this test.\n`
        : undefined,
    ).toEqual([]);
  });
});
