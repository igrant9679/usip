/**
 * Email Verification router — powered by Reoon Email Verifier API
 * VER-001..VER-005 + Auto Re-Verify Scheduler + Health Snapshots + Trend
 */
import { z } from "zod";
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { adminWsProcedure, roleRank, workspaceProcedure } from "../_core/workspace";
import { BULK_VERIFY_MAX, VERIFY_JOB_STALE_MS } from "@shared/verificationLimits";
import { keySourceOf, sharedKeyPolicy, sharedUsedToday } from "../services/spend";
import { getDb } from "../db";
import {
  contacts,
  emailVerificationJobs,
  emailVerificationSnapshots,
  workspaceSettings,
  workspaces,
} from "../../drizzle/schema";
import {
  reoonVerifySingle,
  reoonCreateBulkTask,
  reoonGetBulkResult,
  reoonCheckBalance,
  reoonStatusToUsip,
  VERIFICATION_BADGE,
  getReoonKey,
  type VerificationStatus,
} from "../services/reoon";

// Re-export for back-compat — existing callers import these from this module.
export { reoonStatusToUsip, VERIFICATION_BADGE };
export type { VerificationStatus };

/**
 * The workspace's Reoon key, or a clear precondition failure.
 *
 * Goes through getReoonKey so a key pasted into Settings works here too —
 * before migration 0131 this read the env var directly, which would have made
 * the new Settings field look configured while every verification screen still
 * reported "not configured".
 */
async function getApiKey(workspaceId: number): Promise<string> {
  const key = await getReoonKey(workspaceId);
  if (!key) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "No Reoon API key configured. Add one in Settings → Data sources.",
    });
  }
  return key;
}

/* ─── Spend guards (audit 2026-10-20, P10) ───────────────────────────────── */

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** The workspace's verification job still in flight, if any: one at a time. */
async function runningJobFor(db: Db, workspaceId: number) {
  const [job] = await db
    .select({ id: emailVerificationJobs.id, totalEmails: emailVerificationJobs.totalEmails, progressPct: emailVerificationJobs.progressPct })
    .from(emailVerificationJobs)
    .where(
      and(
        eq(emailVerificationJobs.workspaceId, workspaceId),
        eq(emailVerificationJobs.status, "running"),
        gt(emailVerificationJobs.createdAt, new Date(Date.now() - VERIFY_JOB_STALE_MS)),
      ),
    )
    .limit(1);
  return job ?? null;
}

/** Workspaces between "no job running" and the job row existing (two clicks, or a click and the cron). */
const jobStarting = new Set<number>();

/**
 * How many more addresses the shared key's daily cap allows this workspace,
 * or Infinity when it is on its own key or no cap is set.
 */
async function sharedHeadroom(workspaceId: number, apiKey: string): Promise<number> {
  if (keySourceOf(apiKey, process.env.REOON_API_KEY) !== "shared") return Infinity;
  const policy = await sharedKeyPolicy(workspaceId, "reoon");
  if (policy.dailyCap === null) return Infinity;
  return Math.max(0, policy.dailyCap - (await sharedUsedToday(workspaceId, "reoon")));
}

/** One address once, whatever case it was stored in. */
function uniqueEmails(rows: Array<{ email: string | null }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const e = (r.email ?? "").trim();
    if (!e || seen.has(e.toLowerCase())) continue;
    seen.add(e.toLowerCase());
    out.push(e);
  }
  return out;
}

/* ─── Scheduler helpers (called server-side, not via tRPC) ──────────────── */

/** Take a daily snapshot of email verification health for a workspace */
export async function snapshotHealthMetrics(workspaceId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Check if snapshot already exists for today
  const [existing] = await db
    .select({ id: emailVerificationSnapshots.id })
    .from(emailVerificationSnapshots)
    .where(
      and(
        eq(emailVerificationSnapshots.workspaceId, workspaceId),
        sql`DATE(${emailVerificationSnapshots.snapshotDate}) = ${today}`,
      ),
    )
    .limit(1);

  if (existing) return; // Already snapshotted today

  // Count contacts by status
  const rows = await db
    .select({ status: contacts.emailVerificationStatus })
    .from(contacts)
    .where(eq(contacts.workspaceId, workspaceId));

  const counts = { valid: 0, accept_all: 0, risky: 0, invalid: 0, unknown: 0 };
  for (const r of rows) {
    const s = (r.status ?? "unknown") as VerificationStatus;
    if (s in counts) counts[s]++;
    else counts.unknown++;
  }
  const total = rows.length;

  await db.insert(emailVerificationSnapshots).values({
    workspaceId,
    snapshotDate: today as unknown as Date,
    valid: counts.valid,
    acceptAll: counts.accept_all,
    risky: counts.risky,
    invalid: counts.invalid,
    unknown: counts.unknown,
    total,
  });
}

/**
 * Trigger re-verification of stale risky/accept_all contacts for a workspace.
 *
 * Bounded (audit P10): at most BULK_VERIFY_MAX addresses, the longest-unchecked
 * first, never while another job runs, and within the shared key's daily cap.
 * Says what it did, so "Run Now" can too.
 */
export async function triggerScheduledReverify(
  workspaceId: number,
  triggeredByUserId: number | null = null,
): Promise<{ started: boolean; emails: number; reason?: string }> {
  const db = await getDb();
  if (!db) return { started: false, emails: 0, reason: "no database" };

  const apiKey = await getReoonKey(workspaceId);
  if (!apiKey) return { started: false, emails: 0, reason: "no Reoon key for this workspace" };

  const [settings] = await db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);

  if (!settings?.reverifyIntervalDays) return { started: false, emails: 0, reason: "the re-verify schedule is off" };

  const intervalDays = settings.reverifyIntervalDays;
  const statuses = Array.isArray(settings.reverifyStatuses)
    ? (settings.reverifyStatuses as string[])
    : ["risky", "accept_all"];

  if (statuses.length === 0) return { started: false, emails: 0, reason: "no statuses are selected for re-verify" };
  if (jobStarting.has(workspaceId) || (await runningJobFor(db, workspaceId))) {
    return { started: false, emails: 0, reason: "a verification job is already running" };
  }

  // Cutoff: contacts verified more than N days ago (or never verified)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - intervalDays);

  const staleContacts = await db
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(
      and(
        eq(contacts.workspaceId, workspaceId),
        isNotNull(contacts.email),
        inArray(contacts.emailVerificationStatus, statuses),
        or(
          lt(contacts.emailVerifiedAt, cutoff),
          sql`${contacts.emailVerifiedAt} IS NULL`,
        ),
      ),
    )
    .orderBy(asc(contacts.emailVerifiedAt))
    .limit(BULK_VERIFY_MAX);

  const headroom = await sharedHeadroom(workspaceId, apiKey);
  const emails = uniqueEmails(staleContacts).slice(0, Math.min(BULK_VERIFY_MAX, headroom));
  if (emails.length === 0) {
    return { started: false, emails: 0, reason: headroom === 0 ? "the shared Reoon key's daily cap is used up" : "no contacts are due for re-verify" };
  }

  jobStarting.add(workspaceId);
  try {
    const task = await reoonCreateBulkTask(emails, apiKey, { workspaceId, feature: "emailVerification.reverify" });
    await db.insert(emailVerificationJobs).values({
      workspaceId,
      reoonTaskId: String(task.task_id),
      status: "running",
      totalEmails: task.count_processing,
      checkedEmails: 0,
      progressPct: "0",
      triggeredByUserId,
    });
    return { started: true, emails: Number(task.count_processing ?? emails.length) };
  } finally {
    jobStarting.delete(workspaceId);
  }
}

/** Run daily maintenance for all workspaces with reverify enabled */
export async function runDailyVerificationMaintenance(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const allWorkspaces = await db
    .select({ id: workspaces.id, archivedAt: workspaces.archivedAt })
    .from(workspaces);

  for (const ws of allWorkspaces) {
    try {
      await snapshotHealthMetrics(ws.id);
      // An archived workspace is frozen: its schedule spends nothing (P10).
      if (!ws.archivedAt) await triggerScheduledReverify(ws.id);
    } catch (e) {
      console.error(`[VerifyMaintenance] workspace ${ws.id} error:`, e);
    }
  }
}

/**
 * Server-driven advance of in-flight Reoon bulk verification jobs.
 *
 * getBulkJobStatus only progresses a job when the CLIENT polls it — so if
 * the SDR closes the tab after kicking off a 10k bulk verify, the Reoon
 * task completes server-side but the results are never written back to
 * `contacts`. This cron does the same write-back without the client:
 * find every `status='running'` job, ask Reoon for results, apply to the
 * job's workspace contacts, mark completed. Bounded per tick; per-job
 * try/catch so one stuck job can't block the rest.
 */
export async function advanceRunningVerificationJobs(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const running = await db
    .select()
    .from(emailVerificationJobs)
    .where(eq(emailVerificationJobs.status, "running"))
    .limit(25);

  for (const job of running) {
    if (!job.reoonTaskId) continue;
    try {
      // Per-JOB key: this cron spans workspaces, and since 0131 each one can
      // hold its own Reoon credential. A single process-wide key would poll
      // workspace A's task with workspace B's account.
      const apiKey = await getReoonKey(job.workspaceId);
      if (!apiKey) continue;
      const result = await reoonGetBulkResult(job.reoonTaskId, apiKey);
      const progressPct = result.progress_percentage ?? 0;
      const isCompleted = result.status === "completed";

      if (isCompleted && result.results) {
        for (const [email, data] of Object.entries(result.results)) {
          const usipStatus = reoonStatusToUsip(data.status);
          await db
            .update(contacts)
            .set({
              emailVerificationStatus: usipStatus,
              emailVerifiedAt: new Date(),
              emailVerificationData: data,
            })
            .where(
              and(
                eq(contacts.workspaceId, job.workspaceId),
                eq(contacts.email, email),
              ),
            );
        }
        await db
          .update(emailVerificationJobs)
          .set({
            status: "completed",
            checkedEmails: result.count_checked,
            progressPct: String(progressPct),
            completedAt: new Date(),
          })
          .where(eq(emailVerificationJobs.id, job.id));
      } else {
        await db
          .update(emailVerificationJobs)
          .set({ checkedEmails: result.count_checked, progressPct: String(progressPct) })
          .where(eq(emailVerificationJobs.id, job.id));
      }
    } catch (e) {
      console.error(`[VerifyJobs] job ${job.id} advance failed:`, e);
    }
  }
}

/* ─── Router ────────────────────────────────────────────────────────────── */

export const emailVerificationRouter = router({
  /** Verify a single email address (power mode) and store result on contact */
  verifySingle: workspaceProcedure
    .input(z.object({ contactId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const apiKey = await getApiKey(ctx.workspace.id);

      const [contact] = await db
        .select({ id: contacts.id, email: contacts.email, workspaceId: contacts.workspaceId })
        .from(contacts)
        .where(
          and(
            eq(contacts.id, input.contactId),
            eq(contacts.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);

      if (!contact) throw new TRPCError({ code: "NOT_FOUND" });
      if (!contact.email) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Contact has no email address." });
      }

      const result = await reoonVerifySingle(contact.email, apiKey, "power", { workspaceId: ctx.workspace.id, feature: "emailVerification.verifySingle" });
      const usipStatus = reoonStatusToUsip(result.status);

      await db
        .update(contacts)
        .set({
          emailVerificationStatus: usipStatus,
          emailVerifiedAt: new Date(),
          emailVerificationData: result,
        })
        .where(and(eq(contacts.id, input.contactId), eq(contacts.workspaceId, ctx.workspace.id)));

      return { status: usipStatus, badge: VERIFICATION_BADGE[usipStatus], raw: result };
    }),

  /**
   * Start a bulk verification job.
   *
   * Audit P10: with no ids this verified EVERY contact in the workspace, for
   * any member, on every click. Now: selected ids (up to BULK_VERIFY_MAX) for
   * anyone; the whole workspace only for admins, and then the
   * BULK_VERIFY_MAX longest-unchecked addresses; one job at a time; and never
   * past the shared Reoon key's daily cap for this workspace.
   */
  verifyBulk: workspaceProcedure
    .input(
      z.object({
        contactIds: z.array(z.number()).max(BULK_VERIFY_MAX, `Select at most ${BULK_VERIFY_MAX.toLocaleString()} contacts per verification job.`).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const wholeWorkspace = !input.contactIds || input.contactIds.length === 0;
      if (wholeWorkspace && roleRank(ctx.member.role) < roleRank("admin")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Select the contacts to verify. Only admins can verify the whole workspace." });
      }
      const apiKey = await getApiKey(ctx.workspace.id);
      const running = await runningJobFor(db, ctx.workspace.id);
      if (running || jobStarting.has(ctx.workspace.id)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: running
            ? `A verification job is already running (${running.totalEmails.toLocaleString()} addresses, ${Math.round(Number(running.progressPct ?? 0))}% done). Start the next one when it finishes.`
            : "A verification job is starting. Try again in a moment.",
        });
      }

      const rows = wholeWorkspace
        ? await db
            .select({ id: contacts.id, email: contacts.email })
            .from(contacts)
            .where(and(eq(contacts.workspaceId, ctx.workspace.id), isNotNull(contacts.email)))
            .orderBy(asc(contacts.emailVerifiedAt))
            .limit(BULK_VERIFY_MAX)
        : await db
            .select({ id: contacts.id, email: contacts.email })
            .from(contacts)
            .where(and(eq(contacts.workspaceId, ctx.workspace.id), inArray(contacts.id, input.contactIds!)));

      const emails = uniqueEmails(rows);
      if (emails.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No contacts with email addresses found." });
      }
      const headroom = await sharedHeadroom(ctx.workspace.id, apiKey);
      if (emails.length > headroom) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: headroom === 0
            ? "This workspace has used today's allowance on the shared Reoon key."
            : `Today's allowance on the shared Reoon key has room for ${headroom.toLocaleString()} more addresses; this job has ${emails.length.toLocaleString()}. Select fewer, or try again tomorrow.`,
        });
      }

      jobStarting.add(ctx.workspace.id);
      try {
        const task = await reoonCreateBulkTask(emails, apiKey, { workspaceId: ctx.workspace.id, feature: "emailVerification.verifyBulk" });

        const [job] = await db
          .insert(emailVerificationJobs)
          .values({
            workspaceId: ctx.workspace.id,
            reoonTaskId: String(task.task_id),
            status: "running",
            totalEmails: task.count_processing,
            checkedEmails: 0,
            progressPct: "0",
            triggeredByUserId: ctx.user.id,
          })
          .$returningId();

        return { jobId: job.id, reoonTaskId: task.task_id, totalEmails: task.count_processing };
      } finally {
        jobStarting.delete(ctx.workspace.id);
      }
    }),

  /** Poll a bulk verification job for progress and apply results when done */
  getBulkJobStatus: workspaceProcedure
    .input(z.object({ jobId: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const apiKey = await getApiKey(ctx.workspace.id);

      const [job] = await db
        .select()
        .from(emailVerificationJobs)
        .where(
          and(
            eq(emailVerificationJobs.id, input.jobId),
            eq(emailVerificationJobs.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);

      if (!job) throw new TRPCError({ code: "NOT_FOUND" });
      if (!job.reoonTaskId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      if (job.status === "completed" || job.status === "failed") {
        return {
          jobId: job.id,
          status: job.status,
          progressPct: Number(job.progressPct),
          totalEmails: job.totalEmails,
          checkedEmails: job.checkedEmails,
        };
      }

      const result = await reoonGetBulkResult(job.reoonTaskId, apiKey);
      const progressPct = result.progress_percentage ?? 0;
      const isCompleted = result.status === "completed";

      if (isCompleted && result.results) {
        for (const [email, data] of Object.entries(result.results)) {
          const usipStatus = reoonStatusToUsip(data.status);
          await db
            .update(contacts)
            .set({
              emailVerificationStatus: usipStatus,
              emailVerifiedAt: new Date(),
              emailVerificationData: data,
            })
            .where(
              and(
                eq(contacts.workspaceId, ctx.workspace.id),
                eq(contacts.email, email),
              ),
            );
        }

        await db
          .update(emailVerificationJobs)
          .set({
            status: "completed",
            checkedEmails: result.count_checked,
            progressPct: String(progressPct),
            completedAt: new Date(),
          })
          .where(eq(emailVerificationJobs.id, job.id));
      } else {
        await db
          .update(emailVerificationJobs)
          .set({
            checkedEmails: result.count_checked,
            progressPct: String(progressPct),
          })
          .where(eq(emailVerificationJobs.id, job.id));
      }

      return {
        jobId: job.id,
        status: isCompleted ? "completed" : "running",
        progressPct,
        totalEmails: result.count_total,
        checkedEmails: result.count_checked,
      };
    }),

  /** Check Reoon account balance */
  getAccountBalance: workspaceProcedure.query(async ({ ctx }) => {
    const apiKey = await getApiKey(ctx.workspace.id);
    const balance = await reoonCheckBalance(apiKey);
    return balance;
  }),

  /** Get auto re-verify settings for the workspace */
  getReverifySettings: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [settings] = await db
      .select({
        reverifyIntervalDays: workspaceSettings.reverifyIntervalDays,
        reverifyStatuses: workspaceSettings.reverifyStatuses,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
      .limit(1);
    return {
      reverifyIntervalDays: settings?.reverifyIntervalDays ?? null,
      reverifyStatuses: Array.isArray(settings?.reverifyStatuses)
        ? (settings.reverifyStatuses as string[])
        : ["risky", "accept_all"],
    };
  }),

  /** Save auto re-verify settings */
  /** Admin-gated: sets a workspace-wide schedule that spends Reoon credits. */
  saveReverifySettings: adminWsProcedure
    .input(
      z.object({
        reverifyIntervalDays: z.number().nullable(), // null = disabled
        reverifyStatuses: z.array(z.string()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(workspaceSettings)
        .set({
          reverifyIntervalDays: input.reverifyIntervalDays,
          reverifyStatuses: input.reverifyStatuses,
        })
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      return { ok: true };
    }),

  /**
   * Manually trigger a scheduled re-verify run for the workspace. Admin-only,
   * like the schedule it runs (P10: any member could start a workspace-wide
   * paid job), and it says what it did instead of always "ok".
   */
  triggerReverifyNow: adminWsProcedure.mutation(async ({ ctx }) => {
    return triggerScheduledReverify(ctx.workspace.id, ctx.user.id);
  }),

  /** Get historical trend data for the Email Health widget */
  getHealthTrend: workspaceProcedure
    .input(z.object({ period: z.enum(["30", "60", "90", "120"]) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const periodDays = Number(input.period);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - periodDays);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      const rows = await db
        .select()
        .from(emailVerificationSnapshots)
        .where(
          and(
            eq(emailVerificationSnapshots.workspaceId, ctx.workspace.id),
            gt(emailVerificationSnapshots.snapshotDate, cutoffStr as unknown as Date),
          ),
        )
        .orderBy(emailVerificationSnapshots.snapshotDate);

      return rows.map((r) => ({
        date: String(r.snapshotDate).slice(0, 10),
        valid: r.valid,
        acceptAll: r.acceptAll,
        risky: r.risky,
        invalid: r.invalid,
        unknown: r.unknown,
        total: r.total,
      }));
    }),

  /** Take an immediate health snapshot for the current workspace */
  snapshotNow: workspaceProcedure.mutation(async ({ ctx }) => {
    await snapshotHealthMetrics(ctx.workspace.id);
    return { ok: true };
  }),
});
