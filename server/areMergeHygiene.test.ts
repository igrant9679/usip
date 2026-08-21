/**
 * Placeholder hygiene at applyMerge — the ARE dispatch merge seam.
 *
 * Live defect (owner-caught 2026-08-21, send of 2026-08-20 18:10Z): a
 * prospect's companyName stored the literal scraper token "<UNKNOWN>".
 * `p.companyName ?? "your company"` only catches null; the token is truthy,
 * so the subject went to a real recipient as
 * "Grants administration at <UNKNOWN>". The empty string fails from the
 * other side: not null → no fallback → the tag resolves to "" and vanishes,
 * leaving a hole mid-sentence. Both are the placeholder-field class
 * (shared/fieldHygiene, migration 0159); the merge now reads every prospect
 * field through the ONE cleaner, so placeholder and empty fall back exactly
 * like null. 20 in-sequence prospects carried such companies when this
 * shipped — their queued follow-ups merge at send time, so the fix covers
 * them without touching any row.
 */
import { describe, expect, it } from "vitest";
import { applyMerge } from "./areEngine";

const P = (over: Record<string, unknown>) => ({ firstName: "Sara", lastName: "Blancke", companyName: "70 Faces Media", title: "Grants Manager", ...over }) as never;

describe("applyMerge — company", () => {
  it("the live case: '<UNKNOWN>' falls back to 'your company' instead of substituting garbage", () => {
    expect(applyMerge("Grants administration at {{company}}", P({ companyName: "<UNKNOWN>" })))
      .toBe("Grants administration at your company");
  });
  it("an empty company falls back too — no hole mid-sentence", () => {
    expect(applyMerge("Grant administration at {{company}}", P({ companyName: "" })))
      .toBe("Grant administration at your company");
  });
  it("dash placeholders ('—') are placeholders", () => {
    expect(applyMerge("Work at {{company}}", P({ companyName: "—" }))).toBe("Work at your company");
  });
  it("null keeps its existing fallback", () => {
    expect(applyMerge("Work at {{company}}", P({ companyName: null }))).toBe("Work at your company");
  });
  it("a real company still passes through, on both spellings of the tag", () => {
    expect(applyMerge("At {{company}} / {{companyName}}", P({}))).toBe("At 70 Faces Media / 70 Faces Media");
  });
});

describe("applyMerge — person fields", () => {
  it("a placeholder or empty first name greets 'there', never 'Hi <UNKNOWN>' or 'Hi ,'", () => {
    expect(applyMerge("Hi {{firstName}},", P({ firstName: "<UNKNOWN>" }))).toBe("Hi there,");
    expect(applyMerge("Hi {{firstName}},", P({ firstName: "" }))).toBe("Hi there,");
    expect(applyMerge("Hi {{firstName}},", P({}))).toBe("Hi Sara,");
  });
  it("a placeholder title resolves to nothing rather than the token", () => {
    expect(applyMerge("As {{title}}", P({ title: "N/A" }))).toBe("As ");
  });
});
