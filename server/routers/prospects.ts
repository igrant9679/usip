/**
 * Prospects router — manual prospect list management.
 *
 * Reads/writes the `prospects` table. Sourcing is now done via CSV upload
 * (e.g. LeadRocks exports). The old Clodura search/reveal/credits surface
 * has been removed; legacy `clodura_*` columns on the prospects table are
 * preserved for back-compat but unused by new rows.
 *
 * Procedures:
 *   list              — paginated list with optional filters
 *   promoteToContact  — idempotently create / link a contact from a prospect
 *   delete            — remove a single prospect (keeps linked contact)
 *   bulkDelete        — remove many prospects at once
 */
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { contacts, leads, prospects, scoreResults, scoreModels, workspaceSettings, prospectLinkedinEnrichments, prospectFieldHistory } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { runComprehensiveEnrichment } from "../services/enrichment/comprehensivePass";
import { CONFIDENCE } from "../services/enrichment/fieldMerge";
import { companyFromHeadline } from "../services/enrichment/headlineCompany";
import { repairNamePair } from "../services/enrichment/personName";
import { businessDomainFromEmail } from "../services/company/normalize";
import { lookupContactInfo, type LookupResult } from "../services/scraper";
// Shared synthetic-name detector — anchored to the lastName sentinel so it
// keeps working after the scraper overwrites enrichmentData. See
// services/prospectFromSource.ts.
import { isSyntheticNameProspect } from "../services/prospectFromSource";
import { reoonCheckBalance, getReoonKey } from "../services/reoon";
import { resolveProspectProfileImage } from "../services/profileImage";
import { SWEEP_DAILY_CAP_MAX, SWEEP_DAILY_CAP_MIN } from "@shared/enrichmentLimits";
import { promoteProspectRow } from "../services/prospectPromotion";

export const prospectsRouter = router({
  /** Fetch a single prospect (powers the /prospects/:id detail page). */
  get: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [row] = await db
        .select()
        .from(prospects)
        .where(and(eq(prospects.id, input.id), eq(prospects.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      // Full profile only: attach resolved profile-image metadata (compliance
      // gate decides whether the URL is exposed). Search/list never get this.
      return { ...row, profile_image: resolveProspectProfileImage(row) };
    }),

  /**
   * Field-change timeline for one prospect — first reader of the 0156 audit
   * table (written best-effort by every mergeAll consumer). Powers the History
   * section in the People drawer; newest first, capped so a heavily-enriched
   * row can't flood the panel.
   */
  fieldHistory: workspaceProcedure
    .input(z.object({ prospectId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return db
        .select()
        .from(prospectFieldHistory)
        .where(and(
          eq(prospectFieldHistory.workspaceId, ctx.workspace.id),
          eq(prospectFieldHistory.prospectId, input.prospectId),
        ))
        .orderBy(desc(prospectFieldHistory.changedAt), desc(prospectFieldHistory.id))
        .limit(100);
    }),

  /**
   * Update a prospect's profile image from a PERMITTED source only.
   * Backs PATCH /api/people/{id}/profile-image and
   * POST /api/enrichment/person/{id}/profile-image.
   *
   * - `imageUrl` (when given) must be HTTPS and must not be a LinkedIn URL.
   * - `sourceType` is required whenever an image URL is set.
   * - Without an `imageUrl`, a `status` may be reported (e.g. failed_to_load
   *   from the client, or removed/blocked_by_policy for compliance).
   */
  updateProfileImage: workspaceProcedure
    .input(
      z
        .object({
          id: z.number().int(),
          imageUrl: z.string().max(2048).url().optional(),
          sourceType: z
            .enum(["enrichment_provider", "crm_import", "user_uploaded", "public_authorized_url"])
            .optional(),
          sourceUrl: z.string().max(2048).url().nullable().optional(),
          status: z
            .enum(["available", "unavailable", "failed_to_load", "removed", "blocked_by_policy"])
            .optional(),
        })
        .refine((v) => !v.imageUrl || v.imageUrl.startsWith("https://"), {
          message: "imageUrl must be HTTPS",
          path: ["imageUrl"],
        })
        .refine((v) => !v.imageUrl || !!v.sourceType, {
          message: "sourceType is required when imageUrl is set",
          path: ["sourceType"],
        })
        .refine(
          (v) => {
            if (!v.imageUrl) return true;
            try {
              return !/(^|\.)linkedin\.com$/i.test(new URL(v.imageUrl).hostname);
            } catch {
              return false;
            }
          },
          { message: "LinkedIn URLs are not a permitted image source — use an authorized provider", path: ["imageUrl"] },
        ),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db
        .select()
        .from(prospects)
        .where(and(eq(prospects.id, input.id), eq(prospects.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!before) throw new TRPCError({ code: "NOT_FOUND" });

      const patch: Partial<typeof prospects.$inferInsert> = {};
      if (input.imageUrl) {
        patch.profileImageUrl = input.imageUrl;
        patch.profileImageSource = input.sourceType!;
        patch.profileImageSourceUrl = input.sourceUrl ?? null;
        patch.profileImageStatus = input.status ?? "available";
        patch.profileImageLastVerifiedAt = new Date();
      } else if (input.status) {
        patch.profileImageStatus = input.status;
        // Hard removal / policy block: drop the cached URL so it can't resurface.
        if (input.status === "removed" || input.status === "blocked_by_policy") {
          patch.profileImageUrl = null;
        }
      } else {
        return { ok: true, profile_image: resolveProspectProfileImage(before) };
      }

      await db
        .update(prospects)
        .set(patch)
        .where(and(eq(prospects.id, input.id), eq(prospects.workspaceId, ctx.workspace.id)));
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "prospect",
        entityId: input.id,
        before: { profileImageUrl: before.profileImageUrl, profileImageStatus: before.profileImageStatus, profileImageSource: before.profileImageSource },
        after: { ...before, ...patch },
      });
      return { ok: true, profile_image: resolveProspectProfileImage({ ...before, ...patch }) };
    }),

  /**
   * Store a USER-UPLOADED profile photo (the workspace's own content — no
   * third-party source). The client resizes the image to a small square and
   * sends it as a base64 image data URL, which we store inline (source =
   * user_uploaded). Capped well under the TEXT column limit.
   */
  uploadProfileImage: workspaceProcedure
    .input(
      z.object({
        id: z.number().int(),
        dataUrl: z
          .string()
          .max(60000, "Image is too large — use a smaller photo")
          .regex(
            /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/,
            "Must be a base64-encoded image data URL",
          ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db
        .select()
        .from(prospects)
        .where(and(eq(prospects.id, input.id), eq(prospects.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!before) throw new TRPCError({ code: "NOT_FOUND" });

      const patch: Partial<typeof prospects.$inferInsert> = {
        profileImageUrl: input.dataUrl,
        profileImageSource: "user_uploaded",
        profileImageSourceUrl: null,
        profileImageStatus: "available",
        profileImageLastVerifiedAt: new Date(),
      };
      await db
        .update(prospects)
        .set(patch)
        .where(and(eq(prospects.id, input.id), eq(prospects.workspaceId, ctx.workspace.id)));
      // Audit the change without dumping the (large) image payload.
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "prospect",
        entityId: input.id,
        before: { profileImageStatus: before.profileImageStatus, profileImageSource: before.profileImageSource },
        after: { profileImageStatus: "available", profileImageSource: "user_uploaded" },
      });
      return { ok: true, profile_image: resolveProspectProfileImage({ ...before, ...patch }) };
    }),

  /**
   * Batch-assign user-uploaded photos to many prospects in one request.
   * Each item is { prospect id, resized base64 image data URL }. Validates
   * ownership up front, applies in a loop, and reports per-row failures
   * (no silent drops). Capped at 50 per request.
   */
  bulkUploadProfileImages: workspaceProcedure
    .input(
      z.object({
        items: z
          .array(
            z.object({
              id: z.number().int(),
              dataUrl: z
                .string()
                .max(60000, "Image is too large — use a smaller photo")
                .regex(
                  /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/,
                  "Must be a base64-encoded image data URL",
                ),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const ids = input.items.map((i) => i.id);
      const owned = await db
        .select({ id: prospects.id })
        .from(prospects)
        .where(and(eq(prospects.workspaceId, ctx.workspace.id), inArray(prospects.id, ids)));
      const ownedSet = new Set(owned.map((o) => o.id));

      let uploaded = 0;
      const failed: { id: number; reason: string }[] = [];
      for (const item of input.items) {
        if (!ownedSet.has(item.id)) {
          failed.push({ id: item.id, reason: "not_found" });
          continue;
        }
        await db
          .update(prospects)
          .set({
            profileImageUrl: item.dataUrl,
            profileImageSource: "user_uploaded",
            profileImageSourceUrl: null,
            profileImageStatus: "available",
            profileImageLastVerifiedAt: new Date(),
          })
          .where(and(eq(prospects.id, item.id), eq(prospects.workspaceId, ctx.workspace.id)));
        uploaded++;
      }
      // One aggregate audit entry (avoids dumping N image payloads).
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "prospect",
        entityId: ids[0] ?? 0,
        before: { batch: "profile_image_bulk" },
        after: { uploaded, failed: failed.length, source: "user_uploaded" },
      });
      return { uploaded, failed };
    }),

  /** Manual edit of any user-facing field. Persists who/when via audit log
   *  but does NOT touch confidence/verification fields — those reflect
   *  pipeline truth and should only change via re-enrichment. */
  update: workspaceProcedure
    .input(z.object({
      id: z.number().int(),
      firstName: z.string().min(1).max(80).optional(),
      lastName: z.string().min(1).max(80).optional(),
      title: z.string().max(200).nullable().optional(),
      company: z.string().max(200).nullable().optional(),
      companyDomain: z.string().max(200).nullable().optional(),
      linkedinUrl: z.string().max(500).nullable().optional(),
      email: z.string().max(320).nullable().optional(),
      phone: z.string().max(40).nullable().optional(),
      city: z.string().max(80).nullable().optional(),
      state: z.string().max(80).nullable().optional(),
      country: z.string().max(80).nullable().optional(),
      industry: z.string().max(80).nullable().optional(),
      verificationStatus: z.enum(["verified", "needs_review", "rejected"]).optional(),
      verificationNotes: z.string().max(2000).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db.select().from(prospects)
        .where(and(eq(prospects.id, input.id), eq(prospects.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!before) throw new TRPCError({ code: "NOT_FOUND" });
      const { id, ...rest } = input;
      const patch: Partial<typeof prospects.$inferInsert> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) (patch as any)[k] = v;
      }
      if (Object.keys(patch).length === 0) return { ok: true };
      await db.update(prospects).set(patch)
        .where(and(eq(prospects.id, id), eq(prospects.workspaceId, ctx.workspace.id)));
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "prospect",
        entityId: id,
        before,
        after: { ...before, ...patch },
      });
      return { ok: true };
    }),

  /** Soft-archive — flips verificationStatus to 'rejected'. Keeps the row
   *  for audit/history; bulkDelete is still available for hard removal. */
  archive: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(prospects)
        .set({ verificationStatus: "rejected" })
        .where(and(eq(prospects.id, input.id), eq(prospects.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  /** Re-run discovery scoped to one prospect — uses their stored
   *  name+company to launch a focused person-mode search. The pipeline's
   *  merge-on-dedup logic updates this prospect's row in place rather
   *  than creating a duplicate. */
  reEnrich: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [p] = await db.select().from(prospects)
        .where(and(eq(prospects.id, input.id), eq(prospects.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!p) throw new TRPCError({ code: "NOT_FOUND" });
      const { runDiscovery } = await import("../services/discovery");
      return runDiscovery(ctx.workspace.id, ctx.user.id, "person", {
        jobTitle: p.title ?? undefined,
        industry: p.industry ?? undefined,
        companyName: p.company ?? undefined,
        location: [p.city, p.state, p.country].filter(Boolean).join(", ") || undefined,
        keywords: [`${p.firstName} ${p.lastName}`].filter(Boolean),
      });
    }),

  list: workspaceProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        perPage: z.number().int().min(10).max(200).default(50),
        emailStatus: z.string().optional(),
        hasEmail: z.boolean().optional(),
        /** Whole-dataset contact-info filters — these were page-local client
         *  refinements, so ticking "has phone" filtered 25 visible rows while
         *  the count/pagination ignored it. A filter either narrows the whole
         *  view or it lies. */
        hasPhone: z.boolean().optional(),
        hasLinkedin: z.boolean().optional(),
        promoted: z.boolean().optional(),
        /** Discovery v2: filter by verification status to power the
         *  Needs Review queue and the verified-only feed. */
        verificationStatus: z.enum(["verified", "needs_review", "rejected"]).optional(),
        /** Filter by which discovery run produced/last-touched the row. */
        discoveryRunId: z.number().int().optional(),
        /** Sequence membership: "yes" = enrolled in any sequence, "no" = not. */
        enrolled: z.enum(["yes", "no"]).optional(),
        /** Server-side text filters (case-insensitive contains). */
        search: z.string().trim().max(200).optional(),
        titleQ: z.string().trim().max(200).optional(),
        companyQ: z.string().trim().max(200).optional(),
        locationQ: z.string().trim().max(200).optional(),
        industryQ: z.string().trim().max(200).optional(),
        educationQ: z.string().trim().max(200).optional(),
        linkedinQ: z.string().trim().max(500).optional(),
        /** ICP confidence tier(s) — server-side (was a client-side page refinement). */
        tiers: z.array(z.enum(["high", "medium", "low"])).optional(),
        /** Seniority contains-match against ANY of these tokens (e.g. "vp"). */
        seniorities: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
        /** Whole-dataset sort (replaces the client-side loaded-page sort). */
        sortField: z.enum(["created", "fit", "name", "title", "company", "email", "phone", "industry"]).optional(),
        sortDir: z.enum(["asc", "desc"]).optional(),
        /** Score filter/sort against the primary person Fit model (scoring). */
        scoreMinRating: z.enum(["fair", "good", "excellent"]).optional(),
        scoreDisqualified: z.boolean().optional(),
        scoreMissing: z.boolean().optional(),
        scoreMin: z.number().min(0).max(100).optional(),
        scoreMax: z.number().min(0).max(100).optional(),
        sortByScore: z.enum(["asc", "desc"]).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const conditions = [eq(prospects.workspaceId, ctx.workspace.id)];
      if (input.emailStatus) conditions.push(eq(prospects.emailStatus, input.emailStatus));
      if (input.hasEmail === true) conditions.push(sql`${prospects.email} IS NOT NULL`);
      if (input.hasEmail === false) conditions.push(isNull(prospects.email));
      if (input.hasPhone) conditions.push(sql`${prospects.phone} IS NOT NULL AND ${prospects.phone} <> ''`);
      if (input.hasLinkedin) conditions.push(sql`${prospects.linkedinUrl} IS NOT NULL AND ${prospects.linkedinUrl} <> ''`);
      // "Saved" means promoted to a lead OR a contact — the People page has
      // always counted both, while this filter checked only linkedLeadId and
      // silently dropped contact-only rows from the Saved view. One
      // vocabulary now, and the tiles below share it. Kept OUT of
      // `conditions` so the Total/Net new/Saved tiles can be computed across
      // the whole filtered dataset regardless of which tile is active.
      const savedExpr = sql`(${prospects.linkedLeadId} IS NOT NULL OR ${prospects.linkedContactId} IS NOT NULL)`;
      const promotedConds =
        input.promoted === true ? [savedExpr]
          : input.promoted === false ? [sql`(${prospects.linkedLeadId} IS NULL AND ${prospects.linkedContactId} IS NULL)`]
            : [];
      if (input.verificationStatus) conditions.push(eq(prospects.verificationStatus, input.verificationStatus));
      if (input.discoveryRunId) conditions.push(eq(prospects.lastDiscoveryRunId, input.discoveryRunId));
      // Sequence membership — join via enrollments.prospectId (migration 0085).
      if (input.enrolled === "yes") {
        conditions.push(
          sql`EXISTS (SELECT 1 FROM \`enrollments\` \`e\` WHERE \`e\`.\`prospectId\` = ${prospects.id} AND \`e\`.\`workspaceId\` = ${ctx.workspace.id})`,
        );
      } else if (input.enrolled === "no") {
        conditions.push(
          sql`NOT EXISTS (SELECT 1 FROM \`enrollments\` \`e\` WHERE \`e\`.\`prospectId\` = ${prospects.id} AND \`e\`.\`workspaceId\` = ${ctx.workspace.id})`,
        );
      }
      // Text filters — case-insensitive contains (MySQL default _ci collation).
      if (input.search) {
        const s = `%${input.search}%`;
        conditions.push(
          or(
            like(prospects.firstName, s),
            like(prospects.lastName, s),
            // Full-name search: "Steven Burke" matches neither name column
            // alone, so every full-name query returned nothing — the People
            // search box AND the assistant's people lookup both hit this.
            sql`CONCAT(${prospects.firstName}, ' ', ${prospects.lastName}) LIKE ${s}`,
            like(prospects.title, s),
            like(prospects.company, s),
            like(prospects.email, s),
          )!,
        );
      }
      if (input.titleQ) conditions.push(like(prospects.title, `%${input.titleQ}%`));
      if (input.companyQ) conditions.push(like(prospects.company, `%${input.companyQ}%`));
      if (input.industryQ) conditions.push(like(prospects.industry, `%${input.industryQ}%`));
      if (input.educationQ) conditions.push(like(prospects.education, `%${input.educationQ}%`));
      if (input.linkedinQ) conditions.push(like(prospects.linkedinUrl, `%${input.linkedinQ}%`));
      if (input.locationQ) {
        const s = `%${input.locationQ}%`;
        conditions.push(or(like(prospects.city, s), like(prospects.state, s), like(prospects.country, s))!);
      }
      if (input.tiers?.length) conditions.push(inArray(prospects.confidenceTier, input.tiers));
      if (input.seniorities?.length) {
        conditions.push(or(...input.seniorities.map((s) => like(prospects.seniority, `%${s}%`)))!);
      }

      const offset = (input.page - 1) * input.perPage;

      // Whole-dataset sort (Total + pagination follow it). Default: newest first.
      const sdir = input.sortDir === "asc" ? asc : desc;
      const sortExprs =
        input.sortField === "fit" ? [sdir(prospects.confidenceScore)]
          : input.sortField === "name" ? [sdir(prospects.firstName), sdir(prospects.lastName)]
            : input.sortField === "title" ? [sdir(prospects.title)]
              : input.sortField === "company" ? [sdir(prospects.company)]
                : input.sortField === "email" ? [sdir(prospects.email)]
                  : input.sortField === "phone" ? [sdir(prospects.phone)]
                    : input.sortField === "industry" ? [sdir(prospects.industry)]
                      : [desc(prospects.createdAt)];

      // ── Score filter/sort against the primary person Fit model ───────────
      // Scores live in score_results, so a LEFT JOIN keeps unscored prospects
      // visible unless a positive score filter is applied. Only engages when a
      // score param is present AND a primary person model exists.
      const wantsScore = !!(input.scoreMinRating || input.scoreDisqualified != null
        || input.scoreMissing != null || input.scoreMin != null || input.scoreMax != null || input.sortByScore);
      let primaryModelId: number | null = null;
      if (wantsScore) {
        const [m] = await db.select({ id: scoreModels.id }).from(scoreModels)
          .where(and(eq(scoreModels.workspaceId, ctx.workspace.id), eq(scoreModels.objectType, "person"),
            eq(scoreModels.isPrimary, true), eq(scoreModels.status, "active"))).limit(1);
        primaryModelId = m?.id ?? null;
      }

      /**
       * READ-REPAIR for company name/domain — and credentialed names. The
       * People list renders prospects.company — but rows can hold a blank
       * while their LinkedIn enrichment row knows the employer (write-back
       * predated them, or the 0150 backfill was swallowed by the migration
       * runner, which logs and continues on failure). The list is the
       * surface the owner keeps catching this on, so the list is where it
       * self-heals: blanks are filled from the enrichment row for DISPLAY,
       * and the same values are persisted fill-if-empty (with provenance) so
       * each page render permanently repairs the rows it shows. Names stored
       * with vendor credential suffixes ("Flournoy, PSP") heal the same way.
       */
      const repairCompanyBlanks = async (rowsIn: (typeof prospects.$inferSelect)[]) => {
        const blanks = rowsIn.filter((r) => !r.company?.trim() || !r.companyDomain?.trim());
        const enrRows = blanks.length === 0 ? [] : await db
          .select({
            prospectId: prospectLinkedinEnrichments.prospectId,
            name: prospectLinkedinEnrichments.currentCompanyName,
            domain: prospectLinkedinEnrichments.currentCompanyDomain,
            headline: prospectLinkedinEnrichments.linkedinHeadline,
            title: prospectLinkedinEnrichments.currentTitle,
          })
          .from(prospectLinkedinEnrichments)
          .where(and(
            eq(prospectLinkedinEnrichments.workspaceId, ctx.workspace.id),
            inArray(prospectLinkedinEnrichments.prospectId, blanks.map((r) => r.id)),
          ));
        const byId = new Map(enrRows.map((e) => [e.prospectId, e]));
        const heals: Array<Promise<unknown>> = [];
        for (const r of rowsIn) {
          const e = byId.get(r.id);
          const patch: Record<string, unknown> = {};
          // Per-field provenance so a headline guess is never dressed up as a
          // structured LinkedIn read — weaker sources stay correctable.
          const prov: Record<string, { source: string; confidence: number }> = {};
          if (!r.company?.trim()) {
            if (e?.name?.trim()) {
              patch.company = r.company = e.name.trim();
              prov.company = { source: "linkedin", confidence: CONFIDENCE.linkedinProfile };
            } else {
              // LinkedIn hid the structured fields; the headline still names
              // the employer for "CFO at Acme"-shaped profiles.
              const guessed = companyFromHeadline(e?.headline ?? e?.title);
              if (guessed) {
                patch.company = r.company = guessed;
                prov.company = { source: "headline_parse", confidence: CONFIDENCE.headlineParse };
              }
            }
          }
          if (!r.companyDomain?.trim()) {
            if (e?.domain?.trim()) {
              patch.companyDomain = r.companyDomain = e.domain.trim();
              prov.companyDomain = { source: "linkedin", confidence: CONFIDENCE.linkedinProfile };
            } else {
              // A found email carries its own domain (free-mail excluded) —
              // needs no enrichment row at all.
              const d = businessDomainFromEmail(r.email);
              if (d) {
                patch.companyDomain = r.companyDomain = d;
                prov.companyDomain = { source: "email_domain", confidence: CONFIDENCE.emailDomain };
              }
            }
          }
          // Stored names carry vendor credential suffixes from before the
          // owner's rule ("Flournoy, PSP") — heal them the same way blanks
          // heal: on the render that shows them. Repaired AS A PAIR: historic
          // last-space imports left firstName "Ron Flournoy" + lastName "PSP",
          // which no single-field strip can see. No ledger entries: names are
          // not enrichable fields, this is a normalization of the same value,
          // not a competing source.
          const pair = repairNamePair(r.firstName, r.lastName);
          if (pair.firstName && pair.firstName !== r.firstName) patch.firstName = r.firstName = pair.firstName;
          if (pair.lastName && pair.lastName !== r.lastName) patch.lastName = r.lastName = pair.lastName;
          if (Object.keys(patch).length > 0) {
            if (Object.keys(prov).length > 0) {
              const ledger = { ...((r.fieldProvenance ?? {}) as Record<string, unknown>) };
              for (const f of Object.keys(prov)) {
                ledger[f] = { ...prov[f], at: new Date().toISOString() };
              }
              patch.fieldProvenance = ledger;
            }
            heals.push(
              db.update(prospects).set(patch as never)
                .where(and(eq(prospects.workspaceId, ctx.workspace.id), eq(prospects.id, r.id)))
                .catch((err) => console.warn(`[prospects.list] read-repair failed for ${r.id}:`, err)),
            );
          }
        }
        if (heals.length) await Promise.all(heals);
        return rowsIn;
      };

      // List rows never expose the raw image columns; they carry only the
      // resolved, policy-gated profile_image (same gate as prospects.get) so
      // the People table can render permitted avatars with initials fallback.
      const withResolvedImg = (r: typeof prospects.$inferSelect) => {
        const { profileImageUrl: _u, profileImageSource: _s, profileImageSourceUrl: _su,
          profileImageLastVerifiedAt: _v, profileImageStatus: _st, ...rest } = r;
        return { ...rest, profile_image: resolveProspectProfileImage(r) };
      };

      /** Tile counts for the stats strip: Total / Net new / Saved across the
       *  WHOLE filtered dataset — deliberately excluding the saved-status
       *  filter itself, so the three tiles partition the same population and
       *  clicking one shows exactly the number it promised. (The old strip
       *  computed Net new/Saved on the loaded page only: "Net new 50" was
       *  just the page size.) Score-join filters are not reflected here. */
      const [tileAgg] = await db
        .select({
          all: sql<number>`count(*)`,
          saved: sql<number>`coalesce(sum(case when ${prospects.linkedLeadId} is not null or ${prospects.linkedContactId} is not null then 1 else 0 end), 0)`,
        })
        .from(prospects)
        .where(and(...conditions));
      const savedCount = Number(tileAgg?.saved ?? 0);
      const netNewCount = Number(tileAgg?.all ?? 0) - savedCount;

      if (wantsScore && primaryModelId != null) {
        const joinCond = and(
          eq(scoreResults.objectId, prospects.id),
          eq(scoreResults.objectType, "person"),
          eq(scoreResults.workspaceId, ctx.workspace.id),
          eq(scoreResults.scoreModelId, primaryModelId),
        );
        const scoreConds = [...conditions, ...promotedConds];
        if (input.scoreMinRating) {
          const set = input.scoreMinRating === "excellent" ? ["excellent"]
            : input.scoreMinRating === "good" ? ["good", "excellent"]
              : ["fair", "good", "excellent"];
          scoreConds.push(inArray(scoreResults.rating, set));
        }
        if (input.scoreMissing === true) scoreConds.push(isNull(scoreResults.id));
        if (input.scoreMissing === false) scoreConds.push(isNotNull(scoreResults.id));
        if (input.scoreDisqualified === true) scoreConds.push(eq(scoreResults.isDisqualified, true));
        if (input.scoreDisqualified === false) scoreConds.push(or(eq(scoreResults.isDisqualified, false), isNull(scoreResults.id))!);
        if (input.scoreMin != null) scoreConds.push(sql`${scoreResults.normalizedScore} >= ${input.scoreMin}`);
        if (input.scoreMax != null) scoreConds.push(sql`${scoreResults.normalizedScore} <= ${input.scoreMax}`);

        const orderBy = input.sortByScore === "asc" ? [asc(scoreResults.normalizedScore)]
          : input.sortByScore === "desc" ? [desc(scoreResults.normalizedScore)]
            : sortExprs;

        const joined = await db.select().from(prospects).leftJoin(scoreResults, joinCond)
          .where(and(...scoreConds)).orderBy(...orderBy).limit(input.perPage).offset(offset);
        const [{ total }] = await db.select({ total: sql<number>`count(*)` })
          .from(prospects).leftJoin(scoreResults, joinCond).where(and(...scoreConds));

        await repairCompanyBlanks(joined.map((row) => row.prospects));
        const data = joined.map((row) => ({
          ...withResolvedImg(row.prospects),
          fitScore: row.score_results ? Number(row.score_results.normalizedScore) : null,
          fitRating: row.score_results?.rating ?? null,
        }));
        return { data, total: Number(total), page: input.page, perPage: input.perPage, savedCount, netNewCount };
      }

      const rows = await db
        .select()
        .from(prospects)
        .where(and(...conditions, ...promotedConds))
        .orderBy(...sortExprs)
        .limit(input.perPage)
        .offset(offset);

      const [{ total }] = await db
        .select({ total: sql<number>`count(*)` })
        .from(prospects)
        .where(and(...conditions, ...promotedConds));

      await repairCompanyBlanks(rows);
      // Raw image columns stay server-side; rows carry the resolved image only.
      const data = rows.map(withResolvedImg);

      return { data, total: Number(total), page: input.page, perPage: input.perPage, savedCount, netNewCount };
    }),

  /**
   * Delete a single prospect. If they were promoted, the contact row stays
   * untouched (delete via contacts.delete if you want it gone too).
   */
  delete: workspaceProcedure
    .input(z.object({ prospectId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db
        .select()
        .from(prospects)
        .where(
          and(
            eq(prospects.id, input.prospectId),
            eq(prospects.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);
      if (!before) throw new TRPCError({ code: "NOT_FOUND" });
      await db
        .delete(prospects)
        .where(
          and(
            eq(prospects.id, input.prospectId),
            eq(prospects.workspaceId, ctx.workspace.id),
          ),
        );
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "delete",
        entityType: "prospect",
        entityId: input.prospectId,
        before,
      });
      return { ok: true, hadLinkedContact: Boolean(before.linkedContactId) };
    }),

  /** Selected people → flat rows for CSV export (CSV built client-side). */
  exportSelected: workspaceProcedure
    .input(z.object({ prospectIds: z.array(z.number().int().positive()).min(1).max(5000) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select({
          firstName: prospects.firstName,
          lastName: prospects.lastName,
          title: prospects.title,
          company: prospects.company,
          email: prospects.email,
          phone: prospects.phone,
          linkedinUrl: prospects.linkedinUrl,
          city: prospects.city,
          state: prospects.state,
          country: prospects.country,
          industry: prospects.industry,
          seniority: prospects.seniority,
        })
        .from(prospects)
        .where(and(eq(prospects.workspaceId, ctx.workspace.id), inArray(prospects.id, input.prospectIds)));
    }),

  bulkDelete: workspaceProcedure
    .input(z.object({ prospectIds: z.array(z.number().int()).min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select({ id: prospects.id, linkedContactId: prospects.linkedContactId })
        .from(prospects)
        .where(
          and(
            eq(prospects.workspaceId, ctx.workspace.id),
            inArray(prospects.id, input.prospectIds),
          ),
        );
      if (rows.length === 0) return { deleted: 0, hadLinkedContacts: 0 };
      await db
        .delete(prospects)
        .where(
          and(
            eq(prospects.workspaceId, ctx.workspace.id),
            inArray(prospects.id, rows.map((r) => r.id)),
          ),
        );
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "delete",
        entityType: "prospect_bulk",
        entityId: 0,
        after: { ids: rows.map((r) => r.id) },
      });
      return {
        deleted: rows.length,
        hadLinkedContacts: rows.filter((r) => r.linkedContactId).length,
      };
    }),

  /**
   * Promote a prospect to a contact. Idempotent:
   *   - If already linked, returns the existing contact id.
   *   - If a contact with the same email already exists, links to it.
   *   - Otherwise inserts a new contact and links.
   */
  /**
   * Manual promotion from the People page.
   *
   * DELEGATES. This used to carry its own copy of the promotion — find the
   * contact by email, create it, link it back — which was then duplicated by
   * services/prospectPromotion when the sweeper needed the same thing. Two
   * implementations of "put this prospect in the CRM" is how one of them
   * silently stops linking an account, or stops recovering a stale link.
   *
   * `requireVerified: false` is the difference that matters and it is
   * deliberate: a human looking at one prospect and pressing Promote has made
   * a judgement the unattended sweeper cannot. The sweeper keeps the default
   * (verified only), so an unverified address still cannot reach a campaign on
   * its own.
   */
  promoteToContact: workspaceProcedure
    .input(z.object({ prospectId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const outcome = await promoteProspectRow(ctx.workspace.id, input.prospectId, {
        requireVerified: false,
        ownerUserId: ctx.user.id,
      });
      if (!outcome.promoted) {
        if (outcome.reason === "not_found") {
          throw new TRPCError({ code: "NOT_FOUND", message: "Prospect not found" });
        }
        if (outcome.reason === "db_unavailable") {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        }
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            outcome.reason === "no_email"
              ? "This prospect has no email address yet."
              : "This prospect has no company, so there is nothing to file the contact under.",
        });
      }
      // Response shape preserved for the People page: it reads `created`.
      return { contactId: outcome.contactId, created: !outcome.alreadyLinked };
    }),

  promoteToLead: workspaceProcedure
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

      if (prospect.linkedLeadId) {
        const [stillThere] = await db
          .select({ id: leads.id })
          .from(leads)
          .where(and(eq(leads.id, prospect.linkedLeadId), eq(leads.workspaceId, ctx.workspace.id)))
          .limit(1);
        if (stillThere) {
          return { leadId: prospect.linkedLeadId, created: false };
        }
        await db
          .update(prospects)
          .set({ linkedLeadId: null })
          .where(and(eq(prospects.id, input.prospectId), eq(prospects.workspaceId, ctx.workspace.id)));
      }

      let leadId: number | null = null;
      if (prospect.email) {
        const [existing] = await db
          .select({ id: leads.id })
          .from(leads)
          .where(and(eq(leads.workspaceId, ctx.workspace.id), eq(leads.email, prospect.email)))
          .limit(1);
        if (existing) leadId = existing.id;
      }

      if (!leadId) {
        const [inserted] = await db.insert(leads).values({
          workspaceId: ctx.workspace.id,
          firstName: prospect.firstName,
          lastName: prospect.lastName,
          email: prospect.email ?? null,
          phone: prospect.phone ?? null,
          company: prospect.company ?? null,
          title: prospect.title ?? null,
          source: "Prospecting",
          status: "new",
          ownerUserId: ctx.user.id,
        } as never);
        leadId = (inserted as { insertId: number }).insertId;
      }

      await db
        .update(prospects)
        .set({ linkedLeadId: leadId! })
        .where(and(eq(prospects.id, input.prospectId), eq(prospects.workspaceId, ctx.workspace.id)));

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "lead_from_prospect",
        entityId: leadId!,
        after: { prospectId: input.prospectId },
      });

      return { leadId: leadId!, created: true };
    }),

  /**
   * Find contact info for a single prospect.
   *
   * Pipeline (see server/services/scraper):
   *   1. Resolve company domain
   *   2. Scrape company website (cached 30d per domain)
   *   3. Generate up to 3 email patterns + Reoon-verify (early-stop on valid)
   *   4. Pick winning email by status, write back to prospect row
   *
   * Synchronous — call site should expect ~5–10s of latency per call.
   * Returns the full LookupResult so the UI can show what was found.
   */
  /**
   * The comprehensive pass — one event, the whole funnel. Every source that
   * applies (LinkedIn profile data, Apollo domain, QuickEnrich, pattern +
   * Reoon, site scrape), reconciled field-by-field with provenance and
   * confidence, never downgrading stronger data. Queues the compliant
   * LinkedIn profile job when the prospect has a URL but no profile yet.
   */
  enrichFull: workspaceProcedure
    .input(z.object({ prospectId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const result = await runComprehensiveEnrichment({
        workspaceId: ctx.workspace.id,
        prospectId: input.prospectId,
        userId: ctx.user.id,
        isAdmin: ctx.member.role === "admin" || ctx.member.role === "super_admin",
        trigger: "manual_full",
        queueLinkedInJob: true,
      });
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "prospect",
        entityId: input.prospectId,
        after: { enrichFull: result.phases },
      });
      return result;
    }),

  findContactInfo: workspaceProcedure
    .input(
      z.object({
        prospectId: z.number().int(),
        /** If true, won't overwrite existing prospect.email. Default true. */
        skipIfHasEmail: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<LookupResult> => {
      // Roadmap P1.2: this legacy single-prospect path now routes through
      // the ONE comprehensive pass (merge rules + provenance ledger)
      // instead of calling the scraper directly — the last unprovenance
      // write path to prospects is closed. The wire contract (LookupResult)
      // is preserved for the existing UI; every live caller sends
      // skipIfHasEmail:true, whose "don't clobber an existing email"
      // intent is now enforced by fieldMerge's never-downgrade rules.
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [p] = await db
        .select()
        .from(prospects)
        .where(
          and(
            eq(prospects.id, input.prospectId),
            eq(prospects.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);
      if (!p) throw new TRPCError({ code: "NOT_FOUND" });

      const { runComprehensiveEnrichment } = await import("../services/enrichment/comprehensivePass");
      const pass = await runComprehensiveEnrichment({
        workspaceId: ctx.workspace.id,
        prospectId: p.id,
        userId: ctx.user.id,
        isAdmin: ctx.member.role === "admin" || ctx.member.role === "super_admin",
        trigger: "find_contact_info",
      });

      // Re-read for the fields the pass persisted (phone via scrape step,
      // enrichmentData written by the scraper inside the pass).
      const [after] = await db.select().from(prospects)
        .where(and(eq(prospects.id, p.id), eq(prospects.workspaceId, ctx.workspace.id)))
        .limit(1);

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "prospect",
        entityId: p.id,
        after: {
          enrichment: "comprehensivePass.findContactInfo",
          foundEmail: pass.email,
          phases: pass.phases,
          reoonCreditsQuick: pass.credits.quick,
          reoonCreditsPower: pass.credits.power,
        },
      });

      const skipped = pass.skipped === "suppressed"
        ? "Prospect is suppressed — not enriched"
        : pass.skipped === "not_found" ? "Prospect not found" : null;
      const message = skipped
        ?? (pass.email
          ? `Found ${pass.emailStatus ?? "unverified"} email`
          : `No deliverable email (${pass.phases.pattern ?? pass.phases.quickenrich ?? "no source produced one"})`);

      return {
        ok: pass.ok,
        email: pass.email,
        emailStatus: (pass.emailStatus ?? null) as LookupResult["emailStatus"],
        phone: after?.phone ?? null,
        enrichment: (after?.enrichmentData ?? {}) as LookupResult["enrichment"],
        reoonCredits: pass.credits.quick + pass.credits.power,
        reoonCreditsQuick: pass.credits.quick,
        reoonCreditsPower: pass.credits.power,
        message,
      };
    }),

  /**
   * Find contact info for up to 25 prospects in one shot.
   *
   * Runs lookups serially (NOT Promise.all — we want the per-domain rate
   * limiter inside companySite.ts to work properly, and we don't want to
   * flood Reoon with parallel requests that might hit per-second caps).
   * For larger batches, the right answer is a background-job system — TODO.
   */
  findContactInfoBatch: workspaceProcedure
    .input(
      z.object({
        prospectIds: z.array(z.number().int()).min(1).max(25),
        skipIfHasEmail: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const rows = await db
        .select()
        .from(prospects)
        .where(
          and(
            eq(prospects.workspaceId, ctx.workspace.id),
            inArray(prospects.id, input.prospectIds),
          ),
        );

      const results: Array<{ prospectId: number; result: LookupResult }> = [];
      let creditsQuick = 0;
      let creditsPower = 0;
      let withEmail = 0;
      let withoutEmail = 0;

      // The comprehensive pass below deliberately skips LinkedIn (25 rows must
      // not drain the 100/day lookup cap mid-request) — but "enrich fully"
      // still owes the caller profile data + photos. Report which rows have a
      // LinkedIn URL and no fresh profile, so the CLIENT can queue ONE async
      // orchestrator job for the union of its chunks (cap-aware, match-gated)
      // instead of each chunk spawning its own.
      const FRESH_MS = 30 * 86_400_000;
      const enrRows = await db
        .select({
          prospectId: prospectLinkedinEnrichments.prospectId,
          status: prospectLinkedinEnrichments.linkedinDataStatus,
          at: prospectLinkedinEnrichments.linkedinLastRetrievedAt,
        })
        .from(prospectLinkedinEnrichments)
        .where(and(
          eq(prospectLinkedinEnrichments.workspaceId, ctx.workspace.id),
          inArray(prospectLinkedinEnrichments.prospectId, input.prospectIds),
        ));
      const freshIds = new Set(
        enrRows
          .filter((e) => e.status === "enriched" && e.at && Date.now() - new Date(e.at).getTime() < FRESH_MS)
          .map((e) => e.prospectId),
      );
      const needsLinkedIn = rows
        .filter((p) => !!p.linkedinUrl?.trim() && !freshIds.has(p.id) && p.verificationStatus !== "rejected")
        .map((p) => p.id);

      for (const p of rows) {
        try {
          // Comprehensive pass — every trigger runs the whole funnel now
          // (LinkedIn data on file, Apollo domain, QuickEnrich, pattern+
          // Reoon, scrape) with field-level provenance. queueLinkedInJob
          // false: one batch must not spawn 25 async jobs.
          const comp = await runComprehensiveEnrichment({
            workspaceId: ctx.workspace.id,
            prospectId: p.id,
            userId: ctx.user.id,
            trigger: "people_batch",
            queueLinkedInJob: false,
          });
          creditsQuick += comp.credits.quick;
          creditsPower += comp.credits.power;
          if (comp.email) withEmail++;
          else withoutEmail++;
          results.push({ prospectId: p.id, result: {
            ok: comp.ok, email: comp.email, emailStatus: comp.emailStatus, phone: null,
            enrichment: { scrapedDomain: null, scrapedAt: null, emailsFound: [], phonesFound: [], socialUrls: [], patternsVerified: [] },
            reoonCredits: comp.credits.quick + comp.credits.power,
            reoonCreditsQuick: comp.credits.quick, reoonCreditsPower: comp.credits.power,
            message: Object.entries(comp.phases).map(([k, v]) => `${k}: ${v}`).join(" · "),
          } as unknown as LookupResult });
        } catch (e) {
          // One prospect's failure shouldn't kill the batch
          withoutEmail++;
          results.push({
            prospectId: p.id,
            result: {
              ok: false,
              email: null,
              emailStatus: null,
              phone: null,
              enrichment: {
                scrapedDomain: null,
                scrapedAt: new Date().toISOString(),
                emailsFound: [],
                phonesFound: [],
                socialUrls: [],
                patternsVerified: [],
                skipReason: "exception",
              },
              reoonCredits: 0,
              reoonCreditsQuick: 0,
              reoonCreditsPower: 0,
              message: (e as Error).message,
            },
          });
        }
      }

      const totalCredits = creditsQuick + creditsPower;
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "prospect_bulk",
        entityId: 0,
        after: {
          enrichment: "scraper.findContactInfoBatch",
          processed: rows.length,
          withEmail,
          withoutEmail,
          reoonCredits: totalCredits,
          reoonCreditsQuick: creditsQuick,
          reoonCreditsPower: creditsPower,
        },
      });

      return {
        processed: rows.length,
        withEmail,
        withoutEmail,
        reoonCredits: totalCredits,
        reoonCreditsQuick: creditsQuick,
        reoonCreditsPower: creditsPower,
        results,
        needsLinkedIn,
      };
    }),

  /** Check remaining Reoon daily/instant credits. Used by the UI header. */
  /* ── Backlog enrichment sweeper ───────────────────────────────────────── */

  /**
   * Everything the sweep card needs BEFORE anyone spends a credit: how many
   * prospects are actually waiting, and whether a key exists to spend at all.
   */
  sweepStatus: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [s] = await db
      .select({
        mode: workspaceSettings.enrichmentSweepMode,
        dailyCap: workspaceSettings.enrichmentSweepDailyCap,
        lastRunAt: workspaceSettings.enrichmentSweepLastRunAt,
        lastResult: workspaceSettings.enrichmentSweepLastResult,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
      .limit(1);
    const [mod, key, qeMod] = await Promise.all([
      import("../services/enrichmentSweeper"),
      getReoonKey(ctx.workspace.id),
      import("../services/quickenrich"),
    ]);
    const { countCandidates, countQuickenrichCandidates, queueDiagnostics } = mod;
    const qeKey = await qeMod.getQuickEnrichKey(ctx.workspace.id);
    return {
      mode: (s?.mode ?? "off") as "off" | "approval" | "auto",
      dailyCap: s?.dailyCap ?? 50,
      lastRunAt: s?.lastRunAt ?? null,
      /** Full SweepResult of the most recent run (+ `at` ISO timestamp), or null before the first post-0147 run. */
      lastResult: (s?.lastResult ?? null) as (Record<string, unknown> & { at?: string }) | null,
      candidates: await countCandidates(ctx.workspace.id),
      /** Retryable = already attempted; surfaced separately so "0 waiting" is unambiguous. */
      attemptedAlready: Math.max(0, (await countCandidates(ctx.workspace.id, true)) - (await countCandidates(ctx.workspace.id))),
      reoonConfigured: key.length > 0,
      /**
       * Rows only the QuickEnrich pass can reach (LinkedIn URL, no domain).
       * Zero when no key is configured, because the pass will not run —
       * reporting reachable rows a missing key makes unreachable would be the
       * sweep-button lie over again.
       */
      quickenrichReady: qeKey ? await countQuickenrichCandidates(ctx.workspace.id) : 0,
      /** Why the count is what it is — see queueDiagnostics. */
      queue: await queueDiagnostics(ctx.workspace.id),
    };
  }),

  /** Dedicated setter — keeps these columns off the settings.save allowlist. */
  /**
   * Admin-gated: this switch spends REOON CREDITS unattended. Every other
   * autonomy control on the Autonomy Control Center is adminWsProcedure — these
   * two were workspaceProcedure with no role check of any kind, so any rep could
   * turn on unattended spend against the workspace's BYOK key.
   */
  setSweepSettings: adminWsProcedure
    .input(z.object({
      mode: z.enum(["off", "approval", "auto"]).optional(),
      dailyCap: z.number().int().min(SWEEP_DAILY_CAP_MIN).max(SWEEP_DAILY_CAP_MAX).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const set: Record<string, unknown> = {};
      if (input.mode !== undefined) set.enrichmentSweepMode = input.mode;
      if (input.dailyCap !== undefined) set.enrichmentSweepDailyCap = input.dailyCap;
      if (Object.keys(set).length === 0) return { ok: true as const };
      await db.update(workspaceSettings).set(set as never)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      return { ok: true as const };
    }),

  /**
   * Run a sweep now (the `approval`-mode path, and a manual override in any
   * mode except off). Synchronous and bounded — each prospect is a live scrape
   * plus verification, so the cap is what keeps this a request rather than a job.
   */
  runSweep: workspaceProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(200).default(25),
      retryFailed: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [s] = await db
        .select({ mode: workspaceSettings.enrichmentSweepMode })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
        .limit(1);
      if ((s?.mode ?? "off") === "off") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Enrichment sweeping is off for this workspace. Set it to Approve or Autonomous first.",
        });
      }
      const { sweepWorkspace } = await import("../services/enrichmentSweeper");
      return sweepWorkspace(ctx.workspace.id, { limit: input.limit, retryFailed: input.retryFailed });
    }),

  /**
   * Fill missing company names on ARE queue prospects from LinkedIn.
   *
   * Separate from runSweep on purpose: this spends LinkedIn lookups (own hard
   * daily cap, via the user's connected account), not Reoon credits.
   */
  backfillCompanies: workspaceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(25) }))
    .mutation(async ({ ctx, input }) => {
      const { backfillQueueCompanies } = await import("../services/enrichmentSweeper");
      const isAdmin = ctx.member.role === "admin" || ctx.member.role === "super_admin";
      return backfillQueueCompanies({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        isAdmin,
        limit: input.limit,
      });
    }),

  /** Backfill schedule + how many rows are still missing a company name. */
  backfillStatus: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [s] = await db
      .select({
        mode: workspaceSettings.companyBackfillMode,
        dailyCap: workspaceSettings.companyBackfillDailyCap,
        lastRunAt: workspaceSettings.companyBackfillLastRunAt,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
      .limit(1);
    const { queueDiagnostics } = await import("../services/enrichmentSweeper");
    const q = await queueDiagnostics(ctx.workspace.id);
    return {
      mode: (s?.mode ?? "off") as "off" | "approval" | "auto",
      dailyCap: s?.dailyCap ?? 50,
      lastRunAt: s?.lastRunAt ?? null,
      // The backfill's real candidate set, not needsDomain — a row can have a
      // company and still lack a domain, so the two counts are not the same.
      needsCompany: q.needsCompanyWithLinkedIn,
    };
  }),

  /** Dedicated setter — keeps these off the settings.save allowlist. */
  /**
   * Admin-gated for the same reason, and a sharper one: this spends the
   * connected LinkedIn account's daily lookup allowance (~100/day). Burning
   * that does not just cost money, it risks the account the whole social and
   * enrichment surface depends on.
   */
  setBackfillSettings: adminWsProcedure
    .input(z.object({
      mode: z.enum(["off", "approval", "auto"]).optional(),
      dailyCap: z.number().int().min(1).max(100).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const set: Record<string, unknown> = {};
      if (input.mode !== undefined) set.companyBackfillMode = input.mode;
      if (input.dailyCap !== undefined) set.companyBackfillDailyCap = input.dailyCap;
      if (Object.keys(set).length === 0) return { ok: true as const };
      await db.update(workspaceSettings).set(set as never)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      return { ok: true as const };
    }),

  reoonBalance: workspaceProcedure.query(async ({ ctx }) => {
    try {
      const apiKey = await getReoonKey(ctx.workspace.id);
      if (!apiKey) throw new Error("No Reoon API key configured.");
      return await reoonCheckBalance(apiKey);
    } catch (e) {
      // Don't fail the page render if Reoon is unconfigured / down
      return {
        api_status: "error",
        status: "error",
        remaining_daily_credits: 0,
        remaining_instant_credits: 0,
        error: (e as Error).message,
      };
    }
  }),
});
