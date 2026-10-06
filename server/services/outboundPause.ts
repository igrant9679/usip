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
 * moment), mail or a calendar invite that goes only to your own team
 * (assertOutboundNotPausedFor), cancelling a meeting, a post on your own
 * LinkedIn feed (addressed to no one), and AI calls (their own switch).
 *
 * Where it is asked, before anything is written or sent: meeting Approve &
 * send (one and all); emails from a record, the mailbox (new, reply,
 * forward), an approved draft (one, or all), a proposal to its client and
 * the extension decisions mailed to the client; chat follow-up and Social
 * Autopilot invite tasks (one and all); LinkedIn messages, invites,
 * comments and reactions; calendar events with outside attendees; and the
 * Find meetings button, which in Autonomous drafts instead of sending.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { users, workspaceMembers } from "../../drizzle/schema";
import { getDb } from "../db";
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

/** The active team's addresses (login and notification), lower-cased. */
export async function teamEmails(workspaceId: number): Promise<Set<string>> {
  const db = await getDb();
  if (!db) return new Set();
  const rows = await db
    .select({ email: users.email, notifEmail: workspaceMembers.notifEmail })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), isNull(workspaceMembers.deactivatedAt)));
  const out = new Set<string>();
  for (const r of rows) for (const e of [r.email, r.notifEmail]) if (e) out.add(e.trim().toLowerCase());
  return out;
}

/** Bare addresses from "Name <a@b.com>, c@d.com"-style lists, lower-cased. */
export function recipientAddresses(list: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const item of list) {
    for (const m of String(item ?? "").match(/[^\s<>,;"']+@[^\s<>,;"']+/g) ?? []) out.push(m.toLowerCase());
  }
  return out;
}

/**
 * assertOutboundNotPaused for a send with known recipients: mail or an
 * invite that reaches only the workspace's own team still goes while
 * paused; one outside address and it is refused. No recipients, nothing sent.
 */
export async function assertOutboundNotPausedFor(workspaceId: number, recipients: Array<string | null | undefined>): Promise<void> {
  if (!(await isOutboundPaused(workspaceId))) return;
  const addresses = recipientAddresses(recipients);
  if (!addresses.length) return;
  const team = await teamEmails(workspaceId);
  if (addresses.every((a) => team.has(a))) return;
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: OUTBOUND_PAUSED_MESSAGE });
}
