/**
 * Account-side provenance (roadmap P2.1) — the SAME merge rules prospects
 * get, adapted to account identity fields. Deliberately NOT a new merge
 * engine: every decision routes through fieldMerge.mergeField; this file
 * only maps account fields onto the comparison classes the merge already
 * knows (name/legalName compare like company names, domain like domains).
 *
 * The ledger lives in accounts.field_provenance (migration 0154), same
 * shape as prospects.field_provenance: legacy values without an entry get
 * the `preexisting` baseline — protected from weak sources, correctable
 * by strong ones — exactly the 0151 semantics.
 */
import {
  mergeField,
  type EnrichableField,
  type FieldProvenance,
  type MergeAction,
} from "../enrichment/fieldMerge";

export type AccountEnrichableField = "name" | "domain" | "legalName";

export type AccountProvenanceMap = Partial<Record<AccountEnrichableField, FieldProvenance>>;

/** How each account field compares — reusing fieldMerge's normalization. */
const COMPARE_CLASS: Record<AccountEnrichableField, EnrichableField> = {
  name: "company",
  domain: "companyDomain",
  legalName: "company",
};

export interface AccountMergeDecision {
  field: AccountEnrichableField;
  action: MergeAction;
  value: string;
  provenance: FieldProvenance;
}

/** Merge one candidate value against an account field + its ledger entry.
 *  Same contract as fieldMerge.mergeField — fill / replace on strictly
 *  higher confidence / corroborate on agreement / keep otherwise. */
export function mergeAccountField(
  field: AccountEnrichableField,
  current: { value: string | null | undefined; provenance?: FieldProvenance },
  candidate: { value: string; source: string; confidence: number; at: string },
): AccountMergeDecision {
  const d = mergeField(current, { ...candidate, field: COMPARE_CLASS[field] });
  // Corroboration must never LOWER confidence: fieldMerge caps the bump at
  // 99, which would quietly demote a user·100 pin the moment an automated
  // source agreed with it. Agreement is evidence FOR the value — floor the
  // result at what the value already had.
  const provenance =
    d.action === "corroborated" && (current.provenance?.confidence ?? 0) > d.provenance.confidence
      ? { ...d.provenance, confidence: current.provenance!.confidence }
      : d.provenance;
  return { field, action: d.action, value: d.value, provenance };
}

/** Ledger entry for a manual pin — the human is the source of truth. */
export function userPinProvenance(at: string): FieldProvenance {
  return { source: "user", confidence: 100, at };
}
