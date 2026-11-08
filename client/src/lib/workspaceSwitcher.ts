/**
 * Finding a workspace in the switcher (audit 2026-10-20, U10).
 *
 * With a handful of workspaces the list is the search; past that a box
 * appears. Matches the name or the slug, ignoring case.
 */
export const WORKSPACE_SEARCH_MIN = 6;

export function filterWorkspaces<T extends { name: string; slug?: string | null }>(list: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((w) => w.name.toLowerCase().includes(q) || (w.slug ?? "").toLowerCase().includes(q));
}
