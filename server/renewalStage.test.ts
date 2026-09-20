/**
 * The renewal ladder, pinned at every boundary.
 *
 * `customers.renewalStage` was written twice in the customer's life —
 * wonToCustomer stamped "early" when the deal closed, seed.ts computed a bucket
 * once — and then nothing moved it. No cron, no mutation, no workflow action,
 * and no drag on the board. A contract ending in nine days rendered in "Early",
 * and cs.kpis.renewing90 was structurally 0 in every real workspace.
 *
 * Two ways to get the fix wrong, and this file exists for both:
 *
 *   · STOMPING AN OUTCOME. `renewed` and `churned` are what a human recorded
 *     through cs.addAmendment. If arithmetic may overwrite one, a customer
 *     somebody marked churned re-enters the ladder and reappears as an active
 *     renewal.
 *   · INVENTING ONE. server/seed.ts maps `daysToRenewal < 0` to "renewed"
 *     because demo data needs its terminal columns filled. Copying that into
 *     the real derivation would file every lapsed contract as a win — GRR and
 *     NRR both inflate, and a plausible-looking lie is worse than the stale
 *     column it replaced. A past end date with no outcome recorded is
 *     `at_risk`, which in this enum means PAST DUE.
 *
 * The stage is a function of contractEnd ONLY. Health is a different column on
 * the same card, and it is mutable — cs.updateHealthComponents and cs.submitNps
 * recompute healthTier on every write, so a stage derived from it would
 * oscillate forever around a threshold.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RENEWAL_STAGES,
  RENEWAL_STAGE_LABELS,
  TERMINAL_RENEWAL_STAGES,
  daysUntilContractEnd,
  isTerminalRenewalStage,
  renewalStageFor,
  terminalRenewalStages,
  type RenewalStage,
} from "@shared/renewalStage";

const ROOT = join(__dirname, "..");

/** A fixed clock, so "today" never decides whether this suite passes. */
const NOW = new Date("2026-09-20T12:00:00.000Z");
const endIn = (days: number) => new Date(NOW.getTime() + days * 86400000);
const stageAt = (days: number, current = "early") =>
  renewalStageFor({ current, contractEnd: endIn(days), now: NOW });

/**
 * The `customers.renewalStage` enum, read from the schema rather than retyped.
 *
 * Comments are stripped FIRST — the same trap taskStatus.test.ts documents,
 * where a trailing `// …` inside the enum block produced a phantom value.
 */
function schemaRenewalStages(): string[] {
  const src = readFileSync(join(ROOT, "drizzle/schema.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const table = src.slice(src.indexOf("export const customers = mysqlTable"));
  const m = /renewalStage:\s*mysqlEnum\("renewalStage",\s*\[([\s\S]*?)\]\)/.exec(table);
  if (!m) throw new Error("could not find customers.renewalStage enum in schema.ts");
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

describe("the shared list matches the database", () => {
  it("parses the enum out of schema.ts (guards the parser itself)", () => {
    expect(schemaRenewalStages().length).toBe(7);
  });

  it("RENEWAL_STAGES is exactly the enum, in schema order", () => {
    // Order matters here in a way it does not for task statuses: the board
    // renders its columns straight off this array, and schema order IS the
    // ladder. Compared unsorted on purpose.
    expect([...RENEWAL_STAGES]).toEqual(schemaRenewalStages());
  });

  it("every stage has exactly one label", () => {
    expect(Object.keys(RENEWAL_STAGE_LABELS).sort()).toEqual([...RENEWAL_STAGES].sort());
  });

  it("at_risk is labelled as a DATE, not a health judgement", () => {
    // "At risk" read as "this customer looks unhealthy", which is the health
    // pill beside it on the same card. The column holds contracts whose end
    // date has passed with no outcome recorded.
    expect(RENEWAL_STAGE_LABELS.at_risk).toBe("Past due");
  });
});

describe("the boundaries", () => {
  /** Both sides of every threshold — an off-by-one here is a whole column. */
  const CASES: Array<[number, RenewalStage]> = [
    [400, "early"],
    [91, "early"],
    [90, "ninety"],
    [61, "ninety"],
    [60, "sixty"],
    [31, "sixty"],
    [30, "thirty"],
    [1, "thirty"],
    [0, "at_risk"],
    [-1, "at_risk"],
    [-400, "at_risk"],
  ];

  CASES.forEach(([days, expected]) => {
    it(`${days} days out → ${expected}`, () => {
      expect(stageAt(days)).toBe(expected);
    });
  });

  it("the four time buckets agree with seed.ts for every non-negative day count", () => {
    // seed.ts keeps its own one-shot mapping (it also has to invent terminal
    // states for demo data). The two must not disagree, or a seeded workspace
    // jumps the first time the derivation runs over it.
    const seedBucket = (d: number) => (d <= 30 ? "thirty" : d <= 60 ? "sixty" : d <= 90 ? "ninety" : "early");
    for (let d = 0; d <= 200; d++) {
      if (d === 0) continue; // seed has no non-negative past-due case
      expect(stageAt(d), `day ${d}`).toBe(seedBucket(d));
    }
  });
});

describe("the two failure modes", () => {
  it("a past end date is at_risk, NOT renewed — seed.ts's `< 0 ? \"renewed\"` is rejected", () => {
    // Declaring a renewal nobody recorded inflates GRR/NRR and files a churn
    // as a win. seed.ts may do it because demo data has to fill the column;
    // the derivation the product reads may not.
    [-1, -30, -235].forEach((d) => {
      expect(stageAt(d)).toBe("at_risk");
      expect(stageAt(d)).not.toBe("renewed");
    });
  });

  it("a recorded outcome is never overwritten, at any day count", () => {
    TERMINAL_RENEWAL_STAGES.forEach((terminal) => {
      [400, 91, 90, 31, 1, 0, -1, -400].forEach((d) => {
        expect(stageAt(d, terminal), `${terminal} at ${d} days`).toBe(terminal);
      });
      // …and with no contract date at all.
      expect(renewalStageFor({ current: terminal, contractEnd: null, now: NOW })).toBe(terminal);
    });
  });
});

describe("what the stage does not depend on", () => {
  it("health and churn risk cannot move it — they are not inputs at all", () => {
    /**
     * A stage derived from healthTier would duplicate the pill already on the
     * card, erase the date bucket (85 days out and 5 days out land together),
     * and oscillate forever: cs.updateHealthComponents and cs.submitNps
     * recompute healthTier on every write, so a customer straddling score 55
     * flips between two columns for the rest of its life.
     *
     * Asserted on the source, because "same answer for two healths" cannot be
     * written against a signature that has no health parameter to vary.
     */
    const src = readFileSync(join(ROOT, "shared/renewalStage.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/healthTier|healthScore|churnRisk|npsScore/);
    // And the only field it reads off the customer is the contract date.
    expect(renewalStageFor({ current: "early", contractEnd: endIn(45), now: NOW })).toBe("sixty");
  });

  it("no contract date means no basis to move — the stored value is kept", () => {
    expect(renewalStageFor({ current: "thirty", contractEnd: null, now: NOW })).toBe("thirty");
    expect(renewalStageFor({ current: "early", contractEnd: undefined, now: NOW })).toBe("early");
    expect(renewalStageFor({ current: "sixty", contractEnd: "not a date", now: NOW })).toBe("sixty");
  });
});

describe("idempotence", () => {
  it("f(f(x)) === f(x) for every case, so a sweep re-running is free", () => {
    // The persistence sweep runs every 6h over the same rows. If the ladder
    // were not idempotent it would rewrite customers.updatedAt forever.
    [400, 91, 90, 61, 60, 31, 30, 1, 0, -1, -400].forEach((d) => {
      [...RENEWAL_STAGES].forEach((current) => {
        const once = renewalStageFor({ current, contractEnd: endIn(d), now: NOW });
        const twice = renewalStageFor({ current: once, contractEnd: endIn(d), now: NOW });
        expect(twice, `${current} at ${d} days`).toBe(once);
      });
    });
  });
});

describe("daysUntilContractEnd", () => {
  it("counts whole days with ceil — 'ends later today' is still 1 day out", () => {
    const laterToday = new Date(NOW.getTime() + 6 * 3600000);
    expect(daysUntilContractEnd(laterToday, NOW)).toBe(1);
    expect(daysUntilContractEnd(endIn(30), NOW)).toBe(30);
    expect(daysUntilContractEnd(new Date(NOW.getTime() - 6 * 3600000), NOW)).toBe(0);
  });

  it("accepts the string form a JSON payload carries", () => {
    expect(daysUntilContractEnd("2026-10-20T12:00:00.000Z", NOW)).toBe(30);
  });

  it("returns null rather than NaN for anything unusable", () => {
    expect(daysUntilContractEnd(null, NOW)).toBeNull();
    expect(daysUntilContractEnd(undefined, NOW)).toBeNull();
    expect(daysUntilContractEnd("", NOW)).toBeNull();
    expect(daysUntilContractEnd("whenever", NOW)).toBeNull();
  });

  it("reads no host-clock field — a bucket must not depend on the container's timezone", () => {
    const src = readFileSync(join(ROOT, "shared/renewalStage.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/\.setHours\(|\.getDay\(\)|\.getHours\(\)/);
  });
});

describe("the terminal set", () => {
  it("is exactly renewed and churned", () => {
    expect([...TERMINAL_RENEWAL_STAGES].sort()).toEqual(["churned", "renewed"]);
    expect(isTerminalRenewalStage("renewed")).toBe(true);
    expect(isTerminalRenewalStage("churned")).toBe(true);
    expect(isTerminalRenewalStage("at_risk")).toBe(false);
    expect(isTerminalRenewalStage("early")).toBe(false);
  });

  it("terminalRenewalStages() hands out a fresh mutable copy", () => {
    // Drizzle's notInArray rejects a readonly array, and a shared mutable one a
    // caller could push to would be worse.
    const a = terminalRenewalStages();
    a.push("early");
    expect(terminalRenewalStages()).not.toContain("early");
  });
});
