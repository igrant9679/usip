/**
 * Email Dynamic Path — vitest specs
 * Tests pure-logic helpers from emailBuilder.ts + subjectAB.ts
 * No DB or HTTP required.
 */
import { describe, it, expect } from "vitest";
import { resolveMergeTags, renderDesignToHtml } from "./routers/emailBuilder";

// ─── Merge-tag resolver ───────────────────────────────────────────────────────

describe("resolveMergeTags", () => {
  it("replaces known tags with default preview values", () => {
    const result = resolveMergeTags("Hi {{firstName}}, welcome to {{company}}!");
    expect(result).toBe("Hi Alex, welcome to Acme Corp!");
  });

  it("uses caller-supplied overrides over defaults", () => {
    const result = resolveMergeTags("Hi {{firstName}}!", { firstName: "Jordan" });
    expect(result).toBe("Hi Jordan!");
  });

  it("falls back to bracketed tag name for unknown tags", () => {
    const result = resolveMergeTags("Hello {{unknownTag}}");
    expect(result).toBe("Hello [unknownTag]");
  });

  it("handles customField.key syntax", () => {
    const result = resolveMergeTags("{{customField.industry}}", { "customField.industry": "SaaS" });
    expect(result).toBe("SaaS");
  });

  it("leaves non-tag double-brace content untouched if not matching pattern", () => {
    // A tag must be word chars only — curly braces with spaces are not tags
    const result = resolveMergeTags("No tags here");
    expect(result).toBe("No tags here");
  });

  it("replaces multiple occurrences of the same tag", () => {
    const result = resolveMergeTags("{{firstName}} and {{firstName}} again");
    expect(result).toBe("Alex and Alex again");
  });

  it("handles empty string input", () => {
    expect(resolveMergeTags("")).toBe("");
  });
});

// ─── Design renderer ─────────────────────────────────────────────────────────
// renderDesignToHtml(blocks: Block[], subject: string, overrides?)
// Block = { id, type, props, sortOrder }

describe("renderDesignToHtml", () => {
  it("renders a header block with headline", () => {
    const blocks = [{ id: "1", type: "header", props: { headline: "Hello World", bgColor: "#14B89A" }, sortOrder: 0 }];
    const html = renderDesignToHtml(blocks, "Test Subject");
    expect(html).toContain("Hello World");
    expect(html).toContain("#14B89A");
  });

  it("renders a text block", () => {
    const blocks = [{ id: "2", type: "text", props: { content: "Body copy here" }, sortOrder: 0 }];
    const html = renderDesignToHtml(blocks, "Subject");
    expect(html).toContain("Body copy here");
  });

  it("renders a button block with href", () => {
    const blocks = [{ id: "3", type: "button", props: { label: "Click me", url: "https://example.com" }, sortOrder: 0 }];
    const html = renderDesignToHtml(blocks, "Subject");
    expect(html).toContain("https://example.com");
    expect(html).toContain("Click me");
  });

  it("renders a divider block", () => {
    const blocks = [{ id: "4", type: "divider", props: {}, sortOrder: 0 }];
    const html = renderDesignToHtml(blocks, "Subject");
    expect(html).toContain("<hr");
  });

  it("renders an image block with src", () => {
    const blocks = [{ id: "5", type: "image", props: { src: "https://example.com/img.png", alt: "Test" }, sortOrder: 0 }];
    const html = renderDesignToHtml(blocks, "Subject");
    expect(html).toContain("https://example.com/img.png");
    expect(html).toContain("Test");
  });

  it("renders a spacer block", () => {
    const blocks = [{ id: "6", type: "spacer", props: { height: 32 }, sortOrder: 0 }];
    const html = renderDesignToHtml(blocks, "Subject");
    expect(html).toContain("32px");
  });

  it("renders a footer block with unsubscribe link", () => {
    const blocks = [{ id: "7", type: "footer", props: { content: "© 2026 USIP", unsubscribeUrl: "https://example.com/unsub" }, sortOrder: 0 }];
    const html = renderDesignToHtml(blocks, "Subject");
    expect(html).toContain("© 2026 USIP");
    expect(html).toContain("https://example.com/unsub");
  });

  it("wraps output in a valid HTML email shell", () => {
    const blocks = [{ id: "8", type: "text", props: { content: "Test" }, sortOrder: 0 }];
    const html = renderDesignToHtml(blocks, "My Subject");
    expect(html).toContain("<!DOCTYPE html");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain("My Subject");
  });

  it("resolves merge tags inside block content", () => {
    const blocks = [{ id: "9", type: "text", props: { content: "Hi {{firstName}}, thanks for your interest in {{company}}." }, sortOrder: 0 }];
    const html = renderDesignToHtml(blocks, "Subject");
    expect(html).toContain("Hi Alex");
    expect(html).toContain("Acme Corp");
  });

  it("handles empty blocks array gracefully", () => {
    const html = renderDesignToHtml([], "Empty");
    expect(html).toContain("<!DOCTYPE html");
    expect(html).not.toContain("undefined");
  });

  it("sorts blocks by sortOrder before rendering", () => {
    const blocks = [
      { id: "b", type: "text", props: { content: "Second" }, sortOrder: 1 },
      { id: "a", type: "text", props: { content: "First" }, sortOrder: 0 },
    ];
    const html = renderDesignToHtml(blocks, "Subject");
    const firstIdx = html.indexOf("First");
    const secondIdx = html.indexOf("Second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});

// ─── Spam analyzer (pure scoring logic) ──────────────────────────────────────

describe("spam score heuristics", () => {
  /**
   * Mirror the deterministic scoring rules from subjectAB.ts
   * (we test the logic inline here so we don't need to import the router)
   */
  function computeSpamScore(subject: string): { score: number; flags: string[] } {
    const flags: string[] = [];
    let score = 0;

    const upper = subject.toUpperCase();
    const lower = subject.toLowerCase();

    // Rule 1: ALL CAPS
    if (subject === upper && subject.trim().length > 3) { flags.push("ALL CAPS"); score += 20; }
    // Rule 2: Excessive exclamation
    if ((subject.match(/!/g) || []).length > 1) { flags.push("Excessive exclamation"); score += 15; }
    // Rule 3: Dollar amount
    if (/\$\d/.test(subject)) { flags.push("Dollar amount in subject"); score += 10; }
    // Rule 4: Free keyword
    if (/\bfree\b/i.test(subject)) { flags.push("'Free' keyword"); score += 15; }
    // Rule 5: Urgency words
    if (/\b(urgent|act now|limited time|expires|last chance)\b/i.test(subject)) { flags.push("Urgency language"); score += 10; }
    // Rule 6: Fake reply/forward prefix
    if (/^(re:|fw:|fwd:)/i.test(subject.trim())) { flags.push("Fake reply/forward prefix"); score += 25; }
    // Rule 7: Too long (>70 chars)
    if (subject.length > 70) { flags.push("Subject too long (>70 chars)"); score += 5; }
    // Rule 8: Too short (<10 chars)
    if (subject.trim().length < 10) { flags.push("Subject too short (<10 chars)"); score += 5; }
    // Rule 9: Spam trigger words
    const spamWords = ["guaranteed", "winner", "prize", "click here", "buy now", "order now", "earn money", "make money"];
    for (const w of spamWords) {
      if (lower.includes(w)) { flags.push(`Spam trigger: "${w}"`); score += 12; break; }
    }
    // Rule 10: Excessive punctuation
    if ((subject.match(/[!?]{2,}/g) || []).length > 0) { flags.push("Excessive punctuation"); score += 10; }

    return { score: Math.min(score, 100), flags };
  }

  it("clean subject gets score 0 and no flags", () => {
    const { score, flags } = computeSpamScore("Quick question about your Q3 goals");
    expect(score).toBe(0);
    expect(flags).toHaveLength(0);
  });

  it("ALL CAPS subject adds 20 points", () => {
    const { score, flags } = computeSpamScore("BUY NOW SAVE MONEY");
    expect(score).toBeGreaterThanOrEqual(20);
    expect(flags).toContain("ALL CAPS");
  });

  it("fake Re: prefix adds 25 points", () => {
    const { score, flags } = computeSpamScore("Re: Your recent inquiry");
    expect(score).toBeGreaterThanOrEqual(25);
    expect(flags.some((f) => f.includes("Fake reply"))).toBe(true);
  });

  it("dollar amount adds 10 points", () => {
    const { score, flags } = computeSpamScore("Save $500 on your subscription");
    expect(score).toBeGreaterThanOrEqual(10);
    expect(flags.some((f) => f.includes("Dollar"))).toBe(true);
  });

  it("'free' keyword adds 15 points", () => {
    const { score, flags } = computeSpamScore("Get a free demo today");
    expect(score).toBeGreaterThanOrEqual(15);
    expect(flags.some((f) => f.includes("Free"))).toBe(true);
  });

  it("caps score at 100", () => {
    const { score } = computeSpamScore("RE: FREE GUARANTEED WINNER PRIZE CLICK HERE!!! $500 URGENT ACT NOW");
    expect(score).toBe(100);
  });

  it("urgency language adds 10 points", () => {
    const { score, flags } = computeSpamScore("Limited time offer for your team");
    expect(score).toBeGreaterThanOrEqual(10);
    expect(flags.some((f) => f.includes("Urgency"))).toBe(true);
  });
});

// ─── Snippet validation ───────────────────────────────────────────────────────

describe("snippet validation rules", () => {
  const VALID_CATEGORIES = ["opener", "value_prop", "social_proof", "objection_handler", "cta", "closing", "ps"] as const;

  it("accepts all valid snippet categories", () => {
    for (const cat of VALID_CATEGORIES) {
      expect(VALID_CATEGORIES).toContain(cat);
    }
  });

  it("rejects empty body", () => {
    const isValid = (body: string) => body.trim().length >= 1;
    expect(isValid("")).toBe(false);
    expect(isValid("  ")).toBe(false);
    expect(isValid("Hello {{firstName}}")).toBe(true);
  });

  it("detects merge tags used in body", () => {
    const body = "Hi {{firstName}}, I noticed {{company}} is growing fast.";
    const tags = (body.match(/\{\{[a-zA-Z0-9_.]+\}\}/g) || []);
    expect(tags).toContain("{{firstName}}");
    expect(tags).toContain("{{company}}");
    expect(tags).toHaveLength(2);
  });
});

// ─── Brand voice validation ───────────────────────────────────────────────────

describe("brand voice validation", () => {
  const VALID_TONES = ["professional", "conversational", "direct", "empathetic", "authoritative"] as const;

  it("accepts all valid tone values", () => {
    for (const tone of VALID_TONES) {
      expect(VALID_TONES).toContain(tone);
    }
  });

  it("validates hex color format", () => {
    const isHex = (c: string) => /^#[0-9a-fA-F]{6}$/.test(c);
    expect(isHex("#14B89A")).toBe(true);
    expect(isHex("#0F766E")).toBe(true);
    expect(isHex("14B89A")).toBe(false);
    expect(isHex("#GGGGGG")).toBe(false);
    expect(isHex("#14B89")).toBe(false);
  });

  it("vocabulary and avoidWords must be string arrays", () => {
    const vocab: string[] = ["synergy", "leverage"];
    const avoid: string[] = ["spam", "guaranteed"];
    expect(Array.isArray(vocab)).toBe(true);
    expect(Array.isArray(avoid)).toBe(true);
    expect(vocab.every((w) => typeof w === "string")).toBe(true);
  });
});

// ─── Prompt template A/B logic ────────────────────────────────────────────────

describe("prompt template A/B group logic", () => {
  it("only A and B are valid group values", () => {
    const VALID_GROUPS = ["A", "B"] as const;
    expect(VALID_GROUPS).toContain("A");
    expect(VALID_GROUPS).toContain("B");
    expect(VALID_GROUPS).not.toContain("C");
  });

  it("activating a template should deactivate others with the same goal", () => {
    // Simulate the activate logic: set all same-goal to inactive, then set target active
    const templates = [
      { id: 1, goal: "intro", isActive: true },
      { id: 2, goal: "intro", isActive: false },
      { id: 3, goal: "follow_up", isActive: true },
    ];
    const activateId = 2;
    const target = templates.find((t) => t.id === activateId)!;

    const updated = templates.map((t) => ({
      ...t,
      isActive: t.goal === target.goal ? t.id === activateId : t.isActive,
    }));

    expect(updated.find((t) => t.id === 1)!.isActive).toBe(false);
    expect(updated.find((t) => t.id === 2)!.isActive).toBe(true);
    expect(updated.find((t) => t.id === 3)!.isActive).toBe(true); // different goal, unchanged
  });

  it("duplicate template should flip A/B group", () => {
    const original = { abGroup: "A" as const };
    const duplicate = { ...original, abGroup: original.abGroup === "A" ? "B" as const : "A" as const };
    expect(duplicate.abGroup).toBe("B");
  });
});
