/**
 * prospectSources.ts — the ONE vocabulary for external prospect-data vendors.
 *
 * Shared by the server registry (which enforces it) and the client (which
 * renders the union of every source's filters and the per-source "can this
 * source honour my query?" strip). Pure data + pure functions only — no
 * imports, so it can be loaded by either side and by tests.
 *
 * Why a capability manifest at all: sources are not interchangeable. A
 * directory that keyword-matches a title against a description blob is not
 * title filtering. Declaring it "approximated" lets the UI show a weaker
 * match and lets the waterfall rank that source below one that filters on
 * the title natively — instead of blending a strong result set with a weak
 * one and paying several vendors for the same person.
 */

/** Every filter a search can carry. A source declares which it can honour. */
export const FILTER_TYPES = [
  "jobTitle",
  "seniority",
  "department",
  "industry",
  "country",
  "stateProvince",
  "city",
  "postalCode",
  "companyName",
  "companyDomain",
  "headcountRange",
  "revenueRange",
  "keyword",
  "hasEmail",
  "hasPhone",
  "technology",
] as const;
export type FilterType = (typeof FILTER_TYPES)[number];

export const FILTER_LABELS: Record<FilterType, string> = {
  jobTitle: "Job title",
  seniority: "Seniority",
  department: "Department",
  industry: "Industry",
  country: "Country",
  stateProvince: "State / province",
  city: "City",
  postalCode: "Postal code",
  companyName: "Company name",
  companyDomain: "Company domain",
  headcountRange: "Company size",
  revenueRange: "Revenue range",
  keyword: "Keyword",
  hasEmail: "Has email",
  hasPhone: "Has phone",
  technology: "Technology",
};

/** The vendor slugs the registry knows. A slug may appear here ONLY if the
 *  registry has an adapter for it (a stub that says "not implemented" counts:
 *  the UI shows it as "available, not configured"). */
export const PROSPECT_SOURCE_SLUGS = [
  "warmysender",
  "quickenrich",
  "apollo",
  "leadocean",
  "hunter",
  "lemlist",
] as const;
export type ProspectSourceSlug = (typeof PROSPECT_SOURCE_SLUGS)[number];

/**
 * What a source can do. Declared per adapter; the registry never guesses.
 *
 * `supportedFilters` — honoured natively by the vendor's own filter.
 * `approximatedFilters` — accepted, but applied loosely (keyword-matched).
 * `supportsFreePreview` — results can be seen before anything is spent.
 * `returnsMaskedPreview` — the preview hides the email until acquisition.
 * `geographicCoverage` — ISO-3166 alpha-2 codes; empty means global.
 */
export interface SourceCapabilities {
  supportedFilters: FilterType[];
  approximatedFilters: FilterType[];
  supportsFreePreview: boolean;
  returnsMaskedPreview: boolean;
  supportsMobilePhone: boolean;
  supportsVerification: boolean;
  maxBatchSize: number;
  geographicCoverage: string[];
}

/**
 * LeadOcean's manifest (read from https://api.leadocean.io/openapi.json,
 * 2026-11-02). Its preview is NOT free: every search row counts one record, so
 * a person costs two, the row and the lookup that finds their address. That is
 * why it never starts ticked anywhere (ARE_OPT_IN_SOURCES, eligibleFor).
 *
 * Three filters are declared approximated, each for a real reason:
 *   stateProvince — there is no person-level state filter. `hqState` filters the
 *                   EMPLOYER's headquarters; the adapter checks the person's own
 *                   address afterwards.
 *   department    — mapped onto LeadOcean's closed list of job functions.
 *   industry      — free text goes to `companyKeywords` unless every value is an
 *                   exact label in its industry list.
 */
export const LEADOCEAN_CAPABILITIES: SourceCapabilities = {
  supportedFilters: ["jobTitle", "seniority", "country", "city", "companyName", "companyDomain", "headcountRange", "keyword", "hasEmail", "hasPhone", "technology"],
  approximatedFilters: ["stateProvince", "department", "industry"],
  supportsFreePreview: false,
  returnsMaskedPreview: true,
  supportsMobilePhone: true,
  supportsVerification: false,
  maxBatchSize: 100,
  geographicCoverage: [],
};

/** The email statuses a workspace may accept from LeadOcean, safest first. */
export const LEADOCEAN_EMAIL_STATUSES = ["verified", "catch_all_valid", "catch_all", "untested", "role", "risky", "derived", "unknown"] as const;
export type LeadoceanEmailStatus = (typeof LEADOCEAN_EMAIL_STATUSES)[number];

/** LeadOcean's own words for each (x-enum-labels in its spec). */
export const LEADOCEAN_EMAIL_STATUS_LABELS: Record<LeadoceanEmailStatus, string> = {
  verified: "Deliverable",
  catch_all_valid: "Catch-all, mailbox confirmed",
  catch_all: "Catch-all domain",
  untested: "Not yet checked",
  role: "Role address",
  risky: "Risky",
  derived: "Derived, not verified",
  unknown: "Unknown",
};

export const LEADOCEAN_DEFAULT_EMAIL_STATUSES: LeadoceanEmailStatus[] = ["verified"];

/** Never accepted, whatever a workspace's settings say. */
export const LEADOCEAN_NEVER_ACCEPT = ["invalid", "disposable", "spam_trap", "abuse"] as const;

/** All the work-email door ever answers with; anything looser needs the full lookup. */
export const LEADOCEAN_WORK_EMAIL_STATUSES: readonly string[] = ["verified", "catch_all_valid", "catch_all"];

/**
 * What a stored setting means: known statuses only, none of the never-accepted
 * ones, and `verified` when nothing usable is left. `catch_all` brings
 * `catch_all_valid` with it, because a mailbox confirmed on a catch-all domain
 * is strictly better, and LeadOcean's own filter treats them the same way.
 */
export function leadoceanAcceptedStatuses(raw: unknown): LeadoceanEmailStatus[] {
  const known = new Set<string>(LEADOCEAN_EMAIL_STATUSES);
  const picked = Array.isArray(raw) ? raw.filter((s): s is LeadoceanEmailStatus => typeof s === "string" && known.has(s)) : [];
  if (picked.length === 0) return [...LEADOCEAN_DEFAULT_EMAIL_STATUSES];
  const out = Array.from(new Set<LeadoceanEmailStatus>(picked));
  if (out.indexOf("catch_all") !== -1 && out.indexOf("catch_all_valid") === -1) out.push("catch_all_valid");
  return out;
}

/** Phones, or a status the work-email door never returns, need the full lookup. */
export function leadoceanUsesFullLookup(accepted: readonly string[], fetchPhones: boolean): boolean {
  return fetchPhones || accepted.some((s) => LEADOCEAN_WORK_EMAIL_STATUSES.indexOf(s) === -1);
}

/** The normalized search every adapter receives. Empty arrays mean "not set". */
export interface SearchCriteria {
  jobTitles: string[];
  seniorities: string[];
  departments: string[];
  industries: string[];
  countries: string[];
  stateProvinces: string[];
  cities: string[];
  postalCodes: string[];
  companyNames: string[];
  companyDomains: string[];
  headcountRange?: { min?: number; max?: number };
  revenueRange?: { min?: number; max?: number };
  keywords: string[];
  hasEmail?: boolean;
  hasPhone?: boolean;
  technologies: string[];
}

export function emptyCriteria(): SearchCriteria {
  return {
    jobTitles: [], seniorities: [], departments: [], industries: [], countries: [],
    stateProvinces: [], cities: [], postalCodes: [], companyNames: [], companyDomains: [],
    keywords: [], technologies: [],
  };
}

/** The filters a criteria object actually sets (non-empty). */
export function activeFilters(c: SearchCriteria): FilterType[] {
  const out: FilterType[] = [];
  if (c.jobTitles.length) out.push("jobTitle");
  if (c.seniorities.length) out.push("seniority");
  if (c.departments.length) out.push("department");
  if (c.industries.length) out.push("industry");
  if (c.countries.length) out.push("country");
  if (c.stateProvinces.length) out.push("stateProvince");
  if (c.cities.length) out.push("city");
  if (c.postalCodes.length) out.push("postalCode");
  if (c.companyNames.length) out.push("companyName");
  if (c.companyDomains.length) out.push("companyDomain");
  if (c.headcountRange && (c.headcountRange.min != null || c.headcountRange.max != null)) out.push("headcountRange");
  if (c.revenueRange && (c.revenueRange.min != null || c.revenueRange.max != null)) out.push("revenueRange");
  if (c.keywords.length) out.push("keyword");
  if (c.hasEmail !== undefined) out.push("hasEmail");
  if (c.hasPhone !== undefined) out.push("hasPhone");
  if (c.technologies.length) out.push("technology");
  return out;
}

/**
 * The per-source verdict for one query. `full` = every active filter is
 * native; `approximate` = every active filter is at least approximated, and
 * `approximated` names the loose ones; `cannot` = at least one active filter
 * the source neither supports nor approximates (`missing` names them).
 *
 * A query with NO active filters is "cannot" for every source: searching a
 * vendor's entire database is never an audience, and several vendors 422 or
 * bill for it.
 */
export interface CapabilityMatch {
  verdict: "full" | "approximate" | "cannot";
  approximated: FilterType[];
  missing: FilterType[];
}

export function matchCapabilities(caps: SourceCapabilities, criteria: SearchCriteria): CapabilityMatch {
  const active = activeFilters(criteria);
  if (active.length === 0) return { verdict: "cannot", approximated: [], missing: [] };
  const supported = new Set<FilterType>(caps.supportedFilters);
  const approx = new Set<FilterType>(caps.approximatedFilters);
  const approximated: FilterType[] = [];
  const missing: FilterType[] = [];
  for (let i = 0; i < active.length; i++) {
    const f = active[i];
    if (supported.has(f)) continue;
    if (approx.has(f)) approximated.push(f);
    else missing.push(f);
  }
  // Geography: a source with declared coverage cannot honour a country it
  // does not cover. Country codes are compared case-insensitively; a country
  // given as a name (not a code) is left to the adapter's own mapping.
  if (criteria.countries.length > 0 && caps.geographicCoverage.length > 0) {
    const cov = new Set(caps.geographicCoverage.map((c) => c.toUpperCase()));
    const codes = criteria.countries.filter((c) => /^[A-Za-z]{2}$/.test(c.trim()));
    if (codes.length > 0 && codes.every((c) => !cov.has(c.trim().toUpperCase()))) {
      if (missing.indexOf("country") === -1) missing.push("country");
    }
  }
  if (missing.length > 0) return { verdict: "cannot", approximated, missing };
  if (approximated.length > 0) return { verdict: "approximate", approximated, missing };
  return { verdict: "full", approximated, missing };
}

/** The union of filters across a set of manifests — what the search UI renders. */
export function filterUnion(manifests: SourceCapabilities[]): FilterType[] {
  const seen = new Set<FilterType>();
  for (let i = 0; i < manifests.length; i++) {
    const m = manifests[i];
    for (let j = 0; j < m.supportedFilters.length; j++) seen.add(m.supportedFilters[j]);
    for (let j = 0; j < m.approximatedFilters.length; j++) seen.add(m.approximatedFilters[j]);
  }
  return FILTER_TYPES.filter((f) => seen.has(f));
}

/**
 * Default checking order across vendors when the workspace has not ordered
 * them: sources with a free preview first (search costs nothing, spend is
 * only on net-new records), then everything else. Within a tier, a source
 * that filters the LEAD filter natively outranks one that approximates it —
 * so a title-led query prefers a title-capable source. Pure; the registry
 * applies the workspace's explicit order on top.
 */
export function rankSourcesForQuery<T extends { slug: string; capabilities: SourceCapabilities }>(
  sources: T[],
  criteria: SearchCriteria,
): T[] {
  const active = activeFilters(criteria);
  const lead = active[0];
  const score = (s: T): number => {
    let n = 0;
    if (s.capabilities.supportsFreePreview) n += 100;
    const m = matchCapabilities(s.capabilities, criteria);
    if (m.verdict === "full") n += 20;
    else if (m.verdict === "approximate") n += 10;
    if (lead && s.capabilities.supportedFilters.indexOf(lead) !== -1) n += 5;
    return n;
  };
  return sources
    .map((s, i) => ({ s, i, n: score(s) }))
    .sort((a, b) => (b.n - a.n) || (a.i - b.i))
    .map((x) => x.s);
}

/** Credential status vocabulary (mirrors the DB enum). */
export const CREDENTIAL_STATUSES = ["unvalidated", "valid", "invalid", "revoked"] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

/** Budget buckets a source may meter. A source declares the ones it uses. */
export type BudgetBucket = "leads" | "verification" | "lookups";
export type BudgetGranularity = "daily" | "monthly" | "credits";
