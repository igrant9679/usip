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
 *   Fallback: {{firstName|Friend}} — use "Friend" if firstName is empty
 *
 * Unknown variables are left as-is so reviewers can spot unresolved tokens.
 */

import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { contacts, accounts } from "../drizzle/schema";

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
  };
};

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

  // Sender fields
  m.set("senderName", s.name ?? "");
  m.set("senderEmail", s.email ?? "");

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
 */
export function resolveMergeVars(text: string, ctx: MergeContext): string {
  const varMap = buildVarMap(ctx);

  return text.replace(/\{\{([^}]+)\}\}/g, (match, inner: string) => {
    const [varName, fallback] = inner.split("|").map((s) => s.trim());
    if (!varName) return match;

    const resolved = varMap.get(varName);
    if (resolved !== undefined) {
      // Use fallback if resolved value is empty and fallback is provided
      return resolved || fallback || resolved;
    }

    // Unknown variable — leave as-is so reviewers can spot it
    return match;
  });
}

/**
 * Inject a tracking pixel <img> tag and wrap all <a href="..."> links
 * with the click-tracking redirect URL.
 *
 * @param html      The compiled HTML body
 * @param token     The draft's trackingToken
 * @param baseUrl   The public base URL of the app (e.g. https://app.example.com)
 */
export function injectTracking(html: string, token: string, baseUrl: string): string {
  const pixelUrl = `${baseUrl}/api/track/open/${encodeURIComponent(token)}`;
  const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none;border:0;" alt="" />`;

  // Wrap all <a href="..."> links (skip mailto: and already-tracked links)
  const wrapped = html.replace(
    /<a\s+([^>]*?)href="(https?:\/\/[^"]+)"([^>]*?)>/gi,
    (_match, before: string, url: string, after: string) => {
      // Don't double-wrap already-tracked links
      if (url.includes("/api/track/click/")) return _match;
      const trackUrl = `${baseUrl}/api/track/click/${encodeURIComponent(token)}?url=${encodeURIComponent(url)}`;
      return `<a ${before}href="${trackUrl}"${after}>`;
    },
  );

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
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  // Linkify URLs
  const linked = escaped.replace(
    /(https?:\/\/[^\s<>"]+)/g,
    '<a href="$1">$1</a>',
  );

  // Wrap in minimal HTML
  return `<!DOCTYPE html><html><body><p>${linked.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p></body></html>`;
}

/**
 * Load contact + account data from DB and build a MergeContext.
 */
export async function buildMergeContextFromDb(
  contactId: number | null | undefined,
): Promise<MergeContext> {
  if (!contactId) return {};

  const db = await getDb();
  if (!db) return {};

  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, contactId))
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
