/**
 * The import mapping audit.
 *
 * An audit is a number somebody will act on, so the ways it can lie matter more
 * than the ways it can work: over-counting invites a destructive "repair" of
 * rows that are fine, and under-counting reads as an all-clear. Each test below
 * pins one of those directions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditFieldMapping,
  companyNameLooksLikeUrl,
  hasMappingDefect,
  isCompanyLinkedInUrl,
  legacyMatchHeaderToField,
  looksLikeVerificationVerdict,
} from "./services/importMappingAudit";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("legacyMatchHeaderToField — the old matcher, preserved", () => {
  /**
   * If this drifts, the audit stops recognising the very mappings it exists to
   * find and quietly reports every workspace as clean. These are the exact
   * mis-assignments from the reported import.
   */
  it("still reproduces the mis-assignments it is there to detect", () => {
    expect(legacyMatchHeaderToField("Email Status")).toBe("email");
    expect(legacyMatchHeaderToField("Company Website")).toBe("company");
    expect(legacyMatchHeaderToField("Company Domain")).toBe("company");
    expect(legacyMatchHeaderToField("Company City")).toBe("company");
    expect(legacyMatchHeaderToField("Company Phone")).toBe("phone");
    expect(legacyMatchHeaderToField("Corporate Phone")).toBe("phone");
  });

  /**
   * FIELD ORDER DECIDED THE DAMAGE, which is precisely what importFields.ts's
   * header warns about. The old matcher took the FIRST field whose key was a
   * substring, and `company` (6th) precedes `linkedinUrl` (7th) — so a company
   * LinkedIn page landed in the company NAME column, not the profile column.
   * Asserted because it tells a repair where to look; guessing the profile
   * column would send it to the wrong field entirely.
   */
  it("put a company LinkedIn page in the company NAME field, not the profile field", () => {
    expect(legacyMatchHeaderToField("Company Linkedin Url")).toBe("company");
    expect(legacyMatchHeaderToField("Person Linkedin Url")).toBe("linkedinUrl");
  });

  it("agrees with the new matcher on headers that were never wrong", () => {
    // These are why a healthy import is not flagged.
    const unchanged: Array<[string, string]> = [
      ["First Name", "firstName"],
      ["Last Name", "lastName"],
      ["Email", "email"],
      ["Job Title", "title"],
      ["City", "city"],
      ["Country", "country"],
    ];
    for (const [header, field] of unchanged) {
      expect(legacyMatchHeaderToField(header), header).toBe(field);
    }
  });
});

describe("auditFieldMapping — what an import actually did", () => {
  it("flags a field two columns claimed, and names the one that WON", () => {
    // Order matters: mapRowToContact keeps the last, so the earlier column is
    // the data that was lost. Naming them the wrong way round would point a
    // repair at the surviving value.
    const f = auditFieldMapping({ Email: "email", "Email Status": "email" });
    expect(f.duplicateClaims).toHaveLength(1);
    expect(f.duplicateClaims[0].field).toBe("email");
    expect(f.duplicateClaims[0].headers).toEqual(["Email", "Email Status"]);
    expect(f.duplicateClaims[0].keptHeader).toBe("Email Status");
    expect(hasMappingDefect(f)).toBe(true);
  });

  /**
   * A duplicate claim with NO suspect assignment beside it.
   *
   * Both of these are legitimate email columns under the current matcher, so
   * the only defect is that two of them claim one field. The earlier test used
   * `Email` + `Email Status`, which trips BOTH detectors at once — and a
   * mutation deleting the duplicate-claims term from `hasMappingDefect`
   * survived it, because the suspect-assignment term still fired. One case per
   * detector, or the two cover for each other.
   */
  it("flags a duplicate claim even when no column was mis-assigned", () => {
    const f = auditFieldMapping({ "Work Email": "email", "Personal Email": "email" });
    expect(f.suspectAssignments).toEqual([]);
    expect(f.duplicateClaims).toHaveLength(1);
    expect(f.duplicateClaims[0].keptHeader).toBe("Personal Email");
    expect(hasMappingDefect(f)).toBe(true);
  });

  it("flags a column the old matcher mis-assigned on its own", () => {
    const f = auditFieldMapping({ "Company Website": "company" });
    expect(f.suspectAssignments).toEqual([
      { header: "Company Website", storedField: "company", correctField: "website" },
    ]);
  });

  it("reports the correct field as null when there is nowhere right to put it", () => {
    // Company Phone describes the employer; the audit must not imply a target.
    const f = auditFieldMapping({ "Company Phone": "phone" });
    expect(f.suspectAssignments[0].correctField).toBeNull();
  });

  it("does NOT flag a deliberate human mapping", () => {
    /**
     * The false-positive that would make the audit useless. Nobody's automatic
     * matcher would map "Mobile" onto company — so a stored mapping saying so
     * is a person's choice, and second-guessing it turns the report into noise.
     */
    const f = auditFieldMapping({ Mobile: "company" });
    expect(f.suspectAssignments).toEqual([]);
    expect(hasMappingDefect(f)).toBe(false);
  });

  it("is silent on a healthy mapping", () => {
    const f = auditFieldMapping({
      "First Name": "firstName", "Last Name": "lastName", Email: "email",
      "Email Status": null, Company: "company", Website: "website",
    });
    expect(f.duplicateClaims).toEqual([]);
    expect(f.suspectAssignments).toEqual([]);
    expect(hasMappingDefect(f)).toBe(false);
  });

  it("ignores skipped columns entirely", () => {
    expect(hasMappingDefect(auditFieldMapping({ a: null, b: null }))).toBe(false);
  });

  it("finds the defect in the reported import's real shape", () => {
    const f = auditFieldMapping({
      "First Name": "firstName", "Last Name": "lastName",
      Email: "email", "Email Status": "email",
      Company: "company", "Job Title": "title",
    });
    expect(f.duplicateClaims).toHaveLength(1);
    expect(f.suspectAssignments.map((s) => s.header)).toContain("Email Status");
  });
});

describe("companyNameLooksLikeUrl — certain vs possible", () => {
  it("is certain about anything that cannot be a name", () => {
    for (const v of ["https://acme.io", "http://acme.io", "www.acme.io", "acme.io/about"]) {
      expect(companyNameLooksLikeUrl(v), v).toBe("certain");
    }
  });

  it("is only POSSIBLE about a bare host, because real companies are named that way", () => {
    // Booking.com and Salesforce.com are legitimate company names. Counting
    // them as damage would make the headline number untrustworthy, and an
    // untrustworthy number is one somebody repairs anyway.
    for (const v of ["acme.io", "Booking.com", "Salesforce.com"]) {
      expect(companyNameLooksLikeUrl(v), v).toBe("possible");
    }
  });

  it("says nothing about an ordinary company name", () => {
    for (const v of ["Acme", "Acme Inc.", "American Wood Fibers, Inc.", "AT&T", "", null, undefined]) {
      expect(companyNameLooksLikeUrl(v as string | null), String(v)).toBeNull();
    }
  });

  it("does not mistake a sentence with a full stop for a domain", () => {
    expect(companyNameLooksLikeUrl("Acme Inc. Holdings")).toBeNull();
  });
});

describe("isCompanyLinkedInUrl", () => {
  it("recognises a company page in the person's profile column", () => {
    expect(isCompanyLinkedInUrl("https://www.linkedin.com/company/acme")).toBe(true);
    expect(isCompanyLinkedInUrl("https://linkedin.com/school/mit")).toBe(true);
    expect(isCompanyLinkedInUrl("HTTPS://WWW.LINKEDIN.COM/COMPANY/ACME")).toBe(true);
  });

  it("leaves a real person's profile alone", () => {
    expect(isCompanyLinkedInUrl("https://www.linkedin.com/in/ada-li")).toBe(false);
    // The word "company" in a person's slug must not trip it.
    expect(isCompanyLinkedInUrl("https://www.linkedin.com/in/ada-company-li")).toBe(false);
    expect(isCompanyLinkedInUrl("")).toBe(false);
    expect(isCompanyLinkedInUrl(null)).toBe(false);
  });
});

describe("looksLikeVerificationVerdict", () => {
  it("recognises the verdict vocabularies that reach these files", () => {
    for (const v of ["valid", "unknown", "catch-all", "accept_all", "risky", "Unavailable", "GUESSED"]) {
      expect(looksLikeVerificationVerdict(v), v).toBe(true);
    }
  });

  it("never flags a real address", () => {
    for (const v of ["ada@acme.io", "valid@acme.io", "unknown@acme.io", "", null]) {
      expect(looksLikeVerificationVerdict(v as string | null), String(v)).toBe(false);
    }
  });
});

describe("the audit cannot write", () => {
  /**
   * The whole premise is "count before you touch". A mutation, or a later
   * well-meaning edit, that adds a repair here would change what this endpoint
   * DOES while its name and its UI still say it only reports.
   */
  const src = read("server/services/importMappingAudit.ts");

  it("issues no destructive statement", () => {
    for (const verb of [".update(", ".insert(", ".delete("]) {
      expect(src.includes(verb), `audit performs ${verb}`).toBe(false);
    }
  });

  it("is exposed as an admin-scoped query, not a mutation", () => {
    const router = read("server/routers/dataHealth.ts");
    const at = router.indexOf("importMappingAudit:");
    expect(at, "procedure missing — re-anchor").toBeGreaterThan(-1);
    const decl = router.slice(at, at + 160);
    expect(decl).toContain("adminWsProcedure");
    expect(decl).toContain(".query(");
    expect(decl).not.toContain(".mutation(");
  });

  it("tells the reader what it could not see", () => {
    // A zero from a bounded scan reads as an all-clear unless the bound is
    // stated. Both limits are pushed into `notes`, not left in a comment.
    expect(src).toMatch(/notes\.push\(/);
    expect(src).toMatch(/RESIDUE_SCAN_CAP/);
    expect(src).toMatch(/cannot be detected by inspection/);
  });

  /**
   * Scope asserted PER QUERY, in a bounded window.
   *
   * A whole-file `toMatch(/eq\(contacts\.workspaceId/)` passed while the
   * residue scan's scope was deleted — the copy in the alive-rows join
   * satisfied it. That is `b15490d`'s lesson exactly: one scoped query
   * satisfies a file-level assertion forever, however many unscoped siblings
   * join it. Dropping a scope here would report another tenant's rows as this
   * workspace's damage.
   */
  function queryWindow(startAnchor: string, endAnchor: string): string {
    const at = src.indexOf(startAnchor);
    expect(at, `start anchor not found — re-anchor: ${startAnchor}`).toBeGreaterThan(-1);
    const end = src.indexOf(endAnchor, at + startAnchor.length);
    expect(end, `end anchor not found — re-anchor: ${endAnchor}`).toBeGreaterThan(at);
    const w = src.slice(at, end);
    expect(w.length, `window too small to be the real query: ${startAnchor}`).toBeGreaterThan(120);
    return w;
  }

  it("scopes the imports read to the workspace", () => {
    const w = queryWindow("const imports = await db", "const affected:");
    expect(w).toMatch(/eq\(contactImports\.workspaceId, workspaceId\)/);
  });

  it("scopes the contacts residue scan to the workspace", () => {
    const w = queryWindow("const contactRows = await db", ".limit(RESIDUE_SCAN_CAP)");
    expect(w).toMatch(/eq\(contacts\.workspaceId, workspaceId\)/);
  });

  it("scopes the prospects residue scan to the workspace", () => {
    const w = queryWindow("const prospectRows = await db", ".limit(RESIDUE_SCAN_CAP)");
    expect(w).toMatch(/eq\(prospects\.workspaceId, workspaceId\)/);
  });

  it("scopes both sides of the still-present join", () => {
    const w = queryWindow("const alive = await db", "const byImport");
    expect(w).toMatch(/eq\(contacts\.workspaceId, workspaceId\)/);
    expect(w).toMatch(/eq\(prospects\.workspaceId, workspaceId\)/);
    expect(w).toMatch(/inArray\(contactImportRows\.importId, ids\)/);
  });
});
