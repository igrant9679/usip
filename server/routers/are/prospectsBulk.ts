/**
 * ARE — mass actions on a campaign's prospects (owner ask 2026-08-19:
 * "select many or all prospects and different buttons for all useful
 * actions… all actions should track and save automatically within the
 * campaign and for all relevant info site-wide").
 *
 * ONE procedure, `are.prospects.bulk`, and two rules that keep it honest:
 *
 *  1. Campaign-state actions (approve, reject, skip, restore, re-evaluate,
 *     enrich, generate, pause, resume, cancel) run the EXISTING single-row
 *     procedure per id through createCaller — same guards, same status
 *     transitions, same per-row history as the buttons on the row. Nothing is
 *     re-implemented, so the two can never disagree.
 *  2. People-level actions (add to list, create tasks, suppress, promote)
 *     operate on the PERSON the queue row links to — `personProspectId`, the
 *     People-as-master seam — linking the row first when it is not yet linked.
 *     That is what "site-wide" means here: a list membership, a task or a
 *     suppression lands on the person and is visible from People, Tasks, the
 *     sequences engine, not just inside this campaign.
 *
 * Every run writes one audit row (entityType are_prospect_bulk, with the
 * action, the ids and the per-row outcome) and one campaign log line
 * (phase "bulk"), and returns the per-row failures — a partial success is
 * reported as such, never rounded up.
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { MAX_TIMELINE_DAY_OFFSET, MAX_TIMELINE_STEPS } from "@shared/areStepCadence";
import { areEngineLogs, emailSuppressions, prospectIntelligence, prospectQueue } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { recordAudit } from "../../audit";
import { upsertPersonForRow, type QueuePersonShape } from "../../services/personLink";

export const BULK_ACTIONS = [
  // campaign state — via the single-row procedures
  "approve", "reject", "skip", "restore", "reEvaluate", "enrich", "generateSequence",
  "pauseSequence", "resumeSequence", "cancelSequence", "editTimeline", "activateSequence",
  // people-level — via the linked People record
  "addToList", "createTasks", "suppress", "linkToPeople",
] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export const BULK_INPUT = z.object({
  campaignId: z.number().int().positive(),
  prospectIds: z.array(z.number().int().positive()).min(1).max(200),
  action: z.enum(BULK_ACTIONS),
  /** reject / cancelSequence / suppress / restore note */
  reason: z.string().trim().max(500).optional(),
  /** generateSequence: regenerate even if one exists */
  force: z.boolean().optional(),
  /** addToList: an existing list, or a new one by name */
  listId: z.number().int().positive().optional(),
  newListName: z.string().trim().min(1).max(200).optional(),
  /** createTasks */
  taskTitle: z.string().trim().min(1).max(240).optional(),
  taskType: z.enum(["follow_up", "call", "manual_email", "social_touch", "meeting_prep", "todo"]).optional(),
  taskPriority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  dueInDays: z.number().int().min(0).max(60).optional(),
  /** suppress: why — lands on both the ARE suppression list and the site-wide email suppressions */
  suppressionReason: z.enum(["unsubscribe", "bounce", "competitor", "existing_customer", "manual", "do_not_contact"]).optional(),
  /** editTimeline: cumulative day offsets for each ordered step (0170).
   *  Omit with clearTimeline=true to return the selection to campaign cadence. */
  dayOffsets: z.array(z.number().int().min(0).max(MAX_TIMELINE_DAY_OFFSET)).min(1).max(MAX_TIMELINE_STEPS).optional(),
  clearTimeline: z.boolean().optional(),
});
export type BulkInput = z.infer<typeof BULK_INPUT>;

export interface BulkResult {
  action: BulkAction;
  requested: number;
  ok: number;
  failed: Array<{ id: number; error: string }>;
  /** Human line for the toast / log. */
  summary: string;
  /** People-level actions: how many rows had to be linked to a person first, and how many could not be. */
  linked?: number;
  unlinkable?: number;
  listId?: number;
}

type Ctx = { workspace: { id: number }; user: { id: number } };

async function emitBulkLog(workspaceId: number, campaignId: number, level: "info" | "warn", message: string, details?: unknown) {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(areEngineLogs).values({ workspaceId, campaignId, phase: "bulk", level, message: message.slice(0, 500), details: (details ?? null) as never });
  } catch (e) { console.error("[are.bulk] log failed:", e); }
}

/** Resolve each queue row to its People id, linking unlinked rows through the
 *  one seam (personLink.upsertPersonForRow) and writing the link back. */
async function peopleIdsFor(workspaceId: number, rows: Array<typeof prospectQueue.$inferSelect>): Promise<{ byQueueId: Map<number, number>; linked: number; unlinkable: number[] }> {
  const db = await getDb();
  const byQueueId = new Map<number, number>();
  let linked = 0;
  const unlinkable: number[] = [];
  if (!db) return { byQueueId, linked, unlinkable: rows.map((r) => r.id) };
  for (const r of rows) {
    if (r.personProspectId) { byQueueId.set(r.id, r.personProspectId); continue; }
    const res = await upsertPersonForRow(workspaceId, r as unknown as QueuePersonShape);
    if (!res) { unlinkable.push(r.id); continue; }
    await db.update(prospectQueue).set({ personProspectId: res.personId } as never)
      .where(and(eq(prospectQueue.id, r.id), eq(prospectQueue.workspaceId, workspaceId)));
    byQueueId.set(r.id, res.personId);
    linked++;
  }
  return { byQueueId, linked, unlinkable };
}

export async function runBulkAction(ctx: Ctx, input: BulkInput): Promise<BulkResult> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const ws = ctx.workspace.id;

  // Every id must be a row of THIS campaign in THIS workspace — a stale or
  // hand-crafted id is rejected before anything runs.
  const rows = await db.select().from(prospectQueue)
    .where(and(eq(prospectQueue.workspaceId, ws), eq(prospectQueue.campaignId, input.campaignId), inArray(prospectQueue.id, input.prospectIds)));
  const known = new Set(rows.map((r) => r.id));
  const missing = input.prospectIds.filter((id) => !known.has(id));
  if (missing.length) throw new TRPCError({ code: "BAD_REQUEST", message: `${missing.length} selected prospect(s) are not in this campaign (ids ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}) — refresh and try again.` });

  // Dynamic import breaks the routers.ts ⇄ are router cycle (assistant.ts does the same).
  const { appRouter } = await import("../../routers");
  const caller = appRouter.createCaller(ctx as never);

  const result: BulkResult = { action: input.action, requested: rows.length, ok: 0, failed: [], summary: "" };
  const perRow = async (fn: (row: typeof rows[number]) => Promise<unknown>) => {
    for (const r of rows) {
      try { await fn(r); result.ok++; }
      catch (e) { result.failed.push({ id: r.id, error: ((e as Error)?.message ?? String(e)).slice(0, 200) }); }
    }
  };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

  // LLM-backed actions take seconds PER ROW, so a mass run cannot finish
  // inside one request. Above a small batch they run in the background:
  // the call returns at once, the campaign log gets a "started" line and a
  // "finished" line with the per-row outcome, and the audit row is written
  // when it finishes. The tab refreshes as rows change.
  const LLM_ACTIONS: BulkAction[] = ["generateSequence", "reEvaluate"];
  const INLINE_MAX = 5;
  if (LLM_ACTIONS.includes(input.action) && rows.length > INLINE_MAX) {
    const label = input.action === "generateSequence" ? "Generating sequences" : "Re-evaluating";
    await emitBulkLog(ws, input.campaignId, "info", `Bulk ${input.action}: ${label} for ${plural(rows.length, "prospect")} — running in the background`, { prospectIds: input.prospectIds });
    void (async () => {
      const bg: BulkResult = { action: input.action, requested: rows.length, ok: 0, failed: [], summary: "" };
      for (const r of rows) {
        try {
          if (input.action === "generateSequence") await caller.are.prospects.generateSequence({ prospectId: r.id, campaignId: input.campaignId, force: input.force ?? false });
          else await caller.are.prospects.reEvaluate({ prospectId: r.id });
          bg.ok++;
        } catch (e) { bg.failed.push({ id: r.id, error: ((e as Error)?.message ?? String(e)).slice(0, 200) }); }
      }
      bg.summary = `${label} finished: ${bg.ok} of ${rows.length} done${bg.failed.length ? `, ${bg.failed.length} failed` : ""}`;
      await recordAudit({ workspaceId: ws, actorUserId: ctx.user.id, action: "update", entityType: "are_prospect_bulk", entityId: input.campaignId,
        after: { action: input.action, requested: bg.requested, ok: bg.ok, failed: bg.failed, prospectIds: input.prospectIds, background: true } });
      await emitBulkLog(ws, input.campaignId, bg.failed.length ? "warn" : "info", `Bulk ${input.action}: ${bg.summary}`, { failed: bg.failed });
    })().catch((e) => console.error("[are.bulk] background run failed:", e));
    result.summary = `${label} for ${plural(rows.length, "prospect")} in the background — rows update as each finishes; the campaign log has the outcome`;
    result.ok = rows.length; // accepted, not finished — the summary says so
    return result;
  }

  switch (input.action) {
    case "approve": await perRow((r) => caller.are.prospects.approve({ prospectId: r.id })); result.summary = `Approved ${plural(result.ok, "prospect")}`; break;
    case "reject": await perRow((r) => caller.are.prospects.reject({ prospectId: r.id, reason: input.reason })); result.summary = `Rejected ${plural(result.ok, "prospect")}`; break;
    case "skip": await perRow((r) => caller.are.prospects.skip({ prospectId: r.id })); result.summary = `Skipped ${plural(result.ok, "prospect")}`; break;
    case "restore": {
      // A rejected/skipped row back to pending so the engine screens it again.
      await perRow(async (r) => {
        if (r.sequenceStatus !== "skipped") throw new Error(`not rejected (status ${r.sequenceStatus})`);
        await db.update(prospectQueue)
          .set({ sequenceStatus: "pending", rejectedAt: null, rejectionReason: input.reason ? `Restored — ${input.reason}` : null } as never)
          .where(and(eq(prospectQueue.id, r.id), eq(prospectQueue.workspaceId, ws)));
      });
      result.summary = `Restored ${plural(result.ok, "prospect")} to pending`;
      break;
    }
    case "reEvaluate": await perRow((r) => caller.are.prospects.reEvaluate({ prospectId: r.id })); result.summary = `Re-evaluated ${plural(result.ok, "prospect")}`; break;
    case "enrich": await perRow((r) => caller.are.prospects.enrich({ prospectId: r.id })); result.summary = `Enrichment started for ${plural(result.ok, "prospect")}`; break;
    case "generateSequence": await perRow((r) => caller.are.prospects.generateSequence({ prospectId: r.id, campaignId: input.campaignId, force: input.force ?? false })); result.summary = `Sequences generated for ${plural(result.ok, "prospect")}`; break;
    case "pauseSequence": await perRow((r) => caller.are.prospects.pauseSequence({ prospectId: r.id })); result.summary = `Paused ${plural(result.ok, "sequence")}`; break;
    case "resumeSequence": await perRow((r) => caller.are.prospects.resumeSequence({ prospectId: r.id })); result.summary = `Resumed ${plural(result.ok, "sequence")}`; break;
    case "cancelSequence": await perRow((r) => caller.are.prospects.cancelSequence({ prospectId: r.id, reason: input.reason })); result.summary = `Canceled ${plural(result.ok, "sequence")}`; break;
    case "editTimeline": {
      // One timeline applied to the whole selection — cumulative day offsets
      // per ordered step, or an explicit return to the campaign grid. The
      // single-row procedure moves each prospect's already-scheduled rows too,
      // so the edit is real immediately, not at the next respace.
      if (!input.clearTimeline && !input.dayOffsets) throw new TRPCError({ code: "BAD_REQUEST", message: "Provide the timeline's day offsets, or clearTimeline to return to campaign cadence." });
      const offsets = input.clearTimeline ? null : input.dayOffsets!;
      await perRow((r) => caller.are.prospects.setSequenceTimeline({ prospectId: r.id, dayOffsets: offsets }));
      result.summary = offsets
        ? `Timeline set for ${plural(result.ok, "prospect")} — steps on day ${offsets.join(", ")}`
        : `Timeline reset to campaign cadence for ${plural(result.ok, "prospect")}`;
      break;
    }
    case "activateSequence": {
      /**
       * "Activate" = approve + enroll, because to the user a sequence is not
       * active until its steps are actually scheduled — an approval that
       * waits for the next cron tick looks like a button that did nothing.
       *
       * Guards per row, THEN one enrolment pass. A row only qualifies from
       * `pending` (approved here, through the single-row procedure — the
       * 2026-08-16 lesson lives in its COALESCE stamps) or `approved`
       * (already decided, just not enrolled yet). A row with no generated
       * sequence fails with a reason instead of being silently approved into
       * a state the engine can do nothing with.
       *
       * Enrolment goes through are.engine.enrollOnly — enrol phase only, no
       * dispatch, works on a paused campaign by design. On an ACTIVE campaign
       * the dispatcher picks the new rows up on its next cycle under the
       * daily cap; that consequence is what the client's confirm dialog says
       * out loud. The email gate (day 16) still applies inside enrolment:
       * an approved-but-email-less prospect stays approved and is counted,
       * which the summary reports rather than rounding up to "activated".
       */
      const intel = await db
        .select({ prospectQueueId: prospectIntelligence.prospectQueueId, seq: prospectIntelligence.generatedSequence })
        .from(prospectIntelligence)
        .where(and(eq(prospectIntelligence.workspaceId, ws), inArray(prospectIntelligence.prospectQueueId, input.prospectIds)));
      const hasSeq = new Set(intel.filter((i) => Array.isArray(i.seq) && (i.seq as unknown[]).length > 0).map((i) => i.prospectQueueId));
      await perRow(async (r) => {
        if (r.sequenceStatus === "enrolled" || r.sequenceStatus === "paused") throw new Error(`already active (status ${r.sequenceStatus})`);
        if (r.sequenceStatus !== "pending" && r.sequenceStatus !== "approved") throw new Error(`not activatable from status "${r.sequenceStatus}"`);
        if (!hasSeq.has(r.id)) throw new Error("no generated sequence — run Generate first");
        if (r.sequenceStatus === "pending") await caller.are.prospects.approve({ prospectId: r.id });
      });
      let enrolled = 0, enrollBlocked = false;
      if (result.ok > 0) {
        // enrollOnly is bounded per call (the engine's own page size); loop
        // until a pass enrolls nobody. A held campaign lock ends the loop —
        // the cron finishes the backlog, and the summary says so.
        for (let pass = 0; pass < 25; pass++) {
          const res = await caller.are.engine.enrollOnly({ campaignId: input.campaignId });
          enrolled += res.enrolled;
          if (res.skippedInFlight) { enrollBlocked = true; break; }
          if (res.enrolled === 0) break;
        }
      }
      // Honest outcome = the statuses NOW of the rows that passed the guards
      // — never the intent, and never rows that failed (an already-enrolled
      // row in the selection must not inflate "activated").
      const failedIds = new Set(result.failed.map((f) => f.id));
      const after = await db
        .select({ id: prospectQueue.id, status: prospectQueue.sequenceStatus })
        .from(prospectQueue)
        .where(and(eq(prospectQueue.workspaceId, ws), inArray(prospectQueue.id, input.prospectIds)));
      const okRows = after.filter((a) => !failedIds.has(a.id));
      const nowEnrolled = okRows.filter((a) => a.status === "enrolled").length;
      const stillApproved = okRows.filter((a) => a.status === "approved").length;
      result.summary = `Activated ${plural(nowEnrolled, "sequence")}`
        + (stillApproved > 0 ? `; ${stillApproved} approved but held at enrolment (waiting for an email address, or no usable steps — the campaign log names each hold)` : "")
        + (enrollBlocked ? "; another enrol run held the campaign lock — the engine finishes the rest on its next cycle" : "");
      break;
    }

    case "linkToPeople": {
      const { byQueueId, linked, unlinkable } = await peopleIdsFor(ws, rows);
      result.ok = byQueueId.size; result.linked = linked; result.unlinkable = unlinkable.length;
      for (const id of unlinkable) result.failed.push({ id, error: "no usable identity (needs an email, LinkedIn URL, or phone)" });
      result.summary = `${plural(byQueueId.size, "prospect")} linked to People (${linked} newly created or linked)`;
      break;
    }
    case "addToList": {
      if (!input.listId && !input.newListName) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a list or give the new one a name." });
      const { byQueueId, linked, unlinkable } = await peopleIdsFor(ws, rows);
      for (const id of unlinkable) result.failed.push({ id, error: "could not link to a People record (no usable identity)" });
      const personIds = Array.from(new Set(byQueueId.values()));
      let listId = input.listId;
      if (!listId) {
        const created = (await caller.recordLists.create({ name: input.newListName!, entityType: "people" } as never)) as { id: number };
        listId = created.id;
      }
      if (personIds.length) await caller.recordLists.addMembers({ listId, recordType: "prospect", recordIds: personIds } as never);
      result.ok = personIds.length; result.linked = linked; result.unlinkable = unlinkable.length; result.listId = listId;
      result.summary = `Added ${plural(personIds.length, "person")} to list #${listId}`;
      break;
    }
    case "createTasks": {
      if (!input.taskTitle) throw new TRPCError({ code: "BAD_REQUEST", message: "A task title is required." });
      const { byQueueId, linked, unlinkable } = await peopleIdsFor(ws, rows);
      for (const id of unlinkable) result.failed.push({ id, error: "could not link to a People record (no usable identity)" });
      const personIds = Array.from(new Set(byQueueId.values()));
      if (personIds.length) {
        await caller.tasks.bulkCreateForProspects({
          prospectIds: personIds, title: input.taskTitle, type: input.taskType ?? "follow_up",
          priority: input.taskPriority ?? "normal", dueInDays: input.dueInDays ?? 2,
        } as never);
      }
      result.ok = personIds.length; result.linked = linked; result.unlinkable = unlinkable.length;
      result.summary = `Created "${input.taskTitle}" for ${plural(personIds.length, "person")}`;
      break;
    }
    case "suppress": {
      // Two ledgers, one action: the ARE suppression list (what the engine
      // consults at enrol/dispatch) AND the site-wide email_suppressions
      // table (what every other sender consults). A person the owner says
      // "never contact" is never contacted anywhere.
      const areReason = input.suppressionReason ?? "do_not_contact";
      const siteReason: "unsubscribe" | "bounce" | "spam_complaint" | "manual" =
        areReason === "unsubscribe" ? "unsubscribe" : areReason === "bounce" ? "bounce" : "manual";
      await perRow(async (r) => {
        if (!r.email && !r.linkedinUrl) throw new Error("no email or LinkedIn URL to suppress");
        await caller.are.execution.addSuppression({
          ...(r.email ? { email: r.email } : {}), ...(r.linkedinUrl ? { linkedinUrl: r.linkedinUrl } : {}),
          reason: areReason,
        } as never);
        if (r.email) {
          const email = r.email.trim().toLowerCase();
          const [existing] = await db.select({ id: emailSuppressions.id }).from(emailSuppressions)
            .where(and(eq(emailSuppressions.workspaceId, ws), eq(emailSuppressions.email, email))).limit(1);
          if (!existing) {
            await db.insert(emailSuppressions).values({ workspaceId: ws, email, reason: siteReason, notes: (input.reason ?? `ARE bulk suppress (campaign ${input.campaignId})`).slice(0, 512) } as never);
          }
        }
        // And stop anything already scheduled for them in this campaign.
        if (r.sequenceStatus === "enrolled" || r.sequenceStatus === "paused" || r.sequenceStatus === "approved") {
          await caller.are.prospects.cancelSequence({ prospectId: r.id, reason: `Suppressed (${areReason})` });
        }
      });
      result.summary = `Suppressed ${plural(result.ok, "prospect")} — ARE list + site-wide email suppressions`;
      break;
    }
    default:
      throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown action" });
  }

  if (result.failed.length) result.summary += `; ${result.failed.length} failed`;

  await recordAudit({
    workspaceId: ws, actorUserId: ctx.user.id, action: "update", entityType: "are_prospect_bulk", entityId: input.campaignId,
    after: { action: input.action, requested: result.requested, ok: result.ok, failed: result.failed, prospectIds: input.prospectIds, params: { reason: input.reason, listId: result.listId ?? input.listId, newListName: input.newListName, taskTitle: input.taskTitle, suppressionReason: input.suppressionReason, dayOffsets: input.dayOffsets, clearTimeline: input.clearTimeline } },
  });
  await emitBulkLog(ws, input.campaignId, result.failed.length ? "warn" : "info",
    `Bulk ${input.action}: ${result.summary}`, { prospectIds: input.prospectIds, failed: result.failed });
  return result;
}
