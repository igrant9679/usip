/**
 * The one definition of "which renewal bucket is this customer in".
 *
 * `customers.renewalStage` was written in exactly two places — wonToCustomer.ts
 * stamps "early" on every newly-won customer, and seed.ts computes a bucket once
 * at seed time — and then never touched again. No cron moved it, no mutation
 * moved it, `update_field` in workflowEngine does not cover customers, and the
 * Renewals cards are plain divs with no drag. So a contract ending in nine days
 * sat in "Early" forever, and `cs.kpis.renewing90` was structurally 0 in every
 * REAL workspace (a seeded demo tenant populates thirty/sixty/ninety at seed
 * time, which is why the bug reads as absent there).
 *
 * The stage is a pure function of contractEnd, so it is DERIVED at read time —
 * cs.list / cs.get / cs.kpis / cs.renewalsBoard and the two churn-risk prompts.
 * The persistence sweep (server/services/renewalStageEngine.ts) exists only so
 * a direct table read, an export or a future report agrees with what the UI has
 * already been showing.
 *
 * 🔴 `at_risk` means PAST DUE, not "unhealthy". The ladder seeded into the
 * operator manual is "early → 90 days → 60 → 30 → at risk → renewed or
 * churned": at_risk sits after `thirty` in a TEMPORAL sequence. Deriving it
 * from healthTier instead would duplicate the health pill the card already
 * renders, erase the date bucket (a renewal 85 days out and one 5 days out land
 * in the same column), and oscillate forever — cs.updateHealthComponents and
 * cs.submitNps recompute healthTier on every write.
 *
 * 🔴 A past contractEnd is NOT a renewal. seed.ts maps `d < 0` to "renewed"
 * because demo data needs its terminal columns populated; a real derivation must
 * never copy that. Asserting a renewal nobody recorded inflates GRR/NRR and
 * files a churn as a win — a plausible-looking lie, which is worse than the
 * stale column it replaces. `renewed` and `churned` are HUMAN outcomes, written
 * only by cs.addAmendment, and the derivation never overwrites them.
 */

/**
 * Every value of the `customers.renewalStage` enum, in schema order.
 *
 * Schema order IS the ladder, which is why the board can render its columns
 * straight off this array: before this, Renewals.tsx listed them early / 30 /
 * 60 / 90, so a card advancing through its contract travelled right, then left,
 * then left again.
 */
export const RENEWAL_STAGES = [
  "early",
  "ninety",
  "sixty",
  "thirty",
  "at_risk",
  "renewed",
  "churned",
] as const;

export type RenewalStage = (typeof RENEWAL_STAGES)[number];

/**
 * Human labels. "Past due" rather than "At risk": the column holds contracts
 * whose end date has passed with no outcome recorded, and "at risk" reads as a
 * health judgement — which is a different column on the same card.
 */
export const RENEWAL_STAGE_LABELS: Record<RenewalStage, string> = {
  early: "Early",
  ninety: "90 days",
  sixty: "60 days",
  thirty: "30 days",
  at_risk: "Past due",
  renewed: "Renewed",
  churned: "Churned",
};

/**
 * The two stages a human recorded and arithmetic may not revoke.
 *
 * A customer somebody marked churned must not re-enter the ladder and reappear
 * as an active renewal the moment its contractEnd is in the past.
 */
export const TERMINAL_RENEWAL_STAGES: readonly RenewalStage[] = ["renewed", "churned"];

/** Mutable copy for Drizzle's `notInArray`, which does not take a readonly array. */
export function terminalRenewalStages(): RenewalStage[] {
  return [...TERMINAL_RENEWAL_STAGES];
}

export function isTerminalRenewalStage(stage: string): boolean {
  return (TERMINAL_RENEWAL_STAGES as readonly string[]).includes(stage);
}

/**
 * Whole days from `now` until the contract ends, or null when there is no
 * usable date. `Math.ceil`, so "ends later today" is 1 day out and not 0 —
 * 0 and below is the past-due side of the ladder.
 *
 * Deliberately no setHours()/getHours()/getDay(): a day count read off the
 * container's timezone is the bug server/availability.test.ts bans, and the
 * engine that calls this from server/ is inside that scan.
 */
export function daysUntilContractEnd(
  contractEnd: Date | string | null | undefined,
  now?: Date,
): number | null {
  if (contractEnd === null || contractEnd === undefined) return null;
  const end = contractEnd instanceof Date ? contractEnd : new Date(contractEnd);
  const endMs = end.getTime();
  if (isNaN(endMs)) return null;
  const nowMs = (now ?? new Date()).getTime();
  // `+ 0` normalises Math.ceil's negative zero: a contract that ended earlier
  // today is 0 days out, and "-0" rendered into a churn-risk prompt or a log
  // line is a distraction with no meaning behind it.
  return Math.ceil((endMs - nowMs) / 86400000) + 0;
}

/**
 * The ladder. Pure, idempotent (`f(f(x)) === f(x)`) and a function of exactly
 * one field, so every reader agrees without coordinating.
 *
 *   stored renewed/churned → kept      (human outcome, engine-immutable)
 *   contractEnd absent     → kept      (no basis to move it)
 *   d > 90                 → early
 *   60 < d <= 90           → ninety
 *   30 < d <= 60           → sixty
 *   0  < d <= 30           → thirty
 *   d <= 0                 → at_risk   (past its end date, no outcome recorded)
 *
 * The four time buckets match seed.ts's one-shot mapping at every boundary, so
 * demo tenants do not jump when this ships. The `d <= 0` row is where they
 * diverge, on purpose — see the file docstring.
 */
export function renewalStageFor(args: {
  current: string;
  contractEnd: Date | string | null | undefined;
  now?: Date;
}): RenewalStage {
  // `current` comes out of a mysqlEnum, so it is already one of the seven. The
  // casts below preserve an unrecognised value instead of laundering it into
  // "early" — that is what keeps Renewals.tsx's `_unbucketed` column able to
  // show enum drift rather than hiding it in the first bucket.
  if (isTerminalRenewalStage(args.current)) return args.current as RenewalStage;
  const d = daysUntilContractEnd(args.contractEnd, args.now);
  if (d === null) return args.current as RenewalStage;
  if (d > 90) return "early";
  if (d > 60) return "ninety";
  if (d > 30) return "sixty";
  if (d > 0) return "thirty";
  return "at_risk";
}
