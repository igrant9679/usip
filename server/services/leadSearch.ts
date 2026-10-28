/**
 * The Leads list, paged in SQL (audit 2026-10-20, R49, X4.1).
 *
 * leads.list read every lead in the workspace, filtered by status and search
 * in JavaScript, and sorted by score alone — so the page re-downloaded the
 * whole table on every keystroke, and leads with the same score came back in
 * a different order each time. Now the filter runs in SQL, the sort ends in
 * the id (one order, so a lead is on exactly one page), and like company
 * search (services/company/searchService.ts) the page's ids are found first
 * and only those rows are read.
 */
import { and, desc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { leads } from "../../drizzle/schema";
import { getDb } from "../db";

export type LeadFilters = { status?: string; search?: string };

/** What a row of the Leads table and its CSV show. */
export const LEAD_LIST_COLUMNS = {
  id: leads.id, firstName: leads.firstName, lastName: leads.lastName, email: leads.email,
  phone: leads.phone, company: leads.company, title: leads.title, source: leads.source,
  status: leads.status, score: leads.score, grade: leads.grade, ownerUserId: leads.ownerUserId,
  aiNextAction: leads.aiNextAction, aiNextActionNote: leads.aiNextActionNote, createdAt: leads.createdAt,
};

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * Each word of the search must appear in the first name, last name, company
 * or email — "jane acme" finds Jane at Acme, as the old in-browser filter did
 * over "first last company email".
 */
export function leadWhere(ws: number, f: LeadFilters = {}): SQL {
  const conds: SQL[] = [eq(leads.workspaceId, ws)];
  if (f.status) conds.push(eq(leads.status, f.status as any));
  const words = (f.search ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  for (const w of words) {
    const s = `%${escapeLike(w)}%`;
    conds.push(or(like(leads.firstName, s), like(leads.lastName, s), like(leads.company, s), like(leads.email, s))!);
  }
  return and(...conds)!;
}

/** Highest score first; leads that tie keep one order, newest first. */
export const LEAD_ORDER = [desc(leads.score), desc(leads.id)];

export async function searchLeads(ws: number, opts: LeadFilters & { page?: number; perPage?: number }) {
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.min(200, Math.max(10, opts.perPage ?? 50));
  const db = await getDb();
  if (!db) return { rows: [], total: 0, page, perPage };
  const where = leadWhere(ws, opts);
  const [pageIds, [{ total }]] = await Promise.all([
    db.select({ id: leads.id }).from(leads).where(where).orderBy(...LEAD_ORDER).limit(perPage).offset((page - 1) * perPage),
    db.select({ total: sql<number>`count(*)` }).from(leads).where(where),
  ]);
  const ids = pageIds.map((r) => r.id);
  if (!ids.length) return { rows: [], total: Number(total), page, perPage };
  const rows = await db.select(LEAD_LIST_COLUMNS).from(leads).where(and(eq(leads.workspaceId, ws), inArray(leads.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { rows: ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r), total: Number(total), page, perPage };
}
