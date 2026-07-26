/**
 * The chat agent talks to strangers and can put a meeting on a rep's calendar,
 * so the guards between the model and the database are the part worth testing:
 * what we accept as an email, what we let overwrite known facts, and who is
 * allowed to book.
 */
import { describe, it, expect } from "vitest";
import {
  MEETING_REQUEST_FLOOR,
  decideOffer,
  mergeVisitor,
  plausibleEmail,
  sanitizeTurn,
  transcriptText,
  type ChatMessage,
} from "./chatAgent";

describe("plausibleEmail", () => {
  it("accepts a real-looking address and lowercases it", () => {
    expect(plausibleEmail("Idris.Grant@LSIMedia.com")).toBe("idris.grant@lsimedia.com");
  });

  it("rejects non-addresses", () => {
    for (const bad of ["", "   ", "not an email", "john@", "@acme.com", "john@acme", null, 42, undefined]) {
      expect(plausibleEmail(bad)).toBeNull();
    }
  });

  it("rejects the placeholder addresses models invent", () => {
    expect(plausibleEmail("john.doe@acme.com")).toBeNull();
    expect(plausibleEmail("someone@example.com")).toBeNull();
    expect(plausibleEmail("hello@yourcompany.com")).toBeNull();
  });

  it("treats the literal strings null/unknown as absent", () => {
    expect(plausibleEmail("null")).toBeNull();
    expect(plausibleEmail("unknown")).toBeNull();
  });
});

describe("mergeVisitor", () => {
  it("keeps what we already know rather than a later re-guess", () => {
    const merged = mergeVisitor(
      { name: "Dana Reed", email: "dana@acme.io", company: "Acme" },
      { name: "Dana", email: "d.reed@acme.io", company: "Acme Corp", phone: "555-0100" },
    );
    expect(merged.name).toBe("Dana Reed");
    expect(merged.email).toBe("dana@acme.io");
    expect(merged.company).toBe("Acme");
    // ...but genuinely new facts still land.
    expect(merged.phone).toBe("555-0100");
  });

  it("fills in from the new turn when nothing is known", () => {
    const merged = mergeVisitor({}, { name: "Sam", email: "sam@northwind.co", company: null, phone: null });
    expect(merged).toEqual({ name: "Sam", email: "sam@northwind.co", company: null, phone: null });
  });

  it("never lets an implausible email displace a real stored one", () => {
    expect(mergeVisitor({ email: "real@northwind.co" }, { email: "john.doe@example.com" }).email)
      .toBe("real@northwind.co");
  });

  it("drops an implausible email entirely rather than storing it", () => {
    expect(mergeVisitor({}, { email: "john.doe@example.com" }).email).toBeNull();
  });
});

describe("decideOffer", () => {
  const base = { mode: "auto" as const, score: 80, threshold: 60, hasEmail: true, wantsMeeting: true, alreadyBooked: false };

  it("books a qualified visitor in auto mode", () => {
    expect(decideOffer(base)).toBe("book");
  });

  it("hands a qualified visitor to a human in approval mode", () => {
    expect(decideOffer({ ...base, mode: "approval" })).toBe("handoff");
  });

  it("does nothing when the agent is off", () => {
    expect(decideOffer({ ...base, mode: "off" })).toBe("none");
  });

  it("never offers without an email", () => {
    expect(decideOffer({ ...base, hasEmail: false })).toBe("none");
    expect(decideOffer({ ...base, mode: "approval", hasEmail: false })).toBe("none");
  });

  it("is idempotent once booked", () => {
    expect(decideOffer({ ...base, alreadyBooked: true })).toBe("none");
  });

  it("does not let an eager model book unqualified traffic", () => {
    expect(decideOffer({ ...base, score: MEETING_REQUEST_FLOOR - 1, wantsMeeting: true })).toBe("none");
  });

  it("books a below-threshold visitor who is asking, above the floor", () => {
    expect(decideOffer({ ...base, score: MEETING_REQUEST_FLOOR, wantsMeeting: true })).toBe("book");
  });

  it("stays quiet for a below-threshold visitor who is not asking", () => {
    expect(decideOffer({ ...base, score: 55, threshold: 60, wantsMeeting: false })).toBe("none");
  });
});

describe("sanitizeTurn", () => {
  it("falls back to a safe reply when the model returns nothing usable", () => {
    const t = sanitizeTurn({}, "fallback");
    expect(t.reply).toBe("fallback");
    expect(t.score).toBe(0);
    expect(t.wantsMeeting).toBe(false);
    expect(t.extracted).toEqual({ name: null, email: null, company: null, phone: null });
  });

  it("clamps the score into 0-100", () => {
    expect(sanitizeTurn({ score: 900 }, "f").score).toBe(100);
    expect(sanitizeTurn({ score: -5 }, "f").score).toBe(0);
    expect(sanitizeTurn({ score: "not a number" }, "f").score).toBe(0);
  });

  it("only treats a literal true as wanting a meeting", () => {
    expect(sanitizeTurn({ wantsMeeting: "yes" }, "f").wantsMeeting).toBe(false);
    expect(sanitizeTurn({ wantsMeeting: 1 }, "f").wantsMeeting).toBe(false);
    expect(sanitizeTurn({ wantsMeeting: true }, "f").wantsMeeting).toBe(true);
  });

  it("truncates a runaway reply instead of storing it whole", () => {
    expect(sanitizeTurn({ reply: "x".repeat(5000) }, "f").reply.length).toBe(1200);
  });

  it("survives a non-object response", () => {
    expect(sanitizeTurn(null, "f").reply).toBe("f");
    expect(sanitizeTurn("a string", "f").reply).toBe("f");
  });
});

describe("transcriptText", () => {
  const msg = (role: "visitor" | "agent", text: string): ChatMessage => ({ role, text, at: "2026-07-25T00:00:00.000Z" });

  it("labels each side and keeps order", () => {
    expect(transcriptText([msg("agent", "Hi!"), msg("visitor", "hello")], "Ada"))
      .toBe("Ada: Hi!\nVisitor: hello");
  });

  it("keeps only the most recent turns so the prompt cannot grow without bound", () => {
    const many = Array.from({ length: 40 }, (_, i) => msg("visitor", `m${i}`));
    const lines = transcriptText(many, "Ada").split("\n");
    expect(lines).toHaveLength(20);
    expect(lines[lines.length - 1]).toBe("Visitor: m39");
  });
});
