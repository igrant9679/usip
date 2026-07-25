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
