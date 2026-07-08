/**
 * LinkedIn enrichment orchestrator — the one-click "Enrich" engine.
 *
 * The user selects prospects (or a whole list) and clicks Enrich. This creates
 * a job + per-prospect items, then processes them ASYNCHRONOUSLY (the request
 * returns immediately with a job id the UI polls). Per prospect it:
 *   eligibility → resolve lookup strategy (existing URL → name/company lookup →
 *   unavailable) → retrieve via Unipile → validate against the INTENDED
 *   prospect → auto-apply / needs_review / conflict / skip → persist + snapshot.
 *
 * Successful enrichment writes a prospect_linkedin_enrichments row, which the
 * daily worker already picks up — so daily monitoring is enabled automatically,
 * no manual step. Retrieval is Unipile-only (rate-limited, audited). One failed
 * prospect never blocks the rest of the batch.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import {
  prospects,
  prospectLinkedinEnrichments,
  linkedinEnrichmentJobs,
  linkedinEnrichmentJobItems,
  recordListMembers,
} from "../../../drizzle/schema";
import { determineLookupStrategy, canUseNameCompanyLookup } from "./lookupStrategy";
import { retrieveLinkedInProfileByUrl, retrieveByNameCompany } from "./unipileProfile";
import { scoreIntendedMatch } from "./matching";
import { applyEnrichment, markUnavailable, enrichmentBlockReason } from "./enrichmentService";
import { checkLinkedInEnrichmentHealth } from "./health";

export type TriggerType =
  | "people_bulk_action" | "people_row_action" | "open_profile_action" | "full_profile_action"
  | "list_bulk_action" | "list_enrich_all" | "account_contacts_action" | "daily_monitoring" | "manual_admin_run";

export interface EnrichOptions {
  forceRefresh?: boolean;
  includeProfileImage?: boolean;
  detectChanges?: boolean;
  scheduleDailyMonitoring?: boolean;
}

export interface JobHandle { jobId: number; status: string; total: number }

const insertId = (res: unknown): number => Number((res as { insertId?: number }[])[0]?.insertId ?? 0);

/* ───────────────────────────── entry points ───────────────────────────── */

export async function runForProspects(opts: {
  workspaceId: number;
  userId: number;
  isAdmin: boolean;
  prospectIds: number[];
  triggerType: TriggerType;
  options?: EnrichOptions;
}): Promise<JobHandle> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const ids = [...new Set(opts.prospectIds)].filter((n) => Number.isFinite(n));
  const ws = opts.workspaceId;

  const jobRes = await db.insert(linkedinEnrichmentJobs).values({
    workspaceId: ws,
    triggeredByUserId: opts.userId,
    triggerType: opts.triggerType,
    status: "queued",
    totalProspects: ids.length,
  } as never);
  const jobId = insertId(jobRes);

  if (ids.length > 0) {
    await db.insert(linkedinEnrichmentJobItems).values(
      ids.map((prospectId) => ({ jobId, workspaceId: ws, prospectId, status: "pending" })) as never,
    );
  }

  // Process asynchronously — the caller gets the job id immediately and polls.
  void processJob({ ws, jobId, userId: opts.userId, isAdmin: opts.isAdmin, single: ids.length === 1, options: opts.options ?? {} })
    .catch((e) => console.error(`[linkedinEnrich] job ${jobId} crashed:`, (e as Error).message));

  return { jobId, status: "queued", total: ids.length };
}

export async function runForList(opts: {
  workspaceId: number;
  userId: number;
  isAdmin: boolean;
  listId: number;
  prospectIds?: number[];
  enrichAll?: boolean;
  triggerType?: TriggerType;
  options?: EnrichOptions;
}): Promise<JobHandle> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  let ids = opts.prospectIds ?? [];
  if (opts.enrichAll || ids.length === 0) {
    const members = await db
      .select({ recordId: recordListMembers.recordId })
      .from(recordListMembers)
      .where(and(
        eq(recordListMembers.workspaceId, opts.workspaceId),
        eq(recordListMembers.listId, opts.listId),
        eq(recordListMembers.recordType, "prospect"),
      ));
    ids = members.map((m) => m.recordId);
  }
  return runForProspects({
    workspaceId: opts.workspaceId, userId: opts.userId, isAdmin: opts.isAdmin,
    prospectIds: ids, triggerType: opts.triggerType ?? (opts.enrichAll ? "list_enrich_all" : "list_bulk_action"),
    options: opts.options,
  });
}

/* ───────────────────────────── processing ─────────────────────────────── */

async function setItem(ws: number, itemId: number, set: Record<string, unknown>) {
  const db = await getDb();
  if (!db) return;
  await db.update(linkedinEnrichmentJobItems).set(set as never)
    .where(and(eq(linkedinEnrichmentJobItems.workspaceId, ws), eq(linkedinEnrichmentJobItems.id, itemId)));
}

async function processJob(ctx: {
  ws: number; jobId: number; userId: number; isAdmin: boolean; single: boolean; options: EnrichOptions;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const { ws, jobId } = ctx;

  await db.update(linkedinEnrichmentJobs).set({ status: "running", startedAt: new Date() })
    .where(and(eq(linkedinEnrichmentJobs.workspaceId, ws), eq(linkedinEnrichmentJobs.id, jobId)));

  // Defensive health re-check (the router pre-checks too). If unhealthy, fail
  // every item with a clear reason rather than silently doing nothing.
  const health = await checkLinkedInEnrichmentHealth({ workspaceId: ws, userId: ctx.userId, isAdmin: ctx.isAdmin });

  const items = await db.select().from(linkedinEnrichmentJobItems)
    .where(and(eq(linkedinEnrichmentJobItems.workspaceId, ws), eq(linkedinEnrichmentJobItems.jobId, jobId)));

  for (const item of items) {
    try {
      if (health.status !== "connected") {
        await setItem(ws, item.id, { status: "failed", errorMessage: health.missing_requirements[0] ?? "LinkedIn not connected", completedAt: new Date() });
        continue;
      }
      await setItem(ws, item.id, { status: "retrieving", startedAt: new Date() });

      const [p] = await db.select().from(prospects)
        .where(and(eq(prospects.workspaceId, ws), eq(prospects.id, item.prospectId)));
      if (!p) { await setItem(ws, item.id, { status: "skipped", errorMessage: "Prospect not found", completedAt: new Date() }); continue; }

      // Compliance — never enrich a suppressed/rejected prospect.
      const block = enrichmentBlockReason(p);
      if (block) { await setItem(ws, item.id, { status: "blocked_by_policy", errorMessage: block, completedAt: new Date() }); continue; }

      // Prior enrichment URL (strategy #3).
      const [prior] = await db.select({ url: prospectLinkedinEnrichments.linkedinProfileUrl })
        .from(prospectLinkedinEnrichments)
        .where(and(eq(prospectLinkedinEnrichments.workspaceId, ws), eq(prospectLinkedinEnrichments.prospectId, p.id)));

      const { strategy, url } = determineLookupStrategy(p as any, prior?.url ?? null);
      if (strategy === "unavailable") {
        await setItem(ws, item.id, { status: "unavailable", linkedinLookupStrategy: "unavailable", completedAt: new Date() });
        continue;
      }

      let usedStrategy = strategy;
      let retrieve = url
        ? await retrieveLinkedInProfileByUrl({ workspaceId: ws, userId: ctx.userId, isAdmin: ctx.isAdmin, linkedinUrl: url })
        : await retrieveByNameCompany({ workspaceId: ws, userId: ctx.userId, isAdmin: ctx.isAdmin, prospect: p as any });

      // Dead/renamed slug (profile URL no longer resolves at the vendor):
      // fall back to the same compliant name+company search used for URL-less
      // prospects. Match scoring below still gates weak matches into
      // needs_review, so the fallback can't silently mis-enrich. Never
      // triggered on rate limits — that would burn a second lookup for nothing.
      if ((!retrieve.ok || !retrieve.profile) && url && retrieve.status === "source_unavailable" && canUseNameCompanyLookup(p as any)) {
        const fallback = await retrieveByNameCompany({ workspaceId: ws, userId: ctx.userId, isAdmin: ctx.isAdmin, prospect: p as any });
        if (fallback.ok && fallback.profile) {
          retrieve = fallback;
          usedStrategy = "unipile_name_company_lookup";
        }
      }

      if (!retrieve.ok || !retrieve.profile) {
        // If a prior enrichment exists, record "unavailable" as a change.
        if (prior?.url) {
          const [enr] = await db.select({ id: prospectLinkedinEnrichments.id })
            .from(prospectLinkedinEnrichments)
            .where(and(eq(prospectLinkedinEnrichments.workspaceId, ws), eq(prospectLinkedinEnrichments.prospectId, p.id)));
          if (enr) await markUnavailable({ workspaceId: ws, prospectId: p.id, enrichmentId: enr.id, reason: retrieve.message });
        }
        const itemStatus = retrieve.status === "no_match" ? "unavailable" : "failed";
        await setItem(ws, item.id, { status: itemStatus, linkedinLookupStrategy: strategy, linkedinUrlUsed: url, errorMessage: `${retrieve.status}: ${retrieve.message}`.slice(0, 1000), completedAt: new Date() });
        continue;
      }

      const match = scoreIntendedMatch(p as any, retrieve.profile, { userInitiatedSingle: ctx.single });

      const base = {
        linkedinLookupStrategy: usedStrategy,
        linkedinUrlUsed: retrieve.profile.profileUrl ?? url,
        matchStatus: match.status,
        matchScore: match.score,
        completedAt: new Date(),
      };

      if (match.conflict) {
        await setItem(ws, item.id, { ...base, status: "conflict" });
        continue;
      }
      if (match.autoApply) {
        await applyEnrichment({
          workspaceId: ws, prospectId: p.id, profile: retrieve.profile,
          matchStatus: match.status, sourceAccountId: retrieve.viaAccountId,
          imageAllowed: (ctx.options.includeProfileImage ?? true) && !!retrieve.profile.profileImageUrl,
        });
        await setItem(ws, item.id, { ...base, status: "enriched" });
        continue;
      }
      // 50–74 not single, or <50 → needs review (never overwrite fields).
      await setItem(ws, item.id, { ...base, status: "needs_review" });
    } catch (e) {
      // Drizzle query errors put the whole SQL in .message and the actual DB
      // reason in .cause — lead with the cause so it survives the 1000-char cap.
      const msg = [(e as any)?.cause?.message, (e as Error).message].filter(Boolean).join(" ⇐ ");
      await setItem(ws, item.id, { status: "failed", errorMessage: msg.slice(0, 1000), completedAt: new Date() });
    }
  }

  await finalizeJob(ws, jobId);
}

async function finalizeJob(ws: number, jobId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const rows = await db.select({ status: linkedinEnrichmentJobItems.status })
    .from(linkedinEnrichmentJobItems)
    .where(and(eq(linkedinEnrichmentJobItems.workspaceId, ws), eq(linkedinEnrichmentJobItems.jobId, jobId)));
  const n = (s: string) => rows.filter((r) => r.status === s).length;
  const enriched = n("enriched");
  const needsReview = n("needs_review");
  const conflict = n("conflict");
  const failed = n("failed");
  const skipped = n("skipped") + n("unavailable") + n("blocked_by_policy");
  const eligible = enriched + needsReview + conflict + failed;
  await db.update(linkedinEnrichmentJobs).set({
    status: "completed", completedAt: new Date(),
    eligibleCount: eligible, enrichedCount: enriched, needsReviewCount: needsReview,
    conflictCount: conflict, failedCount: failed, skippedCount: skipped,
  } as never).where(and(eq(linkedinEnrichmentJobs.workspaceId, ws), eq(linkedinEnrichmentJobs.id, jobId)));
}

/* ─────────────────────────────── reads ────────────────────────────────── */

export async function getJob(workspaceId: number, jobId: number) {
  const db = await getDb();
  if (!db) return null;
  const [job] = await db.select().from(linkedinEnrichmentJobs)
    .where(and(eq(linkedinEnrichmentJobs.workspaceId, workspaceId), eq(linkedinEnrichmentJobs.id, jobId)));
  return job ?? null;
}

export async function getJobItems(workspaceId: number, jobId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(linkedinEnrichmentJobItems)
    .where(and(eq(linkedinEnrichmentJobItems.workspaceId, workspaceId), eq(linkedinEnrichmentJobItems.jobId, jobId)))
    .orderBy(desc(linkedinEnrichmentJobItems.id));
}
