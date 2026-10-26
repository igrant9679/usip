/**
 * suppression.ts — THE suppression check, for every engine and every channel.
 *
 * 🔴 THE BUG (audit 2026-10-20, A8). There are two lists, and each path read
 * a different slice of them:
 *
 *   email_suppressions      unsubscribes, bounces, spam complaints, manual —
 *                           keyed by email address
 *   are_suppression_list    the Revenue Engine's do-not-contact list — an
 *                           email, a LinkedIn profile URL OR a company domain
 *
 * The sequence engine and the draft senders read only the first. ARE's
 * enrolment read only the second, LinkedIn steps read neither, and nothing
 * anywhere read the LinkedIn-URL or domain columns — so "never contact anyone
 * at acme.com" and "never contact this LinkedIn profile" were rows that
 * stopped nobody.
 *
 * Now there is one question, asked the same way at discovery, enrolment and
 * every dispatch: is this PERSON suppressed for this CHANNEL?
 *
 * Channels. A bounce says an address does not work, not that the person asked
 * to be left alone, so a bounce stops email only. Everything else —
 * unsubscribe, spam complaint, manual, do-not-contact, competitor, existing
 * customer — is the person (or the workspace) saying no, and stops every
 * channel: someone who unsubscribed from a sales email should not get the
 * LinkedIn DM instead.
 *
 * Matching. Addresses compare trimmed and lower-cased (normalizeSuppressionEmail).
 * LinkedIn URLs compare by profile path ("in/jane-doe"), domains by bare host
 * ("acme.com"), and a person's company domain is their email's domain unless
 * they carry one. New rows are written normalised (normaliseAreSuppression);
 * older rows were stored as typed, so the read also matches the common
 * spellings of the same URL or domain.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { areSuppressionList, emailSuppressions } from "../../drizzle/schema";
import { getDb } from "../db";
import { normalizeSuppressionEmail } from "../unsubscribe";

export type SuppressionChannel = "email" | "linkedin" | "any";

export type SuppressionHit = {
  list: "email_suppressions" | "are_suppression_list";
  matched: "email" | "linkedin" | "domain";
  reason: string;
};

export type SuppressionTarget = {
  email?: string | null;
  linkedinUrl?: string | null;
  companyDomain?: string | null;
};

/** "https://www.linkedin.com/in/Jane-Doe/?trk=x" → "in/jane-doe"; a bare slug → "in/<slug>". */
export function normalizeLinkedinUrl(url: string | null | undefined): string | null {
  const raw = (url ?? "").trim().toLowerCase();
  if (!raw) return null;
  const m = raw.match(/linkedin\.com\/(.+)$/);
  let path = m
    ? m[1]
    : /^(in|pub|company|sales)\//.test(raw)
      ? raw
      : raw.includes("/") || raw.includes(".") ? "" : `in/${raw}`;
  path = path.split(/[?#]/)[0].replace(/\/+$/, "");
  return path || null;
}

/** "https://www.Acme.com/about" → "acme.com". */
export function normalizeDomain(domain: string | null | undefined): string | null {
  const raw = (domain ?? "").trim().toLowerCase();
  if (!raw) return null;
  const host = raw.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/^www\./, "");
  return host.includes(".") ? host : null;
}

export function emailDomain(email: string | null | undefined): string | null {
  const e = normalizeSuppressionEmail(email);
  const at = e.lastIndexOf("@");
  return at > 0 ? normalizeDomain(e.slice(at + 1)) : null;
}

/** Every common spelling of one LinkedIn profile URL, for matching rows stored as typed. */
export function linkedinUrlVariants(url: string): string[] {
  const key = normalizeLinkedinUrl(url);
  return key ? linkedinVariants(key, url) : [];
}

/** The ways an older, un-normalised row may have stored the same profile. */
function linkedinVariants(key: string, raw: string): string[] {
  const out = new Set<string>([raw.trim()]);
  for (const scheme of ["https://www.", "http://www.", "https://", "http://", "www.", ""]) {
    out.add(`${scheme}linkedin.com/${key}`);
    out.add(`${scheme}linkedin.com/${key}/`);
  }
  return Array.from(out).filter(Boolean);
}

function domainVariants(host: string): string[] {
  const out = new Set<string>();
  for (const scheme of ["", "http://", "https://"]) {
    for (const www of ["", "www."]) {
      out.add(`${scheme}${www}${host}`);
      out.add(`${scheme}${www}${host}/`);
    }
  }
  return Array.from(out);
}

/** A row about to be written to are_suppression_list, in the form the read matches. */
export function normaliseAreSuppression<T extends SuppressionTarget>(row: T): T {
  const email = normalizeSuppressionEmail(row.email);
  const li = normalizeLinkedinUrl(row.linkedinUrl);
  const domain = normalizeDomain(row.companyDomain);
  return {
    ...row,
    email: email || null,
    linkedinUrl: li ? `https://www.linkedin.com/${li}` : null,
    companyDomain: domain,
  };
}

/** Bounces stop email only; every other reason stops every channel. */
function stops(reason: string, channel: SuppressionChannel): boolean {
  return channel === "email" || reason !== "bounce";
}

/**
 * The first suppression that stops contacting this person on this channel, or
 * null. Throws if the database is unreachable: a sender that cannot ask must
 * not assume the answer is no.
 */
export async function findSuppression(
  workspaceId: number,
  target: SuppressionTarget,
  channel: SuppressionChannel,
): Promise<SuppressionHit | null> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable — suppression could not be checked");

  const email = normalizeSuppressionEmail(target.email);
  const liKey = normalizeLinkedinUrl(target.linkedinUrl);
  const domain = normalizeDomain(target.companyDomain) ?? emailDomain(email);

  if (email) {
    const rows = await db
      .select({ reason: emailSuppressions.reason })
      .from(emailSuppressions)
      .where(and(eq(emailSuppressions.workspaceId, workspaceId), eq(emailSuppressions.email, email)));
    const hit = rows.find((r) => stops(String(r.reason), channel));
    if (hit) return { list: "email_suppressions", matched: "email", reason: String(hit.reason) };
  }

  const any = [];
  if (email) any.push(eq(areSuppressionList.email, email));
  if (liKey) any.push(inArray(areSuppressionList.linkedinUrl, linkedinVariants(liKey, target.linkedinUrl ?? "")));
  if (domain) any.push(inArray(areSuppressionList.companyDomain, domainVariants(domain)));
  if (any.length === 0) return null;
  const rows = await db
    .select({
      email: areSuppressionList.email,
      linkedinUrl: areSuppressionList.linkedinUrl,
      companyDomain: areSuppressionList.companyDomain,
      reason: areSuppressionList.reason,
    })
    .from(areSuppressionList)
    .where(and(eq(areSuppressionList.workspaceId, workspaceId), any.length === 1 ? any[0] : or(...any)));
  for (const r of rows) {
    if (!stops(String(r.reason), channel)) continue;
    const reason = String(r.reason);
    if (email && normalizeSuppressionEmail(r.email) === email) return { list: "are_suppression_list", matched: "email", reason };
    if (liKey && normalizeLinkedinUrl(r.linkedinUrl) === liKey) return { list: "are_suppression_list", matched: "linkedin", reason };
    if (domain && normalizeDomain(r.companyDomain) === domain) return { list: "are_suppression_list", matched: "domain", reason };
  }
  return null;
}

export async function isPersonSuppressed(
  workspaceId: number,
  target: SuppressionTarget,
  channel: SuppressionChannel,
): Promise<boolean> {
  return (await findSuppression(workspaceId, target, channel)) !== null;
}

/** For logs and skip reasons. */
export function describeSuppression(hit: SuppressionHit): string {
  const what = hit.matched === "email" ? "address" : hit.matched === "linkedin" ? "LinkedIn profile" : "company domain";
  const list = hit.list === "email_suppressions" ? "email suppression list" : "do-not-contact list";
  return `${what} is on the ${list} (${hit.reason})`;
}
