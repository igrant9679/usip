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
 * The scoring math is a pure function so it can be unit-tested without a DB.
 */
import { behavioralMax } from "@shared/leadScoreModel";

export type ScoreConfig = {
  firmoOrgTypeWeight: number;
  firmoTitleWeight: number;
  firmoCompletenessWeight: number;

  behavOpenPoints: number;
  behavOpenMax: number;
  behavClickPoints: number;
  behavClickMax: number;
  behavReplyPoints: number;
  behavStepPoints: number;
  behavBouncePenalty: number;
  behavUnsubPenalty: number;
  behavDecayPctPer30d: number;

  aiFitMax: number;

  tierWarmMin: number;
  tierHotMin: number;
  tierSalesReadyMin: number;
};

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  firmoOrgTypeWeight: 15,
  firmoTitleWeight: 15,
  firmoCompletenessWeight: 10,
  behavOpenPoints: 5,
  behavOpenMax: 15,
  behavClickPoints: 10,
  behavClickMax: 20,
  behavReplyPoints: 25,
  behavStepPoints: 3,
  behavBouncePenalty: -10,
  behavUnsubPenalty: -15,
  behavDecayPctPer30d: 10,
  aiFitMax: 30,
  tierWarmMin: 31,
  tierHotMin: 61,
  tierSalesReadyMin: 81,
};

export type LeadFirmoInput = {
  title?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
};

export type LeadBehaviorInput = {
  opens: number;
  clicks: number;
  replies: number;
  completedSteps: number;
  bounces: number;
  unsubscribes: number;
  /** Days since the most recent engagement event. Used to decay behavioral score. */
  daysSinceLastEngagement: number;
};

export type AiFitOutput = {
  fit_score: number; // 0..1
  pain_points: string[];
  recommended_products: string[];
  objection_risks: string[];
  /** Set when the model failed and the fit is a guess from the title (P38). */
  source?: "title_heuristic";
};

// The tier vocabulary and its grade mapping live in @shared/leadTier, because
// the Leads table needs the second half and used to re-derive it from
// hardcoded thresholds. Re-exported so this module's existing importers are
// unaffected.
export type { LeadTier } from "@shared/leadTier";
import type { LeadTier } from "@shared/leadTier";

export type ScoreBreakdown = {
  firmographic: number;
  behavioral: number;
  aiFit: number;
  total: number;
  tier: LeadTier;
  reasons: string[];
};

/* ─────────── Firmographic ─────────── */

export type TitleSeniority = "c_suite" | "vp" | "director" | "manager" | "ic" | "none";

/**
 * Seniority read from whole words (audit 2026-10-20, P36). Substring tests
 * missed CTO, COO and President, gave a Product Owner C-suite points for
 * "owner", and found "vp" and "cro" inside other words ("Microsoft").
 */
export function titleSeniority(title: string | null | undefined): TitleSeniority {
  const t = (title ?? "").toLowerCase().trim();
  if (!t) return "none";
  const vicePresident = /\bvice[\s-]+president\b/.test(t);
  if (
    /\b(chief|ceo|cfo|cmo|cro|cto|coo|cio|ciso|cpo|cxo|founder|cofounder)\b/.test(t) ||
    (/\bpresident\b/.test(t) && !vicePresident) ||
    (/\bowner\b/.test(t) && !/\bproduct owner\b/.test(t))
  ) return "c_suite";
  if (vicePresident || /\b(vp|svp|evp|avp|head of)\b/.test(t)) return "vp";
  if (/\bdirectors?\b/.test(t)) return "director";
  if (/\bmanagers?\b/.test(t)) return "manager";
  return "ic";
}

const SENIORITY_SHARE: Record<TitleSeniority, { share: number; label: string }> = {
  c_suite: { share: 1, label: "C-suite title" },
  vp: { share: 0.8, label: "VP-level title" },
  director: { share: 0.6, label: "Director title" },
  manager: { share: 0.4, label: "Manager title" },
  ic: { share: 0.2, label: "IC title" },
  none: { share: 0, label: "" },
};

export function scoreFirmographic(lead: LeadFirmoInput, cfg: ScoreConfig = DEFAULT_SCORE_CONFIG): { value: number; reasons: string[] } {
  const reasons: string[] = [];
  let pts = 0;

  // Title seniority: full weight if C-suite, scaled down by tier.
  const seniority = SENIORITY_SHARE[titleSeniority(lead.title)];
  if (seniority.share > 0) {
    const titlePts = Math.round(cfg.firmoTitleWeight * seniority.share);
    pts += titlePts;
    reasons.push(`${seniority.label} (+${titlePts})`);
  }

  // Org type proxy via company name presence and email-domain category.
  const company = (lead.company ?? "").trim();
  const email = (lead.email ?? "").toLowerCase();
  const isFreeEmail = /@(gmail|yahoo|hotmail|outlook|icloud|protonmail|aol)\./.test(email);
  if (company.length > 0 && !isFreeEmail) {
    pts += cfg.firmoOrgTypeWeight;
    reasons.push(`B2B organization (+${cfg.firmoOrgTypeWeight})`);
  } else if (company.length > 0 && isFreeEmail) {
    pts += Math.round(cfg.firmoOrgTypeWeight * 0.5);
    reasons.push(`Company name w/ free email (+${Math.round(cfg.firmoOrgTypeWeight * 0.5)})`);
  }

  // Completeness: 1 pt per filled core field, normalized to weight.
  const filled = [lead.title, lead.company, lead.email, lead.phone, lead.source].filter((x) => !!x && String(x).trim().length > 0).length;
  const completeness = Math.round((filled / 5) * cfg.firmoCompletenessWeight);
  pts += completeness;
  reasons.push(`Profile completeness ${filled}/5 (+${completeness})`);

  const max = cfg.firmoOrgTypeWeight + cfg.firmoTitleWeight + cfg.firmoCompletenessWeight;
  return { value: clamp(pts, 0, max), reasons };
}

/* ─────────── Behavioral ─────────── */

export function scoreBehavioral(b: LeadBehaviorInput, cfg: ScoreConfig = DEFAULT_SCORE_CONFIG): { value: number; reasons: string[] } {
  const reasons: string[] = [];
  let pts = 0;

  const openPts = Math.min(cfg.behavOpenMax, b.opens * cfg.behavOpenPoints);
  if (openPts !== 0) {
    pts += openPts;
    reasons.push(`${b.opens} opens (+${openPts})`);
  }
  const clickPts = Math.min(cfg.behavClickMax, b.clicks * cfg.behavClickPoints);
  if (clickPts !== 0) {
    pts += clickPts;
    reasons.push(`${b.clicks} clicks (+${clickPts})`);
  }
  // Reply points are given once, however many replies (P119: the page called
  // them points per reply).
  if (b.replies > 0) {
    pts += cfg.behavReplyPoints;
    reasons.push(`Replied${b.replies > 1 ? ` (${b.replies} replies)` : ""} (+${cfg.behavReplyPoints}, counted once)`);
  }
  if (b.completedSteps > 0) {
    const stepPts = b.completedSteps * cfg.behavStepPoints;
    pts += stepPts;
    reasons.push(`${b.completedSteps} sequence steps (+${stepPts})`);
  }
  if (b.bounces > 0) {
    pts += cfg.behavBouncePenalty;
    reasons.push(`${b.bounces} bounce(s) (${cfg.behavBouncePenalty})`);
  }
  if (b.unsubscribes > 0) {
    pts += cfg.behavUnsubPenalty;
    reasons.push(`${b.unsubscribes} unsubscribe(s) (${cfg.behavUnsubPenalty})`);
  }

  // 30-day decay: every full 30-day window, multiply by (1 - decay%).
  const periods = Math.floor(Math.max(0, b.daysSinceLastEngagement) / 30);
  if (periods > 0 && pts > 0) {
    const factor = Math.pow(1 - cfg.behavDecayPctPer30d / 100, periods);
    const before = pts;
    pts = Math.round(pts * factor);
    reasons.push(`Decay ${periods}x30d (${before}→${pts})`);
  }

  // Cap at component max (sum of positive weights, not penalties).
  return { value: clamp(pts, -30, behavioralMax(cfg)), reasons };
}

/* ─────────── AI Fit ─────────── */

/**
 * The fit to use when the model call fails: a guess from the title, marked as
 * one so it is never shown as the model's assessment (P38).
 */
export function titleHeuristicFit(title: string | null | undefined): AiFitOutput {
  const fit = { c_suite: 0.85, vp: 0.7, director: 0.55, manager: 0.4, ic: 0.25, none: 0.25 }[titleSeniority(title)];
  return { fit_score: fit, pain_points: [], recommended_products: [], objection_risks: [], source: "title_heuristic" };
}

export function scoreAiFit(ai: AiFitOutput | null | undefined, cfg: ScoreConfig = DEFAULT_SCORE_CONFIG): { value: number; reasons: string[] } {
  if (!ai || typeof ai.fit_score !== "number") return { value: 0, reasons: ["AI fit not assessed yet"] };
  const fit = clamp(ai.fit_score, 0, 1);
  const value = Math.round(fit * cfg.aiFitMax);
  const reasons: string[] = [];
  reasons.push(ai.source === "title_heuristic"
    ? `Fit estimated from the title; the AI assessment failed (+${value})`
    : `AI fit ${(fit * 100).toFixed(0)}% (+${value})`);
  if (Array.isArray(ai.pain_points) && ai.pain_points.length) reasons.push(`Pains: ${ai.pain_points.slice(0, 2).join(", ")}`);
  if (Array.isArray(ai.objection_risks) && ai.objection_risks.length) reasons.push(`Risks: ${ai.objection_risks.slice(0, 2).join(", ")}`);
  return { value, reasons };
}

/* ─────────── Composite ─────────── */

export function tierFor(total: number, cfg: ScoreConfig = DEFAULT_SCORE_CONFIG): LeadTier {
  if (total >= cfg.tierSalesReadyMin) return "sales_ready";
  if (total >= cfg.tierHotMin) return "hot";
  if (total >= cfg.tierWarmMin) return "warm";
  return "cold";
}

export function composeScore(args: {
  firmo: ReturnType<typeof scoreFirmographic>;
  behav: ReturnType<typeof scoreBehavioral>;
  aiFit: ReturnType<typeof scoreAiFit>;
  cfg?: ScoreConfig;
}): ScoreBreakdown {
  const cfg = args.cfg ?? DEFAULT_SCORE_CONFIG;
  // Behaviour is summed as it is, negative included: flooring it at 0 first
  // meant a bounce or an unsubscribe never lowered the total (P33).
  const total = clamp(args.firmo.value + args.behav.value + args.aiFit.value, 0, 100);
  const tier = tierFor(total, cfg);
  return {
    firmographic: args.firmo.value,
    behavioral: args.behav.value,
    aiFit: args.aiFit.value,
    total,
    tier,
    reasons: [...args.firmo.reasons, ...args.behav.reasons, ...args.aiFit.reasons],
  };
}

export function tierColor(tier: LeadTier): string {
  switch (tier) {
    case "sales_ready": return "#16a34a"; // green-600
    case "hot": return "#ea580c"; // orange-600
    case "warm": return "#eab308"; // yellow-500
    case "cold": return "#64748b"; // slate-500
  }
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

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
