/**
 * 2FA backup codes (audit 2026-10-20, G15; final pass 2026-11-07).
 *
 * The lock-out screen said "there are no backup codes", and there were none:
 * a lost phone meant waiting for an admin. Now ten one-time codes are made at
 * setup and on demand (a new set replaces the old), stored hashed, shown
 * once, accepted at the second-factor prompt, each usable once, with "N codes
 * left" on the security screen. A wrong one counts against the account's
 * sign-in lock exactly as a wrong authenticator code does.
 *
 * The sign-in route runs for real on an ephemeral port against the SQL fake,
 * as in s1bSignIn.test.ts.
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
import { MAX_FAILURES, resetAccountLockouts, SIGN_IN_LOCKED } from "./services/accountLockout";
import { BACKUP_CODE_COUNT, hashBackupCode, looksLikeBackupCode, newBackupCode, normalizeBackupCode } from "./services/mfaBackupCodes";

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
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal");
}

/** Enrol for real through the procedure, and return the codes it handed out. */
async function enrol(): Promise<string[]> {
  me().mfaTotpEnabledAt = null;
  const out = await caller().profile.confirmTotpEnrollment({ code: codeFor(SECRET, nowStep() - 1) });
  return (out as any).backupCodes as string[];
}

beforeEach(() => {
  resetAccountLockouts();
  h.db = makeSqlFakeDb({ roles: { 2: "rep" }, wsId: () => 2 });
  rows("users").push({
    id: 1, openId: "o1", name: "Tester", email: EMAIL, passwordHash: bcrypt.hashSync(PASSWORD, 4),
    loginMethod: "password", mfaTotpSecret: SECRET, mfaTotpEnabledAt: null, mfaLastStep: null, sessionVersion: 0,
  });
});

describe("the codes", () => {
  it("are ten characters from an unambiguous alphabet, read in two halves", () => {
    for (let i = 0; i < 50; i++) {
      const c = newBackupCode();
      expect(c).toMatch(/^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
      expect(looksLikeBackupCode(c)).toBe(true);
    }
    expect(normalizeBackupCode(" ABCDE-fghjk ")).toBe("abcdefghjk");
    expect(looksLikeBackupCode("123456")).toBe(false);
    expect(looksLikeBackupCode("abcde-fghj0")).toBe(false);
  });

  it("hash differently on two accounts", () => {
    expect(hashBackupCode(1, "abcdefghjk")).not.toBe(hashBackupCode(2, "abcdefghjk"));
  });
});

describe("made at setup, shown once, stored hashed", () => {
  it("confirming the authenticator returns ten codes and keeps only their hashes", async () => {
    const codes = await enrol();
    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(codes).size).toBe(BACKUP_CODE_COUNT);
    const stored = rows("mfa_backup_codes");
    expect(stored).toHaveLength(BACKUP_CODE_COUNT);
    const dump = JSON.stringify(stored);
    for (const c of codes) {
      expect(dump).not.toContain(c);
      expect(dump).not.toContain(normalizeBackupCode(c)!);
    }
    expect(stored.every((r) => r.userId === 1 && r.usedAt == null && /^[0-9a-f]{64}$/.test(r.codeHash))).toBe(true);
    expect((await caller().profile.getMfaStatus()).backupCodes).toEqual({ left: 10, total: 10 });
  });
});

describe("accepted at the second-factor prompt, each once", () => {
  it("a backup code signs in in place of the authenticator code, and says how many are left", async () => {
    const codes = await enrol();
    const ok = await login({ backupCode: codes[3] });
    expect(ok.status).toBe(200);
    expect(ok.body.backupCodesLeft).toBe(9);
    expect((await caller().profile.getMfaStatus()).backupCodes.left).toBe(9);
  });

  it("the same code is refused the second time", async () => {
    const codes = await enrol();
    expect((await login({ backupCode: codes[0] })).status).toBe(200);
    const again = await login({ backupCode: codes[0] });
    expect(again.status).toBe(401);
    expect(again.body.mfaRequired).toBe(true);
    expect(again.body.error).toContain("already been used");
  });

  it("typed into the authenticator box, with capitals and spaces, it still works", async () => {
    const codes = await enrol();
    expect((await login({ totpCode: ` ${codes[5].toUpperCase().replace("-", " ")} ` })).status).toBe(200);
  });

  it("two sign-ins racing with one code: only one gets in", async () => {
    const codes = await enrol();
    const [a, b] = await Promise.all([login({ backupCode: codes[1] }), login({ backupCode: codes[1] })]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });

  it("another account's code does not work here", async () => {
    await enrol();
    const foreign = newBackupCode();
    rows("mfa_backup_codes").push({ id: 999, userId: 2, codeHash: hashBackupCode(2, normalizeBackupCode(foreign)!), usedAt: null });
    expect((await login({ backupCode: foreign })).status).toBe(401);
  });

  it("wrong backup codes count against the account's lock, like wrong authenticator codes", async () => {
    const codes = await enrol();
    for (let i = 0; i < MAX_FAILURES; i++) expect((await login({ backupCode: newBackupCode() })).status).toBe(401);
    const locked = await login({ backupCode: codes[2] });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe(SIGN_IN_LOCKED);
  });

  it("control: without 2FA a backup code field changes nothing", async () => {
    me().mfaTotpSecret = null;
    const ok = await login({ backupCode: "abcde-fghjk" });
    expect(ok.status).toBe(200);
    expect(ok.body.backupCodesLeft).toBeUndefined();
  });
});

describe("made again on demand, replacing the old set", () => {
  it("needs a current code or the password, and the old codes stop working", async () => {
    const old = await enrol();
    expect((await refusal(caller().profile.regenerateBackupCodes({ currentPassword: "nope" }))).code).toBe("FORBIDDEN");
    const { backupCodes } = await caller().profile.regenerateBackupCodes({ currentPassword: PASSWORD });
    expect(backupCodes).toHaveLength(10);
    expect(backupCodes.some((c) => old.includes(c))).toBe(false);
    expect(rows("mfa_backup_codes")).toHaveLength(10);
    expect((await login({ backupCode: old[0] })).status).toBe(401);
    expect((await login({ backupCode: backupCodes[0] })).status).toBe(200);
  });

  it("is refused without an authenticator", async () => {
    expect((await refusal(caller().profile.regenerateBackupCodes({ currentPassword: PASSWORD }))).code).toBe("BAD_REQUEST");
  });

  it("turning 2FA off takes the codes with it", async () => {
    await enrol();
    await caller().profile.disableTotp({ currentPassword: PASSWORD });
    expect(rows("mfa_backup_codes")).toHaveLength(0);
  });

  it("an admin's Reset 2FA clears them too", () => {
    const src = read("server/routers/admin.ts");
    const reset = src.slice(src.indexOf("resetMemberMfa: adminWsProcedure"), src.indexOf("getNotifPrefs: workspaceProcedure"));
    expect(reset).toContain("await clearBackupCodes(db, member.userId);");
  });
});

describe("the screens", () => {
  it("the setup dialog shows the codes before it closes", () => {
    const src = read("client/src/components/usip/settings/TotpSetupDialog.tsx");
    expect(src).toContain("if (Array.isArray(r?.backupCodes) && r.backupCodes.length > 0) setBackupCodes(r.backupCodes);");
    expect(src).toContain("<BackupCodesPanel codes={backupCodes} />");
  });

  it("the security screen says how many are left and makes a new set", () => {
    const src = read("client/src/pages/usip/SettingsHub.tsx");
    const row = src.slice(src.indexOf('data-testid="backup-codes-row"'), src.indexOf("<MfaMethodRow", src.indexOf('data-testid="backup-codes-row"')));
    expect(row).toContain("`${backupLeft} codes left`");
    expect(row).toContain("setBackupOpen(true)");
    expect(src).toContain("trpc.profile.regenerateBackupCodes.useMutation({");
  });

  it("the sign-in form offers a backup code and sends it as one", () => {
    const src = read("client/src/App.tsx");
    expect(src).toContain("Lost your phone? Use a backup code");
    expect(src).toContain("if (useBackup) body.backupCode = totpCode.trim();");
  });

  it("the lock-out screen no longer says there are no backup codes", () => {
    const src = read("client/src/components/usip/MfaRequiredGate.tsx");
    expect(src).not.toContain("there are no backup codes");
    expect(src).toContain("ten one-time backup codes");
  });
});
