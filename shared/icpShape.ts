/**
 * icpShape.ts — the one reader for the ICP profile's list fields.
 *
 * `runIcpInference` (server/routers/are/icp.ts) stores each list as weighted
 * objects — targetTitles `[{title, seniority, role, weight}]`, targetIndustries
 * `[{industry, weight, examples}]`, targetGeographies `[{country, region,
 * weight}]`, targetTechStack `[{technology, signal_type, weight}]`,
 * antiPatterns `[{dimension, value, reason}]`, topConversionSignals
 * `[{signal, correlation_score}]` — while almost every reader assumed plain
 * strings (2026-10-14, Downstream's integration review): campaign discovery
 * fell back to them and crashed on `.trim()`, the deterministic scorer and the
 * vendor searches received "[object Object]", and the ICP page showed those
 * words and saved them back. The demo seed wrote plain strings, which hid it.
 *
 * Everything that reads an ICP list goes through here. It accepts the object
 * shape, plain strings, a JSON string of either, mixed rows and null, and it
 * drops the literal "[object Object]" that corrupted rows hold.
 */

export type IcpListKind = "title" | "industry" | "geography" | "technology" | "antiPattern" | "signal";

export type IcpWeighted = { label: string; weight: number | null; detail?: string };
export type IcpGeography = { country: string; region: string };

const CORRUPT = "[object Object]";

/** The list as an array, whatever form it was stored in. */
function listOf(value: unknown): unknown[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return [];
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [s];
  }
  return [];
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

function labelOf(item: unknown, kind: IcpListKind): string {
  if (typeof item === "string" || typeof item === "number") return str(item);
  if (!item || typeof item !== "object") return "";
  const o = item as Record<string, unknown>;
  switch (kind) {
    case "title": return str(o.title) || str(o.name);
    case "industry": return str(o.industry) || str(o.name);
    case "technology": return str(o.technology) || str(o.name);
    case "signal": return str(o.signal) || str(o.name);
    case "antiPattern": return str(o.value) || str(o.dimension);
    case "geography": {
      const region = str(o.region), country = str(o.country);
      return region && country ? `${region}, ${country}` : region || country;
    }
  }
}

function weightOf(item: unknown): number | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const w = typeof o.weight === "number" ? o.weight : typeof o.correlation_score === "number" ? o.correlation_score : null;
  return w != null && Number.isFinite(w) ? w : null;
}

function detailOf(item: unknown, kind: IcpListKind): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const o = item as Record<string, unknown>;
  const parts =
    kind === "title" ? [str(o.seniority), str(o.role)]
    : kind === "industry" ? [Array.isArray(o.examples) ? o.examples.map(str).filter(Boolean).slice(0, 3).join(", ") : ""]
    : kind === "technology" ? [str(o.signal_type)]
    : kind === "antiPattern" ? [str(o.reason)]
    : [];
  const d = parts.filter(Boolean).join(" · ");
  return d || undefined;
}

/** Weighted entries, cleaned and deduplicated (case-insensitive, first one wins). */
export function icpWeighted(value: unknown, kind: IcpListKind): IcpWeighted[] {
  const out: IcpWeighted[] = [];
  const seen = new Set<string>();
  for (const item of listOf(value)) {
    const label = labelOf(item, kind).slice(0, 200);
    if (!label || label === CORRUPT) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const detail = detailOf(item, kind);
    out.push({ label, weight: weightOf(item), ...(detail ? { detail } : {}) });
  }
  return out;
}

/** Plain labels: what search filters, scoring and chips want. */
export function icpLabels(value: unknown, kind: IcpListKind): string[] {
  return icpWeighted(value, kind).map((w) => w.label);
}

/** A list for an LLM prompt: labels with their weight, e.g. "VP Sales (0.9), CFO (0.6)". */
export function icpPromptList(value: unknown, kind: IcpListKind): string {
  return icpWeighted(value, kind)
    .map((w) => (w.weight != null ? `${w.label} (${w.weight})` : w.label))
    .join(", ");
}

/** Geographies as {country, region} pairs. A plain "Region, Country" string is split at its last comma. */
export function icpGeographies(value: unknown): IcpGeography[] {
  const out: IcpGeography[] = [];
  for (const item of listOf(value)) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const o = item as Record<string, unknown>;
      const g = { country: str(o.country), region: str(o.region) };
      if (g.country || g.region) out.push(g);
      continue;
    }
    const s = str(item);
    if (!s || s === CORRUPT) continue;
    const i = s.lastIndexOf(",");
    out.push(i > 0 ? { region: s.slice(0, i).trim(), country: s.slice(i + 1).trim() } : { region: "", country: s });
  }
  return out;
}

/**
 * Stored objects for a list a person edited as labels. A label that was
 * already there keeps its stored entry, weight and all; a new one gets the
 * inferred shape with no weight. So an override never flattens the profile
 * back to strings, and never invents a weight.
 */
export function icpStoredFromLabels(labels: string[], previous: unknown, kind: IcpListKind): Record<string, unknown>[] {
  const prior = new Map<string, Record<string, unknown>>();
  for (const item of listOf(previous)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const label = labelOf(item, kind);
    if (label && !prior.has(label.toLowerCase())) prior.set(label.toLowerCase(), item as Record<string, unknown>);
  }
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const raw of labels) {
    const label = String(raw ?? "").trim();
    if (!label || label === CORRUPT || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const kept = prior.get(label.toLowerCase());
    if (kept) { out.push(kept); continue; }
    switch (kind) {
      case "title": out.push({ title: label, seniority: "", role: "", weight: null }); break;
      case "industry": out.push({ industry: label, weight: null, examples: [] }); break;
      case "technology": out.push({ technology: label, signal_type: "", weight: null }); break;
      case "antiPattern": out.push({ dimension: "", value: label, reason: "" }); break;
      case "signal": out.push({ signal: label, correlation_score: null }); break;
      case "geography": {
        const [g] = icpGeographies([label]);
        out.push({ country: g?.country ?? label, region: g?.region ?? "", weight: null });
        break;
      }
    }
  }
  return out;
}
