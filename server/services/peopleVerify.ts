/**
 * Verify People in bulk (audit 2026-10-20, F39).
 *
 * People are the sitewide record and Data health counts them, but the only
 * bulk verify took contact ids, and nothing on People verified anyone — so
 * the "verified" numbers never moved from the screen. Now a selection on
 * People becomes one persisted job (services/jobs/runner) that runs each
 * person through the SAME procedure the person page's Verify button runs,
 * `prospects.verifyEmail`, as the person who started it: the same role check,
 * the same Reoon key choke point (getReoonKey: own key, or the shared key
 * only when allowed and under its cap), the same ledger and audit row. One
 * Reoon daily credit per person with an address; people without one are left
 * out before anything is queued, so they cost nothing.
 */
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { prospects } from "../../drizzle/schema";
import { getDb } from "../db";
import { recordAudit } from "../audit";
import { callerContextFor, enqueueJob, findActiveJob, kickJobs, registerJobKind } from "./jobs/runner";

export const PEOPLE_VERIFY_JOB = "prospects.verifyEmail";
/** People per bulk verify: one selection page of People at most. */
export const PEOPLE_VERIFY_MAX = 200;

type Payload = { prospectIds: number[] };

registerJobKind<Payload>(PEOPLE_VERIFY_JOB, {
  async step(job, payload, budgetMs) {
    const until = Date.now() + budgetMs;
    const { appRouter } = await import("../routers");
    const caller = appRouter.createCaller((await callerContextFor(job)) as never);
    const ids = payload.prospectIds ?? [];
    let i = job.resumeFrom;
    let done = 0;
    const failures: Array<{ id: number; error: string }> = [];
    while (i < ids.length && Date.now() < until) {
      try {
        await caller.prospects.verifyEmail({ prospectId: ids[i] });
        done++;
      } catch (e) {
        failures.push({ id: ids[i], error: ((e as Error)?.message ?? String(e)).slice(0, 200) });
      }
      i++;
    }
    return { cursor: i, done, failures, finished: i >= ids.length, message: `Verified ${job.done + done} of ${ids.length}` };
  },
  async finish(job, payload, outcome) {
    await recordAudit({
      workspaceId: job.workspaceId, actorUserId: job.userId, action: "update", entityType: "prospect_email_verify_bulk", entityId: 0,
      after: { requested: job.total, verified: job.done, failed: job.failed, outcome, jobId: job.id, prospectIds: payload.prospectIds },
    });
  },
});

/** The selection's people who have an address, in the order given. */
export async function peopleWithEmail(workspaceId: number, ids: number[]): Promise<number[]> {
  const db = await getDb();
  if (!db || ids.length === 0) return [];
  const rows = await db.select({ id: prospects.id }).from(prospects).where(and(
    eq(prospects.workspaceId, workspaceId),
    inArray(prospects.id, ids),
    isNotNull(prospects.email),
    ne(prospects.email, ""),
  ));
  const have = new Set(rows.map((r) => r.id));
  return ids.filter((id) => have.has(id));
}

/** Queue the verify, or hand back the same selection's job already running. */
export async function queuePeopleVerify(workspaceId: number, userId: number, withEmail: number[]) {
  const running = await findActiveJob<Payload>(workspaceId, PEOPLE_VERIFY_JOB, (p) => withEmail.every((id) => p.prospectIds?.includes(id)));
  if (running) return { jobId: running.id, existing: true };
  const { job } = await enqueueJob({ workspaceId, userId, kind: PEOPLE_VERIFY_JOB, payload: { prospectIds: withEmail } satisfies Payload, total: withEmail.length });
  kickJobs();
  return { jobId: job.id, existing: false };
}
