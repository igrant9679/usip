/**
 * Which workspace THIS TAB is working in.
 *
 * 🔴 THE BUG (audit 2026-10-20): every request read the workspace id from
 * localStorage, which all tabs share. Switching workspace in one tab silently
 * retargeted every other open tab: their screens still showed the old
 * workspace while their next save, send or delete went to the new one.
 *
 * Now each tab keeps its own id in sessionStorage. localStorage only remembers
 * the last choice, so a NEW tab opens where you last were. Both accessors are
 * wrapped: storage can be unavailable (private windows, blocked site data),
 * and the server then falls back to the first workspace.
 */
const KEY = "usip:workspaceId";

export function getActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const own = window.sessionStorage.getItem(KEY);
    if (own) return own;
  } catch { /* no session storage */ }
  try {
    const last = window.localStorage.getItem(KEY);
    if (last) {
      try { window.sessionStorage.setItem(KEY, last); } catch { /* ignore */ }
      return last;
    }
  } catch { /* no local storage */ }
  return null;
}

export function setActiveWorkspaceId(id: number | string): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(KEY, String(id)); } catch { /* ignore */ }
  try { window.localStorage.setItem(KEY, String(id)); } catch { /* ignore */ }
}

/**
 * Raised when the server refuses this tab's workspace (WORKSPACE_UNAVAILABLE,
 * audit 2026-10-20, G11). WorkspaceProvider reloads the list and moves the tab
 * to a workspace the person still belongs to.
 */
export const WORKSPACE_UNAVAILABLE_EVENT = "velocity:workspace-unavailable";

/** The fields the switcher needs to decide whether a workspace can be opened. */
export type SwitchableWorkspace = { id: number; role: string; archivedAt?: unknown };

/**
 * Whether this person can work in this workspace now. An archived workspace
 * refuses everyone below super admin (workspaceGateRefusal), so it is shown
 * with a badge but not offered to them (audit 2026-10-20, G36).
 */
export function canOpenWorkspace(w: SwitchableWorkspace): boolean {
  return !w.archivedAt || w.role === "super_admin";
}

/**
 * Which workspace a tab should be in, given the list and the one it asked
 * for: that one if it can still open it, else the first it can, else none.
 */
export function chooseWorkspace<W extends SwitchableWorkspace>(list: W[], wanted: number | null): W | null {
  const asked = wanted != null ? list.find((w) => w.id === wanted) : undefined;
  if (asked && canOpenWorkspace(asked)) return asked;
  return list.find(canOpenWorkspace) ?? null;
}

/**
 * The cached queries a workspace switch keeps: only the list of workspaces,
 * which is the same from every one. Everything else is the old workspace's
 * data and is cleared, so it isn't shown while the new one loads (audit
 * 2026-10-20, P114: switching only invalidated, which kept the old rows on
 * screen until each refetch landed). tRPC keys a query [path, { input, type }].
 */
export function keepAcrossWorkspaceSwitch(queryKey: readonly unknown[]): boolean {
  const path = queryKey[0];
  return Array.isArray(path) && path[0] === "workspace" && path[1] === "list";
}
