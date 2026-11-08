/**
 * Email verification for self-registered accounts (audit 2026-10-20, F1;
 * final pass 2026-11-07), and the sign-up policy it completes (F2).
 *
 * Register gave a session with no confirmation email. Now a stranger's new
 * account carries a verification link's hash, the link goes out through the
 * system sender a password reset uses (honouring the outbound pause), the
 * account shows a banner with Resend until it is opened, and accepting an
 * invitation, completing a password reset or confirming a new sign-in email
 * verifies it too. Every existing account counts as verified (migration
 * 0312's idempotent backfill).
 *
 * The register route runs for real on an ephemeral port against the SQL fake
 * with real membership rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  sent: [] as Array<{ ws: number; to: string; subject: string; html: string }>,
}));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./emailDelivery", async (a) => ({
  ...(await a<typeof import("./emailDelivery")>()),
  sendSystemEmail: async (ws: number, msg: any) => { h.sent.push({ ws, ...msg }); return { ok: true }; },
}));

import express from "express";
import bcrypt from "bcryptjs";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { registerPasswordAuthRoutes } from "./passwordAuth";
import { appRouter } from "./routers";
import { publicUser } from "./_core/safeProjections";
import { resetAccountLockouts } from "./services/accountLockout";
import { hashResetToken } from "./services/passwordReset";
import { makeEmailChangeToken } from "./services/emailChangeToken";
import { isEmailVerificationPending } from "./services/accountEmailVerification";
import { invalidateSendWindowCache } from "./services/sendWindow";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const userBy = (email: string) => rows("users").find((u) => u.email === email);
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

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
/** The mail is sent after the answer; wait for it. */
async function settle() {
  for (let i = 0; i < 100 && h.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
}
const linkToken = (html: string) => decodeURIComponent(/verify-email\?token=([^"&]+)/.exec(html)![1]);

function caller(userId: number | null) {
  const user = userId == null ? null : rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {}, cookie: () => {} },
  } as unknown as TrpcContext);
}

const PLATFORM_WS = 7;
beforeEach(() => {
  resetAccountLockouts();
  // The pause is read through a short cache; each test starts from the rows it seeds.
  invalidateSendWindowCache();
  h.sent = [];
  h.db = makeSqlFakeDb({ realMembers: true });
  // The platform owner (users.role = "admin") and the workspace they own:
  // the sender for a stranger who belongs nowhere.
  rows("users").push({ id: 99, openId: "local:99", name: "Platform", email: "owner@platform.example", role: "admin", passwordHash: "x", sessionVersion: 0, createdAt: new Date() });
  rows("users").push({ id: 98, openId: "local:98", name: "Client", email: "client@client.example", role: "user", passwordHash: "x", sessionVersion: 0, createdAt: new Date() });
  rows("workspaces").push(
    { id: 3, name: "A client", slug: "client", ownerUserId: 98, archivedAt: null, plan: "trial" },
    { id: PLATFORM_WS, name: "Platform", slug: "platform", ownerUserId: 99, archivedAt: null, plan: "trial" },
  );
});

describe("a stranger who registers must confirm the address", () => {
  it("the new account waits on a link, which goes to that address through the platform's sender", async () => {
    const out = await post("/api/auth/register", { email: "New.Person@Example.com", password: "a long enough password", name: "New Person" });
    expect(out.status).toBe(200);
    expect(out.body.emailVerificationPending).toBe(true);
    const u = userBy("new.person@example.com");
    expect(u.emailVerifiedAt).toBeNull();
    expect(u.emailVerifyTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(isEmailVerificationPending(u)).toBe(true);
    await settle();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ ws: PLATFORM_WS, to: "new.person@example.com" });
    // The mail carries the raw token; the row only its hash.
    expect(hashResetToken(linkToken(h.sent[0].html))).toBe(u.emailVerifyTokenHash);
    expect((h.sent[0] as any).logPreview).toContain("link withheld");
  });

  it("auth.me says so, and never hands out the hash", async () => {
    await post("/api/auth/register", { email: "a@example.com", password: "a long enough password" });
    const me = publicUser(userBy("a@example.com"))!;
    expect(me.emailVerificationPending).toBe(true);
    expect(JSON.stringify(me)).not.toContain(userBy("a@example.com").emailVerifyTokenHash);
    // Every account without a pending link counts as verified.
    expect(publicUser(rows("users").find((r) => r.id === 98))!.emailVerificationPending).toBe(false);
  });

  it("opening the link verifies the account, once", async () => {
    await post("/api/auth/register", { email: "b@example.com", password: "a long enough password" });
    await settle();
    const token = linkToken(h.sent[0].html);
    expect(await caller(null).accountVerification.confirm({ token })).toEqual({ ok: true, email: "b@example.com" });
    const u = userBy("b@example.com");
    expect(u.emailVerifiedAt).toBeInstanceOf(Date);
    expect(u.emailVerifyTokenHash).toBeNull();
    expect(isEmailVerificationPending(u)).toBe(false);
    await expect(caller(null).accountVerification.confirm({ token })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("an expired or made-up link verifies nothing", async () => {
    await post("/api/auth/register", { email: "c@example.com", password: "a long enough password" });
    await settle();
    const token = linkToken(h.sent[0].html);
    userBy("c@example.com").emailVerifyExpiresAt = new Date(Date.now() - 1000);
    await expect(caller(null).accountVerification.confirm({ token })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller(null).accountVerification.confirm({ token: "f".repeat(64) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(isEmailVerificationPending(userBy("c@example.com"))).toBe(true);
  });

  it("while the sender's workspace has outbound paused, no link is sent, and Resend says why", async () => {
    rows("workspace_settings").push({ id: 1, workspaceId: PLATFORM_WS, outboundPausedAt: new Date(), timezone: "UTC" });
    await post("/api/auth/register", { email: "d@example.com", password: "a long enough password" });
    await new Promise((r) => setTimeout(r, 100));
    expect(h.sent).toHaveLength(0);
    const id = userBy("d@example.com").id;
    const out = await caller(id).accountVerification.resend();
    expect(out.sent).toBe(false);
    expect(out.message).toContain("paused");
    expect(h.sent).toHaveLength(0);
  });

  it("Resend makes a new link (the old one stops working) and is capped", async () => {
    await post("/api/auth/register", { email: "e@example.com", password: "a long enough password" });
    await settle();
    const first = linkToken(h.sent[0].html);
    const id = userBy("e@example.com").id;
    const out = await caller(id).accountVerification.resend();
    expect(out.sent).toBe(true);
    expect(h.sent).toHaveLength(2);
    await expect(caller(null).accountVerification.confirm({ token: first })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    for (let i = 0; i < 4; i++) await caller(id).accountVerification.resend();
    await expect(caller(id).accountVerification.resend()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // A verified account is told so and sent nothing.
    expect((await caller(98).accountVerification.resend()).alreadyVerified).toBe(true);
  });

  it("an activation-link member's link comes from their own workspace's sender", async () => {
    rows("workspace_invite_links").push({ id: 1, workspaceId: 3, token: "activation-link-token-0001", role: "rep", title: null, quota: null, usedAt: null, expiresAt: null });
    await post("/api/auth/register", { email: "f@example.com", password: "a long enough password", inviteLinkToken: "activation-link-token-0001" });
    await settle();
    expect(h.sent.map((m) => m.ws)).toEqual([3]);
  });
});

describe("other ways the address is proven", () => {
  const pending = (id: number, email: string, over: Record<string, unknown> = {}) => ({
    id, openId: `local:${id}`, name: "P", email, role: "user", passwordHash: bcrypt.hashSync("old password", 4), loginMethod: "password",
    sessionVersion: 0, emailVerifiedAt: null, emailVerifyTokenHash: "a".repeat(64), emailVerifyExpiresAt: new Date(Date.now() + 60_000), ...over,
  });

  it("accepting an invitation, whose token was emailed to the address", async () => {
    rows("users").push(pending(50, "g@example.com"));
    rows("workspace_members").push({ id: 1, workspaceId: 3, userId: 50, role: "rep", inviteToken: "i".repeat(40), inviteExpiresAt: null, deactivatedAt: null, createdAt: new Date() });
    await caller(50).team.finaliseAcceptance({ token: "i".repeat(40) });
    expect(isEmailVerificationPending(userBy("g@example.com"))).toBe(false);
    expect(userBy("g@example.com").emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("registering on an invitation's own placeholder is verified at once, and sends no link", async () => {
    rows("users").push({ id: 51, openId: "invite:h@example.com", name: null, email: "h@example.com", role: "user", passwordHash: null, loginMethod: "invite", sessionVersion: 0 });
    rows("workspace_members").push({ id: 2, workspaceId: 3, userId: 51, role: "rep", inviteToken: "j".repeat(40), inviteExpiresAt: null, deactivatedAt: null, createdAt: new Date() });
    const out = await post("/api/auth/register", { email: "h@example.com", password: "a long enough password", inviteToken: "j".repeat(40) });
    expect(out.status).toBe(200);
    expect(out.body.emailVerificationPending).toBe(false);
    expect(userBy("h@example.com").emailVerifiedAt).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.sent).toHaveLength(0);
  });

  it("completing a password reset", async () => {
    const token = "r".repeat(64);
    rows("users").push(pending(52, "i@example.com", { passwordResetTokenHash: hashResetToken(token), passwordResetExpiresAt: new Date(Date.now() + 60_000) }));
    expect((await post("/api/auth/reset-password", { token, password: "a brand new password" })).status).toBe(200);
    expect(isEmailVerificationPending(userBy("i@example.com"))).toBe(false);
  });

  it("confirming a new sign-in email", async () => {
    rows("users").push(pending(53, "j@example.com"));
    const token = makeEmailChangeToken({ userId: 53, oldEmail: "j@example.com", newEmail: "k@example.com" });
    await caller(null).profile.confirmEmailChange({ token });
    expect(isEmailVerificationPending(userBy("k@example.com"))).toBe(false);
  });
});

describe("existing accounts count as verified", () => {
  it("migration 0312 backfills them, skipping any account with a pending link, so it is safe to run again", () => {
    const src = read("server/_core/rawMigrations.ts");
    const m = between(src, 'name: "0312_user_email_verification.sql"', "],");
    expect(m).toContain("UPDATE `users` SET `email_verified_at` = `createdAt` WHERE `email_verified_at` IS NULL AND `email_verify_token_hash` IS NULL");
  });

  it("a row with no pending link is not waiting, whatever else it lacks", () => {
    expect(isEmailVerificationPending({ emailVerifiedAt: null, emailVerifyTokenHash: null })).toBe(false);
    expect(isEmailVerificationPending({ emailVerifiedAt: new Date(), emailVerifyTokenHash: "x" })).toBe(false);
    expect(isEmailVerificationPending({ emailVerifiedAt: null, emailVerifyTokenHash: "x" })).toBe(true);
  });
});

describe("the screens", () => {
  it("the banner, with Resend, is in the shell and on the no-workspace screen", () => {
    const banner = read("client/src/components/usip/EmailVerificationBanner.tsx");
    expect(banner).toContain("emailVerificationPending");
    expect(banner).toContain("trpc.accountVerification.resend.useMutation({");
    expect(read("client/src/components/usip/Shell.tsx")).toContain("<EmailVerificationBanner />");
    expect(read("client/src/components/usip/WorkspaceAccessGate.tsx")).toContain("notice={<EmailVerificationBanner compact />}");
  });

  it("/verify-email is public and confirms on a button press, not on load", () => {
    const app = read("client/src/App.tsx");
    expect(app).toContain('<Route path="/verify-email"><VerifyEmail /></Route>');
    const page = read("client/src/pages/VerifyEmail.tsx");
    expect(page).toContain("onClick={() => { setError(null); confirm.mutate({ token }); }}");
    expect(page).not.toMatch(/useEffect\([^)]*confirm\.mutate/);
  });
});

describe("F2: the sign-up policy is decided", () => {
  it("sign-up creates no workspace for a stranger, and workspace creation stays with super admins", () => {
    const seed = read("server/seed.ts");
    const may = between(seed, "export async function mayBootstrapOwnWorkspace(", "\n}\n");
    expect(may).toContain('if (user.role === "admin") return true;');
    expect(read("server/routers/workspace.ts")).toContain("if (mine.length === 0 && (await mayBootstrapOwnWorkspace(ctx.user))) {");
  });
});
