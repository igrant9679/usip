/**
 * Enrichment-job builder — the pure flow rules, separated from the drawer so
 * the gating is testable without a DOM and cannot drift per component:
 * which card unlocks when, and what "workflow complete" means.
 *
 * Deliberately dependency-free (no React, no "@/" aliases) so server-side
 * tests can import it by relative path.
 *
 * ⚠️ No backend exists for enrichment jobs yet. These vocabularies name the
 * app's REAL enrichment capabilities (free-source email finder + Reoon,
 * QuickEnrich LinkedIn, company identity resolution) so the day a jobs table
 * lands, the stored config maps 1:1 — but nothing here runs anything.
 */

export type JobStep = "workflow" | "settings";
export type CardKey = "object" | "type" | "filters" | "cadence";

export interface EnrichmentJobConfig {
  /** Header toggle — whether the job would be live once created. */
  enabled: boolean;
  name: string;
  objectType: string | null;
  enrichmentType: string | null;
  /** Optional — "all" is a real choice, null means "not visited". */
  filter: string | null;
  cadence: string | null;
}

export const EMPTY_JOB: EnrichmentJobConfig = {
  enabled: true,
  name: "Untitled enrichment job",
  objectType: null,
  enrichmentType: null,
  filter: null,
  cadence: null,
};

export interface CardOption {
  value: string;
  label: string;
  hint?: string;
}

export const OBJECT_OPTIONS: CardOption[] = [
  { value: "people", label: "People", hint: "Site-wide People records" },
  { value: "companies", label: "Companies", hint: "Company / account records" },
];

export const TYPE_OPTIONS: CardOption[] = [
  { value: "email", label: "Find & verify email", hint: "Free-source finder + Reoon verification" },
  { value: "linkedin", label: "LinkedIn profile", hint: "QuickEnrich profile match" },
  { value: "company_identity", label: "Company identity", hint: "Domain + brand resolution" },
];

export const FILTER_OPTIONS: CardOption[] = [
  { value: "missing_only", label: "Only records missing this data", hint: "Skip records that already have it" },
  { value: "stale", label: "Only records not enriched in 90+ days", hint: "Refresh pass" },
  { value: "all", label: "All matching records", hint: "No filter" },
];

export const CADENCE_OPTIONS: CardOption[] = [
  { value: "once", label: "Run once", hint: "A single pass, then done" },
  { value: "daily", label: "Daily", hint: "Every day, new matches only" },
  { value: "weekly", label: "Weekly", hint: "Once a week, new matches only" },
];

export function optionsFor(key: CardKey): CardOption[] {
  switch (key) {
    case "object": return OBJECT_OPTIONS;
    case "type": return TYPE_OPTIONS;
    case "filters": return FILTER_OPTIONS;
    case "cadence": return CADENCE_OPTIONS;
  }
}

export function labelFor(key: CardKey, value: string | null): string | null {
  if (value == null) return null;
  return optionsFor(key).find((o) => o.value === value)?.label ?? null;
}

/**
 * Which card is clickable. Filters is OPTIONAL, so cadence must not wait on
 * it — both unlock together once the enrichment type is chosen; everything
 * downstream of the object waits for the object.
 */
export function cardEnabled(cfg: EnrichmentJobConfig, key: CardKey): boolean {
  switch (key) {
    case "object": return true;
    case "type": return cfg.objectType != null;
    case "filters": return cfg.enrichmentType != null;
    case "cadence": return cfg.enrichmentType != null;
  }
}

export function cardCompleted(cfg: EnrichmentJobConfig, key: CardKey): boolean {
  switch (key) {
    case "object": return cfg.objectType != null;
    case "type": return cfg.enrichmentType != null;
    case "filters": return cfg.filter != null;
    case "cadence": return cfg.cadence != null;
  }
}

export function selectedValue(cfg: EnrichmentJobConfig, key: CardKey): string | null {
  switch (key) {
    case "object": return cfg.objectType;
    case "type": return cfg.enrichmentType;
    case "filters": return cfg.filter;
    case "cadence": return cfg.cadence;
  }
}

export function withSelection(cfg: EnrichmentJobConfig, key: CardKey, value: string): EnrichmentJobConfig {
  switch (key) {
    case "object":
      // Changing the object invalidates downstream choices that depended on
      // it — a filter for "missing email" makes no sense against a different
      // object/type pairing. Same-value re-picks keep everything.
      return cfg.objectType === value ? cfg : { ...cfg, objectType: value, enrichmentType: null, filter: null, cadence: null };
    case "type":
      return cfg.enrichmentType === value ? cfg : { ...cfg, enrichmentType: value, filter: null };
    case "filters": return { ...cfg, filter: value };
    case "cadence": return { ...cfg, cadence: value };
  }
}

/** Filters is optional; the three required choices gate "Next: Settings". */
export function workflowComplete(cfg: EnrichmentJobConfig): boolean {
  return cfg.objectType != null && cfg.enrichmentType != null && cfg.cadence != null;
}
