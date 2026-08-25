/**
 * stripNameCredentials rewrites people's NAMES, so a wrong answer here is
 * worse than a missed strip — half these cases exist to prove restraint.
 * The credentialed examples are the owner's list plus live workspace rows.
 */
import { describe, it, expect } from "vitest";
import { repairNamePair, stripNameCredentials } from "./enrichment/personName";

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

describe("repairNamePair", () => {
  it("re-splits when a last-space import left the credential as the surname", () => {
    // Ron's live row after the first heal pass: the comma had stranded the
    // credential alone in lastName, where the single-field strip can't act.
    expect(repairNamePair("Ron Flournoy,", "PSP")).toEqual({ firstName: "Ron", lastName: "Flournoy" });
    expect(repairNamePair("Rachele Thomas", "CDAL")).toEqual({ firstName: "Rachele", lastName: "Thomas" });
  });

  it("known credentials only — an all-caps surname is not a credential", () => {
    // CDAL is in the list; LEE is somebody's name.
    expect(repairNamePair("Ron Flournoy", "LEE")).toEqual({ firstName: "Ron Flournoy", lastName: "LEE" });
  });

  it("leaves a single-word firstName pair alone — nothing safe to re-split", () => {
    expect(repairNamePair("Cher", "MBA")).toEqual({ firstName: "Cher", lastName: "MBA" });
  });

  it("strips both fields in the ordinary case", () => {
    expect(repairNamePair("Ron", "Flournoy, PSP")).toEqual({ firstName: "Ron", lastName: "Flournoy" });
    expect(repairNamePair("Dr. Jane", "Doe")).toEqual({ firstName: "Jane", lastName: "Doe" });
  });

  it("null-in, null-out", () => {
    expect(repairNamePair(null, null)).toEqual({ firstName: null, lastName: null });
  });
});

/**
 * The People "Name" rule (owner 2026-08-25): first + last only,
 * capitalization normalized. Same restraint philosophy — mixed-case tokens
 * are somebody's own casing and must survive untouched.
 */
import { normalizePersonNamePair } from "./enrichment/personName";

describe("normalizePersonNamePair", () => {
  it("title-cases shapeless tokens (ALL-CAPS and all-lowercase)", () => {
    expect(normalizePersonNamePair("JOHN", "SMITH")).toEqual({ firstName: "John", lastName: "Smith" });
    expect(normalizePersonNamePair("mary", "jones")).toEqual({ firstName: "Mary", lastName: "Jones" });
  });

  it("never touches mixed-case tokens — that shape is deliberate", () => {
    expect(normalizePersonNamePair("Ronald", "McDonald")).toEqual({ firstName: "Ronald", lastName: "McDonald" });
    expect(normalizePersonNamePair("Leonardo", "DiCaprio")).toEqual({ firstName: "Leonardo", lastName: "DiCaprio" });
  });

  it("re-caps apostrophe/hyphen segments and the Mc prefix", () => {
    expect(normalizePersonNamePair("SEAN", "O'BRIEN")).toEqual({ firstName: "Sean", lastName: "O'Brien" });
    expect(normalizePersonNamePair("ann", "smith-jones")).toEqual({ firstName: "Ann", lastName: "Smith-Jones" });
    expect(normalizePersonNamePair("ronald", "mcdonald")).toEqual({ firstName: "Ronald", lastName: "McDonald" });
  });

  it("keeps surname particles lowercase — but a particle AS the surname capitalizes", () => {
    expect(normalizePersonNamePair("ANA", "VAN DER BERG")).toEqual({ firstName: "Ana", lastName: "van der Berg" });
    expect(normalizePersonNamePair("maria", "de la cruz")).toEqual({ firstName: "Maria", lastName: "de la Cruz" });
    // Vietnamese surnames: the particle list must not eat a real surname.
    expect(normalizePersonNamePair("thanh", "LE")).toEqual({ firstName: "Thanh", lastName: "Le" });
  });

  it("firstName keeps only its first token — middles drop, per the rule", () => {
    expect(normalizePersonNamePair("John A.", "Smith")).toEqual({ firstName: "John", lastName: "Smith" });
    expect(normalizePersonNamePair("Mary Ann", "Smith")).toEqual({ firstName: "Mary", lastName: "Smith" });
  });

  it("splits a whole name stored in firstName: first token / last token", () => {
    expect(normalizePersonNamePair("John Smith", "")).toEqual({ firstName: "John", lastName: "Smith" });
    expect(normalizePersonNamePair("John Michael Smith", null)).toEqual({ firstName: "John", lastName: "Smith" });
  });

  it("lastName stays whole — multi-token surnames and generational suffixes ARE the name", () => {
    expect(normalizePersonNamePair("Bob", "Smith Jr")).toEqual({ firstName: "Bob", lastName: "Smith Jr" });
  });

  it("still strips credentials (built on repairNamePair)", () => {
    expect(normalizePersonNamePair("RACHELE", "THOMAS, BSN, RN, CDAL")).toEqual({ firstName: "Rachele", lastName: "Thomas" });
  });

  it("null-in, null-out; never empties a non-empty input", () => {
    expect(normalizePersonNamePair(null, null)).toEqual({ firstName: null, lastName: null });
    expect(normalizePersonNamePair("Cher", null).firstName).toBe("Cher");
  });
});
