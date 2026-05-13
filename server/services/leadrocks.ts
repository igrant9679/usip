/**
 * LeadRocks CSV adapter.
 *
 * LeadRocks exports a fixed schema with ~35 columns including multiple
 * Work/Direct Email slots each with a confidence flag, multiple Phone
 * slots, and company-website / domain context. This module:
 *
 *   1. Sniffs whether a parsed CSV looks like LeadRocks (`looksLikeLeadRocks`)
 *   2. Picks the single best email per row from the 8 Work + 6 Direct slots
 *      using the confidence flag as a priority key
 *   3. Maps a LeadRocks row to a partial Prospect insert shape
 *
 * Email-status priority (high → low):
 *   ok_for_all|ok_for_all   confidence 100 — LeadRocks SMTP-verified twice
 *   ok_for_all              confidence 90  — verified once
 *   ok                      confidence 80
 *   risky                   confidence 50
 *   unknown                 confidence 30  — generated pattern, unverified
 *   (empty / other)         confidence 0
 *
 * Tie-break: prefer Direct over Work emails (more likely personal/checked).
 */

import { normalizeDomain } from "./scraper/domain";

/* ─── Column-name patterns (case + space + #-tolerant) ─────────────────── */

function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, "").replace(/#/g, "");
}

/** Returns true if the headers look like a LeadRocks export. */
export function looksLikeLeadRocks(headers: string[]): boolean {
  const set = new Set(headers.map(norm));
  // Hallmark columns — all three should be present in a real LeadRocks file
  return (
    set.has("linkedurl") &&
    set.has("companywebsite") &&
    (set.has("workemail1") || set.has("workemail"))
  );
}

/* ─── Status → confidence rank ─────────────────────────────────────────── */

const STATUS_RANK: Record<string, number> = {
  "ok_for_all|ok_for_all": 100,
  ok_for_all: 90,
  ok: 80,
  risky: 50,
  unknown: 30,
};

function rankStatus(status: string | undefined): number {
  if (!status) return 0;
  const key = status.trim().toLowerCase();
  return STATUS_RANK[key] ?? (key.includes("ok") ? 70 : 0);
}

/* ─── Find header by fuzzy match ───────────────────────────────────────── */

function findHeader(headers: string[], target: string): string | null {
  const t = norm(target);
  for (const h of headers) {
    if (norm(h) === t) return h;
  }
  return null;
}

/* ─── Best-email picker ────────────────────────────────────────────────── */

export type BestEmail = {
  email: string;
  status: string;
  rank: number;
  source: "work" | "direct";
  slot: number;
};

/**
 * Scan all Work Email #1-8 and Direct Email #1-6 slots, return the highest-
 * confidence non-empty one (or null if all empty). Direct beats Work on tie.
 */
export function pickBestEmail(
  row: Record<string, string>,
  headers: string[],
): BestEmail | null {
  const candidates: BestEmail[] = [];

  // Direct first so equal-rank ties resolve in Direct's favor (stable order)
  for (let i = 1; i <= 6; i++) {
    const emailCol = findHeader(headers, `Direct Email #${i}`) ?? findHeader(headers, `Direct Email ${i}`);
    const statusCol = findHeader(headers, `Direct Email #${i} Status`) ?? findHeader(headers, `Direct Email ${i} Status`);
    const email = emailCol ? (row[emailCol] ?? "").trim() : "";
    if (!email || !email.includes("@")) continue;
    const status = statusCol ? (row[statusCol] ?? "").trim() : "";
    candidates.push({
      email: email.toLowerCase(),
      status,
      rank: rankStatus(status),
      source: "direct",
      slot: i,
    });
  }

  for (let i = 1; i <= 8; i++) {
    const emailCol = findHeader(headers, `Work Email #${i}`) ?? findHeader(headers, `Work Email ${i}`);
    const statusCol = findHeader(headers, `Work Email #${i} Status`) ?? findHeader(headers, `Work Email ${i} Status`);
    const email = emailCol ? (row[emailCol] ?? "").trim() : "";
    if (!email || !email.includes("@")) continue;
    const status = statusCol ? (row[statusCol] ?? "").trim() : "";
    candidates.push({
      email: email.toLowerCase(),
      status,
      rank: rankStatus(status),
      source: "work",
      slot: i,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    // Direct > work on equal rank
    if (a.source !== b.source) return a.source === "direct" ? -1 : 1;
    // Lower slot = earlier-discovered = slightly better
    return a.slot - b.slot;
  });

  return candidates[0];
}

/** Pick first non-empty Phone #1-8 slot. */
function pickFirstPhone(row: Record<string, string>, headers: string[]): string | null {
  for (let i = 1; i <= 8; i++) {
    const col = findHeader(headers, `Phone #${i}`) ?? findHeader(headers, `Phone ${i}`);
    if (!col) continue;
    const v = (row[col] ?? "").trim();
    if (v) return v;
  }
  return null;
}

/* ─── Map LeadRocks status to USIP normalized status ───────────────────── */

function statusToUsip(leadrocksStatus: string | undefined): string | null {
  if (!leadrocksStatus) return null;
  const key = leadrocksStatus.trim().toLowerCase();
  if (key === "ok_for_all|ok_for_all" || key === "ok_for_all" || key === "ok") return "valid";
  if (key === "risky") return "risky";
  if (key === "unknown") return "unknown";
  return null;
}

/* ─── Row → Prospect shape ─────────────────────────────────────────────── */

export type MappedProspect = {
  /** Required — must be non-empty for the row to be importable. */
  firstName: string;
  /** Required */
  lastName: string;
  /** Required for dedup — rows without this are flagged as invalid. */
  linkedinUrl: string;

  title: string | null;
  company: string | null;
  companyDomain: string | null;
  industry: string | null;
  city: string | null;
  state: string | null;
  country: string | null;

  email: string | null;
  emailStatus: string | null;
  emailRawStatus: string | null; // LeadRocks' raw status string, for debugging
  emailSource: "work" | "direct" | null;
  phone: string | null;
};

/** Parse Location field ("Austin, TX, United States") into city/state/country. */
function splitLocation(loc: string): { city: string | null; state: string | null; country: string | null } {
  const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { city: null, state: null, country: null };
  if (parts.length === 1) return { city: null, state: null, country: parts[0] };
  if (parts.length === 2) return { city: parts[0], state: null, country: parts[1] };
  return { city: parts[0], state: parts[1], country: parts.slice(2).join(", ") };
}

/** Convert a LeadRocks row → MappedProspect, or null if unimportable. */
export function mapLeadRocksRow(
  row: Record<string, string>,
  headers: string[],
): MappedProspect | null {
  const get = (label: string): string => {
    const h = findHeader(headers, label);
    return h ? (row[h] ?? "").trim() : "";
  };

  const firstName = get("First Name");
  const lastName = get("Last Name");
  const linkedinUrl = get("Linked Url") || get("LinkedIn URL") || get("LinkedinUrl");

  // Hard requirements: must have a name + LinkedIn URL to be a useful prospect
  if (!firstName || !lastName || !linkedinUrl) return null;

  const location = get("Location");
  const { city, state, country } = splitLocation(location);

  const companyWebsite = get("Company Website");
  const companyDomain = normalizeDomain(companyWebsite);

  const best = pickBestEmail(row, headers);
  const phone = pickFirstPhone(row, headers);

  return {
    firstName,
    lastName,
    linkedinUrl,
    title: get("Job Title") || null,
    company: get("Company") || null,
    companyDomain,
    industry: get("Industry") || null,
    city,
    state,
    country,
    email: best?.email ?? null,
    emailStatus: best ? statusToUsip(best.status) : null,
    emailRawStatus: best?.status ?? null,
    emailSource: best?.source ?? null,
    phone,
  };
}
