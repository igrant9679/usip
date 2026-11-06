/**
 * Team, workspace and admin access (audit 2026-10-20, batch S1a, 2026-11-06):
 *
 *   C4   mailbox OAuth tokens encrypted at rest; plaintext saved before
 *        encryption is encrypted once, safely
 *   G7   SCIM honours filters and `active`, and deprovisioning deactivates
 *   G10  signing up no longer makes a stranger super_admin of a workspace
 *   G11  a tab asking for a workspace it can't use is refused, not redirected
 *   G13  "the last super admin" means the last ACTIVE one; the owner stays
 *   G16  saving an integration keeps its stored secret
 *   G35  someone with no workspace gets a screen that says why
 *   G36  archived workspaces are badged, and their public pages stop
 *   G46  one rank rule for acting on another member
 *   G47  invites report what happened; 0 days means never
 *   G48  the Danger zone offers super-admin actions to super admins only
 *   G49  SCIM tokens hashed and audited; CSV cells can't run formulas
 *   G52/O43  sender pools take a manager, and hold an account once
 *   G68  seats, escaped invite emails, real time zones, voice agent owners,
 *        platform-wide counts, the CRM card
 *   P114 a workspace switch clears the old workspace's cached data
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  process.env.VITE_APP_ID = process.env.VITE_APP_ID || "s1a-test-app";
  return {
    db: null as any,
    audits: [] as Array<Record<string, any>>,
    emails: [] as Array<{ to: unknown; subject: string; html: string }>,
    emailResult: { ok: true } as { ok: boolean; reason?: string },
  };
});
vi.mock("./db", async (importActual) => {
  const actual = await importActual<typeof import("./db")>();
  const { and, eq, isNull } = await import("drizzle-orm");
  const { workspaceMembers, workspaces } = await import("../drizzle/schema");
  return {
    ...actual,
    getDb: async () => h.db,
    checkPermission: async () => {},
    // db.ts reads its own getDb, which the mock above can't reach. The same
    // query, against the fake; the archivedAt column it adds is pinned by
    // source in the G36 block.
    getUserWorkspaces: async (userId: number) => h.db
      .select({
        id: workspaces.id, name: workspaces.name, slug: workspaces.slug, plan: workspaces.plan,
        logoUrl: workspaces.logoUrl, role: workspaceMembers.role, archivedAt: workspaces.archivedAt,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deactivatedAt), isNull(workspaceMembers.inviteToken))),
  };
});
vi.mock("./audit", async (importActual) => ({
  ...(await importActual<typeof import("./audit")>()),
  recordAudit: async (e: Record<string, any>) => { h.audits.push(e); },
}));
vi.mock("./emailDelivery", async (importActual) => ({
  ...(await importActual<typeof import("./emailDelivery")>()),
  sendSystemEmail: async (_ws: number, opts: { to: unknown; subject: string; html: string }) => {
    h.emails.push(opts);
    return h.emailResult;
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { WORKSPACE_UNAVAILABLE_ERR_MSG } from "@shared/const";
import { csvCell } from "@shared/csvCell";
import { decryptField, encryptField, readStoredSecret } from "./emailAdapter";
import { encryptLegacyMailboxSecrets, looksEncrypted } from "./services/secretBackfill";
import { mergeIntegrationConfig, redactIntegrationConfig } from "./services/sendgridKey";
import { hashScimToken, parseScimFilter, requestedActive, verifyScimBearer } from "./scimHttp";
import { invalidateArchivedWorkspaceCache } from "./_core/workspaceArchive";
import { canOpenWorkspace, chooseWorkspace, keepAcrossWorkspaceSwitch } from "../client/src/lib/activeWorkspace";
import { inviteResult, roleLabel } from "../client/src/lib/teamMessages";
import { WorkspaceAccessScreen } from "../client/src/components/usip/WorkspaceAccessGate";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
/** The text between two anchors, both required (an anchor that's gone fails, not -1). */
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, `anchor "${from}"`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b, `anchor "${to}"`).toBeGreaterThan(-1);
  return src.slice(a, b);
};

const LSI = 2;
const CF = 4;
// Users: 20/21 admins, 22 rep, 23 super admin and owner, 24 a DEACTIVATED
// super admin, 25 manager, 26 a second active super admin, 10 CF's own.
function seed() {
  rows("workspaces").push(
    { id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: 23, archivedAt: null, plan: "trial", logoUrl: null },
    { id: CF, name: "CommunityForce", slug: "cf", ownerUserId: 10, archivedAt: null, plan: "trial", logoUrl: null },
  );
  const user = (id: number, email: string, over: Record<string, unknown> = {}) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email, loginMethod: "password", role: "user",
    passwordHash: null, mfaTotpSecret: null, mfaTotpEnabledAt: null, sessionVersion: 0, ...over,
  });
  rows("users").push(
    user(20, "admin@lsi.example"), user(21, "admin2@lsi.example"), user(22, "rep@lsi.example"),
    user(23, "owner@lsi.example"), user(24, "gone@lsi.example"), user(25, "manager@lsi.example"),
    user(26, "super2@lsi.example"), user(10, "cf@cf.example"),
  );
  const member = (id: number, workspaceId: number, userId: number, role: string, over: Record<string, unknown> = {}) => ({
    id, workspaceId, userId, role, deactivatedAt: null, inviteToken: null, lastActiveAt: new Date(), createdAt: new Date(),
    quota: null, title: null, ...over,
  });
  rows("workspace_members").push(
    member(1, LSI, 20, "admin"), member(2, LSI, 21, "admin"), member(3, LSI, 22, "rep"),
    member(4, LSI, 23, "super_admin"), member(5, LSI, 24, "super_admin", { deactivatedAt: new Date("2026-10-01T00:00:00Z") }),
    member(6, LSI, 25, "manager"), member(7, CF, 10, "super_admin"),
  );
}
/** A second active super admin, for the cases that need one. */
const addSecondSuper = () => rows("workspace_members").push({
  id: 8, workspaceId: LSI, userId: 26, role: "super_admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date(), createdAt: new Date(),
});

function caller(userId: number, ws: number | null = LSI) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: ws == null ? {} : { "x-workspace-id": String(ws) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.audits = [];
  h.emails = [];
  h.emailResult = { ok: true };
  invalidateArchivedWorkspaceCache();
  seed();
});

/* ─── G13 ──────────────────────────────────────────────────────────────── */

describe("G13: a workspace always keeps an active super admin, and its owner", () => {
  it("the last active super admin can't demote themselves because a deactivated one is on the books", async () => {
    const r = await refusal(caller(23).team.changeRole({ memberId: 4, role: "admin" }));
    expect(r.code).toBe("BAD_REQUEST");
    expect(r.message).toMatch(/sole super_admin/);
    expect(row("workspace_members", 4).role).toBe("super_admin");
  });

  it("control: with a second active super admin, they can", async () => {
    addSecondSuper();
    await caller(23).team.changeRole({ memberId: 4, role: "admin" });
    expect(row("workspace_members", 4).role).toBe("admin");
  });

  it("bulk demotion counts the seats it empties, not deactivated rows", async () => {
    addSecondSuper();
    // Demoting the second active one and the deactivated one leaves the owner.
    await caller(23).team.bulkChangeRole({ memberIds: [8, 5], role: "admin" });
    expect(row("workspace_members", 8).role).toBe("admin");
    expect(row("workspace_members", 5).role).toBe("admin");
  });

  it("deactivate refuses the workspace's owner, as delete does", async () => {
    addSecondSuper();
    const r = await refusal(caller(26).team.deactivate({ memberId: 4, reassignToUserId: 22 }));
    expect(r.code).toBe("BAD_REQUEST");
    expect(r.message).toMatch(/owns the workspace/);
    expect(row("workspace_members", 4).deactivatedAt).toBeNull();
  });

  it("bulk deactivate skips the owner", async () => {
    addSecondSuper();
    const out = await caller(26).team.bulkDeactivate({ memberIds: [4], reassignToUserId: 22 });
    expect(out).toMatchObject({ deactivated: 0, skipped: 1 });
    expect(row("workspace_members", 4).deactivatedAt).toBeNull();
  });

  it("control: deactivating a rep still works", async () => {
    await caller(20).team.deactivate({ memberId: 3, reassignToUserId: 20 });
    expect(row("workspace_members", 3).deactivatedAt).not.toBeNull();
  });

  it("the inline role select asks before it changes anyone's role", () => {
    const team = strip(read("client/src/pages/usip/Team.tsx"));
    const select = between(team, `<select aria-label="Role"`, `</select>`);
    expect(select).toContain("confirmAction({");
    expect(select).toMatch(/\}, \(\) => changeRole\.mutate\(\{ memberId: m\.memberId, role \}\)\);/);
    expect(select).not.toMatch(/onChange=\{\(e\) => changeRole\.mutate/);
    expect(roleLabel("admin")).toBe("an admin");
    expect(roleLabel("super_admin")).toBe("a super admin");
  });
});

/* ─── G46 ──────────────────────────────────────────────────────────────── */

describe("G46: an admin acts only on members below them", () => {
  it("an admin can't change a fellow admin's quota, title or permissions, or reactivate one", async () => {
    rows("workspace_members").find((m) => m.id === 2).deactivatedAt = null;
    expect((await refusal(caller(20).team.setQuota({ memberId: 2, quota: 5 }))).code).toBe("FORBIDDEN");
    expect((await refusal(caller(20).team.setTitle({ memberId: 2, title: "Intern" }))).code).toBe("FORBIDDEN");
    expect((await refusal(caller(20).team.setPermissions({ memberId: 2, permissions: { export_data: false } }))).code).toBe("FORBIDDEN");
    expect(row("workspace_members", 2)).toMatchObject({ quota: null, title: null });
    expect(rows("member_permissions")).toHaveLength(0);
    // …nor a super admin, deactivated or not.
    expect((await refusal(caller(20).team.reactivate({ memberId: 5 }))).code).toBe("FORBIDDEN");
    expect(row("workspace_members", 5).deactivatedAt).not.toBeNull();
    expect((await refusal(caller(20).team.setQuota({ memberId: 4, quota: 1 }))).code).toBe("FORBIDDEN");
  });

  it("control: an admin can do all four to a rep, and set their own quota and title", async () => {
    await caller(20).team.setQuota({ memberId: 3, quota: 5000 });
    await caller(20).team.setTitle({ memberId: 3, title: "AE" });
    await caller(20).team.setPermissions({ memberId: 3, permissions: { export_data: false } });
    expect(row("workspace_members", 3)).toMatchObject({ quota: "5000", title: "AE" });
    expect(rows("member_permissions")).toHaveLength(1);
    row("workspace_members", 3).deactivatedAt = new Date();
    await caller(20).team.reactivate({ memberId: 3 });
    expect(row("workspace_members", 3).deactivatedAt).toBeNull();
    await caller(20).team.setTitle({ memberId: 1, title: "Head of Sales" });
    expect(row("workspace_members", 1).title).toBe("Head of Sales");
  });

  it("another workspace's member is not found", async () => {
    expect((await refusal(caller(23).team.setQuota({ memberId: 7, quota: 1 }))).code).toBe("NOT_FOUND");
    expect((await refusal(caller(23).team.reactivate({ memberId: 7 }))).code).toBe("NOT_FOUND");
  });
});

/* ─── G47 + G68 invite email ───────────────────────────────────────────── */

describe("G47: an invite says whether its email went", () => {
  it("a failed send is reported, with the reason", async () => {
    h.emailResult = { ok: false, reason: "No system sender is set" };
    const res = await caller(20).team.invite({ email: "new@lsi.example", role: "rep" });
    expect(res.emailSent).toBe(false);
    expect(res.emailError).toBe("No system sender is set");
    expect(inviteResult(res)).toMatchObject({ tone: "warning" });
    expect(inviteResult(res).text).toContain("No system sender is set");
  });

  it("control: a send that went is reported as sent", async () => {
    const res = await caller(20).team.invite({ email: "new2@lsi.example", role: "rep" });
    expect(res.emailSent).toBe(true);
    expect(inviteResult(res)).toEqual({ tone: "success", text: "Invitation email sent" });
  });

  it("no email asked for is not a failure", async () => {
    const res = await caller(20).team.invite({ email: "new3@lsi.example", role: "rep", sendEmail: false });
    expect(res).toMatchObject({ emailSent: false, emailError: null });
    expect(h.emails).toHaveLength(0);
    expect(inviteResult(res).tone).toBe("success");
  });

  it("names typed by people are escaped in the email (G68)", async () => {
    row("workspaces", LSI).name = `Acme <b onmouseover="x()">`;
    await caller(20).team.invite({ email: "x@lsi.example", name: `<img src=x onerror=alert(1)>`, role: "rep" });
    const html = h.emails[0]!.html;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain(`<b onmouseover`);
  });

  it("0 days means the invitation never expires", async () => {
    await caller(20).team.updateInviteExpiry({ days: 0 });
    expect(rows("workspace_settings").find((s) => s.workspaceId === LSI).inviteExpiryDays).toBe(0);
    await caller(20).team.invite({ email: "forever@lsi.example", role: "rep", sendEmail: false });
    const u = rows("users").find((x) => x.email === "forever@lsi.example");
    const m = rows("workspace_members").find((x) => x.userId === u.id);
    expect(m.inviteToken).toBeTruthy();
    expect(m.inviteExpiresAt).toBeNull();
  });

  it("the resend paths report the send too", async () => {
    const res = await caller(20).team.invite({ email: "pending@lsi.example", role: "rep", sendEmail: false });
    const m = rows("workspace_members").find((x) => x.userId === res.userId);
    h.emailResult = { ok: false, reason: "SMTP refused" };
    const resent = await caller(20).team.resendInvitation({ memberId: m.id });
    expect(resent).toMatchObject({ emailSent: false, emailError: "SMTP refused" });
  });
});

/* ─── G68 ──────────────────────────────────────────────────────────────── */

describe("G68: the smaller Settings defects", () => {
  it("seats count members who can sign in, not deactivated ones", async () => {
    const usage = await caller(23).usage.currentMonth();
    // LSI has six memberships, one deactivated.
    expect(Number(usage.seatsUsed)).toBe(5);
  });

  it("a time zone must be a real one", async () => {
    expect((await refusal(caller(20).settings.save({ timezone: "Eastern-ish" }))).code).toBe("BAD_REQUEST");
    await caller(20).settings.save({ timezone: "America/New_York" });
    expect(rows("workspace_settings").find((s) => s.workspaceId === LSI).timezone).toBe("America/New_York");
  });

  it("a voice agent's owner must work here", async () => {
    const base = { name: "Front desk", purpose: "outbound_outreach" as const, voice: "eve", status: "active" as const };
    expect((await refusal(caller(20).voiceAgents.create({ ...base, ownerUserId: 10 }))).code).toBe("BAD_REQUEST");
    expect((await refusal(caller(20).voiceAgents.create({ ...base, ownerUserId: 24 }))).code).toBe("BAD_REQUEST");
    await caller(20).voiceAgents.create({ ...base, ownerUserId: 22 });
    const id = rows("voice_agents")[0].id;
    expect((await refusal(caller(20).voiceAgents.update({ id, ownerUserId: 10 }))).code).toBe("BAD_REQUEST");
    expect(row("voice_agents", id).ownerUserId).toBe(22);
  });

  it("whole-table row counts go to the platform owner only", async () => {
    h.db.execute = async () => [[{ n: 7 }]];
    const asAdmin: any[] = await caller(20).dangerZone.tableStatus({ tables: ["leads"] });
    expect(asAdmin).toEqual([{ table: "leads", exists: true, rows: null }]);
    rows("users").find((u) => u.id === 20).role = "admin";
    const asOwner: any[] = await caller(20).dangerZone.tableStatus({ tables: ["leads"] });
    expect(asOwner).toEqual([{ table: "leads", exists: true, rows: 7 }]);
  });

  it("the CRM card says what is true", () => {
    const hub = read("client/src/pages/usip/SettingsHub.tsx").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(hub).not.toContain("Your team has not connected a CRM");
    expect(hub).toContain("Connecting an outside CRM such as Salesforce or HubSpot isn't available yet.");
  });
});

/* ─── G16 ──────────────────────────────────────────────────────────────── */

describe("G16: saving an integration keeps its stored secret", () => {
  beforeEach(() => {
    rows("workspace_integrations").push({ id: 90, workspaceId: LSI, provider: "webhook", status: "connected", config: { url: "https://a.example/hook", secret: "s3cret" } });
  });

  it("the form's draft is the redacted row, and saving it changes the URL without losing the secret", async () => {
    const listed: any[] = await caller(20).integrations.list();
    const draft = { ...listed.find((r) => r.provider === "webhook").config, url: "https://b.example/hook" };
    expect(draft).toEqual({ url: "https://b.example/hook", hasSecret: true });
    await caller(20).integrations.save({ provider: "webhook", config: draft, status: "connected" });
    expect(row("workspace_integrations", 90).config).toEqual({ url: "https://b.example/hook", secret: "s3cret" });
  });

  it("a typed secret replaces it, and a blank one keeps it", async () => {
    await caller(20).integrations.save({ provider: "webhook", config: { url: "https://a.example/hook", secret: "" } });
    expect(row("workspace_integrations", 90).config.secret).toBe("s3cret");
    await caller(20).integrations.save({ provider: "webhook", config: { url: "https://a.example/hook", secret: "n3w" } });
    expect(row("workspace_integrations", 90).config.secret).toBe("n3w");
  });

  it("a flag an earlier save stored in place of the secret is dropped", () => {
    expect(mergeIntegrationConfig({ url: "u", hasSecretKey: true }, { url: "u", publishableKey: "pk" })).toEqual({ url: "u", publishableKey: "pk" });
    expect(redactIntegrationConfig({ secretKey: "sk" })).toEqual({ hasSecretKey: true });
  });
});

/* ─── G52 / O43 ────────────────────────────────────────────────────────── */

describe("G52/O43: sender pools take a manager, and hold each account once", () => {
  beforeEach(() => {
    rows("sending_accounts").push(
      { id: 70, workspaceId: LSI, name: "A", fromEmail: "a@lsi.example", provider: "generic_smtp", unipileAccountId: null, enabled: true },
      { id: 71, workspaceId: LSI, name: "B", fromEmail: "b@lsi.example", provider: "generic_smtp", unipileAccountId: null, enabled: true },
    );
    rows("sender_pools").push({ id: 60, workspaceId: LSI, name: "Main", rotationStrategy: "round_robin" });
    rows("sender_pool_members").push({ id: 61, workspaceId: LSI, poolId: 60, accountId: 70, weight: 10, position: 0 });
  });

  it("a rep can't create, edit or rewire a pool", async () => {
    const rep = caller(22).senderPools;
    for (const p of [
      rep.create({ name: "Mine", members: [{ accountId: 70 }] } as any),
      rep.update({ id: 60, name: "Renamed" } as any),
      rep.addMember({ poolId: 60, accountId: 71 }),
      rep.removeMember({ memberId: 61 }),
      rep.updateMemberWeight({ memberId: 61, weight: 50 }),
    ]) {
      expect((await refusal(p)).message).toBe("Requires manager role");
    }
    expect(row("sender_pools", 60).name).toBe("Main");
    expect(rows("sender_pool_members")).toHaveLength(1);
    expect(row("sender_pool_members", 61).weight).toBe(10);
  });

  it("a manager can, and an account goes into a pool once", async () => {
    const mgr = caller(25).senderPools;
    expect((await refusal(mgr.addMember({ poolId: 60, accountId: 70 }))).code).toBe("CONFLICT");
    await mgr.addMember({ poolId: 60, accountId: 71 });
    expect(rows("sender_pool_members").filter((m) => m.poolId === 60).map((m) => m.accountId).sort()).toEqual([70, 71]);
    const { id } = await mgr.create({ name: "Twice", members: [{ accountId: 70 }, { accountId: 70 }, { accountId: 71 }] } as any);
    expect(rows("sender_pool_members").filter((m) => m.poolId === id).map((m) => m.accountId)).toEqual([70, 71]);
    await mgr.update({ id, members: [{ accountId: 71 }, { accountId: 71 }] } as any);
    expect(rows("sender_pool_members").filter((m) => m.poolId === id).map((m) => m.accountId)).toEqual([71]);
  });

  it("the page offers creating to managers and deleting to admins only", () => {
    const page = strip(read("client/src/pages/usip/SenderPools.tsx"));
    expect(page).toContain("const canEdit = rankOf(current?.role) >= ROLE_RANK.manager;");
    expect(page).toContain("const canDelete = isAdminRole(current?.role);");
    expect(page).toMatch(/\{canEdit && <Button onClick=\{\(\) => setShowCreate\(true\)\}/);
    expect(page).toMatch(/\{canDelete && <Button\s+size="icon"/);
  });
});

/* ─── G7 ───────────────────────────────────────────────────────────────── */

describe("G7: SCIM filters, reports `active`, and deactivates", () => {
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
  const call = async (key: string, opts: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> } = {}) => {
    const res: any = { statusCode: 200, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; }, end() { return this; } };
    await routes[key]({ params: opts.params ?? {}, body: opts.body ?? {}, query: opts.query ?? {}, method: key.split(" ")[0], scimProvider: { id: 1, workspaceId: LSI } }, res);
    return res;
  };

  it("an IdP's lookup by userName finds that person, not the whole workspace", async () => {
    const found = await call("GET /api/scim/v2/Users", { query: { filter: 'userName eq "REP@lsi.example"' } });
    expect(found.body.totalResults).toBe(1);
    expect(found.body.Resources.map((r: any) => r.userName)).toEqual(["rep@lsi.example"]);
    const none = await call("GET /api/scim/v2/Users", { query: { filter: 'userName eq "nobody@lsi.example"' } });
    expect(none.body).toMatchObject({ totalResults: 0, Resources: [] });
    const byEmail = await call("GET /api/scim/v2/Users", { query: { filter: 'emails.value eq "owner@lsi.example"' } });
    expect(byEmail.body.Resources.map((r: any) => r.id)).toEqual(["23"]);
  });

  it("a filter it can't read is refused, never answered with everyone", async () => {
    const bad = await call("GET /api/scim/v2/Users", { query: { filter: 'displayName co "User"' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.scimType).toBe("invalidFilter");
    expect(parseScimFilter('userName eq "a\\"b"')).toEqual({ attr: "userName", value: 'a"b' });
    expect(parseScimFilter(undefined)).toBeNull();
  });

  it("control: no filter lists this workspace's people, with paging", async () => {
    const all = await call("GET /api/scim/v2/Users");
    expect(all.body.totalResults).toBe(6);
    const page = await call("GET /api/scim/v2/Users", { query: { startIndex: "2", count: "2" } });
    expect(page.body).toMatchObject({ totalResults: 6, startIndex: 2, itemsPerPage: 2 });
  });

  it("`active` is the membership's, not a constant", async () => {
    expect((await call("GET /api/scim/v2/Users/:id", { params: { id: "24" } })).body.active).toBe(false);
    expect((await call("GET /api/scim/v2/Users/:id", { params: { id: "22" } })).body.active).toBe(true);
  });

  it("PATCH active=false deactivates the membership, and active=true brings it back", async () => {
    const off = await call("PATCH /api/scim/v2/Users/:id", { params: { id: "22" }, body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", path: "active", value: "False" }] } });
    expect(off.statusCode).toBe(200);
    expect(off.body.active).toBe(false);
    expect(row("workspace_members", 3).deactivatedAt).not.toBeNull();
    const on = await call("PATCH /api/scim/v2/Users/:id", { params: { id: "22" }, body: { Operations: [{ op: "replace", value: { active: true } }] } });
    expect(on.body.active).toBe(true);
    expect(row("workspace_members", 3).deactivatedAt).toBeNull();
  });

  it("DELETE deactivates too: the membership stays, so no fresh workspace appears", async () => {
    // A platform owner would otherwise be given one (G10), which makes this
    // the case where a deleted row would show.
    rows("users").find((u) => u.id === 22).role = "admin";
    const del = await call("DELETE /api/scim/v2/Users/:id", { params: { id: "22" } });
    expect(del.statusCode).toBe(204);
    expect(row("workspace_members", 3)).toMatchObject({ workspaceId: LSI, userId: 22 });
    expect(row("workspace_members", 3).deactivatedAt).not.toBeNull();
    expect(await caller(22, null).workspace.list()).toEqual([]);
    expect(rows("workspaces")).toHaveLength(2);
  });

  it("an IdP can't remove the last active super admin, or the owner", async () => {
    // Owned by an admin here, so it is the super-admin rule that refuses.
    row("workspaces", LSI).ownerUserId = 20;
    const r = await call("PATCH /api/scim/v2/Users/:id", { params: { id: "23" }, body: { active: false } });
    expect(r.statusCode).toBe(409);
    expect(r.body.detail).toMatch(/only active super admin/);
    expect(row("workspace_members", 4).deactivatedAt).toBeNull();
    row("workspaces", LSI).ownerUserId = 23;
    addSecondSuper();
    const owner = await call("DELETE /api/scim/v2/Users/:id", { params: { id: "23" } });
    expect(owner.statusCode).toBe(409);
    expect(owner.body.detail).toMatch(/owns the workspace/);
    expect(row("workspace_members", 4).deactivatedAt).toBeNull();
    // control: the second super admin can go, the owner remains.
    expect((await call("DELETE /api/scim/v2/Users/:id", { params: { id: "26" } })).statusCode).toBe(204);
  });

  it("reads `active` from every shape IdPs send", () => {
    expect(requestedActive({ active: false })).toBe(false);
    expect(requestedActive({ Operations: [{ op: "replace", path: "active", value: false }] })).toBe(false);
    expect(requestedActive({ Operations: [{ op: "Replace", value: { active: "True" } }] })).toBe(true);
    expect(requestedActive({ displayName: "x" })).toBeUndefined();
    expect(requestedActive({ Operations: [{ op: "remove", path: "active" }] })).toBeUndefined();
  });
});

/* ─── G49 ──────────────────────────────────────────────────────────────── */

describe("G49: SCIM tokens are hashed and audited; CSV cells can't run formulas", () => {
  it("a new token is shown once and stored as a hash; the list carries none", async () => {
    const { bearerToken } = await caller(20).scim.createProvider({ name: "Okta" });
    const stored = rows("scim_providers")[0];
    expect(stored.bearerToken).toBe(hashScimToken(bearerToken));
    expect(stored.bearerToken).not.toContain(bearerToken);
    const listed: any[] = await caller(20).scim.listProviders();
    expect(listed[0]).not.toHaveProperty("bearerToken");
    expect(JSON.stringify(listed)).not.toContain(bearerToken);
    const ok = await verifyScimBearer(`Bearer ${bearerToken}`);
    expect(ok.ok).toBe(true);
    expect((await verifyScimBearer(`Bearer ${stored.bearerToken}`)).ok, "the hash is not itself a token").toBe(false);
    expect(h.audits.some((a) => a.entityType === "scim_provider" && a.action === "create")).toBe(true);
  });

  it("rotating stores the new hash and audits it", async () => {
    const { bearerToken: first } = await caller(20).scim.createProvider({ name: "Okta" });
    const id = rows("scim_providers")[0].id;
    const { bearerToken: second } = await caller(20).scim.rotateToken({ id });
    expect(row("scim_providers", id).bearerToken, "stored hashed from the start").toBe(hashScimToken(second));
    expect((await verifyScimBearer(`Bearer ${first}`)).ok).toBe(false);
    expect((await verifyScimBearer(`Bearer ${second}`)).ok).toBe(true);
    expect(h.audits.some((a) => a.entityType === "scim_provider" && a.after?.tokenRotated)).toBe(true);
  });

  it("a token stored before hashing still works once, and is hashed on that use", async () => {
    rows("scim_providers").push({ id: 5, workspaceId: LSI, name: "Legacy", bearerToken: "scim_legacy-plain", enabled: true });
    expect((await verifyScimBearer("Bearer scim_legacy-plain")).ok).toBe(true);
    expect(row("scim_providers", 5).bearerToken).toBe(hashScimToken("scim_legacy-plain"));
    expect((await verifyScimBearer("Bearer scim_legacy-plain")).ok).toBe(true);
  });

  it("a cell that would be a formula is written as text", () => {
    expect(csvCell('=HYPERLINK("https://evil.example","Open")')).toBe(`"'=HYPERLINK(""https://evil.example"",""Open"")"`);
    for (const lead of ["+1+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1"]) expect(csvCell(lead).replace(/^"/, "")[0], lead).toBe("'");
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell(null)).toBe("");
  });

  it("every CSV writer uses that one cell, and no copy of the old escaper is left", () => {
    for (const f of ["server/routers/reports.ts", "server/routers/operations.ts", "server/emailTracking.ts", "server/routers/are/prospects.ts", "client/src/components/usip/people/SelectionToolbar.tsx"]) {
      const src = strip(read(f));
      expect(src, f).toContain('import { csvCell } from "@shared/csvCell";');
      expect(src, f).not.toMatch(/replace\(\/"\/g, '""'\)/);
    }
  });

  it("the audit page shows times, and doesn't claim a completeness it lacks", () => {
    const audit = read("client/src/pages/usip/Audit.tsx");
    expect(audit).not.toContain("A complete audit trail");
    expect(audit).toContain("<span>{fmtDateTime(a.createdAt)}</span>");
  });
});

/* ─── G11 ──────────────────────────────────────────────────────────────── */

describe("G11: a tab asking for a workspace it can't use is refused", () => {
  it("another workspace's id is refused, not answered from the caller's own", async () => {
    const r = await refusal(caller(22, CF).workspace.current());
    expect(r).toEqual({ code: "FORBIDDEN", message: WORKSPACE_UNAVAILABLE_ERR_MSG });
    const write = await refusal(caller(22, CF).senderPools.list());
    expect(write.message).toBe(WORKSPACE_UNAVAILABLE_ERR_MSG);
  });

  it("so is a workspace they were deactivated from, while active in another", async () => {
    rows("workspace_members").push({ id: 30, workspaceId: CF, userId: 22, role: "rep", deactivatedAt: new Date(), inviteToken: null, lastActiveAt: new Date(), createdAt: new Date() });
    expect((await refusal(caller(22, CF).workspace.current())).message).toBe(WORKSPACE_UNAVAILABLE_ERR_MSG);
  });

  it("control: no header still lands in their workspace, and their own header works", async () => {
    expect((await caller(22, null).workspace.current()).workspace.id).toBe(LSI);
    expect((await caller(22, LSI).workspace.current()).workspace.id).toBe(LSI);
  });

  it("the client reloads its list on that refusal and moves the tab", () => {
    const main = strip(read("client/src/main.tsx"));
    expect(main).toContain("if (error.message !== WORKSPACE_UNAVAILABLE_ERR_MSG) return;");
    expect(main).toContain("window.dispatchEvent(new Event(WORKSPACE_UNAVAILABLE_EVENT));");
    expect(main.match(/flagWorkspaceUnavailable\(event\.(query|mutation)\.state\.error\);/g)).toHaveLength(2);
    const ctx = strip(read("client/src/contexts/WorkspaceContext.tsx"));
    expect(ctx).toContain("window.addEventListener(WORKSPACE_UNAVAILABLE_EVENT, onUnavailable);");
    expect(ctx).toContain("void utils.workspace.list.invalidate();");
  });
});

/* ─── P114 ─────────────────────────────────────────────────────────────── */

describe("P114: switching workspace clears the old one's cached data", () => {
  it("everything but the workspace list is reset, not just invalidated", () => {
    expect(keepAcrossWorkspaceSwitch([["workspace", "list"], { type: "query" }])).toBe(true);
    expect(keepAcrossWorkspaceSwitch([["leads", "list"], { input: {}, type: "query" }])).toBe(false);
    expect(keepAcrossWorkspaceSwitch([["workspace", "current"], { type: "query" }])).toBe(false);
    const ctx = strip(read("client/src/contexts/WorkspaceContext.tsx"));
    expect(ctx).toContain("void queryClient.resetQueries({ predicate: (q) => !keepAcrossWorkspaceSwitch(q.queryKey) });");
    const switchTo = between(ctx, "const switchTo = useCallback(", "[clearWorkspaceData],");
    expect(switchTo).toContain("clearWorkspaceData();");
    expect(switchTo).not.toContain("utils.invalidate()");
  });
});

/* ─── G35 + G10 ────────────────────────────────────────────────────────── */

describe("G35: someone with no workspace to work in is told why", () => {
  it("workspace.access names the reason", async () => {
    expect(await caller(22, null).workspace.access()).toEqual({ state: "member" });
    row("workspace_members", 3).deactivatedAt = new Date();
    expect(await caller(22, null).workspace.access()).toEqual({ state: "deactivated" });
    row("workspace_members", 3).deactivatedAt = null;
    row("workspace_members", 3).inviteToken = "t".repeat(64);
    expect(await caller(22, null).workspace.access()).toEqual({ state: "invite_pending" });
    rows("users").push({ id: 40, openId: "local:40", name: "New", email: "new@else.example", role: "user" });
    expect(await caller(40, null).workspace.access()).toEqual({ state: "none" });
  });

  it("the screen says so in plain words, and offers sign-out", () => {
    const html = (p: any, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(WorkspaceAccessScreen, { problem: p, ...extra }));
    expect(html("deactivated")).toContain("Your access has been removed");
    expect(html("invite_pending")).toContain("Your invitation is waiting");
    expect(html("none")).toContain("You&#x27;re not in a workspace yet");
    const archived = html("archived", { workspaceName: "LSI Media", others: [{ id: 4, name: "CommunityForce" }], onSwitch: () => {} });
    expect(archived).toContain("This workspace is archived");
    expect(archived).toContain("CommunityForce");
    for (const p of ["deactivated", "invite_pending", "none", "archived"]) expect(html(p)).toContain("Sign out");
  });

  it("every authed page goes through the gate", () => {
    const app = strip(read("client/src/App.tsx"));
    expect(app).toContain("<WorkspaceAccessGate>{children}</WorkspaceAccessGate>");
    const gate = strip(read("client/src/components/usip/WorkspaceAccessGate.tsx"));
    expect(gate).toContain("const empty = !isLoading && workspaces.length === 0;");
    expect(gate).toContain("if (current && !canOpenWorkspace(current)) {");
  });
});

describe("G10: signing up does not make a stranger super_admin of a workspace", () => {
  it("a self-registered account with no membership gets none", async () => {
    rows("users").push({ id: 40, openId: "local:40", name: "Stranger", email: "s@else.example", role: "user" });
    expect(await caller(40, null).workspace.list()).toEqual([]);
    expect(rows("workspaces")).toHaveLength(2);
    expect(rows("workspace_members").filter((m) => m.userId === 40)).toHaveLength(0);
  });

  it("control: the platform owner still gets one, and so does the first sign-in on an empty database", async () => {
    rows("users").push({ id: 41, openId: "local:41", name: "Owner", email: "o@else.example", role: "admin" });
    const mine: any[] = await caller(41, null).workspace.list();
    expect(mine).toHaveLength(1);
    expect(mine[0].role).toBe("super_admin");

    h.db = makeSqlFakeDb({ realMembers: true });
    rows("users").push({ id: 42, openId: "local:42", name: "First", email: "f@else.example", role: "user" });
    expect(await caller(42, null).workspace.list()).toHaveLength(1);
  });
});

/* ─── G36 ──────────────────────────────────────────────────────────────── */

describe("G36: archived workspaces are badged, and their public pages stop", () => {
  const archive = () => { row("workspaces", LSI).archivedAt = new Date(); invalidateArchivedWorkspaceCache(); };
  const anon = () => appRouter.createCaller({ user: null, req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } }, res: {} } as any);
  beforeEach(() => {
    rows("forms").push({ id: 80, workspaceId: LSI, publicId: "pub80", title: "Contact", fields: [], status: "active", redirectUrl: null, autoCreateLead: false });
    rows("landing_pages").push({ id: 81, workspaceId: LSI, slug: "spring", status: "published", autoCreateLead: false, viewCount: 0 });
    rows("booking_links").push({ id: 82, workspaceId: LSI, userId: 22, slug: "rep-30", active: true, durationMin: 30, title: "Call" });
    rows("chat_agents").push({ id: 83, workspaceId: LSI, slug: "help", status: "published", mode: "auto", displayName: "Elsie", greeting: "Hi", themeColor: "#123456", name: "Help" });
  });

  it("the switcher's list says which are archived, and only a super admin may open one", async () => {
    archive();
    const mine: any[] = await caller(23, null).workspace.list();
    expect(mine[0].archivedAt).toBeInstanceOf(Date);
    const fn = between(strip(read("server/db.ts")), "export async function getUserWorkspaces(", ".from(workspaceMembers)");
    expect(fn).toContain("archivedAt: workspaces.archivedAt,");
    expect(canOpenWorkspace({ id: 1, role: "admin", archivedAt: new Date() })).toBe(false);
    expect(canOpenWorkspace({ id: 1, role: "super_admin", archivedAt: new Date() })).toBe(true);
    expect(canOpenWorkspace({ id: 1, role: "rep", archivedAt: null })).toBe(true);
    const list = [{ id: 2, role: "rep", archivedAt: new Date() }, { id: 4, role: "rep", archivedAt: null }];
    expect(chooseWorkspace(list, 2)?.id, "a tab on an archived workspace moves").toBe(4);
    expect(chooseWorkspace(list, null)?.id).toBe(4);
    for (const f of ["client/src/components/usip/Shell.tsx", "client/src/pages/usip/SettingsHub.tsx"]) {
      expect(read(f), f).toContain("disabled={!canOpenWorkspace(w)}");
    }
  });

  it("forms, landing pages, booking links and chat agents stop serving and taking submissions", async () => {
    archive();
    expect(await anon().forms.getByPublicId({ publicId: "pub80" })).toBeNull();
    expect((await refusal(anon().forms.submit({ publicId: "pub80", data: { email: "v@x.example" } }))).code).toBe("NOT_FOUND");
    expect((await refusal(anon().landingPages.getBySlug({ slug: "spring" }))).code).toBe("NOT_FOUND");
    expect((await refusal(anon().landingPages.submit({ slug: "spring", data: { email: "v@x.example" } }))).code).toBe("NOT_FOUND");
    expect((await refusal(anon().bookingLinks.getPublic({ slug: "rep-30" }))).code).toBe("NOT_FOUND");
    expect((await refusal(anon().chatAgents.getPublic({ slug: "help" }))).code).toBe("NOT_FOUND");
    expect((await refusal(anon().chatAgents.send({ slug: "help", message: "hello" }))).code).toBe("NOT_FOUND");
    expect(rows("leads")).toHaveLength(0);
    expect(rows("form_submissions")).toHaveLength(0);
  });

  it("control: a live workspace's form and chat agent are served", async () => {
    expect(await anon().forms.getByPublicId({ publicId: "pub80" })).toMatchObject({ title: "Contact" });
    expect(await anon().chatAgents.getPublic({ slug: "help" })).toMatchObject({ displayName: "Elsie" });
  });

  it("the shared booking path refuses too, so the chat agent can't book into it", () => {
    const booking = strip(read("server/routers/bookingLinks.ts"));
    const path = between(booking, "export async function bookSlotForLink(", "const openSlots = await openSlotsForLink(link);");
    expect(path).toMatch(/if \(!\(await isWorkspaceLive\(link\.workspaceId\)\)\) \{\s*throw new TRPCError\(\{ code: "NOT_FOUND"/);
    expect(strip(read("server/chatWidget.ts"))).toContain(`a.mode === "off" || !(await isWorkspaceLive(a.workspaceId))`);
  });
});

/* ─── G48 ──────────────────────────────────────────────────────────────── */

describe("G48: the Danger zone offers super-admin actions to super admins", () => {
  const danger = () => between(strip(read("client/src/pages/usip/Settings.tsx")), "function DangerTab(", "\n}\n");

  it("every action's button is off for a plain admin", () => {
    const d = danger();
    expect(d).toContain("const superOnly = canEdit && isSuperAdmin;");
    for (const b of [
      "disabled={!superOnly || exportMut.isPending}",
      "disabled={!superOnly || sampleTotal === 0 || removeSample.isPending}",
      "disabled={!superOnly} onClick={() => setShowTransfer((v) => !v)}",
      "disabled={!superOnly || unarchiveMut.isPending}",
      "disabled={!superOnly} className=\"text-rose-700\" onClick={() => setShowArchive((v) => !v)}",
    ]) expect(d, b).toContain(b);
    expect(d).not.toMatch(/disabled=\{!canEdit[ }]/);
  });

  it("the export is named for what it is: counts, not data", () => {
    const d = danger();
    expect(d).not.toContain("Export all workspace data");
    expect(d).toContain("Download workspace summary");
    expect(d).toContain("Counts only, not the records themselves.");
  });
});

/* ─── C4 ───────────────────────────────────────────────────────────────── */

describe("C4: mailbox OAuth tokens are encrypted, and old plaintext is encrypted once", () => {
  it("create and update store OAuth tokens encrypted; the reader gets them back", async () => {
    const { id } = await caller(20).sendingAccounts.create({ name: "O", provider: "outlook_oauth", fromEmail: "o@lsi.example", oauthAccessToken: "access-1", oauthRefreshToken: "refresh-1" } as any);
    const stored = row("sending_accounts", id);
    expect(stored.oauthAccessToken).not.toContain("access-1");
    expect(decryptField(stored.oauthAccessToken)).toBe("access-1");
    expect(decryptField(stored.oauthRefreshToken)).toBe("refresh-1");
    await caller(20).sendingAccounts.update({ id, oauthAccessToken: "access-2" } as any);
    expect(decryptField(row("sending_accounts", id).oauthAccessToken)).toBe("access-2");
    const sa = strip(read("server/routers/sendingAccounts.ts"));
    expect(sa).toContain("oauthAccessToken: readStoredSecret(account.oauthAccessToken),");
    expect(sa).toContain("oauthAccessToken = readStoredSecret(existing.oauthAccessToken);");
  });

  it("a calendar's OAuth tokens are stored encrypted", async () => {
    await caller(22).calendar.connectOutlookOAuth({ oauthAccessToken: "cal-access", oauthRefreshToken: "cal-refresh" });
    const acct = rows("calendar_accounts")[0];
    expect(decryptField(acct.oauthAccessToken)).toBe("cal-access");
    expect(decryptField(acct.oauthRefreshToken)).toBe("cal-refresh");
  });

  it("the backfill encrypts plaintext, leaves ciphertext alone, and does nothing the second time", async () => {
    const already = encryptField("already-secret");
    // In encryptField's shape but under another key: still ciphertext, so left.
    const foreign = `${"a".repeat(24)}:${"b".repeat(32)}:${"c".repeat(16)}`;
    const touched = new Date("2026-09-01T00:00:00Z");
    rows("sending_accounts").push(
      { id: 1, workspaceId: LSI, smtpPassword: "plain-smtp", imapPassword: already, oauthAccessToken: "plain-access", oauthRefreshToken: null, updatedAt: touched },
      { id: 2, workspaceId: LSI, smtpPassword: foreign, imapPassword: null, oauthAccessToken: null, oauthRefreshToken: null, updatedAt: touched },
    );
    rows("calendar_accounts").push({ id: 3, workspaceId: LSI, oauthAccessToken: "plain-cal", oauthRefreshToken: "plain-cal-r", updatedAt: touched });

    expect(await encryptLegacyMailboxSecrets(h.db)).toEqual({ encrypted: 4 });
    const a = row("sending_accounts", 1);
    expect(decryptField(a.smtpPassword)).toBe("plain-smtp");
    expect(decryptField(a.oauthAccessToken)).toBe("plain-access");
    expect(a.imapPassword).toBe(already);
    expect(a.updatedAt).toEqual(touched);
    expect(row("sending_accounts", 2).smtpPassword).toBe(foreign);
    expect(decryptField(row("calendar_accounts", 3).oauthRefreshToken)).toBe("plain-cal-r");
    expect(readStoredSecret(a.smtpPassword)).toBe("plain-smtp");

    expect(await encryptLegacyMailboxSecrets(h.db)).toEqual({ encrypted: 0 });
    expect(looksEncrypted("hunter2")).toBe(false);
  });

  it("a save that lands while it runs wins", async () => {
    const saved = encryptField("saved-meanwhile");
    h.db = makeSqlFakeDb({
      realMembers: true,
      beforeUpdate: (t) => { if (t === "sending_accounts") rows("sending_accounts")[0].smtpPassword = saved; },
    });
    rows("sending_accounts").push({ id: 1, workspaceId: LSI, smtpPassword: "plain-old", imapPassword: null, oauthAccessToken: null, oauthRefreshToken: null, updatedAt: new Date() });
    await encryptLegacyMailboxSecrets(h.db);
    expect(rows("sending_accounts")[0].smtpPassword).toBe(saved);
  });
});
