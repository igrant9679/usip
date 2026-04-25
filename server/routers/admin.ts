/**
 * Admin router — workspace Settings + Team management.
 *
 * Provides:
 *   - settings.get / settings.save           (General, Branding, Security, Notifications)
 *   - usage.currentMonth                     (Billing tab counters)
 *   - team.list                              (Members + deactivated + lastActive)
 *   - team.invite                            (create-or-link user to workspace)
 *   - team.changeRole                        (role-rank guarded; prevents self-demotion of sole super_admin)
 *   - team.setQuota / team.setTitle
 *   - team.deactivate                        (requires reassignTo; moves owned leads/opps/tasks to target)
 *   - team.reactivate
 *   - team.bulkChangeRole                    (admin+ only)
 */
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import {
  auditLog,
  leads,
  loginHistory,
  memberPermissions,
  opportunities,
  tasks,
  usageCounters,
  users,
  workspaceMembers,
  workspaceSettings,
} from "../../drizzle/schema";
import { checkPermission, getDb } from "../db";
import { adminWsProcedure, roleRank, workspaceProcedure } from "../_core/workspace";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { recordAudit } from "../audit";

const ROLE_ENUM = z.enum(["super_admin", "admin", "manager", "rep"]);
const DEFAULT_NOTIFY_POLICY = {
  newLeadRouted: { inApp: true, email: false },
  salesReadyCrossed: { inApp: true, email: true },
  dealMoved: { inApp: true, email: false },
  taskOverdue: { inApp: true, email: false },
  mention: { inApp: true, email: true },
};

async function getOrSeedSettings(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const [row] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId));
  if (row) return row;
  await db.insert(workspaceSettings).values({
    workspaceId,
    timezone: "UTC",
    brandPrimary: "#14B89A",
    brandAccent: "#0F766E",
    emailFromName: null,
    emailSignature: null,
    sessionTimeoutMin: 480,
    ipAllowlist: [],
    enforce2fa: false,
    notifyPolicy: DEFAULT_NOTIFY_POLICY,
  });
  const [fresh] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId));
  return fresh!;
}

export const settingsRouter = router({
  get: workspaceProcedure.query(async ({ ctx }) => {
    const s = await getOrSeedSettings(ctx.workspace.id);
    return {
      ...s,
      ipAllowlist: Array.isArray(s.ipAllowlist) ? s.ipAllowlist : [],
      notifyPolicy: (s.notifyPolicy as Record<string, any>) ?? DEFAULT_NOTIFY_POLICY,
    };
  }),

  save: adminWsProcedure
    .input(
      z.object({
        timezone: z.string().max(64).optional(),
        brandPrimary: z.string().regex(/^#([0-9A-Fa-f]{3,8})$/).optional(),
        brandAccent: z.string().regex(/^#([0-9A-Fa-f]{3,8})$/).optional(),
        emailFromName: z.string().max(120).nullable().optional(),
        emailSignature: z.string().max(4000).nullable().optional(),
        sessionTimeoutMin: z.number().int().min(15).max(60 * 24 * 7).optional(),
        ipAllowlist: z.array(z.string()).optional(),
        enforce2fa: z.boolean().optional(),
        blockInvalidEmailsFromSequences: z.boolean().optional(),
        notifyPolicy: z
          .record(
            z.string(),
            z.object({ inApp: z.boolean(), email: z.boolean() }),
          )
          .optional(),
        slackWebhookUrl: z.string().url().nullable().optional(),
        teamsWebhookUrl: z.string().url().nullable().optional(),
        systemSenderAccountId: z.number().int().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await getOrSeedSettings(ctx.workspace.id); // ensure row exists
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) {
        if (v !== undefined) patch[k] = v;
      }
      if (Object.keys(patch).length === 0) return { ok: true };
      await db.update(workspaceSettings).set(patch).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "workspace_settings",
        entityId: ctx.workspace.id,
        after: patch,
      });
      return { ok: true };
    }),
});

export const usageRouter = router({
  currentMonth: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    const [row] = await db
      .select()
      .from(usageCounters)
      .where(and(eq(usageCounters.workspaceId, ctx.workspace.id), eq(usageCounters.month, month)));
    return {
      month,
      llmTokens: Number(row?.llmTokens ?? 0),
      emailsSent: Number(row?.emailsSent ?? 0),
      seatsUsed: (await db.select({ c: count() }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, ctx.workspace.id)))[0]?.c ?? 0,
    };
  }),
});

/* ─── Team ─────────────────────────────────────────────────────────────── */

export const teamRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select({
        memberId: workspaceMembers.id,
        userId: users.id,
        openId: users.openId,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
        loginMethod: users.loginMethod,
        role: workspaceMembers.role,
        title: workspaceMembers.title,
        quota: workspaceMembers.quota,
        deactivatedAt: workspaceMembers.deactivatedAt,
        lastActiveAt: workspaceMembers.lastActiveAt,
        notifEmail: workspaceMembers.notifEmail,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(eq(workspaceMembers.workspaceId, ctx.workspace.id))
      .orderBy(desc(workspaceMembers.createdAt));
  }),

  /**
   * Invite a user to the workspace.
   * If `email` matches an existing user, we link that user; otherwise a
   * placeholder `users` row is created (openId = `invite:<email>`) so the
   * workspace membership is immediately usable for assignment even before
   * the invitee signs in.
   */
  invite: adminWsProcedure
    .input(
      z.object({
        email: z.string().email(),
        name: z.string().min(1).max(120).optional(),
        role: ROLE_ENUM.default("rep"),
        title: z.string().max(120).optional(),
        quota: z.number().nonnegative().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Guard: a rep cannot be promoted beyond your own role
      if (roleRank(input.role) > roleRank(ctx.member.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot assign a role higher than your own" });
      }

      // Find or create user
      const [existingUser] = await db.select().from(users).where(eq(users.email, input.email));
      let userId: number;
      if (existingUser) {
        userId = existingUser.id;
      } else {
        const inserted = await db.insert(users).values({
          openId: `invite:${input.email.toLowerCase()}`,
          name: input.name ?? input.email.split("@")[0],
          email: input.email,
          loginMethod: "invite",
        });
        userId = Number((inserted as any)[0]?.insertId ?? 0);
      }

      // Existing membership?
      const [existingMember] = await db
        .select()
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, ctx.workspace.id), eq(workspaceMembers.userId, userId)));
      if (existingMember) {
        throw new TRPCError({ code: "CONFLICT", message: "User is already a member of this workspace" });
      }

      // Generate invite token and expiry
      const inviteToken = crypto.randomBytes(32).toString("hex");
      const [wsSettings] = await db
        .select({ inviteExpiryDays: workspaceSettings.inviteExpiryDays })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      const expiryDays = wsSettings?.inviteExpiryDays ?? 7;
      const inviteExpiresAt = expiryDays && expiryDays > 0
        ? new Date(Date.now() + expiryDays * 86400_000)
        : null;
      await db.insert(workspaceMembers).values({
        workspaceId: ctx.workspace.id,
        userId,
        role: input.role,
        title: input.title ?? null,
        quota: input.quota !== undefined ? String(input.quota) : null,
        inviteToken,
        inviteExpiresAt,
      });

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "workspace_member",
        entityId: userId,
        after: { email: input.email, role: input.role },
      });
      // Send invitation email via workspace SMTP (Email Delivery settings)
      try {
        const { sendWorkspaceEmail } = await import("../emailDelivery");
        const appOrigin = process.env.VITE_OAUTH_PORTAL_URL ?? "https://manus.im";
        const inviteUrl = `${appOrigin}/invite/accept?token=${inviteToken}`;
        const recipientName = input.name ?? input.email.split("@")[0];
        await sendWorkspaceEmail(ctx.workspace.id, {
          to: input.email,
          subject: `You've been invited to join ${ctx.workspace.name}`,
          html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
  <h2 style="margin-bottom:8px">You're invited!</h2>
  <p>Hi ${recipientName},</p>
  <p><strong>${ctx.workspace.name}</strong> has invited you to join their workspace on USIP as a <strong>${input.role}</strong>.</p>
  <p style="margin:24px 0">
    <a href="${inviteUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">Accept invitation</a>
  </p>
  <p style="color:#6b7280;font-size:13px">Or copy this link: <a href="${inviteUrl}">${inviteUrl}</a></p>
  ${inviteExpiresAt ? `<p style="color:#6b7280;font-size:13px">This invitation expires on ${inviteExpiresAt.toLocaleDateString()}.</p>` : ""}
  <p style="color:#9ca3af;font-size:12px">If you did not expect this invitation, you can safely ignore this email.</p>
</div>`,
        });
      } catch (_e) {
        // Non-fatal: invitation email failure should not block the invite
      }
      return { ok: true, userId };
    }),

  changeRole: adminWsProcedure
    .input(z.object({ memberId: z.number().int(), role: ROLE_ENUM }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [target] = await db.select().from(workspaceMembers).where(
        and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, ctx.workspace.id)),
      );
      if (!target) throw new TRPCError({ code: "NOT_FOUND" });

      // Role-rank guards: cannot set a role higher than yours, and cannot modify a peer at >= your rank
      // (a super_admin can always act)
      if (roleRank(input.role) > roleRank(ctx.member.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot assign a role higher than your own" });
      }
      if (
        ctx.member.role !== "super_admin" &&
        roleRank(target.role) >= roleRank(ctx.member.role) &&
        target.userId !== ctx.user.id
      ) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot change role of a peer or higher" });
      }

      // Prevent demoting the sole super_admin
      if (target.role === "super_admin" && input.role !== "super_admin") {
        const [{ c }] = await db
          .select({ c: count() })
          .from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, ctx.workspace.id), eq(workspaceMembers.role, "super_admin")));
        if (Number(c) <= 1) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot demote the sole super_admin" });
        }
      }

      await db
        .update(workspaceMembers)
        .set({ role: input.role })
        .where(eq(workspaceMembers.id, input.memberId));
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "workspace_member",
        entityId: target.userId,
        after: { role: input.role },
      });
      return { ok: true };
    }),

  setQuota: adminWsProcedure
    .input(z.object({ memberId: z.number().int(), quota: z.number().nonnegative().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(workspaceMembers)
        .set({ quota: input.quota === null ? null : String(input.quota) })
        .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  setTitle: adminWsProcedure
    .input(z.object({ memberId: z.number().int(), title: z.string().max(120).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(workspaceMembers)
        .set({ title: input.title })
        .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  /**
   * Deactivate a member and reassign their owned leads / opportunities / open tasks.
   * Cannot deactivate the sole super_admin. Cannot deactivate yourself.
   */
  deactivate: adminWsProcedure
    .input(z.object({ memberId: z.number().int(), reassignToUserId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [target] = await db
        .select()
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, ctx.workspace.id)));
      if (!target) throw new TRPCError({ code: "NOT_FOUND" });
      if (target.userId === ctx.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot deactivate yourself" });
      if (
        ctx.member.role !== "super_admin" &&
        roleRank(target.role) >= roleRank(ctx.member.role)
      ) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot deactivate a peer or higher" });
      }

      // Sole super_admin guard
      if (target.role === "super_admin") {
        const [{ c }] = await db
          .select({ c: count() })
          .from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, ctx.workspace.id), eq(workspaceMembers.role, "super_admin")));
        if (Number(c) <= 1) throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot deactivate the sole super_admin" });
      }

      // Verify reassign target is an active member
      const [rcpt] = await db
        .select()
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, ctx.workspace.id), eq(workspaceMembers.userId, input.reassignToUserId)));
      if (!rcpt) throw new TRPCError({ code: "BAD_REQUEST", message: "Reassign target is not a workspace member" });
      if (rcpt.deactivatedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Reassign target is deactivated" });

      // Reassign owned work
      const [leadUpd] = await db.execute(sql`UPDATE leads SET ownerUserId = ${input.reassignToUserId} WHERE workspaceId = ${ctx.workspace.id} AND ownerUserId = ${target.userId}`) as any;
      const [oppUpd] = await db.execute(sql`UPDATE opportunities SET ownerUserId = ${input.reassignToUserId} WHERE workspaceId = ${ctx.workspace.id} AND ownerUserId = ${target.userId}`) as any;
      const [taskUpd] = await db.execute(sql`UPDATE tasks SET ownerUserId = ${input.reassignToUserId} WHERE workspaceId = ${ctx.workspace.id} AND ownerUserId = ${target.userId} AND status = 'open'`) as any;

      await db
        .update(workspaceMembers)
        .set({ deactivatedAt: new Date() })
        .where(eq(workspaceMembers.id, input.memberId));

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "workspace_member",
        entityId: target.userId,
        after: { deactivated: true, reassignedTo: input.reassignToUserId },
      });
      return {
        ok: true,
        reassigned: {
          leads: Number(leadUpd?.affectedRows ?? 0),
          opportunities: Number(oppUpd?.affectedRows ?? 0),
          openTasks: Number(taskUpd?.affectedRows ?? 0),
        },
      };
    }),

  reactivate: adminWsProcedure
    .input(z.object({ memberId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(workspaceMembers)
        .set({ deactivatedAt: null })
        .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  bulkChangeRole: adminWsProcedure
    .input(z.object({ memberIds: z.array(z.number().int()).min(1).max(200), role: ROLE_ENUM }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      if (roleRank(input.role) > roleRank(ctx.member.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot assign a role higher than your own" });
      }
      await db
        .update(workspaceMembers)
        .set({ role: input.role })
        .where(and(eq(workspaceMembers.workspaceId, ctx.workspace.id), inArray(workspaceMembers.id, input.memberIds)));
      return { ok: true, count: input.memberIds.length };
    }),

  /**
   * Bulk deactivate multiple members with a single reassign target.
   * Applies the same guards as single deactivate per member.
   */
  bulkDeactivate: adminWsProcedure
    .input(z.object({ memberIds: z.array(z.number().int()).min(1).max(50), reassignToUserId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Verify reassign target is an active member
      const [rcpt] = await db.select().from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, ctx.workspace.id), eq(workspaceMembers.userId, input.reassignToUserId)));
      if (!rcpt) throw new TRPCError({ code: "BAD_REQUEST", message: "Reassign target is not a workspace member" });
      if (rcpt.deactivatedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Reassign target is deactivated" });

      const targets = await db.select().from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, ctx.workspace.id), inArray(workspaceMembers.id, input.memberIds)));

      let deactivated = 0;
      let skipped = 0;
      // Count active super_admins to protect sole super_admin
      const [{ superAdminCount }] = await db.select({ superAdminCount: count() }).from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, ctx.workspace.id), eq(workspaceMembers.role, "super_admin"), isNull(workspaceMembers.deactivatedAt)));
      const activeSuperAdmins = Number(superAdminCount ?? 0);
      const targetSuperAdminIds = new Set(targets.filter((t) => t.role === "super_admin" && !t.deactivatedAt).map((t) => t.userId));
      const wouldRemoveSoleSuperAdmin = activeSuperAdmins - targetSuperAdminIds.size < 1;
      if (wouldRemoveSoleSuperAdmin) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot deactivate the sole super_admin. Promote another member first." });
      }

      for (const target of targets) {
        // Skip self, already deactivated, peer-rank violations
        if (target.userId === ctx.user.id) { skipped++; continue; }
        if (target.deactivatedAt) { skipped++; continue; }
        if (ctx.member.role !== "super_admin" && roleRank(target.role) >= roleRank(ctx.member.role)) { skipped++; continue; }

        // Reassign owned work
        await db.execute(sql`UPDATE leads SET ownerUserId = ${input.reassignToUserId} WHERE workspaceId = ${ctx.workspace.id} AND ownerUserId = ${target.userId}`);
        await db.execute(sql`UPDATE opportunities SET ownerUserId = ${input.reassignToUserId} WHERE workspaceId = ${ctx.workspace.id} AND ownerUserId = ${target.userId}`);
        await db.execute(sql`UPDATE tasks SET ownerUserId = ${input.reassignToUserId} WHERE workspaceId = ${ctx.workspace.id} AND ownerUserId = ${target.userId} AND status = 'open'`);

        await db.update(workspaceMembers).set({ deactivatedAt: new Date() }).where(eq(workspaceMembers.id, target.id));
        deactivated++;
      }

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "workspace_member",
        entityId: 0,
        after: { bulkDeactivated: deactivated, skipped, reassignedTo: input.reassignToUserId },
      });
       return { ok: true, deactivated, skipped };
    }),

  /** Update the calling member's notification email and preferences. */
  updateNotifPrefs: workspaceProcedure
    .input(
      z.object({
        notifEmail: z.string().email().nullable().optional(),
        notifPrefs: z
          .object({
            sequence_reply: z.boolean().optional(),
            social_response: z.boolean().optional(),
            workflow_alert: z.boolean().optional(),
            system: z.boolean().optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const patch: Record<string, unknown> = {};
      if (input.notifEmail !== undefined) patch.notifEmail = input.notifEmail;
      if (input.notifPrefs !== undefined) patch.notifPrefs = input.notifPrefs;
      if (Object.keys(patch).length === 0) return { ok: true };
      await db
        .update(workspaceMembers)
        .set(patch)
        .where(
          and(
            eq(workspaceMembers.workspaceId, ctx.workspace.id),
            eq(workspaceMembers.userId, ctx.user.id),
          ),
        );
      return { ok: true };
    }),

  /**
   * Set (or reset) a team member's local password.
   * Only admins can set passwords for members below their rank.
   * The password is hashed with bcrypt (cost 12) and stored in users.passwordHash.
   */
  setMemberPassword: adminWsProcedure
    .input(
      z.object({
        memberId: z.number().int(),
        password: z.string().min(8, "Password must be at least 8 characters"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [member] = await db
        .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, ctx.workspace.id)));
      if (!member) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
      if (ctx.member.role !== "super_admin" && roleRank(member.role) >= roleRank(ctx.member.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot set password for a member at or above your role" });
      }
      const hash = await bcrypt.hash(input.password, 12);
      await db.update(users).set({ passwordHash: hash }).where(eq(users.id, member.userId));
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "workspace_member",
        entityId: member.userId,
        after: { action: "password_set" },
      });
      return { ok: true };
    }),

  /**
   * Resend the invitation email to a pending (not-yet-accepted) member.
   * Guard: user must still have loginMethod = "invite".
   */
  resendInvitation: adminWsProcedure
    .input(z.object({ memberId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [row] = await db
        .select({
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
          deactivatedAt: workspaceMembers.deactivatedAt,
          email: users.email,
          name: users.name,
          loginMethod: users.loginMethod,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, ctx.workspace.id)));
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
      if (row.loginMethod !== "invite") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Member has already accepted their invitation and signed in" });
      }
      if (row.deactivatedAt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot resend invitation to a deactivated member" });
      }
      // Regenerate invite token and reset expiry
      const newToken = crypto.randomBytes(32).toString("hex");
      const [wsSettings2] = await db
        .select({ inviteExpiryDays: workspaceSettings.inviteExpiryDays })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      const expiryDays2 = wsSettings2?.inviteExpiryDays ?? 7;
      const newExpiresAt = expiryDays2 && expiryDays2 > 0
        ? new Date(Date.now() + expiryDays2 * 86400_000)
        : null;
      await db.update(workspaceMembers)
        .set({ inviteToken: newToken, inviteExpiresAt: newExpiresAt })
        .where(eq(workspaceMembers.id, input.memberId));
      // Resend invitation email via workspace SMTP (Email Delivery settings)
      try {
        const { sendWorkspaceEmail } = await import("../emailDelivery");
        const appOrigin = process.env.VITE_OAUTH_PORTAL_URL ?? "https://manus.im";
        const resendUrl = `${appOrigin}/invite/accept?token=${newToken}`;
        const recipientName = row.name ?? row.email?.split("@")[0];
        await sendWorkspaceEmail(ctx.workspace.id, {
          to: row.email!,
          subject: `Reminder: You've been invited to join ${ctx.workspace.name}`,
          html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
  <h2 style="margin-bottom:8px">Invitation reminder</h2>
  <p>Hi ${recipientName},</p>
  <p>This is a reminder that you have been invited to join <strong>${ctx.workspace.name}</strong> on USIP as a <strong>${row.role}</strong>.</p>
  <p style="margin:24px 0">
    <a href="${resendUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">Accept invitation</a>
  </p>
  <p style="color:#6b7280;font-size:13px">Or copy this link: <a href="${resendUrl}">${resendUrl}</a></p>
  ${newExpiresAt ? `<p style="color:#6b7280;font-size:13px">This invitation expires on ${newExpiresAt.toLocaleDateString()}.</p>` : ""}
  <p style="color:#9ca3af;font-size:12px">If you did not expect this invitation, you can safely ignore this email.</p>
</div>`,
        });
      } catch (_e) { /* Non-fatal */ }
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "workspace_member",
        entityId: row.userId,
        after: { action: "invitation_resent", email: row.email },
      });
      return { ok: true };
    }),

  /**
   * Return the invite link URL for a pending member.
   * Regenerates the token if it is expired or missing.
   * Guard: member must still have loginMethod = "invite".
   */
  copyInviteLink: adminWsProcedure
    .input(z.object({ memberId: z.number().int(), origin: z.string().url() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [row] = await db
        .select({
          userId: workspaceMembers.userId,
          loginMethod: users.loginMethod,
          deactivatedAt: workspaceMembers.deactivatedAt,
          inviteToken: workspaceMembers.inviteToken,
          inviteExpiresAt: workspaceMembers.inviteExpiresAt,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, ctx.workspace.id)));
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
      if (row.loginMethod !== "invite") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Member has already accepted their invitation" });
      }
      if (row.deactivatedAt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot get invite link for a deactivated member" });
      }
      // Regenerate token if missing or expired
      const now = new Date();
      let token = row.inviteToken;
      if (!token || (row.inviteExpiresAt && row.inviteExpiresAt <= now)) {
        token = crypto.randomBytes(32).toString("hex");
        const [settings] = await db
          .select({ inviteExpiryDays: workspaceSettings.inviteExpiryDays })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
        const expiryDays = settings?.inviteExpiryDays ?? 7;
        const expiresAt = expiryDays > 0 ? new Date(now.getTime() + expiryDays * 86400_000) : null;
        await db.update(workspaceMembers)
          .set({ inviteToken: token, inviteExpiresAt: expiresAt })
          .where(eq(workspaceMembers.id, input.memberId));
      }
      return { url: `${input.origin}/invite/accept?token=${token}` };
    }),

  /**
   * Return recent login history for a specific workspace member.
   * Returns up to 50 most recent entries.
   */
  getLoginHistory: adminWsProcedure
    .input(z.object({ memberId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Resolve userId from memberId
      const [member] = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, ctx.workspace.id)));
      if (!member) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
      return db
        .select()
        .from(loginHistory)
        .where(eq(loginHistory.userId, member.userId))
        .orderBy(desc(loginHistory.createdAt))
        .limit(50);
    }),

  /**
   * Update the invitation expiry days setting for this workspace.
   * 0 = no expiry.
   */
  updateInviteExpiry: adminWsProcedure
    .input(z.object({ days: z.number().int().min(0).max(365) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await getOrSeedSettings(ctx.workspace.id);
      await db.update(workspaceSettings)
        .set({ inviteExpiryDays: input.days === 0 ? null : input.days })
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "workspace_settings",
        entityId: ctx.workspace.id,
        after: { inviteExpiryDays: input.days },
      });
      return { ok: true };
    }),

  /**
   * Public: look up an invite token and return workspace/role info for the acceptance page.
   * Does not accept the invite — just validates the token and returns display info.
   */
  acceptInvitePreview: publicProcedure
    .input(z.object({ token: z.string().min(1) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { workspaces } = await import("../../drizzle/schema");
      const [row] = await db
        .select({
          memberId: workspaceMembers.id,
          workspaceId: workspaceMembers.workspaceId,
          workspaceName: workspaces.name,
          role: workspaceMembers.role,
          inviteExpiresAt: workspaceMembers.inviteExpiresAt,
          loginMethod: users.loginMethod,
          userName: users.name,
          userEmail: users.email,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(workspaceMembers.userId, users.id))
        .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(eq(workspaceMembers.inviteToken, input.token));
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Invite link is invalid or has already been used." });
      if (row.loginMethod !== "invite" && row.loginMethod !== "expired_invite") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This invitation has already been accepted." });
      }
      const now = new Date();
      if (row.inviteExpiresAt && row.inviteExpiresAt <= now) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This invitation link has expired. Please ask an admin to resend your invitation." });
      }
      return {
        workspaceName: row.workspaceName,
        role: row.role,
        userName: row.userName,
        userEmail: row.userEmail,
        expiresAt: row.inviteExpiresAt,
      };
    }),

  /**
   * Protected: finalise invite acceptance after the user has signed in via OAuth.
   * Matches the calling user's email to the pending invite token, then marks accepted.
   */
  finaliseAcceptance: protectedProcedure
    .input(z.object({ token: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { workspaces } = await import("../../drizzle/schema");
      const [row] = await db
        .select({
          memberId: workspaceMembers.id,
          workspaceId: workspaceMembers.workspaceId,
          workspaceName: workspaces.name,
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
          inviteExpiresAt: workspaceMembers.inviteExpiresAt,
          loginMethod: users.loginMethod,
          userEmail: users.email,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(workspaceMembers.userId, users.id))
        .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(eq(workspaceMembers.inviteToken, input.token));
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Invite link is invalid or has already been used." });
      if (row.loginMethod !== "invite" && row.loginMethod !== "expired_invite") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This invitation has already been accepted." });
      }
      const now = new Date();
      if (row.inviteExpiresAt && row.inviteExpiresAt <= now) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This invitation link has expired. Please ask an admin to resend your invitation." });
      }
      // Verify the signed-in user's email matches the invite
      if (ctx.user.email?.toLowerCase() !== row.userEmail?.toLowerCase()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `This invite was sent to ${row.userEmail}. Please sign in with that email address.`,
        });
      }
      // Mark accepted: update users.loginMethod, clear invite token
      await db.update(users)
        .set({ loginMethod: "oauth", openId: ctx.user.openId })
        .where(eq(users.id, row.userId));
      await db.update(workspaceMembers)
        .set({ inviteToken: null, inviteExpiresAt: null })
        .where(eq(workspaceMembers.id, row.memberId));
      // Record login history
      try {
        await db.insert(loginHistory).values({
          userId: row.userId,
          workspaceId: row.workspaceId,
          outcome: "success",
        });
      } catch (_) { /* non-fatal */ }
      await recordAudit({
        workspaceId: row.workspaceId,
        actorUserId: row.userId,
        action: "update",
        entityType: "workspace_member",
        entityId: row.memberId,
        after: { loginMethod: "oauth", inviteAccepted: true },
      });
      return { ok: true, workspaceName: row.workspaceName, role: row.role };
    }),

  /**
   * Return filtered login history for a specific workspace member.
   * Supports optional outcome filter and date range. Returns up to 200 rows.
   */
  getLoginHistoryFiltered: adminWsProcedure
    .input(z.object({
      memberId: z.number().int(),
      outcome: z.enum(["success", "failed", "expired_invite"]).optional(),
      from: z.date().optional(),
      to: z.date().optional(),
      limit: z.number().int().min(1).max(500).default(200),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [member] = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, ctx.workspace.id)));
      if (!member) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
      const conditions: ReturnType<typeof eq>[] = [eq(loginHistory.userId, member.userId) as any];
      if (input.outcome) conditions.push(eq(loginHistory.outcome, input.outcome) as any);
      if (input.from) conditions.push(gte(loginHistory.createdAt, input.from) as any);
      if (input.to) conditions.push(lte(loginHistory.createdAt, input.to) as any);
      return db
        .select()
        .from(loginHistory)
        .where(and(...conditions))
        .orderBy(desc(loginHistory.createdAt))
        .limit(input.limit);
    }),

  /** Return the calling member's notification prefs. */
  getNotifPrefs: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db
      .select({ notifEmail: workspaceMembers.notifEmail, notifPrefs: workspaceMembers.notifPrefs })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspace.id),
          eq(workspaceMembers.userId, ctx.user.id),
        ),
      );
    const DEFAULT_PREFS = { sequence_reply: true, social_response: true, workflow_alert: true, system: true };
    return {
      notifEmail: row?.notifEmail ?? null,
      notifPrefs: (row?.notifPrefs as Record<string, boolean> | null) ?? DEFAULT_PREFS,
    };
  }),
});
/* ─── Danger Zone ───────────────────────────────────────────────────────── */

export const dangerZoneRouter = router({
  /**
   * Soft-archive the workspace. Sets archivedAt = now.
   * Only the workspace owner (super_admin) can archive.
   * After archiving, the workspace is hidden from workspace switcher.
   */
  archiveWorkspace: adminWsProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    // Only super_admin can archive
    if (ctx.member.role !== "super_admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: "Only super admins can archive a workspace" });
    }
    const { workspaces } = await import("../../drizzle/schema");
    await db.update(workspaces).set({ archivedAt: new Date() }).where(eq(workspaces.id, ctx.workspace.id));
    await recordAudit({
      workspaceId: ctx.workspace.id,
      actorUserId: ctx.user.id,
      action: "update",
      entityType: "workspace",
      entityId: ctx.workspace.id,
      after: { archived: true },
    });
    return { ok: true };
  }),

  /**
   * Transfer workspace ownership to another active super_admin member.
   * The current owner's role is not changed; the new owner's ownerUserId is set.
   */
  transferOwnership: adminWsProcedure
    .input(z.object({ newOwnerUserId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      if (ctx.member.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only super admins can transfer ownership" });
      }
      if (input.newOwnerUserId === ctx.user.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "You are already the owner" });
      }
      // Verify new owner is an active member
      const [newOwnerMember] = await db.select().from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, ctx.workspace.id), eq(workspaceMembers.userId, input.newOwnerUserId)));
      if (!newOwnerMember) throw new TRPCError({ code: "NOT_FOUND", message: "New owner is not a workspace member" });
      if (newOwnerMember.deactivatedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "New owner is deactivated" });

      const { workspaces } = await import("../../drizzle/schema");
      await db.update(workspaces).set({ ownerUserId: input.newOwnerUserId }).where(eq(workspaces.id, ctx.workspace.id));
      // Ensure new owner has super_admin role
      await db.update(workspaceMembers).set({ role: "super_admin" }).where(eq(workspaceMembers.id, newOwnerMember.id));

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "workspace",
        entityId: ctx.workspace.id,
        after: { ownerTransferredTo: input.newOwnerUserId },
      });
      return { ok: true };
    }),

  /**
   * Export workspace data as a JSON summary.
   * Returns counts and a sample of each entity type.
   * Full export (CSV per entity) would require streaming — this returns a JSON blob.
   */
  exportData: adminWsProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    // Role guard: super_admin only (existing), plus per-member permission override
    if (ctx.member.role !== "super_admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: "Only super admins can export workspace data" });
    }
    await checkPermission(ctx, "export_data");

    const { contacts, leads, accounts, opportunities, customers, tasks: tasksTable } = await import("../../drizzle/schema");

    const [contactCount] = await db.select({ c: count() }).from(contacts).where(eq(contacts.workspaceId, ctx.workspace.id));
    const [leadCount] = await db.select({ c: count() }).from(leads).where(eq(leads.workspaceId, ctx.workspace.id));
    const [accountCount] = await db.select({ c: count() }).from(accounts).where(eq(accounts.workspaceId, ctx.workspace.id));
    const [oppCount] = await db.select({ c: count() }).from(opportunities).where(eq(opportunities.workspaceId, ctx.workspace.id));
    const [customerCount] = await db.select({ c: count() }).from(customers).where(eq(customers.workspaceId, ctx.workspace.id));
    const [taskCount] = await db.select({ c: count() }).from(tasksTable).where(eq(tasksTable.workspaceId, ctx.workspace.id));

    const exportData = {
      exportedAt: new Date().toISOString(),
      workspaceId: ctx.workspace.id,
      workspaceName: ctx.workspace.name,
      summary: {
        contacts: Number(contactCount?.c ?? 0),
        leads: Number(leadCount?.c ?? 0),
        accounts: Number(accountCount?.c ?? 0),
        opportunities: Number(oppCount?.c ?? 0),
        customers: Number(customerCount?.c ?? 0),
        tasks: Number(taskCount?.c ?? 0),
      },
    };

    await recordAudit({
      workspaceId: ctx.workspace.id,
      actorUserId: ctx.user.id,
      action: "create",
      entityType: "data_export",
      entityId: ctx.workspace.id,
      after: exportData.summary,
    });

    return exportData;
  }),

  /**
   * Update editable fields for a team member.
   * Admins can edit members below their rank.
   * Editable fields: name, email (users table), title, role, quota, notifEmail (workspaceMembers table).
   */
  updateMember: adminWsProcedure
    .input(
      z.object({
        memberId: z.number().int(),
        name: z.string().min(1).max(120).optional(),
        email: z.string().email().optional(),
        title: z.string().max(120).nullable().optional(),
        role: z.enum(["super_admin", "admin", "manager", "rep"]).optional(),
        quota: z.number().min(0).nullable().optional(),
        notifEmail: z.string().email().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Resolve the member row
      const [member] = await db
        .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, ctx.workspace.id)));
      if (!member) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });

      // Role-rank guard: cannot edit a member at or above your own rank
      if (ctx.member.role !== "super_admin" && roleRank(member.role) >= roleRank(ctx.member.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot edit a member at or above your role" });
      }

      // If promoting to a role above the caller's rank, block it
      if (input.role && ctx.member.role !== "super_admin" && roleRank(input.role) >= roleRank(ctx.member.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot promote a member to a role at or above your own" });
      }

      // Update users table (name, email)
      const userPatch: Record<string, unknown> = {};
      if (input.name !== undefined) userPatch.name = input.name;
      if (input.email !== undefined) userPatch.email = input.email;
      if (Object.keys(userPatch).length > 0) {
        await db.update(users).set(userPatch).where(eq(users.id, member.userId));
      }

      // Update workspaceMembers table (title, role, quota, notifEmail)
      const memberPatch: Record<string, unknown> = {};
      if (input.title !== undefined) memberPatch.title = input.title;
      if (input.role !== undefined) memberPatch.role = input.role;
      if (input.quota !== undefined) memberPatch.quota = input.quota !== null ? String(input.quota) : null;
      if (input.notifEmail !== undefined) memberPatch.notifEmail = input.notifEmail;
      if (Object.keys(memberPatch).length > 0) {
        await db.update(workspaceMembers).set(memberPatch)
          .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, ctx.workspace.id)));
      }

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "workspace_member",
        entityId: member.userId,
        after: { ...userPatch, ...memberPatch },
      });

      return { ok: true };
    }),

  /** Return all permission overrides for a member in this workspace */
  getPermissions: adminWsProcedure
    .input(z.object({ memberId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [member] = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, ctx.workspace.id)));
      if (!member) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });

      const rows = await db
        .select()
        .from(memberPermissions)
        .where(and(eq(memberPermissions.workspaceId, ctx.workspace.id), eq(memberPermissions.userId, member.userId)));

      // Return as a map: { feature: granted }
      const perms: Record<string, boolean> = {};
      for (const row of rows) perms[row.feature] = row.granted;
      return perms;
    }),

  /** Upsert permission overrides for a member */
  setPermissions: adminWsProcedure
    .input(z.object({
      memberId: z.number().int(),
      permissions: z.record(z.string().max(80), z.boolean()),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [member] = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, ctx.workspace.id)));
      if (!member) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });

      const entries = Object.entries(input.permissions);
      if (entries.length === 0) return { ok: true };

      // Upsert each feature permission
      for (const [feature, granted] of entries) {
        await db
          .insert(memberPermissions)
          .values({ workspaceId: ctx.workspace.id, userId: member.userId, feature, granted, grantedBy: ctx.user.id })
          .onDuplicateKeyUpdate({ set: { granted, grantedBy: ctx.user.id } });
      }

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "workspace_member",
        entityId: member.userId,
        after: { permissions: input.permissions },
      });

      return { ok: true };
    }),

  /** Return recent audit log entries for a specific member */
  getMemberActivityLog: adminWsProcedure
    .input(z.object({
      memberId: z.number().int(),
      limit: z.number().int().min(1).max(100).default(50),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [member] = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, ctx.workspace.id)));
      if (!member) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });

      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.workspaceId, ctx.workspace.id),
            or(
              and(eq(auditLog.entityType, "workspace_member"), eq(auditLog.entityId, member.userId)),
              and(eq(auditLog.entityType, "user"), eq(auditLog.entityId, member.userId)),
              and(eq(auditLog.action, "login"), eq(auditLog.actorUserId, member.userId)),
            ),
          ),
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(input.limit);

      return rows;
    }),
});
