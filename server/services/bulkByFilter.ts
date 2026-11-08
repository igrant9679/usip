/**
 * Bulk actions on "all N matching", and People's bulk enrich, run on the
 * server (audit 2026-10-20, F30 and R66).
 *
 * People, Companies and Leads could select at most the page on screen, and
 * People's "Enrich fully" sent the selection from the browser ten people a
 * request, so closing the tab stopped it part-way. Now:
 *
 *   - "Select all N matching" names the list's filter, not ids. The server
 *     reads the same filter the list counts (services/peopleFilter,
 *     company/searchService, leadSearch), refuses if the count is no longer
 *     the one the confirmation stated, and snapshots who matched;
 *   - the action is a persisted job (services/jobs/runner) that works through
 *     them in slices, each slice through the SAME procedure the page's own
 *     button calls, run as the person who started it: the role checks, caps,
 *     suppression and pause checks, ledgers and audit rows of that procedure
 *     all apply, slice by slice;
 *   - Enrich fully, for a selection or all matching, is such a job too. The
 *     comprehensive pass runs a person at a time through
 *     prospects.findContactInfoBatch, under the vendors' own caps, and when the
 *     job ends ONE LinkedIn lookup job takes the people who still have no
 *     profile, as the page did.
 *
 * Nothing here enrols anyone: putting all matching people into a campaign or
 * sequence goes through the Add to… menu with the matching ids, which runs
 * every enrolment check (outbound pause, suppression, do-not-contact).
 */
import { and, eq, inArray } from "drizzle-orm";
import { prospectLinkedinEnrichments, prospects } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { getDb } from "../db";
import { callerContextFor, enqueueJob, kickJobs, registerJobKind, type JobFailure } from "./jobs/runner";

export const BULK_JOB = "bulk.byFilter";

export type BulkEntity = "people" | "companies" | "leads";
export type BulkAction = "delete" | "optOut" | "addToList" | "tasks" | "enrichFull" | "enrich";

type Payload = {
  entity: BulkEntity;
  action: BulkAction;
  ids: number[];
  params?: Record<string, unknown>;
  /** What was matched, for the audit row: the filter, or "selection". */
  scope?: unknown;
};

/** Ids per call, within each procedure's own input limit. */
const CHUNK: Record<BulkAction, number> = { delete: 500, optOut: 500, addToList: 500, tasks: 500, enrichFull: 1, enrich: 25 };

/** The actions each entity offers on "all matching". */
export const BULK_ACTIONS: Record<BulkEntity, BulkAction[]> = {
  people: ["delete", "optOut", "addToList", "tasks", "enrichFull"],
  companies: ["enrich"],
  leads: ["delete"],
};

const VERB: Record<BulkAction, string> = {
  delete: "Deleted", optOut: "Opted out", addToList: "Added to the list", tasks: "Created tasks for", enrichFull: "Enriched", enrich: "Enriched",
};

type Caller = any;

/** One slice through the page's own procedure; returns how many it handled. */
async function runChunk(caller: Caller, p: Payload, part: number[]): Promise<number> {
  const key = `${p.entity}.${p.action}`;
  switch (key) {
    case "people.delete": return Number((await caller.prospects.bulkDelete({ prospectIds: part })).deleted ?? 0);
    case "people.optOut": { await caller.emailSuppressions.addByProspects({ prospectIds: part }); return part.length; }
    case "people.addToList": {
      const r = await caller.recordLists.addMembers({ listId: Number(p.params?.listId), recordType: "prospect", recordIds: part });
      return Number(r.added ?? 0) + Number(r.alreadyOn ?? 0);
    }
    case "people.tasks": {
      const r = await caller.tasks.bulkCreateForProspects({ ...(p.params ?? {}), prospectIds: part });
      return Number(r?.created ?? part.length);
    }
    case "people.enrichFull": return Number((await caller.prospects.findContactInfoBatch({ prospectIds: part, skipIfHasEmail: true })).processed ?? 0);
    case "companies.enrich": return Number((await caller.companies.bulkEnrich({ accountIds: part })).ok ?? 0);
    case "leads.delete": return Number((await caller.leads.bulkDelete({ ids: part })).deleted ?? 0);
    default: throw new Error(`No bulk action ${key}`);
  }
}

/**
 * The people a finished Enrich fully still owes a LinkedIn profile: a profile
 * URL, not archived, and no profile read in the last 30 days (the rule
 * findContactInfoBatch reports by).
 */
export async function stillNeedLinkedIn(ws: number, ids: number[]): Promise<number[]> {
  const db = await getDb();
  if (!db || !ids.length) return [];
  const FRESH_MS = 30 * 86_400_000;
  const out: number[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = await db.select({ id: prospects.id, linkedinUrl: prospects.linkedinUrl, verificationStatus: prospects.verificationStatus })
      .from(prospects).where(and(eq(prospects.workspaceId, ws), inArray(prospects.id, part)));
    const enr = await db.select({ prospectId: prospectLinkedinEnrichments.prospectId, status: prospectLinkedinEnrichments.linkedinDataStatus, at: prospectLinkedinEnrichments.linkedinLastRetrievedAt })
      .from(prospectLinkedinEnrichments)
      .where(and(eq(prospectLinkedinEnrichments.workspaceId, ws), inArray(prospectLinkedinEnrichments.prospectId, part)));
    const fresh = new Set(enr.filter((e) => e.status === "enriched" && e.at && Date.now() - new Date(e.at).getTime() < FRESH_MS).map((e) => e.prospectId));
    for (const r of rows) if (r.linkedinUrl?.trim() && !fresh.has(r.id) && r.verificationStatus !== "rejected") out.push(r.id);
  }
  return out;
}

registerJobKind<Payload>(BULK_JOB, {
  async step(job, payload, budgetMs) {
    const until = Date.now() + budgetMs;
    const { appRouter } = await import("../routers");
    const caller = appRouter.createCaller((await callerContextFor(job)) as never);
    const ids = payload.ids ?? [];
    const size = CHUNK[payload.action] ?? 100;
    let i = job.resumeFrom;
    let done = 0;
    const failures: JobFailure[] = [];
    while (i < ids.length && Date.now() < until) {
      const part = ids.slice(i, i + size);
      try {
        done += await runChunk(caller, payload, part);
      } catch (e) {
        const error = ((e as Error)?.message ?? String(e)).slice(0, 200);
        for (const id of part) failures.push({ id, error });
        // A refusal that will refuse every slice (a role, a missing key) ends
        // the job rather than failing thousands of people one slice at a time.
        const code = (e as { code?: string })?.code;
        if (code === "FORBIDDEN" || code === "PRECONDITION_FAILED" || code === "UNAUTHORIZED") {
          return { cursor: ids.length, done, failures, finished: true, message: `Stopped: ${error}` };
        }
      }
      i += part.length;
    }
    return { cursor: i, done, failures, finished: i >= ids.length, message: `${VERB[payload.action]} ${job.done + done} of ${ids.length}` };
  },
  async finish(job, payload, outcome) {
    let linkedin: string | null = null;
    if (payload.entity === "people" && payload.action === "enrichFull" && outcome === "done") {
      // Photos and titles come from ONE LinkedIn lookup job for everyone who
      // still has no profile, as the page queued it (cap-aware, match-gated).
      try {
        const need = await stillNeedLinkedIn(job.workspaceId, payload.ids);
        if (need.length) {
          const { appRouter } = await import("../routers");
          const caller = appRouter.createCaller((await callerContextFor(job)) as never);
          for (let i = 0; i < need.length; i += 500) {
            await caller.linkedinEnrichment.run({ prospectIds: need.slice(i, i + 500), triggerType: "people_bulk_action" });
          }
          linkedin = `LinkedIn lookups queued for ${need.length}`;
        }
      } catch (e) {
        linkedin = `LinkedIn lookups not queued: ${((e as Error)?.message ?? String(e)).slice(0, 160)}`;
      }
    }
    await recordAudit({
      workspaceId: job.workspaceId, actorUserId: job.userId, action: payload.action === "delete" ? "delete" : "update",
      entityType: `bulk_${payload.entity}_${payload.action}`, entityId: 0,
      after: { requested: job.total, done: job.done, failed: job.failed, outcome, jobId: job.id, scope: payload.scope ?? "selection", ...(linkedin ? { linkedin } : {}) },
    });
  },
});

/** Queue a bulk action over these ids (already this workspace's, resolved by the caller). */
export async function queueBulk(opts: { workspaceId: number; userId: number; entity: BulkEntity; action: BulkAction; ids: number[]; params?: Record<string, unknown>; scope?: unknown }) {
  const { job } = await enqueueJob({
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    kind: BULK_JOB,
    payload: { entity: opts.entity, action: opts.action, ids: opts.ids, params: opts.params, scope: opts.scope } satisfies Payload,
    total: opts.ids.length,
  });
  kickJobs();
  return { jobId: job.id, total: opts.ids.length };
}
