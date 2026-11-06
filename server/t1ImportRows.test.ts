/**
 * Tracker 2026-11-06, item 2 (Prospect & Enrich › Import Contacts): "All
 * imported contacts are tagged as an error." The tester's file was not
 * available, so these are the whole-file ways the wizard failed every row, run
 * through the real procedures:
 *
 *   1. A quoted line break split each contact in two (R53). Outlook puts the
 *      business address before "E-mail Address", Google Contacts before
 *      "Organization 1 - Name", and the upload tip names both as sources —
 *      so every contact with an address failed "Missing Email"/"Missing
 *      Company" and its tail failed "Missing First Name".
 *   2. The phone check refused common export forms (Apollo's leading
 *      apostrophe, an extension, a slash), and phone failures fail the row.
 *   3. The upload copy named only First and Last Name as required, while CRM
 *      contacts also need Email and Company.
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
import { classifyImportRow, normalizeImportPhone } from "./routers/imports";

function caller() {
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(h.wsId) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { 4: "admin" }, wsId: () => h.wsId });
});

const sets = () => ({
  existingEmails: new Set<string>(),
  seenEmails: new Set<string>(),
  existingNameKeys: new Set<string>(),
  seenNameKeys: new Set<string>(),
  matchOnNameCompany: false,
  skipDuplicates: true,
  requiredFields: ["firstName", "lastName"],
});

describe("phones as exporters write them", () => {
  it.each([
    ["'+1 415-555-0100", "+1 415-555-0100"],
    ["tel:+14155550100", "+14155550100"],
    ["+1 (415) 555-0100 x123", "+1 (415) 555-0100 x123"],
    ["415-555-0100 ext. 12", "415-555-0100 x12"],
    ["415.555.0100 extension 4", "415.555.0100 x4"],
    ["0171 555 0100 #9", "0171 555 0100 x9"],
    ["089/1234567", "089/1234567"],
    ["+63 917 123 4567", "+63 917 123 4567"],
  ])("%s is read as %s", (raw, phone) => {
    expect(normalizeImportPhone(raw)).toEqual({ phone });
    // Idempotent: the classifier re-reads what the mapper stored.
    expect(normalizeImportPhone(phone)).toEqual({ phone });
    expect(phone.length).toBeLessThanOrEqual(40);
    expect(classifyImportRow({ firstName: "A", lastName: "B", phone: raw }, sets()).status).toBe("ok");
  });

  it("scientific notation is still an error, and the reason says what happened and what to do", () => {
    const v = classifyImportRow({ firstName: "A", lastName: "B", phone: "6.39171E+11" }, sets());
    expect(v.status).toBe("error");
    expect(v.reason).toContain("scientific notation (6.39171E+11)");
    expect(v.reason).toContain("format the phone column as Text");
  });

  it("junk is still an error (the csvImport pin), and a long cell is clipped in the reason", () => {
    expect(classifyImportRow({ firstName: "A", lastName: "B", phone: "call me maybe" }, sets()).reason).toContain("Invalid phone format");
    const long = classifyImportRow({ firstName: "A", lastName: "B", phone: "9".repeat(500) }, sets());
    expect(long.status).toBe("error");
    expect(long.reason.length).toBeLessThan(120);
  });
});

describe("whole files through the procedures", () => {
  const OUTLOOK =
    "First Name,Last Name,Company,Business Street,Business Phone,E-mail Address\r\n" +
    'Ada,Lovelace,Engines Ltd,"12 Analytical Way\r\nLondon",\'+44 20 7946 0958,ada@example.com\r\n' +
    'Alan,Turing,Bombe Co,"1 Bletchley\r\nPark",01908 640404 ext. 2,alan@example.com\r\n' +
    'Grace,Hopper,Navy Labs,"Arlington\r\nVirginia",+1 703-555-0100 x7,grace@example.com\r\n';
  const mapping = {
    "First Name": "firstName", "Last Name": "lastName", Company: "company",
    "Business Street": null, "Business Phone": "phone", "E-mail Address": "email",
  };

  it("an Outlook export with multi-line addresses and exporter phones validates with no errors", async () => {
    const r = await caller().imports.validateRows({
      csvText: OUTLOOK, filename: "outlook.csv", fieldMapping: mapping, destination: "contacts",
    });
    expect(r.totalRows).toBe(3);
    expect(r.errorCount).toBe(0);
    expect(r.errorRows).toEqual([]);
    expect(r.importCount).toBe(3);
  });

  it("the import stores the phones normalised", async () => {
    const r = await caller().imports.commit({
      csvText: OUTLOOK, filename: "outlook.csv", fieldMapping: mapping, destination: "prospects",
    });
    expect(r.importedRows).toBe(3);
    expect(r.errorRows).toBe(0);
    const phones = h.db.rowsOf("prospects").map((p: any) => p.phone);
    expect(phones).toEqual(["+44 20 7946 0958", "01908 640404 x2", "+1 703-555-0100 x7"]);
  });
});

describe("the upload step says what each destination requires", () => {
  const page = readFileSync("client/src/pages/usip/ImportContacts.tsx", "utf8");
  it("required columns come from the rule, not a hand-typed pair", () => {
    expect(page).not.toContain("Required columns: First Name,\n                Last Name.");
    expect(page).not.toContain("Include at minimum: First Name, Last Name, and Email.");
    expect(page).toContain('Required columns: {requiredFieldsFor("contacts").map((f) => f.label).join(", ")} for CRM');
    expect(page).toContain('{requiredFieldsFor("prospects").map((f) => f.label).join(", ")} for Prospects');
  });
});
