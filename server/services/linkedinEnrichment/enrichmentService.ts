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
import { CONFIDENCE, mergeAll, type Candidate, type ProvenanceMap } from "../enrichment/fieldMerge";
import { companyFromHeadline } from "../enrichment/headlineCompany";
import { parseLinkedInLocation } from "../enrichment/recordNormalize";
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

/** Clamp a vendor string to its column width — an oversized value must never
 *  fail the whole enrichment insert (MySQL strict mode rejects, not truncates). */
const clip = (s: string | null | undefined, n: number): string | null =>
  s == null ? null : s.length > n ? s.slice(0, n) : s;

/** Final gate for the DATE column: only a fully valid YYYY-MM-DD goes through. */
const dateOnlyOrNull = (s: string | null | undefined): string | null =>
  s && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s) ? s : null;

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

  // Mutable profile fields shared by insert + update. Strings are clipped to
  // their column widths and the date is re-validated so no vendor payload can
  // fail the upsert at the DB layer.
  const fields = {
    linkedinProfileUrl: p.profileUrl,
    linkedinProfileIdentifier: clip(p.identifier, 200),
    linkedinPublicId: clip(p.publicId, 200),
    linkedinFullName: clip(p.fullName, 200),
    linkedinFirstName: clip(p.firstName, 100),
    linkedinLastName: clip(p.lastName, 100),
    linkedinHeadline: clip(p.headline, 500),
    linkedinLocation: clip(p.location, 200),
    linkedinProfileImageUrl: p.profileImageUrl,
    linkedinProfileImageAllowed: opts.imageAllowed,
    currentTitle: clip(p.currentTitle, 200),
    currentCompanyName: clip(p.currentCompanyName, 200),
    currentCompanyLinkedinUrl: p.currentCompanyLinkedinUrl,
    currentCompanyDomain: clip(p.currentCompanyDomain, 200),
    currentCompanyStartDate: dateOnlyOrNull(p.currentCompanyStartDate) as never, // 'YYYY-MM-DD' accepted by mysql
    experienceHistoryJson: p.experience,
    educationHistoryJson: p.education,
    skillsJson: p.skills,
    summaryAbout: p.summaryAbout,
    industry: clip(p.industry, 120),
    languagesJson: p.languages,
    linkedinConnectionDegree: clip(p.connectionDegree, 16),
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

  // Write the headline facts BACK to the prospect row — through the SAME
  // provenance-aware merge every enrichment trigger uses (fieldMerge), so a
  // fresh LinkedIn read can CORRECT a weaker stale value, corroborate a
  // matching one, and never displaces something more trustworthy. This is
  // what makes the People list, {{company}} merge tags, exports, and the
  // ICP fit scorer see enriched data at all.
  {
    const at = now.toISOString();
    const cand = (field: Candidate["field"], value: string | null | undefined): Candidate[] =>
      value?.trim() ? [{ field, value: value.trim(), source: "linkedin", confidence: CONFIDENCE.linkedinProfile, at }] : [];
    // Location + canonical profile URL ride the same provenance-aware merge
    // as company/title — the contact stays synchronized with LinkedIn where
    // LinkedIn wins on source quality/recency, and keeps stronger data where
    // it doesn't. Location arrives as one string ("Austin, Texas, United
    // States") and is split only as far as its shape allows.
    const loc = parseLinkedInLocation(p.location);
    const candidates: Candidate[] = [
      ...cand("company", fields.currentCompanyName as string | null),
      ...cand("companyDomain", fields.currentCompanyDomain as string | null),
      ...cand("title", p.currentTitle ? clip(p.currentTitle, 120) : null),
      ...cand("linkedinUrl", p.profileUrl || null),
      ...cand("city", clip(loc.city, 80)),
      ...cand("state", clip(loc.state, 80)),
      ...cand("country", clip(loc.country, 80)),
    ];
    // LinkedIn withholds structured work history for out-of-network profiles
    // (experience empty, no current_company) — but "CFO at Acme" headlines
    // still name the employer. Parse it as its own weaker source so the
    // ledger stays honest: headline_parse · 60, replaceable by any real read.
    if (!fields.currentCompanyName) {
      const guessed = companyFromHeadline(p.headline);
      if (guessed) {
        candidates.push({
          field: "company", value: clip(guessed, 200)!,
          source: "headline_parse", confidence: CONFIDENCE.headlineParse, at,
        });
      }
    }
    if (candidates.length > 0) {
      // Converge the company candidate onto the workspace's established
      // spelling (account by domain/name, else most common prospect
      // spelling) before it competes in the merge.
      for (const c of candidates) {
        if (c.field === "company") {
          const { canonicalCompanyNameForWorkspace } = await import("../enrichment/companyCanonical");
          c.value = await canonicalCompanyNameForWorkspace(ws, c.value, fields.currentCompanyDomain as string | null);
        }
      }
      const [cur] = await db
        .select({
          company: prospects.company, companyDomain: prospects.companyDomain,
          title: prospects.title, linkedinUrl: prospects.linkedinUrl,
          city: prospects.city, state: prospects.state, country: prospects.country,
          fieldProvenance: prospects.fieldProvenance,
        })
        .from(prospects)
        .where(and(eq(prospects.workspaceId, ws), eq(prospects.id, pid)))
        .limit(1);
      if (cur) {
        const merged = mergeAll(
          {
            company: cur.company, companyDomain: cur.companyDomain, title: cur.title,
            linkedinUrl: cur.linkedinUrl, city: cur.city, state: cur.state, country: cur.country,
          },
          (cur.fieldProvenance ?? {}) as ProvenanceMap,
          candidates,
        );
        if (merged.decisions.some((d) => d.action !== "kept")) {
          await db.update(prospects)
            .set({ ...merged.fields, fieldProvenance: merged.ledger } as never)
            .where(and(eq(prospects.workspaceId, ws), eq(prospects.id, pid)));
        }
      }
    }
  }

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

  // Mirror a permitted photo through the existing compliance gate. The vendor
  // URL is a SIGNED CDN link that expires in ~2 weeks (licdn `e=` param), so
  // the pixels are downloaded once and stored as a small inline data URI —
  // the same self-contained form user uploads use, already whitelisted by
  // resolveProspectProfileImage. On download failure the https URL is kept:
  // two weeks of avatar beats none, and the backfill cron retries later.
  if (opts.imageAllowed && p.profileImageUrl && /^https:\/\//i.test(p.profileImageUrl)) {
    const [cur] = await db
      .select({ src: prospects.profileImageSource })
      .from(prospects)
      .where(and(eq(prospects.workspaceId, ws), eq(prospects.id, pid)));
    if (!cur || cur.src !== "user_uploaded") {
      const { mirrorImageToDataUri } = await import("../enrichment/profileImageMirror");
      const mirrored = await mirrorImageToDataUri(p.profileImageUrl);
      await db
        .update(prospects)
        .set({
          profileImageUrl: mirrored.ok ? mirrored.dataUri : p.profileImageUrl,
          profileImageSource: "enrichment_provider",
          profileImageSourceUrl: p.profileUrl,
          profileImageStatus: "available",
          profileImageLastVerifiedAt: now,
        })
        .where(and(eq(prospects.workspaceId, ws), eq(prospects.id, pid)));
    }
  }

  // Fire-and-forget: enrichment may have changed title/company/location/photo,
  // so refresh this person's fit + Velocity Priority Score. Never blocks or
  // fails enrichment (scoring is optional metadata).
  void import("../scoring/recalculationService")
    .then((m) => m.recalcForObject(ws, "person", pid, "enrichment updated"))
    .catch(() => { /* scoring is best-effort */ });

  // Fire-and-forget: if this person changed companies, the Job Change Autopilot
  // may autonomously create a re-engagement task (a top meeting-booking trigger).
  // Gated by workspace mode; never blocks or fails enrichment.
  if (changes.some((c) => c.changeType === "company_changed")) {
    void import("./jobChangeReengagement")
      .then((m) => m.onJobChangeDetected(ws, pid, changes))
      .catch(() => { /* re-engagement is best-effort */ });
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
