import Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";
import { usageCounters, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { tryDecryptSecret } from "./crypto";
import { linkedKey, linkedKeys } from "../services/keyShares";
import { deepseekSettings } from "../services/deepseekSettings";
import { ENV } from "./env";
import { getRequestClientIp, getRequestFeature, getRequestUserId, getRequestWorkspaceId, isBackgroundWork } from "./requestContext";
import { recordLlmTokens, usageMonthKey } from "../usageCounters";
import { recordAiUsage, type KeySource } from "../services/spend";
import { applyTier } from "../services/aiTiers";
import type { AiProviderId, AiTask } from "@shared/aiTiers";

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

/**
 * The text of a reply's content. Providers answer with a string; the type
 * also allows content parts, so a parts array is joined. JSON.parse and the
 * database took the union as if it were always a string.
 */
export function contentText(content: MessageContent | MessageContent[] | null | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  const parts = Array.isArray(content) ? content : [content];
  return parts.map((p) => (typeof p === "string" ? p : p.type === "text" ? p.text : "")).join("");
}

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

/** The providers a call can run on: one list, shared with the settings screen (shared/aiTiers.ts). */
export type ProviderName = AiProviderId;

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
  /**
   * PROSPECT-FACING COPY: append the sender's brand (company facts and voice,
   * services/brandContext) to the system prompt, for the resolved workspace.
   * Set by every writer whose output is emailed, messaged, spoken, put in an
   * invite or a client-facing proposal (owner ask 2026-09-24: all AI
   * communications informed by each workspace's own messaging). Writers that
   * already build the brand block themselves leave it off, as do internal
   * calls (scoring, research, classification, summaries for the rep).
   */
  sendersBrand?: boolean;
  /**
   * THE PROSPECT'S MARKET: append the workspace's own research on the market
   * this writing is for (services/research/context, Research phase 3, owner
   * 2026-10-14). Say what the writer knows — the ARE campaign, the persona,
   * the prospect's title, the account's industry — and what it writes (the
   * surface); the composer picks the sector and persona and sizes the block.
   * Nothing matches, or the workspace has no research: nothing is added and
   * the writer behaves as before. Every writer either sets this or is listed
   * with a reason in server/researchCoverage.test.ts.
   */
  research?: import("../services/research/context").ResearchUse;
  /**
   * What this call is for, in the spend report (services/spend). Defaults to
   * the tRPC path of the request, else "background"; engines name themselves.
   */
  feature?: string;
  /**
   * The KIND of work this call is (shared/aiTiers.ts): it picks the tier, and
   * so the model, the workspace has set for that kind of work. Every call
   * names one (server/aiTiers.test.ts). A workspace with no tiers set ignores
   * it and uses its default model, as every call did before 2026-11-16.
   * A call that names its own `provider` or `model` is left alone.
   */
  task?: AiTask;
  /**
   * Run this call that many tiers above its task's tier, when the workspace
   * has a model set there. For a turn that turned out harder than its kind
   * of work usually is: Elsie, once she has looked things up.
   */
  stepUp?: number;
};

type ResolvedCreds = {
  anthropicApiKey: string;
  openaiApiKey: string;
  geminiApiKey: string;
  deepseekApiKey: string;
  anthropicModel: string;
  openaiModel: string;
  geminiModel: string;
  deepseekModel: string;
  defaultProvider: string;
  /** Whose account each provider's key bills: the workspace's own, or the deployment's env key. */
  sources: Record<ProviderName, KeySource>;
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
    /** Anthropic prompt caching, billed at their own rates (not in total_tokens). */
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
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
  // DeepSeek's low-cost model id (their model list, read 2026-11-16).
  deepseek: "deepseek-flash",
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
  deepseekApiKey: ENV.deepseekApiKey,
  anthropicModel: DEFAULT_MODELS.anthropic,
  openaiModel: DEFAULT_MODELS.openai,
  geminiModel: DEFAULT_MODELS.gemini,
  deepseekModel: DEFAULT_MODELS.deepseek,
  defaultProvider: ENV.aiDefaultProvider,
  sources: { anthropic: "shared", openai: "shared", gemini: "shared", deepseek: "shared" },
};

async function loadCreds(workspaceId?: number): Promise<ResolvedCreds> {
  if (!workspaceId) return ENV_CREDS;
  try {
    const db = await getDb();
    if (!db) return ENV_CREDS;
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

    // DeepSeek's key and model are read apart from the select above, and a
    // failed read there is "no DeepSeek key" (services/deepseekSettings).
    const deepseek = await deepseekSettings(workspaceId);
    const own = {
      anthropic: tryDecryptSecret(row.anthropicApiKeyEnc),
      openai: tryDecryptSecret(row.openaiApiKeyEnc),
      gemini: tryDecryptSecret(row.geminiApiKeyEnc),
      deepseek: tryDecryptSecret(deepseek.keyEnc),
    };
    // A key another workspace lends this one counts as its own for every
    // purpose here (services/keyShares): own first, then lent, then the env.
    const missing = (["anthropic", "openai", "gemini", "deepseek"] as const).filter((p) => !own[p]);
    if (missing.length > 0) {
      const lent = await linkedKeys(workspaceId, missing);
      for (const p of missing) if (lent[p]) own[p] = lent[p]!.key;
    }
    return {
      anthropicApiKey: own.anthropic || ENV.anthropicApiKey,
      openaiApiKey: own.openai || ENV.openaiApiKey,
      geminiApiKey: own.gemini || ENV.geminiApiKey,
      deepseekApiKey: own.deepseek || ENV.deepseekApiKey,
      anthropicModel: row.anthropicModel || DEFAULT_MODELS.anthropic,
      openaiModel: row.openaiModel || DEFAULT_MODELS.openai,
      geminiModel: row.geminiModel || DEFAULT_MODELS.gemini,
      deepseekModel: deepseek.model || DEFAULT_MODELS.deepseek,
      defaultProvider: row.aiDefaultProvider || ENV.aiDefaultProvider,
      sources: {
        anthropic: own.anthropic ? "workspace" : "shared",
        openai: own.openai ? "workspace" : "shared",
        gemini: own.gemini ? "workspace" : "shared",
        deepseek: own.deepseek ? "workspace" : "shared",
      },
    };
  } catch (err) {
    console.error("[llm] loadCreds failed, falling back to env:", err);
    return ENV_CREDS;
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

/** Models seen refusing a forced tool choice in this process; their calls go straight to "auto". */
const MODELS_REFUSING_FORCED_TOOL = new Set<string>();

export function __resetForcedToolMemoryForTests(): void {
  MODELS_REFUSING_FORCED_TOOL.clear();
}

/** The 400 a model gives when it does not accept tool_choice "tool" / "any". */
export function refusesForcedToolChoice(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return status === 400 && /tool_choice/i.test(msg) && /not supported for this model/i.test(msg);
}

/** The JSON object in a text reply (fenced or bare), re-serialised; null when there is none. */
export function jsonFromText(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const candidates = [fenced, text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    if (!c || !c.trim()) continue;
    try {
      const v = JSON.parse(c.trim());
      if (v && typeof v === "object" && !Array.isArray(v)) return JSON.stringify(v);
    } catch {
      // try the next form
    }
  }
  return null;
}

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

  // Some models refuse a FORCED tool choice: Claude Opus 5.5 answers
  // tool_choice "tool" or "any" with a 400 (found live 2026-10-14, Research
  // engine). Forcing is still tried first, since it is the stronger guarantee
  // where it works; on that refusal the same request goes again with the tool
  // offered ("auto") and the system prompt saying to call it, and the model is
  // remembered so its later calls skip the refused attempt.
  const resolvedModel = model ?? creds.anthropicModel;
  const forced = effectiveToolChoice?.type === "tool" || effectiveToolChoice?.type === "any";
  const callInstruction = !forced
    ? ""
    : effectiveToolChoice?.type === "tool"
      ? `Respond by calling the ${effectiveToolChoice.name} tool exactly once with the complete result. Do not answer in text.`
      : "Respond by calling one of the tools.";
  const send = (auto: boolean) =>
    client.messages.create({
      model: resolvedModel,
      max_tokens: requestedMaxTokens,
      ...(typeof temperature === "number" ? { temperature } : {}),
      ...(auto
        ? { system: [systemPrompt, callInstruction].filter(Boolean).join("\n\n") }
        : systemPrompt ? { system: systemPrompt } : {}),
      messages: conversationMessages,
      ...(effectiveTools ? { tools: effectiveTools } : {}),
      ...(effectiveToolChoice ? { tool_choice: auto ? ({ type: "auto" } as Anthropic.ToolChoiceAuto) : effectiveToolChoice } : {}),
    });
  let response: Anthropic.Message;
  if (forced && MODELS_REFUSING_FORCED_TOOL.has(resolvedModel)) {
    response = await send(true);
  } else {
    try {
      response = await send(false);
    } catch (err) {
      if (!forced || !refusesForcedToolChoice(err)) throw err;
      MODELS_REFUSING_FORCED_TOOL.add(resolvedModel);
      response = await send(true);
    }
  }

  const textBlocks = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map(b => b.text)
    .join("");

  // When we asked for the structured-output tool, the tool_use input IS the
  // result — surface it as the message content so callers can JSON.parse it.
  // A model that was only OFFERED the tool may answer with the JSON in text
  // instead; that is passed on as the JSON alone.
  const structuredBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === STRUCTURED_TOOL_NAME,
  );
  const textContent =
    useStructuredTool && structuredBlock
      ? JSON.stringify(structuredBlock.input)
      : useStructuredTool
        ? (jsonFromText(textBlocks) ?? textBlocks)
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
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
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
    // Clamped, not passed through: Gemini rejects a maxOutputTokens above the
    // model's own cap, and callers now size this to their work (the ARE
    // sequence calls ask for up to 16000 for a 14-step template). A clamp
    // turns "the request errors" into "the response may truncate", which
    // parseLlmJson reports with a readable message.
    maxOutputTokens: Math.min(8192, maxTokens ?? max_tokens ?? 4096),
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
// DeepSeek (OpenAI-format chat completions at api.deepseek.com)
// ---------------------------------------------------------------------------

export const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions";

/**
 * Sent on every DeepSeek request, here and in llmStream.
 *
 * DeepSeek THINKS unless a request turns it off (api-docs.deepseek.com, read
 * 2026-11-16), and with thinking on: a forced tool choice is a 400,
 * temperature is ignored, and every later request in a conversation that has
 * tools must carry the earlier reasoning back or it is a 400 too. Nothing
 * here does that, and callers size max_tokens for the answer alone. So it is
 * off, and a DeepSeek model answers the way the other three providers' do.
 */
export const DEEPSEEK_THINKING_OFF = { type: "disabled" } as const;

type DeepSeekUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

/**
 * DeepSeek's usage in this module's terms. Its prompt_tokens COUNTS the
 * cached part (hit + miss) and it bills the two at different prices, so the
 * hits go where Anthropic's cache reads go and only the misses are input.
 */
export function deepseekUsage(u: DeepSeekUsage | null | undefined): { input: number; output: number; cacheRead: number } {
  const hit = Math.max(0, Number(u?.prompt_cache_hit_tokens ?? 0));
  const prompt = Math.max(0, Number(u?.prompt_tokens ?? 0));
  const miss = u?.prompt_cache_miss_tokens != null ? Math.max(0, Number(u.prompt_cache_miss_tokens)) : Math.max(0, prompt - hit);
  return { input: miss, output: Math.max(0, Number(u?.completion_tokens ?? 0)), cacheRead: hit };
}

/** A message as DeepSeek takes it: text only, as the Gemini path sends it. */
function deepseekMessage(message: Message): Record<string, unknown> {
  if (message.role === "tool" || message.role === "function") return normalizeMessageOpenAI(message);
  const text = ensureArray(message.content)
    .map((p) => (typeof p === "string" ? p : p.type === "text" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
  return { role: message.role, ...(message.name ? { name: message.name } : {}), content: text };
}

/**
 * The request body. What differs from OpenAI's:
 *   - `thinking` is turned off (above).
 *   - response_format has "json_object" and NO "json_schema". A schema call
 *     goes as json_object with the schema written into the system prompt.
 *   - JSON output needs the word "json" somewhere in the prompt; a call that
 *     asks for a JSON object and never says the word has it said for it.
 * As on Anthropic, a call that brings its own tools is not also put in JSON
 * mode: its tool call is its structure.
 */
export function deepseekPayload(params: InvokeParams, model: string): { payload: Record<string, unknown>; wantsJson: boolean } {
  const messages = params.messages.map(deepseekMessage);
  const tools = params.tools && params.tools.length > 0 ? params.tools : undefined;
  const format = normalizeResponseFormat(params);
  const wantsJson = !tools && (format?.type === "json_schema" || format?.type === "json_object");

  if (wantsJson) {
    const instruction =
      format?.type === "json_schema"
        ? `Reply with one JSON object and nothing else. It must match this JSON schema:\n${JSON.stringify(format.json_schema.schema)}`
        : messages.some((m) => /json/i.test(String(m.content ?? "")))
          ? ""
          : "Reply with one JSON object and nothing else.";
    if (instruction) {
      const system = messages.find((m) => m.role === "system");
      if (system) system.content = `${String(system.content ?? "")}\n\n${instruction}`;
      else messages.unshift({ role: "system", content: instruction });
    }
  }

  const payload: Record<string, unknown> = {
    model,
    messages,
    max_tokens: params.maxTokens ?? params.max_tokens ?? (wantsJson ? 8192 : 4096),
    thinking: DEEPSEEK_THINKING_OFF,
  };
  if (typeof params.temperature === "number") payload.temperature = params.temperature;
  if (tools) {
    payload.tools = tools;
    const choice = normalizeToolChoiceOpenAI(params.toolChoice || params.tool_choice, tools);
    if (choice) payload.tool_choice = choice;
  }
  if (wantsJson) payload.response_format = { type: "json_object" };
  return { payload, wantsJson };
}

type DeepSeekResponse = {
  id?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { role?: string; content?: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: DeepSeekUsage;
};

async function invokeViaDeepSeek(
  params: InvokeParams,
  creds: ResolvedCreds
): Promise<InvokeResult> {
  if (!creds.deepseekApiKey) {
    throw new Error(
      "DeepSeek API key is not configured (workspace or DEEPSEEK_API_KEY env)"
    );
  }
  const model = params.model ?? creds.deepseekModel;
  const { payload, wantsJson } = deepseekPayload(params, model);

  // Overload and rate-limit answers clear in seconds; the same three tries,
  // 0s, 1s, 3s, the Gemini path makes. The error carries its status so a
  // background job can tell a transient failure from a hard one.
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const send = async (): Promise<DeepSeekResponse> => {
    let status = 0;
    let statusText = "";
    let errorText = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(DEEPSEEK_CHAT_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${creds.deepseekApiKey}`,
        },
        body: JSON.stringify(payload),
      });
      if (response.ok) return (await response.json()) as DeepSeekResponse;
      status = response.status;
      statusText = response.statusText;
      errorText = await response.text();
      if (!RETRYABLE.has(status) || attempt === 2) break;
      await new Promise((r) => setTimeout(r, attempt === 0 ? 1000 : 3000));
    }
    throw Object.assign(new Error(`DeepSeek invoke failed: ${status} ${statusText} – ${errorText}`), { status });
  };

  const blank = (d: DeepSeekResponse) => {
    const m = d.choices?.[0]?.message;
    return !m?.tool_calls?.length && !String(m?.content ?? "").trim();
  };

  let data = await send();
  let used = deepseekUsage(data.usage);
  // A JSON-mode reply the API could not read as JSON comes back as blank
  // content with finish_reason "stop". DeepSeek's documented remedy is to ask
  // again; once, and both requests are billed, so both are counted.
  if (wantsJson && blank(data)) {
    data = await send();
    const again = deepseekUsage(data.usage);
    used = { input: used.input + again.input, output: used.output + again.output, cacheRead: used.cacheRead + again.cacheRead };
  }

  return {
    id: data.id ?? `deepseek-${Date.now()}`,
    created: data.created ?? Math.floor(Date.now() / 1000),
    model: data.model ?? model,
    choices: (data.choices ?? []).map((c, i) => ({
      index: c.index ?? i,
      message: {
        role: "assistant" as const,
        content: c.message?.content ?? "",
        ...(c.message?.tool_calls?.length ? { tool_calls: c.message.tool_calls } : {}),
      },
      finish_reason: c.finish_reason ?? null,
    })),
    usage: {
      prompt_tokens: used.input,
      completion_tokens: used.output,
      total_tokens: used.input + used.output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: used.cacheRead,
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
  if (preferred === "deepseek" && creds.deepseekApiKey) return "deepseek";

  // Fallback order: Anthropic → OpenAI → Gemini → DeepSeek. DeepSeek is last:
  // a workspace reaches it unasked only when it is the one key there is.
  if (creds.anthropicApiKey) return "anthropic";
  if (creds.openaiApiKey) return "openai";
  if (creds.geminiApiKey) return "gemini";
  if (creds.deepseekApiKey) return "deepseek";

  throw new Error(
    "No AI provider configured. Set a workspace key in Settings → Integrations, or ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / DEEPSEEK_API_KEY in env."
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

export function checkLlmBurst(
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

export async function checkMonthlyCap(workspaceId: number | undefined, now: number): Promise<void> {
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
  if (params.sendersBrand && workspaceId) {
    const { withSendersBrand } = await import("../services/brandContext");
    params = { ...params, messages: await withSendersBrand(workspaceId, params.messages) };
  }
  if (params.research && workspaceId) {
    const { withResearch } = await import("../services/research/context");
    params = { ...params, messages: await withResearch(workspaceId, params.research, params.messages) };
  }

  // Both ceilings are checked BEFORE the provider call and before a
  // concurrency slot is taken — a limit enforced after the money is spent is
  // not a limit, and a refused call must not hold a slot others are queued on.
  const now = Date.now();
  // A persisted bulk job (services/jobs/runner) paces itself one item at a
  // time; holding it to the clicking user's per-minute ceiling is what made
  // a 50-row "Generate sequences" fail part-way (audit A37).
  if (!isBackgroundWork()) checkLlmBurst(getRequestUserId(), getRequestClientIp(), now);
  await checkMonthlyCap(workspaceId, now);

  const creds = await loadCreds(workspaceId);
  // The workspace's tier for this kind of work decides the model (unless the
  // caller named one, or no tier is set: then it is the default, as before).
  const routed = await applyTier(params, workspaceId, creds);
  const first = await callProvider(routed.params, creds, workspaceId);
  // A reply that had to be JSON and is not is a failed call: its caller will
  // throw or fall back. When the workspace has a stronger model set above
  // this tier, try once more there instead. Both calls were made, so both are
  // metered (inside callProvider).
  if (routed.canStepUp && failedItsFormat(routed.params, first)) {
    const higher = await applyTier(params, workspaceId, creds, (params.stepUp ?? 0) + 1);
    return callProvider(higher.params, creds, workspaceId);
  }
  return first;
}

/** True for a call that asked for JSON and got a reply with none in it. */
export function failedItsFormat(params: InvokeParams, result: InvokeResult): boolean {
  const format = params.responseFormat ?? params.response_format;
  const wantsJson = !!(params.outputSchema ?? params.output_schema) || (!!format && format.type !== "text");
  if (!wantsJson) return false;
  const msg = result.choices[0]?.message;
  if (msg?.tool_calls?.length) return false;
  return jsonFromText(contentText(msg?.content as MessageContent | MessageContent[] | null | undefined)) === null;
}

async function callProvider(params: InvokeParams, creds: ResolvedCreds, workspaceId: number | undefined): Promise<InvokeResult> {
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
      case "deepseek":
        result = await invokeViaDeepSeek(params, creds);
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
  // The spend ledger (audit Phase 3) splits the same call by meter, model and
  // whose key paid, so the report can match the provider's usage page. A
  // call with no workspace is still counted, as unattributed.
  await recordAiUsage({
    workspaceId,
    vendor: provider,
    model: result.model,
    keySource: creds.sources[provider],
    feature: params.feature ?? getRequestFeature() ?? "background",
    usage: {
      input: result.usage?.prompt_tokens,
      output: result.usage?.completion_tokens,
      cacheWrite: result.usage?.cache_creation_input_tokens,
      cacheRead: result.usage?.cache_read_input_tokens,
    },
  });
  return result;
}

// ---------------------------------------------------------------------------
// Research engine: Anthropic server tools (web search, web fetch)
// ---------------------------------------------------------------------------

/**
 * The workspace's OWN Anthropic key, or "" — never the server's.
 *
 * Research runs bill the workspace that asked (owner plan 2026-10-14), so,
 * unlike loadCreds, this does not fall back to ANTHROPIC_API_KEY: a workspace
 * without a key is told to add one rather than quietly spending the platform's.
 */
export async function workspaceAnthropicKey(workspaceId: number): Promise<string> {
  const db = await getDb();
  if (!db) return "";
  const [row] = await db
    .select({ enc: workspaceSettings.anthropicApiKeyEnc })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  // Its own key, or one another workspace lends it — still never the server's.
  return tryDecryptSecret(row?.enc) || (await linkedKey(workspaceId, "anthropic"));
}

/**
 * One Messages API request with server tools, streamed so the caller sees each
 * search and page read as it finishes (`onBlock`). For the Research engine
 * (services/research/engine.ts), which needs what invokeLLM hides: the raw
 * content blocks, the server-tool usage and `pause_turn`.
 *
 * Same ceilings and meter as invokeLLM: the monthly budget is checked first,
 * and the tokens are recorded. It does NOT take an invokeLLM concurrency slot:
 * a research request can run for minutes, and the app shares two slots; the
 * engine bounds its own concurrency instead.
 */
export async function runAnthropicServerTools(args: {
  workspaceId: number;
  /** For the spend report; "research" when unset. */
  feature?: string;
  params: Anthropic.MessageCreateParamsNonStreaming;
  onBlock?: (block: Anthropic.ContentBlock) => void;
  signal?: AbortSignal;
}): Promise<Anthropic.Message> {
  await checkMonthlyCap(args.workspaceId, Date.now());
  const apiKey = await workspaceAnthropicKey(args.workspaceId);
  if (!apiKey) {
    throw new Error("Research runs on this workspace's own Anthropic key. An admin can add one in Settings → Integrations → AI provider keys.");
  }
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 15 * 60_000 });
  const stream = client.messages.stream(args.params, { signal: args.signal });
  if (args.onBlock) stream.on("contentBlock", args.onBlock);
  const message = await stream.finalMessage();
  const u = message.usage;
  await recordLlmTokens(
    args.workspaceId,
    (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
  );
  await recordAiUsage({
    workspaceId: args.workspaceId,
    vendor: "anthropic",
    model: message.model,
    keySource: "workspace",
    feature: args.feature ?? "research",
    usage: {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheWrite: u.cache_creation_input_tokens,
      cacheRead: u.cache_read_input_tokens,
      webSearches: u.server_tool_use?.web_search_requests,
    },
  });
  return message;
}
