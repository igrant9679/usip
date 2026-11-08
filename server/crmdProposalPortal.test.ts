/**
 * The proposal portal's answers and what the team sees of them (audit
 * 2026-10-20, F48 and U34).
 *
 *   F48  an acceptance keeps an e-signature record on the proposal — the name
 *        typed, the email given, the time and the address — written by the
 *        click that won, and the team's proposal page shows it;
 *   F48  the portal records views: first, last and a visit count, nothing
 *        about the viewer; a refresh is the same visit, a draft records
 *        nothing, and a member of the team checking the link is not counted;
 *   F48  "Request changes" is the feedback path, named for what it does;
 *   U34  the portal's Decline (built by PR #59, proposals.declineByToken) is
 *        there beside Accept.
 *
 * Run against the SQL-evaluating fake; nothing is sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "f".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/workflowEngine", async (a) => ({
  ...(await a<typeof import("./services/workflowEngine")>()),
  fireStageChanged: async () => {},
  fireRecordCreated: async () => {},
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { PORTAL_VIEW_GAP_MS } from "./routers/proposals";
import { portalView } from "./services/proposalPortal";
import { isPublicWritePath } from "./publicRateLimit";

const WS = 2, REP = 21, STRANGER = 40;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const prop = (id: number) => rows("proposals").find((p) => p.id === id);
const proposal = (id: number, over: Record<string, unknown> = {}) => rows("proposals").push({
  id, workspaceId: WS, createdBy: REP, title: `Proposal ${id}`, clientName: "Acme", status: "sent", shareToken: `tok-${id}`,
  expiresAt: null, accountId: null, linkedOpportunityId: null, budget: "5000.00", acceptedAt: null, sentAt: new Date(),
  acceptedSignerName: null, acceptedSignerEmail: null, acceptedIp: null,
  portalFirstViewedAt: null, portalLastViewedAt: null, portalViewCount: 0, ...over,
});
const caller = (userId: number | null) => appRouter.createCaller({
  user: userId == null ? null : rows("users").find((u) => u.id === userId),
  req: { protocol: "https", ip: "198.51.100.7", headers: { "user-agent": "PortalTest/1.0" }, socket: { remoteAddress: "10.0.0.1" } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: REP, archivedAt: null, plan: "trial" });
  rows("users").push(
    { id: REP, openId: "u21", name: "Rep", email: "rep@example.com", loginMethod: "password", role: "user" },
    { id: STRANGER, openId: "u40", name: "Someone", email: "someone@example.com", loginMethod: "password", role: "user" },
  );
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: REP, role: "rep", deactivatedAt: null, lastActiveAt: new Date(), inviteToken: null });
});

describe("F48: the e-signature record", () => {
  it("an acceptance stores who signed, their email, the time and the address on the proposal", async () => {
    proposal(1);
    await caller(null).proposals.acceptByToken({ token: "tok-1", signerName: "  Jane Buyer ", signerEmail: "jane@acme.example" });
    expect(prop(1)).toMatchObject({ status: "accepted", acceptedSignerName: "Jane Buyer", acceptedSignerEmail: "jane@acme.example", acceptedIp: "198.51.100.7" });
    expect(prop(1).acceptedAt).toBeInstanceOf(Date);
  });

  it("a second click keeps the first signature", async () => {
    proposal(1);
    await caller(null).proposals.acceptByToken({ token: "tok-1", signerName: "Jane Buyer" });
    const r = await caller(null).proposals.acceptByToken({ token: "tok-1", signerName: "Someone Else", signerEmail: "x@y.example" });
    expect(r.alreadyAccepted).toBe(true);
    expect(prop(1)).toMatchObject({ acceptedSignerName: "Jane Buyer", acceptedSignerEmail: null });
  });

  it("the portal is not shown the record, and the team's page shows it", () => {
    proposal(1, { status: "accepted", acceptedSignerName: "Jane", acceptedSignerEmail: "j@a.example", acceptedIp: "1.2.3.4", portalViewCount: 3 });
    const view = portalView(prop(1)) as Record<string, unknown>;
    for (const k of ["acceptedSignerName", "acceptedSignerEmail", "acceptedIp", "portalViewCount", "portalLastViewedAt"]) expect(view).not.toHaveProperty(k);
    const page = read("client/src/pages/usip/ProposalDetail.tsx");
    expect(page).toContain("<PortalRecord proposal={proposal} />");
    expect(page).toContain('<dt className="text-muted-foreground">Signed by</dt><dd className="font-medium">{proposal.acceptedSignerName}</dd>');
    expect(page).toContain("{proposal.acceptedIp || \"Unknown\"}");
    expect(page).toContain("without a portal signature.");
    // The accept dialog says what the signature keeps before it is made.
    expect(read("client/src/pages/ProposalPortal.tsx")).toContain("Accepting with your name is an electronic signature.");
  });
});

describe("F48: portal view tracking", () => {
  it("counts a visit, sets first and last viewed, and a refresh is the same visit", async () => {
    proposal(1);
    expect(await caller(null).proposals.recordView({ token: "tok-1" })).toEqual({ counted: true });
    const first = prop(1).portalFirstViewedAt;
    expect(prop(1).portalViewCount).toBe(1);
    expect(first).toBeTruthy();
    expect(await caller(null).proposals.recordView({ token: "tok-1" })).toEqual({ counted: false });
    expect(prop(1).portalViewCount).toBe(1);
    // A visit after the gap counts; the first view stays the first.
    prop(1).portalLastViewedAt = new Date(Date.now() - PORTAL_VIEW_GAP_MS - 1000);
    expect(await caller(null).proposals.recordView({ token: "tok-1" })).toEqual({ counted: true });
    expect(prop(1).portalViewCount).toBe(2);
    expect(new Date(prop(1).portalFirstViewedAt).getTime()).toBe(new Date(first).getTime());
  });

  it("a draft or an unknown link records nothing; a team member checking the link is not counted", async () => {
    proposal(1, { status: "draft" });
    proposal(2);
    expect(await caller(null).proposals.recordView({ token: "tok-1" })).toEqual({ counted: false });
    expect(await caller(null).proposals.recordView({ token: "nope" })).toEqual({ counted: false });
    expect(await caller(REP).proposals.recordView({ token: "tok-2" })).toEqual({ counted: false });
    expect(await caller(STRANGER).proposals.recordView({ token: "tok-2" })).toEqual({ counted: true });
    expect(prop(1).portalViewCount).toBe(0);
    expect(prop(2).portalViewCount).toBe(1);
  });

  it("is a capped public write, the portal sends it once per load, and the team sees the counts", () => {
    expect(isPublicWritePath("/proposals.recordView")).toBe(true);
    const portal = read("client/src/pages/ProposalPortal.tsx");
    expect(portal).toContain("if (!data || viewSent.current || !token) return;");
    expect(portal).toContain("recordView.mutate({ token });");
    const page = read("client/src/pages/usip/ProposalDetail.tsx");
    expect(page).toContain('<dt className="text-muted-foreground">Visits</dt><dd className="font-medium">{views}</dd>');
    expect(read("server/_core/rawMigrations.ts")).toContain("ALTER TABLE `proposals` ADD COLUMN `portalViewCount` int NOT NULL DEFAULT 0");
  });
});

describe("F48 and U34: Request changes and Decline", () => {
  it("the feedback tab is Request changes on the portal and Change requests for the team", () => {
    const portal = read("client/src/pages/ProposalPortal.tsx");
    expect(portal).toContain('<TabsTrigger value="feedback" className="rounded-md data-[state=active]:bg-teal-600 data-[state=active]:text-white text-sm">\n              Request changes\n            </TabsTrigger>');
    expect(portal).not.toContain("Submit Feedback");
    expect(portal).toContain('{submitFeedback.isPending ? "Sending..." : "Send change request"}');
    expect(read("client/src/pages/usip/ProposalDetail.tsx")).toContain('label: `Change requests${feedback.length > 0');
  });

  it("Decline sits beside Accept, and declines through the portal procedure", async () => {
    const portal = read("client/src/pages/ProposalPortal.tsx");
    expect(portal).toContain("onClick={() => setDeclineDialogOpen(true)}");
    expect(portal).toContain("trpc.proposals.declineByToken.useMutation(");
    proposal(1);
    expect(await caller(null).proposals.declineByToken({ token: "tok-1", reason: "Over budget" })).toMatchObject({ ok: true, alreadyDeclined: false });
    expect(prop(1).status).toBe("not_accepted");
  });
});
