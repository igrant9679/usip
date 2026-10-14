/**
 * researchModels.ts — the models the Research engine may run on, their prices,
 * and the cost of a run.
 *
 * Owner decision 2026-10-14: research runs on Claude Opus 5.5 with web search
 * by default, on the workspace's own Anthropic key; admins pick the model.
 *
 * Prices are Anthropic's published list prices in USD, read from
 * https://platform.claude.com/docs/en/about-claude/pricing on 2026-10-14.
 * Web search is $10 per 1,000 searches; web fetch has no charge beyond the
 * tokens it adds. If Anthropic changes a price, change it here: every cost
 * the Research pages show is computed from this table, and a run records the
 * model it used so an old run's cost stays what it was.
 */

export type ResearchModelId = "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-haiku-5-5";

/** USD per million tokens. `over100k` is the price tier for a request whose prompt exceeds 100,000 tokens. */
type Price = { input: number; output: number; cacheWrite5m: number; cacheRead: number };

export const RESEARCH_MODELS: Record<ResearchModelId, { label: string; note: string; price: Price; over100k?: Price }> = {
  "claude-opus-5-5": {
    label: "Claude Opus 5.5",
    note: "Most thorough. The default.",
    price: { input: 4, output: 20, cacheWrite5m: 5, cacheRead: 0.2 },
  },
  "claude-sonnet-5-5": {
    label: "Claude Sonnet 5.5",
    note: "About half the cost of Opus.",
    price: { input: 2, output: 10, cacheWrite5m: 2.5, cacheRead: 0.1 },
  },
  "claude-haiku-5-5": {
    label: "Claude Haiku 5.5",
    note: "Cheapest; lighter research.",
    price: { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheRead: 0.01 },
    over100k: { input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheRead: 0.05 },
  },
};

export const DEFAULT_RESEARCH_MODEL: ResearchModelId = "claude-opus-5-5";
export const DEFAULT_RESEARCH_DAILY_RUNS = 10;
export const MAX_RESEARCH_DAILY_RUNS = 50;
export const WEB_SEARCH_USD = 0.01;

export function isResearchModel(v: unknown): v is ResearchModelId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(RESEARCH_MODELS, v);
}

export function researchModelOf(v: unknown): ResearchModelId {
  return isResearchModel(v) ? v : DEFAULT_RESEARCH_MODEL;
}

/** One API response's usage, as Anthropic reports it. */
export type ResearchUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null; web_fetch_requests?: number | null } | null;
};

/** The cost of one API response, in USD. */
export function requestCostUsd(model: ResearchModelId, u: ResearchUsage): number {
  const m = RESEARCH_MODELS[model];
  const input = u.input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const p = m.over100k && input + write + read > 100_000 ? m.over100k : m.price;
  const tokens = (input * p.input + (u.output_tokens ?? 0) * p.output + write * p.cacheWrite5m + read * p.cacheRead) / 1_000_000;
  return tokens + (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
}

export const formatUsd = (n: number | string | null | undefined): string => {
  const v = Number(n ?? 0);
  return v > 0 && v < 0.01 ? "<$0.01" : `$${v.toFixed(2)}`;
};
