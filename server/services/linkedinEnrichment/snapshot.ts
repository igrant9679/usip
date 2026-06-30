/**
 * Snapshot + change detection for LinkedIn enrichment (pure functions).
 *
 * Builds a normalized snapshot of the monitored profile fields, hashes it for
 * cheap "did anything change?" checks, and diffs two snapshots into meaningful
 * field changes — explicitly suppressing noise (whitespace / case / punctuation
 * / reordered arrays). Each change carries a change_type + display priority per
 * the feature spec.
 */
import { createHash } from "crypto";
import type { VelocityLinkedInProfile } from "./mapper";

export type ChangePriority = "high" | "medium" | "low";

export interface DetectedChange {
  fieldName: string;
  changeType: string;
  priority: ChangePriority;
  label: string;
  oldValue: string | null;
  newValue: string | null;
}

/** Monitored scalar fields → change classification + priority. */
const SCALAR_FIELDS: Array<{
  key: string;
  get: (p: VelocityLinkedInProfile) => string | null;
  changeType: string;
  priority: ChangePriority;
  label: string;
}> = [
  { key: "linkedin_full_name", get: (p) => p.fullName, changeType: "name_changed", priority: "low", label: "Name changed" },
  { key: "linkedin_headline", get: (p) => p.headline, changeType: "headline_changed", priority: "medium", label: "Headline changed" },
  { key: "linkedin_location", get: (p) => p.location, changeType: "location_changed", priority: "medium", label: "Location updated" },
  { key: "current_title", get: (p) => p.currentTitle, changeType: "title_changed", priority: "high", label: "Title changed" },
  { key: "current_company_name", get: (p) => p.currentCompanyName, changeType: "company_changed", priority: "high", label: "Company changed" },
  { key: "current_company_domain", get: (p) => p.currentCompanyDomain, changeType: "company_changed", priority: "high", label: "Company changed" },
  { key: "current_company_start_date", get: (p) => p.currentCompanyStartDate, changeType: "company_start_changed", priority: "low", label: "Start date updated" },
  { key: "industry", get: (p) => p.industry, changeType: "industry_changed", priority: "low", label: "Industry changed" },
  { key: "summary_about", get: (p) => p.summaryAbout, changeType: "about_changed", priority: "low", label: "About updated" },
];

const JSON_FIELDS: Array<{
  key: string;
  get: (p: VelocityLinkedInProfile) => unknown;
  canon: (p: VelocityLinkedInProfile) => string;
  changeType: string;
  priority: ChangePriority;
  label: string;
}> = [
  {
    key: "experience_history_json",
    get: (p) => p.experience,
    canon: (p) => p.experience.map((e) => `${norm(e.company)}|${norm(e.title)}`).sort().join("~"),
    changeType: "experience_updated", priority: "medium", label: "Experience updated",
  },
  {
    key: "education_history_json",
    get: (p) => p.education,
    canon: (p) => p.education.map((e) => `${norm(e.school)}|${norm(e.degree)}`).sort().join("~"),
    changeType: "education_updated", priority: "low", label: "Education updated",
  },
  {
    key: "skills_json",
    get: (p) => p.skills,
    canon: (p) => [...new Set(p.skills.map(norm))].sort().join("~"),
    changeType: "skills_updated", priority: "low", label: "Skills updated",
  },
];

/** Canonical comparison form — lowercases, collapses non-alphanumerics. */
function norm(s?: string | null): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** The raw + canonical monitored snapshot of a profile. */
export interface ProfileSnapshot {
  /** Raw display values (what we show as old/new in changes). */
  raw: Record<string, string | null>;
  /** Whether a (presence-only) photo exists — signed-URL churn is ignored. */
  hasPhoto: boolean;
  /** Canonical values used for diffing + hashing. */
  canon: Record<string, string>;
}

export function buildSnapshot(p: VelocityLinkedInProfile): ProfileSnapshot {
  const raw: Record<string, string | null> = {};
  const canon: Record<string, string> = {};
  for (const f of SCALAR_FIELDS) {
    const v = f.get(p);
    raw[f.key] = v;
    canon[f.key] = norm(v);
  }
  for (const f of JSON_FIELDS) {
    raw[f.key] = JSON.stringify(f.get(p) ?? []);
    canon[f.key] = f.canon(p);
  }
  const hasPhoto = !!p.profileImageUrl;
  raw["linkedin_profile_image_url"] = p.profileImageUrl ?? null;
  canon["linkedin_profile_image_present"] = hasPhoto ? "1" : "0";
  return { raw, hasPhoto, canon };
}

/** Stable SHA-256 over the canonical snapshot (noise-insensitive). */
export function snapshotHash(s: ProfileSnapshot): string {
  const keys = Object.keys(s.canon).sort();
  const payload = keys.map((k) => `${k}=${s.canon[k]}`).join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Diff a previous snapshot against the current profile. Returns only
 * meaningful changes — fields whose CANONICAL value differs (so
 * whitespace/case/punctuation/array-reorder churn produces nothing).
 */
export function detectChanges(prev: ProfileSnapshot, p: VelocityLinkedInProfile): DetectedChange[] {
  const cur = buildSnapshot(p);
  const out: DetectedChange[] = [];

  for (const f of SCALAR_FIELDS) {
    if ((prev.canon[f.key] ?? "") !== (cur.canon[f.key] ?? "")) {
      out.push({
        fieldName: f.key, changeType: f.changeType, priority: f.priority, label: f.label,
        oldValue: prev.raw[f.key] ?? null, newValue: cur.raw[f.key] ?? null,
      });
    }
  }
  for (const f of JSON_FIELDS) {
    if ((prev.canon[f.key] ?? "") !== (cur.canon[f.key] ?? "")) {
      out.push({
        fieldName: f.key, changeType: f.changeType, priority: f.priority, label: f.label,
        oldValue: prev.raw[f.key] ?? null, newValue: cur.raw[f.key] ?? null,
      });
    }
  }
  // Photo: presence-only (ignore rotating signed-URL params).
  const had = (prev.canon["linkedin_profile_image_present"] ?? "0") === "1";
  if (had !== cur.hasPhoto) {
    out.push(
      cur.hasPhoto
        ? { fieldName: "linkedin_profile_image_url", changeType: "new_profile_photo", priority: "low", label: "New profile photo", oldValue: null, newValue: cur.raw["linkedin_profile_image_url"] }
        : { fieldName: "linkedin_profile_image_url", changeType: "profile_photo_removed", priority: "low", label: "Profile photo removed", oldValue: prev.raw["linkedin_profile_image_url"] ?? null, newValue: null },
    );
  }
  return out;
}

/** changeType → compact UI label (for changes read back from the DB). */
export const CHANGE_LABELS: Record<string, string> = {
  name_changed: "Name changed",
  headline_changed: "Headline changed",
  location_changed: "Location updated",
  title_changed: "Title changed",
  company_changed: "Company changed",
  company_start_changed: "Start date updated",
  industry_changed: "Industry changed",
  about_changed: "About updated",
  experience_updated: "Experience updated",
  education_updated: "Education updated",
  skills_updated: "Skills updated",
  new_profile_photo: "New profile photo",
  profile_photo_removed: "Profile photo removed",
  profile_unavailable: "LinkedIn unavailable",
  linkedin_url_changed: "LinkedIn updated",
};

export function labelFor(changeType: string): string {
  return CHANGE_LABELS[changeType] ?? "LinkedIn updated";
}

const PRIORITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, normal: 0 };

/** Pick the headline label for a set of changes, per the display rules. */
export function summarizeChanges(
  changes: Array<{ label: string; priority: string; changeType: string }>,
): { displayText: string | null; highestPriority: ChangePriority | "normal" } {
  if (changes.length === 0) return { displayText: null, highestPriority: "normal" };
  const sorted = [...changes].sort((a, b) => (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0));
  const top = sorted[0];
  const highestPriority = (top.priority as ChangePriority) ?? "low";
  // A high-priority change always shows its specific label.
  if (highestPriority === "high") return { displayText: top.label, highestPriority };
  // Single change → its label; multiple medium/low → "[N] LinkedIn updates".
  if (changes.length === 1) return { displayText: top.label, highestPriority };
  return { displayText: `${changes.length} LinkedIn updates`, highestPriority };
}
