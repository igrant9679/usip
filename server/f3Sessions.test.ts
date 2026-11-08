/**
 * "Sign out everywhere" and the active-sessions list (audit 2026-10-20, F3;
 * final pass 2026-11-07).
 *
 * Session versioning already ended every session on a password or 2FA
 * change. Missing: a button for the person themselves, and a list of where
 * they are signed in. The list is built from what is recorded: each
 * successful sign-in's login_history row now names the session it started
 * (jti, expiry, version), and a row is listed while that session is alive.
 *
 * The sign-in route runs for real on an ephemeral port against the SQL fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import express from "express";
import bcrypt from "bcryptjs";
import { decodeJwt } from "jose";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { registerPasswordAuthRoutes } from "./passwordAuth";
import { appRouter } from "./routers";
import { resetAccountLockouts } from "./services/accountLockout";
import { isSessionRevoked } from "./_core/sessionRevocation";
import { describeUserAgent } from "@shared/userAgent";
import { COOKIE_NAME } from "@shared/const";

const EMAIL = "tester@velocity.test";
const PASSWORD = "correct horse battery";
const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const me = () => rows("users").find((u) => u.id === 1);
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, `anchor "${from}"`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b, `anchor "${to}"`).toBeGreaterThan(-1);
  return src.slice(a, b);
};

let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerPasswordAuthRoutes(app);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); });

/** Sign in from a browser with this User-Agent; returns the session token it was given. */
async function signIn(ua: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/password-login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": ua },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`${COOKIE_NAME}=([^;]+)`).exec(cookie);
  expect(m, "a session cookie").toBeTruthy();
  return decodeURIComponent(m![1]);
}

/** A tRPC caller as the browser holding `token`; `issued` collects any cookie it is re-issued. */
function caller(token: string | null, issued: string[] = []) {
  return appRouter.createCaller({
    user: { id: 1, openId: "o1", email: EMAIL, name: "Tester", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": "2", ...(token ? { cookie: `${COOKIE_NAME}=${token}` } : {}), "user-agent": CHROME_WIN } },
    res: { clearCookie: () => {}, cookie: (_n: string, v: string) => { issued.push(v); } },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  resetAccountLockouts();
  h.db = makeSqlFakeDb({ roles: { 2: "rep" }, wsId: () => 2 });
  rows("users").push({
    id: 1, openId: "o1", name: "Tester", email: EMAIL, passwordHash: bcrypt.hashSync(PASSWORD, 4),
    loginMethod: "password", mfaTotpSecret: null, mfaTotpEnabledAt: null, mfaLastStep: null, sessionVersion: 0,
  });
});

describe("a sign-in records the session it started", () => {
  it("its history row names the token's id, expiry and the account's session version", async () => {
    const token = await signIn(CHROME_WIN);
    const claims = decodeJwt(token);
    const row = rows("login_history").find((r) => r.outcome === "success");
    expect(row.sessionJti).toBe(claims.jti);
    expect(new Date(row.sessionExpiresAt).getTime()).toBe((claims.exp as number) * 1000);
    expect(row.sessionVersion).toBe(0);
  });
});

describe("the active-sessions list", () => {
  it("lists each live session with its device, address and time, and marks this browser", async () => {
    const laptop = await signIn(CHROME_WIN);
    await signIn(SAFARI_IPHONE);
    const list = await caller(laptop).profile.listMySessions();
    expect(list.map((s) => s.device).sort()).toEqual(["Chrome on Windows", "Safari on iPhone"]);
    expect(list.find((s) => s.current)?.device).toBe("Chrome on Windows");
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.every((s) => typeof s.ipAddress === "string" && s.signedInAt instanceof Date)).toBe(true);
    // Not the token id: the list hands out row ids only.
    expect(JSON.stringify(list)).not.toContain(String(decodeJwt(laptop).jti));
  });

  it("leaves out failed sign-ins, expired sessions and sessions from an older session version", async () => {
    await signIn(CHROME_WIN);
    rows("login_history").push(
      { id: 900, userId: 1, outcome: "failed", sessionJti: null, createdAt: new Date() },
      { id: 901, userId: 1, outcome: "success", sessionJti: "expiredjti", sessionExpiresAt: new Date(Date.now() - 1000), sessionVersion: 0, createdAt: new Date() },
      { id: 902, userId: 1, outcome: "success", sessionJti: "oldversion", sessionExpiresAt: new Date(Date.now() + 86_400_000), sessionVersion: -1, createdAt: new Date() },
      { id: 903, userId: 2, outcome: "success", sessionJti: "someoneelse", sessionExpiresAt: new Date(Date.now() + 86_400_000), sessionVersion: 0, createdAt: new Date() },
      { id: 904, userId: 1, outcome: "success", sessionJti: null, createdAt: new Date() },
    );
    const ids = (await caller(null).profile.listMySessions()).map((s) => s.id);
    expect(ids).toHaveLength(1);
    expect(ids).not.toContain(901);
    expect(ids).not.toContain(902);
    expect(ids).not.toContain(903);
  });
});

describe("signing out one session", () => {
  it("revokes that session's token and drops it from the list", async () => {
    const laptop = await signIn(CHROME_WIN);
    const phone = await signIn(SAFARI_IPHONE);
    const phoneRow = (await caller(laptop).profile.listMySessions()).find((s) => !s.current)!;
    await caller(laptop).profile.signOutSession({ id: phoneRow.id });
    expect(await isSessionRevoked(h.db, String(decodeJwt(phone).jti))).toBe(true);
    expect(await isSessionRevoked(h.db, String(decodeJwt(laptop).jti))).toBe(false);
    expect((await caller(laptop).profile.listMySessions()).map((s) => s.device)).toEqual(["Chrome on Windows"]);
  });

  it("refuses someone else's row", async () => {
    rows("login_history").push({ id: 950, userId: 2, outcome: "success", sessionJti: "theirs", sessionExpiresAt: new Date(Date.now() + 86_400_000), sessionVersion: 0, createdAt: new Date() });
    await expect(caller(null).profile.signOutSession({ id: 950 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await isSessionRevoked(h.db, "theirs")).toBe(false);
  });
});

describe("Sign out everywhere", () => {
  it("ends every session, and keeps this browser in on a fresh one that stays listed as this browser", async () => {
    const laptop = await signIn(CHROME_WIN);
    await signIn(SAFARI_IPHONE);
    const issued: string[] = [];
    await caller(laptop, issued).profile.signOutEverywhere();
    // Every token carries the version it was minted at: both are now stale.
    expect(me().sessionVersion).toBe(1);
    expect(issued).toHaveLength(1);
    const fresh = issued[0];
    expect(decodeJwt(fresh).sv).toBe(1);
    const list = await caller(fresh).profile.listMySessions();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ device: "Chrome on Windows", current: true });
  });

  it("changing your password re-lists this browser the same way", async () => {
    const laptop = await signIn(CHROME_WIN);
    const issued: string[] = [];
    await caller(laptop, issued).profile.changeMyPassword({ currentPassword: PASSWORD, newPassword: "a whole new password" });
    const list = await caller(issued[0]).profile.listMySessions();
    expect(list.map((s) => s.current)).toEqual([true]);
  });
});

describe("what admins see of a sign-in", () => {
  it("both login-history reads leave out the session columns", () => {
    const src = read("server/routers/admin.ts");
    const cols = between(src, "const LOGIN_HISTORY_COLUMNS = {", "};");
    expect(cols).not.toContain("session");
    expect(src.split(".select(LOGIN_HISTORY_COLUMNS)\n        .from(loginHistory)").length - 1).toBe(2);
    expect(src).not.toMatch(/\.select\(\)\s*\.from\(loginHistory\)/);
  });
});

describe("devices are named the way a person would", () => {
  it.each([
    [CHROME_WIN, "Chrome on Windows"],
    [SAFARI_IPHONE, "Safari on iPhone"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", "Safari on Mac"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox on Linux"],
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["", "Unknown device"],
  ])("%s", (ua, want) => {
    expect(describeUserAgent(ua)).toBe(want);
  });
});

describe("the security screen", () => {
  it("lists the sessions, signs one out, and has a confirmed Sign out everywhere", () => {
    const src = read("client/src/pages/usip/SettingsHub.tsx");
    const card = between(src, "function SessionsCard() {", "\n}\n");
    expect(card).toContain("trpc.profile.listMySessions.useQuery()");
    expect(card).toContain("signOutOne.mutate({ id: s.id })");
    const all = between(card, "onClick={() => confirmAction({", "}, () => signOutAll.mutate())}");
    expect(all).toContain('confirmLabel: "Sign out everywhere"');
    expect(between(src, "function MfaTab(", "function TotpDisconnectDialog(")).toContain("<SessionsCard />");
  });
});
