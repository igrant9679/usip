/**
 * companyFromHeadline turns vendor prose into a CRM field that later passes
 * resolve to a domain and mail. A wrong answer is therefore worse than no
 * answer, and these cases are the line between the two.
 *
 * The real headlines here came from the live workspace: LinkedIn withholds
 * structured work history for third-degree profiles, so the headline is the
 * only place the employer appears.
 */
import { describe, it, expect } from "vitest";
import { companyFromHeadline } from "./enrichmentSweeper";

describe("companyFromHeadline", () => {
  it("reads the real headlines this was built for", () => {
    expect(companyFromHeadline("Chief Financial Officer at George Industries")).toBe("George Industries");
    expect(companyFromHeadline("Chief Financial Officer at American Wood Fibers, Inc.")).toBe("American Wood Fibers, Inc.");
  });

  it("keeps a trailing period that belongs to the name", () => {
    expect(companyFromHeadline("CFO at Acme Inc.")).toBe("Acme Inc.");
  });

  it("handles the @ form", () => {
    expect(companyFromHeadline("Head of Ops @ Northwind Foundation")).toBe("Northwind Foundation");
  });

  it("takes the first role when a headline chains several", () => {
    expect(companyFromHeadline("CFO at George Industries | Board Member at Acme Trust")).toBe("George Industries");
    expect(companyFromHeadline("ED at Hope Center • Advisor at Other Co")).toBe("Hope Center");
  });

  it("returns null when there is no employer to read", () => {
    for (const h of ["Nonprofit Leader", "Chief Financial Officer", "", "   ", null, undefined]) {
      expect(companyFromHeadline(h)).toBeNull();
    }
  });

  it("rejects idioms that merely contain the word at", () => {
    expect(companyFromHeadline("Consultant at large")).toBeNull();
    expect(companyFromHeadline("Building at scale")).toBeNull();
  });

  it("rejects prose rather than guessing a company out of it", () => {
    // Real marketing-headline shape. The first draft accepted this and would
    // have written "every stage of their journey..." into the CRM as a company.
    expect(companyFromHeadline("I help nonprofits at every stage of their journey grow their impact and reach")).toBeNull();
    expect(companyFromHeadline("Speaking at conferences about nonprofit strategy")).toBeNull();
    expect(companyFromHeadline(`Director at ${"x".repeat(150)}`)).toBeNull();
  });

  it("still accepts long-but-real names and lowercase-first brands", () => {
    expect(companyFromHeadline("Program Officer at The Bill and Melinda Gates Foundation"))
      .toBe("The Bill and Melinda Gates Foundation");
    expect(companyFromHeadline("Engineer at eBay")).toBe("eBay");
    expect(companyFromHeadline("Analyst at iRobot")).toBe("iRobot");
  });

  it("does not treat a comma as a separator", () => {
    // The obvious wrong implementation cuts here and stores "American Wood Fibers".
    expect(companyFromHeadline("CFO at American Wood Fibers, Inc.")).toContain("Inc.");
  });

  it("trims trailing separator noise", () => {
    expect(companyFromHeadline("CFO at Acme Corp -")).toBe("Acme Corp");
    expect(companyFromHeadline("CFO at Acme Corp,")).toBe("Acme Corp");
  });

  it("reads the dash form only when a legal suffix vouches for it", () => {
    // Live workspace headline (Ron Flournoy): the employer arrives after a
    // dash, and the LLC suffix is what makes it safe to accept.
    expect(companyFromHeadline("Vice President of Operations - Lifecycle Construction Services, LLC"))
      .toBe("Lifecycle Construction Services, LLC");
    expect(companyFromHeadline("Executive Director - Northwind Foundation")).toBe("Northwind Foundation");
  });

  it("rejects dash tails without a suffix — they are departments, not employers", () => {
    expect(companyFromHeadline("Sales Manager - Northeast Region")).toBeNull();
    expect(companyFromHeadline("Director - Client Services")).toBeNull();
    // State code after a comma-less dash must not be read as "Co".
    expect(companyFromHeadline("Consultant - Denver Co")).toBeNull();
  });

  it("uses the LAST dash so earlier segments read as departments", () => {
    expect(companyFromHeadline("VP - Operations - Acme Inc.")).toBe("Acme Inc.");
  });

  it("never lets the dash form preempt the at/@ form", () => {
    expect(companyFromHeadline("VP - Operations at George Industries")).toBe("George Industries");
  });
});
