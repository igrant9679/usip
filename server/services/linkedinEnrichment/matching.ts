/**
 * LinkedIn → prospect matching.
 *
 * Resolves a retrieved/normalized LinkedIn profile (+ any identifiers supplied
 * on the import row) to an existing prospect in the SAME workspace, using the
 * scored hierarchy from the feature spec. Returns a typed confidence bucket so
 * the importer knows whether it may auto-apply or must route to manual review.
 *
 * Every query is workspace-scoped. Matching is read-only — it never writes.
 */
import { and, eq, like } from "drizzle-orm";
import { getDb } from "../../db";
import { prospects } from "../../../drizzle/schema";
import type { VelocityLinkedInProfile } from "./mapper";
import { validateLinkedInUrl } from "./mapper";

export type MatchStatus = "exact_match" | "high_confidence" | "possible_match" | "no_match" | "conflict";

export interface MatchInput {
  workspaceId: number;
  normalizedUrl: string | null;
  identifier: string | null;
  /** Identifiers supplied on the import row (may be sparse). */
  provided?: {
    prospectId?: number | null;
    fullName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    title?: string | null;
    email?: string | null;
  };
  /** The retrieved profile, when available (raises confidence). */
  profile?: VelocityLinkedInProfile | null;
}

export interface MatchResult {
  status: MatchStatus;
  prospectId: number | null;
  score: number;
  reasons: string[];
  /** Top alternative candidates for the manual-review UI. */
  candidates: Array<{ prospectId: number; score: number; name: string }>;
}

type ProspectRow = typeof prospects.$inferSelect;

/* ───────────────────────────── text helpers ───────────────────────────── */

const norm = (s?: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (s?: string | null) => new Set(norm(s).split(" ").filter(Boolean));

/** Jaccard token overlap, 0..1. */
function overlap(a?: string | null, b?: string | null): number {
  const ta = tokens(a), tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function fullNameOf(p: ProspectRow): string {
  return `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim();
}

/* ─────────────────────────── candidate gather ─────────────────────────── */

async function gatherCandidates(input: MatchInput): Promise<ProspectRow[]> {
  const db = await getDb();
  if (!db) return [];
  const ws = input.workspaceId;
  const byId = new Map<number, ProspectRow>();
  const add = (rows: ProspectRow[]) => rows.forEach((r) => byId.set(r.id, r));

  // 1) explicit prospect id
  if (input.provided?.prospectId) {
    add(
      await db.select().from(prospects).where(
        and(eq(prospects.workspaceId, ws), eq(prospects.id, input.provided.prospectId)),
      ),
    );
  }
  // 2) linkedin url identifier (slug appears anywhere in the stored url)
  if (input.identifier) {
    add(
      await db.select().from(prospects).where(
        and(eq(prospects.workspaceId, ws), like(prospects.linkedinUrl, `%${input.identifier}%`)),
      ),
    );
  }
  // 3) email exact
  const email = input.provided?.email?.trim();
  if (email) {
    add(
      await db.select().from(prospects).where(
        and(eq(prospects.workspaceId, ws), eq(prospects.email, email)),
      ),
    );
  }
  // 4) name (first + last) — from the profile or the provided row
  const first = input.profile?.firstName ?? input.provided?.firstName ?? null;
  const last = input.profile?.lastName ?? input.provided?.lastName ?? null;
  if (first && last) {
    add(
      await db.select().from(prospects).where(
        and(eq(prospects.workspaceId, ws), like(prospects.firstName, first), like(prospects.lastName, last)),
      ),
    );
  }
  return [...byId.values()];
}

/* ───────────────────────────── scoring ────────────────────────────────── */

function scoreCandidate(input: MatchInput, p: ProspectRow): { score: number; reasons: string[]; conflictName: boolean } {
  const reasons: string[] = [];
  let score = 0;
  let conflictName = false;

  const prof = input.profile;
  const provided = input.provided ?? {};

  // strongest keys
  if (provided.prospectId && p.id === provided.prospectId) {
    score += 100; reasons.push("prospect_id direct match (+100)");
  }
  if (input.identifier && p.linkedinUrl) {
    const candId = validateLinkedInUrl(p.linkedinUrl).identifier;
    if (candId && candId.toLowerCase() === input.identifier.toLowerCase()) {
      score += 100; reasons.push("linkedin_url exact match (+100)");
    }
  }
  if (provided.email && p.email && provided.email.toLowerCase() === p.email.toLowerCase()) {
    score += 95; reasons.push("email exact match (+95)");
  }

  // names
  const candName = fullNameOf(p);
  const profFull = prof?.fullName ?? provided.fullName ?? null;
  if (profFull && candName) {
    if (norm(profFull) === norm(candName)) {
      score += 40; reasons.push("full name exact (+40)");
    } else {
      const first = prof?.firstName ?? provided.firstName ?? null;
      const last = prof?.lastName ?? provided.lastName ?? null;
      if (first && last && norm(first) === norm(p.firstName) && norm(last) === norm(p.lastName)) {
        score += 35; reasons.push("first + last exact (+35)");
      } else if (overlap(profFull, candName) < 0.2) {
        // strongly different names
        score -= 50; reasons.push("conflicting name (-50)"); conflictName = true;
      }
    }
  }

  // company
  const profCompany = prof?.currentCompanyName ?? provided.company ?? null;
  if (profCompany && p.company) {
    if (norm(profCompany) === norm(p.company)) {
      score += 30; reasons.push("company exact (+30)");
    } else {
      const ov = overlap(profCompany, p.company);
      if (ov >= 0.4) { score += 20; reasons.push("company fuzzy (+20)"); }
      else if (ov === 0) { score -= 25; reasons.push("conflicting company (-25)"); }
    }
  }

  // title
  const profTitle = prof?.currentTitle ?? provided.title ?? null;
  if (profTitle && p.title && overlap(profTitle, p.title) >= 0.4) {
    score += 15; reasons.push("title similarity (+15)");
  }

  // location
  const profLoc = prof?.location ?? null;
  const candLoc = [p.city, p.state, p.country].filter(Boolean).join(" ");
  if (profLoc && candLoc && overlap(profLoc, candLoc) >= 0.34) {
    score += 10; reasons.push("location similarity (+10)");
  }

  // account association — domain alignment
  const profDomain = prof?.currentCompanyDomain ?? null;
  if (profDomain && p.companyDomain && norm(profDomain) === norm(p.companyDomain)) {
    score += 10; reasons.push("company domain match (+10)");
  }

  return { score, reasons, conflictName };
}

/* ───────────────────────────── public API ─────────────────────────────── */

export async function matchProfileToProspect(input: MatchInput): Promise<MatchResult> {
  const candidates = await gatherCandidates(input);
  if (candidates.length === 0) {
    return { status: "no_match", prospectId: null, score: 0, reasons: ["no candidate prospects found"], candidates: [] };
  }

  const scored = candidates
    .map((p) => {
      const s = scoreCandidate(input, p);
      return { prospectId: p.id, name: fullNameOf(p), ...s };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  // Conflict: a strong identifier matched but the name strongly disagrees,
  // OR the top two candidates are both strong (ambiguous identity).
  const strongHit = best.reasons.some((r) => r.includes("+100") || r.includes("+95"));
  const ambiguous = scored.length > 1 && scored[1].score >= 75 && best.score - scored[1].score < 10;
  if ((strongHit && best.conflictName) || ambiguous) {
    return {
      status: "conflict",
      prospectId: best.prospectId,
      score: best.score,
      reasons: [...best.reasons, ambiguous ? "ambiguous: multiple strong candidates" : "conflicting identifiers on the same record"],
      candidates: scored.slice(0, 5).map((s) => ({ prospectId: s.prospectId, score: s.score, name: s.name })),
    };
  }

  const status: MatchStatus =
    best.score >= 90 ? "exact_match"
      : best.score >= 75 ? "high_confidence"
        : best.score >= 50 ? "possible_match"
          : "no_match";

  return {
    status,
    prospectId: status === "no_match" ? null : best.prospectId,
    score: best.score,
    reasons: best.reasons,
    candidates: scored.slice(0, 5).map((s) => ({ prospectId: s.prospectId, score: s.score, name: s.name })),
  };
}

/** Whether the importer may auto-apply this match without manual review. */
export function canAutoApply(m: MatchResult): boolean {
  if (m.status === "exact_match") return true;
  if (m.status === "high_confidence") {
    // only when no conflicting identifier surfaced
    return !m.reasons.some((r) => r.includes("conflicting"));
  }
  return false;
}
