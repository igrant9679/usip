/**
 * LinkedIn enrichment persistence + change-summary selectors.
 *
 * Writes the per-prospect enrichment record, the daily snapshot, and any
 * detected field changes; mirrors a permitted profile photo into the prospect
 * through the EXISTING compliance gate (source = enrichment_provider, never
 * overriding a user upload). Also exposes the compact change-summary selectors
 * the People/list/profile UIs read.
 *
 * Compliance: enrichment is skipped/blocked for prospects that are
 * rejected/suppressed (the strongest signal available on the prospects row);
 * the profile photo is only stored/displayed when explicitly permitted.
 * All queries are workspace-scoped.
 */
import { createHash } from "crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../../db";
import {
  prospects,
  prospectLinkedinEnrichments,
  prospectLinkedinFieldSnapshots,
  prospectLinkedinFieldChanges,
} from "../../../drizzle/schema";
import type { VelocityLinkedInProfile } from "./mapper";
import {
  buildSnapshot,
  snapshotHash,
  detectChanges,
  summarizeChanges,
  labelFor,
  type ProfileSnapshot,
  type DetectedChange,
} from "./snapshot";

const DEFAULT_SOURCE_TYPE = "unipile_linkedin_profile";

const valHash = (v: string | null): string | null =>
  v == null ? null : createHash("sha256").update(v).digest("hex");

export interface ApplyEnrichmentResult {
  enrichmentId: number;
  changes: DetectedChange[];
  dataStatus: string;
}

/** Compliance: is enrichment blocked for this prospect? */
export function enrichmentBlockReason(p: { verificationStatus?: string | null }): string | null {
  if (p.verificationStatus === "rejected") return "prospect_suppressed";
  return null;
}

/**
 * Persist a retrieved profile against a prospect: upsert the enrichment row,
 * write a snapshot, diff against the previous snapshot into field changes,
 * and (if permitted) mirror the profile photo through the compliance gate.
 */
export async function applyEnrichment(opts: {
  workspaceId: number;
  prospectId: number;
  profile: VelocityLinkedInProfile;
  /** linkedin_match_status: exact_match | high_confidence | manual | created_new … */
  matchStatus: string;
  sourceType?: string;
  sourceAccountId?: string | null;
  imageAllowed: boolean;
}): Promise<ApplyEnrichmentResult> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const now = new Date();
  const ws = opts.workspaceId;
  const pid = opts.prospectId;
  const p = opts.profile;
  const sourceType = opts.sourceType ?? DEFAULT_SOURCE_TYPE;

  // Mutable profile fields shared by insert + update.
  const fields = {
    linkedinProfileUrl: p.profileUrl,
    linkedinProfileIdentifier: p.identifier,
    linkedinPublicId: p.publicId,
    linkedinFullName: p.fullName,
    linkedinFirstName: p.firstName,
    linkedinLastName: p.lastName,
    linkedinHeadline: p.headline,
    linkedinLocation: p.location,
    linkedinProfileImageUrl: p.profileImageUrl,
    linkedinProfileImageAllowed: opts.imageAllowed,
    currentTitle: p.currentTitle,
    currentCompanyName: p.currentCompanyName,
    currentCompanyLinkedinUrl: p.currentCompanyLinkedinUrl,
    currentCompanyDomain: p.currentCompanyDomain,
    currentCompanyStartDate: p.currentCompanyStartDate as never, // 'YYYY-MM-DD' accepted by mysql
    experienceHistoryJson: p.experience,
    educationHistoryJson: p.education,
    skillsJson: p.skills,
    summaryAbout: p.summaryAbout,
    industry: p.industry,
    languagesJson: p.languages,
    linkedinConnectionDegree: p.connectionDegree,
    linkedinMatchStatus: opts.matchStatus,
    linkedinDataStatus: "enriched",
    linkedinSourceType: sourceType,
    linkedinSourceVendor: "unipile",
    linkedinSourceAccountId: opts.sourceAccountId ?? null,
    linkedinLastRetrievedAt: now,
    linkedinLastCheckedAt: now,
  };

  await db
    .insert(prospectLinkedinEnrichments)
    .values({ workspaceId: ws, prospectId: pid, ...fields } as never)
    .onDuplicateKeyUpdate({ set: fields as never });

  const [row] = await db
    .select({ id: prospectLinkedinEnrichments.id })
    .from(prospectLinkedinEnrichments)
    .where(and(eq(prospectLinkedinEnrichments.workspaceId, ws), eq(prospectLinkedinEnrichments.prospectId, pid)));
  const enrichmentId = row!.id;

  // Snapshot + diff.
  const snap = buildSnapshot(p);
  const hash = snapshotHash(snap);
  const [latest] = await db
    .select()
    .from(prospectLinkedinFieldSnapshots)
    .where(and(eq(prospectLinkedinFieldSnapshots.workspaceId, ws), eq(prospectLinkedinFieldSnapshots.prospectId, pid)))
    .orderBy(desc(prospectLinkedinFieldSnapshots.capturedAt))
    .limit(1);

  let changes: DetectedChange[] = [];
  if (latest && latest.snapshotHash !== hash) {
    changes = detectChanges(latest.snapshotJson as ProfileSnapshot, p);
    if (changes.length > 0) {
      await db.insert(prospectLinkedinFieldChanges).values(
        changes.map((c) => ({
          workspaceId: ws,
          prospectId: pid,
          enrichmentId,
          fieldName: c.fieldName,
          oldValue: c.oldValue,
          newValue: c.newValue,
          oldValueHash: valHash(c.oldValue),
          newValueHash: valHash(c.newValue),
          changeType: c.changeType,
          sourceVendor: "unipile",
          sourceType,
          displayPriority: c.priority,
          isVisible: true,
        })) as never,
      );
    }
  }
  // Write a new snapshot only when content actually changed (or first time).
  if (!latest || latest.snapshotHash !== hash) {
    await db.insert(prospectLinkedinFieldSnapshots).values({
      workspaceId: ws,
      prospectId: pid,
      enrichmentId,
      snapshotHash: hash,
      snapshotJson: snap,
    } as never);
  }

  // Mirror a permitted photo through the existing compliance gate.
  if (opts.imageAllowed && p.profileImageUrl && /^https:\/\//i.test(p.profileImageUrl)) {
    const [cur] = await db
      .select({ src: prospects.profileImageSource })
      .from(prospects)
      .where(and(eq(prospects.workspaceId, ws), eq(prospects.id, pid)));
    if (!cur || cur.src !== "user_uploaded") {
      await db
        .update(prospects)
        .set({
          profileImageUrl: p.profileImageUrl,
          profileImageSource: "enrichment_provider",
          profileImageSourceUrl: p.profileUrl,
          profileImageStatus: "available",
          profileImageLastVerifiedAt: now,
        })
        .where(and(eq(prospects.workspaceId, ws), eq(prospects.id, pid)));
    }
  }

  return { enrichmentId, changes, dataStatus: "enriched" };
}

/**
 * Record that a prospect's LinkedIn profile couldn't be retrieved during a
 * check (high-priority "profile unavailable" indicator). Deduped: skipped if
 * the most recent unacknowledged change is already profile_unavailable.
 */
export async function markUnavailable(opts: {
  workspaceId: number;
  prospectId: number;
  enrichmentId: number;
  reason: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const { workspaceId: ws, prospectId: pid, enrichmentId } = opts;
  await db
    .update(prospectLinkedinEnrichments)
    .set({ linkedinDataStatus: "source_unavailable", linkedinLastCheckedAt: new Date() })
    .where(and(eq(prospectLinkedinEnrichments.workspaceId, ws), eq(prospectLinkedinEnrichments.id, enrichmentId)));

  const [recent] = await db
    .select({ changeType: prospectLinkedinFieldChanges.changeType })
    .from(prospectLinkedinFieldChanges)
    .where(
      and(
        eq(prospectLinkedinFieldChanges.workspaceId, ws),
        eq(prospectLinkedinFieldChanges.prospectId, pid),
        isNull(prospectLinkedinFieldChanges.acknowledgedAt),
      ),
    )
    .orderBy(desc(prospectLinkedinFieldChanges.detectedAt))
    .limit(1);
  if (recent?.changeType === "profile_unavailable") return;

  await db.insert(prospectLinkedinFieldChanges).values({
    workspaceId: ws,
    prospectId: pid,
    enrichmentId,
    fieldName: "linkedin_profile",
    oldValue: null,
    newValue: opts.reason.slice(0, 200),
    changeType: "profile_unavailable",
    sourceVendor: "unipile",
    sourceType: DEFAULT_SOURCE_TYPE,
    displayPriority: "high",
    isVisible: true,
  } as never);
}

/* ─────────────────────────── change summary ───────────────────────────── */

export interface LinkedInChangeSummary {
  prospect_id: number;
  has_updates: boolean;
  unacknowledged_count: number;
  highest_priority: "high" | "medium" | "low" | "normal";
  display_text: string | null;
  last_checked_at: Date | null;
  changes: Array<{
    id: number;
    field_name: string;
    change_type: string;
    label: string;
    old_value: string | null;
    new_value: string | null;
    priority: string;
    detected_at: Date;
  }>;
}

function emptySummary(prospectId: number, lastChecked: Date | null = null): LinkedInChangeSummary {
  return {
    prospect_id: prospectId,
    has_updates: false,
    unacknowledged_count: 0,
    highest_priority: "normal",
    display_text: null,
    last_checked_at: lastChecked,
    changes: [],
  };
}

/** Compact change summary for one prospect (open/full profile + indicator). */
export async function getProspectLinkedInChangeSummary(
  workspaceId: number,
  prospectId: number,
): Promise<LinkedInChangeSummary> {
  const map = await getLinkedInChangeSummaries(workspaceId, [prospectId]);
  return map.get(prospectId) ?? emptySummary(prospectId);
}

/** Batched summaries for a set of prospects (People table / list rows — no N+1). */
export async function getLinkedInChangeSummaries(
  workspaceId: number,
  prospectIds: number[],
): Promise<Map<number, LinkedInChangeSummary>> {
  const out = new Map<number, LinkedInChangeSummary>();
  const db = await getDb();
  if (!db || prospectIds.length === 0) return out;
  const ids = [...new Set(prospectIds)];

  const enr = await db
    .select({ prospectId: prospectLinkedinEnrichments.prospectId, lastCheckedAt: prospectLinkedinEnrichments.linkedinLastCheckedAt })
    .from(prospectLinkedinEnrichments)
    .where(and(eq(prospectLinkedinEnrichments.workspaceId, workspaceId), inArray(prospectLinkedinEnrichments.prospectId, ids)));
  const lastChecked = new Map(enr.map((e) => [e.prospectId, e.lastCheckedAt as Date | null]));
  for (const id of ids) out.set(id, emptySummary(id, lastChecked.get(id) ?? null));

  const rows = await db
    .select()
    .from(prospectLinkedinFieldChanges)
    .where(
      and(
        eq(prospectLinkedinFieldChanges.workspaceId, workspaceId),
        inArray(prospectLinkedinFieldChanges.prospectId, ids),
        eq(prospectLinkedinFieldChanges.isVisible, true),
        isNull(prospectLinkedinFieldChanges.acknowledgedAt),
      ),
    )
    .orderBy(desc(prospectLinkedinFieldChanges.detectedAt));

  const byProspect = new Map<number, typeof rows>();
  for (const r of rows) {
    const arr = byProspect.get(r.prospectId) ?? [];
    arr.push(r);
    byProspect.set(r.prospectId, arr);
  }

  for (const [pid, changeRows] of byProspect) {
    const mapped = changeRows.map((c) => ({
      id: c.id,
      field_name: c.fieldName,
      change_type: c.changeType,
      label: labelFor(c.changeType),
      old_value: c.oldValue,
      new_value: c.newValue,
      priority: c.displayPriority,
      detected_at: c.detectedAt as Date,
    }));
    const { displayText, highestPriority } = summarizeChanges(
      mapped.map((m) => ({ label: m.label, priority: m.priority, changeType: m.change_type })),
    );
    out.set(pid, {
      prospect_id: pid,
      has_updates: mapped.length > 0,
      unacknowledged_count: mapped.length,
      highest_priority: highestPriority,
      display_text: displayText,
      last_checked_at: lastChecked.get(pid) ?? null,
      changes: mapped,
    });
  }
  return out;
}

/** Acknowledge change indicators — removes them from People/list rows but keeps history. */
export async function acknowledgeChanges(opts: {
  workspaceId: number;
  prospectId: number;
  userId: number;
  changeIds?: number[];
}): Promise<{ acknowledged: number }> {
  const db = await getDb();
  if (!db) return { acknowledged: 0 };
  const { workspaceId: ws, prospectId: pid } = opts;
  const conds = [
    eq(prospectLinkedinFieldChanges.workspaceId, ws),
    eq(prospectLinkedinFieldChanges.prospectId, pid),
    isNull(prospectLinkedinFieldChanges.acknowledgedAt),
  ];
  if (opts.changeIds?.length) conds.push(inArray(prospectLinkedinFieldChanges.id, opts.changeIds));
  await db
    .update(prospectLinkedinFieldChanges)
    .set({ acknowledgedAt: new Date(), acknowledgedByUserId: opts.userId })
    .where(and(...conds));
  return { acknowledged: opts.changeIds?.length ?? -1 };
}

/** Full enrichment record + recent change history for the full profile view. */
export async function getProspectEnrichment(workspaceId: number, prospectId: number) {
  const db = await getDb();
  if (!db) return null;
  const [enrichment] = await db
    .select()
    .from(prospectLinkedinEnrichments)
    .where(and(eq(prospectLinkedinEnrichments.workspaceId, workspaceId), eq(prospectLinkedinEnrichments.prospectId, prospectId)));
  if (!enrichment) return null;
  const history = await db
    .select()
    .from(prospectLinkedinFieldChanges)
    .where(and(eq(prospectLinkedinFieldChanges.workspaceId, workspaceId), eq(prospectLinkedinFieldChanges.prospectId, prospectId)))
    .orderBy(desc(prospectLinkedinFieldChanges.detectedAt))
    .limit(100);
  return { enrichment, history };
}
