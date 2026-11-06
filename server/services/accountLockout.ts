/**
 * Per-account brakes on guessing (audit 2026-10-20, G9 and G32).
 *
 * Every limiter in front of sign-in keys on the caller's address (req.ip,
 * _core/clientIp.ts), which stops one machine guessing and does nothing about
 * many machines guessing ONE account: ten tries per address per quarter-hour,
 * times however many addresses an attacker has. This counts failures per
 * ACCOUNT instead, wherever they come from.
 *
 * Keyed on what the caller typed, not on whether an account exists: an unknown
 * address locks after the same number of failures, with the same answer, so
 * the lock is not a way to learn which emails have accounts. A correct sign-in
 * or a password reset clears it.
 *
 * In memory, like the express-rate-limit stores beside it: a restart forgets,
 * and with more than one instance each keeps its own count. Both are softer
 * than a shared store, neither reopens the hole.
 */

export const MAX_FAILURES = 10;
export const WINDOW_MS = 15 * 60 * 1000;
/** Past this many tracked keys, the stalest are forgotten first. */
const MAX_KEYS = 50_000;

export const SIGN_IN_LOCKED =
  "Too many failed sign-in attempts for this account. Wait 15 minutes, or use Forgot password to reset it.";

const failures = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const list = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

/** The sign-in key for an email as typed (trimmed, lower-cased). */
export function signInKey(email: string): string {
  return `signin:${email.trim().toLowerCase()}`;
}

/** The key for a signed-in user's own credential checks (password/email change, 2FA off). */
export function profileKey(userId: number): string {
  return `profile:${userId}`;
}

export function isLockedOut(key: string, now = Date.now(), max = MAX_FAILURES): boolean {
  return recent(key, now).length >= max;
}

export function noteFailure(key: string, now = Date.now()): void {
  const list = recent(key, now);
  list.push(now);
  // Re-inserted at the end, so Map order is least-recently-failed first.
  failures.delete(key);
  failures.set(key, list.slice(-MAX_FAILURES * 2));
  if (failures.size > MAX_KEYS) {
    const first = failures.keys().next();
    if (!first.done) failures.delete(first.value);
  }
}

export function clearFailures(key: string): void {
  failures.delete(key);
}

/** Tests only: forget every count. */
export function resetAccountLockouts(): void {
  failures.clear();
}
