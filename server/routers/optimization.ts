/**
 * Optimisation router — the review queue for system-generated recommendations.
 *
 * Phase 2 scope is REVIEW ONLY. `approve` records a human decision; it does not
 * mutate sequences, sources, or settings. Applying (and its Off/Approve/Auto
 * gating plus auto-revert) is Phase 3, and the UI says so plainly rather than
 * shipping a button that implies more than it does.
 *
 * Reads are open to any workspace member; decisions are admin-only, since these
 * proposals change workspace-wide outbound strategy rather than one rep's work.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { optimizationRecommendations } from "../../drizzle/schema";

const MODULES = ["sequences", "messaging", "sourcing", "voice", "crm", "icp", "sdr_coaching"] as const;
const STATUSES = ["pending", "approved", "applied", "dismissed", "reverted", "superseded"] as const;

/** Load a recommendation, enforcing workspace ownership. */
async function loadOwned(db: any, workspaceId: number, id: number) {
  const [row] = await db
    .select()
    .from(optimizationRecommendations)
    .where(and(
      eq(optimizationRecommendations.id, id),
      eq(optimizationRecommendations.workspaceId, workspaceId),
    ));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Recommendation not found." });
  return row;
}

export const optimizationRouter = router({
  /** Recommendations for the workspace, newest first. */
  list: workspaceProcedure
    .input(z.object({
      status: z.enum(STATUSES).optional(),
      module: z.enum(MODULES).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const where = [eq(optimizationRecommendations.workspaceId, ctx.workspace.id)];
      if (input?.status) where.push(eq(optimizationRecommendations.status, input.status as never));
      if (input?.module) where.push(eq(optimizationRecommendations.module, input.module as never));
      return db
        .select()
        .from(optimizationRecommendations)
        .where(and(...where))
        .orderBy(desc(optimizationRecommendations.createdAt))
        .limit(input?.limit ?? 50);
    }),

  /** Pending count, for a nav badge. */
  pendingCount: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return 0;
    const rows = await db
      .select({ id: optimizationRecommendations.id })
      .from(optimizationRecommendations)
      .where(and(
        eq(optimizationRecommendations.workspaceId, ctx.workspace.id),
        eq(optimizationRecommendations.status, "pending" as never),
      ));
    return rows.length;
  }),

  /**
   * Accept a recommendation. Records the decision only — Phase 2 does not
   * apply changes, so the caller must still make the change itself.
   */
  approve: adminWsProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const row = await loadOwned(db, ctx.workspace.id, input.id);
      if (row.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Already ${row.status}.` });
      }
      await db
        .update(optimizationRecommendations)
        .set({ status: "approved" as never, appliedByUserId: ctx.user.id })
        .where(eq(optimizationRecommendations.id, input.id));
      return { ok: true as const, applied: false as const };
    }),

  /** Reject a recommendation. Dismissed proposals are never re-generated. */
  dismiss: adminWsProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const row = await loadOwned(db, ctx.workspace.id, input.id);
      if (row.status === "dismissed") return { ok: true as const };
      await db
        .update(optimizationRecommendations)
        .set({
          status: "dismissed" as never,
          dismissedAt: new Date(),
          dismissedByUserId: ctx.user.id,
        })
        .where(eq(optimizationRecommendations.id, input.id));
      return { ok: true as const };
    }),

  /** Re-open a dismissed/approved recommendation. */
  reopen: adminWsProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const row = await loadOwned(db, ctx.workspace.id, input.id);
      if (!["dismissed", "approved"].includes(String(row.status))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Only dismissed or approved items can be re-opened." });
      }
      await db
        .update(optimizationRecommendations)
        .set({ status: "pending" as never, dismissedAt: null, dismissedByUserId: null })
        .where(eq(optimizationRecommendations.id, input.id));
      return { ok: true as const };
    }),

  /**
   * Run the analyzers now. Deterministic and LLM-free, so this is cheap and
   * safe to invoke on demand; it also runs on a daily cron.
   */
  analyzeNow: adminWsProcedure.mutation(async ({ ctx }) => {
    const { runOptimizationAnalyzers } = await import("../services/optimization/runner");
    return runOptimizationAnalyzers(ctx.workspace.id);
  }),

  /** Which analyzers exist, so the UI can explain what is and isn't covered. */
  analyzers: workspaceProcedure.query(async () => {
    const { ANALYZERS } = await import("../services/optimization/runner");
    return ANALYZERS.map((a) => ({ module: a.module, name: a.name }));
  }),

  /** Bulk dismiss — clears a noisy backlog without 20 clicks. */
  dismissAll: adminWsProcedure
    .input(z.object({ ids: z.array(z.number().int()).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(optimizationRecommendations)
        .set({ status: "dismissed" as never, dismissedAt: new Date(), dismissedByUserId: ctx.user.id })
        .where(and(
          eq(optimizationRecommendations.workspaceId, ctx.workspace.id),
          inArray(optimizationRecommendations.id, input.ids),
        ));
      return { ok: true as const, dismissed: input.ids.length };
    }),
});
