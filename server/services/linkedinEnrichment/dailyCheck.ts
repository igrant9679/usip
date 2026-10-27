/**
 * Daily LinkedIn change-check worker.
 *
 * For each prospect with active LinkedIn enrichment, re-retrieves the permitted
 * profile through Unipile (routed via the SAME bridged account, so the existing
 * per-account daily rate-limit applies), diffs it against the last snapshot,
 * and records meaningful field changes — which surface as the compact UI
 * indicators. Suppressed/rejected prospects and records checked within 24h are
 * skipped (unless an admin forces the run).
 *
 * Compliance: Unipile-only retrieval (no scraping); rate-limited; never
 * refreshes a suppressed prospect.
 */
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { utcDayStart } from "@shared/timeWindows";
import { archivedWorkspaceIds } from "../../_core/workspaceArchive";
import { getDb } from "../../db";
import {
  prospects,
  prospectLinkedinEnrichments,
  linkedinDailyCheckJobs,
  unipileAccounts,
} from "../../../drizzle/schema";
import { retrieveLinkedInProfileByUrl } from "./unipileProfile";
import { applyEnrichment, markUnavailable, enrichmentBlockReason } from "./enrichmentService";
import { LOOKUP_WAIT_MS, type LookupTurn } from "./lookupQueue";

const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;
/** Bound a single workspace run so a huge workspace can't run unbounded. */
const MAX_PER_RUN = 250;

export interface DailyCheckResult {
  jobId: number;
  workspaceId: number;
  checked: number;
  changed: number;
  failed: number;
  skipped: number;
}

/**
 * Today's job for a workspace: one row per UTC day, however many turns the
 * LinkedIn queue gives it, so the status card reads as one run.
 */
async function todaysJob(ws: number, trigger: "manual" | "scheduled") {
  const db = await getDb();
  if (!db) return null;
  const [today] = await db.select().from(linkedinDailyCheckJobs)
    .where(and(eq(linkedinDailyCheckJobs.workspaceId, ws), gte(linkedinDailyCheckJobs.createdAt, utcDayStart())))
    .orderBy(desc(linkedinDailyCheckJobs.id))
    .limit(1);
  if (today) return today;
  await db.insert(linkedinDailyCheckJobs).values({ workspaceId: ws, status: "pending", trigger, checkedCount: 0, changedCount: 0, failedCount: 0 } as never);
  const [created] = await db.select().from(linkedinDailyCheckJobs)
    .where(eq(linkedinDailyCheckJobs.workspaceId, ws))
    .orderBy(desc(linkedinDailyCheckJobs.id))
    .limit(1);
  return created ?? null;
}

/**
 * One turn of the daily check for one workspace: stale profiles, oldest
 * first, until today's budget (MAX_PER_RUN) is spent, the account limits hold
 * a lookup, or `deadline` passes.
 *
 * Audit 2026-10-20 (P6): this ran every profile back to back at 01:00. The
 * gate allows one lookup per ~90 s in working hours, so every lookup was
 * refused, and each refusal was recorded as "profile unavailable": up to 250
 * false alerts a night, and no job change ever found. Now the LinkedIn queue
 * (lookupQueue) gives each workspace a turn every few minutes, a hold parks
 * the day's job as "waiting" and resumes later, and only the vendor saying
 * the profile is gone ("not found") raises the unavailable alert.
 */
export async function runDailyCheckForWorkspace(opts: {
  workspaceId: number;
  force?: boolean;
  trigger?: "manual" | "scheduled";
  deadline?: number;
}): Promise<DailyCheckResult & LookupTurn> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const ws = opts.workspaceId;
  // An archived workspace is frozen (2026-08-12), whoever asks.
  const archivedWs = await archivedWorkspaceIds();
  if (archivedWs.has(ws)) {
    return { jobId: 0, workspaceId: ws, checked: 0, changed: 0, failed: 0, skipped: 0, looked: 0, held: null };
  }
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const job = await todaysJob(ws, opts.trigger ?? "scheduled");
  if (!job) throw new Error("Database unavailable");
  const jobId = job.id;

  let checked = job.checkedCount ?? 0, changed = job.changedCount ?? 0, failed = job.failedCount ?? 0, skipped = 0, looked = 0;
  const result = (held: string | null): DailyCheckResult & LookupTurn => ({ jobId, workspaceId: ws, checked, changed, failed, skipped, looked, held });
  const save = async (set: Record<string, unknown>) => {
    await db.update(linkedinDailyCheckJobs)
      .set({ checkedCount: checked, changedCount: changed, failedCount: failed, ...set } as never)
      .where(eq(linkedinDailyCheckJobs.id, jobId));
  };
  if (job.status === "completed" && !opts.force) return result(null);
  const budget = Math.max(0, MAX_PER_RUN - checked - failed);
  if (budget === 0) { await save({ status: "completed", completedAt: new Date(), holdReason: null }); return result(null); }
  await save({ status: "running", holdReason: null, startedAt: job.startedAt ?? new Date() });

  try {
    // Staleness and suppression decide the SET, not the loop.
    //
    // This read used to be `where workspaceId` + LIMIT 250 with no ORDER BY,
    // and both refusals below (checked within 24h, prospect rejected) were
    // applied in JS afterwards. So a job whose entire purpose is refreshing
    // the STALE records spent its budget on whichever 250 rows MySQL felt
    // like returning — overwhelmingly the fresh ones, since they are the
    // majority — and the stale rows behind that window were never reached.
    // The unordered page is what made it permanent: the same arbitrary 250
    // come back every run, so a record outside it is not "late", it is
    // unreachable.
    //
    // Oldest first, never-checked first (MySQL sorts NULL ahead in ASC), so
    // the budget lands on the rows with the most to tell us. Note the loop
    // still re-checks suppression: retrievals below are awaited, so minutes
    // pass and a prospect can be rejected mid-run — that is a genuine
    // time-of-check gap, not a duplicated filter.
    const staleBefore = new Date(Date.now() - TWENTY_FOUR_H);
    // getTableColumns, NOT a bare .select(): with a join, drizzle nests the
    // result by table name and every `enr.<field>` below would silently read
    // undefined. This keeps the row shape byte-identical to the pre-join one.
    const enrichments = await db
      .select(getTableColumns(prospectLinkedinEnrichments))
      .from(prospectLinkedinEnrichments)
      .innerJoin(prospects, and(
        eq(prospects.id, prospectLinkedinEnrichments.prospectId),
        eq(prospects.workspaceId, ws),
      ))
      .where(and(
        eq(prospectLinkedinEnrichments.workspaceId, ws),
        // enrichmentBlockReason(): rejected is the one suppression state.
        or(
          isNull(prospects.verificationStatus),
          ne(prospects.verificationStatus, "rejected"),
        ),
        ...(opts.force ? [] : [or(
          isNull(prospectLinkedinEnrichments.linkedinLastCheckedAt),
          lt(prospectLinkedinEnrichments.linkedinLastCheckedAt, staleBefore),
        )]),
      ))
      .orderBy(asc(prospectLinkedinEnrichments.linkedinLastCheckedAt))
      .limit(budget);

    // Map source account → owner user id so lookups route through the same
    // (rate-limited) bridged account they were enriched with.
    const accountIds = Array.from(new Set(enrichments.map((e) => e.linkedinSourceAccountId).filter(Boolean) as string[]));
    const ownerByAccount = new Map<string, number>();
    if (accountIds.length) {
      const accts = await db
        .select({ acct: unipileAccounts.unipileAccountId, owner: unipileAccounts.userId })
        .from(unipileAccounts)
        .where(and(eq(unipileAccounts.workspaceId, ws), inArray(unipileAccounts.unipileAccountId, accountIds)));
      for (const a of accts) ownerByAccount.set(a.acct, a.owner);
    }

    for (const enr of enrichments) {
      if (Date.now() >= deadline) {
        await save({ status: "waiting", holdReason: null });
        return result(null);
      }
      // Compliance: never refresh a suppressed/rejected prospect. Kept
      // despite the SQL predicate: every iteration awaits a network
      // retrieval, so a prospect can be rejected while this loop is running.
      const [p] = await db
        .select({ verificationStatus: prospects.verificationStatus })
        .from(prospects)
        .where(and(eq(prospects.workspaceId, ws), eq(prospects.id, enr.prospectId)));
      if (!p || enrichmentBlockReason(p)) { skipped++; continue; }

      const ownerUserId = enr.linkedinSourceAccountId ? ownerByAccount.get(enr.linkedinSourceAccountId) ?? 0 : 0;
      const retrieve = await retrieveLinkedInProfileByUrl({
        workspaceId: ws,
        userId: ownerUserId,
        isAdmin: true, // pool-wide so requestedAccountId resolves
        linkedinUrl: enr.linkedinProfileUrl,
        requestedAccountId: enr.linkedinSourceAccountId ?? undefined,
        waitMs: LOOKUP_WAIT_MS,
        feature: "linkedinDailyCheck",
      });

      // Held by the account limits: nothing was looked up, nothing is known
      // about this profile. Park the day's job; the queue resumes it.
      if (retrieve.status === "rate_limited") {
        await save({ status: "waiting", holdReason: retrieve.message.slice(0, 300) });
        return result(retrieve.message);
      }
      looked++;

      if (!retrieve.ok || !retrieve.profile) {
        // Only the vendor saying the profile is gone is an alert; a vendor
        // error is a failed check, tried again tomorrow.
        if (retrieve.status === "no_match") {
          await markUnavailable({ workspaceId: ws, prospectId: enr.prospectId, enrichmentId: enr.id, reason: retrieve.message });
        } else {
          // Checked today, without an answer: tomorrow's turn tries again. Left
          // unstamped, every turn today would look it up again.
          await db.update(prospectLinkedinEnrichments)
            .set({ linkedinLastCheckedAt: new Date() })
            .where(and(eq(prospectLinkedinEnrichments.workspaceId, ws), eq(prospectLinkedinEnrichments.id, enr.id)));
        }
        failed++;
        await save({});
        continue;
      }

      const applied = await applyEnrichment({
        workspaceId: ws,
        prospectId: enr.prospectId,
        profile: retrieve.profile,
        matchStatus: enr.linkedinMatchStatus,
        sourceAccountId: retrieve.viaAccountId ?? enr.linkedinSourceAccountId,
        imageAllowed: !!retrieve.profile.profileImageUrl,
      });
      checked++;
      if (applied.changes.length > 0) changed++;
      await save({});
    }

    await save({ status: "completed", completedAt: new Date(), holdReason: null });
  } catch (e) {
    await save({ status: "failed", completedAt: new Date() });
    console.error(`[linkedinDailyCheck] workspace ${ws} failed:`, (e as Error).message);
  }

  return result(null);
}

/** The LinkedIn queue's turn for this workspace's change check. */
export async function dailyCheckTurn(ws: number, deadline: number): Promise<LookupTurn> {
  const r = await runDailyCheckForWorkspace({ workspaceId: ws, trigger: "scheduled", deadline });
  return { looked: r.looked, held: r.held };
}

/** Workspaces with enriched profiles whose check for today is not finished. */
export async function workspacesWithDailyCheckDue(): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const withProfiles = Array.from(new Set((await db
    .select({ ws: prospectLinkedinEnrichments.workspaceId })
    .from(prospectLinkedinEnrichments)).map((r) => r.ws)));
  if (withProfiles.length === 0) return [];
  const doneToday = new Set((await db
    .select({ ws: linkedinDailyCheckJobs.workspaceId })
    .from(linkedinDailyCheckJobs)
    .where(and(gte(linkedinDailyCheckJobs.createdAt, utcDayStart()), eq(linkedinDailyCheckJobs.status, "completed")))).map((r) => r.ws));
  return withProfiles.filter((ws) => !doneToday.has(ws));
}

/** How many profiles the next turn would check (the "Run now" confirmation, audit P157). */
export async function dailyCheckDue(ws: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const staleBefore = new Date(Date.now() - TWENTY_FOUR_H);
  const rows = await db
    .select({ id: prospectLinkedinEnrichments.id })
    .from(prospectLinkedinEnrichments)
    .innerJoin(prospects, and(eq(prospects.id, prospectLinkedinEnrichments.prospectId), eq(prospects.workspaceId, ws)))
    .where(and(
      eq(prospectLinkedinEnrichments.workspaceId, ws),
      or(isNull(prospects.verificationStatus), ne(prospects.verificationStatus, "rejected")),
      or(isNull(prospectLinkedinEnrichments.linkedinLastCheckedAt), lt(prospectLinkedinEnrichments.linkedinLastCheckedAt, staleBefore)),
    ));
  return Math.min(rows.length, MAX_PER_RUN);
}

/**
 * Scheduler entry point, kept for callers: the change check now runs as part
 * of the LinkedIn queue (lookupQueue.drainLinkedInLookups), in working hours,
 * at the pace the account limits allow.
 */
export async function runDailyCheckAllWorkspaces(): Promise<void> {
  const { drainLinkedInLookups } = await import("./lookupQueue");
  await drainLinkedInLookups();
}

/** Last daily-check job for a workspace (status card). */
export async function getLastDailyCheck(workspaceId: number) {
  const db = await getDb();
  if (!db) return null;
  const [latest] = await db
    .select()
    .from(linkedinDailyCheckJobs)
    .where(eq(linkedinDailyCheckJobs.workspaceId, workspaceId))
    .orderBy(desc(linkedinDailyCheckJobs.id))
    .limit(1);
  return latest ?? null;
}
