/**
 * Streaming variants of invokeLLM, one per provider. Each function returns
 * an async iterable of text deltas; the higher-level SSE endpoint
 * (registerLLMStreamRoute) flushes each delta to the client.
 *
 * The shared credential-resolution path (loadCreds → workspace → env) is
 * reused so BYOK applies to streaming exactly as it does to invokeLLM.
 *
 * 🔴 AUDIT 2026-10-20 (Phase 3). Streaming was the one model path with no
 * meter, no monthly budget and no burst ceiling: every streamed brief,
 * proposal section and email rewrite was spent and never counted. It now
 * checks the same two ceilings as invokeLLM before calling the provider and
 * records what the provider reports at the end of the stream — including a
 * stream the reader stopped early, which the provider bills all the same.
 */
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { tryDecryptSecret } from "./crypto";
import { ENV } from "./env";
import { checkLlmBurst, checkMonthlyCap, type InvokeParams, type ProviderName, type TextContent } from "./llm";
import { getRequestClientIp, getRequestFeature, getRequestUserId, getRequestWorkspaceId, isBackgroundWork } from "./requestContext";
import { recordLlmTokens } from "../usageCounters";
import { recordAiUsage, type KeySource } from "../services/spend";

const DEFAULT_MODELS = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.5-flash",
} as const;

type ResolvedCreds = {
  anthropicApiKey: string;
  openaiApiKey: string;
  geminiApiKey: string;
  anthropicModel: string;
  openaiModel: string;
  geminiModel: string;
  defaultProvider: string;
  sources: Record<ProviderName, KeySource>;
};

const ENV_CREDS: ResolvedCreds = {
  anthropicApiKey: ENV.anthropicApiKey,
  openaiApiKey: ENV.openaiApiKey,
  geminiApiKey: ENV.geminiApiKey,
  anthropicModel: DEFAULT_MODELS.anthropic,
  openaiModel: DEFAULT_MODELS.openai,
  geminiModel: DEFAULT_MODELS.gemini,
  defaultProvider: ENV.aiDefaultProvider,
  sources: { anthropic: "shared", openai: "shared", gemini: "shared" },
};

async function loadCreds(workspaceId?: number): Promise<ResolvedCreds> {
  if (!workspaceId) return ENV_CREDS;
  try {
    const db = await getDb();
    const rows = await db
      .select({
        anthropicApiKeyEnc: workspaceSettings.anthropicApiKeyEnc,
        openaiApiKeyEnc: workspaceSettings.openaiApiKeyEnc,
        geminiApiKeyEnc: workspaceSettings.geminiApiKeyEnc,
        anthropicModel: workspaceSettings.anthropicModel,
        openaiModel: workspaceSettings.openaiModel,
        geminiModel: workspaceSettings.geminiModel,
        aiDefaultProvider: workspaceSettings.aiDefaultProvider,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1);

    const row = rows[0];
    if (!row) return ENV_CREDS;
    const own = {
      anthropic: tryDecryptSecret(row.anthropicApiKeyEnc),
      openai: tryDecryptSecret(row.openaiApiKeyEnc),
      gemini: tryDecryptSecret(row.geminiApiKeyEnc),
    };
    return {
      anthropicApiKey: own.anthropic || ENV.anthropicApiKey,
      openaiApiKey: own.openai || ENV.openaiApiKey,
      geminiApiKey: own.gemini || ENV.geminiApiKey,
      anthropicModel: row.anthropicModel || DEFAULT_MODELS.anthropic,
      openaiModel: row.openaiModel || DEFAULT_MODELS.openai,
      geminiModel: row.geminiModel || DEFAULT_MODELS.gemini,
      defaultProvider: row.aiDefaultProvider || ENV.aiDefaultProvider,
      sources: {
        anthropic: own.anthropic ? "workspace" : "shared",
        openai: own.openai ? "workspace" : "shared",
        gemini: own.gemini ? "workspace" : "shared",
      },
    };
  } catch (err) {
    console.error("[llmStream] loadCreds failed, falling back to env:", err);
    return ENV_CREDS;
  }
}

function resolveProvider(
  explicit: ProviderName | undefined,
  creds: ResolvedCreds
): ProviderName {
  if (explicit) return explicit;
  const preferred = (creds.defaultProvider ?? "").toLowerCase();
  if (preferred === "openai" && creds.openaiApiKey) return "openai";
  if (preferred === "gemini" && creds.geminiApiKey) return "gemini";
  if (preferred === "anthropic" && creds.anthropicApiKey) return "anthropic";
  if (creds.anthropicApiKey) return "anthropic";
  if (creds.openaiApiKey) return "openai";
  if (creds.geminiApiKey) return "gemini";
  throw new Error("No AI provider configured");
}

// ─── Message normalisation (text-only for streaming endpoints) ──────────────

type SimpleMsg = { role: "system" | "user" | "assistant"; content: string };

function flatten(params: InvokeParams): { system: string; turns: SimpleMsg[] } {
  const system: string[] = [];
  const turns: SimpleMsg[] = [];
  for (const m of params.messages) {
    const text = Array.isArray(m.content)
      ? m.content
          .map(p => (typeof p === "string" ? p : (p as TextContent).text ?? ""))
          .join("\n")
      : typeof m.content === "string"
        ? m.content
        : (m.content as TextContent).text ?? "";

    if (m.role === "system") {
      system.push(text);
    } else if (m.role === "user" || m.role === "assistant") {
      turns.push({ role: m.role, content: text });
    }
  }
  return { system: system.join("\n\n"), turns };
}

/** What the provider reports a stream used, filled in as the stream goes. */
type StreamUsage = { model: string | null; input: number; output: number; cacheWrite: number; cacheRead: number };

// ─── Anthropic ──────────────────────────────────────────────────────────────

async function* streamAnthropic(
  params: InvokeParams,
  creds: ResolvedCreds,
  signal: AbortSignal,
  usage: StreamUsage,
): AsyncGenerator<string> {
  if (!creds.anthropicApiKey) throw new Error("Anthropic API key not configured");
  const client = new Anthropic({ apiKey: creds.anthropicApiKey });
  const { system, turns } = flatten(params);

  const stream = client.messages.stream(
    {
      model: params.model ?? creds.anthropicModel,
      max_tokens: params.maxTokens ?? params.max_tokens ?? 4096,
      ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
      ...(system ? { system } : {}),
      messages: turns.map(t => ({ role: t.role, content: t.content })),
    },
    { signal },
  );

  for await (const event of stream) {
    // message_start carries the input side; each message_delta the running
    // output count (cumulative, so the last one wins).
    if (event.type === "message_start") {
      const u = event.message.usage;
      usage.model = event.message.model;
      usage.input = u.input_tokens ?? 0;
      usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
      usage.cacheRead = u.cache_read_input_tokens ?? 0;
    } else if (event.type === "message_delta") {
      usage.output = event.usage.output_tokens ?? usage.output;
    }
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta" &&
      event.delta.text
    ) {
      yield event.delta.text;
    }
  }
}

// ─── OpenAI ─────────────────────────────────────────────────────────────────

async function* streamOpenAI(
  params: InvokeParams,
  creds: ResolvedCreds,
  signal: AbortSignal,
  usage: StreamUsage,
): AsyncGenerator<string> {
  if (!creds.openaiApiKey) throw new Error("OpenAI API key not configured");

  const payload: Record<string, unknown> = {
    model: params.model ?? creds.openaiModel,
    messages: params.messages.map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content
            .map(p => (typeof p === "string" ? p : (p as TextContent).text ?? ""))
            .join("\n")
        : typeof m.content === "string"
          ? m.content
          : (m.content as TextContent).text ?? "",
    })),
    max_tokens: params.maxTokens ?? params.max_tokens ?? 4096,
    stream: true,
    // Without this a streamed completion reports no usage at all.
    stream_options: { include_usage: true },
  };
  if (typeof params.temperature === "number") payload.temperature = params.temperature;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${creds.openaiApiKey}`,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI stream failed: ${res.status} ${res.statusText} – ${text}`);
  }

  yield* parseSSE(res.body, line => {
    if (line === "[DONE]") return null;
    try {
      const j = JSON.parse(line);
      if (typeof j?.model === "string") usage.model = j.model;
      if (j?.usage) {
        usage.input = Number(j.usage.prompt_tokens ?? 0);
        usage.output = Number(j.usage.completion_tokens ?? 0);
      }
      const delta = j?.choices?.[0]?.delta?.content;
      return typeof delta === "string" ? delta : null;
    } catch {
      return null;
    }
  });
}

// ─── Gemini ─────────────────────────────────────────────────────────────────

async function* streamGemini(
  params: InvokeParams,
  creds: ResolvedCreds,
  signal: AbortSignal,
  usage: StreamUsage,
): AsyncGenerator<string> {
  if (!creds.geminiApiKey) throw new Error("Gemini API key not configured");
  const { system, turns } = flatten(params);

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: params.maxTokens ?? params.max_tokens ?? 4096,
  };
  if (typeof params.temperature === "number") generationConfig.temperature = params.temperature;

  const body: Record<string, unknown> = {
    contents: turns.map(t => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.content }],
    })),
    generationConfig,
  };
  if (system) {
    body.systemInstruction = { role: "system", parts: [{ text: system }] };
  }

  const model = params.model ?? creds.geminiModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(creds.geminiApiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini stream failed: ${res.status} ${res.statusText} – ${text}`);
  }

  usage.model = model;
  yield* parseSSE(res.body, line => {
    try {
      const j = JSON.parse(line);
      // Each chunk carries the running totals; the last one is the call's.
      if (j?.usageMetadata) {
        usage.input = Number(j.usageMetadata.promptTokenCount ?? 0);
        usage.output = Number(j.usageMetadata.candidatesTokenCount ?? 0);
      }
      const parts = j?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) return null;
      const text = parts.map((p: { text?: string }) => p?.text ?? "").join("");
      return text || null;
    } catch {
      return null;
    }
  });
}

// ─── SSE parser shared by OpenAI + Gemini ───────────────────────────────────

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  extract: (line: string) => string | null,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, nlIdx).replace(/\r$/, "");
        buffer = buffer.slice(nlIdx + 1);
        if (!rawLine.startsWith("data:")) continue;
        const data = rawLine.slice(5).trimStart();
        if (!data) continue;
        const piece = extract(data);
        if (piece) yield piece;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Public entry point ─────────────────────────────────────────────────────

export type StreamParams = InvokeParams & {
  signal?: AbortSignal;
  /** The signed-in user, for the per-user burst ceiling: the SSE routes run outside tRPC's request context. */
  userId?: number;
};

export async function* streamLLM(params: StreamParams): AsyncGenerator<string> {
  const workspaceId = params.workspaceId ?? getRequestWorkspaceId();
  // Same contract as invokeLLM's sendersBrand (see InvokeParams).
  if (params.sendersBrand && workspaceId) {
    const { withSendersBrand } = await import("../services/brandContext");
    params = { ...params, messages: await withSendersBrand(workspaceId, params.messages) };
  }
  // Same contract as invokeLLM's research (see InvokeParams).
  if (params.research && workspaceId) {
    const { withResearch } = await import("../services/research/context");
    params = { ...params, messages: await withResearch(workspaceId, params.research, params.messages) };
  }
  // invokeLLM's two ceilings, before the provider is called.
  const now = Date.now();
  if (!isBackgroundWork()) checkLlmBurst(params.userId ?? getRequestUserId(), getRequestClientIp(), now);
  await checkMonthlyCap(workspaceId, now);

  const creds = await loadCreds(workspaceId);
  const provider = resolveProvider(params.provider, creds);
  const signal = params.signal ?? new AbortController().signal;
  const usage: StreamUsage = { model: null, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  try {
    switch (provider) {
      case "anthropic":
        yield* streamAnthropic(params, creds, signal, usage);
        return;
      case "openai":
        yield* streamOpenAI(params, creds, signal, usage);
        return;
      case "gemini":
        yield* streamGemini(params, creds, signal, usage);
        return;
    }
  } finally {
    // Runs when the stream ends, fails, or the reader stops early: whatever
    // the provider reported by then is what it bills.
    await recordLlmTokens(workspaceId, usage.input + usage.output);
    await recordAiUsage({
      workspaceId,
      vendor: provider,
      model: usage.model ?? params.model ?? null,
      keySource: creds.sources[provider],
      feature: params.feature ?? getRequestFeature() ?? "stream",
      usage: { input: usage.input, output: usage.output, cacheWrite: usage.cacheWrite, cacheRead: usage.cacheRead },
    });
  }
}
