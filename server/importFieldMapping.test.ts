/**
 * Header → field matching, and the duplicate-mapping refusal.
 *
 * THE BUG THIS EXISTS FOR (live import, 2026-08-06): the client auto-mapped by
 * bidirectional substring —
 *
 *   normalized.includes(kNorm) || kNorm.includes(normalized)
 *
 * — so `Email Status`, whose values are verification verdicts, mapped onto the
 * `email` field. A 200-row verified-email export produced 200 rows of
 * "Invalid email format: valid" and zero importable rows. Because the file also
 * had a real `Email` column, BOTH claimed `email` and `mapRowToContact`'s
 * last-write-wins quietly kept the verdict.
 *
 * So the matcher is tested on real exporter headers, not on invented ones, and
 * the collapse is tested end-to-end through the actual `classifyImportRow` the
 * importer runs.
 */
import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTACT_IMPORT_FIELDS,
  CONTACT_IMPORT_FIELD_KEYS,
  HEADER_ALIASES,
  autoMapHeaders,
  describeDuplicateMappings,
  findDuplicateFieldMappings,
  matchHeaderToField,
  normalizeHeader,
} from "@shared/importFields";
import { assertNoDuplicateMappings, classifyImportRow } from "./routers/imports";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("matchHeaderToField — the reported defect", () => {
  /**
   * The exact headers from the export that broke. Every one of these carries a
   * verification verdict or a confidence score, NOT an address.
   */
  it("never maps a verification-status column onto email", () => {
    for (const h of [
      "Email Status",
      "Email status",
      "email_status",
      "Email Verification",
      "Email Confidence",
      "Primary Email Catch-all Status",
      "Email Validity",
    ]) {
      expect(matchHeaderToField(h), h).not.toBe("email");
    }
  });

  it("still maps the real address column", () => {
    for (const h of ["Email", "email", "E-mail", "Email Address", "Work Email"]) {
      expect(matchHeaderToField(h), h).toBe("email");
    }
  });

  /**
   * The same substring flaw mis-filed four other columns. `Company Website`
   * landing on the company NAME field is the one that silently corrupted data
   * rather than merely erroring — a URL stored as a company name.
   */
  it("does not fold company-scoped columns onto contact fields", () => {
    expect(matchHeaderToField("Company Website")).toBe("website");
    expect(matchHeaderToField("Company Domain")).toBe("website");
    // These describe the employer and have nowhere correct to go, so they must
    // map to NOTHING rather than to the contact's own phone/city/profile.
    expect(matchHeaderToField("Company Phone")).toBeNull();
    expect(matchHeaderToField("Company City")).toBeNull();
    expect(matchHeaderToField("Company Linkedin Url")).toBeNull();
    expect(matchHeaderToField("Company Address")).toBeNull();
  });

  it("maps the person's own columns", () => {
    const cases: Array<[string, string]> = [
      ["First Name", "firstName"],
      ["Last Name", "lastName"],
      ["Job Title", "title"],
      ["Title", "title"],
      ["Company", "company"],
      ["Company Name", "company"],
      ["Person Linkedin Url", "linkedinUrl"],
      ["LinkedIn URL", "linkedinUrl"],
      ["Mobile Phone", "phone"],
      ["Website", "website"],
      ["Industry", "industry"],
      ["City", "city"],
      ["State", "state"],
      ["Country", "country"],
      ["Seniority", "seniority"],
    ];
    for (const [header, field] of cases) {
      expect(matchHeaderToField(header), header).toBe(field);
    }
  });

  it("ignores case, punctuation and a leading BOM", () => {
    // Excel writes a BOM onto the FIRST header, which used to leave column 1
    // — usually First Name — permanently unmapped.
    expect(matchHeaderToField("﻿First Name")).toBe("firstName");
    expect(matchHeaderToField("  FIRST_NAME  ")).toBe("firstName");
    expect(normalizeHeader("﻿Email Address")).toBe("emailaddress");
  });

  it("maps an unrecognised header to nothing rather than guessing", () => {
    for (const h of ["Keywords", "Technologies", "Annual Revenue", "# Employees", "", "   "]) {
      expect(matchHeaderToField(h), h).toBeNull();
    }
  });
});

describe("the alias table itself", () => {
  it("points every alias at a real field", () => {
    for (const [alias, field] of Object.entries(HEADER_ALIASES)) {
      expect(CONTACT_IMPORT_FIELD_KEYS, alias).toContain(field);
    }
  });

  it("is already normalised, or the lookup can never hit it", () => {
    // A key with a space or capital is dead weight: lookups are by normalised
    // header, so it would silently never match.
    for (const alias of Object.keys(HEADER_ALIASES)) {
      expect(normalizeHeader(alias), alias).toBe(alias);
    }
  });

  it("never shadows a field's own label or key", () => {
    const own = new Set([
      ...CONTACT_IMPORT_FIELDS.map((f) => normalizeHeader(f.label)),
      ...CONTACT_IMPORT_FIELDS.map((f) => f.key.toLowerCase()),
    ]);
    for (const alias of Object.keys(HEADER_ALIASES)) {
      expect(own.has(alias), `${alias} duplicates a label/key`).toBe(false);
    }
  });

  it("has a floor — an emptied table would pass every test above", () => {
    expect(Object.keys(HEADER_ALIASES).length).toBeGreaterThan(40);
  });
});

describe("autoMapHeaders — one column per field", () => {
  /** The failing file's shape: address column, then its verdict column. */
  const BROKEN_EXPORT = ["First Name", "Last Name", "Email", "Email Status", "Company", "Job Title"];

  it("maps the address and skips the verdict", () => {
    const m = autoMapHeaders(BROKEN_EXPORT);
    expect(m["Email"]).toBe("email");
    expect(m["Email Status"]).toBeNull();
  });

  it("produces no duplicate field claims, so the mapping is importable as-is", () => {
    expect(findDuplicateFieldMappings(autoMapHeaders(BROKEN_EXPORT))).toEqual([]);
  });

  it("keeps the FIRST of two columns that legitimately mean the same field", () => {
    // Both are real addresses; last-write-wins would otherwise pick the later
    // one on the strength of column order alone.
    const m = autoMapHeaders(["First Name", "Work Email", "Personal Email"]);
    expect(m["Work Email"]).toBe("email");
    expect(m["Personal Email"]).toBeNull();
  });

  it("assigns every header a key, mapped or not", () => {
    // The mapping table renders from the headers; a missing key would render as
    // unmapped while carrying no explicit decision.
    const headers = ["First Name", "Keywords", "Email"];
    const m = autoMapHeaders(headers);
    expect(Object.keys(m).sort()).toEqual([...headers].sort());
  });
});

describe("findDuplicateFieldMappings", () => {
  it("reports a field claimed twice, with both column names", () => {
    const d = findDuplicateFieldMappings({ Email: "email", "Email Status": "email" });
    expect(d).toHaveLength(1);
    expect(d[0].field).toBe("email");
    expect(d[0].label).toBe("Email");
    expect(d[0].headers).toEqual(["Email", "Email Status"]);
  });

  it("ignores unmapped columns rather than grouping them together", () => {
    // Several nulls are not a conflict — they are several skipped columns.
    expect(findDuplicateFieldMappings({ a: null, b: null, c: "email" })).toEqual([]);
  });

  it("is silent on a clean mapping", () => {
    expect(findDuplicateFieldMappings({ Email: "email", Phone: "phone" })).toEqual([]);
  });

  it("reports every conflicting field, not just the first", () => {
    const d = findDuplicateFieldMappings({
      Email: "email", "Email 2": "email", Phone: "phone", Mobile: "phone",
    });
    expect(d.map((x) => x.field).sort()).toEqual(["email", "phone"]);
  });

  it("describes a conflict in words the user can act on", () => {
    const msg = describeDuplicateMappings(findDuplicateFieldMappings({
      Email: "email", "Email Status": "email",
    }));
    expect(msg).toContain("Email");
    expect(msg).toContain('"Email Status"');
  });
});

describe("what the collapse actually did to a row", () => {
  /**
   * End-to-end through the REAL classifier, so this fails if the validation
   * rule changes underneath the story. Reproduces the screenshot exactly.
   */
  const opts = {
    existingEmails: new Set<string>(),
    seenEmails: new Set<string>(),
    existingNameKeys: new Set<string>(),
    seenNameKeys: new Set<string>(),
    matchOnNameCompany: false,
    skipDuplicates: true,
    // The legacy pair: this block is about the email FORMAT check, which is
    // what the collapse tripped. Destination-specific required sets are
    // covered in importRequiredFields.test.ts.
    requiredFields: ["firstName", "lastName"],
  };

  it("rejected every row with the verdict text as the address", () => {
    for (const verdict of ["valid", "unknown", "catch-all"]) {
      const r = classifyImportRow({ firstName: "Ada", lastName: "Li", email: verdict }, opts);
      expect(r.status).toBe("error");
      expect(r.reason).toBe(`Invalid email format: ${verdict}`);
    }
  });

  it("accepts the same row once the real address survives", () => {
    const r = classifyImportRow({ firstName: "Ada", lastName: "Li", email: "ada@acme.io" }, opts);
    expect(r.status).toBe("ok");
    expect(r.emailKey).toBe("ada@acme.io");
  });
});

/**
 * The guard EXECUTED, not merely located.
 *
 * The first version of this file only asserted that both procedures *call*
 * `assertNoDuplicateMappings`. A mutation that turned its body into an
 * unconditional `return` passed all of it — presence is not effect, and a
 * structural check can only ever pin the shape it was given.
 */
describe("assertNoDuplicateMappings — run for real", () => {
  it("throws BAD_REQUEST when two columns claim one field", () => {
    expect(() =>
      assertNoDuplicateMappings({ Email: "email", "Email Status": "email" }),
    ).toThrow(TRPCError);
  });

  it("names both columns and the field, so the message is actionable", () => {
    try {
      assertNoDuplicateMappings({ Email: "email", "Email Status": "email" });
      throw new Error("expected a throw");
    } catch (e) {
      const err = e as TRPCError;
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("Email");
      expect(err.message).toContain('"Email Status"');
      // The consequence, not just the fact — this is the part a user acts on.
      expect(err.message).toMatch(/only one would be imported/i);
    }
  });

  it("permits a clean mapping, including several skipped columns", () => {
    expect(() =>
      assertNoDuplicateMappings({
        Email: "email", "Email Status": null, Keywords: null, Phone: "phone",
      }),
    ).not.toThrow();
  });

  it("permits an entirely empty mapping", () => {
    expect(() => assertNoDuplicateMappings({})).not.toThrow();
  });
});

describe("the matcher has one definition, and it is not a similarity match", () => {
  const client = read("client/src/pages/usip/ImportContacts.tsx");
  const shared = read("shared/importFields.ts");

  /**
   * Asserted as booleans rather than `expect(client).toMatch(...)` on purpose:
   * a failure of the string form dumps the ENTIRE client file into the report,
   * and that file contains the literal "Failed to parse CSV." — which made
   * guardAudit.mjs classify a correctly-killed mutation as a build break.
   * A guard that reports the wrong verdict on failure is a guard you cannot
   * trust when it matters.
   */
  it("the client calls the shared mapper instead of declaring its own", () => {
    expect(client.includes("autoMapHeaders"), "client no longer calls autoMapHeaders").toBe(true);
    // The exact substring test that caused the bug, in any spacing.
    expect(/includes\(\s*kNorm\s*\)/.test(client), "the fuzzy matcher is back").toBe(false);
    expect(/kNorm\.includes/.test(client), "the fuzzy matcher is back").toBe(false);
  });

  /**
   * Asserted on the shared module too, because moving the flawed matcher into
   * shared/ would satisfy the client-side assertions above while changing
   * nothing about the behaviour.
   */
  it("the shared matcher compares whole headers, never substrings", () => {
    const fn = shared.slice(shared.indexOf("export function matchHeaderToField"));
    expect(fn.length, "matchHeaderToField not found — re-anchor").toBeGreaterThan(200);
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).not.toMatch(/\.includes\(/);
    expect(body).not.toMatch(/\.startsWith\(|\.endsWith\(/);
  });

  it("both procedures refuse a duplicate mapping", () => {
    const src = read("server/routers/imports.ts");
    const calls = src.match(/assertNoDuplicateMappings\(/g) ?? [];
    // One definition + validateRows + commit.
    expect(calls.length).toBeGreaterThanOrEqual(3);

    const validateStart = src.indexOf("validateRows: workspaceProcedure");
    const commitStart = src.indexOf("commit: workspaceProcedure");
    expect(validateStart).toBeGreaterThan(-1);
    expect(commitStart).toBeGreaterThan(validateStart);
    for (const [name, block] of [
      ["validateRows", src.slice(validateStart, commitStart)],
      ["commit", src.slice(commitStart)],
    ] as const) {
      expect(block.length, name).toBeGreaterThan(500);
      expect(block, name).toMatch(/assertNoDuplicateMappings\(/);
    }
  });

  it("commit refuses BEFORE it writes an import history row", () => {
    // Otherwise a rejected import leaves a row claiming it ran.
    const src = read("server/routers/imports.ts");
    const commit = src.slice(src.indexOf("commit: workspaceProcedure"));
    const guardAt = commit.indexOf("assertNoDuplicateMappings(");
    // Single-line anchor on purpose: this repo is CRLF, so a "\n" inside a
    // literal matches nothing and the ordering check would silently never run.
    const insertAt = commit.indexOf(".insert(contactImports)");
    expect(guardAt, "guard missing").toBeGreaterThan(-1);
    expect(insertAt, "import-record insert missing — re-anchor").toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(insertAt);
  });

  it("the mapping UI blocks rather than warning", () => {
    // A warning the user can click past leaves the silent drop in place.
    // Boolean form for the same reason as above.
    expect(/findDuplicateFieldMappings\(/.test(client), "UI no longer detects conflicts").toBe(true);
    // The button's own condition, and the definition that condition depends on.
    // Asserting only `disabled={... !canContinue}` would survive canContinue
    // being redefined to ignore duplicates entirely.
    expect(
      /disabled=\{[^}]*!canContinue/.test(client),
      "the Validate button no longer blocks",
    ).toBe(true);
    expect(
      /canContinue\s*=\s*duplicateMappings\.length === 0/.test(client),
      "canContinue no longer accounts for duplicate mappings",
    ).toBe(true);
  });
});
