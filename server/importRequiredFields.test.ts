/**
 * Mandatory import fields, and the fact that they depend on the DESTINATION.
 *
 * Email is required for `contacts` and deliberately NOT for `prospects`. That
 * asymmetry is the whole design, so it is asserted in both directions: a CRM
 * contact with no address cannot be sequenced, while the prospects backlog
 * exists precisely to hold people whose address is not known yet and hand them
 * to the enrichment sweeper. Requiring an email there would reject the rows the
 * destination was built for.
 *
 * Two halves are enforced and neither implies the other:
 *   · MAPPING level — no column is assigned to a required field;
 *   · ROW level — a column is mapped but this row's cell is empty.
 */
import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTACT_IMPORT_FIELDS,
  isFieldRequiredFor,
  missingRequiredMappings,
  requiredFieldKeysFor,
  requiredFieldsFor,
} from "@shared/importFields";
import { assertRequiredFieldsMapped, classifyImportRow } from "./routers/imports";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

const sets = () => ({
  existingEmails: new Set<string>(),
  seenEmails: new Set<string>(),
  existingNameKeys: new Set<string>(),
  seenNameKeys: new Set<string>(),
  matchOnNameCompany: false,
  skipDuplicates: true,
});

describe("which fields are mandatory", () => {
  it("requires name, company AND email for CRM contacts", () => {
    expect(requiredFieldKeysFor("contacts").sort()).toEqual(
      ["company", "email", "firstName", "lastName"].sort(),
    );
  });

  it("requires name and company for prospects, but NOT email", () => {
    expect(requiredFieldKeysFor("prospects").sort()).toEqual(
      ["company", "firstName", "lastName"].sort(),
    );
    expect(requiredFieldKeysFor("prospects")).not.toContain("email");
  });

  it("keeps company mandatory for prospects, because the sweeper needs it", () => {
    // The free domain pass resolves a company NAME to a domain, and the email
    // finder needs that domain. A prospect with no company is unworkable by
    // every pass in the pipeline, so this is not tidiness.
    const email = CONTACT_IMPORT_FIELDS.find((f) => f.key === "email")!;
    const company = CONTACT_IMPORT_FIELDS.find((f) => f.key === "company")!;
    expect(isFieldRequiredFor(company, "prospects")).toBe(true);
    expect(isFieldRequiredFor(email, "prospects")).toBe(false);
    expect(isFieldRequiredFor(email, "contacts")).toBe(true);
  });

  it("leaves everything else optional", () => {
    const optional = CONTACT_IMPORT_FIELDS.filter((f) => f.requiredFor.length === 0).map((f) => f.key);
    expect(optional).toEqual(
      ["phone", "title", "linkedinUrl", "website", "industry", "city", "state", "country", "seniority"],
    );
  });

  it("lists required fields in mapping-screen order", () => {
    // The UI prints this list; out-of-order would read as a different product.
    expect(requiredFieldsFor("contacts").map((f) => f.label)).toEqual(
      ["First Name", "Last Name", "Email", "Company"],
    );
  });
});

describe("mapping level — a required field with no column", () => {
  const mapped = { A: "firstName", B: "lastName", C: "company", D: "email" };

  it("passes a complete contacts mapping", () => {
    expect(missingRequiredMappings(mapped, "contacts")).toEqual([]);
    expect(() => assertRequiredFieldsMapped(mapped, "contacts")).not.toThrow();
  });

  it("names exactly what is missing", () => {
    const { D, ...noEmail } = mapped;
    expect(missingRequiredMappings(noEmail, "contacts").map((f) => f.label)).toEqual(["Email"]);
  });

  it("accepts the SAME file for prospects that it refuses for contacts", () => {
    // The asymmetry, stated as one assertion pair — this is the behaviour a
    // user hits when a list has no email column.
    const { D, ...noEmail } = mapped;
    expect(() => assertRequiredFieldsMapped(noEmail, "contacts")).toThrow(TRPCError);
    expect(() => assertRequiredFieldsMapped(noEmail, "prospects")).not.toThrow();
  });

  it("tells the user where to go instead of only what is wrong", () => {
    const { D, ...noEmail } = mapped;
    try {
      assertRequiredFieldsMapped(noEmail, "contacts");
      throw new Error("expected a throw");
    } catch (e) {
      const err = e as TRPCError;
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("Email");
    }
  });

  it("does not count a column mapped to null as mapping the field", () => {
    expect(missingRequiredMappings({ A: "firstName", B: null }, "prospects").map((f) => f.key))
      .toEqual(["lastName", "company"]);
  });
});

describe("row level — a mapped column that is empty on this row", () => {
  const contactsRequired = requiredFieldKeysFor("contacts");
  const prospectsRequired = requiredFieldKeysFor("prospects");

  it("rejects a contacts row with no email", () => {
    const v = classifyImportRow(
      { firstName: "Ada", lastName: "Li", company: "Acme", email: "" },
      { ...sets(), requiredFields: contactsRequired },
    );
    expect(v.status).toBe("error");
    expect(v.reason).toContain("Missing Email");
  });

  it("accepts the SAME row for prospects", () => {
    const v = classifyImportRow(
      { firstName: "Ada", lastName: "Li", company: "Acme", email: "" },
      { ...sets(), requiredFields: prospectsRequired },
    );
    expect(v.status).toBe("ok");
  });

  it("rejects a row with no company for either destination", () => {
    for (const required of [contactsRequired, prospectsRequired]) {
      const v = classifyImportRow(
        { firstName: "Ada", lastName: "Li", email: "ada@acme.io" },
        { ...sets(), requiredFields: required },
      );
      expect(v.status).toBe("error");
      expect(v.reason).toContain("Missing Company");
    }
  });

  it("treats whitespace as missing", () => {
    const v = classifyImportRow(
      { firstName: "Ada", lastName: "Li", company: "   ", email: "ada@acme.io" },
      { ...sets(), requiredFields: contactsRequired },
    );
    expect(v.status).toBe("error");
    expect(v.reason).toContain("Missing Company");
  });

  it("reports every missing field at once, in mapping-screen order", () => {
    // One row, one trip: reporting only the first would make fixing a file an
    // n-round-trip exercise.
    const v = classifyImportRow({}, { ...sets(), requiredFields: contactsRequired });
    expect(v.reason).toBe("Missing First Name; Missing Last Name; Missing Email; Missing Company");
  });

  it("still rejects a malformed email even where email is optional", () => {
    // Optional means "may be absent", never "may be junk" — this is the check
    // the reported Email Status import tripped.
    const v = classifyImportRow(
      { firstName: "Ada", lastName: "Li", company: "Acme", email: "valid" },
      { ...sets(), requiredFields: prospectsRequired },
    );
    expect(v.status).toBe("error");
    expect(v.reason).toContain("Invalid email format");
  });

  it("REFUSES to run without a required-field set", () => {
    /**
     * `new Set(undefined)` is a valid empty set, so a caller that forgets this
     * argument would silently require nothing and import every row. That is the
     * fail-open shape this repo keeps getting bitten by, so it throws instead.
     */
    expect(() =>
      classifyImportRow({ firstName: "A" }, { ...sets() } as never),
    ).toThrow(/requiredFields is missing/);
  });
});

describe("preview and import cannot disagree about what is required", () => {
  const src = read("server/routers/imports.ts");

  it("both procedures derive the set from the same destination-keyed helper", () => {
    const calls = src.match(/requiredFieldKeysFor\(input\.destination\)/g) ?? [];
    expect(calls.length).toBe(2); // validateRows + commit, and nothing hardcoded
  });

  it("both procedures check the mapping, not just the preview", () => {
    // commit had NO mapping-level check at all: an unmapped required field was
    // a preview error and a successful import for anyone skipping the preview.
    const validateStart = src.indexOf("validateRows: workspaceProcedure");
    const commitStart = src.indexOf("commit: workspaceProcedure");
    expect(validateStart).toBeGreaterThan(-1);
    expect(commitStart).toBeGreaterThan(validateStart);
    for (const [name, block] of [
      ["validateRows", src.slice(validateStart, commitStart)],
      ["commit", src.slice(commitStart)],
    ] as const) {
      expect(block.length, name).toBeGreaterThan(500);
      expect(block, name).toMatch(/assertRequiredFieldsMapped\(mapping, input\.destination\)/);
      expect(block, name).toMatch(/requiredFields,/);
    }
  });

  it("no procedure hardcodes a field name in place of the helper", () => {
    // The old code named First Name and Last Name inline; a second literal list
    // is how the two halves drift apart again.
    expect(/f\.required\b/.test(src), "stale per-field required flag still read").toBe(false);
  });

  it("the mapping screen asks the same helper the server does", () => {
    const client = read("client/src/pages/usip/ImportContacts.tsx");
    expect(/missingRequiredMappings\(fieldMapping, destination\)/.test(client)).toBe(true);
    expect(/isFieldRequiredFor\(f, destination\)/.test(client)).toBe(true);
    // And it must not print a hardcoded list beside a dynamic one.
    expect(/Required fields: First Name, Last Name/.test(client)).toBe(false);
  });

  it("the mapping screen BLOCKS on a missing required field, not just on a conflict", () => {
    /**
     * Detecting it and refusing to continue are different things. A mutation
     * that dropped the `missingRequired` term from `canContinue` left every
     * other client assertion green — the screen still computed the list and
     * still rendered the warning, and the button still blocked on duplicates.
     */
    const client = read("client/src/pages/usip/ImportContacts.tsx");
    expect(
      /canContinue\s*=\s*duplicateMappings\.length === 0 && missingRequired\.length === 0/.test(client),
      "canContinue no longer accounts for unmapped required fields",
    ).toBe(true);
    expect(/disabled=\{[^}]*!canContinue/.test(client)).toBe(true);
  });
});
