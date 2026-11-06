/**
 * The Dashboard's stat-card goals, one set per workspace (audit 2026-10-20,
 * G69). They were kept under one key for the whole browser, so a goal set in
 * one workspace showed in every other workspace opened there.
 *
 * The old key is moved into the first workspace that reads it, the one its
 * owner was most likely working in, and removed, so it can't reach a second.
 */
export const LEGACY_GOALS_KEY = "velocity_dashboard_goals";

export const goalsKey = (workspaceId: number) => `${LEGACY_GOALS_KEY}:${workspaceId}`;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readGoals(store: Store, workspaceId: number, defaults: Record<string, number>): Record<string, number> {
  try {
    let raw = store.getItem(goalsKey(workspaceId));
    if (raw == null) {
      const legacy = store.getItem(LEGACY_GOALS_KEY);
      if (legacy != null) {
        store.setItem(goalsKey(workspaceId), legacy);
        store.removeItem(LEGACY_GOALS_KEY);
        raw = legacy;
      }
    }
    const saved = raw ? JSON.parse(raw) : {};
    const out = { ...defaults };
    if (saved && typeof saved === "object") {
      for (const [k, v] of Object.entries(saved)) if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return { ...defaults };
  }
}

export function writeGoals(store: Store, workspaceId: number, goals: Record<string, number>): void {
  try {
    store.setItem(goalsKey(workspaceId), JSON.stringify(goals));
  } catch {
    /* storage full or blocked: the goal holds for this visit only */
  }
}
