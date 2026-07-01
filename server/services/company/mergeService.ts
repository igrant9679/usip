/**
 * AccountMergeService — detect duplicate workspace accounts and merge them,
 * reassigning all dependents (prospects, contacts, links, opportunities,
 * customers, domains) to the surviving primary and archiving the duplicate.
 * Preserves history (rows are re-pointed, not deleted).
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import {
  accounts, prospects, contacts, contactAccountLinks, opportunities, customers,
  accountDomains, activities,
} from "../../../drizzle/schema";

export async function findDuplicateAccounts(ws: number): Promise<Array<{ key: string; accountIds: number[] }>> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ id: accounts.id, key: accounts.normalizedDomain })
    .from(accounts).where(and(eq(accounts.workspaceId, ws)));
  const byKey = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.key) continue;
    const arr = byKey.get(r.key) ?? [];
    arr.push(r.id); byKey.set(r.key, arr);
  }
  return [...byKey.entries()].filter(([, ids]) => ids.length > 1).map(([key, accountIds]) => ({ key, accountIds }));
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
