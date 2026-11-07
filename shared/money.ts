/**
 * One way to show an amount of money on screen (audit 2026-10-20, R98).
 *
 * The app had five: Common's `fmt$` (a hard-coded "$" in front of
 * toLocaleString, so 1234.5 read "$1,234.5"), and four page-local compact
 * formatters that disagreed with each other — Deals had no millions, so $1.5M
 * read "$1500k"; Companies rounded thousands to none, Lists to one place.
 *
 * The currency is a parameter. No workspace stores a currency today (there is
 * no such setting), so every caller gets USD, and when a setting exists this
 * is the one place it has to reach.
 *
 * Quotes and their PDF keep `formatMoney` from @shared/quoteTotals, which is
 * exact to the cent from integer arithmetic: a document a customer signs
 * always shows cents.
 */
export const DEFAULT_CURRENCY = "USD";

function symbolFor(currency: string): string {
  try {
    const part = new Intl.NumberFormat("en-US", { style: "currency", currency }).formatToParts(0).find((p) => p.type === "currency");
    return part?.value ?? "$";
  } catch {
    return "$";
  }
}

/**
 * `compact`: $950 · $1.5k · $150k · $1.5M · $2.3B, for cards and tight
 * columns. Otherwise the whole amount, with cents only when there are any:
 * $1,234 · $1,234.50.
 */
export function formatAmount(
  amount: number | string | null | undefined,
  opts: { currency?: string; compact?: boolean } = {},
): string {
  const currency = opts.currency ?? DEFAULT_CURRENCY;
  const n = Number(amount ?? 0);
  const value = Number.isFinite(n) ? n : 0;
  if (opts.compact) {
    const abs = Math.abs(value);
    const sign = value < 0 ? "-" : "";
    const sym = symbolFor(currency);
    const units: Array<[number, string]> = [[1e3, "k"], [1e6, "M"], [1e9, "B"]];
    let i = abs >= 1e9 ? 2 : abs >= 1e6 ? 1 : abs >= 1e3 ? 0 : -1;
    if (i >= 0) {
      const shown = (k: number) => { const q = abs / units[k][0]; return q.toFixed(q >= 100 ? 0 : 1); };
      // 999,999 rounds to "1000k": say "1M" instead.
      if (i < 2 && Number(shown(i)) >= 1000) i += 1;
      return `${sign}${sym}${shown(i).replace(/\.0$/, "")}${units[i][1]}`;
    }
  }
  const hasCents = !opts.compact && Math.round(value * 100) % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(value);
}
