/**
 * Pull an employer out of a LinkedIn headline (pure — no imports).
 *
 * Needed because LinkedIn withholds structured work history for people outside
 * the connected account's network — measured on this workspace, third-degree
 * profiles come back with `experienceEntries: 0` and no `current_company`,
 * while the headline reads "Chief Financial Officer at George Industries". The
 * employer was always there; we were reading the headline for the title and
 * discarding the rest.
 *
 * Deliberately conservative. This writes into a CRM field that downstream
 * passes then resolve to a domain and mail, so a wrong answer is worse than no
 * answer: anything long, sentence-like, or matching a known idiom ("at scale",
 * "at large") is rejected rather than guessed at.
 *
 * Lives in its own module so the mapper, the comprehensive pass, and the
 * People read-repair can all consume it without pulling in the sweeper's
 * DB-heavy import graph. enrichmentSweeper re-exports it for its own callers.
 */
const HEADLINE_NON_COMPANIES = new Set([
  "large", "scale", "heart", "home", "work", "times", "last", "will", "present", "night", "once", "best",
]);

/**
 * The " - Company" headline form is accepted ONLY when the tail ends in a
 * legal/organizational suffix. A dash separates a company at least as often
 * as it separates a department or a region ("Sales Manager - Northeast",
 * "Director - Client Services"), so unlike the "at"/"@" forms the dash carries
 * no employer semantics by itself — the suffix is what supplies them.
 * Bare "co" is deliberately absent: "Denver, CO" ends in a state code.
 */
const DASH_COMPANY_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "l.l.c", "ltd", "limited", "corp", "corporation",
  "plc", "llp", "gmbh", "company", "foundation",
]);

/** Validate a candidate tail; returns the cleaned company name or null. */
function validateTail(rawTail: string): string | null {
  let tail = rawTail;
  // Headlines pile on segments after a separator — cut at the first one.
  // Comma is NOT a separator: "American Wood Fibers, Inc." is one company.
  for (const sep of ["|", "•", "·", "—", "–", "\n"]) {
    const i = tail.indexOf(sep);
    if (i > 0) tail = tail.slice(0, i);
  }
  // Strip trailing separators but NOT a trailing period — "American Wood
  // Fibers, Inc." ends in one and it is part of the name.
  const name = tail.trim().replace(/[\s,;:|•·—–-]+$/, "").trim();
  if (!name) return null;
  if (HEADLINE_NON_COMPANIES.has(name.toLowerCase())) return null;
  // Company names are short. Six words covers "The Bill and Melinda Gates
  // Foundation"; ten was loose enough to accept "every stage of their journey
  // grow their impact and reach" out of a marketing headline.
  if (name.length > 120 || name.split(/\s+/).length > 6) return null;
  // Prose continues in lower case; names do not. eBay and iRobot start lower
  // but capitalise inside the first word, so allow that shape specifically.
  //
  // Case is tested with toLowerCase/toUpperCase rather than a \p{Lu} class
  // because this project's regex target predates unicode property escapes —
  // and this way caseless scripts (CJK) pass instead of being rejected as
  // "not capitalised", which a plain [A-Z] check would get wrong.
  const first = name.split(/\s+/)[0] ?? "";
  const c = first.charAt(0);
  const startsUpperOrCaseless = c !== c.toLowerCase() || c === c.toUpperCase();
  const hasInnerCapital = first.slice(1).split("").some((ch) => ch !== ch.toLowerCase());
  if (!startsUpperOrCaseless && !hasInnerCapital) return null;
  return name;
}

export function companyFromHeadline(headline: string | null | undefined): string | null {
  const h = (headline ?? "").trim();
  if (!h) return null;
  // First " at " / " @ " only. A headline can chain roles ("CFO at X | Advisor
  // at Y"); the first is the current one people lead with.
  const m = h.match(/\s(?:at|@)\s+(.+)$/i);
  if (m) return validateTail(m[1]);

  // Dash form, LAST dash: "VP - Operations - Lifecycle Construction Services,
  // LLC" names the employer after the final separator, and any earlier dash
  // segment is a department. Suffix-gated (see DASH_COMPANY_SUFFIXES).
  let dashTail: string | null = null;
  const dashRe = /\s[-–—]\s+/g;
  for (let dm = dashRe.exec(h); dm; dm = dashRe.exec(h)) {
    dashTail = h.slice(dm.index + dm[0].length);
  }
  if (!dashTail) return null;
  const name = validateTail(dashTail);
  if (!name) return null;
  const lastWord = (name.split(/\s+/).pop() ?? "").replace(/[.,]+$/, "").toLowerCase();
  return DASH_COMPANY_SUFFIXES.has(lastWord) ? name : null;
}
