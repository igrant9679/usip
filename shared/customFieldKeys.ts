/**
 * Keys inside the `customFields` JSON blob that belong to the ENGINES, not to
 * the admin-defined custom-fields feature.
 *
 * Four tables carry a `customFields` JSON column — accounts, contacts, leads,
 * opportunities — and two entirely different populations write to it:
 *
 *   • the Custom Fields feature, whose keys an admin defines in Settings;
 *   • application code, which uses the same blob as a convenient place to park
 *     control data it has no column for.
 *
 * Nothing separated the two namespaces. The engine keys are not documentation:
 * `linkedinUrl` is how socialAutopilot DECIDES WHO GETS A LINKEDIN INVITE
 * (`JSON_EXTRACT(customFields,'$.linkedinUrl') IS NOT NULL`), `coOwners` is a
 * list of user ids, and the scoring engine resolves several criterion fields
 * straight out of this blob. A custom field that lands on one of these names
 * does not merely collide — it steers an automated outbound action or moves a
 * lead score.
 *
 * `technologies` is the sharp one: the scoring engine reads it, and it is a
 * perfectly ordinary thing for an admin to want a custom field called, and it
 * passes createDef's snake_case rule unchanged.
 */

/** Engine-owned key → what owns it, for the error message. */
export const RESERVED_CUSTOM_FIELD_KEYS: Record<string, string> = {
  // routers/unipile.ts writes these when importing a LinkedIn search;
  // services/socialAutopilot.ts reads linkedinUrl to pick invite targets.
  linkedinUrl: "LinkedIn import + Social Autopilot invite targeting",
  location: "LinkedIn import",
  // routers/opportunityIntelligence.ts — a list of workspace user ids.
  coOwners: "Opportunity co-owners",
  // routers/imports.ts — CSV import provenance.
  importTag: "CSV import provenance",
  importSource: "CSV import provenance",
  importId: "CSV import provenance",
  // services/scoring/* resolve these as scoring inputs.
  technologies: "Lead scoring (technologies criterion)",
  intentTopics: "Lead scoring (intent)",
  hiringSignals: "Lead scoring (intent)",
  websiteKeywords: "Lead scoring (intent)",
  recentFunding: "Lead scoring (intent)",
  recentExecChange: "Lead scoring (intent)",
  recentNews: "Lead scoring (intent)",
};

/**
 * Comparison form for a field key: case-folded, separators dropped, so
 * `hiring_signals`, `hiringSignals` and `Hiring Signals` are one name.
 *
 * The readers are inconsistent about which spelling they use — fieldResolver
 * tries `blob[field] ?? blob[camel(field)]` while priorityService looks only
 * for camelCase — so a reservation that matched exactly would be trivially
 * side-stepped by the other spelling.
 *
 * ⚠️ Deliberately NOT `normalizeMergeKey` from @shared/mergeKeys, despite the
 * rule being the same today. That one must preserve `.` because merge tokens
 * are namespaced (`{{customField.tier}}`); a DB field key must not contain one.
 * Two vocabularies that are free to diverge, kept apart on purpose rather than
 * by accident — the reason is recorded so the next person doesn't "fix" it.
 */
export function canonicalCustomFieldKey(key: string): string {
  return String(key ?? "").toLowerCase().replace(/[_\s-]+/g, "");
}

const RESERVED_CANONICAL = new Map<string, { key: string; owner: string }>(
  Object.entries(RESERVED_CUSTOM_FIELD_KEYS).map(([k, owner]) => [
    canonicalCustomFieldKey(k),
    { key: k, owner },
  ]),
);

/**
 * The engine key this name would collide with, or null.
 *
 * Returns the CANONICAL spelling and its owner so callers can say which
 * feature the name belongs to rather than just refusing.
 */
export function reservedCustomFieldKey(key: string): { key: string; owner: string } | null {
  return RESERVED_CANONICAL.get(canonicalCustomFieldKey(key)) ?? null;
}

/**
 * The keys in a `setValues` payload that the workspace has NOT defined.
 *
 * Extracted from routers/customFields.ts so the allowlist can be tested by
 * CALLING it. The guard that used to cover it asserted that
 * `defs.map((d) => d.fieldKey)` and `Object.keys(input.values)` appeared in
 * the handler — both still true after `if (defined.has(key)) continue;` was
 * mutated to `if (defined.has(key) || true) continue;`, which disables the
 * allowlist entirely. That mutation passed the whole suite (1601 green).
 * Presence of the pieces is not the effect; a pure function has no such gap.
 *
 * Exact match on purpose. `defined` holds the workspace's own fieldKeys as
 * stored, and `setValues` writes `input.values` into the blob under the key
 * the caller supplied — so the key that is checked must be the key that is
 * written. Canonicalising here would accept `first_name` for a field defined
 * as `firstName` and then write `first_name`, a key no reader looks for.
 * (`reservedCustomFieldKey` is separator-insensitive for the opposite reason:
 * it refuses a NEW definition, where either spelling would collide.)
 */
export function undefinedCustomFieldKeys(
  values: Record<string, unknown>,
  defined: ReadonlySet<string>,
): string[] {
  return Object.keys(values).filter((key) => !defined.has(key));
}
