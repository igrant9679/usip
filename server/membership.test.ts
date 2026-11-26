/**
 * Owner, 2026-11-26: "I'd like to enable sign-up via the website, with new
 * subscriber/membership creation handled on the front end … Give me the
 * 'plumbing' … I want to be able to sign up for a new workspace from the
 * front-end website and from within the app itself (both places)".
 *
 * Held here:
 *   1. the contract both sides read: what a request may carry, the plans;
 *   2. the lock: only a recent request signed with the deployment's secret
 *      gets in, and with no secret set nothing does;
 *   3. the website's door: one sign-up makes one workspace, with its owner
 *      and plan, however many times or however concurrently it is sent, and
 *      a half-made workspace is never left open;
 *   4. afterwards: plan changes, an ended membership archives and a renewed
 *      one restores, and only a workspace the site made can be reached;
 *   5. the app's door: closed unless the owner opens it, one per account,
 *      confirmed addresses only, always on the Trial plan;
 *   6. the wiring: routes mounted, body capped, the screen has the form.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  process.env.VITE_APP_ID = process.env.VITE_APP_ID || "membership-test-app";
  return { db: null as any, audits: [] as Array<Record<string, any>>, failOn: null as null | { op: string; table: string } };
});
vi.mock("./db", async (importActual) => {
  const actual = await importActual<typeof import("./db")>();
  const { and, eq, isNull } = await import("drizzle-orm");
  const { workspaceMembers, workspaces } = await import("../drizzle/schema");
  return {
    ...actual,
    getDb: async () => h.db,
    checkPermission: async () => {},
    getUserWorkspaces: async (userId: number) => h.db
      .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug, plan: workspaces.plan, logoUrl: workspaces.logoUrl, role: workspaceMembers.role, archivedAt: workspaces.archivedAt })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deactivatedAt), isNull(workspaceMembers.inviteToken))),
  };
});
vi.mock("./audit", async (importActual) => ({
  ...(await importActual<typeof import("./audit")>()),
  recordAudit: async (e: Record<string, any>) => { h.audits.push(e); },
}));
vi.mock("./seedHelpContent", () => ({ seedHelpContent: async () => {} }));

import { getTableName } from "drizzle-orm";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { appUrl } from "./appUrl";
import { invalidateArchivedWorkspaceCache } from "./_core/workspaceArchive";
import { isPublicBodyPath } from "./_core/publicBodyLimit";
import { claimableInvite } from "./passwordAuth";
import { checkMembershipSignature, membershipSecretOf, registerMembershipRoutes, signMembershipRequest } from "./membershipApi";
import {
  MembershipError, createOwnWorkspace, membershipEnded, membershipState, provisionMembership, reissueActivation, updateMembership,
} from "./services/membership";
import {
  ACTIVATION_LINK_DAYS, MEMBERSHIP_ENDED_RESTORE_MESSAGE, MEMBERSHIP_SECRET_MIN_LENGTH, SELF_SERVE_BLOCK_MESSAGE,
  defaultWorkspaceName, membershipSigningPayload, membershipSiteUrl, parseExternalId, parseProvision, parseUpdate,
  publicPlans, selfServeBlock, selfServeMode, trialOfferLine,
} from "@shared/membership";
import { MEMBERSHIP_PLANS, PLAN_MONTHLY_LIMIT } from "@shared/prospectAllowance";
import { membershipLinks } from "../drizzle/schema";
import { WorkspaceAccessScreen } from "../client/src/components/usip/WorkspaceAccessGate";
import { initialAuthMode, returnPathFor } from "../client/src/lib/authRedirect";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
/** The text between two anchors, both required (an anchor that is gone fails, it is never -1). */
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, `anchor "${from}"`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b, `anchor "${to}"`).toBeGreaterThan(-1);
  return src.slice(a, b);
};

/** A fixture, never a real key: long enough to be accepted as a secret. */
const SECRET = "fixture-only-not-a-real-secret-0123456789";
const LSI = 2;

/**
 * The fake keeps every inserted row. MySQL would refuse a second row on a
 * unique key, and the claim depends on that refusal, so it is added here for
 * the two keys this feature leans on. `failOn` makes one statement throw.
 */
function withUniqueKeys(db: any) {
  const insert = db.insert.bind(db);
  const update = db.update.bind(db);
  db.insert = (table: any) => {
    const name = getTableName(table);
    const chain = insert(table);
    const values = chain.values.bind(chain);
    chain.values = (v: any) => {
      if (h.failOn?.op === "insert" && h.failOn.table === name) throw new Error(`simulated failure: insert ${name}`);
      const all = db.rowsOf(name) as any[];
      if (name === "membership_links" && all.some((r) => r.source === v.source && r.externalId === v.externalId)) {
        throw Object.assign(new Error("Duplicate entry for key 'ux_membership_link_external'"), { code: "ER_DUP_ENTRY" });
      }
      if (name === "users" && all.some((r) => r.openId === v.openId)) {
        throw Object.assign(new Error("Duplicate entry for key 'openId'"), { code: "ER_DUP_ENTRY" });
      }
      return values(v);
    };
    return chain;
  };
  db.update = (table: any) => {
    const name = getTableName(table);
    if (h.failOn?.op === "update" && h.failOn.table === name) throw new Error(`simulated failure: update ${name}`);
    return update(table);
  };
  return db;
}

const user = (id: number, email: string, over: Record<string, unknown> = {}) => ({
  id, openId: `local:${id}`, name: `User ${id}`, email, loginMethod: "password", role: "user",
  passwordHash: "$2a$12$fixturehashfixturehashfixturehashfixturehashfixturehash", mfaTotpSecret: null, mfaTotpEnabledAt: null,
  sessionVersion: 0, emailVerifiedAt: new Date("2026-11-01T00:00:00Z"), emailVerifyTokenHash: null, ...over,
});

function seed() {
  rows("workspaces").push({ id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial", logoUrl: null });
  rows("users").push(user(1, "owner@lsi.example", { role: "admin" }), user(5, "existing@member.example"));
  rows("workspace_members").push({ id: 1, workspaceId: LSI, userId: 1, role: "super_admin", deactivatedAt: null, inviteToken: null, inviteExpiresAt: null, title: "Owner", createdAt: new Date() });
  rows("workspace_settings").push({ id: 1, workspaceId: LSI, membershipPlan: null });
}

const sale = (over: Record<string, unknown> = {}) => {
  const p = parseProvision({ externalId: "sub-1001", email: "New.Member@Example.com", name: "Dana Reyes", plan: "contributor", ...over });
  if (!p.ok) throw new Error(p.error);
  return p.value;
};

function caller(userId: number, ws: number | null) {
  const u = rows("users").find((x) => x.id === userId);
  return appRouter.createCaller({
    user: u,
    req: { protocol: "https", headers: ws == null ? {} : { "x-workspace-id": String(ws) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>): Promise<{ code?: string; status?: number; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, status: e.status, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

beforeEach(() => {
  h.db = withUniqueKeys(makeSqlFakeDb({ realMembers: true }));
  h.audits = [];
  h.failOn = null;
  invalidateArchivedWorkspaceCache();
  delete process.env.SELF_SERVE_SIGNUP;
  delete process.env.MEMBERSHIP_SITE_URL;
  delete process.env.MEMBERSHIP_API_SECRET;
  seed();
});

describe("the contract", () => {
  it("takes a sale as the site sends it: the address lowercased, a number id as its digits", () => {
    expect(sale()).toEqual({ externalId: "sub-1001", email: "new.member@example.com", name: "Dana Reyes", workspaceName: null, plan: "contributor" });
    expect(parseProvision({ externalId: 8842, email: "a@b.co", plan: "trial" })).toMatchObject({ ok: true, value: { externalId: "8842", name: null } });
  });

  it("refuses what it cannot act on, saying which field", () => {
    const err = (b: unknown) => { const r = parseProvision(b); return r.ok ? "accepted" : r.error; };
    expect(err({ email: "a@b.co", plan: "trial" })).toContain("externalId is required");
    expect(err({ externalId: "has space", email: "a@b.co", plan: "trial" })).toContain("externalId may hold");
    expect(err({ externalId: "x".repeat(121), email: "a@b.co", plan: "trial" })).toContain("longer than 120");
    expect(err({ externalId: "s1", email: "not-an-address", plan: "trial" })).toContain("email is required");
    expect(err({ externalId: "s1", email: "a@b.co", plan: "enterprise" })).toContain(`plan must be one of: ${MEMBERSHIP_PLANS.join(", ")}`);
    expect(err({ externalId: "s1", email: "a@b.co", plan: "trial", workspaceName: "x" })).toContain("at least 2");
    expect(err(null)).toContain("externalId is required");
    expect(parseExternalId(-3).ok).toBe(false);
  });

  it("an update changes the plan, the status, or both, and nothing is not an update", () => {
    expect(parseUpdate({ externalId: "s1", plan: "steward" })).toEqual({ ok: true, value: { externalId: "s1", plan: "steward", status: null } });
    expect(parseUpdate({ externalId: "s1", status: "ended" })).toEqual({ ok: true, value: { externalId: "s1", plan: null, status: "ended" } });
    expect(parseUpdate({ externalId: "s1" })).toMatchObject({ ok: false });
    expect(parseUpdate({ externalId: "s1", status: "paused" })).toMatchObject({ ok: false });
    expect(parseUpdate({ externalId: "s1", plan: "gold" })).toMatchObject({ ok: false });
  });

  it("names a workspace after its owner when the site sends no name", () => {
    expect(defaultWorkspaceName("Dana Reyes", "d@x.co")).toBe("Dana's Workspace");
    expect(defaultWorkspaceName(null, "dana@x.co")).toBe("dana's Workspace");
  });

  it("publishes every plan with the number it includes", () => {
    expect(publicPlans().map((p) => p.id)).toEqual([...MEMBERSHIP_PLANS]);
    for (const p of publicPlans()) expect(p.prospectRecordsPerMonth).toBe(PLAN_MONTHLY_LIMIT[p.id]);
  });

  it("the app's sign-up is closed unless SELF_SERVE_SIGNUP says trial", () => {
    expect(selfServeMode({})).toBe("off");
    expect(selfServeMode({ SELF_SERVE_SIGNUP: "true" })).toBe("off");
    expect(selfServeMode({ SELF_SERVE_SIGNUP: " Trial " })).toBe("trial");
    expect(selfServeBlock({ mode: "off", hasWorkspace: false, emailConfirmed: true })).toBe("closed");
    expect(selfServeBlock({ mode: "trial", hasWorkspace: true, emailConfirmed: true })).toBe("has_workspace");
    expect(selfServeBlock({ mode: "trial", hasWorkspace: false, emailConfirmed: false })).toBe("email_unconfirmed");
    expect(selfServeBlock({ mode: "trial", hasWorkspace: false, emailConfirmed: true })).toBeNull();
  });

  it("links to the membership site only when it is an https address", () => {
    expect(membershipSiteUrl({})).toBeNull();
    expect(membershipSiteUrl({ MEMBERSHIP_SITE_URL: "javascript:alert(1)" })).toBeNull();
    expect(membershipSiteUrl({ MEMBERSHIP_SITE_URL: "http://example.com/plans" })).toBeNull();
    expect(membershipSiteUrl({ MEMBERSHIP_SITE_URL: "https://www.example.com/plans" })).toBe("https://www.example.com/plans");
  });
});

describe("the lock", () => {
  const now = Date.UTC(2026, 10, 26, 15, 0, 0);
  const ts = String(now / 1000);
  const body = JSON.stringify({ externalId: "sub-1001", email: "a@b.co", plan: "member" });
  const check = (over: Partial<Parameters<typeof checkMembershipSignature>[0]> = {}) =>
    checkMembershipSignature({ secret: SECRET, timestamp: ts, signature: `sha256=${signMembershipRequest(SECRET, ts, body)}`, rawBody: body, nowMs: now, ...over });

  it("signs the timestamp, a dot, then the body as sent", () => {
    expect(membershipSigningPayload("1700000000", '{"a":1}')).toBe('1700000000.{"a":1}');
  });

  it("lets in a recent request signed with the secret, with or without the sha256= prefix", () => {
    expect(check()).toEqual({ ok: true });
    expect(check({ signature: signMembershipRequest(SECRET, ts, body).toUpperCase() })).toEqual({ ok: true });
  });

  it("is closed, 503, while no secret is set or the one set is too short to be one", () => {
    expect(membershipSecretOf({})).toBeNull();
    expect(membershipSecretOf({ MEMBERSHIP_API_SECRET: "x".repeat(MEMBERSHIP_SECRET_MIN_LENGTH - 1) })).toBeNull();
    expect(membershipSecretOf({ MEMBERSHIP_API_SECRET: SECRET })).toBe(SECRET);
    expect(check({ secret: null })).toMatchObject({ ok: false, status: 503, code: "not_configured" });
  });

  it("refuses a request with no signature, a changed body, another secret, or another timestamp", () => {
    expect(check({ signature: undefined })).toMatchObject({ ok: false, status: 401, code: "unsigned" });
    expect(check({ timestamp: undefined })).toMatchObject({ ok: false, status: 401, code: "unsigned" });
    expect(check({ rawBody: body.replace("member", "founder") })).toMatchObject({ ok: false, status: 401, code: "bad_signature" });
    expect(check({ signature: `sha256=${signMembershipRequest("another-secret-another-secret-another", ts, body)}` })).toMatchObject({ ok: false, code: "bad_signature" });
    // The timestamp is inside what is signed: moving it breaks the signature.
    expect(check({ timestamp: String(now / 1000 + 10) })).toMatchObject({ ok: false, code: "bad_signature" });
  });

  it("refuses a correctly signed request that is more than five minutes old or ahead", () => {
    const old = String(now / 1000 - 301);
    expect(check({ timestamp: old, signature: signMembershipRequest(SECRET, old, body) })).toMatchObject({ ok: false, status: 401, code: "stale" });
    const ahead = String(now / 1000 + 301);
    expect(check({ timestamp: ahead, signature: signMembershipRequest(SECRET, ahead, body) })).toMatchObject({ ok: false, code: "stale" });
    const edge = String(now / 1000 - 299);
    expect(check({ timestamp: edge, signature: signMembershipRequest(SECRET, edge, body) })).toEqual({ ok: true });
  });
});

describe("the routes", () => {
  type Handler = (req: any, res: any) => unknown;
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, ...hs: Handler[]) => routes.set(`GET ${path}`, hs[hs.length - 1]),
    post: (path: string, ...hs: Handler[]) => routes.set(`POST ${path}`, hs[hs.length - 1]),
  };
  registerMembershipRoutes(app as never);

  async function call(method: string, path: string, payload?: unknown, opts: { sign?: boolean; secret?: string } = {}) {
    const raw = payload === undefined ? "" : JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {};
    if (opts.sign !== false) {
      headers["x-velocity-timestamp"] = ts;
      headers["x-velocity-signature"] = `sha256=${signMembershipRequest(opts.secret ?? SECRET, ts, raw)}`;
    }
    const out = { status: 200, body: null as any, headers: {} as Record<string, string> };
    const res = {
      status(c: number) { out.status = c; return res; },
      json(b: unknown) { out.body = b; return res; },
      setHeader(k: string, v: string) { out.headers[k] = v; },
    };
    await routes.get(`${method} ${path}`)!({ headers, body: payload ?? {}, rawBody: Buffer.from(raw, "utf8") }, res);
    return out;
  }

  it("mounts the five routes", () => {
    expect([...routes.keys()].sort()).toEqual([
      "GET /api/membership/plans",
      "POST /api/membership/activation",
      "POST /api/membership/provision",
      "POST /api/membership/status",
      "POST /api/membership/update",
    ]);
  });

  it("answers the plan list to anyone, with no secret set", async () => {
    const r = await call("GET", "/api/membership/plans", undefined, { sign: false });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, appSignUp: "off", membershipSiteUrl: null });
    expect(r.body.plans).toHaveLength(MEMBERSHIP_PLANS.length);
  });

  it("does nothing at all on every signed route while no secret is set", async () => {
    for (const p of ["provision", "update", "status", "activation"]) {
      const r = await call("POST", `/api/membership/${p}`, { externalId: "sub-1001", email: "a@b.co", plan: "member", status: "ended" });
      expect(r.status, p).toBe(503);
      expect(r.body.code, p).toBe("not_configured");
    }
    expect(rows("membership_links")).toHaveLength(0);
    expect(rows("workspaces")).toHaveLength(1);
  });

  it("does nothing for an unsigned or wrongly signed request", async () => {
    process.env.MEMBERSHIP_API_SECRET = SECRET;
    const payload = { externalId: "sub-1001", email: "a@b.co", plan: "member" };
    expect((await call("POST", "/api/membership/provision", payload, { sign: false })).status).toBe(401);
    expect((await call("POST", "/api/membership/provision", payload, { secret: "the-wrong-secret-the-wrong-secret-xx" })).status).toBe(401);
    expect((await call("POST", "/api/membership/update", { externalId: "sub-1001", status: "ended" }, { sign: false })).status).toBe(401);
    expect(rows("membership_links")).toHaveLength(0);
    expect(rows("workspaces")).toHaveLength(1);
  });

  it("makes the workspace for a signed sale, and says what is wrong with one it cannot read", async () => {
    process.env.MEMBERSHIP_API_SECRET = SECRET;
    const bad = await call("POST", "/api/membership/provision", { externalId: "sub-1001", email: "a@b.co", plan: "gold" });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ ok: false, code: "invalid" });
    const ok = await call("POST", "/api/membership/provision", { externalId: "sub-1001", email: "a@b.co", name: "Ana", plan: "member" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, created: true, plan: "member", status: "active", account: "new", workspaceName: "Ana's Workspace" });
    expect(ok.body.activationUrl).toContain("/invite/accept?token=");
    const unknown = await call("POST", "/api/membership/status", { externalId: "sub-9999" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("not_found");
  });

  it("is mounted before the tRPC handler and reads a capped body", () => {
    const index = read("server/_core/index.ts");
    expect(between(index, "registerPasswordAuthRoutes(app);", 'app.use("/api/trpc", trpcCsrfGuard)')).toContain("registerMembershipRoutes(app);");
    expect(isPublicBodyPath("/api/membership/provision")).toBe(true);
  });
});

describe("the website's door", () => {
  it("makes a new address a workspace on the plan, with an owner who has a first-sign-in link", async () => {
    const r = await provisionMembership(sale());
    expect(r).toMatchObject({ created: true, account: "new", plan: "contributor", status: "active", activationPending: true, workspaceName: "Dana's Workspace" });
    const ws = rows("workspaces").find((w) => w.id === r.workspaceId);
    const owner = rows("users").find((u) => u.email === "new.member@example.com");
    expect(owner).toMatchObject({ openId: "invite:new.member@example.com", loginMethod: "invite", passwordHash: null });
    expect(ws.ownerUserId).toBe(owner.id);
    const member = rows("workspace_members").find((m) => m.workspaceId === r.workspaceId);
    expect(member).toMatchObject({ userId: owner.id, role: "super_admin" });
    expect(member.inviteToken).toMatch(/^[0-9a-f]{64}$/);
    expect(r.activationUrl).toBe(appUrl(`/invite/accept?token=${member.inviteToken}`));
    const days = (member.inviteExpiresAt.getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(ACTIVATION_LINK_DAYS);
    expect(rows("workspace_settings").find((s) => s.workspaceId === r.workspaceId).membershipPlan).toBe("contributor");
    expect(rows("membership_links")).toEqual([expect.objectContaining({ source: "meyousocial", externalId: "sub-1001", workspaceId: r.workspaceId, userId: owner.id, status: "active" })]);
    expect(h.audits).toEqual([expect.objectContaining({ workspaceId: r.workspaceId, actorUserId: null, action: "create", entityType: "workspace" })]);
  });

  it("gives an address that already has an account its workspace at once, with no link to set a password", async () => {
    const r = await provisionMembership(sale({ email: "existing@member.example", workspaceName: "Northwind Sales" }));
    expect(r).toMatchObject({ created: true, account: "existing", activationPending: false, activationUrl: null, workspaceName: "Northwind Sales" });
    expect(rows("users").filter((u) => u.email === "existing@member.example")).toHaveLength(1);
    const member = rows("workspace_members").find((m) => m.workspaceId === r.workspaceId);
    expect(member).toMatchObject({ userId: 5, role: "super_admin" });
    expect(member.inviteToken ?? null).toBeNull();
    // They can open it straight away.
    expect((await caller(5, null).workspace.list()).map((w: any) => w.id)).toEqual([r.workspaceId]);
  });

  it("makes one workspace for a sale sent twice, and changes nothing the second time", async () => {
    const first = await provisionMembership(sale());
    const again = await provisionMembership(sale({ plan: "founder", workspaceName: "Something Else" }));
    expect(again).toMatchObject({ created: false, workspaceId: first.workspaceId, plan: "contributor", workspaceName: "Dana's Workspace" });
    // The link the owner has not used yet is given again, unchanged.
    expect(again.activationUrl).toBe(first.activationUrl);
    expect(rows("workspaces")).toHaveLength(2);
    expect(rows("membership_links")).toHaveLength(1);
  });

  it("makes one workspace when the same sale arrives twice at once", async () => {
    const settled = await Promise.allSettled([provisionMembership(sale()), provisionMembership(sale())]);
    const made = settled.filter((s) => s.status === "fulfilled" && (s as PromiseFulfilledResult<any>).value.created);
    expect(made).toHaveLength(1);
    for (const s of settled) {
      if (s.status === "rejected") expect(s.reason).toMatchObject({ status: 409, code: "in_progress" });
    }
    expect(rows("workspaces")).toHaveLength(2);
    expect(rows("membership_links")).toHaveLength(1);
    expect(rows("users").filter((u) => u.email === "new.member@example.com")).toHaveLength(1);
  });

  it("two memberships for one person are two workspaces", async () => {
    const a = await provisionMembership(sale({ externalId: "sub-1" }));
    const b = await provisionMembership(sale({ externalId: "sub-2" }));
    expect(b.workspaceId).not.toBe(a.workspaceId);
    expect(rows("users").filter((u) => u.email === "new.member@example.com")).toHaveLength(1);
  });

  describe("the first-sign-in link claims the owner's account", () => {
    const owner = () => rows("users").find((u) => u.email === "new.member@example.com");
    const tokenOf = (workspaceId: number) => rows("workspace_members").find((m) => m.workspaceId === workspaceId && m.userId === owner().id).inviteToken as string;
    /** An ordinary invitation from a workspace admin, waiting on the same address. */
    const adminInvite = (id: number, token: string) => rows("workspace_members").push({
      id, workspaceId: LSI, userId: owner().id, role: "rep", deactivatedAt: null, inviteToken: token, inviteExpiresAt: null, title: null, createdAt: new Date(),
    });

    it("with one membership, as any invitation does", async () => {
      const made = await provisionMembership(sale());
      expect(await claimableInvite(h.db, owner(), tokenOf(made.workspaceId))).toMatchObject({ memberId: expect.any(Number) });
      expect(await claimableInvite(h.db, owner(), "f".repeat(64))).toBeNull();
    });

    it("when the same person bought a second membership before signing in: either link works", async () => {
      const a = await provisionMembership(sale({ externalId: "sub-1" }));
      const b = await provisionMembership(sale({ externalId: "sub-2" }));
      expect(await claimableInvite(h.db, owner(), tokenOf(a.workspaceId))).not.toBeNull();
      expect(await claimableInvite(h.db, owner(), tokenOf(b.workspaceId))).not.toBeNull();
    });

    it("when a workspace admin has also invited the address: the member's own link works, the admin's token does not", async () => {
      const made = await provisionMembership(sale());
      const adminToken = "a".repeat(64);
      adminInvite(80, adminToken);
      expect(await claimableInvite(h.db, owner(), tokenOf(made.workspaceId))).not.toBeNull();
      // The admin can read their own invite's token. It must not set the password of someone who owns a paid workspace.
      expect(await claimableInvite(h.db, owner(), adminToken)).toBeNull();
    });

    it("two admins' invitations and no membership: neither token claims, as before", async () => {
      rows("users").push({ id: 60, openId: "invite:two@x.example", name: "Two", email: "two@x.example", loginMethod: "invite", role: "user", passwordHash: null });
      const two = rows("users").find((u) => u.id === 60);
      rows("workspaces").push({ id: 9, name: "Other", slug: "other", ownerUserId: 1, archivedAt: null, plan: "trial", logoUrl: null });
      rows("workspace_members").push(
        { id: 81, workspaceId: LSI, userId: 60, role: "rep", deactivatedAt: null, inviteToken: "b".repeat(64), inviteExpiresAt: null, title: null, createdAt: new Date() },
        { id: 82, workspaceId: 9, userId: 60, role: "rep", deactivatedAt: null, inviteToken: "c".repeat(64), inviteExpiresAt: null, title: null, createdAt: new Date() },
      );
      expect(await claimableInvite(h.db, two, "b".repeat(64))).toBeNull();
      expect(await claimableInvite(h.db, two, "c".repeat(64))).toBeNull();
    });

    it("an invitation INTO a member's workspace is an ordinary one: the exception is for the owner the site named", async () => {
      const made = await provisionMembership(sale());
      // The member, as admin of their workspace, invites a colleague whom another workspace has also invited.
      rows("users").push({ id: 61, openId: "invite:colleague@x.example", name: "Colleague", email: "colleague@x.example", loginMethod: "invite", role: "user", passwordHash: null });
      const colleague = rows("users").find((u) => u.id === 61);
      rows("workspace_members").push(
        { id: 83, workspaceId: made.workspaceId, userId: 61, role: "rep", deactivatedAt: null, inviteToken: "d".repeat(64), inviteExpiresAt: null, title: null, createdAt: new Date() },
        { id: 84, workspaceId: LSI, userId: 61, role: "rep", deactivatedAt: null, inviteToken: "e".repeat(64), inviteExpiresAt: null, title: null, createdAt: new Date() },
      );
      expect(await claimableInvite(h.db, colleague, "d".repeat(64))).toBeNull();
      expect(await claimableInvite(h.db, colleague, "e".repeat(64))).toBeNull();
    });

    it("not for an account that already has a password, nor with a lapsed link", async () => {
      const made = await provisionMembership(sale());
      const token = tokenOf(made.workspaceId);
      rows("workspace_members").find((m) => m.workspaceId === made.workspaceId).inviteExpiresAt = new Date(Date.now() - 1000);
      expect(await claimableInvite(h.db, owner(), token)).toBeNull();
      rows("workspace_members").find((m) => m.workspaceId === made.workspaceId).inviteExpiresAt = null;
      expect(await claimableInvite(h.db, { ...owner(), passwordHash: "set" }, token)).toBeNull();
    });
  });

  it("never leaves a half-made workspace open: no member, archived, and the sale can be sent again", async () => {
    h.failOn = { op: "update", table: "membership_links" };
    const r = await refusal(provisionMembership(sale()));
    expect(r).toMatchObject({ status: 500, code: "failed" });
    const orphan = rows("workspaces").find((w) => w.id !== LSI);
    expect(orphan.archivedAt).toBeInstanceOf(Date);
    expect(rows("workspace_members").filter((m) => m.workspaceId === orphan.id)).toHaveLength(0);
    expect(rows("membership_links")).toHaveLength(0);
    h.failOn = null;
    const retry = await provisionMembership(sale());
    expect(retry.created).toBe(true);
    expect(retry.workspaceId).not.toBe(orphan.id);
  });

  it("makes nothing when the database is down, and says to try again", async () => {
    h.db = null;
    expect(await refusal(provisionMembership(sale()))).toMatchObject({ status: 503, code: "unavailable" });
  });
});

describe("afterwards", () => {
  it("changes the plan and reports the one it replaced", async () => {
    const made = await provisionMembership(sale());
    const r = await updateMembership({ externalId: "sub-1001", plan: "steward", status: null });
    expect(r).toMatchObject({ plan: "steward", status: "active", previous: { plan: "contributor", status: "active" } });
    expect(rows("workspace_settings").find((s) => s.workspaceId === made.workspaceId).membershipPlan).toBe("steward");
    expect(h.audits[h.audits.length - 1]).toMatchObject({ action: "update", workspaceId: made.workspaceId });
  });

  it("an ended membership archives its workspace, and its owner cannot restore it; the platform owner can", async () => {
    const made = await provisionMembership(sale({ email: "existing@member.example" }));
    const r = await updateMembership({ externalId: "sub-1001", plan: null, status: "ended" });
    expect(r).toMatchObject({ status: "ended", plan: "contributor", previous: { status: "active" } });
    expect(rows("workspaces").find((w) => w.id === made.workspaceId).archivedAt).toBeInstanceOf(Date);
    expect(rows("membership_links")[0]).toMatchObject({ status: "ended" });
    expect(rows("membership_links")[0].endedAt).toBeInstanceOf(Date);
    expect(await membershipEnded(made.workspaceId)).toBe(true);

    const ownerTry = await refusal(caller(5, made.workspaceId).dangerZone.unarchiveWorkspace());
    expect(ownerTry).toMatchObject({ code: "FORBIDDEN", message: MEMBERSHIP_ENDED_RESTORE_MESSAGE });
    expect(rows("workspaces").find((w) => w.id === made.workspaceId).archivedAt).toBeInstanceOf(Date);

    // The platform owner, as a super admin there, still can: it is their deployment.
    rows("workspace_members").push({ id: 99, workspaceId: made.workspaceId, userId: 1, role: "super_admin", deactivatedAt: null, inviteToken: null, inviteExpiresAt: null, title: null, createdAt: new Date() });
    await caller(1, made.workspaceId).dangerZone.unarchiveWorkspace();
    expect(rows("workspaces").find((w) => w.id === made.workspaceId).archivedAt).toBeNull();
  });

  it("a renewed membership restores the workspace", async () => {
    const made = await provisionMembership(sale());
    await updateMembership({ externalId: "sub-1001", plan: null, status: "ended" });
    const r = await updateMembership({ externalId: "sub-1001", plan: "member", status: "active" });
    expect(r).toMatchObject({ status: "active", plan: "member", previous: { status: "ended", plan: "contributor" } });
    expect(rows("workspaces").find((w) => w.id === made.workspaceId).archivedAt).toBeNull();
    expect(rows("membership_links")[0]).toMatchObject({ status: "active", endedAt: null });
    expect(await membershipEnded(made.workspaceId)).toBe(false);
  });

  it("a workspace with no membership is not one whose membership ended", async () => {
    expect(await membershipEnded(LSI)).toBe(false);
    rows("workspaces").find((w) => w.id === LSI).archivedAt = new Date();
    invalidateArchivedWorkspaceCache();
    await caller(1, LSI).dangerZone.unarchiveWorkspace();
    expect(rows("workspaces").find((w) => w.id === LSI).archivedAt).toBeNull();
  });

  it("cannot reach a workspace the site did not make", async () => {
    // Unknown id.
    expect(await refusal(updateMembership({ externalId: "sub-404", plan: null, status: "ended" }))).toMatchObject({ status: 404, code: "not_found" });
    // A workspace made in the app has a link, but not the site's: its id is not the site's to use.
    rows("membership_links").push({ id: 50, source: "app", externalId: "user-5", workspaceId: LSI, userId: 5, email: "x@y.co", status: "active", endedAt: null });
    expect(await refusal(updateMembership({ externalId: "user-5", plan: "founder", status: "ended" }))).toMatchObject({ status: 404 });
    expect(await refusal(membershipState("user-5"))).toMatchObject({ status: 404 });
    expect(await refusal(reissueActivation("user-5"))).toMatchObject({ status: 404 });
    expect(rows("workspaces").find((w) => w.id === LSI).archivedAt).toBeNull();
    expect(rows("workspace_settings").find((s) => s.workspaceId === LSI).membershipPlan).toBeNull();
  });

  it("reports what it holds, with this month's use of the plan", async () => {
    const made = await provisionMembership(sale());
    rows("prospect_allowance_usage").push({ id: 1, workspaceId: made.workspaceId, period: new Date().toISOString().slice(0, 7), used: 412 });
    const s = await membershipState("sub-1001");
    expect(s).toMatchObject({ workspaceId: made.workspaceId, plan: "contributor", status: "active", activationPending: true });
    expect(s.usage).toMatchObject({ used: 412, limit: PLAN_MONTHLY_LIMIT.contributor });
  });

  it("issues a fresh first-sign-in link to an owner still waiting, and the old one stops working", async () => {
    const made = await provisionMembership(sale());
    const before = rows("workspace_members").find((m) => m.workspaceId === made.workspaceId).inviteToken;
    // The nightly job marked the lapsed invitation expired.
    rows("users").find((u) => u.email === "new.member@example.com").loginMethod = "expired_invite";
    const r = await reissueActivation("sub-1001");
    const after = rows("workspace_members").find((m) => m.workspaceId === made.workspaceId).inviteToken;
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
    expect(r.activationUrl).toBe(appUrl(`/invite/accept?token=${after}`));
    expect(rows("users").find((u) => u.email === "new.member@example.com").loginMethod).toBe("invite");
  });

  it("gives no link to an owner who has already signed in: a token there would lock them out", async () => {
    const made = await provisionMembership(sale({ email: "existing@member.example" }));
    const r = await reissueActivation("sub-1001");
    expect(r).toMatchObject({ activationPending: false, activationUrl: null });
    expect(rows("workspace_members").find((m) => m.workspaceId === made.workspaceId).inviteToken ?? null).toBeNull();
  });

  it("does not show a lapsed link as one that works", async () => {
    const made = await provisionMembership(sale());
    rows("workspace_members").find((m) => m.workspaceId === made.workspaceId).inviteExpiresAt = new Date(Date.now() - 1000);
    const s = await membershipState("sub-1001");
    expect(s).toMatchObject({ activationPending: true, activationUrl: null });
  });
});

describe("the app's door", () => {
  const newcomer = () => { rows("users").push(user(7, "fresh@start.example")); return rows("users").find((u) => u.id === 7); };

  it("is closed until the platform owner opens it", async () => {
    newcomer();
    expect(await caller(7, null).workspace.signUp()).toMatchObject({ open: false, block: "closed", message: SELF_SERVE_BLOCK_MESSAGE.closed });
    expect(await refusal(caller(7, null).workspace.createOwn({ name: "Fresh Start" }))).toMatchObject({ code: "FORBIDDEN", message: SELF_SERVE_BLOCK_MESSAGE.closed });
    expect(rows("workspaces")).toHaveLength(1);
    expect(rows("membership_links")).toHaveLength(0);
  });

  it("when open, makes someone with a confirmed address their own Trial workspace, once", async () => {
    process.env.SELF_SERVE_SIGNUP = "trial";
    process.env.MEMBERSHIP_SITE_URL = "https://www.example.com/plans";
    newcomer();
    expect(await caller(7, null).workspace.signUp()).toEqual({ open: true, block: null, message: null, offer: trialOfferLine(), membershipSiteUrl: "https://www.example.com/plans" });
    const w = await caller(7, null).workspace.createOwn({ name: "  Fresh Start  " });
    expect(w.name).toBe("Fresh Start");
    expect(rows("workspace_members").find((m) => m.workspaceId === w.id)).toMatchObject({ userId: 7, role: "super_admin" });
    expect(rows("workspace_members").find((m) => m.workspaceId === w.id).inviteToken ?? null).toBeNull();
    expect(rows("workspace_settings").find((s) => s.workspaceId === w.id).membershipPlan).toBe("trial");
    expect(rows("membership_links")).toEqual([expect.objectContaining({ source: "app", externalId: "user-7", workspaceId: w.id, userId: 7 })]);
    expect(h.audits).toEqual([expect.objectContaining({ workspaceId: w.id, actorUserId: 7, action: "create" })]);
    expect((await caller(7, null).workspace.list()).map((x: any) => x.id)).toEqual([w.id]);

    expect(await caller(7, null).workspace.signUp()).toMatchObject({ open: false, block: "has_workspace" });
    expect(await refusal(caller(7, null).workspace.createOwn({ name: "A Second One" }))).toMatchObject({ code: "FORBIDDEN" });
    expect(rows("workspaces")).toHaveLength(2);
  });

  it("makes one workspace for a double click", async () => {
    process.env.SELF_SERVE_SIGNUP = "trial";
    const u = newcomer();
    const settled = await Promise.allSettled([createOwnWorkspace(u, "Fresh Start"), createOwnWorkspace(u, "Fresh Start")]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(settled.find((s) => s.status === "rejected")).toMatchObject({ reason: expect.any(MembershipError) });
    expect(rows("workspaces")).toHaveLength(2);
  });

  it("waits for the address to be confirmed", async () => {
    process.env.SELF_SERVE_SIGNUP = "trial";
    rows("users").push(user(8, "unconfirmed@start.example", { emailVerifiedAt: null, emailVerifyTokenHash: "a".repeat(64) }));
    expect(await caller(8, null).workspace.signUp()).toMatchObject({ open: false, block: "email_unconfirmed", message: SELF_SERVE_BLOCK_MESSAGE.email_unconfirmed });
    expect(await refusal(caller(8, null).workspace.createOwn({ name: "Too Soon" }))).toMatchObject({ code: "FORBIDDEN", message: SELF_SERVE_BLOCK_MESSAGE.email_unconfirmed });
    expect(rows("workspaces")).toHaveLength(1);
  });

  it("does not make a workspace for someone who was deactivated elsewhere", async () => {
    process.env.SELF_SERVE_SIGNUP = "trial";
    newcomer();
    rows("workspace_members").push({ id: 70, workspaceId: LSI, userId: 7, role: "rep", deactivatedAt: new Date(), inviteToken: null, inviteExpiresAt: null, title: null, createdAt: new Date() });
    expect(await refusal(caller(7, null).workspace.createOwn({ name: "Back Door" }))).toMatchObject({ code: "FORBIDDEN", message: SELF_SERVE_BLOCK_MESSAGE.has_workspace });
  });

  it("the operator's own New workspace still works, through the same maker", async () => {
    const w = await caller(1, LSI).workspace.create({ name: "Client Co" });
    expect(w).toMatchObject({ name: "Client Co" });
    expect(rows("workspace_members").find((m) => m.workspaceId === w.id)).toMatchObject({ userId: 1, role: "super_admin", title: "Owner" });
    // The operator's own workspaces are on no plan and have no membership.
    expect(rows("membership_links")).toHaveLength(0);
    const router = read("server/routers/workspace.ts");
    expect(between(router, "create: workspaceProcedure", "rename: workspaceProcedure")).toContain("createWorkspace(db, {");
  });
});

describe("the screen and the schema", () => {
  const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(WorkspaceAccessScreen, props as never));

  it("offers the form when the app will make a workspace, and keeps the old words when it will not", () => {
    const form = createElement("form", { "data-create-own-workspace": true }, "Workspace name");
    const open = html({ problem: "create", create: form });
    expect(open).toContain("Create your workspace");
    expect(open).toContain("data-create-own-workspace");
    expect(open).not.toContain("not in a workspace yet");
    const closed = html({ problem: "none" });
    expect(closed).toContain("You&#x27;re not in a workspace yet");
    expect(html({ problem: "none", body: SELF_SERVE_BLOCK_MESSAGE.email_unconfirmed })).toContain("Confirm your email address first");
  });

  it("the gate asks whether it may, and the form's mutation says when it fails", () => {
    const gate = read("client/src/components/usip/WorkspaceAccessGate.tsx");
    expect(gate).toContain('trpc.workspace.signUp.useQuery(undefined, { enabled: empty && access.data?.state === "none" })');
    expect(gate).toContain('problem={offer?.open ? "create" : state}');
    const form = read("client/src/components/usip/CreateOwnWorkspace.tsx");
    expect(between(form, "trpc.workspace.createOwn.useMutation({", "});")).toContain("onError:");
    expect(form).toContain("utils.workspace.list.invalidate()");
  });

  it("?signup=1 opens the sign-in page on Create account, and nothing else does", () => {
    expect(initialAuthMode("?signup=1")).toBe("signup");
    expect(initialAuthMode("")).toBe("signin");
    expect(initialAuthMode("?signup=0")).toBe("signin");
    expect(initialAuthMode("?returnPath=%2Fare&signup=1")).toBe("signup");
    // The link lands on Home after registering, not back on itself.
    expect(returnPathFor({ pathname: "/", search: "?signup=1", hash: "" })).toBe("/");
    expect(read("client/src/App.tsx")).toContain("useState<\"signin\" | \"signup\" | \"forgot\">(() => initialAuthMode(window.location.search))");
  });

  it("the migration makes the table the schema describes, with the key the claim depends on", () => {
    const migrations = read("server/_core/rawMigrations.ts");
    const sql = between(migrations, '"0447_membership_links.sql"', "},");
    for (const col of Object.values(membershipLinks).map((c: any) => c?.name).filter((n): n is string => typeof n === "string")) {
      expect(sql, col).toContain(`\`${col}\``);
    }
    expect(sql).toContain("UNIQUE KEY `ux_membership_link_external` (`source`, `externalId`)");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS `membership_links`");
  });
});
