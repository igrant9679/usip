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
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { affectedRowsOf, claimRow } from "../_core/claim";
import { optimizationRecommendations, workspaceSettings } from "../../drizzle/schema";

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

type OptDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** A claim on a recommendation older than this is a crashed apply, and may be taken again. */
const APPLY_CLAIM_STALE_MS = 10 * 60_000;
const OPEN = ["pending", "approved"] as const;

/**
 * Take a recommendation for applying (audit X1.5). A double click on Approve,
 * or Approve beside Approve all, each read "pending" and each applied the
 * change: a cap raised twice, its previous value overwritten. appliedAt is
 * the claim: an open recommendation has none until it is applied, so the
 * update that sets it first wins; applyRecommendation then sets it again.
 */
async function claimForApply(db: OptDb, workspaceId: number, id: number): Promise<boolean> {
  return claimRow(db.update(optimizationRecommendations)
    .set({ appliedAt: new Date() } as never)
    .where(and(
      eq(optimizationRecommendations.id, id),
      eq(optimizationRecommendations.workspaceId, workspaceId),
      inArray(optimizationRecommendations.status, [...OPEN] as never),
      or(isNull(optimizationRecommendations.appliedAt), lt(optimizationRecommendations.appliedAt, new Date(Date.now() - APPLY_CLAIM_STALE_MS))),
    )));
}

/** Give the claim back when the apply did not happen. */
async function releaseApplyClaim(db: OptDb, workspaceId: number, id: number): Promise<void> {
  await db.update(optimizationRecommendations)
    .set({ appliedAt: null } as never)
    .where(and(eq(optimizationRecommendations.id, id), eq(optimizationRecommendations.workspaceId, workspaceId), inArray(optimizationRecommendations.status, [...OPEN] as never)));
}

/** Record an advisory recommendation as approved, once: only from pending. */
async function claimAdvisory(db: OptDb, workspaceId: number, id: number, userId: number): Promise<boolean> {
  return claimRow(db.update(optimizationRecommendations)
    .set({ status: "approved" as never, appliedByUserId: userId })
    .where(and(eq(optimizationRecommendations.id, id), eq(optimizationRecommendations.workspaceId, workspaceId), eq(optimizationRecommendations.status, "pending" as never))));
}

/** Apply one claimed recommendation; the claim is released if nothing was applied. */
async function applyClaimed(db: OptDb, workspaceId: number, row: any, userId: number) {
  const { applyRecommendation } = await import("../services/optimization/apply");
  try {
    const outcome = await applyRecommendation(workspaceId, row, userId);
    if (!outcome.ok) await releaseApplyClaim(db, workspaceId, row.id);
    return outcome;
  } catch (e) {
    await releaseApplyClaim(db, workspaceId, row.id);
    throw e;
  }
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

  /**
   * Accept a recommendation and APPLY it when it carries an applicable patch.
   *
   * Advisory proposals (no machine-applicable change — e.g. "rewrite this
   * step's copy") are recorded as `approved` and say so, rather than reporting
   * an apply that never happened.
   */
  approve: adminWsProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const row = await loadOwned(db, ctx.workspace.id, input.id);
      if (row.status !== "pending" && row.status !== "approved") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Already ${row.status}.` });
      }
      const { isApplicable } = await import("../services/optimization/apply");

      if (!isApplicable(row)) {
        // Approving an advisory one twice records it once (X1.5).
        if (row.status === "pending") await claimAdvisory(db, ctx.workspace.id, input.id, ctx.user.id);
        return {
          ok: true as const,
          applied: false as const,
          detail: "Recorded — this one is advisory, so there is no automatic change to make.",
        };
      }

      if (!(await claimForApply(db, ctx.workspace.id, input.id))) {
        throw new TRPCError({ code: "CONFLICT", message: "This recommendation is already being applied, or was just applied." });
      }
      const outcome = await applyClaimed(db, ctx.workspace.id, row, ctx.user.id);
      if (!outcome.ok) throw new TRPCError({ code: "BAD_REQUEST", message: outcome.detail });
      return { ok: true as const, applied: true as const, detail: outcome.detail };
    }),

  /** Undo an applied change, restoring the recorded previous state. */
  revert: adminWsProcedure
    .input(z.object({ id: z.number().int(), reason: z.string().max(300).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const row = await loadOwned(db, ctx.workspace.id, input.id);
      if (row.status !== "applied") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Only applied changes can be reverted (this one is ${row.status}).` });
      }
      const { revertRecommendation } = await import("../services/optimization/apply");
      const outcome = await revertRecommendation(ctx.workspace.id, row, input.reason ?? "reverted by admin");
      if (!outcome.ok) throw new TRPCError({ code: "BAD_REQUEST", message: outcome.detail });
      return { ok: true as const, detail: outcome.detail };
    }),

  /** Current autonomy mode + change budget for the optimisation layer. */
  getSettings: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [s] = await db
      .select({
        mode: workspaceSettings.optimizationMode,
        dailyCap: workspaceSettings.optimizationDailyCap,
        lastRunAt: workspaceSettings.optimizationLastRunAt,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
    return s ?? { mode: "approval" as const, dailyCap: 3, lastRunAt: null };
  }),

  /** Set Off / Approve / Auto (and the daily change budget). */
  setSettings: adminWsProcedure
    .input(z.object({
      mode: z.enum(["off", "approval", "auto"]).optional(),
      dailyCap: z.number().int().min(1).max(20).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const set: Record<string, unknown> = {};
      if (input.mode !== undefined) set.optimizationMode = input.mode;
      if (input.dailyCap !== undefined) set.optimizationDailyCap = input.dailyCap;
      if (Object.keys(set).length === 0) return { ok: true as const };
      // Settings row may not exist yet for this workspace. NOTE: this table has
      // no `id` column — workspaceId IS the primary key. Selecting a
      // non-existent column here threw "Cannot convert undefined or null to
      // object" at runtime, which no unit test caught because the failure is in
      // the query builder, not the logic.
      const [existing] = await db
        .select({ workspaceId: workspaceSettings.workspaceId })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      if (existing) {
        await db.update(workspaceSettings).set(set as never)
          .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      } else {
        await db.insert(workspaceSettings).values({ workspaceId: ctx.workspace.id, ...set } as never);
      }
      return { ok: true as const };
    }),

  /** Reject a recommendation. Dismissed proposals are never re-generated. */
  dismiss: adminWsProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const row = await loadOwned(db, ctx.workspace.id, input.id);
      if (row.status === "dismissed") return { ok: true as const };
      // Only from the state it was read in (X1.5): one applied in between
      // keeps its applied state and its revert, rather than reading dismissed.
      const won = await claimRow(db
        .update(optimizationRecommendations)
        .set({
          status: "dismissed" as never,
          dismissedAt: new Date(),
          dismissedByUserId: ctx.user.id,
        })
        .where(and(eq(optimizationRecommendations.id, input.id), eq(optimizationRecommendations.workspaceId, ctx.workspace.id), eq(optimizationRecommendations.status, row.status as never))));
      if (!won) throw new TRPCError({ code: "CONFLICT", message: "This recommendation changed while you were looking at it. Refresh and try again." });
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
        .where(and(eq(optimizationRecommendations.id, input.id), eq(optimizationRecommendations.workspaceId, ctx.workspace.id), inArray(optimizationRecommendations.status, ["dismissed", "approved"] as never)));
      return { ok: true as const };
    }),

  /**
   * Run the analyzers now. Deterministic and LLM-free, so this is cheap and
   * safe to invoke on demand; it also runs on a daily cron.
   */
  analyzeNow: adminWsProcedure.mutation(async ({ ctx }) => {
    const { runOptimizationAnalyzers } = await import("../services/optimization/runner");
    // force: a human asking explicitly should get an answer even when the mode
    // is 'off' (which otherwise skips the analyzers entirely).
    return runOptimizationAnalyzers(ctx.workspace.id, true);
  }),

  /** Bulk dismiss — clears a noisy backlog without 20 clicks. */
  dismissAll: adminWsProcedure
    .input(z.object({ ids: z.array(z.number().int()).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Open ones only (X1.5): an applied recommendation dismissed in bulk lost
      // its revert, and the count was the ids sent, not the rows changed.
      const res = await db
        .update(optimizationRecommendations)
        .set({ status: "dismissed" as never, dismissedAt: new Date(), dismissedByUserId: ctx.user.id })
        .where(and(
          eq(optimizationRecommendations.workspaceId, ctx.workspace.id),
          inArray(optimizationRecommendations.id, input.ids),
          inArray(optimizationRecommendations.status, [...OPEN] as never),
        ));
      return { ok: true as const, dismissed: affectedRowsOf(res) };
    }),

  /**
   * Bulk approve (owner ask 2026-09-08: "approve all" on every approvals
   * screen). Same split as `approve`: advisory rows are recorded, applicable
   * ones are applied (each reversible via `revert`). One failure never
   * blocks the rest — the caller gets the tally and the failures by id.
   */
  approveAll: adminWsProcedure
    .input(z.object({ ids: z.array(z.number().int()).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { isApplicable } = await import("../services/optimization/apply");
      let applied = 0, recorded = 0, skipped = 0;
      const failed: Array<{ id: number; detail: string }> = [];
      for (const id of input.ids) {
        try {
          const row = await loadOwned(db, ctx.workspace.id, id);
          if (row.status !== "pending" && row.status !== "approved") { skipped++; continue; }
          if (!isApplicable(row)) {
            if (row.status === "pending" && !(await claimAdvisory(db, ctx.workspace.id, id, ctx.user.id))) { skipped++; continue; }
            recorded++;
            continue;
          }
          // Each applies once, whoever else is approving it (X1.5).
          if (!(await claimForApply(db, ctx.workspace.id, id))) { skipped++; continue; }
          const outcome = await applyClaimed(db, ctx.workspace.id, row, ctx.user.id);
          if (outcome.ok) applied++; else failed.push({ id, detail: outcome.detail });
        } catch (e) {
          failed.push({ id, detail: (e as Error).message });
        }
      }
      return { ok: true as const, applied, recorded, skipped, failed };
    }),
});
