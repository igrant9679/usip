/**
 * SSE endpoint for streaming LLM completions.
 *
 *   POST /api/llm/stream
 *     Headers: x-workspace-id (REQUIRED — 400 without it; the caller must be a
 *              member of that workspace, and it selects the BYOK credentials)
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
import { resolveStreamAuth } from "./_core/streamHelpers";
import { streamLLM } from "./_core/llmStream";
import type { InvokeParams } from "./_core/llm";

export function registerLLMStreamRoutes(app: Express) {
  app.post("/api/llm/stream", async (req: Request, res: Response) => {
    // ── Auth + workspace ──────────────────────────────────────────────────
    // One rule, shared with runSSEStream — see resolveStreamAuth. The copy
    // that lived here wrapped the membership check in
    // `if (Number.isFinite(workspaceId))`, so a request that simply omitted
    // the header skipped the check AND arrived at streamLLM with
    // workspaceId: undefined, which is the signal to ignore the workspace's
    // BYOK credentials and bill the platform key. Any authenticated user
    // could drive arbitrary provider/model/messages that way.
    const auth = await resolveStreamAuth(req, res);
    if (!auth) return;
    const { workspaceId } = auth;

    // ── Validate body ─────────────────────────────────────────────────────
    const body = (req.body ?? {}) as Partial<InvokeParams>;
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ error: "messages array is required" });
      return;
    }

    // The whole body is forwarded on purpose: unlike the four routes built on
    // runSSEStream, this one is the generic passthrough and carries tools /
    // outputSchema / responseFormat straight to the provider.
    const params: InvokeParams = {
      ...body,
      messages: body.messages,
      workspaceId,
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
