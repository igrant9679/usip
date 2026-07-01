/**
 * Companies router — the Apollo-style company/account layer.
 *
 * Search + profile reads, prospect→company association + backfill, contact
 * linking, enrichment, logo management, and merge. `accounts` is the workspace-
 * account record; global_organizations is the shared layer. Every query is
 * workspace-scoped. Permission map: view → any member · create/edit/enrich/link
 * → manager+ · merge/archive/logo → admin+.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { and, eq } from "drizzle-orm";
import { accounts, globalOrganizations, prospects } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { searchWorkspaceAccounts } from "../services/company/searchService";
import {
  getCompanyProfile, getCompanyContacts, getCompanyActivity, getCompanyEnrichmentHistory,
  getCompanyTechnologies, getCompanyFunding, getCompanyScore,
} from "../services/company/profileService";
import {
  associateProspectToCompany, associateBulkProspectsToCompanies, associateUnlinkedProspects,
  linkContactToAccount, unlinkContactFromAccount, createWorkspaceAccount, companyInputFromProspect,
} from "../services/company/associationService";
import { findWorkspaceAccountMatch } from "../services/company/matchingService";
import { enrichCompany, bulkEnrichCompanies } from "../services/company/enrichmentService";
import { updateCompanyLogo, clearCompanyLogo, setCompanyLogoStatus } from "../services/company/logoService";
import { findDuplicateAccounts, mergeAccounts } from "../services/company/mergeService";

const RANK: Record<string, number> = { super_admin: 4, admin: 3, manager: 2, rep: 1 };
function requireRole(role: string, min: "manager" | "admin") {
  if ((RANK[role] ?? 0) < RANK[min]) throw new TRPCError({ code: "FORBIDDEN", message: "You don't have permission for this company action." });
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
  technologies: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb(); if (!db) return [];
      const [a] = await db.select({ orgId: accounts.globalOrganizationId }).from(accounts).where(and(eq(accounts.workspaceId, ctx.workspace.id), eq(accounts.id, input.accountId))).limit(1);
      return getCompanyTechnologies(a?.orgId ?? null);
    }),
  funding: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb(); if (!db) return [];
      const [a] = await db.select({ orgId: accounts.globalOrganizationId }).from(accounts).where(and(eq(accounts.workspaceId, ctx.workspace.id), eq(accounts.id, input.accountId))).limit(1);
      return getCompanyFunding(a?.orgId ?? null);
    }),
  score: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => getCompanyScore(ctx.workspace.id, input.accountId)),

  /* ── mutations: edit / archive ── */
  update: workspaceProcedure
    .input(z.object({
      accountId: z.number().int().positive(),
      name: z.string().max(200).optional(), industry: z.string().max(80).nullable().optional(),
      websiteUrl: z.string().max(500).nullable().optional(), linkedinCompanyUrl: z.string().max(500).nullable().optional(),
      employeeCount: z.number().int().nullable().optional(), accountStage: z.string().max(64).nullable().optional(),
      ownerUserId: z.number().int().nullable().optional(), description: z.string().max(4000).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { accountId, ...rest } = input;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
      if (Object.keys(patch).length) await db.update(accounts).set(patch as never).where(and(eq(accounts.workspaceId, ctx.workspace.id), eq(accounts.id, accountId)));
      return { ok: true as const };
    }),
  archive: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(accounts).set({ archivedAt: new Date() } as never).where(and(eq(accounts.workspaceId, ctx.workspace.id), eq(accounts.id, input.accountId)));
      return { ok: true as const };
    }),

  /* ── association / linking ── */
  associateProspect: workspaceProcedure
    .input(z.object({ prospectId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [p] = await db.select().from(prospects).where(and(eq(prospects.workspaceId, ctx.workspace.id), eq(prospects.id, input.prospectId))).limit(1);
      if (!p) throw new TRPCError({ code: "NOT_FOUND" });
      return associateProspectToCompany(p as never, { sourceType: "manual" });
    }),
  backfill: workspaceProcedure.mutation(async ({ ctx }) => {
    requireRole(ctx.member.role, "manager");
    return associateUnlinkedProspects(ctx.workspace.id);
  }),
  associateBulk: workspaceProcedure
    .input(z.object({ prospectIds: z.array(z.number().int().positive()).min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      return associateBulkProspectsToCompanies(ctx.workspace.id, input.prospectIds, "manual_bulk");
    }),
  createFromProspect: workspaceProcedure
    .input(z.object({ prospectId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [p] = await db.select().from(prospects).where(and(eq(prospects.workspaceId, ctx.workspace.id), eq(prospects.id, input.prospectId))).limit(1);
      if (!p) throw new TRPCError({ code: "NOT_FOUND" });
      const accountId = await createWorkspaceAccount(ctx.workspace.id, companyInputFromProspect(p as never), "manual");
      return { accountId };
    }),
  matchCandidates: workspaceProcedure
    .input(z.object({ name: z.string().optional(), domain: z.string().optional(), website: z.string().optional(), linkedinCompanyUrl: z.string().optional() }))
    .query(async ({ ctx, input }) => findWorkspaceAccountMatch(ctx.workspace.id, input)),
  linkContact: workspaceProcedure
    .input(z.object({ contactId: z.number().int().positive(), accountId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      await linkContactToAccount(ctx.workspace.id, input.contactId, input.accountId);
      return { ok: true as const };
    }),
  unlinkContact: workspaceProcedure
    .input(z.object({ contactId: z.number().int().positive(), accountId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      await unlinkContactFromAccount(ctx.workspace.id, input.contactId, input.accountId);
      return { ok: true as const };
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

  /* ── logo ── */
  updateLogo: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive(), logoUrl: z.string().url(), sourceType: z.enum(["user_uploaded", "crm_import", "enrichment_provider", "permitted_public_url", "website_logo", "manual_entry"]), sourceUrl: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      const res = await updateCompanyLogo(ctx.workspace.id, input.accountId, { logoUrl: input.logoUrl, sourceType: input.sourceType, sourceUrl: input.sourceUrl });
      if (!res.ok) throw new TRPCError({ code: "BAD_REQUEST", message: res.reason });
      return res;
    }),
  verifyLogo: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive(), status: z.enum(["available", "failed_to_load", "blocked_by_policy", "removed", "unavailable"]) }))
    .mutation(async ({ ctx, input }) => {
      await setCompanyLogoStatus(ctx.workspace.id, input.accountId, input.status);
      return { ok: true as const };
    }),
  deleteLogo: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      await clearCompanyLogo(ctx.workspace.id, input.accountId);
      return { ok: true as const };
    }),

  /* ── merge ── */
  duplicates: workspaceProcedure.query(async ({ ctx }) => findDuplicateAccounts(ctx.workspace.id)),
  merge: workspaceProcedure
    .input(z.object({ primaryAccountId: z.number().int().positive(), duplicateAccountId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      const res = await mergeAccounts(ctx.workspace.id, input.primaryAccountId, input.duplicateAccountId);
      if (!res.ok) throw new TRPCError({ code: "BAD_REQUEST", message: res.reason });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "account_merge", entityId: input.primaryAccountId, after: { merged: input.duplicateAccountId } });
      return res;
    }),

  /* ── global organizations (shared layer) ── */
  organization: workspaceProcedure
    .input(z.object({ organizationId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = await getDb(); if (!db) return null;
      const [org] = await db.select().from(globalOrganizations).where(eq(globalOrganizations.id, input.organizationId)).limit(1);
      return org ?? null;
    }),
});
