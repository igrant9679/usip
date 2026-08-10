/**
 * stripNameCredentials rewrites people's NAMES, so a wrong answer here is
 * worse than a missed strip — half these cases exist to prove restraint.
 * The credentialed examples are the owner's list plus live workspace rows.
 */
import { describe, it, expect } from "vitest";
import { stripNameCredentials } from "./enrichment/personName";

describe("stripNameCredentials", () => {
  it("strips the owner's example credentials", () => {
    expect(stripNameCredentials("Jane Doe, CPTM")).toBe("Jane Doe");
    expect(stripNameCredentials("Jane Doe, PMP")).toBe("Jane Doe");
    expect(stripNameCredentials("Jane Doe, MBA")).toBe("Jane Doe");
    expect(stripNameCredentials("Jane Doe, FACHE")).toBe("Jane Doe");
  });

  it("strips the live workspace rows this was built for", () => {
    // Ron's row rendered "Ron Flournoy, PSP" on the People page (2026-08-10).
    expect(stripNameCredentials("Ron Flournoy, PSP")).toBe("Ron Flournoy");
    // The areEngine comment's original example.
    expect(stripNameCredentials("Rachele Thomas, BSN, RN, CDAL")).toBe("Rachele Thomas");
  });

  it("works on a bare last-name part, the shape enrichment actually stores", () => {
    expect(stripNameCredentials("Flournoy, PSP")).toBe("Flournoy");
    expect(stripNameCredentials("Doe, MBA, PMP")).toBe("Doe");
  });

  it("strips chained and dotted credentials", () => {
    expect(stripNameCredentials("Jane Doe, MBA, PMP, CSM")).toBe("Jane Doe");
    expect(stripNameCredentials("Jane Doe, Ph.D.")).toBe("Jane Doe");
    expect(stripNameCredentials("John Smith, SHRM-CP")).toBe("John Smith");
  });

  it("strips space-form known credentials", () => {
    expect(stripNameCredentials("John Smith MBA")).toBe("John Smith");
    expect(stripNameCredentials("Jane Doe PhD")).toBe("Jane Doe");
    expect(stripNameCredentials("John Smith MBA PMP")).toBe("John Smith");
  });

  it("strips honorific prefixes", () => {
    expect(stripNameCredentials("Dr. Jane Doe")).toBe("Jane Doe");
    expect(stripNameCredentials("Dr Jane Doe")).toBe("Jane Doe");
  });

  it("keeps generational suffixes — they are the name", () => {
    expect(stripNameCredentials("Martin Luther King, Jr.")).toBe("Martin Luther King, Jr.");
    expect(stripNameCredentials("John Smith, III")).toBe("John Smith, III");
  });

  it("never mangles a Last, First import", () => {
    expect(stripNameCredentials("Doe, Jane")).toBe("Doe, Jane");
  });

  it("keeps surnames that collide with degree tokens", () => {
    // "Ma"/"Ba" are real surnames; "MA"/"BA" are degrees. Case decides.
    expect(stripNameCredentials("Jane Ma")).toBe("Jane Ma");
    expect(stripNameCredentials("Amadou Ba")).toBe("Amadou Ba");
    expect(stripNameCredentials("Jane Doe, MA")).toBe("Jane Doe");
  });

  it("leaves all-caps names alone — caps alone prove nothing about a lone name", () => {
    expect(stripNameCredentials("JANE DOE")).toBe("JANE DOE");
  });

  it("never strips to empty", () => {
    expect(stripNameCredentials("MBA")).toBe("MBA");
    expect(stripNameCredentials("PMP, MBA")).toBe("PMP");
  });

  it("null-in, null-out", () => {
    expect(stripNameCredentials(null)).toBeNull();
    expect(stripNameCredentials(undefined)).toBeNull();
    expect(stripNameCredentials("   ")).toBeNull();
  });

  it("keeps honorific-only strings intact", () => {
    expect(stripNameCredentials("Dr.")).toBe("Dr.");
  });
});
