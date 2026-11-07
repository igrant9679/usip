/**
 * A merge of N duplicate contacts, planned as the pairwise merges the server
 * runs (audit 2026-10-20, P95).
 *
 * `dataHealth.mergeContacts` folds ONE duplicate into the survivor: a field
 * the survivor has blank is filled from the duplicate, and a field named in
 * `overrideFields` takes the duplicate's value. The dialog lets the person
 * choose the survivor and, per field, which record's value it keeps; this
 * turns those choices into the sequence of calls, and says what the survivor
 * will hold at the end, so the preview and the result are one computation.
 */

/** The fields a merge can take from a duplicate: the server's CONTACT_FILLABLE. */
export const CONTACT_MERGE_FIELDS = [
  { key: "email", label: "Email" },
  { key: "title", label: "Title" },
  { key: "phone", label: "Phone" },
  { key: "linkedinUrl", label: "LinkedIn URL" },
  { key: "city", label: "City" },
  { key: "seniority", label: "Seniority" },
  { key: "accountId", label: "Account" },
] as const;

export type ContactMergeField = (typeof CONTACT_MERGE_FIELDS)[number]["key"];
export type ContactMergeRecord = { id: number } & Partial<Record<ContactMergeField, unknown>>;

export const hasValue = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "";

export function planContactMerge(
  records: ContactMergeRecord[],
  survivorId: number,
  /** Field → the record whose value the survivor keeps. Unset: its own, or the first filled. */
  picks: Partial<Record<ContactMergeField, number>>,
) {
  const survivor = records.find((r) => r.id === survivorId);
  const duplicates = records.filter((r) => r.id !== survivorId);
  const steps = duplicates.map((d) => ({
    secondaryId: d.id,
    overrideFields: CONTACT_MERGE_FIELDS.map((f) => f.key).filter((k) => picks[k] === d.id && hasValue(d[k])),
  }));
  const result = {} as Record<ContactMergeField, { value: unknown; fromId: number | null }>;
  for (const { key } of CONTACT_MERGE_FIELDS) {
    let value = survivor?.[key];
    let fromId: number | null = hasValue(value) ? survivorId : null;
    for (const d of duplicates) {
      if (!hasValue(d[key])) continue;
      if (picks[key] === d.id || !hasValue(value)) { value = d[key]; fromId = d.id; }
    }
    result[key] = { value: hasValue(value) ? value : null, fromId };
  }
  return { steps, result };
}
