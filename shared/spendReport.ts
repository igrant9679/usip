/**
 * spendReport.ts — the cost report's arithmetic (audit 2026-10-20, Phase 3
 * gate: a per-workspace cost report for AI, lookups and verification that
 * matches the vendors' own dashboards for a week).
 *
 * The vendors' usage pages count units per UTC day: tokens by model, Reoon
 * credits, QuickEnrich hits, WarmySender leads, Apollo API requests. So the
 * report does too, one line per vendor, unit, model and paying key, with a
 * column per day. Dollars are an ESTIMATE, shown only for models whose list
 * price is on file (shared/researchModels.ts and OTHER_MODEL_PRICES below,
 * read from Anthropic's pricing page): a made-up price would be worse than
 * none, and the units are what a vendor dashboard is checked against.
 */
import { RESEARCH_MODELS, WEB_SEARCH_USD, type Price } from "./researchModels";

export type SpendRowIn = {
  workspaceId: number;
  day: string;
  vendor: string;
  meter: string;
  model: string;
  keySource: string;
  feature: string;
  quantity: number;
  calls: number;
};

export type SpendLine = {
  vendor: string;
  meter: string;
  model: string;
  keySource: string;
  perDay: Record<string, number>;
  total: number;
  calls: number;
  /** USD at list price, or null when this unit has no price on file. */
  estUsd: number | null;
};

export type SpendFeature = { vendor: string; feature: string; meter: string; total: number };

export type SpendSummary = {
  days: string[];
  lines: SpendLine[];
  /** Where the units went, biggest first (tokens summed across input and output). */
  features: SpendFeature[];
  /** Total of every priced line. */
  estUsd: number;
};

/** The UTC days from `fromDay` through `toDay`, inclusive. */
export function dayRange(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${toDay}T00:00:00Z`);
  for (let t = Date.parse(`${fromDay}T00:00:00Z`); t <= end && out.length < 400; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * List prices for models the platform calls that are not Research choices,
 * USD per million tokens. claude-haiku-4-5 is the deployment's default model
 * (_core/llm.ts, _core/llmStream.ts): a call that names no model runs on it.
 * Read from Anthropic's pricing on 2026-10-27: $1 in, $5 out; a 5-minute cache
 * write is 1.25x input and a cache read 0.1x.
 */
const OTHER_MODEL_PRICES: Record<string, Price> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite5m: 1.25, cacheRead: 0.1 },
};

const PRICES: Record<string, Price> = {
  ...Object.fromEntries(Object.entries(RESEARCH_MODELS).map(([id, m]) => [id, m.price])),
  ...OTHER_MODEL_PRICES,
};

/** The price-table model a reported model id belongs to ("claude-opus-5-5-20261001" → "claude-opus-5-5"). */
export function pricedModel(model: string): string | null {
  const m = model.toLowerCase();
  return Object.keys(PRICES).find((id) => m === id || m.startsWith(`${id}-`)) ?? null;
}

/** USD for `quantity` of one meter, or null when there is no price on file for it. */
export function unitCostUsd(vendor: string, meter: string, model: string, quantity: number): number | null {
  if (vendor !== "anthropic") return null;
  if (meter === "web_searches") return quantity * WEB_SEARCH_USD;
  const id = pricedModel(model);
  if (!id) return null;
  const p = PRICES[id];
  const perMillion =
    meter === "input_tokens" ? p.input
      : meter === "output_tokens" ? p.output
        : meter === "cache_write_tokens" ? p.cacheWrite5m
          : meter === "cache_read_tokens" ? p.cacheRead
            : null;
  return perMillion === null ? null : (quantity * perMillion) / 1_000_000;
}

const TOKEN_METERS = new Set(["input_tokens", "output_tokens", "cache_write_tokens", "cache_read_tokens"]);

export function summarizeSpend(rows: SpendRowIn[], days: string[]): SpendSummary {
  const inRange = new Set(days);
  const lines = new Map<string, SpendLine>();
  const features = new Map<string, SpendFeature>();
  for (const r of rows) {
    if (!inRange.has(r.day)) continue;
    const key = [r.vendor, r.meter, r.model, r.keySource].join("\u0000");
    let line = lines.get(key);
    if (!line) {
      line = { vendor: r.vendor, meter: r.meter, model: r.model, keySource: r.keySource, perDay: {}, total: 0, calls: 0, estUsd: null };
      lines.set(key, line);
    }
    line.perDay[r.day] = (line.perDay[r.day] ?? 0) + r.quantity;
    line.total += r.quantity;
    line.calls += r.calls;

    const fMeter = TOKEN_METERS.has(r.meter) ? "tokens" : r.meter;
    const fKey = [r.vendor, r.feature, fMeter].join("\u0000");
    const f = features.get(fKey) ?? { vendor: r.vendor, feature: r.feature || "(unnamed)", meter: fMeter, total: 0 };
    f.total += r.quantity;
    features.set(fKey, f);
  }
  let estUsd = 0;
  const out = Array.from(lines.values());
  for (const l of out) {
    l.estUsd = unitCostUsd(l.vendor, l.meter, l.model, l.total);
    if (l.estUsd !== null) estUsd += l.estUsd;
  }
  out.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.model.localeCompare(b.model) || a.meter.localeCompare(b.meter) || a.keySource.localeCompare(b.keySource));
  return {
    days,
    lines: out,
    features: Array.from(features.values()).sort((a, b) => b.total - a.total),
    estUsd,
  };
}

/** How each vendor's unit is named in the report. */
export const METER_LABEL: Record<string, string> = {
  input_tokens: "Input tokens",
  output_tokens: "Output tokens",
  cache_write_tokens: "Cache write tokens",
  cache_read_tokens: "Cache read tokens",
  web_searches: "Web searches",
  daily_credits: "Daily credits (single, power)",
  instant_credits: "Instant credits (single, quick)",
  bulk_emails: "Bulk verification addresses",
  email_hits: "Emails delivered (1 credit each)",
  searches: "Search requests",
  leads: "Leads exported",
  profile_lookups: "Profile lookups",
};

export const VENDOR_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  reoon: "Reoon",
  quickenrich: "QuickEnrich",
  apollo: "Apollo",
  warmysender: "WarmySender",
  linkedin: "LinkedIn (Unipile)",
};
