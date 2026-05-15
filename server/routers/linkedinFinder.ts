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
  LINKEDIN_DAILY_CAP,
} from "../services/linkedinLookup";

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

      const firstName = (input.firstName ?? "").trim() || "(unknown)";
      const lastName = (input.lastName ?? "").trim() || "(LinkedIn)";

      try {
        const inserted = await db
          .insert(prospects)
          .values({
            workspaceId: ctx.workspace.id,
            firstName,
            lastName,
            title: input.title ?? undefined,
            linkedinUrl: input.linkedinUrl,
            company: input.company ?? undefined,
            companyDomain: input.companyDomain ?? undefined,
          } as never);
        const id = Number(
          (inserted as unknown as { insertId?: number }[])[0]?.insertId ?? 0,
        );
        await recordAudit({
          workspaceId: ctx.workspace.id,
          actorUserId: ctx.user.id,
          action: "create",
          entityType: "prospect_from_linkedin",
          entityId: id,
          after: { source: "linkedin_finder", linkedinUrl: input.linkedinUrl },
        });
        return { ok: true, prospectId: id };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }),
});
