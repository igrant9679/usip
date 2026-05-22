/**
 * Shared builder for prospect rows created by the scraper sources
 * (Google Places, URL scraper, LinkedIn finder).
 *
 * Before this module each save path invented its own placeholder
 * conventions ("(business)" / "(via URL)" / "(LinkedIn)") and the URL
 * path stuffed arbitrary page URLs into the `linkedinUrl` column — which
 * poisons the LeadRocks importer's linkedinUrl-based dedup. This
 * centralizes one convention.
 *
 * Synthetic-name detection is anchored to the lastName SENTINEL, not to
 * enrichmentData, because the contact-info scraper later OVERWRITES
 * enrichmentData with its own shape — so an enrichmentData-only flag
 * would silently stop working after the first "Find contact info" run
 * and the second run would generate garbage email patterns again.
 */

/** Sentinel lastName marking a company-level (non-person) prospect. */
export const SYNTHETIC_LAST_NAME = "(company)";
const UNKNOWN_FIRST = "(unknown)";
const UNKNOWN_LAST = "(prospect)";

export type ScrapedProspectSource =
  | "google_places"
  | "url_scraper"
  | "linkedin_finder";

export type ScrapedProspectInput = {
  workspaceId: number;
  source: ScrapedProspectSource;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  companyDomain?: string | null;
  /** A genuine linkedin.com profile URL. Non-LinkedIn URLs are dropped. */
  linkedinUrl?: string | null;
  /** Originating page/source URL (any host). Stored in enrichmentData. */
  sourceUrl?: string | null;
  /** True when firstName carries a company name, not a person (Places). */
  syntheticName?: boolean;
};

function isLinkedInUrl(u: string): boolean {
  try {
    return /(^|\.)linkedin\.com$/i.test(new URL(u).hostname);
  } catch {
    return false;
  }
}

/**
 * Produce the insert values + audit metadata for a scraped prospect.
 * The caller adds dedup logic and performs the insert with `.values()`.
 */
export function buildScrapedProspectValues(input: ScrapedProspectInput): {
  values: Record<string, unknown>;
  entityType: string;
  audit: Record<string, unknown>;
} {
  const rawFirst = (input.firstName ?? "").trim();
  const rawLast = (input.lastName ?? "").trim();

  let firstName: string;
  let lastName: string;
  if (input.syntheticName) {
    firstName = rawFirst || (input.company ?? "").trim() || UNKNOWN_FIRST;
    lastName = SYNTHETIC_LAST_NAME;
  } else if (!rawFirst && !rawLast) {
    firstName = UNKNOWN_FIRST;
    lastName = UNKNOWN_LAST;
  } else {
    firstName = rawFirst || UNKNOWN_FIRST;
    lastName = rawLast || UNKNOWN_LAST;
  }

  // Only persist linkedinUrl when it's genuinely a LinkedIn URL. A blog /
  // news / Crunchbase page URL must NOT land in linkedinUrl — the
  // LeadRocks importer dedups on that column and would treat unrelated
  // pages as duplicate "profiles".
  const linkedinUrl =
    input.linkedinUrl && isLinkedInUrl(input.linkedinUrl)
      ? input.linkedinUrl
      : undefined;

  const enrichmentData: Record<string, unknown> = { source: input.source };
  if (input.sourceUrl) enrichmentData.sourceUrl = input.sourceUrl;
  if (input.syntheticName) enrichmentData.syntheticName = true;

  return {
    values: {
      workspaceId: input.workspaceId,
      firstName,
      lastName,
      // prospects.title is varchar(120); LinkedIn headlines routinely run
      // longer, so truncate rather than let the insert fail "Data too long".
      title: input.title?.trim().slice(0, 120) || undefined,
      email: input.email?.trim() || undefined,
      phone: input.phone?.trim() || undefined,
      company: input.company?.trim() || undefined,
      companyDomain: input.companyDomain?.trim() || undefined,
      linkedinUrl,
      enrichmentData,
    },
    entityType: `prospect_from_${input.source}`,
    audit: { source: input.source, sourceUrl: input.sourceUrl ?? null },
  };
}

/**
 * True if a prospect row is a synthetic (company-level) prospect — the
 * contact-info scraper must skip email-pattern generation + Reoon for
 * these. Anchored to the lastName sentinel so it survives enrichmentData
 * being overwritten; falls back to the legacy enrichmentData flag for
 * any rows created before this convention landed.
 */
export function isSyntheticNameProspect(row: {
  lastName?: string | null;
  enrichmentData?: unknown;
}): boolean {
  if (row.lastName === SYNTHETIC_LAST_NAME) return true;
  const ed = row.enrichmentData;
  return (
    !!ed &&
    typeof ed === "object" &&
    (ed as { syntheticName?: unknown }).syntheticName === true
  );
}
