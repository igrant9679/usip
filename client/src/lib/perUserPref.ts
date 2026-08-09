/**
 * perUserPref — tiny localStorage prefs, keyed BY USER.
 *
 * For choices that belong to a person, not a browser: which mailbox account
 * a team member works in, which calendar they view. A bare localStorage key
 * would leak one member's selection to the next person who signs in on the
 * same machine — the user id in the key is the point of this module.
 *
 * Values are advisory: callers must validate a loaded value against live
 * data (does that account still exist / still belong to me?) before using
 * it, because prefs outlive disconnections and role changes.
 */
export function loadPerUserPref<T>(
  userId: number | string | null | undefined,
  key: string,
): T | null {
  if (userId == null) return null;
  try {
    const raw = localStorage.getItem(`velocity_pref_u${userId}_${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function savePerUserPref(
  userId: number | string | null | undefined,
  key: string,
  value: unknown,
): void {
  if (userId == null) return;
  try {
    localStorage.setItem(`velocity_pref_u${userId}_${key}`, JSON.stringify(value));
  } catch {
    /* storage full/blocked — a lost preference, not an error */
  }
}
