/**
 * Workspace context middleware + role-guarded procedure factories.
 * Every protected USIP procedure must come from these helpers so that
 * `ctx.workspace` and `ctx.member.role` are guaranteed.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { workspaceMembers, workspaces, type WorkspaceMember, type Workspace } from "../../drizzle/schema";
import { getDb } from "../db";
import { protectedProcedure } from "./trpc";
import { mergeRequestContext } from "./requestContext";

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

  /**
   * 🔴 DEACTIVATION MUST REVOKE ACCESS, and it did not.
   *
   * `team.deactivate` reassigns the member's leads, opportunities and open
   * tasks, sets `deactivatedAt`, hides them from the Team list, and refuses to
   * reassign work TO them ("Reassign target is deactivated"). Every signal in
   * the product says this person is out.
   *
   * This function — which EVERY authenticated request passes through — matched
   * the membership on (userId, workspaceId) alone. `deactivatedAt` appeared
   * nowhere in `_core/`. So a deactivated member kept their session, could sign
   * in again with their password, and carried on at whatever role they held,
   * including admin. Offboarding a leaver removed their work, not their access.
   */
  // Look for membership matching header workspace if provided
  if (headerVal) {
    const wsId = Number(headerVal);
    if (Number.isFinite(wsId)) {
      const rows = await db
        .select({ ws: workspaces, mb: workspaceMembers })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(and(
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.workspaceId, wsId),
          isNull(workspaceMembers.deactivatedAt),
        ))
        .limit(1);
      if (rows[0]) return { workspace: rows[0].ws, member: rows[0].mb };
      // Deliberately FALLS THROUGH rather than throwing: someone deactivated in
      // this workspace may still be active in another, and should land there.
    }
  }

  // Fallback: first workspace they are still active in
  const rows = await db
    .select({ ws: workspaces, mb: workspaceMembers })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deactivatedAt)))
    .limit(1);

  if (!rows[0]) {
    /**
     * Separate "you were deactivated" from "you never had a workspace" — the
     * two need different words, and a leaver hitting a bare NO_WORKSPACE would
     * read it as a bug and ask someone to fix it.
     */
    const [everMember] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .limit(1);
    if (everMember) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Your access to this workspace has been deactivated. Contact an administrator.",
      });
    }
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
  /**
   * MERGE, do not replace. `als.run` installs a brand-new store, so calling
   * `runWithRequestContext` here would drop the `clientIp` the base middleware
   * in `_core/trpc.ts` just set. Harmless for an authenticated call — the
   * ceiling prefers the userId anyway — but it makes the store's contents
   * depend on middleware order, which is how the next reader gets it wrong.
   */
  return mergeRequestContext(
    { workspaceId: workspace.id, userId: ctx.user.id },
    () => next({ ctx: { ...ctx, workspace, member } })
  );
});

/** Role hierarchy: super_admin > admin > manager > rep */
const ROLE_RANK = { super_admin: 4, admin: 3, manager: 2, rep: 1 } as const;

export function roleRank(role: keyof typeof ROLE_RANK): number {
  return ROLE_RANK[role];
}

/**
 * Role helpers, exported because four routers had each declared their own copy
 * of the rank map — companies.ts, scoring.ts, linkedinEnrichment.ts (plus
 * literal `role === "admin" || role === "super_admin"` checks in are/scraper.ts
 * and linkedinFinder.ts).
 *
 * All five AGREED when this was written; the drift is latent, not live. But a
 * rank map is a permission boundary, and the failure mode of adding a role here
 * without updating the copies is that the new role is silently DENIED in four
 * routers and allowed everywhere else — which reads as a bug in the feature,
 * not in the map.
 *
 * Unknown roles rank 0, so anything not in the hierarchy is denied rather than
 * compared against `undefined`.
 */
export function rankOf(role: string): number {
  return (ROLE_RANK as Record<string, number>)[role] ?? 0;
}

export function isAdminRole(role: string): boolean {
  return rankOf(role) >= ROLE_RANK.admin;
}

/** Throw FORBIDDEN unless `role` is at least `min`. `message` names the action. */
export function requireMinRole(role: string, min: keyof typeof ROLE_RANK, message: string): void {
  if (rankOf(role) < ROLE_RANK[min]) {
    throw new TRPCError({ code: "FORBIDDEN", message });
  }
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
