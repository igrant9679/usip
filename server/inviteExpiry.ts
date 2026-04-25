/**
 * Invite Expiry — nightly jobs
 *
 * expireInvitations():
 *   Marks workspace_members rows whose inviteExpiresAt has passed and whose
 *   associated user still has loginMethod = "invite" as expired.
 *   Updates users.loginMethod to "expired_invite" so the UI can show
 *   a distinct "Expired" badge and the invite/resend guards still work.
 *
 * sendExpiryWarningEmails():
 *   Finds pending invitations expiring within the next 48 hours and sends
 *   a reminder email via the workspace's Email Delivery SMTP config
 *   (smtp_configs table — Settings → Email Delivery).
 *   Skips workspaces without a verified SMTP config.
 */
import { and, eq, gt, isNotNull, lte } from "drizzle-orm";
import { getDb } from "./db";
import { loginHistory, users, workspaceMembers, workspaces } from "../drizzle/schema";
import { sendWorkspaceEmail } from "./emailDelivery";

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

export async function sendExpiryWarningEmails(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  // Find pending invitations expiring within the next 48 hours
  const expiringSoon = await db
    .select({
      memberId: workspaceMembers.id,
      workspaceId: workspaceMembers.workspaceId,
      userId: workspaceMembers.userId,
      inviteExpiresAt: workspaceMembers.inviteExpiresAt,
      inviteToken: workspaceMembers.inviteToken,
      userName: users.name,
      userEmail: users.email,
      workspaceName: workspaces.name,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(
      and(
        isNotNull(workspaceMembers.inviteExpiresAt),
        gt(workspaceMembers.inviteExpiresAt, now),
        lte(workspaceMembers.inviteExpiresAt, in48h),
        eq(users.loginMethod, "invite"),
      ),
    );

  if (expiringSoon.length === 0) return;

  let warnedCount = 0;

  for (const member of expiringSoon) {
    if (!member.userEmail) continue;
    const hoursLeft = member.inviteExpiresAt
      ? Math.round((member.inviteExpiresAt.getTime() - now.getTime()) / 3_600_000)
      : 48;
    const recipientName = member.userName ?? member.userEmail.split("@")[0];
    const workspaceName = member.workspaceName ?? "USIP";
    const appOrigin = process.env.VITE_OAUTH_PORTAL_URL ?? "https://manus.im";
    const inviteUrl = member.inviteToken
      ? `${appOrigin}/invite/accept?token=${member.inviteToken}`
      : appOrigin;

    try {
      const result = await sendWorkspaceEmail(member.workspaceId, {
        to: member.userEmail,
        subject: `Your invitation to ${workspaceName} expires in ${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}`,
        html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
  <h2 style="margin-bottom:8px">Invitation expiring soon</h2>
  <p>Hi ${recipientName},</p>
  <p>Your invitation to join <strong>${workspaceName}</strong> on USIP will expire in approximately <strong>${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}</strong>.</p>
  <p style="margin:24px 0">
    <a href="${inviteUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">Accept invitation now</a>
  </p>
  <p style="color:#6b7280;font-size:13px">Or copy this link: <a href="${inviteUrl}">${inviteUrl}</a></p>
  <p style="color:#9ca3af;font-size:12px">If you did not expect this invitation, you can safely ignore this email.</p>
</div>`,
      });

      if (!result.ok) {
        console.warn(`[InviteExpiry] Warning email skipped for ${member.userEmail}: ${result.reason}`);
        continue;
      }

      // Log a warning entry in login_history so admins can see the reminder was sent
      try {
        await db.insert(loginHistory).values({
          userId: member.userId,
          workspaceId: member.workspaceId,
          outcome: "expired_invite",
          ipAddress: "system",
          userAgent: "expiry-warning-job",
        });
      } catch (_) { /* non-fatal */ }

      warnedCount++;
    } catch (emailErr) {
      console.error(`[InviteExpiry] Failed to send warning email to ${member.userEmail}:`, emailErr);
    }
  }

  if (warnedCount > 0) {
    console.log(`[InviteExpiry] Sent ${warnedCount} expiry warning email(s)`);
  }
}
