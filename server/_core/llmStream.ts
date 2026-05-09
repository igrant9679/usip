/**
 * Streaming variants of invokeLLM, one per provider. Each function returns
 * an async iterable of text deltas; the higher-level SSE endpoint
 * (registerLLMStreamRoute) flushes each delta to the client.
 *
 * The shared credential-resolution path (loadCreds → workspace → env) is
 * reused so BYOK applies to streaming exactly as it does to invokeLLM.
 */
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { tryDecryptSecret } from "./crypto";
import { ENV } from "./env";
import type { InvokeParams, ProviderName, TextContent } from "./llm";

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
};

const ENV_CREDS: ResolvedCreds = {
  anthropicApiKey: ENV.anthropicApiKey,
  openaiApiKey: ENV.openaiApiKey,
  geminiApiKey: ENV.geminiApiKey,
  anthropicModel: DEFAULT_MODELS.anthropic,
  openaiModel: DEFAULT_MODELS.openai,
  geminiModel: DEFAULT_MODELS.gemini,
  defaultProvider: ENV.aiDefaultProvider,
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
    return {
      anthropicApiKey: tryDecryptSecret(row.anthropicApiKeyEnc) || ENV.anthropicApiKey,
      openaiApiKey: tryDecryptSecret(row.openaiApiKeyEnc) || ENV.openaiApiKey,
      geminiApiKey: tryDecryptSecret(row.geminiApiKeyEnc) || ENV.geminiApiKey,
      anthropicModel: row.anthropicModel || DEFAULT_MODELS.anthropic,
      openaiModel: row.openaiModel || DEFAULT_MODELS.openai,
      geminiModel: row.geminiModel || DEFAULT_MODELS.gemini,
      defaultProvider: row.aiDefaultProvider || ENV.aiDefaultProvider,
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

// ─── Anthropic ──────────────────────────────────────────────────────────────

async function* streamAnthropic(
  params: InvokeParams,
  creds: ResolvedCreds,
  signal: AbortSignal
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
  signal: AbortSignal
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
  signal: AbortSignal
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

  yield* parseSSE(res.body, line => {
    try {
      const j = JSON.parse(line);
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

export type StreamParams = InvokeParams & { signal?: AbortSignal };

export async function* streamLLM(params: StreamParams): AsyncGenerator<string> {
  const creds = await loadCreds(params.workspaceId);
  const provider = resolveProvider(params.provider, creds);
  const signal = params.signal ?? new AbortController().signal;
  switch (provider) {
    case "anthropic":
      yield* streamAnthropic(params, creds, signal);
      return;
    case "openai":
      yield* streamOpenAI(params, creds, signal);
      return;
    case "gemini":
      yield* streamGemini(params, creds, signal);
      return;
  }
}
