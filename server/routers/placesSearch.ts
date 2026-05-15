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

      let created = 0;
      for (const hit of input.hits) {
        const { firstName, lastName } = splitName(hit.name);
        const companyDomain = normalizeDomain(hit.websiteUri ?? null);
        try {
          await db.insert(prospects).values({
            workspaceId: ctx.workspace.id,
            firstName: firstName || "(unknown)",
            lastName: lastName || "(business)",
            company: hit.name,
            companyDomain: companyDomain ?? undefined,
            phone: hit.nationalPhoneNumber ?? hit.internationalPhoneNumber ?? undefined,
            city: undefined, // could parse from formattedAddress in a follow-up
            // No email — the scraper's "Find contact info" will fill that
          } as never);
          created++;
        } catch {
          // continue — likely a duplicate
        }
      }
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "prospect_bulk_places",
        entityId: 0,
        after: { source: "google_places", attempted: input.hits.length, created },
      });
      return { attempted: input.hits.length, created };
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
