/**
 * "Undo this import" (audit 2026-10-20, F32).
 *
 * An import could not be taken back: a wrong mapping or the wrong file meant
 * deleting its rows by hand, with nothing to say which rows it made. Every
 * import records each row it created in contact_import_rows (contactId or
 * prospectId), so the import's own rows are known exactly, and Undo removes
 * those and nothing else:
 *
 *   - a person or contact since put to use is kept and counted: promoted to a
 *     lead or contact, enrolled in a sequence, queued in a campaign, or (for a
 *     contact) named on a deal;
 *   - for a contacts import, the People row the import's own linking made for
 *     a removed contact (created after the import started, and not otherwise
 *     in use) goes with it; a People row that existed before is only unlinked;
 *   - a company the import created goes only when nothing uses it any more:
 *     no contact, person or deal;
 *   - every removed row is copied into the audit entry first, as a bulk
 *     delete does, so it can be restored.
 *
 * The import is then marked undone, with what was removed and what was kept.
 */
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import {
  accounts, contactImportRows, contactImports, contacts, enrollments, opportunities, opportunityContactRoles, prospectQueue, prospects,
} from "../../drizzle/schema";
import { recordAudit } from "../audit";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type ImportRecord = typeof contactImports.$inferSelect;

export type UndoSummary = {
  importId: number;
  removedPeople: number;
  removedContacts: number;
  removedCompanies: number;
  unlinkedPeople: number;
  keptInUse: number;
  keptCompanies: number;
};

const CHUNK = 500;
async function inChunks<T>(ids: number[], fn: (part: number[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await fn(ids.slice(i, i + CHUNK))));
  return out;
}

export async function undoImport(db: Db, ws: number, record: ImportRecord, actorUserId: number): Promise<UndoSummary> {
  const made = await db.select({ contactId: contactImportRows.contactId, prospectId: contactImportRows.prospectId })
    .from(contactImportRows)
    .where(and(eq(contactImportRows.importId, record.id), eq(contactImportRows.status, "imported")));
  const madeProspects = Array.from(new Set(made.map((r) => r.prospectId).filter((x): x is number => x != null)));
  const madeContacts = Array.from(new Set(made.map((r) => r.contactId).filter((x): x is number => x != null)));

  // People in use since the import: promoted, in a sequence, or in a campaign.
  const peopleInUse = async (ids: number[]): Promise<Set<number>> => {
    if (!ids.length) return new Set();
    const promoted = await inChunks(ids, (part) => db.select({ id: prospects.id }).from(prospects)
      .where(and(eq(prospects.workspaceId, ws), inArray(prospects.id, part), or(isNotNull(prospects.linkedLeadId), isNotNull(prospects.linkedContactId))!)));
    const enrolled = await inChunks(ids, (part) => db.select({ id: enrollments.prospectId }).from(enrollments)
      .where(and(eq(enrollments.workspaceId, ws), inArray(enrollments.prospectId, part))));
    const queued = await inChunks(ids, (part) => db.select({ id: prospectQueue.personProspectId }).from(prospectQueue)
      .where(and(eq(prospectQueue.workspaceId, ws), inArray(prospectQueue.personProspectId, part))));
    return new Set([...promoted, ...enrolled, ...queued].map((r) => r.id).filter((x): x is number => x != null));
  };

  let removedPeople = 0, removedContacts = 0, unlinkedPeople = 0, keptInUse = 0;
  const removed: { people: unknown[]; contacts: unknown[]; companies: unknown[] } = { people: [], contacts: [], companies: [] };

  if (madeProspects.length) {
    const live = await inChunks(madeProspects, (part) => db.select().from(prospects).where(and(eq(prospects.workspaceId, ws), inArray(prospects.id, part))));
    const inUse = await peopleInUse(live.map((p) => p.id));
    const gone = live.filter((p) => !inUse.has(p.id));
    keptInUse += live.length - gone.length;
    removed.people.push(...gone);
    for (let i = 0; i < gone.length; i += CHUNK) {
      await db.delete(prospects).where(and(eq(prospects.workspaceId, ws), inArray(prospects.id, gone.slice(i, i + CHUNK).map((p) => p.id))));
    }
    removedPeople += gone.length;
  }

  if (madeContacts.length) {
    const live = await inChunks(madeContacts, (part) => db.select().from(contacts).where(and(eq(contacts.workspaceId, ws), inArray(contacts.id, part))));
    const liveIds = live.map((c) => c.id);
    const enrolled = await inChunks(liveIds, (part) => db.select({ id: enrollments.contactId }).from(enrollments)
      .where(and(eq(enrollments.workspaceId, ws), inArray(enrollments.contactId, part))));
    const onDeals = await inChunks(liveIds, (part) => db.select({ id: opportunityContactRoles.contactId }).from(opportunityContactRoles)
      .where(and(eq(opportunityContactRoles.workspaceId, ws), inArray(opportunityContactRoles.contactId, part))));
    const usedContacts = new Set([...enrolled, ...onDeals].map((r) => r.id).filter((x): x is number => x != null));
    const gone = live.filter((c) => !usedContacts.has(c.id));
    keptInUse += live.length - gone.length;
    const goneIds = gone.map((c) => c.id);

    // The People rows linked to the removed contacts.
    const linked = goneIds.length
      ? await inChunks(goneIds, (part) => db.select().from(prospects).where(and(eq(prospects.workspaceId, ws), inArray(prospects.linkedContactId, part))))
      : [];
    const madeHere = linked.filter((p) => p.createdAt && record.createdAt && new Date(p.createdAt).getTime() >= new Date(record.createdAt).getTime() && p.linkedLeadId == null);
    const madeInUse = await (async () => {
      const ids = madeHere.map((p) => p.id);
      if (!ids.length) return new Set<number>();
      const enr = await inChunks(ids, (part) => db.select({ id: enrollments.prospectId }).from(enrollments).where(and(eq(enrollments.workspaceId, ws), inArray(enrollments.prospectId, part))));
      const q = await inChunks(ids, (part) => db.select({ id: prospectQueue.personProspectId }).from(prospectQueue).where(and(eq(prospectQueue.workspaceId, ws), inArray(prospectQueue.personProspectId, part))));
      return new Set([...enr, ...q].map((r) => r.id).filter((x): x is number => x != null));
    })();
    const peopleGone = madeHere.filter((p) => !madeInUse.has(p.id));
    const peopleGoneIds = new Set(peopleGone.map((p) => p.id));
    const peopleUnlink = linked.filter((p) => !peopleGoneIds.has(p.id));

    removed.contacts.push(...gone);
    removed.people.push(...peopleGone);
    for (let i = 0; i < goneIds.length; i += CHUNK) {
      await db.delete(contacts).where(and(eq(contacts.workspaceId, ws), inArray(contacts.id, goneIds.slice(i, i + CHUNK))));
    }
    const pg = peopleGone.map((p) => p.id);
    for (let i = 0; i < pg.length; i += CHUNK) {
      await db.delete(prospects).where(and(eq(prospects.workspaceId, ws), inArray(prospects.id, pg.slice(i, i + CHUNK))));
    }
    const pu = peopleUnlink.map((p) => p.id);
    for (let i = 0; i < pu.length; i += CHUNK) {
      await db.update(prospects).set({ linkedContactId: null }).where(and(eq(prospects.workspaceId, ws), inArray(prospects.id, pu.slice(i, i + CHUNK))));
    }
    removedContacts += goneIds.length;
    removedPeople += pg.length;
    unlinkedPeople += pu.length;
  }

  // Companies this import created, when nothing uses them now.
  const createdAccountIds = Array.isArray(record.createdAccountIds) ? (record.createdAccountIds as unknown[]).filter((x): x is number => typeof x === "number") : [];
  let removedCompanies = 0, keptCompanies = 0;
  if (createdAccountIds.length) {
    const live = await inChunks(createdAccountIds, (part) => db.select().from(accounts).where(and(eq(accounts.workspaceId, ws), inArray(accounts.id, part))));
    const ids = live.map((a) => a.id);
    const byContacts = await inChunks(ids, (part) => db.select({ id: contacts.accountId }).from(contacts).where(and(eq(contacts.workspaceId, ws), inArray(contacts.accountId, part))));
    const byPeople = await inChunks(ids, (part) => db.select({ id: prospects.accountId }).from(prospects).where(and(eq(prospects.workspaceId, ws), inArray(prospects.accountId, part))));
    const byDeals = await inChunks(ids, (part) => db.select({ id: opportunities.accountId }).from(opportunities).where(and(eq(opportunities.workspaceId, ws), inArray(opportunities.accountId, part))));
    const used = new Set([...byContacts, ...byPeople, ...byDeals].map((r) => r.id).filter((x): x is number => x != null));
    const gone = live.filter((a) => !used.has(a.id));
    keptCompanies = live.length - gone.length;
    removed.companies.push(...gone);
    for (let i = 0; i < gone.length; i += CHUNK) {
      await db.delete(accounts).where(and(eq(accounts.workspaceId, ws), inArray(accounts.id, gone.slice(i, i + CHUNK).map((a) => a.id))));
    }
    removedCompanies = gone.length;
  }

  const summary: UndoSummary = { importId: record.id, removedPeople, removedContacts, removedCompanies, unlinkedPeople, keptInUse, keptCompanies };
  // The removed rows themselves, so the undo can itself be reversed.
  await recordAudit({
    workspaceId: ws, actorUserId, action: "delete", entityType: "contact_import_undo", entityId: record.id,
    before: removed, after: summary,
  });
  await db.update(contactImports).set({ undoneAt: new Date(), undoneByUserId: actorUserId, undoSummary: summary as never })
    .where(and(eq(contactImports.id, record.id), eq(contactImports.workspaceId, ws), isNull(contactImports.undoneAt)));
  return summary;
}
