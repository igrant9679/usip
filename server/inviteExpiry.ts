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
 *   a reminder email via the workspace's configured system sender.
 *   Skips workspaces without a configured system sender.
 */
import { and, between, eq, gt, isNotNull, lte } from "drizzle-orm";
import { getDb } from "./db";
import { loginHistory, users, workspaceMembers, workspaceSettings } from "../drizzle/schema";

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
      userName: users.name,
      userEmail: users.email,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(
      and(
        isNotNull(workspaceMembers.inviteExpiresAt),
        gt(workspaceMembers.inviteExpiresAt, now),
        lte(workspaceMembers.inviteExpiresAt, in48h),
        eq(users.loginMethod, "invite"),
      ),
    );

  if (expiringSoon.length === 0) return;

  // Group by workspaceId to batch the settings lookup
  const byWorkspace = new Map<number, typeof expiringSoon>();
  for (const row of expiringSoon) {
    const list = byWorkspace.get(row.workspaceId) ?? [];
    list.push(row);
    byWorkspace.set(row.workspaceId, list);
  }

  let warnedCount = 0;

  for (const [workspaceId, members] of byWorkspace) {
    try {
      // Look up workspace settings for system sender
      const [settings] = await db
        .select({ systemSenderAccountId: workspaceSettings.systemSenderAccountId })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, workspaceId));

      if (!settings?.systemSenderAccountId) continue; // no sender configured

      const { sendingAccounts, workspaces } = await import("../drizzle/schema");
      const { buildTransporter, decrypt } = await import("./routers/smtpConfig");

      const [sender] = await db
        .select()
        .from(sendingAccounts)
        .where(eq(sendingAccounts.id, settings.systemSenderAccountId));

      if (!sender?.smtpHost || !sender?.smtpUsername || !sender?.smtpPassword) continue;

      const [workspace] = await db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));

      const workspaceName = workspace?.name ?? "USIP";
      const password = decrypt(sender.smtpPassword);
      const transporter = buildTransporter({
        host: sender.smtpHost,
        port: sender.smtpPort ?? 587,
        secure: sender.smtpSecure ?? false,
        username: sender.smtpUsername,
        password,
      });

      for (const member of members) {
        if (!member.userEmail) continue;
        const hoursLeft = member.inviteExpiresAt
          ? Math.round((member.inviteExpiresAt.getTime() - now.getTime()) / 3_600_000)
          : 48;
        try {
          await transporter.sendMail({
            from: `"${sender.fromName ?? workspaceName}" <${sender.fromEmail}>`,
            to: member.userEmail,
            subject: `Your invitation to ${workspaceName} expires in ${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}`,
            html: `<p>Hi ${member.userName ?? member.userEmail.split("@")[0]},</p>
<p>Your invitation to join <strong>${workspaceName}</strong> on USIP will expire in approximately <strong>${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}</strong>.</p>
<p>Please sign in at USIP to accept your invitation before it expires. If you need a new invitation, contact your workspace administrator.</p>
<p>If you did not expect this invitation, you can safely ignore this email.</p>`,
          });
          // Log a warning entry in login_history so admins can see the reminder was sent
          try {
            await db.insert(loginHistory).values({
              userId: member.userId,
              workspaceId,
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
    } catch (wsErr) {
      console.error(`[InviteExpiry] Error processing workspace ${workspaceId}:`, wsErr);
    }
  }

  if (warnedCount > 0) {
    console.log(`[InviteExpiry] Sent ${warnedCount} expiry warning email(s)`);
  }
}
