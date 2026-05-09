/**
 * SSE endpoint for streaming LLM completions.
 *
 *   POST /api/llm/stream
 *     Headers: x-workspace-id (required for BYOK to apply)
 *     Body: same shape as InvokeParams (messages, provider?, model?, ...)
 *     Returns: text/event-stream
 *
 * Event format (each line is `data: <json>\n\n`):
 *   { "type": "delta", "text": "..." }   one or more
 *   { "type": "done" }                    terminator
 *   { "type": "error", "error": "..." }   on failure (replaces "done")
 *
 * Closing the connection (e.g. user navigates away) aborts the upstream
 * provider call via AbortController.
 */
import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { workspaceMembers } from "../drizzle/schema";
import { getDb } from "./db";
import { sdk } from "./_core/sdk";
import { streamLLM } from "./_core/llmStream";
import type { InvokeParams } from "./_core/llm";

export function registerLLMStreamRoutes(app: Express) {
  app.post("/api/llm/stream", async (req: Request, res: Response) => {
    // ── Auth ──────────────────────────────────────────────────────────────
    let userId: number;
    try {
      const user = await sdk.authenticateRequest(req);
      userId = user.id;
    } catch {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // ── Workspace check ───────────────────────────────────────────────────
    const headerVal = req.headers["x-workspace-id"];
    const headerStr = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    const workspaceId = headerStr ? Number(headerStr) : NaN;

    if (Number.isFinite(workspaceId)) {
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
    }

    // ── Validate body ─────────────────────────────────────────────────────
    const body = (req.body ?? {}) as Partial<InvokeParams>;
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ error: "messages array is required" });
      return;
    }

    const params: InvokeParams = {
      ...body,
      messages: body.messages,
      workspaceId: Number.isFinite(workspaceId) ? workspaceId : undefined,
    };

    // ── SSE headers ───────────────────────────────────────────────────────
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
    res.flushHeaders?.();

    const send = (event: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      // Express + node http: no built-in flush after write; the kernel will push.
    };

    // ── Abort on client disconnect ────────────────────────────────────────
    const abort = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    // ── Heartbeat to keep proxies from closing the connection ─────────────
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": heartbeat\n\n");
    }, 15_000);

    try {
      for await (const delta of streamLLM({ ...params, signal: abort.signal })) {
        if (res.writableEnded) break;
        send({ type: "delta", text: delta });
      }
      if (!res.writableEnded) {
        send({ type: "done" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Stream failed";
      if (!res.writableEnded) {
        send({ type: "error", error: message });
      }
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });
}
