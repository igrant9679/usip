/**
 * Where a visitor may be sent after signing in — one definition, shared.
 *
 * 🔴 THE BUG THIS FIXES. Four sites each spelled the check
 * `returnPath.startsWith("/")` by hand: both `/api/auth/login` and
 * `/api/auth/register` in `server/passwordAuth.ts`, the post-login
 * `window.location.href` in `client/src/App.tsx`, and `getLoginUrl` in
 * `client/src/const.ts`.
 *
 * **`//evil.com` starts with `/`.** A protocol-relative URL passes every one of
 * those checks and the browser resolves it against the current scheme, so
 * `/?returnPath=//evil.com` → sign in → `res.redirect(302, "//evil.com")` lands
 * the visitor on another origin, having just authenticated. That is an open
 * redirect on the auth path, which is the shape phishing wants: the link really
 * does start at the product's own domain.
 *
 * `/\evil.com` is the same hole with a different spelling — WHATWG URL parsing
 * treats a backslash after the first slash as a second slash, so Chrome and
 * Firefox resolve it exactly like `//evil.com`.
 *
 * ⚠️ NOT A COSMETIC TIGHTENING. A legitimate `returnPath` is always an in-app
 * path (`/invite/accept?token=…`, `/people`), so nothing real is refused. But
 * this returns "/" rather than throwing, on purpose: the visitor has just
 * authenticated successfully and must land somewhere sensible, not on an error.
 */

/** A returnPath is safe only if it is same-origin BY CONSTRUCTION. */
export function safeReturnPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string") return fallback;
  // Must be an absolute in-app path.
  if (!value.startsWith("/")) return fallback;
  /**
   * `//host` and `/\host` both leave this origin. Checked on the SECOND
   * character rather than by a `startsWith("//")` pair so the backslash variant
   * cannot be forgotten when someone adds the next one.
   */
  if (value.length > 1 && (value[1] === "/" || value[1] === "\\")) return fallback;
  /**
   * A CR or LF reaching `res.redirect` is header injection — everything after
   * the newline becomes a header the attacker chose. Express escapes the
   * Location value today, so this is defence in depth rather than the defence,
   * and it costs one test.
   */
  if (/[\r\n\t\0]/.test(value)) return fallback;
  return value;
}
