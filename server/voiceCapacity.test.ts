/**
 * Owner ask 2026-10-06: "give me the ability to add multiple numbers/agents
 * so that I can make more outbound calls from a particular workspace".
 * An agent holds several numbers and calls take turns across them; the
 * workspace limits are an admin's, never past the ceilings.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  agentNumberMatching,
  agentNumbers,
  areaCode,
  clampVoiceLimits,
  DEFAULT_VOICE_LIMITS,
  numberFields,
  pickFromNumber,
  VOICE_LIMIT_CEILINGS,
} from "@shared/voiceCapacity";
import { decideAdmission, QUEUED_COUNTS_MS } from "./services/voiceGuards";

describe("an agent's numbers", () => {
  it("main first, then the others, without repeats or blanks", () => {
    expect(agentNumbers({ plivoNumber: "+17037971086", plivoExtraNumbers: ["+12025550111", "17037971086", "", 5, "+14155550122"] }))
      .toEqual(["+17037971086", "+12025550111", "+14155550122"]);
    expect(agentNumbers({ plivoNumber: null, plivoExtraNumbers: null })).toEqual([]);
    expect(agentNumbers(undefined)).toEqual([]);
  });

  it("matches a number however it is written", () => {
    const a = { plivoNumber: "+17037971086", plivoExtraNumbers: ["+12025550111"] };
    expect(agentNumberMatching(a, "12025550111")).toBe("+12025550111");
    expect(agentNumberMatching(a, "+1 (703) 797-1086")).toBe("+17037971086");
    expect(agentNumberMatching(a, "+14155550100")).toBeNull();
    expect(agentNumberMatching(a, "")).toBeNull();
  });

  it("stores the first as the main number and the rest as extras", () => {
    expect(numberFields(["+12025550111", "+14155550122", "12025550111"])).toEqual({ plivoNumber: "+12025550111", plivoExtraNumbers: ["+14155550122"] });
    expect(numberFields(["+12025550111"])).toEqual({ plivoNumber: "+12025550111", plivoExtraNumbers: null });
    expect(numberFields([])).toEqual({ plivoNumber: null, plivoExtraNumbers: null });
  });

  it("reads North American area codes", () => {
    expect(areaCode("+14155550100")).toBe("415");
    expect(areaCode("7037971086")).toBe("703");
    expect(areaCode("+442071234567")).toBeNull();
  });
});

describe("which number places a call", () => {
  const numbers = ["+17037971086", "+12025550111", "+14155550122"];

  it("the number this person was last called from comes first", () => {
    expect(pickFromNumber({ numbers, to: "+14155550100", lastFrom: "12025550111", usedToday: {} })).toBe("+12025550111");
  });

  it("then a number with their area code", () => {
    expect(pickFromNumber({ numbers, to: "+14155550100", usedToday: { "17037971086": 0, "14155550122": 40 } })).toBe("+14155550122");
  });

  it("then the least used, the main number winning a tie", () => {
    expect(pickFromNumber({ numbers, to: "+13125550100", usedToday: { "17037971086": 9, "12025550111": 3, "14155550122": 3 } })).toBe("+12025550111");
    expect(pickFromNumber({ numbers, to: "+13125550100", usedToday: {} })).toBe("+17037971086");
  });

  it("never a number that has placed its calls for the day, even the last one used or the local one", () => {
    const usedToday = { "12025550111": 100, "14155550122": 100 };
    expect(pickFromNumber({ numbers, to: "+14155550100", lastFrom: "+12025550111", usedToday })).toBe("+17037971086");
    expect(pickFromNumber({ numbers, to: "+14155550100", usedToday: { ...usedToday, "17037971086": 100 } })).toBeNull();
    expect(pickFromNumber({ numbers: [], to: "+14155550100", usedToday: {} })).toBeNull();
  });
});

describe("the workspace limits", () => {
  it("default when unset, whole numbers from 1 up to the ceilings otherwise", () => {
    expect(clampVoiceLimits(null)).toEqual(DEFAULT_VOICE_LIMITS);
    expect(clampVoiceLimits({ maxConcurrent: null, dialsPerMinute: undefined })).toEqual(DEFAULT_VOICE_LIMITS);
    expect(clampVoiceLimits({ maxConcurrent: 99, dialsPerMinute: 0, dailyMinutes: 600.7 })).toEqual({ maxConcurrent: VOICE_LIMIT_CEILINGS.maxConcurrent, dialsPerMinute: 1, dailyMinutes: 600 });
  });

  it("the defaults are what the workspace had before (3 at once, 2 a minute, 240 minutes)", () => {
    expect(DEFAULT_VOICE_LIMITS).toEqual({ maxConcurrent: 3, dialsPerMinute: 2, dailyMinutes: 240 });
    expect(VOICE_LIMIT_CEILINGS).toEqual({ maxConcurrent: 10, dialsPerMinute: 10, dailyMinutes: 1500 });
  });

  const now = Date.parse("2026-10-06T15:00:00Z");
  const row = (status: string, agoMs: number, durationSec: number | null = null) => ({ status, startedAt: new Date(now - agoMs), durationSec, fromNumber: null });

  it("an admin's limits replace the defaults in the spend check", () => {
    const five = Array.from({ length: 5 }, () => row("in_progress", 60_000));
    expect(decideAdmission(five, null, now)).toMatchObject({ ok: false, code: "concurrency" });
    expect(decideAdmission(five, null, now, { ...DEFAULT_VOICE_LIMITS, maxConcurrent: 6 })).toEqual({ ok: true });
    const used = [row("completed", 3_600_000, 300 * 60)];
    expect(decideAdmission(used, null, now)).toMatchObject({ ok: false, code: "daily_budget" });
    expect(decideAdmission(used, null, now, { ...DEFAULT_VOICE_LIMITS, dailyMinutes: 600 })).toEqual({ ok: true });
  });

  it("a call just placed counts toward calls at once until Plivo reports on it", () => {
    const placed = Array.from({ length: 3 }, () => row("queued", 10_000));
    expect(decideAdmission(placed, null, now)).toMatchObject({ ok: false, code: "concurrency" });
    const old = Array.from({ length: 3 }, () => row("queued", QUEUED_COUNTS_MS + 1000));
    expect(decideAdmission(old, null, now)).toEqual({ ok: true });
  });
});

describe("the settings behind it", () => {
  const src = readFileSync(path.join(__dirname, "routers", "voiceAgents.ts"), "utf8");
  const block = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

  it("setting an agent's numbers is an admin's, takes each number off any other agent, and is audited", () => {
    const m = block("setPlivoNumbers: adminWsProcedure", "  /** Live key verification");
    expect(m).toContain(".max(MAX_NUMBERS_PER_AGENT)");
    expect(m).toContain("ne(voiceAgents.id, agent.id)");
    expect(m).toContain("const kept = theirs.filter((n) => !taking.has(digitsOf(n)));");
    expect(m).toContain("set(numberFields(kept))");
    expect(m).toContain("is not on this Plivo account.");
    expect(m).toContain('entityType: "voice_agent"');
    expect(src).not.toContain("connectPlivoNumber");
  });

  it("the limits are an admin's, bounded by the ceilings, and audited", () => {
    const m = block("setAiCallLimits: adminWsProcedure", "  savePlivo: adminWsProcedure");
    expect(m).toContain(".max(VOICE_LIMIT_CEILINGS.maxConcurrent)");
    expect(m).toContain(".max(VOICE_LIMIT_CEILINGS.dialsPerMinute)");
    expect(m).toContain(".max(VOICE_LIMIT_CEILINGS.dailyMinutes)");
    expect(m).toContain("const limits = clampVoiceLimits(input);");
    expect(m).toContain('entityType: "ai_call_limits"');
  });

  it("a test call can only ring from one of the agent's own numbers", () => {
    const ai = readFileSync(path.join(__dirname, "routers", "aiCalls.ts"), "utf8");
    expect(ai).toContain("const from = input.fromNumber ? agentNumberMatching(agent, input.fromNumber) : agent.plivoNumber;");
    expect(ai).toContain("if (!from) throw new TRPCError");
    expect(ai).toContain("await placeCall(creds, { from, to,");
  });
});
