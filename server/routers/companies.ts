/**
 * Companies router — the Apollo-style company/account layer.
 *
 * Search + profile reads, prospect→company backfill, enrichment, brand
 * reconciliation, and duplicate review/merge. `accounts` is the workspace-
 * account record. Every query is workspace-scoped. Permission map: view → any
 * member · enrich/backfill → manager+ · merge/archive/brand-override → admin+.
 *
 * 2026-08-12 owner-approved trim: 15 procedures nothing called were removed
 * (brandSearch, technologies, funding, score, update, associateProspect,
 * associateBulk, createFromProspect, matchCandidates, link/unlinkContact,
 * the three logo mutations, organization). The services behind the removed
 * procedures largely stay — enrichment/association/logo paths call them; the
 * router just stopped pretending to be their UI.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { workspaceProcedure, requireMinRole } from "../_core/workspace";
import { getDb } from "../db";
import { and, eq } from "drizzle-orm";
import { accounts } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { searchWorkspaceAccounts } from "../services/company/searchService";
import {
  getCompanyProfile, getCompanyContacts, getCompanyActivity, getCompanyEnrichmentHistory,
} from "../services/company/profileService";
import { associateUnlinkedProspects } from "../services/company/associationService";
import { enrichCompany, bulkEnrichCompanies } from "../services/company/enrichmentService";
import { findDuplicateAccounts, mergeAccounts } from "../services/company/mergeService";

// One rank map — _core/workspace.ts. Four routers had their own copy.
function requireRole(role: string, min: "manager" | "admin") {
  requireMinRole(role, min, "You don't have permission for this company action.");
}

const filters = z.object({
  q: z.string().max(200).optional(),
  industries: z.array(z.string()).optional(),
  ownerIds: z.array(z.number().int()).optional(),
  accountStages: z.array(z.string()).optional(),
  employeeMin: z.number().int().optional(),
  employeeMax: z.number().int().optional(),
  revenueMin: z.number().optional(),
  revenueMax: z.number().optional(),
  locations: z.array(z.string()).optional(),
  hasContacts: z.boolean().optional(),
  minRating: z.enum(["fair", "good", "excellent"]).optional(),
  includeArchived: z.boolean().optional(),
}).optional();
const sort = z.object({
  field: z.enum(["name", "employeeCount", "revenue", "score", "lastEnriched", "createdAt", "contactCount"]),
  direction: z.enum(["asc", "desc"]),
}).optional();

export const companiesRouter = router({
  /* ── Brand identity reconciliation (company-enrichment stack) ──
     The reconciler is the ONLY automated Brand Search caller; these actions
     let an admin run/inspect/override it per account. */
  reconcileBrand: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      const { reconcileAccountBrand } = await import("../services/company/brandReconciler");
      const result = await reconcileAccountBrand(ctx.workspace.id, input.accountId, { byUserId: ctx.user.id });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "brand_reconcile", entityId: input.accountId, after: { action: result.action, changes: result.changes } });
      return result;
    }),
  brandObservations: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb(); if (!db) return [];
      const { brandObservations } = await import("../../drizzle/schema");
      const { desc } = await import("drizzle-orm");
      return db.select().from(brandObservations)
        .where(and(eq(brandObservations.workspaceId, ctx.workspace.id), eq(brandObservations.accountId, input.accountId)))
        .orderBy(desc(brandObservations.observedAt)).limit(20);
    }),
  setBrandOverride: workspaceProcedure
    .input(z.object({
      accountId: z.number().int().positive(),
      name: z.string().trim().min(1).max(200).optional(),
      domain: z.string().trim().min(3).max(200).optional(),
      reason: z.string().trim().max(300).optional(),
    }).refine((v) => v.name || v.domain, { message: "Override at least one of name or domain." }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const override = {
        ...(input.name ? { name: input.name } : {}),
        ...(input.domain ? { domain: input.domain } : {}),
        byUserId: ctx.user.id, at: new Date().toISOString(),
        ...(input.reason ? { reason: input.reason } : {}),
      };
      // The override IS the value: pin the fields it names so display matches.
      // The pin is also recorded in the account ledger at user·100 (roadmap
      // P2.1) — no automated source can ever outrank it.
      const { normalizeCompanyName, normalizeDomain } = await import("../services/company/normalize");
      const { userPinProvenance } = await import("../services/company/accountProvenance");
      const [cur] = await db.select({ fieldProvenance: accounts.fieldProvenance }).from(accounts)
        .where(and(eq(accounts.workspaceId, ctx.workspace.id), eq(accounts.id, input.accountId))).limit(1);
      const ledger = { ...((cur?.fieldProvenance ?? {}) as Record<string, unknown>) };
      const set: Record<string, unknown> = { brandOverride: override };
      if (input.name) { set.name = input.name; set.normalizedName = normalizeCompanyName(input.name); ledger.name = userPinProvenance(override.at); }
      if (input.domain) {
        const d = normalizeDomain(input.domain);
        if (!d) throw new TRPCError({ code: "BAD_REQUEST", message: "That doesn't look like a domain." });
        set.domain = d; set.normalizedDomain = d; ledger.domain = userPinProvenance(override.at);
      }
      set.fieldProvenance = ledger;
      await db.update(accounts).set(set as never).where(and(eq(accounts.workspaceId, ctx.workspace.id), eq(accounts.id, input.accountId)));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "brand_override", entityId: input.accountId, after: override });
      return { ok: true };
    }),
  removeBrandOverride: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(accounts).set({ brandOverride: null } as never).where(and(eq(accounts.workspaceId, ctx.workspace.id), eq(accounts.id, input.accountId)));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "brand_override", entityId: input.accountId });
      return { ok: true };
    }),

  /* ── search / list ── */
  search: workspaceProcedure
    .input(z.object({ filters, sort, page: z.number().int().min(1).default(1), perPage: z.number().int().min(10).max(200).default(50) }))
    .query(async ({ ctx, input }) => searchWorkspaceAccounts(ctx.workspace.id, input)),

  /* ── profile reads ── */
  get: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const profile = await getCompanyProfile(ctx.workspace.id, input.accountId);
      if (!profile) throw new TRPCError({ code: "NOT_FOUND" });
      return profile;
    }),
  contacts: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => getCompanyContacts(ctx.workspace.id, input.accountId)),
  activity: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => getCompanyActivity(ctx.workspace.id, input.accountId)),
  enrichmentHistory: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => getCompanyEnrichmentHistory(ctx.workspace.id, input.accountId)),

  /* ── mutations: archive ── */
  archive: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(accounts).set({ archivedAt: new Date() } as never).where(and(eq(accounts.workspaceId, ctx.workspace.id), eq(accounts.id, input.accountId)));
      return { ok: true as const };
    }),

  /* ── association ── */
  backfill: workspaceProcedure.mutation(async ({ ctx }) => {
    requireRole(ctx.member.role, "manager");
    return associateUnlinkedProspects(ctx.workspace.id);
  }),

  /* ── enrichment ── */
  enrich: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive(), provided: z.record(z.string(), z.any()).optional() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      const res = await enrichCompany(ctx.workspace.id, input.accountId, { userId: ctx.user.id, provided: input.provided ?? null });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "company_enrichment", entityId: input.accountId, after: { fields: res.fieldsUpdated } });
      return res;
    }),
  bulkEnrich: workspaceProcedure
    .input(z.object({ accountIds: z.array(z.number().int().positive()).min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      return bulkEnrichCompanies(ctx.workspace.id, input.accountIds, ctx.user.id);
    }),

  /* ── merge ── */
  duplicates: workspaceProcedure.query(async ({ ctx }) => findDuplicateAccounts(ctx.workspace.id)),

  /**
   * Bulk brand resolution (owner ask 2026-08-13: every company gets its
   * domain + icon). One call = repair URL-shaped account names in THIS
   * workspace, then run one bounded Brandfetch sweep pass (the same
   * runBrandReconciliation the 6h cron uses — bands, negative cache and
   * spacing all apply), SCOPED to this workspace so the spend and the
   * remaining-count below describe the same set of accounts.
   * Returns how many unverified accounts remain in this workspace so a
   * caller can loop. Note the remainder plateaus above zero: a no_match
   * account stays unverified for the 7-day negative cache. "Stops falling"
   * is the finish line, not zero. Admin only: this spends the Brandfetch
   * search allowance.
   */
  resolveBrandsBatch: workspaceProcedure
    .input(z.object({
      searchLimit: z.number().int().min(1).max(50).default(30),
      /** "domainless" (the default) spends searches only where a domain is
       *  missing — the point of the batch. "all" also re-verifies accounts
       *  that already have one, which the 6h cron otherwise does for free. */
      target: z.enum(["domainless", "all"]).default("domainless"),
    }).optional())
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      const { repairUrlNamedAccounts } = await import("../services/company/nameRepair");
      const urlNames = await repairUrlNamedAccounts(ctx.workspace.id);
      const { runBrandReconciliation } = await import("../services/company/brandReconciler");
      const sweep = await runBrandReconciliation({
        limit: input?.searchLimit ?? 30,
        workspaceId: ctx.workspace.id,
        domainlessOnly: (input?.target ?? "domainless") === "domainless",
      });
      // The sweep only STORES what it saw; a name-only hit writes nothing by
      // the reconciler's spec. Adoption is the separate, lower-trust step that
      // turns those stored name matches into domains for accounts that have
      // none — see domainAdopt.ts for why it is deliberately weak.
      const { adoptBrandDomains } = await import("../services/company/domainAdopt");
      const adopted = await adoptBrandDomains(ctx.workspace.id);
      const db = await getDb();
      let remainingUnverified = 0;
      let remainingWithoutDomain = 0;
      if (db) {
        const { isNull, ne, or: dor, sql: dsql } = await import("drizzle-orm");
        const base = [
          eq(accounts.workspaceId, ctx.workspace.id),
          isNull(accounts.archivedAt),
          ne(accounts.name, ""),
        ];
        const [unverified] = await db.select({ n: dsql<number>`COUNT(*)` }).from(accounts)
          .where(and(...base, isNull(accounts.brandVerifiedAt)));
        remainingUnverified = Number(unverified?.n ?? 0);
        // The metric that actually tracks the owner's ask. `remainingUnverified`
        // plateaus by design (a name match never verifies), so a loop watching
        // only that would stop while domains were still being filled.
        const [domainless] = await db.select({ n: dsql<number>`COUNT(*)` }).from(accounts)
          .where(and(...base, dor(isNull(accounts.domain), dsql`${accounts.domain} = ''`)));
        remainingWithoutDomain = Number(domainless?.n ?? 0);
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "brand_bulk_resolve", entityId: 0, after: { urlNames, sweep, adopted, remainingUnverified, remainingWithoutDomain } });
      return { urlNames, sweep, adopted, remainingUnverified, remainingWithoutDomain };
    }),
  /**
   * Reverse an association run within a stated time window. Dry run unless
   * `apply` is passed — the plan tells you exactly how many accounts get
   * archived and how many people get detached before anything moves.
   */
  undoAssociation: workspaceProcedure
    .input(z.object({ since: z.string().datetime(), apply: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      const { undoAssociationRun } = await import("../services/company/associationUndo");
      const plan = await undoAssociationRun(ctx.workspace.id, { since: new Date(input.since), apply: input.apply });
      if (input.apply) {
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "association_undo", entityId: 0, after: plan });
      }
      return plan;
    }),
  merge: workspaceProcedure
    .input(z.object({ primaryAccountId: z.number().int().positive(), duplicateAccountId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      const res = await mergeAccounts(ctx.workspace.id, input.primaryAccountId, input.duplicateAccountId);
      if (!res.ok) throw new TRPCError({ code: "BAD_REQUEST", message: res.reason });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "account_merge", entityId: input.primaryAccountId, after: { merged: input.duplicateAccountId } });
      return res;
    }),
});
