/**
 * CSV import: one field list, one row classifier, one parse of the header row.
 *
 * Four things were wrong at the seams of this feature, all of them silent:
 *
 *  1. **Two field vocabularies.** imports.ts declared 14 fields;
 *     ImportContacts.tsx declared 13 under a comment claiming it "mirrors
 *     backend SYSTEM_FIELDS". The extra one was `tags`, which nothing writes —
 *     `contacts` has no tags column, `buildContactValues` ignores it, and it is
 *     no longer kept in `customFields` either. The lists were also in a
 *     different ORDER, and order decides which field a header auto-maps to.
 *     `parseCSV` returns `systemFields` that the client ignores entirely.
 *
 *  2. **The preview and the import disagreed three ways** — see
 *     classifyImportRow. The sharpest: the phone check existed ONLY in the
 *     preview, so a row shown to the user as "Invalid phone format" was then
 *     imported anyway. That is the one direction that writes data the user was
 *     told would be excluded.
 *
 *  3. **Duplicate CSV headers collapsed.** A row is a {header → value} map, so
 *     two columns sharing a header silently became one and the LAST won. A
 *     trailing comma on the header line produced a blank header doing the same.
 *
 *  4. **A UTF-8 BOM stayed glued to the first header**, so auto-detection could
 *     never match column 1 — usually First Name.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCSVText, uniqueHeaders } from "./services/csv";
import { classifyImportRow, nameCompanyKey } from "./routers/imports";
import { CONTACT_IMPORT_FIELDS, CONTACT_IMPORT_FIELD_KEYS } from "../shared/importFields";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ─── 1. Header parsing ──────────────────────────────────────────────────── */

describe("uniqueHeaders", () => {
  it("strips a UTF-8 BOM from the first header", () => {
    /**
     * NOT MUTATION-TESTABLE, and that is a property of the code rather than a
     * gap here — recorded so the next audit does not chase it.
     *
     * Deleting the explicit `charCodeAt(0) === 0xfeff` check in
     * services/csv.ts changes NOTHING: the next line is `noBom.trim()`, and
     * U+FEFF is <ZWNBSP> in the ECMAScript WhiteSpace production, so `.trim()`
     * already removes it. The explicit check is belt-and-braces for the day
     * `base` stops trimming, so it is worth keeping and impossible to kill.
     *
     * This assertion is still worth having: it pins the OUTPUT, which is what
     * callers depend on, no matter which line produces it.
     *
     * The BOM below is a real U+FEFF and is invisible in most editors. If this
     * test ever starts passing against a mutant, check the byte is still here
     * before concluding anything — one editor pass can silently drop it.
     */
    expect(uniqueHeaders(["﻿First Name", "Email"])).toEqual(["First Name", "Email"]);
    // Belt-and-braces on the fixture itself: a dropped BOM makes this vacuous.
    expect("﻿First Name".charCodeAt(0), "the U+FEFF fixture has been lost").toBe(0xfeff);
  });

  it("keeps duplicate headers distinct instead of collapsing them", () => {
    expect(uniqueHeaders(["Email", "Name", "Email"])).toEqual(["Email", "Name", "Email (2)"]);
  });

  it("names blank headers rather than sharing one empty key", () => {
    // A header line ending in a comma is the common source of this.
    expect(uniqueHeaders(["Name", "", ""])).toEqual(["Name", "Column 2", "Column 3"]);
  });
});

describe("parseCSVText", () => {
  it("does not lose a column to a repeated header", () => {
    const { headers, rows } = parseCSVText("Email,Email\npersonal@x.com,work@x.com");
    expect(headers).toEqual(["Email", "Email (2)"]);
    // Before: row = { Email: "work@x.com" } and personal@x.com was gone.
    expect(rows[0]).toEqual({ Email: "personal@x.com", "Email (2)": "work@x.com" });
  });

  it("exposes the first column under its real name when the file has a BOM", () => {
    const { headers, rows } = parseCSVText("﻿First Name,Last Name\nAda,Lovelace");
    expect(headers[0]).toBe("First Name");
    expect(rows[0]["First Name"]).toBe("Ada");
  });

  it("still handles quoted fields, escaped quotes and CRLF", () => {
    const { rows } = parseCSVText('Name,Note\r\n"Smith, John","He said ""hi"""\r\n');
    expect(rows[0]).toEqual({ Name: "Smith, John", Note: 'He said "hi"' });
  });

  it("returns empty for an empty file", () => {
    expect(parseCSVText("")).toEqual({ headers: [], rows: [] });
    expect(parseCSVText("\n\n")).toEqual({ headers: [], rows: [] });
  });
});

/* ─── 2. One classifier for preview and import ───────────────────────────── */

/**
 * `requiredFields` is the legacy pair on purpose: these tests are about dedup
 * and preview/commit parity, not about which fields a destination insists on.
 * Destination-specific required sets are covered in importRequiredFields.test.ts.
 */
const emptySets = () => ({
  existingEmails: new Set<string>(),
  seenEmails: new Set<string>(),
  existingNameKeys: new Set<string>(),
  seenNameKeys: new Set<string>(),
  requiredFields: ["firstName", "lastName"],
});

describe("classifyImportRow", () => {
  it("reports missing required fields as errors", () => {
    const v = classifyImportRow({ firstName: "", lastName: "" }, {
      ...emptySets(), matchOnNameCompany: false, skipDuplicates: true,
    });
    expect(v.status).toBe("error");
    expect(v.reason).toContain("Missing First Name");
    expect(v.reason).toContain("Missing Last Name");
  });

  it("rejects a bad phone in BOTH paths, not just the preview", () => {
    // The divergence that mattered: commit had no phone check, so a row the
    // preview listed as an error was imported with the junk value.
    const v = classifyImportRow({ firstName: "A", lastName: "B", phone: "call me maybe" }, {
      ...emptySets(), matchOnNameCompany: false, skipDuplicates: true,
    });
    expect(v.status).toBe("error");
    expect(v.reason).toContain("Invalid phone format");
  });

  it("checks required fields BEFORE duplicates", () => {
    // A row that is both a duplicate and missing a name used to count as a
    // duplicate in the preview and an error in the import.
    const sets = emptySets();
    sets.existingEmails.add("dup@x.com");
    const v = classifyImportRow({ firstName: "A", lastName: "", email: "dup@x.com" }, {
      ...sets, matchOnNameCompany: false, skipDuplicates: true,
    });
    expect(v.status).toBe("error");
    expect(v.isDuplicate).toBe(false);
  });

  it("honours skipDuplicates — a duplicate still imports when it is off", () => {
    const sets = emptySets();
    sets.existingEmails.add("dup@x.com");
    const on = classifyImportRow({ firstName: "A", lastName: "B", email: "dup@x.com" }, {
      ...sets, matchOnNameCompany: false, skipDuplicates: true,
    });
    const off = classifyImportRow({ firstName: "A", lastName: "B", email: "dup@x.com" }, {
      ...sets, matchOnNameCompany: false, skipDuplicates: false,
    });
    expect(on.status).toBe("duplicate");
    expect(off.status).toBe("ok");
    // Reported as a duplicate either way: the summary should say both things
    // rather than pick one.
    expect(on.isDuplicate).toBe(true);
    expect(off.isDuplicate).toBe(true);
  });

  it("only falls back to name+company when the user opted in", () => {
    const sets = emptySets();
    sets.existingNameKeys.add("ada|lovelace|analytical engines");
    const row = { firstName: "Ada", lastName: "Lovelace", company: "Analytical Engines" };
    expect(classifyImportRow(row, { ...sets, matchOnNameCompany: false, skipDuplicates: true }).status).toBe("ok");
    expect(classifyImportRow(row, { ...sets, matchOnNameCompany: true, skipDuplicates: true }).status).toBe("duplicate");
  });

  it("returns the identity keys so the caller can record them", () => {
    const v = classifyImportRow({ firstName: "Ada", lastName: "Lovelace", email: "A@X.com", company: "Acme Inc" }, {
      ...emptySets(), matchOnNameCompany: true, skipDuplicates: true,
    });
    expect(v.emailKey).toBe("a@x.com");
    expect(v.nameKey).toBe(nameCompanyKey("Ada", "Lovelace", "Acme Inc"));
  });

  it("never matches on a name with no company", () => {
    expect(nameCompanyKey("John", "Smith", "")).toBeNull();
    expect(nameCompanyKey("John", "Smith", null)).toBeNull();
    expect(nameCompanyKey("", "Smith", "Acme")).toBeNull();
  });
});

/* ─── 3. Source guards ───────────────────────────────────────────────────── */

describe("one field vocabulary", () => {
  it("offers no field the importer cannot write", () => {
    // `tags` was offered server-side with no column, no writer, and no place in
    // customFields — accepted and dropped. buildContactValues is the only thing
    // that turns a mapped key into stored data, so every offered key must appear
    // in it (or be consumed by the account-resolution step beside it).
    const src = stripComments(read("server/routers/imports.ts"));
    const start = src.indexOf("const buildContactValues");
    expect(start).toBeGreaterThan(-1); // floor: found the writer
    // Everything from the contact writer through the end of company resolution.
    const writer = src.slice(src.indexOf("const normDomain"), start + 1400);
    expect(writer.length).toBeGreaterThan(800);
    const unwritten = CONTACT_IMPORT_FIELD_KEYS.filter(
      (k) => !new RegExp(`mapped\\.${k}\\b`).test(writer),
    );
    expect(
      unwritten,
      unwritten.length
        ? `\n\nOffered in the mapping UI but never written:\n  ${unwritten.join("\n  ")}\n\n` +
            `Add the line in buildContactValues, or drop the field. A mapping option\n` +
            `that discards its column is worse than no option — the import still\n` +
            `reports success.\n`
        : undefined,
    ).toEqual([]);
  });

  it("has no second copy of the list", () => {
    for (const rel of ["server/routers/imports.ts", "client/src/pages/usip/ImportContacts.tsx"]) {
      const src = stripComments(read(rel));
      expect(src, rel).toMatch(/from\s*"@shared\/importFields"/);
      // The tell of a local copy: a literal field entry.
      expect(src, rel).not.toMatch(/\{\s*key:\s*"firstName",\s*label:/);
    }
  });

  it("does not offer tags (no contacts.tags column exists)", () => {
    expect(CONTACT_IMPORT_FIELD_KEYS).not.toContain("tags");
    // And the schema is the reason — parsed, so this cannot go stale if someone
    // adds the column later: then this assertion fails and the field can be
    // offered for real.
    const schema = read("drizzle/schema.ts");
    const start = schema.indexOf("export const contacts = mysqlTable");
    const block = schema.slice(start, schema.indexOf("export const", start + 50));
    expect(block.length).toBeGreaterThan(500);
    expect(block).not.toMatch(/^\s*tags:/m);
  });
});

describe("the preview and the import share one rule", () => {
  const src = stripComments(read("server/routers/imports.ts"));

  it("both procedures call classifyImportRow, and nothing re-implements it", () => {
    const calls = src.match(/classifyImportRow\(/g) ?? [];
    // One definition + two call sites.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    // Neither procedure may check these directly any more — that is how they
    // drifted apart in the first place.
    const validateStart = src.indexOf("validateRows: workspaceProcedure");
    const commitStart = src.indexOf("commit: workspaceProcedure");
    expect(validateStart).toBeGreaterThan(-1);
    expect(commitStart).toBeGreaterThan(validateStart);
    for (const [name, block] of [
      ["validateRows", src.slice(validateStart, commitStart)],
      ["commit", src.slice(commitStart)],
    ] as const) {
      expect(block.length, name).toBeGreaterThan(500);
      expect(block, name).toMatch(/classifyImportRow\(/);
      expect(block, name).not.toMatch(/isValidEmail\(/);
      expect(block, name).not.toMatch(/isValidPhone\(/);
    }
  });

  it("the preview is told which dedupe settings the import will use", () => {
    const validateStart = src.indexOf("validateRows: workspaceProcedure");
    const inputBlock = src.slice(validateStart, validateStart + 900);
    for (const flag of ["matchOnNameCompany", "skipDuplicates"]) {
      expect(inputBlock, flag).toContain(flag);
    }
    // And the client must actually send both, or the input default silently
    // reintroduces the divergence.
    const client = stripComments(read("client/src/pages/usip/ImportContacts.tsx"));
    const call = client.slice(client.indexOf("validateRowsMutation.mutateAsync"), client.indexOf("validateRowsMutation.mutateAsync") + 500);
    expect(call).toContain("matchOnNameCompany");
    expect(call).toContain("skipDuplicates");
  });

  it("accepts no post-import action it does not perform", () => {
    // sequenceId/segmentId were accepted, stored, and acted on by nothing.
    const start = src.indexOf("postImportActions: z");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 300);
    expect(block).not.toMatch(/sequenceId|segmentId/);
  });
});
