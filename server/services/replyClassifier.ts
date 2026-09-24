/**
 * Reply Classifier — autonomous inbound-reply handling behind /v2/conversations.
 *
 * The inbound poller stores replies in `email_replies` and pauses the sequence,
 * but never reads them. This engine closes the loop: it classifies each reply
 * with the 8-class taxonomy from docs/specs/email-activity-reply-classification.md
 * (via the shared invokeLLM) and, on a positive reply, AUTONOMOUSLY creates a
 * meeting proposal (reusing createMeetingProposal) — so an interested reply turns
 * into a booked-meeting candidate with no human step.
 *
 * Autonomy modes (workspace_settings.conversationAutopilotMode):
 *   off      — never runs.
 *   approval — AI classifies replies + suggests actions; a human applies them.
 *   auto     — AI classifies AND executes the per-class action automatically.
 */
import { archivedWorkspaceIds } from "../_core/workspaceArchive";
import { activeOwnerOrNull } from "../_core/activeMembers";
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { genuineReplyScope } from "./replyScope";
import { emailReplies, emailSuppressions, enrollments, tasks, unipileMessages, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { humanizeAiCopy } from "./humanCopy";
import { createMeetingProposal } from "./meetingScheduler";
import { sendWorkspaceEmail } from "../emailDelivery";
import { resolveBookingUrl } from "../mergeVars";
import { sendMessage } from "../lib/unipile";
import { normalizeSuppressionEmail } from "../unsubscribe";
import { escapeHtml } from "@shared/escapeHtml";

export const REPLY_CLASSES = [
  "willing_to_meet",
  "follow_up_question",
  "person_referral",
  "out_of_office",
  "already_left_company_or_not_right_person",
  "not_interested",
  "unsubscribe",
  "none_of_the_above",
] as const;
const SENTIMENTS = ["positive", "neutral", "negative", "objection"];

export interface ReplyClassification {
  replyClass: string;
  sentiment: string;
  confidence: number;
  reasoning: string;
  suggestedReply: string;
  /** YYYY-MM-DD the sender said they are back, or "" — out_of_office only. */
  returnsAt: string;
}

function truncate(s: string | null | undefined, n: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

const escHtml = escapeHtml; // one escaper — @shared/escapeHtml

/** Classify a single reply and persist the classification. Returns it (or null). */
export async function classifyReply(workspaceId: number, reply: any): Promise<ReplyClassification | null> {
  const db = await getDb();
  if (!db) return null;

  const body = truncate(reply.bodyText || reply.bodyHtml, 2000);
  const prompt = `You are a B2B sales reply analyser. Classify this inbound email reply and draft a suggested response. Return JSON only.

From: ${reply.fromName ?? ""} <${reply.fromEmail}>
Subject: ${reply.subject ?? "(none)"}
Received: ${(() => { const d = new Date(reply.receivedAt); return isNaN(d.getTime()) ? "(unknown)" : d.toISOString().slice(0, 10); })()}
Body: ${body || "(empty)"}

Classes (pick exactly one):
- willing_to_meet: wants to meet / positive interest
- follow_up_question: asking a question, needs a reply
- person_referral: points you to someone else
- out_of_office: auto-reply / away
- already_left_company_or_not_right_person: wrong person or has left
- not_interested: explicit no
- unsubscribe: opt-out request
- none_of_the_above: unclear

Return: {
  "replyClass": "<one of the classes above>",
  "sentiment": "positive|neutral|negative|objection",
  "confidence": <integer 0-100>,
  "reasoning": "<one sentence>",
  "suggestedReply": "<a short, professional reply the rep could send>",
  "returnsAt": "<YYYY-MM-DD if and only if this is an out-of-office auto-reply stating a return date, resolved against Received above; otherwise an empty string>"
}`;

  let cls: ReplyClassification = { replyClass: "none_of_the_above", sentiment: "neutral", confidence: 50, reasoning: "", suggestedReply: "", returnsAt: "" };
  try {
    const res = await invokeLLM({
      sendersBrand: true,
      messages: [{ role: "user", content: prompt }],
      // outputSchema forces valid JSON for Anthropic (see taskAutopilot note).
      outputSchema: {
        name: "reply_classification",
        schema: {
          type: "object",
          properties: {
            replyClass: { type: "string", enum: [...REPLY_CLASSES] },
            sentiment: { type: "string", enum: [...SENTIMENTS] },
            confidence: { type: "integer" },
            reasoning: { type: "string" },
            suggestedReply: { type: "string" },
            returnsAt: { type: "string" },
          },
          required: ["replyClass", "sentiment", "confidence", "reasoning", "suggestedReply", "returnsAt"],
        },
      },
      max_tokens: 500,
      workspaceId,
    });
    const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");
    cls = {
      replyClass: (REPLY_CLASSES as readonly string[]).includes(parsed.replyClass) ? parsed.replyClass : "none_of_the_above",
      sentiment: SENTIMENTS.includes(parsed.sentiment) ? parsed.sentiment : "neutral",
      confidence: Math.max(0, Math.min(100, Math.round(Number(parsed.confidence ?? 50)) || 50)),
      reasoning: String(parsed.reasoning ?? "").slice(0, 500),
      suggestedReply: humanizeAiCopy(String(parsed.suggestedReply ?? "").slice(0, 2000)),
      // Grounded extraction: the exact shape or nothing. Date.parse over free
      // text ("back next Monday") invents a date, and this one decides when we
      // start mailing a person again — a wrong one is a send at a wrong time.
      returnsAt: /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.returnsAt ?? "")) ? String(parsed.returnsAt) : "",
    };
  } catch (e) {
    console.error(`[ReplyClassifier] LLM classify failed for reply ${reply.id}:`, e);
  }

  await db.update(emailReplies).set({
    replyClass: cls.replyClass,
    sentiment: cls.sentiment,
    classConfidence: cls.confidence,
    classReasoning: cls.reasoning || null,
    suggestedReply: cls.suggestedReply || null,
    oooReturnsAt: cls.returnsAt ? new Date(cls.returnsAt + "T09:00:00Z") : null,
    classifiedAt: new Date(),
  } as never).where(eq(emailReplies.id, reply.id));

  return cls;
}

function replyRelated(reply: any): { relatedType: string | null; relatedId: number | null } {
  if (reply.contactId) return { relatedType: "contact", relatedId: reply.contactId };
  if (reply.leadId) return { relatedType: "lead", relatedId: reply.leadId };
  if (reply.accountId) return { relatedType: "account", relatedId: reply.accountId };
  return { relatedType: null, relatedId: null };
}

async function createReplyTask(db: any, workspaceId: number, reply: any, title: string, priority: string, type = "follow_up", description?: string) {
  const rel = replyRelated(reply);
  // reply.userId is whoever's mailbox received it, read from a row that may
  // predate their offboarding — a task owned by a leaver looks handled and
  // never is. Unowned beats mis-owned (see _core/activeMembers).
  const ownerUserId = await activeOwnerOrNull(workspaceId, reply.userId);
  await db.insert(tasks).values({
    workspaceId,
    title,
    // The reply's OWN words when the caller passes them — a referral task
    // whose description was just "Re: <subject>" forced the rep back into
    // Conversations to find who was actually named (2026-09-20).
    description: description ?? (reply.subject ? `Re: ${reply.subject}` : null),
    type,
    priority,
    status: "open",
    dueAt: new Date(Date.now() + 86400000),
    ownerUserId,
    relatedType: rel.relatedType,
    relatedId: rel.relatedId,
    source: "ai",
  } as never);
}

export const OOO_DEFAULT_DAYS = 7;
export const OOO_MAX_DAYS = 90;
/** Max consecutive OOO snoozes for one sender before we stop probing them. */
export const OOO_MAX_SNOOZES = 3;

/**
 * When a snoozed enrollment may resume. Absent/invalid/past date → receivedAt
 * + 7d; hard cap +90d; never sooner than now + 12h.
 *
 * The floor is the part that matters: a return date already past (a backlog
 * classified two weeks late, or a robot that quotes yesterday) would resume
 * straight back into the same auto-responder. Hour-of-day is irrelevant — the
 * engine's send window + weekend gate decide the actual moment.
 */
export function oooResumeAt(returnsAt: string | Date | null | undefined, receivedAt: Date, now: Date = new Date()): Date {
  const base = receivedAt instanceof Date && !isNaN(receivedAt.getTime()) ? receivedAt : now;
  const fallback = new Date(base.getTime() + OOO_DEFAULT_DAYS * 86400000);
  const cap = new Date(base.getTime() + OOO_MAX_DAYS * 86400000);
  const floor = new Date(now.getTime() + 12 * 3600000);
  let at = fallback;
  // Date as well as string: on the approval path the row is re-read from
  // mysql, so email_replies.oooReturnsAt arrives as a Date. A string-only
  // check silently threw that away and every approved OOO took the fallback.
  let parsed: Date | null = null;
  if (returnsAt instanceof Date) parsed = returnsAt;
  else if (typeof returnsAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(returnsAt)) parsed = new Date(returnsAt + "T09:00:00Z");
  if (parsed && !isNaN(parsed.getTime()) && parsed.getTime() > base.getTime()) at = parsed;
  if (at.getTime() > cap.getTime()) at = cap;
  if (at.getTime() < floor.getTime()) at = floor;
  return at;
}

/**
 * The enrollment ids inboundReplyPoller paused for THIS reply (migration 0181).
 * The string branch is not defensive padding: some mysql2 configurations hand
 * a json column back as text.
 */
export function pausedIdsOf(reply: any): number[] {
  const raw = reply?.pausedEnrollmentIds;
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? (() => { try { return JSON.parse(raw); } catch { return []; } })()
      : [];
  return (Array.isArray(arr) ? arr : [])
    .map((n: any) => Number(n))
    .filter((n: number) => Number.isFinite(n) && n > 0);
}

/**
 * Execute the per-class action for a classified reply. Returns the action name.
 * `byUser` distinguishes an autopilot run from a rep clicking "Apply".
 */
export async function applyReplyAction(workspaceId: number, reply: any, byUser: boolean): Promise<string> {
  const db = await getDb();
  if (!db) return "none";
  const cls = reply.replyClass as string;
  const name = reply.fromName || reply.fromEmail;
  const rel = replyRelated(reply);
  let action = "none";
  let meetingId: number | null = null;

  // A real reply while someone is OOO-snoozed must cancel the pending resume.
  // The poller's re-pause matches status='active' only, so it is a no-op on an
  // already-paused row and cannot clear this. Without it the sweep would
  // restart outreach into a live conversation — the worst outcome of 0181.
  if (cls !== "out_of_office") {
    const stale = pausedIdsOf(reply);
    if (stale.length > 0) {
      await db.update(enrollments).set({ resumeAt: null } as never).where(and(
        eq(enrollments.workspaceId, workspaceId),
        eq(enrollments.status, "paused"),
        inArray(enrollments.id, stale),
      ));
    }
  }

  switch (cls) {
    case "willing_to_meet": {
      meetingId = await createMeetingProposal(workspaceId, {
        // Same active-membership rule as createReplyTask: never propose a
        // meeting owned by someone who left the workspace.
        ownerUserId: await activeOwnerOrNull(workspaceId, reply.userId),
        relatedType: rel.relatedType,
        relatedId: rel.relatedId,
        name,
        email: reply.fromEmail,
        descriptor: `replied with interest: "${truncate(reply.bodyText || reply.bodyHtml, 200)}"`,
        source: "inbound",
      });
      action = "meeting_proposed";
      // AUTO mode only (byUser=false): reply to the interested prospect with the
      // rep's booking link so they self-book immediately — converting the
      // highest-intent moment into a booked meeting with no human step. In
      // approval mode a rep sends it. Best-effort: falls back to proposal + task.
      let bookingLinkSent = false;
      if (!byUser && reply.fromEmail) {
        try {
          const bookingUrl = await resolveBookingUrl(workspaceId, reply.userId ?? null);
          if (bookingUrl) {
            const first = String(reply.fromName || "").trim().split(/\s+/)[0] || "there";
            const subject = reply.subject ? `Re: ${reply.subject}`.slice(0, 255) : "Great — let's find a time";
            const html =
              `<p>Hi ${escHtml(first)},</p>` +
              `<p>Glad to hear it! Pick whatever time works best for you and it'll drop straight onto my calendar:</p>` +
              `<p><a href="${escHtml(bookingUrl)}">Book a time</a></p>` +
              `<p>Looking forward to it.</p>`;
            const res = await sendWorkspaceEmail(workspaceId, { to: reply.fromEmail, subject, html });
            bookingLinkSent = res.ok;
          }
        } catch (e) {
          console.error(`[ReplyClassifier] booking-link auto-reply failed for reply ${reply.id}:`, e);
        }
      }
      if (bookingLinkSent) action = "booking_link_sent";
      await createReplyTask(
        db, workspaceId, reply,
        bookingLinkSent ? `Booking link sent — ${name} (awaiting self-book)` : `Meeting requested — ${name}`,
        "high", "meeting_prep",
      );
      break;
    }
    case "follow_up_question":
      await createReplyTask(db, workspaceId, reply, `Answer ${name}'s question`, "high", "manual_email");
      action = "task_created";
      break;
    case "person_referral": {
      // Follow through (2026-09-20): create the referred person in People
      // and draft the intro for review — what the Help Center always said
      // happens. Best-effort: any failure degrades to the task alone.
      let outcome = "";
      try {
        const { handleReferralReply } = await import("./referralHandler");
        const r = await handleReferralReply(workspaceId, reply);
        outcome = r.detail;
        action = r.handled ? (r.draftId ? "referral_drafted" : "referral_person_created") : "task_created";
      } catch (e) {
        console.error(`[ReplyClassifier] referral handling failed for reply ${reply.id}:`, e);
        action = "task_created";
      }
      const refSnippet = truncate(reply.bodyText || reply.bodyHtml, 240);
      await createReplyTask(
        db, workspaceId, reply,
        action === "referral_drafted" ? `Referral from ${name} — review the intro draft` : `Referral from ${name}`,
        "normal", "crm_update",
        `${outcome ? `${outcome}.\n` : ""}They wrote: "${refSnippet}"`,
      );
      break;
    }
    case "already_left_company_or_not_right_person": {
      // Flag departed (never delete) so views can filter; the linked
      // person's LinkedIn daily check surfaces the new role, which feeds
      // Job Change re-engagement (2026-09-20).
      let wpOutcome = "";
      try {
        const { handleWrongPersonReply } = await import("./referralHandler");
        const w = await handleWrongPersonReply(workspaceId, reply);
        wpOutcome = w.detail;
        if (w.handled) action = "contact_flagged_departed";
      } catch (e) {
        console.error(`[ReplyClassifier] wrong-person handling failed for reply ${reply.id}:`, e);
      }
      if (action !== "contact_flagged_departed") action = "task_created";
      const wpSnippet = truncate(reply.bodyText || reply.bodyHtml, 240);
      await createReplyTask(
        db, workspaceId, reply,
        `Re-verify contact — ${name} may have left`,
        "normal", "crm_update",
        `${wpOutcome ? `${wpOutcome}.\n` : ""}They wrote: "${wpSnippet}"`,
      );
      break;
    }
    case "not_interested":
      await createReplyTask(db, workspaceId, reply, `${name} not interested — review`, "low", "follow_up");
      action = "marked";
      break;
    case "unsubscribe":
      // Check-then-insert: email_suppressions' (workspaceId,email,reason) index is
      // NOT unique, so ON DUPLICATE KEY wouldn't dedupe — avoid duplicate rows.
      try {
        const [existing] = await db.select({ id: emailSuppressions.id }).from(emailSuppressions)
          .where(and(
            eq(emailSuppressions.workspaceId, workspaceId),
            // Same normalisation as the insert below — a check against the raw
            // From header looks for a form that is never stored, so it misses
            // and re-inserts on every subsequent opt-out reply.
            eq(emailSuppressions.email, normalizeSuppressionEmail(reply.fromEmail)),
            eq(emailSuppressions.reason, "unsubscribe"),
          ));
        if (!existing) {
          await db.insert(emailSuppressions).values({
            workspaceId,
            // Raw inbound From header — normalise before storing.
            email: normalizeSuppressionEmail(reply.fromEmail),
            reason: "unsubscribe",
            draftId: reply.draftId ?? null,
            contactId: reply.contactId ?? null,
            notes: "Auto-suppressed from inbound reply classification",
          } as never);
        }
      } catch (e) { console.error(`[ReplyClassifier] suppression insert failed:`, e); }
      action = "suppressed";
      break;
    case "out_of_office": {
      // The inbound poller pauses EVERY active enrollment for this person the
      // moment any reply lands — before anything knows it was a robot. Until
      // 0181 those people never came back: processEnrollments only ever
      // selects status='active', so an away-message ended the outreach
      // permanently. Schedule exactly the rows THIS reply paused; a rep's own
      // pause, and one an older genuine reply stopped, are not ours to undo.
      const ids = pausedIdsOf(reply);
      // Bound the loop: resume → next step drafts → auto-send dispatches →
      // the robot replies again → paused → snoozed again, and every cycle also
      // bumps campaigns.totalReplied in the poller. Four polite probes is
      // persistence; an unbounded loop is a machine talking to a machine.
      let snoozesSoFar = 0;
      if (ids.length > 0) {
        const [prior] = await db.select({ n: sql<number>`count(*)` }).from(emailReplies).where(and(
          eq(emailReplies.workspaceId, workspaceId),
          eq(emailReplies.fromEmail, reply.fromEmail),
          eq(emailReplies.replyClass, "out_of_office"),
          eq(emailReplies.autoActionTaken, "ooo_snoozed"),
          genuineReplyScope(),
        ));
        snoozesSoFar = Number(prior?.n ?? 0);
      }
      if (ids.length > 0 && snoozesSoFar < OOO_MAX_SNOOZES) {
        const at = oooResumeAt(reply.oooReturnsAt, new Date(reply.receivedAt));
        // status='paused' is load-bearing: in approval mode a rep may click
        // Apply days later, having already resumed or exited the row by hand.
        await db.update(enrollments).set({ resumeAt: at } as never).where(and(
          eq(enrollments.workspaceId, workspaceId),
          eq(enrollments.status, "paused"),
          inArray(enrollments.id, ids),
        ));
        action = "ooo_snoozed";
      } else {
        // Nothing this reply paused (legacy row, replyDetection off, no
        // enrollment), or the probe budget is spent — leave it paused.
        action = "ooo_noted";
      }
      break;
    }
    default:
      action = "none";
  }

  if (action !== "none") {
    await db.update(emailReplies).set({
      autoActionTaken: action,
      meetingId: meetingId,
      handledAt: new Date(),
      handledBy: byUser ? "user" : "ai",
    } as never).where(eq(emailReplies.id, reply.id));
  }
  return action;
}

async function socialTask(db: any, workspaceId: number, msg: any, ownerUserId: number | null, title: string, priority: string, type: string) {
  const rel = msg.linkedContactId ? { t: "contact", i: msg.linkedContactId } : msg.linkedLeadId ? { t: "lead", i: msg.linkedLeadId } : { t: null, i: null };
  await db.insert(tasks).values({
    workspaceId, title, description: msg.text ? String(msg.text).slice(0, 240) : null,
    type, priority, status: "open", dueAt: new Date(Date.now() + 86400000),
    ownerUserId: ownerUserId ?? null, relatedType: rel.t, relatedId: rel.i, source: "ai",
  } as never);
}

/**
 * Classify + act on ONE inbound social (LinkedIn/WhatsApp/…) message — the
 * Conversation Autopilot's social channel. Mirrors the email-reply flow: a
 * "willing_to_meet" message spawns a meeting proposal, owned by the rep whose
 * OWN connected account received it (ownerUserId). Called from the messaging
 * webhook only when the workspace's conversationAutopilotMode != 'off'.
 *
 * `outreachTier` is the webhook's already-resolved answer to "did we start
 * this conversation?" — passed in so the three lookups run once per message,
 * re-derived here when a caller omits it.
 */
export async function classifyAndHandleSocialMessage(
  workspaceId: number,
  msg: any,
  ownerUserId: number | null,
  mode: "approval" | "auto" = "auto",
  outreachTier: string | null = null,
): Promise<string> {
  const db = await getDb();
  if (!db) return "none";
  const { resolveSocialOutreachScope, socialAutopilotMaySend } = await import("./replyScope");
  const tier = outreachTier ?? (await resolveSocialOutreachScope(db, {
    workspaceId, chatId: msg.chatId, senderProviderId: msg.senderProviderId,
  })).tier;
  // Not our conversation: stored and readable, but the model never sees it and
  // nothing is ever sent on its behalf. Re-checked here rather than trusted
  // from the caller, because the harm this prevents — a recruiter's cold DM
  // earning them the rep's booking link — is one forgetful caller away
  // (2026-09-20, the social twin of the email scope above).
  if (!tier) return "out_of_scope";
  // The rep whose account received it may have left since: this path names
  // unipile_accounts.userId with no request context behind it, exactly what
  // createReplyTask guards. Unowned beats mis-owned (_core/activeMembers).
  const owner = await activeOwnerOrNull(workspaceId, ownerUserId);
  const name = msg.senderName || "the sender";
  const chan = msg.provider || "social";
  const body = truncate(msg.text, 2000);

  const prompt = `You are a B2B sales reply analyser. Classify this inbound ${chan} message and draft a suggested response. Return JSON only.

From: ${name}
Message: ${body || "(empty)"}

Classes (pick exactly one):
- willing_to_meet: wants to meet / positive interest
- follow_up_question: asking a question, needs a reply
- person_referral: points you to someone else
- out_of_office: auto-reply / away
- already_left_company_or_not_right_person: wrong person or has left
- not_interested: explicit no
- unsubscribe: opt-out request
- none_of_the_above: unclear`;

  let cls: ReplyClassification = { replyClass: "none_of_the_above", sentiment: "neutral", confidence: 50, reasoning: "", suggestedReply: "", returnsAt: "" };
  try {
    const res = await invokeLLM({
      messages: [{ role: "user", content: prompt }],
      outputSchema: {
        name: "reply_classification",
        schema: {
          type: "object",
          properties: {
            replyClass: { type: "string", enum: [...REPLY_CLASSES] },
            sentiment: { type: "string", enum: [...SENTIMENTS] },
            confidence: { type: "integer" },
            reasoning: { type: "string" },
            suggestedReply: { type: "string" },
          },
          required: ["replyClass", "sentiment", "confidence", "reasoning", "suggestedReply"],
        },
      },
      max_tokens: 500,
      workspaceId,
    });
    const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");
    cls = {
      replyClass: (REPLY_CLASSES as readonly string[]).includes(parsed.replyClass) ? parsed.replyClass : "none_of_the_above",
      sentiment: SENTIMENTS.includes(parsed.sentiment) ? parsed.sentiment : "neutral",
      confidence: Math.max(0, Math.min(100, Math.round(Number(parsed.confidence ?? 50)) || 50)),
      reasoning: String(parsed.reasoning ?? "").slice(0, 500),
      suggestedReply: humanizeAiCopy(String(parsed.suggestedReply ?? "").slice(0, 2000)),
      // The social prompt does not ask for a return date: nothing on the
      // Unipile path pauses an enrollment, so there is nothing to schedule.
      returnsAt: "",
    };
  } catch (e) {
    console.error(`[SocialClassifier] LLM classify failed for message ${msg.id}:`, e);
  }

  await db.update(unipileMessages).set({
    replyClass: cls.replyClass, sentiment: cls.sentiment, classConfidence: cls.confidence,
    classReasoning: cls.reasoning || null, classifiedAt: new Date(),
  } as never).where(eq(unipileMessages.id, msg.id));

  const relatedType = msg.linkedContactId ? "contact" : msg.linkedLeadId ? "lead" : null;
  const relatedId = msg.linkedContactId ?? msg.linkedLeadId ?? null;
  let action = "none";
  let meetingId: number | null = null;
  switch (cls.replyClass) {
    case "willing_to_meet": {
      meetingId = await createMeetingProposal(workspaceId, {
        ownerUserId: owner, relatedType, relatedId, name,
        descriptor: `replied on ${chan} with interest: "${truncate(msg.text, 160)}"`, source: "inbound",
      });
      action = "meeting_proposed";
      // AUTO mode: reply IN-THREAD with the rep's booking link so the prospect
      // self-books from the same DM — mirrors the email path. Best-effort.
      // Only where we MESSAGED first: an accepted invite alone is not consent
      // to receive our calendar link, so that tier gets the proposal and the
      // task and no outbound DM.
      let bookingLinkSent = false;
      if (mode === "auto" && msg.chatId && socialAutopilotMaySend(tier)) {
        try {
          const bookingUrl = await resolveBookingUrl(workspaceId, owner);
          if (bookingUrl) {
            const first = String(name).trim().split(/\s+/)[0] || "there";
            await sendMessage({ chatId: msg.chatId, text: `Great to hear, ${first}! Grab whatever time works best for you here and it'll go straight on my calendar: ${bookingUrl}` });
            bookingLinkSent = true;
          }
        } catch (e) {
          console.error(`[SocialClassifier] booking-link DM failed for message ${msg.id}:`, e);
        }
      }
      if (bookingLinkSent) action = "booking_link_sent";
      await socialTask(db, workspaceId, msg, owner, bookingLinkSent ? `Booking link sent (${chan}) — ${name}` : `Meeting requested (${chan}) — ${name}`, "high", "meeting_prep");
      break;
    }
    case "follow_up_question":
      await socialTask(db, workspaceId, msg, owner, `Answer ${name}'s ${chan} question`, "high", "manual_email"); action = "task_created"; break;
    case "person_referral":
      await socialTask(db, workspaceId, msg, owner, `Save referral from ${name} (${chan})`, "normal", "crm_update"); action = "task_created"; break;
    case "already_left_company_or_not_right_person":
      await socialTask(db, workspaceId, msg, owner, `Re-verify contact — ${name} may have left`, "normal", "crm_update"); action = "task_created"; break;
    case "not_interested":
      await socialTask(db, workspaceId, msg, owner, `${name} not interested (${chan}) — review`, "low", "follow_up"); action = "marked"; break;
    case "out_of_office":
      // Noted, not snoozed, and that is correct rather than unfinished: no
      // code path on the Unipile side ever pauses an enrollment (the only
      // update(enrollments) call sites are inboundReplyPoller, routers/
      // sequences, routers/dataHealth and sequenceEngine), so there is
      // nothing here to schedule a resume for. Mirroring the email branch
      // would stamp a resumeAt with no pausedEnrollmentIds behind it.
      action = "ooo_noted"; break;
    default:
      action = "none";
  }
  if (action !== "none") {
    await db.update(unipileMessages).set({ autoActionTaken: action, meetingId, handledAt: new Date() } as never)
      .where(eq(unipileMessages.id, msg.id));
  }
  return action;
}

/** Classify (and, in 'auto' mode, action) up to `limit` unclassified replies for one workspace. */
export async function runConversationAutopilotForWorkspace(
  workspaceId: number,
  mode: "approval" | "auto",
  limit: number,
): Promise<{ classified: number; actioned: number }> {
  const db = await getDb();
  if (!db) return { classified: 0, actioned: 0 };

  /**
   * `draftId IS NOT NULL` is NOT optional here.
   *
   * email_replies is not "replies to our outbound" — inboundReplyPoller inserts
   * a row for EVERY inbound message in the connected mailbox and sets
   * `draftId: matchedDraft?.id ?? null`, so an unmatched row is ordinary
   * private correspondence. On this workspace that is ~62,000 rows of the
   * owner's Outlook inbox against zero genuine campaign replies.
   *
   * Unscoped, ordered by receivedAt DESC, this fed the newest PRIVATE emails
   * into classifyReply — sending their contents to a model — and in `auto`
   * mode applyReplyAction then created meetings and CRM records from personal
   * mail. Approval mode is not a safeguard against the first half: it gates the
   * ACTION, not the classification, so the model still saw the message.
   *
   * The invariant is documented and this was the one place that mattered most:
   * every query over this table must scope to rows that answer something we
   * actually sent.
   */
  const rows = await db.select().from(emailReplies)
    .where(and(
      eq(emailReplies.workspaceId, workspaceId),
      isNull(emailReplies.classifiedAt),
      // The shared genuine-reply scope (replyScope.ts): draft-matched OR
      // campaign-matched (0174). Campaign replies now get classified too —
      // before, they reached the ARE signal loop but never the 8-class
      // taxonomy, so the Conversations UI could not even label them.
      genuineReplyScope(),
    ))
    .orderBy(desc(emailReplies.receivedAt))
    .limit(limit);

  let classified = 0, actioned = 0;
  for (const reply of rows) {
    const cls = await classifyReply(workspaceId, reply);
    if (!cls) continue;
    classified++;
    if (mode === "auto") {
      // `reply` is the row read BEFORE classification, so its oooReturnsAt is
      // whatever it was then — null on a first pass. Carrying cls.returnsAt
      // forward is what keeps the extracted return date reachable here;
      // without it every auto-mode OOO silently took the 7-day fallback.
      const a = await applyReplyAction(workspaceId, { ...reply, replyClass: cls.replyClass, oooReturnsAt: cls.returnsAt || reply.oooReturnsAt }, false);
      if (a !== "none") actioned++;
    }
  }
  return { classified, actioned };
}

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Cron entry: run reply autopilot for every workspace with mode != 'off'. */
export async function runConversationAutopilotAllWorkspaces(): Promise<{ workspaces: number; classified: number }> {
  const db = await getDb();
  if (!db) return { workspaces: 0, classified: 0 };

  const rows = await db.select().from(workspaceSettings).where(sql`${workspaceSettings.conversationAutopilotMode} <> 'off'`);
  const dayStart = startOfUtcDay();
  let workspaces = 0, classified = 0;

    const archivedWs = await archivedWorkspaceIds();
  for (const ws of rows) {
    if (archivedWs.has(ws.workspaceId)) continue; // archived workspaces are frozen (2026-08-12)
    const mode = ws.conversationAutopilotMode as "approval" | "auto";
    const cap = ws.conversationAutopilotDailyCap ?? 100;
    try {
      const [row] = await db.select({ n: sql<number>`count(*)` }).from(emailReplies)
        .where(and(eq(emailReplies.workspaceId, ws.workspaceId), gte(emailReplies.classifiedAt, dayStart)));
      const remaining = cap - Number(row?.n ?? 0);
      if (remaining <= 0) continue;

      const r = await runConversationAutopilotForWorkspace(ws.workspaceId, mode, Math.min(remaining, 25));
      classified += r.classified;
      workspaces++;
      await db.update(workspaceSettings).set({ conversationAutopilotLastRunAt: new Date() } as never)
        .where(eq(workspaceSettings.workspaceId, ws.workspaceId));
      if (r.classified > 0) console.log(`[ConversationAutopilot] ws ${ws.workspaceId} (${mode}): classified ${r.classified}, actioned ${r.actioned}`);
    } catch (e) {
      console.error(`[ConversationAutopilot] ws ${ws.workspaceId} failed:`, e);
    }
  }
  return { workspaces, classified };
}
