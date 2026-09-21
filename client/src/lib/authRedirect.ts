/**
 * When an unauthorized error should send the browser to the login page — and,
 * critically, when it should NOT.
 *
 * 🔴 THE SIGN-IN PAGE FLICKER. `main.tsx` subscribes to the react-query cache
 * and navigates to `getLoginUrl()` on any error carrying UNAUTHED_ERR_MSG.
 * `getLoginUrl()` returns "/" — the app root, which renders the sign-in form
 * when logged out. So on the sign-in page itself the redirect was a FULL RELOAD
 * OF THE PAGE YOU WERE ALREADY ON. The reloaded page fired the same protected
 * query, which failed the same way, which reloaded again: the screen
 * disappearing and reappearing several times a second, with the form unusable.
 *
 * `useAuth` has always had this guard —
 *     if (window.location.pathname === redirectPath) return;
 * — and the cache subscriber, doing the same job, never got it. Same defect
 * class as the rest of this codebase's duplicate-rule bugs: two
 * implementations, one of them right.
 *
 * Pure, so every case is testable without a browser or a router.
 */
import { MFA_REQUIRED_ERR_MSG } from "@shared/const";

/**
 * The pathname part of a login URL, which may carry a `?returnPath=` query.
 *
 * Deliberately string-only — `new URL()` needs a base and would throw on the
 * relative values `getLoginUrl()` returns.
 */
export function loginPathnameOf(loginUrl: string): string {
  const noHash = loginUrl.split("#")[0];
  const path = noHash.split("?")[0];
  return path || "/";
}

/**
 * True when the browser should be sent to `loginUrl`.
 *
 * Compares PATHNAMES, not full URLs: at `/?returnPath=%2Fpeople` the visitor is
 * already looking at the sign-in form, so navigating to `/` would reload it for
 * no reason and re-run whatever query just failed.
 */
export function shouldRedirectToLogin(currentPathname: string, loginUrl: string): boolean {
  return currentPathname !== loginPathnameOf(loginUrl);
}

/**
 * The workspace requires an authenticator app and this member has not
 * enrolled (2026-09-20, `enforce2fa` enforcement).
 *
 * Keyed off the exact message, not the tRPC code: main.tsx batches every call
 * through one httpBatchLink, so a gated procedure and an exempt one share a
 * single HTTP response and only the individual error distinguishes them.
 * FORBIDDEN alone would also catch every ordinary role refusal.
 *
 * Signing out is NOT the answer here — the member's credentials are fine and
 * signing back in changes nothing — so this deliberately does not feed
 * shouldRedirectToLogin. It raises a full-screen enrolment interstitial.
 */
export function isMfaRequiredError(message: string): boolean {
  return message === MFA_REQUIRED_ERR_MSG;
}

/**
 * Window event main.tsx raises on that error and MfaRequiredGate listens for.
 * Lives here, beside the predicate, rather than on the component: main.tsx is
 * the entry module and should not have to import a React tree to learn a
 * string.
 */
export const MFA_REQUIRED_EVENT = "usip:mfa-required";
