/**
 * Meeting reminders — autonomous no-show reduction.
 *
 * A booked meeting only becomes a sales call if the prospect shows up. This
 * cron scans upcoming booked meetings and emails the attendee a single reminder
 * in the 1–24h-before window, including the join link and a one-click reschedule
 * link (the rep's self-serve booking page) so a conflict becomes a rebook rather
 * than a no-show. Fully hands-off; best-effort (never throws).
 *
 * Delivery uses the workspace transactional SMTP (sendWorkspaceEmail). If a
 * workspace has no SMTP configured we skip WITHOUT stamping, so reminders begin
 * flowing once they set it up; any other outcome stamps reminderSentAt so a
 * reminder is sent at most once.
 */
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { getDb } from "../db";
import { meetings } from "../../drizzle/schema";
import { sendWorkspaceEmail } from "../emailDelivery";
import { resolveBookingUrl } from "../mergeVars";

const REMINDER_STATUSES = ["scheduled", "invited"];

function fmtWhen(d: Date): string {
  // No attendee timezone on file — label UTC explicitly to avoid ambiguity.
  return d.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZone: "UTC",
  }) + " UTC";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Send due pre-meeting reminders across all workspaces. Returns how many were
 * sent. Safe to run on an hourly cron.
 */
export async function sendDueMeetingReminders(): Promise<{ sent: number; considered: number }> {
  const db = await getDb();
  if (!db) return { sent: 0, considered: 0 };

  const now = new Date();
  const minLead = new Date(now.getTime() + 60 * 60 * 1000);       // ≥1h away
  const windowEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000); // ≤24h away

  const due = await db
    .select()
    .from(meetings)
    .where(and(
      inArray(meetings.status, REMINDER_STATUSES),
      isNull(meetings.reminderSentAt),
      gte(meetings.scheduledAt, minLead),
      lte(meetings.scheduledAt, windowEnd),
    ))
    .limit(300);

  let sent = 0;
  for (const m of due) {
    if (!m.contactEmail || !m.scheduledAt) continue;
    const when = fmtWhen(m.scheduledAt as Date);
    const name = m.contactName?.trim() || "there";

    let bookingUrl = "";
    try { bookingUrl = await resolveBookingUrl(m.workspaceId, m.ownerUserId); } catch { /* best-effort */ }

    const joinLine = m.meetingUrl
      ? `<p><a href="${esc(m.meetingUrl)}">Join the meeting</a></p>`
      : "";
    const rescheduleLine = bookingUrl
      ? `<p style="color:#6b7280;font-size:13px">Need a different time? <a href="${esc(bookingUrl)}">Reschedule here</a>.</p>`
      : "";
    const html =
      `<p>Hi ${esc(name)},</p>` +
      `<p>A quick reminder about our meeting <strong>${esc(m.title)}</strong> on <strong>${esc(when)}</strong>.</p>` +
      joinLine +
      `<p>Looking forward to speaking with you.</p>` +
      rescheduleLine;

    const res = await sendWorkspaceEmail(m.workspaceId, {
      to: m.contactEmail,
      subject: `Reminder: ${m.title} — ${when}`,
      html,
    });

    // Skip (leave unstamped) only when the workspace simply has no delivery set
    // up, so reminders start once configured. Any other result is one-and-done.
    const notConfigured = !res.ok && /no smtp config|disabled|incomplete/i.test(res.reason ?? "");
    if (notConfigured) continue;

    try {
      await db.update(meetings).set({ reminderSentAt: new Date() } as never).where(eq(meetings.id, m.id));
    } catch (e) {
      console.error(`[MeetingReminders] stamp failed for meeting ${m.id}:`, (e as Error).message);
    }
    if (res.ok) sent++;
  }

  if (sent > 0) console.log(`[MeetingReminders] sent ${sent}/${due.length} reminder(s)`);
  return { sent, considered: due.length };
}
