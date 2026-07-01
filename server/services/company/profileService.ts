/**
 * CompanyProfileService — reads that back the company profile page: the account
 * with resolved logo + contact count + score, its linked people (prospects and
 * contacts), activity timeline, enrichment history, technologies and funding.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db";
import {
  accounts, contacts, prospects, contactAccountLinks, activities,
  organizationEnrichmentEvents, organizationTechnologies, organizationFundingEvents,
  scoreResults, priorityScoreResults,
} from "../../../drizzle/schema";
import { resolveCompanyLogo, faviconUrlForDomain } from "./logoService";

export async function contactCountForAccount(ws: number, accountId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(contactAccountLinks)
    .where(and(eq(contactAccountLinks.workspaceId, ws), eq(contactAccountLinks.accountId, accountId), eq(contactAccountLinks.isCurrent, true)));
  return Number(n);
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
    for (const p of rows) out.push({ kind: "prospect", id: p.id, firstName: p.firstName, lastName: p.lastName, title: p.title, email: p.email, emailStatus: p.emailStatus, linkedinUrl: p.linkedinUrl, seniority: p.seniority });
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

export async function getCompanyTechnologies(orgId: number | null) {
  const db = await getDb();
  if (!db || !orgId) return [];
  return db.select().from(organizationTechnologies).where(eq(organizationTechnologies.globalOrganizationId, orgId));
}

export async function getCompanyFunding(orgId: number | null) {
  const db = await getDb();
  if (!db || !orgId) return [];
  return db.select().from(organizationFundingEvents).where(eq(organizationFundingEvents.globalOrganizationId, orgId)).orderBy(desc(organizationFundingEvents.announcedAt));
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
