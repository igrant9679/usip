/**
 * Quote money: one rule, and a document that adds up.
 *
 * A quote is the one artefact in this app whose numbers a stranger may sign, and
 * its arithmetic had four problems at once:
 *
 *  1. **Three implementations, and the tested one shipped nowhere.**
 *     `operations.computeQuoteTotals` was exported "for tests" with ZERO
 *     production callers, while `quotes.create` (which writes the columns the
 *     PDF prints) and `Quotes.tsx` (the preview the user approves) each
 *     reimplemented the formula. Two suites asserted the dead copy, so the
 *     shipped maths was untested and reported green — the mirror-test class.
 *
 *  2. **The document need not add up.** Everything was float and rounding
 *     happened independently in three DECIMAL(14,2) columns plus JS: `total`
 *     rounded once from the raw inputs while each `lineTotal` rounded on its
 *     own, so the printed rows could sum to a different figure than the printed
 *     total.
 *
 *  3. **Rows need not multiply out.** `unitPrice` was stored ROUNDED to 2dp
 *     while `lineTotal` was computed from the UNROUNDED input, so a printed row
 *     could read unit 0.13 × qty 4 = 0.50.
 *
 *  4. **Money lost its cents.** Both the PDF and the app formatted with
 *     `toLocaleString()`, whose default maximumFractionDigits is 3 and
 *     minimumFractionDigits 0 — "$1,234.5" and "$1,234" on a price.
 *
 * Plus, found in the same seam and guarded here: a cross-tenant destructive
 * delete, and a dialog that discarded the Terms the user typed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import {
  centsToDecimal,
  computeQuoteTotals,
  formatMoney,
  formatMoneyCents,
  roundCents,
  toCents,
} from "../shared/quoteTotals";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ─── 1. Rounding matches the DECIMAL column ─────────────────────────────── */

describe("toCents / roundCents", () => {
  it("rounds half away from zero, like MySQL DECIMAL(_,2)", () => {
    // The whole reason toPrecision(12) is in there: 1.005 * 100 is
    // 100.49999999999999 in IEEE-754, so a bare Math.round returns 100 and JS
    // then disagrees with the column it just wrote to.
    expect(toCents(1.005)).toBe(101);
    expect(toCents(0.145)).toBe(15);
    expect(toCents(2.675)).toBe(268);
    expect(toCents(1.004)).toBe(100);
    expect(toCents(-1.005)).toBe(-101);
  });

  it("is exact for ordinary two-decimal money", () => {
    expect(toCents(0.1 + 0.2)).toBe(30); // 0.30000000000000004
    expect(toCents(8500)).toBe(850000);
    expect(toCents(0)).toBe(0);
  });

  it("treats non-finite input as zero rather than NaN-poisoning a total", () => {
    expect(toCents(NaN)).toBe(0);
    expect(toCents(Infinity)).toBe(0);
    expect(roundCents(NaN)).toBe(0);
  });
});

describe("centsToDecimal", () => {
  it("emits an exact 2dp string for the DECIMAL column", () => {
    expect(centsToDecimal(0)).toBe("0.00");
    expect(centsToDecimal(5)).toBe("0.05");
    expect(centsToDecimal(1234)).toBe("12.34");
    expect(centsToDecimal(11530000)).toBe("115300.00");
    expect(centsToDecimal(-1234)).toBe("-12.34");
  });

  it("never emits exponential notation (MySQL would reject or mangle it)", () => {
    expect(centsToDecimal(100000000000)).toBe("1000000000.00");
    expect(centsToDecimal(100000000000)).not.toMatch(/e/i);
  });
});

describe("formatMoney", () => {
  it("always shows cents", () => {
    // The bug: toLocaleString() gives "1,234.5" and "1,234".
    expect(formatMoneyCents(123450)).toBe("$1,234.50");
    expect(formatMoneyCents(123400)).toBe("$1,234.00");
    expect(formatMoneyCents(5)).toBe("$0.05");
    expect(formatMoney("115300.00")).toBe("$115,300.00");
    expect(formatMoney(null)).toBe("$0.00");
  });
});

/* ─── 2. The invariants that make a document trustworthy ─────────────────── */

describe("computeQuoteTotals", () => {
  it("keeps the three document invariants on awkward money", () => {
    // Chosen to land on half-cent boundaries in more than one place at once.
    const lines = [
      { quantity: 3, unitPrice: 19.99, discountPct: 33.33 },
      { quantity: 1, unitPrice: 0.125, discountPct: 0 },
      { quantity: 7, unitPrice: 10.005, discountPct: 7.375 },
      { quantity: 2, unitPrice: 100, discountPct: 15 },
    ];
    const t = computeQuoteTotals(lines);

    // 1. the rows sum to the total
    expect(t.lines.reduce((s, l) => s + l.lineTotalCents, 0)).toBe(t.totalCents);
    // 2. subtotal − discount + tax === total
    expect(t.subtotalCents - t.discountTotalCents + t.taxTotalCents).toBe(t.totalCents);
    // 3. every row multiplies out against the unit price the document prints
    for (const l of t.lines) {
      expect(l.quantity * l.unitPriceCents).toBe(l.grossCents);
      expect(l.grossCents - l.discountCents).toBe(l.lineTotalCents);
    }
    // and every stored figure is a whole number of cents
    for (const v of [t.subtotalCents, t.discountTotalCents, t.totalCents]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("rounds the unit price the same way the column does", () => {
    // 0.125 → 0.13 stored. The line total must follow the STORED price
    // (0.13 × 4 = 0.52), not the raw input (0.125 × 4 = 0.50), or the printed
    // row contradicts itself.
    const t = computeQuoteTotals([{ quantity: 4, unitPrice: 0.125, discountPct: 0 }]);
    expect(t.lines[0].unitPriceCents).toBe(13);
    expect(t.lines[0].lineTotalCents).toBe(52);
    expect(centsToDecimal(t.lines[0].unitPriceCents)).toBe("0.13");
  });

  it("does not let per-line rounding drift into the total", () => {
    // Two lines that each round up by half a cent. Rounding the total
    // separately from the lines is how the PDF's rows stopped summing to it.
    const t = computeQuoteTotals([
      { quantity: 1, unitPrice: 10.005, discountPct: 0 },
      { quantity: 1, unitPrice: 10.005, discountPct: 0 },
    ]);
    expect(t.lines.map((l) => l.lineTotalCents)).toEqual([1001, 1001]);
    expect(t.totalCents).toBe(2002);
    expect(t.subtotalCents).toBe(2002);
  });

  it("applies a percentage discount per line, rounded once", () => {
    const t = computeQuoteTotals([{ quantity: 1, unitPrice: 99.99, discountPct: 15 }]);
    expect(t.lines[0].grossCents).toBe(9999);
    expect(t.lines[0].discountCents).toBe(1500); // 1499.85 → 1500
    expect(t.lines[0].lineTotalCents).toBe(8499);
    expect(t.totalCents).toBe(8499);
  });

  it("truncates a fractional quantity (the column is an int)", () => {
    // A fractional quantity would make grossCents fractional and put the drift
    // straight back in.
    const t = computeQuoteTotals([{ quantity: 2.7 as number, unitPrice: 10, discountPct: 0 }]);
    expect(t.lines[0].quantity).toBe(2);
    expect(t.lines[0].lineTotalCents).toBe(2000);
  });

  it("survives a 100% discount and a zero-priced line", () => {
    const t = computeQuoteTotals([
      { quantity: 1, unitPrice: 500, discountPct: 100 },
      { quantity: 3, unitPrice: 0, discountPct: 50 },
    ]);
    expect(t.totalCents).toBe(0);
    expect(t.discountTotalCents).toBe(50000);
  });

  it("accepts tax as a parameter, and reports 0 when none is supplied", () => {
    expect(computeQuoteTotals([{ quantity: 1, unitPrice: 100, discountPct: 0 }]).taxTotalCents).toBe(0);
    const withTax = computeQuoteTotals([{ quantity: 1, unitPrice: 100, discountPct: 0 }], { taxCents: 875 });
    expect(withTax.totalCents).toBe(10875);
    expect(withTax.subtotalCents - withTax.discountTotalCents + withTax.taxTotalCents).toBe(withTax.totalCents);
  });
});

/* ─── 3. Source guards: one implementation, everywhere ───────────────────── */

function sourceFiles(dir: string, exts = /\.(ts|tsx)$/): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p, exts));
    else if (exts.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("nothing recomputes quote money", () => {
  const files = [
    ...sourceFiles(join(ROOT, "server")),
    ...sourceFiles(join(ROOT, "client", "src")),
  ].map((f) => ({ rel: f.slice(ROOT.length + 1).split(sep).join("/"), src: stripComments(readFileSync(f, "utf8")) }));

  it("finds source to scan (guards the scanner itself)", () => {
    // A scan that finds nothing looks exactly like a codebase with no problem.
    expect(files.length).toBeGreaterThan(100);
  });

  it("the discount formula appears only in the shared module", () => {
    // `discountPct / 100` was the fingerprint of all three copies. Comments are
    // stripped first: this file and quoteTotals.ts both QUOTE the formula while
    // explaining it, and prose describing a bug reads identically to the bug.
    const offenders = files
      .filter((f) => /discountPct\s*\/\s*100|discountPct\s*\)\s*\/\s*100/.test(f.src))
      .map((f) => f.rel);
    expect(
      offenders,
      offenders.length
        ? `\n\nQuote arithmetic outside @shared/quoteTotals:\n  ${offenders.join("\n  ")}\n\n` +
            `Import computeQuoteTotals. Three copies of this formula existed and the\n` +
            `only tested one had no production callers.\n`
        : undefined,
    ).toEqual([]);
  });

  it("quotes.create and the Quotes dialog both use the shared module", () => {
    for (const rel of ["server/routers/operations.ts", "client/src/pages/usip/Quotes.tsx"]) {
      const src = stripComments(read(rel));
      expect(src, rel).toMatch(/from\s*"@shared\/quoteTotals"/);
      expect(src, rel).toMatch(/computeQuoteTotals\(/);
    }
  });

  it("the stored figures come from the shared totals, not from String(float)", () => {
    const src = stripComments(read("server/routers/operations.ts"));
    const start = src.indexOf("insert(quotes).values({");
    expect(start).toBeGreaterThan(-1); // floor: found the insert
    const block = src.slice(start, start + 900);
    expect(block.length).toBeGreaterThan(300);
    for (const col of ["subtotal", "discountTotal", "taxTotal", "total"]) {
      expect(block, col).toMatch(new RegExp(`${col}: centsToDecimal\\(`));
    }
  });

  it("the money on a quote document is formatted with cents", () => {
    // toLocaleString() on a quote figure is the "$1,234.5" bug.
    const pdf = stripComments(read("server/routers/operations.ts"));
    const pdfStart = pdf.indexOf('totalsRow("Subtotal"');
    expect(pdfStart).toBeGreaterThan(-1);
    const totalsBlock = pdf.slice(pdfStart, pdfStart + 600);
    expect(totalsBlock).not.toMatch(/toLocaleString/);
    expect(totalsBlock).toMatch(/formatMoney\(/);
  });
});

/* ─── 4. A FormDialog must consume the FormData it is handed ──────────────── */

describe("no dialog silently discards what the user typed", () => {
  const files = sourceFiles(join(ROOT, "client", "src"), /\.tsx$/)
    .map((f) => ({ rel: f.slice(ROOT.length + 1).split(sep).join("/"), src: readFileSync(f, "utf8") }))
    .filter((f) => f.src.includes("<FormDialog"));

  it("finds FormDialogs to scan (guards the scanner itself)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("every FormDialog containing a named field reads its FormData", () => {
    // `FormDialog` calls `onSubmit(new FormData(form))`. Quotes.tsx's callback
    // took no argument, so the Notes and Terms typed onto a customer-facing
    // quote were dropped — the column, the input and the PDF section all
    // existed, only the read was missing. Nothing errors; the quote is simply
    // created blank.
    const offenders: string[] = [];
    for (const f of files) {
      const chunks = f.src.split("<FormDialog").slice(1);
      chunks.forEach((chunk, i) => {
        const body = chunk.split("</FormDialog>")[0] ?? chunk;
        const hasNamedField = /\bname="[^"]+"/.test(body);
        // The props sit before the children; look for the handler's signature.
        const argless = /onSubmit=\{\(\)\s*=>/.test(body);
        if (hasNamedField && argless) offenders.push(`${f.rel} (FormDialog #${i + 1})`);
      });
    }
    expect(
      offenders,
      offenders.length
        ? `\n\nFormDialog(s) that collect named fields and ignore the FormData:\n  ${offenders.join("\n  ")}\n\n` +
            `Take the argument — onSubmit={(form) => ...} — and read form.get("<name>").\n` +
            `Otherwise the user types a value, the dialog closes, and it is gone.\n`
        : undefined,
    ).toEqual([]);
  });
});

/* ─── 5. No destructive write may leave its workspace ────────────────────── */

/**
 * Deletes allowed to run without a workspace filter, with the reason. Explicit,
 * not heuristic — a test that infers "this one looks fine" using the same
 * reasoning that wrote the code agrees with itself by construction.
 */
const UNSCOPED_DELETE_ALLOWED: Record<string, string> = {};

describe("quote deletes cannot reach another tenant", () => {
  it("the line-item delete is workspace-scoped and ownership-checked", () => {
    const src = stripComments(read("server/routers/operations.ts"));
    const start = src.indexOf("delete: workspaceProcedure.input(z.object({ id: z.number() })).mutation");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 1200);
    expect(block.length).toBeGreaterThan(400);
    // The ownership select must come BEFORE the destructive statement.
    const check = block.indexOf("select({ id: quotes.id })");
    const destroy = block.indexOf("delete(quoteLineItems)");
    expect(check).toBeGreaterThan(-1);
    expect(destroy).toBeGreaterThan(check);
    // And the delete itself must be scoped, not merely preceded by a check.
    const deleteStmt = block.slice(destroy, destroy + 260);
    expect(deleteStmt).toMatch(/quoteLineItems\.workspaceId/);
  });

  it("no delete in the operations router is scoped by a bare caller-supplied id", () => {
    // The bug: `delete(quoteLineItems).where(eq(quoteLineItems.quoteId, input.id))`
    // ran FIRST and had no workspace filter, so any authenticated user could
    // strip every line item off ANY workspace's quote by id — and the call
    // returned ok:true, because the quote delete beside it was scoped and simply
    // matched nothing.
    const rel = "server/routers/operations.ts";
    const raw = read(rel);
    const src = stripComments(raw);
    const offenders: string[] = [];
    const seenPerTable = new Map<string, number>();
    const re = /\.delete\((\w+)\)\s*\.where\(([\s\S]{0,240}?)\)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const [, table, where] = m;
      // Which occurrence of this table's delete we are on, so the line number
      // below picks the right one when a table is deleted from twice.
      const nth = (seenPerTable.get(table) ?? 0) + 1;
      seenPerTable.set(table, nth);
      if (!/input\.\w+|ctx\.user\.id/.test(where)) continue;
      if (/workspaceId/.test(where)) continue;
      if (rel in UNSCOPED_DELETE_ALLOWED) continue;
      // Decide on the stripped source, REPORT from the raw source. Stripping
      // block comments removes their newlines, so a line number taken from the
      // stripped text points somewhere else entirely — this guard's first run
      // blamed line 600 (a select) for a delete on line 670.
      let idx = -1;
      for (let k = 0; k < nth; k++) idx = raw.indexOf(`.delete(${table})`, idx + 1);
      const line = idx >= 0 ? raw.slice(0, idx).split("\n").length : 0;
      offenders.push(`${rel}:${line} delete(${table})`);
    }
    expect(
      offenders,
      offenders.length
        ? `\n\nDestructive statement(s) keyed on a caller-supplied id with no workspace filter:\n  ${offenders.join("\n  ")}\n\n` +
            `Verify ownership first AND scope the statement. A tenant boundary that\n` +
            `depends on the caller passing their own id is not a boundary.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const stale = Object.keys(UNSCOPED_DELETE_ALLOWED).filter((rel) => {
      const src = stripComments(read(rel));
      return !/\.delete\(/.test(src);
    });
    expect(stale).toEqual([]);
  });
});
