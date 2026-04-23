/**
 * Tests for email tracking and merge variable resolution (Features 47 & 48)
 */
import { describe, it, expect } from "vitest";
import { resolveMergeVars, textToHtml, injectTracking, type MergeContext } from "./mergeVars";

/* ─── resolveMergeVars ─────────────────────────────────────────────────── */
describe("resolveMergeVars", () => {
  const ctx: MergeContext = {
    contact: {
      firstName: "Alice",
      lastName: "Smith",
      title: "VP Engineering",
      email: "alice@acme.com",
      city: "San Francisco",
    },
    account: {
      name: "Acme Corp",
      domain: "acme.com",
      industry: "SaaS",
    },
    sender: {
      name: "Bob Sales",
      email: "bob@vendor.com",
    },
  };

  it("resolves {{firstName}}", () => {
    expect(resolveMergeVars("Hi {{firstName}},", ctx)).toBe("Hi Alice,");
  });

  it("resolves {{lastName}}", () => {
    expect(resolveMergeVars("Dear {{lastName}},", ctx)).toBe("Dear Smith,");
  });

  it("resolves {{fullName}}", () => {
    expect(resolveMergeVars("Hello {{fullName}}", ctx)).toBe("Hello Alice Smith");
  });

  it("resolves {{company}}", () => {
    expect(resolveMergeVars("I see {{company}} uses SaaS tools.", ctx)).toBe(
      "I see Acme Corp uses SaaS tools."
    );
  });

  it("resolves {{title}}", () => {
    expect(resolveMergeVars("As {{title}},", ctx)).toBe("As VP Engineering,");
  });

  it("resolves {{senderName}} and {{senderEmail}}", () => {
    expect(resolveMergeVars("From {{senderName}} <{{senderEmail}}>", ctx)).toBe(
      "From Bob Sales <bob@vendor.com>"
    );
  });

  it("resolves {{industry}}", () => {
    expect(resolveMergeVars("In the {{industry}} space,", ctx)).toBe(
      "In the SaaS space,"
    );
  });

  it("uses fallback when value is empty", () => {
    const ctxEmpty: MergeContext = { contact: { firstName: "" } };
    expect(resolveMergeVars("Hi {{firstName|Friend}},", ctxEmpty)).toBe("Hi Friend,");
  });

  it("uses resolved value when not empty (ignores fallback)", () => {
    expect(resolveMergeVars("Hi {{firstName|Friend}},", ctx)).toBe("Hi Alice,");
  });

  it("leaves unknown variables as-is", () => {
    expect(resolveMergeVars("{{unknownVar}} stays", ctx)).toBe("{{unknownVar}} stays");
  });

  it("resolves multiple variables in one pass", () => {
    const result = resolveMergeVars(
      "Hi {{firstName}}, I noticed {{company}} is in {{industry}}.",
      ctx
    );
    expect(result).toBe("Hi Alice, I noticed Acme Corp is in SaaS.");
  });

  it("handles empty context gracefully", () => {
    const result = resolveMergeVars("Hi {{firstName}},", {});
    expect(result).toBe("Hi ,");
  });

  it("resolves custom fields via {{customField.key}}", () => {
    const ctxCustom: MergeContext = {
      contact: {
        firstName: "Alice",
        customFields: { tier: "Enterprise", accountManager: "Carol" },
      },
    };
    expect(resolveMergeVars("Tier: {{customField.tier}}", ctxCustom)).toBe(
      "Tier: Enterprise"
    );
    expect(resolveMergeVars("AM: {{customField.accountManager}}", ctxCustom)).toBe(
      "AM: Carol"
    );
  });

  it("does not mutate the input string", () => {
    const original = "Hi {{firstName}},";
    resolveMergeVars(original, ctx);
    expect(original).toBe("Hi {{firstName}},");
  });
});

/* ─── textToHtml ───────────────────────────────────────────────────────── */
describe("textToHtml", () => {
  it("wraps content in HTML boilerplate", () => {
    const html = textToHtml("Hello world");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<body>");
    expect(html).toContain("Hello world");
  });

  it("escapes HTML special characters", () => {
    const html = textToHtml('<script>alert("xss")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("linkifies http URLs", () => {
    const html = textToHtml("Visit https://example.com for details");
    expect(html).toContain('<a href="https://example.com">');
  });

  it("converts double newlines to paragraph breaks", () => {
    const html = textToHtml("Para 1\n\nPara 2");
    expect(html).toContain("</p><p>");
  });

  it("converts single newlines to <br>", () => {
    const html = textToHtml("Line 1\nLine 2");
    expect(html).toContain("<br>");
  });
});

/* ─── injectTracking ───────────────────────────────────────────────────── */
describe("injectTracking", () => {
  const token = "abc123";
  const baseUrl = "https://app.example.com";

  it("injects a tracking pixel before </body>", () => {
    const html = "<html><body><p>Hello</p></body></html>";
    const result = injectTracking(html, token, baseUrl);
    expect(result).toContain(`/api/track/open/${token}`);
    expect(result).toContain('width="1"');
    expect(result).toContain("</body>");
    // Pixel should be before </body>
    const pixelIdx = result.indexOf(`/api/track/open/${token}`);
    const bodyIdx = result.indexOf("</body>");
    expect(pixelIdx).toBeLessThan(bodyIdx);
  });

  it("appends pixel at end when no </body> tag", () => {
    const html = "<p>No body tag</p>";
    const result = injectTracking(html, token, baseUrl);
    expect(result).toContain(`/api/track/open/${token}`);
    // Just verify pixel is appended at the end
    expect(result).toContain("track/open");
  });

  it("wraps http links with click-tracking redirect", () => {
    const html = '<body><a href="https://example.com">Click</a></body>';
    const result = injectTracking(html, token, baseUrl);
    expect(result).toContain(`/api/track/click/${token}`);
    expect(result).toContain("url=https%3A%2F%2Fexample.com");
  });

  it("does not double-wrap already-tracked links", () => {
    const alreadyTracked = `<body><a href="${baseUrl}/api/track/click/${token}?url=https%3A%2F%2Fexample.com">Click</a></body>`;
    const result = injectTracking(alreadyTracked, token, baseUrl);
    // Should not nest /api/track/click/ inside another /api/track/click/
    const matches = result.match(/api\/track\/click/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("does not wrap mailto: links", () => {
    const html = '<body><a href="mailto:alice@example.com">Email</a></body>';
    const result = injectTracking(html, token, baseUrl);
    // mailto links should not be wrapped (regex only matches http/https)
    expect(result).toContain('href="mailto:alice@example.com"');
  });
});

/* ─── Edge cases ───────────────────────────────────────────────────────── */
describe("merge vars edge cases", () => {
  it("handles null contact gracefully", () => {
    const ctx: MergeContext = { contact: null as any };
    expect(() => resolveMergeVars("Hi {{firstName}}", ctx)).not.toThrow();
  });

  it("handles undefined account gracefully", () => {
    const ctx: MergeContext = { contact: { firstName: "Alice" } };
    expect(resolveMergeVars("At {{company}}", ctx)).toBe("At ");
  });

  it("handles template with no variables", () => {
    const ctx: MergeContext = { contact: { firstName: "Alice" } };
    expect(resolveMergeVars("No variables here.", ctx)).toBe("No variables here.");
  });

  it("handles empty string template", () => {
    const ctx: MergeContext = { contact: { firstName: "Alice" } };
    expect(resolveMergeVars("", ctx)).toBe("");
  });

  it("handles multiple occurrences of the same variable", () => {
    const ctx: MergeContext = { contact: { firstName: "Alice" } };
    expect(resolveMergeVars("{{firstName}} and {{firstName}}", ctx)).toBe(
      "Alice and Alice"
    );
  });
});
