/**
 * The authenticator secret is stored encrypted (follow-up to the audit's
 * final pass, 2026-11-07; the SEC batch named `users.mfa_totp_secret` as the
 * one secret still in plaintext).
 *
 * Pinned here:
 *   · setup stores the key encrypted, and confirm, sign-in, disable and new
 *     backup codes all read it back;
 *   · a key saved before this change still works, and setup re-saves it
 *     encrypted;
 *   · a key that won't decrypt matches no code at sign-in — never an
 *     empty-key HMAC anyone could compute, and never a skipped second factor;
 *   · the boot pass encrypts old rows once, and puts back any write that was
 *     not stored whole (a column still too narrow before migration 0350 runs);
 *   · migration 0350 widens the column and the schema says so.
 *
 * The sign-in route runs for real on an ephemeral port against the SQL fake,
 * as in g15BackupCodes.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import express from "express";
import bcrypt from "bcryptjs";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { registerPasswordAuthRoutes } from "./passwordAuth";
import { appRouter } from "./routers";
import { base32Decode } from "./services/totp";
import { resetAccountLockouts } from "./services/accountLockout";
import { openTotpSecret, sealTotpSecret } from "./services/totpSecret";
import { encryptLegacyMailboxSecrets, looksEncrypted } from "./services/secretBackfill";
import { encryptField } from "./emailAdapter";

const EMAIL = "tester@velocity.test";
const PASSWORD = "correct horse battery";
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
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

async function login(body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/auth/password-login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, ...body }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
function caller() {
  return appRouter.createCaller({
    user: { id: 1, openId: "o1", email: EMAIL, name: "Tester", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": "2" } },
    res: { clearCookie: () => {}, cookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  resetAccountLockouts();
  h.db = makeSqlFakeDb({ roles: { 2: "rep" }, wsId: () => 2 });
  rows("users").push({
    id: 1, openId: "o1", name: "Tester", email: EMAIL, passwordHash: bcrypt.hashSync(PASSWORD, 4),
    loginMethod: "password", mfaTotpSecret: null, mfaTotpEnabledAt: null, mfaLastStep: null, sessionVersion: 0,
    updatedAt: new Date("2026-11-01T00:00:00Z"),
  });
});

describe("the helpers", () => {
  it("seal encrypts, open reads both forms, and an unreadable value opens as null", () => {
    const sealed = sealTotpSecret(SECRET);
    expect(sealed).not.toContain(SECRET);
    expect(looksEncrypted(sealed)).toBe(true);
    expect(openTotpSecret(sealed)).toBe(SECRET);
    // Saved before encryption: base32 never has the iv:tag:ciphertext shape.
    expect(looksEncrypted(SECRET)).toBe(false);
    expect(openTotpSecret(SECRET)).toBe(SECRET);
    // Damaged ciphertext (or a changed key) reads as nothing, not as "".
    const damaged = sealed.slice(0, -4) + (sealed.endsWith("0000") ? "1111" : "0000");
    expect(openTotpSecret(damaged)).toBeNull();
    expect(openTotpSecret(null)).toBeNull();
    expect(openTotpSecret("")).toBeNull();
  });
});

describe("setup, confirm and sign-in with the key stored encrypted", () => {
  it("setup stores the key encrypted and hands back the plain key once", async () => {
    const out = await caller().profile.startTotpEnrollment();
    expect(me().mfaTotpSecret).not.toBe(out.secret);
    expect(JSON.stringify(rows("users"))).not.toContain(out.secret);
    expect(looksEncrypted(me().mfaTotpSecret)).toBe(true);
    expect(openTotpSecret(me().mfaTotpSecret)).toBe(out.secret);
    // Opening the dialog again hands back the same key and leaves the row.
    const stored = me().mfaTotpSecret;
    const again = await caller().profile.startTotpEnrollment();
    expect(again).toMatchObject({ secret: out.secret, reused: true });
    expect(me().mfaTotpSecret).toBe(stored);
  });

  it("confirm, sign-in and disable all read the encrypted key", async () => {
    const { secret } = await caller().profile.startTotpEnrollment();
    await caller().profile.confirmTotpEnrollment({ code: codeFor(secret, nowStep() - 1) });
    expect(me().mfaTotpEnabledAt).toBeTruthy();

    expect((await login({})).body.mfaRequired).toBe(true);
    const ok = await login({ totpCode: codeFor(secret, nowStep()) });
    expect(ok.status).toBe(200);

    await caller().profile.disableTotp({ code: codeFor(secret, nowStep() + 1) });
    expect(me()).toMatchObject({ mfaTotpSecret: null, mfaTotpEnabledAt: null });
  });

  it("a key saved before encryption still signs in, and setup re-saves a pending one encrypted", async () => {
    Object.assign(me(), { mfaTotpSecret: SECRET, mfaTotpEnabledAt: new Date() });
    expect((await login({ totpCode: codeFor(SECRET, nowStep()) })).status).toBe(200);

    Object.assign(me(), { mfaTotpSecret: SECRET, mfaTotpEnabledAt: null });
    const out = await caller().profile.startTotpEnrollment();
    expect(out).toMatchObject({ secret: SECRET, reused: true });
    expect(looksEncrypted(me().mfaTotpSecret)).toBe(true);
    expect(openTotpSecret(me().mfaTotpSecret)).toBe(SECRET);
  });

  it("a key that won't decrypt still asks for the code and refuses every code, including the empty-key one", async () => {
    const sealed = sealTotpSecret(SECRET);
    Object.assign(me(), { mfaTotpSecret: sealed.slice(0, -4) + (sealed.endsWith("0000") ? "1111" : "0000"), mfaTotpEnabledAt: new Date() });
    expect((await login({})).body.mfaRequired).toBe(true);
    // The code anyone could compute from an empty HMAC key.
    const emptyKeyCode = codeFor("", nowStep());
    const r = await login({ totpCode: emptyKeyCode });
    expect(r.status).toBe(401);
    expect(r.body.mfaRequired).toBe(true);
    expect((await login({ totpCode: codeFor(SECRET, nowStep()) })).status).toBe(401);
  });
});

describe("the boot pass", () => {
  it("encrypts an old plaintext key once, keeping updatedAt", async () => {
    Object.assign(me(), { mfaTotpSecret: SECRET, mfaTotpEnabledAt: new Date() });
    const before = me().updatedAt;
    expect(await encryptLegacyMailboxSecrets(h.db)).toEqual({ encrypted: 1 });
    expect(looksEncrypted(me().mfaTotpSecret)).toBe(true);
    expect(openTotpSecret(me().mfaTotpSecret)).toBe(SECRET);
    expect(me().updatedAt).toEqual(before);
    expect(await encryptLegacyMailboxSecrets(h.db)).toEqual({ encrypted: 0 });
    expect((await login({ totpCode: codeFor(SECRET, nowStep()) })).status).toBe(200);
  });

  it("puts back a write that was not stored whole, for the next boot", async () => {
    Object.assign(me(), { mfaTotpSecret: SECRET, mfaTotpEnabledAt: new Date() });
    // A column still varchar(64) under a lenient SQL mode: the fake cuts the
    // value short the way MySQL would.
    const users = rows("users");
    const proxy = new Proxy(users[0], {
      set(target, prop, value) {
        (target as any)[prop] = prop === "mfaTotpSecret" && typeof value === "string" ? value.slice(0, 64) : value;
        return true;
      },
    });
    users[0] = proxy;
    expect(await encryptLegacyMailboxSecrets(h.db)).toEqual({ encrypted: 0 });
    expect(me().mfaTotpSecret).toBe(SECRET);
  });

  it("migration 0350 widens the column, and the schema says so", () => {
    const m = read("server/_core/rawMigrations.ts");
    const at = m.indexOf('name: "0350_totp_secret_encrypted.sql"');
    expect(at).toBeGreaterThan(-1);
    expect(m.slice(at, at + 300)).toContain("ALTER TABLE `users` MODIFY COLUMN `mfa_totp_secret` varchar(255) NULL");
    expect(read("drizzle/schema.ts")).toContain('mfaTotpSecret: varchar("mfa_totp_secret", { length: 255 })');
    // An encrypted key fits.
    expect(encryptField(SECRET).length).toBeLessThanOrEqual(255);
  });
});
