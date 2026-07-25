/**
 * Data cleanup helpers. These decide whether real CRM fields get overwritten,
 * so the conservative behaviour is what's pinned here.
 */
import { describe, it, expect } from "vitest";
import { looksLikeUrl, companyFromUrl } from "./routers/dataCleanup";

describe("looksLikeUrl", () => {
  it("detects the URL shapes actually found in companyName", () => {
    expect(looksLikeUrl("https://facebook.com/mongodb")).toBe(true);
    expect(looksLikeUrl("http://acme.com")).toBe(true);
    expect(looksLikeUrl("www.acme.com")).toBe(true);
    expect(looksLikeUrl("acme.com/about")).toBe(true);
  });

  it("leaves real company names alone", () => {
    // A false positive here would overwrite good data.
    expect(looksLikeUrl("Acme")).toBe(false);
    expect(looksLikeUrl("Acme Inc.")).toBe(false);
    expect(looksLikeUrl("Smith & Co")).toBe(false);
    expect(looksLikeUrl("")).toBe(false);
    expect(looksLikeUrl(null)).toBe(false);
  });
});

describe("companyFromUrl", () => {
  it("takes the profile slug from a social URL", () => {
    expect(companyFromUrl("https://facebook.com/mongodb")).toBe("mongodb");
    expect(companyFromUrl("https://www.linkedin.com/company/softchoice")).toBe("softchoice");
  });

  it("takes the host label from a plain company domain", () => {
    expect(companyFromUrl("https://acme.com/about")).toBe("acme");
    expect(companyFromUrl("www.acme-corp.com")).toBe("acme corp");
  });

  it("does not invent capitalisation", () => {
    // Turning "mongodb" into "MongoDB" would be guessing; a lowercase slug is
    // honest and still matches far better than a full URL.
    expect(companyFromUrl("https://facebook.com/mongodb")).not.toBe("MongoDB");
  });

  it("returns null when there is nothing to extract", () => {
    expect(companyFromUrl("")).toBeNull();
    expect(companyFromUrl(null)).toBeNull();
  });
});

describe("companyDomainFromUrl", () => {
  it("refuses to treat a social host as the company's domain", async () => {
    const { companyDomainFromUrl } = await import("./routers/dataCleanup");
    // Caught by the first dry run: this would have written facebook.com onto
    // 756 contacts. A wrong domain poisons matching worse than an empty one.
    expect(companyDomainFromUrl("https://facebook.com/mongodb")).toBeNull();
    expect(companyDomainFromUrl("https://www.linkedin.com/company/softchoice")).toBeNull();
  });

  it("keeps a genuine company domain", async () => {
    const { companyDomainFromUrl } = await import("./routers/dataCleanup");
    expect(companyDomainFromUrl("https://www.acme.com/about")).toBe("acme.com");
    expect(companyDomainFromUrl("acme.co.uk")).toBe("acme.co.uk");
  });

  it("returns null for anything without a host", async () => {
    const { companyDomainFromUrl } = await import("./routers/dataCleanup");
    expect(companyDomainFromUrl("acme")).toBeNull();
    expect(companyDomainFromUrl("")).toBeNull();
  });
});
