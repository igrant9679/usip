/**
 * Two channel vocabularies, and they must stay two.
 *
 * ARE_STEP_CHANNELS is STORAGE: the are_execution_queue enum holds all four,
 * and sequences generated before 2026-09-20 carry sms/voice steps. Narrowing
 * it would make the reader lie about what is on disk.
 *
 * ARE_SENDABLE_CHANNELS is SENDING: there is no SMS gateway in the repo and
 * the voice bridge only answers inbound call-backs, so a step on either
 * channel is minted, queued, skipped — and enough skipped steps flip the
 * prospect to "abandoned", which cancels the sequence with "re-approve to
 * re-enrol", which regenerates from the same cached template and cancels
 * again. That loop is what this vocabulary exists to stop.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARE_SENDABLE_CHANNELS,
  ARE_STEP_CHANNELS,
  UNSENDABLE_CHANNEL_REASON,
  isSendableChannel,
  normalizeSequence,
  unsendableReason,
} from "../shared/areSequenceSteps";

describe("the storage vocabulary and the sending vocabulary are separate", () => {
  it("storage still holds all four", () => {
    expect(Array.from(ARE_STEP_CHANNELS)).toEqual(["email", "linkedin", "sms", "voice"]);
  });

  it("sending is exactly email and LinkedIn", () => {
    expect(Array.from(ARE_SENDABLE_CHANNELS)).toEqual(["email", "linkedin"]);
  });

  it("the two lists are not collapsed into one", () => {
    const src = readFileSync(join(__dirname, "../shared/areSequenceSteps.ts"), "utf8");
    expect(src).toContain('export const ARE_STEP_CHANNELS = ["email", "linkedin", "sms", "voice"] as const;');
    expect(src).toContain('export const ARE_SENDABLE_CHANNELS = ["email", "linkedin"] as const;');
    expect(ARE_STEP_CHANNELS.length).toBeGreaterThan(ARE_SENDABLE_CHANNELS.length);
  });
});

describe("isSendableChannel", () => {
  it("is case-insensitive in both directions", () => {
    expect(isSendableChannel("Email")).toBe(true);
    expect(isSendableChannel("LINKEDIN")).toBe(true);
    expect(isSendableChannel("SMS")).toBe(false);
    expect(isSendableChannel("Voice")).toBe(false);
  });

  it("treats null, undefined and nonsense as unsendable", () => {
    expect(isSendableChannel(null)).toBe(false);
    expect(isSendableChannel(undefined)).toBe(false);
    expect(isSendableChannel("carrier pigeon")).toBe(false);
  });
});

describe("the reason a channel cannot send is one sentence, shared with the help centre", () => {
  it("names the missing provider rather than saying 'not supported'", () => {
    expect(UNSENDABLE_CHANNEL_REASON.sms).toContain("No SMS gateway is connected");
    expect(UNSENDABLE_CHANNEL_REASON.voice).toContain("Outbound calling is not available");
  });

  it("the help centre uses the same words", () => {
    // One fact, one sentence: the MFA article already said "no SMS gateway is
    // connected" honestly, and the product now agrees with it verbatim.
    const help = readFileSync(join(__dirname, "seedHelpContent.ts"), "utf8");
    expect(help).toContain("no SMS gateway is connected");
  });

  it("a sendable channel has no reason, an unknown one gets a generic truthful one", () => {
    expect(unsendableReason("email")).toBeNull();
    expect(unsendableReason("linkedin")).toBeNull();
    expect(unsendableReason("sms")).toBe(UNSENDABLE_CHANNEL_REASON.sms);
    expect(unsendableReason("telepathy")).toContain("is not wired");
  });
});

describe("the reader keeps telling the truth about legacy rows", () => {
  it("normalizeSequence still returns sms for a stored sms step", () => {
    // The clamp lives at the WRITE side (the template read, the personalizer)
    // and in the UI's labelling. If the normaliser started rewriting stored
    // sms steps to email, every viewer would show a step that is not the step
    // the queue holds.
    const out = normalizeSequence([{ stepIndex: 0, day: 0, channel: "sms", body: "hi" }]);
    expect(out[0].channel).toBe("sms");
    expect(isSendableChannel(out[0].channel)).toBe(false);
  });
});
