/**
 * The role hierarchy — one map, reached from both sides.
 *
 * THE DRIFT THIS PREVENTS. The rank map has been copied repeatedly because it
 * is four lines and looks harmless. Five server copies were consolidated into
 * `server/_core/workspace.ts` earlier (companies.ts, scoring.ts,
 * linkedinEnrichment.ts, plus literal `role === "admin" || role ===
 * "super_admin"` checks in are/scraper.ts and linkedinFinder.ts) — but that
 * pass only walked `server/`, so THREE client copies survived it:
 * `pages/usip/Team.tsx`, `pages/usip/CompanyProfile.tsx` and
 * `components/usip/scoring/ProspectScoringPanel.tsx`. All of them agreed with
 * the server; duplication, not drift.
 *
 * What makes it worth consolidating anyway is the failure mode. A role added
 * here and not to a copy is silently DENIED wherever that copy is consulted and
 * allowed everywhere else, which reads as a bug in the feature rather than in
 * the map — and when the copies sit on opposite sides of the wire, the symptom
 * is a button the UI hides for a user the server would have let through.
 *
 * `server/roleRank.test.ts` scans server/, client/ and shared/ for a second
 * hierarchy and fails the suite on one, so a fourth copy cannot quietly appear.
 *
 * No imports, deliberately: this file is reached from the client bundle, from
 * `server/_core/workspace.ts`, and from tests.
 */
export const ROLES = ["super_admin", "admin", "manager", "rep"] as const;

export type Role = (typeof ROLES)[number];

/** super_admin > admin > manager > rep */
export const ROLE_RANK: Record<Role, number> = {
  super_admin: 4,
  admin: 3,
  manager: 2,
  rep: 1,
};

/**
 * Rank a role, ALWAYS through this function rather than by indexing the map.
 *
 * Unknown roles rank 0 — below every real role — so anything outside the
 * hierarchy is denied. Indexing the map raw yields `undefined`, and every
 * comparison against `undefined` is false, which turns a `<` guard into an
 * ALLOW. That is not hypothetical: it is exactly how the gate under every
 * workspace procedure in the app failed open until 2026-09-21.
 */
export function rankOf(role: string | null | undefined): number {
  return (ROLE_RANK as Record<string, number>)[role ?? ""] ?? 0;
}

/** admin and super_admin, and nothing else. */
export function isAdminRole(role: string | null | undefined): boolean {
  return rankOf(role) >= ROLE_RANK.admin;
}
