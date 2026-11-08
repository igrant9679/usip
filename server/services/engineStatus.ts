/**
 * The admin engine status page's data (audit 2026-10-20, F49): each engine's
 * last tick and failures, each queue's depth and failures, the browser errors
 * reported, and the slow queries sampled, so a problem shows here before a
 * customer reports it.
 *
 * Nothing new is recorded for it. Ticks come from guardOverlap, which every
 * guarded engine already runs through (_core/cronGuard.ts, this process since
 * its last start); queues are counted from the rows the engines already keep,
 * in the caller's workspace only; client errors from client_errors (this
 * workspace); slow queries from _core/slowQuery.ts.
 */
import { and, count, desc, eq, gte, isNotNull, lt, lte } from "drizzle-orm";
import { areExecutionQueue, bulkJobs, clientErrors, emailDrafts, enrollments, linkedinEnrichmentBatchRows } from "../../drizzle/schema";
import { engineRunStatuses } from "../_core/cronGuard";
import { slowQueryStats } from "../_core/slowQuery";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface QueueStatus {
  key: string;
  label: string;
  /** What drains it, in words. */
  drainedBy: string;
  waiting: number;
  /** Waiting and already due (null where the queue has no due time). */
  dueNow: number | null;
  /** Claimed or running but not finished within the stated time (null where not tracked). */
  stuck: number | null;
  failed24h: number | null;
  /** The oldest item still due, so a stalled queue is visible even when small. */
  oldestDueAt: Date | null;
}

const HOUR = 3_600_000;

async function n(q: Promise<Array<{ n: number | string }>>): Promise<number> {
  const [r] = await q;
  return Number(r?.n ?? 0);
}

export async function workspaceQueues(db: Db, workspaceId: number, now: Date = new Date()): Promise<QueueStatus[]> {
  const dayAgo = new Date(now.getTime() - 24 * HOUR);
  const stuckSend = new Date(now.getTime() - 15 * 60_000);
  const stuckJob = new Date(now.getTime() - 10 * 60_000);

  const draftsWs = eq(emailDrafts.workspaceId, workspaceId);
  const [draftWaiting, draftStuck, draftFailed, oldestDraft] = await Promise.all([
    n(db.select({ n: count() }).from(emailDrafts).where(and(draftsWs, eq(emailDrafts.status, "approved")))),
    n(db.select({ n: count() }).from(emailDrafts).where(and(draftsWs, eq(emailDrafts.status, "sending"), lt(emailDrafts.sendClaimedAt, stuckSend)))),
    n(db.select({ n: count() }).from(emailDrafts).where(and(draftsWs, eq(emailDrafts.status, "failed"), gte(emailDrafts.sendClaimedAt, dayAgo)))),
    db.select({ at: emailDrafts.createdAt }).from(emailDrafts).where(and(draftsWs, eq(emailDrafts.status, "approved"))).orderBy(emailDrafts.createdAt).limit(1),
  ]);

  const enrWs = eq(enrollments.workspaceId, workspaceId);
  const [enrActive, enrDue, oldestEnr] = await Promise.all([
    n(db.select({ n: count() }).from(enrollments).where(and(enrWs, eq(enrollments.status, "active")))),
    n(db.select({ n: count() }).from(enrollments).where(and(enrWs, eq(enrollments.status, "active"), lte(enrollments.nextActionAt, now)))),
    db.select({ at: enrollments.nextActionAt }).from(enrollments).where(and(enrWs, eq(enrollments.status, "active"), lte(enrollments.nextActionAt, now))).orderBy(enrollments.nextActionAt).limit(1),
  ]);

  const areWs = eq(areExecutionQueue.workspaceId, workspaceId);
  const [areWaiting, areDue, areFailed, oldestAre] = await Promise.all([
    n(db.select({ n: count() }).from(areExecutionQueue).where(and(areWs, eq(areExecutionQueue.status, "scheduled")))),
    n(db.select({ n: count() }).from(areExecutionQueue).where(and(areWs, eq(areExecutionQueue.status, "scheduled"), lte(areExecutionQueue.scheduledAt, now)))),
    n(db.select({ n: count() }).from(areExecutionQueue).where(and(areWs, eq(areExecutionQueue.status, "failed"), gte(areExecutionQueue.executedAt, dayAgo)))),
    db.select({ at: areExecutionQueue.scheduledAt }).from(areExecutionQueue).where(and(areWs, eq(areExecutionQueue.status, "scheduled"), lte(areExecutionQueue.scheduledAt, now))).orderBy(areExecutionQueue.scheduledAt).limit(1),
  ]);

  const jobWs = eq(bulkJobs.workspaceId, workspaceId);
  const [jobQueued, jobStuck, jobFailed, oldestJob] = await Promise.all([
    n(db.select({ n: count() }).from(bulkJobs).where(and(jobWs, eq(bulkJobs.status, "queued")))),
    n(db.select({ n: count() }).from(bulkJobs).where(and(jobWs, eq(bulkJobs.status, "running"), lt(bulkJobs.heartbeatAt, stuckJob)))),
    n(db.select({ n: count() }).from(bulkJobs).where(and(jobWs, eq(bulkJobs.status, "failed"), gte(bulkJobs.finishedAt, dayAgo)))),
    db.select({ at: bulkJobs.createdAt }).from(bulkJobs).where(and(jobWs, eq(bulkJobs.status, "queued"))).orderBy(bulkJobs.createdAt).limit(1),
  ]);

  const liWs = eq(linkedinEnrichmentBatchRows.workspaceId, workspaceId);
  const [liPending, liFailed, oldestLi] = await Promise.all([
    n(db.select({ n: count() }).from(linkedinEnrichmentBatchRows).where(and(liWs, eq(linkedinEnrichmentBatchRows.rowStatus, "pending")))),
    n(db.select({ n: count() }).from(linkedinEnrichmentBatchRows).where(and(liWs, eq(linkedinEnrichmentBatchRows.rowStatus, "failed"), gte(linkedinEnrichmentBatchRows.updatedAt, dayAgo)))),
    db.select({ at: linkedinEnrichmentBatchRows.createdAt }).from(linkedinEnrichmentBatchRows).where(and(liWs, eq(linkedinEnrichmentBatchRows.rowStatus, "pending"))).orderBy(linkedinEnrichmentBatchRows.createdAt).limit(1),
  ]);

  return [
    { key: "email_drafts", label: "Approved emails waiting to send", drainedBy: "the sequence engine and Send approved", waiting: draftWaiting, dueNow: null, stuck: draftStuck, failed24h: draftFailed, oldestDueAt: oldestDraft[0]?.at ?? null },
    { key: "enrollments", label: "Sequence enrolments", drainedBy: "the sequence engine (every 5 minutes)", waiting: enrActive, dueNow: enrDue, stuck: null, failed24h: null, oldestDueAt: oldestEnr[0]?.at ?? null },
    { key: "are_execution_queue", label: "Revenue Engine steps", drainedBy: "the Revenue Engine tick", waiting: areWaiting, dueNow: areDue, stuck: null, failed24h: areFailed, oldestDueAt: oldestAre[0]?.at ?? null },
    { key: "bulk_jobs", label: "Background jobs", drainedBy: "the job runner", waiting: jobQueued, dueNow: null, stuck: jobStuck, failed24h: jobFailed, oldestDueAt: oldestJob[0]?.at ?? null },
    { key: "linkedin_lookups", label: "LinkedIn lookups", drainedBy: "the LinkedIn lookup queue (every 10 minutes)", waiting: liPending, dueNow: null, stuck: null, failed24h: liFailed, oldestDueAt: oldestLi[0]?.at ?? null },
  ];
}

export interface ClientErrorGroup {
  message: string;
  kind: string;
  path: string | null;
  count: number;
  lastAt: Date;
}

/** This workspace's browser errors in the last day, the same message grouped, newest first. */
export async function recentClientErrors(db: Db, workspaceId: number, now: Date = new Date()): Promise<{ total: number; groups: ClientErrorGroup[] }> {
  const rows = await db.select({ message: clientErrors.message, kind: clientErrors.kind, path: clientErrors.path, createdAt: clientErrors.createdAt })
    .from(clientErrors)
    .where(and(eq(clientErrors.workspaceId, workspaceId), gte(clientErrors.createdAt, new Date(now.getTime() - 24 * HOUR)), isNotNull(clientErrors.message)))
    .orderBy(desc(clientErrors.createdAt))
    .limit(500);
  const groups = new Map<string, ClientErrorGroup>();
  for (const r of rows) {
    const key = `${r.kind}\u0000${r.message}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { message: r.message, kind: r.kind, path: r.path, count: 1, lastAt: r.createdAt });
  }
  return { total: rows.length, groups: Array.from(groups.values()).slice(0, 25) };
}

export async function engineStatusFor(db: Db, workspaceId: number, opts: { showErrors: boolean; now?: Date }) {
  const now = opts.now ?? new Date();
  const engines = engineRunStatuses()
    .map((e) => ({ ...e, lastError: opts.showErrors ? e.lastError : e.lastError ? "(shown to super admins)" : null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const [queues, errors] = await Promise.all([workspaceQueues(db, workspaceId, now), recentClientErrors(db, workspaceId, now)]);
  // Engines and slow queries are the whole install's, not this workspace's:
  // an admin sees the counts, a super admin also the error text and the
  // statements (literals already blanked).
  const slow = slowQueryStats();
  return { at: now, engines, queues, clientErrors: errors, slowQueries: opts.showErrors ? slow : { ...slow, samples: [] } };
}
