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
import { archivedWorkspaceIds } from "../../_core/workspaceArchive";
import { and, asc, desc, eq, getTableColumns, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { getDb } from "../../db";
import {
  prospects,
  prospectLinkedinEnrichments,
  linkedinDailyCheckJobs,
  unipileAccounts,
} from "../../../drizzle/schema";
import { retrieveLinkedInProfileByUrl } from "./unipileProfile";
import { applyEnrichment, markUnavailable, enrichmentBlockReason } from "./enrichmentService";

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

/** Run the daily check for one workspace. */
export async function runDailyCheckForWorkspace(opts: {
  workspaceId: number;
  force?: boolean;
  trigger?: "manual" | "scheduled";
}): Promise<DailyCheckResult> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const ws = opts.workspaceId;

  const jobRes = await db.insert(linkedinDailyCheckJobs).values({
    workspaceId: ws,
    status: "running",
    trigger: opts.trigger ?? "scheduled",
    startedAt: new Date(),
  } as never);
  const jobId = Number((jobRes as { insertId?: number }[])[0]?.insertId ?? 0);

  let checked = 0, changed = 0, failed = 0, skipped = 0;

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
      .limit(MAX_PER_RUN);

    // Map source account → owner user id so lookups route through the same
    // (rate-limited) bridged account they were enriched with.
    const accountIds = [...new Set(enrichments.map((e) => e.linkedinSourceAccountId).filter(Boolean) as string[])];
    const ownerByAccount = new Map<string, number>();
    if (accountIds.length) {
      const accts = await db
        .select({ acct: unipileAccounts.unipileAccountId, owner: unipileAccounts.userId })
        .from(unipileAccounts)
        .where(and(eq(unipileAccounts.workspaceId, ws), inArray(unipileAccounts.unipileAccountId, accountIds)));
      for (const a of accts) ownerByAccount.set(a.acct, a.owner);
    }

    for (const enr of enrichments) {
      // No staleness check here any more — the query above owns it. A refusal
      // that can never fire reads, on the next visit, like the filter is
      // still being applied somewhere it is not.

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
      });

      if (!retrieve.ok || !retrieve.profile) {
        await markUnavailable({ workspaceId: ws, prospectId: enr.prospectId, enrichmentId: enr.id, reason: retrieve.message });
        failed++;
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
    }

    await db
      .update(linkedinDailyCheckJobs)
      .set({ status: "completed", checkedCount: checked, changedCount: changed, failedCount: failed, completedAt: new Date() })
      .where(eq(linkedinDailyCheckJobs.id, jobId));
  } catch (e) {
    await db
      .update(linkedinDailyCheckJobs)
      .set({ status: "failed", checkedCount: checked, changedCount: changed, failedCount: failed, completedAt: new Date() })
      .where(eq(linkedinDailyCheckJobs.id, jobId));
    console.error(`[linkedinDailyCheck] workspace ${ws} failed:`, (e as Error).message);
  }

  return { jobId, workspaceId: ws, checked, changed, failed, skipped };
}

/**
 * Scheduler entry point: run the daily check across every workspace that has
 * LinkedIn enrichments, staggered to stay clear of vendor rate limits.
 */
export async function runDailyCheckAllWorkspaces(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const rows = await db
    .selectDistinct({ ws: prospectLinkedinEnrichments.workspaceId })
    .from(prospectLinkedinEnrichments);
  const workspaceIds = rows.map((r) => r.ws);
  console.log(`[linkedinDailyCheck] starting for ${workspaceIds.length} workspace(s)`);
    const archivedWs = await archivedWorkspaceIds();
  for (const ws of workspaceIds) {
    if (archivedWs.has(ws)) continue; // archived workspaces are frozen (2026-08-12)
    try {
      const r = await runDailyCheckForWorkspace({ workspaceId: ws, trigger: "scheduled" });
      console.log(`[linkedinDailyCheck] ws ${ws}: checked=${r.checked} changed=${r.changed} failed=${r.failed} skipped=${r.skipped}`);
    } catch (e) {
      console.error(`[linkedinDailyCheck] ws ${ws} threw:`, (e as Error).message);
    }
    // Stagger workspaces to avoid bursting the vendor.
    await new Promise((res) => setTimeout(res, 2000));
  }
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
