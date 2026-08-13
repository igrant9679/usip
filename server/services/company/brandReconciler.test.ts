/**
 * Brand identity reconciler — the guarantees:
 *
 *  - migration 0152 is declared in BOTH places (rawMigrations + drizzle),
 *    with every column the reconciler writes;
 *  - scoring is domain-match-first and a name-only hit is CAPPED below the
 *    auto threshold, so it can never auto-accept (owner spec);
 *  - a domain CONFLICT lands in the candidate band — a rebrand signal is a
 *    human decision, never an auto-write;
 *  - decisions respect the threshold bands (auto / corroborated / candidate /
 *    no-change) and manual overrides are supreme at every band;
 *  - auto-apply is narrow: legal name + display SPELLING only — a genuinely
 *    different provider name is never auto-renamed;
 *  - change detection hashes the normalized identity, so display/URL noise
 *    never reads as a brand change;
 *  - the refresh predicate honours the negative cache, the stale window, and
 *    re-queries immediately when the account's own identity changed;
 *  - the cron sweep is registered, and the sweep is dormant without config;
 *  - the enrichment-path files still never import the provider (the owner
 *    rule this stack was designed around — reconciliation lives HERE).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRAND_THRESHOLDS, NEGATIVE_TTL_MS, REFRESH_TTL_MS,
  brandContentHash, decideBrandReconcile, deriveLegalName, needsBrandRefresh,
  pickBestHit, scoreBrandHit, runBrandReconciliation, collectBrandCandidates,
} from "./brandReconciler";
import type { BrandSearchHit } from "../brand/brandfetch";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const hit = (over: Partial<BrandSearchHit> = {}): BrandSearchHit => ({
  name: "Acme", domain: "acme.com", icon: null, brandId: "b1", claimed: false, ...over,
});

describe("migration 0152 is declared in both places", () => {
  it("rawMigrations has the 0152 block with every column", () => {
    // CREATE TABLE lives in a template literal with \`-escaped backticks —
    // unescape so assertions read like the SQL that actually runs.
    const src = read("server/_core/rawMigrations.ts").replace(/\\`/g, "`");
    expect(src).toContain("0152_brand_identity_reconciliation.sql");
    expect(src).toMatch(/ALTER TABLE `accounts` ADD COLUMN `legal_name` varchar\(240\) NULL/);
    expect(src).toMatch(/ALTER TABLE `accounts` ADD COLUMN `brand_confidence` int NULL/);
    expect(src).toMatch(/ALTER TABLE `accounts` ADD COLUMN `brand_verified_at` timestamp NULL/);
    expect(src).toMatch(/ALTER TABLE `accounts` ADD COLUMN `brand_override` json NULL/);
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS `brand_observations`/);
    for (const col of ["`provider`", "`raw_name`", "`normalized_name`", "`raw_domain`", "`normalized_domain`", "`logo_ref`", "`claimed`", "`match_confidence`", "`match_basis`", "`content_hash`", "`query_hash`", "`evidence`", "`observed_at`"]) {
      expect(src, `brand_observations must declare ${col}`).toContain(col);
    }
  });

  it("drizzle/schema.ts declares the table and the account columns", () => {
    // Drizzle selects every column it knows about — a column missing here is
    // invisible to the ORM even once it exists in the database.
    const src = read("drizzle/schema.ts");
    expect(src).toMatch(/legalName: varchar\("legal_name"/);
    expect(src).toMatch(/brandConfidence: int\("brand_confidence"\)/);
    expect(src).toMatch(/brandVerifiedAt: timestamp\("brand_verified_at"\)/);
    expect(src).toMatch(/brandOverride: json\("brand_override"\)/);
    expect(src).toMatch(/export const brandObservations = mysqlTable\(\s*\n?\s*"brand_observations"/);
  });
});

describe("scoreBrandHit — domain-match-first", () => {
  const acme = { name: "Acme", domain: "acme.com" };

  it("domain match reaches the auto band; claimed + name agreement raise it, capped at 99", () => {
    expect(scoreBrandHit(acme, hit()).basis).toBe("domain_exact");
    expect(scoreBrandHit(acme, hit()).confidence).toBeGreaterThanOrEqual(BRAND_THRESHOLDS.auto);
    const maxed = scoreBrandHit(acme, hit({ claimed: true }));
    expect(maxed.confidence).toBeLessThanOrEqual(99);
  });

  it("domain matching ignores protocol/www/case noise", () => {
    const s = scoreBrandHit({ name: "Acme", domain: "https://WWW.Acme.com/about" }, hit());
    expect(s.basis).toBe("domain_exact");
  });

  it("a name-only hit NEVER reaches the auto threshold — even exact and claimed", () => {
    const s = scoreBrandHit({ name: "Acme", domain: null }, hit({ claimed: true }));
    expect(s.basis).toBe("name_exact");
    expect(s.confidence).toBeGreaterThanOrEqual(BRAND_THRESHOLDS.corroborated);
    expect(s.confidence).toBeLessThan(BRAND_THRESHOLDS.auto);
  });

  it("a fuzzy name match lands in the candidate band", () => {
    // NB: "Group"/"International"-style suffixes are stripped by
    // normalizeCompanyName and would make names EXACT — use a pair that
    // stays genuinely fuzzy after normalization.
    const s = scoreBrandHit({ name: "Blue River Software", domain: null }, hit({ name: "Blue River Technologies", domain: "blueriver.io" }));
    expect(s.basis).toBe("name_fuzzy");
    expect(s.confidence).toBeGreaterThanOrEqual(BRAND_THRESHOLDS.candidate);
    expect(s.confidence).toBeLessThan(BRAND_THRESHOLDS.corroborated);
  });

  it("a domain CONFLICT is capped in the candidate band — rebrand signals are for humans", () => {
    const s = scoreBrandHit({ name: "Acme", domain: "acme.org" }, hit({ domain: "acme.com" }));
    expect(s.confidence).toBeLessThan(BRAND_THRESHOLDS.corroborated);
    expect(s.confidence).toBeGreaterThanOrEqual(BRAND_THRESHOLDS.candidate);
  });

  it("an unrelated hit scores 0", () => {
    expect(scoreBrandHit({ name: "Acme", domain: null }, hit({ name: "Globex", domain: "globex.com" })).confidence).toBe(0);
  });
});

describe("pickBestHit", () => {
  it("picks the highest score; a claimed brand wins ties; all-zero returns null", () => {
    const acc = { name: "Acme", domain: "acme.com" };
    const best = pickBestHit(acc, [hit({ name: "Acme Ltd", domain: "acmeltd.co" }), hit(), hit({ name: "Globex", domain: "globex.com" })]);
    expect(best?.hit.domain).toBe("acme.com");
    const tie = pickBestHit({ name: "Acme", domain: null }, [hit({ domain: null }), hit({ domain: null, claimed: true, brandId: "b2" })]);
    expect(tie?.hit.brandId).toBe("b2");
    expect(pickBestHit({ name: "Acme", domain: null }, [hit({ name: "Globex", domain: "globex.com" })])).toBeNull();
  });
});

describe("deriveLegalName — legal-vs-display split", () => {
  it("keeps a suffixed legal form, standardized", () => {
    expect(deriveLegalName("Acme, inc")).toBe("Acme, Inc.");
    expect(deriveLegalName("Acme GMBH")).toBe("Acme GmbH");
  });
  it("a bare display name is NOT a legal name", () => {
    expect(deriveLegalName("Acme")).toBeNull();
    expect(deriveLegalName(null)).toBeNull();
  });
});

describe("decideBrandReconcile — threshold bands", () => {
  const base = { name: "Acme", domain: "acme.com" as string | null, legalName: null as string | null, brandOverride: null };
  const scored = (confidence: number, h: Partial<BrandSearchHit> = {}) =>
    ({ hit: hit(h), confidence, basis: "domain_exact" as const });

  it("auto band applies legal name + spelling fix, stamps verified", () => {
    const d = decideBrandReconcile({ ...base, name: "ACME" }, scored(97, { name: "Acme, Inc." }), []);
    expect(d.action).toBe("applied");
    expect(d.verified).toBe(true);
    expect(d.changes.legalName).toBe("Acme, Inc.");
    expect(d.changes.name).toBe("Acme, Inc.");
  });

  it("auto band NEVER renames a genuinely different name — it notes it instead", () => {
    const d = decideBrandReconcile(base, scored(97, { name: "Initech" }), []);
    expect(d.action).toBe("applied");
    expect(d.changes.name).toBeUndefined();
    expect(d.notes.join(" ")).toContain("not auto-renamed");
  });

  it("a name override is supreme even in the auto band", () => {
    const d = decideBrandReconcile(
      { ...base, name: "ACME", brandOverride: { name: "ACME", byUserId: 1, at: "2026-08-11T00:00:00Z" } },
      scored(97, { name: "Acme" }),
      [],
    );
    expect(d.changes.name).toBeUndefined();
  });

  it("corroborated band fills an empty domain ONLY with the account's own evidence", () => {
    const acc = { ...base, domain: null };
    const uncorroborated = decideBrandReconcile(acc, { hit: hit(), confidence: 88, basis: "name_exact" }, []);
    expect(uncorroborated.action).toBe("candidate");
    expect(uncorroborated.changes).toEqual({});

    const corroborated = decideBrandReconcile(acc, { hit: hit(), confidence: 88, basis: "name_exact" }, ["acme.com"]);
    expect(corroborated.action).toBe("corroborated");
    expect(corroborated.changes.domain).toBe("acme.com");
    expect(corroborated.verified).toBe(true);
  });

  it("a domain override blocks the corroborated fill", () => {
    const d = decideBrandReconcile(
      { ...base, domain: null, brandOverride: { domain: "acme.org", byUserId: 1, at: "2026-08-11T00:00:00Z" } },
      { hit: hit(), confidence: 88, basis: "name_exact" },
      ["acme.com"],
    );
    expect(d.changes.domain).toBeUndefined();
  });

  it("candidate band and below change nothing", () => {
    expect(decideBrandReconcile(base, scored(70), []).action).toBe("candidate");
    expect(decideBrandReconcile(base, scored(70), []).changes).toEqual({});
    expect(decideBrandReconcile(base, scored(40), []).action).toBe("no_match");
    expect(decideBrandReconcile(base, null, []).action).toBe("no_match");
  });
});

describe("brandContentHash — change detection keys on identity, not representation", () => {
  it("display/URL noise hashes identically", () => {
    expect(brandContentHash("ACME Corp.", "https://www.acme.com/")).toBe(brandContentHash("Acme corp", "acme.com"));
  });
  it("a real identity change hashes differently", () => {
    expect(brandContentHash("Acme", "acme.com")).not.toBe(brandContentHash("Initech", "acme.com"));
    expect(brandContentHash("Acme", "acme.com")).not.toBe(brandContentHash("Acme", "acme.io"));
  });
});

describe("needsBrandRefresh — the cron's scan rule", () => {
  const now = new Date("2026-08-11T12:00:00Z");
  const acc = { name: "Acme", domain: "acme.com", brandVerifiedAt: null as Date | null };
  const qh = brandContentHash("Acme", "acme.com");

  it("never observed → refresh", () => {
    expect(needsBrandRefresh(acc, null, now)).toBe(true);
  });
  it("recent no-result sighting → negative-cached, no refresh", () => {
    expect(needsBrandRefresh(acc, { observedAt: new Date(now.getTime() - NEGATIVE_TTL_MS / 2), queryHash: qh }, now)).toBe(false);
  });
  it("stale no-result sighting → retry", () => {
    expect(needsBrandRefresh(acc, { observedAt: new Date(now.getTime() - NEGATIVE_TTL_MS - 1000), queryHash: qh }, now)).toBe(true);
  });
  it("verified recently → no refresh; verified stale → refresh", () => {
    const verified = { ...acc, brandVerifiedAt: new Date(now.getTime() - REFRESH_TTL_MS / 2) };
    expect(needsBrandRefresh(verified, { observedAt: verified.brandVerifiedAt!, queryHash: qh }, now)).toBe(false);
    const stale = { ...acc, brandVerifiedAt: new Date(now.getTime() - REFRESH_TTL_MS - 1000) };
    expect(needsBrandRefresh(stale, { observedAt: stale.brandVerifiedAt!, queryHash: qh }, now)).toBe(true);
  });
  it("identity changed since last query → immediate refresh, cache be damned", () => {
    const renamed = { name: "Acme Robotics", domain: "acme.com", brandVerifiedAt: new Date(now.getTime() - 1000) };
    expect(needsBrandRefresh(renamed, { observedAt: new Date(now.getTime() - 1000), queryHash: qh }, now)).toBe(true);
  });
});

describe("the sweep is wired and dormant-safe", () => {
  it("_core/index.ts registers the 6h cron", () => {
    const src = read("server/_core/index.ts");
    const anchor = src.indexOf("runBrandReconciliation()");
    expect(anchor).toBeGreaterThan(-1);
    const window = src.slice(anchor, anchor + 600);
    expect(window).toContain("setInterval(runBrandReconcile, 6 * 60 * 60 * 1000)");
  });

  it("runBrandReconciliation is a no-op without search config", async () => {
    const summary = await runBrandReconciliation({
      provider: { searchReady: () => false, searchBrand: async () => ({ ok: false, reason: "not_configured" }), logoUrl: () => null },
    });
    expect(summary).toEqual({ scanned: 0, searched: 0, applied: 0, corroborated: 0, candidates: 0, noMatch: 0, skipped: 0, failed: 0 });
  });
});

describe("candidate collection pages past the negative cache", () => {
  const now = new Date("2026-08-13T16:00:00Z");
  const recent = new Date(now.getTime() - 60_000);

  /** A row the negative cache holds back: fresh sighting, identity unchanged. */
  const cached = (id: number) => ({ id, workspaceId: 1, name: `Co ${id}`, domain: null, brandVerifiedAt: null });
  const obsFor = (rows: Array<{ id: number; name: string; domain: string | null }>) =>
    new Map(rows.map((r) => [r.id, { observedAt: recent, queryHash: brandContentHash(r.name, r.domain) }]));

  it("walks PAST a full page of negative-cached rows to reach eligible ones behind them", async () => {
    // 400 held-back rows then 5 fresh ones — the shape that made a single
    // capped window return "nothing to do" forever while 5 accounts waited.
    const pageOne = Array.from({ length: 400 }, (_, i) => cached(i + 1));
    const pageTwo = Array.from({ length: 5 }, (_, i) => cached(i + 401));
    const held = obsFor(pageOne); // page two has NO observations → eligible

    const { eligible, scanned, skipped } = await collectBrandCandidates(
      async (afterId, pageSize) => [...pageOne, ...pageTwo].filter((r) => r.id > afterId).slice(0, pageSize),
      async (ids) => new Map(ids.filter((id) => held.has(id)).map((id) => [id, held.get(id)!])),
      { limit: 30, now },
    );

    expect(eligible.map((e) => e.id)).toEqual([401, 402, 403, 404, 405]);
    expect(skipped).toBe(400);
    expect(scanned).toBe(405);
  });

  it("stops at the limit and does not read further pages", async () => {
    const all = Array.from({ length: 900 }, (_, i) => cached(i + 1));
    let pagesRead = 0;
    const { eligible } = await collectBrandCandidates(
      async (afterId, pageSize) => { pagesRead++; return all.filter((r) => r.id > afterId).slice(0, pageSize); },
      async () => new Map(),
      { limit: 30, now },
    );
    expect(eligible).toHaveLength(30);
    expect(pagesRead).toBe(1);
  });

  it("gives up after maxPages instead of scanning a whole table of held-back rows", async () => {
    const all = Array.from({ length: 10_000 }, (_, i) => cached(i + 1));
    let pagesRead = 0;
    const { eligible, skipped } = await collectBrandCandidates(
      async (afterId, pageSize) => { pagesRead++; return all.filter((r) => r.id > afterId).slice(0, pageSize); },
      async (ids) => new Map(ids.map((id) => [id, { observedAt: recent, queryHash: brandContentHash(`Co ${id}`, null) }])),
      { limit: 30, now, pageSize: 100, maxPages: 4 },
    );
    expect(pagesRead).toBe(4);
    expect(eligible).toHaveLength(0);
    expect(skipped).toBe(400);
  });

  it("a RENAMED account re-qualifies even with a fresh sighting (repair → re-search)", async () => {
    // repairUrlNamedAccounts rewrites names; those rows must not sit behind
    // the negative cache with their old query hash.
    const row = { id: 7, workspaceId: 1, name: "fanatics", domain: null, brandVerifiedAt: null };
    const { eligible } = await collectBrandCandidates(
      async (afterId) => (afterId === 0 ? [row] : []),
      async () => new Map([[7, { observedAt: recent, queryHash: brandContentHash("https://facebook.com/fanatics", null) }]]),
      { limit: 30, now },
    );
    expect(eligible.map((e) => e.id)).toEqual([7]);
  });
});

describe("reconciliation lives here — enrichment paths still never import the provider", () => {
  it("the reconciler is in services/company/, not in any enrichment file", () => {
    // The owner rule (structurally enforced in brandfetch.test.ts) forbids
    // enrichment modules from touching Brandfetch. The reconciler must stay
    // the ONLY automated caller — assert the sweep entry is where we say.
    const src = read("server/services/company/brandReconciler.ts");
    expect(src).toContain("export async function runBrandReconciliation");
    for (const rel of ["server/services/enrichment/comprehensivePass.ts", "server/services/enrichmentSweeper.ts", "server/routers/imports.ts"]) {
      expect(read(rel).includes("brandReconciler"), `${rel} must not trigger brand reconciliation`).toBe(false);
    }
  });
});
