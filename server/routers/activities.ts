import { TRPCError } from "@trpc/server";
import { TASK_STATUSES } from "@shared/taskStatus";
import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { seesAllTasks, taskDueState } from "@shared/taskRules";
import { z } from "zod";
import { activities, attachments, notifications, prospects, tasks, workspaceSettings } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { getDb } from "../db";
import { storageErase, storagePut } from "../storage";
import { ATTACHMENT_MAX_BASE64, ATTACHMENT_MAX_BYTES, attachmentType } from "../services/attachmentType";
import { router } from "../_core/trpc";
import { adminWsProcedure, repProcedure, workspaceProcedure } from "../_core/workspace";
import { generateTasksForWorkspace } from "../services/taskAutopilot";
import { getWorkspaceTimezone } from "../services/workspaceTimezone";
import { assertOutboundNotPaused } from "../services/outboundPause";
import { assertOwnerInWorkspace, assertRecordInWorkspace, assertRelatedInWorkspace } from "../services/foreignIds";
import { activeMemberIds } from "../_core/activeMembers";
import { deadlineFrom } from "../services/calendarDeadline";
import { affectedRowsOf } from "../_core/claim";

const TASK_TYPES = ["call", "email", "meeting", "linkedin", "todo", "follow_up", "social_touch", "manual_email", "meeting_prep", "crm_update", "generic_action"] as const;

const TASK_PATCH = z.object({
  title: z.string().min(1).max(240).optional(),
  description: z.string().max(20000).nullable().optional(),
  type: z.enum(TASK_TYPES).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  dueAt: z.union([z.string(), z.date()]).nullable().optional(),
  snoozedUntil: z.union([z.string(), z.date()]).nullable().optional(),
  disposition: z.string().max(48).nullable().optional(),
  ownerUserId: z.number().int().positive().optional(),
}).strict();


/* ─── Tasks ──────────────────────────────────────────────────────────── */

/**
 * A snoozed task comes back when its snooze ends (audit 2026-10-20, R72).
 * Snooze set status "snoozed" and nothing ever set it back, so a task snoozed
 * "until tomorrow" stayed out of every Today and Overdue list for good. Run
 * where tasks are read, rather than by a new timer: it only matches tasks
 * whose snooze has run out.
 */
async function wakeSnoozedTasks(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, workspaceId: number) {
  await db.update(tasks)
    .set({ status: "open", snoozedUntil: null } as never)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "snoozed"), lte(tasks.snoozedUntil, new Date())));
}

/** `mine`: the task pages' scope (R72) — a rep's own tasks, a manager's everyone's. */
function taskScopeOwner(ctx: { user: { id: number }; member: { role: string } }, mine: boolean | undefined): number | null {
  return mine && !seesAllTasks(ctx.member.role) ? ctx.user.id : null;
}

export const tasksRouter = router({
  list: workspaceProcedure
    .input(z.object({
      ownerOnly: z.boolean().optional(),
      status: z.enum(TASK_STATUSES).optional(),
      type: z.enum(TASK_TYPES).optional(),
      source: z.enum(["manual", "sequence", "ai", "import", "workflow"]).optional(),
      relatedType: z.string().optional(),
      relatedId: z.number().optional(),
      // Draft (AI-proposed, unapproved) tasks are hidden by default so they
      // don't leak into other surfaces (e.g. the Calls queue). The Tasks page
      // opts in with includeDrafts:true and reviews them separately.
      includeDrafts: z.boolean().optional(),
      /** The task pages' scope (R72): a rep's own tasks, a manager's everyone's. */
      mine: z.boolean().optional(),
      /** A bound for a screen that shows a page, not everything (O41). Unset: every match, as before. */
      limit: z.number().int().min(1).max(500).optional(),
      /**
       * "due" (the default, as before): by due date, undated first, as MySQL
       * sorts NULL. "soonest": by due date with undated last, so a bounded
       * queue starts with what is due. "recent": newest first (a Completed list).
       */
      order: z.enum(["due", "soonest", "recent"]).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      await wakeSnoozedTasks(db, ctx.workspace.id);
      // Every filter in SQL (audit 2026-10-20, O41): this read every task in
      // the workspace and filtered in JS, so the Calls page fetched them all
      // to keep the call tasks.
      const conds = [eq(tasks.workspaceId, ctx.workspace.id)];
      if (input?.ownerOnly) conds.push(eq(tasks.ownerUserId, ctx.user.id));
      const scopeOwner = taskScopeOwner(ctx, input?.mine);
      if (scopeOwner !== null) conds.push(eq(tasks.ownerUserId, scopeOwner));
      if (input?.status) conds.push(eq(tasks.status, input.status));
      else if (!input?.includeDrafts) conds.push(ne(tasks.status, "draft"));
      if (input?.type) conds.push(eq(tasks.type, input.type));
      if (input?.source) conds.push(eq(tasks.source, input.source));
      if (input?.relatedType && input?.relatedId) {
        conds.push(eq(tasks.relatedType, input.relatedType), eq(tasks.relatedId, input.relatedId));
      }
      const order = input?.order === "recent" ? [desc(tasks.updatedAt), desc(tasks.id)]
        : input?.order === "soonest" ? [sql`${tasks.dueAt} is null`, asc(tasks.dueAt), asc(tasks.id)]
        : [asc(tasks.dueAt), asc(tasks.id)];
      const q = db.select().from(tasks).where(and(...conds)).orderBy(...order);
      return input?.limit ? q.limit(input.limit) : q;
    }),

  create: repProcedure
    .input(z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      type: z.enum(TASK_TYPES).default("todo"),
      priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
      dueAt: z.string().optional(),
      relatedType: z.string().optional(),
      relatedId: z.number().optional(),
      ownerUserId: z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Assigning to another workspace's user (or a leaver) filed the task
      // under someone who can never see it (audit 2026-10-20, C7).
      await assertOwnerInWorkspace(ctx.workspace.id, input.ownerUserId);
      await assertRelatedInWorkspace(db, input.relatedType, input.relatedId, ctx.workspace.id);
      const r = await db.insert(tasks).values({
        ...input,
        workspaceId: ctx.workspace.id,
        ownerUserId: input.ownerUserId ?? ctx.user.id,
        // A day picked as the due date lasts the whole day in the workspace's
        // zone (R29): UTC midnight made "due today" overdue at creation.
        dueAt: deadlineFrom(input.dueAt, await getWorkspaceTimezone(ctx.workspace.id)),
        status: "open",
      });
      const id = Number((r as any)[0]?.insertId ?? 0);
      if (input.ownerUserId && input.ownerUserId !== ctx.user.id) {
        await db.insert(notifications).values({
          workspaceId: ctx.workspace.id,
          userId: input.ownerUserId,
          kind: "task_assigned",
          title: `Task assigned: ${input.title}`,
          relatedType: "task",
          relatedId: id,
        });
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "task", entityId: id, after: input });
      return { id };
    }),

  /** Bulk-create one task per selected prospect (People toolbar "Create Tasks"). */
  bulkCreateForProspects: repProcedure
    .input(z.object({
      prospectIds: z.array(z.number().int().positive()).min(1).max(500),
      title: z.string().min(1).max(240),
      type: z.enum(TASK_TYPES).default("follow_up"),
      priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
      dueInDays: z.number().int().min(0).max(60).default(2),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const dueAt = new Date(Date.now() + input.dueInDays * 86400000);
      // Only this workspace's people get a task (audit 2026-10-20, R73).
      const here = await db.select({ id: prospects.id }).from(prospects)
        .where(and(eq(prospects.workspaceId, ctx.workspace.id), inArray(prospects.id, input.prospectIds)));
      if (here.length === 0) return { created: 0 };
      const values = here.map(({ id: pid }) => ({
        workspaceId: ctx.workspace.id,
        title: input.title,
        type: input.type,
        priority: input.priority,
        status: "open" as const,
        dueAt,
        ownerUserId: ctx.user.id,
        relatedType: "prospect",
        relatedId: pid,
        source: "manual" as const,
      }));
      await db.insert(tasks).values(values as never);
      return { created: values.length };
    }),

  setStatus: repProcedure.input(z.object({ id: z.number(), status: z.enum(["open", "done", "cancelled"]) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(tasks).set({ status: input.status, completedAt: input.status === "done" ? new Date() : null }).where(and(eq(tasks.id, input.id), eq(tasks.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /**
   * Explicit editable fields (audit 2026-10-20, C7): this took
   * `patch: z.record(any)` straight into `.set()`, so a patch could carry
   * `workspaceId` and move the task into another tenant, or hand it to another
   * tenant's user. Status changes keep their own procedures (setStatus,
   * complete), which stamp completedAt; the AI fields belong to the autopilot.
   */
  update: repProcedure.input(z.object({ id: z.number(), patch: TASK_PATCH })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await assertOwnerInWorkspace(ctx.workspace.id, input.patch.ownerUserId);
    const patch: any = { ...input.patch };
    if (patch.dueAt && typeof patch.dueAt === "string") patch.dueAt = deadlineFrom(patch.dueAt, await getWorkspaceTimezone(ctx.workspace.id));
    if (patch.snoozedUntil && typeof patch.snoozedUntil === "string") patch.snoozedUntil = new Date(patch.snoozedUntil);
    if (Object.keys(patch).length === 0) return { ok: true };
    await db.update(tasks).set(patch).where(and(eq(tasks.id, input.id), eq(tasks.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /**
   * Permanently remove a task. A HARD delete, and `/v2/tasks` calls it, so any
   * rep can destroy a task outright.
   *
   * Audited since 2026-10-30, because it was not: `create`, `complete`, `bulk`
   * and the four approve-and-sends all recorded an entry and this — the only
   * irreversible one of them — recorded nothing. A reviewer could see who
   * finished a task and never who destroyed one.
   *
   * The row is read BEFORE the delete and stored as `before`, which is the part
   * that matters: after a hard delete the audit entry is the only surviving
   * record of the task, so an entry carrying just the id would say something was
   * deleted without saying what. That is an audit trail that cannot answer the
   * question it exists for.
   *
   * Nothing is recorded when the id matches no row in this workspace — an
   * attempt on someone else's task is not a deletion and must not read as one.
   *
   * Two limits worth knowing rather than discovering: `recordAudit` swallows its
   * own failures by design (every caller relies on that), so the entry is
   * best-effort; and this is still a hard delete, not a soft one. Making it
   * recoverable needs a column and every read filtered, which is a product
   * decision and not this change.
   */
  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    // Both clauses written out, not hoisted into a `const scope`: the
    // tenantScope guard reads the ARGUMENT TEXT of .where(), so a variable is
    // invisible to it and the statement stops being one it protects. Its own
    // comment records someone hitting this before, and I hit it here on
    // 2026-10-30 — the repetition is the point.
    const [doomed] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, input.id), eq(tasks.workspaceId, ctx.workspace.id)))
      .limit(1);
    if (!doomed) return { ok: true };
    await db.delete(tasks).where(and(eq(tasks.id, input.id), eq(tasks.workspaceId, ctx.workspace.id)));
    await recordAudit({
      workspaceId: ctx.workspace.id,
      actorUserId: ctx.user.id,
      action: "delete",
      entityType: "task",
      entityId: input.id,
      before: doomed,
    });
    return { ok: true };
  }),

  /** Complete a task, optionally recording its outcome (disposition). */
  complete: repProcedure
    .input(z.object({ id: z.number(), disposition: z.string().max(48).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(tasks)
        .set({ status: "done", completedAt: new Date(), disposition: input.disposition ?? null, snoozedUntil: null } as never)
        .where(and(eq(tasks.id, input.id), eq(tasks.workspaceId, ctx.workspace.id)));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "task", entityId: input.id, after: { op: "complete", disposition: input.disposition } });
      return { ok: true };
    }),

  /* ── Approval queues that were only ever tasks (2026-09-09) ────────────
   * Chat follow-ups and Social Autopilot invites in Approve mode park as
   * open tasks; these turn them into approve-and-send actions through the
   * same paths Auto mode uses. See services/approvalTasks.ts. */
  approvalQueue: workspaceProcedure.query(async ({ ctx }) => {
    const { listApprovalTasks } = await import("../services/approvalTasks");
    return listApprovalTasks(ctx.workspace.id);
  }),
  sendChatFollowUp: repProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    // Pause all outbound holds person sends too (owner, 2026-10-06: "Block everything").
    await assertOutboundNotPaused(ctx.workspace.id);
    const { sendChatFollowUpTask } = await import("../services/approvalTasks");
    const r = await sendChatFollowUpTask(ctx.workspace.id, input.id, ctx.user.id);
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "task", entityId: input.id, after: { approveAndSend: "chat_follow_up", ...r } });
    if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `Not sent: ${r.reason.replace(/_/g, " ")}` });
    return r;
  }),
  sendAllChatFollowUps: repProcedure.mutation(async ({ ctx }) => {
    // Pause all outbound holds person sends too (owner, 2026-10-06: "Block everything").
    await assertOutboundNotPaused(ctx.workspace.id);
    const { sendAllApprovalTasks } = await import("../services/approvalTasks");
    const r = await sendAllApprovalTasks(ctx.workspace.id, "chat_follow_up", ctx.user.id);
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "task", entityId: 0, after: { approveAndSendAll: "chat_follow_up", ...r } });
    return r;
  }),
  sendSocialInvite: repProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    // Pause all outbound holds person sends too (owner, 2026-10-06: "Block everything").
    await assertOutboundNotPaused(ctx.workspace.id);
    const { sendSocialInviteTask } = await import("../services/approvalTasks");
    const r = await sendSocialInviteTask(ctx.workspace.id, input.id, ctx.user.id);
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "task", entityId: input.id, after: { approveAndSend: "social_invite", ...r } });
    if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `Not sent: ${r.reason.replace(/_/g, " ")}` });
    return r;
  }),
  sendAllSocialInvites: repProcedure.mutation(async ({ ctx }) => {
    // Pause all outbound holds person sends too (owner, 2026-10-06: "Block everything").
    await assertOutboundNotPaused(ctx.workspace.id);
    const { sendAllApprovalTasks } = await import("../services/approvalTasks");
    const r = await sendAllApprovalTasks(ctx.workspace.id, "social_invite", ctx.user.id);
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "task", entityId: 0, after: { approveAndSendAll: "social_invite", ...r } });
    return r;
  }),

  /** Snooze a task to a later time (status → snoozed). */
  snooze: repProcedure
    .input(z.object({ id: z.number(), snoozedUntil: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const until = new Date(input.snoozedUntil);
      await db.update(tasks)
        .set({ status: "snoozed", snoozedUntil: until, dueAt: until } as never)
        .where(and(eq(tasks.id, input.id), eq(tasks.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  /** Queue stats for the Tasks page header. */
  stats: workspaceProcedure.input(z.object({
    mine: z.boolean().optional(),
    /** One kind of task (the Calls page counts call tasks, O41), filtered in SQL. */
    type: z.enum(TASK_TYPES).optional(),
  }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return { open: 0, dueToday: 0, overdue: 0, completed: 0, draftsPending: 0, snoozed: 0, aiOpen: 0 };
    await wakeSnoozedTasks(db, ctx.workspace.id);
    // The same scope as the list under these cards (R72), so they count it.
    const scopeOwner = taskScopeOwner(ctx, input?.mine);
    const rows = await db.select({ status: tasks.status, dueAt: tasks.dueAt, source: tasks.source, ownerUserId: tasks.ownerUserId }).from(tasks)
      .where(and(
        eq(tasks.workspaceId, ctx.workspace.id),
        scopeOwner !== null ? eq(tasks.ownerUserId, scopeOwner) : undefined,
        input?.type ? eq(tasks.type, input.type) : undefined,
      ));
    const now = Date.now();
    // "Today" as the WORKSPACE reads it. This was `setHours(23,59,59,999)` on a
    // bare Date — the container's day, i.e. UTC — so a task due at 8pm Eastern
    // fell into tomorrow and the Tasks header undercounted "due today" every
    // evening. workspace_settings.timezone is the setting Settings promises
    // governs "activity timestamps"; see services/workspaceTimezone.ts. The
    // rule itself is @shared/taskRules, which both task pages read too (R72).
    const tz = await getWorkspaceTimezone(ctx.workspace.id);
    const s = { open: 0, dueToday: 0, overdue: 0, completed: 0, draftsPending: 0, snoozed: 0, aiOpen: 0 };
    for (const r of rows) {
      if (r.status === "done") s.completed++;
      else if (r.status === "draft") s.draftsPending++;
      else if (r.status === "snoozed") s.snoozed++;
      else if (r.status === "open" || r.status === "in_progress") {
        s.open++;
        if (r.source === "ai") s.aiOpen++;
        const due = taskDueState(r.dueAt, now, tz);
        if (due === "overdue") s.overdue++;
        else if (due === "today") s.dueToday++;
      }
    }
    return s;
  }),

  /* ── Task Autopilot (AI) ──────────────────────────────────────────────── */

  /** Run the AI autopilot on-demand for this workspace. Default → draft (review). */
  generateDrafts: repProcedure
    .input(z.object({ limit: z.number().int().min(1).max(25).optional(), mode: z.enum(["approval", "auto"]).optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const res = await generateTasksForWorkspace(ctx.workspace.id, {
        mode: input?.mode ?? "approval",
        limit: input?.limit ?? 10,
        ownerUserId: ctx.user.id,
      });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "task", entityId: 0, after: { op: "ai_generate", ...res } });
      return res;
    }),

  /** Approve a single AI draft → live open task. */
  approveDraft: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(tasks).set({ status: "open" } as never)
      .where(and(eq(tasks.id, input.id), eq(tasks.workspaceId, ctx.workspace.id), eq(tasks.status, "draft")));
    return { ok: true };
  }),

  /** Approve every pending AI draft in the workspace. */
  approveAllDrafts: repProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const r = await db.update(tasks).set({ status: "open" } as never)
      .where(and(eq(tasks.workspaceId, ctx.workspace.id), eq(tasks.status, "draft")));
    const approved = affectedRowsOf(r);
    return { approved };
  }),

  /** Dismiss an AI draft (→ cancelled, kept for audit). */
  dismissDraft: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(tasks).set({ status: "cancelled" } as never)
      .where(and(eq(tasks.id, input.id), eq(tasks.workspaceId, ctx.workspace.id), eq(tasks.status, "draft")));
    return { ok: true };
  }),

  /** Read the workspace's Task Autopilot config. */
  getAutopilotSettings: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { mode: "off" as const, dailyCap: 25, autoTaskDailyCap: 25, lastRunAt: null as Date | null };
    const [row] = await db.select({
      mode: workspaceSettings.taskAutopilotMode,
      dailyCap: workspaceSettings.taskAutopilotDailyCap,
      // Each other auto-task source's daily cap (audit L15).
      autoTaskDailyCap: workspaceSettings.autoTaskDailyCap,
      lastRunAt: workspaceSettings.taskAutopilotLastRunAt,
    }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
    return row ?? { mode: "off" as const, dailyCap: 25, autoTaskDailyCap: 25, lastRunAt: null };
  }),

  /** Set the workspace's Task Autopilot mode / daily cap (admin only). */
  setAutopilotSettings: adminWsProcedure
    .input(z.object({
      mode: z.enum(["off", "approval", "auto"]).optional(),
      dailyCap: z.number().int().min(1).max(500).optional(),
      /** The other auto-task sources' cap a day each (L15); 0 stops them filing. */
      autoTaskDailyCap: z.number().int().min(0).max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const set: any = {};
      if (input.mode !== undefined) set.taskAutopilotMode = input.mode;
      if (input.dailyCap !== undefined) set.taskAutopilotDailyCap = input.dailyCap;
      if (input.autoTaskDailyCap !== undefined) set.autoTaskDailyCap = input.autoTaskDailyCap;
      if (Object.keys(set).length === 0) return { ok: true };
      await db.insert(workspaceSettings)
        .values({ workspaceId: ctx.workspace.id, ...set } as never)
        .onDuplicateKeyUpdate({ set });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "task_autopilot_settings", entityId: ctx.workspace.id, after: input });
      return { ok: true };
    }),
});

/* ─── Activities (timeline) ──────────────────────────────────────────── */

const MENTION_RE = /@\[([^\]]+)\]\(user:(\d+)\)/g;

export const activitiesRouter = router({
  list: workspaceProcedure
    .input(z.object({ relatedType: z.string(), relatedId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(activities)
        .where(and(eq(activities.workspaceId, ctx.workspace.id), eq(activities.relatedType, input.relatedType), eq(activities.relatedId, input.relatedId)))
        .orderBy(desc(activities.occurredAt))
        .limit(80);
    }),

  logCall: repProcedure
    .input(z.object({
      relatedType: z.string(),
      relatedId: z.number(),
      disposition: z.enum(["connected", "voicemail", "no_answer", "bad_number", "gatekeeper", "callback_requested", "not_interested"]),
      durationSec: z.number().int().min(0).default(0),
      outcome: z.string().optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // On a record of this workspace (audit 2026-10-20, X1.1): another's id
      // put the call on that tenant's timeline.
      await assertRecordInWorkspace(db, input.relatedType, input.relatedId, ctx.workspace.id);
      await db.insert(activities).values({
        workspaceId: ctx.workspace.id,
        type: "call",
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        subject: `Call — ${input.disposition.replace(/_/g, " ")}`,
        body: input.notes,
        callDisposition: input.disposition,
        callDurationSec: input.durationSec,
        callOutcome: input.outcome,
        actorUserId: ctx.user.id,
      });
      return { ok: true };
    }),

  logMeeting: repProcedure
    .input(z.object({
      relatedType: z.string(),
      relatedId: z.number(),
      subject: z.string().min(1),
      startedAt: z.string().optional(),
      endedAt: z.string().optional(),
      attendees: z.array(z.string()).optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await assertRecordInWorkspace(db, input.relatedType, input.relatedId, ctx.workspace.id);
      await db.insert(activities).values({
        workspaceId: ctx.workspace.id,
        type: "meeting",
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        subject: input.subject,
        body: input.notes,
        meetingStartedAt: input.startedAt ? new Date(input.startedAt) : new Date(),
        meetingEndedAt: input.endedAt ? new Date(input.endedAt) : null,
        meetingAttendees: input.attendees ?? [],
        actorUserId: ctx.user.id,
      });
      return { ok: true };
    }),

  /** Add a free-text note. Parses @[Name](user:ID) mentions and sends notifications. */
  addNote: repProcedure
    .input(z.object({
      relatedType: z.string(),
      relatedId: z.number(),
      body: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      await assertRecordInWorkspace(db, input.relatedType, input.relatedId, ctx.workspace.id);
      const mentioned: number[] = [];
      let m: RegExpExecArray | null;
      const re = new RegExp(MENTION_RE);
      while ((m = re.exec(input.body)) !== null) {
        const uid = Number(m[2]);
        if (Number.isFinite(uid) && !mentioned.includes(uid)) mentioned.push(uid);
      }

      await db.insert(activities).values({
        workspaceId: ctx.workspace.id,
        type: "note",
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        subject: "Note",
        body: input.body,
        mentions: mentioned,
        actorUserId: ctx.user.id,
      });

      // Only teammates here are told (X1.1), as crmNotes.create does: a
      // mention of another workspace's user id notified them of this note.
      const here = await activeMemberIds(ctx.workspace.id, mentioned);
      for (const uid of mentioned) {
        if (uid === ctx.user.id || !here.has(uid)) continue;
        await db.insert(notifications).values({
          workspaceId: ctx.workspace.id,
          userId: uid,
          kind: "mention",
          title: `${ctx.user.name ?? "Someone"} mentioned you`,
          body: input.body.slice(0, 240),
          relatedType: input.relatedType,
          relatedId: input.relatedId,
        });
      }
      return { ok: true, mentioned };
    }),

  /**
   * Remove one activity from a record's timeline.
   *
   * The RecordDrawer timeline has always shown a delete control for each
   * activity; it called `activities.delete`, which did not exist. tRPC builds
   * procedure paths at runtime, so it type-errored but compiled, and every
   * confirmed delete returned NOT_FOUND to the user.
   *
   * Audited, unlike the neighbouring logCall/logMeeting/addNote writes: those
   * record that something happened, and this erases that record. A timeline a
   * rep can quietly edit is worth less than one they cannot.
   */
  delete: repProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [row] = await db
        .select({ id: activities.id, type: activities.type, relatedType: activities.relatedType, relatedId: activities.relatedId })
        .from(activities)
        .where(and(eq(activities.id, input.id), eq(activities.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "That activity no longer exists." });
      await db.delete(activities).where(and(eq(activities.id, input.id), eq(activities.workspaceId, ctx.workspace.id)));
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "delete",
        entityType: "activity",
        entityId: input.id,
        before: { type: row.type, relatedType: row.relatedType, relatedId: row.relatedId },
      });
      return { ok: true };
    }),
});

/* ─── Attachments (S3 via storagePut) ────────────────────────────────── */

export const attachmentsRouter = router({
  list: workspaceProcedure
    .input(z.object({ relatedType: z.string(), relatedId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(attachments)
        .where(and(eq(attachments.workspaceId, ctx.workspace.id), eq(attachments.relatedType, input.relatedType), eq(attachments.relatedId, input.relatedId)))
        .orderBy(desc(attachments.createdAt));
    }),

  upload: repProcedure
    .input(z.object({
      relatedType: z.string(),
      relatedId: z.number(),
      fileName: z.string().min(1).max(255),
      /** Ignored (R100): the server decides the type from the file itself. */
      mimeType: z.string().optional(),
      // raw base64 (no data: prefix). Capped here (R100): the only limit was
      // the browser's, and the API took a file as large as the body parser.
      base64: z.string().min(1).max(ATTACHMENT_MAX_BASE64, "Files must be under 8 MB"),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Attached to a record of this workspace (X1.1).
      await assertRecordInWorkspace(db, input.relatedType, input.relatedId, ctx.workspace.id);
      const buf = Buffer.from(input.base64, "base64");
      if (buf.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "The file is empty." });
      if (buf.length > ATTACHMENT_MAX_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Files must be under 8 MB." });
      const type = attachmentType(input.fileName, buf);
      if (!type.ok) throw new TRPCError({ code: "BAD_REQUEST", message: type.reason });
      const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const key = `ws-${ctx.workspace.id}/${input.relatedType}-${input.relatedId}/${Date.now()}-${safeName}`;
      const put = await storagePut(key, buf, type.mimeType);
      const r = await db.insert(attachments).values({
        workspaceId: ctx.workspace.id,
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        fileKey: put.key,
        url: put.url,
        fileName: input.fileName,
        mimeType: type.mimeType,
        sizeBytes: buf.length,
        uploadedByUserId: ctx.user.id,
      });
      return { id: Number((r as any)[0]?.insertId ?? 0), url: put.url, key: put.key };
    }),

  /**
   * Remove an attachment record. Audited since 2026-10-30, for the same reason
   * `tasks.delete` above is: it is a hard delete a rep can call, and it was the
   * second unaudited one in this file. `activities.delete` already did this
   * correctly, which is the pattern both now follow.
   *
   * The whole row goes in `before` — there is no blob column, only metadata —
   * so the entry says which file was removed, what it was attached to and who
   * uploaded it. None of that is recoverable afterwards.
   *
   * The stored file goes too (R100). It used to stay where it was, reachable
   * by `url` after its attachment was deleted. It is erased FIRST, and when
   * that fails nothing is deleted, so a record never outlives its file the
   * other way round either and the delete can be tried again.
   */
  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    // Written out for the same reason as tasks.delete above.
    const [doomed] = await db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, input.id), eq(attachments.workspaceId, ctx.workspace.id)))
      .limit(1);
    if (!doomed) return { ok: true };
    if (doomed.fileKey) {
      try {
        await storageErase(doomed.fileKey);
      } catch (e) {
        console.error(`[attachments.delete] erasing ${doomed.fileKey} failed:`, e);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't remove the file from storage, so nothing was deleted. Try again." });
      }
    }
    await db.delete(attachments).where(and(eq(attachments.id, input.id), eq(attachments.workspaceId, ctx.workspace.id)));
    await recordAudit({
      workspaceId: ctx.workspace.id,
      actorUserId: ctx.user.id,
      action: "delete",
      entityType: "attachment",
      entityId: input.id,
      before: doomed,
    });
    return { ok: true };
  }),
});
