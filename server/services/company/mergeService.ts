/**
 * AccountMergeService — detect duplicate workspace accounts and merge them,
 * reassigning all dependents (prospects, contacts, links, opportunities,
 * customers, domains) to the surviving primary and archiving the duplicate.
 * Preserves history (rows are re-pointed, not deleted).
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../../db";
import {
  accounts, prospects, contacts, contactAccountLinks, opportunities, customers,
  accountDomains, activities, brandObservations, organizationEnrichmentEvents,
  companyLogoAssets,
} from "../../../drizzle/schema";

export interface DuplicateGroup {
  /** The shared normalized domain, or name, the accounts collide on. */
  key: string;
  /** Which collision this is — the two shapes need different judgement. */
  reason: "domain" | "name";
  accounts: Array<{ id: number; name: string; domain: string | null; createdAt: Date | null; contactCount: number }>;
}

/**
 * Accounts that are probably the same company, with enough detail to review
 * which should survive. Archived accounts are excluded — a merged duplicate
 * keeps its normalizedDomain, so without this filter every completed merge
 * would resurface in the list forever.
 *
 * TWO collision shapes, because they arise from opposite mistakes:
 *
 *  - `domain`: same domain, different names — the classic import duplicate.
 *  - `name`: same name, DIFFERENT domains. This is what association produces
 *    when one company's people carry unrelated mailbox domains: the matcher
 *    reads each distinct domain as a distinct company and creates an account
 *    per domain. Seen 2026-08-13 after the first association run — "Verizon
 *    Enterprise" fragmented into 28 accounts, and a school picked up dc.gov,
 *    ftc.gov and its own takomachildren.org as three separate companies.
 *    Grouping only by domain made these structurally invisible.
 */
export async function findDuplicateAccounts(ws: number): Promise<DuplicateGroup[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ id: accounts.id, key: accounts.normalizedDomain, nameKey: accounts.normalizedName, name: accounts.name, domain: accounts.domain, createdAt: accounts.createdAt })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, ws), isNull(accounts.archivedAt)));
  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.key) continue;
    const arr = byKey.get(r.key) ?? [];
    arr.push(r); byKey.set(r.key, arr);
  }
  // Array.from, not a spread — iterator spreads are TS2802 under this tsconfig.
  const domainGroups = Array.from(byKey.entries()).filter(([, g]) => g.length > 1);

  // Same-name groups, minus any set already reported as a domain collision.
  const alreadyGrouped = new Set(domainGroups.flatMap(([, g]) => g.map((r) => r.id)));
  const byName = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.nameKey || alreadyGrouped.has(r.id)) continue;
    const arr = byName.get(r.nameKey) ?? [];
    arr.push(r); byName.set(r.nameKey, arr);
  }
  const nameGroups = Array.from(byName.entries()).filter(([, g]) => g.length > 1);

  const groups: Array<[string, typeof rows, DuplicateGroup["reason"]]> = [
    ...domainGroups.map(([k, g]) => [k, g, "domain"] as [string, typeof rows, DuplicateGroup["reason"]]),
    ...nameGroups.map(([k, g]) => [k, g, "name"] as [string, typeof rows, DuplicateGroup["reason"]]),
  ];
  if (groups.length === 0) return [];

  // Linked-contact counts inform which account should be the primary.
  const ids = groups.flatMap(([, g]) => g.map((r) => r.id));
  const counts = await db
    .select({ accountId: contacts.accountId, c: sql<number>`count(*)` })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, ws), inArray(contacts.accountId, ids)))
    .groupBy(contacts.accountId);
  const byAccount = new Map(counts.map((r) => [Number(r.accountId), Number(r.c)]));

  return groups.map(([key, g, reason]) => ({
    key: reason === "name" ? `name:${key}` : key,
    reason,
    accounts: g.map((r) => ({ id: r.id, name: r.name, domain: r.domain, createdAt: r.createdAt, contactCount: byAccount.get(r.id) ?? 0 })),
  }));
}

export async function mergeAccounts(ws: number, primaryAccountId: number, duplicateAccountId: number): Promise<{ ok: boolean; reason?: string }> {
  if (primaryAccountId === duplicateAccountId) return { ok: false, reason: "cannot merge an account into itself" };
  const db = await getDb();
  if (!db) return { ok: false, reason: "db unavailable" };

  const [primary] = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.workspaceId, ws), eq(accounts.id, primaryAccountId))).limit(1);
  const [dup] = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.workspaceId, ws), eq(accounts.id, duplicateAccountId))).limit(1);
  if (!primary || !dup) return { ok: false, reason: "account not found" };

  const reassign = { accountId: primaryAccountId } as never;
  await db.update(prospects).set(reassign).where(and(eq(prospects.workspaceId, ws), eq(prospects.accountId, duplicateAccountId)));
  await db.update(contacts).set(reassign).where(and(eq(contacts.workspaceId, ws), eq(contacts.accountId, duplicateAccountId)));
  await db.update(contactAccountLinks).set(reassign).where(and(eq(contactAccountLinks.workspaceId, ws), eq(contactAccountLinks.accountId, duplicateAccountId)));
  await db.update(opportunities).set(reassign).where(and(eq(opportunities.workspaceId, ws), eq(opportunities.accountId, duplicateAccountId)));
  await db.update(customers).set(reassign).where(and(eq(customers.workspaceId, ws), eq(customers.accountId, duplicateAccountId)));
  await db.update(accountDomains).set(reassign).where(and(eq(accountDomains.workspaceId, ws), eq(accountDomains.accountId, duplicateAccountId)));
  // Evidence/history tables (roadmap P2.2) — a merged account must not
  // orphan its brand observations, enrichment events, or logo assets.
  // (prospect_linkedin_field_changes is prospect-scoped — nothing to repoint.)
  await db.update(brandObservations).set(reassign).where(and(eq(brandObservations.workspaceId, ws), eq(brandObservations.accountId, duplicateAccountId)));
  await db.update(organizationEnrichmentEvents).set({ accountId: primaryAccountId } as never).where(and(eq(organizationEnrichmentEvents.workspaceId, ws), eq(organizationEnrichmentEvents.accountId, duplicateAccountId)));
  await db.update(companyLogoAssets).set({ accountId: primaryAccountId } as never).where(and(eq(companyLogoAssets.workspaceId, ws), eq(companyLogoAssets.accountId, duplicateAccountId)));

  await db.update(accounts).set({ archivedAt: new Date(), dataStatus: "merged" } as never)
    .where(and(eq(accounts.workspaceId, ws), eq(accounts.id, duplicateAccountId)));

  try {
    await db.insert(activities).values({
      workspaceId: ws, type: "system", relatedType: "account", relatedId: primaryAccountId,
      subject: `Merged account #${duplicateAccountId} into #${primaryAccountId}`.slice(0, 240),
    } as never);
  } catch { /* best-effort */ }
  return { ok: true };
}
