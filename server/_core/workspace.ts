/**
 * Workspace context middleware + role-guarded procedure factories.
 * Every protected USIP procedure must come from these helpers so that
 * `ctx.workspace` and `ctx.member.role` are guaranteed.
 */
import { TRPCError } from "@trpc/server";
import { and, count, eq, isNull } from "drizzle-orm";
import { workspaceMembers, workspaces, type WorkspaceMember, type Workspace } from "../../drizzle/schema";
import { getDb } from "../db";
import { protectedProcedure } from "./trpc";
import { mergeRequestContext } from "./requestContext";
import { mfaGateExemptPath, securityPolicyFor } from "./securityPolicy";
import { autoAuditSkipped, writeAutoAudit } from "./autoAudit";
import { MFA_REQUIRED_ERR_MSG, WORKSPACE_UNAVAILABLE_ERR_MSG } from "@shared/const";
import { isAdminRole, rankOf, ROLE_RANK } from "@shared/roleRank";

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
  /**
   * 🔴 AN INVITATION IS NOT A MEMBERSHIP UNTIL IT IS ACCEPTED (audit
   * 2026-10-20, C1).
   *
   * team.invite writes the membership row at once, with an invite token on
   * it, and this function used to ignore the token — so typing someone's
   * email into another workspace's invite box made them a working member of
   * it, without their knowledge, and made their account reachable from that
   * workspace's admin tools. A row is a membership once its token is cleared,
   * which only the invite-accept path does (finaliseAcceptance, or register
   * claiming its own placeholder).
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
          isNull(workspaceMembers.inviteToken),
        ))
        .limit(1);
      if (rows[0]) return { workspace: rows[0].ws, member: rows[0].mb };
      /**
       * REFUSED, not answered from another workspace (audit 2026-10-20, G11).
       * This used to fall through to the person's first workspace, so that
       * someone deactivated here but active elsewhere would land there. But
       * the tab that sent the header still SHOWS this workspace, and its next
       * save, send or delete went to a different one. The client reloads its
       * workspace list on this message and moves the tab somewhere the person
       * still belongs, so they still land there, knowingly.
       */
      throw new TRPCError({ code: "FORBIDDEN", message: WORKSPACE_UNAVAILABLE_ERR_MSG });
    }
  }

  // Fallback: first workspace they are still active in
  const rows = await db
    .select({ ws: workspaces, mb: workspaceMembers })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(
      eq(workspaceMembers.userId, userId),
      isNull(workspaceMembers.deactivatedAt),
      isNull(workspaceMembers.inviteToken),
    ))
    .limit(1);

  if (!rows[0]) {
    /**
     * Separate "you were deactivated" from "you never had a workspace" — the
     * two need different words, and a leaver hitting a bare NO_WORKSPACE would
     * read it as a bug and ask someone to fix it.
     */
    const absence = await workspaceAbsenceReason(db, userId);
    if (absence === "invite_pending") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Your invitation hasn't been accepted yet. Open the invitation link in your email to join the workspace.",
      });
    }
    if (absence === "deactivated") {
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

export type WorkspaceAbsence = "invite_pending" | "deactivated" | "none";

/**
 * Why someone with no workspace to work in has none: an invitation they have
 * not accepted, a membership that was deactivated, or nothing at all. One
 * answer for the refusal above and for the client's access screen
 * (workspace.access, audit 2026-10-20, G35), which used to be a shell that
 * never finished loading.
 */
export async function workspaceAbsenceReason(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number,
): Promise<WorkspaceAbsence> {
  const [everMember] = await db
    .select({ id: workspaceMembers.id, inviteToken: workspaceMembers.inviteToken, deactivatedAt: workspaceMembers.deactivatedAt })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);
  if (everMember && everMember.inviteToken && !everMember.deactivatedAt) return "invite_pending";
  if (everMember) return "deactivated";
  return "none";
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
 * What stops a member at a workspace's door, or null if nothing does. One rule
 * for every door: workspaceProcedure, the stream routes and the file proxy.
 * Those two had their own copy of the membership check, and it had lost the
 * pending-invite, archive and 2FA rules (audit 2026-10-20, G30).
 */
export async function workspaceGateRefusal(
  workspace: { id: number; archivedAt?: unknown },
  member: { role: string },
  user: { mfaTotpEnabledAt?: unknown },
  path?: string,
): Promise<string | null> {
  /**
   * Archive ENFORCEMENT (2026-08-12, owner-approved — shipped together with
   * un-archive, per the standing rule that enforcement without a way back is
   * a one-way lockout). An archived workspace is frozen for members; only a
   * super_admin may still enter — they are the ones who can restore it from
   * Danger Zone, and a lock nobody can open is not a lock, it is a loss.
   * The autonomous engines enforce the same freeze via _core/workspaceArchive.
   */
  if (workspace.archivedAt && member.role !== "super_admin") {
    return "This workspace is archived. A super admin can restore it from Settings → Danger Zone.";
  }

  /**
   * `enforce2fa` ENFORCEMENT (2026-09-20). Settings → Security stored this
   * flag and nothing read it — the tab said so in an amber banner, because a
   * security control that lies is worse than one that is absent.
   *
   * Four things keep it from becoming a one-way lockout:
   *   · super_admin is exempt, exactly as the archive gate above is. They are
   *     the ones who can switch the policy back off, and `settings.save` is
   *     itself behind this middleware — a lock nobody can open is a loss.
   *   · The four enrolment procedures are exempt (`mfaGateExemptPath`); they
   *     are workspaceProcedure too, so without that the screen that would
   *     clear the block cannot load.
   *   · `settings.save` refuses to TURN IT ON for an admin who has not
   *     enrolled, so the person who flips it is never the first one blocked.
   *   · securityPolicyFor fails open, so a database fault suspends the policy
   *     rather than locking the workspace out of its own product.
   *
   * MFA state comes off the signed-in user, which `sdk.authenticateRequest` already
   * loaded as a full `users` row — no extra query, and therefore no stale
   * window between confirming enrolment and being let back in.
   *
   * Ordering matters: the archive gate stays ABOVE this one. Its message
   * names the way back (Settings → Danger Zone) and must not be masked.
   */
  if (member.role !== "super_admin" && !(path && mfaGateExemptPath(path))) {
    const policy = await securityPolicyFor(workspace.id);
    if (policy && policy.enforce2fa && !user.mfaTotpEnabledAt) return MFA_REQUIRED_ERR_MSG;
  }

  return null;
}

/**
 * For a door outside tRPC, which has no middleware to lean on: is this user a
 * member here, with the same meaning of "member" as resolveWorkspace, and does
 * anything stop them? Returns why not, or null to let them in.
 */
export async function workspaceDoorRefusal(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  user: { id: number; mfaTotpEnabledAt?: unknown },
  workspaceId: number,
): Promise<string | null> {
  const [found] = await db
    .select({ ws: workspaces, mb: workspaceMembers })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(
      eq(workspaceMembers.userId, user.id),
      eq(workspaceMembers.workspaceId, workspaceId),
      isNull(workspaceMembers.deactivatedAt),
      isNull(workspaceMembers.inviteToken),
    ))
    .limit(1);
  if (!found) return "Not a member of that workspace";
  return workspaceGateRefusal(found.ws, found.mb, user);
}

/**
 * `workspaceProcedure` is the workhorse. Every CRUD and read operation
 * uses it so that `ctx.workspace` and `ctx.member` are always present.
 */
export const workspaceProcedure = protectedProcedure.use(async ({ ctx, next, path, type, getRawInput }) => {
  const headerVal = ctx.req.headers["x-workspace-id"];
  const headerStr = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  const { workspace, member } = await resolveWorkspace(ctx.user.id, headerStr);

  const refused = await workspaceGateRefusal(workspace, member, ctx.user, path);
  if (refused) throw new TRPCError({ code: "FORBIDDEN", message: refused });

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
  /**
   * Every mutation leaves an audit entry (audit 2026-10-20, G49). A
   * procedure that calls recordAudit flips `auditMark` and keeps its own,
   * richer entry; one that does not gets the automatic entry after it
   * SUCCEEDS: the procedure, the person and the ids in its input, never a
   * string (_core/autoAudit.ts). A refused or failed call records nothing,
   * and a short list of high-frequency, low-value mutations is skipped.
   */
  const auditMark = { recorded: false };
  const result = await mergeRequestContext(
    { workspaceId: workspace.id, userId: ctx.user.id, auditMark },
    () => next({ ctx: { ...ctx, workspace, member } })
  );
  if (type === "mutation" && result.ok && !auditMark.recorded && !autoAuditSkipped(path)) {
    let input: unknown;
    try { input = await getRawInput(); } catch { input = undefined; }
    await writeAutoAudit({ workspaceId: workspace.id, actorUserId: ctx.user.id, path, input });
  }
  return result;
});


/**
 * Ranks a role that the TYPE says is valid. It delegates to `rankOf` anyway,
 * because the type is a claim about the caller and this is a permission
 * boundary: routers/admin.ts decides with it who may assign which role and
 * whom they may act on (`roleRank(input.role) > roleRank(ctx.member.role)`),
 * and indexing the map raw returns undefined for anything unexpected, which
 * makes every one of those comparisons false — i.e. ALLOW.
 */
export function roleRank(role: keyof typeof ROLE_RANK): number {
  return rankOf(role);
}

/**
 * Role helpers. The MAP and the two pure predicates live in @shared/roleRank
 * so the client reaches the same hierarchy; they are re-exported here because
 * ~20 server modules already import them from this file, and because a rank
 * map is a permission boundary that should have exactly one home.
 *
 * requireMinRole stays here: it throws a TRPCError, which is server-only.
 */
export { isAdminRole, rankOf, ROLE_RANK, ROLES, type Role } from "@shared/roleRank";

/** Throw FORBIDDEN unless `role` is at least `min`. `message` names the action. */
export function requireMinRole(role: string, min: keyof typeof ROLE_RANK, message: string): void {
  if (rankOf(role) < ROLE_RANK[min]) {
    throw new TRPCError({ code: "FORBIDDEN", message });
  }
}

function roleAtLeast(min: keyof typeof ROLE_RANK) {
  return workspaceProcedure.use(async ({ ctx, next }) => {
    // rankOf, NOT ROLE_RANK[...]: a role outside the map indexes to undefined,
    // and `undefined < 3` is false, so the raw form waves the request THROUGH
    // — the gate fails open, in the one place every workspace procedure in the
    // app relies on. rankOf ranks the unknown 0, below rep, so it is denied.
    if (rankOf(ctx.member.role) < ROLE_RANK[min]) {
      throw new TRPCError({ code: "FORBIDDEN", message: `Requires ${min} role` });
    }
    return next({ ctx });
  });
}

/**
 * For what one person owns inside a workspace: their mailbox, their calendar,
 * their dashboard. It is theirs and their managers'. Being in the same workspace
 * isn't enough. A null owner is a manager's.
 */
export function assertOwnerOrManager(
  ctx: { user: { id: number }; member: { role: string } },
  ownerUserId: number | null | undefined,
  message: string,
): void {
  if (ownerUserId != null && ownerUserId === ctx.user.id) return;
  if (rankOf(ctx.member.role) >= ROLE_RANK.manager) return;
  throw new TRPCError({ code: "FORBIDDEN", message });
}

/**
 * The one rank rule for acting on another member (audit 2026-10-20, G46): a
 * super_admin may act on anyone; everyone else only on someone below their own
 * rank. Quota, title, permissions and reactivation had no check at all, so an
 * admin could change a fellow admin's, or a super admin's. `allowSelf` is for
 * a change a person may make to their own row.
 */
export function assertOutranks(
  ctx: { user: { id: number }; member: { role: string } },
  target: { userId: number; role: string },
  message: string,
  opts: { allowSelf?: boolean } = {},
): void {
  if (ctx.member.role === "super_admin") return;
  if (opts.allowSelf && target.userId === ctx.user.id) return;
  if (rankOf(target.role) >= rankOf(ctx.member.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message });
  }
}

/**
 * A super admin who can act: not deactivated, invitation accepted. Only these
 * count toward "this workspace still has a super admin" (audit 2026-10-20,
 * G13). The single changeRole, deactivate and delete counted deactivated rows,
 * so the last super admin who could sign in could be removed while a
 * deactivated one "remained".
 */
export function isActiveSuperAdmin(m: { role: string; deactivatedAt?: unknown; inviteToken?: unknown }): boolean {
  return m.role === "super_admin" && !m.deactivatedAt && !m.inviteToken;
}

/**
 * Whether taking these members out of the super_admin seat (by demotion,
 * deactivation or deletion) would leave the workspace with no active super
 * admin. A workspace with none can never be archived, restored, transferred or
 * exported again, and nothing can put one back. Members who don't hold an
 * active seat don't count either way.
 */
export async function leavesNoActiveSuperAdmin(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  workspaceId: number,
  leaving: Array<{ role: string; deactivatedAt?: unknown; inviteToken?: unknown }>,
): Promise<boolean> {
  const vacated = leaving.filter(isActiveSuperAdmin).length;
  if (vacated === 0) return false;
  const [{ superAdminCount }] = await db
    .select({ superAdminCount: count() })
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.role, "super_admin"),
      isNull(workspaceMembers.deactivatedAt),
      isNull(workspaceMembers.inviteToken),
    ));
  return Number(superAdminCount ?? 0) - vacated < 1;
}

export const repProcedure = roleAtLeast("rep");
export const managerProcedure = roleAtLeast("manager");
export const adminWsProcedure = roleAtLeast("admin");
export const superAdminProcedure = roleAtLeast("super_admin");
