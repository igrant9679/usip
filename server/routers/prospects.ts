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
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { contacts, leads, prospects, scoreResults, scoreModels } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { lookupContactInfo, type LookupResult } from "../services/scraper";
// Shared synthetic-name detector — anchored to the lastName sentinel so it
// keeps working after the scraper overwrites enrichmentData. See
// services/prospectFromSource.ts.
import { isSyntheticNameProspect } from "../services/prospectFromSource";
import { reoonCheckBalance, getReoonApiKey } from "../services/reoon";
import { resolveProspectProfileImage } from "../services/profileImage";

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
      if (input.promoted === true) conditions.push(sql`${prospects.linkedLeadId} IS NOT NULL`);
      if (input.promoted === false) conditions.push(isNull(prospects.linkedLeadId));
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

      // List rows never expose the raw image columns; they carry only the
      // resolved, policy-gated profile_image (same gate as prospects.get) so
      // the People table can render permitted avatars with initials fallback.
      const withResolvedImg = (r: typeof prospects.$inferSelect) => {
        const { profileImageUrl: _u, profileImageSource: _s, profileImageSourceUrl: _su,
          profileImageLastVerifiedAt: _v, profileImageStatus: _st, ...rest } = r;
        return { ...rest, profile_image: resolveProspectProfileImage(r) };
      };

      if (wantsScore && primaryModelId != null) {
        const joinCond = and(
          eq(scoreResults.objectId, prospects.id),
          eq(scoreResults.objectType, "person"),
          eq(scoreResults.workspaceId, ctx.workspace.id),
          eq(scoreResults.scoreModelId, primaryModelId),
        );
        const scoreConds = [...conditions];
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

        const data = joined.map((row) => ({
          ...withResolvedImg(row.prospects),
          fitScore: row.score_results ? Number(row.score_results.normalizedScore) : null,
          fitRating: row.score_results?.rating ?? null,
        }));
        return { data, total: Number(total), page: input.page, perPage: input.perPage };
      }

      const rows = await db
        .select()
        .from(prospects)
        .where(and(...conditions))
        .orderBy(...sortExprs)
        .limit(input.perPage)
        .offset(offset);

      const [{ total }] = await db
        .select({ total: sql<number>`count(*)` })
        .from(prospects)
        .where(and(...conditions));

      // Raw image columns stay server-side; rows carry the resolved image only.
      const data = rows.map(withResolvedImg);

      return { data, total: Number(total), page: input.page, perPage: input.perPage };
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

      if (prospect.linkedContactId) {
        // Only trust the link if the contact still exists — contacts can be
        // deleted out from under a prospect (e.g. a bulk contact purge), leaving
        // a stale linkedContactId that makes Promote a silent permanent no-op.
        const [stillThere] = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(and(eq(contacts.id, prospect.linkedContactId), eq(contacts.workspaceId, ctx.workspace.id)))
          .limit(1);
        if (stillThere) {
          return { contactId: prospect.linkedContactId, created: false };
        }
        // Stale link: the contact was deleted. Clear it and fall through to re-create.
        await db
          .update(prospects)
          .set({ linkedContactId: null })
          .where(and(eq(prospects.id, input.prospectId), eq(prospects.workspaceId, ctx.workspace.id)));
      }

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
          functionalArea: prospect.functionalArea ?? null,
          industry: prospect.industry ?? null,
          companyDomain: prospect.companyDomain ?? null,
          seniority: prospect.seniority ?? null,
          sourceProspectId: prospect.id,
        } as never);
        contactId = (inserted as { insertId: number }).insertId;
      }

      await db
        .update(prospects)
        .set({ linkedContactId: contactId! })
        .where(eq(prospects.id, input.prospectId));

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "contact_from_prospect",
        entityId: contactId!,
        after: { prospectId: input.prospectId },
      });

      return { contactId: contactId!, created: true };
    }),

  /**
   * Promote a prospect to a LEAD — the front of the sales funnel
   * (Prospect → Lead → Opportunity → Account/Customer). Idempotent:
   *   - If already linked to an existing lead, returns it.
   *   - If a stale link points at a deleted lead, clears it and re-creates.
   *   - If a lead with the same email already exists, links to it.
   *   - Otherwise inserts a new lead (status "new") and links.
   */
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
  findContactInfo: workspaceProcedure
    .input(
      z.object({
        prospectId: z.number().int(),
        /** If true, won't overwrite existing prospect.email. Default true. */
        skipIfHasEmail: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<LookupResult> => {
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

      const result = await lookupContactInfo({
        workspaceId: ctx.workspace.id,
        prospectId: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        companyDomain: p.companyDomain ?? null,
        existingPhone: p.phone ?? null,
        skipIfHasEmail: input.skipIfHasEmail && Boolean(p.email),
        syntheticName: isSyntheticNameProspect(p),
      });

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "prospect",
        entityId: p.id,
        after: {
          enrichment: "scraper.findContactInfo",
          foundEmail: result.email,
          reoonCredits: result.reoonCredits,
          reoonCreditsQuick: result.reoonCreditsQuick,
          reoonCreditsPower: result.reoonCreditsPower,
        },
      });

      return result;
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

      for (const p of rows) {
        try {
          const result = await lookupContactInfo({
            workspaceId: ctx.workspace.id,
            prospectId: p.id,
            firstName: p.firstName,
            lastName: p.lastName,
            companyDomain: p.companyDomain ?? null,
            existingPhone: p.phone ?? null,
            skipIfHasEmail: input.skipIfHasEmail && Boolean(p.email),
            syntheticName: isSyntheticNameProspect(p),
          });
          creditsQuick += result.reoonCreditsQuick;
          creditsPower += result.reoonCreditsPower;
          if (result.email) withEmail++;
          else withoutEmail++;
          results.push({ prospectId: p.id, result });
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
      };
    }),

  /** Check remaining Reoon daily/instant credits. Used by the UI header. */
  reoonBalance: workspaceProcedure.query(async () => {
    try {
      const apiKey = getReoonApiKey();
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
