/**
 * LinkedIn Finder router — backs the "LinkedIn" tab on /find-prospects.
 *
 * Procedures:
 *   - listAccounts  (workspace) — bridged LinkedIn accounts the caller may
 *                                 use (own for reps; full pool for admins),
 *                                 each with today's usage / remaining
 *   - lookup        (workspace) — resolve a LinkedIn URL → profile via the
 *                                 chosen / auto-picked account, rate-limited
 *   - saveAsProspect(workspace) — persist a (user-edited) profile as a
 *                                 prospect row
 *
 * The heavy lifting (URL parse, account pick, rate limit, Unipile call,
 * audit log) lives in services/linkedinLookup.ts.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { prospects } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import {
  listUsableAccounts,
  lookupProfile,
  searchLinkedInProfiles,
  LINKEDIN_DAILY_CAP,
} from "../services/linkedinLookup";
import { buildScrapedProspectValues } from "../services/prospectFromSource";

function isAdminRole(role: string): boolean {
  return role === "admin" || role === "super_admin";
}

export const linkedinFinderRouter = router({
  /** Bridged LinkedIn accounts the caller can route lookups through. */
  listAccounts: workspaceProcedure.query(async ({ ctx }) => {
    const isAdmin = isAdminRole(ctx.member.role);
    const accounts = await listUsableAccounts({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      isAdmin,
    });
    return {
      dailyCap: LINKEDIN_DAILY_CAP,
      isAdmin,
      accounts,
    };
  }),

  /** Look up a LinkedIn profile URL. Rate-limited per bridged account. */
  lookup: workspaceProcedure
    .input(
      z.object({
        linkedinUrl: z.string().min(3).max(2048),
        /** Admins only — route through a specific pool account. */
        accountId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const isAdmin = isAdminRole(ctx.member.role);
      return lookupProfile({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        isAdmin,
        linkedinUrl: input.linkedinUrl,
        requestedAccountId: isAdmin ? input.accountId : undefined,
      });
    }),

  /**
   * Search LinkedIn people by structured criteria (name / title / location /
   * industry / company size). Routes through a bridged account via Unipile's
   * classic people-search API.
   */
  search: workspaceProcedure
    .input(
      z.object({
        name: z.string().max(200).optional(),
        title: z.string().max(200).optional(),
        location: z.string().max(200).optional(),
        industry: z.string().max(200).optional(),
        companySize: z.string().max(40).optional(),
        keywords: z.string().max(300).optional(),
        limit: z.number().min(1).max(25).default(10),
        /** Admins only — route through a specific pool account. */
        accountId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const isAdmin = isAdminRole(ctx.member.role);
      // Fold the structured filters into one classic-search keyword string.
      const parts = [
        input.name,
        input.title,
        input.keywords,
        input.location,
        input.industry,
      ]
        .map((s) => (s ?? "").trim())
        .filter(Boolean);
      if (input.companySize && input.companySize !== "any") {
        parts.push(`${input.companySize} employees`);
      }
      return searchLinkedInProfiles({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        isAdmin,
        keywords: parts.join(" "),
        limit: input.limit,
        requestedAccountId: isAdmin ? input.accountId : undefined,
      });
    }),

  /** Bulk-persist selected LinkedIn search hits as prospect rows. */
  saveSearchHits: workspaceProcedure
    .input(
      z.object({
        hits: z
          .array(
            z.object({
              firstName: z.string().optional(),
              lastName: z.string().optional(),
              title: z.string().optional(),
              company: z.string().optional(),
              linkedinUrl: z.string().min(3).max(2048),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      let created = 0;
      for (const hit of input.hits) {
        try {
          const built = buildScrapedProspectValues({
            workspaceId: ctx.workspace.id,
            source: "linkedin_finder",
            firstName: hit.firstName,
            lastName: hit.lastName,
            title: hit.title,
            company: hit.company,
            linkedinUrl: hit.linkedinUrl,
            sourceUrl: hit.linkedinUrl,
          });
          const inserted = await db
            .insert(prospects)
            .values(built.values as never);
          const id = Number(
            (inserted as unknown as { insertId?: number }[])[0]?.insertId ?? 0,
          );
          await recordAudit({
            workspaceId: ctx.workspace.id,
            actorUserId: ctx.user.id,
            action: "create",
            entityType: built.entityType,
            entityId: id,
            after: built.audit,
          });
          created++;
        } catch (e) {
          console.error("[linkedinFinder.saveSearchHits] insert failed:", e);
        }
      }
      return { ok: true as const, created, total: input.hits.length };
    }),

  /** Persist a looked-up (and possibly edited) profile as a prospect. */
  saveAsProspect: workspaceProcedure
    .input(
      z.object({
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        title: z.string().optional(),
        linkedinUrl: z.string().min(3).max(2048),
        company: z.string().optional(),
        companyDomain: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const built = buildScrapedProspectValues({
        workspaceId: ctx.workspace.id,
        source: "linkedin_finder",
        firstName: input.firstName,
        lastName: input.lastName,
        title: input.title,
        company: input.company,
        companyDomain: input.companyDomain,
        linkedinUrl: input.linkedinUrl,
        sourceUrl: input.linkedinUrl,
      });

      try {
        const inserted = await db.insert(prospects).values(built.values as never);
        const id = Number(
          (inserted as unknown as { insertId?: number }[])[0]?.insertId ?? 0,
        );
        await recordAudit({
          workspaceId: ctx.workspace.id,
          actorUserId: ctx.user.id,
          action: "create",
          entityType: built.entityType,
          entityId: id,
          after: built.audit,
        });
        return { ok: true as const, prospectId: id };
      } catch (e) {
        console.error("[linkedinFinder.saveAsProspect] insert failed:", e);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not save the prospect. Please try again.",
        });
      }
    }),
});
