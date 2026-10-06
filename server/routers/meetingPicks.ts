/**
 * meetingPicks — the public page a proposal email's time links open, /m/:token
 * (owner ask 2026-10-06: "No event until accepted").
 *
 * `get` only reads (a mail scanner opening every link books nothing);
 * `confirm` is the page's button, a POST, and is the only thing that puts
 * the meeting on the owner's calendar. The token is 32 random bytes and is
 * the whole credential: it reaches one meeting and says nothing about the
 * workspace beyond its name and the host's.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { confirmProposalPick, proposalForPick } from "../services/meetingScheduler";

const token = z.string().min(16).max(64);

const MESSAGES: Record<string, string> = {
  not_found: "This link isn't valid any more.",
  not_offered: "That time wasn't one of the times offered.",
  time_passed: "That time has already passed. Please pick another.",
  time_taken: "That time was just taken. Please pick another.",
  closed: "This invitation has already been answered.",
  booking_failed: "We couldn't confirm that just now. Please try again in a moment, or reply to the email.",
};

export const meetingPicksRouter = router({
  get: publicProcedure.input(z.object({ token })).query(async ({ input }) => {
    const view = await proposalForPick(input.token);
    if (!view) throw new TRPCError({ code: "NOT_FOUND", message: MESSAGES.not_found });
    return view;
  }),

  confirm: publicProcedure
    .input(z.object({ token, time: z.string().datetime() }))
    .mutation(async ({ input }) => {
      const res = await confirmProposalPick(input.token, input.time);
      if (!res.ok) {
        const code = res.reason === "not_found" ? "NOT_FOUND" : res.reason === "booking_failed" ? "INTERNAL_SERVER_ERROR" : "CONFLICT";
        throw new TRPCError({ code, message: MESSAGES[res.reason] ?? MESSAGES.booking_failed });
      }
      return res;
    }),
});
