/**
 * Where a public form or landing page may send a visitor after they submit it.
 *
 * 🔴 THE HOLE (audit 2026-10-20, "also urgent"). `forms.redirectUrl` and
 * `landingPages.redirectUrl` were stored as any string and handed straight to
 * `window.location.href` by PublicForm.tsx and LandingPage.tsx. A
 * `javascript:` URL there ran script on the app's own origin — in the
 * browser of every visitor who submitted, signed-in members included — and
 * any other scheme or host made the page an open redirect wearing the app's
 * domain.
 *
 * Allowed: an absolute http(s) URL with no embedded credentials, or an in-app
 * path (by the same rule as safeReturnPath). Everything else is null, which the
 * pages treat as "no redirect — show the thank-you". Applied where the value is
 * WRITTEN (the routers refuse it), where it is SERVED (rows stored before this
 * check are neutralised) and where it is FOLLOWED (the pages), so no one layer
 * has to be right on its own.
 */
import { safeReturnPath } from "./returnPath";

const CONTROL_OR_SPACE = /[\u0000- \u007f]/;

export function safeRedirectUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > 2048 || CONTROL_OR_SPACE.test(v)) return null;
  if (v.startsWith("/")) {
    const path = safeReturnPath(v, "");
    return path || null;
  }
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  // https://getvelocityai.app@evil.example reads as ours and goes elsewhere.
  if (u.username || u.password) return null;
  return u.toString();
}

/** For zod `.refine`: empty means "no redirect" and is always allowed. */
export function isAllowedRedirect(raw: string | null | undefined): boolean {
  if (raw == null || raw.trim() === "") return true;
  return safeRedirectUrl(raw) !== null;
}

export const REDIRECT_URL_ERROR = "The redirect must be a web address starting with https:// (or a path in this app).";
