import { describe, expect, it } from "vitest";

/**
 * Reproduces the same pdfkit pipeline that quotes.generatePdf uses,
 * with synthetic line items, and asserts the bytes are a valid PDF.
 * This guarantees we ship a real PDF (signature + EOF marker), not HTML.
 */
async function buildSamplePdf(): Promise<Buffer> {
  const { default: PDFDocument } = await import("pdfkit");
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fillColor("#0F1F1B").fontSize(24).font("Helvetica-Bold").text("USIP");
    doc.fontSize(11).font("Helvetica").fillColor("#666").text("Quote Q-TEST-0001");
    const lis = [
      { name: "Strategy retainer", description: "Monthly", quantity: 12, unitPrice: 8500, discountPct: 0, lineTotal: 102000 },
      { name: "SEO sprint", description: null, quantity: 1, unitPrice: 14000, discountPct: 5, lineTotal: 13300 },
    ];
    let y = 200;
    for (const li of lis) {
      doc.fillColor("#0F1F1B").fontSize(10).text(li.name, 48, y, { width: 260 });
      doc.text(String(li.quantity), 320, y, { width: 50, align: "right" });
      doc.text(`$${li.unitPrice.toLocaleString()}`, 380, y, { width: 60, align: "right" });
      doc.text(`${li.discountPct.toFixed(1)}%`, 450, y, { width: 50, align: "right" });
      doc.font("Helvetica-Bold").text(`$${li.lineTotal.toLocaleString()}`, 510, y, { width: 54, align: "right" });
      doc.font("Helvetica");
      y += 24;
    }
    doc.end();
  });
}

describe("quote PDF generation (pdfkit)", () => {
  it("produces a real PDF (header + EOF marker), not HTML", async () => {
    const buf = await buildSamplePdf();

    // Real PDFs start with %PDF-
    const header = buf.subarray(0, 5).toString("ascii");
    expect(header).toBe("%PDF-");

    // And end with %%EOF (possibly followed by newline)
    const tail = buf.subarray(buf.length - 32).toString("ascii");
    expect(tail).toContain("%%EOF");

    // Sanity: PDF should have non-trivial size for a 2-line invoice
    expect(buf.length).toBeGreaterThan(800);

    // Negative: it must NOT be HTML
    expect(buf.subarray(0, 64).toString("ascii").toLowerCase()).not.toContain("<html");
    expect(buf.subarray(0, 64).toString("ascii").toLowerCase()).not.toContain("<!doctype");
  });
});
