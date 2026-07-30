/**
 * slugify.ts — the ONE way a name becomes part of a public URL.
 *
 * Three byte-identical copies lived in bookingLinks.ts, chatAgents.ts and
 * landingPages.ts — the three routers that mint `/b/:slug`, `/c/:slug` and
 * `/l/:slug`. They agreed, so this is duplication rather than drift (the same
 * verdict startOfUtcDay and the role maps gave). It is worth one definition
 * anyway because of what a slug IS here: derived from the name at CREATE, with
 * no way to change it afterwards. A slug bug is permanent and public.
 *
 * One real edge fixed while consolidating: the old order was
 *
 *     .replace(/^-+|-+$/g, "").slice(0, 60)
 *
 * which trims hyphens and THEN truncates — so a name whose 60th character lands
 * on a separator keeps a trailing hyphen, and every caller appends `-<suffix>`,
 * yielding `some-long-name--a1b2`. Trimming after the cut removes that.
 *
 * Callers still supply their own fallback (`slugify(name) || "page"`), which is
 * correct and deliberately not moved in here: what a nameless thing should be
 * called is the caller's business, and a name of only symbols or non-Latin
 * characters legitimately reduces to nothing.
 */

/** Max length of the derived part, before a caller appends its own suffix. */
export const SLUG_MAX = 60;

export function slugify(s: string, max = SLUG_MAX): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, max)
    // Trimmed AFTER the truncation, so a cut that lands on a separator cannot
    // leave a dangling hyphen for the caller's suffix to double up against.
    .replace(/^-+|-+$/g, "");
}
