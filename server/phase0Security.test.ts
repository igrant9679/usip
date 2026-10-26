/**
 * Phase 0 of the 2026-10-20 audit, the parts that are not "another workspace's
 * id" (those are in tenantScopeProcedures.test.ts):
 *
 *   · C2 — /api/auth/register takes over no existing account.
 *   · C1, the sign-in half — a password sign-in no longer accepts every pending
 *     invitation on the account.
 *   · C3 — cross-site request forgery: SameSite=Lax, JSON-only /api/trpc, and
 *     an Origin check on cookie-carrying writes, through a REAL express server.
 *   · Also urgent — auth.me and settings.get return no secrets, and the rate
 *     limiters key on the address the proxy saw, not on a header the caller
 *     writes.
 *
 * The audit's Phase 0 gate names three of these outright: "a test proves
 * auth.me, settings.get and sendingAccounts.* return no secret fields", "a test
 * proves /api/trpc refuses form-encoded posts", and "sign-up and invite can no
 * longer reach an existing account".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import express from "express";
import { initTRPC } from "@trpc/server";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { getTableColumns } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, sent: [] as { to: string }[] }));
vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));
vi.mock("./audit", async (importActual) => ({
  ...(await importActual<typeof import("./audit")>()),
  recordAudit: async () => {},
}));
vi.mock("./emailDelivery", async (importActual) => ({
  ...(await importActual<typeof import("./emailDelivery")>()),
  sendSystemEmail: async (_ws: number, msg: { to: string }) => {
    h.sent.push(msg);
    return { ok: true };
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { pickResetSenderWorkspace, registerPasswordAuthRoutes } from "./passwordAuth";
import { getSessionCookieOptions } from "./_core/cookies";
import { crossSiteCookieWriteGuard, trpcCsrfGuard } from "./_core/csrf";
import { clientIpOf, configureTrustProxy, rateLimitKey, trustProxySetting } from "./_core/clientIp";
import {
  PUBLIC_USER_FIELDS,
  SENDING_ACCOUNT_SECRET_FIELDS,
  SETTINGS_ADMIN_ONLY_FIELDS,
  SETTINGS_SECRET_FIELDS,
} from "./_core/safeProjections";
import { sendingAccounts, users, workspaceSettings } from "../drizzle/schema";
import { COOKIE_NAME } from "@shared/const";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);

const TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);
const FUTURE = () => new Date(Date.now() + 7 * 86_400_000);

/* ─── a tiny harness for the express routes in passwordAuth.ts ─────────── */

type Handler = (req: any, res: any) => Promise<void> | void;
function authRoutes(): Record<string, Handler> {
  const routes: Record<string, Handler> = {};
  const app = {
    post: (path: string, ...fns: Handler[]) => { routes[path] = fns[fns.length - 1]; },
    get: () => {},
  };
  registerPasswordAuthRoutes(app as any);
  return routes;
}
async function post(path: string, body: Record<string, unknown>) {
  const res: any = {
    statusCode: 200, body: undefined, cookies: [] as unknown[],
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    cookie(name: string, value: string, opts: unknown) { this.cookies.push({ name, value, opts }); },
    redirect(c: number, url: string) { this.statusCode = c; this.body = { redirect: url }; },
  };
  const req = { body, headers: { accept: "application/json" }, protocol: "https", ip: "203.0.113.9", socket: { remoteAddress: "10.0.0.1" } };
  await authRoutes()[path](req, res);
  return res;
}

function seedPeople() {
  h.db.rowsOf("workspaces").push({ id: 2, name: "LSI Media", slug: "lsi", ownerUserId: 20 }, { id: 4, name: "CommunityForce", slug: "cf", ownerUserId: 10 });
  const member = (id: number, workspaceId: number, userId: number, over: Record<string, unknown> = {}) => ({
    id, workspaceId, userId, role: "rep", deactivatedAt: null, inviteToken: null, inviteExpiresAt: null, createdAt: new Date(), ...over,
  });
  h.db.rowsOf("users").push(
    // Real account, password and all.
    { id: 10, openId: "local:10", email: "victim@cf.example", name: "Victim", loginMethod: "password", passwordHash: bcrypt.hashSync("victim-pass-1", 4) },
    // Password-less, but a real person: provisioned by SCIM, or OAuth-only from before native auth.
    { id: 12, openId: "scim:12", email: "scim@cf.example", name: "Scim", loginMethod: "scim", passwordHash: null },
    { id: 13, openId: "oauth-13", email: "oauth@cf.example", name: "OAuth", loginMethod: "oauth", passwordHash: null },
    // Invite placeholders.
    { id: 60, openId: "invite:new@lsi.example", email: "new@lsi.example", name: "New", loginMethod: "invite", passwordHash: null },
    { id: 70, openId: "invite:two@lsi.example", email: "two@lsi.example", name: "Two", loginMethod: "invite", passwordHash: null },
  );
  h.db.rowsOf("workspace_members").push(
    member(1, 4, 10, { role: "super_admin" }),
    // LSI Media's admin invited the victim — and so holds this token.
    member(2, 2, 10, { inviteToken: OTHER_TOKEN, inviteExpiresAt: FUTURE() }),
    member(3, 4, 12),
    member(4, 2, 13, { inviteToken: TOKEN.replace(/a/g, "c"), inviteExpiresAt: FUTURE() }),
    member(5, 2, 60, { inviteToken: TOKEN, inviteExpiresAt: FUTURE() }),
    // Invited by two workspaces: neither admin's token may choose the password.
    member(6, 2, 70, { inviteToken: TOKEN.replace(/a/g, "d"), inviteExpiresAt: FUTURE() }),
    member(7, 4, 70, { inviteToken: TOKEN.replace(/a/g, "e"), inviteExpiresAt: FUTURE() }),
  );
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.sent = [];
  seedPeople();
});

/* ─── C2 ───────────────────────────────────────────────────────────────── */

describe("C2: /api/auth/register creates new accounts only", () => {
  it("refuses every password-less account that is a real person's, token or no token", async () => {
    for (const [email, token, id] of [
      ["scim@cf.example", undefined, 12],
      ["oauth@cf.example", undefined, 13],
      // The attack: invite an OAuth user, read the token off copyInviteLink, register.
      ["oauth@cf.example", TOKEN.replace(/a/g, "c"), 13],
    ] as const) {
      const res = await post("/api/auth/register", { email, password: "attacker-pass-1", inviteToken: token });
      expect(res.statusCode, email).toBe(409);
      expect(res.cookies, "no session").toEqual([]);
      expect(row("users", id).passwordHash).toBeNull();
    }
    expect(row("workspace_members", 4).inviteToken, "and no invite token was spent").toBe(TOKEN.replace(/a/g, "c"));
  });

  it("refuses an account with a password, even with an invite token for it", async () => {
    const res = await post("/api/auth/register", { email: "victim@cf.example", password: "attacker-pass-1", inviteToken: OTHER_TOKEN });
    expect(res.statusCode).toBe(409);
    expect(bcrypt.compareSync("victim-pass-1", row("users", 10).passwordHash)).toBe(true);
    expect(row("workspace_members", 2).inviteToken).toBe(OTHER_TOKEN);
  });

  it("refuses an invite placeholder without its token, or with the wrong one", async () => {
    for (const inviteToken of [undefined, OTHER_TOKEN, "short"]) {
      const res = await post("/api/auth/register", { email: "new@lsi.example", password: "attacker-pass-1", inviteToken });
      expect(res.statusCode).toBe(409);
      expect(res.body.error).toMatch(/invitation link/);
    }
    expect(row("users", 60).passwordHash).toBeNull();
  });

  it("refuses a placeholder that a second workspace has also invited", async () => {
    const res = await post("/api/auth/register", { email: "two@lsi.example", password: "attacker-pass-1", inviteToken: TOKEN.replace(/a/g, "d") });
    expect(res.statusCode).toBe(409);
    expect(row("users", 70).passwordHash).toBeNull();
    expect(rows("workspace_members").filter((m) => m.userId === 70 && m.inviteToken)).toHaveLength(2);
  });

  it("refuses an expired invitation", async () => {
    row("workspace_members", 5).inviteExpiresAt = new Date(Date.now() - 1000);
    expect((await post("/api/auth/register", { email: "new@lsi.example", password: "new-pass-1", inviteToken: TOKEN })).statusCode).toBe(409);
  });

  it("control: the invitee claims their own placeholder with its token — and only that invite is accepted", async () => {
    const res = await post("/api/auth/register", { email: "new@lsi.example", password: "new-pass-1", inviteToken: TOKEN, returnPath: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.cookies).toHaveLength(1);
    expect(bcrypt.compareSync("new-pass-1", row("users", 60).passwordHash)).toBe(true);
    expect(row("workspace_members", 5).inviteToken).toBeNull();
    expect(row("workspace_members", 2).inviteToken, "nobody else's invite moved").toBe(OTHER_TOKEN);
  });

  it("control: a brand-new email still signs up", async () => {
    const res = await post("/api/auth/register", { email: "fresh@example.com", password: "fresh-pass-1" });
    expect(res.statusCode).toBe(200);
    const created = rows("users").find((u) => u.email === "fresh@example.com");
    expect(created.openId).toMatch(/^local:/);
  });
});

/* ─── C1, the sign-in half ─────────────────────────────────────────────── */

describe("C1: signing in does not accept invitations", () => {
  it("a password sign-in leaves the pending invite from another workspace pending", async () => {
    const res = await post("/api/auth/password-login", { email: "victim@cf.example", password: "victim-pass-1" });
    expect(res.statusCode).toBe(200);
    expect(row("workspace_members", 2).inviteToken, "accepted only with its own token, on the invite page").toBe(OTHER_TOKEN);
  });

  it("the workspace switcher lists accepted memberships only", () => {
    const fn = strip(read("server/db.ts"));
    const at = fn.indexOf("export async function getUserWorkspaces(");
    const body = fn.slice(at, fn.indexOf("\n}", at));
    expect(body).toMatch(/isNull\(workspaceMembers\.inviteToken\)/);
    expect(body).toMatch(/isNull\(workspaceMembers\.deactivatedAt\)/);
  });
});

/* ─── C1: the reset link, which is what an admin sends instead ────────── */

describe("C1: a reset link travels only through a workspace the person belongs to, and is never logged", () => {
  const m = (workspaceId: number, over: Partial<{ role: string; inviteToken: string | null; deactivatedAt: Date | null; createdAt: Date | null; ownerUserId: number | null }> = {}) => ({
    workspaceId, role: "rep", inviteToken: null, deactivatedAt: null, createdAt: new Date("2026-01-01"), ownerUserId: 99, ...over,
  });

  it("never picks a workspace that only invited them", () => {
    // Invited by workspace 2 (newer, admin role offered), a rep in their own workspace 4.
    const pick = pickResetSenderWorkspace(10, [m(2, { role: "admin", inviteToken: "t", createdAt: new Date("2026-10-01") }), m(4)]);
    expect(pick?.workspaceId).toBe(4);
  });

  it("prefers the workspace they own, then their highest role, then the oldest", () => {
    expect(pickResetSenderWorkspace(10, [m(2, { role: "super_admin" }), m(4, { ownerUserId: 10 })])?.workspaceId).toBe(4);
    expect(pickResetSenderWorkspace(10, [m(2), m(4, { role: "admin" })])?.workspaceId).toBe(4);
    expect(pickResetSenderWorkspace(10, [m(4, { createdAt: new Date("2026-05-01") }), m(2, { createdAt: new Date("2026-02-01") })])?.workspaceId).toBe(2);
  });

  it("skips deactivated memberships, and sends nothing for a leaver with no live membership", () => {
    expect(pickResetSenderWorkspace(10, [m(2, { deactivatedAt: new Date() }), m(4)])?.workspaceId).toBe(4);
    expect(pickResetSenderWorkspace(10, [m(2, { deactivatedAt: new Date() })])).toBeNull();
  });

  it("an unclaimed invite placeholder falls back to the workspace that invited it first", () => {
    expect(pickResetSenderWorkspace(60, [m(4, { inviteToken: "b", createdAt: new Date("2026-06-01") }), m(2, { inviteToken: "a", createdAt: new Date("2026-03-01") })])?.workspaceId).toBe(2);
  });

  it("forgot-password for the invited victim goes out through their own workspace, with the link kept out of the log", async () => {
    await post("/api/auth/forgot-password", { email: "victim@cf.example" });
    expect(h.sent).toHaveLength(1);
    expect((h.sent[0] as any).logPreview).toMatch(/link withheld/);
  });

  it("both email-log writers honour logPreview", () => {
    const adapter = strip(read("server/emailAdapter.ts"));
    expect(adapter).toContain("bodyHtml: input.logPreview != null ? null : decorated.bodyHtml,");
    expect(adapter).toContain("bodyText: input.logPreview ?? decorated.bodyText,");
    const delivery = strip(read("server/emailDelivery.ts"));
    expect(delivery.match(/bodyHtml: opts\.logPreview != null \? null : opts\.html,/g)).toHaveLength(2);
    expect(delivery).toContain("logPreview: opts.logPreview,");
  });

  it("someone with only an unaccepted invitation still gets a workspace of their own", () => {
    const seed = strip(read("server/seed.ts"));
    const fn = seed.slice(seed.indexOf("export async function ensureUserHasWorkspace"));
    const guard = fn.slice(0, fn.indexOf("const slug"));
    expect(guard).toMatch(/isNull\(workspaceMembers\.inviteToken\)/);
    expect(guard, "deactivated memberships must still count (deactivationRevokesAccess)").not.toMatch(/deactivatedAt/);
  });
});

/* ─── C3 ───────────────────────────────────────────────────────────────── */

describe("C3: cross-site request forgery", () => {
  it("the session cookie is SameSite=Lax", () => {
    expect(getSessionCookieOptions({ protocol: "https", headers: {} } as any).sameSite).toBe("lax");
  });

  const t = initTRPC.create();
  let ran = 0;
  const probeRouter = t.router({
    archiveEverything: t.procedure.mutation(() => { ran++; return "ran"; }),
    read: t.procedure.query(() => "read"),
  });
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    const app = express();
    configureTrustProxy(app);
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(crossSiteCookieWriteGuard);
    app.post("/api/llm/stream", (_req, res) => { res.json({ streamed: true }); });
    app.use("/api/trpc", trpcCsrfGuard);
    app.use("/api/trpc", createExpressMiddleware({ router: probeRouter, createContext: () => ({}) }));
    app.get("/ip", (req, res) => { res.json({ ip: clientIpOf(req), key: rateLimitKey(req) }); });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => { ran = 0; });

  function send(method: string, path: string, headers: Record<string, string>, body = ""): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path, headers: { ...headers, "content-length": Buffer.byteLength(body) } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }
  const session = `${COOKIE_NAME}=signed-in-user`;

  it("refuses a form-encoded or multipart post to /api/trpc — the forgery a hostile page can send", async () => {
    const boundary = "----x";
    const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\n1\r\n--${boundary}--\r\n`;
    for (const [type, body] of [
      [`multipart/form-data; boundary=${boundary}`, multipart],
      ["application/x-www-form-urlencoded", "x=1"],
      ["text/plain", "{}"],
    ]) {
      // The forgery as a browser sends it: cookie attached, Origin the attacker's.
      // The cookie guard turns it away first (403); either refusal will do.
      const r = await send("POST", "/api/trpc/archiveEverything", { "content-type": type, cookie: session, origin: "https://evil.example" }, body);
      expect([403, 415], type).toContain(r.status);
      // The tRPC guard on its own: the content type alone is refused, whatever
      // the Origin says and whether or not a cookie came along.
      for (const headers of [{ cookie: session }, { origin: "https://evil.example" }, {}]) {
        const alone = await send("POST", "/api/trpc/archiveEverything", { "content-type": type, ...headers }, body);
        expect(alone.status, `${type} ${JSON.stringify(headers)}`).toBe(415);
      }
    }
    expect(ran, "the mutation never ran").toBe(0);
  });

  it("refuses a JSON post from another origin", async () => {
    const r = await send("POST", "/api/trpc/archiveEverything", { "content-type": "application/json", cookie: session, origin: "https://evil.example" }, "{}");
    expect(r.status).toBe(403);
    const sub = await send("POST", "/api/trpc/archiveEverything", { "content-type": "application/json", cookie: session, origin: "https://evil.getvelocityai.app" }, "{}");
    expect(sub.status, "a sibling subdomain is same-SITE, so Lax alone would let it through").toBe(403);
    expect((await send("POST", "/api/trpc/archiveEverything", { "content-type": "application/json", origin: "null" }, "{}")).status).toBe(403);
    expect(ran).toBe(0);
  });

  it("control: the app's own JSON call runs, with or without an Origin header", async () => {
    expect((await send("POST", "/api/trpc/archiveEverything", { "content-type": "application/json", cookie: session, origin: `http://127.0.0.1:${port}` }, "{}")).status).toBe(200);
    expect((await send("POST", "/api/trpc/archiveEverything", { "content-type": "application/json" }, "{}")).status).toBe(200);
    expect((await send("GET", "/api/trpc/read", { origin: "https://evil.example" })).status, "reads are not writes").toBe(200);
    expect(ran).toBe(2);
  });

  it("a cookie-carrying write to any other route must come from this origin; a cookieless one (webhooks) is not its business", async () => {
    expect((await send("POST", "/api/llm/stream", { "content-type": "text/plain", cookie: session, origin: "https://evil.example" }, "x")).status).toBe(403);
    expect((await send("POST", "/api/llm/stream", { "content-type": "text/plain", origin: "https://evil.example" }, "x")).status).toBe(200);
    expect((await send("POST", "/api/llm/stream", { "content-type": "application/json", cookie: session, origin: `http://127.0.0.1:${port}` }, "{}")).status).toBe(200);
  });

  it("the guards are mounted ahead of what they guard", () => {
    const src = strip(read("server/_core/index.ts"));
    const cookieGuard = src.indexOf("app.use(crossSiteCookieWriteGuard)");
    const trpcGuard = src.indexOf('app.use("/api/trpc", trpcCsrfGuard)');
    const adapter = src.indexOf("createExpressMiddleware(");
    expect(cookieGuard).toBeGreaterThan(-1);
    expect(trpcGuard).toBeGreaterThan(-1);
    expect(trpcGuard).toBeLessThan(adapter);
    for (const route of ["registerPasswordAuthRoutes(app)", "registerLLMStreamRoutes(app)", "registerMailboxStreamRoutes(app)", "registerStorageProxy(app)"]) {
      expect(src.indexOf(route), route).toBeGreaterThan(cookieGuard);
    }
    expect(src.indexOf("configureTrustProxy(app)")).toBeLessThan(cookieGuard);
  });

  /* ─── Also urgent: the rate-limit key ──────────────────────────────── */

  it("the rate-limit key is the address the proxy saw — rotating X-Forwarded-For does not change it", async () => {
    const a = JSON.parse((await send("GET", "/ip", { "x-forwarded-for": "6.6.6.6, 203.0.113.9" })).body);
    const b = JSON.parse((await send("GET", "/ip", { "x-forwarded-for": "7.7.7.7, 203.0.113.9" })).body);
    expect(a.ip).toBe("203.0.113.9");
    expect(b.key).toBe(a.key);
    const direct = JSON.parse((await send("GET", "/ip", {})).body);
    expect(direct.ip).toBe("127.0.0.1");
  });
});

describe("Also urgent: rate limits trust one proxy hop, and nothing else reads the header", () => {
  it("TRUST_PROXY defaults to one hop and never to 'trust everything'", () => {
    expect(trustProxySetting(undefined)).toBe(1);
    expect(trustProxySetting("")).toBe(1);
    expect(trustProxySetting("2")).toBe(2);
    expect(trustProxySetting("true")).toBe(1);
    expect(trustProxySetting("false")).toBe(false);
    expect(trustProxySetting("10.0.0.0/8")).toBe("10.0.0.0/8");
  });

  it("never yields an empty key", () => {
    expect(clientIpOf({ ip: "   ", socket: { remoteAddress: "" } })).toBe("unknown");
    expect(clientIpOf(undefined)).toBe("unknown");
  });

  it("no server code takes an address from X-Forwarded-For itself", () => {
    const offenders: string[] = [];
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "__fakes__") walk(p); continue; }
        if (!/\.ts$/.test(e.name) || /\.(test|spec)\.ts$/.test(e.name)) continue;
        if (/headers\[\s*["']x-forwarded-for["']\s*\]/i.test(strip(read(p)))) offenders.push(p);
      }
    };
    walk("server");
    expect(offenders).toEqual([]);
  });

  it("every limiter in the auth and public paths keys on rateLimitKey", () => {
    for (const f of ["server/passwordAuth.ts", "server/publicRateLimit.ts"]) {
      const src = strip(read(f));
      const limiters = src.match(/rateLimit\(\{[\s\S]*?\n\}\);/g) ?? [];
      expect(limiters.length, f).toBeGreaterThanOrEqual(3);
      for (const l of limiters) expect(l, f).toMatch(/keyGenerator: (rateLimitKey|ipKey),/);
      if (/keyGenerator: ipKey/.test(src)) expect(src).toMatch(/const ipKey = \(req: Request\) => rateLimitKey\(req\);/);
    }
  });
});

/* ─── Also urgent: no secrets to the browser ───────────────────────────── */

function caller(user: Record<string, unknown> | null, ws = 2) {
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

describe("auth.me, settings.get and sendingAccounts.* return no secret fields", () => {
  it("auth.me returns the safe fields only", async () => {
    const me: any = await caller({
      id: 10, openId: "local:10", email: "victim@cf.example", name: "Victim", loginMethod: "password", role: "user",
      passwordHash: "$2b$12$secret", mfaTotpSecret: "TOTPSECRET", mfaTotpEnabledAt: new Date(),
      passwordResetTokenHash: "f".repeat(64), passwordResetExpiresAt: new Date(),
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    }).auth.me();
    for (const k of ["passwordHash", "mfaTotpSecret", "passwordResetTokenHash", "passwordResetExpiresAt"]) expect(me).not.toHaveProperty(k);
    expect(JSON.stringify(me)).not.toMatch(/TOTPSECRET|\$2b\$/);
    expect(me).toMatchObject({ id: 10, email: "victim@cf.example", hasPassword: true });
    expect(me.mfaTotpEnabledAt).toBeInstanceOf(Date);
    expect(await caller(null).auth.me()).toBeNull();
  });

  function seedSettings() {
    rows("workspace_members").push({ id: 50, workspaceId: 2, userId: 21, role: "rep", deactivatedAt: null, inviteToken: null });
    rows("workspace_members").push({ id: 51, workspaceId: 2, userId: 20, role: "admin", deactivatedAt: null, inviteToken: null });
    rows("workspace_settings").push({
      workspaceId: 2, timezone: "UTC", slackWebhookUrl: "https://hooks.slack.com/services/T/B/SECRET",
      teamsWebhookUrl: "https://outlook.office.com/webhook/SECRET", sendgridInboundToken: "inboundsecret",
      anthropicApiKeyEnc: "enc:anthropic", apolloApiKeyEnc: "enc:apollo", plivoAuthTokenEnc: "enc:plivo",
      ipAllowlist: [], notifyPolicy: null, companyKeywords: [], companyTopics: [],
    });
  }
  const person = (id: number) => ({ id, openId: `local:${id}`, email: `${id}@lsi.example`, name: `U${id}`, role: "user", loginMethod: "password" });

  it("settings.get gives a rep no credential at all — only whether one is set", async () => {
    seedSettings();
    const s: any = await caller(person(21)).settings.get();
    for (const k of SETTINGS_SECRET_FIELDS) expect(s, k).not.toHaveProperty(k);
    expect(s.slackWebhookUrl).toBeNull();
    expect(s.teamsWebhookUrl).toBeNull();
    expect(JSON.stringify(s)).not.toMatch(/SECRET|inboundsecret|enc:/);
    expect(s).toMatchObject({ hasSlackWebhook: true, hasTeamsWebhook: true, hasSendgridInboundToken: true, timezone: "UTC" });
  });

  it("settings.get shows an admin the webhooks they edit, and still no key or token", async () => {
    seedSettings();
    const s: any = await caller(person(20)).settings.get();
    expect(s.slackWebhookUrl).toMatch(/hooks\.slack\.com/);
    for (const k of SETTINGS_SECRET_FIELDS) expect(s, k).not.toHaveProperty(k);
    expect(JSON.stringify(s)).not.toMatch(/inboundsecret|enc:/);
  });

  /**
   * The projections are lists, so the next secret column must not slip past
   * them by default. Any column whose NAME says it is a credential has to be
   * named by the projection (or by the short list of look-alikes below).
   */
  const SECRETISH = /(password|secret|token|apikey|enc$|webhookurl)/i;
  const LOOKALIKES = new Set(["oauthTokenExpiry", "inviteExpiryDays", "llmMonthlyTokenCap"]);

  it("every credential-looking settings column is withheld", () => {
    const named = new Set<string>([...SETTINGS_SECRET_FIELDS, ...SETTINGS_ADMIN_ONLY_FIELDS]);
    const missed = Object.keys(getTableColumns(workspaceSettings)).filter((k) => SECRETISH.test(k) && !named.has(k) && !LOOKALIKES.has(k));
    expect(missed).toEqual([]);
  });

  it("every credential-looking sending-account column is withheld", () => {
    const named = new Set<string>(SENDING_ACCOUNT_SECRET_FIELDS);
    const missed = Object.keys(getTableColumns(sendingAccounts)).filter((k) => SECRETISH.test(k) && !named.has(k) && !LOOKALIKES.has(k));
    expect(missed).toEqual([]);
  });

  it("the user allowlist names no credential column", () => {
    const leaked = PUBLIC_USER_FIELDS.filter((k) => SECRETISH.test(k));
    expect(leaked).toEqual([]);
    // …and every users column it names exists.
    const cols = Object.keys(getTableColumns(users));
    for (const k of PUBLIC_USER_FIELDS) expect(cols, k).toContain(k);
  });
});

/* ─── C9, the engine half ──────────────────────────────────────────────── */

describe("C9: the sequence engine reads people within the enrolment's workspace", () => {
  it("every lookup by an enrolment's id is scoped to enrollment.workspaceId", () => {
    const src = strip(read("server/sequenceEngine.ts"));
    const lookups = src.match(/\.where\([^;]*?enrollment\.(sequenceId|contactId|leadId|prospectId)\)[^;]*?;/g) ?? [];
    const byId = lookups.filter((l) => /eq\((sequences|contacts|leads|prospects)\.id, enrollment\./.test(l));
    // 5 since 2026-10-26 (Phase 1): the per-row sequence read became the due
    // query's join, which is held to the same rule just below.
    expect(byId.length, "the scan found the engine's lookups").toBeGreaterThanOrEqual(5);
    for (const l of byId) expect(l).toMatch(/eq\((sequences|contacts|leads|prospects)\.workspaceId, enrollment\.workspaceId\)/);
    expect(src).toContain("and(eq(sequences.id, enrollments.sequenceId), eq(sequences.workspaceId, enrollments.workspaceId))");
  });
});
