/**
 * Email Activity Router — every email sitewide, in one feed.
 *
 * Owner ask 2026-08-14: "all emails sitewide, especially ARE Hub emails,
 * should appear in the Emails sidebar with all of the relevant data and
 * records."
 *
 * The Emails page read `emailDrafts.list` and nothing else, so it showed CRM
 * ad-hoc sends and AI drafts — a minority of the mail this product sends. ARE
 * campaign steps lived in `are_execution_queue`, Inbox composes and replies
 * were recorded nowhere at all, and inbound mail sat in `email_replies`
 * reachable only from the Inbox.
 *
 * This router merges four sources, each of which keeps ownership of what it
 * knows best:
 *
 *   email_log            everything transmitted (migration 0163), joined back
 *                        to the draft or execution row for LIVE engagement
 *   email_drafts         written but not yet sent — the review queue
 *   are_execution_queue  campaign steps still scheduled, or failed before ever
 *                        reaching a mailbox (a pool with no eligible account
 *                        never reaches the adapter, so no log row exists)
 *   email_replies        inbound
 *
 * ⚠️ Ordering rule, which this file exists to get right: EVERY source filters
 * and orders in SQL and takes `offset + limit` rows. Only then are they merged
 * (@shared/emailActivity mergeFeed). Filtering an already-limited page is the
 * defect that emptied the ARE Active tab in 320072b, and it fails silently.
 *
 * Rows that would appear twice are excluded at the source, never deduped
 * afterwards: a draft or execution row that already HAS a log row is the log
 * row's business, because the log row is the one carrying the delivery outcome.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  areCampaigns,
  areExecutionQueue,
  emailDrafts,
  emailLog,
  emailReplies,
  prospectQueue,
  sendingAccounts,
  sequences,
  users,
} from "../../drizzle/schema";
import { alias } from "drizzle-orm/mysql-core";
import { getDb } from "../db";
import { genuineReplyScope } from "../services/replyScope";
import { workspaceProcedure } from "../_core/workspace";
import {
  failureReasonFor, feedSourceApplies, mergeFeed,
  type EmailFeedKind, type EmailFeedRow,
} from "@shared/emailActivity";

const listInput = z.object({
  direction: z.enum(["all", "outbound", "inbound"]).default("all"),
  /** An `email_log.source` value, or "all". */
  source: z.string().default("all"),
  /** sent | failed | awaiting | scheduled | engaged | bounced | all */
  status: z.string().default("all"),
  search: z.string().default(""),
  campaignId: z.number().optional(),
  contactId: z.number().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

type ListInput = z.infer<typeof listInput>;

/**
 * The sending account reached through the EXECUTION row rather than the log
 * row. Aliased because both joins hit `sending_accounts` in the same query.
 */
const execAccount = alias(sendingAccounts, "exec_account");

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Which sources are worth querying at all. The rule itself lives in
 * @shared/emailActivity, where it is unit-tested — a filter that quietly
 * queries a source it should not is invisible in the result.
 */
function wants(input: ListInput, kind: EmailFeedKind): boolean {
  return feedSourceApplies(input, kind);
}

export const emailActivityRouter = {
  /**
   * The unified feed. One page, newest first, across all four sources.
   */
  list: workspaceProcedure.input(listInput).query(async ({ ctx, input }): Promise<{
    rows: EmailFeedRow[];
    hasMore: boolean;
  }> => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const wsId = ctx.workspace.id;
    const take = input.offset + input.limit;
    // One extra row, purely to answer "is there another page" without a count.
    const takePlus = take + 1;
    const term = input.search.trim();
    const like = `%${term}%`;

    /* ── 1. email_log — everything that was actually transmitted ─────────── */
    const logRows: EmailFeedRow[] = !wants(input, "log") ? [] : await (async () => {
      const conds = [eq(emailLog.workspaceId, wsId)];
      if (input.source !== "all") conds.push(eq(emailLog.source, input.source));
      if (input.campaignId) conds.push(eq(emailLog.campaignId, input.campaignId));
      if (input.contactId) conds.push(eq(emailLog.contactId, input.contactId));
      if (input.status === "sent") conds.push(eq(emailLog.status, "sent"));
      if (input.status === "failed") conds.push(eq(emailLog.status, "failed"));
      if (term) {
        conds.push(sql`(${emailLog.subject} LIKE ${like} OR ${emailLog.toEmail} LIKE ${like}
          OR ${emailLog.sourceLabel} LIKE ${like} OR ${emailLog.bodyPreview} LIKE ${like})`);
      }
      // Engagement filters read the OWNING row, not a copy on the log.
      if (input.status === "engaged") {
        conds.push(sql`(COALESCE(${emailDrafts.openCount}, 0) > 0
          OR COALESCE(${emailDrafts.clickCount}, 0) > 0
          OR ${areExecutionQueue.openedAt} IS NOT NULL)`);
      }
      if (input.status === "bounced") conds.push(sql`${emailDrafts.bouncedAt} IS NOT NULL`);

      const rows = await db
        .select({
          id: emailLog.id,
          source: emailLog.source,
          sourceLabel: emailLog.sourceLabel,
          subject: emailLog.subject,
          preview: emailLog.bodyPreview,
          fromEmail: emailLog.fromEmail,
          fromName: emailLog.fromName,
          toEmail: emailLog.toEmail,
          status: emailLog.status,
          failureReason: emailLog.failureReason,
          at: emailLog.sentAt,
          draftId: emailLog.draftId,
          executionQueueId: emailLog.executionQueueId,
          campaignId: emailLog.campaignId,
          prospectQueueId: emailLog.prospectQueueId,
          contactId: emailLog.contactId,
          leadId: emailLog.leadId,
          sequenceId: emailLog.sequenceId,
          sendingAccountId: emailLog.sendingAccountId,
          userId: emailLog.userId,
          // Live engagement from whichever row owns it.
          draftOpens: emailDrafts.openCount,
          draftClicks: emailDrafts.clickCount,
          draftBouncedAt: emailDrafts.bouncedAt,
          draftBounceType: emailDrafts.bounceType,
          draftRepliedAt: emailDrafts.firstReplyAt,
          execOpens: areExecutionQueue.openCount,
          execOpenedAt: areExecutionQueue.openedAt,
          stepIndex: areExecutionQueue.stepIndex,
        })
        .from(emailLog)
        .leftJoin(emailDrafts, eq(emailDrafts.id, emailLog.draftId))
        .leftJoin(areExecutionQueue, eq(areExecutionQueue.id, emailLog.executionQueueId))
        .where(and(...conds))
        .orderBy(desc(emailLog.sentAt), desc(emailLog.id))
        .limit(takePlus);

      return rows.map((r): EmailFeedRow => ({
        key: `log:${r.id}`,
        kind: "log",
        id: r.id,
        direction: "outbound",
        source: r.source,
        sourceLabel: r.sourceLabel,
        subject: r.subject,
        preview: r.preview,
        fromEmail: r.fromEmail,
        fromName: r.fromName,
        toEmail: r.toEmail,
        status: r.draftBouncedAt ? "bounced" : r.status,
        failureReason: failureReasonFor(r.draftBouncedAt ? "bounced" : r.status, r.failureReason),
        at: r.at,
        openCount: num(r.draftOpens) || num(r.execOpens),
        clickCount: num(r.draftClicks),
        openedAt: r.execOpenedAt ?? null,
        bouncedAt: r.draftBouncedAt ?? null,
        bounceType: r.draftBounceType ?? null,
        repliedAt: r.draftRepliedAt ?? null,
        draftId: r.draftId,
        executionQueueId: r.executionQueueId,
        campaignId: r.campaignId,
        prospectQueueId: r.prospectQueueId,
        contactId: r.contactId,
        leadId: r.leadId,
        sequenceId: r.sequenceId,
        sendingAccountId: r.sendingAccountId,
        userId: r.userId,
        stepIndex: r.stepIndex ?? null,
      }));
    })();

    /* ── 2. email_drafts not yet sent — the review queue ─────────────────── */
    const draftRows: EmailFeedRow[] = !wants(input, "draft") ? [] : await (async () => {
      const conds = [
        eq(emailDrafts.workspaceId, wsId),
        ne(emailDrafts.status, "sent"),
        // A draft whose send already produced a log row is that row's story —
        // including a FAILED send, where the log carries the reason and the
        // draft carries nothing.
        sql`NOT EXISTS (SELECT 1 FROM \`email_log\` l WHERE l.\`draftId\` = ${emailDrafts.id})`,
      ];
      if (input.contactId) conds.push(eq(emailDrafts.toContactId, input.contactId));
      if (input.source === "sequence") conds.push(sql`${emailDrafts.sequenceId} IS NOT NULL`);
      if (input.source === "ai_draft") conds.push(eq(emailDrafts.aiGenerated, true));
      if (input.source === "crm") {
        conds.push(sql`(${emailDrafts.sequenceId} IS NULL AND ${emailDrafts.aiGenerated} = false)`);
      }
      if (input.status === "awaiting") {
        conds.push(inArray(emailDrafts.status, ["pending_review", "ai_pending_review", "approved"]));
      }
      if (term) {
        conds.push(sql`(${emailDrafts.subject} LIKE ${like} OR ${emailDrafts.toEmail} LIKE ${like}
          OR ${emailDrafts.body} LIKE ${like})`);
      }
      const rows = await db
        .select({
          id: emailDrafts.id,
          subject: emailDrafts.subject,
          body: emailDrafts.body,
          toEmail: emailDrafts.toEmail,
          status: emailDrafts.status,
          createdAt: emailDrafts.createdAt,
          sequenceId: emailDrafts.sequenceId,
          aiGenerated: emailDrafts.aiGenerated,
          contactId: emailDrafts.toContactId,
          leadId: emailDrafts.toLeadId,
          sendingAccountId: emailDrafts.sendingAccountId,
          userId: emailDrafts.createdByUserId,
          openCount: emailDrafts.openCount,
          clickCount: emailDrafts.clickCount,
          bouncedAt: emailDrafts.bouncedAt,
          bounceType: emailDrafts.bounceType,
          repliedAt: emailDrafts.firstReplyAt,
          stepIndex: emailDrafts.stepIndex,
          sequenceName: sequences.name,
        })
        .from(emailDrafts)
        .leftJoin(sequences, eq(sequences.id, emailDrafts.sequenceId))
        .where(and(...conds))
        .orderBy(desc(emailDrafts.createdAt), desc(emailDrafts.id))
        .limit(takePlus);

      return rows.map((r): EmailFeedRow => ({
        key: `draft:${r.id}`,
        kind: "draft",
        id: r.id,
        direction: "outbound",
        source: r.sequenceId ? "sequence" : r.aiGenerated ? "ai_draft" : "crm",
        sourceLabel: r.sequenceName ?? null,
        subject: r.subject,
        preview: r.body,
        fromEmail: null,
        fromName: null,
        toEmail: r.toEmail,
        status: r.status,
        failureReason: null,
        at: r.createdAt,
        openCount: num(r.openCount),
        clickCount: num(r.clickCount),
        openedAt: null,
        bouncedAt: r.bouncedAt ?? null,
        bounceType: r.bounceType ?? null,
        repliedAt: r.repliedAt ?? null,
        draftId: r.id,
        executionQueueId: null,
        campaignId: null,
        prospectQueueId: null,
        contactId: r.contactId,
        leadId: r.leadId,
        sequenceId: r.sequenceId,
        sendingAccountId: r.sendingAccountId,
        userId: r.userId,
        stepIndex: r.stepIndex ?? null,
      }));
    })();

    /* ── 3. ARE campaign steps not yet transmitted ───────────────────────── */
    const queuedRows: EmailFeedRow[] = !wants(input, "queued") ? [] : await (async () => {
      const conds = [
        eq(areExecutionQueue.workspaceId, wsId),
        eq(areExecutionQueue.channel, "email"),
        // 'sent' rows are in email_log (backfilled + written at send time).
        // 'failed' rows are here only when the failure happened BEFORE the
        // adapter — no eligible sending account, daily cap — because those
        // never produced a log row.
        inArray(areExecutionQueue.status, ["scheduled", "paused", "failed", "skipped"]),
        sql`NOT EXISTS (SELECT 1 FROM \`email_log\` l WHERE l.\`executionQueueId\` = ${areExecutionQueue.id})`,
      ];
      if (input.campaignId) conds.push(eq(areExecutionQueue.campaignId, input.campaignId));
      if (input.status === "scheduled") {
        conds.push(inArray(areExecutionQueue.status, ["scheduled", "paused"]));
      }
      if (input.status === "failed") conds.push(eq(areExecutionQueue.status, "failed"));
      if (term) {
        conds.push(sql`(${prospectQueue.email} LIKE ${like}
          OR JSON_UNQUOTE(JSON_EXTRACT(${areExecutionQueue.messageContent}, '$.subject')) LIKE ${like}
          OR ${areCampaigns.name} LIKE ${like})`);
      }
      const rows = await db
        .select({
          id: areExecutionQueue.id,
          campaignId: areExecutionQueue.campaignId,
          prospectQueueId: areExecutionQueue.prospectQueueId,
          stepIndex: areExecutionQueue.stepIndex,
          status: areExecutionQueue.status,
          failureReason: areExecutionQueue.failureReason,
          scheduledAt: areExecutionQueue.scheduledAt,
          executedAt: areExecutionQueue.executedAt,
          messageContent: areExecutionQueue.messageContent,
          openCount: areExecutionQueue.openCount,
          openedAt: areExecutionQueue.openedAt,
          toEmail: prospectQueue.email,
          campaignName: areCampaigns.name,
        })
        .from(areExecutionQueue)
        .leftJoin(prospectQueue, eq(prospectQueue.id, areExecutionQueue.prospectQueueId))
        .leftJoin(areCampaigns, eq(areCampaigns.id, areExecutionQueue.campaignId))
        .where(and(...conds))
        .orderBy(desc(areExecutionQueue.scheduledAt), desc(areExecutionQueue.id))
        .limit(takePlus);

      return rows.map((r): EmailFeedRow => {
        const mc = (r.messageContent ?? null) as { subject?: string; body?: string } | null;
        return {
          key: `queued:${r.id}`,
          kind: "queued",
          id: r.id,
          direction: "outbound",
          source: "campaign",
          sourceLabel: r.campaignName ?? null,
          subject: mc?.subject ?? null,
          preview: mc?.body ?? null,
          fromEmail: null,
          fromName: null,
          toEmail: r.toEmail,
          status: r.status,
          failureReason: failureReasonFor(r.status, r.failureReason),
          at: r.executedAt ?? r.scheduledAt,
          openCount: num(r.openCount),
          clickCount: 0,
          openedAt: r.openedAt ?? null,
          bouncedAt: null,
          bounceType: null,
          repliedAt: null,
          draftId: null,
          executionQueueId: r.id,
          campaignId: r.campaignId,
          prospectQueueId: r.prospectQueueId,
          contactId: null,
          leadId: null,
          sequenceId: null,
          sendingAccountId: null,
          userId: null,
          stepIndex: r.stepIndex ?? null,
        };
      });
    })();

    /* ── 4. Inbound ──────────────────────────────────────────────────────── */
    const inboundRows: EmailFeedRow[] = !wants(input, "inbound") ? [] : await (async () => {
      // Genuine replies only (replyScope.ts). Unscoped, this fed the owner's
      // ENTIRE synced private inbox (~75k messages in one workspace) into a
      // CRM tab — and its count disagreed with every reply surface.
      const conds = [eq(emailReplies.workspaceId, wsId), genuineReplyScope()];
      if (input.contactId) conds.push(eq(emailReplies.contactId, input.contactId));
      if (term) {
        conds.push(sql`(${emailReplies.subject} LIKE ${like} OR ${emailReplies.fromEmail} LIKE ${like}
          OR ${emailReplies.bodyText} LIKE ${like})`);
      }
      const rows = await db
        .select({
          id: emailReplies.id,
          subject: emailReplies.subject,
          bodyText: emailReplies.bodyText,
          fromEmail: emailReplies.fromEmail,
          fromName: emailReplies.fromName,
          receivedAt: emailReplies.receivedAt,
          draftId: emailReplies.draftId,
          contactId: emailReplies.contactId,
          leadId: emailReplies.leadId,
          sendingAccountId: emailReplies.sendingAccountId,
          userId: emailReplies.userId,
          replyClass: emailReplies.replyClass,
          toEmail: sendingAccounts.fromEmail,
        })
        .from(emailReplies)
        .leftJoin(sendingAccounts, eq(sendingAccounts.id, emailReplies.sendingAccountId))
        .where(and(...conds))
        .orderBy(desc(emailReplies.receivedAt), desc(emailReplies.id))
        .limit(takePlus);

      return rows.map((r): EmailFeedRow => ({
        key: `inbound:${r.id}`,
        kind: "inbound",
        id: r.id,
        direction: "inbound",
        source: "inbound",
        sourceLabel: r.replyClass ? r.replyClass.replace(/_/g, " ") : null,
        subject: r.subject,
        preview: r.bodyText,
        fromEmail: r.fromEmail,
        fromName: r.fromName,
        toEmail: r.toEmail ?? null,
        status: "received",
        failureReason: null,
        at: r.receivedAt,
        openCount: 0,
        clickCount: 0,
        openedAt: null,
        bouncedAt: null,
        bounceType: null,
        repliedAt: null,
        draftId: r.draftId,
        executionQueueId: null,
        campaignId: null,
        prospectQueueId: null,
        contactId: r.contactId,
        leadId: r.leadId,
        sequenceId: null,
        sendingAccountId: r.sendingAccountId,
        userId: r.userId,
        stepIndex: null,
      }));
    })();

    const merged = mergeFeed(
      [logRows, draftRows, queuedRows, inboundRows],
      { limit: input.limit + 1, offset: input.offset },
    );
    const hasMore = merged.length > input.limit;
    return { rows: hasMore ? merged.slice(0, input.limit) : merged, hasMore };
  }),

  /**
   * Headline numbers and the per-source counts behind the filter chips.
   *
   * Counted across the WHOLE workspace, never across the page — a chip reading
   * "Campaign 50" when 50 is the page size is the same lie an unordered LIMIT
   * tells.
   */
  stats: workspaceProcedure
    .input(z.object({ campaignId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const wsId = ctx.workspace.id;
      const campaignScope = input.campaignId ? eq(emailLog.campaignId, input.campaignId) : undefined;

      const [bySource, totals, drafts, queued, inbound, engagement] = await Promise.all([
        db
          .select({ source: emailLog.source, count: sql<number>`count(*)` })
          .from(emailLog)
          .where(and(eq(emailLog.workspaceId, wsId), campaignScope))
          .groupBy(emailLog.source),
        db
          .select({
            sent: sql<number>`sum(case when ${emailLog.status} = 'sent' then 1 else 0 end)`,
            failed: sql<number>`sum(case when ${emailLog.status} = 'failed' then 1 else 0 end)`,
          })
          .from(emailLog)
          .where(and(eq(emailLog.workspaceId, wsId), campaignScope)),
        db
          .select({ count: sql<number>`count(*)` })
          .from(emailDrafts)
          .where(and(
            eq(emailDrafts.workspaceId, wsId),
            inArray(emailDrafts.status, ["pending_review", "ai_pending_review", "approved"]),
          )),
        db
          .select({ count: sql<number>`count(*)` })
          .from(areExecutionQueue)
          .where(and(
            eq(areExecutionQueue.workspaceId, wsId),
            eq(areExecutionQueue.channel, "email"),
            inArray(areExecutionQueue.status, ["scheduled", "paused"]),
            input.campaignId ? eq(areExecutionQueue.campaignId, input.campaignId) : undefined,
          )),
        db
          .select({ count: sql<number>`count(*)` })
          .from(emailReplies)
          // Genuine replies only (replyScope.ts) — unscoped, this stat said
          // "74,943 inbound" on the Emails tab while Conversations said 0.
          .where(and(eq(emailReplies.workspaceId, wsId), genuineReplyScope())),
        // Open/click rates read the owning rows, which is where the counters
        // actually live. Drafts and campaign sends are counted together
        // because the page presents one funnel, not two.
        Promise.all([
          db
            .select({
              sent: sql<number>`count(*)`,
              opened: sql<number>`sum(case when ${emailDrafts.openCount} > 0 then 1 else 0 end)`,
              clicked: sql<number>`sum(case when ${emailDrafts.clickCount} > 0 then 1 else 0 end)`,
              bounced: sql<number>`sum(case when ${emailDrafts.bouncedAt} is not null then 1 else 0 end)`,
            })
            .from(emailDrafts)
            .where(and(eq(emailDrafts.workspaceId, wsId), eq(emailDrafts.status, "sent"))),
          db
            .select({
              sent: sql<number>`count(*)`,
              opened: sql<number>`sum(case when ${areExecutionQueue.openedAt} is not null then 1 else 0 end)`,
            })
            .from(areExecutionQueue)
            .where(and(
              eq(areExecutionQueue.workspaceId, wsId),
              eq(areExecutionQueue.channel, "email"),
              eq(areExecutionQueue.status, "sent"),
              input.campaignId ? eq(areExecutionQueue.campaignId, input.campaignId) : undefined,
            )),
        ]),
      ]);

      const [draftEng, execEng] = engagement;
      const sentTotal = num(draftEng[0]?.sent) + num(execEng[0]?.sent);
      const openedTotal = num(draftEng[0]?.opened) + num(execEng[0]?.opened);
      const clickedTotal = num(draftEng[0]?.clicked);

      return {
        sent: num(totals[0]?.sent),
        failed: num(totals[0]?.failed),
        awaiting: num(drafts[0]?.count),
        scheduled: num(queued[0]?.count),
        inbound: num(inbound[0]?.count),
        bounced: num(draftEng[0]?.bounced),
        openRate: sentTotal ? Math.round((openedTotal / sentTotal) * 100) : 0,
        clickRate: sentTotal ? Math.round((clickedTotal / sentTotal) * 100) : 0,
        bySource: bySource.map((r) => ({ source: r.source, count: num(r.count) })),
      };
    }),

  /**
   * The full record behind one row: the whole body, the account it left from,
   * who triggered it, and the records it belongs to.
   */
  get: workspaceProcedure
    .input(z.object({ kind: z.enum(["log", "draft", "queued", "inbound"]), id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const wsId = ctx.workspace.id;

      if (input.kind === "log") {
        const [row] = await db
          .select({
            log: emailLog,
            accountName: sendingAccounts.name,
            accountEmail: sendingAccounts.fromEmail,
            execAccountName: execAccount.name,
            execAccountEmail: execAccount.fromEmail,
            execFromEmail: areExecutionQueue.fromEmail,
            userName: users.name,
            campaignName: areCampaigns.name,
            draftBody: emailDrafts.body,
            execContent: areExecutionQueue.messageContent,
          })
          .from(emailLog)
          .leftJoin(sendingAccounts, eq(sendingAccounts.id, emailLog.sendingAccountId))
          // Second chance at the sending account for CAMPAIGN rows: the log
          // records it only for sends made after 0163, while the execution row
          // records it for every send made after 0166. Neither covers the
          // other's gap alone.
          .leftJoin(execAccount, eq(execAccount.id, areExecutionQueue.sendingAccountId))
          .leftJoin(users, eq(users.id, emailLog.userId))
          .leftJoin(areCampaigns, eq(areCampaigns.id, emailLog.campaignId))
          .leftJoin(emailDrafts, eq(emailDrafts.id, emailLog.draftId))
          .leftJoin(areExecutionQueue, eq(areExecutionQueue.id, emailLog.executionQueueId))
          .where(and(eq(emailLog.id, input.id), eq(emailLog.workspaceId, wsId)))
          .limit(1);
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
        const exec = (row.execContent ?? null) as { body?: string } | null;
        return {
          ...row.log,
          // The log keeps a preview; the full body still lives on the row that
          // owns it, so the drawer shows the real thing when there is one.
          body: row.draftBody ?? exec?.body ?? row.log.bodyPreview ?? null,
          accountName: row.accountName ?? row.execAccountName ?? null,
          accountEmail: row.accountEmail ?? row.execAccountEmail ?? row.execFromEmail ?? row.log.fromEmail ?? null,
          userName: row.userName ?? null,
          campaignName: row.campaignName ?? null,
        };
      }

      if (input.kind === "draft") {
        const [row] = await db
          .select()
          .from(emailDrafts)
          .where(and(eq(emailDrafts.id, input.id), eq(emailDrafts.workspaceId, wsId)))
          .limit(1);
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
        return { ...row, accountName: null, accountEmail: null, userName: null, campaignName: null };
      }

      if (input.kind === "queued") {
        const [row] = await db
          .select({
            q: areExecutionQueue,
            toEmail: prospectQueue.email,
            campaignName: areCampaigns.name,
          })
          .from(areExecutionQueue)
          .leftJoin(prospectQueue, eq(prospectQueue.id, areExecutionQueue.prospectQueueId))
          .leftJoin(areCampaigns, eq(areCampaigns.id, areExecutionQueue.campaignId))
          .where(and(eq(areExecutionQueue.id, input.id), eq(areExecutionQueue.workspaceId, wsId)))
          .limit(1);
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
        const mc = (row.q.messageContent ?? null) as { subject?: string; body?: string } | null;
        return {
          ...row.q,
          subject: mc?.subject ?? null,
          body: mc?.body ?? null,
          toEmail: row.toEmail ?? null,
          campaignName: row.campaignName ?? null,
          accountName: null,
          accountEmail: null,
          userName: null,
        };
      }

      const [row] = await db
        .select({ r: emailReplies, accountEmail: sendingAccounts.fromEmail, accountName: sendingAccounts.name })
        .from(emailReplies)
        .leftJoin(sendingAccounts, eq(sendingAccounts.id, emailReplies.sendingAccountId))
        .where(and(eq(emailReplies.id, input.id), eq(emailReplies.workspaceId, wsId)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return {
        ...row.r,
        body: row.r.bodyText ?? row.r.bodyHtml ?? null,
        accountName: row.accountName ?? null,
        accountEmail: row.accountEmail ?? null,
        userName: null,
        campaignName: null,
      };
    }),
};
