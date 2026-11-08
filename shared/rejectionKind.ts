/**
 * Who or what rejected a campaign prospect (audit 2026-10-20, F19).
 *
 * prospect_queue carried a free-text reason and a person-or-engine split
 * (rejectedByUserId), so a re-score or a restore could not pick out "only
 * the ICP-score rejections" or "only the duplicates" without matching text.
 * Every rejecting path now writes one of these kinds beside its reason; the
 * Rejections tab shows and filters by it, and Re-evaluate All re-scores only
 * `screen`.
 *
 * Migration 0331 backfilled older rows from their reason text where the text
 * names exactly one writer (the patterns below); every other rejected row is
 * `other`.
 */
export const REJECTION_KINDS = [
  "person",
  "screen",
  "never_target",
  "distress",
  "suppression",
  "dedupe",
  "no_email",
  "territory",
  "enrichment_failed",
  "no_steps",
  "unidentifiable",
  "other",
] as const;
export type RejectionKind = (typeof REJECTION_KINDS)[number];

export const REJECTION_KIND_LABEL: Record<RejectionKind, string> = {
  person: "Rejected by a person",
  screen: "ICP score screen",
  never_target: "Never-target word",
  distress: "Financial distress",
  suppression: "Suppression list",
  dedupe: "Duplicate",
  no_email: "No email found",
  territory: "Outside territory",
  enrichment_failed: "Enrichment failed",
  no_steps: "No usable steps",
  unidentifiable: "Can't be identified",
  other: "Other",
};

/**
 * The reasons a person picks from when they reject a prospect — one list for
 * a campaign's Prospects tab, its dossier and the cross-campaign approval
 * queue (audit 2026-10-20, F16), so the Rejections tab buckets one fact once.
 * "Outside target geography" is also the engine's territory auto-reject
 * reason (TERRITORY_REJECT_REASON), on purpose.
 */
export const PERSON_REJECT_PRESETS = [
  "Wrong industry",
  "Company too small",
  "Company too large",
  "Already a customer",
  "Competitor",
  "No decision-making authority",
  "Outside target geography",
  "Budget constraints",
  "Not the right timing",
  "Duplicate prospect",
] as const;

export function isRejectionKind(v: unknown): v is RejectionKind {
  return typeof v === "string" && (REJECTION_KINDS as readonly string[]).includes(v);
}

/**
 * The reason-text patterns migration 0331 backfilled by, in its order: the
 * first that matches wins. `prefix` matches the start of the reason, `exact`
 * the whole of it. Each is the fixed text one writer puts first.
 */
export const REJECTION_REASON_PATTERNS: ReadonlyArray<{ kind: RejectionKind; prefix?: string; exact?: string; byUser?: boolean }> = [
  // Audit & fix (services/are/prospectReconcile.ts) is a person's click, with a structural reason.
  { kind: "dedupe", prefix: "Audit & fix: the same person as row " },
  { kind: "unidentifiable", prefix: "Audit & fix: no name, email or LinkedIn profile" },
  // Any other row a person rejected.
  { kind: "person", byUser: true },
  { kind: "screen", prefix: "Auto-screened: ICP match " },
  { kind: "suppression", prefix: "On suppression list" },
  { kind: "dedupe", prefix: "Already in a sequence as prospect #" },
  { kind: "no_email", prefix: "No verifiable email address found" },
  { kind: "distress", prefix: "Downstream: the organization is in financial distress" },
  { kind: "never_target", prefix: "Never-target word " },
  { kind: "territory", exact: "Outside target geography" },
  { kind: "enrichment_failed", prefix: "Enrichment failed " },
  { kind: "no_steps", exact: "Generated sequence has no usable steps" },
];

/** The label for a stored kind; no kind, or one this build doesn't know, reads as Other. */
export function rejectionKindLabel(kind: unknown): string {
  return REJECTION_KIND_LABEL[isRejectionKind(kind) ? kind : "other"];
}

/** The kind a stored reason names, as the backfill read it; `other` when none does. */
export function rejectionKindFromReason(reason: string | null | undefined, rejectedByUserId: number | null | undefined): RejectionKind {
  const r = String(reason ?? "");
  for (const p of REJECTION_REASON_PATTERNS) {
    if (p.byUser) { if (rejectedByUserId != null) return p.kind; continue; }
    if (p.exact != null ? r === p.exact : r.startsWith(p.prefix ?? "\u0000")) return p.kind;
  }
  return "other";
}
