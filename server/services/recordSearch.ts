/**
 * recordSearch.ts — one search across the workspace's own records (owner,
 * 2026-11-23: "a simple way to type in a company name, person's name or
 * email address and see their enriched info").
 *
 * Before this, nothing searched people, companies and leads together: the
 * header's "Search…" box only jumped to pages, and each list page had its
 * own box. This is the read behind that header box now, and behind Elsie's
 * search.records.
 *
 * What matches:
 *   · every word typed must be found on the record ("jane acme" finds Jane
 *     at Acme): a person's first name, last name, company, title or email;
 *     a company's name or domain; a lead's first name, last name, company
 *     or email;
 *   · an email address also finds the company whose domain it is on;
 *   · a bare domain ("acme.org") finds the company, and the people and leads
 *     whose address is on it.
 * Archived people and archived companies are left out, as their lists do.
 *
 * Read only, scoped to the workspace in every statement, and capped: three
 * small queries and one count, never the table.
 */
import { and, desc, eq, inArray, isNull, like, ne, or, sql, type SQL } from "drizzle-orm";
import { accounts, leads, prospects } from "../../drizzle/schema";
import { getDb } from "../db";
import {
  RECORD_SEARCH_PER_KIND, parseRecordSearch,
  type CompanyHit, type LeadHit, type PersonHit, type RecordSearchResult,
} from "@shared/recordSearch";

/** % and _ are wildcards in LIKE; what a person typed is never a pattern. */
export const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);
const contains = (w: string) => `%${escapeLike(w)}%`;
const startsWith = (w: string) => `${escapeLike(w)}%`;

const joinLocation = (...parts: Array<string | null | undefined>) =>
  parts.map((p) => (p ?? "").trim()).filter(Boolean).join(", ") || null;

const EMPTY = (query: string): RecordSearchResult => ({
  query, people: [], companies: [], leads: [], more: { people: false, companies: false, leads: false },
});

export async function searchRecords(workspaceId: number, raw: string, perKind: number = RECORD_SEARCH_PER_KIND): Promise<RecordSearchResult> {
  const q = parseRecordSearch(raw);
  if (!q) return EMPTY(String(raw ?? "").trim());
  const db = await getDb();
  if (!db) return EMPTY(q.text);
  const take = Math.max(1, Math.min(25, perKind));
  const first = q.words[0];

  /* People. */
  const personWords: SQL[] = q.words.map((w) => or(
    like(prospects.firstName, contains(w)),
    like(prospects.lastName, contains(w)),
    like(prospects.company, contains(w)),
    like(prospects.title, contains(w)),
    like(prospects.email, contains(w)),
  )!);
  const peopleRows = await db
    .select({
      id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName, title: prospects.title,
      company: prospects.company, email: prospects.email, emailStatus: prospects.emailStatus, phone: prospects.phone,
      linkedinUrl: prospects.linkedinUrl, city: prospects.city, state: prospects.state, country: prospects.country,
      lastEnrichedAt: prospects.lastEnrichedAt,
    })
    .from(prospects)
    .where(and(
      eq(prospects.workspaceId, workspaceId),
      // Archived people stay out, as on the People list (peopleFilter).
      or(isNull(prospects.verificationStatus), ne(prospects.verificationStatus, "rejected"))!,
      ...personWords,
    ))
    // The exact address, then a name that starts with what was typed, then the rest.
    .orderBy(
      sql`CASE WHEN ${prospects.email} = ${q.email ?? ""} THEN 0 WHEN CONCAT(${prospects.firstName}, ' ', ${prospects.lastName}) LIKE ${startsWith(q.text)} THEN 1 WHEN ${prospects.lastName} LIKE ${startsWith(first)} OR ${prospects.firstName} LIKE ${startsWith(first)} THEN 2 ELSE 3 END`,
      desc(prospects.updatedAt),
      desc(prospects.id),
    )
    .limit(take + 1);

  /* Companies. An email's domain, or a bare domain, finds its company too. */
  const companyWords: SQL = and(...q.words.map((w) => or(
    like(accounts.name, contains(w)),
    like(accounts.domain, contains(w)),
    like(accounts.normalizedDomain, contains(w)),
  )!))!;
  const companyMatch: SQL = q.domain
    ? or(companyWords, eq(accounts.normalizedDomain, q.domain), eq(accounts.domain, q.domain))!
    : companyWords;
  const companyRows = await db
    .select({
      id: accounts.id, name: accounts.name, domain: accounts.domain, normalizedDomain: accounts.normalizedDomain,
      industry: accounts.industry, employeeCount: accounts.employeeCount, employeeBand: accounts.employeeBand,
      hqCity: accounts.hqCity, hqState: accounts.hqState, hqCountry: accounts.hqCountry,
    })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), isNull(accounts.archivedAt), companyMatch))
    .orderBy(
      sql`CASE WHEN ${accounts.normalizedDomain} = ${q.domain ?? ""} THEN 0 WHEN ${accounts.name} LIKE ${startsWith(q.text)} THEN 1 ELSE 2 END`,
      desc(accounts.updatedAt),
      desc(accounts.id),
    )
    .limit(take + 1);

  /* Leads. */
  const leadWords: SQL[] = q.words.map((w) => or(
    like(leads.firstName, contains(w)),
    like(leads.lastName, contains(w)),
    like(leads.company, contains(w)),
    like(leads.email, contains(w)),
  )!);
  const leadRows = await db
    .select({
      id: leads.id, firstName: leads.firstName, lastName: leads.lastName, title: leads.title, company: leads.company,
      email: leads.email, phone: leads.phone, status: leads.status, score: leads.score,
    })
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), ...leadWords))
    .orderBy(
      sql`CASE WHEN ${leads.email} = ${q.email ?? ""} THEN 0 WHEN CONCAT(${leads.firstName}, ' ', ${leads.lastName}) LIKE ${startsWith(q.text)} THEN 1 ELSE 2 END`,
      desc(leads.score),
      desc(leads.id),
    )
    .limit(take + 1);

  /* How many people each company shown has, in one grouped read. */
  const shownCompanies = companyRows.slice(0, take);
  const peopleByCompany = new Map<number, number>();
  if (shownCompanies.length) {
    const counts = await db
      .select({ accountId: prospects.accountId, n: sql<number>`count(*)` })
      .from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.accountId, shownCompanies.map((c) => c.id))))
      .groupBy(prospects.accountId);
    for (const c of counts) if (c.accountId != null) peopleByCompany.set(c.accountId, Number(c.n ?? 0));
  }

  const people: PersonHit[] = peopleRows.slice(0, take).map((p) => ({
    kind: "person", id: p.id, href: `/prospects/${p.id}`,
    name: `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "(no name)",
    title: p.title ?? null, company: p.company ?? null, email: p.email || null, emailStatus: p.emailStatus ?? null,
    phone: p.phone || null, linkedinUrl: p.linkedinUrl || null,
    location: joinLocation(p.city, p.state, p.country),
    enrichedAt: p.lastEnrichedAt ? new Date(p.lastEnrichedAt).toISOString() : null,
  }));
  const companies: CompanyHit[] = shownCompanies.map((c) => ({
    kind: "company", id: c.id, href: `/v2/companies/${c.id}`, name: c.name,
    domain: c.domain || c.normalizedDomain || null, industry: c.industry ?? null,
    size: c.employeeCount ? `${c.employeeCount.toLocaleString("en-US")} employees` : c.employeeBand ? `${c.employeeBand} employees` : null,
    location: joinLocation(c.hqCity, c.hqState, c.hqCountry),
    people: peopleByCompany.get(c.id) ?? 0,
  }));
  const leadHits: LeadHit[] = leadRows.slice(0, take).map((l) => ({
    kind: "lead", id: l.id, href: `/leads/${l.id}`,
    name: `${l.firstName ?? ""} ${l.lastName ?? ""}`.trim() || "(no name)",
    title: l.title ?? null, company: l.company ?? null, email: l.email || null, phone: l.phone || null,
    status: l.status ?? null, score: l.score ?? null,
  }));
  return {
    query: q.text, people, companies, leads: leadHits,
    more: { people: peopleRows.length > take, companies: companyRows.length > take, leads: leadRows.length > take },
  };
}
