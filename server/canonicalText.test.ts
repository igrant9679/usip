/**
 * One canonical comparison form for names and companies.
 *
 * FIVE copies of this rule existed. They were verified DIFFERENTIALLY over 49
 * adversarial inputs — runs of spaces, tabs, punctuation runs, leading and
 * trailing separators, accents, CJK, emoji, empty, null — and agreed on every
 * one before being replaced. Duplication, not drift; the same verdict as
 * `slugify` and the role hierarchy.
 *
 * Consolidated anyway because of what they DECIDE: whether two records are the
 * same human. `nameOrgDedupKey` builds the key that stops one prospect being
 * enrolled twice, and `matching.ts` feeds the Jaccard overlap that links a
 * LinkedIn profile to a person. One edit to one copy silently merges two
 * different people, or stops merging one.
 *
 * 🔎 The fifth copy was found by scanning for the RULE, not the NAME: it lived
 * in scoring/operators.ts under the identifier `t`, and its own comment said it
 * "mirrors the enrichment matcher heuristic". A mirror is a copy that has not
 * drifted yet. Grepping for `norm` would never have found it — which is why the
 * anti-drift test below matches the regex literal instead.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { canonicalText, canonicalTokens } from "@shared/canonicalText";
import { normalizeMergeKey } from "@shared/mergeKeys";

const ROOT = join(__dirname, "..");

describe("canonicalText", () => {
  it("lowercases and collapses every run of separators to one space", () => {
    expect(canonicalText("John   Smith")).toBe("john smith");
    expect(canonicalText("John\t\tSmith")).toBe("john smith");
    expect(canonicalText("MiXeD CaSe")).toBe("mixed case");
  });

  it("trims leading and trailing separators", () => {
    expect(canonicalText("  John Smith  ")).toBe("john smith");
    expect(canonicalText("-leading")).toBe("leading");
    expect(canonicalText("trailing-")).toBe("trailing");
  });

  it("treats punctuation runs as a single boundary", () => {
    expect(canonicalText("O'Brien--SMITH, Inc.")).toBe("o brien smith inc");
    expect(canonicalText("AT&T")).toBe("at t");
    expect(canonicalText("salesforce.com")).toBe("salesforce com");
  });

  it("reduces a string of only separators to empty", () => {
    for (const s of ["", " ", "   ", "---", "...", "!@#$%^&*()"]) {
      expect(canonicalText(s), JSON.stringify(s)).toBe("");
    }
  });

  it("survives null, undefined and non-strings", () => {
    // Two of the five copies used a bare `?? ""` and would have thrown on a
    // number reaching them. Same output for every declared input, one fewer
    // way to fail at runtime.
    expect(canonicalText(null)).toBe("");
    expect(canonicalText(undefined)).toBe("");
    expect(canonicalText(42 as unknown)).toBe("42");
  });

  it("drops accented and non-Latin characters to boundaries", () => {
    // Documenting the real behaviour rather than the behaviour one might wish
    // for: this is a comparison key, and all five copies did exactly this.
    expect(canonicalText("Zoë Müller")).toBe("zo m ller");
    expect(canonicalText("北京字节跳动")).toBe("");
  });

  it("is idempotent", () => {
    const once = canonicalText("  O'Brien--SMITH, Inc. ");
    expect(canonicalText(once)).toBe(once);
  });
});

describe("canonicalTokens", () => {
  it("splits the canonical form and drops empties", () => {
    expect([...canonicalTokens("O'Brien--SMITH, Inc.")]).toEqual(["o", "brien", "smith", "inc"]);
  });

  it("is empty for a string with no alphanumerics", () => {
    expect(canonicalTokens("!!!").size).toBe(0);
    expect(canonicalTokens(null).size).toBe(0);
  });
});

/**
 * The reason these three canonicalisers must NOT be merged, asserted rather
 * than left as a comment somebody can talk themselves out of.
 */
describe("it is a different rule from the identifier canonicalisers", () => {
  it("preserves word boundaries where normalizeMergeKey removes them", () => {
    // Merge keys match IDENTIFIERS: first_name and firstName are one key.
    expect(normalizeMergeKey("first_name")).toBe("firstname");
    // This one feeds TOKENISATION: "John Smith" must stay two tokens or the
    // Jaccard overlap in matching.ts scores 0 against "John A. Smith".
    expect(canonicalText("first_name")).toBe("first name");
    expect(canonicalTokens("John Smith").size).toBe(2);
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Files allowed to canonicalise text their own way, with the reason. A rule
 * that flags legitimate cases is a rule someone switches off.
 */
const OWN_RULE_ALLOWED: Record<string, string> = {
  "server/services/chatKnowledge.ts":
    "terms() returns an ARRAY that keeps duplicates (its scoring counts repeats) and applies stopword + length filtering. canonicalTokens returns a deduping Set — a different job, not a copy.",
  "server/services/company/normalize.ts":
    "Company-name rule deliberately KEEPS & and -, because 'Smith & Sons' and 'Coca-Cola' are names rather than boundaries.",
  "server/routers/helpCenter.ts":
    "Builds a URL slug (hyphen separators, hyphens retained) — that is @shared/slugify's shape, not this one.",
};

describe("nobody re-declares the rule", () => {
  const files = sourceFiles(join(ROOT, "server"));

  it("finds source to scan (guards the scanner itself)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("the lowercase + [^a-z0-9] collapse appears only where allowed", () => {
    const offenders: string[] = [];
    for (const f of files) {
      // Comments first: areEngine's replacement comment quotes the very regex
      // this looks for, and would flag itself.
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const rel = f.slice(ROOT.length + 1).split(sep).join("/");
      if (rel in OWN_RULE_ALLOWED) continue;
      if (/toLowerCase\(\)[\s\S]{0,40}\[\^a-z0-9 ?\]\+?/.test(src) || /\[\^a-z0-9 ?\]\+?[\s\S]{0,40}toLowerCase\(\)/.test(src)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      offenders.length
        ? `\n\nInline canonical-text rule(s) — use canonicalText/canonicalTokens\n` +
            `from @shared/canonicalText:\n  ${offenders.join("\n  ")}\n\n` +
            `Five copies of this agreed, which is one edit away from not. These\n` +
            `decide whether two records are the same human.\n`
        : undefined,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const stale = Object.keys(OWN_RULE_ALLOWED).filter((rel) => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      return !/\[\^a-z0-9/.test(src);
    });
    expect(stale, stale.length ? `\n\nAllowlisted but no longer has its own rule:\n  ${stale.join("\n  ")}\n` : undefined).toEqual([]);
  });

  it("the five consolidated sites import the shared helper", () => {
    for (const rel of [
      "server/services/linkedinEnrichment/snapshot.ts",
      "server/services/linkedinEnrichment/matching.ts",
      // nameOrgDedupKey moved out of areEngine into the shared identity
      // module (2026-08-12, campaign exclusivity) — the import moved with it.
      "server/services/are/queueIdentity.ts",
      "server/services/discovery/consolidate.ts",
      "server/services/scoring/operators.ts",
    ]) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      // A REAL import line. The first attempt at this consolidation checked for
      // the module name ANYWHERE and matched the comments it had just written,
      // so four files got a comment and no import (tsc 341 -> 345 said so).
      expect(src, rel).toMatch(/^import\b.*from\s+["']@shared\/canonicalText["']/m);
    }
  });
});
