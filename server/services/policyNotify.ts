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
import { eq } from "drizzle-orm";
import { isInAppEnabled } from "@shared/notifyPolicy";
import { notifications, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
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

    await db.insert(notifications).values({
      workspaceId: notice.workspaceId,
      userId,
      kind: notice.kind,
      title: notice.title.slice(0, 240),
      body: notice.body ?? null,
      relatedType: notice.relatedType ?? null,
      relatedId: notice.relatedId ?? null,
    } as never);
    return true;
  } catch (e) {
    console.error(`[policyNotify] ${notice.event} failed:`, (e as Error).message);
    return false;
  }
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
