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
import { and, desc, eq, gte, like, ne, sql } from "drizzle-orm";
import {
  activities,
  contacts,
  leads,
  tasks,
  unipileAccounts,
  unipileInvites,
  unipileMessages,
  workspaceSettings,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { listUserPosts, reactToPost, sendLinkedInInvitation, sendMessage } from "../lib/unipile";

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

// ─── Outbound auto-invitations ────────────────────────────────────────────
// The proactive half of the Social Autopilot: instead of waiting for a rep to
// enroll leads in a sequence, auto-send connection invitations to un-invited
// LinkedIn leads (those imported via search carry customFields.linkedinUrl).
// Every accept then fires handleNewRelation → opener → meeting. Fully hands-off.
//
// Compliance/safety: uses the AUTHORIZED Unipile invite endpoint from the
// lead-owner's OWN account; hard-capped well under LinkedIn's invite ceiling;
// dedupes against unipile_invites; only active (new/working) leads; off by default.

const INVITE_HARD_CAP = 20; // per workspace/day — LinkedIn throttles invites hard

/** Short, personalized connection-request note (<200 chars, LinkedIn's limit). */
async function generateInviteNote(
  workspaceId: number,
  who: { name: string; title?: string | null; company?: string | null },
): Promise<string> {
  const firstName = who.name.split(/\s+/)[0] || who.name;
  const ctx = [who.title ? `a ${who.title}` : null, who.company ? `at ${who.company}` : null].filter(Boolean).join(" ");
  const prompt = `Write a LinkedIn connection-request note to ${firstName}${ctx ? ` (${ctx})` : ""}.
Rules: under 180 characters, warm and specific, no pitch, no "I hope this finds you well", no emojis/links. Return ONLY the note text.`;
  try {
    const res = await invokeLLM({ workspaceId, messages: [{ role: "user", content: prompt }], maxTokens: 120 } as never);
    const txt = (res as any)?.choices?.[0]?.message?.content;
    if (typeof txt === "string" && txt.trim()) return txt.trim().replace(/^["']|["']$/g, "").slice(0, 195);
  } catch (err) {
    console.error("[SocialAutopilot] invite note generation failed:", err);
  }
  return `Hi ${firstName}, I come across a lot of teams in your space and would love to connect and trade notes.`.slice(0, 195);
}

/**
 * Best-effort social warming: like the target's most recent post so the invite
 * lands on a slightly warmer relationship. Never throws — any failure (no
 * posts, private profile, wrong id) is swallowed so it can't block the invite.
 */
async function warmBeforeInvite(accountId: string, identifier: string): Promise<void> {
  try {
    const { items } = await listUserPosts(accountId, identifier, { limit: 1 });
    const socialId = items[0]?.social_id;
    if (socialId) {
      await reactToPost(accountId, socialId, "like");
      console.log(`[SocialAutopilot] warmed ${identifier} (liked latest post)`);
    }
  } catch (err) {
    // Warming is optional — log at debug level and move on.
    console.debug?.(`[SocialAutopilot] warm skipped for ${identifier}:`, (err as Error)?.message);
  }
}

/** Auto-send (or draft) connection invitations for one workspace. */
export async function runSocialAutopilotInvitesForWorkspace(
  workspaceId: number,
): Promise<{ sent: number; tasked: number; skipped: number }> {
  const out = { sent: 0, tasked: 0, skipped: 0 };
  const db = await getDb();
  if (!db) return out;

  const [ws] = await db
    .select({ mode: workspaceSettings.socialAutopilotMode, cap: workspaceSettings.socialAutopilotDailyCap })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  const mode = ws?.mode ?? "off";
  if (mode === "off") return out;

  const cap = Math.min(ws?.cap ?? INVITE_HARD_CAP, INVITE_HARD_CAP);
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const [{ n: sentToday }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(unipileInvites)
    .where(and(eq(unipileInvites.workspaceId, workspaceId), gte(unipileInvites.sentAt, since)));
  let budget = cap - Number(sentToday ?? 0);
  if (budget <= 0) return out;

  // Workspace LinkedIn accounts, indexed by owning rep.
  const accts = await db
    .select({ userId: unipileAccounts.userId, id: unipileAccounts.unipileAccountId })
    .from(unipileAccounts)
    .where(and(eq(unipileAccounts.workspaceId, workspaceId), eq(unipileAccounts.provider, "LINKEDIN")));
  if (!accts.length) return out;
  const acctByUser = new Map<number, string>();
  for (const a of accts) if (a.userId != null) acctByUser.set(a.userId, a.id);
  const fallback = accts[0];

  // Candidate leads: a LinkedIn URL in customFields, still active, not yet invited.
  const candidates = await db
    .select({
      id: leads.id, firstName: leads.firstName, lastName: leads.lastName,
      title: leads.title, company: leads.company, ownerUserId: leads.ownerUserId,
      customFields: leads.customFields,
    })
    .from(leads)
    .where(and(
      eq(leads.workspaceId, workspaceId),
      sql`JSON_UNQUOTE(JSON_EXTRACT(${leads.customFields}, '$.linkedinUrl')) IS NOT NULL`,
      sql`${leads.status} in ('new','working')`,
    ))
    .orderBy(desc(leads.createdAt))
    .limit(budget * 4);

  for (const lead of candidates) {
    if (budget <= 0) break;
    const url = (lead.customFields as any)?.linkedinUrl as string | undefined;
    if (!url) { out.skipped++; continue; }
    const slug = url.replace(/\/+$/, "").split("/").pop() || url;

    const [dup] = await db
      .select({ id: unipileInvites.id })
      .from(unipileInvites)
      .where(and(eq(unipileInvites.workspaceId, workspaceId), eq(unipileInvites.recipientProviderId, slug)))
      .limit(1);
    if (dup) { out.skipped++; continue; }

    const name = `${lead.firstName ?? ""} ${lead.lastName ?? ""}`.trim() || "there";
    const ownerAcct = (lead.ownerUserId != null && acctByUser.get(lead.ownerUserId)) || fallback.id;
    const ownerUserId = (lead.ownerUserId != null && acctByUser.has(lead.ownerUserId)) ? lead.ownerUserId : fallback.userId;

    if (mode === "approval") {
      await db.insert(tasks).values({
        workspaceId, title: `Send LinkedIn invite to ${name}`, description: url,
        type: "linkedin_invite", priority: "medium", status: "open",
        dueAt: new Date(Date.now() + 86400000), ownerUserId: lead.ownerUserId ?? null,
        relatedType: "lead", relatedId: lead.id, source: "ai",
      } as never);
      out.tasked++; budget--; continue;
    }

    // auto
    // Warming touch: like the lead's most recent post just before inviting —
    // best-effort, never blocks the invite (wrong/absent post just no-ops).
    await warmBeforeInvite(ownerAcct, slug);
    const note = await generateInviteNote(workspaceId, { name, title: lead.title, company: lead.company });
    try {
      await sendLinkedInInvitation({ accountId: ownerAcct, providerId: slug, message: note });
      await db.insert(unipileInvites).values({
        workspaceId, userId: ownerUserId ?? fallback.userId ?? 0, unipileAccountId: ownerAcct,
        recipientProviderId: slug, recipientName: name, message: note, status: "pending",
        linkedLeadId: lead.id,
      } as never);
      await db.insert(activities).values({
        workspaceId, type: "linkedin", relatedType: "lead", relatedId: lead.id,
        subject: "LinkedIn connection request sent (Social Autopilot)", body: note,
      } as never);
      out.sent++; budget--;
    } catch (err) {
      console.error(`[SocialAutopilot] invite send failed for lead ${lead.id}:`, err);
      out.skipped++;
    }
  }

  await db.update(workspaceSettings)
    .set({ socialAutopilotLastRunAt: new Date() } as never)
    .where(eq(workspaceSettings.workspaceId, workspaceId));
  return out;
}

/** Cron entry: run auto-invites for every workspace with Social Autopilot on. */
export async function runSocialAutopilotAllWorkspaces(): Promise<{ workspaces: number; sent: number; tasked: number }> {
  const db = await getDb();
  if (!db) return { workspaces: 0, sent: 0, tasked: 0 };
  const rows = await db
    .select({ workspaceId: workspaceSettings.workspaceId })
    .from(workspaceSettings)
    .where(ne(workspaceSettings.socialAutopilotMode, "off"));
  let workspaces = 0, sent = 0, tasked = 0;
  for (const r of rows) {
    try {
      const res = await runSocialAutopilotInvitesForWorkspace(r.workspaceId);
      workspaces++; sent += res.sent; tasked += res.tasked;
    } catch (err) {
      console.error(`[SocialAutopilot] workspace ${r.workspaceId} invite run failed:`, err);
    }
  }
  if (sent || tasked) console.log(`[SocialAutopilot] invites — ${sent} sent, ${tasked} tasked across ${workspaces} workspace(s)`);
  return { workspaces, sent, tasked };
}
