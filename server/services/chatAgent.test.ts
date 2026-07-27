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
  emailAskCount,
  scrubUnsupportedClaims,
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

/**
 * Measured on the live agent: the prompt said "ask only once per conversation"
 * and it asked four turns running. A stateless prompt re-decides every turn, so
 * the count has to be computed and fed back in.
 */
describe("emailAskCount", () => {
  const at = "2026-07-27T00:00:00.000Z";
  const agent = (text: string) => ({ role: "agent" as const, text, at });
  const visitor = (text: string) => ({ role: "visitor" as const, text, at });

  it("counts the agent's email questions, not the visitor's messages", () => {
    expect(emailAskCount([
      agent("What brings you here?"),
      visitor("my email is a@b.com, what do you do?"),
      agent("What's your work email?"),
    ])).toBe(1);
  });

  it("counts each repeat — this is the behaviour being suppressed", () => {
    expect(emailAskCount([
      agent("What's the best email to reach you at?"),
      visitor("how much does it cost?"),
      agent("Pricing depends on scope. What's your work email so I can set that up?"),
      visitor("who else have you worked with?"),
      agent("We can walk you through it. What's the best email to reach you?"),
    ])).toBe(3);
  });

  it("does not count a statement that merely mentions email", () => {
    expect(emailAskCount([agent("I'll send that to your email once we're set up.")])).toBe(0);
  });

  it("matches the hyphenated spelling", () => {
    expect(emailAskCount([agent("Can I grab your e-mail?")])).toBe(1);
  });

  it("is empty-safe", () => {
    expect(emailAskCount([])).toBe(0);
  });
});

describe("scrubUnsupportedClaims", () => {
  // The sentence the LIVE agent produced after the prompt rule was added.
  it("drops the exact claim the prompt rule failed to stop", () => {
    const r = scrubUnsupportedClaims(
      "Grant reporting across six funders is exactly the kind of admin work AI can transform. We've helped nonprofits automate report compilation to save weeks each quarter. Have you got a sense of what it costs you annually?",
    );
    expect(r.text).not.toMatch(/we've helped/i);
    expect(r.text).toContain("Grant reporting across six funders");
    expect(r.text).toContain("Have you got a sense");
    expect(r.removed).toHaveLength(1);
  });

  it("catches unnamed track-record claims, which are the dangerous ones", () => {
    expect(scrubUnsupportedClaims("We work with food banks regularly.").text).toBe("");
    expect(scrubUnsupportedClaims("Our clients see this all the time.").text).toBe("");
    expect(scrubUnsupportedClaims("We have worked with similar teams.").text).toBe("");
  });

  it("catches quantified outcomes with or without a digit", () => {
    expect(scrubUnsupportedClaims("It can save 30% of admin time.").text).toBe("");
    expect(scrubUnsupportedClaims("That saves weeks each quarter.").text).toBe("");
    expect(scrubUnsupportedClaims("We reduce reporting by 12 hours a month.").text).toBe("");
  });

  it("leaves ordinary capability talk alone — the agent's actual job", () => {
    const ok = "We help nonprofits use AI to automate repetitive work so your team can focus on the mission. What is taking the most time right now?";
    expect(scrubUnsupportedClaims(ok).text).toBe(ok);
    const ok2 = "The audit is free and it frees up time for your team.";
    expect(scrubUnsupportedClaims(ok2).text).toBe(ok2);
  });

  it("catches a price, which the persona also forbids", () => {
    expect(scrubUnsupportedClaims("It usually starts around $5,000.").text).toBe("");
  });

  it("reports what it removed so a shorter reply is explainable", () => {
    const r = scrubUnsupportedClaims("Sure. Our clients love it.");
    expect(r.removed[0].kind).toBe("track_record");
    expect(r.removed[0].sentence).toContain("Our clients");
  });

  it("is empty-safe and keeps punctuation on the surviving sentences", () => {
    expect(scrubUnsupportedClaims("").text).toBe("");
    expect(scrubUnsupportedClaims("Yes. No! Maybe?").text).toBe("Yes. No! Maybe?");
  });
});

describe("sanitizeTurn + claim scrubbing", () => {
  it("substitutes an honest fallback when scrubbing empties the reply", () => {
    const t = sanitizeTurn({ reply: "We've helped dozens of food banks save weeks.", score: 70 }, "fb");
    expect(t.reply).not.toMatch(/we've helped/i);
    expect(t.reply.length).toBeGreaterThan(20);
  });
});
