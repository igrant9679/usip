/**
 * Scraped-field hygiene — ONE definition of "this value is a placeholder,
 * not data".
 *
 * 🔴 THE BUG THIS FIXES (owner-reported 2026-08-12, screenshot of the ARE
 * campaign Prospects tab). LLM scrapers emit literal tokens — `<UNKNOWN>`,
 * `N/A`, `none` — for fields a source doesn't reveal. The ingest seam
 * cleaned them out of NAMES only, so `<UNKNOWN>` landed verbatim in the
 * queue's email and phone columns and rendered raw in the UI. Cosmetic on
 * screen, structural underneath:
 *
 *   · `if (!prospect.email)` gates every email-acquisition path, and
 *     "<UNKNOWN>" is truthy — the enrich agent never looked for a real
 *     address;
 *   · the sweeper selects on `email IS NULL OR email = ''` — the row was
 *     invisible to every repair pass;
 *   · personLink's email tier matched on ANY non-empty string — two
 *     prospects both holding "<UNKNOWN>" could link to the SAME person.
 *
 * Shape rules beat token lists where a shape exists: an email must contain
 * an @, a phone must contain a digit, a domain must contain a dot. The token
 * list covers free-text fields (title, company, industry…) that have no
 * shape. Migration 0159 applies the same rules to rows already stored.
 */

/**
 * The tokens LLM extraction uses for "I don't know" — bracket/quote-wrapped
 * variants included, which is what distinguishes this from
 * `recordNormalize.cleanPlaceholder`: that one is the CSV-IMPORT junk
 * vocabulary (exact tokens like "asdf", "test", "self employed") applied to
 * human-typed spreadsheet cells, and it deliberately does NOT strip
 * "<unknown>" because brackets never appear in CSV junk. Scraped/LLM fields
 * go through THIS module; imported fields go through that one. If you are
 * adding a third vocabulary, stop and widen one of these instead.
 */
export const PLACEHOLDER_TOKEN =
  /^[\s<>[\]()"'.-]*(unknown|n\/?a|none|null|not\s*(available|found|known)|-+)[\s<>[\]()"'.-]*$/i;

export function isPlaceholderToken(value: unknown): boolean {
  const s = String(value ?? "").trim();
  return !s || PLACEHOLDER_TOKEN.test(s);
}

/** Free-text scraped field: placeholder → undefined, else trimmed + clamped. */
export function cleanScrapedField(value: unknown, max: number): string | undefined {
  const s = String(value ?? "").trim();
  if (!s || PLACEHOLDER_TOKEN.test(s)) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

/** Something that can actually receive mail, lowercased — or null. */
export function usableEmailOrNull(value: unknown): string | null {
  const s = String(value ?? "").trim();
  if (!s || PLACEHOLDER_TOKEN.test(s)) return null;
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s) ? s.toLowerCase() : null;
}

/** A phone is a phone only if it carries at least one digit. */
export function usablePhoneOrNull(value: unknown, max = 40): string | null {
  const s = String(value ?? "").trim();
  if (!s || PLACEHOLDER_TOKEN.test(s) || !/[0-9]/.test(s)) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/** A domain needs a dot; "<UNKNOWN>" and bare words are not domains. */
export function usableDomainOrNull(value: unknown, max = 200): string | null {
  const s = String(value ?? "").trim();
  if (!s || PLACEHOLDER_TOKEN.test(s) || !s.includes(".")) return null;
  return (s.length > max ? s.slice(0, max) : s).toLowerCase();
}
