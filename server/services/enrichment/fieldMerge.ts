/**
 * fieldMerge — the reconciliation rules for comprehensive enrichment.
 *
 * PURE. Given a prospect's current fields (+ provenance ledger) and a set of
 * candidate values from this pass's sources, decide per field: fill, replace,
 * keep, or corroborate. The rules the owner asked for, made executable:
 *
 *  - Source quality is a NUMBER (the confidence table below), so "select the
 *    most reliable result" is a comparison, not a vibe.
 *  - A candidate replaces an existing value only when STRICTLY more
 *    confident. Ties keep what we have — churn without information is loss.
 *  - Cross-source agreement is evidence: a candidate that MATCHES the
 *    current value (same normalized form, different source) doesn't replace
 *    it, it RAISES its confidence and records the corroborating source.
 *  - Recency breaks ties within the SAME source: a newer LinkedIn read of
 *    the same field replaces an older one even at equal confidence, because
 *    people change jobs and the newer read is the fresher observation.
 *  - Legacy values (no provenance — everything written before migration
 *    0151) get a baseline confidence: protected from weak guesses,
 *    correctable by verified/high-quality sources.
 *  - Emails are special: an address Reoon judged `valid` is never replaced
 *    by anything except a newer `valid` — a 92-confidence guess must not
 *    displace a proven mailbox.
 */

import { canonicalizeCompanyDisplayName, cleanPlaceholder, normalizeJobTitle } from "./recordNormalize";

export type EnrichableField =
  | "email" | "phone" | "company" | "companyDomain" | "title" | "education" | "linkedinUrl"
  | "city" | "state" | "country"
  // Generic inbox demoted from primary when a person-specific email won —
  // written by comprehensivePass, carries the demoted value's provenance.
  | "catchAllEmail";

export interface FieldProvenance {
  /** Where the value came from. */
  source: string;
  /** 0–100. See CONFIDENCE for the vocabulary. */
  confidence: number;
  /** ISO timestamp of the observation. */
  at: string;
  /** Emails only: the Reoon verdict backing the value. */
  verification?: string;
  /** Sources that independently agreed with this value. */
  corroboratedBy?: string[];
}

export type ProvenanceMap = Partial<Record<EnrichableField, FieldProvenance>>;

export interface Candidate {
  field: EnrichableField;
  value: string;
  source: string;
  confidence: number;
  at: string;
  verification?: string;
}

/**
 * The confidence table — one place, with the reasoning:
 *  - user-entered data outranks everything (they know their own pipeline);
 *  - verified emails outrank found-but-unverified ones by a wide margin;
 *  - LinkedIn profile facts are high (self-reported but current);
 *  - site-scrape phones/emails are opportunistic finds.
 *
 * `apolloDomain` (75) stays in the table although nothing EMITS it since
 * 2026-08-12 (owner removed Apollo from the waterfall): stored ledger rows
 * carry the numeric value, but keeping the named tier documents what those
 * historical rows meant and keeps the ordering reasoning legible.
 */
export const CONFIDENCE = {
  user: 100,
  emailReoonValid: 95,
  quickenrichVerified: 92,
  patternReoonValid: 90,
  linkedinProfile: 85,
  /** HISTORICAL — no emitter since 2026-08-12; see the header note. */
  apolloDomain: 75,
  /** Legacy value with no ledger entry — protected, but correctable. */
  preexisting: 70,
  emailAcceptAll: 62,
  scrapeFound: 55,
  emailRisky: 50,
  emailUnknown: 45,
  headlineParse: 60,
  /** Domain lifted off the prospect's own business email address. The mailbox
   *  may be unverified, but the domain part is where their mail actually
   *  lives — stronger than a domain-root guess. */
  emailDomain: 70,
  /** Company name derived from the domain root ("acme-corp.com" → "Acme
   *  Corp") — the last-resort filler; any real source replaces it. */
  domainDerived: 40,
  /** Company display name read off the organization's OWN website (title /
   *  og:site_name / copyright) by the name-verification sweep. The org's own
   *  branding is the authority the owner designated for name syntax — above
   *  LinkedIn's self-reported strings, below a user pin. Only ever offered
   *  for values that are slugs of the domain itself, so it corrects
   *  rendering, never identity. */
  websiteOfficial: 88,
  /** Domain taken from a brand-directory NAME match, with nothing else known
   *  about the company. Deliberately below `preexisting` and every evidence
   *  source: a name match is a good guess, not a fact — searching "aarp"
   *  returns aarp.info, whose real domain is aarp.org. It fills an EMPTY
   *  field so the record becomes usable, and yields to the first real
   *  evidence (an email domain, LinkedIn, QuickEnrich) that disagrees. */
  brandSearchName: 60,
} as const;

/** Normalize for cross-source agreement checks — NOT for storage. */
export function normalizeForCompare(field: EnrichableField, v: string): string {
  let s = v.trim().toLowerCase();
  if (field === "companyDomain") s = s.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (field === "linkedinUrl") s = s.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  if (field === "company") s = s.replace(/[.,]| (inc|llc|ltd|gmbh|corp)\.?$/g, "").replace(/\s+/g, " ").trim();
  return s;
}

export type MergeAction = "filled" | "replaced" | "kept" | "corroborated";

export interface MergeDecision {
  field: EnrichableField;
  action: MergeAction;
  value: string;          // the value the field holds AFTER the decision
  provenance: FieldProvenance;
  previous?: { value: string; provenance?: FieldProvenance };
}

/**
 * Merge one candidate against the current state of its field.
 * Returns the decision; the caller persists values + ledger.
 */
export function mergeField(
  current: { value: string | null | undefined; provenance?: FieldProvenance },
  candidate: Candidate,
): MergeDecision {
  const curVal = (current.value ?? "").trim();
  const candProv: FieldProvenance = {
    source: candidate.source,
    confidence: candidate.confidence,
    at: candidate.at,
    ...(candidate.verification ? { verification: candidate.verification } : {}),
  };

  // Empty field: any candidate fills it.
  if (!curVal) {
    return { field: candidate.field, action: "filled", value: candidate.value, provenance: candProv };
  }

  const curProv: FieldProvenance = current.provenance ?? {
    source: "preexisting",
    confidence: CONFIDENCE.preexisting,
    at: "1970-01-01T00:00:00.000Z",
  };

  // Agreement across sources: keep the value, raise its standing.
  if (normalizeForCompare(candidate.field, curVal) === normalizeForCompare(candidate.field, candidate.value)) {
    if (curProv.source !== candidate.source) {
      const corroboratedBy = Array.from(new Set([...(curProv.corroboratedBy ?? []), candidate.source]));
      return {
        field: candidate.field,
        action: "corroborated",
        value: curVal,
        provenance: {
          ...curProv,
          confidence: Math.min(99, Math.max(curProv.confidence, candidate.confidence) + 5),
          corroboratedBy,
        },
        previous: { value: curVal, provenance: current.provenance },
      };
    }
    // Same source re-observing the same value: just refresh the timestamp.
    return {
      field: candidate.field,
      action: "kept",
      value: curVal,
      provenance: { ...curProv, at: candidate.at },
      previous: { value: curVal, provenance: current.provenance },
    };
  }

  // Emails: a Reoon-`valid` address yields only to a NEWER Reoon-`valid` one.
  if (candidate.field === "email" && curProv.verification === "valid" && candidate.verification !== "valid") {
    return { field: "email", action: "kept", value: curVal, provenance: curProv, previous: { value: curVal, provenance: current.provenance } };
  }

  // Conflict: strictly-higher confidence wins; same source + same confidence
  // prefers the newer observation (people change jobs).
  const newerSameSource =
    curProv.source === candidate.source &&
    candidate.confidence >= curProv.confidence &&
    candidate.at > curProv.at;
  if (candidate.confidence > curProv.confidence || newerSameSource) {
    return {
      field: candidate.field,
      action: "replaced",
      value: candidate.value,
      provenance: candProv,
      previous: { value: curVal, provenance: current.provenance },
    };
  }

  return { field: candidate.field, action: "kept", value: curVal, provenance: curProv, previous: { value: curVal, provenance: current.provenance } };
}

/** Per-field representation repair for incoming candidates. Company names
 *  and titles get the full treatment; everything else gets the junk gate.
 *  Emails are deliberately only junk-gated — rewriting a Reoon-verified
 *  address, even cosmetically, would detach the value from its verdict. */
function normalizeCandidateValue(field: EnrichableField, value: string): string | null {
  switch (field) {
    case "company": return canonicalizeCompanyDisplayName(value);
    case "title": return normalizeJobTitle(value);
    default: return cleanPlaceholder(value);
  }
}

/** Merge a batch of candidates; later candidates see earlier winners. */
export function mergeAll(
  fields: Partial<Record<EnrichableField, string | null | undefined>>,
  ledger: ProvenanceMap,
  candidates: Candidate[],
): { decisions: MergeDecision[]; fields: Partial<Record<EnrichableField, string>>; ledger: ProvenanceMap } {
  const outFields: Partial<Record<EnrichableField, string>> = {};
  const outLedger: ProvenanceMap = { ...ledger };
  const state: Partial<Record<EnrichableField, { value: string | null | undefined; provenance?: FieldProvenance }>> = {};
  for (const f of Object.keys(fields) as EnrichableField[]) {
    state[f] = { value: fields[f], provenance: ledger[f] };
  }
  const decisions: MergeDecision[] = [];
  for (const cand of candidates) {
    if (!cand.value?.trim()) continue;
    // Normalization + QC gate: every enrichment source funnels through
    // mergeAll (house rule), so this is the ONE place representation gets
    // fixed before anything is saved — company display spelling, title
    // formatting, placeholder junk. A candidate that normalizes to nothing
    // ("N/A", "-") never merges at all.
    const normalized = normalizeCandidateValue(cand.field, cand.value);
    if (!normalized) continue;
    const normCand = normalized === cand.value ? cand : { ...cand, value: normalized };
    const cur = state[normCand.field] ?? { value: fields[normCand.field], provenance: ledger[normCand.field] };
    const d = mergeField(cur, normCand);
    decisions.push(d);
    state[cand.field] = { value: d.value, provenance: d.provenance };
    outLedger[cand.field] = d.provenance;
    if (d.action === "filled" || d.action === "replaced") outFields[cand.field] = d.value;
  }
  return { decisions, fields: outFields, ledger: outLedger };
}
