/**
 * Who may change a person's ACCOUNT from inside one workspace.
 *
 * 🔴 THE HOLE (audit 2026-10-20, C1). A `users` row is shared by every
 * workspace the person belongs to; a `workspace_members` row is not. Four
 * admin procedures — setMemberPassword, resetMemberMfa, and updateMember's
 * name and email — wrote the shared row, and the only check was "this person
 * is a member of MY workspace". `team.invite` made anyone a member instantly,
 * by email, with no consent. And public sign-up hands every new user an admin
 * workspace of their own. So: sign up, invite the victim's email, set their
 * password (or change their email and reset it), sign in as them.
 *
 * The rule: an admin may edit the account only when this workspace is the
 * ONLY place the account lives, and the person has accepted the invitation
 * that brought them here. Anywhere else the account belongs to the person, and
 * the admin's tool is a reset link to the person's own inbox
 * (`team.sendPasswordReset`).
 *
 * Every membership row counts, deactivated ones included: a deactivated
 * membership elsewhere is still someone else's claim on the account, and
 * "they left that workspace" is not this workspace's call to make.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { workspaceMembers } from "../../drizzle/schema";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export async function accountLivesOnlyHere(db: Db, workspaceId: number, userId: number): Promise<boolean> {
  const rows = await db
    .select({ workspaceId: workspaceMembers.workspaceId, inviteToken: workspaceMembers.inviteToken })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  if (rows.length !== 1) return false;
  const [only] = rows;
  return Number(only.workspaceId) === Number(workspaceId) && only.inviteToken == null;
}

/** Throws FORBIDDEN, naming the alternative, unless `accountLivesOnlyHere`. */
export async function assertAccountEditableHere(db: Db, workspaceId: number, userId: number, what: string): Promise<void> {
  if (await accountLivesOnlyHere(db, workspaceId, userId)) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message:
      `You can't change this person's ${what} from here: their account also belongs to another workspace, ` +
      `or they haven't accepted their invitation yet. Send them a password reset link instead — it goes to their own inbox.`,
  });
}
