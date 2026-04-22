/**
 * Email Verification router — powered by Reoon Email Verifier API
 * VER-001..VER-005 + Auto Re-Verify Scheduler + Health Snapshots + Trend
 */
import { z } from "zod";
import { and, desc, eq, gt, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import {
  contacts,
  emailVerificationJobs,
  emailVerificationSnapshots,
  workspaceSettings,
  workspaces,
} from "../../drizzle/schema";

const REOON_BASE = "https://emailverifier.reoon.com/api/v1";

/* ─── Reoon status → USIP badge mapping ─────────────────────────────────── */
export type VerificationStatus = "valid" | "accept_all" | "risky" | "invalid" | "unknown";

export function reoonStatusToUsip(reoonStatus: string): VerificationStatus {
  switch (reoonStatus) {
    case "safe":
      return "valid";
    case "catch_all":
      return "accept_all";
    case "role_account":
    case "disposable":
    case "inbox_full":
      return "risky";
    case "invalid":
    case "disabled":
    case "spamtrap":
      return "invalid";
    default:
      return "unknown";
  }
}

export const VERIFICATION_BADGE: Record<
  VerificationStatus,
  { label: string; color: string; bg: string }
> = {
  valid: { label: "Valid", color: "text-green-700", bg: "bg-green-100" },
  accept_all: { label: "Accept-All", color: "text-yellow-700", bg: "bg-yellow-100" },
  risky: { label: "Risky", color: "text-orange-700", bg: "bg-orange-100" },
  invalid: { label: "Invalid", color: "text-red-700", bg: "bg-red-100" },
  unknown: { label: "Unknown", color: "text-gray-500", bg: "bg-gray-100" },
};

/* ─── Reoon API helpers ─────────────────────────────────────────────────── */

async function reoonVerifySingle(email: string, apiKey: string) {
  const url = `${REOON_BASE}/verify?email=${encodeURIComponent(email)}&key=${apiKey}&mode=power`;
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`Reoon API error: ${res.status}`);
  return res.json() as Promise<{
    email: string;
    status: string;
    overall_score: number;
    is_safe_to_send: boolean;
    is_valid_syntax: boolean;
    is_disposable: boolean;
    is_role_account: boolean;
    is_catch_all: boolean;
    is_deliverable: boolean;
    mx_accepts_mail: boolean;
  }>;
}

async function reoonCreateBulkTask(emails: string[], apiKey: string) {
  const res = await fetch(`${REOON_BASE}/create-bulk-verification-task/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `USIP bulk ${Date.now()}`, emails, key: apiKey }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Reoon bulk create error: ${res.status}`);
  return res.json() as Promise<{
    status: string;
    task_id: number;
    count_submitted: number;
    count_duplicates_removed: number;
    count_processing: number;
  }>;
}

async function reoonGetBulkResult(taskId: string, apiKey: string) {
  const url = `${REOON_BASE}/get-result-bulk-verification-task/?key=${apiKey}&task_id=${taskId}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Reoon bulk result error: ${res.status}`);
  return res.json() as Promise<{
    task_id: string;
    status: string;
    count_total: number;
    count_checked: number;
    progress_percentage: number;
    results?: Record<
      string,
      { status: string; is_safe_to_send: boolean; is_deliverable: boolean }
    >;
  }>;
}

async function reoonCheckBalance(apiKey: string) {
  const url = `${REOON_BASE}/check-account-balance/?key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Reoon balance error: ${res.status}`);
  return res.json() as Promise<{
    api_status: string;
    remaining_daily_credits: number;
    remaining_instant_credits: number;
    status: string;
  }>;
}

function getApiKey(): string {
  const key = process.env.REOON_API_KEY;
  if (!key) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "REOON_API_KEY not configured." });
  return key;
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

/** Trigger re-verification of stale risky/accept_all contacts for a workspace */
export async function triggerScheduledReverify(workspaceId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const apiKey = process.env.REOON_API_KEY;
  if (!apiKey) return;

  const [settings] = await db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);

  if (!settings?.reverifyIntervalDays) return; // Disabled

  const intervalDays = settings.reverifyIntervalDays;
  const statuses = Array.isArray(settings.reverifyStatuses)
    ? (settings.reverifyStatuses as string[])
    : ["risky", "accept_all"];

  if (statuses.length === 0) return;

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
    );

  const emailRows = staleContacts.filter((r) => r.email);
  if (emailRows.length === 0) return;

  const emails = emailRows.map((r) => r.email as string);
  const task = await reoonCreateBulkTask(emails, apiKey);

  await db.insert(emailVerificationJobs).values({
    workspaceId,
    reoonTaskId: String(task.task_id),
    status: "running",
    totalEmails: task.count_processing,
    checkedEmails: 0,
    progressPct: "0",
    triggeredByUserId: null,
  });
}

/** Run daily maintenance for all workspaces with reverify enabled */
export async function runDailyVerificationMaintenance(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const allWorkspaces = await db
    .select({ id: workspaces.id })
    .from(workspaces);

  for (const ws of allWorkspaces) {
    try {
      await snapshotHealthMetrics(ws.id);
      await triggerScheduledReverify(ws.id);
    } catch (e) {
      console.error(`[VerifyMaintenance] workspace ${ws.id} error:`, e);
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
      const apiKey = getApiKey();

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

      const result = await reoonVerifySingle(contact.email, apiKey);
      const usipStatus = reoonStatusToUsip(result.status);

      await db
        .update(contacts)
        .set({
          emailVerificationStatus: usipStatus,
          emailVerifiedAt: new Date(),
          emailVerificationData: result,
        })
        .where(eq(contacts.id, input.contactId));

      return { status: usipStatus, badge: VERIFICATION_BADGE[usipStatus], raw: result };
    }),

  /** Start a bulk verification job for a list of contact IDs */
  verifyBulk: workspaceProcedure
    .input(
      z.object({
        contactIds: z.array(z.number()).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const apiKey = getApiKey();

      const rows = await db
        .select({ id: contacts.id, email: contacts.email })
        .from(contacts)
        .where(
          input.contactIds && input.contactIds.length > 0
            ? and(
                eq(contacts.workspaceId, ctx.workspace.id),
                inArray(contacts.id, input.contactIds),
              )
            : eq(contacts.workspaceId, ctx.workspace.id),
        );

      const emailRows = rows.filter((r) => r.email);
      if (emailRows.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No contacts with email addresses found." });
      }

      const emails = emailRows.map((r) => r.email as string);
      const task = await reoonCreateBulkTask(emails, apiKey);

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
    }),

  /** Poll a bulk verification job for progress and apply results when done */
  getBulkJobStatus: workspaceProcedure
    .input(z.object({ jobId: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const apiKey = getApiKey();

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
  getAccountBalance: workspaceProcedure.query(async () => {
    const apiKey = getApiKey();
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
  saveReverifySettings: workspaceProcedure
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

  /** Manually trigger a scheduled re-verify run for the workspace */
  triggerReverifyNow: workspaceProcedure.mutation(async ({ ctx }) => {
    await triggerScheduledReverify(ctx.workspace.id);
    return { ok: true };
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
