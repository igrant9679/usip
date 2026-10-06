/**
 * outboundPause.ts — "Pause all outbound" for sends a PERSON clicks.
 *
 * Owner, 2026-10-06, after a bulk "Approve & send all" went out to nine
 * prospects while LSI Media was paused: "all outbound communication was
 * supposed to be stopped!", choosing "Block everything". The pause first
 * held only what Velocity sends on its own (sendWindow.inSendWindow); from
 * now on, every person-triggered send to a prospect asks here first and is
 * refused with this message while the workspace is paused.
 *
 * Not held: a prospect's own action (picking a time on a booking page), a
 * meeting a prospect agrees to on an AI call (they asked for it in the
 * moment), and mail to your own team.
 */
import { TRPCError } from "@trpc/server";
import { getWorkspaceSendWindow } from "./sendWindow";

export const OUTBOUND_PAUSED_MESSAGE =
  "Outbound is paused for this workspace (Settings → Workspace overview → Send window). Nothing goes to prospects until it is switched off.";

export async function isOutboundPaused(workspaceId: number): Promise<boolean> {
  try {
    return (await getWorkspaceSendWindow(workspaceId)).paused;
  } catch {
    // Unknown is not "paused": a lookup failure must not silently block a workspace that is live.
    return false;
  }
}

/** Throws PRECONDITION_FAILED with OUTBOUND_PAUSED_MESSAGE while the workspace is paused. */
export async function assertOutboundNotPaused(workspaceId: number): Promise<void> {
  if (await isOutboundPaused(workspaceId)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: OUTBOUND_PAUSED_MESSAGE });
  }
}
