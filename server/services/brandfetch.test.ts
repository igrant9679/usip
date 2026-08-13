/**
 * Brandfetch passive layer — the guarantees that keep it compliant and
 * dormant-safe:
 *
 *  - the Logo Link builder is pure and produces the documented path-segment
 *    form (theme / size / fallback / type), with fallback/404 by default so
 *    the client cascade can act on unknown brands;
 *  - no client id or no plausible domain → null, never a broken URL;
 *  - searchBrand is DORMANT without config and never throws — timeouts,
 *    non-OK responses, and malformed payloads all return [];
 *  - a structural check that no enrichment path imports the provider —
 *    owner decision: prospect enrichment must never query Brandfetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brandfetchLogoUrl } from "../../shared/brandfetch";
import { createBrandfetchProvider } from "./brand/brandfetch";

afterEach(() => vi.unstubAllGlobals());

describe("brandfetchLogoUrl", () => {
  it("builds the documented path-segment URL", () => {
    const url = brandfetchLogoUrl("acme.com", "cid123", { theme: "dark", size: 64, type: "icon" });
    expect(url).toBe("https://cdn.brandfetch.io/acme.com/theme/dark/w/64/h/64/fallback/404/icon?c=cid123");
  });

  it("normalizes messy domains", () => {
    expect(brandfetchLogoUrl("https://www.Acme.com/about", "cid", {}))
      .toBe("https://cdn.brandfetch.io/acme.com/fallback/404?c=cid");
  });

  it("null without a client id — the tier silently disappears", () => {
    expect(brandfetchLogoUrl("acme.com", null, {})).toBeNull();
    expect(brandfetchLogoUrl("acme.com", "", {})).toBeNull();
  });

  it("null for implausible domains — no broken img requests", () => {
    expect(brandfetchLogoUrl("not a domain", "cid", {})).toBeNull();
    expect(brandfetchLogoUrl("", "cid", {})).toBeNull();
    expect(brandfetchLogoUrl(null, "cid", {})).toBeNull();
  });

  it("clamps size into the sane range", () => {
    expect(brandfetchLogoUrl("acme.com", "cid", { size: 9999 })).toContain("/w/512/h/512/");
    expect(brandfetchLogoUrl("acme.com", "cid", { size: 1 })).toContain("/w/16/h/16/");
  });
});

describe("createBrandfetchProvider — searchBrand", () => {
  it("is dormant without config: not ready, no fetch, and says so", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const p = createBrandfetchProvider({ logoClientId: null, searchClientId: null });
    expect(p.searchReady()).toBe(false);
    expect(await p.searchBrand("acme")).toEqual({ ok: false, reason: "not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps well-formed hits and caps the list", async () => {
    const hits = Array.from({ length: 15 }, (_, i) => ({ name: `Acme ${i}`, domain: `acme${i}.com`, icon: "https://x/i.png", brandId: `id${i}`, claimed: i === 0 }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => hits }) as unknown as Response));
    const p = createBrandfetchProvider({ searchClientId: "sid" });
    const out = await p.searchBrand("acme");
    expect(out.ok).toBe(true);
    expect(out.ok && out.hits).toHaveLength(10);
    expect(out.ok && out.hits[0]).toEqual({ name: "Acme 0", domain: "acme0.com", icon: "https://x/i.png", brandId: "id0", claimed: true });
  });

  it("an empty result set is a real answer: ok with no hits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response));
    const p = createBrandfetchProvider({ searchClientId: "sid" });
    expect(await p.searchBrand("nosuchbrand")).toEqual({ ok: true, hits: [] });
  });

  it("never throws, and never disguises a failure as an empty result", async () => {
    // This is the whole point: a dead key, a 429 and a network blip must not
    // look like "this brand does not exist" — that answer gets negative-cached
    // for a week by the reconciler.
    const p = createBrandfetchProvider({ searchClientId: "sid" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response));
    expect(await p.searchBrand("acme")).toEqual({ ok: false, reason: "auth", status: 401 });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }) as unknown as Response));
    expect(await p.searchBrand("acme")).toEqual({ ok: false, reason: "rate_limit", status: 429 });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response));
    expect(await p.searchBrand("acme")).toEqual({ ok: false, reason: "http", status: 503 });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ not: "an array" }) }) as unknown as Response));
    expect(await p.searchBrand("acme")).toEqual({ ok: false, reason: "malformed" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    expect(await p.searchBrand("acme")).toEqual({ ok: false, reason: "network" });
  });
});

describe("enrichment paths never query Brandfetch (owner decision)", () => {
  it("no enrichment module imports the brand provider", () => {
    const ROOT = join(__dirname, "..");
    const ENRICHMENT_FILES = [
      "services/enrichment/comprehensivePass.ts",
      "services/enrichment/fieldMerge.ts",
      "services/enrichment/companyCanonical.ts",
      "services/linkedinEnrichment/enrichmentService.ts",
      "services/enrichmentSweeper.ts",
      "services/company/enrichmentService.ts",
      "routers/imports.ts",
    ];
    for (const rel of ENRICHMENT_FILES) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src.includes("brand/brandfetch"), `${rel} must not touch Brandfetch`).toBe(false);
      expect(src.includes("api.brandfetch.io"), `${rel} must not call Brandfetch`).toBe(false);
    }
  });
});
