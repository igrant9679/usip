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
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { checkPermission, getDb } from "../db";
import { getOrSeedSettings } from "./admin";
import { recordAudit } from "../audit";
import { LEADOCEAN_EMAIL_STATUSES, PROSPECT_SOURCE_SLUGS, isProspectDatabase } from "@shared/prospectSources";
import { forViewer, isPlatformOwner, sourceNamesFor } from "../services/prospectPool";
import { describeSources, forgetDisplayBudget, getSource, listSources, periodsFor } from "../services/prospectSources/registry";
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
      const out = sources.map((s) => ({ ...s, credential: { ...s.credential, config: redactConfig(s.credential.config) } }));
      // Members read "Source N" and its description, never the vendor's name
      // or its site (owner 2026-11-25); only the platform owner reads them.
      const platformOwner = isPlatformOwner(ctx.user);
      if (platformOwner) return out;
      const names = new Map((await sourceNamesFor({ platformOwner: false })).map((n) => [n.slug, n]));
      return forViewer(out.map((s) => ({ ...s, displayName: names.get(s.slug)?.label ?? s.displayName, docsUrl: "" })), { platformOwner: false });
    }),

  /**
   * What each prospect source is called for this viewer (owner 2026-11-25):
   * "Source N" and its description for every member; the vendor's name for
   * the platform owner only. Every screen that names a source reads this.
   */
  names: workspaceProcedure.query(async ({ ctx }) => {
    const platformOwner = isPlatformOwner(ctx.user);
    return { platformOwner, sources: await sourceNamesFor({ platformOwner }) };
  }),

  /**
   * The one prospect source a workspace on a plan finds people through, and
   * every source it could choose, each with whether it has room this month
   * (Settings → Data sources). `onPlan: false` = no plan: the waterfall runs
   * as before and there is nothing to choose.
   */
  choices: workspaceProcedure.query(async ({ ctx }) => {
    const { sourceChoices } = await import("../services/prospectSourceChoice");
    return sourceChoices(ctx.workspace.id);
  }),

  /** Choose this workspace's one prospect source, or go back to the default (null). Admins only. */
  setChoice: adminWsProcedure
    .input(z.object({ slug: slugSchema.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const { setProspectSource } = await import("../services/prospectSourceChoice");
      if (input.slug && !isProspectDatabase(input.slug)) throw new TRPCError({ code: "BAD_REQUEST", message: "That source cannot be chosen." });
      await setProspectSource(ctx.workspace.id, input.slug);
      await recordAudit({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "workspace_settings", entityId: ctx.workspace.id,
        after: { prospectSource: input.slug },
      });
      return { ok: true as const, slug: input.slug };
    }),

  saveCredentials: adminWsProcedure
    .input(z.object({
      slug: slugSchema,
      apiKey: z.string().max(500).optional(),
      config: z.object({
        billingAnniversaryDay: z.number().int().min(1).max(28).nullable().optional(),
        monthlyLeadAllowance: z.number().int().min(0).max(10_000_000).nullable().optional(),
        leadCreditBalance: z.number().int().min(0).max(10_000_000).nullable().optional(),
        // LeadOcean's options. The never-accepted statuses are not in this list,
        // so no request can name one.
        acceptedEmailStatuses: z.array(z.enum(LEADOCEAN_EMAIL_STATUSES)).min(1).optional(),
        fetchPhones: z.boolean().optional(),
        dailyPeopleCap: z.number().int().min(1).max(10_000_000).nullable().optional(),
        // WarmySender's: verify an address Reoon could not decide (services/secondVerifier). On unless set false.
        verifyUndecided: z.boolean().optional(),
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
        if (input.slug === "warmysender" && c.verifyUndecided !== undefined) config.verifyUndecided = c.verifyUndecided;
        if (input.slug === "leadocean") {
          if (c.acceptedEmailStatuses !== undefined) config.acceptedEmailStatuses = c.acceptedEmailStatuses;
          if (c.fetchPhones !== undefined) config.fetchPhones = c.fetchPhones;
          if (c.dailyPeopleCap !== undefined) config.dailyPeopleCap = c.dailyPeopleCap ?? undefined;
        }
      }
      await saveCredentials(ctx.workspace.id, input.slug, {
        ...(input.apiKey !== undefined ? { secrets: { apiKey: input.apiKey.trim() } } : {}),
        config,
      });
      forgetDisplayBudget(ctx.workspace.id, input.slug);
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
      forgetDisplayBudget(ctx.workspace.id, input.slug);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "prospect_source_credentials", entityId: ctx.workspace.id, after: { slug: input.slug, cleared: true } });
      return { ok: true as const };
    }),

  /**
   * Workspace-wide on/off for one source. Writes the SAME areScraperSources
   * mask ARE Settings edits (one vocabulary, migration 0172); the registry
   * waterfall and campaign discovery both honour it, so "off" stops searches
   * and spends while the saved key and ledger history stay put.
   */
  setEnabled: adminWsProcedure
    .input(z.object({ slug: slugSchema, enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await checkPermission(ctx, "manage_api_keys");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const row = await getOrSeedSettings(ctx.workspace.id);
      const prior = ((row as Record<string, unknown>).areScraperSources ?? {}) as Record<string, boolean>;
      const mask = { ...(typeof prior === "object" && prior ? prior : {}), [input.slug]: input.enabled };
      await db.update(workspaceSettings).set({ areScraperSources: mask } as never)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      await recordAudit({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update",
        entityType: "prospect_source_credentials", entityId: ctx.workspace.id,
        after: { slug: input.slug, enabled: input.enabled },
      });
      return { ok: true as const, enabled: input.enabled };
    }),

  /** Budget ledger for one source: current-period rows + the vendor's own report. */
  ledger: workspaceProcedure
    .input(z.object({ slug: slugSchema }))
    .query(async ({ ctx, input }) => {
      const s = getSource(input.slug);
      const creds = await loadCredentials(ctx.workspace.id, s);
      if (!creds) return { configured: false as const, rows: [], vendor: [] };
      const periods = periodsFor(s, creds);
      const rows = await ledgerView(ctx.workspace.id, input.slug, periods);
      let vendor: Awaited<ReturnType<typeof s.remainingBudget>> = [];
      try { vendor = await s.remainingBudget(creds); } catch { vendor = []; }
      return { configured: true as const, rows, vendor };
    }),

  startSearch: workspaceProcedure
    .input(z.object({
      criteria: criteriaSchema,
      batchTarget: z.number().int().min(1).max(MAX_BATCH_TARGET).default(25),
      /** Per-run source picker (owner ask 2026-09-22). Absent = every eligible source, as before. */
      sources: z.array(slugSchema).min(1).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const views = await Promise.all(listSources().map((s) => credentialView(ctx.workspace.id, s)));
      if (!views.some((v) => v.configured)) {
        // Vendor-free (member-facing): on a membership plan the included
        // prospect data is reached through keys the platform shares or lends,
        // so a workspace with none of those and no key of its own lands here.
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No prospect database is connected to this workspace yet. On a membership plan, prospect data is included up to your plan's monthly number once it is switched on for your workspace; you can also add a key of your own under Settings → Data sources." });
      }
      try {
        const r = await startRun(ctx.workspace.id, ctx.user.id, input.criteria, input.batchTarget, input.sources ?? null);
        // Found the same search still going: nothing new was started (P77).
        if (r.alreadyRunning) return r;
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
      // The run's notes and per-source reasons as members may read them; the
      // found people's own fields are data and are not rewritten.
      return { ...r, run: await forViewer(r.run, { platformOwner: isPlatformOwner(ctx.user) }) };
    }),

  listRuns: workspaceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(20) }).optional())
    .query(async ({ ctx, input }) => forViewer(await listRuns(ctx.workspace.id, input?.limit ?? 20), { platformOwner: isPlatformOwner(ctx.user) })),

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
      // This workspace's search run (audit 2026-10-20, X1.1). promoteResults
      // reads only its own rows; another's run id still wrote an audit entry.
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { requireInWorkspace } = await import("../services/foreignIds");
      const { prospectSearchRuns } = await import("../../drizzle/schema");
      await requireInWorkspace(db, prospectSearchRuns, input.runId, ctx.workspace.id, "Search run");
      const r = await promoteResults(ctx.workspace.id, ctx.user.id, input.runId, input.resultIds);
      await recordAudit({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "prospect_search_run", entityId: input.runId,
        after: { selected: input.resultIds.length, promoted: r.promoted, acquired: r.acquired, unitsSpent: r.unitsSpent, failed: r.failed },
      });
      return { ...r, errors: await forViewer(r.errors, { platformOwner: isPlatformOwner(ctx.user) }) };
    }),
});

/**
 * Config is non-secret by construction; still drop anything named like a
 * secret, defensively. The names are listed rather than matched by "key"
 * anywhere in them (N3, 2026-11-06): that also dropped `sampleRowKeys`, the
 * WarmySender row fields Test connection stores so a renamed field can be
 * diagnosed, so it never showed.
 */
export function redactConfig(c: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(c ?? {});
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (isSecretName(k)) continue;
    out[k] = c[k];
  }
  return out;
}

/** "apiKey", "api_key", "key", "secretKey", "clientSecret", "accessToken", "password", "auth"… */
export function isSecretName(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z]/g, "");
  return /^(api|secret|private|access|client|signing|webhook)?key$/.test(n)
    || /(secret|token|password|passwd|credential|bearer)/.test(n)
    || n === "auth" || n === "authorization";
}
