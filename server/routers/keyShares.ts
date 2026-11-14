/**
 * keyShares.ts — an admin lends a workspace's keys to other workspaces
 * (owner ask 2026-11-13: "give admins (only Admins) the ability to share API
 * keys and tokens ... with other Spaces"). The link itself, and why it is a
 * link and not a copy, is services/keyShares.
 *
 * Who may do what:
 *   - Everything here is admin-or-above in the ACTIVE workspace and needs the
 *     `manage_api_keys` permission, the same gate as entering a key.
 *   - Lending (`share`) also needs the caller to be an active admin-or-above
 *     of the workspace that will borrow. A share changes which vendor account
 *     the borrower's data goes through, so nobody decides that for a
 *     workspace they do not administer.
 *   - Taking a key back (`unshare`) needs only the lender's admin: it is
 *     their key. Giving one up (`stopUsing`) needs only the borrower's admin.
 *
 * Nothing here returns a key, masked or not.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { workspaceKeyShares, workspaceMembers, workspaces } from "../../drizzle/schema";
import { ROLE_RANK, rankOf } from "@shared/roleRank";
import { recordAudit } from "../audit";
import { checkPermission, getDb, hasPermission } from "../db";
import { router } from "../_core/trpc";
import { adminWsProcedure } from "../_core/workspace";
import { SHARE_KINDS, SHARE_KIND_LABEL, borrowedKeys, ownKeyKinds, type ShareKind } from "../services/keyShares";

const kindEnum = z.enum(SHARE_KINDS);

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/** The other live workspaces this user is an active admin-or-above of. */
async function adminWorkspacesOf(userId: number, exceptWorkspaceId: number): Promise<Array<{ id: number; name: string }>> {
  const db = await requireDb();
  const memberships = await db
    .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deactivatedAt), isNull(workspaceMembers.inviteToken)));
  const ids = memberships.filter((m) => m.workspaceId !== exceptWorkspaceId && rankOf(m.role) >= ROLE_RANK.admin).map((m) => m.workspaceId);
  if (ids.length === 0) return [];
  const rows = await db.select({ id: workspaces.id, name: workspaces.name, archivedAt: workspaces.archivedAt }).from(workspaces).where(inArray(workspaces.id, ids));
  return rows.filter((w) => !w.archivedAt).map((w) => ({ id: w.id, name: w.name })).sort((a, b) => a.name.localeCompare(b.name));
}

export const keySharesRouter = router({
  /**
   * What this workspace can lend, to whom, what it already lends and what it
   * borrows. Names and booleans only.
   */
  overview: adminWsProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    const [own, borrowed, candidates, lentRows] = await Promise.all([
      ownKeyKinds(ctx.workspace.id),
      borrowedKeys(ctx.workspace.id),
      adminWorkspacesOf(ctx.user.id, ctx.workspace.id),
      db.select({ target: workspaceKeyShares.targetWorkspaceId, kind: workspaceKeyShares.keyKind }).from(workspaceKeyShares).where(eq(workspaceKeyShares.ownerWorkspaceId, ctx.workspace.id)),
    ]);
    // A borrower this admin does not administer is still named: they lent it.
    const targetIds = Array.from(new Set(lentRows.map((r) => r.target)));
    const names = new Map(candidates.map((w) => [w.id, w.name]));
    const unnamed = targetIds.filter((id) => !names.has(id));
    if (unnamed.length > 0) {
      for (const w of await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(inArray(workspaces.id, unnamed))) names.set(w.id, w.name);
    }
    return {
      canManage: await hasPermission(ctx, "manage_api_keys"),
      workspaces: candidates,
      keys: SHARE_KINDS.map((kind) => ({
        kind,
        label: SHARE_KIND_LABEL[kind],
        hasOwnKey: own.has(kind),
        sharedWith: lentRows.filter((r) => r.kind === kind).map((r) => ({ workspaceId: r.target, name: names.get(r.target) ?? "A workspace" })),
        borrowedFrom: (() => {
          const b = borrowed.find((x) => x.kind === kind);
          return b ? { workspaceId: b.ownerWorkspaceId, name: b.ownerName, usable: b.usable } : null;
        })(),
      })),
    };
  }),

  /** Lend this workspace's key of one kind to another workspace. */
  share: adminWsProcedure
    .input(z.object({ kind: kindEnum, targetWorkspaceId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await checkPermission(ctx, "manage_api_keys");
      if (input.targetWorkspaceId === ctx.workspace.id) throw new TRPCError({ code: "BAD_REQUEST", message: "A workspace cannot share a key with itself." });
      const target = (await adminWorkspacesOf(ctx.user.id, ctx.workspace.id)).find((w) => w.id === input.targetWorkspaceId);
      if (!target) throw new TRPCError({ code: "FORBIDDEN", message: "You can share a key only with a workspace you are an admin of." });
      const kind: ShareKind = input.kind;
      if (!(await ownKeyKinds(ctx.workspace.id)).has(kind)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `This workspace has no ${SHARE_KIND_LABEL[kind]} key of its own to share. A key it borrows cannot be passed on.` });
      }
      const db = await requireDb();
      const [existing] = await db
        .select({ id: workspaceKeyShares.id, owner: workspaceKeyShares.ownerWorkspaceId })
        .from(workspaceKeyShares)
        .where(and(eq(workspaceKeyShares.targetWorkspaceId, input.targetWorkspaceId), eq(workspaceKeyShares.keyKind, kind)))
        .limit(1);
      if (existing && existing.owner === ctx.workspace.id) return { ok: true as const, already: true };
      if (existing) {
        throw new TRPCError({ code: "CONFLICT", message: `${target.name} already uses another workspace's ${SHARE_KIND_LABEL[kind]} key. Stop that share first.` });
      }
      await db.insert(workspaceKeyShares).values({ ownerWorkspaceId: ctx.workspace.id, targetWorkspaceId: input.targetWorkspaceId, keyKind: kind, createdByUserId: ctx.user.id });
      // Both logs say it: the lender's, whose account now pays for another
      // workspace, and the borrower's, whose calls now go through it. (Writing
      // one row by hand switches the automatic one off, so both are explicit.)
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "key_share", entityId: input.targetWorkspaceId, after: { kind, sharedWithWorkspaceId: input.targetWorkspaceId, sharedWith: target.name } });
      await recordAudit({ workspaceId: input.targetWorkspaceId, actorUserId: ctx.user.id, action: "update", entityType: "key_share", entityId: ctx.workspace.id, after: { kind, sharedFromWorkspaceId: ctx.workspace.id, sharedFrom: ctx.workspace.name } });
      return { ok: true as const, already: false };
    }),

  /** Take back a key this workspace lends. */
  unshare: adminWsProcedure
    .input(z.object({ kind: kindEnum, targetWorkspaceId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await checkPermission(ctx, "manage_api_keys");
      const db = await requireDb();
      const [existing] = await db.select({ id: workspaceKeyShares.id }).from(workspaceKeyShares)
        .where(and(eq(workspaceKeyShares.ownerWorkspaceId, ctx.workspace.id), eq(workspaceKeyShares.targetWorkspaceId, input.targetWorkspaceId), eq(workspaceKeyShares.keyKind, input.kind))).limit(1);
      if (!existing) return { ok: true as const, removed: false };
      await db.delete(workspaceKeyShares)
        .where(and(eq(workspaceKeyShares.ownerWorkspaceId, ctx.workspace.id), eq(workspaceKeyShares.targetWorkspaceId, input.targetWorkspaceId), eq(workspaceKeyShares.keyKind, input.kind)));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "key_share", entityId: input.targetWorkspaceId, after: { kind: input.kind, sharedWithWorkspaceId: input.targetWorkspaceId, stopped: true } });
      await recordAudit({ workspaceId: input.targetWorkspaceId, actorUserId: ctx.user.id, action: "update", entityType: "key_share", entityId: ctx.workspace.id, after: { kind: input.kind, sharedFromWorkspaceId: ctx.workspace.id, stopped: true } });
      return { ok: true as const, removed: true };
    }),

  /** Stop using a key another workspace lends this one. */
  stopUsing: adminWsProcedure
    .input(z.object({ kind: kindEnum }))
    .mutation(async ({ ctx, input }) => {
      await checkPermission(ctx, "manage_api_keys");
      const db = await requireDb();
      const [existing] = await db.select({ id: workspaceKeyShares.id, owner: workspaceKeyShares.ownerWorkspaceId }).from(workspaceKeyShares)
        .where(and(eq(workspaceKeyShares.targetWorkspaceId, ctx.workspace.id), eq(workspaceKeyShares.keyKind, input.kind))).limit(1);
      if (!existing) return { ok: true as const, removed: false };
      await db.delete(workspaceKeyShares)
        .where(and(eq(workspaceKeyShares.targetWorkspaceId, ctx.workspace.id), eq(workspaceKeyShares.keyKind, input.kind)));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "key_share", entityId: existing.owner, after: { kind: input.kind, sharedFromWorkspaceId: existing.owner, stoppedByBorrower: true } });
      await recordAudit({ workspaceId: existing.owner, actorUserId: ctx.user.id, action: "update", entityType: "key_share", entityId: ctx.workspace.id, after: { kind: input.kind, borrowerWorkspaceId: ctx.workspace.id, stoppedByBorrower: true } });
      return { ok: true as const, removed: true };
    }),
});
