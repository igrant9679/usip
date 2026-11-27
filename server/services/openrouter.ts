/**
 * OpenRouter, the fifth AI provider (owner decisions 2026-11-27,
 * openrouter-spec.md): its address, the headers every request carries, its
 * errors in words, its model list (cached) and the key check run when a key
 * is saved. The calls themselves go through the one model funnel,
 * server/_core/llm.ts (invokeLLM) and server/_core/llmStream.ts (streamLLM),
 * which meter and budget them like every other provider's.
 *
 * Checked against https://openrouter.ai/docs on 2026-11-27:
 *   - chat at POST /api/v1/chat/completions, OpenAI's request shape, Bearer key
 *   - GET /api/v1/models needs no key; each model lists supported_parameters
 *   - GET /api/v1/key reports the key's limit, what is left and what it used
 *   - usage (with `cost`, in credits = USD) comes back on every response;
 *     the old `usage: {include: true}` switch is deprecated and does nothing
 *   - errors are {error: {code, message, metadata}}, and a 200 can still carry
 *     one (a provider failed after accepting the request)
 *   - optional attribution: HTTP-Referer (the app's URL) and X-Title (its name)
 */
import { appBaseUrl } from "../appUrl";
import {
  OPENROUTER_FALLBACK_MODEL,
  defaultOpenRouterModel,
  parseOpenRouterModels,
  type OpenRouterModel,
} from "@shared/openrouterModels";

export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
export const OPENROUTER_CHAT_URL = `${OPENROUTER_API_BASE}/chat/completions`;
export const OPENROUTER_MODELS_URL = `${OPENROUTER_API_BASE}/models`;
export const OPENROUTER_KEY_URL = `${OPENROUTER_API_BASE}/key`;

/**
 * The headers of every OpenRouter request. The two attribution headers name
 * the app (its public origin, server/appUrl.ts, and "Velocity") and nothing
 * else: no member's name, email or workspace ever goes in a header.
 */
export function openrouterHeaders(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": appBaseUrl(),
    "X-Title": "Velocity",
  };
}

/* ─── Errors ────────────────────────────────────────────────────────────── */

/** Whose key a request went out on, for the words of an error. */
export type OpenRouterKeyWhose = "workspace" | "shared" | null;

const keyName = (whose: OpenRouterKeyWhose) =>
  whose === "shared" ? "the platform's shared OpenRouter key" : whose === "workspace" ? "this workspace's OpenRouter key" : "this OpenRouter key";

/**
 * OpenRouter's own words from an error body. When a provider behind it
 * failed, the message is a generic "Provider returned error" and the
 * provider's answer is in metadata.raw, so that is added.
 */
export function openrouterErrorText(body: unknown): string {
  let err: { message?: unknown; metadata?: { raw?: unknown; provider_name?: unknown } } | undefined;
  if (typeof body === "string") {
    try {
      err = (JSON.parse(body) as { error?: typeof err })?.error;
    } catch {
      return body.trim().slice(0, 300) || "no message";
    }
  } else {
    err = (body as { error?: typeof err } | null)?.error;
  }
  const message = typeof err?.message === "string" && err.message.trim() ? err.message.trim() : "no message";
  const raw = err?.metadata?.raw;
  const rawText = typeof raw === "string" ? raw : raw != null ? JSON.stringify(raw) : "";
  const provider = typeof err?.metadata?.provider_name === "string" ? ` (${err.metadata.provider_name})` : "";
  return rawText && !message.includes(rawText) ? `${message}${provider}: ${rawText.slice(0, 300)}` : message;
}

/**
 * A failed OpenRouter request as an Error carrying its status, so a
 * background job can tell a transient failure (429, 5xx: retried before this
 * is thrown) from a hard one (isRetryableLLMError in _core/llm.ts).
 */
export function openrouterFailure(status: number, statusText: string, body: unknown, whose: OpenRouterKeyWhose): Error & { status: number } {
  const said = openrouterErrorText(body);
  const message =
    status === 401
      ? `OpenRouter refused ${keyName(whose)} (401: ${said}). The key is wrong or has been revoked.`
      : status === 402
        ? `OpenRouter says ${keyName(whose)} is out of credit (402: ${said}). Add credit at openrouter.ai, or raise the key's limit.`
        : status === 429
          ? `OpenRouter is rate limiting ${keyName(whose)} (429: ${said}). Try again in a moment.`
          : `OpenRouter request failed (${status}${statusText ? ` ${statusText}` : ""}: ${said})`;
  return Object.assign(new Error(message), { status });
}

/** Statuses worth another try: timeout, rate limit, and the provider side being down. */
export const OPENROUTER_RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/* ─── The model list ────────────────────────────────────────────────────── */

/** "A few hours" (spec): the list changes when OpenRouter adds a model, not by the minute. */
const MODELS_TTL_MS = 3 * 60 * 60 * 1000;

export type OpenRouterModelList = {
  models: OpenRouterModel[];
  /** When the list was read (ms), or null when it never has been. */
  fetchedAt: number | null;
  /** Why the latest read failed, or null. A stale list is still served beside it. */
  error: string | null;
};

let cache: { at: number; models: OpenRouterModel[] } | null = null;
let lastError: string | null = null;
let inflight: Promise<OpenRouterModelList> | null = null;

/** Test seam: the list is cached per process. */
export function __resetOpenRouterModelsForTests(): void {
  cache = null;
  lastError = null;
  inflight = null;
}

/**
 * OpenRouter's models, read at most every three hours. A failed read keeps
 * the last good list and says why; with no list at all it returns none and
 * the reason, never a made-up list.
 */
export async function getOpenRouterModels(now: number = Date.now()): Promise<OpenRouterModelList> {
  if (cache && now - cache.at < MODELS_TTL_MS) return { models: cache.models, fetchedAt: cache.at, error: null };
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(OPENROUTER_MODELS_URL, { headers: { "HTTP-Referer": appBaseUrl(), "X-Title": "Velocity" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`OpenRouter's model list answered ${res.status}: ${openrouterErrorText(await res.text().catch(() => ""))}`);
      const models = parseOpenRouterModels(await res.json());
      if (models.length === 0) throw new Error("OpenRouter's model list came back empty");
      cache = { at: now, models };
      lastError = null;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.error(`[openrouter] could not read the model list: ${lastError}`);
    } finally {
      inflight = null;
    }
    return { models: cache?.models ?? [], fetchedAt: cache?.at ?? null, error: lastError };
  })();
  return inflight;
}

/**
 * One model's listing. `known: false` means the list could not be read, so
 * nothing can be said about the model either way (the caller then sends the
 * request as it stands and lets OpenRouter answer).
 */
export async function lookupOpenRouterModel(id: string): Promise<{ known: boolean; model: OpenRouterModel | null }> {
  const list = await getOpenRouterModels();
  if (list.models.length === 0) return { known: false, model: null };
  return { known: true, model: list.models.find((m) => m.id === id) ?? null };
}

/** The default model's id: the newest Claude Sonnet that takes tools, from the live list. */
export async function defaultOpenRouterModelId(): Promise<string> {
  const list = await getOpenRouterModels();
  return defaultOpenRouterModel(list.models)?.id ?? OPENROUTER_FALLBACK_MODEL;
}

/* ─── The key check ─────────────────────────────────────────────────────── */

/**
 * What a key check reports. Not the key's label: OpenRouter's default label
 * is the key itself, shortened, and no part of a key goes to a browser.
 */
export type OpenRouterKeyInfo = {
  /** The key's credit limit in USD, or null: no limit set on the key. */
  limit: number | null;
  /** What is left under that limit, or null: no limit. */
  limitRemaining: number | null;
  /** Credits (USD) the key has used, all time. */
  usage: number | null;
  isFreeTier: boolean;
};

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Asks OpenRouter about a key (GET /api/v1/key): valid or not, and its
 * credit when a limit is set. Throws OpenRouter's own message when the key
 * is refused. Nothing about the key is logged.
 */
export async function checkOpenRouterKey(apiKey: string, whose: OpenRouterKeyWhose = null): Promise<OpenRouterKeyInfo> {
  let res: Response;
  try {
    res = await fetch(OPENROUTER_KEY_URL, { method: "GET", headers: openrouterHeaders(apiKey), signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Error(`Could not reach OpenRouter to check the key: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw openrouterFailure(res.status, res.statusText, await res.text().catch(() => ""), whose);
  const data = ((await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null)?.data ?? {};
  return {
    limit: numOrNull(data.limit),
    limitRemaining: numOrNull(data.limit_remaining),
    usage: numOrNull(data.usage),
    isFreeTier: data.is_free_tier === true,
  };
}
