/**
 * visitorLinks.ts — a signed visitor id on links to the workspace's own site
 * (audit 2026-10-20, P5, P88, F40).
 *
 * The website beacon can name the person a visit belongs to when the page's
 * link carries `vid`, and only an id Velocity SIGNED (signVisitorId) is
 * believed: it files the high-intent task and shows as a verified visit.
 * Nothing added one to outgoing mail, so in practice no visit was ever
 * identified. Outreach now adds it, automatically, to every link that points
 * at the workspace's own tracked site(s):
 *
 *   · the site: the host of the company website (Settings → Branding) plus
 *     any listed under Website visitors → tracked sites, and their subdomains;
 *   · never a third-party link, a mailto:, our own app's links (unsubscribe,
 *     portal, tracking redirects), or a link already wrapped for click tracking;
 *   · only while the workspace's click tracking is on: it is click
 *     attribution by another name, and that switch is how a workspace says no.
 *
 * The id names the record the email went to — a People row ("p"), contact
 * ("c") or lead ("l") — signed for this workspace, so it means nothing in
 * another and cannot be forged by walking ids.
 */
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { appBaseUrl } from "../appUrl";
import { signVisitorId } from "../websiteTracking";

/** A host from a URL, a bare domain or "www.x.com/path", lower-cased, without www. */
export function siteHost(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  const host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/** The workspace's tracked hosts: the company website and any listed, once each. */
export function trackedHostsFrom(companyWebsite: string | null | undefined, listed: string | null | undefined): string[] {
  const out: string[] = [];
  for (const v of [companyWebsite, ...String(listed ?? "").split(/[\s,;]+/)]) {
    const h = siteHost(v);
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

function isTrackedUrl(url: URL, hosts: string[], appHost: string | null): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (appHost && (host === appHost || host.endsWith(`.${appHost}`))) return false;
  if (url.pathname.includes("/api/track/")) return false;
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** One URL with `vid` set (replacing any vid/vlid already there), or null to leave it alone. */
function withVid(raw: string, hosts: string[], vid: string, appHost: string | null): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (!isTrackedUrl(url, hosts, appHost)) return null;
  url.searchParams.delete("vlid");
  url.searchParams.set("vid", vid);
  return url.toString();
}

/**
 * Add `vid` to every link to a tracked host in an email's HTML and text parts.
 * HTML: href attributes (single or double quoted, &amp; understood). Text: bare
 * http(s) URLs. Everything else is left byte for byte.
 */
export function decorateVisitorLinks(
  parts: { html: string; text: string },
  opts: { hosts: string[]; vid: string; appHost?: string | null },
): { html: string; text: string; changed: number } {
  const appHost = opts.appHost === undefined ? siteHost(safeAppBase()) : opts.appHost;
  if (!opts.hosts.length || !opts.vid) return { ...parts, changed: 0 };
  let changed = 0;
  const html = parts.html.replace(/(\bhref\s*=\s*)(["'])(https?:\/\/[^"'\s>]+)\2/gi, (m, pre: string, q: string, url: string) => {
    const next = withVid(url.replace(/&amp;/g, "&"), opts.hosts, opts.vid, appHost);
    if (!next) return m;
    changed++;
    return `${pre}${q}${next.replace(/&/g, "&amp;")}${q}`;
  });
  const text = parts.text.replace(/https?:\/\/[^\s<>"')\]]+/gi, (url) => {
    // A trailing full stop or comma belongs to the sentence, not the link.
    const tail = /[.,;:!?]+$/.exec(url)?.[0] ?? "";
    const core = tail ? url.slice(0, -tail.length) : url;
    const next = withVid(core, opts.hosts, opts.vid, appHost);
    if (!next) return url;
    changed++;
    return next + tail;
  });
  return { html, text, changed };
}

function safeAppBase(): string | null {
  try { return appBaseUrl(); } catch { return null; }
}

/** Which record a send went to, as the beacon's id kinds. */
export type VisitorTarget = { prospectId?: number | null; contactId?: number | null; leadId?: number | null };

/** The signed id for the record an email went to: the People row first, then the contact, then the lead. */
export function visitorIdFor(workspaceId: number, who: VisitorTarget): string | null {
  if (who.prospectId) return signVisitorId(workspaceId, "p", who.prospectId);
  if (who.contactId) return signVisitorId(workspaceId, "c", who.contactId);
  if (who.leadId) return signVisitorId(workspaceId, "l", who.leadId);
  return null;
}

/**
 * Decorate an outgoing email for this workspace and recipient, or return it
 * unchanged: when click tracking is off, no tracked site is known, or the
 * recipient is no record. Never throws: a failed settings read sends the
 * email as written.
 */
export async function addVisitorIdsToEmail(
  workspaceId: number,
  who: VisitorTarget,
  parts: { html: string; text: string },
  known?: { emailClickTracking?: boolean | null; companyWebsite?: string | null; trackedSiteDomains?: string | null },
): Promise<{ html: string; text: string; changed: number }> {
  try {
    const vid = visitorIdFor(workspaceId, who);
    if (!vid) return { ...parts, changed: 0 };
    let s = known;
    if (!s || s.companyWebsite === undefined || s.trackedSiteDomains === undefined || s.emailClickTracking === undefined) {
      const db = await getDb();
      if (!db) return { ...parts, changed: 0 };
      const [row] = await db
        .select({ emailClickTracking: workspaceSettings.emailClickTracking, companyWebsite: workspaceSettings.companyWebsite, trackedSiteDomains: workspaceSettings.trackedSiteDomains })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, workspaceId))
        .limit(1);
      s = row ?? {};
    }
    if (s.emailClickTracking === false) return { ...parts, changed: 0 };
    const hosts = trackedHostsFrom(s.companyWebsite, s.trackedSiteDomains);
    return decorateVisitorLinks(parts, { hosts, vid });
  } catch (e) {
    console.warn("[visitorLinks] left the links as written:", (e as Error)?.message ?? e);
    return { ...parts, changed: 0 };
  }
}
