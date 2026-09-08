/**
 * Pins for the Operator's Manual (2026-09-08) — the same knowledge in three
 * homes (the repo skill, the assistant digest, the Help Center category) that
 * can only drift apart silently. These checks make the drift loud:
 *
 *   - every href the assistant digest names is a real registry tool (or one of
 *     its documented tab/filter variants), so `navigate` targets resolve;
 *   - the digest is actually IN both AI prompts (assistant + Ask AI), not just
 *     exported;
 *   - the manual's articles are seeded, in their own category, and every
 *     internal link inside them resolves to an article or a real page;
 *   - the article renderer supports the inline set the manual uses.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../client/src/lib/toolRegistry";
import { ARTICLES, CATEGORIES } from "./seedHelpContent";
import { OPERATOR_ARTICLES, OPERATOR_CATEGORY } from "./seedHelpOperatorManual";
import { PRODUCT_KNOWLEDGE, knowledgeHrefs } from "./productKnowledge";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const registryHrefs = new Set(TOOLS.map((t) => t.href));
// Paths the digest names that are deliberately not registry tools.
const KNOWN_NON_TOOL_PATHS = new Set(["/help/articles"]);
function hrefResolves(href: string): boolean {
  if (registryHrefs.has(href)) return true;
  const base = href.split("?")[0].split("#")[0];
  if (registryHrefs.has(base)) return true;
  if (KNOWN_NON_TOOL_PATHS.has(base)) return true;
  return false;
}

describe("assistant product knowledge digest", () => {
  it("names only real pages", () => {
    const hrefs = knowledgeHrefs();
    expect(hrefs.length).toBeGreaterThan(40);
    const unknown = hrefs.filter((h) => !hrefResolves(h));
    expect(unknown, "digest names a path the tool registry does not have — navigate would 404").toEqual([]);
  });

  it("covers every primary (rail) tool by href", () => {
    const missing = TOOLS.filter((t) => t.primary && !PRODUCT_KNOWLEDGE.includes(t.href)).map((t) => t.href);
    expect(missing).toEqual([]);
  });

  it("stays a digest, not a manual", () => {
    expect(PRODUCT_KNOWLEDGE.length).toBeLessThan(9000);
  });

  it("is inside BOTH AI system prompts", () => {
    const assistant = read("./routers/assistant.ts");
    const help = read("./routers/helpCenter.ts");
    expect(assistant).toMatch(/import \{ PRODUCT_KNOWLEDGE \} from "\.\.\/productKnowledge"/);
    expect(assistant).toContain("${PRODUCT_KNOWLEDGE}");
    expect(assistant).toContain("whats_waiting first");
    expect(help).toMatch(/import \{ PRODUCT_KNOWLEDGE \} from "\.\.\/productKnowledge"/);
    expect(help).toContain("${PRODUCT_KNOWLEDGE}");
  });
});

describe("Operator's Manual help articles", () => {
  it("are seeded in their own category, first", () => {
    expect(CATEGORIES[0]).toBe(OPERATOR_CATEGORY);
    expect(OPERATOR_ARTICLES.length).toBeGreaterThanOrEqual(12);
    for (const a of OPERATOR_ARTICLES) {
      expect(ARTICLES).toContain(a);
      expect(a.slug.startsWith("om-")).toBe(true);
      expect(a.categorySlug).toBe(OPERATOR_CATEGORY.slug);
    }
  });

  it("cover the routines and the page directory", () => {
    const slugs = new Set(OPERATOR_ARTICLES.map((a) => a.slug));
    for (const s of ["om-how-velocity-fits-together", "om-page-directory", "om-daily-routine", "om-weekly-routine", "om-monthly-routine", "om-revenue-engine-lifecycle", "om-autopilots-and-schedules", "om-glossary", "om-troubleshooting"]) {
      expect(slugs.has(s), s).toBe(true);
    }
    // Every rail tool is named in the page directory by href.
    const dir = OPERATOR_ARTICLES.find((a) => a.slug === "om-page-directory")!.bodyMarkdown;
    const missing = TOOLS.filter((t) => t.primary && !dir.includes(t.href)).map((t) => t.href);
    expect(missing).toEqual([]);
  });

  it("only link to articles that exist and pages that exist", () => {
    const slugs = new Set(ARTICLES.map((a) => a.slug));
    const bad: string[] = [];
    for (const a of OPERATOR_ARTICLES) {
      for (const m of a.bodyMarkdown.matchAll(/\]\((\/[^)\s]+)\)/g)) {
        const href = m[1];
        const art = href.match(/^\/help\/articles\/([a-z0-9-]+)$/);
        if (art) { if (!slugs.has(art[1])) bad.push(`${a.slug} → ${href}`); continue; }
        if (!hrefResolves(href)) bad.push(`${a.slug} → ${href}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("use only markdown the article renderer supports", () => {
    const renderer = read("../client/src/pages/usip/HelpArticle.tsx");
    // bold, code, links and pipe tables are rendered — not shown as literal asterisks.
    expect(renderer).toContain("export function renderInline");
    expect(renderer).toContain("export function splitTableRow");
    expect(renderer).toContain("flushTable()");
    for (const a of OPERATOR_ARTICLES) {
      expect(a.bodyMarkdown, a.slug).not.toMatch(/^>\s/m); // no blockquotes
      expect(a.bodyMarkdown, a.slug).not.toMatch(/!\[/); // no images
    }
  });
});
