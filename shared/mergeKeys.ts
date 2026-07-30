/**
 * One rule for matching a `{{token}}` to a merge variable.
 *
 * FOUR implementations substitute merge fields, and before this module no two
 * of them matched keys the same way. The token sets were pinned to each other
 * in `41daa03` (see mergeVarCoverage.test.ts) — the MATCHER was not, so the
 * same template rendered differently depending on which feature sent it:
 *
 *   spelling              mergeVars   crm/sequences   areEngine
 *   {{firstName}}         ✓           ✓               ✓
 *   {{FirstName}}         verbatim    ✓               ✓
 *   {{first_name}}        verbatim    ✓               stripped
 *   {{firstName|Friend}}  ✓           verbatim        stripped
 *
 * Every non-✓ cell is either a raw `{{...}}` arriving in a stranger's inbox or
 * a word silently blanked out of a sentence. `resolveMergeVars` leaves unknown
 * tokens verbatim ON PURPOSE — reviewers spot them — but that is a policy for
 * genuinely UNKNOWN variables, and it was firing on variables the app knows
 * perfectly well and its sibling paths resolve.
 *
 * Live risk is bounded today: every insert chip and every AI prompt names the
 * camelCase spelling, so this bites a hand-typed token, a template pasted from
 * another vendor, or an LLM that doesn't follow the instruction. It is filed as
 * latent, and fixed because the failure lands on a prospect rather than a user.
 *
 * ⚠️ This module owns MATCHING only. What to do with a token that stays
 * unresolved is each caller's own policy and deliberately still differs:
 * mergeVars/crm/sequences leave it verbatim, areEngine strips it. That
 * difference is recorded in mergeVarCoverage.test.ts and is not a defect.
 */

/**
 * Canonical comparison form for a merge key: case-folded, separators dropped.
 *
 * `.` is deliberately KEPT — `{{customField.tier}}` is a namespaced key, and
 * collapsing the dot would merge it with a plain `customFieldTier`.
 */
export function normalizeMergeKey(raw: string): string {
  return String(raw ?? "").toLowerCase().replace(/[_\s-]+/g, "");
}

/** The inside of a `{{...}}`, split into the variable name and its fallback. */
export interface MergeToken {
  /** Variable name, trimmed. Empty when the token was blank. */
  name: string;
  /** Text after the first `|`, trimmed. Undefined when none was given. */
  fallback?: string;
}

/**
 * Parse the inside of a `{{...}}`.
 *
 * Splits on the FIRST `|` only, so a fallback may itself contain one.
 */
export function parseMergeToken(inner: string): MergeToken {
  const raw = String(inner ?? "");
  const bar = raw.indexOf("|");
  if (bar === -1) return { name: raw.trim() };
  return { name: raw.slice(0, bar).trim(), fallback: raw.slice(bar + 1).trim() };
}

/** Exact keys plus their normalized index. Build once per render. */
export interface MergeLookup {
  exact: Map<string, string>;
  normalized: Map<string, string>;
}

/** Either shape the four call sites already have their variables in. */
export type MergeVarSource =
  | Map<string, string | null | undefined>
  | ReadonlyArray<readonly [string, string | null | undefined]>;

/**
 * Index a set of variables for lookup.
 *
 * Null/undefined values are skipped, matching every existing implementation —
 * a variable present but empty must not shadow the caller's fallback handling.
 *
 * On a normalized collision the FIRST key wins and later ones are ignored, so
 * the result never depends on object key order changing under someone. Exact
 * keys are always still reachable, so a collision can only affect a lookup that
 * had no exact match anyway.
 *
 * Takes a Map or an entry array rather than a generic Iterable, and walks both
 * without `for…of`: this project compiles with `downlevelIteration` off, where
 * iterating an Iterable/Map is a TS2802. Real constraint, not a style choice.
 */
export function buildMergeLookup(vars: MergeVarSource): MergeLookup {
  const exact = new Map<string, string>();
  const normalized = new Map<string, string>();
  const add = (k: string, v: string | null | undefined) => {
    if (v == null) return;
    exact.set(k, v);
    const nk = normalizeMergeKey(k);
    if (!normalized.has(nk)) normalized.set(nk, v);
  };
  if (vars instanceof Map) vars.forEach((v, k) => add(k, v));
  else for (let i = 0; i < vars.length; i++) add(vars[i][0], vars[i][1]);
  return { exact, normalized };
}

/**
 * Resolve one variable name. EXACT match first, then the normalized form.
 *
 * The exact-first order is what makes adopting this safe: any spelling that
 * already resolved still resolves to the same value, and normalization can
 * only rescue a token that was previously being emitted raw.
 *
 * Returns undefined when the variable is genuinely unknown — the caller then
 * applies its own unresolved-token policy.
 */
export function resolveMergeName(lookup: MergeLookup, name: string): string | undefined {
  if (!name) return undefined;
  const hit = lookup.exact.get(name);
  if (hit !== undefined) return hit;
  return lookup.normalized.get(normalizeMergeKey(name));
}
