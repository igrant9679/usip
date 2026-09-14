/**
 * prospectSources router — the registry, credentials, budget ledger and
 * staged vendor searches (server/services/prospectSources/*).
 *
 *   list / describe   — every source with manifest, credential status,
 *                       circuit, live budget, and (given criteria) the
 *                       capability verdict for the source strip
 *   saveCredentials   — encrypted upsert (admin + manage_api_keys); a
 *                       changed key is `unvalidated` until tested
 *   validate          — live vendor check; captures scopes/tier/tool schemas
 *   removeCredentials
 *   ledger            — current-period rows + what the vendor reports
 *   startSearch / getRun / listRuns / resultRaw
 *   estimatePromotion — units the selection would spend, before confirming
 *   promote           — acquire on-demand rows, then push into People
 *
 * Never returns a secret: reads go through credentialView (masked).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { checkPermission } from "../db";
import { recordAudit } from "../audit";
import { PROSPECT_SOURCE_SLUGS } from "@shared/prospectSources";
import { describeSources, getSource } from "../services/prospectSources/registry";
import { credentialView, loadCredentials, recordValidation, saveCredentials } from "../services/prospectSources/credentials";
import { ledgerView } from "../services/prospectSources/ledger";
import {
  MAX_BATCH_TARGET, estimatePromotion, getResultRaw, getRun, listRuns, promoteResults, startRun,
} from "../services/prospectSources/searchRuns";

const slugSchema = z.enum(PROSPECT_SOURCE_SLUGS);

const criteriaSchema = z.object({
  jobTitles: z.array(z.string().max(120)).max(20).default([]),
  seniorities: z.array(z.string().max(60)).max(10).default([]),
  departments: z.array(z.string().max(60)).max(10).default([]),
  industries: z.array(z.string().max(120)).max(20).default([]),
  countries: z.array(z.string().max(60)).max(20).default([]),
  stateProvinces: z.array(z.string().max(80)).max(20).default([]),
  cities: z.array(z.string().max(80)).max(20).default([]),
  postalCodes: z.array(z.string().max(20)).max(20).default([]),
  companyNames: z.array(z.string().max(200)).max(20).default([]),
  companyDomains: z.array(z.string().max(200)).max(20).default([]),
  headcountRange: z.object({ min: z.number().int().min(0).optional(), max: z.number().int().min(0).optional() }).optional(),
  revenueRange: z.object({ min: z.number().min(0).optional(), max: z.number().min(0).optional() }).optional(),
  keywords: z.array(z.string().max(120)).max(20).default([]),
  hasEmail: z.boolean().optional(),
  hasPhone: z.boolean().optional(),
  technologies: z.array(z.string().max(80)).max(20).default([]),
});

export const prospectSourcesRouter = router({
  /** Registry view for Settings and the search page. Criteria optional (adds the match verdict). */
  describe: workspaceProcedure
    .input(z.object({ criteria: criteriaSchema.optional() }).optional())
    .query(async ({ ctx, input }) => {
      const sources = await describeSources(ctx.workspace.id, input?.criteria ?? null);
      // Strip anything a secret could hide in; config holds schemas/tier only.
      return sources.map((s) => ({ ...s, credential: { ...s.credential, config: redactConfig(s.credential.config) } }));
    }),

  saveCredentials: adminWsProcedure
    .input(z.object({
      slug: slugSchema,
      apiKey: z.string().max(500).optional(),
      config: z.object({
        billingAnniversaryDay: z.number().int().min(1).max(28).nullable().optional(),
        monthlyLeadAllowance: z.number().int().min(0).max(10_000_000).nullable().optional(),
        leadCreditBalance: z.number().int().min(0).max(10_000_000).nullable().optional(),
      }).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await checkPermission(ctx, "manage_api_keys");
      const s = getSource(input.slug);
      if (s.credentialMode !== "table") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `${s.displayName} keys are managed on its own card (Settings → Data sources).` });
      }
      const config: Record<string, unknown> = {};
      if (input.config) {
        const c = input.config;
        if (c.billingAnniversaryDay !== undefined) config.billingAnniversaryDay = c.billingAnniversaryDay ?? undefined;
        if (c.monthlyLeadAllowance !== undefined) config.monthlyLeadAllowance = c.monthlyLeadAllowance ?? undefined;
        if (c.leadCreditBalance !== undefined) config.leadCreditBalance = c.leadCreditBalance ?? undefined;
      }
      await saveCredentials(ctx.workspace.id, input.slug, {
        ...(input.apiKey !== undefined ? { secrets: { apiKey: input.apiKey.trim() } } : {}),
        config,
      });
      await recordAudit({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update",
        entityType: "prospect_source_credentials", entityId: ctx.workspace.id,
        after: { slug: input.slug, keyChanged: input.apiKey !== undefined, cleared: input.apiKey === "", config },
      });
      return { ok: true as const };
    }),

  /** Live validation. Persists scopes / tier / captured tool schemas on success. */
  validate: adminWsProcedure
    .input(z.object({ slug: slugSchema }))
    .mutation(async ({ ctx, input }) => {
      const s = getSource(input.slug);
      const creds = await loadCredentials(ctx.workspace.id, s);
      if (!creds) throw new TRPCError({ code: "BAD_REQUEST", message: `No ${s.displayName} API key configured.` });
      const r = await s.validateCredentials(creds);
      if (s.credentialMode === "table") await recordValidation(ctx.workspace.id, input.slug, r);
      if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.message });
      return { ok: true as const, message: r.message, discovered: redactConfig(r.discovered ?? {}) };
    }),

  removeCredentials: adminWsProcedure
    .input(z.object({ slug: slugSchema }))
    .mutation(async ({ ctx, input }) => {
      await checkPermission(ctx, "manage_api_keys");
      const s = getSource(input.slug);
      if (s.credentialMode !== "table") throw new TRPCError({ code: "BAD_REQUEST", message: "Managed on its own card." });
      await saveCredentials(ctx.workspace.id, input.slug, { secrets: { apiKey: "" } });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "prospect_source_credentials", entityId: ctx.workspace.id, after: { slug: input.slug, cleared: true } });
      return { ok: true as const };
    }),

  /** Budget ledger for one source: current-period rows + the vendor's own report. */
  ledger: workspaceProcedure
    .input(z.object({ slug: slugSchema }))
    .query(async ({ ctx, input }) => {
      const s = getSource(input.slug);
      const creds = await loadCredentials(ctx.workspace.id, s);
      if (!creds) return { configured: false as const, rows: [], vendor: [] };
      const periods = s.budgetPeriods({ now: new Date(), credentials: creds });
      const rows = await ledgerView(ctx.workspace.id, input.slug, periods);
      let vendor: Awaited<ReturnType<typeof s.remainingBudget>> = [];
      try { vendor = await s.remainingBudget(creds); } catch { vendor = []; }
      return { configured: true as const, rows, vendor };
    }),

  startSearch: workspaceProcedure
    .input(z.object({ criteria: criteriaSchema, batchTarget: z.number().int().min(1).max(MAX_BATCH_TARGET).default(25) }))
    .mutation(async ({ ctx, input }) => {
      const view = await credentialView(ctx.workspace.id, getSource("warmysender"));
      const any = view.configured || (await loadCredentials(ctx.workspace.id, getSource("quickenrich"))) || (await loadCredentials(ctx.workspace.id, getSource("apollo")));
      if (!any) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No prospect-data vendor is connected yet. Add a key under Settings → Data sources." });
      }
      try {
        const r = await startRun(ctx.workspace.id, ctx.user.id, input.criteria, input.batchTarget);
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "prospect_search_run", entityId: r.runId, after: { batchTarget: input.batchTarget } });
        return r;
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: (e as Error).message });
      }
    }),

  getRun: workspaceProcedure
    .input(z.object({ runId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const r = await getRun(ctx.workspace.id, input.runId);
      if (!r) throw new TRPCError({ code: "NOT_FOUND" });
      return r;
    }),

  listRuns: workspaceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(20) }).optional())
    .query(async ({ ctx, input }) => listRuns(ctx.workspace.id, input?.limit ?? 20)),

  /** The vendor's raw row for one staged result (run inspector). */
  resultRaw: workspaceProcedure
    .input(z.object({ resultId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const r = await getResultRaw(ctx.workspace.id, input.resultId);
      if (!r) throw new TRPCError({ code: "NOT_FOUND" });
      return { id: r.id, sourceSlug: r.sourceSlug, externalId: r.externalId, rawPayload: r.rawPayload, normalized: r.normalized };
    }),

  estimatePromotion: workspaceProcedure
    .input(z.object({ runId: z.number().int(), resultIds: z.array(z.number().int()).max(500) }))
    .query(async ({ ctx, input }) => estimatePromotion(ctx.workspace.id, input.runId, input.resultIds)),

  /** Spends units (on-demand sources) then promotes into People. Confirmed client-side with the estimate. */
  promote: workspaceProcedure
    .input(z.object({ runId: z.number().int(), resultIds: z.array(z.number().int()).min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const r = await promoteResults(ctx.workspace.id, ctx.user.id, input.runId, input.resultIds);
      await recordAudit({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "prospect_search_run", entityId: input.runId,
        after: { selected: input.resultIds.length, promoted: r.promoted, acquired: r.acquired, unitsSpent: r.unitsSpent, failed: r.failed },
      });
      return r;
    }),
});

/** Config is non-secret by construction; still drop anything key-shaped defensively. */
function redactConfig(c: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(c ?? {});
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (/key|secret|token|password/i.test(k)) continue;
    out[k] = c[k];
  }
  return out;
}
