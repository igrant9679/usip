/**
 * What a paid action will spend, said before it runs (audit 2026-10-20, F8
 * and U16: "spend is invisible until it's gone").
 *
 * Every control that spends vendor credits or model calls states the count
 * and the cost first and asks; the launchers show each source's allowance
 * left today ("Apollo: 120 of 500 left today") and how many model calls a run
 * can make. The numbers come from the caps and ledgers already built
 * (spend.budgets on the server): nothing here invents a price. Vendor credits
 * are counted in the vendor's own unit; dollars appear only where a list
 * price is on file (shared/researchModels, shared/spendReport).
 *
 * Pure, so a test can read every sentence.
 */

/** A daily allowance: what is used and the cap, or null when nothing caps it. */
export type Allowance = { used: number; cap: number } | null;

export type SourceBudgets = {
  apollo: { configured: boolean; allowance: Allowance };
  quickenrich: { configured: boolean; allowance: Allowance };
  /** Lookups left today across the LinkedIn accounts this person may use. */
  linkedin: { accounts: number; left: number; cap: number };
  /** Reoon: whose key, and the shared key's daily cap when it is the shared one. */
  reoon: { configured: boolean; keySource: "workspace" | "shared" | null; allowance: Allowance };
  /** The workspace's monthly AI token budget (null cap = no budget set). */
  ai: { used: number; cap: number | null };
};

const n = (v: number) => v.toLocaleString("en-US");

export function leftOf(a: Allowance): number | null {
  return a ? Math.max(0, a.cap - a.used) : null;
}

/** "Apollo: 120 of 500 left today", or why the source will not run. */
export function allowanceLine(label: string, configured: boolean, a: Allowance): string {
  if (!configured) return `${label}: no key, skipped`;
  if (!a) return `${label}: no daily cap`;
  return `${label}: ${n(leftOf(a)!)} of ${n(a.cap)} left today`;
}

/**
 * Model calls one discovery run can make per source, at most: News reads one
 * feed with one call; Google Business reads up to three result pages, one
 * call each (routers/are/scraper.ts; pinned by a test). The vendor databases
 * and the LinkedIn search make none.
 */
export const AI_CALLS_PER_SOURCE: Record<string, number> = { news: 1, google_business: 3 };

export function aiCallEstimate(sources: readonly string[]): number {
  return sources.reduce((sum, s) => sum + (AI_CALLS_PER_SOURCE[s] ?? 0), 0);
}

/** The line a discovery launcher shows under its button, before running. */
export function launcherBudgetLine(sources: readonly string[], b: SourceBudgets | null | undefined): string {
  if (!b) return "";
  const parts: string[] = [];
  if (sources.includes("apollo")) parts.push(allowanceLine("Apollo", b.apollo.configured, b.apollo.allowance));
  if (sources.includes("quickenrich")) parts.push(allowanceLine("QuickEnrich", b.quickenrich.configured, b.quickenrich.allowance));
  if (sources.includes("linkedin")) {
    parts.push(b.linkedin.accounts === 0 ? "LinkedIn: no account connected, skipped" : `LinkedIn: ${n(b.linkedin.left)} of ${n(b.linkedin.cap)} lookups left today`);
  }
  const calls = aiCallEstimate(sources);
  if (calls > 0) parts.push(`up to ${calls} AI call${calls === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * The most one person's "Enrich fully" can spend (services/enrichment/
 * comprehensivePass.ts): QuickEnrich bills only an email it delivers, and its
 * hit is confirmed with one Reoon daily credit; the address finder checks at
 * most three patterns (scraper/emailPatterns.ts), each with an instant credit
 * and, until one is deliverable, a daily credit; one LinkedIn lookup is queued
 * when the person has a profile URL and no profile on file. Pinned by a test.
 */
export const ENRICH_FULLY_MAX = { quickenrich: 1, reoonInstant: 3, reoonDaily: 4, linkedin: 1 } as const;

export function enrichFullyText(people: number, b?: SourceBudgets | null): string {
  const m = ENRICH_FULLY_MAX;
  const parts = [
    `For each person it can use up to ${m.quickenrich} QuickEnrich credit (only when an email is found), ${m.reoonInstant} Reoon instant and ${m.reoonDaily} Reoon daily credits to check addresses, and ${m.linkedin} LinkedIn lookup when no profile is on file.`,
    people > 1 ? `For ${n(people)} people that is at most ${n(people * m.quickenrich)} QuickEnrich, ${n(people * m.reoonInstant)} + ${n(people * m.reoonDaily)} Reoon and ${n(people * m.linkedin)} LinkedIn.` : "",
  ];
  if (b) {
    const left: string[] = [];
    if (b.quickenrich.configured) left.push(allowanceLine("QuickEnrich pulls", true, b.quickenrich.allowance));
    if (b.reoon.allowance) left.push(`Reoon shared key: ${n(leftOf(b.reoon.allowance)!)} of ${n(b.reoon.allowance.cap)} left today`);
    if (b.linkedin.accounts > 0) left.push(`LinkedIn: ${n(b.linkedin.left)} lookups left today`);
    if (left.length) parts.push(`${left.join(" · ")}.`);
  }
  return parts.filter(Boolean).join(" ");
}

/**
 * The most one Revenue Engine prospect's Enrich can spend (runEnrichAgent in
 * server/routers/are/prospects.ts): two AI calls, the ICP score and the
 * dossier; and when no email is on file, one QuickEnrich lookup by LinkedIn
 * (billed only for an email it delivers), one Reoon credit to check that
 * hit, and the address finder's up to three patterns, each with an instant
 * and a daily credit (the counts ENRICH_FULLY_MAX uses for the same finder).
 * Pinned by a test that counts the AI calls in the agent.
 */
export const ARE_ENRICH_MAX = { aiCalls: 2, quickenrich: 1, reoonInstant: 3, reoonDaily: 4 } as const;

export function areEnrichText(people: number, b?: SourceBudgets | null): string {
  const m = ARE_ENRICH_MAX;
  const parts = [
    `For each person this makes ${m.aiCalls} AI calls (the ICP score and the dossier), billed to this workspace's AI provider, and when no email is on file it can use up to ${m.quickenrich} QuickEnrich credit (only when an email is found) and ${m.reoonInstant} Reoon instant and ${m.reoonDaily} Reoon daily credits to find and check an address.`,
    people > 1 ? `For ${n(people)} people that is ${n(people * m.aiCalls)} AI calls and at most ${n(people * m.quickenrich)} QuickEnrich and ${n(people * m.reoonInstant)} + ${n(people * m.reoonDaily)} Reoon.` : "",
  ];
  if (b) {
    const left: string[] = [];
    if (b.quickenrich.configured) left.push(allowanceLine("QuickEnrich pulls", true, b.quickenrich.allowance));
    if (b.reoon.allowance) left.push(`Reoon shared key: ${n(leftOf(b.reoon.allowance)!)} of ${n(b.reoon.allowance.cap)} left today`);
    left.push(b.ai.cap ? `AI tokens this month: ${n(b.ai.used)} of ${n(b.ai.cap)}` : `AI tokens this month: ${n(b.ai.used)} (no monthly budget set)`);
    parts.push(`${left.join(" · ")}.`);
  }
  return parts.filter(Boolean).join(" ");
}

/**
 * The most writing one Revenue Engine sequence can spend (runSequenceAgent):
 * the campaign's template when none is cached, the person's steps, and the
 * quality check — three AI calls at most, and no vendor credits. Pinned by a
 * test that counts the AI calls in the agent.
 */
export const ARE_GENERATE_MAX_AI_CALLS = 3;

export function areGenerateText(ai?: SourceBudgets["ai"] | null): string {
  const head = `This makes up to ${ARE_GENERATE_MAX_AI_CALLS} AI calls (the campaign's template if none is saved yet, this person's steps, and a quality check), billed to this workspace's AI provider. Nothing is sent: an approved prospect's sequence goes out on the campaign's cadence, within its caps and send window.`;
  if (!ai) return head;
  return ai.cap
    ? `${head} This month: ${n(ai.used)} of ${n(ai.cap)} tokens used.`
    : `${head} This month: ${n(ai.used)} tokens used (no monthly budget set).`;
}

/** "This makes 1 AI call. This month: 120,000 of 2,000,000 tokens used." */
export function aiCallText(calls: number, ai?: SourceBudgets["ai"] | null, what?: string): string {
  const head = `This makes ${calls === 1 ? "1 AI call" : `${n(calls)} AI calls`}${what ? ` ${what}` : ""}, billed to this workspace's AI provider.`;
  if (!ai) return head;
  return ai.cap
    ? `${head} This month: ${n(ai.used)} of ${n(ai.cap)} tokens used.`
    : `${head} This month: ${n(ai.used)} tokens used (no monthly budget set).`;
}

/**
 * The confirmation for a paid lookup: how many, in the vendor's unit, and
 * what is left today. `count` is what will be sent; `unit` names one of them.
 */
export function paidLookupText(opts: {
  vendor: string;
  count: number;
  /** One unit, singular ("credit", "lookup"). */
  unit: string;
  /** What one item costs in units (Reoon power verification: 1 credit). */
  perItem?: number;
  allowance?: Allowance;
  /** Extra sentence: what the action does with the result. */
  note?: string;
}): string {
  const units = opts.count * (opts.perItem ?? 1);
  const plural = (k: number, w: string) => `${n(k)} ${w}${k === 1 ? "" : "s"}`;
  const left = leftOf(opts.allowance ?? null);
  const head = `This spends up to ${plural(units, `${opts.vendor} ${opts.unit}`)}${opts.perItem && opts.perItem !== 1 ? ` (${opts.perItem} each)` : ""}.`;
  const cap = left === null
    ? ""
    : left < units
      ? ` Only ${n(left)} of today's ${n(opts.allowance!.cap)} are left, so the rest waits for tomorrow or is refused.`
      : ` ${n(left)} of today's ${n(opts.allowance!.cap)} are left.`;
  return `${head}${cap}${opts.note ? ` ${opts.note}` : ""}`;
}
