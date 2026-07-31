/**
 * The sign-in page must never redirect to itself.
 *
 * REPORTED SYMPTOM: "the screen keeps disappearing and re-appearing rapidly"
 * on the Velocity sign-in page.
 *
 * WHAT HAPPENED. Elsie renders outside AuthGate, so it mounts on the sign-in
 * page too, and `pageKeyForRoute("/")` returns "dashboard" — so it fired
 * `tours.getRecommended`, a workspaceProcedure. Logged out that throws
 * UNAUTHED_ERR_MSG. The query-cache subscriber in main.tsx answered by setting
 * `window.location.href = getLoginUrl()`, and getLoginUrl() is "/" — THE PAGE
 * ALREADY ON SCREEN. So it was a full reload, the reloaded page fired the same
 * query, and it reloaded again, several times a second, with the form unusable.
 *
 * `useAuth` has always guarded exactly this:
 *     if (window.location.pathname === redirectPath) return;
 * The cache subscriber, doing the same job, never had it. Two implementations
 * of one rule, one of them right — the defect class this codebase keeps
 * producing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loginPathnameOf, shouldRedirectToLogin } from "../client/src/lib/authRedirect";

const ROOT = join(__dirname, "..");

describe("shouldRedirectToLogin", () => {
  it("REFUSES to redirect when already on the login page", () => {
    // The regression. getLoginUrl() returns "/" and the sign-in form lives at
    // "/", so this must be false or the page reloads itself forever.
    expect(shouldRedirectToLogin("/", "/")).toBe(false);
  });

  it("refuses when on the login page with a returnPath already in the URL", () => {
    // Compare pathnames, not full URLs: this visitor is looking at the form.
    expect(shouldRedirectToLogin("/", "/?returnPath=%2Fv2%2Fpeople")).toBe(false);
  });

  it("still redirects from a protected page", () => {
    expect(shouldRedirectToLogin("/v2/people", "/")).toBe(true);
    expect(shouldRedirectToLogin("/v2/settings", "/?returnPath=%2Fv2%2Fsettings")).toBe(true);
  });

  it("handles a login URL that is not the root", () => {
    // getLoginUrl() returns "/" today; this must not silently break if it ever
    // points somewhere else.
    expect(shouldRedirectToLogin("/login", "/login")).toBe(false);
    expect(shouldRedirectToLogin("/", "/login")).toBe(true);
  });
});

describe("loginPathnameOf", () => {
  it("strips the query and hash", () => {
    expect(loginPathnameOf("/")).toBe("/");
    expect(loginPathnameOf("/?returnPath=%2Fx")).toBe("/");
    expect(loginPathnameOf("/login?a=1#frag")).toBe("/login");
  });

  it("never returns empty", () => {
    expect(loginPathnameOf("")).toBe("/");
    expect(loginPathnameOf("?x=1")).toBe("/");
  });
});

/** Both halves stay wired: the guard is used, and the trigger stays gated. */
describe("the sign-in loop cannot come back", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("main.tsx guards the redirect instead of navigating unconditionally", () => {
    const src = strip(readFileSync(join(ROOT, "client/src/main.tsx"), "utf8"));
    expect(src).toContain("shouldRedirectToLogin");
    // The unguarded assignment must not reappear next to the error handler.
    expect(src).toMatch(/if \(!shouldRedirectToLogin\([\s\S]{0,80}\) return;/);
  });

  it("Elsie does not ask a workspace procedure for tours while logged out", () => {
    const src = strip(readFileSync(join(ROOT, "client/src/components/usip/Elsie.tsx"), "utf8"));
    const canAsk = /const canAsk =([^;]*);/.exec(src);
    expect(canAsk, "canAsk assignment not found").not.toBeNull();
    expect(
      canAsk![1],
      "\n\nElsie mounts OUTSIDE AuthGate, so canAsk must require a signed-in\n" +
        "user — tours.getRecommended is a workspaceProcedure and 401s otherwise.\n",
    ).toContain("user");
  });

  it("the root path still maps to a page key — which is why this fired at all", () => {
    // Not a bug in itself, but it is the reason the sign-in page asked for a
    // tour. If this entry is ever removed the trigger goes with it; the guard
    // above is what actually makes the loop impossible.
    const src = readFileSync(join(ROOT, "client/src/components/usip/Elsie.tsx"), "utf8");
    expect(src).toMatch(/\["\/",\s*"dashboard"\]/);
  });
});
