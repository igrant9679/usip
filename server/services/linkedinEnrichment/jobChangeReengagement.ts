/**
 * Job-change re-engagement — the autonomous action behind Data enrichment ›
 * "Job change alerts".
 *
 * LinkedIn enrichment already DETECTS when a saved prospect changes companies
 * (`company_changed`, written to prospect_linkedin_field_changes). A champion
 * moving companies is one of the strongest sales triggers there is — it opens a
 * warm re-introduction at the new company AND a backfill opportunity at the old
 * one. This module turns that detection into a booked-meeting driver: on a
 * detected company change it autonomously creates a re-engagement follow-up
 * task, gated by the per-workspace Job Change Autopilot mode:
 *
 *   off      → nothing (the change is still surfaced in the alerts feed)
 *   approval → draft task (status='draft') for a human to approve
 *   auto     → live task (status='open'), fully hands-off
 *
 * Best-effort by design: never throws into the enrichment path, dedupes so a
 * prospect never accrues two open re-engagement tasks, and respects a daily cap.
 */
import { and, desc, eq, gte, inArray, like, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { prospects, prospectLinkedinFieldChanges, tasks, workspaceSettings } from "../../../drizzle/schema";
import type { DetectedChange } from "./snapshot";

/** All job-change tasks share this title prefix — used as the dedupe key. */
const REENGAGE_PREFIX = "Re-engage:";
const ACTIVE_STATUSES = ["open", "draft", "in_progress", "snoozed"];

export interface JobChangeReengageResult {
  created: boolean;
  reason: "created" | "off" | "no_company_change" | "already_active" | "cap_reached" | "no_prospect" | "error";
  taskStatus?: "draft" | "open";
}

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Given the changes just detected for a prospect, create a re-engagement task
 * if a company change is present and the workspace's Job Change Autopilot is on.
 */
export async function maybeCreateJobChangeReengagement(
  workspaceId: number,
  prospectId: number,
  changes: DetectedChange[],
  opts: { force?: boolean } = {},
): Promise<JobChangeReengageResult> {
  try {
    // Prefer the human-readable company-name change for the alert copy.
    const companyChange =
      changes.find((c) => c.changeType === "company_changed" && c.fieldName === "current_company_name") ??
      changes.find((c) => c.changeType === "company_changed");
    if (!companyChange) return { created: false, reason: "no_company_change" };

    const db = await getDb();
    if (!db) return { created: false, reason: "error" };

    const [settings] = await db
      .select({
        mode: workspaceSettings.jobChangeAutopilotMode,
        cap: workspaceSettings.jobChangeAutopilotDailyCap,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId));
    // A manual "Re-engage" click (force) creates a live task regardless of mode;
    // the autopilot path honors the workspace's Off/Approve/Auto setting.
    const mode = opts.force ? "auto" : (settings?.mode ?? "off");
    if (mode === "off") return { created: false, reason: "off" };

    // Compliance + display context.
    const [p] = await db
      .select({
        firstName: prospects.firstName,
        lastName: prospects.lastName,
        title: prospects.title,
        verificationStatus: prospects.verificationStatus,
      })
      .from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), eq(prospects.id, prospectId)));
    if (!p) return { created: false, reason: "no_prospect" };
    if (p.verificationStatus === "rejected") return { created: false, reason: "off" };

    // Dedupe: never stack two open re-engagement tasks on the same prospect.
    const existing = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.relatedType, "prospect"),
        eq(tasks.relatedId, prospectId),
        like(tasks.title, `${REENGAGE_PREFIX}%`),
        inArray(tasks.status, ACTIVE_STATUSES),
      ))
      .limit(1);
    if (existing.length > 0) return { created: false, reason: "already_active" };

    // Daily cap — count job-change tasks created this workspace since UTC midnight.
    const cap = settings?.cap ?? 25;
    const [capRow] = await db
      .select({ n: sql<number>`count(*)` })
      .from(tasks)
      .where(and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.source, "ai"),
        like(tasks.title, `${REENGAGE_PREFIX}%`),
        gte(tasks.createdAt, startOfUtcDay()),
      ));
    if (Number(capRow?.n ?? 0) >= cap) return { created: false, reason: "cap_reached" };

    const name = `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "this prospect";
    const oldCompany = companyChange.oldValue?.trim() || "their previous company";
    const newCompany = companyChange.newValue?.trim() || "a new company";
    const targetStatus = mode === "auto" ? "open" : "draft";

    const title = `${REENGAGE_PREFIX} ${name} moved to ${newCompany}`.slice(0, 240);
    const reasoning =
      `${name} (${p.title ?? "prospect"}) changed companies: ${oldCompany} → ${newCompany}. ` +
      `Job changes are a top meeting-booking trigger — reconnect warmly at the new company to re-open the ` +
      `relationship, and consider the backfill opportunity at ${oldCompany}.`;

    await db.insert(tasks).values({
      workspaceId,
      title,
      description: reasoning,
      type: "follow_up",
      priority: "high",
      status: targetStatus,
      dueAt: new Date(Date.now() + 2 * 86400000),
      relatedType: "prospect",
      relatedId: prospectId,
      source: "ai",
      aiReasoning: reasoning,
      aiConfidence: 85,
    } as never);

    await db
      .update(workspaceSettings)
      .set({ jobChangeAutopilotLastRunAt: new Date() })
      .where(eq(workspaceSettings.workspaceId, workspaceId));

    return { created: true, reason: "created", taskStatus: targetStatus };
  } catch (e) {
    console.error(`[JobChangeReengage] ws ${workspaceId} prospect ${prospectId} failed:`, (e as Error).message);
    return { created: false, reason: "error" };
  }
}

/**
 * Manual "Re-engage" — creates a live re-engagement task on demand from the Job
 * change alerts feed. Looks up the prospect's most recent detected company
 * change, then forces creation (bypassing the Off/Approve/Auto mode gate, but
 * still deduped + capped).
 */
export async function reengageProspectManually(
  workspaceId: number,
  prospectId: number,
): Promise<JobChangeReengageResult> {
  const db = await getDb();
  if (!db) return { created: false, reason: "error" };

  const [row] = await db
    .select({
      fieldName: prospectLinkedinFieldChanges.fieldName,
      oldValue: prospectLinkedinFieldChanges.oldValue,
      newValue: prospectLinkedinFieldChanges.newValue,
    })
    .from(prospectLinkedinFieldChanges)
    .where(and(
      eq(prospectLinkedinFieldChanges.workspaceId, workspaceId),
      eq(prospectLinkedinFieldChanges.prospectId, prospectId),
      eq(prospectLinkedinFieldChanges.changeType, "company_changed"),
      eq(prospectLinkedinFieldChanges.fieldName, "current_company_name"),
    ))
    .orderBy(desc(prospectLinkedinFieldChanges.detectedAt))
    .limit(1);
  if (!row) return { created: false, reason: "no_company_change" };

  const change: DetectedChange = {
    fieldName: "current_company_name",
    changeType: "company_changed",
    priority: "high",
    label: "Company changed",
    oldValue: row.oldValue ?? null,
    newValue: row.newValue ?? null,
  };
  return maybeCreateJobChangeReengagement(workspaceId, prospectId, [change], { force: true });
}
