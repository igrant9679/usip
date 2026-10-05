/**
 * knowledgeBase.ts — Settings → Knowledge base (owner ask 2026-10-05:
 * "attach pdfs to provide full product/service/pricing/etc. knowledge to the
 * agent and to inform the AI generated outputs (emails, etc.) in general").
 *
 * Admins add documents (PDF, .txt/.md, or a web page) and edit the overview;
 * anyone in the workspace can see them and try a search. Extraction runs in
 * the background: a document is `processing`, then `ready` or `failed` with
 * a reason.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { knowledgeChunks, knowledgeDocuments, users, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { recordAudit } from "../audit";
import {
  documentCount,
  generateKnowledgeSummary,
  ingestDocument,
  MAX_DOCUMENTS,
  MAX_UPLOAD_BYTES,
  SUMMARY_MAX_CHARS,
  type IngestInput,
} from "../services/knowledgeBase";
import { invalidateKnowledge, searchKnowledge } from "../services/knowledgeSearch";
import { formatKnowledge } from "../services/knowledgeText";

/** A document still `processing` after this was cut off (a restart mid-extraction). */
const STALE_PROCESSING_MS = 10 * 60 * 1000;

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/** What kind of upload this is, from its bytes first and its name second. */
export function uploadKind(fileName: string, mimeType: string, bytes: Uint8Array): "pdf" | "text" | null {
  if (bytes.length >= 5 && String.fromCharCode(...Array.from(bytes.subarray(0, 5))) === "%PDF-") return "pdf";
  const name = fileName.toLowerCase();
  if (/\.(txt|md|markdown|csv)$/.test(name) || /^text\//.test(mimeType)) return "text";
  return null;
}

/** Start extraction without holding the request open; failures land on the row. */
function startIngest(workspaceId: number, id: number, input: IngestInput): void {
  void ingestDocument(workspaceId, id, input).catch((e) => console.error("[Knowledge] ingest crashed:", e));
}

export const knowledgeBaseRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    const docs = await db.select().from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.workspaceId, ctx.workspace.id))
      .orderBy(desc(knowledgeDocuments.createdAt));
    const [s] = await db.select({ summary: workspaceSettings.knowledgeSummary, at: workspaceSettings.knowledgeSummaryUpdatedAt })
      .from(workspaceSettings).where(eq(workspaceSettings.workspaceId, ctx.workspace.id)).limit(1);
    const uploaderIds = Array.from(new Set(docs.map((d) => d.uploadedByUserId).filter((v): v is number => v != null)));
    const names = new Map<number, string | null>();
    for (const id of uploaderIds) {
      const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, id)).limit(1);
      names.set(id, u?.name ?? null);
    }
    const now = Date.now();
    return {
      documents: docs.map((d) => {
        const stale = d.status === "processing" && now - new Date(d.createdAt).getTime() > STALE_PROCESSING_MS;
        return {
          ...d,
          status: stale ? ("failed" as const) : d.status,
          error: stale ? "Processing was interrupted. Refresh or upload it again." : d.error,
          uploadedByName: d.uploadedByUserId != null ? (names.get(d.uploadedByUserId) ?? null) : null,
        };
      }),
      summary: s?.summary ?? "",
      summaryUpdatedAt: s?.at ?? null,
      limits: { maxDocuments: MAX_DOCUMENTS, maxUploadBytes: MAX_UPLOAD_BYTES, summaryMaxChars: SUMMARY_MAX_CHARS },
    };
  }),

  /** Upload a PDF or a text/Markdown file (base64), up to 20 MB. */
  upload: adminWsProcedure
    .input(z.object({ fileName: z.string().min(1).max(255), mimeType: z.string().max(100).default(""), base64: z.string().min(1).max(28_500_000) }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const bytes = new Uint8Array(Buffer.from(input.base64, "base64"));
      if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new TRPCError({ code: "BAD_REQUEST", message: "Files can be up to 20 MB." });
      const kind = uploadKind(input.fileName, input.mimeType, bytes);
      if (!kind) throw new TRPCError({ code: "BAD_REQUEST", message: "Upload a PDF, or a .txt or .md file." });
      if ((await documentCount(ctx.workspace.id)) >= MAX_DOCUMENTS) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `The knowledge base holds up to ${MAX_DOCUMENTS} documents; delete one first.` });
      }
      const title = input.fileName.replace(/\.[a-z0-9]{1,8}$/i, "").replace(/[_]+/g, " ").trim().slice(0, 200) || "Document";
      const ins = await db.insert(knowledgeDocuments).values({
        workspaceId: ctx.workspace.id,
        title,
        sourceType: kind,
        mimeType: input.mimeType.slice(0, 100) || (kind === "pdf" ? "application/pdf" : "text/plain"),
        sizeBytes: bytes.byteLength,
        status: "processing",
        uploadedByUserId: ctx.user.id,
      });
      const id = Number((ins as any)[0]?.insertId ?? (ins as any)?.insertId ?? 0);
      startIngest(ctx.workspace.id, id, kind === "pdf" ? { kind: "pdf", data: bytes } : { kind: "text", text: Buffer.from(bytes).toString("utf8") });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "knowledge_document", entityId: id, after: { title, kind, sizeBytes: bytes.byteLength } });
      return { id };
    }),

  /** Add a public web page (fetched through the SSRF guard). */
  addUrl: adminWsProcedure
    .input(z.object({ url: z.string().url().max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const u = new URL(input.url);
      if (!/^https?:$/.test(u.protocol)) throw new TRPCError({ code: "BAD_REQUEST", message: "Use an http or https address." });
      if ((await documentCount(ctx.workspace.id)) >= MAX_DOCUMENTS) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `The knowledge base holds up to ${MAX_DOCUMENTS} documents; delete one first.` });
      }
      const ins = await db.insert(knowledgeDocuments).values({
        workspaceId: ctx.workspace.id,
        title: `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 200),
        sourceType: "url",
        sourceUrl: u.toString(),
        status: "processing",
        uploadedByUserId: ctx.user.id,
      });
      const id = Number((ins as any)[0]?.insertId ?? (ins as any)?.insertId ?? 0);
      startIngest(ctx.workspace.id, id, { kind: "url", url: u.toString() });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "knowledge_document", entityId: id, after: { url: u.toString() } });
      return { id };
    }),

  /** Read a web page again (it may have changed). */
  refresh: adminWsProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const [d] = await db.select().from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, input.id), eq(knowledgeDocuments.workspaceId, ctx.workspace.id))).limit(1);
    if (!d) throw new TRPCError({ code: "NOT_FOUND" });
    if (d.sourceType !== "url" || !d.sourceUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "Only a web page can be refreshed; upload a new copy of a file instead." });
    await db.update(knowledgeDocuments).set({ status: "processing", error: null }).where(eq(knowledgeDocuments.id, d.id));
    startIngest(ctx.workspace.id, d.id, { kind: "url", url: d.sourceUrl });
    return { ok: true };
  }),

  update: adminWsProcedure
    .input(z.object({ id: z.number().int(), title: z.string().min(1).max(200).optional(), enabled: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const patch: Partial<typeof knowledgeDocuments.$inferInsert> = {};
      if (input.title !== undefined) patch.title = input.title.trim();
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (Object.keys(patch).length) {
        await db.update(knowledgeDocuments).set(patch)
          .where(and(eq(knowledgeDocuments.id, input.id), eq(knowledgeDocuments.workspaceId, ctx.workspace.id)));
        invalidateKnowledge(ctx.workspace.id);
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "knowledge_document", entityId: input.id, after: patch });
      }
      return { ok: true };
    }),

  remove: adminWsProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
    const db = await requireDb();
    const [d] = await db.select({ id: knowledgeDocuments.id, title: knowledgeDocuments.title }).from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, input.id), eq(knowledgeDocuments.workspaceId, ctx.workspace.id))).limit(1);
    if (!d) throw new TRPCError({ code: "NOT_FOUND" });
    await db.delete(knowledgeChunks).where(and(eq(knowledgeChunks.workspaceId, ctx.workspace.id), eq(knowledgeChunks.documentId, d.id)));
    await db.delete(knowledgeDocuments).where(and(eq(knowledgeDocuments.id, d.id), eq(knowledgeDocuments.workspaceId, ctx.workspace.id)));
    invalidateKnowledge(ctx.workspace.id);
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "knowledge_document", entityId: d.id, before: { title: d.title } });
    return { ok: true };
  }),

  saveSummary: adminWsProcedure
    .input(z.object({ summary: z.string().max(SUMMARY_MAX_CHARS) }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const existing = await db.select({ w: workspaceSettings.workspaceId }).from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id)).limit(1);
      if (!existing.length) await db.insert(workspaceSettings).values({ workspaceId: ctx.workspace.id });
      await db.update(workspaceSettings).set({ knowledgeSummary: input.summary.trim() || null, knowledgeSummaryUpdatedAt: new Date() })
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "knowledge_summary", entityId: null, after: { chars: input.summary.trim().length } });
      return { ok: true };
    }),

  /** Redraft the overview from the documents (replaces the current one). */
  generateSummary: adminWsProcedure.mutation(async ({ ctx }) => {
    const text = await generateKnowledgeSummary(ctx.workspace.id);
    if (!text) throw new TRPCError({ code: "BAD_REQUEST", message: "Nothing to summarise yet: add a document and wait for it to be ready." });
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "knowledge_summary", entityId: null, after: { generated: true, chars: text.length } });
    return { summary: text };
  }),

  /** Try a question: the passages an AI writer or the phone agent would get. */
  search: workspaceProcedure
    .input(z.object({ query: z.string().min(1).max(500) }))
    .query(async ({ ctx, input }) => {
      const found = await searchKnowledge(ctx.workspace.id, input.query, 5);
      return { passages: found, block: formatKnowledge(null, found.slice(0, 3)) };
    }),
});
