/**
 * Batch S1b (audit 2026-10-20): the proposal portal and the tracked links.
 *
 *   G18  an acceptance records who accepted, from where and when; it still
 *        happens once, only while open and unexpired.
 *   G40  drafts are not served; public writes are capped.
 *   R67  the portal gets the fields it shows, not the internal row.
 *   R92  the portal's writes are rate-limited; the "View proposal" email
 *        builds its links from appUrl() and escapes what it prints.
 *   G43  click tracking redirects only links we signed; the proposal click
 *        always lands on its own portal page.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  process.env.PUBLIC_APP_URL = "https://app.velocity.test";
  return { db: null as any, sent: [] as any[] };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/outboundPause", async (a) => ({
  ...(await a<typeof import("./services/outboundPause")>()),
  assertOutboundNotPaused: async () => {},
  isOutboundPaused: async () => false,
}));
vi.mock("./emailDelivery", async (a) => ({
  ...(await a<typeof import("./emailDelivery")>()),
  sendWorkspaceEmail: async (_ws: number, m: any) => { h.sent.push(m); return { ok: true }; },
}));
vi.mock("./services/workflowEngine", async (a) => ({
  ...(await a<typeof import("./services/workflowEngine")>()),
  fireStageChanged: async () => {},
  fireRecordCreated: async () => {},
}));

import express from "express";
import { readFileSync } from "node:fs";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { PORTAL_UNAVAILABLE, portalView } from "./services/proposalPortal";
import { isPublicWritePath, publicTrpcLimiters, publicWriteLimiter } from "./publicRateLimit";
import { registerEmailTrackingRoutes } from "./emailTracking";
import { injectTracking } from "./mergeVars";
import { clickSignature, isSignedClick } from "./services/trackedLinks";
import { isSignedVid, registerWebsiteTrackingRoutes, signVisitorId } from "./websiteTracking";

const LSI = 2;
const REP = 21;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);

function seed() {
  rows("workspaces").push({ id: LSI, name: "LSI <Media>", slug: "lsi", ownerUserId: REP, archivedAt: null, plan: "trial" });
  rows("users").push({ id: REP, openId: "local:21", name: "Rep <b>Bold</b>", email: "rep@lsi.example", loginMethod: "password", role: "user" });
  rows("workspace_members").push({
    id: 1, workspaceId: LSI, userId: REP, role: "rep", deactivatedAt: null, lastActiveAt: new Date(), inviteToken: null, createdAt: new Date(),
  });
}
function proposal(id: number, over: Record<string, unknown> = {}) {
  rows("proposals").push({
    id, workspaceId: LSI, createdBy: REP, title: `Proposal ${id}`, clientName: "Acme", clientEmail: "buyer@acme.example",
    clientWebsite: "https://acme.example", orgAbbr: "AC", status: "sent", shareToken: `tok-${id}`, expiresAt: null,
    accountId: 501, contactId: 701, linkedOpportunityId: 77, budget: "5000.00", acceptedAt: null, sentAt: new Date(),
    emailOpenedAt: new Date(), emailClickedAt: null, requirements: ["internal: margin 40%"], skipAutoExtend: false,
    projectType: "Website", rfpDeadline: null, completionDate: null, description: "Scope", ...over,
  });
}
function caller(userId: number | null, headers: Record<string, string> = {}) {
  const user = userId == null ? null : rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", ip: "198.51.100.7", headers: { "x-workspace-id": String(LSI), "user-agent": "PortalTest/1.0", ...headers }, socket: { remoteAddress: "10.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.sent = [];
  seed();
});

/* ─── R67 / G40 ────────────────────────────────────────────────────────── */

describe("R67 and G40: what the portal reads", () => {
  it("the portal gets the fields it shows, never the internal row", async () => {
    proposal(1);
    rows("proposal_sections").push({ id: 1, proposalId: 1, sectionKey: "pricing", content: "$5k", updatedAt: new Date() });
    rows("proposal_milestones").push({ id: 3, proposalId: 1, name: "Kickoff", milestoneDate: null, description: "d", owner: "client", sortOrder: 0 });
    const out: any = await caller(null).proposals.getByShareToken({ token: "tok-1" });
    expect(Object.keys(out.proposal).sort()).toEqual(
      ["acceptedAt", "budget", "clientName", "description", "expiresAt", "orgAbbr", "projectType", "rfpDeadline", "status", "title"],
    );
    expect(out.proposal).toMatchObject({ title: "Proposal 1", clientName: "Acme", budget: "5000.00", status: "sent" });
    const flat = JSON.stringify(out);
    for (const secret of ["tok-1", "buyer@acme.example", "margin 40%", "\"workspaceId\"", "\"createdBy\"", "linkedOpportunityId", "emailOpenedAt"]) {
      expect(flat, secret).not.toContain(secret);
    }
    expect(out.sections).toEqual([{ sectionKey: "pricing", content: "$5k" }]);
    expect(out.milestones).toEqual([{ id: 3, name: "Kickoff", milestoneDate: null, description: "d" }]);
  });

  it("a draft's link says what an unknown link says, and its writes are refused", async () => {
    proposal(1, { status: "draft" });
    for (const token of ["tok-1", "tok-nope"]) {
      expect(await refusal(caller(null).proposals.getByShareToken({ token }))).toEqual({ code: "NOT_FOUND", message: PORTAL_UNAVAILABLE });
    }
    expect((await refusal(caller(null).proposals.submitFeedback({ token: "tok-1", authorName: "A", message: "Hi" }))).code).toBe("NOT_FOUND");
    expect((await refusal(caller(null).proposals.requestExtension({ token: "tok-1", reason: "More time" }))).code).toBe("NOT_FOUND");
    expect(await caller(null).proposals.getExtensionHistory({ token: "tok-1" })).toEqual([]);
    expect((await caller(null).proposals.getExtensionStatus({ token: "tok-1" })).status).toBe("none");
    expect(rows("proposal_feedback")).toHaveLength(0);
    expect(rows("tasks")).toHaveLength(0);
  });

  it("control: every status the client has been sent is served", async () => {
    ["sent", "under_review", "accepted", "not_accepted", "revision_requested"].forEach((status, i) => proposal(i + 1, { status }));
    for (let i = 1; i <= 5; i++) expect((await caller(null).proposals.getByShareToken({ token: `tok-${i}` })).proposal.title).toBe(`Proposal ${i}`);
  });

  it("public writes are capped", async () => {
    proposal(1);
    const long = "x".repeat(5001);
    expect((await refusal(caller(null).proposals.submitFeedback({ token: "tok-1", authorName: "A", message: long }))).code).toBe("BAD_REQUEST");
    expect((await refusal(caller(null).proposals.submitFeedback({ token: "tok-1", authorName: "n".repeat(201), message: "hi" }))).code).toBe("BAD_REQUEST");
    expect((await refusal(caller(null).proposals.requestExtension({ token: "tok-1", reason: "r", clientName: "n".repeat(201) }))).code).toBe("BAD_REQUEST");
    expect((await refusal(caller(null).proposals.getByShareToken({ token: "t".repeat(129) }))).code).toBe("BAD_REQUEST");
    expect(rows("proposal_feedback")).toHaveLength(0);
    await caller(null).proposals.submitFeedback({ token: "tok-1", authorName: "A", message: "x".repeat(5000) });
    expect(rows("proposal_feedback")).toHaveLength(1);
  });

  it("portalView is the whole of what the procedure returns for the proposal", () => {
    const keys = Object.keys(portalView({} as any)).sort();
    expect(keys).toHaveLength(10);
  });
});

/* ─── G18 ──────────────────────────────────────────────────────────────── */

describe("G18: an acceptance names who accepted, and happens once", () => {
  it("records the signer, their address, browser, time zone and the time", async () => {
    proposal(1);
    const out = await caller(null).proposals.acceptByToken({ token: "tok-1", signerName: "Jane Buyer", signerEmail: "jane@acme.example", timeZone: "Europe/London" });
    expect(out).toMatchObject({ ok: true, alreadyAccepted: false });
    const rec = rows("activities").filter((a) => a.relatedType === "proposal" && a.relatedId === 1 && /Accepted/.test(a.subject));
    expect(rec).toHaveLength(1);
    expect(rec[0].subject).toBe("Accepted by Jane Buyer on the client portal");
    expect(rec[0].body).toContain("by Jane Buyer <jane@acme.example>");
    expect(rec[0].body).toContain("their time zone Europe/London");
    expect(rec[0].body).toContain("From address 198.51.100.7");
    expect(rec[0].body).toContain("browser: PortalTest/1.0");
    expect(rec[0].body).toMatch(/Time: \d{4}-\d\d-\d\dT[\d:.]+Z \(UTC\)/);
    expect(rows("tasks").map((t) => t.title)).toEqual(["Follow up: Proposal 1 — accepted by Jane Buyer"]);
  });

  it("a double click records one acceptance and one follow-up", async () => {
    proposal(1);
    await caller(null).proposals.acceptByToken({ token: "tok-1", signerName: "Jane Buyer" });
    expect(await caller(null).proposals.acceptByToken({ token: "tok-1", signerName: "Jane Buyer" })).toEqual({ ok: true, alreadyAccepted: true });
    expect(rows("activities").filter((a) => /Accepted/.test(a.subject ?? ""))).toHaveLength(1);
    expect(rows("tasks")).toHaveLength(1);
  });

  it("control: still only from a sendable status and before expiry", async () => {
    proposal(1, { status: "draft" });
    proposal(2, { expiresAt: new Date(Date.now() - 1000) });
    expect((await refusal(caller(null).proposals.acceptByToken({ token: "tok-1", signerName: "J" }))).message).toMatch(/not open for acceptance/);
    expect((await refusal(caller(null).proposals.acceptByToken({ token: "tok-2", signerName: "J" }))).message).toMatch(/expired/);
    expect(rows("activities")).toHaveLength(0);
  });

  it("the portal asks for the name and sends it, and won't accept without one", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../client/src/pages/ProposalPortal.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const call = src.slice(src.indexOf("onClick={() => acceptMutation.mutate({"), src.indexOf("{acceptMutation.isPending ? \"Accepting...\""));
    expect(call).toContain("signerName: signerName.trim(),");
    expect(call).toContain("timeZone:");
    expect(call).toContain("disabled={acceptMutation.isPending || !signerName.trim()}");
    expect(src).toContain('<Label htmlFor="signer-name" className="text-gray-700">Your full name *</Label>');
  });
});

/* ─── R92 ──────────────────────────────────────────────────────────────── */

describe("R92: the portal's writes are limited, and the proposal email is built safely", () => {
  it("accept, feedback and extension pass the public write ceiling", () => {
    for (const p of ["/proposals.acceptByToken", "/proposals.submitFeedback", "/proposals.requestExtension"]) {
      expect(isPublicWritePath(p), p).toBe(true);
      expect(publicTrpcLimiters(p), p).toEqual([publicWriteLimiter]);
    }
    for (const p of ["/proposals.getByShareToken", "/proposals.acceptProposal", "/proposals.list"]) expect(isPublicWritePath(p), p).toBe(false);
  });

  it("links come from appUrl(), not the origin the browser sent, and every value is escaped", async () => {
    proposal(1, { title: "Q4 <script>alert(1)</script>", clientName: 'Acme "Buyers"', orgAbbr: "A&B" });
    const out = await caller(REP).proposals.sendToClient({ id: 1, origin: "https://evil.example", message: "Hi <img src=x onerror=alert(1)>\nThanks" });
    expect(out.shareUrl).toBe("https://app.velocity.test/p/tok-1");
    const html: string = h.sent[0].html;
    expect(html).not.toContain("evil.example");
    expect(html).toContain('href="https://app.velocity.test/api/track/proposal-click/tok-1"');
    expect(html).toContain('src="https://app.velocity.test/api/track/proposal-open/tok-1"');
    expect(html).not.toContain("?dest=");
    expect(html).not.toMatch(/<script|<img src=x|<b>Bold/);
    expect(html).toContain("Q4 &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Acme &quot;Buyers&quot; (A&amp;B)");
    expect(html).toContain("Hi &lt;img src=x onerror=alert(1)&gt;<br>Thanks");
    expect(html).toContain("LSI &lt;Media&gt;");
  });

  it("control: a caller that sends no origin still sends", async () => {
    proposal(1);
    await caller(REP).proposals.sendToClient({ id: 1 });
    expect(h.sent).toHaveLength(1);
  });
});

/* ─── G43 ──────────────────────────────────────────────────────────────── */

describe("G43: no open redirects through the tracking routes", () => {
  let base = "";
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerEmailTrackingRoutes(app);
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server?.close(); });
  const get = (path: string) => fetch(`${base}${path}`, { redirect: "manual" });

  it("a link we wrote is signed, and redirects", async () => {
    const html = injectTracking('<body><a href="https://example.com/pricing?a=1">x</a></body>', "trk-1", "https://app.velocity.test", { open: false });
    const href = /href="([^"]+)"/.exec(html)![1];
    const u = new URL(href);
    expect(u.searchParams.get("sig")).toBe(clickSignature("trk-1", "https://example.com/pricing?a=1"));
    const res = await get(`${u.pathname}${u.search}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/pricing?a=1");
  });

  it("an unsigned or re-pointed link is not redirected; the page names where it goes", async () => {
    const sig = clickSignature("trk-1", "https://example.com/");
    for (const q of [
      `?url=${encodeURIComponent("https://phish.example/login")}`,
      `?url=${encodeURIComponent("https://phish.example/login")}&sig=${sig}`,
      `?url=${encodeURIComponent("https://phish.example/<x>")}&sig=nonsense`,
    ]) {
      const res = await get(`/api/track/click/trk-1${q}`);
      expect(res.status, q).toBe(200);
      expect(res.headers.get("location"), q).toBeNull();
      const body = await res.text();
      expect(body).toContain("This link goes to another site");
      expect(body).not.toContain("<x>");
    }
    expect(isSignedClick("trk-2", "https://example.com/", sig)).toBe(false);
  });

  it("the proposal click always lands on its own portal page, whatever dest says", async () => {
    for (const q of ["", `?dest=${encodeURIComponent("https://phish.example/")}`, "?dest=//phish.example"]) {
      const res = await get(`/api/track/proposal-click/tok-9${q}`);
      expect(res.status, q).toBe(302);
      expect(res.headers.get("location"), q).toBe("/p/tok-9");
    }
  });

  it("control: unsubscribe still asks on GET and acts only on POST", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./emailTracking.ts", import.meta.url), "utf8");
    const getRoute = src.slice(src.indexOf('app.get("/api/track/unsubscribe/:token"'), src.indexOf('app.post("/api/track/bounce"'));
    expect(getRoute).toContain("TRACK_UNSUB_CONFIRM(");
    expect(getRoute).not.toContain("recordUnsubscribeByToken");
    expect(src).toContain("<body><h1>Unsubscribe <strong>${escapeHtml(email)}</strong>?</h1>");
  });
});

/* ─── P5 ───────────────────────────────────────────────────────────────── */

describe("P5: the visitor beacon files a task only for an id we signed", () => {
  const beacon = async (body: Record<string, unknown>) => {
    let handler: any;
    registerWebsiteTrackingRoutes({ get: () => {}, options: () => {}, post: (_p: string, h2: any) => { handler = h2; } } as any);
    const res: any = { setHeader: () => {}, status: () => res, json: () => res, end: () => res };
    await handler({ body, headers: {} }, res);
  };
  const intentTasks = () => rows("tasks").filter((t) => String(t.title).startsWith("High-intent website visit"));
  beforeEach(() => {
    for (let id = 1; id <= 3; id++) rows("leads").push({ id, workspaceId: LSI, firstName: `L${id}`, lastName: "X", ownerUserId: null });
    rows("workspaces").push({ id: 4, name: "Other", slug: "other", ownerUserId: 99, archivedAt: null });
  });

  it("walking plain ids records the visits and files nothing", async () => {
    for (const vid of ["l1", "2", "l3"]) await beacon({ slug: "lsi", visitorId: "v", path: "/pricing", vid });
    expect(rows("website_visits").map((v) => v.leadId)).toEqual([1, 2, 3]);
    expect(intentTasks()).toHaveLength(0);
  });

  it("a signed id files one, saying it was signed", async () => {
    await beacon({ slug: "lsi", visitorId: "v", path: "/pricing", vid: signVisitorId(LSI, "l", 2) });
    expect(intentTasks().map((t) => [t.relatedId, t.description])).toEqual([[2, "Viewed /pricing — reach out while intent is hot. The visit was matched by a signed id in the link."]]);
  });

  it("a signature for another workspace, another record, or a forged one files nothing", async () => {
    const forOther = signVisitorId(4, "l", 1);
    const [, sig] = signVisitorId(LSI, "l", 1).split(".");
    for (const vid of [forOther, `l2.${sig}`, "l1.AAAAAAAAAAAAAAAA", `c1.${sig}`]) {
      expect(isSignedVid(LSI, vid), vid).toBe(false);
      await beacon({ slug: "lsi", visitorId: "v", path: "/pricing", vid });
    }
    expect(intentTasks()).toHaveLength(0);
    expect(isSignedVid(LSI, signVisitorId(LSI, "c", 7))).toBe(true);
  });
});

/* ─── G45 ──────────────────────────────────────────────────────────────── */

describe("G45: analytics never sees a token", () => {
  const html = () => readFileSync(new URL("../client/index.html", import.meta.url), "utf8");
  /** The inline script that loads analytics (the page has others, e.g. the font loader). */
  const loader = () => {
    const hits = Array.from(html().matchAll(/<script>\s*([\s\S]*?)<\/script>/g)).map((m) => m[1]).filter((b) => b.includes("VITE_ANALYTICS_ENDPOINT"));
    expect(hits, "exactly one analytics loader").toHaveLength(1);
    return hits[0];
  };
  /** Run the page's analytics loader as Vite would serve it, with the endpoint configured. */
  function load(pathname: string) {
    const src = loader()
      // Every occurrence, as Vite does: the comment above the code names one too.
      .split("%VITE_ANALYTICS_ENDPOINT%").join("https://umami.example")
      .split("%VITE_ANALYTICS_WEBSITE_ID%").join("site-1");
    const appended: any[] = [];
    const win: any = {};
    const doc = {
      createElement: () => { const attrs: Record<string, string> = {}; return { attrs, setAttribute: (k: string, v: string) => { attrs[k] = v; } }; },
      body: { appendChild: (n: any) => appended.push(n) },
    };
    new Function("window", "document", "location", "URL", src)(win, doc, { pathname, origin: "https://app.velocity.test" }, URL);
    return { appended, beforeSend: win.__velocityAnalyticsBeforeSend as ((t: string, p: any) => any) | undefined };
  }

  it("a page whose URL is a credential loads no analytics at all", () => {
    for (const p of ["/p/0123abcd", "/m/tok-77", "/reset-password", "/invite/accept", "/join", "/confirm-email"]) {
      expect(load(p).appended, p).toHaveLength(0);
    }
  });

  it("elsewhere it loads, told to drop query strings and fragments, with a hook that scrubs what's left", () => {
    const { appended, beforeSend } = load("/v2/home");
    expect(appended).toHaveLength(1);
    expect(appended[0].attrs).toMatchObject({ "data-exclude-search": "true", "data-exclude-hash": "true", "data-before-send": "__velocityAnalyticsBeforeSend" });
    expect(beforeSend!("pageview", { url: "/v2/people?q=secret#x", referrer: "https://app.velocity.test/p/abc?x=1" }))
      .toEqual({ url: "/v2/people", referrer: "" });
    expect(beforeSend!("pageview", { url: "/m/tok-9", referrer: "" }), "a later navigation onto a token page is not sent").toBe(false);
    expect(beforeSend!("pageview", { url: "/join?token=abc", referrer: "" })).toBe(false);
  });

  it("control: unconfigured, nothing loads (the 2026-09-20 rule)", () => {
    const src = loader();
    const appended: any[] = [];
    new Function("window", "document", "location", "URL", src)({}, { createElement: () => ({}), body: { appendChild: (n: any) => appended.push(n) } }, { pathname: "/v2/home", origin: "x" }, URL);
    expect(appended).toHaveLength(0);
  });
});
