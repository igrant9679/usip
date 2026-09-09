/**
 * approvalTasks — turn the two "approve" queues that were only ever tasks
 * into real approve-and-send actions (owner ask 2026-09-09).
 *
 * Two autopilots in Approve mode park their work as ordinary OPEN tasks:
 *   - Chat follow-up: "Follow up: <visitor> left chat without booking", the
 *     suggested email in the description (services/chatFollowUp.ts).
 *   - Social Autopilot invites: "Send LinkedIn invite to <name>", the
 *     LinkedIn URL in the description (services/socialAutopilot.ts).
 * Until now a rep could only tick them done and send by hand elsewhere. Here
 * each becomes one action that sends through the SAME path the autopilot's
 * Auto mode uses, then closes the task with disposition "sent".
 *
 * The task is the queue row, so recognition is by shape (title + description
 * markers — the same predicate attention.summary counts). New follow-up
 * tasks carry an explicit "To:" line; older ones fall back to the linked
 * lead's email, an email in the title, or the chat session by visitor name.
 *
 * LinkedIn openers ("Send LinkedIn opener to …") stay manual: the task does
 * not carry the connection's provider id, and guessing it is how a message
 * goes to the wrong person.
 */
import { and, desc, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import { activities, chatSessions, leads, tasks, unipileAccounts, unipileInvites } from "../../drizzle/schema";
import { getDb } from "../db";
import { sendWorkspaceEmail } from "../emailDelivery";
import { textToHtml } from "../mergeVars";

export type ApprovalTaskKind = "chat_follow_up" | "social_invite";
export interface ApprovalTaskRow {
  id: number; kind: ApprovalTaskKind; title: string; ownerUserId: number | null; dueAt: Date | null; createdAt: Date;
  /** chat_follow_up */ to?: string | null; subject?: string | null; body?: string | null;
  /** social_invite */ linkedinUrl?: string | null;
  relatedType: string | null; relatedId: number | null;
}

const CHAT_TITLE = "Follow up:%";
const CHAT_DESC = "Suggested email%";
const SOCIAL_TITLE = "Send LinkedIn invite to %";

/** Parse the suggested-email description. Returns nulls when the shape is not the one chatFollowUp writes. */
export function parseChatFollowUp(description: string | null | undefined): { to: string | null; subject: string | null; body: string | null } {
  const d = (description ?? "").replace(/\r\n/g, "\n");
  if (!d.startsWith("Suggested email")) return { to: null, subject: null, body: null };
  const to = d.match(/^To:\s*(\S+@\S+)\s*$/m)?.[1] ?? null;
  const subjMatch = d.match(/^Subject:\s*(.+)$/m);
  const subject = subjMatch?.[1]?.trim() ?? null;
  const bodyStart = subjMatch ? d.indexOf(subjMatch[0]) + subjMatch[0].length : -1;
  const body = bodyStart >= 0 ? d.slice(bodyStart).replace(/^\s+/, "").trim() : null;
  return { to, subject, body: body || null };
}

async function resolveRecipient(workspaceId: number, t: { title: string; relatedType: string | null; relatedId: number | null }, parsedTo: string | null): Promise<string | null> {
  if (parsedTo) return parsedTo;
  const db = await getDb();
  if (!db) return null;
  if (t.relatedType === "lead" && t.relatedId) {
    const [l] = await db.select({ email: leads.email }).from(leads).where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, t.relatedId))).limit(1);
    if (l?.email) return l.email;
  }
  const who = t.title.replace(/^Follow up:\s*/, "").replace(/\s+left chat without booking\s*$/, "").trim();
  if (/\S+@\S+/.test(who)) return who;
  if (who) {
    const [s] = await db.select({ email: chatSessions.visitorEmail }).from(chatSessions)
      .where(and(eq(chatSessions.workspaceId, workspaceId), eq(chatSessions.visitorName, who), isNotNull(chatSessions.visitorEmail)))
      .orderBy(desc(chatSessions.createdAt)).limit(1);
    if (s?.email) return s.email;
  }
  return null;
}

export async function listApprovalTasks(workspaceId: number): Promise<{ chatFollowUps: ApprovalTaskRow[]; socialInvites: ApprovalTaskRow[] }> {
  const db = await getDb();
  if (!db) return { chatFollowUps: [], socialInvites: [] };
  const chat = await db.select().from(tasks).where(and(
    eq(tasks.workspaceId, workspaceId), eq(tasks.status, "open"), eq(tasks.type, "follow_up"),
    like(tasks.title, CHAT_TITLE), like(tasks.description, CHAT_DESC),
  )).orderBy(desc(tasks.createdAt)).limit(100);
  const social = await db.select().from(tasks).where(and(
    eq(tasks.workspaceId, workspaceId), eq(tasks.status, "open"), eq(tasks.type, "social_touch"),
    like(tasks.title, SOCIAL_TITLE), like(tasks.description, "http%"),
  )).orderBy(desc(tasks.createdAt)).limit(100);
  const chatRows: ApprovalTaskRow[] = [];
  for (const t of chat) {
    const p = parseChatFollowUp(t.description);
    chatRows.push({ id: t.id, kind: "chat_follow_up", title: t.title, ownerUserId: t.ownerUserId ?? null, dueAt: t.dueAt ?? null, createdAt: t.createdAt,
      to: await resolveRecipient(workspaceId, t, p.to), subject: p.subject, body: p.body, relatedType: t.relatedType ?? null, relatedId: t.relatedId ?? null });
  }
  const socialRows: ApprovalTaskRow[] = social.map((t) => ({ id: t.id, kind: "social_invite", title: t.title, ownerUserId: t.ownerUserId ?? null, dueAt: t.dueAt ?? null, createdAt: t.createdAt,
    linkedinUrl: (t.description ?? "").trim(), relatedType: t.relatedType ?? null, relatedId: t.relatedId ?? null }));
  return { chatFollowUps: chatRows, socialInvites: socialRows };
}

async function closeTask(workspaceId: number, taskId: number, disposition: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(tasks).set({ status: "done", completedAt: new Date(), disposition, snoozedUntil: null } as never)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)));
}

export type SendOutcome = { ok: true; detail: string } | { ok: false; reason: string };

/** Approve one chat follow-up: send the suggested email exactly as the Auto branch would, then close the task. */
export async function sendChatFollowUpTask(workspaceId: number, taskId: number, actorUserId: number | null): Promise<SendOutcome> {
  const db = await getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };
  const [t] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId))).limit(1);
  if (!t) return { ok: false, reason: "not_found" };
  if (t.status !== "open") return { ok: false, reason: `task is ${t.status}` };
  const p = parseChatFollowUp(t.description);
  if (!p.subject || !p.body) return { ok: false, reason: "not_a_suggested_email" };
  const to = await resolveRecipient(workspaceId, t, p.to);
  if (!to) return { ok: false, reason: "no_recipient" };
  // Claim before sending (at-most-once, same rule as the Auto branch).
  const claimed = await db.update(tasks).set({ status: "in_progress" } as never)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId), eq(tasks.status, "open")));
  if (Number((claimed as unknown as Array<{ affectedRows?: number }>)[0]?.affectedRows ?? 0) !== 1) return { ok: false, reason: "already_taken" };
  const res = await sendWorkspaceEmail(workspaceId, { to, subject: p.subject, text: p.body, html: textToHtml(p.body) });
  if (!res.ok) {
    await db.update(tasks).set({ status: "open" } as never).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)));
    return { ok: false, reason: res.reason ?? "send_failed" };
  }
  await closeTask(workspaceId, taskId, "sent");
  if (t.relatedType === "lead" && t.relatedId) {
    await db.insert(activities).values({ workspaceId, type: "email", relatedType: "lead", relatedId: t.relatedId, subject: `Chat follow-up: ${p.subject}`, body: p.body, actorUserId } as never).catch(() => {});
  }
  return { ok: true, detail: `Sent "${p.subject}" to ${to}` };
}

/** Approve one Social Autopilot invite task: the same gate, note, send and records as Auto mode. */
export async function sendSocialInviteTask(workspaceId: number, taskId: number, actorUserId: number | null): Promise<SendOutcome> {
  const db = await getDb();
  if (!db) return { ok: false, reason: "db_unavailable" };
  const [t] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId))).limit(1);
  if (!t) return { ok: false, reason: "not_found" };
  if (t.status !== "open") return { ok: false, reason: `task is ${t.status}` };
  const url = (t.description ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: "no_linkedin_url" };
  const slug = url.replace(/\/+$/, "").split("/").pop() || url;
  const accts = await db.select({ userId: unipileAccounts.userId, id: unipileAccounts.unipileAccountId })
    .from(unipileAccounts).where(and(eq(unipileAccounts.workspaceId, workspaceId), eq(unipileAccounts.provider, "LINKEDIN")));
  if (accts.length === 0) return { ok: false, reason: "no_linkedin_account" };
  const owned = accts.find((a) => a.userId != null && a.userId === (t.ownerUserId ?? actorUserId));
  const account = owned ?? accts[0];
  const [dup] = await db.select({ id: unipileInvites.id }).from(unipileInvites)
    .where(and(eq(unipileInvites.workspaceId, workspaceId), eq(unipileInvites.recipientProviderId, slug))).limit(1);
  if (dup) { await closeTask(workspaceId, taskId, "already_invited"); return { ok: false, reason: "already_invited" }; }
  const { checkLinkedInAction, recordLinkedInAction } = await import("./linkedin/activityGate");
  const gate = await checkLinkedInAction({ workspaceId, unipileAccountId: account.id, kind: "invite" });
  if (!gate.allowed) return { ok: false, reason: `held by LinkedIn limits: ${gate.message}` };
  const name = t.title.replace(/^Send LinkedIn invite to\s*/, "").trim() || "there";
  let leadTitle: string | null = null, leadCompany: string | null = null;
  if (t.relatedType === "lead" && t.relatedId) {
    const [l] = await db.select({ title: leads.title, company: leads.company }).from(leads).where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, t.relatedId))).limit(1);
    leadTitle = l?.title ?? null; leadCompany = l?.company ?? null;
  }
  const { generateInviteNote } = await import("./socialAutopilot");
  const { sendLinkedInInvitation } = await import("../lib/unipile");
  const note = await generateInviteNote(workspaceId, { name, title: leadTitle, company: leadCompany });
  const claimed = await db.update(tasks).set({ status: "in_progress" } as never)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId), eq(tasks.status, "open")));
  if (Number((claimed as unknown as Array<{ affectedRows?: number }>)[0]?.affectedRows ?? 0) !== 1) return { ok: false, reason: "already_taken" };
  try {
    await sendLinkedInInvitation({ accountId: account.id, providerId: slug, message: note });
  } catch (e) {
    await db.update(tasks).set({ status: "open" } as never).where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)));
    return { ok: false, reason: (e as Error).message.slice(0, 160) };
  }
  await recordLinkedInAction({ workspaceId, unipileAccountId: account.id, kind: "invite", source: "social_autopilot", targetIdentifier: slug });
  await db.insert(unipileInvites).values({
    workspaceId, userId: account.userId ?? actorUserId ?? 0, unipileAccountId: account.id,
    recipientProviderId: slug, recipientName: name, message: note, status: "pending",
    ...(t.relatedType === "lead" && t.relatedId ? { linkedLeadId: t.relatedId } : {}),
  } as never);
  if (t.relatedType === "lead" && t.relatedId) {
    await db.insert(activities).values({ workspaceId, type: "linkedin", relatedType: "lead", relatedId: t.relatedId, subject: "LinkedIn connection request sent (approved)", body: note, actorUserId } as never).catch(() => {});
  }
  await closeTask(workspaceId, taskId, "sent");
  return { ok: true, detail: `Invite sent to ${name}` };
}

export async function sendAllApprovalTasks(workspaceId: number, kind: ApprovalTaskKind, actorUserId: number | null, limit = 50): Promise<{ sent: number; failed: Array<{ id: number; reason: string }> }> {
  const q = await listApprovalTasks(workspaceId);
  const rows = (kind === "chat_follow_up" ? q.chatFollowUps : q.socialInvites).slice(0, limit);
  let sent = 0;
  const failed: Array<{ id: number; reason: string }> = [];
  for (const r of rows) {
    const out = kind === "chat_follow_up" ? await sendChatFollowUpTask(workspaceId, r.id, actorUserId) : await sendSocialInviteTask(workspaceId, r.id, actorUserId);
    if (out.ok) sent++; else { failed.push({ id: r.id, reason: out.reason }); if (/held by LinkedIn limits/.test(out.reason)) break; }
    await new Promise((res) => setTimeout(res, kind === "chat_follow_up" ? 1000 : 3000));
  }
  return { sent, failed };
}

/** Keep the old task shape queryable for the attention panel: the ids of open approval tasks. */
export async function approvalTaskIds(workspaceId: number): Promise<number[]> {
  const q = await listApprovalTasks(workspaceId);
  return [...q.chatFollowUps, ...q.socialInvites].map((r) => r.id);
}

// Referenced so the import list stays honest if the helpers above change.
void inArray; void sql;
