/**
 * Prospect import router — LeadRocks CSV upload flow.
 *
 * Two-step flow:
 *   1. parsePreview — client uploads CSV (base64 or plain text), server
 *      parses + maps + dedups against existing prospects + returns stats
 *      and a sample. Result is cached in-process by importToken (15-min TTL)
 *      so the user can review before committing.
 *
 *   2. commit — client confirms with importToken, server inserts the
 *      mapped rows into the prospects table in batches, returns
 *      created / skipped / errored counts.
 *
 * Why in-memory cache and not a temp DB table:
 *   - 10k rows × ~500 B per MappedProspect ≈ 5 MB per pending import
 *   - 15-min TTL + per-workspace single-import semantics caps memory
 *   - Single-server deployment (no horizontal scaling) means in-memory is fine
 * If we ever shard the server, swap this for a `prospect_import_drafts`
 * table keyed by token.
 */

import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "crypto";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { prospects } from "../../drizzle/schema";
import { parseCSVText } from "../services/csv";
import {
  looksLikeLeadRocks,
  mapLeadRocksRow,
  type MappedProspect,
} from "../services/leadrocks";
import { recordAudit } from "../audit";

/* ─── In-memory draft cache ────────────────────────────────────────────── */

type ImportDraft = {
  workspaceId: number;
  userId: number;
  filename: string;
  format: "leadrocks" | "unknown";
  totalRows: number;
  unmappableRows: number;     // missing firstName/lastName/linkedinUrl
  withEmailRows: number;
  withoutEmailRows: number;
  duplicateInFile: number;    // linkedinUrl duplicates within the CSV itself
  alreadyExisting: number;    // linkedinUrl already in prospects table
  toImport: MappedProspect[]; // deduped + final list
  sample: MappedProspect[];   // first 10 rows for UI preview
  createdAt: number;
};

const DRAFT_TTL_MS = 15 * 60 * 1000;
const draftCache = new Map<string, ImportDraft>();

function pruneExpiredDrafts(): void {
  const now = Date.now();
  for (const [token, d] of draftCache.entries()) {
    if (now - d.createdAt > DRAFT_TTL_MS) draftCache.delete(token);
  }
}

/* ─── Router ───────────────────────────────────────────────────────────── */

export const prospectImportsRouter = router({
  /**
   * Parse + preview a CSV upload. Does not write to the database.
   *
   * Input: raw CSV text (capped at 50 MB / 50k rows in the body parser).
   *        Client should decode the file with FileReader.readAsText before
   *        sending — keeps server CPU low by avoiding base64 transcode.
   */
  parsePreview: workspaceProcedure
    .input(
      z.object({
        csv: z.string().min(1).max(50_000_000), // 50 MB hard cap
        filename: z.string().max(255).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      pruneExpiredDrafts();

      const { headers, rows } = parseCSVText(input.csv);
      if (headers.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "CSV is empty or unparseable" });
      }
      if (rows.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "CSV has no data rows" });
      }
      if (rows.length > 50_000) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Too many rows (${rows.length.toLocaleString()}). Split into batches ≤ 50,000.`,
        });
      }

      const isLeadRocks = looksLikeLeadRocks(headers);
      if (!isLeadRocks) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This doesn't look like a LeadRocks export. Required columns " +
            "missing: 'Linked Url', 'Company Website', and 'Work Email #1' (or similar). " +
            "Generic CSV import is not yet supported here — use the contacts import for those.",
        });
      }

      // Map all rows
      const mapped: MappedProspect[] = [];
      let unmappable = 0;
      for (const r of rows) {
        const m = mapLeadRocksRow(r, headers);
        if (m) mapped.push(m);
        else unmappable++;
      }

      // Dedup within file (linkedinUrl is the canonical key)
      const seen = new Set<string>();
      const deduped: MappedProspect[] = [];
      let duplicateInFile = 0;
      for (const m of mapped) {
        const key = m.linkedinUrl.toLowerCase();
        if (seen.has(key)) {
          duplicateInFile++;
          continue;
        }
        seen.add(key);
        deduped.push(m);
      }

      // Dedup against existing prospects in this workspace
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const existing = new Set<string>();
      if (deduped.length > 0) {
        // Drizzle inArray() with thousands of strings can blow the param limit;
        // chunk in groups of 1,000 to stay safe.
        for (let i = 0; i < deduped.length; i += 1000) {
          const chunk = deduped.slice(i, i + 1000);
          const urls = chunk.map((m) => m.linkedinUrl);
          const rowsExisting = await db
            .select({ url: prospects.linkedinUrl })
            .from(prospects)
            .where(
              and(
                eq(prospects.workspaceId, ctx.workspace.id),
                inArray(prospects.linkedinUrl, urls),
              ),
            );
          for (const r of rowsExisting) {
            if (r.url) existing.add(r.url.toLowerCase());
          }
        }
      }

      const toImport = deduped.filter((m) => !existing.has(m.linkedinUrl.toLowerCase()));
      const withEmail = toImport.filter((m) => m.email).length;

      const token = randomUUID();
      const draft: ImportDraft = {
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        filename: input.filename ?? "leadrocks_export.csv",
        format: "leadrocks",
        totalRows: rows.length,
        unmappableRows: unmappable,
        withEmailRows: withEmail,
        withoutEmailRows: toImport.length - withEmail,
        duplicateInFile,
        alreadyExisting: existing.size,
        toImport,
        sample: toImport.slice(0, 10),
        createdAt: Date.now(),
      };
      draftCache.set(token, draft);

      return {
        importToken: token,
        format: draft.format,
        filename: draft.filename,
        totalRows: draft.totalRows,
        unmappableRows: draft.unmappableRows,
        duplicateInFile: draft.duplicateInFile,
        alreadyExisting: draft.alreadyExisting,
        toImport: toImport.length,
        withEmailRows: draft.withEmailRows,
        withoutEmailRows: draft.withoutEmailRows,
        sample: draft.sample,
      };
    }),

  /** Commit a previewed import to the prospects table. */
  commit: workspaceProcedure
    .input(z.object({ importToken: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      pruneExpiredDrafts();
      const draft = draftCache.get(input.importToken);
      if (!draft) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Import preview expired or not found. Re-upload the CSV.",
        });
      }
      if (draft.workspaceId !== ctx.workspace.id || draft.userId !== ctx.user.id) {
        // Token belongs to someone else / different workspace — refuse hard.
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Insert in batches of 500. MySQL's max_allowed_packet is the typical
      // bottleneck; 500 rows × ~500B ≈ 250KB which is comfortably under
      // default 64MB packet sizes.
      const BATCH = 500;
      let created = 0;
      let errored = 0;

      for (let i = 0; i < draft.toImport.length; i += BATCH) {
        const chunk = draft.toImport.slice(i, i + BATCH);
        try {
          await db.insert(prospects).values(
            chunk.map((m) => ({
              workspaceId: ctx.workspace.id,
              firstName: m.firstName,
              lastName: m.lastName,
              linkedinUrl: m.linkedinUrl,
              title: m.title ?? undefined,
              company: m.company ?? undefined,
              companyDomain: m.companyDomain ?? undefined,
              industry: m.industry ?? undefined,
              city: m.city ?? undefined,
              state: m.state ?? undefined,
              country: m.country ?? undefined,
              email: m.email ?? undefined,
              emailStatus: m.emailStatus ?? undefined,
              phone: m.phone ?? undefined,
            })) as never,
          );
          created += chunk.length;
        } catch (e) {
          // Most likely a unique constraint hit on linkedinUrl from a race
          // with another import; fall back to inserting one-by-one so we
          // can count the survivors.
          for (const m of chunk) {
            try {
              await db.insert(prospects).values({
                workspaceId: ctx.workspace.id,
                firstName: m.firstName,
                lastName: m.lastName,
                linkedinUrl: m.linkedinUrl,
                title: m.title ?? undefined,
                company: m.company ?? undefined,
                companyDomain: m.companyDomain ?? undefined,
                industry: m.industry ?? undefined,
                city: m.city ?? undefined,
                state: m.state ?? undefined,
                country: m.country ?? undefined,
                email: m.email ?? undefined,
                emailStatus: m.emailStatus ?? undefined,
                phone: m.phone ?? undefined,
              } as never);
              created++;
            } catch {
              errored++;
            }
          }
          void e;
        }
      }

      // Free the draft now that we've consumed it
      draftCache.delete(input.importToken);

      // Auto-create/link companies for the freshly imported prospects
      // (best-effort, async — never blocks the import response).
      void import("../services/company/associationService")
        .then((m) => m.associateUnlinkedProspects(ctx.workspace.id))
        .catch((e) => console.error("[company] post-import association failed:", (e as Error).message));

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "prospect_import",
        entityId: 0,
        after: {
          filename: draft.filename,
          format: draft.format,
          totalRows: draft.totalRows,
          attempted: draft.toImport.length,
          created,
          errored,
        },
      });

      return {
        filename: draft.filename,
        attempted: draft.toImport.length,
        created,
        errored,
      };
    }),

  /** Discard a pending preview without importing. */
  discard: workspaceProcedure
    .input(z.object({ importToken: z.string().uuid() }))
    .mutation(({ input }) => {
      draftCache.delete(input.importToken);
      return { ok: true };
    }),
});
