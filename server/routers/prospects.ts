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

/**
 * A prospect has a synthetic (non-person) name when it was created from a
 * company-level source like Google Places — firstName holds the business
 * name and lastName is a "(business)" placeholder. The importer/finder
 * stamps `enrichmentData.syntheticName = true` on those rows. Email-pattern
 * generation + Reoon must be skipped for them (see scraper/index.ts).
 */
function isSyntheticNameProspect(enrichmentData: unknown): boolean {
  return (
    !!enrichmentData &&
    typeof enrichmentData === "object" &&
    (enrichmentData as { syntheticName?: unknown }).syntheticName === true
  );
}
import { reoonCheckBalance, getReoonApiKey } from "../services/reoon";

export const prospectsRouter = router({
  list: workspaceProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        perPage: z.number().int().min(10).max(200).default(50),
        emailStatus: z.string().optional(),
        hasEmail: z.boolean().optional(),
        promoted: z.boolean().optional(),
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
        return { contactId: prospect.linkedContactId, created: false };
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
        syntheticName: isSyntheticNameProspect(p.enrichmentData),
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
            syntheticName: isSyntheticNameProspect(p.enrichmentData),
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
