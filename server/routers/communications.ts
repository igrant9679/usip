/**
 * communications — the one switch for everything a workspace sends to people
 * outside its team (owner, 2026-11-23). See @shared/communications.
 *
 *   communications.status     anyone in the workspace: is it on, paused or
 *                             partly paused, and may this person change it
 *   communications.setPaused  admins: pause or resume email, LinkedIn and AI
 *                             calls in one write, with its own audit entry
 *
 * The header, the sending status bar, the Autonomy Center and Settings all
 * call these two, and so does Elsie (assistantActionCatalog), behind the
 * same confirmation a person gets.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { adminWsProcedure, isAdminRole, workspaceProcedure } from "../_core/workspace";
import { readCommunications, setCommunicationsPaused } from "../services/communications";

export const communicationsRouter = router({
  status: workspaceProcedure.query(async ({ ctx }) => {
    try {
      return { ...(await readCommunications(ctx.workspace.id)), canChange: isAdminRole(ctx.member.role) };
    } catch {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not read whether communications are paused." });
    }
  }),

  setPaused: adminWsProcedure
    .input(z.object({ paused: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const { after, changed } = await setCommunicationsPaused(ctx.workspace.id, input.paused, ctx.user.id);
        return { ok: true, changed, ...after };
      } catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not change the communications switch. Nothing was changed." });
      }
    }),
});
