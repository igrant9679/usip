/**
 * "Is this user still a member of this workspace?" — for the paths that name a
 * user id WITHOUT a request context.
 *
 * 🔴 THE GAP THIS CLOSES. `3366f4b` found that deactivation revoked a leaver's
 * WORK but not their ACCESS, and fixed it in `resolveWorkspace` — the one
 * choke point every authenticated request passes through. That gate is inbound
 * only. It says nothing about the paths where the product acts *as* a member
 * without that member being present:
 *
 *   · a public booking page                    (/b/:slug)
 *   · an inbound chat agent offering slots     (/c/:slug)
 *   · a public form / landing-page submission  (/l/:slug)
 *   · a lead-routing rule's stored target list
 *   · `{{bookingLink}}` rendered into outbound mail
 *   · the autopilot's "pick a workspace owner"
 *
 * Each of those resolves a userId from a row written months earlier
 * (`booking_links.userId`, `forms.createdByUserId`,
 * `lead_routing_rules.targetUserIds`, …) and none of them re-checked that the
 * user is still there. Offboarding a rep stopped them signing in; it did not
 * stop the product from booking meetings in their name, routing inbound leads
 * to them, or emailing prospects a link to their calendar.
 *
 * ⚖️ FAIL CLOSED. With no database these answer "not active". The caller's
 * choice is then between refusing (a booking page 404s) and acting on an
 * unverified id (a stranger books a meeting nobody will attend) — and the
 * first is the recoverable one. Every caller already treats a null db as fatal
 * or best-effort, so this costs nothing in the healthy path.
 *
 * A deleted member has NO membership row at all, so the same `isNull(
 * deactivatedAt)` predicate covers both offboarding routes — `team.deactivate`
 * (row survives, stamped) and `team.delete` (row is gone).
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { workspaceMembers, workspaces } from "../../drizzle/schema";
import { getDb } from "../db";
import { rankOf } from "./workspace";

/**
 * Of `userIds`, those still holding an ACTIVE membership of `workspaceId`.
 * Returns a Set so callers can filter a list in one pass.
 */
export async function activeMemberIds(
  workspaceId: number,
  userIds: Array<number | null | undefined>,
): Promise<Set<number>> {
  // Deduped without spreading a Set: this repo's tsconfig targets below ES2015,
  // where `[...someSet]` is a TS2802 error (there are ~dozens already).
  const wanted = userIds.filter(
    (u, i, all): u is number =>
      typeof u === "number" && Number.isFinite(u) && all.indexOf(u) === i,
  );
  if (wanted.length === 0) return new Set();
  const db = await getDb();
  if (!db) return new Set();
  try {
    const rows = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          inArray(workspaceMembers.userId, wanted),
          isNull(workspaceMembers.deactivatedAt),
        ),
      );
    return new Set(rows.map((r) => r.userId));
  } catch (e) {
    console.error("[activeMembers] lookup failed:", (e as Error).message);
    return new Set();
  }
}

/** True only if `userId` is a current, non-deactivated member of `workspaceId`. */
export async function isActiveMember(
  workspaceId: number,
  userId: number | null | undefined,
): Promise<boolean> {
  if (typeof userId !== "number" || !Number.isFinite(userId)) return false;
  return (await activeMemberIds(workspaceId, [userId])).has(userId);
}

/**
 * `userId` if they are still an active member, otherwise null.
 *
 * The null is the point: an UNOWNED lead is visible to the whole workspace and
 * can be claimed. A lead owned by someone who left is filed under a person who
 * will never open it, and looks handled.
 */
export async function activeOwnerOrNull(
  workspaceId: number,
  userId: number | null | undefined,
): Promise<number | null> {
  return (await isActiveMember(workspaceId, userId)) ? (userId as number) : null;
}

/**
 * Who to address an UNATTENDED notification to — "the workspace owner", but
 * resolved to somebody who will actually read it.
 *
 * 🔴 `workspaces.ownerUserId` is the standing recipient for every notification
 * an autonomous engine produces: all six `areNotify` event types, and the five
 * places in the proposal-followup cron that raise a task or an alert with no
 * user present. It was read raw, in six near-identical inline lookups, none of
 * which checked the owner still works here.
 *
 * Nothing prevents that column dangling. `team.delete`'s sole-super_admin guard
 * protects the ROLE, not the OWNER column — with a second super_admin present
 * the owner can be deleted outright, and `transferOwnership` is the only thing
 * that ever rewrites it. Deactivation doesn't touch it either. So the whole
 * autonomous reporting channel could point at a user id that cannot sign in,
 * and every "campaign completed" / "proposal expiring" notice landed nowhere.
 *
 * ORDER MATTERS: the real owner first, and only then a stand-in. Falling
 * straight to "highest-ranked member" would silently redirect notifications
 * away from an owner who is present but simply outranked by nobody — the
 * fallback exists to repair a broken workspace, not to second-guess a healthy
 * one. Returns null when the workspace has no active members at all; callers
 * skip rather than write a notification to nobody.
 *
 * `team.delete` now refuses to remove the owner, so new workspaces cannot
 * enter this state. This heals the ones already in it.
 */
export async function workspaceNotifyUserId(workspaceId: number): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const [ws] = await db
      .select({ ownerUserId: workspaces.ownerUserId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (ws && (await isActiveMember(workspaceId, ws.ownerUserId))) return ws.ownerUserId;

    const members = await db
      .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), isNull(workspaceMembers.deactivatedAt)));
    if (members.length === 0) return null;
    members.sort((a, b) => rankOf(b.role) - rankOf(a.role));
    return members[0]?.userId ?? null;
  } catch (e) {
    console.error("[activeMembers] workspaceNotifyUserId failed:", (e as Error).message);
    return null;
  }
}
