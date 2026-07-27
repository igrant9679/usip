/**
 * Optimisation runner — executes the analyzers and persists their proposals.
 *
 * Phase 2 scope: GENERATE ONLY. Nothing here applies a change. Every proposal
 * lands as `pending` for a human to approve or dismiss; the apply path and its
 * Off/Approve/Auto gating are Phase 3. Keeping generation and application in
 * separate commits means the recommendations can be judged on a live workspace
 * before anything is allowed to act on them.
 *
 * Dedupe policy — check-then-insert, not upsert, for two reasons:
 *   • MySQL treats NULLs as distinct in unique indexes and `scopeId` is NULL for
 *     global-scope rows, so a unique index would silently admit duplicates.
 *   • A DISMISSED recommendation must stay dismissed. Re-proposing something the
 *     user rejected every night is how a "smart" feature becomes noise the user
 *     turns off. Only `reverted` and `superseded` rows allow a fresh proposal.
 */
import { and, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import { optimizationRecommendations, workspaceSettings } from "../../../drizzle/schema";
import { applyRecommendation, isApplicable } from "./apply";
import { crmAnalyzer } from "./crmAnalyzer";
import { sdrAnalyzer } from "./sdrAnalyzer";
import { sequenceAnalyzer } from "./sequenceAnalyzer";
import { sourceAnalyzer } from "./sourceAnalyzer";
import { voiceAnalyzer } from "./voiceAnalyzer";
import { chatAnalyzer } from "./chatAnalyzer";
import type { Analyzer, Proposal } from "./types";

/** Registered analyzers. Adding a module = adding it to this list. */
export const ANALYZERS: Analyzer[] = [
  sequenceAnalyzer,
  sourceAnalyzer,
  crmAnalyzer,
  sdrAnalyzer,
  voiceAnalyzer,
  chatAnalyzer,
];

/** Statuses that block an identical new proposal. */
const BLOCKING_STATUSES = ["pending", "approved", "applied", "dismissed"] as const;

export interface RunResult {
  proposed: number;
  skippedDuplicate: number;
  analyzersRun: number;
  autoApplied: number;
  errors: string[];
}

/**
 * Confidence required before a change may be applied UNATTENDED.
 *
 * 'low' is excluded deliberately: confidenceFromSample only reaches 'medium' at
 * n>=75, so Auto mode cannot act on a handful of observations. A human in
 * Approve mode may still accept a low-confidence proposal — they can weigh
 * context the analyzer cannot.
 */
const AUTO_MIN_CONFIDENCE = ["medium", "high"];

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** True when an equivalent recommendation already exists in a blocking state. */
async function alreadyExists(db: any, workspaceId: number, p: Proposal): Promise<boolean> {
  const conditions = [
    eq(optimizationRecommendations.workspaceId, workspaceId),
    eq(optimizationRecommendations.module, p.module as never),
    eq(optimizationRecommendations.kind, p.kind),
    eq(optimizationRecommendations.scopeType, p.scopeType as never),
    inArray(optimizationRecommendations.status, BLOCKING_STATUSES as unknown as string[]),
  ];
  const rows = await db
    .select({
      id: optimizationRecommendations.id,
      scopeId: optimizationRecommendations.scopeId,
      scopeLabel: optimizationRecommendations.scopeLabel,
    })
    .from(optimizationRecommendations)
    .where(and(...conditions));

  // scopeId is NULL for global/source scopes, so compare it in JS (a SQL
  // `= NULL` never matches) and fall back to scopeLabel, which is what
  // actually distinguishes one source from another.
  return rows.some(
    (r: any) =>
      (r.scopeId ?? null) === (p.scopeId ?? null) &&
      (r.scopeLabel ?? null) === (p.scopeLabel ?? null),
  );
}

/** Applies remaining in today's change budget, and whether Auto is even on. */
async function autoBudget(db: any, workspaceId: number): Promise<{ mode: string; remaining: number }> {
  const [settings] = await db
    .select({
      mode: workspaceSettings.optimizationMode,
      cap: workspaceSettings.optimizationDailyCap,
    })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId));
  // No settings row yet → treat as the column default ('approval'), i.e. review.
  const mode = String(settings?.mode ?? "approval");
  if (mode !== "auto") return { mode, remaining: 0 };

  const cap = Number(settings?.cap ?? 3);
  const todaysApplies = await db
    .select({ id: optimizationRecommendations.id })
    .from(optimizationRecommendations)
    .where(and(
      eq(optimizationRecommendations.workspaceId, workspaceId),
      eq(optimizationRecommendations.status, "applied" as never),
      gte(optimizationRecommendations.appliedAt, startOfUtcDay()),
    ));
  return { mode, remaining: Math.max(0, cap - todaysApplies.length) };
}

/**
 * Run every analyzer for one workspace, persist new proposals, and — only when
 * optimizationMode is 'auto' — apply the ones that clear the confidence gate,
 * up to the daily change budget.
 *
 * `force` lets a human "Analyse now" even when the mode is 'off'.
 */
export async function runOptimizationAnalyzers(workspaceId: number, force = false): Promise<RunResult> {
  const result: RunResult = { proposed: 0, skippedDuplicate: 0, analyzersRun: 0, autoApplied: 0, errors: [] };
  const db = await getDb();
  if (!db) {
    result.errors.push("database unavailable");
    return result;
  }

  const budget = await autoBudget(db, workspaceId);
  // 'off' means the analyzers don't run at all — no work, no cost.
  if (budget.mode === "off" && !force) return result;
  let remaining = budget.remaining;

  for (const analyzer of ANALYZERS) {
    let proposals: Proposal[] = [];
    try {
      proposals = await analyzer.run(workspaceId);
      result.analyzersRun++;
    } catch (e) {
      // One analyzer failing must not stop the others.
      result.errors.push(`${analyzer.name}: ${(e as Error).message}`);
      continue;
    }

    for (const p of proposals) {
      try {
        if (await alreadyExists(db, workspaceId, p)) {
          result.skippedDuplicate++;
          continue;
        }
        const ins = await db.insert(optimizationRecommendations).values({
          workspaceId,
          module: p.module as never,
          scopeType: p.scopeType as never,
          scopeId: p.scopeId ?? null,
          scopeLabel: p.scopeLabel ? p.scopeLabel.slice(0, 160) : null,
          kind: p.kind.slice(0, 64),
          title: p.title.slice(0, 240),
          rationale: p.rationale,
          evidence: p.evidence,
          sampleSize: p.sampleSize,
          confidence: p.confidence as never,
          currentValue: p.currentValue,
          proposedValue: p.proposedValue,
          status: "pending" as never,
          generatedBy: p.generatedBy ?? "rules",
        } as never);
        result.proposed++;

        /* Auto mode: apply now if this proposal clears every gate. Anything that
           fails a gate simply stays `pending` for a human — an unapplied
           proposal is a safe outcome, a wrongly-applied one is not. */
        if (
          budget.mode === "auto" &&
          remaining > 0 &&
          isApplicable(p) &&
          AUTO_MIN_CONFIDENCE.includes(p.confidence)
        ) {
          const id = Number((ins as any)?.[0]?.insertId ?? 0);
          if (id > 0) {
            const [row] = await db
              .select()
              .from(optimizationRecommendations)
              .where(eq(optimizationRecommendations.id, id));
            if (row) {
              // byUserId null marks this as the system's own decision.
              const outcome = await applyRecommendation(workspaceId, row, null);
              if (outcome.ok) {
                result.autoApplied++;
                remaining--;
                console.log(`[Optimization] ws ${workspaceId} AUTO-APPLIED rec ${id}: ${outcome.detail}`);
              } else {
                result.errors.push(`auto-apply ${id}: ${outcome.detail}`);
              }
            }
          }
        }
      } catch (e) {
        result.errors.push(`${analyzer.name} insert: ${(e as Error).message}`);
      }
    }
  }

  return result;
}

/**
 * Cron entry: generate recommendations for every workspace.
 *
 * Safe to run unattended — it only writes `pending` rows and makes no LLM calls
 * (the analyzers are deterministic), so an idle workspace costs one set of
 * aggregate queries and nothing else. That matters here: background LLM spend on
 * paused campaigns has bitten this codebase before.
 */
export async function runOptimizationForAllWorkspaces(): Promise<{ workspaces: number; proposed: number }> {
  const db = await getDb();
  if (!db) return { workspaces: 0, proposed: 0 };
  const { workspaces } = await import("../../../drizzle/schema");
  const rows = await db.select({ id: workspaces.id }).from(workspaces);

  let count = 0;
  let proposed = 0;
  for (const ws of rows) {
    try {
      const r = await runOptimizationAnalyzers(ws.id);
      proposed += r.proposed;
      count++;
      if (r.proposed > 0 || r.autoApplied > 0 || r.errors.length > 0) {
        console.log(
          `[Optimization] ws ${ws.id}: proposed=${r.proposed} autoApplied=${r.autoApplied} duplicates=${r.skippedDuplicate}` +
            (r.errors.length ? ` errors=${r.errors.join("; ")}` : ""),
        );
      }
      await db
        .update(workspaceSettings)
        .set({ optimizationLastRunAt: new Date() } as never)
        .where(eq(workspaceSettings.workspaceId, ws.id));
    } catch (e) {
      console.error(`[Optimization] ws ${ws.id} failed:`, (e as Error).message);
    }
  }
  return { workspaces: count, proposed };
}
