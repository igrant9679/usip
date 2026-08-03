/**
 * Tell the rep a lead was routed to them.
 *
 * 🔴 THE GAP. A public form or landing page creates a lead, routes it through
 * `routeLeadOwner`, and files it under a rep — and NOTHING TOLD THEM. The lead
 * appears in a list they have to think to open. Meanwhile Settings →
 * Notifications has shown a switch reading "New lead routed to me · in-app" the
 * whole time, defaulted ON, wired to nothing on either side: no send path
 * raised the notification, and no send path read the policy.
 *
 * Inbound leads from a public page are the ones where latency matters most —
 * somebody filled in a form because they wanted to hear back.
 *
 * Scope, stated plainly: this wires ONE of the five events in that panel. The
 * other four remain switches that do nothing, and `@shared/notifyPolicy` marks
 * them `wired: false` rather than letting the list imply otherwise.
 */
import { eq } from "drizzle-orm";
import { isInAppEnabled } from "@shared/notifyPolicy";
import { notifications, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { activeOwnerOrNull } from "../_core/activeMembers";

export interface LeadRoutedNotice {
  workspaceId: number;
  /** Resolved owner of the new lead. Null/absent means nobody to tell. */
  ownerUserId: number | null | undefined;
  leadId: number | null | undefined;
  /** Display name of the person who submitted. */
  name: string;
  company?: string | null;
  /** `leads.source` — "webform", "landing:my-page", … */
  source: string;
}

/**
 * Raise the in-app notification, honouring the workspace policy.
 *
 * BEST-EFFORT AND NON-THROWING. This runs inside a public submit handler; a
 * notification failing must never turn a captured lead into an error page for
 * the person who just filled the form in. Returns whether one was written, so
 * callers and tests can tell "policy said no" from "it worked".
 */
export async function notifyLeadRouted(notice: LeadRoutedNotice): Promise<boolean> {
  try {
    if (!notice.leadId) return false;

    const db = await getDb();
    if (!db) return false;

    /**
     * The owner is re-checked here rather than trusted from the caller. Both
     * call sites already resolve it through `activeOwnerOrNull`, but this
     * function inserts a row keyed on a user id and a notification addressed to
     * somebody who has left is exactly the class be56c02 closed.
     */
    const owner = await activeOwnerOrNull(notice.workspaceId, notice.ownerUserId ?? null);
    if (!owner) return false;

    const [settings] = await db
      .select({ policy: workspaceSettings.notifyPolicy })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, notice.workspaceId))
      .limit(1);
    if (!isInAppEnabled(settings?.policy, "newLeadRouted")) return false;

    const who = notice.name.trim() || "Someone";
    const where = notice.company?.trim();

    /**
     * `kind` is "system" because the enum has no lead value and inventing one
     * is a RUNTIME failure, not a compile error — the `as never` insert class
     * (d3aefe0, a278a39). `relatedType`/`relatedId` carry the deep link
     * instead, which is what the bell actually navigates on.
     */
    await db.insert(notifications).values({
      workspaceId: notice.workspaceId,
      userId: owner,
      kind: "system",
      title: `New lead routed to you: ${who}`.slice(0, 240),
      body: `${who}${where ? ` from ${where}` : ""} came in via ${notice.source} and is now assigned to you.`,
      relatedType: "lead",
      relatedId: notice.leadId,
    } as never);
    return true;
  } catch (e) {
    console.error("[leadNotifications] notifyLeadRouted failed:", (e as Error).message);
    return false;
  }
}
