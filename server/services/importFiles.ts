/**
 * The uploaded import file, kept on the server under a token (audit
 * 2026-10-20, F32 and R86).
 *
 * The importer took the whole CSV three times: to parse it, to validate it
 * and to commit it, so a 10 MB file crossed the wire three times and the
 * commit could read a different file than the one validated. Now the parse
 * stores it once and hands back a token; validation and commit read the
 * stored text. A file is kept for a day and belongs to the person who
 * uploaded it, in that workspace. Each person has one pending file per
 * workspace: a new upload replaces the last one (the same rule the LeadRocks
 * preview kept, R90), and a commit consumes it.
 */
import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, lt } from "drizzle-orm";
import { importFiles } from "../../drizzle/schema";
import { getDb } from "../db";

/** How long an uploaded file is kept for validation and commit. */
export const IMPORT_FILE_TTL_MS = 24 * 60 * 60 * 1000;
/** The largest file kept (the page's own limit is 10 MB). */
export const IMPORT_FILE_MAX_BYTES = 20_000_000;

export type ImportPreset = "leadrocks";

export type StoredImportFile = {
  token: string;
  filename: string;
  preset: ImportPreset | null;
  content: string;
  lastErrorRows: Array<{ rowIndex: number; reason: string }> | null;
};

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/** Keep a file and return its token; this person's earlier pending file here goes. */
export async function saveImportFile(opts: {
  workspaceId: number;
  userId: number;
  filename: string;
  content: string;
  rowCount: number;
  preset: ImportPreset | null;
}): Promise<string> {
  const bytes = Buffer.byteLength(opts.content, "utf8");
  if (bytes > IMPORT_FILE_MAX_BYTES) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This file is larger than 20 MB. Split it into smaller files." });
  }
  const db = await requireDb();
  const token = randomUUID();
  await db.delete(importFiles).where(lt(importFiles.expiresAt, new Date()));
  await db.delete(importFiles).where(and(eq(importFiles.workspaceId, opts.workspaceId), eq(importFiles.userId, opts.userId)));
  await db.insert(importFiles).values({
    token,
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    filename: opts.filename.slice(0, 255),
    preset: opts.preset,
    content: opts.content,
    byteSize: bytes,
    rowCount: opts.rowCount,
    expiresAt: new Date(Date.now() + IMPORT_FILE_TTL_MS),
  });
  return token;
}

/** The stored file, if this person uploaded it here and it has not expired. */
export async function loadImportFile(workspaceId: number, userId: number, token: string): Promise<StoredImportFile> {
  const db = await requireDb();
  const [row] = await db.select().from(importFiles).where(eq(importFiles.token, token)).limit(1);
  if (!row || new Date(row.expiresAt).getTime() < Date.now()) {
    throw new TRPCError({ code: "NOT_FOUND", message: "This upload has expired or was replaced. Upload the file again." });
  }
  if (row.workspaceId !== workspaceId || row.userId !== userId) {
    // Another person's upload, or another workspace's: never readable here.
    throw new TRPCError({ code: "FORBIDDEN", message: "This upload belongs to someone else." });
  }
  return {
    token: row.token,
    filename: row.filename,
    preset: (row.preset as ImportPreset | null) ?? null,
    content: row.content,
    lastErrorRows: (row.lastErrorRows as StoredImportFile["lastErrorRows"]) ?? null,
  };
}

export async function setImportFilePreset(workspaceId: number, userId: number, token: string, preset: ImportPreset | null): Promise<void> {
  const db = await requireDb();
  await db.update(importFiles).set({ preset, lastErrorRows: null })
    .where(and(eq(importFiles.token, token), eq(importFiles.workspaceId, workspaceId), eq(importFiles.userId, userId)));
}

/** The last validation's error rows, for "Download error report" before the import. */
export async function saveImportFileErrors(workspaceId: number, userId: number, token: string, errorRows: Array<{ rowIndex: number; reason: string }>): Promise<void> {
  const db = await requireDb();
  await db.update(importFiles).set({ lastErrorRows: errorRows as never })
    .where(and(eq(importFiles.token, token), eq(importFiles.workspaceId, workspaceId), eq(importFiles.userId, userId)));
}

/** A committed file is consumed. */
export async function deleteImportFile(workspaceId: number, userId: number, token: string): Promise<void> {
  const db = await requireDb();
  await db.delete(importFiles)
    .where(and(eq(importFiles.token, token), eq(importFiles.workspaceId, workspaceId), eq(importFiles.userId, userId)));
}
