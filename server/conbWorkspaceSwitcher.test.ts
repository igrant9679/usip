/**
 * The workspace switcher, the tab title and the invitations inbox (audit
 * 2026-10-20, U10; batch CONB, 2026-11-08).
 *
 *   · Both switchers share one list with a search box once there are enough
 *     workspaces, and badge an archived one (open to super admins only).
 *   · The browser tab names the workspace: "Pipeline · LSI Media · Velocity".
 *   · Invitations waiting for the signed-in user are listed (switcher and
 *     no-workspace screen) with Accept, which goes through the same
 *     acceptance as the emailed link; an account still confirming its email
 *     is refused and pointed at the email (F1).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  audits: [] as any[],
  queries: {} as Record<string, unknown>,
  calls: [] as Array<{ path: string; vars: any }>,
  buttons: [] as any[],
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async (e: any) => { h.audits.push(e); } }));
vi.mock("@/lib/trpc", () => {
  const proc = (path: string) => ({
    useQuery: () => h.queries[path] ?? { data: undefined, isLoading: false, error: null },
    useMutation: () => ({ mutate: (vars: any) => { h.calls.push({ path, vars }); }, isPending: false }),
  });
  const utils = new Proxy({}, { get: () => new Proxy({}, { get: () => ({ invalidate: async () => {} }) }) });
  return {
    trpc: new Proxy({ useUtils: () => utils } as Record<string, unknown>, {
      get: (t, r: string) => (r in t ? t[r] : new Proxy({}, { get: (_u, p: string) => proc(`${r}.${p}`) })),
    }),
  };
});
vi.mock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => ({ workspaces: [], current: null, switchTo: () => {}, isLoading: false }) }));
vi.mock("@/components/ui/button", async () => {
  const { createElement: el } = await import("react");
  return { Button: (props: any) => { h.buttons.push(props); return el("button", { "aria-label": props["aria-label"], disabled: props.disabled }, props.children); } };
});

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { pageTitleFor } from "../client/src/lib/usePageTitle";
import { WORKSPACE_SEARCH_MIN, filterWorkspaces } from "../client/src/lib/workspaceSwitcher";
import { WorkspaceSwitchList } from "../client/src/components/usip/WorkspaceSwitchList";
import { PendingInvitations } from "../client/src/components/usip/PendingInvitations";
import { WorkspaceAccessScreen } from "../client/src/components/usip/WorkspaceAccessGate";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const ME = 21, OTHER = 22;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const DAY = 86_400_000;
const caller = (userId = ME) => appRouter.createCaller({
  user: { ...rows("users").find((u) => u.id === userId), loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: {} },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

describe("the tab names the workspace", () => {
  it("page · workspace · Velocity, and public pages as before", () => {
    expect(pageTitleFor("Pipeline", "LSI Media")).toBe("Pipeline · LSI Media · Velocity");
    expect(pageTitleFor("Pipeline", null)).toBe("Pipeline · Velocity");
    expect(pageTitleFor("  ", "LSI Media")).toBe("Velocity — Unified Revenue Intelligence");
  });
  it("the hook reads the current workspace", () => {
    const src = read("client/src/lib/usePageTitle.ts");
    expect(src).toContain("const { current } = useWorkspace();");
    expect(src).toContain("document.title = pageTitleFor(title, workspaceName);");
    expect(src).toContain("}, [title, workspaceName]);");
  });
});

describe("the switcher finds a workspace, and badges an archived one", () => {
  const many = [
    { id: 1, name: "LSI Media", slug: "lsi", role: "admin", archivedAt: null },
    { id: 2, name: "CommunityForce", slug: "cf", role: "admin", archivedAt: null },
    { id: 3, name: "Queue & Co", slug: "demo", role: "admin", archivedAt: new Date() },
    { id: 4, name: "Acme", slug: "acme", role: "rep", archivedAt: null },
    { id: 5, name: "Globex", slug: "globex", role: "rep", archivedAt: null },
    { id: 6, name: "Initech", slug: "initech", role: "rep", archivedAt: null },
  ];
  const list = (workspaces: any[], query = "") => renderToStaticMarkup(createElement(WorkspaceSwitchList, { workspaces, currentId: 1, query, onQuery: () => {}, onPick: () => {} }));

  it("filters by name or slug, ignoring case", () => {
    expect(filterWorkspaces(many, "COMM").map((w) => w.id)).toEqual([2]);
    expect(filterWorkspaces(many, "demo").map((w) => w.id)).toEqual([3]);
    expect(filterWorkspaces(many, "").length).toBe(6);
  });
  it("shows a search box once the list is long, not before", () => {
    expect(WORKSPACE_SEARCH_MIN).toBe(6);
    expect(list(many)).toContain('aria-label="Find a workspace"');
    expect(list(many.slice(0, 3))).not.toContain('aria-label="Find a workspace"');
  });
  it("lists only the matches, and says when none match", () => {
    const html = list(many, "glob");
    expect(html).toContain("Globex");
    expect(html).not.toContain("Initech");
    expect(list(many, "zzz")).toContain("No workspace matches “zzz”");
  });
  it("badges an archived workspace and lets only a super admin open it", () => {
    const html = list(many.slice(0, 3));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Queue &amp; Co.*Archived<\/span><\/button>/s);
    const asOwner = list([{ ...many[2], role: "super_admin" }]);
    expect(asOwner).not.toContain('disabled=""');
    expect(asOwner).toContain("Archived");
  });
  it("both switchers render the one list", () => {
    expect(read("client/src/components/usip/Shell.tsx")).toContain("<WorkspaceSwitchList\n                  detailed");
    expect(read("client/src/pages/usip/SettingsHub.tsx")).toContain("<WorkspaceSwitchList");
  });
});

describe("invitations waiting for you: the server", () => {
  beforeEach(() => {
    h.db = makeSqlFakeDb({ realMembers: true });
    h.audits = [];
    rows("users").push(
      { id: ME, openId: "u21", email: "rita@lsi.example", name: "Rita", emailVerifiedAt: new Date("2026-01-01"), emailVerifyTokenHash: null },
      { id: OTHER, openId: "u22", email: "sam@lsi.example", name: "Sam", emailVerifiedAt: new Date("2026-01-01"), emailVerifyTokenHash: null },
    );
    rows("workspaces").push(
      { id: 2, name: "LSI Media", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" },
      { id: 7, name: "CommunityForce", slug: "cf", ownerUserId: 1, archivedAt: null, plan: "trial" },
      { id: 8, name: "Expired Co", slug: "ex", ownerUserId: 1, archivedAt: null, plan: "trial" },
      { id: 9, name: "Archived Co", slug: "ar", ownerUserId: 1, archivedAt: new Date(), plan: "trial" },
      { id: 10, name: "Not yours", slug: "ny", ownerUserId: 1, archivedAt: null, plan: "trial" },
    );
    const m = (id: number, workspaceId: number, userId: number, o: Record<string, unknown> = {}) =>
      ({ id, workspaceId, userId, role: "rep", deactivatedAt: null, inviteToken: null, inviteExpiresAt: null, createdAt: new Date(Date.now() - DAY), ...o });
    rows("workspace_members").push(
      m(1, 2, ME, { role: "admin" }),
      m(2, 7, ME, { inviteToken: "t".repeat(64), inviteExpiresAt: new Date(Date.now() + 3 * DAY) }),
      m(3, 8, ME, { inviteToken: "e".repeat(64), inviteExpiresAt: new Date(Date.now() - DAY) }),
      m(4, 9, ME, { inviteToken: "a".repeat(64) }),
      m(5, 10, OTHER, { inviteToken: "o".repeat(64) }),
    );
  });

  it("lists the live ones for this person only, and never the token", async () => {
    const list = await caller().team.myInvitations();
    expect(list.map((i: any) => i.workspaceId)).toEqual([7]);
    expect(list[0]).toMatchObject({ memberId: 2, workspaceName: "CommunityForce", role: "rep" });
    expect(JSON.stringify(list)).not.toContain("tttt");
    expect(Object.keys(list[0])).not.toContain("inviteToken");
  });

  it("accepting joins the workspace through the invitation path, and says so in its log", async () => {
    const r = await caller().team.acceptMyInvitation({ memberId: 2 });
    expect(r).toMatchObject({ ok: true, workspaceName: "CommunityForce", workspaceId: 7 });
    expect(rows("workspace_members").find((x) => x.id === 2)).toMatchObject({ inviteToken: null, inviteExpiresAt: null });
    expect(h.audits.some((a) => a.workspaceId === 7 && a.after?.via === "pending_invitations")).toBe(true);
    expect(await caller().team.myInvitations()).toEqual([]);
  });

  it("someone else's invitation is not yours to accept", async () => {
    await expect(caller().team.acceptMyInvitation({ memberId: 5 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rows("workspace_members").find((x) => x.id === 5)?.inviteToken).toBe("o".repeat(64));
  });

  it("an expired one is refused by the same path the link uses", async () => {
    await expect(caller().team.acceptMyInvitation({ memberId: 3 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("an account still confirming its email is pointed at the email, which proves the address (F1)", async () => {
    Object.assign(rows("users").find((u) => u.id === ME), { emailVerifiedAt: null, emailVerifyTokenHash: "h".repeat(64) });
    await expect(caller().team.acceptMyInvitation({ memberId: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(rows("workspace_members").find((x) => x.id === 2)?.inviteToken).toBe("t".repeat(64));
    expect(rows("users").find((u) => u.id === ME)?.emailVerifiedAt).toBeNull();
  });

  it("the emailed link goes through the same function", () => {
    const admin = read("server/routers/admin.ts");
    const link = admin.slice(admin.indexOf("  finaliseAcceptance: protectedProcedure"), admin.indexOf("  myInvitations: protectedProcedure"));
    expect(link).toContain("return acceptInviteByToken(db, ctx.user, input.token);");
    const inbox = admin.slice(admin.indexOf("  acceptMyInvitation: protectedProcedure"), admin.indexOf("   * Protected: set a password for a pending invite user."));
    expect(inbox).toContain("const res = await acceptInviteByToken(db, ctx.user, row.token);");
  });
});

describe("invitations waiting for you: the screens", () => {
  beforeEach(() => { h.calls = []; h.buttons = []; });

  it("lists each with Accept, which accepts that membership", () => {
    h.queries["team.myInvitations"] = { data: [{ memberId: 2, workspaceId: 7, workspaceName: "CommunityForce", role: "rep", expiresAt: null }] };
    const html = renderToStaticMarkup(createElement(PendingInvitations));
    expect(html).toContain('aria-label="Invitations waiting for you"');
    expect(html).toContain("CommunityForce");
    expect(html).toContain('aria-label="Accept the invitation to CommunityForce"');
    h.buttons.find((b) => b["aria-label"] === "Accept the invitation to CommunityForce").onClick();
    expect(h.calls).toContainEqual({ path: "team.acceptMyInvitation", vars: { memberId: 2 } });
  });
  it("shows nothing when nothing is waiting", () => {
    h.queries["team.myInvitations"] = { data: [] };
    expect(renderToStaticMarkup(createElement(PendingInvitations))).toBe("");
  });
  it("the no-workspace screen carries them, and the switcher shows them with a count", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceAccessScreen, { problem: "invite_pending", invitations: createElement("div", null, "INVITES") }));
    expect(html).toContain("INVITES");
    expect(html).toContain("Accept it below");
    expect(read("client/src/components/usip/WorkspaceAccessGate.tsx")).toContain('invitations={<PendingInvitations className="rounded-md border border-border" />}');
    const shell = read("client/src/components/usip/Shell.tsx");
    expect(shell).toContain('<PendingInvitations onAccepted={() => openSwitcher(false)} className="mb-1 border-b border-border pb-1" />');
    expect(shell).toContain("const pendingInvites = (usePendingInvitations().data ?? []).length;");
  });
});
