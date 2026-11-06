/**
 * CompanyProfileService — reads that back the company profile page: the account
 * with resolved logo + contact count + score, its linked people (prospects and
 * contacts), activity timeline, enrichment history, technologies and funding.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db";
import {
  accounts, contacts, prospects, contactAccountLinks, activities,
  organizationEnrichmentEvents,
  scoreResults, priorityScoreResults,
} from "../../../drizzle/schema";
import { resolveCompanyLogo, faviconUrlForDomain } from "./logoService";

/**
 * How many people each company has: the distinct prospects and contacts linked
 * to it whose rows still exist, which is what the People section lists.
 *
 * The one count (audit 2026-10-20, R65). The header counted current links, the
 * list every link, the merge dialog the legacy contacts.accountId column and
 * the People section the rows it could read, so one company showed four
 * numbers. A person linked twice, or a link to a deleted person, counted in
 * some and not others.
 */
export async function linkedPeopleCounts(ws: number, accountIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const db = await getDb();
  if (!db || accountIds.length === 0) return out;
  const links = await db
    .select({ accountId: contactAccountLinks.accountId, personType: contactAccountLinks.personType, personId: contactAccountLinks.personId })
    .from(contactAccountLinks)
    .where(and(eq(contactAccountLinks.workspaceId, ws), inArray(contactAccountLinks.accountId, accountIds)));
  const idsOf = (type: string) => Array.from(new Set(links.filter((l) => l.personType === type).map((l) => l.personId)));
  const prospectIds = idsOf("prospect");
  const contactIds = idsOf("contact");
  const [ps, cs] = await Promise.all([
    prospectIds.length ? db.select({ id: prospects.id }).from(prospects).where(and(eq(prospects.workspaceId, ws), inArray(prospects.id, prospectIds))) : [],
    contactIds.length ? db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.workspaceId, ws), inArray(contacts.id, contactIds))) : [],
  ]);
  const live = new Set([...ps.map((p) => `prospect:${p.id}`), ...cs.map((c) => `contact:${c.id}`)]);
  const seen = new Map<number, Set<string>>();
  for (const l of links) {
    const key = `${l.personType}:${l.personId}`;
    if (!live.has(key)) continue;
    if (!seen.has(l.accountId)) seen.set(l.accountId, new Set());
    seen.get(l.accountId)!.add(key);
  }
  for (const [accountId, people] of Array.from(seen.entries())) out.set(accountId, people.size);
  return out;
}

export async function contactCountForAccount(ws: number, accountId: number): Promise<number> {
  return (await linkedPeopleCounts(ws, [accountId])).get(accountId) ?? 0;
}

export async function getCompanyProfile(ws: number, accountId: number) {
  const db = await getDb();
  if (!db) return null;
  const [account] = await db.select().from(accounts).where(and(eq(accounts.workspaceId, ws), eq(accounts.id, accountId))).limit(1);
  if (!account) return null;
  const logo = resolveCompanyLogo(account);
  const contactCount = await contactCountForAccount(ws, accountId);
  const score = await getCompanyScore(ws, accountId);
  return {
    ...account,
    logo: { url: logo.url, faviconUrl: faviconUrlForDomain(account.normalizedDomain || account.domain), sourceType: logo.sourceType, status: logo.status },
    contactCount,
    score,
  };
}

/** Linked people (prospects + contacts) for a company. */
export async function getCompanyContacts(ws: number, accountId: number) {
  const db = await getDb();
  if (!db) return [];
  const links = await db.select().from(contactAccountLinks)
    .where(and(eq(contactAccountLinks.workspaceId, ws), eq(contactAccountLinks.accountId, accountId)));
  const prospectIds = links.filter((l) => l.personType === "prospect").map((l) => l.personId);
  const contactIds = links.filter((l) => l.personType === "contact").map((l) => l.personId);
  const out: Array<Record<string, unknown>> = [];
  if (prospectIds.length) {
    const rows = await db.select().from(prospects).where(and(eq(prospects.workspaceId, ws), inArray(prospects.id, prospectIds)));
    // linkedContactId lets the page enrol a person once, not as both rows (R3).
    for (const p of rows) out.push({ kind: "prospect", id: p.id, firstName: p.firstName, lastName: p.lastName, title: p.title, email: p.email, emailStatus: p.emailStatus, linkedinUrl: p.linkedinUrl, seniority: p.seniority, linkedContactId: p.linkedContactId });
  }
  if (contactIds.length) {
    const rows = await db.select().from(contacts).where(and(eq(contacts.workspaceId, ws), inArray(contacts.id, contactIds)));
    for (const c of rows) out.push({ kind: "contact", id: c.id, firstName: c.firstName, lastName: c.lastName, title: c.title, email: c.email, emailStatus: c.emailVerificationStatus, linkedinUrl: c.linkedinUrl, seniority: c.seniority });
  }
  return out;
}

export async function getCompanyActivity(ws: number, accountId: number, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(activities)
    .where(and(eq(activities.workspaceId, ws), eq(activities.relatedType, "account"), eq(activities.relatedId, accountId)))
    .orderBy(desc(activities.occurredAt)).limit(limit);
}

export async function getCompanyEnrichmentHistory(ws: number, accountId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(organizationEnrichmentEvents)
    .where(and(eq(organizationEnrichmentEvents.workspaceId, ws), eq(organizationEnrichmentEvents.accountId, accountId)))
    .orderBy(desc(organizationEnrichmentEvents.createdAt)).limit(50);
}

export async function getCompanyScore(ws: number, accountId: number) {
  const db = await getDb();
  if (!db) return null;
  const [fit] = await db.select().from(scoreResults)
    .where(and(eq(scoreResults.workspaceId, ws), eq(scoreResults.objectType, "company"), eq(scoreResults.objectId, accountId))).limit(1);
  const [priority] = await db.select().from(priorityScoreResults)
    .where(and(eq(priorityScoreResults.workspaceId, ws), eq(priorityScoreResults.objectType, "company"), eq(priorityScoreResults.objectId, accountId))).limit(1);
  return {
    value: fit ? Number(fit.normalizedScore) : null,
    rating: fit?.rating ?? null,
    priority: priority ? Number(priority.priorityScore) : null,
    priorityRating: priority?.priorityRating ?? null,
  };
}
