import { TRPCError } from "@trpc/server";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { activities, contacts, emailDrafts, enrollments, opportunityContactRoles } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { repProcedure, workspaceProcedure } from "../_core/workspace";

export const dataHealthRouter = router({
  getMetrics: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const wsId = ctx.workspace.id;

    const [totals] = await db
      .select({
        total: count(),
        withEmail: sql<number>`SUM(CASE WHEN ${contacts.email} IS NOT NULL AND ${contacts.email} != '' THEN 1 ELSE 0 END)`,
        withPhone: sql<number>`SUM(CASE WHEN ${contacts.phone} IS NOT NULL AND ${contacts.phone} != '' THEN 1 ELSE 0 END)`,
        withCompany: sql<number>`SUM(CASE WHEN ${contacts.accountId} IS NOT NULL THEN 1 ELSE 0 END)`,
        withTitle: sql<number>`SUM(CASE WHEN ${contacts.title} IS NOT NULL AND ${contacts.title} != '' THEN 1 ELSE 0 END)`,
        withLinkedIn: sql<number>`SUM(CASE WHEN ${contacts.linkedinUrl} IS NOT NULL AND ${contacts.linkedinUrl} != '' THEN 1 ELSE 0 END)`,
        verifiedValid: sql<number>`SUM(CASE WHEN ${contacts.emailVerificationStatus} = 'valid' THEN 1 ELSE 0 END)`,
        verifiedAcceptAll: sql<number>`SUM(CASE WHEN ${contacts.emailVerificationStatus} = 'accept_all' THEN 1 ELSE 0 END)`,
        verifiedRisky: sql<number>`SUM(CASE WHEN ${contacts.emailVerificationStatus} = 'risky' THEN 1 ELSE 0 END)`,
        verifiedInvalid: sql<number>`SUM(CASE WHEN ${contacts.emailVerificationStatus} = 'invalid' THEN 1 ELSE 0 END)`,
        verifiedUnknown: sql<number>`SUM(CASE WHEN ${contacts.emailVerificationStatus} IS NULL THEN 1 ELSE 0 END)`,
        enrichedLast90Days: sql<number>`SUM(CASE WHEN ${contacts.updatedAt} >= DATE_SUB(NOW(), INTERVAL 90 DAY) THEN 1 ELSE 0 END)`,
      })
      .from(contacts)
      .where(eq(contacts.workspaceId, wsId));

    // Estimate duplicates: contacts sharing the same email (excluding nulls)
    const [dupEmailResult] = await db.execute(
      sql`SELECT COUNT(*) as cnt FROM (
        SELECT email FROM ${contacts}
        WHERE workspace_id = ${wsId} AND email IS NOT NULL AND email != ''
        GROUP BY email HAVING COUNT(*) > 1
      ) t`
    ) as any;
    const dupEmailGroups = Number((dupEmailResult as any[])?.[0]?.cnt ?? 0);

    // Contacts sharing same firstName+lastName+company
    const [dupNameResult] = await db.execute(
      sql`SELECT COUNT(*) as cnt FROM (
        SELECT first_name, last_name, company FROM ${contacts}
        WHERE workspace_id = ${wsId} AND first_name IS NOT NULL AND last_name IS NOT NULL AND company IS NOT NULL
        GROUP BY first_name, last_name, company HAVING COUNT(*) > 1
      ) t`
    ) as any;
    const dupNameGroups = Number((dupNameResult as any[])?.[0]?.cnt ?? 0);

    const t = totals;
    const total = Number(t.total);
    return {
      total,
      withEmail: Number(t.withEmail),
      withPhone: Number(t.withPhone),
      withCompany: Number(t.withCompany),
      withTitle: Number(t.withTitle),
      withLinkedIn: Number(t.withLinkedIn),
      verifiedValid: Number(t.verifiedValid),
      verifiedAcceptAll: Number(t.verifiedAcceptAll),
      verifiedRisky: Number(t.verifiedRisky),
      verifiedInvalid: Number(t.verifiedInvalid),
      verifiedUnknown: Number(t.verifiedUnknown),
      enrichedLast90Days: Number(t.enrichedLast90Days),
      estimatedDuplicates: dupEmailGroups + dupNameGroups,
      pctWithEmail: total > 0 ? Math.round((Number(t.withEmail) / total) * 100) : 0,
      pctWithPhone: total > 0 ? Math.round((Number(t.withPhone) / total) * 100) : 0,
      pctEnriched: total > 0 ? Math.round((Number(t.enrichedLast90Days) / total) * 100) : 0,
      pctVerified: total > 0 ? Math.round(((Number(t.verifiedValid) + Number(t.verifiedAcceptAll) + Number(t.verifiedRisky) + Number(t.verifiedInvalid)) / total) * 100) : 0,
    };
  }),

  /** Merge duplicate contacts: keep primary, copy missing fields from secondary, re-point FK references, delete secondary. */
  mergeContacts: repProcedure
    .input(z.object({
      primaryId: z.number(),
      secondaryId: z.number(),
      /** Which fields to take from secondary (overrides primary's empty/null value). */
      overrideFields: z.array(z.string()).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const wsId = ctx.workspace.id;

      const [primary] = await db.select().from(contacts).where(and(eq(contacts.id, input.primaryId), eq(contacts.workspaceId, wsId)));
      const [secondary] = await db.select().from(contacts).where(and(eq(contacts.id, input.secondaryId), eq(contacts.workspaceId, wsId)));
      if (!primary || !secondary) throw new TRPCError({ code: "NOT_FOUND", message: "One or both contacts not found" });

      // Build patch: fill empty primary fields from secondary, or use overrideFields
      const fillable: (keyof typeof primary)[] = ["title", "phone", "linkedinUrl", "city", "seniority", "accountId"];
      const patch: Record<string, any> = {};
      for (const field of fillable) {
        const pVal = primary[field];
        const sVal = secondary[field];
        if (input.overrideFields.includes(field)) {
          if (sVal !== null && sVal !== undefined && sVal !== "") patch[field] = sVal;
        } else if ((pVal === null || pVal === undefined || pVal === "") && sVal !== null && sVal !== undefined && sVal !== "") {
          patch[field] = sVal;
        }
      }
      if (Object.keys(patch).length > 0) {
        await db.update(contacts).set(patch).where(eq(contacts.id, input.primaryId));
      }

      // Re-point FK references from secondary → primary
      await db.update(activities).set({ relatedId: input.primaryId }).where(and(eq(activities.relatedType, "contact"), eq(activities.relatedId, input.secondaryId)));
      await db.update(emailDrafts).set({ toContactId: input.primaryId }).where(eq(emailDrafts.toContactId, input.secondaryId));
      await db.update(enrollments).set({ contactId: input.primaryId }).where(eq(enrollments.contactId, input.secondaryId));
      // For opportunity contact roles, delete the secondary's role if primary already has one on the same opp
      const secRoles = await db.select().from(opportunityContactRoles).where(and(eq(opportunityContactRoles.contactId, input.secondaryId), eq(opportunityContactRoles.workspaceId, wsId)));
      for (const role of secRoles) {
        const existing = await db.select().from(opportunityContactRoles).where(and(eq(opportunityContactRoles.opportunityId, role.opportunityId), eq(opportunityContactRoles.contactId, input.primaryId), eq(opportunityContactRoles.workspaceId, wsId)));
        if (existing.length > 0) {
          await db.delete(opportunityContactRoles).where(eq(opportunityContactRoles.id, role.id));
        } else {
          await db.update(opportunityContactRoles).set({ contactId: input.primaryId }).where(eq(opportunityContactRoles.id, role.id));
        }
      }

      // Delete the secondary contact
      await db.delete(contacts).where(and(eq(contacts.id, input.secondaryId), eq(contacts.workspaceId, wsId)));

      return { ok: true, primaryId: input.primaryId, mergedFields: Object.keys(patch) };
    }),

  getDuplicateGroups: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const wsId = ctx.workspace.id;

    // Email duplicates
    const emailDups = await db.execute(
      sql`SELECT email, GROUP_CONCAT(id ORDER BY created_at SEPARATOR ',') as ids,
          GROUP_CONCAT(CONCAT(first_name, ' ', last_name) ORDER BY created_at SEPARATOR '||') as names,
          COUNT(*) as cnt
          FROM ${contacts}
          WHERE workspace_id = ${wsId} AND email IS NOT NULL AND email != ''
          GROUP BY email HAVING COUNT(*) > 1
          ORDER BY cnt DESC LIMIT 10`
    ) as any;

    // Name+account duplicates
    const nameDups = await db.execute(
      sql`SELECT CONCAT(first_name, ' ', last_name, ' (acct:', COALESCE(accountId, 0), ')') as key_val,
          GROUP_CONCAT(id ORDER BY created_at SEPARATOR ',') as ids,
          GROUP_CONCAT(CONCAT(first_name, ' ', last_name) ORDER BY created_at SEPARATOR '||') as names,
          COUNT(*) as cnt
          FROM ${contacts}
          WHERE workspace_id = ${wsId} AND first_name IS NOT NULL AND last_name IS NOT NULL AND accountId IS NOT NULL
          GROUP BY first_name, last_name, accountId HAVING COUNT(*) > 1
          ORDER BY cnt DESC LIMIT 10`
    ) as any;

    const rows = (emailDups as any[])[0] ?? [];
    const nameRows = (nameDups as any[])[0] ?? [];

    const mapGroup = (row: any, type: "email" | "name") => ({
      type,
      key: type === "email" ? row.email : row.key_val,
      ids: String(row.ids).split(","),
      names: String(row.names).split("||"),
      count: Number(row.cnt),
    });

    return [
      ...rows.map((r: any) => mapGroup(r, "email")),
      ...nameRows.map((r: any) => mapGroup(r, "name")),
    ].slice(0, 20);
  }),
});
