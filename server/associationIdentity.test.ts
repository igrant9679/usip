/**
 * Where a person's company comes from (owner directive 2026-08-13, after a
 * live association run split one org into six accounts and gave others
 * somebody else's employer as their domain).
 *
 * The rule: LinkedIn states where a person works. A mailbox domain does not —
 * parents, board members and partners carry dc.gov, ftc.gov, a spouse's
 * company. So a mailbox domain may still RECOGNISE an account that already
 * owns that domain, but it may never name a company, give one its domain, or
 * be the only reason a company gets created.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { companyInputFromProspect } from "./services/company/associationService";

const src = readFileSync("server/services/company/associationService.ts", "utf8");

describe("LinkedIn is the company source", () => {
  it("prefers the LinkedIn company over the record's own company field", () => {
    const input = companyInputFromProspect(
      { company: "Takoma Children's School", companyDomain: null, email: "jane@dc.gov" },
      { companyName: "Takoma Children's School", companyDomain: "takomachildren.org" },
    );
    expect(input.name).toBe("Takoma Children's School");
    expect(input.domain).toBe("takomachildren.org");
    expect(input.website).toBe("takomachildren.org");
  });

  it("falls back to the record's fields when LinkedIn has nothing", () => {
    const input = companyInputFromProspect({ company: "Acme", companyDomain: "acme.com", email: "j@acme.com" }, null);
    expect(input.name).toBe("Acme");
    expect(input.domain).toBe("acme.com");
  });

  it("ignores a blank LinkedIn company rather than blanking the record's own", () => {
    const input = companyInputFromProspect({ company: "Acme", companyDomain: "acme.com" }, { companyName: "  ", companyDomain: "" });
    expect(input.name).toBe("Acme");
    expect(input.domain).toBe("acme.com");
  });
});

describe("a mailbox domain is not a company", () => {
  it("is still exposed for MATCHING an account that already owns it", () => {
    const input = companyInputFromProspect({ company: "Acme", email: "jane@acme.com" }, null);
    expect(input.emailDomain).toBe("acme.com");
  });

  it("never becomes a created company's domain", () => {
    // Both identity writers must derive the domain from company sources only.
    const creators = src.split("const domain = normalizeDomain(input.domain)");
    expect(creators.length).toBeGreaterThan(2); // upsertGlobalOrganization + createWorkspaceAccount
    for (const after of creators.slice(1)) {
      const expr = after.slice(0, after.indexOf(";"));
      expect(expr).not.toContain("emailDomain");
    }
  });

  it("is not, by itself, a usable identity — it cannot mint a company", () => {
    const fn = src.slice(src.indexOf("function hasUsableIdentity"), src.indexOf("function hasUsableIdentity") + 300);
    expect(fn).not.toContain("emailDomain");
  });
});

describe("the sweep does not do a LinkedIn read per prospect", () => {
  it("batches the lookup for the whole page", () => {
    const sweep = src.slice(src.indexOf("export async function associateUnlinkedProspects"));
    expect(sweep).toContain("linkedInCompanyFactsFor(workspaceId, rows.map((p) => p.id))");
    expect(sweep).toContain("linkedin: linkedin.get(p.id) ?? null");
  });
});
