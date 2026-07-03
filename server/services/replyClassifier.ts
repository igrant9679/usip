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
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { emailReplies, emailSuppressions, tasks, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { createMeetingProposal } from "./meetingScheduler";

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
}

function truncate(s: string | null | undefined, n: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** Classify a single reply and persist the classification. Returns it (or null). */
export async function classifyReply(workspaceId: number, reply: any): Promise<ReplyClassification | null> {
  const db = await getDb();
  if (!db) return null;

  const body = truncate(reply.bodyText || reply.bodyHtml, 2000);
  const prompt = `You are a B2B sales reply analyser. Classify this inbound email reply and draft a suggested response. Return JSON only.

From: ${reply.fromName ?? ""} <${reply.fromEmail}>
Subject: ${reply.subject ?? "(none)"}
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
  "suggestedReply": "<a short, professional reply the rep could send>"
}`;

  let cls: ReplyClassification = { replyClass: "none_of_the_above", sentiment: "neutral", confidence: 50, reasoning: "", suggestedReply: "" };
  try {
    const res = await invokeLLM({
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 400,
      workspaceId,
    });
    const parsed = JSON.parse(res.choices?.[0]?.message?.content ?? "{}");
    cls = {
      replyClass: (REPLY_CLASSES as readonly string[]).includes(parsed.replyClass) ? parsed.replyClass : "none_of_the_above",
      sentiment: SENTIMENTS.includes(parsed.sentiment) ? parsed.sentiment : "neutral",
      confidence: Math.max(0, Math.min(100, Math.round(Number(parsed.confidence ?? 50)) || 50)),
      reasoning: String(parsed.reasoning ?? "").slice(0, 500),
      suggestedReply: String(parsed.suggestedReply ?? "").slice(0, 2000),
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

async function createReplyTask(db: any, workspaceId: number, reply: any, title: string, priority: string, type = "follow_up") {
  const rel = replyRelated(reply);
  await db.insert(tasks).values({
    workspaceId,
    title,
    description: reply.subject ? `Re: ${reply.subject}` : null,
    type,
    priority,
    status: "open",
    dueAt: new Date(Date.now() + 86400000),
    ownerUserId: reply.userId ?? null,
    relatedType: rel.relatedType,
    relatedId: rel.relatedId,
    source: "ai",
  } as never);
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

  switch (cls) {
    case "willing_to_meet": {
      meetingId = await createMeetingProposal(workspaceId, {
        ownerUserId: reply.userId ?? null,
        relatedType: rel.relatedType,
        relatedId: rel.relatedId,
        name,
        email: reply.fromEmail,
        descriptor: `replied with interest: "${truncate(reply.bodyText || reply.bodyHtml, 200)}"`,
        source: "inbound",
      });
      await createReplyTask(db, workspaceId, reply, `Meeting requested — ${name}`, "high", "meeting_prep");
      action = "meeting_proposed";
      break;
    }
    case "follow_up_question":
      await createReplyTask(db, workspaceId, reply, `Answer ${name}'s question`, "high", "manual_email");
      action = "task_created";
      break;
    case "person_referral":
      await createReplyTask(db, workspaceId, reply, `Save referral from ${name}`, "normal", "crm_update");
      action = "task_created";
      break;
    case "already_left_company_or_not_right_person":
      await createReplyTask(db, workspaceId, reply, `Re-verify contact — ${name} may have left`, "normal", "crm_update");
      action = "task_created";
      break;
    case "not_interested":
      await createReplyTask(db, workspaceId, reply, `${name} not interested — review`, "low", "follow_up");
      action = "marked";
      break;
    case "unsubscribe":
      try {
        await db.insert(emailSuppressions).values({
          workspaceId,
          email: reply.fromEmail,
          reason: "unsubscribe",
          draftId: reply.draftId ?? null,
          contactId: reply.contactId ?? null,
          notes: "Auto-suppressed from inbound reply classification",
        } as never).onDuplicateKeyUpdate({ set: { notes: "Auto-suppressed from inbound reply classification" } });
      } catch (e) { console.error(`[ReplyClassifier] suppression insert failed:`, e); }
      action = "suppressed";
      break;
    case "out_of_office":
      action = "ooo_noted";
      break;
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

/** Classify (and, in 'auto' mode, action) up to `limit` unclassified replies for one workspace. */
export async function runConversationAutopilotForWorkspace(
  workspaceId: number,
  mode: "approval" | "auto",
  limit: number,
): Promise<{ classified: number; actioned: number }> {
  const db = await getDb();
  if (!db) return { classified: 0, actioned: 0 };

  const rows = await db.select().from(emailReplies)
    .where(and(eq(emailReplies.workspaceId, workspaceId), isNull(emailReplies.classifiedAt)))
    .orderBy(desc(emailReplies.receivedAt))
    .limit(limit);

  let classified = 0, actioned = 0;
  for (const reply of rows) {
    const cls = await classifyReply(workspaceId, reply);
    if (!cls) continue;
    classified++;
    if (mode === "auto") {
      const a = await applyReplyAction(workspaceId, { ...reply, replyClass: cls.replyClass }, false);
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

  for (const ws of rows) {
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
