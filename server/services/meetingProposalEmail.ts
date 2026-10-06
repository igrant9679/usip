/**
 * meetingProposalEmail.ts — "No event until accepted" (owner, 2026-10-06).
 *
 * "why are you still booking meetings on my calendar for meetings that
 * haven't been accepted yet!" A meeting proposal used to go out as a
 * calendar invite, which puts the event on the owner's calendar at once.
 * Now an un-agreed proposal goes out as an email from the owner's mailbox:
 * the invite text, then each offered time as a link to /m/:token?t=i. The
 * page only shows the time; booking needs its Confirm button (a POST), so a
 * mail scanner that opens every link books nothing. The calendar event is
 * made only when the prospect confirms (meetingScheduler.confirmProposalPick).
 */
import { randomBytes } from "crypto";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { activities, sendingAccounts, unipileAccounts, users, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { createEmailAdapter } from "../emailAdapter";
import { assertSendAllowed } from "../sendLimits";
import { isSuppressed, makeUnsubscribeUrl, unsubscribeHeaders } from "../unsubscribe";
import { appBaseUrl } from "../appUrl";
import { escapeHtml } from "@shared/escapeHtml";
import { formatInZone } from "@shared/availability";

/** An unguessable link token: 32 random bytes, URL-safe. */
export function newProposalToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The page a time link opens; `index` preselects that time. */
export function proposalPickUrl(token: string, index?: number): string {
  return `${appBaseUrl()}/m/${encodeURIComponent(token)}${index == null ? "" : `?t=${index}`}`;
}

export type ProposalMeeting = {
  id: number;
  title: string;
  inviteMessage: string | null;
  contactEmail: string;
  contactName: string | null;
  ownerUserId: number | null;
  relatedType: string | null;
  relatedId: number | null;
};

export type ProposalEmailResult =
  | { ok: true; fromEmail: string; messageId: string | null }
  | { ok: false; reason: "no_mailbox" | "suppressed" | "send_limit" | "send_failed"; detail?: string };

type Account = typeof sendingAccounts.$inferSelect;

/**
 * The mailbox the proposal goes from: the owner's own connected mailbox,
 * else the workspace's first enabled one (the same precedence and the same
 * `enabled` rule as a person's email from a record).
 */
async function proposalSender(workspaceId: number, ownerUserId: number | null): Promise<Account | null> {
  const db = await getDb();
  if (!db) return null;
  if (ownerUserId) {
    const [personal] = await db
      .select({ sa: sendingAccounts })
      .from(sendingAccounts)
      .innerJoin(unipileAccounts, eq(sendingAccounts.unipileAccountId, unipileAccounts.unipileAccountId))
      .where(and(
        eq(sendingAccounts.workspaceId, workspaceId),
        eq(unipileAccounts.userId, ownerUserId),
        isNotNull(sendingAccounts.unipileAccountId),
        eq(sendingAccounts.enabled, true),
      ))
      .limit(1);
    if (personal) return personal.sa;
  }
  const [fallback] = await db
    .select()
    .from(sendingAccounts)
    .where(and(eq(sendingAccounts.workspaceId, workspaceId), eq(sendingAccounts.enabled, true)))
    .orderBy(asc(sendingAccounts.id))
    .limit(1);
  return fallback ?? null;
}

/** The owner's signature, else the workspace's. */
async function signatureFor(workspaceId: number, ownerUserId: number | null): Promise<string> {
  const db = await getDb();
  if (!db) return "";
  if (ownerUserId) {
    const [u] = await db.select({ sig: users.emailSignature }).from(users).where(eq(users.id, ownerUserId)).limit(1);
    if (u?.sig?.trim()) return u.sig.trim();
  }
  const [ws] = await db.select({ sig: workspaceSettings.emailSignature }).from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId)).limit(1);
  return (ws?.sig ?? "").trim();
}

/** Plain text with bare URLs made clickable, one <p> per line. */
function paragraphsHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const linked = escapeHtml(line).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
      return `<p style="margin:0 0 8px">${linked || "&nbsp;"}</p>`;
    })
    .join("");
}

/** The email, as HTML and text. Pure, so it is tested without a mailbox. */
export function proposalEmailBodies(input: {
  inviteMessage: string | null;
  times: Date[];
  timezone: string;
  token: string;
  signature: string;
  unsubscribeUrl: string;
}): { html: string; text: string } {
  const message = (input.inviteMessage ?? "").trim();
  const labels = input.times.map((t) => formatInZone(t, input.timezone));
  const buttons = labels
    .map((label, i) => `<a href="${escapeHtml(proposalPickUrl(input.token, i))}" style="display:inline-block;margin:0 8px 8px 0;padding:9px 14px;border:1px solid #c9ccd4;border-radius:8px;color:#111827;text-decoration:none;font-weight:600">${escapeHtml(label)}</a>`)
    .join("");
  const sigHtml = input.signature
    ? `<div style="margin-top:18px;color:#555;line-height:1.4">${input.signature.split("\n").map(escapeHtml).join("<br>")}</div>`
    : "";
  const html =
    (message ? paragraphsHtml(message) : "") +
    `<p style="margin:18px 0 10px;font-weight:600">Pick a time that works for you:</p>` +
    `<div>${buttons}</div>` +
    `<p style="margin:6px 0 0;color:#6b7280;font-size:13px">Each link opens a page to confirm that time, and the calendar invite follows. If none of these work, just reply to this email.</p>` +
    sigHtml +
    `<p style="margin:32px 0 0;color:#9ca3af;font-size:11px;text-align:center;line-height:1.5">Don't want these emails? <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a></p>`;
  const text =
    (message ? `${message}\n\n` : "") +
    `Pick a time that works for you:\n` +
    labels.map((label, i) => `- ${label}: ${proposalPickUrl(input.token, i)}`).join("\n") +
    `\n\nEach link opens a page to confirm that time, and the calendar invite follows. If none of these work, just reply to this email.` +
    (input.signature ? `\n\n${input.signature}` : "") +
    `\n\n—\nUnsubscribe: ${input.unsubscribeUrl}`;
  return { html, text };
}

/** Email the proposal. Never throws: the result says what happened. */
export async function sendProposalEmail(input: {
  workspaceId: number;
  meeting: ProposalMeeting;
  times: Date[];
  timezone: string;
  token: string;
}): Promise<ProposalEmailResult> {
  const { workspaceId, meeting: m } = input;
  if (await isSuppressed(workspaceId, m.contactEmail)) return { ok: false, reason: "suppressed" };
  const account = await proposalSender(workspaceId, m.ownerUserId);
  if (!account) return { ok: false, reason: "no_mailbox" };
  try {
    await assertSendAllowed(workspaceId, account.id);
  } catch (e) {
    return { ok: false, reason: "send_limit", detail: e instanceof Error ? e.message : String(e) };
  }
  const base = appBaseUrl();
  const { html, text } = proposalEmailBodies({
    inviteMessage: m.inviteMessage,
    times: input.times,
    timezone: input.timezone,
    token: input.token,
    signature: await signatureFor(workspaceId, m.ownerUserId),
    unsubscribeUrl: makeUnsubscribeUrl(base, workspaceId, m.contactEmail),
  });
  let messageId: string | null = null;
  try {
    const res = await createEmailAdapter(account).sendEmail({
      fromEmail: account.fromEmail,
      fromName: account.fromName ?? account.name,
      to: m.contactEmail,
      subject: m.title,
      bodyHtml: html,
      bodyText: text,
      // No click tracking: it would rewrite the time links.
      track: false,
      logMeta: {
        source: "meeting_proposal",
        sourceLabel: m.title,
        contactId: m.relatedType === "contact" ? m.relatedId : null,
        leadId: m.relatedType === "lead" ? m.relatedId : null,
      },
      headers: unsubscribeHeaders(base, workspaceId, m.contactEmail),
    });
    messageId = res.messageId ?? null;
  } catch (e) {
    return { ok: false, reason: "send_failed", detail: e instanceof Error ? e.message : String(e) };
  }
  // On the record's timeline (best effort).
  if (m.relatedType && m.relatedId) {
    try {
      const db = await getDb();
      await db?.insert(activities).values({
        workspaceId,
        type: "email",
        relatedType: m.relatedType,
        relatedId: m.relatedId,
        subject: `Meeting times sent: ${m.title}`.slice(0, 240),
        body: text,
        actorUserId: m.ownerUserId,
        occurredAt: new Date(),
      } as never);
    } catch (e) {
      console.error("[MeetingProposalEmail] activity failed:", e instanceof Error ? e.message : e);
    }
  }
  return { ok: true, fromEmail: account.fromEmail, messageId };
}
