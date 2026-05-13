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
});
