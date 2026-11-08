/**
 * A list's members, one page at a time (audit 2026-10-20, P49, X4.1).
 *
 * recordLists.members read every member and then every member's whole row —
 * scraped emails and phones, enrichment blobs and all — and the page searched
 * and sorted them in the browser. Now the search, sort and page run in SQL
 * over member ids (ending in the member id, so a row is on one page), and
 * only the page's rows are read, with the columns the list shows.
 *
 * A People list shows its prospects, a Companies list its accounts; members
 * of another kind (a contact added by an old client) were never shown.
 *
 * Who counts as a member is one rule, `memberConds`, read by the page, the
 * people ids and the Lists index alike (audit 2026-10-20, P46, P50): the
 * index counted every membership row, so a deleted, foreign or mistyped
 * member was in the number and not on the page, and an archived company was
 * on the page. A membership whose record is deleted stays in the table and
 * is never shown or counted, so a person restored from the audit trail comes
 * back onto their lists.
 */
import { and, asc, desc, eq, exists, inArray, isNull, like, ne, or, sql, type SQL } from "drizzle-orm";
import { accounts, prospects, recordListMembers, recordLists } from "../../drizzle/schema";
import { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** A member a list of this kind shows: its own kind, a live record of this workspace, and no archived company. */
export function memberConds(ws: number, companies: boolean): SQL[] {
  return companies
    ? [eq(recordListMembers.workspaceId, ws), eq(recordListMembers.recordType, "account"), eq(accounts.workspaceId, ws), isNull(accounts.archivedAt)]
    : [eq(recordListMembers.workspaceId, ws), eq(recordListMembers.recordType, "prospect"), eq(prospects.workspaceId, ws)];
}

/** Each list's member count, by the same rule its page uses. */
export async function listMemberCounts(db: Db, ws: number): Promise<Map<number, number>> {
  const count = (companies: boolean) => {
    const rec = companies ? accounts : prospects;
    return db.select({ listId: recordListMembers.listId, c: sql<number>`count(*)` })
      .from(recordListMembers)
      .innerJoin(recordLists, eq(recordLists.id, recordListMembers.listId))
      .innerJoin(rec, eq(rec.id, recordListMembers.recordId))
      // Anything not "companies" is a People list, as listMemberPage reads it.
      .where(and(eq(recordLists.workspaceId, ws), companies ? eq(recordLists.entityType, "companies") : ne(recordLists.entityType, "companies"), ...memberConds(ws, companies)))
      .groupBy(recordListMembers.listId);
  };
  const [people, companies] = await Promise.all([count(false), count(true)]);
  return new Map([...people, ...companies].map((r) => [r.listId, Number(r.c)]));
}

export const PERSON_COLUMNS = {
  id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName, title: prospects.title,
  company: prospects.company, email: prospects.email, emailStatus: prospects.emailStatus,
  linkedinUrl: prospects.linkedinUrl, city: prospects.city, state: prospects.state, country: prospects.country,
};
export const COMPANY_COLUMNS = {
  id: accounts.id, name: accounts.name, domain: accounts.domain, industry: accounts.industry,
  region: accounts.region, arr: accounts.arr,
};
/** "Add all to…" acts on at most this many of a list's people. */
export const MAX_LIST_PROSPECT_IDS = 5000;

export type MemberPageInput = { id: number; page?: number; perPage?: number; search?: string; sort?: "added" | "name"; ownerUserId?: number };

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);

export async function listMemberPage(ws: number, input: MemberPageInput) {
  const page = Math.max(1, input.page ?? 1);
  const perPage = Math.min(500, Math.max(10, input.perPage ?? 100));
  const empty = { rows: [] as { memberId: number; recordType: string; recordId: number; addedAt: Date; record: Record<string, unknown> }[], total: 0, page, perPage, prospectIds: [] as number[] };
  const db = await getDb();
  if (!db) return empty;
  const [list] = await db.select({ entityType: recordLists.entityType }).from(recordLists)
    .where(and(eq(recordLists.id, input.id), eq(recordLists.workspaceId, ws))).limit(1);
  if (!list) return empty;
  const companies = list.entityType === "companies";
  const rec = companies ? accounts : prospects;

  const conds: SQL[] = [eq(recordListMembers.listId, input.id), ...memberConds(ws, companies)];
  const words = (input.search ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  for (const w of words) {
    const s = `%${escapeLike(w)}%`;
    conds.push(companies
      ? or(like(accounts.name, s), like(accounts.domain, s), like(accounts.industry, s))!
      : or(like(prospects.firstName, s), like(prospects.lastName, s), like(prospects.title, s), like(prospects.company, s), like(prospects.email, s))!);
  }
  /**
   * The owner filter (audit 2026-10-20, U31): a company's owner on a
   * Companies list; on a People list, the owner of the company the person is
   * filed under (People rows carry no owner of their own). Members in another
   * workspace's company never match.
   */
  if (input.ownerUserId) {
    if (companies) conds.push(eq(accounts.ownerUserId, input.ownerUserId));
    else conds.push(exists(db.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.id, prospects.accountId), eq(accounts.workspaceId, ws), eq(accounts.ownerUserId, input.ownerUserId)))));
  }
  const where = and(...conds);
  const order = input.sort === "name"
    ? (companies ? [asc(accounts.name), asc(recordListMembers.id)] : [asc(prospects.firstName), asc(prospects.lastName), asc(recordListMembers.id)])
    : [desc(recordListMembers.addedAt), desc(recordListMembers.id)];
  const joined = () => db.select({ id: recordListMembers.id }).from(recordListMembers)
    .innerJoin(rec, eq(rec.id, recordListMembers.recordId));

  const [pageIds, [{ total }], people] = await Promise.all([
    joined().where(where).orderBy(...order).limit(perPage).offset((page - 1) * perPage),
    db.select({ total: sql<number>`count(*)` }).from(recordListMembers).innerJoin(rec, eq(rec.id, recordListMembers.recordId)).where(where),
    companies ? Promise.resolve([] as { id: number }[]) :
      // This workspace's people only, the same check the page makes.
      db.select({ id: recordListMembers.recordId }).from(recordListMembers)
        .innerJoin(prospects, eq(prospects.id, recordListMembers.recordId))
        .where(and(eq(recordListMembers.listId, input.id), ...memberConds(ws, false)))
        .orderBy(desc(recordListMembers.addedAt), desc(recordListMembers.id)).limit(MAX_LIST_PROSPECT_IDS),
  ]);
  const ids = pageIds.map((r) => r.id);
  const prospectIds = people.map((r) => r.id);
  if (!ids.length) return { ...empty, total: Number(total), prospectIds };

  const rows = await db.select({
    memberId: recordListMembers.id, recordType: recordListMembers.recordType, recordId: recordListMembers.recordId,
    addedAt: recordListMembers.addedAt, ...(companies ? COMPANY_COLUMNS : PERSON_COLUMNS),
  }).from(recordListMembers).innerJoin(rec, eq(rec.id, recordListMembers.recordId))
    .where(and(...memberConds(ws, companies), inArray(recordListMembers.id, ids)));
  const byId = new Map(rows.map((r: any) => [r.memberId, r]));
  return {
    rows: ids.flatMap((id) => {
      const r: any = byId.get(id);
      if (!r) return [];
      const { memberId, recordType: rt, recordId, addedAt, ...record } = r;
      return [{ memberId, recordType: String(rt), recordId, addedAt, record }];
    }),
    total: Number(total), page, perPage, prospectIds,
  };
}
