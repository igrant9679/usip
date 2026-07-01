/**
 * Criterion operator engine (pure). Evaluates one operator against a resolved
 * field value and the criterion's configured value. Returns a boolean match.
 *
 * Defensive: unknown operators, bad regex, and type mismatches return false
 * rather than throwing — a single bad criterion must never break scoring.
 */
import type { Operator } from "./types";

const s = (v: unknown): string => (v == null ? "" : String(v)).toLowerCase().trim();
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const isEmpty = (v: unknown): boolean =>
  v == null || v === "" || (Array.isArray(v) && v.length === 0);

const toDate = (v: unknown): Date | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
};

/** Jaccard token overlap 0..1 (mirrors the enrichment matcher heuristic). */
function tokenOverlap(a: string, b: string): number {
  const t = (x: string) => new Set(x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean));
  const ta = t(a), tb = t(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const x of ta) if (tb.has(x)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * @param nowMs injected clock (Date.now is unavailable in some sandboxes; the
 * caller passes a stable timestamp).
 */
export function evaluateOperator(
  operator: Operator | string,
  fieldValue: unknown,
  criterionValue: unknown,
  nowMs: number,
): boolean {
  try {
    switch (operator) {
      case "exists": return !isEmpty(fieldValue);
      case "not_exists": return isEmpty(fieldValue);

      case "equals": {
        if (Array.isArray(fieldValue)) return fieldValue.some((x) => s(x) === s(criterionValue));
        return s(fieldValue) === s(criterionValue);
      }
      case "not_equals": {
        if (Array.isArray(fieldValue)) return !fieldValue.some((x) => s(x) === s(criterionValue));
        return s(fieldValue) !== s(criterionValue);
      }

      case "contains": {
        const needle = s(criterionValue);
        if (!needle) return false;
        if (Array.isArray(fieldValue)) return fieldValue.some((x) => s(x).includes(needle));
        return s(fieldValue).includes(needle);
      }
      case "not_contains": {
        const needle = s(criterionValue);
        if (!needle) return true;
        if (Array.isArray(fieldValue)) return !fieldValue.some((x) => s(x).includes(needle));
        return !s(fieldValue).includes(needle);
      }

      case "starts_with": return s(fieldValue).startsWith(s(criterionValue));
      case "ends_with": return s(fieldValue).endsWith(s(criterionValue));

      case "in": {
        const set = asArray(criterionValue).map(s);
        if (Array.isArray(fieldValue)) return fieldValue.some((x) => set.includes(s(x)));
        return set.includes(s(fieldValue));
      }
      case "not_in": {
        const set = asArray(criterionValue).map(s);
        if (Array.isArray(fieldValue)) return !fieldValue.some((x) => set.includes(s(x)));
        return !set.includes(s(fieldValue));
      }

      case "range": {
        const f = num(fieldValue);
        if (f == null) return false;
        let min: number | null = null, max: number | null = null;
        if (Array.isArray(criterionValue)) { min = num(criterionValue[0]); max = num(criterionValue[1]); }
        else if (criterionValue && typeof criterionValue === "object") {
          const o = criterionValue as Record<string, unknown>;
          min = num(o.min ?? o.from ?? o.gte); max = num(o.max ?? o.to ?? o.lte);
        }
        if (min != null && f < min) return false;
        if (max != null && f > max) return false;
        return min != null || max != null;
      }

      case "greater_than": { const f = num(fieldValue), c = num(criterionValue); return f != null && c != null && f > c; }
      case "greater_than_or_equal": { const f = num(fieldValue), c = num(criterionValue); return f != null && c != null && f >= c; }
      case "less_than": { const f = num(fieldValue), c = num(criterionValue); return f != null && c != null && f < c; }
      case "less_than_or_equal": { const f = num(fieldValue), c = num(criterionValue); return f != null && c != null && f <= c; }
      case "score_above": { const f = num(fieldValue), c = num(criterionValue); return f != null && c != null && f > c; }
      case "score_below": { const f = num(fieldValue), c = num(criterionValue); return f != null && c != null && f < c; }

      case "fuzzy_match": {
        let text = criterionValue as string, min = 0.6;
        if (criterionValue && typeof criterionValue === "object" && !Array.isArray(criterionValue)) {
          const o = criterionValue as Record<string, unknown>;
          text = String(o.text ?? o.value ?? "");
          if (num(o.min) != null) min = num(o.min)!;
        }
        return tokenOverlap(s(fieldValue), s(text)) >= min;
      }

      case "regex_match": {
        const pattern = String(criterionValue ?? "");
        if (!pattern || pattern.length > 200) return false; // cap to limit backtracking risk
        return new RegExp(pattern, "i").test(s(fieldValue));
      }

      case "date_within_last": {
        const d = toDate(fieldValue); const days = num(criterionValue);
        if (!d || days == null) return false;
        return nowMs - d.getTime() <= days * 86400000 && d.getTime() <= nowMs;
      }
      case "date_older_than": {
        const d = toDate(fieldValue); const days = num(criterionValue);
        if (!d || days == null) return false;
        return nowMs - d.getTime() > days * 86400000;
      }

      default: return false;
    }
  } catch {
    return false;
  }
}
