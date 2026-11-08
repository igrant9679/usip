/**
 * Audit 2026-10-20, R52: "Import contacts: duplicates counted twice; errors
 * capped at 200 in the tiles and the 'full' report."
 *
 * With Skip duplicates off, validateRows put a duplicate in BOTH validRows and
 * duplicateRows, and the page then added duplicateCount to validCount again for
 * "Contacts to import" and the Import button. And the server returned only the
 * first 200 error rows while the tiles and "Download error report" read that
 * capped list. Run through the real procedures; the preview must still
 * describe the import.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, wsId: 4 }));
vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

function caller() {
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(h.wsId) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { 4: "admin" }, wsId: () => h.wsId });
  h.db.rowsOf("prospects").push({ id: 1, workspaceId: 4, firstName: "Old", lastName: "Hand", email: "dup@example.com", company: "Acme" });
});

const mapping = { First: "firstName", Last: "lastName", Email: "email", Company: "company" };
// One new row, one duplicate of an existing prospect, one error (no company).
const FILE = "First,Last,Email,Company\nNew,Person,new@example.com,Acme\nDup,Person,dup@example.com,Acme\nBad,Row,bad@example.com,\n";

describe("duplicates are counted once", () => {
  it.each([true, false])("skipDuplicates %s: new + duplicates + errors is the file, and importCount is what commit creates", async (skipDuplicates) => {
    const preview = await caller().imports.validateRows({
      csvText: FILE, filename: "f.csv", fieldMapping: mapping, destination: "prospects", skipDuplicates,
    });
    expect(preview.newCount).toBe(1);
    expect(preview.duplicateCount).toBe(1);
    expect(preview.errorCount).toBe(1);
    expect(preview.newCount + preview.duplicateCount + preview.errorCount).toBe(preview.totalRows);
    expect(preview.importCount).toBe(skipDuplicates ? 1 : 2);

    const done = await caller().imports.commit({
      csvText: FILE, filename: "f.csv", fieldMapping: mapping, destination: "prospects", skipDuplicates,
    });
    expect(done.importedRows).toBe(preview.importCount);
  });

  it("the page shows the server's counts and adds nothing to them", () => {
    const page = readFileSync("client/src/pages/usip/ImportContacts.tsx", "utf8");
    expect(page).not.toContain("validCount + (skipDuplicates ? 0 : duplicateCount)");
    expect(page).toContain("Import {importCount} Contacts");
    expect(page).toContain("setImportCount(result.importCount);");
    expect(page).toContain("setNewCount(result.newCount);");
    expect(page).toContain("disabled={importCount === 0}");
  });
});

describe("errors are counted and reported in full", () => {
  it("a file with 250 error rows returns all 250, so the report is complete", async () => {
    const lines = ["First,Last,Email,Company", ...Array.from({ length: 250 }, (_, i) => `P${i},Q,p${i}@example.com,`)];
    const preview = await caller().imports.validateRows({
      csvText: lines.join("\n"), filename: "f.csv", fieldMapping: mapping, destination: "prospects",
    });
    expect(preview.errorCount).toBe(250);
    expect(preview.errorRows).toHaveLength(250);
    expect(preview.errorRows[249]).toEqual({ rowIndex: 250, reason: "Missing Company" });
  });

  it("the tiles and the list count errorCount, and the report is built from every row", () => {
    const page = readFileSync("client/src/pages/usip/ImportContacts.tsx", "utf8");
    expect(page).toContain("setErrorCount(result.errorCount);");
    expect(page).not.toContain("{errorRows.length}");
    expect(page).not.toContain("errorRows.length > 20");
    expect(page).toContain("… and {errorCount - 20} more.");
    // 2026-11-07 (CRMP, F32): the report is built on the server from every
    // error row the validation kept with the upload, with each row's own
    // columns; the page downloads it. Still every row, not the first 200.
    const report = page.slice(page.indexOf("function downloadErrorReport"), page.indexOf("const totalRows"));
    expect(report).toContain("const r = await utils.imports.errorReport.fetch({ fileToken });");
    const router = readFileSync("server/routers/imports.ts", "utf8");
    expect(router).toContain("if (read.fileToken) await saveImportFileErrors(wsId, ctx.user.id, read.fileToken, errorRows);");
    expect(router).toContain("const errs = f.lastErrorRows ?? [];");
  });
});
