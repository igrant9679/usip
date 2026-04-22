import { z } from "zod";
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

  members: workspaceProcedure.query(async ({ ctx }) => {
    return getWorkspaceMembers(ctx.workspace.id);
  }),

  summary: workspaceProcedure.query(async ({ ctx }) => {
    return getWorkspaceCounts(ctx.workspace.id);
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
