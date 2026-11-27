/**
 * workspaceCreation — making a `workspaces` row and everything a workspace
 * needs to be usable the moment it exists.
 *
 * This was the body of workspace.create (the operator's "New workspace"). It
 * moved here on 2026-11-26 when two more callers arrived, a membership bought
 * on the website and the app's own sign-up (services/membership.ts), so the
 * three make a workspace the same way instead of each keeping a copy.
 *
 * What every new workspace gets:
 *   · a unique slug (the name, plus entropy, retried on a collision);
 *   · its owner as a super_admin member, or the owner's pending invitation
 *     when they have never signed in (`owner.invite`);
 *   · its workspace_settings row, up front: several setters make it lazily
 *     but not all do, and a missing row makes a save look like it worked;
 *   · the Help Center content, always. Demo data only when asked for: a
 *     client workspace full of invented accounts is worse than an empty one.
 */
import { slugify } from "@shared/slugify";
import { workspaceMembers, workspaceSettings, workspaces } from "../../drizzle/schema";
import { insertIdOf } from "../_core/insertId";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type NewWorkspace = {
  name: string;
  owner: {
    userId: number;
    title: string;
    /** Set for an owner who has never signed in: their membership waits on this token. */
    invite?: { token: string; expiresAt: Date | null } | null;
  };
  seedDemoData?: boolean;
  /** Names the caller in the log lines ("workspace.create", "membership.provision"). */
  logTag: string;
};

export class WorkspaceCreationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCreationError";
  }
}

export async function createWorkspace(db: Db, input: NewWorkspace): Promise<{ id: number; slug: string; name: string }> {
  // slug is UNIQUE: derive from the name, then add entropy. Retry rather than
  // trusting one draw, so two workspaces named the same never collide.
  const base = slugify(input.name, 40) || "workspace"; // workspace slugs cap at 40
  let workspaceId = 0;
  let slug = "";
  for (let attempt = 0; attempt < 5 && !workspaceId; attempt++) {
    slug = `${base}-${Math.random().toString(36).slice(2, 7)}`.slice(0, 64);
    try {
      const r = await db.insert(workspaces).values({
        name: input.name,
        slug,
        ownerUserId: input.owner.userId,
        plan: "trial",
      });
      workspaceId = insertIdOf(r);
    } catch (e) {
      if (attempt === 4) {
        console.error(`[${input.logTag}] insert failed:`, (e as Error).message);
        throw new WorkspaceCreationError("Could not create the workspace.");
      }
    }
  }
  if (!workspaceId) throw new WorkspaceCreationError("Could not create the workspace.");

  // The owner must be a member, or they cannot open what was just made.
  await db.insert(workspaceMembers).values({
    workspaceId,
    userId: input.owner.userId,
    role: "super_admin",
    title: input.owner.title,
    ...(input.owner.invite ? { inviteToken: input.owner.invite.token, inviteExpiresAt: input.owner.invite.expiresAt } : {}),
  });

  try {
    await db.insert(workspaceSettings).values({ workspaceId });
  } catch (e) {
    console.error(`[${input.logTag}] settings row failed:`, (e as Error).message);
  }

  try {
    if (input.seedDemoData) {
      const { seedWorkspace } = await import("../seed");
      await seedWorkspace(workspaceId, input.owner.userId);
    } else {
      const { seedHelpContent } = await import("../seedHelpContent");
      await seedHelpContent(db as never, workspaceId);
    }
  } catch (e) {
    // The workspace exists and is usable; content seeding is not worth
    // failing the whole creation over.
    console.error(`[${input.logTag}] seeding failed:`, (e as Error).message);
  }

  return { id: workspaceId, slug, name: input.name };
}
