/**
 * Shared SSE streaming infrastructure for AI features.
 *
 * Every route that streams an LLM response goes through these helpers, which
 * own the boilerplate so individual routes only declare:
 *   - their input validation + prompt-building (`buildMessages`)
 *   - any post-stream side effects (`onComplete`, e.g. DB persistence)
 *
 * What the helper handles:
 *   - JWT cookie auth via sdk.authenticateRequest
 *   - x-workspace-id header parsing + membership check
 *   - SSE response headers (incl. X-Accel-Buffering: no for nginx)
 *   - 15s heartbeat to keep proxies alive
 *   - AbortController wired to client disconnect
 *   - Per-event JSON serialisation (delta / done / error / custom)
 *   - Streaming via streamLLM (multi-provider with workspace BYOK)
 *   - Optional onComplete only fires when the client stayed connected
 *     through the whole stream (matches existing Stop-doesn't-save semantics)
 */
import type { Request, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { workspaceMembers } from "../../drizzle/schema";
import { getDb } from "../db";
import { sdk } from "./sdk";
import { streamLLM } from "./llmStream";
import type { Message, ProviderName } from "./llm";

export type StreamSendFn = (event: Record<string, unknown>) => void;

export type StreamHandlerContext = {
  req: Request;
  res: Response;
  userId: number;
  workspaceId: number;
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  send: StreamSendFn;
  /** True once the client has disconnected. Use to skip side-effects on abort. */
  isAborted: () => boolean;
};

export type BuildMessagesResult = {
  messages: Message[];
  provider?: ProviderName;
  model?: string;
  temperature?: number;
  maxTokens?: number;
};

export type StreamHandlerOptions = {
  /**
   * Resolve input validation, fetch any context the prompt needs, and return
   * the LLM messages. Throw to abort with a 4xx response — the helper catches
   * thrown Errors and returns 400 with `error.message` before SSE headers fly.
   */
  buildMessages(ctx: Omit<StreamHandlerContext, "send" | "isAborted">): Promise<BuildMessagesResult>;
  /**
   * Optional post-stream side effect (DB save, audit log, etc.). Receives the
   * full accumulated content. Only invoked if the client stayed connected
   * through the whole stream — aborts skip this.
   *
   * May call `ctx.send(...)` to emit custom events (e.g. `{type:"saved", id}`).
   */
  onComplete?(ctx: StreamHandlerContext, content: string): Promise<void>;
};

/** What every streaming route needs resolved before it may do anything. */
export interface StreamAuth {
  userId: number;
  workspaceId: number;
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
}

/**
 * Authenticate an SSE request and resolve the workspace it acts in.
 *
 * Returns null when the request is refused, having ALREADY written the
 * response — callers must return immediately.
 *
 * ⚠️ This is a separate export because `/api/llm/stream` cannot use
 * `runSSEStream` (it forwards the whole InvokeParams body — tools,
 * outputSchema, responseFormat — which BuildMessagesResult does not carry, and
 * narrowing a generic endpoint's contract is not a thing to do as a side
 * effect of an auth fix). It had its own copy of the rule, and the copy had
 * drifted: the membership check was wrapped in `if (Number.isFinite(workspaceId))`,
 * so omitting the header skipped it entirely and streamed on the platform key
 * with no workspace scope — an authenticated but unscoped LLM proxy, billed
 * past the workspace's own BYOK credentials. Four routes required the header;
 * the fifth treated it as optional. One rule now, in one place.
 */
export async function resolveStreamAuth(req: Request, res: Response): Promise<StreamAuth | null> {
  // ── Auth ──────────────────────────────────────────────────────────────
  let userId: number;
  try {
    const user = await sdk.authenticateRequest(req);
    userId = user.id;
  } catch {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  // ── Workspace ─────────────────────────────────────────────────────────
  const headerVal = req.headers["x-workspace-id"];
  const headerStr = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  const workspaceId = headerStr ? Number(headerStr) : NaN;
  if (!Number.isFinite(workspaceId)) {
    res.status(400).json({ error: "x-workspace-id header required" });
    return null;
  }

  const db = await getDb();
  if (!db) {
    res.status(500).json({ error: "Database unavailable" });
    return null;
  }

  const [member] = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.workspaceId, workspaceId),
        // Deactivation revokes access — see resolveWorkspace.
        isNull(workspaceMembers.deactivatedAt),
      ),
    )
    .limit(1);
  if (!member) {
    res.status(403).json({ error: "Not a member of that workspace" });
    return null;
  }

  return { userId, workspaceId, db };
}

/**
 * Run a full SSE-streamed LLM response. This is the only function streaming
 * routes need to call — they declare what to do via the options hooks.
 */
export async function runSSEStream(
  req: Request,
  res: Response,
  opts: StreamHandlerOptions,
): Promise<void> {
  const auth = await resolveStreamAuth(req, res);
  if (!auth) return;
  const { userId, workspaceId, db } = auth;

  // ── Build messages (caller's hook) ────────────────────────────────────
  let built: BuildMessagesResult;
  try {
    built = await opts.buildMessages({ req, res, userId, workspaceId, db });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bad request";
    res.status(400).json({ error: message });
    return;
  }

  // ── SSE setup ─────────────────────────────────────────────────────────
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send: StreamSendFn = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  let clientDisconnected = false;
  const abort = new AbortController();
  req.on("close", () => {
    clientDisconnected = true;
    if (!res.writableEnded) abort.abort();
  });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": heartbeat\n\n");
  }, 15_000);

  const ctx: StreamHandlerContext = {
    req,
    res,
    userId,
    workspaceId,
    db,
    send,
    isAborted: () => clientDisconnected,
  };

  // ── Stream loop ───────────────────────────────────────────────────────
  let accumulated = "";
  try {
    for await (const delta of streamLLM({
      ...built,
      workspaceId,
      signal: abort.signal,
    })) {
      if (res.writableEnded) break;
      accumulated += delta;
      send({ type: "delta", text: delta });
    }

    // Post-stream hook — skip if the client aborted, matching existing
    // Stop semantics across the rest of the streaming surfaces.
    if (!clientDisconnected && opts.onComplete) {
      try {
        await opts.onComplete(ctx, accumulated);
      } catch (completeErr) {
        console.error("[SSEStream] onComplete failed:", completeErr);
        send({
          type: "error",
          error:
            completeErr instanceof Error
              ? completeErr.message
              : "Post-stream save failed",
        });
      }
    }

    if (!res.writableEnded) send({ type: "done" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stream failed";
    if (!res.writableEnded) send({ type: "error", error: message });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}
