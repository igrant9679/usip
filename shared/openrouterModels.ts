/**
 * OpenRouter's model list, read the same way on the server and on the
 * settings screen (owner decisions 2026-11-27, openrouter-spec.md).
 *
 * OpenRouter (https://openrouter.ai) is one key for many vendors' models, at
 * OpenAI's request shape. Its list (`GET /api/v1/models`, no key needed) says
 * per model which request parameters it takes. That is what decides:
 *
 *   - which models a workspace is OFFERED: in Velocity every tier and the
 *     default model carry structured work (scores, classifications, campaign
 *     targeting), so only a model that can give a structured answer is
 *     offered at all;
 *   - how a structured call is sent to the model it lands on
 *     (`openrouterMode`), and that a call never lands on a model that cannot
 *     answer it (server/_core/llm.ts swaps in the default model instead);
 *   - the default model: the newest Claude Sonnet in the list that takes
 *     tools, read from the live list, never written down as a guess.
 *
 * Pure: the fetch and its cache are server/services/openrouterModels.ts.
 */

export type OpenRouterModel = {
  id: string;
  name: string;
  /** Unix seconds, as OpenRouter lists it: how "newest" is decided. */
  created: number;
  contextLength: number | null;
  /** USD per million tokens; null when OpenRouter lists no fixed price (a router). */
  promptPerMillion: number | null;
  completionPerMillion: number | null;
  supportedParameters: string[];
};

/**
 * The default when the live list cannot be read: the newest Claude Sonnet
 * that takes tools in OpenRouter's list, read from it on 2026-11-27. At run
 * time the live list decides (defaultOpenRouterModel); this is only the
 * answer while OpenRouter's list is unreachable.
 */
export const OPENROUTER_FALLBACK_MODEL = "anthropic/claude-sonnet-5.5";

const perMillion = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1_000_000 * 1_000_000) / 1_000_000;
};

/**
 * OpenRouter's `/models` answer as the models a Velocity text call can use:
 * text out only (image, audio and video generation stay on their own
 * providers), no `:batch` variants (they are not answered interactively).
 * Anything malformed is dropped rather than guessed at.
 */
export function parseOpenRouterModels(raw: unknown): OpenRouterModel[] {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: OpenRouterModel[] = [];
  for (const m of data as Array<Record<string, any>>) {
    const id = typeof m?.id === "string" ? m.id.trim() : "";
    if (!id || id.endsWith(":batch")) continue;
    const outputs = m?.architecture?.output_modalities;
    if (Array.isArray(outputs) && outputs.some((o: unknown) => o !== "text")) continue;
    out.push({
      id,
      name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : id,
      created: Number.isFinite(Number(m.created)) ? Number(m.created) : 0,
      contextLength: Number.isFinite(Number(m.context_length)) && Number(m.context_length) > 0 ? Number(m.context_length) : null,
      promptPerMillion: perMillion(m?.pricing?.prompt),
      completionPerMillion: perMillion(m?.pricing?.completion),
      supportedParameters: Array.isArray(m.supported_parameters) ? m.supported_parameters.filter((p: unknown): p is string => typeof p === "string") : [],
    });
  }
  return out;
}

/** What a call needs from the model: its own tools, a JSON object matching a schema, or any JSON object. */
export type OpenRouterNeed = "tools" | "json_schema" | "json_object";

/**
 * How a call is sent to a model, from what the model's listing says it takes:
 *
 *   tools         the caller's own tools (its tool call is its structure)
 *   forced_tool   one synthesised tool whose arguments ARE the JSON, forced
 *                 with tool_choice: the way the Anthropic path has always
 *                 asked Claude for JSON, so the default model answers here
 *                 the way it answers there
 *   offered_tool  the same tool, offered, with the system prompt saying to
 *                 call it: for a model that takes tools but not tool_choice
 *   json_schema   response_format json_schema (the model's own strict mode)
 *   json_object   response_format json_object, with the schema written into
 *                 the system prompt, as the DeepSeek path does
 *
 * null: the model cannot give this answer, so the call must not go to it.
 */
export type OpenRouterMode = "tools" | "forced_tool" | "offered_tool" | "json_schema" | "json_object";

export function openrouterMode(supported: readonly string[], need: OpenRouterNeed): OpenRouterMode | null {
  const has = (p: string) => supported.includes(p);
  if (need === "tools") return has("tools") ? "tools" : null;
  if (has("tools")) return has("tool_choice") ? "forced_tool" : "offered_tool";
  if (need === "json_schema" && has("structured_outputs")) return "json_schema";
  if (has("response_format") || has("structured_outputs")) return "json_object";
  return null;
}

/** True for a model a structured call may use: it can return JSON that matches a schema. */
export function canAnswerStructured(m: Pick<OpenRouterModel, "supportedParameters">): boolean {
  return openrouterMode(m.supportedParameters, "json_schema") !== null;
}

/** The filter for every OpenRouter picker in Velocity: models that can give structured answers. */
export function modelsForStructuredAnswers<T extends Pick<OpenRouterModel, "supportedParameters">>(models: readonly T[]): T[] {
  return models.filter(canAnswerStructured);
}

/**
 * The newest Claude Sonnet that takes tools, or null when the list has none.
 * Ids are OpenRouter's (`anthropic/claude-sonnet-…`); a variant with a
 * `:suffix` is not the model itself and is passed over.
 */
export function defaultOpenRouterModel<T extends Pick<OpenRouterModel, "id" | "created" | "supportedParameters">>(models: readonly T[]): T | null {
  let best: T | null = null;
  for (const m of models) {
    if (!m.id.startsWith("anthropic/claude-sonnet") || m.id.includes(":")) continue;
    if (!m.supportedParameters.includes("tools")) continue;
    if (!best || m.created > best.created) best = m;
  }
  return best;
}

const usd = (n: number): string => (n === 0 ? "$0" : n < 0.01 ? `$${n.toPrecision(2)}` : `$${n.toFixed(2)}`);

/** "$2.00 in · $10.00 out per 1M tokens", "Free", or "Price varies". */
export function priceLabel(m: Pick<OpenRouterModel, "promptPerMillion" | "completionPerMillion">): string {
  if (m.promptPerMillion === null || m.completionPerMillion === null) return "Price varies";
  if (m.promptPerMillion === 0 && m.completionPerMillion === 0) return "Free";
  return `${usd(m.promptPerMillion)} in · ${usd(m.completionPerMillion)} out per 1M tokens`;
}
