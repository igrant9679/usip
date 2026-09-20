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
import { and, eq, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { emailReplies, unipileInvites, unipileMessages } from "../../drizzle/schema";

/** Drizzle condition: this row answers something we sent. */
export function genuineReplyScope(): SQL {
  return or(isNotNull(emailReplies.draftId), isNotNull(emailReplies.campaignId))!;
}

/** The same scope as a raw-SQL fragment, for hand-built queries (trend7d). */
export const GENUINE_REPLY_SQL = "(`draftId` IS NOT NULL OR `campaignId` IS NOT NULL)";

/* ── The social half of the same idea ──────────────────────────────────────
 *
 * `unipile_messages` had the email table's problem and no scope at all: the
 * messaging webhook stores EVERY inbound DM and handed each one straight to
 * the classifier. So a recruiter's cold LinkedIn message was classified, it
 * inflated every social reply counter, and — worst — a "willing to meet" one
 * got the rep's booking link DM'd back to a total stranger in auto mode
 * (2026-09-20). That is the same failure this file's email half exists to
 * prevent, recreated on the other channel.
 *
 * An inbound social message is a genuine reply only when WE opened the
 * conversation. Three facts, all rows we already write:
 *   chat      — we sent something in this chat
 *   recipient — we DM'd this provider id from this workspace
 *   invite    — we sent this provider id a connection request
 *
 * DERIVED, never stamped on the row. A conversation can BECOME ours after the
 * message lands (they DM'd first, the rep replies by hand; a LinkedIn webhook
 * arrives out of order), and a column written at insert time is frozen wrong
 * in exactly that case. Derived also means nothing to backfill.
 */
const SOCIAL_SCOPE = sql`(
  exists (select 1 from \`unipile_messages\` o
           where o.\`workspaceId\` = \`unipile_messages\`.\`workspaceId\`
             and o.\`direction\` = 'outbound'
             and o.\`chatId\` = \`unipile_messages\`.\`chatId\`)
  or (\`unipile_messages\`.\`senderProviderId\` is not null
      and \`unipile_messages\`.\`senderProviderId\` <> ''
      and exists (select 1 from \`unipile_messages\` o2
                   where o2.\`workspaceId\` = \`unipile_messages\`.\`workspaceId\`
                     and o2.\`direction\` = 'outbound'
                     and o2.\`recipientProviderId\` = \`unipile_messages\`.\`senderProviderId\`))
  or (\`unipile_messages\`.\`senderProviderId\` is not null
      and \`unipile_messages\`.\`senderProviderId\` <> ''
      and exists (select 1 from \`unipile_invites\` v
                   where v.\`workspaceId\` = \`unipile_messages\`.\`workspaceId\`
                     and v.\`recipientProviderId\` = \`unipile_messages\`.\`senderProviderId\`))
)`;

/** Drizzle condition: this inbound DM answers outreach we started. */
export function genuineSocialReplyScope(): SQL {
  return SOCIAL_SCOPE;
}

/**
 * Its complement — the "Not our outreach" view. Visible, never counted, never
 * acted on. Strangers do not vanish from Conversations; they just stop being
 * treated as replies. Every term is an EXISTS, so this is a true complement
 * rather than a three-valued one.
 */
export function notOurOutreachScope(): SQL {
  return sql`not ${SOCIAL_SCOPE}`;
}

export type SocialOutreachTier = "chat" | "recipient" | "invite";
export interface SocialOutreach {
  tier: SocialOutreachTier | null;
  linkedContactId: number | null;
  linkedLeadId: number | null;
}
const NO_OUTREACH: SocialOutreach = { tier: null, linkedContactId: null, linkedLeadId: null };

/**
 * Decide, ONCE at webhook time, whether we started this conversation — and
 * carry back the CRM linkage of the outbound row that proves it, because the
 * inbound row never sets linkedContactId/linkedLeadId and a meeting proposal
 * filed against nothing is a proposal nobody can act on.
 *
 * Fails CLOSED. This value gates a SEND; a transient DB error must never read
 * as "yes, we know them". The read surfaces do not use it — they evaluate
 * genuineSocialReplyScope() inside their own query, where an error cannot
 * silently hide a real reply.
 */
export async function resolveSocialOutreachScope(
  db: any,
  input: { workspaceId: number; chatId: string; senderProviderId: string | null },
): Promise<SocialOutreach> {
  try {
    if (input.chatId) {
      const [ours] = await db
        .select({ c: unipileMessages.linkedContactId, l: unipileMessages.linkedLeadId })
        .from(unipileMessages)
        .where(and(
          eq(unipileMessages.workspaceId, input.workspaceId),
          eq(unipileMessages.chatId, input.chatId),
          eq(unipileMessages.direction, "outbound"),
        ))
        .limit(1);
      if (ours) return { tier: "chat", linkedContactId: ours.c ?? null, linkedLeadId: ours.l ?? null };
    }
    const pid = (input.senderProviderId ?? "").trim();
    if (!pid) return NO_OUTREACH;

    const [dm] = await db
      .select({ c: unipileMessages.linkedContactId, l: unipileMessages.linkedLeadId })
      .from(unipileMessages)
      .where(and(
        eq(unipileMessages.workspaceId, input.workspaceId),
        eq(unipileMessages.direction, "outbound"),
        eq(unipileMessages.recipientProviderId, pid),
      ))
      .limit(1);
    if (dm) return { tier: "recipient", linkedContactId: dm.c ?? null, linkedLeadId: dm.l ?? null };

    const [inv] = await db
      .select({ c: unipileInvites.linkedContactId, l: unipileInvites.linkedLeadId })
      .from(unipileInvites)
      .where(and(
        eq(unipileInvites.workspaceId, input.workspaceId),
        eq(unipileInvites.recipientProviderId, pid),
      ))
      .limit(1);
    if (inv) return { tier: "invite", linkedContactId: inv.c ?? null, linkedLeadId: inv.l ?? null };
  } catch (e) {
    console.error("[replyScope] social outreach resolve failed:", e);
  }
  return NO_OUTREACH;
}

/**
 * May the autopilot SEND to them? Only where we actually messaged first.
 *
 * An accepted connection request is enough to classify and to file a task, but
 * not enough to auto-DM a booking link: we have never written to that person,
 * so an unprompted calendar link from us is the cold-outreach move this scope
 * exists to refuse.
 */
export function socialAutopilotMaySend(tier: string | null | undefined): boolean {
  return tier === "chat" || tier === "recipient";
}
