/**
 * communications.ts — read and set the workspace's two outbound switches as
 * one (see @shared/communications for why there are two).
 *
 * The read is fresh, never the send window's one-minute cache: this is what a
 * person looks at right after flipping it, from any page. A read that fails
 * throws; the callers show "unknown", and the senders themselves fail closed
 * (services/sendWindow), so nothing here has to guess.
 */
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { recordAudit } from "../audit";
import { invalidateSendWindowCache } from "./sendWindow";
import { communicationsState, type CommunicationsState } from "@shared/communications";

export type CommunicationsStatus = {
  state: CommunicationsState;
  emailPaused: boolean;
  callsPaused: boolean;
  /** ISO time each half was paused, or null while it is on. */
  emailPausedAt: string | null;
  callsPausedAt: string | null;
};

function toStatus(row: { outboundPausedAt: Date | null; aiCallsPausedAt: Date | null } | undefined): CommunicationsStatus {
  const emailAt = row?.outboundPausedAt ?? null;
  const callsAt = row?.aiCallsPausedAt ?? null;
  return {
    state: communicationsState(!!emailAt, !!callsAt),
    emailPaused: !!emailAt,
    callsPaused: !!callsAt,
    emailPausedAt: emailAt ? new Date(emailAt).toISOString() : null,
    callsPausedAt: callsAt ? new Date(callsAt).toISOString() : null,
  };
}

export async function readCommunications(workspaceId: number): Promise<CommunicationsStatus> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [row] = await db
    .select({ outboundPausedAt: workspaceSettings.outboundPausedAt, aiCallsPausedAt: workspaceSettings.aiCallsPausedAt })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  return toStatus(row);
}

/**
 * Pause or resume both halves. Pausing keeps the time a half was already
 * paused at (it says since when); resuming clears both, including a half
 * someone paused on its own, because that is what "all" means and the
 * confirm says so before this runs.
 */
export async function setCommunicationsPaused(
  workspaceId: number,
  paused: boolean,
  actorUserId: number | null,
  now: Date = new Date(),
): Promise<{ before: CommunicationsStatus; after: CommunicationsStatus; changed: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [row] = await db
    .select({ outboundPausedAt: workspaceSettings.outboundPausedAt, aiCallsPausedAt: workspaceSettings.aiCallsPausedAt })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  if (!row) await db.insert(workspaceSettings).values({ workspaceId });
  const before = toStatus(row);
  const next = paused
    ? { outboundPausedAt: row?.outboundPausedAt ?? now, aiCallsPausedAt: row?.aiCallsPausedAt ?? now }
    : { outboundPausedAt: null, aiCallsPausedAt: null };
  const after = toStatus(next);
  const changed = before.emailPaused !== after.emailPaused || before.callsPaused !== after.callsPaused;
  if (changed) {
    await db.update(workspaceSettings).set(next).where(eq(workspaceSettings.workspaceId, workspaceId));
  }
  // The engines cache the pause with the send window for a minute. Cleared
  // even when nothing changed: a stale "open" is the one error that sends.
  invalidateSendWindowCache(workspaceId);
  if (changed) {
    await recordAudit({
      workspaceId,
      actorUserId,
      action: "update",
      entityType: "communications_switch",
      entityId: workspaceId,
      before: { emailPaused: before.emailPaused, callsPaused: before.callsPaused },
      after: { emailPaused: after.emailPaused, callsPaused: after.callsPaused },
    });
  }
  return { before, after, changed };
}
