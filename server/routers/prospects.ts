/**
 * Prospects router — manual prospect list management.
 *
 * Reads/writes the `prospects` table. Sourcing is now done via CSV upload
 * (e.g. LeadRocks exports). The old Clodura search/reveal/credits surface
 * has been removed; legacy `clodura_*` columns on the prospects table are
 * preserved for back-compat but unused by new rows.
 *
 * Procedures:
 *   list              — paginated list with optional filters
 *   promoteToContact  — idempotently create / link a contact from a prospect
 *   delete            — remove a single prospect (keeps linked contact)
 *   bulkDelete        — remove many prospects at once
 */
import { z } from "zod";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { contacts, prospects } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { lookupContactInfo, type LookupResult } from "../services/scraper";
// Shared synthetic-name detector — anchored to the lastName sentinel so it
// keeps working after the scraper overwrites enrichmentData. See
// services/prospectFromSource.ts.
import { isSyntheticNameProspect } from "../services/prospectFromSource";
import { reoonCheckBalance, getReoonApiKey } from "../services/reoon";

export const prospectsRouter = router({
  /** Fetch a single prospect (powers the /prospects/:id detail page). */
  get: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [row] = await db
        .select()
        .from(prospects)
        .where(and(eq(prospects.id, input.id), eq(prospects.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return row;
    }),

  /** Manual edit of any user-facing field. Persists who/when via audit log
   *  but does NOT touch confidence/verification fields — those reflect
   *  pipeline truth and should only change via re-enrichment. */
  update: workspaceProcedure
    .input(z.object({
      id: z.number().int(),
      firstName: z.string().min(1).max(80).optional(),
      lastName: z.string().min(1).max(80).optional(),
      title: z.string().max(200).nullable().optional(),
      company: z.string().max(200).nullable().optional(),
      companyDomain: z.string().max(200).nullable().optional(),
      linkedinUrl: z.string().max(500).nullable().optional(),
      email: z.string().max(320).nullable().optional(),
      phone: z.string().max(40).nullable().optional(),
      city: z.string().max(80).nullable().optional(),
      state: z.string().max(80).nullable().optional(),
      country: z.string().max(80).nullable().optional(),
      industry: z.string().max(80).nullable().optional(),
      verificationStatus: z.enum(["verified", "needs_review", "rejected"]).optional(),
      verificationNotes: z.string().max(2000).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db.select().from(prospects)
        .where(and(eq(prospects.id, input.id), eq(prospects.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!before) throw new TRPCError({ code: "NOT_FOUND" });
      const { id, ...rest } = input;
      const patch: Partial<typeof prospects.$inferInsert> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) (patch as any)[k] = v;
      }
      if (Object.keys(patch).length === 0) return { ok: true };
      await db.update(prospects).set(patch)
        .where(and(eq(prospects.id, id), eq(prospects.workspaceId, ctx.workspace.id)));
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "prospect",
        entityId: id,
        before,
        after: { ...before, ...patch },
      });
      return { ok: true };
    }),

  /** Soft-archive — flips verificationStatus to 'rejected'. Keeps the row
   *  for audit/history; bulkDelete is still available for hard removal. */
  archive: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(prospects)
        .set({ verificationStatus: "rejected" })
        .where(and(eq(prospects.id, input.id), eq(prospects.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  /** Re-run discovery scoped to one prospect — uses their stored
   *  name+company to launch a focused person-mode search. The pipeline's
   *  merge-on-dedup logic updates this prospect's row in place rather
   *  than creating a duplicate. */
  reEnrich: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [p] = await db.select().from(prospects)
        .where(and(eq(prospects.id, input.id), eq(prospects.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!p) throw new TRPCError({ code: "NOT_FOUND" });
      const { runDiscovery } = await import("../services/discovery");
      return runDiscovery(ctx.workspace.id, ctx.user.id, "person", {
        jobTitle: p.title ?? undefined,
        industry: p.industry ?? undefined,
        companyName: p.company ?? undefined,
        location: [p.city, p.state, p.country].filter(Boolean).join(", ") || undefined,
        keywords: [`${p.firstName} ${p.lastName}`].filter(Boolean),
      });
    }),

  list: workspaceProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        perPage: z.number().int().min(10).max(200).default(50),
        emailStatus: z.string().optional(),
        hasEmail: z.boolean().optional(),
        promoted: z.boolean().optional(),
        /** Discovery v2: filter by verification status to power the
         *  Needs Review queue and the verified-only feed. */
        verificationStatus: z.enum(["verified", "needs_review", "rejected"]).optional(),
        /** Filter by which discovery run produced/last-touched the row. */
        discoveryRunId: z.number().int().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const conditions = [eq(prospects.workspaceId, ctx.workspace.id)];
      if (input.emailStatus) conditions.push(eq(prospects.emailStatus, input.emailStatus));
      if (input.hasEmail === true) conditions.push(sql`${prospects.email} IS NOT NULL`);
      if (input.hasEmail === false) conditions.push(isNull(prospects.email));
      if (input.promoted === true) conditions.push(sql`${prospects.linkedContactId} IS NOT NULL`);
      if (input.promoted === false) conditions.push(isNull(prospects.linkedContactId));
      if (input.verificationStatus) conditions.push(eq(prospects.verificationStatus, input.verificationStatus));
      if (input.discoveryRunId) conditions.push(eq(prospects.lastDiscoveryRunId, input.discoveryRunId));

      const offset = (input.page - 1) * input.perPage;
      const rows = await db
        .select()
        .from(prospects)
        .where(and(...conditions))
        .orderBy(desc(prospects.createdAt))
        .limit(input.perPage)
        .offset(offset);

      const [{ total }] = await db
        .select({ total: sql<number>`count(*)` })
        .from(prospects)
        .where(and(...conditions));

      return { data: rows, total: Number(total), page: input.page, perPage: input.perPage };
    }),

  /**
   * Delete a single prospect. If they were promoted, the contact row stays
   * untouched (delete via contacts.delete if you want it gone too).
   */
  delete: workspaceProcedure
    .input(z.object({ prospectId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db
        .select()
        .from(prospects)
        .where(
          and(
            eq(prospects.id, input.prospectId),
            eq(prospects.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);
      if (!before) throw new TRPCError({ code: "NOT_FOUND" });
      await db
        .delete(prospects)
        .where(
          and(
            eq(prospects.id, input.prospectId),
            eq(prospects.workspaceId, ctx.workspace.id),
          ),
        );
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "delete",
        entityType: "prospect",
        entityId: input.prospectId,
        before,
      });
      return { ok: true, hadLinkedContact: Boolean(before.linkedContactId) };
    }),

  bulkDelete: workspaceProcedure
    .input(z.object({ prospectIds: z.array(z.number().int()).min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select({ id: prospects.id, linkedContactId: prospects.linkedContactId })
        .from(prospects)
        .where(
          and(
            eq(prospects.workspaceId, ctx.workspace.id),
            inArray(prospects.id, input.prospectIds),
          ),
        );
      if (rows.length === 0) return { deleted: 0, hadLinkedContacts: 0 };
      await db
        .delete(prospects)
        .where(
          and(
            eq(prospects.workspaceId, ctx.workspace.id),
            inArray(prospects.id, rows.map((r) => r.id)),
          ),
        );
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "delete",
        entityType: "prospect_bulk",
        entityId: 0,
        after: { ids: rows.map((r) => r.id) },
      });
      return {
        deleted: rows.length,
        hadLinkedContacts: rows.filter((r) => r.linkedContactId).length,
      };
    }),

  /**
   * Promote a prospect to a contact. Idempotent:
   *   - If already linked, returns the existing contact id.
   *   - If a contact with the same email already exists, links to it.
   *   - Otherwise inserts a new contact and links.
   */
  promoteToContact: workspaceProcedure
    .input(z.object({ prospectId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [prospect] = await db
        .select()
        .from(prospects)
        .where(and(eq(prospects.id, input.prospectId), eq(prospects.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!prospect) throw new TRPCError({ code: "NOT_FOUND", message: "Prospect not found" });

      if (prospect.linkedContactId) {
        // Only trust the link if the contact still exists — contacts can be
        // deleted out from under a prospect (e.g. a bulk contact purge), leaving
        // a stale linkedContactId that makes Promote a silent permanent no-op.
        const [stillThere] = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.id, prospect.linkedContactId), eq(contacts.workspaceId, ctx.workspace.id)))
          .limit(1);
        if (stillThere) {
          return { contactId: prospect.linkedContactId, created: false };
        }
        // Stale link: the contact was deleted. Clear it and fall through to re-create.
        await db
          .update(prospects)
          .set({ linkedContactId: null })
          .where(and(eq(prospects.id, input.prospectId), eq(prospects.workspaceId, ctx.workspace.id)));
      }

      let contactId: number | null = null;
      if (prospect.email) {
        const [existing] = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.workspaceId, ctx.workspace.id),
              eq(contacts.email, prospect.email),
            ),
          )
          .limit(1);
        if (existing) contactId = existing.id;
      }

      if (!contactId) {
        const [inserted] = await db.insert(contacts).values({
          workspaceId: ctx.workspace.id,
          firstName: prospect.firstName,
          lastName: prospect.lastName,
          title: prospect.title ?? null,
          email: prospect.email ?? null,
          phone: prospect.phone ?? null,
          linkedinUrl: prospect.linkedinUrl ?? null,
          city: prospect.city ?? null,
          functionalArea: prospect.functionalArea ?? null,
          industry: prospect.industry ?? null,
          companyDomain: prospect.companyDomain ?? null,
          seniority: prospect.seniority ?? null,
          sourceProspectId: prospect.id,
        } as never);
        contactId = (inserted as { insertId: number }).insertId;
      }

      await db
        .update(prospects)
        .set({ linkedContactId: contactId! })
        .where(eq(prospects.id, input.prospectId));

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "contact_from_prospect",
        entityId: contactId!,
        after: { prospectId: input.prospectId },
      });

      return { contactId: contactId!, created: true };
    }),

  /**
   * Find contact info for a single prospect.
   *
   * Pipeline (see server/services/scraper):
   *   1. Resolve company domain
   *   2. Scrape company website (cached 30d per domain)
   *   3. Generate up to 3 email patterns + Reoon-verify (early-stop on valid)
   *   4. Pick winning email by status, write back to prospect row
   *
   * Synchronous — call site should expect ~5–10s of latency per call.
   * Returns the full LookupResult so the UI can show what was found.
   */
  findContactInfo: workspaceProcedure
    .input(
      z.object({
        prospectId: z.number().int(),
        /** If true, won't overwrite existing prospect.email. Default true. */
        skipIfHasEmail: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<LookupResult> => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [p] = await db
        .select()
        .from(prospects)
        .where(
          and(
            eq(prospects.id, input.prospectId),
            eq(prospects.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);
      if (!p) throw new TRPCError({ code: "NOT_FOUND" });

      const result = await lookupContactInfo({
        workspaceId: ctx.workspace.id,
        prospectId: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        companyDomain: p.companyDomain ?? null,
        existingPhone: p.phone ?? null,
        skipIfHasEmail: input.skipIfHasEmail && Boolean(p.email),
        syntheticName: isSyntheticNameProspect(p),
      });

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "prospect",
        entityId: p.id,
        after: {
          enrichment: "scraper.findContactInfo",
          foundEmail: result.email,
          reoonCredits: result.reoonCredits,
          reoonCreditsQuick: result.reoonCreditsQuick,
          reoonCreditsPower: result.reoonCreditsPower,
        },
      });

      return result;
    }),

  /**
   * Find contact info for up to 25 prospects in one shot.
   *
   * Runs lookups serially (NOT Promise.all — we want the per-domain rate
   * limiter inside companySite.ts to work properly, and we don't want to
   * flood Reoon with parallel requests that might hit per-second caps).
   * For larger batches, the right answer is a background-job system — TODO.
   */
  findContactInfoBatch: workspaceProcedure
    .input(
      z.object({
        prospectIds: z.array(z.number().int()).min(1).max(25),
        skipIfHasEmail: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const rows = await db
        .select()
        .from(prospects)
        .where(
          and(
            eq(prospects.workspaceId, ctx.workspace.id),
            inArray(prospects.id, input.prospectIds),
          ),
        );

      const results: Array<{ prospectId: number; result: LookupResult }> = [];
      let creditsQuick = 0;
      let creditsPower = 0;
      let withEmail = 0;
      let withoutEmail = 0;

      for (const p of rows) {
        try {
          const result = await lookupContactInfo({
            workspaceId: ctx.workspace.id,
            prospectId: p.id,
            firstName: p.firstName,
            lastName: p.lastName,
            companyDomain: p.companyDomain ?? null,
            existingPhone: p.phone ?? null,
            skipIfHasEmail: input.skipIfHasEmail && Boolean(p.email),
            syntheticName: isSyntheticNameProspect(p),
          });
          creditsQuick += result.reoonCreditsQuick;
          creditsPower += result.reoonCreditsPower;
          if (result.email) withEmail++;
          else withoutEmail++;
          results.push({ prospectId: p.id, result });
        } catch (e) {
          // One prospect's failure shouldn't kill the batch
          withoutEmail++;
          results.push({
            prospectId: p.id,
            result: {
              ok: false,
              email: null,
              emailStatus: null,
              phone: null,
              enrichment: {
                scrapedDomain: null,
                scrapedAt: new Date().toISOString(),
                emailsFound: [],
                phonesFound: [],
                socialUrls: [],
                patternsVerified: [],
                skipReason: "exception",
              },
              reoonCredits: 0,
              reoonCreditsQuick: 0,
              reoonCreditsPower: 0,
              message: (e as Error).message,
            },
          });
        }
      }

      const totalCredits = creditsQuick + creditsPower;
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "prospect_bulk",
        entityId: 0,
        after: {
          enrichment: "scraper.findContactInfoBatch",
          processed: rows.length,
          withEmail,
          withoutEmail,
          reoonCredits: totalCredits,
          reoonCreditsQuick: creditsQuick,
          reoonCreditsPower: creditsPower,
        },
      });

      return {
        processed: rows.length,
        withEmail,
        withoutEmail,
        reoonCredits: totalCredits,
        reoonCreditsQuick: creditsQuick,
        reoonCreditsPower: creditsPower,
        results,
      };
    }),

  /** Check remaining Reoon daily/instant credits. Used by the UI header. */
  reoonBalance: workspaceProcedure.query(async () => {
    try {
      const apiKey = getReoonApiKey();
      return await reoonCheckBalance(apiKey);
    } catch (e) {
      // Don't fail the page render if Reoon is unconfigured / down
      return {
        api_status: "error",
        status: "error",
        remaining_daily_credits: 0,
        remaining_instant_credits: 0,
        error: (e as Error).message,
      };
    }
  }),
});
