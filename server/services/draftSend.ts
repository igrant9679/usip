/**
 * draftSend.ts — claiming an email draft before it is sent, and what may
 * happen to it afterwards (audit 2026-10-20: O4, O14, O16, O17; Phase 1).
 *
 * 🔴 THE BUGS. Four paths send a draft — the row's Send button
 * (emailDrafts.send), the auto-send worker, smtpConfig.sendDraft and "Send
 * approved" (smtpConfig.sendBulkApproved) — and none of them took the draft
 * before sending it. Each read a status, sent, and only afterwards wrote
 * 'sent', so a second click, a second admin or an overlapping worker tick
 * sent the same email again. A failed auto-send left the draft 'approved'
 * forever, where nothing would ever pick it up. Approve, reject, edit and
 * delete ignored status: approving a sent draft queued it again. And a draft
 * already in the queue still went out after the person replied, after their
 * enrolment was paused or ended, or after the sequence was paused.
 *
 * Now:
 *   • A draft is CLAIMED with a conditional UPDATE (status → 'sending') that
 *     names the status it expects; whoever changes the row sends it, anyone
 *     else gets "already being sent".
 *   • Once the transport has been called, the draft is never put back where
 *     a sender would pick it up again, unless the error proves nothing left
 *     (a refused connection or login, a refused recipient). Anything else is
 *     'failed' with the reason stored: the email may have gone, so a person
 *     decides whether to send it again.
 *   • A sequence draft goes out only while its enrolment is running (or has
 *     finished) and its sequence is active — checked at send time, so a reply,
 *     a pause or an exit stops drafts that were already written.
 */
import { and, eq, lt } from "drizzle-orm";
import { emailDrafts, enrollments, sequences } from "../../drizzle/schema";

export type DraftStatus = (typeof emailDrafts.$inferSelect)["status"];

/** What a person may still change. A sent or sending draft is a record of what went out. */
export const EDITABLE_DRAFT_STATUSES: DraftStatus[] = ["pending_review", "ai_pending_review", "approved", "rejected", "failed"];

/** Where a person's Send button may take a draft from. */
export const MANUAL_SEND_FROM: DraftStatus[] = ["pending_review", "ai_pending_review", "approved", "failed"];

/** How long a claim may sit before the sweep calls it interrupted. */
export const SENDING_STALE_MS = 30 * 60_000;

type Db = any;

/**
 * Take the draft for sending. Returns the status it was taken FROM (so a
 * sender that stops before the transport can put it back), or null when it is
 * not in one of `from` — already sent, being sent by someone else, rejected.
 */
export async function claimDraftForSend(
  db: Db,
  workspaceId: number,
  draftId: number,
  current: DraftStatus,
  from: DraftStatus[],
): Promise<DraftStatus | null> {
  if (!from.includes(current)) return null;
  const res = await db
    .update(emailDrafts)
    .set({ status: "sending", sendClaimedAt: new Date(), sendError: null } as never)
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.workspaceId, workspaceId), eq(emailDrafts.status, current)));
  return affected(res) === 1 ? current : null;
}

/** Put a claimed draft back, because nothing was sent. */
export async function releaseDraftClaim(db: Db, draftId: number, back: DraftStatus, reason?: string): Promise<void> {
  await db
    .update(emailDrafts)
    .set({ status: back, sendClaimedAt: null, sendError: reason ? reason.slice(0, 500) : null } as never)
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.status, "sending")));
}

/** The transport was called and we cannot tell whether the email left. */
export async function markDraftFailed(db: Db, draftId: number, reason: string): Promise<void> {
  await db
    .update(emailDrafts)
    .set({ status: "failed", sendError: reason.slice(0, 500) } as never)
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.status, "sending")));
}

/**
 * True only when the error proves the message never left: the connection,
 * greeting or login failed, or the server refused the sender or recipient
 * before any content was accepted. Everything else — a timeout or a dropped
 * socket after DATA, an HTTP 5xx from a provider, an unknown error — may have
 * been delivered, and is not retried by itself.
 */
export function isDefinitelyNotSent(err: unknown): boolean {
  const e = err as { code?: unknown; command?: unknown; status?: unknown; statusCode?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  const code = String(e.code ?? "");
  if (["EAUTH", "ECONNECTION", "EDNS", "ECONNREFUSED", "ENOTFOUND", "EENVELOPE"].includes(code)) return true;
  const command = String(e.command ?? "").toUpperCase();
  if (["CONN", "EHLO", "HELO", "STARTTLS", "MAIL FROM", "RCPT TO"].includes(command) || command.startsWith("AUTH")) return true;
  const status = Number(e.status ?? e.statusCode);
  return Number.isFinite(status) && status >= 400 && status < 500 && status !== 408;
}

/**
 * Why this draft must not be sent now, or null. Only sequence drafts are
 * held: a draft a person wrote by hand is theirs to send.
 */
export async function draftHoldReason(
  db: Db,
  draft: { workspaceId: number; sequenceId: number | null; enrollmentId: number | null },
): Promise<string | null> {
  if (draft.enrollmentId) {
    const [enr] = await db
      .select({ status: enrollments.status })
      .from(enrollments)
      .where(and(eq(enrollments.id, draft.enrollmentId), eq(enrollments.workspaceId, draft.workspaceId)))
      .limit(1);
    if (enr?.status === "paused") return "the person's enrolment is paused (they replied, or someone paused it)";
    if (enr?.status === "exited") return "the person's enrolment has ended";
  }
  if (draft.sequenceId) {
    const [seq] = await db
      .select({ status: sequences.status })
      .from(sequences)
      .where(and(eq(sequences.id, draft.sequenceId), eq(sequences.workspaceId, draft.workspaceId)))
      .limit(1);
    if (seq && seq.status !== "active") return `the sequence is ${seq.status === "draft" ? "still a draft" : seq.status}`;
  }
  return null;
}

/**
 * A claim whose sender died mid-send (a deploy, a crash) would read
 * "sending" for ever. After SENDING_STALE_MS it becomes 'failed', saying so —
 * never back to a sendable state, because the email may have gone.
 */
export async function sweepStaleSendingDrafts(db: Db, now = new Date()): Promise<number> {
  const res = await db
    .update(emailDrafts)
    .set({ status: "failed", sendError: "Interrupted while sending — check the Emails log before sending again." } as never)
    .where(and(eq(emailDrafts.status, "sending"), lt(emailDrafts.sendClaimedAt, new Date(now.getTime() - SENDING_STALE_MS))));
  return affected(res);
}

export function affected(res: unknown): number {
  const r = res as any;
  return Number(r?.[0]?.affectedRows ?? r?.affectedRows ?? r?.rowsAffected ?? 0);
}
