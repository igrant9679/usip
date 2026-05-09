/**
 * Streaming AI rewrite for email-builder blocks.
 *
 *   POST /api/email-builder/rewrite/stream
 *     Headers: x-workspace-id (required)
 *     Body: { content: string, instruction: "rewrite"|"shorten"|"lengthen"|"make_formal"|"make_casual", tone?: string }
 *     Returns: text/event-stream — same shape as /api/llm/stream
 *
 * Mirrors the prompt-building logic of `emailTemplates.rewriteBlock` in
 * server/routers/emailBuilder.ts:347. If that prompt changes, update both
 * — intentional duplication to keep the streaming path independent of the
 * tRPC router file.
 */
import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { workspaceMembers } from "../drizzle/schema";
import { getDb } from "./db";
import { sdk } from "./_core/sdk";
import { streamLLM } from "./_core/llmStream";

type Instruction = "rewrite" | "shorten" | "lengthen" | "make_formal" | "make_casual";

const INSTRUCTION_MAP: Record<Instruction, string> = {
  rewrite: "Rewrite the following email block content to be more compelling.",
  shorten: "Shorten the following email block content significantly while keeping the key message.",
  lengthen: "Expand the following email block content with more detail and context.",
  make_formal: "Rewrite the following email block content in a formal, professional tone.",
  make_casual: "Rewrite the following email block content in a friendly, conversational tone.",
};

function isInstruction(v: unknown): v is Instruction {
  return typeof v === "string" && v in INSTRUCTION_MAP;
}

export function registerEmailBuilderStreamRoutes(app: Express) {
  app.post(
    "/api/email-builder/rewrite/stream",
    async (req: Request, res: Response) => {
      // ── Auth ────────────────────────────────────────────────────────────
      let userId: number;
      try {
        const user = await sdk.authenticateRequest(req);
        userId = user.id;
      } catch {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      // ── Workspace ───────────────────────────────────────────────────────
      const headerVal = req.headers["x-workspace-id"];
      const headerStr = Array.isArray(headerVal) ? headerVal[0] : headerVal;
      const workspaceId = headerStr ? Number(headerStr) : NaN;
      if (!Number.isFinite(workspaceId)) {
        res.status(400).json({ error: "x-workspace-id header required" });
        return;
      }

      const db = await getDb();
      if (!db) {
        res.status(500).json({ error: "Database unavailable" });
        return;
      }

      const [member] = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (!member) {
        res.status(403).json({ error: "Not a member of that workspace" });
        return;
      }

      // ── Validate body ───────────────────────────────────────────────────
      const body = (req.body ?? {}) as { content?: unknown; instruction?: unknown; tone?: unknown };
      if (typeof body.content !== "string" || body.content.length === 0) {
        res.status(400).json({ error: "content (string) is required" });
        return;
      }
      if (!isInstruction(body.instruction)) {
        res.status(400).json({ error: "instruction must be one of: rewrite, shorten, lengthen, make_formal, make_casual" });
        return;
      }
      const tone = typeof body.tone === "string" ? body.tone : undefined;

      const systemPrompt = `You are an expert email copywriter. ${tone ? `Write in a ${tone} tone.` : ""} Return only the rewritten content with no extra commentary.`;
      const userPrompt = `${INSTRUCTION_MAP[body.instruction]}\n\n---\n${body.content}`;

      // ── SSE setup ───────────────────────────────────────────────────────
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      const send = (event: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      const abort = new AbortController();
      req.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(": heartbeat\n\n");
      }, 15_000);

      try {
        for await (const delta of streamLLM({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          workspaceId,
          signal: abort.signal,
        })) {
          if (res.writableEnded) break;
          send({ type: "delta", text: delta });
        }
        if (!res.writableEnded) send({ type: "done" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Stream failed";
        if (!res.writableEnded) send({ type: "error", error: message });
      } finally {
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
      }
    },
  );
}
