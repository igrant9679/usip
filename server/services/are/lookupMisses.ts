/**
 * A remembered "no result" from a paid email lookup (audit 2026-10-20, A75:
 * "no vendor miss cache").
 *
 * The enrich agent (routers/are/prospects.ts, runEnrichAgent) asks QuickEnrich
 * for a LinkedIn profile's address and then runs the finder — a Reoon quick
 * check on every name pattern and a power check on each survivor — for a name
 * at a domain. Nothing remembered a lookup that came back empty, so enriching
 * the same person again (a person's Enrich click, a retry, the same person in
 * a later campaign) paid for the same empty answer again. A definitive miss is
 * now kept for LOOKUP_MISS_TTL_DAYS and the lookup is skipped until then;
 * a transport failure (timeout, HTTP error) is never kept, since it says
 * nothing about the person.
 */
import { and, eq, gt, inArray } from "drizzle-orm";
import { vendorLookupMisses } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractLinkedInIdentifier } from "../linkedinLookup";
import { canonicalText } from "@shared/canonicalText";

/** As long as the company-site scrape is cached (services/scraper/domainCache.ts). */
export const LOOKUP_MISS_TTL_DAYS = 30;

/** QuickEnrich's LinkedIn lookup, keyed on the profile slug (URL-shape tolerant). */
export function quickenrichMissKey(linkedinUrl: unknown): string | null {
  const url = String(linkedinUrl ?? "").trim().toLowerCase();
  if (!url) return null;
  const slug = extractLinkedInIdentifier(url);
  return slug ? `qe:li:${slug}`.slice(0, 400) : null;
}

/** The pattern finder, keyed on name and domain. */
export function finderMissKey(firstName: unknown, lastName: unknown, domain: unknown): string | null {
  const first = canonicalText(firstName);
  const last = canonicalText(lastName);
  const d = String(domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!first || !last || !d) return null;
  return `finder:${first}|${last}|${d}`.slice(0, 400);
}

/** The finder's answers that are about the person, not about the moment. */
export function isDefinitiveFinderMiss(reason: string | undefined | null): boolean {
  const r = String(reason ?? "");
  return r === "no_valid_pattern" || r === "no_patterns" || r.startsWith("no_mx");
}

/** When each of `keys` last missed, within the TTL. */
export async function recentMisses(workspaceId: number, keys: Array<string | null>, now: Date = new Date()): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const ks = keys.filter((k): k is string => !!k);
  const db = await getDb();
  if (!db || ks.length === 0) return out;
  const since = new Date(now.getTime() - LOOKUP_MISS_TTL_DAYS * 86_400_000);
  const rows = await db.select({ lookupKey: vendorLookupMisses.lookupKey, missedAt: vendorLookupMisses.missedAt })
    .from(vendorLookupMisses)
    .where(and(eq(vendorLookupMisses.workspaceId, workspaceId), inArray(vendorLookupMisses.lookupKey, ks), gt(vendorLookupMisses.missedAt, since)));
  for (const r of rows) out.set(r.lookupKey, new Date(r.missedAt));
  return out;
}

/** Remember a miss (or refresh one). Best-effort: a failed write costs a lookup later, nothing more. */
export async function recordMiss(workspaceId: number, key: string | null, reason: string, now: Date = new Date()): Promise<void> {
  if (!key) return;
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(vendorLookupMisses)
      .values({ workspaceId, lookupKey: key, reason: reason.slice(0, 64), missedAt: now })
      .onDuplicateKeyUpdate({ set: { reason: reason.slice(0, 64), missedAt: now } });
  } catch (e) {
    console.error("[lookupMisses] could not record a miss:", (e as Error)?.message ?? e);
  }
}
