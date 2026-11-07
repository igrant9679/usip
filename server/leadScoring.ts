/**
 * Three-component Lead Scoring Engine. Maximums with the default weights:
 * - Firmographic (max 40)  : org type + title seniority + completeness
 * - Behavioral  (max 75)   : opens 15, clicks 20, a reply 25, five steps at 3;
 *                            bounces and unsubs subtract; 30-day decay
 * - AI Fit      (max 30)   : invokeLLM JSON {fit_score, pain_points, recommended_products, objection_risks}
 * The total is the sum, capped to 0-100. @shared/leadScoreModel computes the
 * maximums for any weights (audit 2026-10-20, P22: this said "max 30" for
 * behaviour, and the page drew it out of 30).
 *
 * The scoring math is pure and now lives in @shared/leadScoreMath, so the Lead
 * Scoring page's what-if runs the same functions in the browser (audit
 * 2026-10-20, U17); it is re-exported here so every importer is unchanged.
 * The routing half below stays here.
 */
export * from "@shared/leadScoreMath";

/* ─────────── Routing ─────────── */

export type RoutingRule = {
  id: number;
  enabled: boolean;
  priority: number;
  conditions: { all?: any[]; any?: any[] } | any[];
  strategy: "round_robin" | "geography" | "industry" | "direct";
  targetUserIds: number[] | null;
  rrCursor: number;
};

export type RoutingMatch = {
  ruleId: number;
  ownerUserId: number;
  /** New value of rrCursor to persist for round-robin rules. */
  newCursor?: number;
};

export type RoutingPayload = {
  country?: string | null;
  state?: string | null;
  city?: string | null;
  industry?: string | null;
  score?: number;
  source?: string | null;
  title?: string | null;
  company?: string | null;
};

/** Normalize legacy [{field,op,value}] arrays to {all:[...]}. */
export function normalizeConditions(c: RoutingRule["conditions"]): { all?: any[]; any?: any[] } {
  if (Array.isArray(c)) return { all: c };
  return c ?? {};
}

/** Reuse-friendly evaluator — same operators as evalConditions in operations.ts. */
export function ruleMatches(rule: RoutingRule, payload: RoutingPayload, evaluator: (spec: any, p: any) => boolean): boolean {
  if (!rule.enabled) return false;
  return evaluator(normalizeConditions(rule.conditions), payload);
}

/**
 * Pick the first matching rule (lowest priority value, then oldest), then choose owner per strategy.
 * - round_robin: targetUserIds[rrCursor], advance cursor
 * - geography  : the owner `geoIndustryOwnerLookup` finds (routeLeadOwner reads
 *                territory rules), else targetUserIds[0]
 * - industry   : same, by industry
 * - direct     : targetUserIds[0]
 */
export function pickRoutingMatch(
  rules: RoutingRule[],
  payload: RoutingPayload,
  evaluator: (spec: any, p: any) => boolean,
  geoIndustryOwnerLookup?: (rule: RoutingRule, payload: RoutingPayload) => number | null,
): RoutingMatch | null {
  // Equal priorities used to run in whatever order the rows came back (P124).
  const ordered = rules.slice().sort((a, b) => a.priority - b.priority || a.id - b.id);
  for (const r of ordered) {
    if (!ruleMatches(r, payload, evaluator)) continue;
    const targets = r.targetUserIds ?? [];
    switch (r.strategy) {
      case "round_robin": {
        if (targets.length === 0) continue;
        const idx = ((r.rrCursor ?? 0) % targets.length + targets.length) % targets.length;
        const ownerUserId = targets[idx]!;
        return { ruleId: r.id, ownerUserId, newCursor: (idx + 1) % targets.length };
      }
      case "direct": {
        if (targets.length === 0) continue;
        return { ruleId: r.id, ownerUserId: targets[0]! };
      }
      case "geography":
      case "industry": {
        const owner = geoIndustryOwnerLookup?.(r, payload) ?? targets[0] ?? null;
        if (owner == null) continue;
        return { ruleId: r.id, ownerUserId: owner };
      }
    }
  }
  return null;
}
