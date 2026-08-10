import { describe, it, expect } from "vitest";
import { humanizeAiCopy, humanizeSubjectBody, HUMAN_COPY_RULES } from "./services/humanCopy";

/**
 * The owner's exact complaint: "AI generated emails contain em dashes and
 * other clues that indicate that is AI written." The prompt layer asks for
 * human style; THIS layer guarantees the mechanical tells are gone even
 * when the model ignores instructions. So the tests assert removal, not
 * politeness.
 */
describe("humanizeAiCopy — the tells", () => {
  it("kills every em dash, spaced or not", () => {
    expect(humanizeAiCopy("We help teams — like yours — move faster")).toBe(
      "We help teams, like yours, move faster",
    );
    expect(humanizeAiCopy("one thing—quick question")).toBe("one thing, quick question");
    expect(humanizeAiCopy("plain text")).not.toContain("—");
  });

  it("turns a numeric en-dash range into a hyphen, other en dashes into commas", () => {
    expect(humanizeAiCopy("a 5–10 minute call")).toBe("a 5-10 minute call");
    expect(humanizeAiCopy("fast – and cheap")).toBe("fast, and cheap");
  });

  it("never leaves doubled punctuation behind", () => {
    expect(humanizeAiCopy("Done. — And more")).toBe("Done. And more");
    expect(humanizeAiCopy("first, — second")).toBe("first, second");
  });

  it("normalizes unicode ellipsis and curly quotes", () => {
    expect(humanizeAiCopy("well… “great” results, don’t you think")).toBe(
      `well... "great" results, don't you think`,
    );
  });

  it("strips markdown the model leaks into plain emails", () => {
    expect(humanizeAiCopy("This is **really** important")).toBe("This is really important");
    expect(humanizeAiCopy("## Next steps\nCall me")).toBe("Next steps\nCall me");
    expect(humanizeAiCopy("use `the tool` today")).toBe("use the tool today");
  });

  it("drops the cliché opener if the model used one anyway", () => {
    expect(humanizeAiCopy("I hope this email finds you well. Quick question about Acme."))
      .toBe("Quick question about Acme.");
  });

  it("leaves merge tags, newlines, and honest hyphens alone", () => {
    const s = "Hi {{firstName}},\n\nWe're a well-known team.\n\nBest";
    expect(humanizeAiCopy(s)).toBe(s);
  });

  it("is safe on HTML fragments — touches characters, never tags", () => {
    expect(humanizeAiCopy("<p>Teams — like yours</p>")).toBe("<p>Teams, like yours</p>");
  });

  it("humanizeSubjectBody covers the common shape and tolerates nulls", () => {
    const out = humanizeSubjectBody({ subject: "Growth — unlocked", body: null });
    expect(out.subject).toBe("Growth, unlocked");
    expect(out.body).toBeNull();
  });
});

describe("the prompt rules and the scrub agree", () => {
  it("the rules ban the em dash the scrub removes", () => {
    expect(HUMAN_COPY_RULES).toContain("em dash");
    // And the rules block itself must not smuggle tells INTO prompts in a
    // way a model would copy — it may name the characters, nothing more.
    expect(HUMAN_COPY_RULES).toContain("NEVER");
  });
});
