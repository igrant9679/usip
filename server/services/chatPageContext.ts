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

export type PageIntent = "high" | "medium" | "low";

/** Path patterns, highest intent first. Order matters: first match wins. */
const HIGH = /(pricing|demo|contact|book|trial|get-started|quote|consultation|audit)/;
const MEDIUM = /(product|service|feature|solution|case-stud|customer|integration|how-it-works|work)/;
/** Pages that mean the visitor is NOT a buyer — do not sell to these. */
const NON_BUYER = /(careers?|jobs?|hiring|team|about|press|privacy|terms|blog\/|news)/;

export function pageIntent(url: string): PageIntent {
  const path = pathOf(url);
  if (!path) return "low";
  if (NON_BUYER.test(path)) return "low";
  if (HIGH.test(path)) return "high";
  if (MEDIUM.test(path)) return "medium";
  return "low";
}

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
