/**
 * bookingConfirmationEmail.ts — the person who books hears back, even when no
 * calendar invite went out (tracker item 10, 2026-11-06).
 *
 * A booking on /b/:slug (or through the chat agent) books the real calendar
 * event via sendMeetingInvite, and the provider's invite is what tells the
 * booker it worked. When that invite does not go (the host has no calendar
 * connected, the calendar refused, or the address already has a meeting and
 * a second invite was held back) the booker got nothing at all: the page said
 * the host "will confirm shortly" and nobody did. The tester booked through
 * Meetings → Preview and waited for an email that was never going to come.
 *
 * This is that email: what was booked, when (in the link's own zone, named),
 * how long, with whom, and "reply to this email" for a change. It goes the way
 * a meeting proposal goes (meetingProposalEmail): from the host's own
 * connected mailbox, else the workspace's first enabled one, after the
 * suppression check and the mailbox's daily cap.
 *
 * NOT held by "Pause all outbound": booking a time is the prospect's own
 * action, which the pause deliberately leaves alone (services/outboundPause),
 * and the provider invite on the same path is not held either. This is the
 * same answer by email.
 */
import { findSuppression } from "./suppression";
import { proposalSender, signatureFor } from "./meetingProposalEmail";
import { createEmailAdapter } from "../emailAdapter";
import { assertSendAllowed } from "../sendLimits";
import { makeUnsubscribeUrl, unsubscribeHeaders } from "../unsubscribe";
import { appBaseUrl } from "../appUrl";
import { escapeHtml } from "@shared/escapeHtml";
import { formatInZone } from "@shared/availability";

export type BookingConfirmationResult =
  | { ok: true; fromEmail: string }
  | { ok: false; reason: "no_mailbox" | "suppressed" | "send_limit" | "send_failed"; detail?: string };

export type BookingConfirmationInput = {
  workspaceId: number;
  meetingId: number;
  title: string;
  startAt: Date;
  durationMin: number;
  /** The booking link's zone; the time is written in it, with the zone named. */
  timezone: string;
  hostName: string;
  ownerUserId: number | null;
  contactEmail: string;
  contactName: string | null;
  relatedType: string | null;
  relatedId: number | null;
};

/** The email, as subject, HTML and text. Pure, so it is tested without a mailbox. */
export function bookingConfirmationBodies(input: {
  title: string;
  startAt: Date;
  durationMin: number;
  timezone: string;
  hostName: string;
  contactName: string | null;
  signature: string;
  unsubscribeUrl: string;
}): { subject: string; html: string; text: string } {
  const when = formatInZone(input.startAt, input.timezone);
  const first = (input.contactName ?? "").trim().split(/\s+/)[0] || "there";
  const subject = `Confirmed: ${input.title} — ${when}`;
  const lines = [
    `Hi ${first},`,
    `Your meeting with ${input.hostName} is booked.`,
    `${input.title}`,
    `${when} · ${input.durationMin} min`,
    `If the time stops working, just reply to this email.`,
  ];
  const sigHtml = input.signature
    ? `<div style="margin-top:18px;color:#555;line-height:1.4">${input.signature.split("\n").map(escapeHtml).join("<br>")}</div>`
    : "";
  const html =
    `<p style="margin:0 0 10px">${escapeHtml(lines[0])}</p>` +
    `<p style="margin:0 0 10px">${escapeHtml(lines[1])}</p>` +
    `<p style="margin:0 0 4px;font-weight:600">${escapeHtml(lines[2])}</p>` +
    `<p style="margin:0 0 14px">${escapeHtml(lines[3])}</p>` +
    `<p style="margin:0;color:#6b7280;font-size:13px">${escapeHtml(lines[4])}</p>` +
    sigHtml +
    `<p style="margin:32px 0 0;color:#9ca3af;font-size:11px;text-align:center;line-height:1.5">Don't want these emails? <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a></p>`;
  const text =
    `${lines[0]}\n\n${lines[1]}\n\n${lines[2]}\n${lines[3]}\n\n${lines[4]}` +
    (input.signature ? `\n\n${input.signature}` : "") +
    `\n\n—\nUnsubscribe: ${input.unsubscribeUrl}`;
  return { subject, html, text };
}

/** Email the booker a confirmation. Never throws: the result says what happened. */
export async function sendBookingConfirmationEmail(input: BookingConfirmationInput): Promise<BookingConfirmationResult> {
  try {
    const { workspaceId } = input;
    // The ONE suppression check (both lists): someone who asked not to be
    // emailed is not emailed, booking or not. The rep is told instead.
    if (await findSuppression(workspaceId, { email: input.contactEmail }, "email")) return { ok: false, reason: "suppressed" };
    const account = await proposalSender(workspaceId, input.ownerUserId);
    if (!account) return { ok: false, reason: "no_mailbox" };
    try {
      await assertSendAllowed(workspaceId, account.id);
    } catch (e) {
      return { ok: false, reason: "send_limit", detail: e instanceof Error ? e.message : String(e) };
    }
    const base = appBaseUrl();
    const { subject, html, text } = bookingConfirmationBodies({
      title: input.title,
      startAt: input.startAt,
      durationMin: input.durationMin,
      timezone: input.timezone,
      hostName: input.hostName,
      contactName: input.contactName,
      signature: await signatureFor(workspaceId, input.ownerUserId),
      unsubscribeUrl: makeUnsubscribeUrl(base, workspaceId, input.contactEmail),
    });
    await createEmailAdapter(account).sendEmail({
      fromEmail: account.fromEmail,
      fromName: account.fromName ?? account.name,
      to: input.contactEmail,
      subject,
      bodyHtml: html,
      bodyText: text,
      // A confirmation, not outreach: nothing to track.
      track: false,
      logMeta: {
        source: "meeting_confirmation",
        sourceLabel: input.title,
        contactId: input.relatedType === "contact" ? input.relatedId : null,
        leadId: input.relatedType === "lead" ? input.relatedId : null,
      },
      headers: unsubscribeHeaders(base, workspaceId, input.contactEmail),
    });
    return { ok: true, fromEmail: account.fromEmail };
  } catch (e) {
    return { ok: false, reason: "send_failed", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** For the rep's notification: why the booker got no confirmation email. */
export function describeConfirmationFailure(r: Exclude<BookingConfirmationResult, { ok: true }>): string {
  switch (r.reason) {
    case "suppressed": return "they are on the suppression list";
    case "no_mailbox": return "no sending mailbox is set up";
    case "send_limit": return "the mailbox has hit its daily limit";
    default: return `the send failed${r.detail ? `: ${r.detail.slice(0, 160)}` : ""}`;
  }
}
