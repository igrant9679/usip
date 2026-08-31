/**
 * replyScope.ts — the ONE definition of a "genuine reply".
 *
 * `email_replies` is not "replies to our outbound": inboundReplyPoller inserts
 * a row for EVERY message in each synced mailbox, so most rows are ordinary
 * private correspondence (~75k in one workspace). A row is a genuine reply
 * only when it is linked to something Velocity sent:
 *
 *   - `draftId`     — matched to an inbox/sequence draft (the original tier)
 *   - `campaignId`  — matched to an ARE campaign enrollment (migration 0174;
 *                     stamped by the poller from the prospect-queue match it
 *                     always performed but never persisted)
 *
 * Before this existed, every surface picked its own scope and they all
 * disagreed (owner report 2026-08-28): Conversations and Home said 0 while
 * the Emails tab said 74,943, and a genuine campaign reply was viewable
 * NOWHERE — the ARE engine reacted to it, but the stored row matched no
 * surface's filter. Every count or listing over this table must use this
 * scope; a new linkage tier gets added HERE, not inline at a call site.
 */
import { isNotNull, or, type SQL } from "drizzle-orm";
import { emailReplies } from "../../drizzle/schema";

/** Drizzle condition: this row answers something we sent. */
export function genuineReplyScope(): SQL {
  return or(isNotNull(emailReplies.draftId), isNotNull(emailReplies.campaignId))!;
}

/** The same scope as a raw-SQL fragment, for hand-built queries (trend7d). */
export const GENUINE_REPLY_SQL = "(`draftId` IS NOT NULL OR `campaignId` IS NOT NULL)";
