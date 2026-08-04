/**
 * The Help Center's structural invariants.
 *
 * 🪤 WHY THIS EXISTS. `seedHelpContent.ts`'s header claimed "9 categories, 39
 * articles, 10 tours" long after the file held 10, 52 and 58. A count in a
 * comment is a claim nothing checks, so the numbers are gone and the things
 * that actually break are asserted here instead.
 *
 * Every check below is a real failure mode, not a shape:
 *   · an article whose `categorySlug` does not resolve seeds with a NULL
 *     category and disappears from the browse UI while still existing;
 *   · a duplicate `slug` means the second article silently overwrites the
 *     first on every boot, because the upsert keys on (workspaceId, slug);
 *   · a `tourName` that does not resolve leaves "take the tour" pointing at
 *     nothing;
 *   · a "Learn more" link in `helpText.ts` naming a slug that does not exist
 *     404s somebody who trusted it — thirteen did once, several of them tour
 *     NAMES or CATEGORY slugs rather than articles. That check used to be a
 *     shell one-liner in a handoff doc; a check nobody re-runs is not a check.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARTICLES, CATEGORIES, TOURS } from "./seedHelpContent";

const ROOT = join(__dirname, "..");

describe("help content — structure", () => {
  /**
   * A floor, so an import that resolved to an empty array cannot make every
   * assertion below pass vacuously. Set well under the current counts.
   */
  it("has real content to check (floor)", () => {
    expect(CATEGORIES.length).toBeGreaterThan(5);
    expect(ARTICLES.length).toBeGreaterThan(40);
    expect(TOURS.length).toBeGreaterThan(20);
  });

  it("every article lands in a category that exists", () => {
    const known = new Set(CATEGORIES.map((c) => c.slug));
    const orphans = ARTICLES.filter((a) => !known.has(a.categorySlug)).map((a) => `${a.slug} → ${a.categorySlug}`);
    expect(
      orphans,
      orphans.length
        ? `\n\nArticle(s) pointing at a category slug that is not in CATEGORIES:\n  ${orphans.join("\n  ")}\n\n` +
          `These seed with categoryId NULL — the article exists, is searchable,\n` +
          `and never appears when browsing the Help Center.\n`
        : undefined,
    ).toEqual([]);
  });

  it("article slugs are unique", () => {
    const seen = new Map<string, number>();
    for (const a of ARTICLES) seen.set(a.slug, (seen.get(a.slug) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([s, n]) => `${s} ×${n}`);
    expect(
      dupes,
      dupes.length
        ? `\n\nDuplicate slug(s): ${dupes.join(", ")}\n\nThe upsert keys on ` +
          `(workspaceId, slug), so the later one overwrites the earlier on every boot.\n`
        : undefined,
    ).toEqual([]);
  });

  it("every article that offers a tour names one that exists", () => {
    const known = new Set(TOURS.map((t) => t.name));
    const dangling = ARTICLES.filter((a) => a.tourName && !known.has(a.tourName)).map(
      (a) => `${a.slug} → "${a.tourName}"`,
    );
    expect(dangling).toEqual([]);
  });

  it("category slugs are unique, and so are category names", () => {
    // Names as well as slugs: the upsert dedupes on NAME, because
    // help_categories has no slug column.
    expect(new Set(CATEGORIES.map((c) => c.slug)).size).toBe(CATEGORIES.length);
    expect(new Set(CATEGORIES.map((c) => c.name)).size).toBe(CATEGORIES.length);
  });

  it("no article ships empty", () => {
    const thin = ARTICLES.filter(
      (a) => !a.title.trim() || !a.summary.trim() || a.bodyMarkdown.trim().length < 200,
    ).map((a) => a.slug);
    expect(thin, "an article with no body is worse than no article — Ask AI will cite it").toEqual([]);
  });
});

describe("help content — the links pointing INTO it", () => {
  /**
   * `helpText.ts` renders a "Learn more" link from `article: "<slug>"`. This is
   * the check that found 13 broken ones, and it is the reason it now runs in CI
   * rather than living as a `comm -23 <(grep …)` in a handoff document.
   */
  it("every 'Learn more' slug in helpText.ts resolves to an article", () => {
    const src = readFileSync(join(ROOT, "client/src/lib/helpText.ts"), "utf8");
    const referenced = [...src.matchAll(/article:\s*"([^"]+)"/g)].map((m) => m[1]!);

    // If the pattern stops matching, this test would pass on an empty list —
    // which looks identical to "every link resolves".
    expect(referenced.length, "no article: links found — the pattern has gone stale").toBeGreaterThan(5);

    const known = new Set(ARTICLES.map((a) => a.slug));
    const broken = [...new Set(referenced.filter((s) => !known.has(s)))];
    expect(
      broken,
      broken.length
        ? `\n\n"Learn more" link(s) with no article behind them:\n  ${broken.join("\n  ")}\n\n` +
          `Each one 404s a user who trusted it. Note that tour NAMES and\n` +
          `CATEGORY slugs are not article slugs — that was the original mistake.\n`
        : undefined,
    ).toEqual([]);
  });
});
