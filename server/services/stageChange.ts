/**
 * stageChange.ts — the ONE way a deal changes stage (audit 2026-10-20, Phase 2:
 * R13, R14, R16, R20, R21).
 *
 * 🔴 THE BUGS. Five endpoints wrote opportunities.stage — the kanban
 * (crm.setStage), the Alerts page (pipelineAlerts.moveDealStage), the manager
 * approval queue (opportunityIntelligence.reviewStageChange) and both proposal
 * accepts — and each did a different subset of what a stage change means. The
 * Alerts move skipped the win %, the history, the audit and the owner's
 * notice; the proposal paths skipped the history; none recorded when a deal
 * was won or lost, so every revenue number read updatedAt. A card dropped back
 * on its own column replayed the whole change (workflows, won side effects,
 * history), and a double click on a proposal accept did it twice. A stage key
 * from another pipeline was accepted and stranded the deal off its board.
 *
 * Now every path calls changeOpportunityStage, which:
 *   • refuses a stage that is not in the deal's own pipeline;
 *   • does nothing when the stage is unchanged;
 *   • writes the move with a conditional UPDATE that names the stage it read,
 *     so of two simultaneous moves only one lands and runs its side effects;
 *   • records stageEnteredAt, and wonAt / lostAt (cleared when the deal leaves
 *     a closed stage), which quota and the deal metrics count from;
 *   • then writes the history, tells the owner, runs closed-won (the account
 *     becomes a Customer) or closed-lost (a win-back task), audits, and fires
 *     the stage_changed workflow rules — for every path alike.
 *
 * The pipeline settings write deals' stages too, when a stage or pipeline is
 * deleted, re-keyed or re-flagged (R18) — those helpers are at the end of
 * this file, so this stays the only module that writes opportunities.stage.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull, like, or } from "drizzle-orm";
import { activeTaskStatuses } from "@shared/taskStatus";
import { crmPipelineStages, opportunities, opportunityStageHistory, tasks } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import type { getDb } from "../db";
import { activeOwnerOrNull, workspaceNotifyUserId } from "../_core/activeMembers";
import { stageResolver } from "../_core/stageSemantics";
import { notifyIfEnabled } from "./policyNotify";
import { ensureCustomerForWonOpp } from "./wonToCustomer";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type StageChangeSource = "board" | "alerts" | "approval" | "proposal" | "proposal_portal";

export type StageChangeResult = {
  /** False when the stage was already this one, or another move landed first. */
  changed: boolean;
  isWon: boolean;
  isLost: boolean;
  customerCreated: boolean;
  fromStage: string | null;
};

const DAY_MS = 86_400_000;

/**
 * The stage dates a NEW deal starts with: it entered its stage now, and a deal
 * created already won or lost closed now. Every insert into opportunities
 * spreads this, so no deal starts without the dates the metrics count from.
 */
export function stageDatesForNewDeal(meta: { isWon: boolean; isLost: boolean }, now: Date = new Date()) {
  return { stageEnteredAt: now, wonAt: meta.isWon ? now : null, lostAt: meta.isLost ? now : null };
}

export async function changeOpportunityStage(
  db: Db,
  input: {
    workspaceId: number;
    opportunityId: number;
    toStage: string;
    /** Who moved it. Null for a client on the public proposal portal. */
    actorUserId: number | null;
    actorName?: string | null;
    source: StageChangeSource;
    /** Written to the stage history. */
    note?: string | null;
    /** Fields that change WITH the stage (the proposal's value on accept). */
    alsoSet?: { value?: string };
    /** Overrides the stage's default win %. */
    winProb?: number;
  },
): Promise<StageChangeResult> {
  const { workspaceId, opportunityId, toStage } = input;
  const [before] = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.id, opportunityId), eq(opportunities.workspaceId, workspaceId)))
    .limit(1);
  if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Opportunity not found" });

  const stages = await stageResolver(db, workspaceId);
  if (!stages.allowedKeys(before.pipelineId ?? null).includes(toStage)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${toStage}" is not a stage in this deal's pipeline. Pick one of its own stages.`,
    });
  }

  const meta = stages.resolve(before.pipelineId ?? null, toStage);
  const unchanged: StageChangeResult = {
    changed: false, isWon: meta.isWon, isLost: meta.isLost, customerCreated: false, fromStage: before.stage,
  };
  if (before.stage === toStage) return unchanged;

  const now = new Date();
  const winProb = input.winProb ?? (meta.isWon ? 100 : meta.isLost ? 0 : meta.defaultWinProb ?? before.winProb);
  const res = await db
    .update(opportunities)
    .set({
      stage: toStage,
      winProb,
      daysInStage: 0,
      stageEnteredAt: now,
      wonAt: meta.isWon ? now : null,
      lostAt: meta.isLost ? now : null,
      ...(input.alsoSet?.value !== undefined ? { value: input.alsoSet.value } : {}),
    } as never)
    .where(and(
      eq(opportunities.id, opportunityId),
      eq(opportunities.workspaceId, workspaceId),
      eq(opportunities.stage, before.stage),
    ));
  if (Number((res as any)?.[0]?.affectedRows ?? (res as any)?.affectedRows ?? 0) !== 1) return unchanged;

  const enteredAt = before.stageEnteredAt ? new Date(before.stageEnteredAt).getTime() : null;
  const daysInPrevStage = enteredAt != null ? Math.max(0, Math.floor((now.getTime() - enteredAt) / DAY_MS)) : before.daysInStage ?? null;
  // The side effects below are best-effort: the move has landed, and a failed
  // notice or task must not turn it into an error the caller retries.
  try {
    await db.insert(opportunityStageHistory).values({
      workspaceId,
      opportunityId,
      fromStage: before.stage,
      toStage,
      changedByUserId: input.actorUserId,
      daysInPrevStage,
      note: input.note ?? null,
    });
  } catch (e) {
    console.warn(`[stageChange] history insert failed for opportunity ${opportunityId}:`, e);
  }

  // The owner hears about it, unless they did it themselves.
  if (before.ownerUserId && before.ownerUserId !== input.actorUserId) {
    try {
      await notifyIfEnabled({
        workspaceId,
        userId: before.ownerUserId,
        event: "dealMoved",
        kind: "system",
        title: `Deal moved: ${before.name}`,
        body: `${input.actorName ?? (input.source === "proposal_portal" ? "The client" : "Someone")} moved "${before.name}" from ${before.stage} to ${toStage}.`,
        relatedType: "opportunity",
        relatedId: opportunityId,
      });
    } catch (e) {
      console.warn(`[stageChange] owner notice failed for opportunity ${opportunityId}:`, e);
    }
  }

  // Closed Won → the account becomes a Customer (post-sale handoff). The CSM
  // fallback must be an active member: the mover, or — on the portal, which
  // has no session — the workspace's notify user. With neither, no customer.
  let customerCreated = false;
  if (meta.isWon) {
    try {
      const fallbackUserId = input.actorUserId ?? (await workspaceNotifyUserId(workspaceId));
      if (fallbackUserId) {
        customerCreated = await ensureCustomerForWonOpp(
          db, workspaceId,
          { accountId: before.accountId, value: input.alsoSet?.value ?? before.value, ownerUserId: before.ownerUserId },
          fallbackUserId,
        );
      }
    } catch (e) {
      console.warn(`[stageChange] closed-won customer creation failed for opportunity ${opportunityId}:`, e);
    }
  }

  // Closed Lost → a win-back touch in ~90 days, once.
  if (meta.isLost) {
    try {
      const [existing] = await db.select({ id: tasks.id }).from(tasks).where(and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.relatedType, "opportunity"),
        eq(tasks.relatedId, opportunityId),
        like(tasks.title, "Win-back:%"),
        inArray(tasks.status, activeTaskStatuses()),
      )).limit(1);
      if (!existing) {
        await db.insert(tasks).values({
          workspaceId,
          title: `Win-back: ${before.name ?? "the deal"}`.slice(0, 240),
          description: `"${before.name ?? "the deal"}" closed lost from stage "${before.stage}". Check back in — circumstances (budget, priorities, the champion's role) often change within a quarter.`,
          type: "follow_up",
          priority: "normal",
          status: "open",
          dueAt: new Date(now.getTime() + 90 * DAY_MS),
          ownerUserId: await activeOwnerOrNull(workspaceId, before.ownerUserId),
          relatedType: "opportunity",
          relatedId: opportunityId,
          source: "ai",
          aiReasoning: "Auto-created on closed-lost so the deal re-enters nurture instead of being abandoned.",
          aiConfidence: 70,
        } as never);
      }
    } catch (e) {
      console.warn(`[stageChange] closed-lost win-back task failed for opportunity ${opportunityId}:`, e);
    }
  }

  try {
    await recordAudit({
      workspaceId,
      actorUserId: input.actorUserId,
      action: "update",
      entityType: "opportunity",
      entityId: opportunityId,
      before: { stage: before.stage },
      after: { stage: toStage, source: input.source, customerCreated },
    });
  } catch (e) {
    console.warn(`[stageChange] audit failed for opportunity ${opportunityId}:`, e);
  }

  // "When a deal is won" is the rule people build first; every path fires it.
  void import("./workflowEngine")
    .then((m) => m.fireStageChanged(
      workspaceId, opportunityId, before.stage ?? null, toStage,
      {
        value: Number(input.alsoSet?.value ?? before.value ?? 0),
        winProb, isWon: meta.isWon, isLost: meta.isLost, name: before.name ?? null,
      },
      before.ownerUserId ?? null,
    ))
    .catch(() => { /* workflow firing is best-effort */ });

  return { changed: true, isWon: meta.isWon, isLost: meta.isLost, customerCreated, fromStage: before.stage };
}

/* ── Pipeline settings (R18) ─────────────────────────────────────────────
 * 🔴 Deleting a stage or a pipeline left its deals holding a key no board has
 * a column for: they vanished from /pipeline and /deals while every revenue
 * number still counted them, and deleting the Won stage turned its past wins
 * into open pipeline. A deal now always moves with the change.
 */

/** The deals on a pipeline's board: its own, and — for the default pipeline — those with no pipeline. */
export function boardDealsWhere(workspaceId: number, pipeline: { id: number; isDefault: boolean | number | null }, stageKey?: string) {
  const onBoard = pipeline.isDefault
    ? or(eq(opportunities.pipelineId, pipeline.id), isNull(opportunities.pipelineId))
    : eq(opportunities.pipelineId, pipeline.id);
  return stageKey !== undefined
    ? and(eq(opportunities.workspaceId, workspaceId), onBoard, eq(opportunities.stage, stageKey))
    : and(eq(opportunities.workspaceId, workspaceId), onBoard);
}

type PipelineRef = { id: number; isDefault: boolean | number | null };

/**
 * A stage is being deleted: move its deals to another stage of the SAME kind
 * in the same pipeline (open → open, won → won, lost → lost), so a win stays a
 * win, with its won date. Recorded in each deal's history. Returns the count.
 */
export async function moveDealsOffStage(
  db: Db,
  input: { workspaceId: number; pipeline: PipelineRef; fromKey: string; toKey: string; actorUserId: number; note: string },
): Promise<number> {
  const deals = await db.select({ id: opportunities.id, stageEnteredAt: opportunities.stageEnteredAt })
    .from(opportunities).where(boardDealsWhere(input.workspaceId, input.pipeline, input.fromKey));
  const now = new Date();
  for (const d of deals) {
    await db.update(opportunities).set({ stage: input.toKey, stageEnteredAt: now, daysInStage: 0 } as never)
      .where(and(eq(opportunities.id, d.id), eq(opportunities.workspaceId, input.workspaceId), eq(opportunities.stage, input.fromKey)));
    try {
      await db.insert(opportunityStageHistory).values({
        workspaceId: input.workspaceId, opportunityId: d.id, fromStage: input.fromKey, toStage: input.toKey,
        changedByUserId: input.actorUserId,
        daysInPrevStage: d.stageEnteredAt ? Math.max(0, Math.floor((now.getTime() - new Date(d.stageEnteredAt).getTime()) / DAY_MS)) : null,
        note: input.note,
      });
    } catch (e) {
      console.warn(`[stageChange] history insert failed for opportunity ${d.id}:`, e);
    }
  }
  return deals.length;
}

/** A stage's key changed: its deals keep their place (same stage, new key). */
export async function rekeyStageDeals(
  db: Db,
  input: { workspaceId: number; pipeline: PipelineRef; fromKey: string; toKey: string },
): Promise<void> {
  await db.update(opportunities).set({ stage: input.toKey })
    .where(boardDealsWhere(input.workspaceId, input.pipeline, input.fromKey));
}

/**
 * A stage was flagged (or unflagged) Won or Lost: the deals in it are
 * reclassified at read time, so their won / lost dates follow. A newly won
 * deal counts from when it entered the stage; an unflagged one loses the date.
 */
export async function restampStageDeals(
  db: Db,
  input: { workspaceId: number; pipeline: PipelineRef; key: string; isWon: boolean; isLost: boolean },
): Promise<void> {
  const deals = await db.select({
    id: opportunities.id, wonAt: opportunities.wonAt, lostAt: opportunities.lostAt, stageEnteredAt: opportunities.stageEnteredAt,
  }).from(opportunities).where(boardDealsWhere(input.workspaceId, input.pipeline, input.key));
  const now = new Date();
  for (const d of deals) {
    const since = d.stageEnteredAt ?? now;
    await db.update(opportunities).set({
      wonAt: input.isWon ? d.wonAt ?? since : null,
      lostAt: input.isLost ? d.lostAt ?? since : null,
    } as never).where(and(eq(opportunities.id, d.id), eq(opportunities.workspaceId, input.workspaceId)));
  }
}

/**
 * A pipeline is being deleted: move its deals onto another one. Each keeps its
 * stage where the target has the same key, else goes to the target's first
 * stage of the same kind. Throws, moving nothing, when the target has no stage
 * of a kind some deal needs.
 */
export async function moveDealsToPipeline(
  db: Db,
  input: { workspaceId: number; from: PipelineRef; toPipelineId: number; actorUserId: number; note: string },
): Promise<number> {
  const target = await db.select({
    key: crmPipelineStages.key, isWon: crmPipelineStages.isWon, isLost: crmPipelineStages.isLost,
  }).from(crmPipelineStages)
    .where(and(eq(crmPipelineStages.workspaceId, input.workspaceId), eq(crmPipelineStages.pipelineId, input.toPipelineId)))
    .orderBy(asc(crmPipelineStages.sortOrder), asc(crmPipelineStages.id));
  const kindOf = (r: { isWon: unknown; isLost: unknown }) => (Number(r.isLost) ? "lost" : Number(r.isWon) ? "won" : "open");
  const firstOfKind = (k: string) => target.find((r) => kindOf(r) === k)?.key ?? null;

  const stages = await stageResolver(db, input.workspaceId);
  const deals = await db.select({ id: opportunities.id, stage: opportunities.stage, pipelineId: opportunities.pipelineId, stageEnteredAt: opportunities.stageEnteredAt })
    .from(opportunities).where(boardDealsWhere(input.workspaceId, input.from));
  const plan = deals.map((d) => {
    const meta = stages.resolve(d.pipelineId ?? input.from.id, d.stage);
    const kind = meta.isWon ? "won" : meta.isLost ? "lost" : "open";
    const same = target.find((r) => r.key === d.stage && kindOf(r) === kind);
    return { ...d, kind, toKey: same ? same.key : firstOfKind(kind) };
  });
  const missing = plan.find((p) => !p.toKey);
  if (missing) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `The pipeline you picked has no ${missing.kind === "open" ? "open" : missing.kind === "won" ? "Won" : "Lost"} stage for its deals to go to. Add one there first.`,
    });
  }
  const now = new Date();
  for (const d of plan) {
    const restage = d.toKey !== d.stage;
    await db.update(opportunities).set({
      pipelineId: input.toPipelineId,
      ...(restage ? { stage: d.toKey, stageEnteredAt: now, daysInStage: 0 } : {}),
    } as never).where(and(eq(opportunities.id, d.id), eq(opportunities.workspaceId, input.workspaceId)));
    if (restage) {
      try {
        await db.insert(opportunityStageHistory).values({
          workspaceId: input.workspaceId, opportunityId: d.id, fromStage: d.stage, toStage: d.toKey!,
          changedByUserId: input.actorUserId,
          daysInPrevStage: d.stageEnteredAt ? Math.max(0, Math.floor((now.getTime() - new Date(d.stageEnteredAt).getTime()) / DAY_MS)) : null,
          note: input.note,
        });
      } catch (e) {
        console.warn(`[stageChange] history insert failed for opportunity ${d.id}:`, e);
      }
    }
  }
  return plan.length;
}
