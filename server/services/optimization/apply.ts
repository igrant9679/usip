/**
 * Apply / revert handlers — the only place in the system that turns a
 * recommendation into an actual change to live outbound.
 *
 * One handler per proposal `kind`, registered in APPLY_HANDLERS. A kind with no
 * handler CANNOT be applied: `applyRecommendation` returns an explicit error
 * rather than reporting success while doing nothing (the failure mode that let
 * four of eight workflow-builder actions stay dead in this codebase for months).
 *
 * Every handler must be REVERSIBLE. Auto mode is only defensible because a bad
 * call can be undone automatically, so `revert` is part of the contract, not an
 * afterthought — and each handler re-reads current state at apply time rather
 * than trusting a snapshot taken when the proposal was generated.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { areCampaigns, optimizationRecommendations, sequences } from "../../../drizzle/schema";

export interface ApplyOutcome {
  ok: boolean;
  /** Human-readable summary of what changed, stored on the audit trail. */
  detail: string;
}

type Handler = {
  /** Perform the change. */
  apply(workspaceId: number, rec: any): Promise<ApplyOutcome>;
  /** Undo it, using `currentValue` captured before the change. */
  revert(workspaceId: number, rec: any): Promise<ApplyOutcome>;
};

/* ─── sequences: retire a dead step ─────────────────────────────────────────
 * `sequences.steps` is a JSON array; disabling means setting enabled:false on
 * one element. The sequence engine skips disabled steps (see sequenceEngine's
 * normalizeStep + the enabled===false branch) — without that, writing this flag
 * would change nothing.
 * ────────────────────────────────────────────────────────────────────────── */

async function setStepEnabled(
  workspaceId: number,
  sequenceId: number,
  stepIndex: number,
  enabled: boolean,
): Promise<ApplyOutcome> {
  const db = await getDb();
  if (!db) return { ok: false, detail: "database unavailable" };

  const [seq] = await db
    .select({ id: sequences.id, name: sequences.name, steps: sequences.steps })
    .from(sequences)
    .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId)));
  if (!seq) return { ok: false, detail: `sequence ${sequenceId} not found in this workspace` };

  const steps = Array.isArray(seq.steps) ? [...(seq.steps as any[])] : [];
  if (stepIndex < 0 || stepIndex >= steps.length) {
    // The sequence was edited after the proposal was generated.
    return { ok: false, detail: `step ${stepIndex + 1} no longer exists on "${seq.name}"` };
  }
  const current = steps[stepIndex] ?? {};
  const currentlyEnabled = current.enabled !== false;
  if (currentlyEnabled === enabled) {
    return { ok: true, detail: `step ${stepIndex + 1} of "${seq.name}" was already ${enabled ? "enabled" : "disabled"}` };
  }
  // Preserve every other field on the step — only the flag changes.
  steps[stepIndex] = { ...current, enabled };
  await db
    .update(sequences)
    .set({ steps } as never)
    .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId)));
  return {
    ok: true,
    detail: `${enabled ? "Re-enabled" : "Disabled"} step ${stepIndex + 1} of "${seq.name}"`,
  };
}

const retireDeadStep: Handler = {
  async apply(workspaceId, rec) {
    const patch = (rec.proposedValue ?? {}) as { stepIndex?: number; enabled?: boolean };
    const sequenceId = Number(rec.scopeId);
    if (!Number.isFinite(sequenceId) || typeof patch.stepIndex !== "number") {
      return { ok: false, detail: "malformed proposal: needs scopeId + proposedValue.stepIndex" };
    }
    return setStepEnabled(workspaceId, sequenceId, patch.stepIndex, patch.enabled === true);
  },
  async revert(workspaceId, rec) {
    const prev = (rec.currentValue ?? {}) as { stepIndex?: number; enabled?: boolean };
    const sequenceId = Number(rec.scopeId);
    if (!Number.isFinite(sequenceId) || typeof prev.stepIndex !== "number") {
      return { ok: false, detail: "cannot revert: original state was not recorded" };
    }
    return setStepEnabled(workspaceId, sequenceId, prev.stepIndex, prev.enabled !== false);
  },
};

/* ─── sourcing: deprioritise an unproductive source ─────────────────────────
 * `are_campaigns.prospectSources` is a JSON array of source keys. Dropping a
 * source removes it from every ACTIVE campaign that lists it; reverting adds it
 * back only to the campaigns it was actually removed from (recorded in the
 * recommendation's resultDelta at apply time).
 * ────────────────────────────────────────────────────────────────────────── */

const deprioritiseSource: Handler = {
  async apply(workspaceId, rec) {
    const db = await getDb();
    if (!db) return { ok: false, detail: "database unavailable" };
    const source = String(rec.scopeLabel ?? "").trim();
    if (!source) return { ok: false, detail: "malformed proposal: no source in scopeLabel" };

    const rows = await db
      .select({ id: areCampaigns.id, name: areCampaigns.name, prospectSources: areCampaigns.prospectSources })
      .from(areCampaigns)
      .where(eq(areCampaigns.workspaceId, workspaceId));

    const touched: number[] = [];
    for (const c of rows) {
      const list = Array.isArray(c.prospectSources) ? (c.prospectSources as any[]) : [];
      if (!list.includes(source)) continue;
      // Never strip a campaign's LAST source — that would silently stop it
      // sourcing anything at all, which is a bigger change than proposed.
      if (list.length <= 1) continue;
      await db
        .update(areCampaigns)
        .set({ prospectSources: list.filter((s) => s !== source) } as never)
        .where(eq(areCampaigns.id, c.id));
      touched.push(c.id);
    }

    if (touched.length === 0) {
      return { ok: true, detail: `No campaign needed changing — "${source}" was not in use (or was a campaign's only source)` };
    }
    // Record exactly which campaigns changed so revert is precise.
    await db
      .update(optimizationRecommendations)
      .set({ resultDelta: { revertTargets: touched, source } } as never)
      .where(eq(optimizationRecommendations.id, rec.id));
    return { ok: true, detail: `Removed "${source}" from ${touched.length} campaign(s)` };
  },

  async revert(workspaceId, rec) {
    const db = await getDb();
    if (!db) return { ok: false, detail: "database unavailable" };
    const delta = (rec.resultDelta ?? {}) as { revertTargets?: number[]; source?: string };
    const source = String(delta.source ?? rec.scopeLabel ?? "").trim();
    const targets = Array.isArray(delta.revertTargets) ? delta.revertTargets : [];
    if (!source || targets.length === 0) {
      return { ok: false, detail: "cannot revert: no record of which campaigns were changed" };
    }
    let restored = 0;
    for (const id of targets) {
      const [c] = await db
        .select({ id: areCampaigns.id, prospectSources: areCampaigns.prospectSources })
        .from(areCampaigns)
        .where(and(eq(areCampaigns.id, id), eq(areCampaigns.workspaceId, workspaceId)));
      if (!c) continue;
      const list = Array.isArray(c.prospectSources) ? (c.prospectSources as any[]) : [];
      if (list.includes(source)) continue;
      await db
        .update(areCampaigns)
        .set({ prospectSources: [...list, source] } as never)
        .where(eq(areCampaigns.id, id));
      restored++;
    }
    return { ok: true, detail: `Restored "${source}" to ${restored} campaign(s)` };
  },
};

export const APPLY_HANDLERS: Record<string, Handler> = {
  retire_dead_step: retireDeadStep,
  deprioritise_unproductive_source: deprioritiseSource,
};

/** Can this recommendation be applied by code at all? */
export function isApplicable(rec: { kind?: string; proposedValue?: unknown }): boolean {
  return !!rec.kind && !!APPLY_HANDLERS[rec.kind] && rec.proposedValue != null;
}

/**
 * Apply a recommendation and mark it `applied`. Records who/when and captures a
 * metric snapshot so the attribution pass can judge the change later.
 */
export async function applyRecommendation(
  workspaceId: number,
  rec: any,
  byUserId: number | null,
): Promise<ApplyOutcome> {
  const db = await getDb();
  if (!db) return { ok: false, detail: "database unavailable" };

  const handler = APPLY_HANDLERS[String(rec.kind)];
  if (!handler) {
    // Loud failure by design: an advisory proposal must never look applied.
    return { ok: false, detail: `"${rec.kind}" is advisory — there is no automatic change to apply` };
  }
  if (rec.proposedValue == null) {
    return { ok: false, detail: "this recommendation carries no change to apply" };
  }

  // Snapshot BEFORE the change — this is what the attribution pass compares
  // against to decide whether the advice helped, and to auto-revert if not.
  let baseline: unknown = null;
  try {
    const { snapshotMetrics } = await import("./attribution");
    baseline = await snapshotMetrics(workspaceId);
  } catch (e) {
    // A missing baseline only costs us attribution, so don't block the apply.
    console.error(`[Optimization] baseline snapshot failed for rec ${rec.id}:`, (e as Error).message);
  }

  const outcome = await handler.apply(workspaceId, rec);
  if (!outcome.ok) return outcome;

  // Re-read resultDelta: a handler may have written to it (the source handler
  // records which campaigns it touched), and that must not be clobbered.
  const [fresh] = await db
    .select({ resultDelta: optimizationRecommendations.resultDelta })
    .from(optimizationRecommendations)
    .where(eq(optimizationRecommendations.id, rec.id));
  const merged = { ...((fresh?.resultDelta ?? {}) as Record<string, unknown>), baseline, appliedDetail: outcome.detail };

  await db
    .update(optimizationRecommendations)
    .set({
      status: "applied" as never,
      appliedAt: new Date(),
      appliedByUserId: byUserId,
      resultDelta: merged,
    } as never)
    .where(eq(optimizationRecommendations.id, rec.id));

  return outcome;
}

/** Revert an applied recommendation and mark it `reverted`. */
export async function revertRecommendation(
  workspaceId: number,
  rec: any,
  reason: string,
): Promise<ApplyOutcome> {
  const db = await getDb();
  if (!db) return { ok: false, detail: "database unavailable" };

  const handler = APPLY_HANDLERS[String(rec.kind)];
  if (!handler) return { ok: false, detail: `no revert handler for "${rec.kind}"` };

  const outcome = await handler.revert(workspaceId, rec);
  if (!outcome.ok) return outcome;

  const prevDelta = (rec.resultDelta ?? {}) as Record<string, unknown>;
  await db
    .update(optimizationRecommendations)
    .set({
      status: "reverted" as never,
      resultDelta: { ...prevDelta, revertedReason: reason, revertedAt: new Date().toISOString() },
    } as never)
    .where(eq(optimizationRecommendations.id, rec.id));

  return { ok: true, detail: `${outcome.detail} (reverted: ${reason})` };
}
