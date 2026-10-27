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
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../../db";
import {
  prospects,
  linkedinEnrichmentBatches,
  linkedinEnrichmentBatchRows,
  workspaceMembers,
} from "../../../drizzle/schema";
import { validateLinkedInUrl } from "./mapper";
import { retrieveLinkedInProfileByUrl } from "./unipileProfile";
import { matchProfileToProspect, canAutoApply } from "./matching";
import { applyEnrichment, enrichmentBlockReason } from "./enrichmentService";
import { buildScrapedProspectValues } from "../prospectFromSource";
import { LOOKUP_WAIT_MS, type LookupTurn } from "./lookupQueue";
import { isAdminRole } from "../../_core/workspace";

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

/** A batch a worker died holding goes back to the queue after this long. */
const BATCH_STALE_MS = 10 * 60 * 1000;

/**
 * Queue a batch to run (audit 2026-10-20, P90). Refused while it is already
 * running, and only rows still pending are ever looked up, so a second click
 * or a retry never pays twice. The lookups run in the background through the
 * LinkedIn queue (lookupQueue), at the pace the account limits allow.
 */
export async function startBatch(opts: { workspaceId: number; batchId: number; userId: number }): Promise<{ status: string; pending: number }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const ws = opts.workspaceId;
  const [batch] = await db.select().from(linkedinEnrichmentBatches)
    .where(and(eq(linkedinEnrichmentBatches.workspaceId, ws), eq(linkedinEnrichmentBatches.id, opts.batchId)));
  if (!batch) throw new Error("Batch not found");
  const fresh = batch.heartbeatAt && Date.now() - new Date(batch.heartbeatAt).getTime() < BATCH_STALE_MS;
  if (batch.status === "running" && fresh) throw new Error("This batch is already running.");
  const pending = (await db.select({ id: linkedinEnrichmentBatchRows.id }).from(linkedinEnrichmentBatchRows)
    .where(and(
      eq(linkedinEnrichmentBatchRows.workspaceId, ws), eq(linkedinEnrichmentBatchRows.batchId, opts.batchId),
      eq(linkedinEnrichmentBatchRows.validationStatus, "valid"), eq(linkedinEnrichmentBatchRows.rowStatus, "pending"),
    ))).length;
  if (pending === 0) throw new Error("Nothing left to look up in this batch. Retry the failed rows to look them up again.");
  await db.update(linkedinEnrichmentBatches)
    .set({ status: "queued", runByUserId: opts.userId, holdReason: null, completedAt: null } as never)
    .where(and(eq(linkedinEnrichmentBatches.workspaceId, ws), eq(linkedinEnrichmentBatches.id, opts.batchId)));
  return { status: "queued", pending };
}

/** Put a batch's failed rows back in the queue (audit P90: they could not be retried). */
export async function retryFailedRows(opts: { workspaceId: number; batchId: number; userId: number }): Promise<{ retried: number }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const ws = opts.workspaceId;
  const failed = await db.select({ id: linkedinEnrichmentBatchRows.id }).from(linkedinEnrichmentBatchRows)
    .where(and(
      eq(linkedinEnrichmentBatchRows.workspaceId, ws), eq(linkedinEnrichmentBatchRows.batchId, opts.batchId),
      eq(linkedinEnrichmentBatchRows.rowStatus, "failed"),
    ));
  if (failed.length === 0) return { retried: 0 };
  await db.update(linkedinEnrichmentBatchRows)
    .set({ rowStatus: "pending", errorMessage: null } as never)
    .where(and(eq(linkedinEnrichmentBatchRows.workspaceId, ws), inArray(linkedinEnrichmentBatchRows.id, failed.map((r) => r.id))));
  await startBatch(opts);
  return { retried: failed.length };
}

/** One worker per batch: the conditional UPDATE is the claim. */
async function claimBatch(ws: number, batchId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const [b] = await db.select({ status: linkedinEnrichmentBatches.status, heartbeatAt: linkedinEnrichmentBatches.heartbeatAt })
    .from(linkedinEnrichmentBatches)
    .where(and(eq(linkedinEnrichmentBatches.workspaceId, ws), eq(linkedinEnrichmentBatches.id, batchId)));
  if (!b) return false;
  const stale = !b.heartbeatAt || Date.now() - new Date(b.heartbeatAt).getTime() >= BATCH_STALE_MS;
  if (!(b.status === "queued" || b.status === "waiting" || (b.status === "running" && stale))) return false;
  const [res] = await db.update(linkedinEnrichmentBatches)
    .set({ status: "running", heartbeatAt: new Date(), holdReason: null, startedAt: sql`COALESCE(${linkedinEnrichmentBatches.startedAt}, NOW())` } as never)
    .where(and(
      eq(linkedinEnrichmentBatches.workspaceId, ws), eq(linkedinEnrichmentBatches.id, batchId),
      eq(linkedinEnrichmentBatches.status, b.status),
      b.heartbeatAt ? eq(linkedinEnrichmentBatches.heartbeatAt, b.heartbeatAt) : isNull(linkedinEnrichmentBatches.heartbeatAt),
    ));
  return Number((res as { affectedRows?: number })?.affectedRows ?? 0) === 1;
}

/**
 * Look up a batch's pending rows until they are done, the account limits hold
 * a lookup, or `deadline` passes (audit P7: every row after the first used to
 * fail on the pacing refusal). A hold leaves the row pending and the batch
 * "waiting"; the LinkedIn queue resumes it.
 */
export async function runBatch(opts: {
  workspaceId: number;
  userId: number;
  isAdmin: boolean;
  batchId: number;
  deadline?: number;
}): Promise<BatchSummary & LookupTurn> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const ws = opts.workspaceId;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  if (!(await claimBatch(ws, opts.batchId))) {
    return { ...(await summarize(ws, opts.batchId)), looked: 0, held: null };
  }

  const rows = await db
    .select()
    .from(linkedinEnrichmentBatchRows)
    .where(
      and(
        eq(linkedinEnrichmentBatchRows.workspaceId, ws),
        eq(linkedinEnrichmentBatchRows.batchId, opts.batchId),
        eq(linkedinEnrichmentBatchRows.validationStatus, "valid"),
        eq(linkedinEnrichmentBatchRows.rowStatus, "pending"),
      ),
    );

  let looked = 0;
  const park = async (holdReason: string | null): Promise<BatchSummary & LookupTurn> => {
    await db.update(linkedinEnrichmentBatches)
      .set({ status: "waiting", holdReason: holdReason?.slice(0, 300) ?? null, heartbeatAt: new Date() } as never)
      .where(and(eq(linkedinEnrichmentBatches.workspaceId, ws), eq(linkedinEnrichmentBatches.id, opts.batchId)));
    return { ...(await summarize(ws, opts.batchId)), looked, held: holdReason };
  };

  for (const row of rows) {
    if (Date.now() >= deadline) return park(null);
    await db.update(linkedinEnrichmentBatches).set({ heartbeatAt: new Date() } as never)
      .where(and(eq(linkedinEnrichmentBatches.workspaceId, ws), eq(linkedinEnrichmentBatches.id, opts.batchId)));
    try {
      const retrieve = await retrieveLinkedInProfileByUrl({
        workspaceId: ws,
        userId: opts.userId,
        isAdmin: opts.isAdmin,
        linkedinUrl: row.normalizedUrl ?? row.originalUrl,
        waitMs: LOOKUP_WAIT_MS,
        feature: "linkedinBatch",
      });
      // Held by the account limits: the row stays pending for the next turn.
      if (retrieve.status === "rate_limited") return park(retrieve.message);
      looked++;

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

  return { ...(await finalizeBatch(ws, opts.batchId, "completed")), looked, held: null };
}

/** A batch's counts without changing its status (a run that did not get the claim). */
async function summarize(ws: number, batchId: number): Promise<BatchSummary> {
  const batch = await getBatch(ws, batchId);
  return {
    batchId,
    status: batch?.status ?? "missing",
    totalRows: batch?.totalRows ?? 0,
    validRows: batch?.validRows ?? 0,
    invalidRows: batch?.invalidRows ?? 0,
    matchedRows: batch?.matchedRows ?? 0,
    needsReviewRows: batch?.needsReviewRows ?? 0,
    failedRows: batch?.failedRows ?? 0,
  };
}

/** The queue's turn for this workspace: every batch not finished, oldest first. */
export async function continueBatches(ws: number, deadline: number): Promise<LookupTurn> {
  const db = await getDb();
  if (!db) return { looked: 0, held: null };
  const batches = await db.select().from(linkedinEnrichmentBatches)
    .where(and(eq(linkedinEnrichmentBatches.workspaceId, ws), inArray(linkedinEnrichmentBatches.status, ["queued", "waiting", "running"])))
    .orderBy(asc(linkedinEnrichmentBatches.id));
  let looked = 0;
  for (const b of batches) {
    if (Date.now() >= deadline) break;
    const userId = b.runByUserId ?? b.uploadedByUserId;
    const [m] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, ws), eq(workspaceMembers.userId, userId)));
    const r = await runBatch({ workspaceId: ws, userId, isAdmin: isAdminRole(m?.role ?? "rep"), batchId: b.id, deadline });
    looked += r.looked;
    if (r.held) return { looked, held: r.held };
  }
  return { looked, held: null };
}

/** Workspaces with a batch not finished. */
export async function workspacesWithPendingBatches(): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ ws: linkedinEnrichmentBatches.workspaceId }).from(linkedinEnrichmentBatches)
    .where(inArray(linkedinEnrichmentBatches.status, ["queued", "waiting", "running"]));
  return Array.from(new Set(rows.map((r) => r.ws)));
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
    .set({ status, completedAt: new Date(), matchedRows, needsReviewRows, failedRows, holdReason: null } as never)
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
