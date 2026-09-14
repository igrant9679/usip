/**
 * Prospect-source subsystem — the provider interface and its DTOs.
 *
 * THE ABSTRACTION IS THE DELIVERABLE; the vendors are plugins. Adding a
 * vendor means one adapter file implementing `ProspectSource` plus one entry
 * in registry.ts. The search UI, the waterfall executor and the budget
 * ledger never change for a new vendor.
 *
 * Immutable-by-convention: adapters return fresh objects, callers never
 * mutate them. Every field a vendor could disagree on carries provenance
 * downstream through fieldMerge (server/services/enrichment/fieldMerge.ts),
 * which is already the one field-level conflict rule in this codebase.
 */
import type {
  BudgetBucket,
  BudgetGranularity,
  ProspectSourceSlug,
  SearchCriteria,
  SourceCapabilities,
} from "@shared/prospectSources";

/** Decrypted vendor credentials for one workspace. Never logged. */
export interface SourceCredentials {
  slug: ProspectSourceSlug;
  workspaceId: number;
  /** The secret(s). WarmySender: { apiKey }. QuickEnrich/Apollo: { apiKey }. */
  secrets: Record<string, string>;
  /** Non-secret configuration stored beside the secret (billing anniversary
   *  day, plan allowance, purchased credit balance, captured tool schema …). */
  config: Record<string, unknown>;
}

export interface CredentialValidationResult {
  ok: boolean;
  /** Human-readable outcome ("Key accepted — scopes: leads:read, …"). */
  message: string;
  /** Vendor-reported facts worth persisting into `config` (scopes, tier,
   *  tool schemas, allowance). The credential store merges these. */
  discovered?: Record<string, unknown>;
  /** insufficient_scope / unauthorized are terminal: the key must be reissued. */
  terminal?: boolean;
}

/**
 * The normalized record every adapter maps into. `emailIsMasked` marks a
 * preview whose address is hidden until acquisition — a masked value is
 * NEVER an email and must never be stored as one (the Apollo
 * `email_not_unlocked@` lesson, generalized).
 */
export interface ProspectRecord {
  externalId: string;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  seniority: string | null;
  companyName: string | null;
  companyDomain: string | null;
  email: string | null;
  emailIsMasked: boolean;
  /** ISO timestamp of the vendor's own verification claim, when it makes one. */
  emailVerifiedAt: string | null;
  mobilePhone: string | null;
  businessPhone: string | null;
  linkedinUrl: string | null;
  city: string | null;
  stateProvince: string | null;
  country: string | null;
  industry: string | null;
  headcount: string | null;
  /** The vendor's raw row, for the run inspector. PII stays here, never in logs. */
  rawSourcePayload: Record<string, unknown>;
}

export interface SearchResultPage {
  records: ProspectRecord[];
  /** Cursor for the next page, when the vendor pages. */
  nextCursor: string | null;
  /** Total the vendor claims, when it says. */
  totalAvailable: number | null;
  /** True when the vendor billed for this page already (no free preview);
   *  the executor then skips acquire() for this source. */
  alreadyCharged: boolean;
  /** Units the search itself consumed (0 for free previews). */
  unitsSpent: number;
}

export interface AcquisitionResult {
  records: ProspectRecord[];
  /** Units the vendor actually charged — re-acquiring a held record is free
   *  on some vendors, so this can be below records.length. */
  unitsSpent: number;
  /** Ids the vendor refused or could not find. */
  failedExternalIds: string[];
}

export interface BudgetSnapshot {
  bucket: BudgetBucket;
  /** Remaining units the vendor reports; null when the vendor does not say. */
  remaining: number | null;
  limit: number | null;
  used: number | null;
  /** When the vendor's own period rolls, if known. */
  resetsAt: string | null;
  /** Free-text the UI can show ("plan allowance", "purchased credits"). */
  fundedBy: string | null;
}

/** One ledger bucket a source meters, with the vendor's reset semantics. */
export interface BudgetPeriod {
  bucket: BudgetBucket;
  granularity: BudgetGranularity;
  /** "2026-09" / "2026-09-14" / "all" — the row key. */
  periodKey: string;
  /** null = uncapped or unknown. */
  unitsLimit: number | null;
  resetsAt: Date | null;
}

/**
 * Declares HOW a source's allowance resets — per source, never in the
 * ledger. WarmySender leads reset on the billing anniversary and are paced
 * daily; QuickEnrich is uncapped; Apollo's search path is a per-day pull cap.
 */
export type BudgetPeriodResolver = (args: {
  now: Date;
  credentials: SourceCredentials;
}) => BudgetPeriod[];

/** Classified failure a vendor call can produce. One vocabulary for all vendors. */
export type VendorFailureReason =
  | "no_credentials"
  | "unauthorized"       // terminal — key invalid/revoked
  | "insufficient_scope" // terminal — key must be reissued with the scope
  | "plan_required"      // terminal — vendor wants an upgrade
  | "rate_limited"       // transient — honour retryAfterSeconds
  | "budget_exhausted"   // the vendor refused for allowance, not for rate
  | "invalid_params"     // our request was wrong — do not retry as-is
  | "unavailable"        // transient — 5xx / network / timeout
  | "not_implemented"
  | "http";

export interface VendorFailure {
  ok: false;
  reason: VendorFailureReason;
  message: string;
  retryAfterSeconds?: number;
  status?: number;
}

export type VendorResult<T> = ({ ok: true } & T) | VendorFailure;

export function isTerminalFailure(r: VendorFailureReason): boolean {
  return r === "unauthorized" || r === "insufficient_scope" || r === "plan_required" || r === "not_implemented";
}

/** Extra context a search can carry (page cursor, campaign id for logs). */
export interface SearchContext {
  cursor?: string | null;
  campaignId?: number | null;
  runId?: number | null;
}

/** THE provider interface. */
export interface ProspectSource {
  readonly slug: ProspectSourceSlug;
  readonly displayName: string;
  readonly docsUrl: string;
  /** The manifest. Given credentials, an adapter may refine it from facts
   *  it discovered at validation (e.g. a captured tool schema proving a
   *  native title filter exists). */
  capabilities(c?: SourceCredentials | null): SourceCapabilities;
  /** Which ledger buckets this source meters, and how they reset. */
  budgetPeriods: BudgetPeriodResolver;
  /** Validate a workspace's credentials. Called on save and on demand. */
  validateCredentials(c: SourceCredentials): Promise<CredentialValidationResult>;
  /** Free where the vendor allows it. May return masked records. */
  search(criteria: SearchCriteria, c: SourceCredentials, limit: number, ctx: SearchContext): Promise<VendorResult<SearchResultPage>>;
  /** Billable. Unmasks / retrieves full detail for the chosen records. */
  acquire(externalIds: string[], c: SourceCredentials, ctx: SearchContext): Promise<VendorResult<AcquisitionResult>>;
  /** Current remaining allowance per bucket, where the vendor exposes it. */
  remainingBudget(c: SourceCredentials): Promise<BudgetSnapshot[]>;
  /** Where this source's credential lives: the generic table, or a legacy
   *  workspace_settings column read through its own resolver. */
  readonly credentialMode: "table" | "legacy";
  /**
   * "on_demand" — free preview, then acquire() spends only on net-new
   *               records (WarmySender).
   * "none"      — the search result IS the deliverable; nothing to acquire
   *               inside the waterfall (Apollo; QuickEnrich, whose credits
   *               the enrichment sweep spends later behind the Reoon gate).
   */
  readonly acquisition: "on_demand" | "none";
  /** Legacy sources meter pulls through are_scrape_jobs; the executor calls
   *  this after a search so every surface writes the ledger the caps read. */
  recordUsage?(workspaceId: number, records: number, query: string): Promise<void>;
}
