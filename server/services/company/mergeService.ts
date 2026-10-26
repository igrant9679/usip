/**
 * AccountMergeService — detect duplicate workspace accounts and merge them,
 * reassigning all dependents (prospects, contacts, links, opportunities,
 * customers, domains) to the surviving primary and archiving the duplicate.
 * Preserves history (rows are re-pointed, not deleted).
 */
import { and, eq, getTableName, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../../db";
import {
  accounts, prospects, contacts, contactAccountLinks, opportunities, customers,
  accountDomains, activities, brandObservations, organizationEnrichmentEvents,
  companyLogoAssets, proposals, accountBriefs, emailReplies, tasks, meetings,
  attachments, recordFiles, calendarEvents, voiceCalls, crmNotes, recordListMembers,
  qbrs, contractAmendments, supportTickets,
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
 *  - `name`: same name, and the domains do NOT agree — either none of them
 *    has one, or they hold different ones. Both arise from association, and
 *    grouping by domain made both structurally invisible: a group with no
 *    domains has no key at all, and a group with conflicting domains lands
 *    in a different bucket per member.
 *
 *    Measured 2026-08-13, on the first association run over ~2,500 prospects:
 *    556 same-name groups, of which 459 have no domain conflict to resolve
 *    (all blank, or all the same) — those are plain duplicate creation. The
 *    other 97 hold genuinely different domains, because a company's people
 *    carry unrelated mailbox domains and each one reads as its own company:
 *    Takoma Children's School came out as six accounts — takomachildren.org
 *    (right) plus dc.gov, ftc.gov, htgc.com and afterschoolalliance.org, all
 *    lifted from somebody's mailbox. Those need a human, which is why the
 *    review dialog sorts the name-matching domain to the top.
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

/**
 * Every column that points a row at a CRM account (not a SENDING account:
 * sendingAccountDailyStats, senderPoolMembers and mailboxAiTriage use the
 * name for mailboxes). Exported so a test can hold the list against the
 * schema.
 */
export const ACCOUNT_REF_COLUMNS = [
  { table: prospects, col: prospects.accountId, ws: prospects.workspaceId },
  { table: contacts, col: contacts.accountId, ws: contacts.workspaceId },
  { table: contactAccountLinks, col: contactAccountLinks.accountId, ws: contactAccountLinks.workspaceId },
  { table: opportunities, col: opportunities.accountId, ws: opportunities.workspaceId },
  { table: proposals, col: proposals.accountId, ws: proposals.workspaceId },
  { table: accountDomains, col: accountDomains.accountId, ws: accountDomains.workspaceId },
  { table: accountBriefs, col: accountBriefs.accountId, ws: accountBriefs.workspaceId },
  { table: emailReplies, col: emailReplies.accountId, ws: emailReplies.workspaceId },
  // Evidence/history tables (roadmap P2.2) — a merged account must not
  // orphan its brand observations, enrichment events, or logo assets.
  { table: brandObservations, col: brandObservations.accountId, ws: brandObservations.workspaceId },
  { table: organizationEnrichmentEvents, col: organizationEnrichmentEvents.accountId, ws: organizationEnrichmentEvents.workspaceId },
  { table: companyLogoAssets, col: companyLogoAssets.accountId, ws: companyLogoAssets.workspaceId },
] as const;

/** Rows that name an account through relatedType/relatedId (or entityType/entityId). */
export const ACCOUNT_POLY_REFS = [
  { table: tasks, type: tasks.relatedType, id: tasks.relatedId, ws: tasks.workspaceId, idKey: "relatedId" },
  { table: activities, type: activities.relatedType, id: activities.relatedId, ws: activities.workspaceId, idKey: "relatedId" },
  { table: meetings, type: meetings.relatedType, id: meetings.relatedId, ws: meetings.workspaceId, idKey: "relatedId" },
  { table: attachments, type: attachments.relatedType, id: attachments.relatedId, ws: attachments.workspaceId, idKey: "relatedId" },
  { table: recordFiles, type: recordFiles.relatedType, id: recordFiles.relatedId, ws: recordFiles.workspaceId, idKey: "relatedId" },
  { table: calendarEvents, type: calendarEvents.relatedType, id: calendarEvents.relatedId, ws: calendarEvents.workspaceId, idKey: "relatedId" },
  { table: voiceCalls, type: voiceCalls.relatedType, id: voiceCalls.relatedId, ws: voiceCalls.workspaceId, idKey: "relatedId" },
  { table: crmNotes, type: crmNotes.entityType, id: crmNotes.entityId, ws: crmNotes.workspaceId, idKey: "entityId" },
] as const;

/** Tables keyed by a customer row, which follow it when two customers fold into one. */
const CUSTOMER_REF_TABLES = [
  { table: qbrs, col: qbrs.customerId, ws: qbrs.workspaceId },
  { table: contractAmendments, col: contractAmendments.customerId, ws: contractAmendments.workspaceId },
  { table: supportTickets, col: supportTickets.customerId, ws: supportTickets.workspaceId },
] as const;

export type MergeResult = {
  ok: boolean;
  reason?: string;
  /** Rows re-pointed, by table. */
  moved?: Record<string, number>;
  /** When both accounts were customers: the duplicate's customer row, folded into the survivor's. */
  customerFolded?: { from: number; into: number; droppedArr: string } | null;
};

const affected = (r: unknown) => Number((r as any)?.[0]?.affectedRows ?? (r as any)?.affectedRows ?? 0);

/**
 * Merge a duplicate account into the one that survives.
 *
 * Audit 2026-10-20, R12: eleven separate writes with no transaction, so a
 * failure part-way left the company split across two records; tasks, notes,
 * files, meetings, list memberships, proposals and briefs stayed on the
 * archived duplicate; and when both accounts were customers, both customer
 * rows moved to the survivor and its ARR was counted twice. Now every
 * reference moves in one transaction, a list never holds the company twice,
 * and two customer rows fold into the survivor's (its ARR stands; the
 * duplicate's is reported, not added).
 */
export async function mergeAccounts(ws: number, primaryAccountId: number, duplicateAccountId: number): Promise<MergeResult> {
  if (primaryAccountId === duplicateAccountId) return { ok: false, reason: "cannot merge an account into itself" };
  const db = await getDb();
  if (!db) return { ok: false, reason: "db unavailable" };

  const [primary] = await db.select({ id: accounts.id, name: accounts.name, archivedAt: accounts.archivedAt }).from(accounts).where(and(eq(accounts.workspaceId, ws), eq(accounts.id, primaryAccountId))).limit(1);
  const [dup] = await db.select({ id: accounts.id, name: accounts.name, archivedAt: accounts.archivedAt }).from(accounts).where(and(eq(accounts.workspaceId, ws), eq(accounts.id, duplicateAccountId))).limit(1);
  if (!primary || !dup) return { ok: false, reason: "account not found" };
  if (primary.archivedAt) return { ok: false, reason: `"${primary.name}" was merged away already — pick an account that is still active to keep.` };
  if (dup.archivedAt) return { ok: false, reason: `"${dup.name}" was already merged.` };

  return db.transaction(async (tx) => {
    const moved: Record<string, number> = {};
    for (const ref of ACCOUNT_REF_COLUMNS) {
      const r = await tx.update(ref.table).set({ accountId: primaryAccountId } as never)
        .where(and(eq(ref.ws, ws), eq(ref.col, duplicateAccountId)));
      moved[getTableName(ref.table)] = affected(r);
    }
    // Child accounts follow their parent.
    moved.child_accounts = affected(await tx.update(accounts).set({ parentAccountId: primaryAccountId } as never)
      .where(and(eq(accounts.workspaceId, ws), eq(accounts.parentAccountId, duplicateAccountId))));
    for (const ref of ACCOUNT_POLY_REFS) {
      const r = await tx.update(ref.table).set({ [ref.idKey]: primaryAccountId } as never)
        .where(and(eq(ref.ws, ws), eq(ref.type, "account"), eq(ref.id, duplicateAccountId)));
      moved[getTableName(ref.table)] = affected(r);
    }

    // Lists: a list that already holds the survivor drops the duplicate's row.
    const dupMemberships = await tx.select({ id: recordListMembers.id, listId: recordListMembers.listId }).from(recordListMembers)
      .where(and(eq(recordListMembers.workspaceId, ws), eq(recordListMembers.recordType, "account"), eq(recordListMembers.recordId, duplicateAccountId)));
    let listsMoved = 0;
    for (const m of dupMemberships) {
      const [already] = await tx.select({ id: recordListMembers.id }).from(recordListMembers)
        .where(and(eq(recordListMembers.workspaceId, ws), eq(recordListMembers.listId, m.listId), eq(recordListMembers.recordType, "account"), eq(recordListMembers.recordId, primaryAccountId)))
        .limit(1);
      if (already) await tx.delete(recordListMembers).where(and(eq(recordListMembers.id, m.id), eq(recordListMembers.workspaceId, ws)));
      else { await tx.update(recordListMembers).set({ recordId: primaryAccountId }).where(and(eq(recordListMembers.id, m.id), eq(recordListMembers.workspaceId, ws))); listsMoved++; }
    }
    moved.record_list_members = listsMoved;

    // Customers: one company, one customer row.
    const [dupCustomer] = await tx.select({ id: customers.id, arr: customers.arr }).from(customers)
      .where(and(eq(customers.workspaceId, ws), eq(customers.accountId, duplicateAccountId))).limit(1);
    const [primaryCustomer] = await tx.select({ id: customers.id }).from(customers)
      .where(and(eq(customers.workspaceId, ws), eq(customers.accountId, primaryAccountId))).limit(1);
    let customerFolded: MergeResult["customerFolded"] = null;
    if (dupCustomer && primaryCustomer) {
      for (const ref of CUSTOMER_REF_TABLES) {
        await tx.update(ref.table).set({ customerId: primaryCustomer.id } as never)
          .where(and(eq(ref.ws, ws), eq(ref.col, dupCustomer.id)));
      }
      await tx.delete(customers).where(and(eq(customers.workspaceId, ws), eq(customers.id, dupCustomer.id)));
      customerFolded = { from: dupCustomer.id, into: primaryCustomer.id, droppedArr: String(dupCustomer.arr ?? "0") };
    } else if (dupCustomer) {
      await tx.update(customers).set({ accountId: primaryAccountId } as never)
        .where(and(eq(customers.workspaceId, ws), eq(customers.id, dupCustomer.id)));
    }
    moved.customers = dupCustomer ? 1 : 0;

    await tx.update(accounts).set({ archivedAt: new Date(), dataStatus: "merged" } as never)
      .where(and(eq(accounts.workspaceId, ws), eq(accounts.id, duplicateAccountId)));

    await tx.insert(activities).values({
      workspaceId: ws, type: "system", relatedType: "account", relatedId: primaryAccountId,
      subject: `Merged "${dup.name}" (#${duplicateAccountId}) into "${primary.name}" (#${primaryAccountId})`.slice(0, 240),
      body: customerFolded
        ? `Both were customers: customer #${customerFolded.from} (ARR ${customerFolded.droppedArr}) folded into #${customerFolded.into}, whose ARR stands.`
        : null,
    } as never);
    return { ok: true, moved, customerFolded };
  });
}
