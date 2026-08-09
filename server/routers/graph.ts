/**
 * graph — Microsoft 365 (OneNote + OneDrive) per-member integration.
 *
 * Connection is PER USER: each member OAuths their own Microsoft account,
 * so files browse THEIR OneDrive and notes mirror into THEIR notebook.
 * Everything here fails closed with a named-env message until
 * MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET are set.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { graphConnections, recordFiles } from "../../drizzle/schema";
import { workspaceProcedure } from "../_core/workspace";
import { router } from "../_core/trpc";
import {
  buildAuthorizeUrl,
  clearTokenCache,
  getConnection,
  graphEnvConfigured,
  signOAuthState,
} from "../services/msgraph";
import { getDownloadUrl, getItem, listFolder, uploadToVelocityFolder } from "../services/onedrive";
import { runOneNoteSync } from "../services/onenoteSync";

const RELATED_TYPES = ["contact", "lead", "account", "opportunity"] as const;

async function requireConnection(workspaceId: number, userId: number) {
  const conn = await getConnection(workspaceId, userId);
  if (!conn || conn.status !== "active") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Connect your Microsoft account first (Connected Accounts → Microsoft 365).",
    });
  }
  return conn;
}

export const graphRouter = router({
  status: workspaceProcedure.query(async ({ ctx }) => {
    const conn = await getConnection(ctx.workspace.id, ctx.user.id);
    return {
      envConfigured: graphEnvConfigured(),
      connected: !!conn && conn.status === "active",
      needsReconnect: conn?.status === "error",
      msEmail: conn?.msEmail ?? null,
      onenoteSyncedAt: conn?.onenoteSyncedAt ?? null,
      lastSyncResult: (conn?.lastSyncResult ?? null) as
        | { pushed: number; pulled: number; skippedUnmatched: number; errors: string[]; at: string }
        | null,
    };
  }),

  getConnectUrl: workspaceProcedure.mutation(async ({ ctx }) => {
    if (!graphEnvConfigured()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET are not set on the server yet.",
      });
    }
    const state = await signOAuthState({ userId: ctx.user.id, workspaceId: ctx.workspace.id });
    return { url: await buildAuthorizeUrl(state) };
  }),

  disconnect: workspaceProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const conn = await getConnection(ctx.workspace.id, ctx.user.id);
    if (conn) {
      clearTokenCache(conn.id);
      await db.delete(graphConnections).where(eq(graphConnections.id, conn.id));
    }
    return { ok: true };
  }),

  /* ── OneDrive ─────────────────────────────────────────────────────── */

  oneDriveList: workspaceProcedure
    .input(z.object({ itemId: z.string().max(300).optional() }))
    .query(async ({ ctx, input }) => {
      const conn = await requireConnection(ctx.workspace.id, ctx.user.id);
      return { items: await listFolder(conn, input.itemId) };
    }),

  attachFile: workspaceProcedure
    .input(z.object({
      relatedType: z.enum(RELATED_TYPES),
      relatedId: z.number().int().positive(),
      itemId: z.string().max(300),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const conn = await requireConnection(ctx.workspace.id, ctx.user.id);
      // Resolve through Graph rather than trusting client-supplied metadata —
      // the stored name/webUrl are rendered to other members later.
      const item = await getItem(conn, input.itemId);
      if (item.isFolder) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a file, not a folder." });
      await db.insert(recordFiles).values({
        workspaceId: ctx.workspace.id,
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        source: "onedrive",
        driveItemId: item.id,
        name: item.name,
        webUrl: item.webUrl,
        sizeBytes: item.size,
        addedByUserId: ctx.user.id,
      });
      return { ok: true, name: item.name };
    }),

  uploadFile: workspaceProcedure
    .input(z.object({
      relatedType: z.enum(RELATED_TYPES),
      relatedId: z.number().int().positive(),
      filename: z.string().min(1).max(255),
      /** Base64 payload — bounded well under the 50mb JSON body limit. */
      dataBase64: z.string().max(30_000_000),
      subfolder: z.string().max(120).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const conn = await requireConnection(ctx.workspace.id, ctx.user.id);
      const buf = Buffer.from(input.dataBase64, "base64");
      if (buf.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Empty file." });
      const item = await uploadToVelocityFolder(
        conn,
        input.subfolder ?? `${input.relatedType}s`,
        input.filename,
        buf,
      );
      await db.insert(recordFiles).values({
        workspaceId: ctx.workspace.id,
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        source: "onedrive",
        driveItemId: item.id,
        name: item.name,
        webUrl: item.webUrl,
        sizeBytes: item.size ?? buf.length,
        addedByUserId: ctx.user.id,
      });
      return { ok: true, name: item.name, webUrl: item.webUrl };
    }),

  listFiles: workspaceProcedure
    .input(z.object({
      relatedType: z.enum(RELATED_TYPES),
      relatedId: z.number().int().positive(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { files: [] };
      const files = await db.select().from(recordFiles)
        .where(and(
          eq(recordFiles.workspaceId, ctx.workspace.id),
          eq(recordFiles.relatedType, input.relatedType),
          eq(recordFiles.relatedId, input.relatedId),
        ))
        .orderBy(desc(recordFiles.id));
      return { files };
    }),

  /** Unlink from the record — never deletes the file in OneDrive. */
  removeFile: workspaceProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.delete(recordFiles)
        .where(and(eq(recordFiles.id, input.id), eq(recordFiles.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  downloadUrl: workspaceProcedure
    .input(z.object({ itemId: z.string().max(300) }))
    .mutation(async ({ ctx, input }) => {
      const conn = await requireConnection(ctx.workspace.id, ctx.user.id);
      const url = await getDownloadUrl(conn, input.itemId);
      if (!url) throw new TRPCError({ code: "NOT_FOUND", message: "File not found in OneDrive." });
      return { url };
    }),

  /* ── OneNote ──────────────────────────────────────────────────────── */

  onenoteSyncNow: workspaceProcedure.mutation(async ({ ctx }) => {
    const conn = await requireConnection(ctx.workspace.id, ctx.user.id);
    return runOneNoteSync(conn);
  }),

  /* ── Outlook calendar ─────────────────────────────────────────────── */

  calendarSyncNow: workspaceProcedure.mutation(async ({ ctx }) => {
    const conn = await requireConnection(ctx.workspace.id, ctx.user.id);
    const { runGraphCalendarSync } = await import("../services/graphCalendarSync");
    return runGraphCalendarSync(conn);
  }),
});
