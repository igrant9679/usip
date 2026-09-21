/**
 * Settings → Security finally bites — two of its three controls, and the
 * third is now labelled precisely instead of blanket.
 *
 * 🔴 THE BUG. `sessionTimeoutMin`, `enforce2fa` and `ipAllowlist` saved,
 * reloaded and were read by NOTHING. The timeout in particular rendered as an
 * ordinary live control, so an admin could set 15 minutes and reasonably
 * believe sessions expired. An honest amber banner went up on 2026-09-20; this
 * change replaces two thirds of it with enforcement.
 *
 *   · sessionTimeoutMin — set on the JWT `exp` and the cookie `maxAge` at the
 *     two mint sites in passwordAuth. No middleware: jose already refuses an
 *     expired token inside jwtVerify and the whole refusal path downstream is
 *     built and tested.
 *   · enforce2fa — one gate in workspaceProcedure, with a super_admin bypass
 *     and four exempt enrolment paths, because enforcement without a way back
 *     is a one-way lockout.
 *   · ipAllowlist — deliberately NOT enforced, and this file pins that the
 *     honest label stays until the trusted-proxy hop count is settled. That
 *     pin is the one that stops a future "cleanup" re-creating the lie.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prospectFieldHistory, users, workspaceSettings } from "../drizzle/schema";
import {
  MFA_EXEMPT_PATHS,
  MIN_SESSION_LIFETIME_MS,
  invalidateSecurityPolicyCache,
  mfaGateExemptPath,
  sessionLifetimeMs,
} from "./_core/securityPolicy";
import { MFA_REQUIRED_ERR_MSG, NOT_ADMIN_ERR_MSG, ONE_YEAR_MS, UNAUTHED_ERR_MSG } from "@shared/const";
import { isMfaRequiredError } from "../client/src/lib/authRedirect";
import type { TrpcContext } from "./_core/context";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const h = vi.hoisted(() => ({ db: null as any }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { appRouter } from "./routers";

/* ── Pure: the session lifetime arithmetic ───────────────────────────────── */

describe("sessionLifetimeMs", () => {
  it("falls back when the workspace has no stored timeout", () => {
    // A workspace whose settings row was never seeded must not get a short
    // session by accident — "no answer" means "no restriction" everywhere.
    expect(sessionLifetimeMs(undefined, ONE_YEAR_MS)).toBe(ONE_YEAR_MS);
    expect(sessionLifetimeMs(null, ONE_YEAR_MS)).toBe(ONE_YEAR_MS);
  });

  it("falls back on zero and on a negative value rather than minting a dead token", () => {
    expect(sessionLifetimeMs(0, ONE_YEAR_MS)).toBe(ONE_YEAR_MS);
    expect(sessionLifetimeMs(-5, ONE_YEAR_MS)).toBe(ONE_YEAR_MS);
  });

  it("converts minutes to milliseconds in the ordinary case", () => {
    expect(sessionLifetimeMs(480, ONE_YEAR_MS)).toBe(480 * 60_000);
  });

  it("clamps HIGH so a corrupt row cannot outlive the cookie it is set with", () => {
    // 999_999 minutes is ~1.9 years; the cookie maxAge is the same number, so
    // a token longer than the fallback would be a cookie we never intended.
    expect(sessionLifetimeMs(999_999, ONE_YEAR_MS)).toBe(ONE_YEAR_MS);
  });

  it("clamps LOW so a corrupt row cannot lock a tenant into a re-login loop", () => {
    // The zod input floor is 15 minutes, but the column is an int and this is
    // the one number that decides whether a workspace can work at all.
    expect(sessionLifetimeMs(1, ONE_YEAR_MS)).toBe(MIN_SESSION_LIFETIME_MS);
    expect(MIN_SESSION_LIFETIME_MS).toBe(15 * 60_000);
  });
});

/* ── Pure: the exemption list ────────────────────────────────────────────── */

describe("mfaGateExemptPath", () => {
  it("lets the enrolment procedures through", () => {
    expect(mfaGateExemptPath("profile.startTotpEnrollment")).toBe(true);
    expect(mfaGateExemptPath("profile.confirmTotpEnrollment")).toBe(true);
  });

  it("does not let an ordinary procedure through", () => {
    expect(mfaGateExemptPath("prospects.list")).toBe(false);
    expect(mfaGateExemptPath("")).toBe(false);
  });

  /**
   * The lockout this prevents is INVISIBLE until a customer hits it: add a
   * fifth TOTP procedure to profile.ts, forget this list, and the member the
   * gate blocked cannot reach the screen that would unblock them.
   */
  it("covers every TOTP/MFA procedure profile.ts declares", () => {
    const src = read("server/routers/profile.ts");
    const declared = [...src.matchAll(/(\w+):\s*workspaceProcedure/g)]
      .map((m) => m[1]!)
      .filter((n) => /Totp|MfaStatus/.test(n));
    expect(declared.length, "no TOTP procedures found — the pattern has gone stale").toBeGreaterThan(3);
    const missing = declared.filter((n) => MFA_EXEMPT_PATHS.indexOf(`profile.${n}`) === -1);
    expect(
      missing,
      missing.length
        ? `\n\nTOTP procedure(s) not exempt from the enforce2fa gate:\n  ${missing.join("\n  ")}\n\n` +
            `They are workspaceProcedure too, so a blocked member cannot reach\n` +
            `the enrolment screen that would clear the block.\n`
        : undefined,
    ).toEqual([]);
  });
});

/* ── Pure: the error code, and the client's reading of it ────────────────── */

describe("the refusal message", () => {
  it("carries a code of its own, distinct from every other refusal", () => {
    // The first draft of this change reused 10002, which NOT_ADMIN already
    // owns — the client would then have shown the enrolment interstitial to
    // anyone refused for role.
    const codes = [UNAUTHED_ERR_MSG, NOT_ADMIN_ERR_MSG, MFA_REQUIRED_ERR_MSG].map(
      (m) => /\((\d+)\)/.exec(m)?.[1],
    );
    expect(codes.every((c) => !!c), "a refusal message lost its numeric code").toBe(true);
    expect(new Set(codes).size).toBe(3);
  });

  it("isMfaRequiredError matches only that message", () => {
    expect(isMfaRequiredError(MFA_REQUIRED_ERR_MSG)).toBe(true);
    expect(isMfaRequiredError(UNAUTHED_ERR_MSG)).toBe(false);
    expect(isMfaRequiredError(NOT_ADMIN_ERR_MSG)).toBe(false);
  });
});

/* ── Behavioural: the gate, through the REAL middleware ──────────────────── */

/**
 * `settings` is what the workspace_settings select answers: a row array, or
 * "reject" to simulate the database being unreadable.
 */
function makeDb(opts: { role: string; archivedAt?: Date | null; settings: unknown[] | "reject"; mfaEnabled?: boolean }) {
  const builder = () => {
    const st: { table?: unknown; joined: boolean } = { joined: false };
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin() { st.joined = true; return b; },
      where() { return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) {
        if (st.joined) {
          res([{
            ws: { id: 1, name: "Acme", ownerUserId: 1, archivedAt: opts.archivedAt ?? null },
            mb: { id: 1, userId: 1, workspaceId: 1, role: opts.role, deactivatedAt: null, lastActiveAt: new Date() },
          }]);
        } else if (st.table === workspaceSettings) {
          if (opts.settings === "reject") rej(new Error("fake db: workspace_settings unreadable"));
          else res(opts.settings);
        } else if (st.table === users) {
          res([{ enabledAt: opts.mfaEnabled ? new Date() : null }]);
        } else if (st.table === prospectFieldHistory) {
          res([]);
        } else {
          rej(new Error("fake db: unscripted select"));
        }
      },
    };
    return b;
  };
  return { select: () => builder() };
}

function makeCtx(mfaEnabled: boolean): TrpcContext {
  return {
    user: {
      id: 1, openId: "user-1", email: "u1@example.com", name: "User 1",
      loginMethod: "password", role: "user",
      mfaTotpSecret: mfaEnabled ? "SECRET" : null,
      mfaTotpEnabledAt: mfaEnabled ? new Date("2026-09-01T00:00:00Z") : null,
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext;
}

describe("enforce2fa in workspaceProcedure", () => {
  // The policy is cached ~60s per workspace and every case here uses
  // workspace 1, so a stale entry would silently answer the next test.
  beforeEach(() => invalidateSecurityPolicyCache());

  it("refuses a member with no authenticator app", async () => {
    h.db = makeDb({ role: "rep", settings: [{ enforce2fa: true }] });
    await expect(appRouter.createCaller(makeCtx(false)).prospects.fieldHistory({ prospectId: 1 }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: MFA_REQUIRED_ERR_MSG });
  });

  it("still lets that member reach the enrolment screen — the whole safety property", async () => {
    // getMfaStatus is workspaceProcedure too. Without the exemption the gate
    // blocks the only route out of itself.
    h.db = makeDb({ role: "rep", settings: [{ enforce2fa: true }] });
    await expect(appRouter.createCaller(makeCtx(false)).profile.getMfaStatus())
      .resolves.toMatchObject({ totp: { connected: false } });
  });

  it("lets an enrolled member straight through", async () => {
    h.db = makeDb({ role: "rep", settings: [{ enforce2fa: true }], mfaEnabled: true });
    await expect(appRouter.createCaller(makeCtx(true)).prospects.fieldHistory({ prospectId: 1 }))
      .resolves.toEqual([]);
  });

  it("never blocks a super_admin", async () => {
    // The way back. settings.save is itself behind this middleware, so an
    // unenrolled super admin who could not get in would have no route to
    // switch the policy off — enforcement without a way back is a lockout,
    // which is the same rule the archive gate above it follows.
    h.db = makeDb({ role: "super_admin", settings: [{ enforce2fa: true }] });
    await expect(appRouter.createCaller(makeCtx(false)).prospects.fieldHistory({ prospectId: 1 }))
      .resolves.toEqual([]);
  });

  it("does nothing when the policy is off", async () => {
    h.db = makeDb({ role: "rep", settings: [{ enforce2fa: false }] });
    await expect(appRouter.createCaller(makeCtx(false)).prospects.fieldHistory({ prospectId: 1 }))
      .resolves.toEqual([]);
  });

  it("does nothing when the workspace has no settings row yet", async () => {
    h.db = makeDb({ role: "rep", settings: [] });
    await expect(appRouter.createCaller(makeCtx(false)).prospects.fieldHistory({ prospectId: 1 }))
      .resolves.toEqual([]);
  });

  it("the ARCHIVE refusal still wins — its message names the way back", async () => {
    // Both gates would fire here. The archive one must not be masked: it is
    // the only message that tells a super admin where the restore button is.
    h.db = makeDb({ role: "admin", archivedAt: new Date("2026-08-12T00:00:00Z"), settings: [{ enforce2fa: true }] });
    await expect(appRouter.createCaller(makeCtx(false)).prospects.fieldHistory({ prospectId: 1 }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("archived") });
  });

  it("FAILS OPEN when the policy row cannot be read", async () => {
    // Production safety property AND the reason six existing fake-db suites
    // stay green: a database fault must suspend the control, not lock a
    // workspace out of its own product.
    h.db = makeDb({ role: "rep", settings: "reject" });
    await expect(appRouter.createCaller(makeCtx(false)).prospects.fieldHistory({ prospectId: 1 }))
      .resolves.toEqual([]);
  });
});

describe("settings.save cannot be used to lock yourself out", () => {
  beforeEach(() => invalidateSecurityPolicyCache());

  it("refuses enforce2fa:true from an admin who has not enrolled", async () => {
    h.db = makeDb({ role: "admin", settings: [{ enforce2fa: false }] });
    await expect(appRouter.createCaller(makeCtx(false)).settings.save({ enforce2fa: true }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("Profile") });
  });
});

/* ── Source pins: the parts a fake database cannot observe ───────────────── */

describe("the session lifetime is derived at the mint sites", () => {
  const src = read("server/passwordAuth.ts");

  it("both mint sites stopped hard-coding a year", () => {
    // The whole feature is these two numbers. A refactor that reinstates
    // ONE_YEAR_MS here silently un-ships the control with no test failing.
    expect(src).toContain("sessionLifetimeForUser");
    expect(src).not.toMatch(/maxAge:\s*ONE_YEAR_MS/);
    expect(src).not.toMatch(/expiresInMs:\s*ONE_YEAR_MS/);
    expect((src.match(/maxAge:\s*lifetimeMs/g) ?? []).length).toBe(2);
    expect((src.match(/expiresInMs:\s*lifetimeMs/g) ?? []).length).toBe(2);
  });

  it("it excludes workspaces the user has left", () => {
    // A departed member's old workspace must not set the lifetime of the
    // session they hold in the workspace they are still in.
    const fn = /async function sessionLifetimeForUser[\s\S]*?\n}/.exec(src);
    expect(fn, "sessionLifetimeForUser not found").not.toBeNull();
    expect(fn![0]).toContain("isNull(workspaceMembers.deactivatedAt)");
  });

  it("it takes the MINIMUM across memberships, not the first one found", () => {
    // Otherwise a member of a strict workspace buys a lax session simply by
    // holding a second membership somewhere permissive.
    const fn = /async function sessionLifetimeForUser[\s\S]*?\n}/.exec(src);
    expect(fn![0]).toMatch(/min === null \|\| v < min/);
  });

  it("it fails open rather than signing everybody out on a db hiccup", () => {
    const fn = /async function sessionLifetimeForUser[\s\S]*?\n}/.exec(src);
    expect(fn![0]).toMatch(/return ONE_YEAR_MS;/);
  });
});

describe("the IP allowlist stays honestly labelled", () => {
  const src = read("client/src/pages/usip/Settings.tsx");
  const tab = /function SecurityTab\([\s\S]*?\n}/.exec(src);

  it("has a SecurityTab to inspect", () => {
    expect(tab, "SecurityTab not found — re-anchor this test").not.toBeNull();
  });

  it("the two live controls are no longer disabled", () => {
    // They were both hard `disabled` while inert. An edit that leaves them
    // disabled would ship enforcement nobody can configure.
    expect(tab![0]).toContain("disabled={!canEdit}");
    expect((tab![0].match(/disabled=\{!canEdit\}/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("the IP textarea is still disabled, and the amber notice names ONLY it", () => {
    /**
     * This is the pin that stops a future cleanup re-creating the lie. The
     * allowlist cannot be enforced until a trusted-proxy hop count exists:
     * first-hop waves through anyone who sets a header while the UI claims
     * protection, last-hop behind two edge hops locks out every member
     * including the admin who would turn it off.
     */
    const ipIdx = tab![0].indexOf("IP allowlist");
    expect(ipIdx, "the IP allowlist field has gone").toBeGreaterThan(-1);
    const before = tab![0].slice(0, ipIdx);
    const after = tab![0].slice(ipIdx);
    expect(after).toMatch(/disabled\s*\n/);
    expect(after).toContain("Not enforced yet.");
    expect(
      before,
      "the amber banner has gone blanket again — it must name the IP control alone",
    ).not.toContain("Not enforced yet.");
  });

  it("enforce2fa is still sent as ES6 shorthand (settingsAllowlist.test.ts reads that form)", () => {
    // `\r?` because most of this repo is CRLF on disk.
    expect(tab![0]).toMatch(/\n\s*enforce2fa,\r?\n/);
  });
});

describe("the blocked member is given somewhere to go", () => {
  /**
   * Without this wiring the gate is just a wall: every page a blocked member
   * could reach is behind the same middleware, so a redirect lands them on a
   * screen of failed queries. The interstitial is the only surface that uses
   * the four exempt procedures.
   */
  it("main.tsx flags the refusal without navigating", () => {
    const src = read("client/src/main.tsx");
    expect(src).toContain("isMfaRequiredError");
    expect(src).toContain("MFA_REQUIRED_EVENT");
    // The login redirect must stay separate — signing out fixes nothing here,
    // the member's credentials are fine.
    expect(src).toContain("shouldRedirectToLogin");
  });

  it("the gate is mounted inside the authed shell", () => {
    expect(read("client/src/components/usip/Shell.tsx")).toContain("<MfaRequiredGate />");
  });

  it("the enrolment dialog is shared, not duplicated", () => {
    // One copy, so the flow cannot drift between the place you choose it and
    // the place you are forced into it. Its two mutations keep their existing
    // onError handlers, which is what clientMutationErrors.test.ts requires.
    const dialog = read("client/src/components/usip/settings/TotpSetupDialog.tsx");
    expect(dialog).toContain("profile.startTotpEnrollment");
    expect(dialog).toContain("profile.confirmTotpEnrollment");
    for (const consumer of [
      "client/src/pages/usip/SettingsHub.tsx",
      "client/src/components/usip/MfaRequiredGate.tsx",
    ]) {
      expect(read(consumer)).toContain("settings/TotpSetupDialog");
    }
  });
});

describe("the allowlist is deliberately not built on the rate-limit hop", () => {
  it("_core/trpc.ts still takes the FIRST x-forwarded-for hop, and says why", () => {
    // Companion to llmRateLimit.test.ts, which pins the same hop for the
    // limiter key. Re-pointing it to satisfy an allowlist would change the
    // limiter's behaviour as a side effect.
    const src = read("server/_core/trpc.ts");
    expect(src).toContain('.split(",")[0]');
    expect(src).toMatch(/allowlist is deliberately NOT built on it/);
  });

  it("nothing has quietly added a trust-proxy setting", () => {
    // The prerequisite, not the feature. If this ever lands it must be
    // verified against a real request before the allowlist is switched on.
    expect(read("server/_core/index.ts")).not.toMatch(/trust proxy/);
  });
});
