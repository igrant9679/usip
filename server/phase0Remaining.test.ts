/**
 * The rest of Phase 0 of the 2026-10-20 audit (after C1–C9, which are in
 * tenantScopeProcedures.test.ts and phase0Security.test.ts):
 *
 *   · redirectUrl XSS / open redirect on public forms and landing pages
 *   · SSRF: the ARE scraper, workflow webhooks, the integrations webhook test,
 *     the SMTP connection test
 *   · security headers, and no X-Powered-By
 *   · the Manus runtime and debug collector out of production builds
 *   · sessions that can be ended, and 2FA codes that work once
 *   · rights inside a workspace: bulk role change, login history, SCIM
 *   · one tab's workspace switch no longer retargets the others
 *   · mailbox passwords encrypted at rest
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  // A session token names its app; ENV reads this at import time, and CI sets no
  // app id, which makes every token unverifiable.
  process.env.VITE_APP_ID = process.env.VITE_APP_ID || "phase0-test-app";
  return { db: null as any, fetched: [] as string[], transports: [] as string[] };
});
vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
  // db.ts calls its own getDb internally; route the session lookup to the fake too.
  getUserByOpenId: async (openId: string) => (h.db.rowsOf("users") as any[]).find((u) => u.openId === openId),
}));
vi.mock("./audit", async (importActual) => ({
  ...(await importActual<typeof import("./audit")>()),
  recordAudit: async () => {},
}));
vi.mock("./routers/smtpConfig", async (importActual) => ({
  ...(await importActual<typeof import("./routers/smtpConfig")>()),
  buildTransporter: (o: { host: string }) => {
    h.transports.push(o.host);
    return { verify: async () => true };
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { safeRedirectUrl } from "@shared/safeRedirect";
import { assertPublicHost, safeFetch } from "./services/scraper/ssrfGuard";
import { testSmtpConnection } from "./routers/sendingAccounts";
import { scrapeWeb } from "./routers/are/scraper";
import { isEmbeddablePath, securityHeaders } from "./_core/securityHeaders";
import { sdk } from "./_core/sdk";
import { matchTotpStep } from "./services/totp";
import { decryptField, encryptField, readStoredSecret } from "./emailAdapter";
import { COOKIE_NAME } from "@shared/const";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);

const LSI = 2;
const CF = 4;

function seed() {
  rows("workspaces").push(
    { id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: 20, archivedAt: null },
    { id: CF, name: "CommunityForce", slug: "cf", ownerUserId: 10, archivedAt: null },
  );
  const user = (id: number, email: string, over: Record<string, unknown> = {}) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email, loginMethod: "password", role: "user",
    passwordHash: null, mfaTotpSecret: null, mfaTotpEnabledAt: null, sessionVersion: 0, mfaLastStep: null, ...over,
  });
  rows("users").push(
    user(20, "admin@lsi.example"), user(21, "admin2@lsi.example"), user(22, "rep@lsi.example"),
    user(23, "super@lsi.example"), user(10, "victim@cf.example"),
  );
  const member = (id: number, workspaceId: number, userId: number, role: string) => ({
    id, workspaceId, userId, role, deactivatedAt: null, inviteToken: null, lastActiveAt: new Date(), createdAt: new Date(),
  });
  rows("workspace_members").push(
    member(1, LSI, 20, "admin"), member(2, LSI, 21, "admin"), member(3, LSI, 22, "rep"),
    member(4, LSI, 23, "super_admin"), member(5, CF, 10, "super_admin"), member(6, LSI, 10, "rep"),
  );
}

function caller(userId: number, ws = LSI, cookie?: string, res: Record<string, unknown> = {}) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(ws), ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {}, ...res },
  } as unknown as TrpcContext);
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.fetched = [];
  h.transports = [];
  seed();
});

/* ─── redirectUrl ──────────────────────────────────────────────────────── */

describe("a form or landing page cannot redirect a visitor to script or another scheme", () => {
  it("safeRedirectUrl keeps web addresses and in-app paths, and nothing else", () => {
    expect(safeRedirectUrl("https://example.com/thanks?x=1")).toBe("https://example.com/thanks?x=1");
    expect(safeRedirectUrl("/thanks")).toBe("/thanks");
    for (const bad of [
      "javascript:alert(document.cookie)", " javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>1</script>",
      "vbscript:x", "//evil.example", "/\\evil.example", "https://getvelocityai.app@evil.example/", "java\tscript:alert(1)",
      "https://ex ample.com", "", null, 42,
    ]) {
      expect(safeRedirectUrl(bad), String(bad)).toBeNull();
    }
  });

  it("forms.create and forms.update refuse a javascript: redirect", async () => {
    expect((await refusal(caller(20).forms.create({ title: "T", fields: [{ key: "email", label: "Email" }], redirectUrl: "javascript:alert(1)" }))).code).toBe("BAD_REQUEST");
    rows("forms").push({ id: 7, workspaceId: LSI, publicId: "p7", title: "T", fields: [], status: "active", redirectUrl: null });
    expect((await refusal(caller(20).forms.update({ id: 7, patch: { redirectUrl: "javascript:alert(1)" } }))).code).toBe("BAD_REQUEST");
    // The patch takes named fields only — not who the leads are filed under.
    expect((await refusal(caller(20).forms.update({ id: 7, patch: { createdByUserId: 10 } as any }))).code).toBe("BAD_REQUEST");
    await caller(20).forms.update({ id: 7, patch: { redirectUrl: "https://example.com/thanks" } });
    expect(row("forms", 7).redirectUrl).toBe("https://example.com/thanks");
  });

  it("a redirect saved before the check is not served to the page", async () => {
    rows("forms").push({ id: 8, workspaceId: LSI, publicId: "p8", title: "T", fields: [], status: "active", redirectUrl: "javascript:alert(1)" });
    const form: any = await appRouter.createCaller({ user: null, req: { headers: {} }, res: {} } as any).forms.getByPublicId({ publicId: "p8" });
    expect(form.redirectUrl).toBeNull();
    const src = strip(read("server/routers/forms.ts")) + strip(read("server/routers/landingPages.ts"));
    expect(src.match(/redirectUrl: safeRedirectUrl\((form|page)\.redirectUrl\)/g)).toHaveLength(2);
  });

  it("both public pages follow only what safeRedirectUrl allows", () => {
    for (const p of ["client/src/pages/PublicForm.tsx", "client/src/pages/LandingPage.tsx"]) {
      const src = strip(read(p));
      expect(src, p).toContain("const to = safeRedirectUrl(r?.redirectUrl);");
      expect(src, p).not.toMatch(/window\.location\.href = r\.redirectUrl/);
    }
  });

  it("a form cannot auto-enrol into another workspace's sequence", async () => {
    rows("sequences").push({ id: 40, workspaceId: CF, name: "Theirs", status: "active" });
    expect((await refusal(caller(20).forms.create({ title: "T", fields: [{ key: "email", label: "Email" }], autoEnrollSequenceId: 40 }))).code).toBe("BAD_REQUEST");
  });
});

/* ─── SSRF ─────────────────────────────────────────────────────────────── */

describe("server-side requests cannot be aimed at internal addresses", () => {
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = (async (url: string) => {
      h.fetched.push(String(url));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
  });
  afterAll(() => { globalThis.fetch = realFetch; });

  const INTERNAL = [
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://127.0.0.1:3306/", "http://10.0.0.5/", "http://[::1]/", "http://localhost/",
    "http://metadata.google.internal/", "http://usip.railway.internal/", "file:///etc/passwd",
  ];

  it("safeFetch refuses internal targets for POST and HEAD too, before any request leaves", async () => {
    for (const url of INTERNAL) {
      await expect(safeFetch(url, { method: "POST", body: "{}", maxRedirects: 0 }), url).rejects.toThrow();
      await expect(safeFetch(url, { method: "HEAD", maxRedirects: 0 }), url).rejects.toThrow();
    }
    expect(h.fetched).toEqual([]);
  });

  it("control: a public address is fetched, with the method and body it was given", async () => {
    const res = await safeFetch("http://93.184.216.34/hook", { method: "POST", body: "{}", maxRedirects: 0 });
    expect(res.status).toBe(200);
    expect(h.fetched).toEqual(["http://93.184.216.34/hook"]);
  });

  it("the ARE scraper reads nothing from an internal address", async () => {
    for (const url of INTERNAL.filter((u) => u.startsWith("http"))) expect(await scrapeWeb(LSI, null, url, "icp")).toEqual([]);
    expect(h.fetched).toEqual([]);
  });

  it("the SMTP test will not connect to an internal host", async () => {
    for (const host of ["127.0.0.1", "169.254.169.254", "10.1.2.3", "localhost", "smtp.railway.internal"]) {
      const r = await testSmtpConnection({ provider: "generic_smtp", smtpHost: host, smtpPort: 25, smtpUsername: "u", smtpPassword: "p" });
      expect(r.ok, host).toBe(false);
      expect(r.error, host).toMatch(/refused/);
    }
    expect(h.transports).toEqual([]);
    await expect(assertPublicHost("93.184.216.34")).resolves.toBeUndefined();
  });

  it("the workflow webhooks, Slack, Teams and the integrations test go through the guard", () => {
    const wf = strip(read("server/services/workflowEngine.ts"));
    const action = wf.slice(wf.indexOf("async function runAction("), wf.indexOf("case \"create_task\""));
    expect(action.match(/await safeFetch\(/g)).toHaveLength(3);
    expect(action).not.toMatch(/await fetch\(/);
    const integ = strip(read("server/routers/integrations.ts"));
    expect(integ).toContain('await safeFetch(String(url), { method: "HEAD"');
    expect(integ).not.toMatch(/await fetch\(url/);
    expect(strip(read("server/routers/are/scraper.ts"))).not.toMatch(/await fetch\(/);
  });
});

/* ─── security headers, Manus runtime ──────────────────────────────────── */

describe("security headers", () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    const app = express();
    app.disable("x-powered-by");
    app.use(securityHeaders);
    app.get("*", (_req, res) => { res.send("page"); });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path, headers }, (res) => { res.resume(); resolve(res); }).on("error", reject);
    });

  it("the app cannot be framed, and says so twice", async () => {
    for (const path of ["/", "/people", "/settings", "/api/trpc/auth.me"]) {
      const res = await get(path);
      expect(res.headers["x-frame-options"], path).toBe("DENY");
      expect(res.headers["content-security-policy"], path).toContain("frame-ancestors 'none'");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(res.headers["x-powered-by"]).toBeUndefined();
    }
  });

  it("the visitor pages customers embed can be framed", async () => {
    for (const path of ["/c/acme", "/f/abc123", "/b/jane", "/l/spring-offer"]) {
      const res = await get(path);
      expect(res.headers["x-frame-options"], path).toBeUndefined();
      expect(res.headers["content-security-policy"], path).toContain("frame-ancestors *");
    }
    expect(isEmbeddablePath("/campaigns")).toBe(false);
    expect(isEmbeddablePath("/cs")).toBe(false);
  });

  it("HSTS only over HTTPS", async () => {
    expect((await get("/")).headers["strict-transport-security"]).toBeUndefined();
    expect((await get("/", { "x-forwarded-proto": "https" })).headers["strict-transport-security"]).toBe("max-age=31536000");
  });

  it("the server mounts them ahead of every route", () => {
    const src = strip(read("server/_core/index.ts"));
    const at = src.indexOf("app.use(securityHeaders)");
    expect(src).toContain('app.disable("x-powered-by")');
    expect(at).toBeGreaterThan(-1);
    for (const route of ["registerHealthRoute(app)", "registerOAuthRoutes(app)", "createExpressMiddleware("]) {
      expect(src.indexOf(route), route).toBeGreaterThan(at);
    }
  });
});

describe("the Manus runtime and debug collector stay out of production", () => {
  it("vite build gets neither plugin; the dev server gets both", async () => {
    const mod: any = await import("../vite.config");
    const make = mod.default as (env: { command: string; mode: string }) => { plugins: any[] };
    const names = (env: { command: string; mode: string }) =>
      make(env).plugins.flat(Infinity).filter(Boolean).map((p: any) => p.name as string);
    const build = names({ command: "build", mode: "production" });
    expect(build.filter((n) => /manus/i.test(n))).toEqual([]);
    expect(names({ command: "serve", mode: "development" }).filter((n) => /manus/i.test(n)).length).toBe(2);
  });

  it("the collector script is no longer in the public folder that every build copies", () => {
    expect(existsSync(join(ROOT, "client/public/__manus__/debug-collector.js"))).toBe(false);
    expect(existsSync(join(ROOT, "client/dev/__manus__/debug-collector.js"))).toBe(true);
  });
});

/* ─── sessions ─────────────────────────────────────────────────────────── */

describe("sessions can be ended", () => {
  const authOf = (token: string) => sdk.authenticateRequest({ headers: { cookie: `${COOKIE_NAME}=${token}` } } as any);

  it("a token carries the account's session version and its own id", async () => {
    const token = await sdk.createSessionToken("local:22", { name: "Rep", sessionVersion: 3 });
    const s = await sdk.verifySession(token);
    expect(s).toMatchObject({ openId: "local:22", sessionVersion: 3 });
    expect(s?.jti).toMatch(/^[\w-]{21}$/);
  });

  it("an account with no name can still hold a session", async () => {
    const token = await sdk.createSessionToken("local:22", { name: "" });
    expect(await sdk.verifySession(token)).not.toBeNull();
  });

  it("bumping the version ends every older token", async () => {
    const token = await sdk.createSessionToken("local:22", { name: "Rep", sessionVersion: 0 });
    expect((await authOf(token)).id).toBe(22);
    row("users", 22).sessionVersion = 1;
    await expect(authOf(token)).rejects.toThrow(/signed out/);
  });

  it("logout ends this token, and only this one", async () => {
    const mine = await sdk.createSessionToken("local:22", { name: "Rep" });
    const other = await sdk.createSessionToken("local:22", { name: "Rep" });
    await caller(22, LSI, `${COOKIE_NAME}=${mine}`).auth.logout();
    await expect(authOf(mine)).rejects.toThrow(/signed out/);
    expect((await authOf(other)).id, "another device stays signed in").toBe(22);
  });

  it("logging out with a token from before jtis ends the account's sessions", async () => {
    const { SignJWT } = await import("jose");
    const legacy = await new SignJWT({ openId: "local:22", appId: process.env.VITE_APP_ID!, name: "Rep" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET!));
    expect((await sdk.verifySession(legacy))?.jti).toBeUndefined();
    await caller(22, LSI, `${COOKIE_NAME}=${legacy}`).auth.logout();
    expect(row("users", 22).sessionVersion).toBe(1);
  });

  it("changing your own password ends your other sessions and re-issues this one", async () => {
    const cookies: string[] = [];
    await caller(22, LSI, undefined, { cookie: (_n: string, v: string) => cookies.push(v) }).profile.changeMyPassword({ newPassword: "a-brand-new-pass" });
    expect(row("users", 22).sessionVersion).toBe(1);
    expect(cookies).toHaveLength(1);
    expect((await sdk.verifySession(cookies[0]))?.sessionVersion).toBe(1);
  });

  it("an admin's password or 2FA reset ends the member's sessions", async () => {
    await caller(20).team.setMemberPassword({ memberId: 3, password: "admin-set-pass" });
    expect(row("users", 22).sessionVersion).toBe(1);
    row("users", 22).mfaTotpSecret = "JBSWY3DPEHPK3PXP";
    await caller(20).team.resetMemberMfa({ memberId: 3 });
    expect(row("users", 22).sessionVersion).toBe(2);
  });

  it("every path that resets or changes a password or second factor bumps the version", () => {
    const pa = strip(read("server/passwordAuth.ts"));
    const reset = pa.slice(pa.indexOf('"/api/auth/reset-password"'), pa.indexOf('"/api/auth/password-login"'));
    expect(reset).toContain("sessionVersion: sql`${users.sessionVersion} + 1`");
    const profile = strip(read("server/routers/profile.ts"));
    expect(profile.match(/await revokeAllSessions\(db, ctx\.user\.id\);\n\s+await reissueSessionCookie\(db, ctx\.req, ctx\.res, ctx\.user\.id\);/g)).toHaveLength(3);
  });
});

describe("a 2FA code works once", () => {
  const SECRET = "JBSWY3DPEHPK3PXP";
  it("matchTotpStep names the step a code belongs to", () => {
    const now = Date.UTC(2026, 9, 24, 12, 0, 0);
    expect(matchTotpStep(SECRET, "000000", 1, now)).toBeNull();
  });

  it("a code accepted once is refused the second time", async () => {
    const crypto = await import("node:crypto");
    const { base32Decode } = await import("./services/totp");
    const step = Math.floor(Date.now() / 1000 / 30);
    const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
    const hm = crypto.createHmac("sha1", base32Decode(SECRET)).update(msg).digest();
    const o = hm[hm.length - 1] & 0x0f;
    const code = String(((((hm[o] & 0x7f) << 24) | (hm[o + 1] << 16) | (hm[o + 2] << 8) | hm[o + 3]) % 1_000_000)).padStart(6, "0");
    row("users", 22).mfaTotpSecret = SECRET;
    await caller(22).profile.confirmTotpEnrollment({ code });
    expect(row("users", 22).mfaLastStep).toBe(step);
    row("users", 22).mfaTotpEnabledAt = null;
    expect((await refusal(caller(22).profile.confirmTotpEnrollment({ code }))).code, "the same code again").toBe("FORBIDDEN");
    const login = strip(read("server/passwordAuth.ts"));
    expect(login).toContain("if (step === null || !(await useTotpStep(db, user.id, step))) {");
  });
});

/* ─── rights inside a workspace ────────────────────────────────────────── */

describe("bulk role change follows the single change's rules", () => {
  it("an admin cannot demote a fellow admin in bulk", async () => {
    expect((await refusal(caller(20).team.bulkChangeRole({ memberIds: [2, 3], role: "rep" }))).code).toBe("FORBIDDEN");
    expect(row("workspace_members", 2).role).toBe("admin");
    expect(row("workspace_members", 3).role).toBe("rep");
  });

  it("the last super_admin cannot be demoted in bulk", async () => {
    expect((await refusal(caller(23).team.bulkChangeRole({ memberIds: [4], role: "admin" }))).code).toBe("BAD_REQUEST");
    expect(row("workspace_members", 4).role).toBe("super_admin");
  });

  it("another workspace's member is not found", async () => {
    expect((await refusal(caller(23).team.bulkChangeRole({ memberIds: [5], role: "rep" }))).code).toBe("NOT_FOUND");
    expect(row("workspace_members", 5).role).toBe("super_admin");
  });

  it("control: an admin can still move reps", async () => {
    await caller(20).team.bulkChangeRole({ memberIds: [3], role: "manager" });
    expect(row("workspace_members", 3).role).toBe("manager");
  });
});

describe("the Team page shows only this workspace's sign-ins", () => {
  it("a member's sign-ins elsewhere are not listed", async () => {
    rows("login_history").push(
      { id: 1, userId: 10, workspaceId: CF, ipAddress: "198.51.100.7", outcome: "success", createdAt: new Date() },
      { id: 2, userId: 10, workspaceId: LSI, ipAddress: "203.0.113.4", outcome: "success", createdAt: new Date() },
      { id: 3, userId: 10, workspaceId: null, ipAddress: "192.0.2.1", outcome: "success", createdAt: new Date() },
    );
    const list: any[] = await caller(20).team.getLoginHistory({ memberId: 6 });
    expect(list.map((r) => r.id)).toEqual([2]);
    const filtered: any[] = await caller(20).team.getLoginHistoryFiltered({ memberId: 6 });
    expect(filtered.map((r) => r.id)).toEqual([2]);
  });

  it("control: an account that lives only here shows its unattributed sign-ins too", async () => {
    rows("login_history").push(
      { id: 4, userId: 22, workspaceId: LSI, outcome: "success", createdAt: new Date() },
      { id: 5, userId: 22, workspaceId: null, outcome: "success", createdAt: new Date() },
    );
    const list: any[] = await caller(20).team.getLoginHistory({ memberId: 3 });
    expect(list.map((r) => r.id).sort()).toEqual([4, 5]);
  });
});

describe("SCIM sees only its own workspace's people", () => {
  type Handler = (req: any, res: any) => Promise<void> | void;
  const routes: Record<string, Handler> = {};
  beforeAll(async () => {
    const { registerScimRoutes } = await import("./scimHttp");
    const app: any = {
      use: () => {},
      get: (p: string, f: Handler) => { routes[`GET ${p}`] = f; },
      post: (p: string, f: Handler) => { routes[`POST ${p}`] = f; },
      put: (p: string, f: Handler) => { routes[`PUT ${p}`] = f; },
      patch: (p: string, f: Handler) => { routes[`PATCH ${p}`] = f; },
      delete: (p: string, f: Handler) => { routes[`DELETE ${p}`] = f; },
    };
    registerScimRoutes(app);
  });
  const call = async (key: string, params: Record<string, string> = {}, body: unknown = {}) => {
    const res: any = { statusCode: 200, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; }, end() { return this; } };
    await routes[key]({ params, body, scimProvider: { id: 1, workspaceId: LSI } }, res);
    return res;
  };

  it("a user of another workspace is not found by id, for read or replace", async () => {
    rows("users").push({ id: 50, openId: "local:50", email: "only-cf@cf.example", name: "Only CF" });
    rows("workspace_members").push({ id: 50, workspaceId: CF, userId: 50, role: "rep", inviteToken: null, deactivatedAt: null });
    expect((await call("GET /api/scim/v2/Users/:id", { id: "50" })).statusCode).toBe(404);
    expect((await call("PUT /api/scim/v2/Users/:id", { id: "50" }, { displayName: "x" })).statusCode).toBe(404);
    const own = await call("GET /api/scim/v2/Users/:id", { id: "22" });
    expect(own.body.userName).toBe("rep@lsi.example");
  });

  it("provisioning an account that lives elsewhere makes a pending invitation, not a member", async () => {
    rows("users").push({ id: 51, openId: "local:51", email: "elsewhere@cf.example", name: "Elsewhere" });
    rows("workspace_members").push({ id: 51, workspaceId: CF, userId: 51, role: "rep", inviteToken: null, deactivatedAt: null });
    await call("POST /api/scim/v2/Users", {}, { userName: "elsewhere@cf.example" });
    const m = rows("workspace_members").find((r) => r.workspaceId === LSI && r.userId === 51);
    expect(m.inviteToken).toMatch(/^[0-9a-f]{64}$/);
    await call("POST /api/scim/v2/Users", {}, { userName: "brand-new@lsi.example" });
    const created = rows("users").find((u) => u.email === "brand-new@lsi.example");
    expect(rows("workspace_members").find((r) => r.userId === created.id).inviteToken ?? null, "an account SCIM created is its own").toBeNull();
  });
});

/* ─── one tab, one workspace ───────────────────────────────────────────── */

describe("switching workspace in one tab does not retarget the others", () => {
  it("every request reads this tab's workspace, never the shared localStorage value", () => {
    const helper = strip(read("client/src/lib/activeWorkspace.ts"));
    expect(helper).toContain("window.sessionStorage.getItem(KEY)");
    for (const f of [
      "client/src/main.tsx", "client/src/components/usip/RecordDrawer.tsx", "client/src/hooks/useStreamLLM.ts",
      "client/src/pages/usip/EmailBuilder.tsx", "client/src/pages/usip/Mailbox.tsx", "client/src/pages/usip/ProposalDetail.tsx",
      "client/src/contexts/WorkspaceContext.tsx",
    ]) {
      const src = strip(read(f));
      expect(src, f).not.toContain('localStorage.getItem("usip:workspaceId")');
      expect(src, f).toMatch(/getActiveWorkspaceId\(\)/);
    }
  });

  it("each tab keeps its own id once it has one", async () => {
    const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
    const shared = store();
    const tabA = { localStorage: shared, sessionStorage: store() };
    const tabB = { localStorage: shared, sessionStorage: store() };
    const mod = await import("../client/src/lib/activeWorkspace");
    const as = <T>(w: unknown, f: () => T) => { (globalThis as any).window = w; try { return f(); } finally { delete (globalThis as any).window; } };
    as(tabA, () => mod.setActiveWorkspaceId(2));
    expect(as(tabB, () => mod.getActiveWorkspaceId()), "a new tab opens where you last were").toBe("2");
    as(tabA, () => mod.setActiveWorkspaceId(4));
    expect(as(tabB, () => mod.getActiveWorkspaceId()), "…and stays there when another tab switches").toBe("2");
    expect(as(tabA, () => mod.getActiveWorkspaceId())).toBe("4");
  });
});

/* ─── mailbox passwords at rest ────────────────────────────────────────── */

describe("mailbox passwords are encrypted at rest", () => {
  it("create and update store ciphertext; readers get the password back", async () => {
    const { id } = await caller(20).sendingAccounts.create({ name: "M", provider: "generic_smtp", fromEmail: "m@lsi.example", smtpPassword: "smtp-plain-1", imapPassword: "imap-plain-1" } as any);
    const stored = row("sending_accounts", id);
    expect(stored.smtpPassword).not.toContain("smtp-plain-1");
    expect(decryptField(stored.smtpPassword)).toBe("smtp-plain-1");
    expect(decryptField(stored.imapPassword)).toBe("imap-plain-1");
    await caller(20).sendingAccounts.update({ id, smtpPassword: "smtp-plain-2", imapPassword: "imap-plain-2" } as any);
    // decryptField, not readStoredSecret: the reader tolerates plaintext, so it
    // would pass an update that forgot to encrypt.
    expect(row("sending_accounts", id).smtpPassword).not.toContain("smtp-plain-2");
    expect(decryptField(row("sending_accounts", id).smtpPassword)).toBe("smtp-plain-2");
    expect(decryptField(row("sending_accounts", id).imapPassword)).toBe("imap-plain-2");
    await caller(20).sendingAccounts.bulkCreateSmtp({ rows: [{ fromEmail: "b@lsi.example", smtpPassword: "bulk-plain" }] });
    const bulk = rows("sending_accounts").find((r) => r.fromEmail === "b@lsi.example");
    expect(bulk.smtpPassword).not.toContain("bulk-plain");
  });

  it("a password saved before encryption still reads", () => {
    expect(readStoredSecret("legacy-plaintext")).toBe("legacy-plaintext");
    expect(readStoredSecret(encryptField("x:y:z"))).toBe("x:y:z");
    expect(readStoredSecret(null)).toBeNull();
  });

  it("every reader goes through readStoredSecret", () => {
    expect(strip(read("server/services/warmupEngine.ts"))).toContain("password: readStoredSecret(acct.smtpPassword)");
    const sa = strip(read("server/routers/sendingAccounts.ts"));
    expect(sa).toContain("smtpPassword: readStoredSecret(account.smtpPassword),");
    expect(sa).toContain("smtpPassword = readStoredSecret(existing.smtpPassword) ?? undefined;");
  });
});
