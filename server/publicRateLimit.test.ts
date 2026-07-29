import { describe, it, expect } from "vitest";
import { isMeteredPublicPath, isPublicWritePath } from "./publicRateLimit";

/**
 * This predicate decides who gets throttled. Both directions are dangerous:
 * too broad and signed-in users are rate-limited on their own app; too narrow
 * and the public LLM endpoint stays free to abuse.
 */
describe("isMeteredPublicPath", () => {
  it("matches the public chat send, the one metered public procedure", () => {
    expect(isMeteredPublicPath("/chatAgents.send")).toBe(true);
  });

  /** httpBatchLink appends ?batch=1 and can comma-join procedure names. */
  it("still matches when the client batches", () => {
    expect(isMeteredPublicPath("/chatAgents.send?batch=1")).toBe(true);
    expect(isMeteredPublicPath("/chatAgents.getPublic,chatAgents.send")).toBe(true);
  });

  /** The whole app shares /api/trpc — throttling it would be far worse. */
  it("does NOT match ordinary authenticated traffic", () => {
    for (const p of [
      "/leads.list",
      "/tasks.getAutopilotSettings",
      "/sequences.bulkEnroll",
      "/workspace.members",
    ]) {
      expect(isMeteredPublicPath(p)).toBe(false);
    }
  });

  /** Neighbouring chat procedures are cheap reads — no model call, no limit. */
  it("does not throttle the free chat procedures", () => {
    expect(isMeteredPublicPath("/chatAgents.getPublic")).toBe(false);
    expect(isMeteredPublicPath("/chatAgents.book")).toBe(false);
  });

  it("handles an empty path rather than throwing", () => {
    expect(isMeteredPublicPath("")).toBe(false);
  });
});

/**
 * The write ceiling covers a different cost: `bookingLinks.book` emails a
 * calendar invite to a caller-supplied address and occupies a real slot, and
 * the two submit paths mint leads the autonomous engines then act on.
 */
describe("isPublicWritePath", () => {
  it("covers every unauthenticated write", () => {
    expect(isPublicWritePath("/bookingLinks.book")).toBe(true);
    expect(isPublicWritePath("/forms.submit")).toBe(true);
    expect(isPublicWritePath("/landingPages.submit")).toBe(true);
  });

  /** Reads are how a visitor loads the page at all — never throttle those. */
  it("leaves the public READ paths alone", () => {
    expect(isPublicWritePath("/bookingLinks.getPublic")).toBe(false);
    expect(isPublicWritePath("/forms.getByPublicId")).toBe(false);
    expect(isPublicWritePath("/landingPages.getBySlug")).toBe(false);
  });

  it("does not touch authenticated traffic", () => {
    expect(isPublicWritePath("/leads.list")).toBe(false);
    expect(isPublicWritePath("/sequences.bulkEnroll")).toBe(false);
  });

  /** The two ceilings must not overlap, or the wrong limit silently applies. */
  it("is disjoint from the metered LLM set", () => {
    for (const p of ["/chatAgents.send", "/bookingLinks.book", "/forms.submit", "/landingPages.submit"]) {
      expect(isMeteredPublicPath(p) && isPublicWritePath(p)).toBe(false);
    }
  });
});
