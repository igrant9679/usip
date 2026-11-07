/**
 * websiteVisitors router — read side of the first-party visitor tracker.
 * Powers /v2/website-visitors: headline stats + recent known-visitor intent.
 */
import { and, desc, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { contacts, leads, prospects, websiteVisits, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { siteHost, trackedHostsFrom } from "../services/visitorLinks";

export const websiteVisitorsRouter = router({
  stats: workspaceProcedure.query(async ({ ctx }) => {
    const empty = { visits30d: 0, uniqueVisitors: 0, knownVisitors: 0, verifiedVisitors: 0, highIntent: 0 };
    const db = await getDb();
    if (!db) return empty;
    const since = new Date(Date.now() - 30 * 86400000);
    const [row] = await db
      .select({
        visits: sql<number>`count(*)`,
        uniques: sql<number>`count(distinct \`visitorId\`)`,
        known: sql<number>`count(distinct case when \`contactId\` is not null then concat('c', \`contactId\`) when \`leadId\` is not null then concat('l', \`leadId\`) when \`prospectId\` is not null then concat('p', \`prospectId\`) else null end)`,
        // People identified by a link id we signed (P88): these ARE who the stats say.
        verified: sql<number>`count(distinct case when \`signed\` = true then concat(coalesce(\`contactId\`, ''), '/', coalesce(\`leadId\`, ''), '/', coalesce(\`prospectId\`, '')) else null end)`,
        high: sql<number>`sum(case when \`intent\` = 'high' then 1 else 0 end)`,
      })
      .from(websiteVisits)
      .where(and(eq(websiteVisits.workspaceId, ctx.workspace.id), gte(websiteVisits.createdAt, since)));
    return {
      visits30d: Number(row?.visits ?? 0),
      uniqueVisitors: Number(row?.uniques ?? 0),
      knownVisitors: Number(row?.known ?? 0),
      verifiedVisitors: Number(row?.verified ?? 0),
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
          prospectId: websiteVisits.prospectId,
          signed: websiteVisits.signed,
          createdAt: websiteVisits.createdAt,
          contactFirst: contacts.firstName,
          contactLast: contacts.lastName,
          leadFirst: leads.firstName,
          leadLast: leads.lastName,
          leadCompany: leads.company,
          personFirst: prospects.firstName,
          personLast: prospects.lastName,
          personCompany: prospects.company,
        })
        .from(websiteVisits)
        // Both joins carry the workspace term. The visit rows are scoped, but
        // the JOINED record was matched by id alone — and until the write-side
        // check landed those ids came straight off a public beacon, so another
        // tenant's contact name and company rendered here. Scoped at the read
        // too, so rows already stored with a foreign id cannot resolve.
        .leftJoin(contacts, and(eq(contacts.id, websiteVisits.contactId), eq(contacts.workspaceId, ctx.workspace.id)))
        .leftJoin(leads, and(eq(leads.id, websiteVisits.leadId), eq(leads.workspaceId, ctx.workspace.id)))
        .leftJoin(prospects, and(eq(prospects.id, websiteVisits.prospectId), eq(prospects.workspaceId, ctx.workspace.id)))
        .where(and(
          eq(websiteVisits.workspaceId, ctx.workspace.id),
          or(isNotNull(websiteVisits.contactId), isNotNull(websiteVisits.leadId), isNotNull(websiteVisits.prospectId)),
        ))
        .orderBy(desc(websiteVisits.createdAt))
        .limit(input.limit ?? 100);
      return rows.map((r) => ({
        id: r.id,
        path: r.path,
        referrer: r.referrer,
        intent: r.intent,
        createdAt: r.createdAt,
        recordType: r.contactId ? "contact" : r.prospectId ? "prospect" : "lead",
        recordId: r.contactId ?? r.prospectId ?? r.leadId,
        name: r.contactId
          ? `${r.contactFirst ?? ""} ${r.contactLast ?? ""}`.trim()
          : r.prospectId
            ? `${r.personFirst ?? ""} ${r.personLast ?? ""}`.trim()
            : `${r.leadFirst ?? ""} ${r.leadLast ?? ""}`.trim(),
        company: r.leadCompany ?? r.personCompany ?? null,
        /** The link's id was one we signed: this IS the person (P88). */
        verified: !!r.signed,
      }));
    }),

  /**
   * Where outreach adds a signed visitor id (audit 2026-10-20, F40): the
   * company website's host plus the sites listed here, and whether click
   * tracking (the switch that allows it) is on.
   */
  trackedSites: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { hosts: [] as string[], companyWebsite: null as string | null, listed: "", clickTracking: true };
    const [row] = await db
      .select({ companyWebsite: workspaceSettings.companyWebsite, listed: workspaceSettings.trackedSiteDomains, click: workspaceSettings.emailClickTracking })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
      .limit(1);
    return {
      hosts: trackedHostsFrom(row?.companyWebsite, row?.listed),
      companyWebsite: row?.companyWebsite ?? null,
      listed: row?.listed ?? "",
      clickTracking: row?.click !== false,
    };
  }),

  /** More of the workspace's own sites, beside the company website (F40). Admins only. */
  setTrackedSites: adminWsProcedure
    .input(z.object({ domains: z.string().max(1000) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const parts = input.domains.split(/[\s,;]+/).map((d) => d.trim()).filter(Boolean);
      const bad = parts.filter((d) => !siteHost(d));
      if (bad.length) throw new TRPCError({ code: "BAD_REQUEST", message: `Not a website address: ${bad.slice(0, 3).join(", ")}` });
      const hosts = Array.from(new Set(parts.map((d) => siteHost(d)!)));
      const value = hosts.join(", ").slice(0, 1000) || null;
      const [exists] = await db.select({ id: workspaceSettings.workspaceId }).from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id)).limit(1);
      if (exists) {
        await db.update(workspaceSettings).set({ trackedSiteDomains: value } as never).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      } else {
        await db.insert(workspaceSettings).values({ workspaceId: ctx.workspace.id, trackedSiteDomains: value } as never);
      }
      return { ok: true as const, hosts };
    }),
});
