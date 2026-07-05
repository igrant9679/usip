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
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { z } from "zod";
import { meetings, prospects, tasks, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { recordAudit } from "../audit";
import { router } from "../_core/trpc";
import { adminWsProcedure, repProcedure, workspaceProcedure } from "../_core/workspace";
import { proposeMeetingForProspect, runMeetingAutopilotForWorkspace, sendMeetingInvite } from "../services/meetingScheduler";

const MEETING_STATUSES = ["proposed", "invited", "scheduled", "completed", "no_show", "cancelled", "rescheduled"] as const;

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
      return rows;
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
      if (r.status === "scheduled" || r.status === "invited") {
        s.booked++;
        if (r.scheduledAt && new Date(r.scheduledAt).getTime() >= now) s.upcoming++;
      }
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
      const id = await proposeMeetingForProspect(ctx.workspace.id, p as any, ctx.user.id, "manual");
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not draft meeting" });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "propose", entityType: "meeting", entityId: id, after: { relatedId: input.relatedId } });
      return { id };
    }),

  /** On-demand: propose meetings for the best-fit prospects (approval — never auto-sends). */
  generateProposals: repProcedure
    .input(z.object({ limit: z.number().int().min(1).max(20).optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const res = await runMeetingAutopilotForWorkspace(ctx.workspace.id, "approval", input?.limit ?? 8, ctx.user.id);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "ai_generate", entityType: "meeting", entityId: 0, after: res });
      return res;
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

  reschedule: repProcedure
    .input(z.object({ id: z.number(), scheduledAt: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(meetings).set({ status: "rescheduled", scheduledAt: new Date(input.scheduledAt) } as never)
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

      // No-show rebound: autonomously create a high-priority re-engagement task so
      // a missed meeting is recovered (reach out + share the booking link to
      // self-rebook) rather than silently lost. Deduped per linked record.
      let reboundTaskId: number | null = null;
      if (status === "no_show") {
        try {
          const name = m.contactName?.trim() || "the prospect";
          let already = false;
          if (m.relatedType && m.relatedId) {
            const existing = await db.select({ id: tasks.id }).from(tasks).where(and(
              eq(tasks.workspaceId, ctx.workspace.id),
              eq(tasks.relatedType, m.relatedType),
              eq(tasks.relatedId, m.relatedId),
              like(tasks.title, "Re-book no-show:%"),
              inArray(tasks.status, ["open", "draft", "in_progress", "snoozed"]),
            )).limit(1);
            already = existing.length > 0;
          }
          if (!already) {
            const ins = await db.insert(tasks).values({
              workspaceId: ctx.workspace.id,
              title: `Re-book no-show: ${name}`.slice(0, 240),
              description: `${name} didn't attend "${m.title}". Reach out to reschedule — share your booking link so they can self-book a new time.`,
              type: "follow_up",
              priority: "high",
              status: "open",
              dueAt: new Date(Date.now() + 86400000),
              ownerUserId: m.ownerUserId ?? null,
              relatedType: m.relatedType ?? null,
              relatedId: m.relatedId ?? null,
              source: "ai",
              aiReasoning: "Auto-created after a no-show to recover the meeting.",
              aiConfidence: 90,
            } as never);
            reboundTaskId = Number((ins as any)[0]?.insertId ?? 0) || null;
          }
        } catch (e) {
          console.error("[meetings.complete] no-show rebound task failed:", (e as Error).message);
        }
      }
      return { ok: true, reboundTaskId };
    }),

  cancel: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(meetings).set({ status: "cancelled" } as never)
      .where(and(eq(meetings.id, input.id), eq(meetings.workspaceId, ctx.workspace.id)));
    return { ok: true };
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
    if (!db) return { mode: "off" as const, dailyCap: 10, lastRunAt: null as Date | null };
    const [row] = await db.select({
      mode: workspaceSettings.meetingAutopilotMode,
      dailyCap: workspaceSettings.meetingAutopilotDailyCap,
      lastRunAt: workspaceSettings.meetingAutopilotLastRunAt,
    }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
    return row ?? { mode: "off" as const, dailyCap: 10, lastRunAt: null };
  }),

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
});
