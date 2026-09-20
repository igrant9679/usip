/**
 * The one definition of "is this deal won, lost, or still open".
 *
 * `opportunities.stage` stopped being an enum in migration 0082 — it is a
 * varchar, and `crm_pipeline_stages` lets every workspace define its own keys
 * and tick Won/Lost on any of them (/settings/pipelines). Exactly two code
 * paths ever read those flags; roughly seventy others string-matched "won" and
 * "lost" instead, in three mutually inconsistent dialects:
 *
 *   crm.ts · operations.ts · reports.ts · …   stage === "won" / "lost"
 *   dealAutopilot.ts                          + "closed_won" "closed_lost" "closed"
 *   assistant.ts                              /closed/i — matches NEITHER
 *   Home.tsx                                  startsWith("closed") — same
 *
 * 🔴 A workspace that renames its closing stage to `signed` and ticks Won gets
 * a pipeline number that counts its own closed-won deals as open forecast, a
 * revenue widget that reads zero, an autopilot that keeps generating next-steps
 * for deals that already closed, and an AI assistant that tells the rep out
 * loud how many "open" deals they have while counting every won and lost one.
 * The flags shipped; the readers never learned about them.
 *
 * Derived at READ time, deliberately. The flags are editable at any moment —
 * an admin can tick Won on a stage that already holds 40 historical deals —
 * and a stored `closedState` column would need a workspace-wide UPDATE fired
 * from a checkbox to stay true. Read-time derivation self-heals for free.
 *
 * PRECEDENCE, which is the whole subtlety: a key that has a configured row in
 * `crm_pipeline_stages` is decided by THAT ROW's flags. The name defaults below
 * apply only to keys no row in the workspace configures. That is what keeps
 * legacy keys (`closed_won`, `closed_lost`, `closed`) and every workspace that
 * never opened /settings/pipelines behaving bit-for-bit as before — while still
 * honouring an admin who UNTICKS Won on the stage keyed `won`.
 */

/** One row of `crm_pipeline_stages`, as mysql2 hands it back (tinyint 1/0). */
export type StageFlagRow = {
  key: string;
  isWon: boolean | number | null;
  isLost: boolean | number | null;
};

/** Keys that mean "won" when no pipeline row says otherwise. */
export const DEFAULT_WON_KEYS = ["won", "closed_won"];

/** Keys that mean "lost" when no pipeline row says otherwise. */
export const DEFAULT_LOST_KEYS = ["lost", "closed_lost"];

/**
 * Closed, but neither won nor lost. `closed` is dealAutopilot's fifth literal:
 * the autopilot has always refused to work these deals, and nothing counts them
 * as revenue or as a loss. Keeping the distinction means `isClosed` can stay
 * honest instead of forcing every closed key into one of the two buckets.
 */
export const DEFAULT_CLOSED_ONLY_KEYS = ["closed"];

/**
 * Key order of the pipeline `ensureDefaultPipeline` seeds (crm.ts LEGACY_STAGES).
 *
 * ONLY for display fallback — a funnel or stage-distribution widget rendering
 * for a workspace whose default pipeline has not been seeded yet, which happens
 * because seeding is lazy. Never use it to decide won/lost; that is what the
 * flags are for.
 */
export const DEFAULT_STAGE_ORDER = ["discovery", "qualified", "proposal", "negotiation", "won", "lost"];

type Disposition = "won" | "lost" | "open" | "closed";

export interface StageIndex {
  /** Fresh MUTABLE arrays — Drizzle's `inArray` rejects readonly ones. */
  wonKeys(): string[];
  lostKeys(): string[];
  /** won ∪ lost ∪ closed-but-neither, deduped. */
  closedKeys(): string[];
  isWon(key: string | null | undefined): boolean;
  isLost(key: string | null | undefined): boolean;
  isClosed(key: string | null | undefined): boolean;
  isOpen(key: string | null | undefined): boolean;
}

/**
 * mysql2 returns tinyint columns as 1/0, drizzle as true/false, and a partial
 * select can leave either undefined. All three have to read the same.
 */
function flagged(v: boolean | number | null | undefined): boolean {
  return !!Number(v);
}

export function buildStageIndex(rows: StageFlagRow[]): StageIndex {
  // Object.create(null): stage keys are workspace-supplied strings, and a stage
  // keyed "constructor" must not inherit an answer from Object.prototype.
  const configured = Object.create(null) as Record<string, Disposition>;
  for (const r of rows) {
    const key = r && r.key != null ? String(r.key) : "";
    if (!key) continue;
    const won = flagged(r.isWon);
    const lost = flagged(r.isLost);
    // Both ticked → LOST. The UI clears the other checkbox, but createStage and
    // updateStage accept both, and counting a deal as revenue because a
    // mis-configured stage also says Won is the more expensive way to be wrong.
    const verdict: Disposition = lost ? "lost" : won ? "won" : "open";
    const prev = configured[key];
    if (prev === undefined) {
      configured[key] = verdict;
      continue;
    }
    // Two pipelines can define the same key with different flags (the clone
    // path). Same tie-break, one level up: lost beats won beats open.
    configured[key] = prev === "lost" || verdict === "lost" ? "lost"
      : prev === "won" || verdict === "won" ? "won"
      : "open";
  }

  const disposition = Object.create(null) as Record<string, Disposition>;
  Object.keys(configured).forEach((k) => { disposition[k] = configured[k]; });
  const applyDefault = (keys: string[], d: Disposition) => {
    keys.forEach((k) => { if (configured[k] === undefined) disposition[k] = d; });
  };
  applyDefault(DEFAULT_WON_KEYS, "won");
  applyDefault(DEFAULT_LOST_KEYS, "lost");
  applyDefault(DEFAULT_CLOSED_ONLY_KEYS, "closed");

  const keysWhere = (pred: (d: Disposition) => boolean): string[] =>
    Object.keys(disposition).filter((k) => pred(disposition[k]));

  // A key that appears nowhere is OPEN. Deleting a stage leaves its deals with
  // the stored key (the delete confirm says so), so orphan keys are real and an
  // orphan must not silently become revenue.
  const at = (key: string | null | undefined): Disposition =>
    key == null ? "open" : disposition[String(key)] ?? "open";

  return {
    wonKeys: () => keysWhere((d) => d === "won"),
    lostKeys: () => keysWhere((d) => d === "lost"),
    closedKeys: () => keysWhere((d) => d !== "open"),
    isWon: (key) => at(key) === "won",
    isLost: (key) => at(key) === "lost",
    isClosed: (key) => at(key) !== "open",
    isOpen: (key) => at(key) === "open",
  };
}
