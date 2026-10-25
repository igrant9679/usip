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
