/**
 * Workspace context middleware + role-guarded procedure factories.
 * Every protected USIP procedure must come from these helpers so that
 * `ctx.workspace` and `ctx.member.role` are guaranteed.
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { workspaceMembers, workspaces, type WorkspaceMember, type Workspace } from "../../drizzle/schema";
import { getDb } from "../db";
import { protectedProcedure } from "./trpc";

export type WorkspaceCtxExtension = {
  workspace: Workspace;
  member: WorkspaceMember;
};

/**
 * Resolves the active workspace for the current user.
 * Order of resolution:
  *   1. `x-workspace-id` header (set by frontend after switch)
 *   2. First workspace the user belongs to
 * If none exist, throws so the frontend can route to onboarding.
 */
async function resolveWorkspace(userId: number, headerVal?: string) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

  // Look for membership matching header workspace if provided
  if (headerVal) {
    const wsId = Number(headerVal);
    if (Number.isFinite(wsId)) {
      const rows = await db
        .select({ ws: workspaces, mb: workspaceMembers })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, wsId)))
        .limit(1);
      if (rows[0]) return { workspace: rows[0].ws, member: rows[0].mb };
    }
  }

  // Fallback: first workspace
  const rows = await db
    .select({ ws: workspaces, mb: workspaceMembers })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);

  if (!rows[0]) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "NO_WORKSPACE",
    });
  }
  return { workspace: rows[0].ws, member: rows[0].mb };
}

/**
 * `workspaceProcedure` is the workhorse. Every CRUD and read operation
 * uses it so that `ctx.workspace` and `ctx.member` are always present.
 */
export const workspaceProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const headerVal = ctx.req.headers["x-workspace-id"];
  const headerStr = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  const { workspace, member } = await resolveWorkspace(ctx.user.id, headerStr);
  return next({
    ctx: { ...ctx, workspace, member },
  });
});

/** Role hierarchy: super_admin > admin > manager > rep */
const ROLE_RANK = { super_admin: 4, admin: 3, manager: 2, rep: 1 } as const;

export function roleRank(role: keyof typeof ROLE_RANK): number {
  return ROLE_RANK[role];
}

function roleAtLeast(min: keyof typeof ROLE_RANK) {
  return workspaceProcedure.use(async ({ ctx, next }) => {
    if (ROLE_RANK[ctx.member.role] < ROLE_RANK[min]) {
      throw new TRPCError({ code: "FORBIDDEN", message: `Requires ${min} role` });
    }
    return next({ ctx });
  });
}

export const repProcedure = roleAtLeast("rep");
export const managerProcedure = roleAtLeast("manager");
export const adminWsProcedure = roleAtLeast("admin");
export const superAdminProcedure = roleAtLeast("super_admin");
