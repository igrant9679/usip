/**
 * LinkedIn enrichment router — the compliant Unipile-backed enrichment API.
 *
 * Surfaces the integration health gate, batch URL import (create → validate →
 * run → review), per-prospect enrichment + change reads, change acknowledge,
 * manual refresh, and the admin daily-check run/status. All retrieval routes
 * through Unipile via the existing rate-limited lookup — no scraping.
 *
 * Permission model maps the spec's granular permissions onto the existing
 * workspace roles (the app has no separate RBAC layer):
 *   view/acknowledge → any member · import/run/review/refresh → manager+ ·
 *   daily force-run → admin+.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { activities } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { checkLinkedInEnrichmentHealth } from "../services/linkedinEnrichment/health";
import {
  createBatch, runBatch, applyReview, getBatch, getBatchRows,
} from "../services/linkedinEnrichment/batchService";
import {
  getProspectEnrichment,
  getProspectLinkedInChangeSummary,
  getLinkedInChangeSummaries,
  acknowledgeChanges,
  applyEnrichment,
  enrichmentBlockReason,
} from "../services/linkedinEnrichment/enrichmentService";
import { retrieveLinkedInProfileByUrl } from "../services/linkedinEnrichment/unipileProfile";
import { runDailyCheckForWorkspace, getLastDailyCheck } from "../services/linkedinEnrichment/dailyCheck";
import { prospects, prospectLinkedinEnrichments } from "../../drizzle/schema";
import { and, eq } from "drizzle-orm";

const RANK: Record<string, number> = { super_admin: 4, admin: 3, manager: 2, rep: 1 };
const isAdminRole = (role: string) => RANK[role] >= RANK.admin;
function requireRole(role: string, min: "manager" | "admin") {
  if ((RANK[role] ?? 0) < RANK[min]) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You don't have permission to run LinkedIn enrichment." });
  }
}

async function emitActivity(opts: {
  workspaceId: number; actorUserId: number; prospectId?: number; subject: string; body?: string;
}) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(activities).values({
      workspaceId: opts.workspaceId,
      type: "linkedin",
      relatedType: "prospect",
      relatedId: opts.prospectId ?? 0,
      subject: opts.subject.slice(0, 240),
      body: opts.body ?? null,
      actorUserId: opts.actorUserId,
    } as never);
  } catch (e) {
    console.error("[linkedinEnrichment] activity emit failed:", (e as Error).message);
  }
}

const rowInput = z.object({
  linkedinUrl: z.string().min(3).max(2048),
  fullName: z.string().max(200).optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  company: z.string().max(200).optional(),
  title: z.string().max(300).optional(),
  email: z.string().max(320).optional(),
  prospectId: z.number().int().positive().optional(),
});

export const linkedinEnrichmentRouter = router({
  /** Integration health — is Unipile + a LinkedIn account ready to enrich? */
  status: workspaceProcedure.query(async ({ ctx }) => {
    return checkLinkedInEnrichmentHealth({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      isAdmin: isAdminRole(ctx.member.role),
    });
  }),

  /** Create a batch from pasted URLs or CSV rows (validate + normalize). */
  createBatch: workspaceProcedure
    .input(z.object({
      sourceType: z.enum(["pasted_urls", "csv_upload"]),
      rows: z.array(rowInput).min(1).max(1000),
    }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      const summary = await createBatch({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        sourceType: input.sourceType,
        rows: input.rows,
      });
      await emitActivity({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id,
        subject: `LinkedIn enrichment batch created (${summary.validRows}/${summary.totalRows} valid)`,
      });
      return summary;
    }),

  /** Run Unipile retrieval + matching for a batch. */
  runBatch: workspaceProcedure
    .input(z.object({ batchId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      // Gate on integration health before spending lookups.
      const health = await checkLinkedInEnrichmentHealth({
        workspaceId: ctx.workspace.id, userId: ctx.user.id, isAdmin: isAdminRole(ctx.member.role),
      });
      if (health.status !== "connected") {
        throw new TRPCError({ code: "FAILED_PRECONDITION", message: health.missing_requirements[0] ?? "LinkedIn integration not ready." });
      }
      const summary = await runBatch({
        workspaceId: ctx.workspace.id, userId: ctx.user.id,
        isAdmin: isAdminRole(ctx.member.role), batchId: input.batchId,
      });
      await emitActivity({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id,
        subject: `LinkedIn batch run: ${summary.matchedRows} enriched, ${summary.needsReviewRows} to review, ${summary.failedRows} failed`,
      });
      return summary;
    }),

  /** Batch status + summary. */
  getBatch: workspaceProcedure
    .input(z.object({ batchId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const batch = await getBatch(ctx.workspace.id, input.batchId);
      if (!batch) throw new TRPCError({ code: "NOT_FOUND" });
      return batch;
    }),

  /** Row-level validation / matching / enrichment status for a batch. */
  listBatchRows: workspaceProcedure
    .input(z.object({ batchId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => getBatchRows(ctx.workspace.id, input.batchId)),

  /** Apply manual match-review decisions. */
  reviewBatch: workspaceProcedure
    .input(z.object({
      batchId: z.number().int().positive(),
      decisions: z.array(z.object({
        rowId: z.number().int().positive(),
        action: z.enum(["match_existing", "create_new", "skip", "conflict", "suppress"]),
        prospectId: z.number().int().positive().optional(),
      })).min(1).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      return applyReview({
        workspaceId: ctx.workspace.id, userId: ctx.user.id,
        isAdmin: isAdminRole(ctx.member.role), batchId: input.batchId, decisions: input.decisions,
      });
    }),

  /** Full LinkedIn enrichment + change history (full profile view). */
  getProspectEnrichment: workspaceProcedure
    .input(z.object({ prospectId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => getProspectEnrichment(ctx.workspace.id, input.prospectId)),

  /** Compact change summary for one prospect (open profile + indicator popover). */
  getProspectChanges: workspaceProcedure
    .input(z.object({ prospectId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => getProspectLinkedInChangeSummary(ctx.workspace.id, input.prospectId)),

  /** Batched change summaries for many prospects (People table / list rows). */
  getChangeSummaries: workspaceProcedure
    .input(z.object({ prospectIds: z.array(z.number().int().positive()).max(500) }))
    .query(async ({ ctx, input }) => {
      const map = await getLinkedInChangeSummaries(ctx.workspace.id, input.prospectIds);
      // tRPC can't serialize a Map — return only prospects that have updates.
      return [...map.values()].filter((s) => s.has_updates);
    }),

  /** Acknowledge change indicators (removes them from rows; keeps history). */
  acknowledgeChanges: workspaceProcedure
    .input(z.object({
      prospectId: z.number().int().positive(),
      changeIds: z.array(z.number().int().positive()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const res = await acknowledgeChanges({
        workspaceId: ctx.workspace.id, prospectId: input.prospectId,
        userId: ctx.user.id, changeIds: input.changeIds,
      });
      await emitActivity({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, prospectId: input.prospectId,
        subject: "LinkedIn changes acknowledged",
      });
      return res;
    }),

  /** Manually refresh one prospect's LinkedIn data (manager+). */
  manualRefresh: workspaceProcedure
    .input(z.object({ prospectId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [enr] = await db
        .select()
        .from(prospectLinkedinEnrichments)
        .where(and(eq(prospectLinkedinEnrichments.workspaceId, ctx.workspace.id), eq(prospectLinkedinEnrichments.prospectId, input.prospectId)));
      if (!enr) throw new TRPCError({ code: "NOT_FOUND", message: "This prospect has no LinkedIn enrichment to refresh." });

      const [p] = await db
        .select({ verificationStatus: prospects.verificationStatus })
        .from(prospects)
        .where(and(eq(prospects.workspaceId, ctx.workspace.id), eq(prospects.id, input.prospectId)));
      if (p && enrichmentBlockReason(p)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This prospect is suppressed — enrichment refresh is blocked." });
      }

      const retrieve = await retrieveLinkedInProfileByUrl({
        workspaceId: ctx.workspace.id, userId: ctx.user.id, isAdmin: isAdminRole(ctx.member.role),
        linkedinUrl: enr.linkedinProfileUrl, requestedAccountId: enr.linkedinSourceAccountId ?? undefined,
      });
      if (!retrieve.ok || !retrieve.profile) {
        throw new TRPCError({ code: "BAD_GATEWAY", message: retrieve.message });
      }
      const applied = await applyEnrichment({
        workspaceId: ctx.workspace.id, prospectId: input.prospectId, profile: retrieve.profile,
        matchStatus: enr.linkedinMatchStatus, sourceAccountId: retrieve.viaAccountId, imageAllowed: !!retrieve.profile.profileImageUrl,
      });
      await recordAudit({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update",
        entityType: "prospect_linkedin_enrichment", entityId: input.prospectId,
        after: { changes: applied.changes.length },
      });
      return { ok: true as const, changes: applied.changes };
    }),

  /** Admin-only: force-run the daily LinkedIn change check for this workspace. */
  dailyCheckRun: workspaceProcedure
    .input(z.object({ force: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      const res = await runDailyCheckForWorkspace({ workspaceId: ctx.workspace.id, force: input.force, trigger: "manual" });
      await emitActivity({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id,
        subject: `LinkedIn daily check: ${res.checked} checked, ${res.changed} changed`,
      });
      return res;
    }),

  /** Last daily-check run for this workspace (status card). */
  dailyCheckStatus: workspaceProcedure.query(async ({ ctx }) => getLastDailyCheck(ctx.workspace.id)),
});
