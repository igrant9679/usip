/**
 * Places Search router — Google Places API integration for prospect sourcing.
 *
 * Procedures:
 *   - getBudget          (workspace)  read current budget + usage state
 *   - saveBudget         (admin)      change cap / threshold / enabled flag
 *   - textSearch         (workspace)  run a Places text search, returns hits
 *   - saveAsProspects    (workspace)  convert selected Places hits → prospect rows
 *   - saveAsAccounts     (workspace)  convert selected Places hits → account rows
 *
 * Budget enforcement is handled inside `services/googlePlaces.ts` — the
 * router is a thin tRPC shell over that.
 */

import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { workspaceProcedure, adminWsProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { prospects, accounts } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import {
  textSearch,
  getBudget,
  setBudget,
  type PlacesResult,
} from "../services/googlePlaces";
import { normalizeDomain } from "../services/scraper/domain";

/* ─── Reusable validator for a single Places hit coming back from the UI ─ */
const PlacesResultZ = z.object({
  placeId: z.string(),
  name: z.string(),
  formattedAddress: z.string().optional(),
  websiteUri: z.string().optional(),
  nationalPhoneNumber: z.string().optional(),
  internationalPhoneNumber: z.string().optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().optional(),
  primaryType: z.string().optional(),
  types: z.array(z.string()).optional(),
  location: z.object({ lat: z.number(), lng: z.number() }).optional(),
  googleMapsUri: z.string().optional(),
});

/** Split "First Last" into firstName/lastName. Returns ("Acme Inc", "") if no space. */
function splitName(full: string): { firstName: string; lastName: string } {
  const trimmed = full.trim();
  const i = trimmed.lastIndexOf(" ");
  if (i === -1) return { firstName: trimmed, lastName: "" };
  return { firstName: trimmed.slice(0, i), lastName: trimmed.slice(i + 1) };
}

export const placesSearchRouter = router({
  /** Read the current budget state for the page meter. */
  getBudget: workspaceProcedure.query(async ({ ctx }) => {
    return getBudget(ctx.workspace.id);
  }),

  /** Admin-only: change cap, threshold %, or enable/disable. */
  saveBudget: adminWsProcedure
    .input(
      z.object({
        monthlyBudgetCents: z.number().int().min(0).max(1_000_000).optional(),
        thresholdPct: z.number().int().min(0).max(100).optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await setBudget(ctx.workspace.id, input);
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "places_budget",
        entityId: ctx.workspace.id,
        after: input,
      });
      return result;
    }),

  /** Run a Places text search. Refuses if budget is exhausted. */
  textSearch: workspaceProcedure
    .input(
      z.object({
        query: z.string().min(2).max(200),
        locationBias: z
          .object({
            lat: z.number(),
            lng: z.number(),
            radiusMeters: z.number().int().min(100).max(50_000),
          })
          .optional(),
        includedType: z.string().max(64).optional(),
        maxResultCount: z.number().int().min(1).max(20).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return textSearch({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        input,
      });
    }),

  /**
   * Convert selected Places hits into prospect rows. Best-effort:
   * Places gives us company-level data (name, address, phone, website),
   * not a person. We create one "prospect" per Place using the company
   * name as firstName + a blank lastName, since the prospects table
   * requires both. Users can edit/clean up afterward; the real win is
   * having the contact info captured for the scraper to find a person.
   */
  saveAsProspects: workspaceProcedure
    .input(z.object({ hits: z.array(PlacesResultZ).min(1).max(50) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Dedup against existing Places-sourced prospects. The prospects
      // table has no unique constraint, so a bare insert+catch never
      // actually dedupes — re-running the same selection would silently
      // create N duplicate rows. Match on (workspaceId, company) +
      // companyDomain, the stable keys for a business-derived prospect.
      const candidateCompanies = input.hits.map((h) => h.name);
      const existingKeys = new Set<string>();
      if (candidateCompanies.length > 0) {
        const rows = await db
          .select({ company: prospects.company, companyDomain: prospects.companyDomain })
          .from(prospects)
          .where(
            and(
              eq(prospects.workspaceId, ctx.workspace.id),
              inArray(prospects.company, candidateCompanies),
            ),
          );
        for (const r of rows) {
          existingKeys.add(`${(r.company ?? "").toLowerCase()}|${(r.companyDomain ?? "").toLowerCase()}`);
        }
      }

      let created = 0;
      let skipped = 0;
      for (const hit of input.hits) {
        const { firstName, lastName } = splitName(hit.name);
        const companyDomain = normalizeDomain(hit.websiteUri ?? null);
        const dedupKey = `${hit.name.toLowerCase()}|${(companyDomain ?? "").toLowerCase()}`;
        if (existingKeys.has(dedupKey)) {
          skipped++;
          continue;
        }
        try {
          await db.insert(prospects).values({
            workspaceId: ctx.workspace.id,
            firstName: firstName || "(unknown)",
            lastName: lastName || "(business)",
            company: hit.name,
            companyDomain: companyDomain ?? undefined,
            phone: hit.nationalPhoneNumber ?? hit.internationalPhoneNumber ?? undefined,
            city: undefined, // could parse from formattedAddress in a follow-up
            // Mark as a company-level (synthetic-name) prospect so the
            // scraper skips email-pattern generation + Reoon on it —
            // see isSyntheticNameProspect() in routers/prospects.ts.
            enrichmentData: { source: "google_places", syntheticName: true },
            // No email — "Find contact info" will scrape phone/socials only
          } as never);
          created++;
          existingKeys.add(dedupKey);
        } catch {
          // continue — defensive; dedup above already handles the common case
          skipped++;
        }
      }
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "prospect_bulk_places",
        entityId: 0,
        after: { source: "google_places", attempted: input.hits.length, created, skipped },
      });
      return { attempted: input.hits.length, created, skipped };
    }),

  /** Same as saveAsProspects but lands in the accounts table — for companies. */
  saveAsAccounts: workspaceProcedure
    .input(z.object({ hits: z.array(PlacesResultZ).min(1).max(50) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Dedup against existing accounts by domain — most useful key.
      const domains = input.hits
        .map((h) => normalizeDomain(h.websiteUri ?? null))
        .filter((d): d is string => !!d);
      const existingDomains = new Set<string>();
      if (domains.length > 0) {
        const rows = await db
          .select({ domain: accounts.domain })
          .from(accounts)
          .where(
            and(
              eq(accounts.workspaceId, ctx.workspace.id),
              inArray(accounts.domain, domains),
            ),
          );
        for (const r of rows) {
          const d = normalizeDomain(r.domain ?? null);
          if (d) existingDomains.add(d);
        }
      }

      let created = 0;
      let skipped = 0;
      for (const hit of input.hits) {
        const domain = normalizeDomain(hit.websiteUri ?? null);
        if (domain && existingDomains.has(domain)) {
          skipped++;
          continue;
        }
        // accounts table has no phone column; phone is captured on the
        // Prospect side instead. Industry maps from Places primaryType.
        try {
          await db.insert(accounts).values({
            workspaceId: ctx.workspace.id,
            name: hit.name,
            domain: domain ?? undefined,
            industry: hit.primaryType ?? undefined,
          } as never);
          created++;
          if (domain) existingDomains.add(domain);
        } catch {
          skipped++;
        }
      }
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "account_bulk_places",
        entityId: 0,
        after: { source: "google_places", attempted: input.hits.length, created, skipped },
      });
      return { attempted: input.hits.length, created, skipped };
    }),
});

// Re-export the type for client consumption
export type { PlacesResult };
