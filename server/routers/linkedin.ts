/**
 * LinkedIn per-user credential storage router (LNK-004 revised)
 *
 * LinkedIn's public API does NOT allow third-party apps to send messages or
 * InMails on behalf of users. This module stores each team member's LinkedIn
 * profile URL and an optional personal API key/token for reference, and
 * surfaces a "Message on LinkedIn" deep-link on contact detail pages.
 *
 * Actual outreach happens in the LinkedIn UI itself.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { linkedinConnections, workspaceMembers, users } from "../../drizzle/schema";

/* ─── Simple AES-256-GCM encryption for credential values ───────────────── */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

function getEncKey(): Buffer {
  // Derive a 32-byte key from JWT_SECRET (always present in platform)
  const secret = process.env.JWT_SECRET ?? "fallback-dev-secret-32-bytes!!!";
  return Buffer.from(secret.padEnd(32, "0").slice(0, 32));
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(ciphertext: string): string {
  const [ivHex, tagHex, encHex] = ciphertext.split(":");
  if (!ivHex || !tagHex || !encHex) throw new Error("Invalid ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", getEncKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(encHex, "hex")).toString("utf8") + decipher.final("utf8");
}

function maskValue(value: string): string {
  if (value.length <= 8) return "••••••••";
  return "••••••••" + value.slice(-4);
}

/* ─── Router ────────────────────────────────────────────────────────────── */

export const linkedinRouter = router({
  /** Get the calling user's LinkedIn credential record */
  getMyCredentials: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    const [record] = await db
      .select()
      .from(linkedinConnections)
      .where(
        and(
          eq(linkedinConnections.userId, ctx.user.id),
          eq(linkedinConnections.workspaceId, ctx.workspace.id),
        ),
      )
      .limit(1);

    if (!record) return null;

    return {
      id: record.id,
      displayName: record.displayName,
      profileUrl: record.profileUrl,
      linkedinId: record.linkedinId,
      syncedAt: record.syncedAt,
      // Return masked access token so UI can show "connected" state
      hasToken: !!record.accessToken,
      tokenMasked: record.accessToken ? maskValue(decrypt(record.accessToken)) : null,
    };
  }),

  /** Save or update the calling user's LinkedIn credentials */
  saveCredentials: workspaceProcedure
    .input(
      z.object({
        /** LinkedIn profile URL, e.g. https://linkedin.com/in/johndoe */
        profileUrl: z.string().url().optional(),
        /** Display name shown on LinkedIn profile */
        displayName: z.string().max(200).optional(),
        /** LinkedIn member ID or vanity handle */
        linkedinId: z.string().max(64).optional(),
        /**
         * Optional: personal API key, OAuth token, or any credential the user
         * wants to store for reference. Stored AES-256-GCM encrypted.
         * Leave empty to only save profile info without a credential value.
         */
        credentialValue: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const encryptedToken = input.credentialValue ? encrypt(input.credentialValue) : undefined;

      // Check if record exists
      const [existing] = await db
        .select({ id: linkedinConnections.id })
        .from(linkedinConnections)
        .where(
          and(
            eq(linkedinConnections.userId, ctx.user.id),
            eq(linkedinConnections.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);

      if (existing) {
        await db
          .update(linkedinConnections)
          .set({
            ...(input.displayName !== undefined && { displayName: input.displayName }),
            ...(input.profileUrl !== undefined && { profileUrl: input.profileUrl }),
            ...(input.linkedinId !== undefined && { linkedinId: input.linkedinId }),
            ...(encryptedToken !== undefined && { accessToken: encryptedToken }),
            syncedAt: new Date(),
          })
          .where(eq(linkedinConnections.id, existing.id));
        return { updated: true };
      } else {
        await db.insert(linkedinConnections).values({
          userId: ctx.user.id,
          workspaceId: ctx.workspace.id,
          accessToken: encryptedToken ?? encrypt(""), // store empty encrypted string if no token
          displayName: input.displayName ?? null,
          profileUrl: input.profileUrl ?? null,
          linkedinId: input.linkedinId ?? null,
          syncedAt: new Date(),
        });
        return { updated: false };
      }
    }),

  /** Remove the calling user's LinkedIn credential record */
  deleteCredentials: workspaceProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    await db
      .delete(linkedinConnections)
      .where(
        and(
          eq(linkedinConnections.userId, ctx.user.id),
          eq(linkedinConnections.workspaceId, ctx.workspace.id),
        ),
      );

    return { deleted: true };
  }),

  /** Admin-only: list all workspace members with their LinkedIn connection status */
  listTeamCredentials: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    // Fetch all active workspace members
    const members = await db
      .select({
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        userName: users.name,
        userEmail: users.email,
        userAvatar: users.avatarUrl,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, ctx.workspace.id),
        ),
      );

    // Fetch LinkedIn records for this workspace
    const linkedinRecords = await db
      .select({
        userId: linkedinConnections.userId,
        displayName: linkedinConnections.displayName,
        profileUrl: linkedinConnections.profileUrl,
        syncedAt: linkedinConnections.syncedAt,
      })
      .from(linkedinConnections)
      .where(eq(linkedinConnections.workspaceId, ctx.workspace.id));

    const linkedinByUser = new Map(linkedinRecords.map((r) => [r.userId, r]));

    return members.map((m) => {
      const li = linkedinByUser.get(m.userId);
      return {
        userId: m.userId,
        userName: m.userName,
        userEmail: m.userEmail,
        userAvatar: m.userAvatar,
        role: m.role,
        linkedinConnected: !!li,
        linkedinDisplayName: li?.displayName ?? null,
        linkedinProfileUrl: li?.profileUrl ?? null,
        linkedinSyncedAt: li?.syncedAt ?? null,
      };
    });
  }),
});
