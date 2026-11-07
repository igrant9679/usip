/**
 * Team and 2FA setup (audit 2026-10-20, U21; final pass 2026-11-07): an MFA
 * column on Team, "N members have no authenticator" before an admin turns on
 * required 2FA, and a QR code in authenticator setup. All three prevent the
 * lock-outs G15 was about.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import QRCode from "qrcode";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, `anchor "${from}"`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b, `anchor "${to}"`).toBeGreaterThan(-1);
  return src.slice(a, b);
};

const WS = 2;
function caller(userId: number) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {}, cookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
  const user = (id: number, name: string, mfa: boolean) => ({
    id, openId: `local:${id}`, name, email: `u${id}@lsi.example`, role: "user", loginMethod: "password",
    passwordHash: null, mfaTotpSecret: mfa ? "JBSWY3DPEHPK3PXP" : null, mfaTotpEnabledAt: mfa ? new Date() : null, sessionVersion: 0,
  });
  rows("users").push(
    user(1, "Owner", false), user(2, "Admin With App", true), user(3, "Rep Without", false),
    user(4, "Gone Rep", false), user(5, "Invited Rep", false), user(6, "Manager With App", true), user(7, "Rep Two", false),
  );
  const member = (id: number, userId: number, role: string, over: Record<string, unknown> = {}) => ({
    id, workspaceId: WS, userId, role, deactivatedAt: null, inviteToken: null, lastActiveAt: new Date(), createdAt: new Date(), ...over,
  });
  rows("workspace_members").push(
    member(1, 1, "super_admin"), member(2, 2, "admin"), member(3, 3, "rep"),
    member(4, 4, "rep", { deactivatedAt: new Date("2026-10-01T00:00:00Z") }),
    member(5, 5, "rep", { inviteToken: "t".repeat(40) }),
    member(6, 6, "manager"), member(7, 7, "rep"),
    // Another workspace's member without 2FA does not count here.
    { id: 8, workspaceId: 9, userId: 3, role: "rep", deactivatedAt: null, inviteToken: null },
  );
});

describe("N members have no authenticator, counted as the gate counts", () => {
  it("counts the active, accepted members the requirement would stop", async () => {
    const out = await caller(2).team.mfaCoverage();
    // Gated: admin 2, rep 3, manager 6, rep 7. Not the super admin (never
    // blocked), the deactivated rep, or the unaccepted invitation.
    expect(out.gated).toBe(4);
    expect(out.withoutAuthenticator).toBe(2);
    expect(out.names.slice().sort()).toEqual(["Rep Two", "Rep Without"]);
  });

  it("is for admins", async () => {
    await expect(caller(3).team.mfaCoverage()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("Settings → Security says so, and asks before turning the requirement on", () => {
    const tab = between(read("client/src/pages/usip/Settings.tsx"), "function SecurityTab(", "IP allowlist (one per line");
    expect(tab).toContain("trpc.team.mfaCoverage.useQuery(undefined, { enabled: canEdit })");
    const save = between(tab, "onClick={() => {", "doSave();\n            }}");
    expect(save).toContain("if (enforce2fa && !settings?.enforce2fa && withoutMfa > 0) {");
    expect(save).toContain("confirmAction({");
    expect(save).toContain("}, doSave);");
    const note = between(tab, 'data-testid="mfa-coverage"', "</div>");
    expect(note).toContain("no authenticator");
  });
});

describe("the Team page has a 2FA column", () => {
  it("a header and a cell for every member: the 2FA pill or Not set up", () => {
    const src = read("client/src/pages/usip/Team.tsx");
    const head = between(src, "<thead", "</thead>");
    expect(head).toContain('<th className="px-3 py-2">2FA</th>');
    const cell = between(src, 'data-testid="member-mfa"', "</td>");
    expect(cell).toContain("Number(m.mfaEnabled) === 1 ?");
    expect(cell).toContain("<ShieldCheck className=\"size-2.5\" /> 2FA");
    expect(cell).toContain("Not set up");
  });
});

describe("authenticator setup has a QR code", () => {
  it("startTotpEnrollment returns the otpauth URL drawn as an SVG QR code", async () => {
    const out = await caller(3).profile.startTotpEnrollment();
    expect(out.qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(out.qrDataUrl!.split(",")[1], "base64").toString("utf8");
    expect(svg).toContain("<svg");
    // The picture encodes exactly the key the dialog shows, nothing else.
    expect(svg).toBe(await QRCode.toString(out.otpauthUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M" }));
    expect(out.otpauthUrl).toContain(`secret=${out.secret}`);
  });

  it("the dialog shows it above the key", () => {
    const src = read("client/src/components/usip/settings/TotpSetupDialog.tsx");
    const qr = between(src, "{enroll.qrDataUrl && (", "Setup key (enter manually in your app)");
    expect(qr).toContain("src={enroll.qrDataUrl}");
    expect(qr).toContain('alt="QR code to add Velocity to your authenticator app"');
  });
});
