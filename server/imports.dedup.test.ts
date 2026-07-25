/**
 * CSV import dedup — the name+company fallback.
 *
 * Context (QA #7, re-tested 2026-07-25): duplicate detection was 100%
 * email-based, and every contact in the live workspace has email = null, so no
 * import could ever detect an already-existing contact. The fallback below is
 * opt-in; these tests pin the safety properties that justify letting it merge
 * records at all.
 */
import { describe, it, expect } from "vitest";
import { nameCompanyKey } from "./routers/imports";

describe("nameCompanyKey — safety", () => {
  it("refuses to key on a name alone", () => {
    // Matching on name only would merge every same-named person in the file.
    expect(nameCompanyKey("John", "Smith", null)).toBeNull();
    expect(nameCompanyKey("John", "Smith", "")).toBeNull();
    expect(nameCompanyKey("John", "Smith", "   ")).toBeNull();
  });

  it("keeps two different people with the same name apart", () => {
    const a = nameCompanyKey("John", "Smith", "Acme");
    const b = nameCompanyKey("John", "Smith", "Globex");
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("requires both first and last name", () => {
    expect(nameCompanyKey("", "Smith", "Acme")).toBeNull();
    expect(nameCompanyKey("John", "", "Acme")).toBeNull();
    expect(nameCompanyKey(null, null, "Acme")).toBeNull();
  });
});

describe("nameCompanyKey — normalisation", () => {
  it("ignores case and surrounding whitespace", () => {
    expect(nameCompanyKey("  John ", "SMITH", " Acme ")).toBe(nameCompanyKey("john", "smith", "acme"));
  });

  it("collapses repeated inner whitespace", () => {
    expect(nameCompanyKey("Mary  Jane", "Watson", "Acme")).toBe(nameCompanyKey("Mary Jane", "Watson", "Acme"));
  });

  it("treats common company suffixes as noise", () => {
    // "Acme Inc." and "Acme" are the same employer in every real dataset.
    const plain = nameCompanyKey("John", "Smith", "Acme");
    expect(nameCompanyKey("John", "Smith", "Acme Inc.")).toBe(plain);
    expect(nameCompanyKey("John", "Smith", "Acme, LLC")).toBe(plain);
    expect(nameCompanyKey("John", "Smith", "Acme Ltd")).toBe(plain);
  });

  it("does not collapse genuinely different companies", () => {
    expect(nameCompanyKey("John", "Smith", "Acme")).not.toBe(nameCompanyKey("John", "Smith", "Acme Labs"));
  });

  it("returns null when a company is nothing but a suffix", () => {
    // "Inc" alone identifies no employer, so it must not become a match key.
    expect(nameCompanyKey("John", "Smith", "Inc")).toBeNull();
  });
});
