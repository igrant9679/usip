/**
 * meetings router — the /v2/meetings CRM surface + AI meeting scheduler.
 *
 * A meeting is a first-class object (drizzle `meetings`), distinct from raw
 * calendarEvents. The AI proposes meetings (status 'proposed' with candidate
 * times + a drafted invite); approving one books it — sending a real calendar
 * invite when the owner has a connected calendar (via meetingScheduler), else
 * recording it locally. The autopilot mode (off/approval/auto) lives on
 * workspace_settings and governs autonomous proposing + sending.
 */
import { TRPCError } from "@trpc/server";
import { activeTaskStatuses } from "@shared/taskStatus";
import { and, desc, eq, gt, inArray, isNull, like, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { calendarAccounts, calendarEvents, meetings, prospects, tasks, users, workspaceMembers, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { recordAudit } from "../audit";
import { activeMemberIds } from "../_core/activeMembers";
import { router } from "../_core/trpc";
import { adminWsProcedure, repProcedure, workspaceProcedure } from "../_core/workspace";
import { proposeMeetingForProspect, regenerateMeetingProposal, regenerateProposalsNotSince, regenerateStaleProposals, runMeetingAutopilotForWorkspace, sendMeetingInvite, startsInProposalWindow } from "../services/meetingScheduler";
import { getWorkspaceTimezone } from "../services/workspaceTimezone";
import { MEETING_STATUSES, remindableMeetingStatuses } from "@shared/meetingStatus";

// Was a fourth hand-written copy of the enum, for this router's z.enum(). The
// anti-drift scanner found it on its first run — exactly as the task-status
// guard turned up activities.ts (9f2e78f). Repointed at the shared definition,
// which is a const tuple so z.enum() takes it directly.

/**
 * Create a recovery task for a meeting that didn't happen.
 *
 * Was inline in the no-show branch only. A cancelled meeting got nothing at
 * all — no task, no notification, no re-engagement — even though a cancel is
 * usually "not right now" rather than "not interested", so it's often the more
 * recoverable of the two. Shared so both paths behave the same and neither can
 * drift again.
 *
 * Deduped per linked record so repeated cancels don't pile up tasks. Returns
 * the new task id, or null if one already existed / there was nothing to link.
 * Never throws: losing the rebound task must not fail the status update the
 * user actually asked for.
 */
async function createMeetingReboundTask(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  workspaceId: number,
  m: typeof meetings.$inferSelect,
  kind: "no_show" | "cancelled",
): Promise<number | null> {
  try {
    const name = m.contactName?.trim() || "the prospect";
    const prefix = kind === "no_show" ? "Re-book no-show" : "Re-book cancelled meeting";
    if (m.relatedType && m.relatedId) {
      const existing = await db.select({ id: tasks.id }).from(tasks).where(and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.relatedType, m.relatedType),
        eq(tasks.relatedId, m.relatedId),
        like(tasks.title, `${prefix}:%`),
        inArray(tasks.status, activeTaskStatuses()),
      )).limit(1);
      if (existing.length > 0) return null;
    }
    const description = kind === "no_show"
      ? `${name} didn't attend "${m.title}". Reach out to reschedule — share your booking link so they can self-book a new time.`
      : `${name} cancelled "${m.title}". Follow up to find a better time — share your booking link so they can self-book.`;
    const ins = await db.insert(tasks).values({
      workspaceId,
      title: `${prefix}: ${name}`.slice(0, 240),
      description,
      type: "follow_up",
      priority: "high",
      status: "open",
      dueAt: new Date(Date.now() + 86400000),
      ownerUserId: m.ownerUserId ?? null,
      relatedType: m.relatedType ?? null,
      relatedId: m.relatedId ?? null,
      source: "ai",
      aiReasoning: kind === "no_show"
        ? "Auto-created after a no-show to recover the meeting."
        : "Auto-created after a cancellation to recover the meeting.",
      aiConfidence: 90,
    } as never);
    return Number((ins as any)[0]?.insertId ?? 0) || null;
  } catch (e) {
    console.error(`[meetings] ${kind} rebound task failed:`, (e as Error).message);
    return null;
  }
}

export const meetingsRouter = router({
  list: workspaceProcedure
    .input(z.object({
      status: z.enum(MEETING_STATUSES).optional(),
      ownerOnly: z.boolean().optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      let rows = await db.select().from(meetings)
        .where(eq(meetings.workspaceId, ctx.workspace.id))
        .orderBy(desc(meetings.createdAt));
      if (input?.status) rows = rows.filter((m) => m.status === input.status);
      if (input?.ownerOnly) rows = rows.filter((m) => m.ownerUserId === ctx.user.id);
      // The reply that produced each meeting (emailReplies.meetingId is set
      // when a positive reply's action books one). A meeting with no way back
      // to the conversation was one of the audit's missing next-step links.
      const { emailReplies } = await import("../../drizzle/schema");
      const { inArray: inArr } = await import("drizzle-orm");
      const ids = rows.map((m) => m.id);
      const sourceByMeeting = new Map<number, number>();
      if (ids.length > 0) {
        const links = await db.select({ id: emailReplies.id, meetingId: emailReplies.meetingId })
          .from(emailReplies)
          .where(and(eq(emailReplies.workspaceId, ctx.workspace.id), inArr(emailReplies.meetingId, ids)));
        for (const l of links) if (l.meetingId && !sourceByMeeting.has(l.meetingId)) sourceByMeeting.set(l.meetingId, l.id);
      }
      return rows.map((m) => ({ ...m, sourceReplyId: sourceByMeeting.get(m.id) ?? null }));
    }),

  stats: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { proposed: 0, upcoming: 0, completed: 0, noShow: 0, booked: 0 };
    const rows = await db.select({ status: meetings.status, scheduledAt: meetings.scheduledAt })
      .from(meetings).where(eq(meetings.workspaceId, ctx.workspace.id));
    const now = Date.now();
    const s = { proposed: 0, upcoming: 0, completed: 0, noShow: 0, booked: 0 };
    for (const r of rows) {
      if (r.status === "proposed") s.proposed++;
      else if (r.status === "completed") s.completed++;
      else if (r.status === "no_show") s.noShow++;
      // Booked = accepted (or agreed); an invite awaiting an answer is upcoming
      // but not booked (owner ask 2026-09-24).
      if (r.status === "scheduled" || r.status === "rescheduled") s.booked++;
      if ((r.status === "scheduled" || r.status === "rescheduled" || r.status === "invited")
        && r.scheduledAt && new Date(r.scheduledAt).getTime() >= now) s.upcoming++;
    }
    return s;
  }),

  /** AI-draft a meeting proposal for one prospect. */
  propose: repProcedure
    .input(z.object({ relatedId: z.number(), relatedType: z.string().default("prospect") }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [p] = await db.select().from(prospects)
        .where(and(eq(prospects.id, input.relatedId), eq(prospects.workspaceId, ctx.workspace.id)));
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Prospect not found" });
      if (!p.email?.trim()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This prospect has no email address, so a meeting invite can't be sent. Add one first." });
      }
      const id = await proposeMeetingForProspect(ctx.workspace.id, p as any, ctx.user.id, "manual");
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not draft meeting" });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "propose", entityType: "meeting", entityId: id, after: { relatedId: input.relatedId } });
      return { id };
    }),

  /**
   * On-demand: propose meetings for the best-fit prospects. Every find is a
   * reviewable proposal: meeting proposals are approval-only (owner ask
   * 2026-09-24, which replaced the 2026-08-26 ask that made this button send
   * in 'auto'). Nothing here sends.
   */
  generateProposals: repProcedure
    .input(z.object({ limit: z.number().int().min(1).max(20).optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      // Honours the workspace's mode like the 45-minute cron: in Autonomous
      // what the button finds is sent at once (every send guard still
      // applies); in Approve it waits for approval.
      const db = await getDb();
      const [s] = db ? await db.select({ mode: workspaceSettings.meetingAutopilotMode })
        .from(workspaceSettings).where(eq(workspaceSettings.workspaceId, ctx.workspace.id)).limit(1) : [];
      const send = s?.mode === "auto";
      const res = await runMeetingAutopilotForWorkspace(ctx.workspace.id, input?.limit ?? 8, ctx.user.id, { send });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "ai_generate", entityType: "meeting", entityId: 0, after: { ...res, send } });
      return { ...res, send };
    }),

  /**
   * Edit a proposal before approving it (owner ask 2026-09-24: proposals
   * "should require approval and/or edits"). Title, invite text and offered
   * times; only an open proposal without an agreed time. Offered times must
   * all be in the future, deduped and sorted, at most five. The invite text
   * is what the calendar invite carries when it is approved.
   */
  updateProposal: repProcedure
    .input(z.object({
      id: z.number(),
      title: z.string().trim().min(1).max(240).optional(),
      inviteMessage: z.string().trim().min(1).max(1500).optional(),
      proposedTimes: z.array(z.string().datetime()).min(1).max(5).optional(),
      /** Alternate join link (Zoom, Meet, …); "" clears it, and the invite then carries a Teams link. */
      meetingUrl: z.union([z.string().trim().url().max(1000).refine((u) => /^https:\/\//i.test(u), "Use an https:// meeting link"), z.literal("")]).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [m] = await db.select({ status: meetings.status, scheduledAt: meetings.scheduledAt }).from(meetings)
        .where(and(eq(meetings.workspaceId, ctx.workspace.id), eq(meetings.id, input.id))).limit(1);
      if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found." });
      if (m.status !== "proposed" || m.scheduledAt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Only an open proposal can be edited." });
      }
      const set: Record<string, unknown> = {};
      if (input.title !== undefined) set.title = input.title;
      if (input.inviteMessage !== undefined) set.inviteMessage = input.inviteMessage;
      if (input.meetingUrl !== undefined) set.meetingUrl = input.meetingUrl === "" ? null : input.meetingUrl;
      if (input.proposedTimes !== undefined) {
        const nowMs = Date.now();
        const times = Array.from(new Set(input.proposedTimes.map((t) => new Date(t).toISOString()))).sort();
        if (times.some((t) => new Date(t).getTime() <= nowMs)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Every offered time must be in the future." });
        }
        // The same window sending enforces: a time saved outside it could
        // never be sent.
        const tz = await getWorkspaceTimezone(ctx.workspace.id);
        if (times.some((t) => !startsInProposalWindow(t, tz))) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Every offered time must start between 9:00 AM and 4:00 PM ${tz.replace(/_/g, " ")} time.` });
        }
        set.proposedTimes = times;
      }
      if (Object.keys(set).length === 0) return { ok: true };
      await db.update(meetings).set(set as never)
        .where(and(eq(meetings.workspaceId, ctx.workspace.id), eq(meetings.id, input.id)));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "meeting", entityId: input.id, after: { edited: Object.keys(set) } });
      return { ok: true };
    }),

  /**
   * Who can own a proposal, and what an invite would send from: the
   * workspace's active members, each with the calendar sendMeetingInvite
   * would use (the owner's first connected one). Only a Unipile-bridged
   * calendar (Microsoft 365) can generate the Teams link; a CalDAV one sends
   * without it. Owner ask 2026-09-24: CommunityForce's proposals should send
   * from Khaja Syed's calendar.
   */
  proposalOwners: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const members = await db.select({ userId: workspaceMembers.userId, name: users.name, email: users.email })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, ctx.workspace.id), isNull(workspaceMembers.deactivatedAt)));
    const cals = await db.select({ userId: calendarAccounts.userId, unipileAccountId: calendarAccounts.unipileAccountId })
      .from(calendarAccounts)
      .where(eq(calendarAccounts.workspaceId, ctx.workspace.id));
    return members.map((mb) => {
      const cal = cals.find((c) => c.userId === mb.userId);
      const calendar: "teams" | "no_teams" | "none" = !cal ? "none" : cal.unipileAccountId ? "teams" : "no_teams";
      return { userId: mb.userId, name: mb.name?.trim() || mb.email || `User ${mb.userId}`, calendar };
    });
  }),

  /**
   * Move open proposals to another member, so their invites send from THAT
   * member's calendar (sendMeetingInvite books on the owner's). `ids`
   * omitted = every open proposal in the workspace. Sends nothing and
   * rewrites nothing: the invite text never names the sender. updatedAt is
   * kept as it was, because a Regenerate all pass walks proposals by
   * updatedAt and would otherwise skip every row reassigned mid-pass.
   */
  reassignProposals: repProcedure
    .input(z.object({
      toUserId: z.number().int(),
      ids: z.array(z.number().int()).min(1).max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const active = await activeMemberIds(ctx.workspace.id, [input.toUserId]);
      if (!active.has(input.toUserId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Choose an active member of this workspace." });
      }
      const open = and(
        eq(meetings.workspaceId, ctx.workspace.id),
        eq(meetings.status, "proposed"),
        or(isNull(meetings.ownerUserId), ne(meetings.ownerUserId, input.toUserId)),
        input.ids ? inArray(meetings.id, input.ids) : undefined,
      );
      const rows = await db.select({ id: meetings.id, ownerUserId: meetings.ownerUserId }).from(meetings).where(open);
      if (rows.length === 0) return { reassigned: 0 };
      await db.update(meetings)
        .set({ ownerUserId: input.toUserId, updatedAt: sql`${meetings.updatedAt}` } as never)
        .where(and(open, inArray(meetings.id, rows.map((r) => r.id))));
      await recordAudit({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "meeting",
        entityId: rows.length === 1 ? rows[0].id : 0,
        before: { owners: rows.map((r) => ({ id: r.id, ownerUserId: r.ownerUserId })) },
        after: { reassignedTo: input.toUserId, count: rows.length },
      });
      return { reassigned: rows.length };
    }),

  /** Manually create a meeting (already agreed or being scheduled). */
  create: repProcedure
    .input(z.object({
      title: z.string().min(1),
      relatedType: z.string().optional(),
      relatedId: z.number().optional(),
      contactName: z.string().optional(),
      contactEmail: z.string().email().optional(),
      company: z.string().optional(),
      scheduledAt: z.string().optional(),
      durationMin: z.number().int().min(5).max(480).default(30),
      meetingUrl: z.string().optional(),
      location: z.string().optional(),
      inviteMessage: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
      const ins = await db.insert(meetings).values({
        workspaceId: ctx.workspace.id,
        ownerUserId: ctx.user.id,
        relatedType: input.relatedType ?? null,
        relatedId: input.relatedId ?? null,
        contactName: input.contactName ?? null,
        contactEmail: input.contactEmail ?? null,
        company: input.company ?? null,
        title: input.title,
        status: scheduledAt ? "scheduled" : "proposed",
        proposedTimes: scheduledAt ? [scheduledAt.toISOString()] : [],
        scheduledAt,
        durationMin: input.durationMin,
        meetingUrl: input.meetingUrl ?? null,
        location: input.location ?? null,
        inviteMessage: input.inviteMessage ?? null,
        source: "manual",
      } as never);
      const id = Number((ins as any)[0]?.insertId ?? 0);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "meeting", entityId: id, after: input });
      return { id };
    }),

  /** Approve a proposal & book it — sends the calendar invite when possible. */
  approveAndSend: repProcedure
    .input(z.object({ id: z.number(), chosenTime: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const res = await sendMeetingInvite(ctx.workspace.id, input.id, input.chosenTime);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "book", entityType: "meeting", entityId: input.id, after: res });
      return res;
    }),

  /**
   * Approve & send EVERY pending proposal (owner ask 2026-09-08: "approve
   * all" on every approvals screen). Each one books its earliest FUTURE
   * slot — the same default the single approve uses when no time is chosen —
   * so a proposal whose times have all passed is skipped and reported, not
   * silently booked in the past. Bounded at 50 per call; each send is
   * audited exactly like a single approve.
   */
  approveAllProposed: repProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const rows = await db.select({ id: meetings.id }).from(meetings)
      .where(and(eq(meetings.workspaceId, ctx.workspace.id), eq(meetings.status, "proposed")))
      .orderBy(desc(meetings.createdAt)).limit(50);
    let sent = 0;
    const skipped: Record<string, number> = {};
    for (const m of rows) {
      try {
        const res = await sendMeetingInvite(ctx.workspace.id, m.id);
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "meeting", entityId: m.id, after: { ...res, bulk: true, book: true } });
        if (res.sent) sent++; else { const k = res.reason ?? "unknown"; skipped[k] = (skipped[k] ?? 0) + 1; }
      } catch (e) {
        const k = (e as Error).message || "error"; skipped[k] = (skipped[k] ?? 0) + 1;
      }
    }
    return { sent, attempted: rows.length, skipped };
  }),

  /**
   * Fresh times + fresh invite for one stale proposal, in place (owner ask
   * 2026-09-20 — four surfaces promised this button before it existed). The
   * autopilot also regenerates stale proposals unattended each tick.
   */
  regenerateProposal: repProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const res = await regenerateMeetingProposal(ctx.workspace.id, input.id);
      if (!res.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: res.reason === "not_a_proposal" ? "Only proposals can be regenerated." : "Proposal not found.",
        });
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "meeting", entityId: input.id, after: { regenerated: true } });
      return { ok: true };
    }),

  /**
   * Every OUTDATED proposal in the queue — times all past, or any time outside
   * the 9:00–16:00 window — freshened, whatever its source (the button is
   * attended; owner ask 2026-09-24). Bounded at 10 per click so a pass of LLM
   * drafts finishes well inside the client's request timeout; `remaining`
   * tells the page whether to offer another pass. Never sends anything.
   */
  regenerateAllOutdated: repProcedure.mutation(async ({ ctx }) => {
    const res = await regenerateStaleProposals(ctx.workspace.id, 10, { anySource: true });
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "meeting", entityId: 0, after: { regenerateAllOutdated: res.regenerated, remaining: res.remaining } });
    return res;
  }),

  /**
   * Rewrite every open proposal — times AND invite text — with the current
   * brand profile, 10 per call (owner ask 2026-09-24). The first call anchors
   * the pass (`since` omitted = now on the server, whose clock the rows'
   * updatedAt shares far better than the browser's) and returns it; the page
   * sends it back until `remaining` is 0. Overwrites edits. Never sends.
   */
  regenerateAllProposals: repProcedure
    .input(z.object({ since: z.string().datetime().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const since = input?.since ? new Date(input.since) : new Date();
      const res = await regenerateProposalsNotSince(ctx.workspace.id, since, 10);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "meeting", entityId: 0, after: { regenerateAllProposals: res.regenerated, remaining: res.remaining } });
      return { ...res, since: since.toISOString() };
    }),

  reschedule: repProcedure
    .input(z.object({ id: z.number(), scheduledAt: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      /**
       * `reminderSentAt` is cleared, because it records "we have reminded them
       * about THIS meeting" and the meeting has just moved. Left stamped, the
       * attendee got a reminder for the time they abandoned and none for the
       * time they chose — the reminder cron only ever considers rows where it
       * is NULL. A state transition that changes the date has to reset what was
       * said about the old one.
       */
      await db.update(meetings).set({
        status: "rescheduled",
        scheduledAt: new Date(input.scheduledAt),
        reminderSentAt: null,
      } as never)
        .where(and(eq(meetings.id, input.id), eq(meetings.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  complete: repProcedure
    .input(z.object({ id: z.number(), disposition: z.string().max(48).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const status = input.disposition === "no_show" ? "no_show" : "completed";
      const [m] = await db.select().from(meetings)
        .where(and(eq(meetings.id, input.id), eq(meetings.workspaceId, ctx.workspace.id)));
      if (!m) throw new TRPCError({ code: "NOT_FOUND" });
      await db.update(meetings).set({ status, disposition: input.disposition ?? null } as never)
        .where(and(eq(meetings.id, input.id), eq(meetings.workspaceId, ctx.workspace.id)));

      const reboundTaskId = status === "no_show"
        ? await createMeetingReboundTask(db, ctx.workspace.id, m, "no_show")
        : null;
      return { ok: true, reboundTaskId };
    }),

  cancel: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [m] = await db.select().from(meetings)
      .where(and(eq(meetings.id, input.id), eq(meetings.workspaceId, ctx.workspace.id)));
    if (!m) throw new TRPCError({ code: "NOT_FOUND" });
    await db.update(meetings).set({ status: "cancelled" } as never)
      .where(and(eq(meetings.id, input.id), eq(meetings.workspaceId, ctx.workspace.id)));

    // A cancelled meeting used to be three lines that set a status and nothing
    // else — while a no-show, twenty lines above, got an automatic recovery
    // task. So a prospect who silently didn't turn up was chased and one who
    // actively cancelled (often meaning "not this time", i.e. still
    // interested) just vanished. Same rebound treatment now.
    const reboundTaskId = await createMeetingReboundTask(db, ctx.workspace.id, m, "cancelled");
    return { ok: true, reboundTaskId };
  }),

  /**
   * Take booked meetings out of Velocity (owner ask 2026-09-24, after a bulk
   * approve booked 33 CommunityForce prospects into one 2 PM slot: "remove
   * any booked meetings from velocity. I'll remove [them] from his outlook
   * calendar"). Marks each cancelled and drops Velocity's stored copy of the
   * calendar event. Never touches the provider calendar: deleting the event
   * there is what emails each attendee a cancellation, so that stays the
   * calendar owner's call. No rebound task: a cleanup, not a prospect
   * cancelling. `ids` omitted = every upcoming booked meeting in the
   * workspace. Dry run by default.
   */
  removeBookings: adminWsProcedure
    .input(z.object({
      ids: z.array(z.number().int()).min(1).max(500).optional(),
      dryRun: z.boolean().default(true),
    }).optional())
    .mutation(async ({ ctx, input }) => {
      const dryRun = input?.dryRun ?? true;
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const ws = ctx.workspace.id;
      const booked = and(
        eq(meetings.workspaceId, ws),
        inArray(meetings.status, remindableMeetingStatuses()),
        // Upcoming only: a past meeting still marked scheduled is history (LSI
        // had four from July and August), not part of any pile-up.
        gt(meetings.scheduledAt, new Date()),
        input?.ids ? inArray(meetings.id, input.ids) : undefined,
      );
      const rows = await db.select({
        id: meetings.id, status: meetings.status, calendarEventId: meetings.calendarEventId,
        contactName: meetings.contactName, scheduledAt: meetings.scheduledAt,
      }).from(meetings).where(booked);
      const listed = rows.map((r) => ({ id: r.id, contactName: r.contactName, scheduledAt: r.scheduledAt }));
      if (dryRun || rows.length === 0) return { dryRun, removed: 0, meetings: listed };
      const ids = rows.map((r) => r.id);
      const eventIds = rows.map((r) => r.calendarEventId).filter((x): x is number => typeof x === "number" && x > 0);
      if (eventIds.length > 0) {
        await db.delete(calendarEvents).where(and(eq(calendarEvents.workspaceId, ws), inArray(calendarEvents.id, eventIds)));
      }
      await db.update(meetings)
        .set({ status: "cancelled", calendarEventId: null } as never)
        .where(and(booked, inArray(meetings.id, ids)));
      await recordAudit({
        workspaceId: ws, actorUserId: ctx.user.id, action: "update", entityType: "meeting", entityId: 0,
        before: { meetings: rows.map((r) => ({ id: r.id, status: r.status, calendarEventId: r.calendarEventId })) },
        after: { removedFromVelocity: ids.length, status: "cancelled", providerCalendarTouched: false },
      });
      return { dryRun, removed: ids.length, meetings: listed };
    }),

  /**
   * Undo the ARE "meeting booked" effects of invites nobody accepted (owner
   * ask 2026-09-24): restores the sequence, revives the steps the fake
   * booking skipped (spaced, never a burst), corrects the campaign count and
   * deletes the signal. Reports, never deletes, the CRM records it created.
   * Dry run by default. See services/are/undoInviteBookings.
   */
  undoInviteBookingSignals: adminWsProcedure
    .input(z.object({ dryRun: z.boolean().default(true) }).optional())
    .mutation(async ({ ctx, input }) => {
      const { undoInviteBookingSignals } = await import("../services/are/undoInviteBookings");
      const res = await undoInviteBookingSignals(ctx.workspace.id, { dryRun: input?.dryRun ?? true });
      if (!res.dryRun && res.undone > 0) {
        await recordAudit({
          workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "are_signal", entityId: 0,
          before: { signals: res.rows.map((r) => ({ signalId: r.signalId, prospectQueueId: r.prospectQueueId, campaignId: r.campaignId, statusBefore: r.statusBefore })) },
          after: { undoneMeetingBooked: res.undone, statusesRestored: res.rows.filter((r) => r.restoresStatus).length, stepsRevived: res.rows.reduce((a, r) => a + r.stepsRevived, 0) },
        });
      }
      return res;
    }),

  /** Dismiss (delete) an unbooked AI proposal. */
  dismissProposal: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(meetings)
      .where(and(eq(meetings.id, input.id), eq(meetings.workspaceId, ctx.workspace.id), eq(meetings.status, "proposed")));
    return { ok: true };
  }),

  getAutopilotSettings: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { mode: "off" as const, dailyCap: 10, lastRunAt: null as Date | null, proposalOwnerUserId: null as number | null };
    const [row] = await db.select({
      mode: workspaceSettings.meetingAutopilotMode,
      dailyCap: workspaceSettings.meetingAutopilotDailyCap,
      lastRunAt: workspaceSettings.meetingAutopilotLastRunAt,
      proposalOwnerUserId: workspaceSettings.meetingProposalOwnerUserId,
    }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
    if (!row) return { mode: "off" as const, dailyCap: 10, lastRunAt: null, proposalOwnerUserId: null };
    return { ...row, mode: row.mode as "off" | "approval" | "auto" };
  }),

  /**
   * Off, Approve or Autonomous. Autonomous was removed and restored on
   * 2026-09-24 (owner: "I want to turn that on for meeting proposals"): it
   * sends each NEW proposal's invite as soon as it is drafted; proposals
   * already waiting in the queue still need Approve & send.
   */
  setAutopilotSettings: adminWsProcedure
    .input(z.object({ mode: z.enum(["off", "approval", "auto"]), dailyCap: z.number().int().min(1).max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const set: any = { meetingAutopilotMode: input.mode };
      if (input.dailyCap !== undefined) set.meetingAutopilotDailyCap = input.dailyCap;
      await db.insert(workspaceSettings)
        .values({ workspaceId: ctx.workspace.id, ...set } as never)
        .onDuplicateKeyUpdate({ set });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "meeting_autopilot_settings", entityId: ctx.workspace.id, after: input });
      return { ok: true };
    }),

  /**
   * Who owns every NEW proposal (owner ask 2026-09-24), so its invite sends
   * from that member's calendar; null = each prospect's rep. Applied in
   * createMeetingProposal, the one path every proposal takes. Existing
   * proposals are not moved: that is reassignProposals.
   */
  setProposalOwner: adminWsProcedure
    .input(z.object({ userId: z.number().int().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      if (input.userId !== null) {
        const active = await activeMemberIds(ctx.workspace.id, [input.userId]);
        if (!active.has(input.userId)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Choose an active member of this workspace." });
        }
      }
      const set = { meetingProposalOwnerUserId: input.userId };
      await db.insert(workspaceSettings)
        .values({ workspaceId: ctx.workspace.id, ...set } as never)
        .onDuplicateKeyUpdate({ set });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "meeting_autopilot_settings", entityId: ctx.workspace.id, after: { proposalOwnerUserId: input.userId } });
      return { ok: true };
    }),
});
