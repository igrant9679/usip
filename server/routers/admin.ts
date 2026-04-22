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
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  leads,
  opportunities,
  tasks,
  usageCounters,
  users,
  workspaceMembers,
  workspaceSettings,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { adminWsProcedure, roleRank, workspaceProcedure } from "../_core/workspace";
import { router } from "../_core/trpc";
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
        notifyPolicy: z
          .record(
            z.string(),
            z.object({ inApp: z.boolean(), email: z.boolean() }),
          )
          .optional(),
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
        role: workspaceMembers.role,
        title: workspaceMembers.title,
        quota: workspaceMembers.quota,
        deactivatedAt: workspaceMembers.deactivatedAt,
        lastActiveAt: workspaceMembers.lastActiveAt,
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

      await db.insert(workspaceMembers).values({
        workspaceId: ctx.workspace.id,
        userId,
        role: input.role,
        title: input.title ?? null,
        quota: input.quota !== undefined ? String(input.quota) : null,
      });

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "workspace_member",
        entityId: userId,
        after: { email: input.email, role: input.role },
      });
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
});
