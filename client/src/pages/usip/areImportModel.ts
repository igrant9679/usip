/**
 * A campaign's CSV import, apart from the page so tests can call it (audit
 * 2026-10-20, A54): the file goes up in chunks the server accepts, and the
 * result names every count, not just the duplicates.
 */

/** are.prospects.importRows takes at most this many rows at a time. */
export const IMPORT_CHUNK = 2000;

export interface ImportTotals {
  imported: number;
  withEmail: number;
  skippedDuplicates: number;
  skippedEmpty: number;
  skippedOtherCampaign: number;
  failed: number;
}

export const emptyImportTotals = (): ImportTotals => ({ imported: 0, withEmail: 0, skippedDuplicates: 0, skippedEmpty: 0, skippedOtherCampaign: 0, failed: 0 });

/** Add one chunk's result to the running totals. */
export function addImportTotals(t: ImportTotals, r: Partial<ImportTotals>): ImportTotals {
  t.imported += r.imported ?? 0;
  t.withEmail += r.withEmail ?? 0;
  t.skippedDuplicates += r.skippedDuplicates ?? 0;
  t.skippedEmpty += r.skippedEmpty ?? 0;
  t.skippedOtherCampaign += r.skippedOtherCampaign ?? 0;
  t.failed += r.failed ?? 0;
  return t;
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Every count, in words: what came in and why the rest did not. */
export function importSummary(t: ImportTotals): string {
  const parts = [`Imported ${n(t.imported, "prospect")}${t.withEmail ? ` (${t.withEmail} with email)` : ""}`];
  if (t.skippedDuplicates) parts.push(`${n(t.skippedDuplicates, "duplicate")} already in this campaign`);
  if (t.skippedOtherCampaign) parts.push(`${n(t.skippedOtherCampaign, "person", "people")} already in another campaign`);
  if (t.skippedEmpty) parts.push(`${n(t.skippedEmpty, "row")} with no name or email`);
  if (t.failed) parts.push(`${n(t.failed, "row")} the database refused`);
  return parts.join(" · ");
}
