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
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../../db";
import {
  prospects,
  prospectLinkedinEnrichments,
  linkedinEnrichmentJobs,
  linkedinEnrichmentJobItems,
  recordListMembers,
  workspaceMembers,
} from "../../../drizzle/schema";
import { determineLookupStrategy, canUseNameCompanyLookup } from "./lookupStrategy";
import { retrieveLinkedInProfileByUrl, retrieveByNameCompany } from "./unipileProfile";
import { scoreIntendedMatch } from "./matching";
import { applyEnrichment, markUnavailable, enrichmentBlockReason } from "./enrichmentService";
import { checkLinkedInEnrichmentHealth } from "./health";
import { LOOKUP_WAIT_MS, type LookupTurn } from "./lookupQueue";
import { isAdminRole } from "../../_core/workspace";

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

/** Record-level actions a person takes on one record (the bulk action with one row selected counts). */
export const PERSON_TRIGGERS = ["people_row_action", "open_profile_action", "full_profile_action", "people_bulk_action"] as const;

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
    // Kept on the row so the queue can resume the job after a restart.
    options: (opts.options ?? {}) as never,
  } as never);
  const jobId = insertId(jobRes);

  if (ids.length > 0) {
    await db.insert(linkedinEnrichmentJobItems).values(
      ids.map((prospectId) => ({ jobId, workspaceId: ws, prospectId, status: "pending" })) as never,
    );
  }

  // Process asynchronously — the caller gets the job id immediately and polls.
  // A person enriching ONE record themselves may do so while the account's
  // LinkedIn activity is switched off (owner ask 2026-10-05); bulk and list
  // enrichment, and the daily check, stay behind the switch. Held by the
  // account limits, the job waits and linkedinEnrichment/lookupQueue resumes it.
  const personInitiated = ids.length === 1 && (PERSON_TRIGGERS as readonly string[]).includes(opts.triggerType);
  void processJob({ ws, jobId, userId: opts.userId, isAdmin: opts.isAdmin, single: ids.length === 1, personInitiated, options: opts.options ?? {} })
    .catch((e) => console.error(`[linkedinEnrich] job ${jobId} crashed:`, (e as Error).message));

  return { jobId, status: "queued", total: ids.length };
}

/**
 * The most one Enrich run may take on (audit P92: "Enrich all" on a large list
 * queued every member, far past what the accounts can look up in days).
 */
export const MAX_ENRICH_PER_JOB = 1000;

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
  if (ids.length > MAX_ENRICH_PER_JOB) {
    throw new Error(`This list has ${ids.length.toLocaleString()} people. Enrich at most ${MAX_ENRICH_PER_JOB.toLocaleString()} at a time: select them, or split the list.`);
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

/** A job a worker died holding goes back to the queue after this long. */
const JOB_STALE_MS = 10 * 60 * 1000;

type JobCtx = {
  ws: number; jobId: number; userId: number; isAdmin: boolean; single: boolean; personInitiated: boolean; options: EnrichOptions;
};

/** Rebuild what a job runs as from its row: the queue resumes jobs after a restart. */
async function jobContext(job: typeof linkedinEnrichmentJobs.$inferSelect): Promise<JobCtx> {
  const db = await getDb();
  let isAdmin = false;
  if (db) {
    const [m] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, job.workspaceId), eq(workspaceMembers.userId, job.triggeredByUserId)));
    isAdmin = isAdminRole(m?.role ?? "rep");
  }
  const single = job.totalProspects === 1;
  return {
    ws: job.workspaceId, jobId: job.id, userId: job.triggeredByUserId, isAdmin, single,
    personInitiated: single && (PERSON_TRIGGERS as readonly string[]).includes(job.triggerType),
    options: (job.options as EnrichOptions | null) ?? {},
  };
}

/** One worker per job: the conditional UPDATE is the claim. */
async function claimJob(ws: number, jobId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const [job] = await db.select({ status: linkedinEnrichmentJobs.status, heartbeatAt: linkedinEnrichmentJobs.heartbeatAt })
    .from(linkedinEnrichmentJobs)
    .where(and(eq(linkedinEnrichmentJobs.workspaceId, ws), eq(linkedinEnrichmentJobs.id, jobId)));
  if (!job) return false;
  const stale = !job.heartbeatAt || Date.now() - new Date(job.heartbeatAt).getTime() >= JOB_STALE_MS;
  if (!(job.status === "queued" || job.status === "waiting" || (job.status === "running" && stale))) return false;
  const [res] = await db.update(linkedinEnrichmentJobs)
    .set({ status: "running", heartbeatAt: new Date(), holdReason: null, startedAt: sql`COALESCE(${linkedinEnrichmentJobs.startedAt}, NOW())` } as never)
    .where(and(
      eq(linkedinEnrichmentJobs.workspaceId, ws), eq(linkedinEnrichmentJobs.id, jobId),
      eq(linkedinEnrichmentJobs.status, job.status),
      job.heartbeatAt ? eq(linkedinEnrichmentJobs.heartbeatAt, job.heartbeatAt) : isNull(linkedinEnrichmentJobs.heartbeatAt),
    ));
  return Number((res as { affectedRows?: number })?.affectedRows ?? 0) === 1;
}

/** Hand the job back to the queue: held by the account limits (`holdReason`), or out of time. */
async function pauseJob(ws: number, jobId: number, holdReason: string | null): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(linkedinEnrichmentJobs)
    .set({ status: "waiting", holdReason: holdReason?.slice(0, 300) ?? null, heartbeatAt: new Date() } as never)
    .where(and(eq(linkedinEnrichmentJobs.workspaceId, ws), eq(linkedinEnrichmentJobs.id, jobId)));
}

/**
 * Work a job's pending items until they are done, the account limits hold a
 * lookup, or `deadline` passes. Audit 2026-10-20 (P7): this used to run every
 * item back to back in one promise. The gate refused every lookup after the
 * first, each refusal was recorded as a failure (and, for a dead slug, spent a
 * fallback search), and a restart lost the run. Now a hold keeps the item
 * pending and parks the job as "waiting"; linkedinEnrichment/lookupQueue
 * picks it up again when the gate allows.
 */
async function processJob(ctx: JobCtx, deadline = Number.POSITIVE_INFINITY): Promise<LookupTurn> {
  const db = await getDb();
  if (!db) return { looked: 0, held: null };
  const { ws, jobId } = ctx;
  if (!(await claimJob(ws, jobId))) return { looked: 0, held: null };

  // Defensive health re-check (the router pre-checks too). If unhealthy, fail
  // every item with a clear reason rather than silently doing nothing.
  const health = await checkLinkedInEnrichmentHealth({ workspaceId: ws, userId: ctx.userId, isAdmin: ctx.isAdmin });
  // A person waiting on one record hears a hold at once; bulk runs pace themselves.
  const waitMs = ctx.personInitiated ? 0 : LOOKUP_WAIT_MS;
  const feature = ctx.single ? "linkedinEnrich.single" : "linkedinEnrich.bulk";

  // Only work not yet done. "retrieving" is an item a dead worker was holding:
  // this worker owns the job now (the claim above), so it is pending again.
  const items = await db.select().from(linkedinEnrichmentJobItems)
    .where(and(
      eq(linkedinEnrichmentJobItems.workspaceId, ws), eq(linkedinEnrichmentJobItems.jobId, jobId),
      inArray(linkedinEnrichmentJobItems.status, ["pending", "retrieving"]),
    ));

  let looked = 0;
  const hold = async (itemId: number, message: string): Promise<LookupTurn> => {
    await setItem(ws, itemId, { status: "pending", errorMessage: `Waiting for LinkedIn limits: ${message}`.slice(0, 1000) });
    await pauseJob(ws, jobId, message);
    return { looked, held: message };
  };

  for (const item of items) {
    if (Date.now() >= deadline) {
      await pauseJob(ws, jobId, null);
      return { looked, held: null };
    }
    try {
      if (health.status !== "connected") {
        await setItem(ws, item.id, { status: "failed", errorMessage: health.missing_requirements[0] ?? "LinkedIn not connected", completedAt: new Date() });
        continue;
      }
      await setItem(ws, item.id, { status: "retrieving", startedAt: new Date() });
      await db.update(linkedinEnrichmentJobs).set({ heartbeatAt: new Date() } as never)
        .where(and(eq(linkedinEnrichmentJobs.workspaceId, ws), eq(linkedinEnrichmentJobs.id, jobId)));

      const [p] = await db.select().from(prospects)
        .where(and(eq(prospects.workspaceId, ws), eq(prospects.id, item.prospectId)));
      if (!p) { await setItem(ws, item.id, { status: "skipped", errorMessage: "Prospect not found", completedAt: new Date() }); continue; }

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
        ? await retrieveLinkedInProfileByUrl({ workspaceId: ws, userId: ctx.userId, isAdmin: ctx.isAdmin, linkedinUrl: url, personInitiated: ctx.personInitiated, waitMs, feature })
        : await retrieveByNameCompany({ workspaceId: ws, userId: ctx.userId, isAdmin: ctx.isAdmin, prospect: p as any, personInitiated: ctx.personInitiated, waitMs });
      if (retrieve.status === "rate_limited") return await hold(item.id, retrieve.message);
      looked++;

      // Dead/renamed slug (the vendor answered "not found" for the URL): fall
      // back to the same compliant name+company search used for URL-less
      // prospects. Match scoring below still gates weak matches into
      // needs_review, so the fallback can't silently mis-enrich. Never
      // triggered by a hold — that would burn a second lookup for nothing
      // (audit P7: holds used to be read as "source_unavailable", which is
      // exactly what this fallback keyed on).
      if ((!retrieve.ok || !retrieve.profile) && url && retrieve.status === "no_match" && canUseNameCompanyLookup(p as any)) {
        const fallback = await retrieveByNameCompany({ workspaceId: ws, userId: ctx.userId, isAdmin: ctx.isAdmin, prospect: p as any, personInitiated: ctx.personInitiated, waitMs });
        if (fallback.status === "rate_limited") return await hold(item.id, fallback.message);
        looked++;
        if (fallback.ok && fallback.profile) {
          retrieve = fallback;
          usedStrategy = "unipile_name_company_lookup";
        }
      }

      if (!retrieve.ok || !retrieve.profile) {
        // If a prior enrichment exists and the vendor says the profile is
        // gone, record "unavailable" as a change. A vendor error is not that.
        if (prior?.url && retrieve.status === "no_match") {
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
      // What a reviewer confirms (audit P8): the profile this run found, kept
      // so "Confirm & apply" applies exactly it, without a second lookup.
      const candidate = { candidateProfile: { profile: retrieve.profile, viaAccountId: retrieve.viaAccountId } };

      if (match.conflict) {
        await setItem(ws, item.id, { ...base, ...candidate, status: "conflict" });
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
      await setItem(ws, item.id, { ...base, ...candidate, status: "needs_review" });
    } catch (e) {
      // Drizzle query errors put the whole SQL in .message and the actual DB
      // reason in .cause — lead with the cause so it survives the 1000-char cap.
      const msg = [(e as any)?.cause?.message, (e as Error).message].filter(Boolean).join(" ⇐ ");
      await setItem(ws, item.id, { status: "failed", errorMessage: msg.slice(0, 1000), completedAt: new Date() });
    }
  }

  await finalizeJob(ws, jobId);
  return { looked, held: null };
}

/**
 * The queue's turn for this workspace (linkedinEnrichment/lookupQueue): every
 * job not finished, oldest first, until one is held or time runs out.
 */
export async function continueEnrichmentJobs(ws: number, deadline: number): Promise<LookupTurn> {
  const db = await getDb();
  if (!db) return { looked: 0, held: null };
  const jobs = await db.select().from(linkedinEnrichmentJobs)
    .where(and(eq(linkedinEnrichmentJobs.workspaceId, ws), inArray(linkedinEnrichmentJobs.status, ["queued", "waiting", "running"])))
    .orderBy(asc(linkedinEnrichmentJobs.id));
  let looked = 0;
  for (const job of jobs) {
    if (Date.now() >= deadline) break;
    const r = await processJob(await jobContext(job), deadline);
    looked += r.looked;
    if (r.held) return { looked, held: r.held };
  }
  return { looked, held: null };
}

/** Workspaces with an Enrich job not finished. */
export async function workspacesWithPendingJobs(): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ ws: linkedinEnrichmentJobs.workspaceId }).from(linkedinEnrichmentJobs)
    .where(inArray(linkedinEnrichmentJobs.status, ["queued", "waiting", "running"]));
  return Array.from(new Set(rows.map((r) => r.ws)));
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
    status: "completed", completedAt: new Date(), holdReason: null,
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
