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
  /** Which Reoon mode produced this status. */
  mode: "quick" | "power";
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
  /** Total Reoon credits burned (sum of quick + power). */
  reoonCredits: number;
  /** Reoon `instant_credits` consumed (mode=quick pre-filter). */
  reoonCreditsQuick: number;
  /** Reoon `daily_credits` consumed (mode=power confirmation). */
  reoonCreditsPower: number;
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
  /**
   * True when firstName/lastName are synthetic placeholders (e.g. a
   * Google-Places business saved as a prospect: firstName="Acme Dental",
   * lastName="(business)"). The company-site scrape (phones/socials) still
   * runs and is persisted, but email-pattern generation + Reoon are
   * skipped — generating "acmedental.business@domain" and burning Reoon
   * credits on it is pure waste.
   */
  syntheticName?: boolean;
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
      reoonCreditsQuick: 0,
      reoonCreditsPower: 0,
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

  // Synthetic-name prospect (e.g. a Google-Places business): the scrape
  // (phones/socials) is still valuable and gets persisted, but generating
  // email patterns from "Acme Dental / (business)" and Reoon-verifying
  // them is pure waste. Skip pattern-gen + Reoon entirely.
  if (input.syntheticName) {
    enrichment.skipReason = "synthetic_name";
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
      reoonCreditsQuick: 0,
      reoonCreditsPower: 0,
      message: "Business prospect — scraped site for phone/socials (no email patterns)",
    };
  }

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
      reoonCreditsQuick: 0,
      reoonCreditsPower: 0,
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
      reoonCreditsQuick: 0,
      reoonCreditsPower: 0,
      message: "Missing first or last name — cannot build email patterns",
    };
  }

  // 4. Two-stage verification: quick filter → power confirm.
  //
  // Stage A: run all 3 patterns through mode=quick (consumes the cheap
  //   `instant_credits` pool). Drop anything quick rules as 'invalid'.
  // Stage B: run survivors through mode=power (consumes the limited
  //   `daily_credits` pool). Early-stop on first 'valid' match.
  //
  // Why this is cheaper on average: most fake patterns are caught by
  // quick mode (syntax/MX/disposable/role-account). Without the pre-filter
  // every pattern would burn 1 daily credit; with it, daily credits are
  // only spent on plausible candidates.
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
      reoonCreditsQuick: 0,
      reoonCreditsPower: 0,
      message: "REOON_API_KEY not configured",
    };
  }

  let creditsQuick = 0;
  let creditsPower = 0;

  // Stage A — quick filter. All patterns share the cheap instant-credit
  // pool and don't depend on each other, so fire them in parallel (one
  // batched round-trip) instead of sequentially. Results are processed in
  // pattern order afterwards so survivor ordering — and thus the power
  // stage's early-stop on the most-likely pattern — is unchanged.
  type QuickResult = { pattern: EmailPattern; quickStatus: VerificationStatus };
  const survivors: QuickResult[] = [];
  const quickResults = await Promise.all(
    patterns.map(async (p) => {
      try {
        const r = await reoonVerifySingle(p.email, apiKey, "quick");
        return { pattern: p, status: reoonStatusToUsip(r.status), overallScore: r.overall_score, ok: true as const };
      } catch {
        // Quick mode unreachable — be conservative and still try power on
        // this candidate (don't drop on transient errors).
        return { pattern: p, status: "unknown" as VerificationStatus, overallScore: undefined, ok: false as const };
      }
    }),
  );
  for (const qr of quickResults) {
    if (qr.ok) creditsQuick++;
    // Record the quick result so the UI can show what was tried.
    enrichment.patternsVerified.push({
      email: qr.pattern.email,
      pattern: qr.pattern.pattern,
      status: qr.status,
      overallScore: qr.overallScore,
      mode: "quick",
    });
    // Drop only on confident invalid. 'unknown' (quick didn't have a
    // cached answer) still escalates to power.
    if (qr.status !== "invalid") survivors.push({ pattern: qr.pattern, quickStatus: qr.status });
  }

  // Stage B — power confirmation on survivors. Order by prior (the
  // generator already returns them in descending-prior order), so the
  // most-likely pattern gets the first power probe and triggers early-stop.
  for (const s of survivors) {
    try {
      const r = await reoonVerifySingle(s.pattern.email, apiKey, "power");
      creditsPower++;
      const status = reoonStatusToUsip(r.status);
      enrichment.patternsVerified.push({
        email: s.pattern.email,
        pattern: s.pattern.pattern,
        status,
        overallScore: r.overall_score,
        mode: "power",
      });
      if (status === "valid") break; // Early stop — saves remaining power credits
    } catch (e) {
      enrichment.patternsVerified.push({
        email: s.pattern.email,
        pattern: s.pattern.pattern,
        status: "unknown",
        mode: "power",
      });
      void e;
    }
  }

  // 5. Pick winning email + write back. Power results win ties — see pickWinner.
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
    reoonCredits: creditsQuick + creditsPower,
    reoonCreditsQuick: creditsQuick,
    reoonCreditsPower: creditsPower,
    message: winner
      ? `Found ${winner.status} email (${winner.pattern}, ${winner.mode})`
      : scraped.fetchError
        ? `Could not reach ${domain}: ${scraped.fetchError}`
        : "No deliverable email found",
  };
}

/**
 * Pick the winning email across all verification results.
 *
 * Priority:
 *   1. Status rank (valid > accept_all > risky > unknown), invalid dropped
 *   2. Mode (power > quick) — power is SMTP-confirmed, quick is heuristic
 *   3. Pattern prior (caller already sorts by this; we just keep the first)
 */
function pickWinner(
  results: PatternVerifyResult[],
): PatternVerifyResult | null {
  let best: PatternVerifyResult | null = null;
  for (const r of results) {
    if (r.status === "invalid") continue;
    if (!best) {
      best = r;
      continue;
    }
    const statusDelta = STATUS_RANK[r.status] - STATUS_RANK[best.status];
    if (statusDelta > 0) {
      best = r;
    } else if (statusDelta === 0 && r.mode === "power" && best.mode === "quick") {
      // Same status — prefer the power-confirmed one
      best = r;
    }
  }
  return best;
}

function pickPhone(scraped: ScrapedSite, existing: string | null): string | null {
  if (existing) return existing; // Don't overwrite
  return scraped.phones[0] ?? null;
}
