/**
 * Invite Expiry — nightly job
 *
 * Marks workspace_members rows whose inviteExpiresAt has passed and whose
 * associated user still has loginMethod = "invite" as expired.
 * We update the users.loginMethod to "expired_invite" so the UI can show
 * a distinct "Expired" badge and the invite/resend guards still work.
 */
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { getDb } from "./db";
import { users, workspaceMembers } from "../drizzle/schema";

export async function expireInvitations(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const now = new Date();

  // Find all workspace_members with a past inviteExpiresAt
  const expired = await db
    .select({
      memberId: workspaceMembers.id,
      userId: workspaceMembers.userId,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(
      and(
        isNotNull(workspaceMembers.inviteExpiresAt),
        lte(workspaceMembers.inviteExpiresAt, now),
        eq(users.loginMethod, "invite"),
      ),
    );

  if (expired.length === 0) return;

  const userIds = [...new Set(expired.map((r) => r.userId))];
  for (const userId of userIds) {
    await db
      .update(users)
      .set({ loginMethod: "expired_invite" })
      .where(eq(users.id, userId));
  }

  console.log(`[InviteExpiry] Expired ${userIds.length} pending invitation(s)`);
}
