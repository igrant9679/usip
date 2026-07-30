/**
 * escapeHtml.ts — the ONE way this codebase turns a value into HTML text.
 *
 * There were FIVE, and they disagreed about the quote:
 *
 *   | Where                                   | & < > | " | Used inside an attribute? |
 *   |-----------------------------------------|-------|---|--------------------------|
 *   | crm.ts escapeHtml                       |  yes  | ✓ | yes (href, label)        |
 *   | mergeVars.ts (×2)                       |  yes  | ✓ | no                       |
 *   | services/meetingReminders.ts esc        |  yes  | ✓ | no                       |
 *   | services/reportScheduler.ts esc         |  yes  | ✗ | no (text only)           |
 *   | proposalExports/buildPrintHTML.ts esc   |  yes  | ✗ | **YES**                  |
 *
 * The last row is the bug. That file builds the printable/exportable proposal a
 * CUSTOMER receives, and it renders:
 *
 *     <img src="${esc(sender.logo)}" alt="${esc(sender.org)}" onerror="…"/>
 *
 * with the copy that does not escape `"`. A workspace's own branding org-name or
 * logo URL containing a double quote closes the attribute early and everything
 * after it is parsed as MORE ATTRIBUTES — the textbook attribute-injection, in
 * the one artefact here that leaves the building. The identical helper two
 * directories away had always escaped the quote; the weaker copy just happened
 * to be the one used in attributes.
 *
 * `'` is escaped too, because single-quoted attributes are equally common and a
 * helper that is safe in one quoting style and not the other is the same trap
 * one level down. In element text both render identically.
 *
 * This is NOT a sanitiser for untrusted MARKUP — that is `sanitizeEmailHtml`,
 * which has its own history (the `java&#9;script:` bypass fixed in 50a4a28).
 * This escapes a VALUE so it can never become markup in the first place.
 */

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/&/g, "&amp;"], // must be first, or later replacements get double-escaped
  [/</g, "&lt;"],
  [/>/g, "&gt;"],
  [/"/g, "&quot;"],
  [/'/g, "&#39;"],
];

/** Escape a value for safe interpolation into HTML text OR an attribute. */
export function escapeHtml(value: unknown): string {
  let out = String(value ?? "");
  for (const [re, to] of REPLACEMENTS) out = out.replace(re, to);
  return out;
}
