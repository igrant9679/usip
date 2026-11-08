/**
 * Sign-in with an authenticator app, T1 batch (2026-11-06): tracker item 16
 * ("I cannot log in using my account even though I already used an
 * Authenticator App") and audit row G15 (the lock-out screen promised an admin
 * reset that had no button).
 *
 * What the verify path was checked for, and found sound: the RFC 6238
 * computation (the RFC's own vectors pass below), spaces in a code, one step
 * (30 s) of clock drift either way, the same plaintext secret read at
 * enrolment and at sign-in, and the order password → code. What was wrong:
 *   · each opening of the setup dialog replaced the pending secret, so the
 *     entry a person had already added to their app stopped matching;
 *   · a code whose step was already spent (sign straight back in after
 *     enrolling) was reported as "didn't match";
 *   · every request counted against the 10-per-15-minutes limit, two per 2FA
 *     sign-in and successes included;
 *   · nobody could reset a member's 2FA from the Team page.
 *
 * The sign-in route runs for real on an ephemeral port against the SQL fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import express from "express";
import bcrypt from "bcryptjs";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { registerPasswordAuthRoutes } from "./passwordAuth";
import { appRouter } from "./routers";
import { base32Decode, verifyTotp } from "./services/totp";
import { openTotpSecret } from "./services/totpSecret";

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const EMAIL = "tester@velocity.test";
const PASSWORD = "correct horse battery";
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const me = () => rows("users").find((u) => u.id === 1);

/** The code an authenticator app shows for `step`, computed independently of services/totp. */
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
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e; }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { 2: "rep" }, wsId: () => 2 });
  rows("users").push({
    id: 1, openId: "o1", name: "Tester", email: EMAIL, passwordHash: bcrypt.hashSync(PASSWORD, 4),
    loginMethod: "password", mfaTotpSecret: SECRET, mfaTotpEnabledAt: new Date(), mfaLastStep: null, sessionVersion: 0,
  });
});

describe("the code computation is RFC 6238", () => {
  it("passes the RFC's SHA-1 vectors", () => {
    const rfc = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(verifyTotp(rfc, "287082", 0, 59_000)).toBe(true);
    expect(verifyTotp(rfc, "081804", 0, 1111111109_000)).toBe(true);
    expect(verifyTotp(rfc, "279037", 0, 2000000000_000)).toBe(true);
  });
});

describe("signing in with an authenticator app (tracker 16)", () => {
  it("asks for the code after the password, then signs in with it, spaces and all", async () => {
    const first = await login({});
    expect(first.status).toBe(401);
    expect(first.body.mfaRequired).toBe(true);
    const code = codeFor(SECRET, nowStep());
    const ok = await login({ totpCode: `${code.slice(0, 3)} ${code.slice(3)}` });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
  });

  it("accepts the previous step's code (a phone up to 30 s behind)", async () => {
    expect((await login({ totpCode: codeFor(SECRET, nowStep() - 1) })).status).toBe(200);
  });

  it("a code already used says so, instead of 'didn't match'", async () => {
    const code = codeFor(SECRET, nowStep());
    expect((await login({ totpCode: code })).status).toBe(200);
    const again = await login({ totpCode: code });
    expect(again.status).toBe(401);
    expect(again.body.mfaRequired).toBe(true);
    expect(again.body.error).toContain("already been used");
    expect(again.body.error).not.toContain("didn't match");
  });

  it("right after enrolling, the same code is refused as used, not as wrong", async () => {
    me().mfaTotpEnabledAt = null;
    const code = codeFor(SECRET, nowStep());
    await caller().profile.confirmTotpEnrollment({ code });
    const e = await login({ totpCode: code });
    expect(e.status).toBe(401);
    expect(e.body.error).toContain("already been used");
    const confirmAgain = await refusal((me().mfaTotpEnabledAt = null, caller().profile.confirmTotpEnrollment({ code })));
    expect(confirmAgain.message).toContain("already been used");
  });

  it("a wrong code still says it didn't match", async () => {
    const wrong = String((Number(codeFor(SECRET, nowStep())) + 1) % 1_000_000).padStart(6, "0");
    const r = await login({ totpCode: wrong });
    expect(r.status).toBe(401);
    expect(r.body.error).toContain("didn't match");
  });
});

describe("re-opening the setup dialog keeps the key the app already has (tracker 16)", () => {
  it("an unconfirmed key is handed back, not replaced", async () => {
    me().mfaTotpEnabledAt = null;
    me().mfaTotpSecret = null;
    const a = await caller().profile.startTotpEnrollment();
    const b = await caller().profile.startTotpEnrollment();
    expect(b.secret).toBe(a.secret);
    expect(b.reused).toBe(true);
    // The key is stored encrypted since 2026-11-07 (services/totpSecret.ts):
    // what is kept still opens to the key the app already has.
    expect(openTotpSecret(me().mfaTotpSecret)).toBe(a.secret);
    // The entry added from the first opening confirms.
    await caller().profile.confirmTotpEnrollment({ code: codeFor(a.secret, nowStep()) });
    expect(me().mfaTotpEnabledAt).toBeTruthy();
  });

  it("after a disconnect, a fresh key", async () => {
    me().mfaTotpEnabledAt = null;
    me().mfaTotpSecret = null;
    const a = await caller().profile.startTotpEnrollment();
    me().mfaTotpSecret = null; // disconnect / admin reset clears it
    const b = await caller().profile.startTotpEnrollment();
    expect(b.secret).not.toBe(a.secret);
    expect(b.reused).toBe(false);
  });

  it("the dialog says the key is the same one", () => {
    const src = read("client/src/components/usip/settings/TotpSetupDialog.tsx");
    expect(src).toContain("{enroll.reused && (");
  });
});

describe("only failed sign-ins count against the limit (tracker 16)", () => {
  it("successes and the code prompt are not counted; wrong passwords and codes are", () => {
    const src = read("server/passwordAuth.ts");
    const limiter = src.slice(src.indexOf("const passwordLoginLimiter = rateLimit({"), src.indexOf("const registerLimiter"));
    expect(limiter).toContain("skipSuccessfulRequests: true");
    expect(limiter).toContain("res.statusCode < 400 || res.locals.mfaCodePrompt === true");
    const route = src.slice(src.indexOf('"/api/auth/password-login"'), src.indexOf('"/api/auth/register"'));
    // 2026-11-07 (G15): the prompt condition now also waits for a backup code
    // (`!totpCode && !backupCode`); what it pins is unchanged.
    const promptAt = route.indexOf("if (!totpCode && !backupCode) {");
    expect(promptAt).toBeGreaterThan(-1);
    const prompt = route.slice(promptAt, route.indexOf("// A code works ONCE"));
    expect(prompt).toContain("res.locals.mfaCodePrompt = true;");
    // Set only on the prompt: a wrong or spent code must still count.
    expect(route.split("mfaCodePrompt = true").length - 1).toBe(1);
  });
});

describe("an admin can reset a member's 2FA from the Team page (G15)", () => {
  it("team.list says who has 2FA, without the secret", () => {
    const src = read("server/routers/admin.ts");
    const list = src.slice(src.indexOf("export const teamRouter = router({"), src.indexOf("invite: adminWsProcedure"));
    expect(list).toContain("mfaEnabled: sql<number>`CASE WHEN ${users.mfaTotpEnabledAt} IS NOT NULL THEN 1 ELSE 0 END`");
    expect(list).not.toContain("mfaTotpSecret");
  });

  it("the Team page shows a 2FA badge and a confirmed Reset 2FA for members the admin may edit", () => {
    const src = read("client/src/pages/usip/Team.tsx");
    expect(src).toContain("trpc.team.resetMemberMfa.useMutation({");
    const btn = src.slice(src.indexOf("{editable && Number(m.mfaEnabled) === 1 && ("), src.indexOf('title="View login history"'));
    expect(btn).toContain("confirmAction({");
    expect(btn).toContain("resetMfa.mutate({ memberId: m.memberId })");
    expect(src).toContain("<ShieldCheck className=\"size-2.5\" /> 2FA");
  });

  it("the lock-out screen's promise points at the button that now exists", () => {
    expect(read("client/src/components/usip/MfaRequiredGate.tsx")).toContain("Reset 2FA on your row of the Team");
  });
});
