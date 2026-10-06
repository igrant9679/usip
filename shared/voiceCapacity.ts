/**
 * voiceCapacity.ts — how many AI calls a workspace can make (2026-10-06).
 *
 * Owner ask: "give me the ability to add multiple numbers/agents so that I
 * can make more outbound calls from a particular workspace."
 *
 * Numbers. One number places at most MAX_CALLS_PER_NUMBER_PER_DAY calls
 * (carriers flag a busy new number as spam), so an agent may hold several.
 * Its main number (voice_agents.plivoNumber) comes first: the agent is listed
 * by it and test calls use it unless told otherwise. The others
 * (plivoExtraNumbers) share the calls. A number belongs to one agent only, so
 * a call to any of them is answered by that agent.
 *
 * Limits. Calls at once, new calls a minute and agent minutes a day were
 * fixed constants (security audit 2026-10-04). An admin may now raise them,
 * never past the ceilings: they are what keeps a mistake from running up the
 * xAI and Plivo bills.
 */

export const MAX_CALLS_PER_NUMBER_PER_DAY = 100;
export const MAX_NUMBERS_PER_AGENT = 20;

export type VoiceLimits = {
  /** Calls the workspace's agents hold at once, in or out. */
  maxConcurrent: number;
  /** New AI calls the dialer starts per minute. */
  dialsPerMinute: number;
  /** Agent minutes in any rolling 24 hours, in or out. */
  dailyMinutes: number;
};

export const DEFAULT_VOICE_LIMITS: VoiceLimits = { maxConcurrent: 3, dialsPerMinute: 2, dailyMinutes: 240 };
export const VOICE_LIMIT_CEILINGS: VoiceLimits = { maxConcurrent: 10, dialsPerMinute: 10, dailyMinutes: 1500 };

/** Stored values (null = default), each a whole number between 1 and its ceiling. */
export function clampVoiceLimits(v: Partial<Record<keyof VoiceLimits, number | null | undefined>> | null | undefined): VoiceLimits {
  const one = (k: keyof VoiceLimits) => {
    const n = Number(v?.[k]);
    if (v?.[k] == null || !Number.isFinite(n)) return DEFAULT_VOICE_LIMITS[k];
    return Math.min(VOICE_LIMIT_CEILINGS[k], Math.max(1, Math.floor(n)));
  };
  return { maxConcurrent: one("maxConcurrent"), dialsPerMinute: one("dialsPerMinute"), dailyMinutes: one("dailyMinutes") };
}

const digits = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "");

export type AgentNumberFields = { plivoNumber?: string | null; plivoExtraNumbers?: unknown };

/** Every number the agent calls from and answers, main first, without repeats. */
export function agentNumbers(a: AgentNumberFields | null | undefined): string[] {
  const extras = Array.isArray(a?.plivoExtraNumbers) ? (a!.plivoExtraNumbers as unknown[]).filter((n): n is string => typeof n === "string") : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of [a?.plivoNumber ?? null, ...extras]) {
    const d = digits(n);
    if (!n || !d || seen.has(d)) continue;
    seen.add(d);
    out.push(n);
  }
  return out;
}

/** The agent's number matching `number` (any formatting), or null. */
export function agentNumberMatching(a: AgentNumberFields | null | undefined, number: string | null | undefined): string | null {
  const d = digits(number);
  if (!d) return null;
  return agentNumbers(a).find((n) => digits(n) === d) ?? null;
}

/** The agent's columns for a list of numbers, the first being the main one. */
export function numberFields(numbers: string[]): { plivoNumber: string | null; plivoExtraNumbers: string[] | null } {
  const list = agentNumbers({ plivoExtraNumbers: numbers });
  return { plivoNumber: list[0] ?? null, plivoExtraNumbers: list.length > 1 ? list.slice(1) : null };
}

/** North American area code, or null. */
export function areaCode(number: string | null | undefined): string | null {
  const d = digits(number);
  if (d.length === 11 && d.startsWith("1")) return d.slice(1, 4);
  if (d.length === 10) return d.slice(0, 3);
  return null;
}

/**
 * Which of the agent's numbers places a call:
 *   1. the number this person was last called from: a second call from a new
 *      number looks like spam, and their call back reaches the same agent;
 *   2. otherwise one with the person's area code: people answer local numbers;
 *   3. otherwise the one that has placed the fewest calls in the last 24 hours.
 * A number that has placed `perNumberCap` calls is skipped. Null when all have.
 * `usedToday` is keyed by digits only.
 */
export function pickFromNumber(input: {
  numbers: string[];
  to: string;
  lastFrom?: string | null;
  usedToday: Record<string, number>;
  perNumberCap?: number;
}): string | null {
  const cap = input.perNumberCap ?? MAX_CALLS_PER_NUMBER_PER_DAY;
  const used = (n: string) => input.usedToday[digits(n)] ?? 0;
  const open = input.numbers.filter((n) => used(n) < cap);
  if (!open.length) return null;
  const last = digits(input.lastFrom);
  if (last) {
    const same = open.find((n) => digits(n) === last);
    if (same) return same;
  }
  const code = areaCode(input.to);
  const local = code ? open.filter((n) => areaCode(n) === code) : [];
  const pool = local.length ? local : open;
  return pool.reduce((best, n) => (used(n) < used(best) ? n : best));
}
