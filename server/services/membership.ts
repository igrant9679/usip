/**
 * membership — a workspace that exists because of a membership (owner,
 * 2026-11-26; the contract and every sentence are in shared/membership.ts).
 *
 * THE TWO DOORS
 *   provisionMembership   the membership site sold one: make the workspace
 *                         and its owner (server/membershipApi.ts, signed).
 *   createOwnWorkspace    someone registered in the app and has no workspace:
 *                         make them one on the Trial plan, when that is open.
 *
 * AFTERWARDS (the site only)
 *   updateMembership      the plan changed, or the membership ended or came
 *                         back.
 *   membershipState       what Velocity holds for a membership.
 *   reissueActivation     a fresh first-sign-in link for an owner who has
 *                         not used theirs.
 *
 * ONE SIGN-UP, ONE WORKSPACE. The link row is claimed FIRST, under the unique
 * key (source, externalId), and the workspace is made only by the request
 * that won the claim. A sign-up sent twice, or twice at once, finds the first
 * one's workspace; it never makes a second. A claim whose workspace could not
 * be made is deleted again, so a retry starts clean.
 *
 * WHAT THE SITE CAN REACH. Every function that takes an externalId looks the
 * workspace up through its link row, and only rows the site itself made
 * (source "meyousocial"). A workspace nobody signed up for through the site
 * (the operator's own, a client's) has no such row and cannot be renamed,
 * re-planned or archived from outside, whatever is sent.
 *
 * AN ENDED MEMBERSHIP archives its workspace with the archive that already
 * exists (_core/workspaceArchive): engines skip it, members below super_admin
 * are refused, nothing is deleted. The owner can still open it and read their
 * data but cannot restore it (admin.unarchiveWorkspace asks membershipEnded);
 * an active membership restores it.
 */
import crypto from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { membershipLinks, users, workspaceMembers, workspaces } from "../../drizzle/schema";
import { getDb } from "../db";
import { affectedRowsOf } from "../_core/claim";
import { insertIdOf } from "../_core/insertId";
import { invalidateArchivedWorkspaceCache } from "../_core/workspaceArchive";
import { recordAudit } from "../audit";
import { appUrl } from "../appUrl";
import {
  ACTIVATION_LINK_DAYS, SELF_SERVE_BLOCK_MESSAGE, SELF_SERVE_PLAN, SITE_SOURCE, defaultWorkspaceName,
  selfServeBlock, selfServeMode,
  type MembershipSource, type MembershipStatus, type ProvisionInput, type SelfServeBlock, type UpdateInput,
} from "@shared/membership";
import type { MembershipPlan } from "@shared/prospectAllowance";
import { createWorkspace } from "./workspaceCreation";
import { allowanceFor, membershipPlanOf, setMembershipPlan } from "./prospectAllowance";
import { isEmailVerificationPending } from "./accountEmailVerification";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** A failure the caller should say, with the HTTP status that fits it. */
export class MembershipError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "MembershipError";
  }
}

export type MembershipView = {
  externalId: string;
  workspaceId: number;
  workspaceName: string;
  plan: MembershipPlan | null;
  status: MembershipStatus;
  /** True while the owner has not yet set a password: they still need the activation link. */
  activationPending: boolean;
  /** The owner's first-sign-in link while activationPending and the link is live; null otherwise. */
  activationUrl: string | null;
  signInUrl: string;
};

export type ProvisionResult = MembershipView & {
  /** False when this membership had its workspace already and nothing was made. */
  created: boolean;
  /** Whether the email belonged to a Velocity account already. */
  account: "new" | "existing";
};

const PENDING_METHODS = ["invite", "expired_invite"];

/** Someone who has never signed in: no password, and still marked as invited. */
function isPlaceholder(u: { passwordHash: string | null; loginMethod: string | null }): boolean {
  return !u.passwordHash && PENDING_METHODS.includes(u.loginMethod ?? "");
}

function activationUrlFor(token: string): string {
  return appUrl(`/invite/accept?token=${token}`);
}

function newInvite(): { token: string; expiresAt: Date } {
  return { token: crypto.randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + ACTIVATION_LINK_DAYS * 86_400_000) };
}

async function requireDb(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new MembershipError(503, "unavailable", "The database is unavailable. Try again shortly.");
  return db;
}

async function linkOf(db: Db, source: MembershipSource, externalId: string) {
  const [row] = await db
    .select()
    .from(membershipLinks)
    .where(and(eq(membershipLinks.source, source), eq(membershipLinks.externalId, externalId)))
    .limit(1);
  return row ?? null;
}

/** The link of a membership the site made, with its workspace: 404 when there is none, 409 while it is still being made. */
async function siteLink(db: Db, externalId: string) {
  const link = await linkOf(db, SITE_SOURCE, externalId);
  if (!link) throw new MembershipError(404, "not_found", "No workspace was made for this membership. Provision it first.");
  if (!link.workspaceId) throw new MembershipError(409, "in_progress", "This membership's workspace is still being made. Try again in a few seconds.");
  return link;
}

/** What Velocity holds for a link, as the site reads it. A plan that cannot be read is said as null, never guessed. */
async function viewOf(db: Db, link: { externalId: string; workspaceId: number; userId: number; status: string }): Promise<MembershipView> {
  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, link.workspaceId)).limit(1);
  const [member] = await db
    .select({ inviteToken: workspaceMembers.inviteToken, inviteExpiresAt: workspaceMembers.inviteExpiresAt })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, link.workspaceId), eq(workspaceMembers.userId, link.userId)))
    .limit(1);
  let plan: MembershipPlan | null = null;
  try {
    plan = await membershipPlanOf(link.workspaceId);
  } catch (e) {
    console.error(`[membership] plan unreadable for workspace ${link.workspaceId}:`, e instanceof Error ? e.message : e);
  }
  const token = member?.inviteToken ?? null;
  const live = !!token && (!member?.inviteExpiresAt || member.inviteExpiresAt.getTime() > Date.now());
  return {
    externalId: link.externalId,
    workspaceId: link.workspaceId,
    workspaceName: ws?.name ?? "",
    plan,
    status: link.status === "ended" ? "ended" : "active",
    activationPending: !!token,
    activationUrl: live && token ? activationUrlFor(token) : null,
    signInUrl: appUrl("/"),
  };
}

/**
 * The account an email belongs to: a real one when there is one, else a
 * placeholder someone's invitation made, else none. Email is not unique on
 * users, so a real account is preferred over a placeholder of the same address.
 */
async function accountFor(db: Db, email: string) {
  const rows = await db
    .select({ id: users.id, passwordHash: users.passwordHash, loginMethod: users.loginMethod, name: users.name })
    .from(users)
    .where(eq(users.email, email));
  rows.sort((a, b) => a.id - b.id);
  return rows.find((u) => !isPlaceholder(u)) ?? rows[0] ?? null;
}

/** Take the link row for this membership. True when this call made it; false when it was there already. */
async function claimLink(db: Db, source: MembershipSource, externalId: string, userId: number, email: string): Promise<boolean> {
  try {
    await db.insert(membershipLinks).values({ source, externalId, workspaceId: 0, userId, email, status: "active" });
    return true;
  } catch (e) {
    // The unique key refused it: another request has this membership.
    if (await linkOf(db, source, externalId)) return false;
    throw e;
  }
}

async function releaseClaim(db: Db, source: MembershipSource, externalId: string): Promise<void> {
  await db
    .delete(membershipLinks)
    .where(and(eq(membershipLinks.source, source), eq(membershipLinks.externalId, externalId), eq(membershipLinks.workspaceId, 0)));
}

/**
 * Make the workspace a claimed link is for, put it on its plan and point the
 * link at it. All three or none: a workspace with no plan is unmetered, so one
 * that was made but could not be finished is closed to everyone (its member
 * row removed, the workspace archived) before the claim is given back.
 */
async function makeLinkedWorkspace(
  db: Db,
  source: MembershipSource,
  externalId: string,
  plan: MembershipPlan,
  make: Parameters<typeof createWorkspace>[1],
): Promise<{ id: number; name: string }> {
  let made = 0;
  try {
    const workspace = await createWorkspace(db, make);
    made = workspace.id;
    await setMembershipPlan(workspace.id, plan);
    await db
      .update(membershipLinks)
      .set({ workspaceId: workspace.id })
      .where(and(eq(membershipLinks.source, source), eq(membershipLinks.externalId, externalId)));
    return workspace;
  } catch (e) {
    console.error(`[${make.logTag}] failed${made ? ` after making workspace ${made}` : ""}:`, e instanceof Error ? e.message : e);
    if (made) {
      try {
        await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, made));
        await db.update(workspaces).set({ archivedAt: new Date() }).where(eq(workspaces.id, made));
        invalidateArchivedWorkspaceCache();
      } catch (closeErr) {
        console.error(`[${make.logTag}] could not close half-made workspace ${made}:`, closeErr instanceof Error ? closeErr.message : closeErr);
      }
    }
    await releaseClaim(db, source, externalId).catch(() => {});
    throw e;
  }
}

/**
 * The membership site sold a membership: make its workspace and its owner.
 * Sent again for the same externalId it changes nothing and answers with what
 * is there (`created: false`); a plan change goes through updateMembership.
 */
export async function provisionMembership(input: ProvisionInput): Promise<ProvisionResult> {
  const db = await requireDb();

  const found = await linkOf(db, SITE_SOURCE, input.externalId);
  if (found) {
    if (!found.workspaceId) throw new MembershipError(409, "in_progress", "This membership's workspace is still being made. Try again in a few seconds.");
    return { ...(await viewOf(db, found)), created: false, account: "existing" };
  }

  // The owner: their own account when the address has one, else a placeholder
  // that their activation link turns into an account (team.invite's shape).
  let account = await accountFor(db, input.email);
  const isNewAccount = !account;
  if (!account) {
    try {
      const r = await db.insert(users).values({
        openId: `invite:${input.email}`,
        name: input.name ?? input.email.split("@")[0],
        email: input.email,
        loginMethod: "invite",
      });
      account = { id: insertIdOf(r), passwordHash: null, loginMethod: "invite", name: input.name };
    } catch (e) {
      // Two sign-ups for one new address at once: the other made the row.
      account = await accountFor(db, input.email);
      if (!account) throw e;
    }
  }
  const userId = account.id;

  if (!(await claimLink(db, SITE_SOURCE, input.externalId, userId, input.email))) {
    const other = await linkOf(db, SITE_SOURCE, input.externalId);
    if (!other?.workspaceId) throw new MembershipError(409, "in_progress", "This membership's workspace is still being made. Try again in a few seconds.");
    return { ...(await viewOf(db, other)), created: false, account: "existing" };
  }

  const pending = isPlaceholder(account);
  const invite = pending ? newInvite() : null;
  let workspace: { id: number; name: string };
  try {
    workspace = await makeLinkedWorkspace(db, SITE_SOURCE, input.externalId, input.plan, {
      name: input.workspaceName ?? defaultWorkspaceName(input.name, input.email),
      owner: { userId, title: "Owner", invite },
      logTag: "membership.provision",
    });
  } catch {
    throw new MembershipError(500, "failed", "The workspace could not be made. Nothing was left open; send the sign-up again.");
  }
  // A lapsed invitation elsewhere left this placeholder marked expired; it has a live link again.
  if (pending && account.loginMethod === "expired_invite") {
    await db.update(users).set({ loginMethod: "invite" }).where(eq(users.id, userId));
  }

  await recordAudit({
    workspaceId: workspace.id,
    actorUserId: null,
    action: "create",
    entityType: "workspace",
    entityId: workspace.id,
    after: { via: "membership_site", externalId: input.externalId, plan: input.plan, ownerUserId: userId },
  });

  return {
    externalId: input.externalId,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    plan: input.plan,
    status: "active",
    activationPending: pending,
    activationUrl: invite ? activationUrlFor(invite.token) : null,
    signInUrl: appUrl("/"),
    created: true,
    account: isNewAccount ? "new" : "existing",
  };
}

/** The plan changed, or the membership ended or came back. Changes only what was sent. */
export async function updateMembership(input: UpdateInput): Promise<MembershipView & { previous: { plan: string | null; status: MembershipStatus } }> {
  const db = await requireDb();
  const link = await siteLink(db, input.externalId);
  const before: { plan: string | null; status: MembershipStatus } = { plan: null, status: link.status === "ended" ? "ended" : "active" };

  if (input.plan) {
    const r = await setMembershipPlan(link.workspaceId, input.plan);
    before.plan = r.previous;
  } else {
    before.plan = await membershipPlanOf(link.workspaceId).catch(() => null);
  }

  if (input.status && input.status !== before.status) {
    if (input.status === "ended") {
      // Archive only a live workspace, so one its owner archived keeps its own date.
      await db.update(workspaces).set({ archivedAt: new Date() }).where(and(eq(workspaces.id, link.workspaceId), isNull(workspaces.archivedAt)));
      await db.update(membershipLinks).set({ status: "ended", endedAt: new Date() }).where(eq(membershipLinks.id, link.id));
    } else {
      await db.update(workspaces).set({ archivedAt: null }).where(eq(workspaces.id, link.workspaceId));
      await db.update(membershipLinks).set({ status: "active", endedAt: null }).where(eq(membershipLinks.id, link.id));
    }
    invalidateArchivedWorkspaceCache();
  }

  const after = await viewOf(db, { ...link, status: input.status ?? link.status });
  if (after.plan !== before.plan || after.status !== before.status) {
    await recordAudit({
      workspaceId: link.workspaceId,
      actorUserId: null,
      action: "update",
      entityType: "workspace",
      entityId: link.workspaceId,
      before,
      after: { via: "membership_site", externalId: input.externalId, plan: after.plan, status: after.status },
    });
  }
  return { ...after, previous: before };
}

/** What Velocity holds for a membership, with this month's prospect-data use. */
export async function membershipState(externalId: string): Promise<MembershipView & { usage: { used: number; limit: number; resetsOn: string } | null }> {
  const db = await requireDb();
  const link = await siteLink(db, externalId);
  const view = await viewOf(db, link);
  let usage: { used: number; limit: number; resetsOn: string } | null = null;
  try {
    const a = await allowanceFor(link.workspaceId);
    if (a.plan) usage = { used: a.used, limit: a.limit, resetsOn: a.resetsOn };
  } catch {
    // Unreadable is said as null, never as zero used.
  }
  return { ...view, usage };
}

/**
 * A fresh first-sign-in link for an owner who has not used theirs (it lapsed,
 * or the email was lost). The old link stops working. An owner who has
 * already set a password gets no link: they sign in, or use Forgot password.
 */
export async function reissueActivation(externalId: string): Promise<MembershipView> {
  const db = await requireDb();
  const link = await siteLink(db, externalId);
  const invite = newInvite();
  // Only a membership still waiting is given a new token: the token column is
  // what "not accepted yet" means, so it must never be set on an accepted one.
  const res = await db
    .update(workspaceMembers)
    .set({ inviteToken: invite.token, inviteExpiresAt: invite.expiresAt })
    .where(and(
      eq(workspaceMembers.workspaceId, link.workspaceId),
      eq(workspaceMembers.userId, link.userId),
      isNotNull(workspaceMembers.inviteToken),
    ));
  if (affectedRowsOf(res) > 0) {
    await db.update(users).set({ loginMethod: "invite" }).where(and(eq(users.id, link.userId), eq(users.loginMethod, "expired_invite")));
  }
  return viewOf(db, link);
}

/** True when this workspace's membership is over, so only a renewal (or the platform owner) restores it. */
export async function membershipEnded(workspaceId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select({ status: membershipLinks.status }).from(membershipLinks).where(eq(membershipLinks.workspaceId, workspaceId));
  return rows.length > 0 && rows.every((r) => r.status === "ended");
}

/**
 * True when this workspace was made for this person by a membership bought on
 * the site: it is their own workspace, and the link to it went to their
 * address. passwordAuth.claimableInvite asks, so that link still works when
 * other invitations are waiting on the same address. A failed read is "no":
 * the stricter rule applies.
 */
export async function isSiteMembership(workspaceId: number, userId: number): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    const [row] = await db
      .select({ id: membershipLinks.id })
      .from(membershipLinks)
      .where(and(eq(membershipLinks.source, SITE_SOURCE), eq(membershipLinks.workspaceId, workspaceId), eq(membershipLinks.userId, userId)))
      .limit(1);
    return !!row;
  } catch (e) {
    console.error("[membership] isSiteMembership failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

/** Whether the app would make this person a workspace right now, and why not when it would not. */
export async function selfServeStateFor(user: { id: number; emailVerifiedAt?: unknown; emailVerifyTokenHash?: unknown }): Promise<{ open: boolean; block: SelfServeBlock | null }> {
  const db = await requireDb();
  const mine = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    // An accepted membership, deactivated or not, as ensureUserHasWorkspace
    // reads it: offboarding must not turn into a new workspace.
    .where(and(eq(workspaceMembers.userId, user.id), isNull(workspaceMembers.inviteToken)))
    .limit(1);
  const block = selfServeBlock({
    mode: selfServeMode(process.env),
    hasWorkspace: mine.length > 0,
    emailConfirmed: !isEmailVerificationPending(user),
  });
  return { open: block === null, block };
}

/**
 * The app's own door: someone registered here, confirmed their address and
 * has no workspace. Makes them one on the Trial plan. One per account: the
 * link row (source "app", the account's id) is the claim.
 */
export async function createOwnWorkspace(
  user: { id: number; email: string | null; name: string | null; emailVerifiedAt?: unknown; emailVerifyTokenHash?: unknown },
  name: string,
): Promise<{ id: number; name: string }> {
  const db = await requireDb();
  const { block } = await selfServeStateFor(user);
  if (block) throw new MembershipError(403, block, SELF_SERVE_BLOCK_MESSAGE[block]);

  const externalId = `user-${user.id}`;
  if (!(await claimLink(db, "app", externalId, user.id, user.email ?? ""))) {
    throw new MembershipError(409, "has_workspace", SELF_SERVE_BLOCK_MESSAGE.has_workspace);
  }
  let workspace: { id: number; name: string };
  try {
    workspace = await makeLinkedWorkspace(db, "app", externalId, SELF_SERVE_PLAN, {
      name,
      owner: { userId: user.id, title: "Owner" },
      logTag: "membership.selfServe",
    });
  } catch {
    throw new MembershipError(500, "failed", "The workspace could not be made. Nothing was left open; try again.");
  }
  await recordAudit({
    workspaceId: workspace.id,
    actorUserId: user.id,
    action: "create",
    entityType: "workspace",
    entityId: workspace.id,
    after: { via: "app_sign_up", plan: SELF_SERVE_PLAN },
  });
  return workspace;
}
