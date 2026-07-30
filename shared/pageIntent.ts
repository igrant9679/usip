/**
 * pageIntent.ts — the ONE reading of what a URL says about a visitor.
 *
 * There were two, and a comment in one of them asserting they agreed:
 * `chatPageContext.ts` said it "deliberately mirrors `classifyIntent` in
 * websiteTracking.ts — the same paths mean the same thing to a chat agent as
 * they do to visitor tracking, and two different opinions about what '/pricing'
 * means would be a bug waiting to happen." They had already drifted apart:
 *
 * | Band      | websiteTracking had            | chatPageContext had                          |
 * |-----------|--------------------------------|----------------------------------------------|
 * | high      | …buy, checkout                 | …quote, consultation, audit                  |
 * | medium    | features, solutions, customers | + service, how-it-works, work (and singulars)|
 * | non-buyer | **no such concept**            | careers, jobs, hiring, team, about, blog/, … |
 *
 * The missing NON_BUYER band is the one that mattered, because website tracking
 * does not merely record a band — `intent === "high"` on a KNOWN contact or lead
 * spawns a follow-up task for the record owner:
 *
 *   • `/blog/pricing-strategy`      → tracking: HIGH   → a rep is told a prospect
 *                                     is on a buying page. They read a blog post.
 *   • `/careers/product-manager`    → tracking: MEDIUM → a job applicant scored as
 *                                     a shopper.
 *   • `/jobs/solutions-engineer`    → tracking: MEDIUM, for the same reason.
 *
 * The chat side had already worked out that those pages mean "not a buyer" and
 * written the rule down; the tracking side never received it. That is the
 * mirror-test class exactly: an invariant that lives in prose, with nothing
 * binding either copy to the other.
 *
 * Rule going forward: this file is the only place a path becomes an intent.
 * `chatPageContext` still owns turning a band into a SENTENCE for a prompt —
 * that part is genuinely chat-specific.
 */

export type PageIntent = "high" | "medium" | "low";

/**
 * Path patterns, checked NON_BUYER first — the order is the point. A visitor on
 * `/careers/product-manager` matches MEDIUM's "product" and HIGH's rules can
 * match a blog post about pricing; whichever band those would land in, the page
 * still says "not shopping".
 *
 * The union of what the two copies had. Broadening MEDIUM is cheap (it only
 * changes a statistic), broadening HIGH adds task triggers and was done only for
 * paths that are unambiguously buying intent for this product — quote,
 * consultation and audit are the front door here, the same way checkout is
 * elsewhere.
 */
export const HIGH_INTENT =
  /(pricing|demo|contact|book|trial|get-started|buy|checkout|quote|consultation|audit)/;
export const MEDIUM_INTENT =
  /(product|service|feature|solution|case-stud|customer|integration|how-it-works|work)/;
/** Pages that mean the visitor is NOT a buyer — never sell to these. */
export const NON_BUYER = /(careers?|jobs?|hiring|team|about|press|privacy|terms|blog\/|news)/;

/** Lowercased path + query of a URL, or "" if it cannot be parsed. */
export function pathOf(url: string): string {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw, "https://placeholder.invalid");
    return `${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/** True when the visitor is on a page that says "not a customer". */
export function isNonBuyerPage(url: string): boolean {
  const path = pathOf(url);
  return !!path && NON_BUYER.test(path);
}

export function pageIntent(url: string): PageIntent {
  const path = pathOf(url);
  if (!path) return "low";
  if (NON_BUYER.test(path)) return "low";
  if (HIGH_INTENT.test(path)) return "high";
  if (MEDIUM_INTENT.test(path)) return "medium";
  return "low";
}
