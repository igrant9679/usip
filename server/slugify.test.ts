/**
 * One slug rule, because a slug is permanent and public.
 *
 * Three byte-identical copies lived in the three routers that mint public URLs
 * — bookingLinks (/b/:slug), chatAgents (/c/:slug), landingPages (/l/:slug).
 * Duplication rather than drift, the same verdict startOfUtcDay and the role
 * maps gave. Consolidated anyway because of what a slug is here: derived from
 * the name at CREATE with no way to change it afterwards, so a slug bug is
 * permanent and customer-visible.
 *
 * One real edge fixed on the way: the old order trimmed hyphens and THEN
 * truncated, so a name whose cut lands on a separator kept a trailing hyphen —
 * and every caller appends `-<suffix>`, producing `some-long-name--a1b2`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { SLUG_MAX, slugify } from "../shared/slugify";

const ROOT = join(__dirname, "..");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("slugify", () => {
  it("lowercases and joins on single hyphens", () => {
    expect(slugify("AI Audit for Nonprofits")).toBe("ai-audit-for-nonprofits");
    expect(slugify("Rep   Name")).toBe("rep-name");
    expect(slugify("Acme, Inc. — Q4 Offer!")).toBe("acme-inc-q4-offer");
  });

  it("never leaves a leading or trailing hyphen, even when truncated", () => {
    expect(slugify("  spaced  ")).toBe("spaced");
    expect(slugify("!!!lead!!!")).toBe("lead");
    // The edge the old order got wrong: build a name whose cut lands on a
    // separator. Trimming before the slice left the hyphen behind, and the
    // caller's `-suffix` then doubled it.
    const name = `${"a".repeat(SLUG_MAX - 1)} tail`;
    const s = slugify(name);
    expect(s.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(s.endsWith("-"), `trailing hyphen in ${JSON.stringify(s)}`).toBe(false);
    expect(`${s}-a1b2`).not.toMatch(/--/);
  });

  it("returns empty for a name with nothing sluggable, so callers can fall back", () => {
    // Deliberate: what a nameless thing should be called is the caller's
    // business, and every call site supplies its own default.
    expect(slugify("!!!")).toBe("");
    expect(slugify("日本語")).toBe("");
    expect(slugify("")).toBe("");
    expect(slugify(null as unknown as string)).toBe("");
  });

  it("caps the derived part so the caller's suffix always fits", () => {
    expect(slugify("x".repeat(200)).length).toBe(SLUG_MAX);
  });
});

describe("only one slug rule", () => {
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

  const files = sourceFiles(join(ROOT, "server"))
    .map((f) => ({ rel: f.slice(ROOT.length + 1).split(sep).join("/"), src: stripComments(readFileSync(f, "utf8")) }));

  it("finds source to scan (guards the scanner itself)", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it("nothing re-derives a slug", () => {
    // The fingerprint all three copies shared.
    const offenders = files
      // The hyphen is what makes it a SLUG. Matching the character class alone
      // flagged areEngine and linkedinEnrichment/matching, which replace with a
      // SPACE — those are text normalisers for comparing names, not URL builders.
      .filter((f) => /replace\(\/\[\^a-z0-9\]\+\/g,\s*"-"\)/.test(f.src))
      .map((f) => f.rel);
    expect(
      offenders,
      offenders.length
        ? `\n\nA second slug rule in:\n  ${offenders.join("\n  ")}\n\n` +
            `Import slugify from @shared/slugify. A slug is derived once at create\n` +
            `and never changes, so a difference between two copies is permanent and\n` +
            `public.\n`
        : undefined,
    ).toEqual([]);
  });

  it("all three public-URL routers import it", () => {
    for (const rel of [
      "server/routers/bookingLinks.ts",
      "server/routers/chatAgents.ts",
      "server/routers/landingPages.ts",
    ]) {
      const f = files.find((x) => x.rel === rel);
      expect(f, rel).toBeDefined();
      expect(f!.src, rel).toMatch(/from\s*"@shared\/slugify"/);
    }
  });
});
