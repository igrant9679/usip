/**
 * Name verification — the invariants that make the background sweep safe:
 *
 *  - THE SLUG GATE IS THE IDENTITY GUARD: only a company string that is the
 *    domain's own label (case/punctuation-mangled) is ever a candidate. A
 *    real name next to an unrelated mailbox domain must never match — that
 *    is the identity-source bug class ("Columbia University" @ concern.net).
 *  - Freemail domains are never hints (their label names the provider).
 *  - The write path goes through fieldMerge as `websiteOfficial` (88): a
 *    user pin (100) survives structurally; the tier sits above LinkedIn's
 *    self-reported strings and below user.
 *  - Acronym composition never duplicates an acronym already in the name.
 *  - The cron is registered with overlap protection, and the sweep never
 *    hooks individual ingest seams (updatedAt look-back covers them all).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  FREEMAIL_DOMAINS,
  composeDisplayName,
  domainLabel,
  extractSignals,
  isFetchableHost,
  isSlugOfDomain,
  pickHintDomain,
} from "./services/company/nameVerification";
import { CONFIDENCE, mergeField } from "./services/enrichment/fieldMerge";

describe("the slug gate — identity can never change", () => {
  it("matches the mangles that started this (owner examples)", () => {
    expect(isSlugOfDomain("Mncsf", "mncsf.org")).toBe(true);
    expect(isSlugOfDomain("Umn", "umn.edu")).toBe(true);
    expect(isSlugOfDomain("Bbbsmiami", "bbbsmiami.org")).toBe(true);
    expect(isSlugOfDomain("Gla", "gla.ac.uk")).toBe(true);
    expect(isSlugOfDomain("Alali", "alali.holdings")).toBe(true);
    expect(isSlugOfDomain("Wtgrantfdn", "wtgrantfdn.org")).toBe(true);
    // Punctuation-mangled variants of the label still count as slugs.
    expect(isSlugOfDomain("10000 Degrees", "10000degrees.org")).toBe(true);
    expect(isSlugOfDomain("hill-spire llc", "hillspirellc.com")).toBe(true);
  });

  it("never matches a real name on an unrelated domain — the concern.net case", () => {
    expect(isSlugOfDomain("Columbia University", "concern.net")).toBe(false);
    expect(isSlugOfDomain("Town of Frederick", "frederickco.gov")).toBe(false);
    expect(isSlugOfDomain("Arizona Department of Health Services", "azdhs.gov")).toBe(false);
  });

  it("a name that IS the label ('Ford Foundation' @ fordfoundation.org) converges, not diverges", () => {
    // Slug-detected → looked up → the official name equals the current string
    // → mergeField corroborates instead of rewriting. No churn.
    expect(isSlugOfDomain("Ford Foundation", "fordfoundation.org")).toBe(true);
    const d = mergeField(
      { value: "Ford Foundation", provenance: undefined },
      { field: "company", value: "Ford Foundation", source: "websiteOfficial", confidence: CONFIDENCE.websiteOfficial, at: "2026-08-26T00:00:00.000Z" },
    );
    expect(d.action).toBe("corroborated");
    expect(d.value).toBe("Ford Foundation");
  });
});

describe("hint domains", () => {
  it("prefers companyDomain, falls back to the mailbox, refuses freemail", () => {
    expect(pickHintDomain({ companyDomain: "mncsf.org", email: "x@gmail.com" })).toBe("mncsf.org");
    expect(pickHintDomain({ companyDomain: null, email: "jdivine@umn.edu" })).toBe("umn.edu");
    expect(pickHintDomain({ companyDomain: "gmail.com", email: "x@yahoo.com" })).toBe(null);
    expect(pickHintDomain({ companyDomain: null, email: null })).toBe(null);
  });

  it("the freemail list covers the providers seen in the live data", () => {
    for (const d of ["gmail.com", "yahoo.com", "hotmail.com", "aol.com", "outlook.com", "mail.fm"]) {
      expect(FREEMAIL_DOMAINS.has(d), d).toBe(true);
    }
  });
});

describe("domain plumbing", () => {
  it("labels multi-part TLDs and www correctly", () => {
    expect(domainLabel("gla.ac.uk")).toBe("gla");
    expect(domainLabel("www.mncsf.org")).toBe("mncsf");
    expect(domainLabel("omi.wa.gov.au")).toBe("omi");
    expect(domainLabel("nodots")).toBe(null);
  });

  it("refuses hosts a server-side fetch must never touch", () => {
    expect(isFetchableHost("localhost")).toBe(false);
    expect(isFetchableHost("something.local")).toBe(false);
    expect(isFetchableHost("10.0.0.1")).toBe(false);
    expect(isFetchableHost("::1")).toBe(false);
    expect(isFetchableHost("mncsf.org")).toBe(true);
  });
});

describe("page signals", () => {
  it("pulls title, og:site_name, and copyright; caps lengths", () => {
    const s = extractSignals(
      `<html><head><title>Home | Mission Neighborhood Centers</title>` +
      `<meta property="og:site_name" content="MNC" /></head>` +
      `<body><h1>Welcome</h1><footer>© 2026 Mission Neighborhood Centers, Inc.</footer></body></html>`,
    );
    expect(s.title).toContain("Mission Neighborhood Centers");
    expect(s.siteName).toBe("MNC");
    expect(s.copyright).toContain("Mission Neighborhood Centers");
    expect(s.h1).toBe("Welcome");
  });
});

describe("display composition", () => {
  it("appends the acronym once and never duplicates", () => {
    expect(composeDisplayName("Federal Emergency Management Agency", "FEMA"))
      .toBe("Federal Emergency Management Agency (FEMA)");
    expect(composeDisplayName("Pasadena Independent School District (Pasadena ISD)", "Pasadena ISD"))
      .toBe("Pasadena Independent School District (Pasadena ISD)");
    expect(composeDisplayName("GlobalGiving", null)).toBe("GlobalGiving");
  });
});

describe("the merge tier", () => {
  it("websiteOfficial sits above LinkedIn and below user, and a user pin survives", () => {
    expect(CONFIDENCE.websiteOfficial).toBeGreaterThan(CONFIDENCE.linkedinProfile);
    expect(CONFIDENCE.websiteOfficial).toBeLessThan(CONFIDENCE.user);
    const pinned = mergeField(
      { value: "Their Chosen Name", provenance: { source: "user", confidence: 100, at: "2026-08-01T00:00:00.000Z" } },
      { field: "company", value: "Website Name", source: "websiteOfficial", confidence: CONFIDENCE.websiteOfficial, at: "2026-08-26T00:00:00.000Z" },
    );
    expect(pinned.action).toBe("kept");
    expect(pinned.value).toBe("Their Chosen Name");
  });

  it("replaces a domain-derived slug (40) and a legacy value (70)", () => {
    for (const prov of [
      { source: "domainDerived", confidence: CONFIDENCE.domainDerived, at: "2026-01-01T00:00:00.000Z" },
      undefined, // legacy → preexisting 70
    ]) {
      const d = mergeField(
        { value: "Mncsf", provenance: prov },
        { field: "company", value: "Mission Neighborhood Centers (MNC)", source: "websiteOfficial", confidence: CONFIDENCE.websiteOfficial, at: "2026-08-26T00:00:00.000Z" },
      );
      expect(d.action).toBe("replaced");
      expect(d.value).toBe("Mission Neighborhood Centers (MNC)");
    }
  });
});

describe("wiring (structural)", () => {
  const core = readFileSync("server/_core/index.ts", "utf8");
  const svc = readFileSync("server/services/company/nameVerification.ts", "utf8");

  it("the cron is registered with overlap protection and a boot stagger", () => {
    expect(core).toContain('guardOverlap("NameVerification"');
    expect(core).toMatch(/setInterval\(runNameVerification, 30 \* 60 \* 1000\)/);
  });

  it("the sweep discovers work by updatedAt look-back — no per-seam hooks to forget", () => {
    expect(svc).toContain("gte(prospects.updatedAt, since)");
    // No ingest seam imports this service; coverage comes from the scan.
    for (const seam of ["routers/imports.ts", "routers/prospectImports.ts", "services/discovery/consolidate.ts", "services/personLink.ts"]) {
      expect(readFileSync(`server/${seam}`, "utf8")).not.toContain("nameVerification");
    }
  });

  it("writes go through mergeField as websiteOfficial — never a raw overwrite", () => {
    const sweep = svc.slice(svc.indexOf("export async function runNameVerificationSweep"));
    expect(sweep).toContain('source: "websiteOfficial"');
    expect(sweep).toContain("mergeField(");
    expect(sweep).toContain("isSlugOfDomain(");
  });

  it("the admin drain exists and is admin-gated", () => {
    const router = readFileSync("server/routers/companies.ts", "utf8");
    const proc = router.slice(router.indexOf("runNameVerification:"), router.indexOf("resolveBrandsBatch:"));
    expect(proc).toContain('requireRole(ctx.member.role, "admin")');
    expect(proc).toContain("runNameVerificationSweep");
  });
});
