/**
 * Batch S1b (audit 2026-10-20): sign-in and the signed-in user's own
 * credentials.
 *
 *   G9   a failed password or 2FA code counts against the ACCOUNT, not just
 *        the address it came from, so many machines can't share one guess.
 *   G31  an unknown email costs the same bcrypt work as a wrong password, and
 *        forgot-password answers before it sends.
 *   G32  changing the password, the email or turning 2FA off is a credential
 *        check with the same lock; a new email is confirmed from its own
 *        mailbox and the old one is told.
 *
 * The routes run for real on an ephemeral port against the SQL fake, as in
 * t1TwoFactor.test.ts. The IP limiters skip under NODE_ENV=test; the account
 * lock does not, which is what lets it be tested here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  sent: [] as Array<{ ws: number; to: string; subject: string; html: string }>,
  hold: null as null | Promise<void>,
}));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./emailDelivery", async (a) => ({
  ...(await a<typeof import("./emailDelivery")>()),
  sendSystemEmail: async (ws: number, msg: any) => {
    if (h.hold) await h.hold;
    h.sent.push({ ws, ...msg });
    return { ok: true };
  },
}));

import express from "express";
import bcrypt from "bcryptjs";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { DUMMY_PASSWORD_HASH, registerPasswordAuthRoutes } from "./passwordAuth";
import { appRouter } from "./routers";
import { base32Decode } from "./services/totp";
import { MAX_FAILURES, resetAccountLockouts, SIGN_IN_LOCKED } from "./services/accountLockout";
import { EMAIL_CHANGE_TTL_MS, makeEmailChangeToken, readEmailChangeToken } from "./services/emailChangeToken";
import { hashResetToken } from "./services/passwordReset";

const EMAIL = "tester@velocity.test";
const PASSWORD = "correct horse battery";
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const rows = (t: string) => h.db.rowsOf(t) as any[];
const me = () => rows("users").find((u) => u.id === 1);

function codeFor(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const hm = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = hm[hm.length - 1] & 0x0f;
  return String(((((hm[o] & 0x7f) << 24) | (hm[o + 1] << 16) | (hm[o + 2] << 8) | hm[o + 3]) % 1_000_000)).padStart(6, "0");
}
const nowStep = () => Math.floor(Date.now() / 1000 / 30);
const wrongCode = () => String((Number(codeFor(SECRET, nowStep())) + 500_000) % 1_000_000).padStart(6, "0");

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

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const login = (body: Record<string, unknown> = {}) => post("/api/auth/password-login", { email: EMAIL, password: PASSWORD, ...body });

function caller() {
  return appRouter.createCaller({
    user: { id: 1, openId: "o1", email: EMAIL, name: "Tester", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": "2" } },
    res: { clearCookie: () => {}, cookie: () => {} },
  } as unknown as TrpcContext);
}
const anon = () => appRouter.createCaller({ user: null, req: { headers: {} }, res: {} } as unknown as TrpcContext);
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  resetAccountLockouts();
  h.sent = [];
  h.hold = null;
  h.db = makeSqlFakeDb({ roles: { 2: "rep" }, wsId: () => 2 });
  rows("users").push({
    id: 1, openId: "o1", name: "Tester", email: EMAIL, passwordHash: bcrypt.hashSync(PASSWORD, 4),
    loginMethod: "password", mfaTotpSecret: null, mfaTotpEnabledAt: null, mfaLastStep: null, sessionVersion: 0,
  });
});

/* ─── G9 ───────────────────────────────────────────────────────────────── */

describe("G9: failed sign-ins lock the account, from any address", () => {
  it(`after ${MAX_FAILURES} wrong passwords even the right one is refused, with no lookup`, async () => {
    for (let i = 0; i < MAX_FAILURES; i++) expect((await login({ password: `wrong-${i}` })).status).toBe(401);
    const locked = await login();
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe(SIGN_IN_LOCKED);
    // The lock is per account: another account signs in as usual.
    rows("users").push({ id: 2, openId: "o2", name: "Other", email: "other@velocity.test", passwordHash: bcrypt.hashSync("other-pass-1", 4), loginMethod: "password", sessionVersion: 0 });
    expect((await post("/api/auth/password-login", { email: "other@velocity.test", password: "other-pass-1" })).status).toBe(200);
  });

  it("an address with no account locks the same way and says the same thing", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect((await post("/api/auth/password-login", { email: "Nobody@Velocity.test", password: "x" })).status).toBe(401);
    }
    const locked = await post("/api/auth/password-login", { email: "nobody@velocity.test", password: "x" });
    expect(locked).toEqual({ status: 429, body: { error: SIGN_IN_LOCKED } });
  });

  it("wrong authenticator codes count too, so the password holder gets ten guesses at the code", async () => {
    me().mfaTotpSecret = SECRET;
    me().mfaTotpEnabledAt = new Date();
    for (let i = 0; i < MAX_FAILURES; i++) expect((await login({ totpCode: wrongCode() })).status).toBe(401);
    expect((await login({ totpCode: codeFor(SECRET, nowStep()) })).status).toBe(429);
  });

  it("control: the code prompt is not a failure, and a success clears the count", async () => {
    me().mfaTotpSecret = SECRET;
    me().mfaTotpEnabledAt = new Date();
    for (let i = 0; i < MAX_FAILURES + 2; i++) expect((await login()).body.mfaRequired).toBe(true);
    for (let i = 0; i < MAX_FAILURES - 1; i++) await login({ password: "nope" });
    expect((await login({ totpCode: codeFor(SECRET, nowStep()) })).status).toBe(200);
    for (let i = 0; i < MAX_FAILURES - 1; i++) await login({ password: "nope" });
    expect((await login({ password: "nope" })).status, "the tenth failure since the success, not the nineteenth").toBe(401);
  });

  it("a password reset unlocks it", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await login({ password: "nope" });
    expect((await login()).status).toBe(429);
    const token = "f".repeat(64);
    Object.assign(me(), { passwordResetTokenHash: hashResetToken(token), passwordResetExpiresAt: new Date(Date.now() + 60_000) });
    expect((await post("/api/auth/reset-password", { token, password: "a brand new password" })).status).toBe(200);
    expect((await login({ password: "a brand new password" })).status).toBe(200);
  });
});

/* ─── G31 ──────────────────────────────────────────────────────────────── */

describe("G31: sign-in and forgot-password don't tell which emails have accounts", () => {
  it("the dummy hash is a real cost-12 bcrypt hash, so comparing against it does the work", async () => {
    expect(DUMMY_PASSWORD_HASH).toHaveLength(60);
    expect(bcrypt.getRounds(DUMMY_PASSWORD_HASH)).toBe(12);
    // A malformed hash returns at once; this one takes the full cost.
    const t0 = Date.now();
    expect(await bcrypt.compare("anything", DUMMY_PASSWORD_HASH)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThan(20);
  });

  it("an unknown email is compared against it", async () => {
    const spy = vi.spyOn(bcrypt, "compare");
    try {
      await post("/api/auth/password-login", { email: "ghost@velocity.test", password: "x" });
      expect(spy).toHaveBeenCalledWith("x", DUMMY_PASSWORD_HASH);
      // Every hash compared on that request was a well-formed cost-12 one.
      for (const [, hash] of spy.mock.calls) {
        expect(String(hash)).toHaveLength(60);
        expect(bcrypt.getRounds(String(hash))).toBe(12);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("forgot-password answers a real account before the reset email is sent", async () => {
    rows("workspaces").push({ id: 2, name: "LSI", slug: "lsi", ownerUserId: 1 });
    let release!: () => void;
    h.hold = new Promise<void>((r) => { release = r; });
    const answer = post("/api/auth/forgot-password", { email: EMAIL });
    const first = await Promise.race([answer, new Promise((r) => setTimeout(() => r("still waiting"), 3000))]);
    expect(first, "the answer waited for the mail send").toEqual({ status: 200, body: { ok: true } });
    expect(h.sent).toHaveLength(0);
    release();
    for (let i = 0; i < 100 && h.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(h.sent.map((m) => m.to)).toEqual([EMAIL]);
  });
});

/* ─── G32 ──────────────────────────────────────────────────────────────── */

describe("G32: the signed-in user's own credential changes", () => {
  it("a new email is not applied until its own mailbox confirms, and the old address is told", async () => {
    const out = await caller().profile.changeMyEmail({ newEmail: "New@Mailbox.example", currentPassword: PASSWORD });
    expect(out).toMatchObject({ ok: true, pending: true, email: "new@mailbox.example" });
    expect(me().email).toBe(EMAIL);
    expect(h.sent.map((m) => m.to)).toEqual(["new@mailbox.example", EMAIL]);
    expect(h.sent[1].html).toContain("new@mailbox.example");
    expect(h.sent[1].html).toContain("If this wasn't you");
    const token = decodeURIComponent(/confirm-email\?token=([^"&]+)/.exec(h.sent[0].html)![1]);

    expect(await anon().profile.confirmEmailChange({ token })).toEqual({ ok: true, email: "new@mailbox.example" });
    expect(me().email).toBe("new@mailbox.example");
    // Once: the account no longer has the old address the link names.
    expect((await refusal(anon().profile.confirmEmailChange({ token }))).code).toBe("BAD_REQUEST");
  });

  it("a forged, tampered or expired link changes nothing", async () => {
    const good = makeEmailChangeToken({ userId: 1, oldEmail: EMAIL, newEmail: "x@mailbox.example" });
    const [payload, sig] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ u: 1, o: EMAIL, n: "evil@mailbox.example", x: Date.now() + 60_000 })).toString("base64url");
    for (const t of [`${forged}.${sig}`, `${payload}.${sig.slice(0, -2)}xx`, `${payload}`, "rubbish.rubbish"]) {
      expect((await refusal(anon().profile.confirmEmailChange({ token: t.padEnd(10, "x") }))).code, t).toBe("BAD_REQUEST");
    }
    expect(readEmailChangeToken(good, Date.now() + EMAIL_CHANGE_TTL_MS + 1)).toBeNull();
    expect(me().email).toBe(EMAIL);
  });

  it("wrong current passwords lock password and email changes, and 2FA off", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect((await refusal(caller().profile.changeMyPassword({ currentPassword: "nope", newPassword: "another password" }))).code).toBe("FORBIDDEN");
    }
    expect((await refusal(caller().profile.changeMyPassword({ currentPassword: PASSWORD, newPassword: "another password" }))).code).toBe("TOO_MANY_REQUESTS");
    expect((await refusal(caller().profile.changeMyEmail({ newEmail: "n@mailbox.example", currentPassword: PASSWORD }))).code).toBe("TOO_MANY_REQUESTS");
    me().mfaTotpSecret = SECRET;
    me().mfaTotpEnabledAt = new Date();
    expect((await refusal(caller().profile.disableTotp({ currentPassword: PASSWORD }))).code).toBe("TOO_MANY_REQUESTS");
    expect(me().mfaTotpEnabledAt).toBeTruthy();
    expect(await bcrypt.compare(PASSWORD, me().passwordHash)).toBe(true);
  });

  it("wrong 2FA-off attempts count as well", async () => {
    me().mfaTotpSecret = SECRET;
    me().mfaTotpEnabledAt = new Date();
    for (let i = 0; i < MAX_FAILURES; i++) await refusal(caller().profile.disableTotp({ code: wrongCode() }));
    expect((await refusal(caller().profile.disableTotp({ code: codeFor(SECRET, nowStep()) }))).code).toBe("TOO_MANY_REQUESTS");
  });

  it("email-change requests are capped, since each sends two emails", async () => {
    for (let i = 0; i < 5; i++) await caller().profile.changeMyEmail({ newEmail: `n${i}@mailbox.example`, currentPassword: PASSWORD });
    expect((await refusal(caller().profile.changeMyEmail({ newEmail: "n9@mailbox.example", currentPassword: PASSWORD }))).code).toBe("TOO_MANY_REQUESTS");
    expect(h.sent).toHaveLength(10);
  });

  it("control: the right password still changes the password", async () => {
    await caller().profile.changeMyPassword({ currentPassword: PASSWORD, newPassword: "another password" });
    expect(await bcrypt.compare("another password", me().passwordHash)).toBe(true);
  });
});
