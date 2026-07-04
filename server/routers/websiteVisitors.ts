/**
 * websiteVisitors router — read side of the first-party visitor tracker.
 * Powers /v2/website-visitors: headline stats + recent known-visitor intent.
 */
import { and, desc, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { contacts, leads, websiteVisits } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";

export const websiteVisitorsRouter = router({
  stats: workspaceProcedure.query(async ({ ctx }) => {
    const empty = { visits30d: 0, uniqueVisitors: 0, knownVisitors: 0, highIntent: 0 };
    const db = await getDb();
    if (!db) return empty;
    const since = new Date(Date.now() - 30 * 86400000);
    const [row] = await db
      .select({
        visits: sql<number>`count(*)`,
        uniques: sql<number>`count(distinct \`visitorId\`)`,
        known: sql<number>`count(distinct case when \`contactId\` is not null then concat('c', \`contactId\`) when \`leadId\` is not null then concat('l', \`leadId\`) else null end)`,
        high: sql<number>`sum(case when \`intent\` = 'high' then 1 else 0 end)`,
      })
      .from(websiteVisits)
      .where(and(eq(websiteVisits.workspaceId, ctx.workspace.id), gte(websiteVisits.createdAt, since)));
    return {
      visits30d: Number(row?.visits ?? 0),
      uniqueVisitors: Number(row?.uniques ?? 0),
      knownVisitors: Number(row?.known ?? 0),
      highIntent: Number(row?.high ?? 0),
    };
  }),

  /** Recent KNOWN-visitor page views (attributed to a contact/lead), enriched with the name. */
  listKnown: workspaceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [] as any[];
      const rows = await db
        .select({
          id: websiteVisits.id,
          path: websiteVisits.path,
          referrer: websiteVisits.referrer,
          intent: websiteVisits.intent,
          contactId: websiteVisits.contactId,
          leadId: websiteVisits.leadId,
          createdAt: websiteVisits.createdAt,
          contactFirst: contacts.firstName,
          contactLast: contacts.lastName,
          leadFirst: leads.firstName,
          leadLast: leads.lastName,
          leadCompany: leads.company,
        })
        .from(websiteVisits)
        .leftJoin(contacts, eq(contacts.id, websiteVisits.contactId))
        .leftJoin(leads, eq(leads.id, websiteVisits.leadId))
        .where(and(
          eq(websiteVisits.workspaceId, ctx.workspace.id),
          or(isNotNull(websiteVisits.contactId), isNotNull(websiteVisits.leadId)),
        ))
        .orderBy(desc(websiteVisits.createdAt))
        .limit(input.limit ?? 100);
      return rows.map((r) => ({
        id: r.id,
        path: r.path,
        referrer: r.referrer,
        intent: r.intent,
        createdAt: r.createdAt,
        recordType: r.contactId ? "contact" : "lead",
        recordId: r.contactId ?? r.leadId,
        name: r.contactId
          ? `${r.contactFirst ?? ""} ${r.contactLast ?? ""}`.trim()
          : `${r.leadFirst ?? ""} ${r.leadLast ?? ""}`.trim(),
        company: r.leadCompany ?? null,
      }));
    }),
});
