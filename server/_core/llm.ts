import Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";
import { usageCounters, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { tryDecryptSecret } from "./crypto";
import { ENV } from "./env";
import { getRequestClientIp, getRequestUserId, getRequestWorkspaceId } from "./requestContext";
import { recordLlmTokens, usageMonthKey } from "../usageCounters";

// ---------------------------------------------------------------------------
// Public types — kept stable so existing 24 call sites do not change.
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4";
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type ProviderName = "anthropic" | "openai" | "gemini";

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  // New (optional) — per-call provider/model override.
  provider?: ProviderName;
  model?: string;
  temperature?: number;
  // BYOK — when set, the workspace's configured API key + model are used in
  // preference to the server-level env vars. Falls back to env on any miss.
  workspaceId?: number;
};

type ResolvedCreds = {
  anthropicApiKey: string;
  openaiApiKey: string;
  geminiApiKey: string;
  anthropicModel: string;
  openaiModel: string;
  geminiModel: string;
  defaultProvider: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

// ---------------------------------------------------------------------------
// Default model per provider. Override per-call via params.model.
// ---------------------------------------------------------------------------

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.5-flash",
};

// ---------------------------------------------------------------------------
// Global concurrency gate
//
// The ARE engine fans out enrichment/sequence agents with Promise.allSettled
// (up to ~8 simultaneous calls per tick), which tripped Anthropic's
// concurrent-connection rate limit (429 "Number of concurrent connections has
// exceeded your rate limit"). All invokeLLM calls process-wide now queue
// through this semaphore so bursts serialize instead of erroring. Override
// with LLM_MAX_CONCURRENCY when the account's tier allows more.
// ---------------------------------------------------------------------------

const LLM_MAX_CONCURRENCY = Math.max(1, Number(process.env.LLM_MAX_CONCURRENCY ?? "") || 2);
let llmActive = 0;
const llmWaiters: Array<() => void> = [];

async function acquireLlmSlot(): Promise<void> {
  if (llmActive < LLM_MAX_CONCURRENCY) {
    llmActive++;
    return;
  }
  await new Promise<void>((resolve) => llmWaiters.push(resolve));
  llmActive++;
}

function releaseLlmSlot(): void {
  llmActive--;
  const next = llmWaiters.shift();
  if (next) next();
}

/**
 * True for transient provider errors (rate limit / overload / 5xx) that a
 * background job should retry later rather than persist as a hard failure.
 * SDK errors carry a numeric `status`; raw-fetch paths only have the message.
 */
export function isRetryableLLMError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === "number" && [408, 429, 500, 502, 503, 504, 529].includes(status)) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /rate[_ ]?limit|overloaded|too many (concurrent )?(request|connection)|\b429\b|\b529\b/i.test(msg);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

const normalizeContentPart = (
  part: MessageContent
): TextContent | ImageContent | FileContent => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }
  if (part.type === "text") return part;
  if (part.type === "image_url") return part;
  if (part.type === "file_url") return part;
  throw new Error("Unsupported message content part");
};

const normalizeMessageOpenAI = (message: Message) => {
  const { role, name, tool_call_id } = message;

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");
    return { role, name, tool_call_id, content };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);

  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return { role, name, content: contentParts[0].text };
  }

  return { role, name, content: contentParts };
};

const normalizeToolChoiceOpenAI = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;
  if (toolChoice === "none" || toolChoice === "auto") return toolChoice;

  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }
    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }
    return { type: "function", function: { name: tools[0].function.name } };
  }

  if ("name" in toolChoice) {
    return { type: "function", function: { name: toolChoice.name } };
  }

  return toolChoice;
};

const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (
      explicitFormat.type === "json_schema" &&
      !explicitFormat.json_schema?.schema
    ) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }

  const schema = outputSchema || output_schema;
  if (!schema) return undefined;

  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

// ---------------------------------------------------------------------------
// Credential resolution — workspace BYOK overrides env defaults.
// ---------------------------------------------------------------------------

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
      anthropicApiKey:
        tryDecryptSecret(row.anthropicApiKeyEnc) || ENV.anthropicApiKey,
      openaiApiKey: tryDecryptSecret(row.openaiApiKeyEnc) || ENV.openaiApiKey,
      geminiApiKey: tryDecryptSecret(row.geminiApiKeyEnc) || ENV.geminiApiKey,
      anthropicModel: row.anthropicModel || DEFAULT_MODELS.anthropic,
      openaiModel: row.openaiModel || DEFAULT_MODELS.openai,
      geminiModel: row.geminiModel || DEFAULT_MODELS.gemini,
      defaultProvider: row.aiDefaultProvider || ENV.aiDefaultProvider,
    };
  } catch (err) {
    console.error("[llm] loadCreds failed, falling back to env:", err);
    return ENV_CREDS;
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function invokeViaAnthropic(
  params: InvokeParams,
  creds: ResolvedCreds
): Promise<InvokeResult> {
  if (!creds.anthropicApiKey) {
    throw new Error(
      "Anthropic API key is not configured (workspace or ANTHROPIC_API_KEY env)"
    );
  }
  // maxRetries 4 (SDK default 2): the SDK honors retry-after and backs off
  // exponentially on 429/5xx/529 — concurrent-connection 429s clear in
  // seconds once the semaphore has drained the burst, so a deeper retry
  // budget converts most of them into slow successes instead of failures.
  const client = new Anthropic({ apiKey: creds.anthropicApiKey, maxRetries: 4 });

  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    maxTokens,
    max_tokens,
    model,
    temperature,
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  } = params;

  const systemParts: string[] = [];
  const conversationMessages: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const parts = ensureArray(msg.content);
      systemParts.push(
        parts
          .map(p => (typeof p === "string" ? p : (p as TextContent).text ?? ""))
          .join("\n")
      );
    } else {
      const normalized = normalizeMessageOpenAI(msg);
      conversationMessages.push(
        normalized as unknown as Anthropic.MessageParam
      );
    }
  }

  const systemPrompt = systemParts.join("\n\n") || undefined;

  const anthropicTools: Anthropic.Tool[] | undefined =
    tools && tools.length > 0
      ? tools.map(t => ({
          name: t.function.name,
          description: t.function.description ?? "",
          input_schema: (t.function.parameters ?? {
            type: "object",
            properties: {},
          }) as Anthropic.Tool["input_schema"],
        }))
      : undefined;

  let anthropicToolChoice:
    | Anthropic.ToolChoiceAuto
    | Anthropic.ToolChoiceAny
    | Anthropic.ToolChoiceTool
    | undefined;
  const tc = toolChoice || tool_choice;
  if (tc && anthropicTools) {
    if (tc === "auto") {
      anthropicToolChoice = { type: "auto" };
    } else if (tc === "required") {
      anthropicToolChoice = { type: "any" };
    } else if (tc !== "none" && "name" in tc) {
      anthropicToolChoice = { type: "tool", name: tc.name };
    } else if (tc !== "none" && "type" in tc) {
      anthropicToolChoice = {
        type: "tool",
        name: (tc as ToolChoiceExplicit).function.name,
      };
    }
  }

  // Anthropic has no OpenAI-style `response_format`. When the caller asked
  // for json_schema output and supplied no tools of its own, synthesise a
  // single forced tool from the schema — the model's tool_use input then IS
  // the structured JSON. Without this every json_schema call (the whole ARE
  // agent suite, etc.) got prose back and the caller's JSON.parse threw.
  const structuredFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  });
  const STRUCTURED_TOOL_NAME = "respond_with_structured_output";
  // Both json_schema (typed) and json_object (free-form) callers need forcing on
  // Anthropic — json_object has no OpenAI-style equivalent, so without this the
  // model returns prose and the caller's JSON.parse throws. Synthesize a forced
  // tool: json_schema uses the caller's schema; json_object uses a permissive
  // object so the tool_use input IS the requested JSON.
  const wantsStructured =
    structuredFormat?.type === "json_schema" || structuredFormat?.type === "json_object";
  const useStructuredTool =
    wantsStructured && (!anthropicTools || anthropicTools.length === 0);

  const structuredInputSchema: Anthropic.Tool["input_schema"] =
    structuredFormat?.type === "json_schema"
      ? ((structuredFormat as { json_schema: JsonSchema }).json_schema.schema as Anthropic.Tool["input_schema"])
      : ({ type: "object", additionalProperties: true } as Anthropic.Tool["input_schema"]);

  const effectiveTools: Anthropic.Tool[] | undefined = useStructuredTool
    ? [
        {
          name: STRUCTURED_TOOL_NAME,
          description:
            structuredFormat?.type === "json_schema"
              ? "Return the response strictly as JSON matching the provided schema."
              : "Return the response strictly as a single JSON object.",
          input_schema: structuredInputSchema,
        },
      ]
    : anthropicTools;
  const effectiveToolChoice = useStructuredTool
    ? ({ type: "tool", name: STRUCTURED_TOOL_NAME } as Anthropic.ToolChoiceTool)
    : anthropicToolChoice;

  const requestedMaxTokens =
    maxTokens ?? max_tokens ?? (useStructuredTool ? 8192 : 4096);

  const response = await client.messages.create({
    model: model ?? creds.anthropicModel,
    max_tokens: requestedMaxTokens,
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: conversationMessages,
    ...(effectiveTools ? { tools: effectiveTools } : {}),
    ...(effectiveToolChoice ? { tool_choice: effectiveToolChoice } : {}),
  });

  const textBlocks = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map(b => b.text)
    .join("");

  // When we forced the structured-output tool, the tool_use input IS the
  // result — surface it as the message content so callers can JSON.parse it.
  const structuredBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === STRUCTURED_TOOL_NAME,
  );
  const textContent =
    useStructuredTool && structuredBlock
      ? JSON.stringify(structuredBlock.input)
      : textBlocks;

  const toolCalls: ToolCall[] = response.content
    .filter(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name !== STRUCTURED_TOOL_NAME,
    )
    .map(b => ({
      id: b.id,
      type: "function" as const,
      function: {
        name: b.name,
        arguments: JSON.stringify(b.input),
      },
    }));

  return {
    id: response.id,
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textContent,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: response.stop_reason ?? null,
      },
    ],
    usage: {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens:
        response.usage.input_tokens + response.usage.output_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI (native — no proxy)
// ---------------------------------------------------------------------------

async function invokeViaOpenAI(
  params: InvokeParams,
  creds: ResolvedCreds
): Promise<InvokeResult> {
  if (!creds.openaiApiKey) {
    throw new Error(
      "OpenAI API key is not configured (workspace or OPENAI_API_KEY env)"
    );
  }

  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
    maxTokens,
    max_tokens,
    model,
    temperature,
  } = params;

  const payload: Record<string, unknown> = {
    model: model ?? creds.openaiModel,
    messages: messages.map(normalizeMessageOpenAI),
    max_tokens: maxTokens ?? max_tokens ?? 4096,
  };

  if (typeof temperature === "number") {
    payload.temperature = temperature;
  }

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const normalizedToolChoice = normalizeToolChoiceOpenAI(
    toolChoice || tool_choice,
    tools
  );
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }

  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  });
  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${creds.openaiApiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenAI invoke failed: ${response.status} ${response.statusText} – ${errorText}`
    );
  }

  return (await response.json()) as InvokeResult;
}

// ---------------------------------------------------------------------------
// Google Gemini (native generateContent REST API)
// ---------------------------------------------------------------------------

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

/**
 * Strip JSON-Schema keywords that Gemini's `responseSchema` rejects.
 *
 * Our callers write OpenAI-flavoured strict schemas (`additionalProperties:
 * false`, `$schema`, `$defs`, etc.). Gemini's structured-output endpoint
 * only accepts an OpenAPI 3.0 subset and throws 400 "Unknown name
 * 'additionalProperties' …" on anything else. We deep-clone the schema and
 * drop the unsupported keys so the same callsite works across providers.
 */
function sanitizeSchemaForGemini(input: unknown): unknown {
  const UNSUPPORTED = new Set([
    "additionalProperties",
    "$schema",
    "$id",
    "$ref",
    "$defs",
    "definitions",
    "strict",
    "patternProperties",
    "unevaluatedProperties",
    "const",
    "examples",
    "default",
  ]);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (UNSUPPORTED.has(k)) continue;
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  };
  return walk(input);
}

async function invokeViaGemini(
  params: InvokeParams,
  creds: ResolvedCreds
): Promise<InvokeResult> {
  if (!creds.geminiApiKey) {
    throw new Error(
      "Gemini API key is not configured (workspace or GEMINI_API_KEY env)"
    );
  }

  const {
    messages,
    maxTokens,
    max_tokens,
    model,
    temperature,
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  } = params;

  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    const partsAsText = ensureArray(msg.content)
      .map(p => {
        if (typeof p === "string") return p;
        if (p.type === "text") return p.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");

    if (msg.role === "system") {
      systemParts.push(partsAsText);
      continue;
    }

    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: partsAsText }],
    });
  }

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: maxTokens ?? max_tokens ?? 4096,
  };
  if (typeof temperature === "number") {
    generationConfig.temperature = temperature;
  }

  // JSON mode
  const fmt = responseFormat || response_format;
  const schema = outputSchema || output_schema;
  if (fmt?.type === "json_object" || fmt?.type === "json_schema" || schema) {
    generationConfig.responseMimeType = "application/json";
    if (fmt?.type === "json_schema") {
      generationConfig.responseSchema = sanitizeSchemaForGemini(fmt.json_schema.schema);
    } else if (schema) {
      generationConfig.responseSchema = sanitizeSchemaForGemini(schema.schema);
    }
  }

  const payload: Record<string, unknown> = {
    contents,
    generationConfig,
  };
  if (systemParts.length > 0) {
    payload.systemInstruction = {
      role: "system",
      parts: [{ text: systemParts.join("\n\n") }],
    };
  }

  const chosenModel = model ?? creds.geminiModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    chosenModel
  )}:generateContent?key=${encodeURIComponent(creds.geminiApiKey)}`;

  // Retry transient Gemini failures (503 "model overloaded", 429 quota,
  // 500 server error) with exponential backoff. These are not bugs in our
  // payload — Google's model just goes down for seconds at a time, and
  // the prior behavior was to surface the raw error on the prospect row
  // and require the user to manually retry. Three attempts: 0s, 1s, 3s.
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  let response!: Response;
  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.ok) break;
    lastError = await response.text();
    if (!RETRYABLE.has(response.status) || attempt === MAX_ATTEMPTS - 1) break;
    const delayMs = attempt === 0 ? 1000 : 3000;
    await new Promise((r) => setTimeout(r, delayMs));
  }

  if (!response.ok) {
    throw new Error(
      `Gemini invoke failed: ${response.status} ${response.statusText} – ${lastError}`
    );
  }

  type GeminiResponse = {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }>; role?: string };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };

  const data = (await response.json()) as GeminiResponse;
  const candidate = data.candidates?.[0];
  const text =
    candidate?.content?.parts?.map(p => p.text ?? "").join("") ?? "";

  return {
    id: `gemini-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model: chosenModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: candidate?.finishReason ?? null,
      },
    ],
    usage: {
      prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

function resolveProvider(
  explicit: ProviderName | undefined,
  creds: ResolvedCreds
): ProviderName {
  if (explicit) return explicit;
  const preferred = (creds.defaultProvider ?? "").toLowerCase();
  if (preferred === "openai" && creds.openaiApiKey) return "openai";
  if (preferred === "gemini" && creds.geminiApiKey) return "gemini";
  if (preferred === "anthropic" && creds.anthropicApiKey) return "anthropic";

  // Fallback order: Anthropic → OpenAI → Gemini.
  if (creds.anthropicApiKey) return "anthropic";
  if (creds.openaiApiKey) return "openai";
  if (creds.geminiApiKey) return "gemini";

  throw new Error(
    "No AI provider configured. Set a workspace key in Settings → Integrations, or ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY in env."
  );
}

/**
 * Per-USER burst ceiling for interactive LLM calls.
 *
 * 47 invokeLLM call sites across 22 routers had no ceiling of any kind, so any
 * signed-in user could drive arbitrary model spend as fast as they could send
 * requests. Enforced HERE rather than as a list of tRPC paths in the rate-limit
 * middleware: a path list has to be maintained, and the 48th call site would
 * simply not be on it.
 *
 * Applied ONLY when there is a request user — an interactive call. Background
 * engines pass `workspaceId` explicitly and run with no request context, so
 * they are untouched; they carry their own per-feature daily caps
 * (taskAutopilotDailyCap and friends), which is the right control for them.
 *
 * A safety valve, not a business number: the repo already caps the PUBLIC LLM
 * path at 20/min, and this sits just above it because a signed-in user doing
 * bulk work legitimately bursts harder than an anonymous chat visitor.
 */
const LLM_BURST_WINDOW_MS = 60_000;
const LLM_BURST_MAX = 30;

/**
 * 🔴 THE ANONYMOUS HALF OF THE SAME CEILING.
 *
 * `if (!userId) return` covered background jobs — but it also covered every
 * UNAUTHENTICATED caller, because `getRequestUserId()` is only ever set for a
 * signed-in request. So the public chat agent, which reaches `invokeLLM` through
 * `chatAgents.send` → `runChatTurn`, skipped this entirely. The only thing
 * bounding it was `METERED_PUBLIC_PROCEDURES` in `publicRateLimit.ts`: a
 * hand-written array of tRPC path substrings **with one entry in it**. Precisely
 * the maintenance hazard the note above refuses for the authenticated side.
 *
 * A request now always carries at least a client IP (base middleware in
 * `_core/trpc.ts`), so the funnel can key on that when there is no user. The
 * express limiter stays as a cheaper, earlier rejection for the one path it
 * knows about — defence in depth rather than the defence.
 *
 * ⚠️ AN IP IS A WEAKER KEY THAN A USER ID, and it is the strongest one an
 * anonymous request has. Visitors behind one corporate NAT share a bucket. The
 * public ceiling is set where that only bites a site sending 20 chat messages a
 * minute from a single egress IP, which is a better problem than unmetered
 * model spend on someone else's API key.
 */
const LLM_PUBLIC_BURST_MAX = 20;

/** Keyed `u:<userId>` or `ip:<addr>` so the two namespaces cannot collide. */
const llmBurst = new Map<string, number[]>();

function checkLlmBurst(
  userId: number | undefined,
  clientIp: string | undefined,
  now: number,
): void {
  // A signed-in user is the better key, so it wins when both are present.
  const key = userId ? `u:${userId}` : clientIp ? `ip:${clientIp}` : null;
  // Neither → no request context at all → a background job. Those carry their
  // own per-feature daily caps, and the monthly workspace budget still applies.
  if (!key) return;
  const max = userId ? LLM_BURST_MAX : LLM_PUBLIC_BURST_MAX;

  const hits = (llmBurst.get(key) ?? []).filter((t) => now - t < LLM_BURST_WINDOW_MS);
  if (hits.length >= max) {
    llmBurst.set(key, hits);
    throw new Error(
      `LLM rate limit: more than ${max} AI requests in a minute. Please wait a moment and try again.`,
    );
  }
  hits.push(now);
  llmBurst.set(key, hits);
  // The map is keyed and pruned on read, but a long-lived process with many
  // callers would still accumulate empty arrays. Cheap sweep when it grows.
  if (llmBurst.size > 500) {
    llmBurst.forEach((v, k) => {
      if (v.every((t: number) => now - t >= LLM_BURST_WINDOW_MS)) llmBurst.delete(k);
    });
  }
}

/** Test seam — the ceiling is process-local, so suites must be able to reset it. */
export function __resetLlmBurstForTests(): void {
  llmBurst.clear();
}

/**
 * Per-WORKSPACE monthly token budget.
 *
 * `workspace_settings.llmMonthlyTokenCap` is NULL by default, which means
 * unlimited — what a month's budget should be is a billing decision this
 * codebase cannot derive, and shipping a guessed number would cut workspaces
 * off mid-campaign on deploy (the fabrication refused in 974b903 / ff9e04d).
 * The mechanism ships off; the owner sets the number.
 *
 * Unlike the burst ceiling this DOES apply to background engines. A budget
 * that the autonomous engines are exempt from is not a budget — they are the
 * heaviest spenders in the system.
 *
 * Cached briefly so a per-call check does not become two queries per LLM call.
 * FAILS OPEN on a DB error: at that point the app is already broken, and
 * refusing every AI feature on top of it helps nobody.
 */
const CAP_CACHE_MS = 60_000;
const capCache = new Map<number, { at: number; cap: number | null; used: number }>();

async function checkMonthlyCap(workspaceId: number | undefined, now: number): Promise<void> {
  if (!workspaceId) return;
  const cached = capCache.get(workspaceId);
  let cap = cached?.cap ?? null;
  let used = cached?.used ?? 0;
  if (!cached || now - cached.at > CAP_CACHE_MS) {
    try {
      const db = await getDb();
      if (!db) return;
      const month = usageMonthKey();
      const [[settings], [counter]] = await Promise.all([
        db.select({ cap: workspaceSettings.llmMonthlyTokenCap })
          .from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)),
        db.select({ used: usageCounters.llmTokens })
          .from(usageCounters)
          .where(and(eq(usageCounters.workspaceId, workspaceId), eq(usageCounters.month, month))),
      ]);
      cap = settings?.cap ?? null;
      used = Number(counter?.used ?? 0);
      capCache.set(workspaceId, { at: now, cap, used });
    } catch (e) {
      console.error(`[usage] cap check failed for workspace ${workspaceId}:`, e instanceof Error ? e.message : String(e));
      return; // fail open
    }
  }
  if (cap !== null && cap > 0 && used >= cap) {
    throw new Error(
      `This workspace has reached its monthly AI budget (${used.toLocaleString()} of ${cap.toLocaleString()} tokens). ` +
        `Raise it in Settings → Billing, or wait for the next month.`,
    );
  }
}

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  // Resolution order for workspaceId:
  //   1. explicit params.workspaceId (background jobs, tests)
  //   2. async-local store set by workspaceProcedure middleware (every tRPC call)
  //   3. undefined → env-only credentials
  const workspaceId = params.workspaceId ?? getRequestWorkspaceId();

  // Both ceilings are checked BEFORE the provider call and before a
  // concurrency slot is taken — a limit enforced after the money is spent is
  // not a limit, and a refused call must not hold a slot others are queued on.
  const now = Date.now();
  checkLlmBurst(getRequestUserId(), getRequestClientIp(), now);
  await checkMonthlyCap(workspaceId, now);

  const creds = await loadCreds(workspaceId);
  const provider = resolveProvider(params.provider, creds);
  await acquireLlmSlot();
  let result: InvokeResult;
  try {
    switch (provider) {
      case "anthropic":
        result = await invokeViaAnthropic(params, creds);
        break;
      case "openai":
        result = await invokeViaOpenAI(params, creds);
        break;
      case "gemini":
        result = await invokeViaGemini(params, creds);
        break;
      default:
        throw new Error(`Unsupported provider: ${provider as string}`);
    }
  } finally {
    releaseLlmSlot();
  }
  // Metered HERE, at the one funnel every provider returns through, rather
  // than at each call site — there are dozens and a new one would simply not
  // be counted.
  await recordLlmTokens(workspaceId, result.usage?.total_tokens ?? 0);
  return result;
}
