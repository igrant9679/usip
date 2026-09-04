/**
 * attention — the ONE answer to "what needs me?".
 *
 * Every human-in-the-loop queue in the product, counted in SQL and returned
 * in a single call: AI drafts awaiting review, ARE prospects awaiting
 * approval (cross-campaign — nothing else in the app could answer that),
 * proposed meetings, unhandled replies, AI-drafted tasks, paused campaigns.
 * Plus a 24-hour digest of what the autopilots did, so an owner who opens
 * the app sees "here is what ran, here is the one queue to clear" instead
 * of 44 nav items.
 *
 * ⚠️ emailReplies holds ALL synced inbound mail (tens of thousands of rows),
 * not just replies to our outreach. Every reply count here is scoped
 * `draftId IS NOT NULL` — the rows provably tied to something we sent.
 * Dropping that predicate turns the badge into "your entire inbox".
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  areCampaigns,
  campaignRoutingSuggestions,
  emailDrafts,
  emailLog,
  emailReplies,
  meetings,
  optimizationRecommendations,
  prospectQueue,
  tasks,
  unipileMessages,
} from "../../drizzle/schema";
import { workspaceProcedure } from "../_core/workspace";
import { router } from "../_core/trpc";
import { remindableMeetingStatuses } from "@shared/meetingStatus";
import { genuineReplyScope } from "../services/replyScope";

const EMPTY = {
  totalNeedingYou: 0,
  aiDrafts: { count: 0, items: [] as { id: number; subject: string | null; toEmail: string | null }[] },
  proposedMeetings: { count: 0, items: [] as { id: number; title: string; contactName: string | null }[] },
  unhandledReplies: { count: 0, items: [] as { fromEmail: string; subject: string | null; receivedAt: Date }[] },
  areApprovals: { count: 0, byCampaign: [] as { campaignId: number; name: string; count: number }[] },
  draftTasks: { count: 0 },
  pausedCampaigns: [] as { id: number; name: string }[],
  // The four queues that never reached this aggregator before 2026-09-02
  // (audit: it covered five of nine human queues). Each is a real place a
  // person has to act; a "what needs me" number that omits them is wrong.
  sequenceDrafts: { count: 0 },
  socialReplies: { count: 0 },
  optimizationRecs: { count: 0 },
  chatFollowUps: { count: 0 },
  /** Best-fit campaign suggestions awaiting accept/dismiss (phase 3). */
  routingSuggestions: { count: 0, byCampaign: [] as { campaignId: number; name: string; count: number }[] },
  /** Proposed NEW campaigns awaiting create/dismiss (2026-09-04). */
  campaignProposals: { count: 0 },
  digest24h: { emailsSent: 0, prospectsDiscovered: 0, repliesReceived: 0, meetingsBooked: 0 },
};

export const attentionRouter = router({
  summary: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return EMPTY;
    const ws = ctx.workspace.id;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      [draftAgg],
      draftItems,
      [meetAgg],
      meetItems,
      [replyAgg],
      replyItems,
      areByCampaign,
      [taskAgg],
      paused,
      [digestSent],
      [digestDiscovered],
      [digestReplies],
      [digestMeetings],
      [seqDraftAgg],
      [socialAgg],
      [optAgg],
      [chatFollowAgg],
      routingByCampaign,
    ] = await Promise.all([
      db.select({ n: sql<number>`count(*)` }).from(emailDrafts)
        .where(and(eq(emailDrafts.workspaceId, ws), eq(emailDrafts.status, "ai_pending_review"))),
      db.select({ id: emailDrafts.id, subject: emailDrafts.subject, toEmail: emailDrafts.toEmail })
        .from(emailDrafts)
        .where(and(eq(emailDrafts.workspaceId, ws), eq(emailDrafts.status, "ai_pending_review")))
        .orderBy(desc(emailDrafts.id)).limit(5),
      db.select({ n: sql<number>`count(*)` }).from(meetings)
        .where(and(eq(meetings.workspaceId, ws), eq(meetings.status, "proposed"))),
      db.select({ id: meetings.id, title: meetings.title, contactName: meetings.contactName })
        .from(meetings)
        .where(and(eq(meetings.workspaceId, ws), eq(meetings.status, "proposed")))
        .orderBy(desc(meetings.id)).limit(3),
      db.select({ n: sql<number>`count(*)` }).from(emailReplies)
        .where(and(eq(emailReplies.workspaceId, ws), genuineReplyScope(), isNull(emailReplies.handledAt))),
      db.select({ fromEmail: emailReplies.fromEmail, subject: emailReplies.subject, receivedAt: emailReplies.receivedAt })
        .from(emailReplies)
        .where(and(eq(emailReplies.workspaceId, ws), genuineReplyScope(), isNull(emailReplies.handledAt)))
        .orderBy(desc(emailReplies.receivedAt)).limit(5),
      db.select({ campaignId: prospectQueue.campaignId, n: sql<number>`count(*)` })
        .from(prospectQueue)
        .where(and(
          eq(prospectQueue.workspaceId, ws),
          eq(prospectQueue.sequenceStatus, "pending"),
          eq(prospectQueue.enrichmentStatus, "complete"),
        ))
        .groupBy(prospectQueue.campaignId),
      db.select({ n: sql<number>`count(*)` }).from(tasks)
        .where(and(eq(tasks.workspaceId, ws), eq(tasks.status, "draft"))),
      db.select({ id: areCampaigns.id, name: areCampaigns.name }).from(areCampaigns)
        .where(and(eq(areCampaigns.workspaceId, ws), eq(areCampaigns.status, "paused"))),
      /**
       * The 24h "emails sent" reads the SITEWIDE send log (email_log, 0163)
       * — the one table every send path writes: campaign dispatch, sequence
       * sends, mailbox composes. It used to count emailDrafts, which only
       * the inbox AI-draft flow creates, so the Home tile said "0 sent" on
       * days the campaigns delivered dozens (owner screenshot 2026-08-26).
       * repliesReceived uses the shared genuine-reply scope (replyScope.ts):
       * draft-matched or campaign-matched (0174) — never all inbound, which
       * would count the owner's private mail as "replies" (the 75k-row trap).
       */
      db.select({ n: sql<number>`count(*)` }).from(emailLog)
        .where(and(eq(emailLog.workspaceId, ws), eq(emailLog.status, "sent"), gte(emailLog.sentAt, since))),
      db.select({ n: sql<number>`count(*)` }).from(prospectQueue)
        .where(and(eq(prospectQueue.workspaceId, ws), gte(prospectQueue.createdAt, since))),
      db.select({ n: sql<number>`count(*)` }).from(emailReplies)
        .where(and(eq(emailReplies.workspaceId, ws), genuineReplyScope(), gte(emailReplies.receivedAt, since))),
      // "Booked" = the attendee has a time (invited/scheduled/rescheduled) —
      // the shared vocabulary's remindable set, NOT a hand-typed list.
      db.select({ n: sql<number>`count(*)` }).from(meetings)
        .where(and(
          eq(meetings.workspaceId, ws),
          inArray(meetings.status, remindableMeetingStatuses()),
          gte(meetings.createdAt, since),
        )),
      // Sequence-engine drafts awaiting a human (the /email-drafts queue) —
      // a different status value from the AI-pipeline drafts counted above.
      db.select({ n: sql<number>`count(*)` }).from(emailDrafts)
        .where(and(eq(emailDrafts.workspaceId, ws), eq(emailDrafts.status, "pending_review"))),
      // Unhandled LinkedIn / WhatsApp replies (the Unified Inbox's queue).
      db.select({ n: sql<number>`count(*)` }).from(unipileMessages)
        .where(and(eq(unipileMessages.workspaceId, ws), eq(unipileMessages.direction, "inbound"), isNull(unipileMessages.handledAt))),
      // Continuous-optimisation recommendations waiting for accept/dismiss.
      db.select({ n: sql<number>`count(*)` }).from(optimizationRecommendations)
        .where(and(eq(optimizationRecommendations.workspaceId, ws), eq(optimizationRecommendations.status, "pending" as never))),
      // Chat follow-up review tasks: chatFollowUp inserts them OPEN (not
      // draft), titled "Follow up: … left chat without booking" with the
      // suggested email in the description — the only marker they carry.
      db.select({ n: sql<number>`count(*)` }).from(tasks)
        .where(and(
          eq(tasks.workspaceId, ws),
          eq(tasks.status, "open"),
          eq(tasks.type, "follow_up"),
          like(tasks.title, "Follow up:%"),
          like(tasks.description, "Suggested email%"),
        )),
      // Best-fit campaign suggestions (phase 3) — pending, grouped by campaign.
      db.select({ campaignId: campaignRoutingSuggestions.campaignId, name: areCampaigns.name, n: sql<number>`count(*)` })
        .from(campaignRoutingSuggestions)
        .innerJoin(areCampaigns, eq(areCampaigns.id, campaignRoutingSuggestions.campaignId))
        .where(and(eq(campaignRoutingSuggestions.workspaceId, ws), eq(campaignRoutingSuggestions.status, "pending")))
        .groupBy(campaignRoutingSuggestions.campaignId, areCampaigns.name),
    ]);

    // Campaign names for the ARE breakdown — one IN query, not a join in the
    // aggregate (the group-by result is tiny).
    const campaignIds = areByCampaign.map((r) => r.campaignId);
    const names = campaignIds.length
      ? await db.select({ id: areCampaigns.id, name: areCampaigns.name }).from(areCampaigns)
          .where(and(eq(areCampaigns.workspaceId, ws), inArray(areCampaigns.id, campaignIds)))
      : [];
    const nameOf = new Map(names.map((c) => [c.id, c.name]));

    const aiDrafts = { count: Number(draftAgg?.n ?? 0), items: draftItems };
    const proposedMeetings = { count: Number(meetAgg?.n ?? 0), items: meetItems };
    const unhandledReplies = { count: Number(replyAgg?.n ?? 0), items: replyItems };
    const areApprovals = {
      count: areByCampaign.reduce((s, r) => s + Number(r.n), 0),
      byCampaign: areByCampaign.map((r) => ({
        campaignId: r.campaignId,
        name: nameOf.get(r.campaignId) ?? `Campaign ${r.campaignId}`,
        count: Number(r.n),
      })),
    };
    const draftTasks = { count: Number(taskAgg?.n ?? 0) };
    const sequenceDrafts = { count: Number(seqDraftAgg?.n ?? 0) };
    const socialReplies = { count: Number(socialAgg?.n ?? 0) };
    const optimizationRecs = { count: Number(optAgg?.n ?? 0) };
    const chatFollowUps = { count: Number(chatFollowAgg?.n ?? 0) };
    const routingSuggestions = {
      count: routingByCampaign.reduce((s, r) => s + Number(r.n), 0),
      byCampaign: routingByCampaign.map((r) => ({ campaignId: r.campaignId, name: r.name, count: Number(r.n) })),
    };
    // Proposed NEW campaigns (2026-09-04) — a queue a person has to act on.
    const { countPendingProposals } = await import("../services/campaignProposals");
    const campaignProposals = { count: await countPendingProposals(ws) };

    return {
      totalNeedingYou:
        aiDrafts.count + proposedMeetings.count + unhandledReplies.count +
        areApprovals.count + draftTasks.count + paused.length +
        sequenceDrafts.count + socialReplies.count + optimizationRecs.count + chatFollowUps.count +
        routingSuggestions.count + campaignProposals.count,
      aiDrafts,
      proposedMeetings,
      unhandledReplies,
      areApprovals,
      draftTasks,
      pausedCampaigns: paused,
      sequenceDrafts,
      socialReplies,
      optimizationRecs,
      chatFollowUps,
      routingSuggestions,
      campaignProposals,
      digest24h: {
        emailsSent: Number(digestSent?.n ?? 0),
        prospectsDiscovered: Number(digestDiscovered?.n ?? 0),
        repliesReceived: Number(digestReplies?.n ?? 0),
        meetingsBooked: Number(digestMeetings?.n ?? 0),
      },
    };
  }),
});
