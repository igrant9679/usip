/**
 * Phone numbers as people read them (owner ask 2026-10-05: "fix the phone
 * formatting"): Plivo's "15714798700" is stored as +15714798700 and shown as
 * +1 571-479-8700, everywhere a call's number appears.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { formatPhone, toE164 } from "../shared/phoneFormat";

describe("toE164 (storage)", () => {
  it("normalises what carriers and people send", () => {
    expect(toE164("15714798700")).toBe("+15714798700");
    expect(toE164("+1 (571) 479-8700")).toBe("+15714798700");
    expect(toE164("5714798700")).toBe("+15714798700");
    expect(toE164("sip:+15714798700@sip.voice.x.ai")).toBe("+15714798700");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
  });
  it("leaves what is not a number alone", () => {
    expect(toE164("anonymous")).toBe("anonymous");
    expect(toE164("12345")).toBe("12345");
    expect(toE164("")).toBeNull();
    expect(toE164(null)).toBeNull();
  });
});

describe("formatPhone (display)", () => {
  it("North American numbers read as +1 571-479-8700", () => {
    expect(formatPhone("15714798700")).toBe("+1 571-479-8700");
    expect(formatPhone("+17037971086")).toBe("+1 703-797-1086");
    expect(formatPhone("5714798700")).toBe("+1 571-479-8700");
  });
  it("other countries as +digits; non-numbers as they came", () => {
    expect(formatPhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(formatPhone("anonymous")).toBe("anonymous");
    expect(formatPhone(null)).toBe("");
  });
});

describe("used where numbers are stored and shown", () => {
  const read = (...p: string[]) => readFileSync(path.join(__dirname, "..", ...p), "utf8");
  it("callers are stored as +E.164", () => {
    expect(read("server", "plivoWebhook.ts")).toContain('const from = toE164(String(b.From ?? ""))?.slice(0, 32) ?? null;');
    expect(read("server", "voiceWebhook.ts")).toContain("fromNumber: toE164(from)?.slice(0, 32) ?? null,");
  });
  it("notifications and screens format them", () => {
    expect(read("server", "services", "voiceRelay.ts")).toContain("const who = ctx.personName || formatPhone(ctx.otherNumber) || \"a caller\";");
    expect(read("server", "voiceWebhook.ts")).toContain("from ? ` from ${formatPhone(from)}` : \"\"");
    expect(read("client", "src", "pages", "usip", "Calls.tsx")).toContain("{formatPhone(c.fromNumber) || \"unknown\"} → {formatPhone(c.toNumber) || \"—\"}");
    expect(read("client", "src", "pages", "usip", "ConversationsV2.tsx")).toContain("{formatPhone(c.fromNumber) || \"Unknown caller\"}");
    expect(read("client", "src", "components", "usip", "settings", "VoiceAgentsSection.tsx")).toContain("{formatPhone(c.fromNumber) || \"unknown\"} → {formatPhone(c.toNumber) || \"—\"}");
    expect(read("client", "src", "components", "usip", "calls", "AiCallQueue.tsx")).toContain("formatPhone(r.toNumber)");
  });
});
