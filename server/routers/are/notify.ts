/**
 * ARE Notification Helper
 *
 * Writes in-app notifications with kind="are_event" for ARE-specific events.
 * These appear in the notification bell with a distinct violet/Bot styling.
 *
 * Event types, and whether ARE Settings can switch them off (2026-09-20 — the
 * three switches existed on the page and gated nothing, and two of the events
 * they named had no dispatch site at all):
 *   meeting_booked       — prospect booked a meeting. Emitted from
 *                          routers/are/execution.ts. Gated by
 *                          areNotifyOnMeetingBooked (default ON).
 *   auto_approved        — one digest per campaign per tick when prospects
 *                          cleared the ICP threshold without review. Emitted
 *                          from areEngine.ts. Gated by areNotifyOnAutoApprove
 *                          (default OFF).
 *   icp_updated          — ICP profile regenerated (cron or button) or
 *                          restored. Emitted from routers/are/icp.ts. Gated by
 *                          areNotifyOnIcpUpdate (default ON).
 *   signal_classified    — engagement signal / positive reply. NO switch: it
 *                          fires on every email open, so a gate would buy a
 *                          settings SELECT per open.
 *   hook_enhanced        — AI rewrote the outreach hook. NO switch, same
 *                          reason (services/signalEnhancement.ts).
 *   campaign_completed   — declared here, dispatched from NOWHERE. Kept in the
 *                          union so an implementer has the name; it is not a
 *                          notice anyone receives today.
 *
 * Only the three gated types pay for the settings lookup — the ungated ones
 * never touch workspace_settings.
 */

import { notifications, workspaceSettings } from "../../../drizzle/schema";
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { workspaceNotifyUserId } from "../../_core/activeMembers";

export type AreEventType =
  | "meeting_booked"
  | "auto_approved"
  | "icp_updated"
  | "campaign_completed"
  | "signal_classified"
  | "hook_enhanced";

/**
 * eventType → the workspace_settings boolean that can silence it.
 *
 * An event type ABSENT here is deliberately unsilenceable, so a typo'd or
 * newly-added type fails open (you get the notice) rather than closed (you
 * never learn you are missing one). That direction is the whole point of this
 * map: the bug being fixed was a switch with no event, and the symmetric bug
 * — an event silently tied to a switch the user cannot see — is worse.
 */
const NOTIFY_GATE: Record<string, "areNotifyOnMeetingBooked" | "areNotifyOnAutoApprove" | "areNotifyOnIcpUpdate"> = {
  meeting_booked: "areNotifyOnMeetingBooked",
  auto_approved: "areNotifyOnAutoApprove",
  icp_updated: "areNotifyOnIcpUpdate",
};

/** The gating column for an event type, or undefined when it has no switch. */
export function notifyGateColumn(eventType: string): string | undefined {
  return NOTIFY_GATE[eventType];
}

export interface AreNotifyOptions {
  workspaceId: number;
  eventType: AreEventType;
  title: string;
  body: string;
  relatedId?: number;   // campaignId or prospectQueueId
  relatedType?: string; // "are_campaign" | "prospect"
}

/**
 * Writes an in-app notification for the workspace owner.
 * Non-fatal — errors are swallowed so they never block the calling flow.
 */
export async function areNotify(opts: AreNotifyOptions): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    // The ARE Settings switches, honoured here rather than at each dispatch
    // site so a new emit cannot forget them. `=== false` and not `!s[col]`:
    // getOrSeedSettings writes the row lazily, so a workspace that has never
    // opened the page has NO row, and a falsy read there would mute every
    // workspace in the product rather than none.
    const col = notifyGateColumn(opts.eventType);
    if (col) {
      const [s] = await db
        .select()
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, opts.workspaceId))
        .limit(1);
      if (s && (s as Record<string, unknown>)[col] === false) return;
    }
    /**
     * The owner, or an active stand-in if they have left. Read raw, this was
     * the ARE engine's ONLY reporting channel pointed at a user id nobody
     * checks — every campaign_completed, auto_approved and icp_updated notice
     * written into a void. Null means the workspace has no active members, so
     * there is nobody to tell.
     */
    const recipient = await workspaceNotifyUserId(opts.workspaceId);
    if (!recipient) return;
    await db.insert(notifications).values({
      workspaceId: opts.workspaceId,
      userId: recipient,
      kind: "are_event",
      title: opts.title,
      body: opts.body,
      relatedType: opts.relatedType ?? "are_campaign",
      relatedId: opts.relatedId ?? null,
    });
  } catch (e) {
    console.error("[AreNotify] Failed to write notification:", e);
  }
}
