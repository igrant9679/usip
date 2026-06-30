/**
 * LinkedIn enrichment batch orchestration.
 *
 * createBatch → validate/normalize/dedupe rows; runBatch → retrieve each via
 * Unipile (rate-limited, audited), match to a prospect, and either auto-apply
 * the enrichment (exact / clean high-confidence) or route to manual review;
 * applyReview → apply the user's match decisions.
 *
 * Retrieval is Unipile-only (no scraping). Every query is workspace-scoped.
 * The mapped profile for each run row is stashed in match_reasons.profile so
 * review can apply enrichment without a second vendor call.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db";
import {
  prospects,
  linkedinEnrichmentBatches,
  linkedinEnrichmentBatchRows,
} from "../../../drizzle/schema";
import { validateLinkedInUrl } from "./mapper";
import { retrieveLinkedInProfileByUrl } from "./unipileProfile";
import { matchProfileToProspect, canAutoApply } from "./matching";
import { applyEnrichment, enrichmentBlockReason } from "./enrichmentService";
import { buildScrapedProspectValues } from "../prospectFromSource";

export interface ImportRow {
  linkedinUrl: string;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  email?: string | null;
  prospectId?: number | null;
}

export interface BatchSummary {
  batchId: number;
  status: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  matchedRows: number;
  needsReviewRows: number;
  failedRows: number;
}

const insertId = (res: unknown): number => Number((res as { insertId?: number }[])[0]?.insertId ?? 0);

/* ─────────────────────────── create + validate ────────────────────────── */

export async function createBatch(opts: {
  workspaceId: number;
  userId: number;
  sourceType: "pasted_urls" | "csv_upload";
  rows: ImportRow[];
}): Promise<BatchSummary> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const ws = opts.workspaceId;

  // Validate + normalize + dedupe (within this batch).
  const seen = new Set<string>();
  const prepared = opts.rows.map((r) => {
    const v = validateLinkedInUrl(r.linkedinUrl ?? "");
    let validationStatus: "valid" | "invalid" | "duplicate" = "valid";
    let validationError: string | null = null;
    if (!v.valid) {
      validationStatus = "invalid";
      validationError = v.error;
    } else if (v.normalizedUrl && seen.has(v.normalizedUrl)) {
      validationStatus = "duplicate";
      validationError = "Duplicate URL in this batch";
    } else if (v.normalizedUrl) {
      seen.add(v.normalizedUrl);
    }
    return { row: r, v, validationStatus, validationError };
  });

  const validRows = prepared.filter((p) => p.validationStatus === "valid").length;
  const invalidRows = prepared.length - validRows;

  const batchRes = await db.insert(linkedinEnrichmentBatches).values({
    workspaceId: ws,
    uploadedByUserId: opts.userId,
    sourceType: opts.sourceType,
    status: "validated",
    totalRows: prepared.length,
    validRows,
    invalidRows,
  } as never);
  const batchId = insertId(batchRes);

  if (prepared.length > 0) {
    await db.insert(linkedinEnrichmentBatchRows).values(
      prepared.map((p) => ({
        batchId,
        workspaceId: ws,
        originalUrl: p.row.linkedinUrl ?? "",
        normalizedUrl: p.v.normalizedUrl,
        providedFullName: p.row.fullName ?? null,
        providedFirstName: p.row.firstName ?? null,
        providedLastName: p.row.lastName ?? null,
        providedCompany: p.row.company ?? null,
        providedTitle: p.row.title ?? null,
        providedEmail: p.row.email ?? null,
        providedProspectId: p.row.prospectId ?? null,
        validationStatus: p.validationStatus,
        validationError: p.validationError,
        rowStatus: p.validationStatus === "valid" ? "pending" : "skipped",
      })) as never,
    );
  }

  return {
    batchId, status: "validated",
    totalRows: prepared.length, validRows, invalidRows,
    matchedRows: 0, needsReviewRows: 0, failedRows: 0,
  };
}

/* ────────────────────────────── run batch ─────────────────────────────── */

export async function runBatch(opts: {
  workspaceId: number;
  userId: number;
  isAdmin: boolean;
  batchId: number;
}): Promise<BatchSummary> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const ws = opts.workspaceId;

  const [batch] = await db
    .select()
    .from(linkedinEnrichmentBatches)
    .where(and(eq(linkedinEnrichmentBatches.workspaceId, ws), eq(linkedinEnrichmentBatches.id, opts.batchId)));
  if (!batch) throw new Error("Batch not found");

  await db
    .update(linkedinEnrichmentBatches)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(linkedinEnrichmentBatches.workspaceId, ws), eq(linkedinEnrichmentBatches.id, opts.batchId)));

  const rows = await db
    .select()
    .from(linkedinEnrichmentBatchRows)
    .where(
      and(
        eq(linkedinEnrichmentBatchRows.workspaceId, ws),
        eq(linkedinEnrichmentBatchRows.batchId, opts.batchId),
        eq(linkedinEnrichmentBatchRows.validationStatus, "valid"),
      ),
    );

  for (const row of rows) {
    try {
      const retrieve = await retrieveLinkedInProfileByUrl({
        workspaceId: ws,
        userId: opts.userId,
        isAdmin: opts.isAdmin,
        linkedinUrl: row.normalizedUrl ?? row.originalUrl,
      });

      if (!retrieve.ok || !retrieve.profile) {
        await updateRow(row.id, ws, {
          rowStatus: "failed",
          errorMessage: `${retrieve.status}: ${retrieve.message}`.slice(0, 1000),
        });
        continue;
      }

      const match = await matchProfileToProspect({
        workspaceId: ws,
        normalizedUrl: row.normalizedUrl,
        identifier: retrieve.identifier,
        provided: {
          prospectId: row.providedProspectId,
          fullName: row.providedFullName,
          firstName: row.providedFirstName,
          lastName: row.providedLastName,
          company: row.providedCompany,
          title: row.providedTitle,
          email: row.providedEmail,
        },
        profile: retrieve.profile,
      });

      const matchReasons = {
        reasons: match.reasons,
        candidates: match.candidates,
        viaAccountId: retrieve.viaAccountId,
        profile: retrieve.profile, // stashed so review can apply without re-fetch
      };

      // Auto-apply exact / clean high-confidence.
      if (canAutoApply(match) && match.prospectId) {
        const blocked = await prospectBlocked(ws, match.prospectId);
        if (blocked) {
          await updateRow(row.id, ws, {
            matchStatus: match.status, matchScore: match.score, matchReasons,
            matchedProspectId: match.prospectId, rowStatus: "skipped",
            errorMessage: `blocked_by_policy: ${blocked}`,
          });
          continue;
        }
        const applied = await applyEnrichment({
          workspaceId: ws,
          prospectId: match.prospectId,
          profile: retrieve.profile,
          matchStatus: match.status,
          sourceAccountId: retrieve.viaAccountId,
          imageAllowed: !!retrieve.profile.profileImageUrl,
        });
        await updateRow(row.id, ws, {
          matchStatus: match.status, matchScore: match.score, matchReasons,
          matchedProspectId: match.prospectId, enrichmentId: applied.enrichmentId,
          rowStatus: "enriched",
        });
        continue;
      }

      // Needs review or no match.
      await updateRow(row.id, ws, {
        matchStatus: match.status,
        matchScore: match.score,
        matchReasons,
        matchedProspectId: match.prospectId,
        rowStatus: match.status === "no_match" ? "no_match" : "needs_review",
      });
    } catch (e) {
      await updateRow(row.id, ws, { rowStatus: "failed", errorMessage: (e as Error).message.slice(0, 1000) });
    }
  }

  return finalizeBatch(ws, opts.batchId, "completed");
}

/* ───────────────────────────── apply review ───────────────────────────── */

export type ReviewAction = "match_existing" | "create_new" | "skip" | "conflict" | "suppress";

export async function applyReview(opts: {
  workspaceId: number;
  userId: number;
  isAdmin: boolean;
  batchId: number;
  decisions: Array<{ rowId: number; action: ReviewAction; prospectId?: number | null }>;
}): Promise<BatchSummary> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const ws = opts.workspaceId;

  for (const d of opts.decisions) {
    const [row] = await db
      .select()
      .from(linkedinEnrichmentBatchRows)
      .where(
        and(
          eq(linkedinEnrichmentBatchRows.workspaceId, ws),
          eq(linkedinEnrichmentBatchRows.batchId, opts.batchId),
          eq(linkedinEnrichmentBatchRows.id, d.rowId),
        ),
      );
    if (!row) continue;
    const profile = (row.matchReasons as { profile?: any } | null)?.profile ?? null;

    try {
      if (d.action === "skip" || d.action === "suppress") {
        await updateRow(row.id, ws, { rowStatus: "skipped", errorMessage: d.action === "suppress" ? "suppressed_by_user" : null });
        continue;
      }
      if (d.action === "conflict") {
        await updateRow(row.id, ws, { matchStatus: "conflict", rowStatus: "skipped" });
        continue;
      }
      if (!profile) {
        await updateRow(row.id, ws, { rowStatus: "failed", errorMessage: "No retrieved profile to apply (re-run the batch)" });
        continue;
      }

      if (d.action === "match_existing") {
        const target = d.prospectId ?? row.matchedProspectId;
        if (!target) { await updateRow(row.id, ws, { rowStatus: "failed", errorMessage: "No prospect selected" }); continue; }
        const blocked = await prospectBlocked(ws, target);
        if (blocked) { await updateRow(row.id, ws, { rowStatus: "skipped", errorMessage: `blocked_by_policy: ${blocked}` }); continue; }
        const applied = await applyEnrichment({
          workspaceId: ws, prospectId: target, profile, matchStatus: "manual",
          imageAllowed: !!profile.profileImageUrl,
        });
        await updateRow(row.id, ws, { matchedProspectId: target, enrichmentId: applied.enrichmentId, matchStatus: "high_confidence", rowStatus: "enriched" });
        continue;
      }

      if (d.action === "create_new") {
        const built = buildScrapedProspectValues({
          workspaceId: ws,
          source: "linkedin_enrichment",
          firstName: profile.firstName ?? row.providedFirstName ?? undefined,
          lastName: profile.lastName ?? row.providedLastName ?? undefined,
          title: profile.currentTitle ?? row.providedTitle ?? undefined,
          company: profile.currentCompanyName ?? row.providedCompany ?? undefined,
          companyDomain: profile.currentCompanyDomain ?? undefined,
          linkedinUrl: profile.profileUrl ?? row.normalizedUrl ?? undefined,
          sourceUrl: profile.profileUrl ?? row.normalizedUrl ?? undefined,
        });
        const ins = await db.insert(prospects).values(built.values as never);
        const newId = insertId(ins);
        const applied = await applyEnrichment({
          workspaceId: ws, prospectId: newId, profile, matchStatus: "created_new",
          imageAllowed: !!profile.profileImageUrl,
        });
        await updateRow(row.id, ws, { matchedProspectId: newId, enrichmentId: applied.enrichmentId, matchStatus: "created_new", rowStatus: "enriched" });
        continue;
      }
    } catch (e) {
      await updateRow(row.id, ws, { rowStatus: "failed", errorMessage: (e as Error).message.slice(0, 1000) });
    }
  }

  return finalizeBatch(ws, opts.batchId, "completed");
}

/* ───────────────────────────── reads + helpers ────────────────────────── */

export async function getBatch(workspaceId: number, batchId: number) {
  const db = await getDb();
  if (!db) return null;
  const [batch] = await db
    .select()
    .from(linkedinEnrichmentBatches)
    .where(and(eq(linkedinEnrichmentBatches.workspaceId, workspaceId), eq(linkedinEnrichmentBatches.id, batchId)));
  return batch ?? null;
}

export async function getBatchRows(workspaceId: number, batchId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(linkedinEnrichmentBatchRows)
    .where(and(eq(linkedinEnrichmentBatchRows.workspaceId, workspaceId), eq(linkedinEnrichmentBatchRows.batchId, batchId)));
}

async function updateRow(id: number, ws: number, set: Record<string, unknown>) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(linkedinEnrichmentBatchRows)
    .set(set as never)
    .where(and(eq(linkedinEnrichmentBatchRows.workspaceId, ws), eq(linkedinEnrichmentBatchRows.id, id)));
}

/** Compliance: is this prospect blocked from enrichment? Returns a reason or null. */
async function prospectBlocked(ws: number, prospectId: number): Promise<string | null> {
  const db = await getDb();
  if (!db) return "db_unavailable";
  const [p] = await db
    .select({ verificationStatus: prospects.verificationStatus })
    .from(prospects)
    .where(and(eq(prospects.workspaceId, ws), eq(prospects.id, prospectId)));
  if (!p) return "prospect_not_found";
  return enrichmentBlockReason(p);
}

/** Recompute the batch counters from its rows and set a terminal status. */
async function finalizeBatch(ws: number, batchId: number, status: string): Promise<BatchSummary> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const rows = await db
    .select({ rowStatus: linkedinEnrichmentBatchRows.rowStatus })
    .from(linkedinEnrichmentBatchRows)
    .where(and(eq(linkedinEnrichmentBatchRows.workspaceId, ws), eq(linkedinEnrichmentBatchRows.batchId, batchId)));
  const count = (s: string) => rows.filter((r) => r.rowStatus === s).length;
  const matchedRows = count("enriched");
  const needsReviewRows = count("needs_review");
  const failedRows = count("failed");
  await db
    .update(linkedinEnrichmentBatches)
    .set({ status, completedAt: new Date(), matchedRows, needsReviewRows, failedRows })
    .where(and(eq(linkedinEnrichmentBatches.workspaceId, ws), eq(linkedinEnrichmentBatches.id, batchId)));
  const batch = await getBatch(ws, batchId);
  return {
    batchId, status,
    totalRows: batch?.totalRows ?? rows.length,
    validRows: batch?.validRows ?? 0,
    invalidRows: batch?.invalidRows ?? 0,
    matchedRows, needsReviewRows, failedRows,
  };
}
