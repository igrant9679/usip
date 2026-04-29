/**
 * Clodura.ai tRPC Router
 * Covers: search, reveal (email/phone), credits, taxonomies,
 *         prospect ingest, promote-to-contact, contact enrich (single + bulk),
 *         enrichment history, enrichment settings, saved searches.
 */
import { z } from "zod";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "crypto";
import { router } from "../_core/trpc";
import { workspaceProcedure, adminWsProcedure } from "../_core/workspace";
import { getDb } from "../db";
import {
  contacts,
  prospects,
  cloduraRevealJobs,
  cloduraSavedSearches,
  cloduraEnrichmentJobs,
  cloduraEnrichmentSettings,
  contactEnrichmentHistory,
  workspaceIntegrations,
} from "../../drizzle/schema";
import {
  searchPeople,
  revealEmail,
  revealPhone,
  getCredits,
  getTaxonomy,
  enrichContact,
  CloduraError,
  type CloduraSearchFilters,
} from "../services/clodura/client";
import { getCached, setCached } from "../services/clodura/cache";
import { checkRateLimit } from "../services/clodura/rateLimiter";
import { recordAudit } from "../audit";

/* ─── Helper: get Clodura API key for workspace ───────────────────────────── */
async function getWorkspaceApiKey(workspaceId: number): Promise<string | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const [row] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.provider, "clodura"),
      ),
    )
    .limit(1);
  return (row?.config as any)?.apiKey ?? undefined;
}

/* ─── Helper: map CloduraError → TRPCError ────────────────────────────────── */
function mapCloduraError(e: CloduraError): TRPCError {
  if (e.statusCode === 401) return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Clodura integration unavailable — check the API key in Settings → Integrations." });
  if (e.statusCode === 402) return new TRPCError({ code: "PAYMENT_REQUIRED" as any, message: "Out of Clodura credits. Visit your Clodura plan page to top up." });
  if (e.statusCode === 403) return new TRPCError({ code: "FORBIDDEN", message: e.message });
  if (e.statusCode === 409) return new TRPCError({ code: "CONFLICT", message: "Already enriched within the last few minutes — try again later." });
  if (e.statusCode === 422) return new TRPCError({ code: "BAD_REQUEST", message: e.message });
  if (e.statusCode === 429) return new TRPCError({ code: "TOO_MANY_REQUESTS" as any, message: e.message });
  if (e.statusCode === 400) return new TRPCError({ code: "BAD_REQUEST", message: e.message });
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: e.message });
}

/* ─── Shared filter schema ────────────────────────────────────────────────── */
const filterSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  personTitle: z.array(z.string()).optional(),
  seniority: z.array(z.string()).optional(),
  functional: z.array(z.string()).optional(),
  company: z.array(z.string()).optional(),
  companyDomain: z.array(z.string()).max(10, "Max 10 domains").optional(),
  industry: z.array(z.string()).optional(),
  technology: z.array(z.string()).optional(),
  city: z.array(z.string()).optional(),
  state: z.array(z.string()).optional(),
  country: z.array(z.string()).optional(),
  employeeSize: z.array(z.string()).optional(),
  revenue: z.array(z.string()).optional(),
  linkedinUrl: z.string().optional(),
});

/* ─── Router ──────────────────────────────────────────────────────────────── */
export const cloduraRouter = router({

  /* ── Search ──────────────────────────────────────────────────────────── */
  search: workspaceProcedure
    .input(z.object({
      filters: filterSchema,
      page: z.number().int().min(1).max(100).default(1),
      perPage: z.number().int().refine((v) => [25, 50, 100].includes(v), "perPage must be 25, 50, or 100").default(25),
    }))
    .query(async ({ ctx, input }) => {
      const rl = checkRateLimit(ctx.workspace.id);
      if (!rl.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS" as any,
          message: rl.reason ?? "Rate limit exceeded",
        });
      }

      // Check cache first
      const params = { ...input.filters, page: input.page, perPage: input.perPage };
      const cached = await getCached(ctx.workspace.id, params);
      if (cached) return { ...cached, cacheHit: true };

      const apiKey = await getWorkspaceApiKey(ctx.workspace.id);
      try {
        const result = await searchPeople(params, apiKey);
        await setCached(ctx.workspace.id, params, result);
        return { ...result, cacheHit: false };
      } catch (e) {
        if (e instanceof CloduraError) throw mapCloduraError(e);
        throw e;
      }
    }),

  /* ── Credits ─────────────────────────────────────────────────────────── */
  credits: workspaceProcedure.query(async ({ ctx }) => {
    const apiKey = await getWorkspaceApiKey(ctx.workspace.id);
    try {
      return await getCredits(apiKey);
    } catch (e) {
      if (e instanceof CloduraError) throw mapCloduraError(e);
      throw e;
    }
  }),

  /* ── Taxonomies ──────────────────────────────────────────────────────── */
  taxonomy: workspaceProcedure
    .input(z.object({
      type: z.enum(["seniority", "functional", "industry", "technology", "country", "employeeSize", "revenue"]),
    }))
    .query(async ({ ctx, input }) => {
      const apiKey = await getWorkspaceApiKey(ctx.workspace.id);
      try {
        return await getTaxonomy(input.type, apiKey);
      } catch (e) {
        if (e instanceof CloduraError) throw mapCloduraError(e);
        throw e;
      }
    }),

  /* ── Reveal email ────────────────────────────────────────────────────── */
  revealEmail: workspaceProcedure
    .input(z.object({ prospectId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [prospect] = await db
        .select()
        .from(prospects)
        .where(and(eq(prospects.id, input.prospectId), eq(prospects.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!prospect) throw new TRPCError({ code: "NOT_FOUND", message: "Prospect not found" });
      if (!prospect.cloduraPersonId) throw new TRPCError({ code: "BAD_REQUEST", message: "Prospect has no Clodura person ID" });

      const trackingId = randomUUID();
      const webhookUrl = `${process.env.APP_URL ?? "https://usip-app-production.up.railway.app"}/api/webhooks/clodura/email`;

      const apiKey = await getWorkspaceApiKey(ctx.workspace.id);
      try {
        const result = await revealEmail({ personId: prospect.cloduraPersonId, webhookUrl }, apiKey);
        // Create reveal job row
        await db.insert(cloduraRevealJobs).values({
          trackingId: result.trackingId ?? trackingId,
          prospectId: input.prospectId,
          kind: "email",
          status: result.status === "completed" ? "completed" : "pending",
          requestedBy: ctx.user.id,
          requestedAt: new Date(),
          completedAt: result.status === "completed" ? new Date() : undefined,
        });
        // If synchronous response, update prospect immediately
        if (result.status === "completed" && result.email) {
          await db.update(prospects).set({
            email: result.email,
            emailStatus: "verified",
            emailRevealedAt: new Date(),
          }).where(eq(prospects.id, input.prospectId));
        }
        await recordAudit({
          workspaceId: ctx.workspace.id,
          actorUserId: ctx.user.id,
          action: "create",
          entityType: "clodura_reveal_job",
          entityId: input.prospectId,
        });
        return { trackingId: result.trackingId ?? trackingId, status: result.status };
      } catch (e) {
        if (e instanceof CloduraError) throw mapCloduraError(e);
        throw e;
      }
    }),

  /* ── Reveal phone ────────────────────────────────────────────────────── */
  revealPhone: workspaceProcedure
    .input(z.object({ prospectId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [prospect] = await db
        .select()
        .from(prospects)
        .where(and(eq(prospects.id, input.prospectId), eq(prospects.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!prospect) throw new TRPCError({ code: "NOT_FOUND", message: "Prospect not found" });
      if (!prospect.cloduraPersonId) throw new TRPCError({ code: "BAD_REQUEST", message: "Prospect has no Clodura person ID" });

      const trackingId = randomUUID();
      const webhookUrl = `${process.env.APP_URL ?? "https://usip-app-production.up.railway.app"}/api/webhooks/clodura/phone`;

      const apiKey = await getWorkspaceApiKey(ctx.workspace.id);
      try {
        const result = await revealPhone({ personId: prospect.cloduraPersonId, webhookUrl }, apiKey);
        await db.insert(cloduraRevealJobs).values({
          trackingId: result.trackingId ?? trackingId,
          prospectId: input.prospectId,
          kind: "phone",
          status: result.status === "completed" ? "completed" : "pending",
          requestedBy: ctx.user.id,
          requestedAt: new Date(),
          completedAt: result.status === "completed" ? new Date() : undefined,
        });
        if (result.status === "completed" && result.phone) {
          await db.update(prospects).set({
            phone: result.phone,
            phoneRevealedAt: new Date(),
          }).where(eq(prospects.id, input.prospectId));
        }
        return { trackingId: result.trackingId ?? trackingId, status: result.status };
      } catch (e) {
        if (e instanceof CloduraError) throw mapCloduraError(e);
        throw e;
      }
    }),

  /* ── Reveal job status ───────────────────────────────────────────────── */
  revealJobStatus: workspaceProcedure
    .input(z.object({ trackingId: z.string() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [job] = await db
        .select()
        .from(cloduraRevealJobs)
        .where(eq(cloduraRevealJobs.trackingId, input.trackingId))
        .limit(1);
      if (!job) throw new TRPCError({ code: "NOT_FOUND" });
      return job;
    }),

  /* ── Ingest prospects from search results ────────────────────────────── */
  ingestProspects: workspaceProcedure
    .input(z.object({
      people: z.array(z.object({
        personId: z.string(),
        firstName: z.string(),
        lastName: z.string(),
        personTitle: z.string().optional(),
        seniority: z.array(z.string()).optional(),
        functional: z.array(z.string()).optional(),
        linkedinUrl: z.string().optional(),
        personCity: z.string().optional(),
        personState: z.string().optional(),
        personCountry: z.string().optional(),
        organizationName: z.string().optional(),
        organizationId: z.string().optional(),
        companyDomain: z.array(z.string()).optional(),
        industry: z.array(z.string()).optional(),
        contactEmailStatus: z.string().optional(),
      })),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      let created = 0;
      let skipped = 0;

      for (const p of input.people) {
        // Idempotent on clodura_person_id
        const [existing] = await db
          .select({ id: prospects.id })
          .from(prospects)
          .where(
            and(
              eq(prospects.workspaceId, ctx.workspace.id),
              eq(prospects.cloduraPersonId, p.personId),
            ),
          )
          .limit(1);

        if (existing) {
          skipped++;
          continue;
        }

        await db.insert(prospects).values({
          workspaceId: ctx.workspace.id,
          cloduraPersonId: p.personId,
          cloduraOrgId: p.organizationId ?? null,
          cloduraSyncedAt: new Date(),
          firstName: p.firstName,
          lastName: p.lastName,
          title: p.personTitle ?? null,
          seniority: p.seniority?.[0] ?? null,
          functionalArea: p.functional?.[0] ?? null,
          linkedinUrl: p.linkedinUrl ?? null,
          city: p.personCity ?? null,
          state: p.personState ?? null,
          country: p.personCountry ?? null,
          company: p.organizationName ?? null,
          companyDomain: p.companyDomain?.[0] ?? null,
          industry: p.industry?.[0] ?? null,
          emailStatus: p.contactEmailStatus ?? null,
        });
        created++;
      }

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "prospects_ingest",
        after: { created, skipped },
      });

      return { created, skipped };
    }),

  /* ── List prospects ──────────────────────────────────────────────────── */
  listProspects: workspaceProcedure
    .input(z.object({
      page: z.number().int().min(1).default(1),
      perPage: z.number().int().min(10).max(200).default(50),
      search: z.string().optional(),
      emailStatus: z.string().optional(),
      hasEmail: z.boolean().optional(),
      promoted: z.boolean().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const conditions = [eq(prospects.workspaceId, ctx.workspace.id)];
      if (input.emailStatus) conditions.push(eq(prospects.emailStatus, input.emailStatus));
      if (input.hasEmail === true) conditions.push(sql`${prospects.email} IS NOT NULL`);
      if (input.hasEmail === false) conditions.push(isNull(prospects.email));
      if (input.promoted === true) conditions.push(sql`${prospects.linkedContactId} IS NOT NULL`);
      if (input.promoted === false) conditions.push(isNull(prospects.linkedContactId));

      const offset = (input.page - 1) * input.perPage;
      const rows = await db
        .select()
        .from(prospects)
        .where(and(...conditions))
        .orderBy(desc(prospects.createdAt))
        .limit(input.perPage)
        .offset(offset);

      const [{ total }] = await db
        .select({ total: sql<number>`count(*)` })
        .from(prospects)
        .where(and(...conditions));

      return { data: rows, total: Number(total), page: input.page, perPage: input.perPage };
    }),

  /* ── Promote prospect to contact ─────────────────────────────────────── */
  promoteToContact: workspaceProcedure
    .input(z.object({ prospectId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [prospect] = await db
        .select()
        .from(prospects)
        .where(and(eq(prospects.id, input.prospectId), eq(prospects.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!prospect) throw new TRPCError({ code: "NOT_FOUND", message: "Prospect not found" });

      // Idempotent: if already linked, return existing contact
      if (prospect.linkedContactId) {
        return { contactId: prospect.linkedContactId, created: false };
      }

      // Check for existing contact by email (idempotent on email match)
      let contactId: number | null = null;
      if (prospect.email) {
        const [existing] = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.workspaceId, ctx.workspace.id),
              eq(contacts.email, prospect.email),
            ),
          )
          .limit(1);
        if (existing) contactId = existing.id;
      }

      if (!contactId) {
        const [inserted] = await db.insert(contacts).values({
          workspaceId: ctx.workspace.id,
          firstName: prospect.firstName,
          lastName: prospect.lastName,
          title: prospect.title ?? null,
          email: prospect.email ?? null,
          phone: prospect.phone ?? null,
          linkedinUrl: prospect.linkedinUrl ?? null,
          city: prospect.city ?? null,
          // Enrichment fields
          cloduraPersonId: prospect.cloduraPersonId ?? null,
          cloduraOrgId: prospect.cloduraOrgId ?? null,
          functionalArea: prospect.functionalArea ?? null,
          industry: prospect.industry ?? null,
          companyDomain: prospect.companyDomain ?? null,
          seniority: prospect.seniority ?? null,
          sourceProspectId: prospect.id,
        } as any);
        contactId = (inserted as any).insertId;
      }

      // Link the prospect to the contact
      await db
        .update(prospects)
        .set({ linkedContactId: contactId! })
        .where(eq(prospects.id, input.prospectId));

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "contact_from_prospect",
        entityId: contactId,
        after: { prospectId: input.prospectId },
      });

      return { contactId: contactId!, created: true };
    }),

  /* ── Enrich contact — preview (no write) ─────────────────────────────── */
  enrichPreview: workspaceProcedure
    .input(z.object({ contactId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [contact] = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, input.contactId), eq(contacts.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!contact) throw new TRPCError({ code: "NOT_FOUND" });

      const { identifierSet, confidence } = buildIdentifierSet(contact as any);
      if (!identifierSet) {
        return { eligible: false, reason: "Not eligible — insufficient identifiers" };
      }

      const apiKey = await getWorkspaceApiKey(ctx.workspace.id);
      try {
        const raw = await enrichContact(identifierSet, apiKey);
        if (!raw) return { eligible: true, diff: [], confidence, noMatch: true };

        const diff = buildDiff(contact as any, raw);
        return { eligible: true, diff, confidence, noMatch: false, rawResponse: raw };
      } catch (e) {
        if (e instanceof CloduraError) throw mapCloduraError(e);
        throw e;
      }
    }),

  /* ── Enrich contact — apply ───────────────────────────────────────────── */
  enrichApply: workspaceProcedure
    .input(z.object({
      contactId: z.number().int(),
      fields: z.array(z.object({
        fieldName: z.string(),
        newValue: z.string().nullable(),
      })),
      rawResponse: z.record(z.any()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [contact] = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, input.contactId), eq(contacts.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!contact) throw new TRPCError({ code: "NOT_FOUND" });

      const manuallyEdited: string[] = (contact as any).manuallyEditedFields ?? [];
      const updates: Record<string, unknown> = {};
      const historyRows: Array<{
        fieldName: string;
        oldValue: string | null;
        newValue: string | null;
      }> = [];

      for (const f of input.fields) {
        if (manuallyEdited.includes(f.fieldName)) continue; // never silently overwrite
        const oldValue = String((contact as any)[f.fieldName] ?? "");
        updates[f.fieldName] = f.newValue;
        historyRows.push({ fieldName: f.fieldName, oldValue, newValue: f.newValue });
      }

      if (Object.keys(updates).length > 0) {
        updates.enrichedAt = new Date();
        updates.enrichmentStatus = "enriched";
        await db.update(contacts).set(updates as any).where(eq(contacts.id, input.contactId));

        // Create enrichment job row
        const { identifierSet, confidence } = buildIdentifierSet(contact as any);
        const [jobInsert] = await db.insert(cloduraEnrichmentJobs).values({
          workspaceId: ctx.workspace.id,
          contactId: input.contactId,
          trigger: "manual",
          identifierSet: identifierSet ?? {},
          confidence,
          status: "completed",
          creditsConsumed: 1,
          rawResponse: input.rawResponse ?? null,
          requestedBy: ctx.user.id,
          requestedAt: new Date(),
          completedAt: new Date(),
        });
        const jobId = (jobInsert as any).insertId;

        // Write history rows
        for (const h of historyRows) {
          await db.insert(contactEnrichmentHistory).values({
            workspaceId: ctx.workspace.id,
            contactId: input.contactId,
            enrichmentJobId: jobId,
            fieldName: h.fieldName,
            oldValue: h.oldValue,
            newValue: h.newValue,
            appliedBy: ctx.user.id,
            appliedAt: new Date(),
          });
        }

        await recordAudit({
          workspaceId: ctx.workspace.id,
          actorUserId: ctx.user.id,
          action: "update",
          entityType: "contact_enrichment",
          entityId: input.contactId,
          before: Object.fromEntries(historyRows.map((h) => [h.fieldName, h.oldValue])),
          after: Object.fromEntries(historyRows.map((h) => [h.fieldName, h.newValue])),
        });
      }

      return { applied: Object.keys(updates).length, skippedManuallyEdited: input.fields.length - Object.keys(updates).length };
    }),

  /* ── Bulk enrich ─────────────────────────────────────────────────────── */
  enrichBulk: workspaceProcedure
    .input(z.object({
      contactIds: z.array(z.number().int()).min(1).max(500),
      mode: z.enum(["fill_empty", "overwrite_all"]).default("fill_empty"),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Check daily budget
      const [settings] = await db
        .select()
        .from(cloduraEnrichmentSettings)
        .where(eq(cloduraEnrichmentSettings.workspaceId, ctx.workspace.id))
        .limit(1);
      const dailyCap = settings?.dailyBudgetCap ?? 1500;

      // Count today's usage
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const [{ used }] = await db
        .select({ used: sql<number>`coalesce(sum(credits_consumed), 0)` })
        .from(cloduraEnrichmentJobs)
        .where(
          and(
            eq(cloduraEnrichmentJobs.workspaceId, ctx.workspace.id),
            sql`${cloduraEnrichmentJobs.requestedAt} >= ${today}`,
          ),
        );
      const remaining = dailyCap - Number(used);
      if (remaining <= 0) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS" as any, message: `Daily enrichment budget of ${dailyCap} credits exhausted. Resets tomorrow.` });
      }
      const toProcess = input.contactIds.slice(0, remaining);

      // Queue enrichment jobs (async — worker picks them up)
      for (const contactId of toProcess) {
        const [contact] = await db
          .select()
          .from(contacts)
          .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, ctx.workspace.id)))
          .limit(1);
        if (!contact) continue;

        const { identifierSet, confidence } = buildIdentifierSet(contact as any);
        await db.insert(cloduraEnrichmentJobs).values({
          workspaceId: ctx.workspace.id,
          contactId,
          trigger: "bulk",
          identifierSet: identifierSet ?? {},
          confidence: identifierSet ? confidence : "not_eligible",
          status: identifierSet ? "pending" : "no_match",
          requestedBy: ctx.user.id,
          requestedAt: new Date(),
        });
      }

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "bulk_enrich",
        after: { contactCount: toProcess.length, mode: input.mode },
      });

      return {
        queued: toProcess.length,
        skipped: input.contactIds.length - toProcess.length,
        dailyBudgetRemaining: remaining - toProcess.length,
      };
    }),

  /* ── Enrichment jobs list ────────────────────────────────────────────── */
  enrichmentJobs: workspaceProcedure
    .input(z.object({
      contactId: z.number().int().optional(),
      status: z.string().optional(),
      page: z.number().int().min(1).default(1),
      perPage: z.number().int().min(10).max(100).default(25),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const conditions = [eq(cloduraEnrichmentJobs.workspaceId, ctx.workspace.id)];
      if (input.contactId) conditions.push(eq(cloduraEnrichmentJobs.contactId, input.contactId));
      if (input.status) conditions.push(eq(cloduraEnrichmentJobs.status, input.status));

      const offset = (input.page - 1) * input.perPage;
      const rows = await db
        .select()
        .from(cloduraEnrichmentJobs)
        .where(and(...conditions))
        .orderBy(desc(cloduraEnrichmentJobs.requestedAt))
        .limit(input.perPage)
        .offset(offset);

      return rows.map((r) => ({ ...r, rawResponse: undefined })); // never expose raw to client
    }),

  /* ── Enrichment history for a contact ───────────────────────────────── */
  enrichmentHistory: workspaceProcedure
    .input(z.object({ contactId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return db
        .select()
        .from(contactEnrichmentHistory)
        .where(
          and(
            eq(contactEnrichmentHistory.contactId, input.contactId),
            eq(contactEnrichmentHistory.workspaceId, ctx.workspace.id),
          ),
        )
        .orderBy(desc(contactEnrichmentHistory.appliedAt));
    }),

  /* ── Enrichment settings ─────────────────────────────────────────────── */
  enrichmentSettings: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db
      .select()
      .from(cloduraEnrichmentSettings)
      .where(eq(cloduraEnrichmentSettings.workspaceId, ctx.workspace.id))
      .limit(1);
    return row ?? {
      workspaceId: ctx.workspace.id,
      autoEnrichOnCreate: false,
      scheduledReenrichEnabled: false,
      staleThresholdDays: 90,
      dailyBudgetCap: 1500,
    };
  }),

  updateEnrichmentSettings: adminWsProcedure
    .input(z.object({
      autoEnrichOnCreate: z.boolean().optional(),
      scheduledReenrichEnabled: z.boolean().optional(),
      staleThresholdDays: z.number().int().min(7).max(365).optional(),
      dailyBudgetCap: z.number().int().min(1).max(2000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .insert(cloduraEnrichmentSettings)
        .values({
          workspaceId: ctx.workspace.id,
          autoEnrichOnCreate: input.autoEnrichOnCreate ?? false,
          scheduledReenrichEnabled: input.scheduledReenrichEnabled ?? false,
          staleThresholdDays: input.staleThresholdDays ?? 90,
          dailyBudgetCap: input.dailyBudgetCap ?? 1500,
          updatedBy: ctx.user.id,
        })
        .onDuplicateKeyUpdate({
          set: {
            ...(input.autoEnrichOnCreate !== undefined ? { autoEnrichOnCreate: input.autoEnrichOnCreate } : {}),
            ...(input.scheduledReenrichEnabled !== undefined ? { scheduledReenrichEnabled: input.scheduledReenrichEnabled } : {}),
            ...(input.staleThresholdDays !== undefined ? { staleThresholdDays: input.staleThresholdDays } : {}),
            ...(input.dailyBudgetCap !== undefined ? { dailyBudgetCap: input.dailyBudgetCap } : {}),
            updatedBy: ctx.user.id,
          },
        });
      return { ok: true };
    }),

  /* ── Saved searches ──────────────────────────────────────────────────── */
  savedSearches: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    return db
      .select()
      .from(cloduraSavedSearches)
      .where(
        and(
          eq(cloduraSavedSearches.userId, ctx.user.id),
          eq(cloduraSavedSearches.workspaceId, ctx.workspace.id),
        ),
      )
      .orderBy(desc(cloduraSavedSearches.updatedAt));
  }),

  saveSearch: workspaceProcedure
    .input(z.object({
      name: z.string().min(1).max(120),
      filters: z.record(z.any()),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [ins] = await db.insert(cloduraSavedSearches).values({
        userId: ctx.user.id,
        workspaceId: ctx.workspace.id,
        name: input.name,
        filters: input.filters as any,
      });
      return { id: (ins as any).insertId };
    }),

  deleteSavedSearch: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .delete(cloduraSavedSearches)
        .where(
          and(
            eq(cloduraSavedSearches.id, input.id),
            eq(cloduraSavedSearches.userId, ctx.user.id),
          ),
        );
      return { ok: true };
    }),
});

/* ─── Identifier resolution helper ───────────────────────────────────────── */
function buildIdentifierSet(contact: Record<string, unknown>): {
  identifierSet: Record<string, string> | null;
  confidence: "highest" | "medium" | "low";
} {
  if (contact.linkedinUrl) {
    return { identifierSet: { linkedinUrl: contact.linkedinUrl as string }, confidence: "highest" };
  }
  if (contact.email && contact.firstName && contact.lastName) {
    return {
      identifierSet: {
        email: contact.email as string,
        firstName: contact.firstName as string,
        lastName: contact.lastName as string,
      },
      confidence: "highest",
    };
  }
  if (contact.email) {
    return { identifierSet: { email: contact.email as string }, confidence: "medium" };
  }
  if (contact.firstName && contact.lastName && contact.orgLinkedinUrl) {
    return {
      identifierSet: {
        firstName: contact.firstName as string,
        lastName: contact.lastName as string,
        orgLinkedinUrl: contact.orgLinkedinUrl as string,
      },
      confidence: "medium",
    };
  }
  const company = (contact as any).company ?? (contact as any).accountName;
  if (contact.firstName && contact.lastName && company) {
    return {
      identifierSet: {
        firstName: contact.firstName as string,
        lastName: contact.lastName as string,
        company: company as string,
      },
      confidence: "low",
    };
  }
  return { identifierSet: null, confidence: "low" };
}

/* ─── Diff builder ────────────────────────────────────────────────────────── */
interface DiffRow {
  fieldName: string;
  label: string;
  currentValue: string | null;
  proposedValue: string | null;
  isManuallyEdited: boolean;
}

const FIELD_MAP: Array<{ cloduraKey: string; contactKey: string; label: string; getter: (r: any) => string | null }> = [
  { cloduraKey: "personTitle", contactKey: "title", label: "Title", getter: (r) => r.personTitle ?? null },
  { cloduraKey: "seniority", contactKey: "seniority", label: "Seniority", getter: (r) => r.seniority?.[0] ?? null },
  { cloduraKey: "functional", contactKey: "functionalArea", label: "Functional Area", getter: (r) => r.functional?.[0] ?? null },
  { cloduraKey: "personCity", contactKey: "city", label: "City", getter: (r) => r.personCity ?? null },
  { cloduraKey: "personState", contactKey: "state", label: "State", getter: (r) => r.personState ?? null },
  { cloduraKey: "personCountry", contactKey: "country", label: "Country", getter: (r) => r.personCountry ?? null },
  { cloduraKey: "linkedinUrl", contactKey: "linkedinUrl", label: "LinkedIn URL", getter: (r) => r.linkedinUrl ?? null },
  { cloduraKey: "org.name", contactKey: "company", label: "Company", getter: (r) => r.organisation?.organisationName ?? null },
  { cloduraKey: "org.domain", contactKey: "companyDomain", label: "Company Domain", getter: (r) => r.organisation?.domain ?? null },
  { cloduraKey: "org.industry", contactKey: "industry", label: "Industry", getter: (r) => r.organisation?.industry ?? null },
  { cloduraKey: "org.size", contactKey: "companyEmployeeSize", label: "Company Size", getter: (r) => r.organisation?.organisationEmployeeSize ?? null },
  { cloduraKey: "org.revenue", contactKey: "companyRevenue", label: "Company Revenue", getter: (r) => r.organisation?.revenue ?? null },
  { cloduraKey: "org.founded", contactKey: "companyFoundedYear", label: "Founded Year", getter: (r) => r.organisation?.foundedYear ? String(r.organisation.foundedYear) : null },
  { cloduraKey: "org.phone", contactKey: "companyPhone", label: "Company Phone", getter: (r) => r.organisation?.boardlineNumbers ?? null },
  { cloduraKey: "org.city", contactKey: "companyCity", label: "Company City", getter: (r) => r.organisation?.organisationCity ?? null },
  { cloduraKey: "org.state", contactKey: "companyState", label: "Company State", getter: (r) => r.organisation?.organisationState ?? null },
  { cloduraKey: "org.country", contactKey: "companyCountry", label: "Company Country", getter: (r) => r.organisation?.organisationCountry ?? null },
];

function buildDiff(contact: Record<string, unknown>, raw: Record<string, unknown>): DiffRow[] {
  const manuallyEdited: string[] = (contact.manuallyEditedFields as string[]) ?? [];
  const diff: DiffRow[] = [];

  for (const f of FIELD_MAP) {
    const proposed = f.getter(raw);
    const current = String(contact[f.contactKey] ?? "");
    if (!proposed) continue;
    if (proposed === current) continue;
    // Skip LinkedIn URL if contact already has one
    if (f.contactKey === "linkedinUrl" && contact.linkedinUrl) continue;
    // Skip company phone if contact already has one
    if (f.contactKey === "companyPhone" && contact.companyPhone) continue;

    diff.push({
      fieldName: f.contactKey,
      label: f.label,
      currentValue: current || null,
      proposedValue: proposed,
      isManuallyEdited: manuallyEdited.includes(f.contactKey),
    });
  }

  return diff;
}
