/**
 * What the page a visitor is standing on tells us before they type anything.
 *
 * The agent used to open with the same line whether someone was on the pricing
 * page or the careers page. The URL is the strongest intent signal available at
 * turn zero and it costs nothing to collect, so it is worth reading properly.
 *
 * Deliberately mirrors `classifyIntent` in websiteTracking.ts — the same paths
 * mean the same thing to a chat agent as they do to visitor tracking, and two
 * different opinions about what "/pricing" means would be a bug waiting to
 * happen. Kept as its own pure module because the chat needs a SENTENCE for a
 * prompt, not just a band.
 */

/**
 * The classifier moved to @shared/pageIntent — websiteTracking.ts had its own
 * copy, this file's header claimed the two "deliberately mirror" each other, and
 * they had drifted: tracking knew nothing of NON_BUYER, so `/blog/pricing-x`
 * scored HIGH there and spawned a follow-up task for a rep. Re-exported because
 * chatAgent.ts and the tests reach for these through this module.
 */
import { isNonBuyerPage, pageIntent, pathOf } from "@shared/pageIntent";
export { pageIntent, pathOf, isNonBuyerPage };
export type { PageIntent } from "@shared/pageIntent";

export interface PageContext {
  pageUrl?: string | null;
  pageTitle?: string | null;
  referrer?: string | null;
}

/**
 * One paragraph for the prompt, or "" when we know nothing.
 *
 * Explicitly tells the model what NOT to do on a careers/about page. A visitor
 * reading the jobs page being pitched an audit is the most obviously wrong thing
 * this feature could cause, and the persona's "be warm and brief with job
 * seekers" rule only fires AFTER they say so.
 */
export function describePageContext(ctx: PageContext): string {
  const url = String(ctx.pageUrl ?? "").trim();
  const title = String(ctx.pageTitle ?? "").trim();
  const ref = String(ctx.referrer ?? "").trim();
  if (!url && !title) return "";

  const lines: string[] = [];
  lines.push(`The visitor opened this chat on: ${title || url}${title && url ? ` (${url})` : ""}`);
  if (ref) lines.push(`They arrived from: ${ref}`);

  const intent = pageIntent(url);
  if (isNonBuyerPage(url)) {
    lines.push(
      "This page suggests they are NOT here to buy — they may be a job seeker, a supplier or simply reading about us. Be helpful and brief, and do NOT push for a meeting unless they ask for one.",
    );
  } else if (intent === "high") {
    lines.push(
      "This page suggests real buying intent. Open by referencing what that page is about rather than asking a generic opening question.",
    );
  } else if (intent === "medium") {
    lines.push("This page suggests they are researching. Reference it naturally if it helps.");
  }
  return lines.join("\n");
}
