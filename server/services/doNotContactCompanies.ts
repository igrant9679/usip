/**
 * People about to be enrolled whose company is flagged "do not contact now"
 * (audit 2026-10-20, F36).
 *
 * Research's Downstream seller fit flags an organization in financial
 * distress, and the company page says so ("Financial distress: do not
 * contact now"). The Revenue Engine's screen rejects such people, but a
 * sequence enrolment from People, a list or the company page itself went
 * ahead without a word. The Add to… review asks this first and makes the
 * person confirm they mean it, or leave those people out.
 *
 * A person's company is their People row's account, a contact's account, or
 * the account a lead's company name names. The flag is the one the company
 * page shows: `customFields.downstreamFit.flags` holding "financial-distress".
 */
import { and, eq, inArray } from "drizzle-orm";
import { accounts, contacts, leads, prospects } from "../../drizzle/schema";
import { getDb } from "../db";

export const DO_NOT_CONTACT_FLAG = "financial-distress";

/** Whether an account's stored research says not to contact it now. */
export function accountSaysDoNotContact(customFields: unknown): boolean {
  const cf = customFields && typeof customFields === "object" ? (customFields as Record<string, unknown>) : null;
  const fit = cf?.downstreamFit && typeof cf.downstreamFit === "object" ? (cf.downstreamFit as { flags?: unknown }) : null;
  return Array.isArray(fit?.flags) && (fit!.flags as unknown[]).includes(DO_NOT_CONTACT_FLAG);
}

export type DoNotContactHit = {
  people: number;
  companies: Array<{ accountId: number; name: string; people: number }>;
  /** The flagged people, by kind, so the review can leave them out. */
  flagged: { prospectIds: number[]; contactIds: number[]; leadIds: number[] };
};

export async function doNotContactCompaniesFor(
  workspaceId: number,
  ids: { prospectIds?: number[]; contactIds?: number[]; leadIds?: number[] },
): Promise<DoNotContactHit> {
  const empty: DoNotContactHit = { people: 0, companies: [], flagged: { prospectIds: [], contactIds: [], leadIds: [] } };
  const db = await getDb();
  if (!db) return empty;
  const people: Array<{ kind: "p" | "c"; id: number; accountId: number | null }> = [];
  const leadCompanies: Array<{ id: number; company: string }> = [];
  const pIds = Array.from(new Set(ids.prospectIds ?? [])).slice(0, 5000);
  const cIds = Array.from(new Set(ids.contactIds ?? [])).slice(0, 5000);
  const lIds = Array.from(new Set(ids.leadIds ?? [])).slice(0, 5000);
  if (pIds.length) {
    const rows = await db.select({ id: prospects.id, accountId: prospects.accountId }).from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), inArray(prospects.id, pIds)));
    for (const r of rows) people.push({ kind: "p", id: r.id, accountId: r.accountId ?? null });
  }
  if (cIds.length) {
    const rows = await db.select({ id: contacts.id, accountId: contacts.accountId }).from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), inArray(contacts.id, cIds)));
    for (const r of rows) people.push({ kind: "c", id: r.id, accountId: r.accountId ?? null });
  }
  if (lIds.length) {
    const rows = await db.select({ id: leads.id, company: leads.company }).from(leads)
      .where(and(eq(leads.workspaceId, workspaceId), inArray(leads.id, lIds)));
    for (const r of rows) if (r.company?.trim()) leadCompanies.push({ id: r.id, company: r.company.trim() });
  }

  const flagged = new Map<number, string>();
  const nameToId = new Map<string, number>();
  const accountIds = Array.from(new Set(people.map((x) => x.accountId).filter((x): x is number => x != null)));
  if (accountIds.length) {
    const rows = await db.select({ id: accounts.id, name: accounts.name, customFields: accounts.customFields }).from(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), inArray(accounts.id, accountIds)));
    for (const a of rows) if (accountSaysDoNotContact(a.customFields)) flagged.set(a.id, a.name);
  }
  if (leadCompanies.length) {
    const names = Array.from(new Set(leadCompanies.map((l) => l.company))).slice(0, 1000);
    const rows = await db.select({ id: accounts.id, name: accounts.name, customFields: accounts.customFields }).from(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), inArray(accounts.name, names)));
    for (const a of rows) {
      if (!accountSaysDoNotContact(a.customFields)) continue;
      flagged.set(a.id, a.name);
      nameToId.set(a.name.toLowerCase(), a.id);
    }
  }
  if (flagged.size === 0) return empty;

  const counts = new Map<number, number>();
  const out = { prospectIds: [] as number[], contactIds: [] as number[], leadIds: [] as number[] };
  for (const x of people) {
    if (x.accountId == null || !flagged.has(x.accountId)) continue;
    counts.set(x.accountId, (counts.get(x.accountId) ?? 0) + 1);
    (x.kind === "p" ? out.prospectIds : out.contactIds).push(x.id);
  }
  for (const l of leadCompanies) {
    const id = nameToId.get(l.company.toLowerCase());
    if (id == null) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    out.leadIds.push(l.id);
  }
  const companies = Array.from(counts.entries())
    .map(([accountId, n]) => ({ accountId, name: flagged.get(accountId)!, people: n }))
    .sort((a, b) => b.people - a.people);
  return { people: companies.reduce((s, c) => s + c.people, 0), companies, flagged: out };
}
