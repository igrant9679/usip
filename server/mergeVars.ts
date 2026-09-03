/**
 * Merge Variable Resolution (Feature 48)
 *
 * Resolves {{variableName}} placeholders in email subject + body with live
 * contact/account values from the database before SMTP delivery.
 *
 * Supported variables:
 *   Contact:  {{firstName}}, {{lastName}}, {{fullName}}, {{title}}, {{email}},
 *             {{phone}}, {{city}}, {{seniority}}, {{linkedinUrl}}
 *   Account:  {{company}}, {{domain}}, {{industry}}, {{employeeBand}},
 *             {{revenueBand}}, {{region}}
 *   Custom:   {{customField.anyKey}} — reads from contact.customFields JSON
 *   Sender:   {{senderName}}, {{senderEmail}} — from SMTP config
 *             {{bookingLink}} — the sending rep's self-serve booking URL (/b/:slug)
 *   Fallback: {{firstName|Friend}} — use "Friend" if firstName is empty
 *
 * Unknown variables are left as-is so reviewers can spot unresolved tokens.
 */

import { and, eq } from "drizzle-orm";
import { appBaseUrl } from "./appUrl";
import { getDb } from "./db";
import { isActiveMember } from "./_core/activeMembers";
import { contacts, accounts, leads, prospects, bookingLinks, users } from "../drizzle/schema";
import { escapeHtml } from "@shared/escapeHtml";
import { isHtmlBody } from "@shared/emailBody";
import { slugify } from "@shared/slugify";
import { buildMergeLookup, isEmptyLinkToken, normalizeMergeKey, parseMergeToken, resolveMergeName, stripEmptyLinkCarriers } from "@shared/mergeKeys";

export type MergeContext = {
  contact?: {
    firstName?: string | null;
    lastName?: string | null;
    title?: string | null;
    email?: string | null;
    phone?: string | null;
    city?: string | null;
    seniority?: string | null;
    linkedinUrl?: string | null;
    customFields?: Record<string, unknown> | null;
  };
  account?: {
    name?: string | null;
    domain?: string | null;
    industry?: string | null;
    employeeBand?: string | null;
    revenueBand?: string | null;
    region?: string | null;
  };
  sender?: {
    name?: string | null;
    email?: string | null;
    /** The sending rep's public booking URL (…/b/:slug), for {{bookingLink}}. */
    bookingUrl?: string | null;
  };
};

/** App base URL for building public links (booking, tracking). */
// The public origin lives in ONE place now — see server/appUrl.ts for why.
// Imported (not just re-exported) because resolveBookingUrl defaults to it.
export { appBaseUrl };

/**
 * Resolve a rep's self-serve booking URL for {{bookingLink}}, lazily
 * provisioning a link if the rep doesn't have one yet (same get-or-create as the
 * bookingLinks.mine endpoint) so a meeting-ask draft never renders a broken CTA.
 * Returns "" when the link is explicitly deactivated, when the rep is no
 * longer an active member, or on any failure.
 *
 * 🔴 THE MEMBERSHIP CHECK MUST COME BEFORE THE LAZY PROVISION, not after.
 * `{{bookingLink}}` is rendered from a stored author id — `draft.createdByUserId`,
 * `page.createdByUserId` — which may name someone who left months ago. Without
 * this gate the get-or-create branch would MINT A NEW booking link for a
 * non-member and mail a prospect a link to a calendar nobody watches. An empty
 * string is the documented "no link" value and every caller already handles it.
 */
export async function resolveBookingUrl(
  workspaceId: number,
  userId: number | null | undefined,
  baseUrl: string = appBaseUrl(),
): Promise<string> {
  if (!userId || !baseUrl) return "";
  try {
    const db = await getDb();
    if (!db) return "";
    if (!(await isActiveMember(workspaceId, userId))) return "";
    let [link] = await db
      .select({ slug: bookingLinks.slug, active: bookingLinks.active })
      .from(bookingLinks)
      .where(and(eq(bookingLinks.workspaceId, workspaceId), eq(bookingLinks.userId, userId)));
    if (!link) {
      const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
      // Same rule as bookingLinks.ts, which MINTS this slug — an inline copy
      // here meant {{bookingLink}} could resolve to a URL the booking router
      // would never have generated.
      const base = slugify(u?.name ?? `rep-${userId}`) || `rep-${userId}`;
      const slug = `${base}-${userId}`.slice(0, 80);
      await db.insert(bookingLinks).values({ workspaceId, userId, slug, title: "Book a meeting" } as never);
      [link] = await db
        .select({ slug: bookingLinks.slug, active: bookingLinks.active })
        .from(bookingLinks)
        .where(and(eq(bookingLinks.workspaceId, workspaceId), eq(bookingLinks.userId, userId)));
    }
    if (!link || !link.active) return "";
    return `${baseUrl.replace(/\/+$/, "")}/b/${link.slug}`;
  } catch (e) {
    console.error("[mergeVars] resolveBookingUrl failed:", (e as Error).message);
    return "";
  }
}

/**
 * Build a flat key→value map from the merge context.
 * Falls back to empty string for missing values unless a fallback is provided.
 */
function buildVarMap(ctx: MergeContext): Map<string, string> {
  const m = new Map<string, string>();

  const c = ctx.contact ?? {};
  const a = ctx.account ?? {};
  const s = ctx.sender ?? {};

  // Contact fields
  m.set("firstName", c.firstName ?? "");
  m.set("lastName", c.lastName ?? "");
  m.set("fullName", [c.firstName, c.lastName].filter(Boolean).join(" "));
  m.set("title", c.title ?? "");
  m.set("email", c.email ?? "");
  m.set("phone", c.phone ?? "");
  m.set("city", c.city ?? "");
  m.set("seniority", c.seniority ?? "");
  m.set("linkedinUrl", c.linkedinUrl ?? "");

  // Account fields
  m.set("company", a.name ?? "");
  m.set("domain", a.domain ?? "");
  m.set("industry", a.industry ?? "");
  m.set("employeeBand", a.employeeBand ?? "");
  m.set("revenueBand", a.revenueBand ?? "");
  m.set("region", a.region ?? "");

  // Sender fields.
  //
  // A mailbox linked by address (SendGrid domain-authenticated senders, most
  // SMTP mailboxes) carries no fromName, so `s.name` is null and the
  // senderName token rendered as NOTHING — a campaign signature of
  // "Best," / senderName / "CommunityForce" went out as "Best," / blank line /
  // "CommunityForce". Falling back to the address is not a guess:
  // asrar.mehraj@… is that person's own name, written by them, and it beats a
  // hole in the sign-off.
  const senderName = (s.name ?? "").trim() || personNameFromEmailLocal(s.email);
  m.set("senderName", senderName);
  m.set("senderEmail", s.email ?? "");
  // First/last split so a signature can sign off with just the first name.
  const senderParts = senderName.split(/\s+/).filter(Boolean);
  m.set("senderFirstName", senderParts[0] ?? "");
  m.set("senderLastName", senderParts.slice(1).join(" "));
  m.set("bookingLink", s.bookingUrl ?? "");

  // Custom fields: {{customField.key}}
  const custom = c.customFields as Record<string, unknown> | null | undefined;
  if (custom && typeof custom === "object") {
    for (const [key, val] of Object.entries(custom)) {
      m.set(`customField.${key}`, String(val ?? ""));
    }
  }

  return m;
}

/**
 * Replace all {{varName}} and {{varName|fallback}} tokens in a string.
 * - {{firstName}} → resolved value or empty string
 * - {{firstName|Friend}} → resolved value or "Friend" if empty
 * - Unknown variables are left as-is
 *
 * Key matching is @shared/mergeKeys — exact spelling first, then the canonical
 * form. This used to be a bare `varMap.get(varName)`, i.e. case-SENSITIVE with
 * no separator tolerance, while the crm/sequences renderer two directories away
 * resolved `{{FirstName}}` and `{{first_name}}` happily. Same template, two
 * send paths, two different emails — and on this path the loser is a literal
 * `{{first_name}}` in a prospect's inbox.
 */
export function resolveMergeVars(text: string, ctx: MergeContext): string {
  const lookup = buildMergeLookup(buildVarMap(ctx));

  // A dead {{bookingLink}} takes its sentence with it — the same rule areEngine
  // applies, from the same definition, because both paths render this token.
  const carried = stripEmptyLinkCarriers(String(text ?? ""), (tok) => isEmptyLinkToken(tok, lookup));

  return carried.replace(/\{\{([^}]+)\}\}/g, (match, inner: string) => {
    const { name, fallback } = parseMergeToken(inner);
    if (!name) return match;

    const resolved = resolveMergeName(lookup, name);
    if (resolved !== undefined) {
      // Use fallback if resolved value is empty and fallback is provided
      return resolved || fallback || resolved;
    }

    // Unknown variable — leave as-is so reviewers can spot it
    return match;
  });
}

/**
 * Replace `{{merge_field}}` tokens with per-recipient values, from a flat map.
 *
 * The forgiving sibling of `resolveMergeVars`: same matching rule and same
 * leave-unknown-tokens-verbatim policy, but takes the variables directly
 * instead of building them from a MergeContext.
 *
 * ONE copy. crm.ts and sequences.ts each carried a byte-identical private
 * version — the second one's own comment said "same forgiving matcher as
 * crm.ts", which is true right up until someone edits one of them. Neither
 * supported the `{{name|fallback}}` syntax that mergeVars has always
 * documented, so that token reached recipients with its braces intact.
 *
 * Operates on the raw string, so call this BEFORE HTML-wrapping the body.
 */
export function renderMergeFields(
  template: string,
  vars: Record<string, string | null | undefined>,
): string {
  if (!template) return template;
  const lookup = buildMergeLookup(Object.entries(vars));
  // Same rule again. crm.ts and sequences.ts both send through here, and a
  // meeting-ask template is exactly where a {{bookingLink}} CTA lives.
  template = stripEmptyLinkCarriers(template, (tok) => isEmptyLinkToken(tok, lookup));
  // `[^}]` rather than the old `[a-zA-Z0-9_\s]`: the narrow class could not
  // match a `|`, so the fallback form never even entered the replacer.
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, inner: string) => {
    const { name, fallback } = parseMergeToken(inner);
    if (!name) return match;
    const hit = resolveMergeName(lookup, name);
    if (hit === undefined) return match;
    return hit || fallback || hit;
  });
}

/**
 * FINAL egress scrub: no `{{…}}` ever leaves in a template send.
 *
 * The renderers deliberately disagree about unresolved tags — areEngine
 * strips them (autonomous, no reviewer), while resolveMergeVars and
 * renderMergeFields leave them verbatim *so reviewers can spot them* in
 * drafts and previews. That policy is right for editing surfaces and wrong at
 * the wire: the sequences auto-send path proved it by mailing recipients a
 * literal `{{senderCompany}}` when two offered tokens were missing from the
 * merge map, and the same shape resurfaced 2026-08-08 as a `{{company}}` in a
 * stored campaign subject. Renderer policy stays reviewer-friendly; THIS runs
 * at the send boundary, template paths only.
 *
 * ⚠️ Never apply this to human-composed mail (the Rep Mailbox adapter path):
 * a person may legitimately type `{{firstName}}` when discussing a template
 * with a colleague, and silently rewriting a human's words is worse than any
 * stray brace.
 *
 * The tidy-up is deliberately minimal: collapse the doubled space a removed
 * mid-sentence token leaves, and the space a removed token strands before
 * punctuation. Anything smarter is a rewrite of prose nobody reviewed.
 *
 * `removed` reports what was cut so call sites can log it — a fired scrub is
 * an upstream bug (a token offered somewhere but absent from a merge map),
 * and silence here would hide exactly the signal that gets it fixed.
 */
export function scrubUnresolvedMergeTags(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  if (!text || !text.includes("{{")) return { text: text ?? "", removed };
  let out = text.replace(/\{\{([^}]*)\}\}/g, (_m, inner: string) => {
    removed.push(inner.trim());
    return "";
  });
  if (removed.length > 0) {
    out = out
      .replace(/[ \t]{2,}/g, " ")         // "at  ." → "at ."
      .replace(/[ \t]+([,.;:!?])/g, "$1") // "at ." → "at."
      .trim();                            // a removed edge tag strands edge whitespace
  }
  return { text: out, removed };
}

/** scrubUnresolvedMergeTags + the warn every call site would otherwise re-type. */
export function scrubForSend(text: string, where: string): string {
  const { text: out, removed } = scrubUnresolvedMergeTags(text);
  if (removed.length > 0) {
    console.warn(
      `[mergeScrub] ${where}: stripped unresolved merge tag(s) [${removed.join(", ")}] at the send boundary — a token is offered somewhere but missing from this path's merge map`,
    );
  }
  return out;
}

/**
 * Inject a tracking pixel <img> tag and wrap all <a href="..."> links
 * with the click-tracking redirect URL.
 *
 * @param html      The compiled HTML body
 * @param token     The draft's trackingToken
 * @param baseUrl   The public base URL of the app (e.g. https://app.example.com)
 */
export function injectTracking(
  html: string,
  token: string,
  baseUrl: string,
  opts?: { open?: boolean; click?: boolean },
): string {
  const doOpen = opts?.open !== false;
  const doClick = opts?.click !== false;
  if (!doOpen && !doClick) return html;

  // Wrap all <a href="..."> links (skip mailto: and already-tracked links)
  const wrapped = doClick
    ? html.replace(
        /<a\s+([^>]*?)href="(https?:\/\/[^"]+)"([^>]*?)>/gi,
        (_match, before: string, url: string, after: string) => {
          // Don't double-wrap already-tracked links
          if (url.includes("/api/track/click/")) return _match;
          const trackUrl = `${baseUrl}/api/track/click/${encodeURIComponent(token)}?url=${encodeURIComponent(url)}`;
          return `<a ${before}href="${trackUrl}"${after}>`;
        },
      )
    : html;

  if (!doOpen) return wrapped;
  const pixelUrl = `${baseUrl}/api/track/open/${encodeURIComponent(token)}`;
  const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none;border:0;" alt="" />`;

  // Inject pixel just before </body> or at the end
  if (wrapped.includes("</body>")) {
    return wrapped.replace("</body>", `${pixel}</body>`);
  }
  return wrapped + pixel;
}

/**
 * Convert plain-text email body to minimal HTML for tracking injection.
 * Wraps URLs in <a> tags and converts newlines to <br>.
 */
export function textToHtml(text: string): string {
  // Escape HTML special chars first
  const escaped = escapeHtml(text);

  // Render Markdown links [label](url) AND bare URLs in a single pass so a URL
  // inside a Markdown link isn't double-wrapped. The Markdown alternative is
  // tried first and consumes the whole token, so its url can't re-match as bare.
  const linked = escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"]+)/g,
    (_m, label: string, mdUrl: string, bareUrl: string) =>
      mdUrl ? `<a href="${mdUrl}">${label}</a>` : `<a href="${bareUrl}">${bareUrl}</a>`,
  );

  // Wrap in minimal HTML
  return `<!DOCTYPE html><html><body><p>${linked.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p></body></html>`;
}

/**
 * Format-aware version of textToHtml: a rich-editor body is ALREADY an HTML
 * fragment (see shared/emailBody), so it is wrapped in the same document
 * shell UNESCAPED; plain text keeps the textToHtml contract. Callers that
 * also send a text/plain part should pair this with htmlBodyToText.
 *
 * The <body> wrapper matters: injectTracking appends its open pixel before
 * </body>, and the opt-out footer replaces on it too.
 */
export function bodyToHtmlDocument(body: string): string {
  if (isHtmlBody(body)) {
    return `<!DOCTYPE html><html><body>${body}</body></html>`;
  }
  return textToHtml(body);
}

/**
 * Render a sequence opt-out footer (workspace_settings.emailSequenceOptOut*).
 *
 * The message marks its clickable unsubscribe text with `<%link text%>`; the
 * rest is literal. Returns null for a blank message. When `unsubscribeUrl` is
 * given (SMTP send path — a tracking token exists) the bracket becomes a real
 * one-click unsubscribe link; otherwise it falls back to a `mailto:` to
 * `senderEmail`. Produces both a plain-text and an HTML footer.
 */
/**
 * "asrar.mehraj@cforcefederal.com" → "Asrar Mehraj".
 *
 * Only splits on the separators people actually use in a work address, and
 * refuses anything that does not look like a name — a shared mailbox like
 * "info@" or "sales@" must not sign an email "Info".
 */
export function personNameFromEmailLocal(email?: string | null): string {
  const local = String(email ?? "").split("@")[0]?.trim().toLowerCase() ?? "";
  if (!local) return "";
  const GENERIC = /^(info|sales|hello|hi|team|support|contact|admin|help|no-?reply|do-?not-?reply|marketing|billing|careers|jobs|press|office)$/;
  if (GENERIC.test(local)) return "";
  const parts = local.split(/[._-]+/).filter(Boolean)
    // Drop trailing digits people append to disambiguate ("jsmith2").
    .map((w) => w.replace(/\d+$/, ""))
    .filter((w) => w.length > 1);
  if (parts.length === 0) return "";
  return parts.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

/**
 * The name a mailbox signs with and shows as. In order: the explicit display
 * name; the account's own label when it is more than the address; then a name
 * read off the address itself ("asrar.mehraj@…" → "Asrar Mehraj"). Empty only
 * for a shared inbox ("info@") with nothing configured.
 *
 * Owner report 2026-09-03, two screenshots: the four CommunityForce SendGrid
 * senders were linked by address (fromName NULL, name = the address), so
 * every campaign email arrived From a bare address and signed off
 * "Best," / blank line / "CommunityForce". ONE rule here, used by the From
 * header AND the {{senderName}} merge, so the two can never disagree.
 */
export function senderDisplayName(a: { fromName?: string | null; name?: string | null; fromEmail?: string | null }): string {
  const explicit = (a.fromName ?? "").trim();
  if (explicit) return explicit;
  const email = (a.fromEmail ?? "").trim();
  const label = (a.name ?? "").trim();
  if (label && !label.includes("@") && label.toLowerCase() !== email.toLowerCase()) return label;
  return personNameFromEmailLocal(email);
}

/** Sender-side tokens: resolvable only once the sending mailbox is known. */
export const SENDER_TOKENS = ["senderName", "senderFirstName", "senderLastName", "senderEmail"] as const;

export function isDeferredSenderToken(name: string): boolean {
  const n = normalizeMergeKey(name);
  return SENDER_TOKENS.some((t) => normalizeMergeKey(t) === n);
}

/**
 * Fill the sender tokens against the mailbox that is about to send. Runs at
 * the send boundary (emailDelivery), AFTER the pool has picked the account:
 * the ARE engine substitutes prospect fields at dispatch time but cannot know
 * which mailbox the pool will choose, so it leaves these four verbatim and
 * this fills them. Every other token is left alone for the scrub to judge.
 */
export function resolveSenderTokens(
  text: string,
  a: { fromName?: string | null; name?: string | null; fromEmail?: string | null },
): string {
  const name = senderDisplayName(a);
  const parts = name.split(/\s+/).filter(Boolean);
  const lookup = buildMergeLookup([
    ["senderName", name],
    ["senderFirstName", parts[0] ?? ""],
    ["senderLastName", parts.slice(1).join(" ")],
    ["senderEmail", (a.fromEmail ?? "").trim()],
  ]);
  return String(text ?? "").replace(/\{\{([^}]+)\}\}/g, (match, inner: string) => {
    const { name: key, fallback } = parseMergeToken(inner);
    if (!key || !isDeferredSenderToken(key)) return match;
    const hit = resolveMergeName(lookup, key) ?? "";
    return hit || fallback || "";
  });
}

export function renderSequenceOptOut(
  message: string | null | undefined,
  opts: { unsubscribeUrl?: string; senderEmail?: string },
): { text: string; html: string } | null {
  const raw = (message ?? "").trim();
  if (!raw) return null;
  const href = opts.unsubscribeUrl
    ? opts.unsubscribeUrl
    : opts.senderEmail
      ? `mailto:${opts.senderEmail}?subject=Unsubscribe`
      : null;

  const esc = escapeHtml; // one escaper — @shared/escapeHtml
  const marker = /<%\s*([\s\S]*?)\s*%>/;

  // Plain text: drop the <% %> markers, keep the label; append the URL when it
  // is an http(s) link (a mailto reads fine inline without repeating it).
  const stripped = raw.replace(new RegExp(marker, "g"), (_m, l: string) => (l ?? "").trim());
  const text = href && href.startsWith("http") ? `${stripped} ( ${href} )` : stripped;

  // HTML: escape the literal parts and inject a real <a> for the bracket.
  let htmlInner: string;
  const m = raw.match(/^([\s\S]*?)<%\s*([\s\S]*?)\s*%>([\s\S]*)$/);
  if (href && m) {
    htmlInner = `${esc(m[1])}<a href="${href}">${esc(m[2].trim())}</a>${esc(m[3])}`;
  } else if (href) {
    htmlInner = `${esc(stripped)} <a href="${href}">unsubscribe</a>`;
  } else {
    htmlInner = esc(stripped);
  }
  const html = `<p style="margin-top:16px;font-size:12px;color:#888">${htmlInner.replace(/\n/g, "<br>")}</p>`;
  return { text, html };
}

/**
 * Load recipient data from DB and build a MergeContext.
 *
 * Accepts either a bare contactId (legacy signature) or an object with any
 * of { contactId, leadId, prospectId } — drafts created by the sequence
 * engine target leads/prospects with NO contact row, and previously got an
 * empty context (so every {{tag}} reached the recipient unresolved).
 * Resolution priority: contact → lead → prospect.
 */
export async function buildMergeContextFromDb(
  ref:
    | number
    | null
    | undefined
    | { contactId?: number | null; leadId?: number | null; prospectId?: number | null },
): Promise<MergeContext> {
  const ids = typeof ref === "number" ? { contactId: ref } : (ref ?? {});
  const db = await getDb();
  if (!db) return {};

  if (!ids.contactId) {
    // Lead recipient: leads carry their own name/company columns (no account row).
    if (ids.leadId) {
      const [lead] = await db.select().from(leads).where(eq(leads.id, ids.leadId)).limit(1);
      if (lead) {
        return {
          contact: {
            firstName: lead.firstName,
            lastName: lead.lastName,
            title: lead.title,
            email: lead.email,
            phone: lead.phone,
          },
          account: lead.company ? { name: lead.company } : undefined,
        };
      }
    }
    // Prospect recipient: prospects carry name/company/domain/industry columns.
    if (ids.prospectId) {
      const [p] = await db.select().from(prospects).where(eq(prospects.id, ids.prospectId)).limit(1);
      if (p) {
        return {
          contact: {
            firstName: p.firstName,
            lastName: p.lastName,
            title: p.title,
            email: p.email,
            phone: p.phone,
            city: p.city,
            linkedinUrl: p.linkedinUrl,
          },
          account: p.company || p.companyDomain
            ? { name: p.company, domain: p.companyDomain, industry: p.industry }
            : undefined,
        };
      }
    }
    return {};
  }

  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, ids.contactId))
    .limit(1);

  if (!contact) return {};

  let account: typeof accounts.$inferSelect | undefined;
  if (contact.accountId) {
    const [acc] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, contact.accountId))
      .limit(1);
    account = acc;
  }

  return {
    contact: {
      firstName: contact.firstName,
      lastName: contact.lastName,
      title: contact.title,
      email: contact.email,
      phone: contact.phone,
      city: contact.city,
      seniority: contact.seniority,
      linkedinUrl: contact.linkedinUrl,
      customFields: contact.customFields as Record<string, unknown> | null,
    },
    account: account
      ? {
          name: account.name,
          domain: account.domain,
          industry: account.industry,
          employeeBand: account.employeeBand,
          revenueBand: account.revenueBand,
          region: account.region,
        }
      : undefined,
  };
}
