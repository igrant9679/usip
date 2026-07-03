/**
 * Social Autopilot — the LinkedIn/social channel of Velocity's autonomous
 * meeting-booking engine.
 *
 * The highest-leverage moment in social selling is the instant a prospect
 * ACCEPTS your connection request: the channel is open and intent is warm.
 * Unipile surfaces that moment via the `users` webhook `new_relation` event
 * (LinkedIn has no accept-invitation API — acceptance can only be *detected*,
 * never performed, so everything here stays inside the authorized/compliant
 * layer). On that event we autonomously send a personalized opener DM, which
 * then flows back through the inbound messaging webhook → Conversation
 * Autopilot → meeting proposal. End-to-end, no rep touch.
 *
 * Governed by workspace_settings.socialAutopilotMode:
 *   off      — do nothing (default)
 *   approval — draft the opener into a task for the rep to review + send
 *   auto     — send the opener immediately (subject to the daily cap)
 *
 * Per-user identity: the opener is sent from the REP'S OWN connected account
 * (the one that received the acceptance), never a shared/system identity.
 */
import { and, eq, gte, like, sql } from "drizzle-orm";
import {
  contacts,
  tasks,
  unipileAccounts,
  unipileMessages,
  workspaceSettings,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { sendMessage } from "../lib/unipile";

interface NewRelationPayload {
  account_id?: string;
  account_type?: string;
  user_full_name?: string;
  user_provider_id?: string;
  user_public_identifier?: string;
  user_profile_url?: string;
  user_picture_url?: string;
}

/** Generate a short, human, first-touch LinkedIn opener. Plain text (no JSON). */
async function generateOpener(
  workspaceId: number,
  who: { name: string; title?: string | null; company?: string | null },
): Promise<string> {
  const firstName = who.name.split(/\s+/)[0] || who.name;
  const ctx = [
    who.title ? `their title is ${who.title}` : null,
    who.company ? `they work at ${who.company}` : null,
  ]
    .filter(Boolean)
    .join("; ");
  const prompt = `Write a warm, concise LinkedIn opening message to ${firstName}, who just accepted my connection request${ctx ? ` (${ctx})` : ""}.

Rules:
- 2 sentences max, under 40 words total.
- Sound like a real person, not a pitch. No "I hope this finds you well".
- Thank them for connecting, then one light, genuine, curiosity-driven line that opens a conversation. Do NOT ask for a meeting yet.
- No emojis, no hashtags, no links. Return ONLY the message text.`;

  try {
    const res = await invokeLLM({
      workspaceId,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 200,
    } as never);
    const txt = (res as any)?.choices?.[0]?.message?.content;
    if (typeof txt === "string" && txt.trim()) {
      return txt.trim().replace(/^["']|["']$/g, "");
    }
  } catch (err) {
    console.error("[SocialAutopilot] opener generation failed:", err);
  }
  // Deterministic fallback so the flow never stalls on an LLM hiccup.
  return `Thanks for connecting, ${firstName}! Curious what's keeping you busy these days — always glad to trade notes with people doing interesting work.`;
}

/**
 * Handle a single `new_relation` (invitation-accepted) event. Idempotent per
 * (account, provider_id): if we already have an outbound message to this
 * connection we skip, so Unipile's up-to-8h polling re-delivery can't double-send.
 * Returns a short status string for logging.
 */
export async function handleNewRelation(payload: NewRelationPayload): Promise<string> {
  const db = await getDb();
  if (!db) return "no_db";

  const accountId = payload.account_id;
  const providerId = payload.user_provider_id;
  const name = (payload.user_full_name || "there").trim();
  const publicId = payload.user_public_identifier || null;
  if (!accountId || !providerId) return "missing_ids";

  // Resolve the receiving rep's own account.
  const [acct] = await db
    .select({ workspaceId: unipileAccounts.workspaceId, userId: unipileAccounts.userId })
    .from(unipileAccounts)
    .where(eq(unipileAccounts.unipileAccountId, accountId))
    .limit(1);
  if (!acct) {
    console.warn(`[SocialAutopilot] new_relation for unknown account ${accountId}`);
    return "unknown_account";
  }
  const workspaceId = acct.workspaceId;
  const ownerUserId = acct.userId ?? null;

  const [ws] = await db
    .select({
      mode: workspaceSettings.socialAutopilotMode,
      cap: workspaceSettings.socialAutopilotDailyCap,
    })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  const mode = ws?.mode ?? "off";
  if (mode === "off") return "off";

  // Dedupe: have we already messaged this connection from this account?
  const [existing] = await db
    .select({ id: unipileMessages.id })
    .from(unipileMessages)
    .where(
      and(
        eq(unipileMessages.unipileAccountId, accountId),
        eq(unipileMessages.recipientProviderId, providerId),
        eq(unipileMessages.direction, "outbound"),
      ),
    )
    .limit(1);
  if (existing) return "already_opened";

  // Best-effort match to a contact for personalization + CRM linkage.
  let linkedContactId: number | null = null;
  let title: string | null = null;
  let company: string | null = null;
  if (publicId) {
    const [c] = await db
      .select({ id: contacts.id, title: contacts.title, companyName: contacts.companyName })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), like(contacts.linkedinUrl, `%${publicId}%`)))
      .limit(1);
    if (c) {
      linkedContactId = c.id;
      title = c.title ?? null;
      company = (c.companyName as string | null) ?? null;
    }
  }

  const opener = await generateOpener(workspaceId, { name, title, company });

  // Approval mode: draft into a task, let the rep send.
  if (mode === "approval") {
    await db.insert(tasks).values({
      workspaceId,
      title: `Send LinkedIn opener to ${name} (connection accepted)`,
      description: opener,
      type: "linkedin_dm",
      priority: "high",
      status: "open",
      dueAt: new Date(Date.now() + 86400000),
      ownerUserId,
      relatedType: linkedContactId ? "contact" : null,
      relatedId: linkedContactId,
      source: "ai",
    } as never);
    return "approval_task";
  }

  // Auto mode: enforce the per-workspace daily send cap.
  const cap = ws?.cap ?? 50;
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(unipileMessages)
    .where(
      and(
        eq(unipileMessages.workspaceId, workspaceId),
        eq(unipileMessages.direction, "outbound"),
        eq(unipileMessages.provider, "linkedin"),
        gte(unipileMessages.createdAt, since),
      ),
    );
  if (Number(n) >= cap) {
    // Fall back to a task so the accept isn't dropped silently.
    await db.insert(tasks).values({
      workspaceId,
      title: `Send LinkedIn opener to ${name} (daily auto-cap reached)`,
      description: opener,
      type: "linkedin_dm",
      priority: "medium",
      status: "open",
      dueAt: new Date(Date.now() + 86400000),
      ownerUserId,
      relatedType: linkedContactId ? "contact" : null,
      relatedId: linkedContactId,
      source: "ai",
    } as never);
    return "capped_task";
  }

  try {
    const sent = await sendMessage({ accountId, attendeesIds: [providerId], text: opener });
    await db.insert(unipileMessages).values({
      workspaceId,
      unipileAccountId: accountId,
      provider: "linkedin",
      chatId: sent.id || providerId,
      messageId: sent.id || `opener-${providerId}`,
      direction: "outbound",
      recipientName: name,
      recipientProviderId: providerId,
      text: opener,
      linkedContactId,
    } as never);
    console.log(`[SocialAutopilot] auto opener sent to ${name} (account ${accountId})`);
    return "opener_sent";
  } catch (err) {
    console.error("[SocialAutopilot] opener send failed:", err);
    // Preserve the opportunity as a task on send failure.
    await db.insert(tasks).values({
      workspaceId,
      title: `Send LinkedIn opener to ${name} (auto-send failed)`,
      description: opener,
      type: "linkedin_dm",
      priority: "high",
      status: "open",
      dueAt: new Date(Date.now() + 86400000),
      ownerUserId,
      relatedType: linkedContactId ? "contact" : null,
      relatedId: linkedContactId,
      source: "ai",
    } as never);
    return "send_failed_task";
  }
}
