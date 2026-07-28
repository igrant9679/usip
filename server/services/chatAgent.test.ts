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
  emailInText,
  handoffLine,
  wantsHuman,
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

/**
 * `known` is built from the session row and lags one turn, so on the exact turn
 * a visitor types their address the prompt believed we had none and told the
 * model it MUST ask. Measured live: "Can I send you a calendar link? (I'll just
 * need your work email to set that up.)" — in reply to a message giving it.
 */
describe("emailInText", () => {
  it("finds an address inside a sentence", () => {
    expect(emailInText("I am Testy McTestface, my email is testy@northwind.org"))
      .toBe("testy@northwind.org");
  });

  it("strips trailing punctuation", () => {
    expect(emailInText("reach me at dana@acme.io.")).toBe("dana@acme.io");
    expect(emailInText("is it sam@acme.io?")).toBe("sam@acme.io");
  });

  it("handles a plus-tag", () => {
    expect(emailInText("use idris.grant+chattest@gmail.com please"))
      .toBe("idris.grant+chattest@gmail.com");
  });

  it("still rejects the placeholders models invent", () => {
    expect(emailInText("email john.doe@example.com")).toBeNull();
  });

  it("returns null when there is no address", () => {
    expect(emailInText("let me discuss internally and come back to you")).toBeNull();
    expect(emailInText("")).toBeNull();
  });
});

/**
 * Escalation is deterministic on purpose: a visitor who has decided they want a
 * human has stopped wanting the bot's opinion, so this must not depend on the
 * model agreeing. False positives are expensive in the other direction — each
 * one mints a task for a rep and promises the visitor a call.
 */
describe("wantsHuman", () => {
  it("catches the direct asks", () => {
    for (const t of [
      "can I talk to a human?",
      "I'd like to speak with someone",
      "please connect me to a real person",
      "get me a human",
      "put me through to an agent",
      "can I speak to a representative",
      "is there a real person I can talk to",
      "are you a bot?",
      "is this a chatbot",
      "I'd rather talk to a person",
    ]) {
      expect(wantsHuman(t), t).toBe(true);
    }
  });

  it("does not fire on ordinary conversation", () => {
    for (const t of [
      "we run a food bank network",
      "grant reporting is eating us alive",
      "someone told me about you",
      "that's a real problem for us",
      "what does your team do?",
      "I need to discuss internally first",
      "how much does it cost?",
      "",
    ]) {
      expect(wantsHuman(t), t).toBe(false);
    }
  });

  /** "Human resources" is a department, not a request for a human. */
  it("is not fooled by human resources", () => {
    expect(wantsHuman("our human resources team handles that")).toBe(false);
    expect(wantsHuman("I work in human resources")).toBe(false);
  });

  it("still fires when HR is mentioned alongside a genuine ask", () => {
    expect(wantsHuman("human resources sent me — can I speak to a person?")).toBe(true);
  });
});

describe("sanitizeTurn needsHuman", () => {
  it("only treats a literal true as needing a human", () => {
    expect(sanitizeTurn({ needsHuman: "yes" }, "f").needsHuman).toBe(false);
    expect(sanitizeTurn({ needsHuman: 1 }, "f").needsHuman).toBe(false);
    expect(sanitizeTurn({ needsHuman: true }, "f").needsHuman).toBe(true);
    expect(sanitizeTurn({}, "f").needsHuman).toBe(false);
  });
});

describe("handoffLine", () => {
  it("only promises when we can already reach them", () => {
    expect(handoffLine({ hasEmail: true, replyAsksForEmail: false }))
      .toBe("I've asked a colleague to pick this up — they'll be in touch shortly.");
  });

  it("asks for an email when we have none — the promise must be keepable", () => {
    expect(handoffLine({ hasEmail: false, replyAsksForEmail: false })).toMatch(/best email/);
  });

  /**
   * Measured live: the model's reply already ended with "I'll just need your
   * work email", and appending the ask produced a message asking twice in four
   * lines.
   */
  it("does not ask again when the reply already did", () => {
    expect(handoffLine({ hasEmail: false, replyAsksForEmail: true })).not.toMatch(/best email/);
  });
});
