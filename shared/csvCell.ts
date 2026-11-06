/**
 * One CSV cell, safe to open in a spreadsheet. The one copy: there were five,
 * each with the same gap.
 *
 * A cell holding a quote, comma or line break is quote-wrapped with its quotes
 * doubled (RFC 4180). And a text cell starting with = + - @, a tab or a carriage
 * return is read by Excel, Sheets and LibreOffice as a FORMULA, so a prospect
 * or audit entry named `=HYPERLINK("https://evil.example","Open")` became a
 * live link, or worse, in the admin's spreadsheet (audit 2026-10-20, G49). Such
 * a cell gets a leading apostrophe, the usual neutraliser: the spreadsheet
 * shows the text and does not run it. Plain numbers ("-12.50") are left alone.
 */
export function csvCell(v: unknown): string {
  if (v == null) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
