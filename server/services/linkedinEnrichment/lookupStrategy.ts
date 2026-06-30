/**
 * LinkedIn lookup-strategy resolution (pure).
 *
 * Decides HOW to enrich a prospect the user clicked "Enrich" on — without ever
 * asking them for a URL. Priority order (per spec):
 *   1. existing prospect.linkedin_url
 *   2. CRM-imported LinkedIn URL (prospect.enrichmentData)
 *   3. LinkedIn URL from a prior enrichment record
 *   4. licensed enrichment-provider LinkedIn URL (enrichmentData)
 *   5. authorized Unipile name/company lookup (name + company/title/location)
 *   6. otherwise → unavailable (skip, don't fail the batch)
 */
import { validateLinkedInUrl } from "./mapper";

export type LookupStrategy =
  | "existing_prospect_linkedin_url"
  | "crm_imported_linkedin_url"
  | "prior_enrichment_linkedin_url"
  | "enrichment_provider_linkedin_url"
  | "unipile_name_company_lookup"
  | "unavailable";

export interface ProspectForLookup {
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  company?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  linkedinUrl?: string | null;
  enrichmentData?: unknown;
}

/** Pull a LinkedIn URL out of the prospect's free-form enrichmentData JSON. */
function urlFromEnrichmentData(data: unknown, keys: string[]): string | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && validateLinkedInUrl(v).valid) return v;
  }
  return null;
}

/** Can we attempt an authorized name/company lookup? (need a name + context) */
export function canUseNameCompanyLookup(p: ProspectForLookup): boolean {
  const hasName = !!(p.firstName && p.lastName);
  const hasContext = !!(p.company || p.title || p.city || p.country);
  return hasName && hasContext;
}

export function determineLookupStrategy(
  p: ProspectForLookup,
  priorEnrichmentUrl?: string | null,
): { strategy: LookupStrategy; url: string | null } {
  if (p.linkedinUrl && validateLinkedInUrl(p.linkedinUrl).valid) {
    return { strategy: "existing_prospect_linkedin_url", url: p.linkedinUrl };
  }
  const crm = urlFromEnrichmentData(p.enrichmentData, ["linkedinUrl", "linkedin_url", "linkedin", "crmLinkedinUrl"]);
  if (crm) return { strategy: "crm_imported_linkedin_url", url: crm };

  if (priorEnrichmentUrl && validateLinkedInUrl(priorEnrichmentUrl).valid) {
    return { strategy: "prior_enrichment_linkedin_url", url: priorEnrichmentUrl };
  }
  const provider = urlFromEnrichmentData(p.enrichmentData, ["providerLinkedinUrl", "enrichmentProviderLinkedinUrl"]);
  if (provider) return { strategy: "enrichment_provider_linkedin_url", url: provider };

  if (canUseNameCompanyLookup(p)) {
    return { strategy: "unipile_name_company_lookup", url: null };
  }
  return { strategy: "unavailable", url: null };
}
