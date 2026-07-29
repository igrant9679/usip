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
import { runWithRequestContext } from "./requestContext";

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
 * How stale `lastActiveAt` may get before we refresh it. Every authenticated
 * request passes through here, so writing unconditionally would mean one UPDATE
 * per request; at 5 minutes it is at most one write per active user per 5 min
 * and the Team page is still accurate to within that.
 */
export const LAST_ACTIVE_REFRESH_MS = 5 * 60 * 1000;

/** Pure, so the throttle is testable without a database. */
export function shouldRefreshLastActive(
  lastActiveAt: Date | null | undefined,
  nowMs: number,
  refreshMs = LAST_ACTIVE_REFRESH_MS,
): boolean {
  if (!lastActiveAt) return true;
  const t = lastActiveAt instanceof Date ? lastActiveAt.getTime() : new Date(lastActiveAt).getTime();
  if (!Number.isFinite(t)) return true;
  // A clock skew or a future timestamp shouldn't wedge it permanently stale.
  return nowMs - t >= refreshMs || t > nowMs;
}

/**
 * `workspaceProcedure` is the workhorse. Every CRUD and read operation
 * uses it so that `ctx.workspace` and `ctx.member` are always present.
 */
export const workspaceProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const headerVal = ctx.req.headers["x-workspace-id"];
  const headerStr = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  const { workspace, member } = await resolveWorkspace(ctx.user.id, headerStr);

  /**
   * Touch `workspace_members.lastActiveAt`.
   *
   * The Team page has always rendered a "Last active" column for every member.
   * Nothing in the codebase ever wrote this column — its only other references
   * were the schema declaration, the SELECT in team.list, and a doc comment on
   * that router advertising "(Members + deactivated + lastActive)". So the
   * column read "—" for every member, permanently, and a manager could
   * reasonably read that as "nobody has logged in".
   *
   * Done here because this middleware is the one choke point every
   * authenticated request already passes through, and it ALREADY selects the
   * whole member row — so the throttle check costs nothing extra. Fire-and-
   * forget: presence tracking must never fail or slow the request it observes.
   */
  if (shouldRefreshLastActive(member.lastActiveAt as Date | null, Date.now())) {
    const db = await getDb();
    if (db) {
      void db
        .update(workspaceMembers)
        .set({ lastActiveAt: new Date() })
        .where(eq(workspaceMembers.id, member.id))
        .catch((e: unknown) => {
          console.warn("[workspace] lastActiveAt touch failed:", (e as Error).message);
        });
    }
  }
  // Stash workspaceId in async-local storage so downstream code (notably
  // invokeLLM) can pick up the active workspace without threading it through.
  return runWithRequestContext(
    { workspaceId: workspace.id, userId: ctx.user.id },
    () => next({ ctx: { ...ctx, workspace, member } })
  );
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
