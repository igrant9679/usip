/**
 * URL scraper tRPC router — backs the "URL" tab on /find-prospects.
 *
 * Procedures:
 *   - scrapeOne   (workspace) — extract data from a single URL
 *   - scrapeBatch (workspace) — extract from up to 25 URLs in parallel
 *   - saveAsProspect (workspace) — turn an extraction into a Prospect row
 *
 * The scrapeOne procedure is the one users hit most — paste a URL,
 * preview what was found, decide whether to save. Batch is for power
 * users who want to dump a list and triage results.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { prospects } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { scrapeUrl, type ExtractedData } from "../services/scraper/urlScraper";
import { buildScrapedProspectValues } from "../services/prospectFromSource";

const ExtractedFieldZ = z.object({
  value: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low", "none"]),
  source: z.string(),
});

// Subset of ExtractedData that the client can write back when saving —
// mirrors the shape but everything is optional (the user can edit before
// saving).
const SaveInputZ = z.object({
  url: z.string().url().or(z.string().min(3)),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  jobTitle: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  companyName: z.string().optional(),
  companyDomain: z.string().optional(),
  bio: z.string().optional(),
  /** LinkedIn URL discovered on the page, if any. */
  linkedinUrl: z.string().optional(),
});

export const urlScraperRouter = router({
  scrapeOne: workspaceProcedure
    .input(z.object({ url: z.string().min(3).max(2048) }))
    .mutation(async ({ input }) => {
      const data = await scrapeUrl(input.url);
      return data;
    }),

  scrapeBatch: workspaceProcedure
    .input(z.object({ urls: z.array(z.string().min(3).max(2048)).min(1).max(25) }))
    .mutation(async ({ input }) => {
      // Concurrency-limited fan-out: max 5 in-flight at a time to be polite
      // to sites being hit (one URL per second per domain is enforced inside
      // the company-site scraper but not here — fine for arbitrary URLs).
      const out: ExtractedData[] = [];
      const inFlight: Promise<void>[] = [];
      let i = 0;
      const next = async (): Promise<void> => {
        if (i >= input.urls.length) return;
        const idx = i++;
        const result = await scrapeUrl(input.urls[idx]);
        out[idx] = result;
        return next();
      };
      for (let c = 0; c < Math.min(5, input.urls.length); c++) {
        inFlight.push(next());
      }
      await Promise.all(inFlight);
      return out;
    }),

  /**
   * Persist one extraction as a Prospect row. The Prospects table
   * requires firstName + lastName + linkedinUrl, but only the names
   * are strict at the DB level; we synthesize sensible defaults for
   * the others if missing so the user isn't forced to back out and
   * fix the URL extraction manually.
   */
  saveAsProspect: workspaceProcedure
    .input(SaveInputZ)
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const built = buildScrapedProspectValues({
        workspaceId: ctx.workspace.id,
        source: "url_scraper",
        firstName: input.firstName,
        lastName: input.lastName,
        title: input.jobTitle,
        email: input.email,
        phone: input.phone,
        company: input.companyName,
        companyDomain: input.companyDomain,
        // helper keeps this only if it's a real linkedin.com URL —
        // arbitrary page URLs no longer pollute the linkedinUrl column
        linkedinUrl: input.linkedinUrl,
        sourceUrl: input.url,
      });

      try {
        const inserted = await db.insert(prospects).values(built.values as never);
        const id = Number((inserted as unknown as { insertId?: number }[])[0]?.insertId ?? 0);
        await recordAudit({
          workspaceId: ctx.workspace.id,
          actorUserId: ctx.user.id,
          action: "create",
          entityType: built.entityType,
          entityId: id,
          after: built.audit,
        });
        return { ok: true as const, prospectId: id };
      } catch (e) {
        // Standardized: log the raw error server-side, surface a sanitized
        // TRPCError (don't leak DB internals to the client).
        console.error("[urlScraper.saveAsProspect] insert failed:", e);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not save the prospect. Please try again.",
        });
      }
    }),
});

// Re-export the shape used by the router's queries/mutations for client typing.
export type { ExtractedData };
export type ExtractedFieldSchema = z.infer<typeof ExtractedFieldZ>;
