/**
 * Public pages, the last of G70 (audit 2026-10-20; final pass 2026-11-07):
 *
 *   1 · A new booking link's slug cannot be guessed from the rep's name. It was
 *       `name-<userId>`, so the ids could be walked. Existing links keep theirs.
 *   2 · A /m link stops working 30 days after the proposal was emailed, and
 *       the page says so instead of erroring.
 *   3 · The meeting-proposal page has a Decline: it closes the proposal, tells
 *       the owner as a confirmation does, books and sends nothing, and the
 *       meeting autopilot leaves that person alone afterwards.
 *   4 · The proposal portal has a Decline too: the proposal is marked not
 *       accepted, and the team is told as acceptance tells it.
 *
 * Run against the SQL-evaluating fake; the calendar and the model are mocked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "e".repeat(64);
  return { db: null as any, listEvents: [] as unknown[] };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./_core/llm", async (a) => ({ ...(await a<typeof import("./_core/llm")>()), invokeLLM: async () => { throw new Error("no AI in tests"); } }));
vi.mock("./calendarAdapter", async (a) => ({
  ...(await a<typeof import("./calendarAdapter")>()),
  createCalendarAdapter: () => ({ listEvents: async () => h.listEvents, createEvent: async () => { throw new Error("no calendar writes in tests"); } }),
}));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateArchivedWorkspaceCache } from "./_core/workspaceArchive";
import { randomSlugToken, unguessableSlug } from "@shared/slugify";
import { resolveBookingUrl } from "./mergeVars";
import {
  DECLINED_BY_PROSPECT, PICK_LINK_TTL_DAYS, confirmProposalPick, declineProposalPick, pickLinkExpired, previewMeetingCandidates, proposalForPick,
} from "./services/meetingScheduler";
import { isPublicWritePath } from "./publicRateLimit";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const WS = 2, REP = 7;
const DAY = 86_400_000;
const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz012345";

const anon = () => appRouter.createCaller({ user: null, req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } }, res: {} } as unknown as TrpcContext);
const rep = () => appRouter.createCaller({
  user: rows("users").find((u) => u.id === REP),
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) }, socket: { remoteAddress: "127.0.0.1" } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.listEvents = [];
  invalidateArchivedWorkspaceCache();
  rows("workspaces").push({ id: WS, name: "Acme", slug: "acme", ownerUserId: REP, archivedAt: null, plan: "trial" });
  rows("users").push({ id: REP, openId: "local:7", name: "Ann Lee", email: "ann@acme.example", role: "user", loginMethod: "password" });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: REP, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date(), createdAt: new Date() });
});

/* ── 1 · booking slugs ─────────────────────────────────────────────────── */

describe("a new booking link cannot be found from the rep's name (G70)", () => {
  it("the slug is the name plus ten random characters, different every time", () => {
    const a = unguessableSlug("Ann Lee", "rep-7");
    const b = unguessableSlug("Ann Lee", "rep-7");
    expect(a).toMatch(/^ann-lee-[a-km-z2-9]{10}$/);
    expect(a).not.toBe(b);
    expect(randomSlugToken()).toMatch(/^[a-km-z2-9]{10}$/);
    expect(unguessableSlug("", "rep-7")).toMatch(/^rep-7-[a-km-z2-9]{10}$/);
    expect(unguessableSlug("x".repeat(200), "rep-7").length).toBeLessThanOrEqual(80);
  });

  it("bookingLinks.mine mints one that does not end in the user id", async () => {
    const link = await rep().bookingLinks.mine();
    expect(link.slug).toMatch(/^ann-lee-[a-km-z2-9]{10}$/);
    expect(link.slug).not.toBe(`ann-lee-${REP}`);
  });

  it("{{bookingLink}}'s lazy provision mints the same shape", async () => {
    await resolveBookingUrl(WS, REP, "https://app.example");
    // (The fake applies no column defaults, so the new row's `active` reads
    // unset and the URL itself comes back empty here; the slug is the point.)
    expect(rows("booking_links")).toHaveLength(1);
    expect(rows("booking_links")[0].slug).toMatch(/^ann-lee-[a-km-z2-9]{10}$/);
  });

  it("an existing link keeps its old slug, so links already sent keep working", async () => {
    rows("booking_links").push({ id: 3, workspaceId: WS, userId: REP, slug: "ann-lee-7", title: "Intro", active: true, durationMin: 30, bookingCount: 0, startHour: 9, endHour: 17, workDays: "1,2,3,4,5", timezone: "UTC" });
    expect((await rep().bookingLinks.mine()).slug).toBe("ann-lee-7");
    expect(await resolveBookingUrl(WS, REP, "https://app.example")).toBe("https://app.example/b/ann-lee-7");
  });
});

/* ── 2–3 · /m links: expiry and Decline ───────────────────────────────── */

const future = (d: number) => new Date(Date.now() + d * DAY).toISOString();
function invited(over: Record<string, unknown> = {}) {
  rows("meetings").push({
    id: 9, workspaceId: WS, ownerUserId: REP, status: "invited", proposedTimes: [future(2), future(3)], scheduledAt: null,
    durationMin: 30, contactEmail: "vee@visitor.example", contactName: "Vee", title: "Intro call", meetingUrl: null,
    relatedType: "prospect", relatedId: 77, proposalToken: TOKEN, proposalSentAt: new Date(Date.now() - DAY),
    createdAt: new Date(Date.now() - DAY), updatedAt: new Date(), disposition: null, ...over,
  });
}

describe("a /m link expires (G70)", () => {
  it("expires 30 days after the proposal was emailed, not before", () => {
    const now = Date.now();
    expect(PICK_LINK_TTL_DAYS).toBe(30);
    expect(pickLinkExpired({ proposalSentAt: new Date(now - 29 * DAY) }, now)).toBe(false);
    expect(pickLinkExpired({ proposalSentAt: new Date(now - 31 * DAY) }, now)).toBe(true);
    // Falls back to when the row was made; with neither, nothing was emailed.
    expect(pickLinkExpired({ proposalSentAt: null, createdAt: new Date(now - 31 * DAY) }, now)).toBe(true);
    expect(pickLinkExpired({}, now)).toBe(false);
  });

  it("an expired link shows a clear page: who it was from, and no times or meeting details", async () => {
    invited({ proposalSentAt: new Date(Date.now() - 31 * DAY) });
    const view = await anon().meetingPicks.get({ token: TOKEN });
    expect(view.state).toBe("link_expired");
    expect(view.ownerName).toBe("Ann Lee");
    expect(view.times).toEqual([]);
    expect(view.scheduledAt).toBeNull();
    expect(view.meetingUrl).toBeNull();
  });

  it("a live link is unaffected", async () => {
    invited();
    expect((await proposalForPick(TOKEN))!.state).toBe("open");
  });

  it("an expired link cannot confirm a time or decline", async () => {
    invited({ proposalSentAt: new Date(Date.now() - 31 * DAY) });
    expect(await confirmProposalPick(TOKEN, future(2))).toEqual({ ok: false, reason: "link_expired" });
    const r = await refusal(anon().meetingPicks.decline({ token: TOKEN }));
    expect(r.code).toBe("CONFLICT");
    expect(r.message).toBe("This link has expired. Reply to the email to find a time.");
    expect(rows("meetings")[0].status).toBe("invited");
  });
});

describe("Decline on the meeting-proposal page (G70)", () => {
  it("closes the proposal, tells the owner and the timeline, and books nothing", async () => {
    invited();
    const out = await anon().meetingPicks.decline({ token: TOKEN, note: "Not this quarter" });
    expect(out).toEqual({ ok: true });
    const m = rows("meetings")[0];
    expect(m.status).toBe("cancelled");
    expect(m.disposition).toBe(DECLINED_BY_PROSPECT);
    expect(m.attendeeResponse).toBe("declined");
    expect(m.scheduledAt).toBeNull();
    const n = rows("notifications");
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ workspaceId: WS, userId: REP, title: "Meeting declined: Vee" });
    expect(n[0].body).toContain('Their note: "Not this quarter"');
    expect(rows("activities")).toHaveLength(1);
    expect(rows("activities")[0]).toMatchObject({ relatedType: "prospect", relatedId: 77, subject: "Meeting declined: Intro call" });
    expect(rows("calendar_events")).toHaveLength(0);
  });

  it("the page then shows the declined state, and a second click changes nothing", async () => {
    invited();
    await declineProposalPick(TOKEN);
    expect((await proposalForPick(TOKEN))!.state).toBe("declined");
    expect(await declineProposalPick(TOKEN)).toEqual({ ok: true, already: true });
    expect(rows("notifications")).toHaveLength(1);
  });

  it("a confirmed meeting cannot be declined from the page (reply to the invite instead)", async () => {
    invited({ status: "scheduled", scheduledAt: new Date(future(2)) });
    expect(await declineProposalPick(TOKEN)).toEqual({ ok: false, reason: "closed" });
    expect(rows("meetings")[0].status).toBe("scheduled");
  });

  it("an unknown token is not found", async () => {
    expect((await refusal(anon().meetingPicks.decline({ token: TOKEN }))).code).toBe("NOT_FOUND");
  });

  it("is under the public write ceiling, with the portal's Decline", () => {
    expect(isPublicWritePath("/meetingPicks.decline")).toBe(true);
    expect(isPublicWritePath("/proposals.declineByToken")).toBe(true);
  });
});

describe("after a Decline the meeting autopilot leaves that person alone (G70)", () => {
  function seedProspects() {
    rows("prospects").push(
      { id: 77, workspaceId: WS, firstName: "Vee", lastName: "V", email: "vee@visitor.example", company: "V Co", verificationStatus: null, confidenceScore: 90, updatedAt: new Date() },
      { id: 78, workspaceId: WS, firstName: "Bo", lastName: "B", email: "bo@visitor.example", company: "B Co", verificationStatus: null, confidenceScore: 80, updatedAt: new Date() },
    );
  }

  it("someone who declined lately is not a candidate; someone else still is", async () => {
    seedProspects();
    invited();
    await declineProposalPick(TOKEN);
    const picks = await previewMeetingCandidates(WS, 5);
    expect(picks.map((p) => p.id)).toEqual([78]);
  });

  it("the same person matched by email under another prospect row is skipped too", async () => {
    seedProspects();
    rows("prospects").push({ id: 79, workspaceId: WS, firstName: "Vee", lastName: "Dup", email: "Vee@Visitor.example", company: "V Co", verificationStatus: null, confidenceScore: 70, updatedAt: new Date() });
    invited();
    await declineProposalPick(TOKEN);
    expect((await previewMeetingCandidates(WS, 5)).map((p) => p.id)).toEqual([78]);
  });

  it("an old decline (past the quiet period) no longer holds them back", async () => {
    seedProspects();
    invited({ status: "cancelled", disposition: DECLINED_BY_PROSPECT, updatedAt: new Date(Date.now() - 120 * DAY) });
    expect((await previewMeetingCandidates(WS, 5)).map((p) => p.id).sort()).toEqual([77, 78]);
  });
});

/* ── 4 · the proposal portal's Decline ────────────────────────────────── */

describe("Decline on the proposal portal (G70)", () => {
  const proposal = (status: string) => rows("proposals").push({
    id: 40, workspaceId: WS, title: "Website rebuild", clientName: "Visitor Co", status, shareToken: "share-40", expiresAt: null, linkedOpportunityId: null,
  });

  it("marks it not accepted, records the reason, and tells the team", async () => {
    proposal("sent");
    expect(await anon().proposals.declineByToken({ token: "share-40", signerName: "Vee", reason: "Budget moved" })).toEqual({ ok: true, alreadyDeclined: false });
    expect(rows("proposals")[0].status).toBe("not_accepted");
    const act = rows("activities").find((a) => a.relatedType === "proposal");
    expect(act).toMatchObject({ relatedId: 40, subject: "Declined by Vee on the client portal", body: "Reason given: Budget moved" });
    const n = rows("notifications");
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ workspaceId: WS, userId: REP, title: "Proposal declined: Website rebuild", relatedType: "proposal", relatedId: 40 });
  });

  it("a second click is a no-op, and an accepted or draft proposal cannot be declined", async () => {
    proposal("sent");
    await anon().proposals.declineByToken({ token: "share-40" });
    expect(await anon().proposals.declineByToken({ token: "share-40" })).toEqual({ ok: true, alreadyDeclined: true });
    expect(rows("notifications")).toHaveLength(1);
    rows("proposals")[0].status = "accepted";
    expect((await refusal(anon().proposals.declineByToken({ token: "share-40" }))).message).toMatch(/can no longer be declined/);
    rows("proposals")[0].status = "draft";
    expect((await refusal(anon().proposals.declineByToken({ token: "share-40" }))).code).toBe("NOT_FOUND");
  });
});

/* ── the screens ──────────────────────────────────────────────────────── */

describe("the two pages offer Decline (G70)", () => {
  it("the meeting-proposal page has a Decline that posts to meetingPicks.decline, and shows declined and expired states", () => {
    const src = read("client/src/pages/MeetingPickPage.tsx");
    expect(src).toContain("trpc.meetingPicks.decline.useMutation");
    expect(src).toContain("decline.mutate({ token, note:");
    expect(src).toContain('d.state === "declined"');
    expect(src).toContain('d.state === "link_expired"');
    // The page's wording mirrors the server's TTL.
    expect(src).toContain(`const PICK_LINK_DAYS = ${PICK_LINK_TTL_DAYS};`);
  });

  it("the portal has a Decline beside Accept, shown only while the proposal is open", () => {
    const src = read("client/src/pages/ProposalPortal.tsx");
    expect(src).toContain("trpc.proposals.declineByToken.useMutation");
    const cta = src.slice(src.indexOf("{/* Accept / Decline CTA"), src.indexOf("Accepting notifies the team"));
    expect(cta).toContain("isOpenForAnswer(proposal.status)");
    expect(cta).toContain("setDeclineDialogOpen(true)");
    expect(src).toContain("declineMutation.mutate({ token,");
  });
});
