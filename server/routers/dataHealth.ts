import { TRPCError } from "@trpc/server";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { activities, contacts, emailDrafts, enrollments, opportunityContactRoles, prospects, prospectQueue } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { adminWsProcedure, repProcedure, workspaceProcedure } from "../_core/workspace";

export const dataHealthRouter = router({
  /**
   * Data Health describes PEOPLE (`prospects`), the sitewide person record.
   *
   * Owner directive 2026-08-17: one location for every person; the scrapers,
   * ARE, and enrichment all contribute to and read from People and Companies.
   * This procedure used to count `contacts` — the older CRM table that the
   * 0160 fold-in made a one-directional mirror of People — so it reported the
   * table enrichment never writes to. Live on 2026-08-16 that read "0 of 1,520
   * with email, 100% missing" for LSI while 1,505 People rows HAD emails, and
   * Home turned that into a paid-enrichment nudge (deep test report #4).
   *
   * Vocabulary note, checked against prod rather than the schema comment:
   * `prospects.emailStatus` carries Reoon's verdicts (valid / accept_all /
   * risky / invalid / unknown) — the comment saying "verified|unverified|
   * unavailable" is stale. So the four verification buckets map 1:1; nothing
   * is invented. `withCompany` means "has an employer" here (company name or
   * domain), not "linked to an account row" — People are enriched with an
   * employer long before association links them to a Companies record.
   */
  getMetrics: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const wsId = ctx.workspace.id;

    const [totals] = await db
      .select({
        total: count(),
        withEmail: sql<number>`SUM(CASE WHEN ${prospects.email} IS NOT NULL AND ${prospects.email} != '' THEN 1 ELSE 0 END)`,
        withPhone: sql<number>`SUM(CASE WHEN ${prospects.phone} IS NOT NULL AND ${prospects.phone} != '' THEN 1 ELSE 0 END)`,
        withCompany: sql<number>`SUM(CASE WHEN (${prospects.company} IS NOT NULL AND ${prospects.company} != '') OR (${prospects.companyDomain} IS NOT NULL AND ${prospects.companyDomain} != '') THEN 1 ELSE 0 END)`,
        withTitle: sql<number>`SUM(CASE WHEN ${prospects.title} IS NOT NULL AND ${prospects.title} != '' THEN 1 ELSE 0 END)`,
        withLinkedIn: sql<number>`SUM(CASE WHEN ${prospects.linkedinUrl} IS NOT NULL AND ${prospects.linkedinUrl} != '' THEN 1 ELSE 0 END)`,
        verifiedValid: sql<number>`SUM(CASE WHEN ${prospects.emailStatus} = 'valid' THEN 1 ELSE 0 END)`,
        verifiedAcceptAll: sql<number>`SUM(CASE WHEN ${prospects.emailStatus} = 'accept_all' THEN 1 ELSE 0 END)`,
        verifiedRisky: sql<number>`SUM(CASE WHEN ${prospects.emailStatus} = 'risky' THEN 1 ELSE 0 END)`,
        verifiedInvalid: sql<number>`SUM(CASE WHEN ${prospects.emailStatus} = 'invalid' THEN 1 ELSE 0 END)`,
        verifiedUnknown: sql<number>`SUM(CASE WHEN ${prospects.emailStatus} IS NULL OR ${prospects.emailStatus} = 'unknown' THEN 1 ELSE 0 END)`,
        enrichedLast90Days: sql<number>`SUM(CASE WHEN ${prospects.updatedAt} >= DATE_SUB(NOW(), INTERVAL 90 DAY) THEN 1 ELSE 0 END)`,
      })
      .from(prospects)
      .where(eq(prospects.workspaceId, wsId));

    // Estimate duplicates: people sharing the same email (excluding nulls)
    const [dupEmailResult] = await db.execute(
      sql`SELECT COUNT(*) as cnt FROM (
        SELECT email FROM ${prospects}
        WHERE workspaceId = ${wsId} AND email IS NOT NULL AND email != ''
        GROUP BY email HAVING COUNT(*) > 1
      ) t`
    ) as any;
    const dupEmailGroups = Number((dupEmailResult as any[])?.[0]?.cnt ?? 0);

    // People sharing the same firstName+lastName+company
    const [dupNameResult] = await db.execute(
      sql`SELECT COUNT(*) as cnt FROM (
        SELECT firstName, lastName, company FROM ${prospects}
        WHERE workspaceId = ${wsId} AND firstName IS NOT NULL AND lastName IS NOT NULL AND company IS NOT NULL AND company != ''
        GROUP BY firstName, lastName, company HAVING COUNT(*) > 1
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
        await db.update(contacts).set(patch).where(and(eq(contacts.id, input.primaryId), eq(contacts.workspaceId, wsId)));
      }

      // Re-point FK references from secondary → primary
      await db.update(activities).set({ relatedId: input.primaryId }).where(and(eq(activities.relatedType, "contact"), eq(activities.relatedId, input.secondaryId), eq(activities.workspaceId, wsId)));
      await db.update(emailDrafts).set({ toContactId: input.primaryId }).where(and(eq(emailDrafts.toContactId, input.secondaryId), eq(emailDrafts.workspaceId, wsId)));
      await db.update(enrollments).set({ contactId: input.primaryId }).where(and(eq(enrollments.contactId, input.secondaryId), eq(enrollments.workspaceId, wsId)));
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

  /**
   * How much data the old CSV column matcher mis-filed (fixed in 8c967cc).
   *
   * READ-ONLY, and deliberately not paired with a repair action: the counts
   * have to be read before anyone decides what — if anything — to change.
   * Admin-scoped because it reports every import in the workspace, including
   * other members' filenames and column mappings.
   */
  /**
   * One-shot: bring every linked contact up to date with its People row,
   * fill-only. The seam in personLink.mirrorPersonFieldsToContacts keeps them
   * aligned from here on; this catches up the rows that diverged BEFORE it
   * existed (LSI: 1,520 contacts with no email, People has them). Same rule
   * as the seam — a contact's existing value always wins; only gaps fill.
   * Admin-only and dry-run by default, because it writes to a CRM table.
   */
  syncContactsFromPeople: adminWsProcedure
    .input(z.object({ dryRun: z.boolean().default(true), limit: z.number().int().min(1).max(5000).default(5000) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const wsId = ctx.workspace.id;
      const rows = await db
        .select({
          contactId: contacts.id,
          cEmail: contacts.email, cPhone: contacts.phone, cTitle: contacts.title, cLinkedin: contacts.linkedinUrl,
          cCompany: contacts.companyName, cDomain: contacts.companyDomain,
          pEmail: prospects.email, pPhone: prospects.phone, pTitle: prospects.title, pLinkedin: prospects.linkedinUrl,
          pCompany: prospects.company, pDomain: prospects.companyDomain,
        })
        .from(contacts)
        .innerJoin(prospects, and(eq(prospects.id, contacts.personProspectId), eq(prospects.workspaceId, wsId)))
        .where(eq(contacts.workspaceId, wsId))
        .limit(input.limit);
      const empty = (v: unknown) => v === null || v === undefined || String(v).trim() === "";
      let scanned = 0, wouldFill = 0, filled = 0;
      const byField: Record<string, number> = {};
      for (const r of rows) {
        scanned++;
        const patch: Record<string, unknown> = {};
        const pairs: Array<[string, unknown, unknown, number]> = [
          ["email", r.cEmail, r.pEmail, 320], ["phone", r.cPhone, r.pPhone, 40], ["title", r.cTitle, r.pTitle, 120],
          ["linkedinUrl", r.cLinkedin, r.pLinkedin, 200], ["companyName", r.cCompany, r.pCompany, 200], ["companyDomain", r.cDomain, r.pDomain, 200],
        ];
        for (const [col, cur, from, width] of pairs) {
          if (empty(cur) && !empty(from)) { patch[col] = String(from).slice(0, width); byField[col] = (byField[col] ?? 0) + 1; }
        }
        if (Object.keys(patch).length === 0) continue;
        wouldFill++;
        if (!input.dryRun) {
          await db.update(contacts).set(patch as never)
            .where(and(eq(contacts.workspaceId, wsId), eq(contacts.id, r.contactId)));
          filled++;
        }
      }
      return { dryRun: input.dryRun, scanned, contactsWithGaps: wouldFill, filled, byField };
    }),

  /**
   * One-shot: push queue-row emails up to their linked People rows where the
   * People row has none. The seam in enrichmentSweeper now does this on every
   * new find; this catches up the rows the sweeper found BEFORE it did (CF:
   * 8 actively-sequenced prospects with a queue email and no People email).
   * Goes through mergeIntoPerson — provenance recorded, stronger values kept
   * — never a blind copy. Admin-only, dry-run by default.
   */
  syncPeopleFromQueue: adminWsProcedure
    .input(z.object({ dryRun: z.boolean().default(true), limit: z.number().int().min(1).max(5000).default(5000) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const wsId = ctx.workspace.id;
      const rows = await db
        .select({ queueId: prospectQueue.id, personId: prospectQueue.personProspectId, qEmail: prospectQueue.email, pEmail: prospects.email })
        .from(prospectQueue)
        .innerJoin(prospects, and(eq(prospects.id, prospectQueue.personProspectId), eq(prospects.workspaceId, wsId)))
        .where(and(
          eq(prospectQueue.workspaceId, wsId),
          sql`${prospectQueue.email} IS NOT NULL AND ${prospectQueue.email} <> ''`,
          sql`(${prospects.email} IS NULL OR ${prospects.email} = '')`,
        ))
        .limit(input.limit);
      // One push per PERSON — several queue rows can link to one People row.
      const byPerson = new Map<number, string>();
      for (const r of rows) if (r.personId && r.qEmail && !byPerson.has(r.personId)) byPerson.set(r.personId, r.qEmail);
      let pushed = 0;
      if (!input.dryRun) {
        const { mergeIntoPerson } = await import("../services/personLink");
        for (const [personId, email] of Array.from(byPerson.entries())) {
          await mergeIntoPerson(wsId, personId, { email, source: "sync_from_queue" });
          pushed++;
        }
      }
      return { dryRun: input.dryRun, queueRowsWithEmailPeopleWithout: rows.length, distinctPeople: byPerson.size, pushed };
    }),

  importMappingAudit: adminWsProcedure.query(async ({ ctx }) => {
    const { auditImportMappings } = await import("../services/importMappingAudit");
    return auditImportMappings(ctx.workspace.id);
  }),

  getDuplicateGroups: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const wsId = ctx.workspace.id;

    // Email duplicates
    const emailDups = await db.execute(
      sql`SELECT email, GROUP_CONCAT(id ORDER BY createdAt SEPARATOR ',') as ids,
          GROUP_CONCAT(CONCAT(firstName, ' ', lastName) ORDER BY createdAt SEPARATOR '||') as names,
          COUNT(*) as cnt
          FROM ${contacts}
          WHERE workspaceId = ${wsId} AND email IS NOT NULL AND email != ''
          GROUP BY email HAVING COUNT(*) > 1
          ORDER BY cnt DESC LIMIT 10`
    ) as any;

    // Name+account duplicates
    const nameDups = await db.execute(
      sql`SELECT CONCAT(firstName, ' ', lastName, ' (acct:', COALESCE(accountId, 0), ')') as key_val,
          GROUP_CONCAT(id ORDER BY createdAt SEPARATOR ',') as ids,
          GROUP_CONCAT(CONCAT(firstName, ' ', lastName) ORDER BY createdAt SEPARATOR '||') as names,
          COUNT(*) as cnt
          FROM ${contacts}
          WHERE workspaceId = ${wsId} AND firstName IS NOT NULL AND lastName IS NOT NULL AND accountId IS NOT NULL
          GROUP BY firstName, lastName, accountId HAVING COUNT(*) > 1
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

  /**
   * Provider effectiveness (roadmap P4.1) — which source actually EARNS its
   * keep. Zero new writes: the winning source per field already sits in
   * every prospect's field_provenance ledger; this is the GROUP BY the
   * audit said was "one query away". Bounded read of the ledger column only.
   */
  providerEffectiveness: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const { prospects } = await import("../../drizzle/schema");
    const rows = await db
      .select({ ledger: prospects.fieldProvenance })
      .from(prospects)
      .where(and(eq(prospects.workspaceId, ctx.workspace.id), sql`${prospects.fieldProvenance} IS NOT NULL`))
      .limit(5000);

    // source → field → { holding: rows where this source's value is current,
    //                    verified: of those, email rows Reoon judged valid }
    const bySource: Record<string, { total: number; fields: Record<string, number>; verifiedEmails: number }> = {};
    for (const r of rows) {
      const ledger = (r.ledger ?? {}) as Record<string, { source?: string; verification?: string } | undefined>;
      for (const [field, entry] of Object.entries(ledger)) {
        if (!entry?.source) continue;
        const s = (bySource[entry.source] ??= { total: 0, fields: {}, verifiedEmails: 0 });
        s.total++;
        s.fields[field] = (s.fields[field] ?? 0) + 1;
        if (field === "email" && entry.verification === "valid") s.verifiedEmails++;
      }
    }
    return {
      prospectsWithLedger: rows.length,
      sources: Object.entries(bySource)
        .map(([source, v]) => ({ source, ...v }))
        .sort((a, b) => b.total - a.total),
    };
  }),
});
