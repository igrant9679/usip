/**
 * Guard for hover-help wiring, which failed by NAME MISMATCH — the dominant
 * defect class in this repo.
 *
 * `navHelpFor(href)` is called only from `renderNavLink` in Shell.tsx and matches
 * the key EXACTLY. Two entries were authored as "/v2/customers" and
 * "/v2/renewals" while the sidebar renders "/customers" and "/renewals", so the
 * copy existed, the links existed, and they never met. Nothing errors: the tip
 * simply never appears, which is indistinguishable from "no tip was written" —
 * on the feature added specifically because the product's own owner said he
 * could not use it.
 *
 * Two traps this test had to survive, both of which produced a confidently
 * wrong answer first:
 *
 *  1. `const TOP_LINKS: NavLink[] = [` — slicing from the first "[" after the
 *     name lands on the bracket pair in the TYPE ANNOTATION, which closes
 *     immediately and yields an empty array. The scan reported 0 nav links and
 *     therefore 0 problems. Anchor on "= [".
 *  2. `_LEGACY_NAV` is NOT rendered — it only feeds an accent-colour map. Its 42
 *     links must not be counted, or every one of them looks uncovered.
 *
 * Hence the floor assertions below: a scanner that finds nothing must fail
 * loudly rather than pass silently.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Slice the array literal assigned to `const <name>`, skipping the type annotation. */
function sliceArray(src: string, name: string): string {
  const i = src.indexOf("const " + name);
  if (i < 0) return "";
  const eq = src.indexOf("= [", i);
  if (eq < 0) return "";
  let depth = 0;
  let j = eq + 2;
  for (; j < src.length; j++) {
    if (src[j] === "[") depth++;
    else if (src[j] === "]") { depth--; if (depth === 0) break; }
  }
  return src.slice(eq + 2, j);
}

const shell = read("client/src/components/usip/Shell.tsx");
const helpText = read("client/src/lib/helpText.ts");

/** Only the arrays the sidebar actually renders. */
const liveNav = ["TOP_LINKS", "SECTIONS", "BOTTOM_LINKS"].map((n) => sliceArray(shell, n)).join("\n");

const liveLinks = [...liveNav.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]);

const navHelpBlock = helpText.slice(helpText.indexOf("NAV_HELP"), helpText.indexOf("FIELD_HELP"));
const helpKeys = new Set([...navHelpBlock.matchAll(/"(\/[^"]*)":/g)].map((m) => m[1]));

/**
 * Keys for pages that are NOT in the sidebar (reached via a SubNav or the "More"
 * menu). navHelpFor is never called for them, so they are inert — kept because
 * the copy is harmless and may be wired later. Listed so "inert" is a stated
 * fact rather than something the next reader has to rediscover.
 */
const INERT_KEYS = new Set([
  "/v2/pipeline",        // Pipeline has no sidebar link
  "/v2/opportunities",   // reached from the pipeline board
  "/sending-accounts",   // Engage SubNav
  "/are/performance",    // ARE Hub SubNav
]);

describe("nav hover-help coverage", () => {
  it("finds the live nav and the help keys (guards the scanner itself)", () => {
    // Both previous versions of this scan returned 0 and looked clean.
    expect(liveLinks.length).toBeGreaterThan(40);
    expect(helpKeys.size).toBeGreaterThan(40);
  });

  it("excludes _LEGACY_NAV, which is not rendered", () => {
    const legacy = sliceArray(shell, "_LEGACY_NAV");
    expect(legacy.length).toBeGreaterThan(0); // it does still exist…
    // …and none of its exclusive hrefs leaked into the live set.
    expect(liveNav).not.toContain("_LEGACY_NAV");
  });

  it("every sidebar link has hover help", () => {
    const uncovered = [...new Set(liveLinks)].filter((h) => !helpKeys.has(h));
    expect(
      uncovered,
      uncovered.length
        ? `\n\nSidebar link(s) with no NAV_HELP entry:\n  ${uncovered.join("\n  ")}\n\n` +
            `Add them to NAV_HELP in client/src/lib/helpText.ts — that is the one place\n` +
            `hover copy lives.\n`
        : undefined,
    ).toEqual([]);
  });

  it("every NAV_HELP key matches a sidebar link, or is declared inert", () => {
    // This is the direction that actually broke: copy keyed to an href the
    // sidebar never renders can never be shown.
    const orphans = [...helpKeys].filter((k) => !liveLinks.includes(k) && !INERT_KEYS.has(k));
    expect(
      orphans,
      orphans.length
        ? `\n\nNAV_HELP key(s) matching no sidebar link:\n  ${orphans.join("\n  ")}\n\n` +
            `navHelpFor() matches the href EXACTLY, so this copy can never appear. Either\n` +
            `re-key it to the href Shell.tsx renders, or add it to INERT_KEYS with a note\n` +
            `saying which SubNav reaches that page.\n`
        : undefined,
    ).toEqual([]);
  });

  it("INERT_KEYS has no stale entries", () => {
    const nowLive = [...INERT_KEYS].filter((k) => liveLinks.includes(k));
    expect(
      nowLive,
      nowLive.length ? `\n\nThese are listed inert but now have a sidebar link — drop them:\n  ${nowLive.join("\n  ")}\n` : undefined,
    ).toEqual([]);
  });
});
