/**
 * Contact-info lookup orchestrator.
 *
 * Pipeline for a single prospect:
 *   1. Resolve domain (from companyDomain, else parsed from companyWebsite)
 *   2. Scrape company website (cached 30d per domain)
 *   3. Generate 3 email patterns from name + domain
 *   4. Reoon-verify each pattern (stops early on first `valid`)
 *   5. Pick winning email by status priority, write back to prospect row
 *
 * Designed to be called from a single-prospect tRPC procedure or looped
 * by a small-batch handler. NEVER throws — always returns a structured
 * `LookupResult` with `skipReason` populated when nothing useful happened.
 */

import { eq, and } from "drizzle-orm";
import { getDb } from "../../db";
import { prospects } from "../../../drizzle/schema";
import {
  reoonVerifySingle,
  reoonStatusToUsip,
  getReoonApiKey,
  type VerificationStatus,
} from "../reoon";
import { normalizeDomain } from "./domain";
import { scrapeCompanySite, type ScrapedSite } from "./companySite";
import { readDomainCache, writeDomainCache } from "./domainCache";
import { generatePatterns, type EmailPattern } from "./emailPatterns";

/* ─── Types ────────────────────────────────────────────────────────────── */

export type PatternVerifyResult = {
  email: string;
  pattern: EmailPattern["pattern"];
  status: VerificationStatus;
  overallScore?: number;
};

export type EnrichmentData = {
  scrapedDomain: string | null;
  scrapedAt: string;
  emailsFound: string[];
  phonesFound: string[];
  socialUrls: string[];
  patternsVerified: PatternVerifyResult[];
  /** Set when we deliberately produced no useful output. */
  skipReason?: string;
};

export type LookupResult = {
  ok: boolean;
  /** Best email we found (after verification) — null if nothing deliverable. */
  email: string | null;
  emailStatus: VerificationStatus | null;
  /** First phone found on company site, if prospect had no phone before. */
  phone: string | null;
  enrichment: EnrichmentData;
  /** How many Reoon credits we burned on this prospect. */
  reoonCredits: number;
  /** Short human-readable summary, useful for toast messages. */
  message: string;
};

/* ─── Status priority ──────────────────────────────────────────────────── */

const STATUS_RANK: Record<VerificationStatus, number> = {
  valid: 4,
  accept_all: 3,
  risky: 2,
  unknown: 1,
  invalid: 0,
};

/* ─── Per-prospect lookup ──────────────────────────────────────────────── */

export type ProspectLookupInput = {
  workspaceId: number;
  prospectId: number;
  firstName: string;
  lastName: string;
  companyDomain: string | null;
  /** Free-form "Company Website" column from the CSV — fallback for domain. */
  companyWebsite?: string | null;
  /** If true, won't overwrite existing prospect.email. */
  skipIfHasEmail: boolean;
  /** Existing prospect.phone — only fill if null. */
  existingPhone: string | null;
};

export async function lookupContactInfo(
  input: ProspectLookupInput,
): Promise<LookupResult> {
  const scrapedAt = new Date().toISOString();
  const empty: EnrichmentData = {
    scrapedDomain: null,
    scrapedAt,
    emailsFound: [],
    phonesFound: [],
    socialUrls: [],
    patternsVerified: [],
  };

  // 1. Resolve domain
  const domain = normalizeDomain(input.companyDomain) ?? normalizeDomain(input.companyWebsite);
  if (!domain) {
    return {
      ok: false,
      email: null,
      emailStatus: null,
      phone: null,
      enrichment: { ...empty, skipReason: "no_domain" },
      reoonCredits: 0,
      message: "No company domain available — cannot search",
    };
  }

  // 2. Scrape company site (cached 30d)
  let scraped: ScrapedSite | null = await readDomainCache(domain);
  if (!scraped) {
    scraped = await scrapeCompanySite(domain);
    await writeDomainCache(domain, scraped);
  }

  const enrichment: EnrichmentData = {
    scrapedDomain: domain,
    scrapedAt,
    emailsFound: scraped.emails,
    phonesFound: scraped.phones,
    socialUrls: scraped.socialUrls,
    patternsVerified: [],
  };

  // If the caller already has an email and asked us not to overwrite, skip
  // the pattern + Reoon step entirely — we'd burn credits with no benefit.
  // The scrape (phones + socials) still ran and gets persisted.
  if (input.skipIfHasEmail) {
    const phone = pickPhone(scraped, input.existingPhone);
    const db = await getDb();
    if (db) {
      const update: Record<string, unknown> = { enrichmentData: enrichment };
      if (phone && !input.existingPhone) update.phone = phone;
      await db
        .update(prospects)
        .set(update)
        .where(
          and(
            eq(prospects.id, input.prospectId),
            eq(prospects.workspaceId, input.workspaceId),
          ),
        );
    }
    return {
      ok: true,
      email: null,
      emailStatus: null,
      phone,
      enrichment,
      reoonCredits: 0,
      message: "Already had an email — scraped site only (no verify)",
    };
  }

  // 3. Generate patterns
  const patterns = generatePatterns(input.firstName, input.lastName, domain);
  if (patterns.length === 0) {
    enrichment.skipReason = "no_name_for_patterns";
    return {
      ok: false,
      email: null,
      emailStatus: null,
      phone: pickPhone(scraped, input.existingPhone),
      enrichment,
      reoonCredits: 0,
      message: "Missing first or last name — cannot build email patterns",
    };
  }

  // 4. Verify patterns (early-stop on `valid`)
  let apiKey: string;
  try {
    apiKey = getReoonApiKey();
  } catch {
    enrichment.skipReason = "reoon_key_missing";
    return {
      ok: false,
      email: null,
      emailStatus: null,
      phone: pickPhone(scraped, input.existingPhone),
      enrichment,
      reoonCredits: 0,
      message: "REOON_API_KEY not configured",
    };
  }

  let credits = 0;
  for (const p of patterns) {
    try {
      const r = await reoonVerifySingle(p.email, apiKey);
      credits++;
      const status = reoonStatusToUsip(r.status);
      enrichment.patternsVerified.push({
        email: p.email,
        pattern: p.pattern,
        status,
        overallScore: r.overall_score,
      });
      if (status === "valid") break; // Early stop — save credits
    } catch (e) {
      enrichment.patternsVerified.push({
        email: p.email,
        pattern: p.pattern,
        status: "unknown",
      });
      // Continue trying other patterns; one transient Reoon error isn't fatal
      void e;
    }
  }

  // 5. Pick winning email + write back
  const winner = pickWinner(enrichment.patternsVerified);
  const phone = pickPhone(scraped, input.existingPhone);

  const db = await getDb();
  if (db) {
    const update: Record<string, unknown> = {
      enrichmentData: enrichment,
      emailVerifiedAt: new Date(),
    };
    // Only fill email if missing (or if we explicitly want to overwrite)
    if (winner && (!input.skipIfHasEmail)) {
      update.email = winner.email;
      update.emailStatus = winner.status;
    } else if (winner && input.skipIfHasEmail) {
      // Has existing email — just record verification, don't overwrite
    }
    if (phone && !input.existingPhone) {
      update.phone = phone;
    }
    await db
      .update(prospects)
      .set(update)
      .where(
        and(
          eq(prospects.id, input.prospectId),
          eq(prospects.workspaceId, input.workspaceId),
        ),
      );
  }

  return {
    ok: true,
    email: winner?.email ?? null,
    emailStatus: winner?.status ?? null,
    phone,
    enrichment,
    reoonCredits: credits,
    message: winner
      ? `Found ${winner.status} email (${winner.pattern})`
      : scraped.fetchError
        ? `Could not reach ${domain}: ${scraped.fetchError}`
        : "No deliverable email found",
  };
}

function pickWinner(
  results: PatternVerifyResult[],
): PatternVerifyResult | null {
  let best: PatternVerifyResult | null = null;
  for (const r of results) {
    if (r.status === "invalid") continue;
    if (!best || STATUS_RANK[r.status] > STATUS_RANK[best.status]) best = r;
  }
  return best;
}

function pickPhone(scraped: ScrapedSite, existing: string | null): string | null {
  if (existing) return existing; // Don't overwrite
  return scraped.phones[0] ?? null;
}
