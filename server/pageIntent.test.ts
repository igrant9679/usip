/**
 * One reading of a URL, because the second one spawned tasks.
 *
 * `chatPageContext.ts` carried a comment saying it "deliberately mirrors
 * `classifyIntent` in websiteTracking.ts — ... two different opinions about what
 * '/pricing' means would be a bug waiting to happen." The two had already
 * drifted, and the gap was not symmetric: website tracking had NO non-buyer
 * band at all.
 *
 * That matters because tracking does not just record a band. A visit scored
 * `high` by a KNOWN contact or lead spawns a follow-up task for the record
 * owner — so the drift turned blog readers and job applicants into rep
 * interruptions:
 *
 *   /blog/pricing-strategy   → HIGH   (matched "pricing")
 *   /careers/product-manager → MEDIUM (matched "product")
 *   /jobs/solutions-engineer → MEDIUM (matched "solution")
 *
 * The chat side had already written the rule that these are not buyers. The
 * tracking side never received it, and nothing bound the two.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { isNonBuyerPage, pageIntent, pathOf } from "../shared/pageIntent";
import { pageIntent as viaChatModule } from "./services/chatPageContext";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("pageIntent", () => {
  it("scores real buying pages high", () => {
    for (const p of ["/pricing", "/request-a-demo", "/contact-us", "/book-a-call",
                     "/free-trial", "/get-started", "/checkout", "/buy-now",
                     "/get-a-quote", "/free-consultation", "/free-audit"]) {
      expect(pageIntent(p), p).toBe("high");
    }
  });

  it("scores research pages medium", () => {
    for (const p of ["/products", "/our-services", "/features", "/solutions",
                     "/case-studies", "/customers", "/integrations", "/how-it-works"]) {
      expect(pageIntent(p), p).toBe("medium");
    }
  });

  it("NON-BUYER pages outrank every other signal", () => {
    // The whole bug, as a table. Each of these matched a high or medium pattern
    // and was scored as a shopper by website tracking.
    const cases: Array<[string, string]> = [
      ["/blog/pricing-strategy", "a blog post about pricing is not a pricing page"],
      ["/careers/product-manager", "a job ad is not product research"],
      ["/jobs/solutions-engineer", "ditto"],
      ["/about/our-customers", "an about page naming customers is not a customer page"],
      ["/team/contact", "a team directory is not a contact request"],
      ["/press/new-pricing-announced", "press coverage is not shopping"],
      ["/privacy", "nobody buys from a privacy policy"],
      ["/terms", "or from terms"],
    ];
    for (const [path, why] of cases) {
      expect(pageIntent(path), `${path} — ${why}`).toBe("low");
      expect(isNonBuyerPage(path), path).toBe(true);
    }
  });

  it("treats an unknown page as low rather than guessing", () => {
    expect(pageIntent("/")).toBe("low");
    expect(pageIntent("/some/random/page")).toBe("low");
    expect(pageIntent("")).toBe("low");
    expect(pageIntent(null as unknown as string)).toBe("low");
  });

  it("reads the path out of a full URL, and survives a malformed one", () => {
    expect(pathOf("https://example.com/Pricing?utm=x")).toBe("/pricing?utm=x");
    expect(pageIntent("https://example.com/pricing")).toBe("high");
    // A query string can carry the signal too.
    expect(pageIntent("/landing?plan=pricing")).toBe("high");
    // `new URL(x, base)` resolves a relative reference rather than throwing, so
    // free text comes back percent-encoded rather than hitting the catch. Fine
    // for the purpose — it still contains no intent words — but worth pinning so
    // the fallback branch is not mistaken for the common path.
    expect(pathOf("not a url at all")).toBe("/not%20a%20url%20at%20all");
    expect(pageIntent("not a url at all")).toBe("low");
  });

  it("gives the chat agent and website tracking the SAME answer", () => {
    // The invariant the comment claimed and nothing enforced. Imported through
    // the chat module and directly from the shared one — if they ever stop being
    // the same function this fails.
    for (const p of ["/pricing", "/blog/pricing-strategy", "/careers/product-manager",
                     "/checkout", "/free-audit", "/", "/integrations"]) {
      expect(viaChatModule(p), p).toBe(pageIntent(p));
    }
  });
});

/* ─── Source guard ───────────────────────────────────────────────────────── */

describe("only one module classifies a path", () => {
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

  const files = sourceFiles(join(ROOT, "server"));

  it("finds source to scan (guards the scanner itself)", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it("nothing else pattern-matches a path into an intent band", () => {
    // The fingerprint both copies shared: a regex listing buying pages. Comments
    // are stripped first — this file and shared/pageIntent.ts both QUOTE the old
    // patterns while explaining them.
    const offenders = files
      .map((f) => ({ rel: f.slice(ROOT.length + 1).split(sep).join("/"), src: stripComments(readFileSync(f, "utf8")) }))
      // The fingerprint is an ALTERNATION of intent words, not the words alone:
      // a bare /case-stud/ matched seedAreDemo's prose ("Clicked the case-study
      // link"), which is a sentence, not a classifier.
      .filter((f) => /\(pricing\|demo\|contact/.test(f.src) || /case-stud\|/.test(f.src))
      .map((f) => f.rel);
    expect(
      offenders,
      offenders.length
        ? `\n\nA second path→intent classifier in:\n  ${offenders.join("\n  ")}\n\n` +
            `Import pageIntent from @shared/pageIntent. Two opinions about what\n` +
            `"/blog/pricing" means is how a blog reader came to interrupt a rep.\n`
        : undefined,
    ).toEqual([]);
  });

  it("both consumers import the shared module", () => {
    for (const rel of ["server/websiteTracking.ts", "server/services/chatPageContext.ts"]) {
      expect(stripComments(read(rel)), rel).toMatch(/from\s*"@shared\/pageIntent"/);
    }
  });

  it("the task trigger still keys on the shared band", () => {
    // The consequence that makes this more than a statistic: a HIGH visit by a
    // known record spawns a task. If that ever reads a locally-computed band
    // again, the drift is back with the same blast radius.
    const src = stripComments(read("server/websiteTracking.ts"));
    expect(src).toMatch(/const intent = pageIntent\(path\)/);
    expect(src).toMatch(/intent === "high" && \(contactId \|\| leadId\)/);
  });
});
