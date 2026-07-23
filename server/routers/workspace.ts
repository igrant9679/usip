import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { ensureUserHasWorkspace } from "../seed";
import {
  getUserWorkspaces,
  getWorkspaceCounts,
  getWorkspaceMembers,
} from "../db";

export const workspaceRouter = router({
  /**
   * Returns workspaces the current user is a member of.
   * Auto-bootstraps a demo workspace + seed data if the user has none.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    let mine = await getUserWorkspaces(ctx.user.id);
    if (mine.length === 0) {
      await ensureUserHasWorkspace(ctx.user.id, ctx.user.name);
      mine = await getUserWorkspaces(ctx.user.id);
    }
    return mine;
  }),

  current: workspaceProcedure.query(({ ctx }) => ({
    workspace: ctx.workspace,
    member: ctx.member,
  })),

  /**
   * Rename the workspace (admin+). The name is tenant-facing: it brands
   * proposal emails, AI prompts, and the workspace switcher — there was
   * previously no way to change it at all.
   */
  rename: workspaceProcedure
    .input(z.object({ name: z.string().trim().min(2).max(120) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.member.role !== "admin" && ctx.member.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Requires admin role" });
      }
      const { getDb } = await import("../db");
      const { workspaces } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(workspaces)
        .set({ name: input.name })
        .where(eq(workspaces.id, ctx.workspace.id));
      return { ok: true, name: input.name };
    }),

  members: workspaceProcedure.query(async ({ ctx }) => {
    return getWorkspaceMembers(ctx.workspace.id);
  }),

  summary: workspaceProcedure.query(async ({ ctx }) => {
    return getWorkspaceCounts(ctx.workspace.id);
  }),

  /**
   * Honest 7-day daily series for the Home hero sparklines: activities
   * logged, meetings scheduled, and inbound replies received per UTC day.
   */
  trend7d: workspaceProcedure.query(async ({ ctx }) => {
    const { getDb } = await import("../db");
    const { sql } = await import("drizzle-orm");
    const db = await getDb();
    const empty = Array.from({ length: 7 }, () => 0);
    if (!db) return { activities: empty, meetings: empty, replies: empty };
    const since = new Date(Date.now() - 6 * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);
    const dayKey = (d: Date) => d.toISOString().slice(0, 10);
    const days = Array.from({ length: 7 }, (_, i) => dayKey(new Date(since.getTime() + i * 86_400_000)));
    const bucket = async (table: string, dateCol: string): Promise<number[]> => {
      const rows = (await db.execute(
        sql.raw(`SELECT DATE(${dateCol}) d, COUNT(*) n FROM \`${table}\` WHERE workspaceId = ${Number(ctx.workspace.id)} AND ${dateCol} >= '${since.toISOString().slice(0, 19).replace("T", " ")}' GROUP BY DATE(${dateCol})`),
      )) as unknown as [Array<{ d: string | Date; n: number }>];
      const byDay = new Map((rows[0] ?? []).map((r) => [dayKey(new Date(r.d)), Number(r.n)]));
      return days.map((d) => byDay.get(d) ?? 0);
    };
    const [activities, meetings, replies] = await Promise.all([
      bucket("activities", "occurredAt"),
      bucket("meetings", "scheduledAt"),
      bucket("email_replies", "receivedAt"),
    ]);
    return { activities, meetings, replies };
  }),

  switch: protectedProcedure
    .input(z.object({ workspaceId: z.number().int() }))
    .mutation(async ({ input, ctx }) => {
      const mine = await getUserWorkspaces(ctx.user.id);
      const ok = mine.find((w) => w.id === input.workspaceId);
      if (!ok) throw new Error("Not a member of that workspace");
      // Frontend persists the current workspace id and sends it via header on each call.
      return { ok: true, workspaceId: input.workspaceId };
    }),
});
