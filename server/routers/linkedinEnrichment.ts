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
import { workspaceProcedure, adminWsProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { activities, tasks, workspaceSettings } from "../../drizzle/schema";
import { reengageProspectManually } from "../services/linkedinEnrichment/jobChangeReengagement";
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
import { retrieveLinkedInProfileByUrl, retrieveByNameCompany } from "../services/linkedinEnrichment/unipileProfile";
import { determineLookupStrategy } from "../services/linkedinEnrichment/lookupStrategy";
import { scoreIntendedMatch } from "../services/linkedinEnrichment/matching";
import { runDailyCheckForWorkspace, getLastDailyCheck } from "../services/linkedinEnrichment/dailyCheck";
import { runForProspects, runForList, getJob, getJobItems } from "../services/linkedinEnrichment/orchestrator";
import {
  prospects,
  prospectLinkedinEnrichments,
  prospectLinkedinFieldSnapshots,
  prospectLinkedinFieldChanges,
  linkedinEnrichmentBatches,
  linkedinEnrichmentBatchRows,
  linkedinEnrichmentJobs,
  linkedinEnrichmentJobItems,
} from "../../drizzle/schema";
import { and, desc, eq, inArray, like } from "drizzle-orm";

const TRIGGER_TYPES = [
  "people_bulk_action", "people_row_action", "open_profile_action", "full_profile_action",
  "list_bulk_action", "list_enrich_all", "account_contacts_action", "manual_admin_run",
] as const;
const enrichOptions = z.object({
  forceRefresh: z.boolean().optional(),
  includeProfileImage: z.boolean().optional(),
  detectChanges: z.boolean().optional(),
  scheduleDailyMonitoring: z.boolean().optional(),
}).optional();

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

  /**
   * One-click enrich for selected prospects. Health-gated; returns a job id the
   * UI polls. No URL upload, no manual matching — the orchestrator resolves the
   * lookup strategy and auto-applies confident matches.
   */
  run: workspaceProcedure
    .input(z.object({
      prospectIds: z.array(z.number().int().positive()).min(1).max(500),
      triggerType: z.enum(TRIGGER_TYPES).default("people_bulk_action"),
      options: enrichOptions,
    }))
    .mutation(async ({ ctx, input }) => {
      const isAdmin = isAdminRole(ctx.member.role);
      const health = await checkLinkedInEnrichmentHealth({ workspaceId: ctx.workspace.id, userId: ctx.user.id, isAdmin });
      if (health.status !== "connected") {
        throw new TRPCError({ code: "FAILED_PRECONDITION", message: health.missing_requirements[0] ?? "LinkedIn integration not ready." });
      }
      const handle = await runForProspects({
        workspaceId: ctx.workspace.id, userId: ctx.user.id, isAdmin,
        prospectIds: input.prospectIds, triggerType: input.triggerType, options: input.options,
      });
      await emitActivity({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id,
        prospectId: input.prospectIds.length === 1 ? input.prospectIds[0] : undefined,
        subject: `LinkedIn enrichment started for ${handle.total} prospect(s)`,
      });
      return handle;
    }),

  /** One-click enrich for a list — selected members or every eligible member. */
  runForList: workspaceProcedure
    .input(z.object({
      listId: z.number().int().positive(),
      prospectIds: z.array(z.number().int().positive()).max(2000).optional(),
      enrichAll: z.boolean().default(false),
      options: enrichOptions,
    }))
    .mutation(async ({ ctx, input }) => {
      const isAdmin = isAdminRole(ctx.member.role);
      const health = await checkLinkedInEnrichmentHealth({ workspaceId: ctx.workspace.id, userId: ctx.user.id, isAdmin });
      if (health.status !== "connected") {
        throw new TRPCError({ code: "FAILED_PRECONDITION", message: health.missing_requirements[0] ?? "LinkedIn integration not ready." });
      }
      const handle = await runForList({
        workspaceId: ctx.workspace.id, userId: ctx.user.id, isAdmin,
        listId: input.listId, prospectIds: input.prospectIds, enrichAll: input.enrichAll, options: input.options,
      });
      await emitActivity({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id,
        subject: `LinkedIn enrichment started for ${handle.total} list member(s)`,
      });
      return handle;
    }),

  /** Job status + counters (poll this for progress). */
  getJob: workspaceProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const job = await getJob(ctx.workspace.id, input.jobId);
      if (!job) throw new TRPCError({ code: "NOT_FOUND" });
      return job;
    }),

  /** Row-level results for a job. */
  getJobItems: workspaceProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => getJobItems(ctx.workspace.id, input.jobId)),

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

  /**
   * Human-confirmed apply for a prospect the matcher flagged (needs_review or
   * conflict). The reviewer has asserted the retrieved profile is the right
   * person, so this re-retrieves via the SAME compliant Unipile path and
   * applies the enrichment regardless of the automatic match score — while
   * still recording the real score/status for the audit trail. Manager+.
   *
   * This is the apply primitive behind the (future) job-results review panel;
   * it also lets an operator resolve a single flagged record on demand.
   */
  confirmEnrich: workspaceProcedure
    .input(z.object({ prospectId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      const isAdmin = isAdminRole(ctx.member.role);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const health = await checkLinkedInEnrichmentHealth({ workspaceId: ctx.workspace.id, userId: ctx.user.id, isAdmin });
      if (health.status !== "connected") {
        throw new TRPCError({ code: "FAILED_PRECONDITION", message: health.missing_requirements[0] ?? "LinkedIn integration not ready." });
      }

      const [p] = await db.select().from(prospects)
        .where(and(eq(prospects.workspaceId, ctx.workspace.id), eq(prospects.id, input.prospectId)));
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Prospect not found." });
      // Compliance — never enrich a suppressed/rejected prospect, even on confirm.
      const block = enrichmentBlockReason(p);
      if (block) throw new TRPCError({ code: "FORBIDDEN", message: block });

      const [prior] = await db.select({ url: prospectLinkedinEnrichments.linkedinProfileUrl })
        .from(prospectLinkedinEnrichments)
        .where(and(eq(prospectLinkedinEnrichments.workspaceId, ctx.workspace.id), eq(prospectLinkedinEnrichments.prospectId, p.id)));

      const { strategy, url } = determineLookupStrategy(p as never, prior?.url ?? null);
      if (strategy === "unavailable") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No LinkedIn URL or enough profile context to enrich this prospect." });
      }

      const retrieve = url
        ? await retrieveLinkedInProfileByUrl({ workspaceId: ctx.workspace.id, userId: ctx.user.id, isAdmin, linkedinUrl: url })
        : await retrieveByNameCompany({ workspaceId: ctx.workspace.id, userId: ctx.user.id, isAdmin, prospect: p as never });
      if (!retrieve.ok || !retrieve.profile) {
        throw new TRPCError({ code: "BAD_GATEWAY", message: retrieve.message });
      }

      // Score for the audit record, but apply regardless — the reviewer confirmed identity.
      const match = scoreIntendedMatch(p as never, retrieve.profile, { userInitiatedSingle: true });
      const applied = await applyEnrichment({
        workspaceId: ctx.workspace.id, prospectId: p.id, profile: retrieve.profile,
        matchStatus: match.status, sourceAccountId: retrieve.viaAccountId,
        imageAllowed: !!retrieve.profile.profileImageUrl,
      });

      await recordAudit({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update",
        entityType: "prospect_linkedin_enrichment", entityId: p.id,
        after: { confirmedApply: true, matchStatus: match.status, matchScore: match.score, changes: applied.changes.length },
      });
      await emitActivity({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, prospectId: p.id,
        subject: `LinkedIn enrichment confirmed & applied (${applied.changes.length} change${applied.changes.length === 1 ? "" : "s"})`,
      });
      return { ok: true as const, matchStatus: match.status, matchScore: match.score, changes: applied.changes };
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

  /* ─────────────────────────── admin cleanup ──────────────────────────── */

  /** Admin: delete a URL-upload batch and its rows. */
  deleteBatch: workspaceProcedure
    .input(z.object({ batchId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const ws = ctx.workspace.id;
      await db.delete(linkedinEnrichmentBatchRows).where(and(eq(linkedinEnrichmentBatchRows.workspaceId, ws), eq(linkedinEnrichmentBatchRows.batchId, input.batchId)));
      await db.delete(linkedinEnrichmentBatches).where(and(eq(linkedinEnrichmentBatches.workspaceId, ws), eq(linkedinEnrichmentBatches.id, input.batchId)));
      await recordAudit({ workspaceId: ws, actorUserId: ctx.user.id, action: "delete", entityType: "linkedin_enrichment_batch", entityId: input.batchId });
      return { ok: true as const };
    }),

  /** Admin: delete an Enrich job and its items (does not undo applied enrichment). */
  deleteJob: workspaceProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const ws = ctx.workspace.id;
      await db.delete(linkedinEnrichmentJobItems).where(and(eq(linkedinEnrichmentJobItems.workspaceId, ws), eq(linkedinEnrichmentJobItems.jobId, input.jobId)));
      await db.delete(linkedinEnrichmentJobs).where(and(eq(linkedinEnrichmentJobs.workspaceId, ws), eq(linkedinEnrichmentJobs.id, input.jobId)));
      await recordAudit({ workspaceId: ws, actorUserId: ctx.user.id, action: "delete", entityType: "linkedin_enrichment_job", entityId: input.jobId });
      return { ok: true as const };
    }),

  /**
   * Admin: fully remove a prospect's LinkedIn enrichment — the enrichment row,
   * its snapshots and field-change history — and clear an enrichment-sourced
   * profile photo (a user-uploaded photo is preserved). Use to undo a test or a
   * bad enrichment; the prospect's own fields are untouched.
   */
  deleteProspectEnrichment: workspaceProcedure
    .input(z.object({ prospectId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const ws = ctx.workspace.id;
      const pid = input.prospectId;
      await db.delete(prospectLinkedinFieldChanges).where(and(eq(prospectLinkedinFieldChanges.workspaceId, ws), eq(prospectLinkedinFieldChanges.prospectId, pid)));
      await db.delete(prospectLinkedinFieldSnapshots).where(and(eq(prospectLinkedinFieldSnapshots.workspaceId, ws), eq(prospectLinkedinFieldSnapshots.prospectId, pid)));
      await db.delete(prospectLinkedinEnrichments).where(and(eq(prospectLinkedinEnrichments.workspaceId, ws), eq(prospectLinkedinEnrichments.prospectId, pid)));
      // Clear an enrichment-sourced photo; leave a user upload in place.
      await db.update(prospects)
        .set({ profileImageUrl: null, profileImageSource: null, profileImageSourceUrl: null, profileImageStatus: "unknown", profileImageLastVerifiedAt: null })
        .where(and(eq(prospects.workspaceId, ws), eq(prospects.id, pid), eq(prospects.profileImageSource, "enrichment_provider")));
      await recordAudit({ workspaceId: ws, actorUserId: ctx.user.id, action: "delete", entityType: "prospect_linkedin_enrichment", entityId: pid });
      return { ok: true as const };
    }),

  /* ─────────────────────── Job change alerts ──────────────────────────── */

  /**
   * Workspace-wide feed of detected job changes (company/title moves) for the
   * Data enrichment › "Job change alerts" tab. A company move is the strongest
   * re-engagement trigger; each row shows the before/after and whether a
   * re-engagement task is already open for that prospect.
   */
  jobChanges: workspaceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(60) }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const ws = ctx.workspace.id;
      const limit = input?.limit ?? 60;

      // One meaningful row per change: company by name, or a title move.
      const rows = await db
        .select({
          id: prospectLinkedinFieldChanges.id,
          prospectId: prospectLinkedinFieldChanges.prospectId,
          changeType: prospectLinkedinFieldChanges.changeType,
          fieldName: prospectLinkedinFieldChanges.fieldName,
          oldValue: prospectLinkedinFieldChanges.oldValue,
          newValue: prospectLinkedinFieldChanges.newValue,
          detectedAt: prospectLinkedinFieldChanges.detectedAt,
          acknowledgedAt: prospectLinkedinFieldChanges.acknowledgedAt,
          firstName: prospects.firstName,
          lastName: prospects.lastName,
          title: prospects.title,
          company: prospects.company,
          linkedinUrl: prospects.linkedinUrl,
        })
        .from(prospectLinkedinFieldChanges)
        .innerJoin(prospects, and(
          eq(prospects.workspaceId, prospectLinkedinFieldChanges.workspaceId),
          eq(prospects.id, prospectLinkedinFieldChanges.prospectId),
        ))
        .where(and(
          eq(prospectLinkedinFieldChanges.workspaceId, ws),
          inArray(prospectLinkedinFieldChanges.fieldName, ["current_company_name", "current_title"]),
          inArray(prospectLinkedinFieldChanges.changeType, ["company_changed", "title_changed"]),
        ))
        .orderBy(desc(prospectLinkedinFieldChanges.detectedAt))
        .limit(limit);

      // Which of these prospects already have an open re-engagement task?
      const pids = [...new Set(rows.map((r) => r.prospectId))];
      const active = pids.length
        ? await db
            .select({ relatedId: tasks.relatedId })
            .from(tasks)
            .where(and(
              eq(tasks.workspaceId, ws),
              eq(tasks.relatedType, "prospect"),
              inArray(tasks.relatedId, pids),
              like(tasks.title, "Re-engage:%"),
              inArray(tasks.status, ["open", "draft", "in_progress", "snoozed"]),
            ))
        : [];
      const reengaged = new Set(active.map((t) => t.relatedId));

      return rows.map((r) => ({
        id: r.id,
        prospectId: r.prospectId,
        name: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || "Unknown",
        title: r.title,
        company: r.company,
        linkedinUrl: r.linkedinUrl,
        changeType: r.changeType,
        oldValue: r.oldValue,
        newValue: r.newValue,
        detectedAt: r.detectedAt,
        acknowledged: !!r.acknowledgedAt,
        hasReengagementTask: reengaged.has(r.prospectId),
      }));
    }),

  /** Read the workspace's Job Change Autopilot config (any member). */
  getJobChangeSettings: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { mode: "off" as const, dailyCap: 25, lastRunAt: null as Date | null };
    const [row] = await db
      .select({
        mode: workspaceSettings.jobChangeAutopilotMode,
        dailyCap: workspaceSettings.jobChangeAutopilotDailyCap,
        lastRunAt: workspaceSettings.jobChangeAutopilotLastRunAt,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
    return {
      mode: (row?.mode ?? "off") as "off" | "approval" | "auto",
      dailyCap: row?.dailyCap ?? 25,
      lastRunAt: (row?.lastRunAt ?? null) as Date | null,
    };
  }),

  /** Set the Job Change Autopilot mode / daily cap (admin only). */
  setJobChangeSettings: adminWsProcedure
    .input(z.object({
      mode: z.enum(["off", "approval", "auto"]).optional(),
      dailyCap: z.number().int().min(1).max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const set: Record<string, unknown> = {};
      if (input.mode !== undefined) set.jobChangeAutopilotMode = input.mode;
      if (input.dailyCap !== undefined) set.jobChangeAutopilotDailyCap = input.dailyCap;
      if (Object.keys(set).length === 0) return { ok: true as const };
      // Upsert: workspace_settings row may not exist yet.
      await db
        .insert(workspaceSettings)
        .values({ workspaceId: ctx.workspace.id, ...set } as never)
        .onDuplicateKeyUpdate({ set: set as never });
      return { ok: true as const };
    }),

  /** Manually create a re-engagement task for a prospect who changed jobs. */
  reengage: workspaceProcedure
    .input(z.object({ prospectId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const res = await reengageProspectManually(ctx.workspace.id, input.prospectId);
      if (!res.created) {
        if (res.reason === "already_active") {
          throw new TRPCError({ code: "CONFLICT", message: "A re-engagement task is already open for this prospect." });
        }
        if (res.reason === "no_company_change") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "No detected company change for this prospect." });
        }
        if (res.reason === "cap_reached") {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Daily re-engagement cap reached." });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not create the re-engagement task." });
      }
      await emitActivity({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, prospectId: input.prospectId,
        subject: "Re-engagement task created from a detected job change",
      });
      return { ok: true as const, taskStatus: res.taskStatus };
    }),
});
