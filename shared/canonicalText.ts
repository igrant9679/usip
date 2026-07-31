/**
 * Canonical comparison form for NAMES AND COMPANIES.
 *
 * Four copies of this rule existed, and they were verified — differentially,
 * over 49 adversarial inputs (runs of spaces, tabs, punctuation runs, leading
 * and trailing separators, accents, CJK, emoji, empty, null) — to agree on
 * every one before being replaced:
 *
 *   linkedinEnrichment/snapshot.ts    byte-identical to matching.ts
 *   linkedinEnrichment/matching.ts    the Jaccard token source
 *   areEngine.nameOrgDedupKey         + a redundant \s+ collapse (a no-op:
 *                                     [^a-z0-9]+ has already collapsed runs)
 *   discovery/consolidate.ts          [^a-z0-9 ]+ then \s+, same result
 *
 * DUPLICATION, NOT DRIFT — the honest verdict, same as `slugify` and the role
 * hierarchy. Consolidated anyway because of what these four DECIDE: whether two
 * records are the same human. `nameOrgDedupKey` builds the key that stops one
 * prospect being enrolled twice, and `matching.ts` feeds the Jaccard overlap
 * that links a LinkedIn profile to a person. One edit to one copy silently
 * merges two different people, or stops merging one.
 *
 * ⚠️ NOT the same rule as `normalizeMergeKey` (@shared/mergeKeys) or
 * `canonicalCustomFieldKey` (@shared/customFieldKeys), and the difference is
 * load-bearing rather than incidental. Those collapse separators to NOTHING
 * because they match identifiers — `first_name` and `firstName` are one key.
 * This one collapses them to a SPACE because it feeds tokenisation: "John
 * Smith" must stay two tokens for Jaccard overlap to mean anything, and
 * "johnsmith" would score 0 against "John A. Smith". Three canonicalisers that
 * look alike and must not be merged; the reason is recorded here so nobody
 * "fixes" it later.
 */

/**
 * Lowercase, every run of non-alphanumerics to a single space, trimmed.
 *
 *   "  O'Brien--SMITH, Inc. " → "o brien smith inc"
 *
 * `String(...)` rather than the bare `?? ""` two of the copies used: they were
 * typed `string | null | undefined`, so a number reaching them would have
 * thrown on `.toLowerCase()`. Same output for every declared input, one fewer
 * way to fail at runtime.
 */
export function canonicalText(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The canonical form split into tokens, empties dropped.
 *
 * The shape `matching.ts` actually consumes — exported so a caller doing token
 * comparison cannot reinvent the split (and pick a different one).
 */
export function canonicalTokens(s: unknown): Set<string> {
  return new Set(canonicalText(s).split(" ").filter(Boolean));
}
