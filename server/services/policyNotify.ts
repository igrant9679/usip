/**
 * In-app notifications that honour the workspace notification policy.
 *
 * 🔴 THE FIVE SWITCHES IN Settings → Notifications WERE DECORATIVE. The policy
 * was written and read back to render the same switches; no send path consulted
 * it. `997ba40` wired the first event and left the other four marked
 * `wired: false` rather than implying coverage. This is the rest, and the four
 * were not all the same shape:
 *
 *   salesReadyCrossed  ALREADY SENT — but gated on a SECOND, different toggle
 *                      (`lead_score_config.notifyOnSalesReady`), so an admin
 *                      could switch it off in Settings and keep receiving them.
 *   mention            ALREADY SENT — ignoring the policy, and addressed from a
 *                      member list that never filtered deactivated members.
 *   dealMoved          no dispatch site at all.
 *   taskOverdue        no dispatch site at all. The cron of that name fires
 *                      WORKFLOW RULES; it never told the task's owner anything.
 *
 * One gate, so a sixth event cannot be added with a fifth spelling of it.
 */
import { and, eq } from "drizzle-orm";
import { isEmailEnabled, isInAppEnabled, memberWantsEvent } from "@shared/notifyPolicy";
import { escapeHtml } from "@shared/escapeHtml";
import { notifications, users, workspaceMembers, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { appUrl } from "../appUrl";
import { sendWorkspaceEmail } from "../emailDelivery";
import { activeOwnerOrNull } from "../_core/activeMembers";

/**
 * Values of the `notifications.kind` enum.
 *
 * Typed rather than `string` because inventing a value fails at RUNTIME, not at
 * compile time — the `as never` insert class (d3aefe0, a278a39). Adding a kind
 * means a migration; this union is what makes forgetting that a type error.
 */
export type NotificationKind =
  | "mention" | "task_assigned" | "task_due" | "deal_won" | "deal_lost"
  | "renewal_due" | "churn_risk" | "approval_request" | "workflow_fired"
  | "system" | "email_reply" | "are_event";

export interface PolicyNotice {
  workspaceId: number;
  /** Recipient. Re-checked for active membership before anything is written. */
  userId: number | null | undefined;
  /** Key in @shared/notifyPolicy. */
  event: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  relatedType?: string | null;
  relatedId?: number | null;
  /**
   * Extra veto, ANDed with the policy. For events that also carry an older,
   * separate switch of their own — see salesReadyCrossed.
   */
  alsoRequire?: boolean;
}

/**
 * Write one in-app notification if the workspace policy allows it.
 *
 * BEST-EFFORT AND NON-THROWING. Several call sites are public submit handlers
 * or unattended crons; a notification failing must never break the thing that
 * triggered it. Returns whether a row was written, so a caller (or a test) can
 * tell "policy said no" from "it worked".
 */
export async function notifyIfEnabled(notice: PolicyNotice): Promise<boolean> {
  try {
    if (notice.alsoRequire === false) return false;

    const db = await getDb();
    if (!db) return false;

    /**
     * The recipient is re-resolved here rather than trusted from the caller.
     * Every call site should already have done it, but this function inserts a
     * row keyed on a user id, and a notification addressed to somebody who has
     * left is exactly the class be56c02 closed. One place that cannot get it
     * wrong beats five that must remember.
     */
    const userId = await activeOwnerOrNull(notice.workspaceId, notice.userId ?? null);
    if (!userId) return false;

    const [settings] = await db
      .select({ policy: workspaceSettings.notifyPolicy })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, notice.workspaceId))
      .limit(1);
    if (!isInAppEnabled(settings?.policy, notice.event)) return false;

    /**
     * The member's own switch, which can only NARROW the workspace policy —
     * checked after it, so muting is possible and un-muting is not. Absent
     * defers to the policy, which is what makes the old stored vocabulary
     * (`sequence_reply` and friends) harmless rather than an accidental mute.
     *
     * Mutes BOTH channels: the page offers one switch per event, and "stop
     * telling me about this" is the only reading of it that does not need a
     * second column the UI has never had.
     */
    const [member] = await db
      .select({ prefs: workspaceMembers.notifPrefs })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, notice.workspaceId),
        eq(workspaceMembers.userId, userId),
      ))
      .limit(1);
    if (!memberWantsEvent(member?.prefs, notice.event)) return false;

    await db.insert(notifications).values({
      workspaceId: notice.workspaceId,
      userId,
      kind: notice.kind,
      title: notice.title.slice(0, 240),
      body: notice.body ?? null,
      relatedType: notice.relatedType ?? null,
      relatedId: notice.relatedId ?? null,
    } as never);

    /**
     * The email column. Strictly a SECOND channel, sent only after the in-app
     * row exists — so a mail failure can never cost anyone the notification
     * itself, and the two can never disagree about whether something happened.
     */
    if (isEmailEnabled(settings?.policy, notice.event)) {
      void sendPolicyEmail(notice, userId).catch((e) =>
        console.error(`[policyNotify] ${notice.event} email failed:`, (e as Error).message),
      );
    }
    return true;
  } catch (e) {
    console.error(`[policyNotify] ${notice.event} failed:`, (e as Error).message);
    return false;
  }
}

/**
 * Deliver the email half.
 *
 * Fire-and-forget from the caller's point of view: several dispatch sites are
 * public submit handlers and unattended crons, and SMTP is slow enough that
 * awaiting it would put a mail round-trip inside a prospect's form POST.
 *
 * Silently does nothing when the workspace has no SMTP configured —
 * `sendWorkspaceEmail` returns `{ok:false}` rather than throwing, which is the
 * right shape here: email is opt-in infrastructure, not a requirement.
 */
async function sendPolicyEmail(notice: PolicyNotice, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  /**
   * `workspace_members.notifEmail` is a personal notification address that may
   * differ from the login one; fall back to the account email. Both are read
   * through the membership row, so this cannot address somebody outside the
   * workspace even if a userId were wrong.
   */
  const [row] = await db
    .select({ notifEmail: workspaceMembers.notifEmail, loginEmail: users.email })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(
      eq(workspaceMembers.workspaceId, notice.workspaceId),
      eq(workspaceMembers.userId, userId),
    ))
    .limit(1);

  const to = (row?.notifEmail ?? row?.loginEmail ?? "").trim();
  if (!to) return;

  /**
   * 🔒 EVERY INTERPOLATED VALUE IS ESCAPED. Titles and bodies carry prospect
   * names, note text and deal names — attacker-influenced strings on the public
   * capture paths. `textToHtml` in areEngine already had to learn this: a URL
   * with a double quote closed an attribute and everything after it parsed as
   * more attributes.
   */
  const title = escapeHtml(notice.title);
  const body = notice.body ? escapeHtml(notice.body) : "";
  const link = notice.relatedType && notice.relatedId
    ? appUrl(`/notifications?related=${encodeURIComponent(notice.relatedType)}&id=${notice.relatedId}`)
    : appUrl("/notifications");

  await sendWorkspaceEmail(notice.workspaceId, {
    to,
    subject: notice.title.slice(0, 200),
    html:
      `<p><strong>${title}</strong></p>` +
      (body ? `<p>${body.replace(/\n/g, "<br>")}</p>` : "") +
      `<p><a href="${escapeHtml(link)}">Open in Velocity</a></p>` +
      `<p style="color:#6b7280;font-size:12px">You are receiving this because ` +
      `email is enabled for this event in Settings → Notifications.</p>`,
  });
}

export interface LeadRoutedNotice {
  workspaceId: number;
  ownerUserId: number | null | undefined;
  leadId: number | null | undefined;
  /** Display name of the person who submitted. */
  name: string;
  company?: string | null;
  /** `leads.source` — "webform", "landing:my-page", … */
  source: string;
}

/**
 * A public form or landing page routed a lead to somebody — tell them.
 *
 * `kind` is "system" because the enum has no lead value; the deep link rides on
 * relatedType/relatedId, which is what the bell navigates on.
 */
export async function notifyLeadRouted(notice: LeadRoutedNotice): Promise<boolean> {
  if (!notice.leadId) return false;
  const who = notice.name.trim() || "Someone";
  const where = notice.company?.trim();
  return notifyIfEnabled({
    workspaceId: notice.workspaceId,
    userId: notice.ownerUserId,
    event: "newLeadRouted",
    kind: "system",
    title: `New lead routed to you: ${who}`,
    body: `${who}${where ? ` from ${where}` : ""} came in via ${notice.source} and is now assigned to you.`,
    relatedType: "lead",
    relatedId: notice.leadId,
  });
}
