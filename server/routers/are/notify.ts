/**
 * ARE Notification Helper
 *
 * Writes in-app notifications with kind="are_event" for ARE-specific events.
 * These appear in the notification bell with a distinct violet/Bot styling.
 *
 * Event types:
 *   meeting_booked       — prospect booked a meeting
 *   auto_approved        — prospect auto-approved above ICP threshold
 *   icp_updated          — ICP profile regenerated / restored
 *   campaign_completed   — campaign reached target prospect count
 *   signal_classified    — positive reply classified (positive/objection)
 *   hook_enhanced        — AI rewrote the outreach hook after a signal
 */

import { eq } from "drizzle-orm";
import { notifications, workspaces } from "../../../drizzle/schema";
import { getDb } from "../../db";

export type AreEventType =
  | "meeting_booked"
  | "auto_approved"
  | "icp_updated"
  | "campaign_completed"
  | "signal_classified"
  | "hook_enhanced";

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
    // Resolve the workspace owner
    const [ws] = await db
      .select({ ownerUserId: workspaces.ownerUserId })
      .from(workspaces)
      .where(eq(workspaces.id, opts.workspaceId))
      .limit(1);
    if (!ws) return;
    await db.insert(notifications).values({
      workspaceId: opts.workspaceId,
      userId: ws.ownerUserId,
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
