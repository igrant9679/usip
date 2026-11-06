/**
 * Audit 2026-10-20, O24: leads imported from LinkedIn search could never get
 * a LinkedIn step. The import keeps the profile in `leads.customFields.linkedinUrl`
 * (leads have no linkedinUrl column), and the engine's lead branch read
 * nothing at all, so every DM and invite step skipped them as "no LinkedIn
 * profile on the record".
 *
 * Run against the real engine and an in-memory database that evaluates the
 * SQL it renders. Every send goes to a recording mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: null as any,
  windowOpen: true,
  dms: [] as any[],
  invites: [] as any[],
  gateChecks: [] as any[],
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./_core/workspaceArchive", async (a) => ({ ...(await a<typeof import("./_core/workspaceArchive")>()), archivedWorkspaceIds: async () => new Set<number>() }));
vi.mock("./services/sendWindow", async (a) => ({ ...(await a<typeof import("./services/sendWindow")>()), inSendWindow: async () => h.windowOpen }));
vi.mock("./services/workspaceTimezone", async (a) => ({ ...(await a<typeof import("./services/workspaceTimezone")>()), getWorkspaceTimezone: async () => "UTC" }));
vi.mock("./lib/unipile", async (a) => ({
  ...(await a<typeof import("./lib/unipile")>()),
  sendMessage: async (x: any) => { h.dms.push(x); return { id: `msg-${h.dms.length}`, chatId: `chat-${h.dms.length}` }; },
  sendLinkedInInvitation: async (x: any) => { h.invites.push(x); return {}; },
}));
vi.mock("./services/linkedin/activityGate", async (a) => ({
  ...(await a<typeof import("./services/linkedin/activityGate")>()),
  checkLinkedInAction: async (i: any) => { h.gateChecks.push(i); return { allowed: true, reason: null, message: "ok", retryAfterMs: null }; },
  recordLinkedInAction: async () => {},
}));
vi.mock("./mergeVars", async (a) => ({ ...(await a<typeof import("./mergeVars")>()), resolveBookingUrl: async () => "", buildMergeContextFromDb: async () => ({}) }));
vi.mock("./campaignCounters", async (a) => ({ ...(await a<typeof import("./campaignCounters")>()), bumpCampaignCounter: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { processEnrollments } from "./sequenceEngine";

const LSI = 2;
const ADMIN = 20;
const REP = 21;
const MIN = 60_000;
const T0 = new Date("2026-10-27T15:00:00Z").getTime();
const OPEN = { sendWindowStart: "00:00", sendWindowEnd: "23:59", skipWeekends: false };
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);

function seq(id: number, steps: unknown[]) {
  rows("sequences").push({
    id, workspaceId: LSI, name: `Sequence ${id}`, description: null, status: "active", steps, settings: OPEN,
    dailyCap: null, ownerUserId: REP, assignedToUserId: null, enrollmentTrigger: null, exitConditions: null,
    isTemplate: false, visibility: "team", sourceTemplateId: null, enrolledCount: 0, createdAt: new Date(), updatedAt: new Date(),
  });
}
function enr(id: number, sequenceId: number, who: Record<string, number>, over: Record<string, unknown> = {}) {
  rows("enrollments").push({
    id, workspaceId: LSI, sequenceId, contactId: null, leadId: null, prospectId: null, status: "active",
    currentStep: 0, startedAt: new Date(), nextActionAt: new Date(Date.now() - MIN), resumeAt: null, ...who, ...over,
  });
}
/** A lead as importSearchHitsAsLeads writes it (routers/unipile.ts). */
function searchLead(id: number, over: Record<string, unknown> = {}) {
  rows("leads").push({
    id, workspaceId: LSI, firstName: "Jo", lastName: "Search", email: null, title: "VP Sales", company: "Acme",
    source: "linkedin_search", status: "new", ownerUserId: REP,
    customFields: { linkedinUrl: "https://www.linkedin.com/in/jo-search", location: "Austin" }, ...over,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  h.db = makeSqlFakeDb({ realMembers: true });
  h.windowOpen = true;
  h.dms = [];
  h.invites = [];
  h.gateChecks = [];
  rows("workspaces").push({ id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  const user = (id: number, mail: string) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: mail, loginMethod: "password", role: "user",
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN, "admin@lsi.example"), user(REP, "rep@lsi.example"));
  const member = (id: number, userId: number, role: string) => ({
    id, workspaceId: LSI, userId, role, title: null, quota: null, deactivatedAt: null, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(member(1, ADMIN, "admin"), member(2, REP, "rep"));
  rows("unipile_accounts").push({ id: 2, workspaceId: LSI, userId: REP, unipileAccountId: "acc-rep", provider: "LINKEDIN" });
});
afterEach(() => { vi.useRealTimers(); });

describe("a lead imported from LinkedIn search gets its LinkedIn steps", () => {
  it("a DM step reads the profile from customFields and sends to it, rendered for the lead", async () => {
    searchLead(201);
    seq(1, [{ type: "linkedin_dm", body: "Hi {{firstName}} at {{company}}" }]);
    enr(11, 1, { leadId: 201 });
    await processEnrollments();
    expect(h.dms).toHaveLength(1);
    expect(h.dms[0]).toMatchObject({ accountId: "acc-rep", attendeesIds: ["jo-search"], text: "Hi Jo at Acme" });
    // Recorded against the lead, so a reply finds its way back.
    expect(rows("unipile_messages")[0]).toMatchObject({ recipientProviderId: "jo-search", linkedLeadId: 201 });
  });

  it("an invite step too, recorded against the lead", async () => {
    searchLead(202);
    seq(2, [{ type: "linkedin_invite", note: "Hi {{firstName}}" }]);
    enr(12, 2, { leadId: 202 });
    await processEnrollments();
    expect(h.invites).toHaveLength(1);
    expect(h.invites[0]).toMatchObject({ providerId: "jo-search", message: "Hi Jo" });
    expect(rows("unipile_invites")[0]).toMatchObject({ recipientProviderId: "jo-search", linkedLeadId: 202, status: "pending" });
  });

  it("a lead with no profile still skips, and the step moves on as before", async () => {
    searchLead(203, { customFields: { location: "Austin" } });
    seq(3, [{ type: "linkedin_dm", body: "Hi" }, { type: "wait", days: 1 }]);
    enr(13, 3, { leadId: 203 });
    await processEnrollments();
    expect(h.dms).toHaveLength(0);
    expect(row("enrollments", 13).currentStep).toBe(1);
  });

  it("a lead on the do-not-contact list by that profile is not messaged", async () => {
    searchLead(204);
    rows("are_suppression_list").push({ id: 1, workspaceId: LSI, email: null, linkedinUrl: "linkedin.com/in/jo-search", companyDomain: null, reason: "do_not_contact" });
    seq(4, [{ type: "linkedin_dm", body: "Hi" }]);
    enr(14, 4, { leadId: 204 });
    await processEnrollments();
    expect(h.dms).toHaveLength(0);
  });

  it("outside the window (or paused) nothing goes, and the step waits", async () => {
    h.windowOpen = false;
    searchLead(205);
    seq(5, [{ type: "linkedin_dm", body: "Hi" }]);
    enr(15, 5, { leadId: 205 });
    await processEnrollments();
    expect(h.dms).toHaveLength(0);
    expect(row("enrollments", 15).currentStep).toBe(0);
  });

  it("a step already skipped for this reason is not resurrected", async () => {
    // Skipped before the fix: the enrolment is past the DM step, on a wait.
    searchLead(206);
    seq(6, [{ type: "linkedin_dm", body: "Hi" }, { type: "wait", days: 3 }, { type: "linkedin_dm", body: "Again" }]);
    enr(16, 6, { leadId: 206 }, { currentStep: 1, nextActionAt: new Date(T0 + 2 * 86_400_000) });
    await processEnrollments();
    expect(h.dms).toHaveLength(0);
    expect(row("enrollments", 16).currentStep).toBe(1);
  });
});
