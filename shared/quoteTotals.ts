/**
 * quoteTotals.ts — the ONE definition of quote arithmetic.
 *
 * There were THREE copies of this formula and the only tested one shipped
 * nowhere:
 *   • `operations.computeQuoteTotals` — exported "for tests", ZERO production
 *     callers. Both test suites asserted against it, so the money maths that
 *     actually runs had no coverage at all while two tests reported it green.
 *   • `quotes.create` — reimplemented inline, and this is the one that writes
 *     the columns a customer's PDF prints.
 *   • `Quotes.tsx` — reimplemented again for the dialog preview, so the number
 *     the user approves is computed by different code than the number stored.
 *
 * It also could not guarantee the document ADDS UP, because everything was
 * float and rounding happened in four independent places (three DECIMAL(14,2)
 * columns rounding on INSERT, plus JS):
 *
 *   • `unitPrice` was stored ROUNDED to 2dp while `lineTotal` was computed from
 *     the UNROUNDED input, so a printed row need not multiply out: unit 0.13 ×
 *     qty 4 printed beside a line total of 0.50.
 *   • `total` was computed pre-rounding and rounded once, while each `lineTotal`
 *     rounded on its own — so the sum of the printed rows could differ from the
 *     printed total by a cent per line.
 *
 * A quote is a document a stranger receives and may sign. "Off by a cent" is
 * not a rounding detail there, it is a document whose own numbers disagree.
 *
 * So: all arithmetic happens in INTEGER CENTS, rounding once per value at the
 * point the value is created, and the totals are DERIVED from the rounded line
 * figures. That makes three invariants true by construction rather than by
 * luck:
 *   1. totalCents === Σ lineTotalCents
 *   2. subtotalCents − discountTotalCents + taxTotalCents === totalCents
 *   3. each line's grossCents − discountCents === its lineTotalCents, using the
 *      same unit price the document prints
 *
 * Rule going forward: no other file may multiply a quantity by a price. Import
 * from here — including the client, so the preview and the stored row cannot
 * disagree.
 */

export interface QuoteLineInput {
  quantity: number;
  unitPrice: number;
  discountPct: number;
}

export interface QuoteLineTotals {
  quantity: number;
  /** The unit price as it will be STORED and PRINTED, in cents. */
  unitPriceCents: number;
  /** quantity × unitPriceCents, before discount. */
  grossCents: number;
  discountCents: number;
  /** grossCents − discountCents. */
  lineTotalCents: number;
}

export interface QuoteTotals {
  lines: QuoteLineTotals[];
  subtotalCents: number;
  discountTotalCents: number;
  taxTotalCents: number;
  totalCents: number;
}

/**
 * A currency amount → integer cents, rounded half away from zero to match how
 * MySQL rounds into DECIMAL(_, 2).
 *
 * The `toPrecision(12)` step is not decoration. IEEE-754 stores 1.005 × 100 as
 * 100.49999999999999, so a bare `Math.round` yields 100 where the DECIMAL column
 * yields 101 — i.e. JS and the database would disagree about the same amount,
 * which is the drift this module exists to remove. 12 significant digits is far
 * more than any money value here needs and far less than the error being fixed.
 */
export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return roundCents(amount * 100);
}

/**
 * Round a value that is ALREADY in cents to a whole cent, half away from zero.
 * Same precision guard as toCents, for the same reason.
 */
export function roundCents(cents: number): number {
  if (!Number.isFinite(cents)) return 0;
  const sign = cents < 0 ? -1 : 1;
  const abs = Math.abs(cents);
  return sign * Math.round(Number(abs.toPrecision(12)));
}

/** Integer cents → the exact 2dp string a DECIMAL(_, 2) column should receive. */
export function centsToDecimal(cents: number): string {
  const n = Math.trunc(cents);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Money for display on a quote or its PDF: always two decimals.
 *
 * The app-wide `fmt$` uses `toLocaleString()`, whose default
 * maximumFractionDigits is 3 and minimumFractionDigits is 0 — so a total of
 * 1234.5 printed as "$1,234.5" and 1234 as "$1,234". Acceptable for a pipeline
 * figure on a dashboard; not for the price on a document a customer signs.
 */
export function formatMoneyCents(cents: number): string {
  const n = Math.trunc(cents);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** Same, for a value that is already in currency units (e.g. a DECIMAL string). */
export function formatMoney(amount: number | string | null | undefined): string {
  return formatMoneyCents(toCents(Number(amount ?? 0)));
}

/**
 * Fold line items into the figures a quote stores and prints.
 *
 * `taxCents` is a parameter rather than a hardcoded 0 so that a caller which
 * ever gains a tax input has somewhere to put it. Nothing supplies one today —
 * `quotes.create` has no tax field and the PDF's "Tax" row therefore always
 * prints $0.00, which is honest but means the row is decoration.
 */
export function computeQuoteTotals(
  lineItems: QuoteLineInput[],
  opts: { taxCents?: number } = {},
): QuoteTotals {
  const lines: QuoteLineTotals[] = lineItems.map((li) => {
    // Quantity is an integer column; a fractional one would make `grossCents`
    // fractional and reintroduce the drift this function removes.
    const quantity = Math.max(0, Math.trunc(Number(li.quantity) || 0));
    const unitPriceCents = toCents(Number(li.unitPrice) || 0);
    const grossCents = quantity * unitPriceCents;
    const pct = Number(li.discountPct) || 0;
    // Rounded here, once, so the discount the document shows is the discount
    // subtracted from the line — not a second, differently-rounded figure.
    const discountCents = roundCents((grossCents * pct) / 100);
    return {
      quantity,
      unitPriceCents,
      grossCents,
      discountCents,
      lineTotalCents: grossCents - discountCents,
    };
  });

  const subtotalCents = lines.reduce((s, l) => s + l.grossCents, 0);
  const discountTotalCents = lines.reduce((s, l) => s + l.discountCents, 0);
  const taxTotalCents = Math.trunc(opts.taxCents ?? 0);
  return {
    lines,
    subtotalCents,
    discountTotalCents,
    taxTotalCents,
    // Derived from the rounded line figures, NOT recomputed from the raw
    // inputs: that is what makes "the rows sum to the total" true rather than
    // usually-true.
    totalCents: subtotalCents - discountTotalCents + taxTotalCents,
  };
}
