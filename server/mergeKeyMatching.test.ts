/**
 * The four merge-field implementations must agree on WHAT A TOKEN MEANS.
 *
 * `41daa03` pinned their token SETS to each other (mergeVarCoverage.test.ts).
 * Nothing pinned their MATCHERS, and all three rules differed:
 *
 *   mergeVars.resolveMergeVars   exact `.get(name)` — case-sensitive
 *   crm/sequences                lowercase + strip [_\s], no `|fallback`
 *   areEngine.applyMerge         literal /gi regexes per token
 *
 * So `{{first_name}}` resolved on the sequences path and reached a prospect
 * with its braces on via the draft path, and `{{firstName|Friend}}` — the
 * fallback syntax mergeVars documents — was emitted verbatim by the other two.
 *
 * These are BEHAVIOURAL assertions against the shipped functions, not a
 * re-implementation of the matching rule. A test that recomputes the answer
 * agrees with itself forever while the real renderers drift.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMergeVars, renderMergeFields, type MergeContext } from "./mergeVars";
import { applyMerge } from "./areEngine";

const ROOT = join(__dirname, "..");

/** Every spelling a human or an LLM plausibly types for one variable. */
const SPELLINGS = [
  "{{firstName}}",
  "{{FirstName}}",
  "{{firstname}}",
  "{{FIRSTNAME}}",
  "{{first_name}}",
  "{{first name}}",
  "{{first-name}}",
  "{{ firstName }}",
];

const ctx: MergeContext = {
  contact: { firstName: "Alice", lastName: "Smith", title: "VP Engineering" },
  account: { name: "Acme" },
  sender: { name: "Bob" },
} as MergeContext;

const prospect = { firstName: "Alice", lastName: "Smith", companyName: "Acme", title: "VP Engineering" } as never;

describe("every merge implementation resolves every spelling", () => {
  it.each(SPELLINGS)("resolveMergeVars — %s", (token) => {
    expect(resolveMergeVars(`Hi ${token},`, ctx)).toBe("Hi Alice,");
  });

  it.each(SPELLINGS)("renderMergeFields (crm + sequences) — %s", (token) => {
    expect(renderMergeFields(`Hi ${token},`, { firstName: "Alice" })).toBe("Hi Alice,");
  });

  it.each(SPELLINGS)("areEngine.applyMerge — %s", (token) => {
    expect(applyMerge(`Hi ${token},`, prospect)).toBe("Hi Alice,");
  });
});

describe("the {{name|fallback}} syntax works everywhere it can", () => {
  it("resolveMergeVars uses the fallback when the value is empty", () => {
    const empty = { contact: { firstName: "" }, account: {}, sender: {} } as MergeContext;
    expect(resolveMergeVars("Hi {{firstName|Friend}},", empty)).toBe("Hi Friend,");
  });

  it("renderMergeFields uses the fallback — it could not even parse one before", () => {
    expect(renderMergeFields("Hi {{firstName|Friend}},", { firstName: "" })).toBe("Hi Friend,");
    expect(renderMergeFields("Hi {{firstName|Friend}},", { firstName: "Alice" })).toBe("Hi Alice,");
  });

  it("applyMerge uses the fallback rather than blanking the word", () => {
    // Its firstName defaults to "there", so use a token that can be empty.
    expect(applyMerge("Role: {{title|unknown}}", { ...(prospect as object), title: null } as never))
      .toBe("Role: unknown");
  });
});

describe("unresolved-token POLICY still differs, deliberately", () => {
  /**
   * This is the one difference that is NOT drift: areEngine mails a stranger
   * with no human in the loop, so it strips; the other two leave the token
   * visible for the reviewer who is about to read the draft. Asserted so that
   * changing it is a decision rather than a side effect.
   */
  it("resolveMergeVars leaves an unknown token verbatim", () => {
    expect(resolveMergeVars("Hi {{notAThing}},", ctx)).toBe("Hi {{notAThing}},");
  });

  it("renderMergeFields leaves an unknown token verbatim", () => {
    expect(renderMergeFields("Hi {{notAThing}},", { firstName: "Alice" })).toBe("Hi {{notAThing}},");
  });

  it("applyMerge strips an unknown token", () => {
    expect(applyMerge("Hi {{notAThing}},", prospect)).toBe("Hi ,");
  });
});

describe("normalization does not over-reach", () => {
  it("keeps namespaced customField keys distinct", () => {
    const withCustom = {
      contact: { firstName: "Alice", customFields: { tier: "Gold" } },
      account: {},
      sender: {},
    } as MergeContext;
    expect(resolveMergeVars("Tier: {{customField.tier}}", withCustom)).toBe("Tier: Gold");
    // The dot is preserved, so this is NOT the same key.
    expect(resolveMergeVars("Tier: {{customFieldtier}}", withCustom)).toBe("Tier: {{customFieldtier}}");
  });

  it("an exact key always wins over a normalized collision", () => {
    expect(renderMergeFields("{{a_b}}|{{ab}}", { ab: "exact", a_b: "under" })).toBe("under|exact");
  });
});

/**
 * Anti-drift. Comments are STRIPPED FIRST: the replacement comments left in
 * crm.ts and sequences.ts name both `renderMergeFields` and `../mergeVars`, so
 * a raw scan would match the prose explaining the fix and pass either way.
 * That exact trap has bitten this repo four times.
 */
describe("no file re-declares a merge renderer", () => {
  const CONSUMERS = ["server/routers/crm.ts", "server/routers/sequences.ts"];

  const stripped = (rel: string) =>
    readFileSync(join(ROOT, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("finds the consumers to scan (guards the scanner itself)", () => {
    for (const rel of CONSUMERS) {
      expect(stripped(rel).length, rel).toBeGreaterThan(1000);
      expect(stripped(rel), rel).toContain("renderMergeFields(");
    }
  });

  it("neither consumer defines its own copy", () => {
    for (const rel of CONSUMERS) {
      expect(stripped(rel), rel).not.toMatch(/function\s+renderMergeFields/);
    }
  });

  it("both consumers import the one definition", () => {
    for (const rel of CONSUMERS) {
      expect(stripped(rel), rel).toMatch(/import\s*\{[^}]*renderMergeFields[^}]*\}\s*from\s*["']\.\.\/mergeVars["']/);
    }
  });

  it("every implementation matches keys via @shared/mergeKeys", () => {
    for (const rel of ["server/mergeVars.ts", "server/areEngine.ts"]) {
      expect(stripped(rel), rel).toContain("@shared/mergeKeys");
      // The old hand-rolled rule must not come back alongside it.
      expect(stripped(rel), rel).not.toMatch(/toLowerCase\(\)\.replace\(\/\[_\\s\]/);
    }
  });
});
