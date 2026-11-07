/**
 * messageIds.ts — tying a reply to the exact email it answers (audit
 * 2026-10-20, F5).
 *
 * A reply names the message it answers in In-Reply-To, and the whole chain
 * in References, by RFC 5322 Message-ID. Matching used to look only at
 * `email_drafts.trackingToken`: the provider's id cut to 64 characters, so a
 * full Message-ID ("<long-uuid@mail.example.com>") almost never matched, and
 * the reply fell back to "the newest sent draft to that address" — the wrong
 * send whenever the person had more than one, and nothing at all for campaign
 * (ARE) mail, which kept no message id.
 *
 * Now every send keeps the Message-ID it went out with, in full:
 *   email_drafts.messageId          sequence, CRM and approved-draft sends
 *   email_log.rfcMessageId          every send through an adapter (the log row
 *                                   names its draft or campaign queue row)
 *   are_execution_queue.externalId  campaign sends
 * and a bridged (Unipile) mailbox, whose send answer carries only a tracking
 * id, gets its Message-ID from the mail_sent webhook (recordBridgedSendMessageId).
 *
 * trackingToken stays as the last exact fallback, and the newest-draft-by-
 * address fallback stays behind all of them in the poller.
 */
import { and, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { areExecutionQueue, emailDrafts, emailLog, unipileEmailsCache } from "../../../drizzle/schema";

type Db = any;

const stripAngle = (s: string) => s.trim().replace(/^<|>$/g, "").trim();

/** The ids a reply names, In-Reply-To first then References newest-last, bare and de-duplicated. */
export function referencedMessageIds(inReplyTo: string | null | undefined, references: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const id = stripAngle(raw);
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  };
  // Headers can carry several ids, separated by whitespace or commas; angle
  // brackets delimit each when present.
  const split = (v: string | null | undefined) => {
    const s = String(v ?? "");
    const angled = s.match(/<[^<>\s]+>/g);
    return angled && angled.length ? angled : s.split(/[\s,]+/);
  };
  for (const r of split(inReplyTo)) push(r);
  // The parent is last in References, so read it from the end.
  for (const r of split(references).reverse()) push(r);
  return out;
}

/** Each id as stored either way: bare and in angle brackets. */
export function messageIdCandidates(ids: string[]): string[] {
  return Array.from(new Set(ids.flatMap((id) => [id, `<${id}>`]))).filter((s) => s.length <= 500);
}

export type SentMatch = {
  draft: Record<string, any> | null;
  /** The campaign queue row the reply answers, when it was campaign mail. */
  queue: { id: number; campaignId: number } | null;
  /** Which record matched, for the log line. */
  via: "draft.messageId" | "email_log" | "are_execution_queue" | "unipile_sent" | "draft.trackingToken" | null;
};

/**
 * The send a reply answers, by Message-ID, within the workspace. Never throws
 * for a lookup it cannot make: an unmatched reply is still recorded, and the
 * poller falls back to the newest draft to that address.
 */
export async function matchSentByMessageId(db: Db, workspaceId: number, ids: string[]): Promise<SentMatch> {
  const none: SentMatch = { draft: null, queue: null, via: null };
  if (!ids.length) return none;
  const candidates = messageIdCandidates(ids);
  if (!candidates.length) return none;
  const draftById = async (id: number) =>
    (await db.select().from(emailDrafts).where(and(eq(emailDrafts.id, id), eq(emailDrafts.workspaceId, workspaceId))).limit(1))[0] ?? null;

  const out: SentMatch = { ...none };
  try {
    // 1. The draft that went out with this Message-ID.
    const [d] = await db.select().from(emailDrafts)
      .where(and(eq(emailDrafts.workspaceId, workspaceId), inArray(emailDrafts.messageId, candidates)))
      .orderBy(desc(emailDrafts.id)).limit(1);
    if (d) { out.draft = d; out.via = "draft.messageId"; }

    // 2. The log row of the send: names its draft, or its campaign queue row.
    //    rfcMessageId is the header; messageId is the provider's id, which for
    //    SMTP is the same header, and holds it for sends logged before 0340.
    const [log] = await db.select({ draftId: emailLog.draftId, prospectQueueId: emailLog.prospectQueueId, campaignId: emailLog.campaignId })
      .from(emailLog)
      .where(and(eq(emailLog.workspaceId, workspaceId), or(inArray(emailLog.rfcMessageId, candidates), inArray(emailLog.messageId, candidates))))
      .orderBy(desc(emailLog.id)).limit(1);
    if (log) {
      if (!out.draft && log.draftId) {
        const byLog = await draftById(Number(log.draftId));
        if (byLog) { out.draft = byLog; out.via = "email_log"; }
      }
      if (log.prospectQueueId && log.campaignId) {
        out.queue = { id: Number(log.prospectQueueId), campaignId: Number(log.campaignId) };
        out.via ??= "email_log";
      }
    }

    // 3. A campaign send's own row.
    if (!out.queue) {
      const [q] = await db.select({ prospectQueueId: areExecutionQueue.prospectQueueId, campaignId: areExecutionQueue.campaignId })
        .from(areExecutionQueue)
        .where(and(eq(areExecutionQueue.workspaceId, workspaceId), inArray(areExecutionQueue.externalId, candidates)))
        .orderBy(desc(areExecutionQueue.id)).limit(1);
      if (q) { out.queue = { id: Number(q.prospectQueueId), campaignId: Number(q.campaignId) }; out.via ??= "are_execution_queue"; }
    }

    // 4. A bridged mailbox's send: its sent copy carries the Message-ID and
    //    the tracking id the draft stored.
    if (!out.draft) {
      const [sentCopy] = await db.select({ trackingId: unipileEmailsCache.trackingId })
        .from(unipileEmailsCache)
        .where(and(eq(unipileEmailsCache.workspaceId, workspaceId), inArray(unipileEmailsCache.providerMessageId, candidates), isNotNull(unipileEmailsCache.trackingId)))
        .limit(1);
      if (sentCopy?.trackingId) {
        const [byTracking] = await db.select().from(emailDrafts)
          .where(and(eq(emailDrafts.workspaceId, workspaceId), eq(emailDrafts.trackingToken, String(sentCopy.trackingId).slice(0, 64))))
          .limit(1);
        if (byTracking) { out.draft = byTracking; out.via = "unipile_sent"; }
      }
    }

    // 5. The old exact match: the provider's tracking id, as stored (≤ 64).
    if (!out.draft) {
      const short = candidates.filter((c) => c.length <= 64);
      if (short.length) {
        const [t] = await db.select().from(emailDrafts)
          .where(and(eq(emailDrafts.workspaceId, workspaceId), inArray(emailDrafts.trackingToken, short)))
          .limit(1);
        if (t) { out.draft = t; out.via = out.via ?? "draft.trackingToken"; }
      }
    }
  } catch (e) {
    console.error("[messageIds] reply match failed:", (e as Error)?.message ?? e);
  }
  return out;
}

/**
 * A bridged mailbox's send reports its Message-ID in the mail_sent webhook,
 * not in the send answer. Recorded on the draft and the log row that stored
 * this send's tracking id, so a reply to it matches by Message-ID too.
 */
export async function recordBridgedSendMessageId(
  db: Db,
  workspaceId: number,
  trackingId: string | null | undefined,
  messageId: string | null | undefined,
): Promise<void> {
  const tid = String(trackingId ?? "").trim();
  const mid = String(messageId ?? "").trim();
  if (!tid || !mid || mid.length > 500) return;
  await db.update(emailDrafts).set({ messageId: mid } as never)
    .where(and(eq(emailDrafts.workspaceId, workspaceId), eq(emailDrafts.trackingToken, tid.slice(0, 64)), isNull(emailDrafts.messageId)));
  await db.update(emailLog).set({ rfcMessageId: mid } as never)
    .where(and(eq(emailLog.workspaceId, workspaceId), eq(emailLog.messageId, tid), isNull(emailLog.rfcMessageId)));
}
