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
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import { optimizationRecommendations } from "../../../drizzle/schema";
import { sequenceAnalyzer } from "./sequenceAnalyzer";
import { sourceAnalyzer } from "./sourceAnalyzer";
import type { Analyzer, Proposal } from "./types";

/** Registered analyzers. Adding a module = adding it to this list. */
export const ANALYZERS: Analyzer[] = [sequenceAnalyzer, sourceAnalyzer];

/** Statuses that block an identical new proposal. */
const BLOCKING_STATUSES = ["pending", "approved", "applied", "dismissed"] as const;

export interface RunResult {
  proposed: number;
  skippedDuplicate: number;
  analyzersRun: number;
  errors: string[];
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

/** Run every analyzer for one workspace and persist new proposals. */
export async function runOptimizationAnalyzers(workspaceId: number): Promise<RunResult> {
  const result: RunResult = { proposed: 0, skippedDuplicate: 0, analyzersRun: 0, errors: [] };
  const db = await getDb();
  if (!db) {
    result.errors.push("database unavailable");
    return result;
  }

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
        await db.insert(optimizationRecommendations).values({
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
      if (r.proposed > 0 || r.errors.length > 0) {
        console.log(
          `[Optimization] ws ${ws.id}: proposed=${r.proposed} duplicates=${r.skippedDuplicate}` +
            (r.errors.length ? ` errors=${r.errors.join("; ")}` : ""),
        );
      }
    } catch (e) {
      console.error(`[Optimization] ws ${ws.id} failed:`, (e as Error).message);
    }
  }
  return { workspaces: count, proposed };
}
