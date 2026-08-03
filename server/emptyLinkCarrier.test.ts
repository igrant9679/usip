/**
 * A dead {{bookingLink}} must take its sentence with it.
 *
 * THE BUG. `resolveBookingUrl` returns "" whenever the rep has no booking link,
 * has switched it off, or has left the workspace. Substituting that into
 * "Book a time here: {{bookingLink}}" sends a stranger a sentence that stops
 * mid-promise. In Markdown it is worse: `[Book a call]({{bookingLink}})`
 * becomes `[Book a call]()`, and areEngine's HTML pass only linkifies
 * `https?://`, so the raw brackets ship.
 *
 * Reachable WITHOUT anyone leaving — a rep who simply toggles their booking
 * link off produces it — which is why this is not filed under the offboarding
 * seam that surfaced it.
 *
 * BOTH RENDERERS, ONE RULE. `applyMerge` (ARE outreach) and mergeVars'
 * `resolveMergeVars` / `renderMergeFields` (drafts, bulk send, crm, sequences)
 * all expose `{{bookingLink}}`. Fixing one would have rebuilt the four-renderer
 * divergence `e3c545c` paid to remove, so the rule lives in @shared/mergeKeys
 * and all three call it.
 *
 * The function is PURE, so it is tested by being run — not re-implemented.
 */
import { describe, it, expect } from "vitest";
import {
  LINK_MERGE_KEYS,
  buildMergeLookup,
  isEmptyLinkToken,
  parseMergeToken,
  stripEmptyLinkCarriers,
} from "@shared/mergeKeys";
import { applyMerge } from "./areEngine";
import { renderMergeFields, resolveMergeVars } from "./mergeVars";

/** Strip carriers for whatever `vars` says is empty. */
const strip = (text: string, vars: Record<string, string>) => {
  const lookup = buildMergeLookup(Object.entries(vars));
  return stripEmptyLinkCarriers(text, (tok) => isEmptyLinkToken(tok, lookup));
};

const NO_LINK = { bookingLink: "", firstName: "Ada", title: "" };
const HAS_LINK = { bookingLink: "https://app.example.com/b/ada-7", firstName: "Ada", title: "" };

describe("removing the carrier of an empty link token", () => {
  it("drops a whole CTA sentence that ran to the end", () => {
    expect(strip("Book a time here: {{bookingLink}}", NO_LINK)).toBe("");
  });

  it("drops only the dead sentence, keeping its neighbours", () => {
    expect(strip("Hi Ada. Book a time: {{bookingLink}}. Speak soon.", NO_LINK))
      .toBe("Hi Ada. Speak soon.");
  });

  it("drops a Markdown link whose URL was the token", () => {
    expect(strip("[Book a call]({{bookingLink}})", NO_LINK)).toBe("");
  });

  it("keeps the surrounding clause when the Markdown link is inline", () => {
    /**
     * The reason the carrier is a SENTENCE and not a LINE: "or just reply" is
     * still a useful instruction, and a line-level rule would have deleted it.
     */
    expect(strip("Grab a slot [here]({{bookingLink}}) or just reply.", NO_LINK))
      .toBe("Grab a slot or just reply.");
  });

  it("removes the line and does not leave a hole in the paragraph flow", () => {
    const body = [
      "Hi Ada,",
      "",
      "We help teams ship faster.",
      "",
      "Book a time here: {{bookingLink}}",
      "",
      "Best,",
      "Sam",
    ].join("\n");
    expect(strip(body, NO_LINK)).toBe(
      ["Hi Ada,", "", "We help teams ship faster.", "", "Best,", "Sam"].join("\n"),
    );
  });

  it("cuts once when two dead tokens share a sentence", () => {
    expect(strip("Pick {{bookingLink}} or {{bookingLink}} whichever suits.", NO_LINK)).toBe("");
  });

  it("does not duplicate text when a NESTED carrier overlaps its sentence", () => {
    /**
     * 🔴 ADDED AFTER A MUTATION PASSED. The case above produces two IDENTICAL
     * spans, which survive un-merged by luck. This one does not: the Markdown
     * link yields a narrow span sitting INSIDE the bare token's sentence span,
     * and emitting them separately re-emits the tail that the first cut had
     * already skipped — duplicating copy into a stranger's email.
     */
    expect(strip("Grab a slot [here]({{bookingLink}}) or use {{bookingLink}} directly.", NO_LINK))
      .toBe("");
  });

  it("handles several dead sentences in one body", () => {
    expect(strip("One. Book: {{bookingLink}}. Two. Or here: {{bookingLink}}. Three.", NO_LINK))
      .toBe("One. Two. Three.");
  });
});

describe("what it must NOT touch", () => {
  it("leaves everything alone when the link resolves", () => {
    const t = "Book a time here: {{bookingLink}}";
    expect(strip(t, HAS_LINK)).toBe(t);
  });

  it("leaves a token that has a usable fallback", () => {
    /**
     * `{{bookingLink|https://calendly.com/x}}` is not empty — the caller's
     * fallback handling still applies, and deleting the sentence would throw
     * away a link the author deliberately supplied.
     */
    const t = "Book a time: {{bookingLink|https://calendly.com/x}}";
    expect(strip(t, NO_LINK)).toBe(t);
  });

  it("leaves an EMPTY NON-LINK token, because the sentence still reads", () => {
    /**
     * The restriction that makes this safe. `{{title}}` is routinely empty;
     * dropping "as a {{title}} at Acme" would delete the personalisation rather
     * than repair it. Only a token whose VALUE IS the actionable thing takes
     * its sentence with it.
     */
    const t = "Noticed you work as a {{title}} at Acme.";
    expect(strip(t, NO_LINK)).toBe(t);
  });

  it("leaves an UNKNOWN key to the caller's own policy", () => {
    // mergeVars leaves unknown tokens verbatim for a reviewer to spot; areEngine
    // strips them. Deleting a sentence because a key was misspelled would be a
    // different change from the one this makes.
    const t = "Book here: {{bookingLinkTypo}}";
    expect(strip(t, NO_LINK)).toBe(t);
  });

  it("leaves a LINK-named key that the caller never supplied", () => {
    /**
     * 🔴 ADDED AFTER A MUTATION PASSED. The case above is caught by the
     * link-key check and never reaches the emptiness test, so it proved nothing
     * about ABSENT vs EMPTY. "Present and empty" means the renderer looked for a
     * booking link and there is none — strip. ABSENT means this caller does not
     * populate the token at all, which is the caller's unresolved-token policy
     * to handle, not a licence to delete their copy.
     */
    const t = "Book here: {{bookingLink}}";
    expect(strip(t, { firstName: "Ada" })).toBe(t);
  });

  it("leaves text with no tokens byte-identical", () => {
    const t = "Hi Ada,\n\nNo tokens here at all.\n\nBest,\nSam";
    expect(strip(t, NO_LINK)).toBe(t);
  });

  it("is a no-op on empty input", () => {
    expect(strip("", NO_LINK)).toBe("");
    expect(stripEmptyLinkCarriers(null as any, () => true)).toBe("");
  });
});

describe("the link-key list", () => {
  it("contains bookingLink and is matched case/separator-insensitively", () => {
    expect(LINK_MERGE_KEYS).toContain("bookingLink");
    const lookup = buildMergeLookup(Object.entries(NO_LINK));
    for (const spelling of ["bookingLink", "BookingLink", "booking_link"]) {
      expect(isEmptyLinkToken(parseMergeToken(spelling), lookup), spelling).toBe(true);
    }
  });

  it("does not classify an ordinary token as a link", () => {
    const lookup = buildMergeLookup(Object.entries(NO_LINK));
    expect(isEmptyLinkToken(parseMergeToken("title"), lookup)).toBe(false);
    expect(isEmptyLinkToken(parseMergeToken(""), lookup)).toBe(false);
  });
});

/* ── End to end, through the renderers that actually send ────────────────── */

describe("the shipped renderers, called for real", () => {
  const prospect = { firstName: "Ada", lastName: "L", companyName: "Acme", title: "CTO" } as any;

  it("areEngine.applyMerge drops the CTA when there is no booking URL", () => {
    expect(applyMerge("Hi {{firstName}}. Book a time: {{bookingLink}}. Bye.", prospect, ""))
      .toBe("Hi Ada. Bye.");
  });

  it("areEngine.applyMerge keeps it when there is one", () => {
    expect(applyMerge("Book a time: {{bookingLink}}", prospect, "https://x.test/b/ada"))
      .toBe("Book a time: https://x.test/b/ada");
  });

  it("areEngine.applyMerge no longer emits a Markdown link with an empty URL", () => {
    // `[Book a call]()` is what shipped before: textToHtml only linkifies
    // https?://, so the brackets reached the prospect verbatim.
    const out = applyMerge("Hi. [Book a call]({{bookingLink}}) Bye.", prospect, "");
    expect(out).not.toContain("[Book a call]");
    expect(out).not.toContain("()");
  });

  it("mergeVars.renderMergeFields drops the CTA too", () => {
    expect(renderMergeFields("Hi {{firstName}}. Book: {{bookingLink}}. Bye.", { firstName: "Ada", bookingLink: "" }))
      .toBe("Hi Ada. Bye.");
  });

  it("mergeVars.resolveMergeVars drops the CTA too", () => {
    const out = resolveMergeVars("Hi {{firstName}}. Book: {{bookingLink}}. Bye.", {
      contact: { firstName: "Ada" },
      sender: { bookingUrl: "" },
    } as any);
    expect(out).toBe("Hi Ada. Bye.");
  });

  it("all three agree on the same template — the point of one definition", () => {
    /**
     * `e3c545c` consolidated the MATCHER after four renderers disagreed about
     * spellings. This is the same class of divergence one layer up: what to do
     * when a known link token has no value. Asserted across the renderers
     * rather than assumed.
     */
    const tpl = "Hi. Book a time: {{bookingLink}}. Bye.";
    const are = applyMerge(tpl, prospect, "");
    const flat = renderMergeFields(tpl, { bookingLink: "" });
    const ctxd = resolveMergeVars(tpl, { sender: { bookingUrl: "" } } as any);
    expect(are).toBe("Hi. Bye.");
    expect(flat).toBe(are);
    expect(ctxd).toBe(are);
  });
});
