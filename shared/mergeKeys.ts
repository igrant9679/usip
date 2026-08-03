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

/* ─── Empty LINK tokens take their sentence with them ─────────────────────── */

/**
 * Merge keys whose VALUE IS A LINK, so the copy around them is pointless
 * without one. Kept here rather than at either call site because both renderers
 * must agree about which tokens are links — the whole reason this module exists
 * is that four of them disagreed about something similar.
 */
export const LINK_MERGE_KEYS: readonly string[] = ["bookingLink"];

/**
 * "This is a link token, and we know there is no link."
 *
 * Three conditions, each doing work:
 *   · it must be a LINK key — see the restriction on stripEmptyLinkCarriers;
 *   · a usable FALLBACK rescues it, so `{{bookingLink|https://…}}` is untouched;
 *   · the key must be PRESENT AND EMPTY. An unknown key is left to the caller's
 *     own unresolved-token policy, which differs on purpose (mergeVars leaves it
 *     verbatim for a reviewer to spot, areEngine strips it) — deleting a
 *     sentence because a key was misspelled would be a different change.
 */
export function isEmptyLinkToken(token: MergeToken, lookup: MergeLookup): boolean {
  if (!token.name) return false;
  const n = normalizeMergeKey(token.name);
  let isLink = false;
  for (let i = 0; i < LINK_MERGE_KEYS.length; i++) {
    if (normalizeMergeKey(LINK_MERGE_KEYS[i]!) === n) { isLink = true; break; }
  }
  if (!isLink) return false;
  if (token.fallback) return false;
  return resolveMergeName(lookup, token.name) === "";
}

/**
 * Remove the copy that only existed to carry a link, when there is no link.
 *
 * THE BUG. `{{bookingLink}}` resolves to `""` whenever the rep has no booking
 * link, has switched it off, or has left the workspace. Substituting an empty
 * string into "Book a time here: {{bookingLink}}" sends a stranger
 * "Book a time here: " — a sentence that stops mid-promise. In Markdown it is
 * worse: `[Book a call]({{bookingLink}})` becomes `[Book a call]()`, which the
 * HTML pass will not linkify (it requires `https?://`), so the raw brackets
 * ship as-is.
 *
 * ⚠️ ONLY LINK TOKENS, and the restriction is the whole design. A token whose
 * value IS the actionable thing makes its sentence useless when absent. A
 * descriptive one does not: `{{title}}` is routinely empty, and dropping
 * "as a {{title}} at {{company}}" would delete the personalisation rather than
 * repair it. So this takes an explicit list of link-valued names and touches
 * nothing else.
 *
 * A token with a usable FALLBACK (`{{bookingLink|https://…}}`) is not empty and
 * is left alone — the caller's fallback handling still applies.
 *
 * Runs BEFORE substitution, because afterwards the token is gone and its
 * carrier can no longer be identified.
 */
export function stripEmptyLinkCarriers(
  text: string,
  isEmptyLinkToken: (token: MergeToken) => boolean,
): string {
  const src = String(text ?? "");
  if (!src) return src;

  const tokenRe = /\{\{([^}]*)\}\}/g;
  /** [start, end) spans to delete, discovered left to right. */
  const cuts: Array<[number, number]> = [];

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(src)) !== null) {
    if (!isEmptyLinkToken(parseMergeToken(m[1] ?? ""))) continue;
    cuts.push(carrierSpan(src, m.index, m.index + m[0].length));
  }
  if (cuts.length === 0) return src;

  // Merge overlaps so two dead tokens in one sentence cut it once.
  cuts.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (let i = 0; i < cuts.length; i++) {
    const last = merged[merged.length - 1];
    if (last && cuts[i]![0] <= last[1]) last[1] = Math.max(last[1], cuts[i]![1]);
    else merged.push([cuts[i]![0], cuts[i]![1]]);
  }

  let out = "";
  let at = 0;
  for (let i = 0; i < merged.length; i++) {
    out += src.slice(at, merged[i]![0]);
    at = merged[i]![1];
  }
  out += src.slice(at);
  return tidyAfterCut(out);
}

/** Sentence terminators that end a carrier. */
const TERMINATORS = ".!?";

/**
 * The span to delete for a dead token at [from, to).
 *
 * Smallest carrier first:
 *   1. a Markdown link whose URL is the token — `[label]({{tok}})`;
 *   2. otherwise the SENTENCE around it, bounded by `.!?` or a line break.
 *
 * Sentence rather than whole line, so "Book here {{tok}} or just reply." keeps
 * nothing but a line like "Grab a slot [here]({{tok}}) or reply." keeps
 * "Grab a slot or reply." — the neighbouring clause survives when it can.
 */
function carrierSpan(src: string, from: number, to: number): [number, number] {
  // 1. Markdown link: scan back over "](" and a "[label" with no line break.
  const before = src.slice(0, from);
  const mdOpen = before.lastIndexOf("](");
  if (mdOpen !== -1 && before.slice(mdOpen).indexOf("\n") === -1) {
    const label = before.lastIndexOf("[", mdOpen);
    if (label !== -1 && src[to] === ")" && before.slice(label).indexOf("\n") === -1) {
      // Swallow one adjoining space so "slot [here](x) or" does not double up.
      let end = to + 1;
      let start = label;
      if (src[end] === " " && src[start - 1] === " ") start -= 1;
      return [start, end];
    }
  }

  // 2. Sentence bounds.
  let start = from;
  while (start > 0) {
    const ch = src[start - 1]!;
    if (ch === "\n") break;
    if (TERMINATORS.indexOf(ch) !== -1) break;
    start -= 1;
  }
  // Leave the terminator itself in place; drop the space that followed it.
  while (src[start] === " " || src[start] === "\t") start += 1;

  let end = to;
  while (end < src.length) {
    const ch = src[end]!;
    if (ch === "\n") break;
    end += 1;
    if (TERMINATORS.indexOf(ch) !== -1) break;
  }
  // Take trailing spaces so the join does not leave a double gap.
  while (src[end] === " " || src[end] === "\t") end += 1;
  return [start, end];
}

/** Collapse what removal left behind: stranded blanks and orphaned newlines. */
function tidyAfterCut(s: string): string {
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}
