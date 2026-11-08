/**
 * Is this lead already here? (audit 2026-10-20, F36)
 *
 * leads.create made a second lead for an address the workspace already had,
 * as a lead or as a contact, and nobody was told. This is the one check, read
 * by the New lead dialog before it saves and by leads.create itself, which
 * refuses a match unless the person chose to create it anyway.
 *
 * An address is a person, so a lead or a contact with the same address (any
 * case) is a match. With no address, a lead with the same first name, last
 * name and company is; a name alone is not, since two people share names.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { contacts, leads } from "../../drizzle/schema";
import { getDb } from "../db";

export type LeadDuplicate = {
  kind: "lead" | "contact";
  id: number;
  name: string;
  email: string | null;
  company: string | null;
  matchedBy: "email" | "name + company";
};

/** The most matches the dialog lists. */
export const LEAD_DUPLICATE_LIMIT = 5;

export async function findLeadDuplicates(
  workspaceId: number,
  input: { email?: string | null; firstName?: string | null; lastName?: string | null; company?: string | null },
): Promise<LeadDuplicate[]> {
  const db = await getDb();
  if (!db) return [];
  const email = (input.email ?? "").trim().toLowerCase();
  const name = (r: { firstName: string | null; lastName: string | null }) => [r.firstName, r.lastName].filter(Boolean).join(" ").trim();
  const out: LeadDuplicate[] = [];
  if (email) {
    const ls = await db.select({ id: leads.id, firstName: leads.firstName, lastName: leads.lastName, email: leads.email, company: leads.company })
      .from(leads)
      .where(and(eq(leads.workspaceId, workspaceId), sql`lower(${leads.email}) = ${email}`))
      .orderBy(desc(leads.id)).limit(LEAD_DUPLICATE_LIMIT);
    for (const r of ls) out.push({ kind: "lead", id: r.id, name: name(r), email: r.email, company: r.company, matchedBy: "email" });
    const cs = await db.select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, company: contacts.companyName })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), sql`lower(${contacts.email}) = ${email}`))
      .orderBy(desc(contacts.id)).limit(LEAD_DUPLICATE_LIMIT);
    for (const r of cs) out.push({ kind: "contact", id: r.id, name: name(r), email: r.email, company: r.company, matchedBy: "email" });
    return out.slice(0, LEAD_DUPLICATE_LIMIT);
  }
  const first = (input.firstName ?? "").trim().toLowerCase();
  const last = (input.lastName ?? "").trim().toLowerCase();
  const company = (input.company ?? "").trim().toLowerCase();
  if (!first || !last || !company) return [];
  const ls = await db.select({ id: leads.id, firstName: leads.firstName, lastName: leads.lastName, email: leads.email, company: leads.company })
    .from(leads)
    .where(and(
      eq(leads.workspaceId, workspaceId),
      sql`lower(${leads.firstName}) = ${first}`,
      sql`lower(${leads.lastName}) = ${last}`,
      sql`lower(${leads.company}) = ${company}`,
    ))
    .orderBy(desc(leads.id)).limit(LEAD_DUPLICATE_LIMIT);
  return ls.map((r) => ({ kind: "lead" as const, id: r.id, name: name(r), email: r.email, company: r.company, matchedBy: "name + company" as const }));
}

/** "Ann Lee (lead #12, by email)" for a refusal message. */
export function describeLeadDuplicates(d: LeadDuplicate[]): string {
  return d.map((x) => `${x.name || x.email || "Unnamed"} (${x.kind} #${x.id}, by ${x.matchedBy})`).join("; ");
}
