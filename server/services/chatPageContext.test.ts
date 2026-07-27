import { describe, it, expect } from "vitest";
import { pageIntent, isNonBuyerPage, describePageContext, pathOf } from "./chatPageContext";

describe("pageIntent", () => {
  it("reads buying intent off the path", () => {
    for (const u of ["https://lsi.example/pricing", "https://lsi.example/book-a-demo", "/get-started", "/free-audit"]) {
      expect(pageIntent(u)).toBe("high");
    }
  });

  it("recognises research pages", () => {
    for (const u of ["/services/automation", "/case-studies/food-banks", "/how-it-works"]) {
      expect(pageIntent(u)).toBe("medium");
    }
  });

  /**
   * The most obviously wrong thing this feature could cause is pitching an
   * audit to someone reading the jobs page. A non-buyer page outranks every
   * other signal, including a keyword that would otherwise read as intent.
   */
  it("treats non-buyer pages as low no matter what else is in the path", () => {
    for (const u of ["/careers", "/jobs/engineer", "/about", "/privacy", "/careers/contact-us"]) {
      expect(pageIntent(u)).toBe("low");
      expect(isNonBuyerPage(u)).toBe(true);
    }
  });

  it("defaults to low rather than guessing", () => {
    expect(pageIntent("/")).toBe("low");
    expect(pageIntent("")).toBe("low");
    expect(pageIntent("not a url at all")).toBe("low");
  });

  it("ignores the domain and matches on the path", () => {
    // "pricing" in the host must not count — only the path is the signal.
    expect(pageIntent("https://pricing.example.com/careers")).toBe("low");
    expect(pageIntent("https://example.com/pricing")).toBe("high");
  });
});

describe("pathOf", () => {
  it("lowercases path and query, dropping the origin", () => {
    expect(pathOf("https://Example.com/Pricing?Plan=Pro")).toBe("/pricing?plan=pro");
  });
  it("accepts a bare path", () => {
    expect(pathOf("/Contact")).toBe("/contact");
  });
  it("is empty-safe", () => {
    expect(pathOf("")).toBe("");
  });
});

describe("describePageContext", () => {
  it("says nothing when it knows nothing", () => {
    expect(describePageContext({})).toBe("");
    expect(describePageContext({ pageUrl: "", pageTitle: "" })).toBe("");
  });

  it("names the page and the referrer", () => {
    const out = describePageContext({
      pageUrl: "https://lsi.example/pricing",
      pageTitle: "Pricing",
      referrer: "https://google.com/",
    });
    expect(out).toContain("Pricing");
    expect(out).toContain("https://lsi.example/pricing");
    expect(out).toContain("arrived from: https://google.com/");
    expect(out).toContain("buying intent");
  });

  it("tells the agent NOT to sell on a careers page", () => {
    const out = describePageContext({ pageUrl: "https://lsi.example/careers", pageTitle: "Careers" });
    expect(out).toMatch(/not.*here to buy/i);
    expect(out).toMatch(/do NOT push for a meeting/);
  });

  it("works with a title but no url", () => {
    expect(describePageContext({ pageTitle: "Some page" })).toContain("Some page");
  });
});
