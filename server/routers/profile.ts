/**
 * profile.ts — self-service settings for the signed-in user.
 *
 * Today this is just the per-user email signature override; the router is
 * a natural home for future things like notification preferences or
 * timezone overrides without bloating admin/settings (which is workspace
 * scoped).
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { users, workspaceMembers } from "../../drizzle/schema";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";

export const profileRouter = router({
  /**
   * The signed-in user's account info for the Settings → Profile page:
   * name/email/login state from users + title/role from their membership
   * in the current workspace.
   */
  getMe: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [u] = await db
      .select({
        name: users.name,
        email: users.email,
        loginMethod: users.loginMethod,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);
    const [m] = await db
      .select({ title: workspaceMembers.title, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, ctx.workspace.id), eq(workspaceMembers.userId, ctx.user.id)))
      .limit(1);
    return {
      name: u?.name ?? "",
      email: u?.email ?? "",
      loginMethod: u?.loginMethod ?? null,
      hasPassword: !!u?.passwordHash,
      title: m?.title ?? "",
      role: m?.role ?? null,
    };
  }),

  /** Update the signed-in user's display name and their member title in this workspace. */
  updateMe: workspaceProcedure
    .input(z.object({
      name: z.string().trim().min(1, "Name is required").max(120),
      title: z.string().trim().max(120).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(users).set({ name: input.name }).where(eq(users.id, ctx.user.id));
      if (input.title !== undefined) {
        await db
          .update(workspaceMembers)
          .set({ title: input.title?.trim() ? input.title.trim() : null })
          .where(and(eq(workspaceMembers.workspaceId, ctx.workspace.id), eq(workspaceMembers.userId, ctx.user.id)));
      }
      return { ok: true };
    }),

  /**
   * Self-service password change. Users who already have a password must
   * supply the current one; OAuth-only users may set their first password
   * without it (same trust level as the invite password-setup flow).
   */
  changeMyPassword: workspaceProcedure
    .input(z.object({
      currentPassword: z.string().optional(),
      newPassword: z.string().min(8, "Password must be at least 8 characters").max(200),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [u] = await db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);
      if (u?.passwordHash) {
        if (!input.currentPassword) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Enter your current password." });
        }
        const ok = await bcrypt.compare(input.currentPassword, u.passwordHash);
        if (!ok) throw new TRPCError({ code: "FORBIDDEN", message: "Current password is incorrect." });
      }
      const hash = await bcrypt.hash(input.newPassword, 12);
      await db.update(users).set({ passwordHash: hash }).where(eq(users.id, ctx.user.id));
      return { ok: true };
    }),

  /**
   * Return the signed-in user's per-user signature override.
   * Empty string means "use the workspace default".
   */
  getMySignature: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db
      .select({ emailSignature: users.emailSignature })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);
    return { emailSignature: row?.emailSignature ?? "" };
  }),

  /**
   * Update the signed-in user's signature. Pass empty string (or null)
   * to clear the override and fall back to the workspace default.
   */
  updateMySignature: workspaceProcedure
    .input(z.object({ emailSignature: z.string().max(4000).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const value = input.emailSignature?.trim() ? input.emailSignature.trim() : null;
      await db
        .update(users)
        .set({ emailSignature: value })
        .where(eq(users.id, ctx.user.id));
      return { emailSignature: value ?? "" };
    }),

  /** The signed-in user's appearance preferences (colour theme). Null = default teal. */
  getMyAppearance: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db
      .select({ themePalette: users.themePalette })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);
    return { themePalette: row?.themePalette ?? null };
  }),

  /** Persist the colour theme so it follows the user across devices. */
  updateMyAppearance: workspaceProcedure
    .input(z.object({
      themePalette: z.enum(["teal", "indigo", "violet", "rose", "amber", "ocean", "graphite"]).nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // "teal" is the default — store null so future default changes apply.
      const value = input.themePalette && input.themePalette !== "teal" ? input.themePalette : null;
      await db.update(users).set({ themePalette: value }).where(eq(users.id, ctx.user.id));
      return { themePalette: value };
    }),
});
