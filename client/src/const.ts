export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { safeReturnPath } from "@shared/returnPath";

// App root renders the Landing component (email + password form) when the
// user is unauthenticated, so simply navigating to "/" surfaces login/signup.
// Optionally pass returnPath in the query string so the form redirects back
// to the originally-requested page after successful auth.
export const getLoginUrl = (returnPath?: string) => {
  // `//evil.com` starts with "/" — see @shared/returnPath for why that mattered.
  const safe = safeReturnPath(returnPath, "");
  if (safe) {
    return `/?returnPath=${encodeURIComponent(safe)}`;
  }
  return "/";
};
