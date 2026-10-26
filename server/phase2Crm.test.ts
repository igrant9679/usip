/**
 * Phase 2 of the 2026-10-20 audit, slice B — CRM records you can trust — run
 * against the real routers and the SQL-evaluating fake (`__fakes__/sqlFakeDb`),
 * whose db.transaction rolls every table back when its body throws.
 *
 *   lead conversion: claimed once, matches, no invented deal, atomic (R8) ·
 *   company merge: the survivor named, every reference moved, one customer,
 *   atomic (R12) · contact merge: admin only, never into itself, every
 *   reference moved, audited, atomic (P9) · days picked as dates (R29) ·
 *   and the client fixes that have no server half, pinned in their source:
 *   the Custom Fields crash (R1), selection that follows the query (R4), a
 *   drawer per record (R6), amounts with cents (R28).
 *
 * Time is frozen at T0 — Wednesday 2026-11-18, 15:00 UTC (10:00 in New York).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  tz: "America/New_York",
  created: [] as any[],
  updated: [] as any[],
  personLinks: [] as any[],
  audits: [] as any[],
  failOn: null as null | ((table: string) => boolean),
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async (x: any) => { h.audits.push(x); } }));
vi.mock("./services/workspaceTimezone", async (a) => ({
  ...(await a<typeof import("./services/workspaceTimezone")>()),
  getWorkspaceTimezone: async () => h.tz,
}));
vi.mock("./services/workflowEngine", async (a) => ({
  ...(await a<typeof import("./services/workflowEngine")>()),
  fireRecordCreated: async (...args: unknown[]) => { h.created.push(args); },
  fireRecordUpdated: async (...args: unknown[]) => { h.updated.push(args); },
  fireStageChanged: async () => {},
}));
vi.mock("./services/personLink", async (a) => ({
  ...(await a<typeof import("./services/personLink")>()),
  upsertPersonForContact: async (...args: unknown[]) => { h.personLinks.push(args); },
}));

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { calendarDayFrom, deadlineFrom, endOfLocalDay } from "./services/calendarDeadline";

const LSI = 2;
const CF = 4;
const ADMIN = 20;
const REP = 21;
const T0 = new Date("2026-11-18T15:00:00Z").getTime();

const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
const count = (t: string, where: (r: any) => boolean = () => true) => rows(t).filter(where).length;

function seed() {
  rows("workspaces").push(
    { id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" },
    { id: CF, name: "CommunityForce", slug: "cf", ownerUserId: 10, archivedAt: null, plan: "trial" },
  );
  const user = (id: number, mail: string) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: mail, loginMethod: "password", role: "user",
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN, "admin@lsi.example"), user(REP, "rep@lsi.example"));
  const member = (id: number, workspaceId: number, userId: number, role: string) => ({
    id, workspaceId, userId, role, title: null, quota: null, deactivatedAt: null, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(member(1, LSI, ADMIN, "admin"), member(2, LSI, REP, "rep"));
  // A default pipeline whose first stage is NOT "discovery".
  rows("crm_pipelines").push({ id: 1, workspaceId: LSI, name: "Default", isDefault: true, sortOrder: 0 });
  rows("crm_pipeline_stages").push(
    { id: 11, workspaceId: LSI, pipelineId: 1, key: "lead_in", label: "Lead in", sortOrder: 10, defaultWinProb: 15, isWon: false, isLost: false },
    { id: 12, workspaceId: LSI, pipelineId: 1, key: "won", label: "Won", sortOrder: 90, defaultWinProb: 100, isWon: true, isLost: false },
    { id: 13, workspaceId: LSI, pipelineId: 1, key: "lost", label: "Lost", sortOrder: 99, defaultWinProb: 0, isWon: false, isLost: true },
  );
}

function account(id: number, over: Record<string, unknown> = {}) {
  rows("accounts").push({
    id, workspaceId: LSI, name: `Account ${id}`, domain: null, normalizedName: null, normalizedDomain: null,
    parentAccountId: null, archivedAt: null, dataStatus: null, ownerUserId: REP, ...over,
  });
}
function contact(id: number, over: Record<string, unknown> = {}) {
  rows("contacts").push({
    id, workspaceId: LSI, accountId: null, firstName: "Ann", lastName: "Lee", email: null, phone: null, title: null,
    linkedinUrl: null, city: null, seniority: null, isPrimary: false, ownerUserId: REP, ...over,
  });
}
function lead(id: number, over: Record<string, unknown> = {}) {
  rows("leads").push({
    id, workspaceId: LSI, firstName: "Ann", lastName: "Lee", email: "Ann.Lee@Acme.example", phone: null, company: "Acme",
    title: "VP Ops", source: null, status: "new", score: 0, grade: null, convertedContactId: null, convertedAccountId: null,
    convertedOpportunityId: null, ownerUserId: REP, ...over,
  });
}

function caller(userId: number, ws = LSI) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  h.db = makeSqlFakeDb({ realMembers: true, beforeUpdate: (t) => { if (h.failOn?.(t)) throw new Error(`write to ${t} failed`); } });
  h.tz = "America/New_York";
  h.created = [];
  h.updated = [];
  h.personLinks = [];
  h.audits = [];
  h.failOn = null;
  invalidateStageIndex();
  seed();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ── R8: lead conversion ────────────────────────────────────────────────── */

describe("converting a lead (R8)", () => {
  beforeEach(() => {
    account(501, { name: "Acme Corp", domain: "acme.example", normalizedDomain: "acme.example", normalizedName: "acme" });
    account(502, { name: "Acme", normalizedName: "acme" });
    account(503, { name: "Old Acme", normalizedDomain: "acme.example", archivedAt: new Date(T0 - 86_400_000) });
    contact(701, { accountId: 501, email: "ann.lee@acme.example" });
    lead(1);
  });

  it("offers the accounts it may already be and the contact with its address", async () => {
    const p = await caller(REP).leads.convertPreview({ id: 1 });
    expect(p.accountMatches.map((a) => [a.id, a.reason])).toEqual([[501, "domain"], [502, "name"]]);
    expect(p.contactMatch).toMatchObject({ id: 701 });
    expect(p.alreadyConverted).toBe(false);
  });

  it("converts into the matches by default, and makes no deal unless asked", async () => {
    const before = { accounts: count("accounts"), contacts: count("contacts"), opps: count("opportunities") };
    const r = await caller(REP).leads.convert({ id: 1 });
    expect(r).toMatchObject({ accountId: 501, contactId: 701, opportunityId: null, accountCreated: false, contactCreated: false });
    expect([count("accounts"), count("contacts"), count("opportunities")]).toEqual([before.accounts, before.contacts, before.opps]);
    expect(row("leads", 1)).toMatchObject({ status: "converted", convertedAccountId: 501, convertedContactId: 701, convertedOpportunityId: null });
    // A reused contact was created long ago: no record_created for it.
    await vi.waitFor(() => expect(h.updated).toHaveLength(1));
    expect(h.created).toHaveLength(0);
    expect(h.personLinks).toHaveLength(0);
  });

  it("creates new records when told to, and a deal only with the value given, in the pipeline's first open stage", async () => {
    const r = await caller(REP).leads.convert({ id: 1, accountId: null, contactId: null, createOpportunity: true, opportunityValue: 1234.5 });
    expect(r.accountCreated && r.contactCreated).toBe(true);
    expect(row("accounts", r.accountId)).toMatchObject({ name: "Acme", domain: "acme.example", normalizedDomain: "acme.example" });
    expect(row("contacts", r.contactId)).toMatchObject({ accountId: r.accountId, email: "Ann.Lee@Acme.example" });
    expect(row("opportunities", r.opportunityId!)).toMatchObject({ stage: "lead_in", pipelineId: 1, value: "1234.5", winProb: 15, accountId: r.accountId });
    expect(row("opportunities", r.opportunityId!).stageEnteredAt.getTime()).toBe(T0);
    await vi.waitFor(() => expect(h.created).toHaveLength(2));
    expect(h.personLinks).toHaveLength(1);
  });

  it("a deal asked for with no value is worth 0, not $25,000", async () => {
    const r = await caller(REP).leads.convert({ id: 1, createOpportunity: true });
    expect(row("opportunities", r.opportunityId!).value).toBe("0");
  });

  it("converts once: a second convert is refused and creates nothing", async () => {
    await caller(REP).leads.convert({ id: 1, accountId: null, contactId: null });
    const after = { accounts: count("accounts"), contacts: count("contacts") };
    expect((await refusal(caller(REP).leads.convert({ id: 1, accountId: null, contactId: null }))).code).toBe("CONFLICT");
    expect([count("accounts"), count("contacts")]).toEqual([after.accounts, after.contacts]);
  });

  it("of two simultaneous converts, the one that loses the claim creates nothing", async () => {
    // Another request converts the lead between our read and our claim.
    h.failOn = (t) => { if (t === "leads" && row("leads", 1).status !== "converted") row("leads", 1).status = "converted"; return false; };
    const before = { accounts: count("accounts"), contacts: count("contacts") };
    expect((await refusal(caller(REP).leads.convert({ id: 1, accountId: null, contactId: null }))).code).toBe("CONFLICT");
    expect([count("accounts"), count("contacts")]).toEqual([before.accounts, before.contacts]);
  });

  it("a failure part-way leaves the lead unconverted and nothing half-made", async () => {
    let leadWrites = 0;
    h.failOn = (t) => t === "leads" && ++leadWrites === 2; // the claim lands; the final write fails
    const before = { accounts: count("accounts"), contacts: count("contacts"), opps: count("opportunities") };
    expect((await refusal(caller(REP).leads.convert({ id: 1, accountId: null, contactId: null, createOpportunity: true, opportunityValue: 10 }))).message).toMatch(/write to leads failed/);
    expect(row("leads", 1).status).toBe("new");
    expect([count("accounts"), count("contacts"), count("opportunities")]).toEqual([before.accounts, before.contacts, before.opps]);
    expect(h.db.txLog.rolledBack).toBe(1);
  });

  it("refuses another workspace's account", async () => {
    rows("accounts").push({ id: 601, workspaceId: CF, name: "Theirs", archivedAt: null });
    expect((await refusal(caller(REP).leads.convert({ id: 1, accountId: 601 }))).code).toBe("BAD_REQUEST");
    expect(row("leads", 1).status).toBe("new");
  });
});

/* ── R12: company merge ─────────────────────────────────────────────────── */

describe("merging two companies (R12)", () => {
  beforeEach(() => {
    account(501, { name: "Acme" });
    account(502, { name: "ACME Inc" });
    account(503, { name: "Acme Labs", parentAccountId: 502 });
    contact(701, { accountId: 502 });
    rows("opportunities").push({ id: 801, workspaceId: LSI, accountId: 502, name: "Deal", stage: "lead_in", value: "100.00", winProb: 15, pipelineId: 1 });
    rows("proposals").push({ id: 901, workspaceId: LSI, accountId: 502, title: "P", clientName: "Acme", status: "draft" });
    rows("tasks").push({ id: 1, workspaceId: LSI, title: "Call", relatedType: "account", relatedId: 502, status: "open" });
    rows("tasks").push({ id: 2, workspaceId: LSI, title: "Other", relatedType: "contact", relatedId: 502, status: "open" });
    rows("crm_notes").push({ id: 1, workspaceId: LSI, entityType: "account", entityId: 502, body: "note" });
    rows("account_briefs").push({ id: 1, workspaceId: LSI, accountId: 502, content: "brief" });
    rows("record_list_members").push(
      { id: 1, workspaceId: LSI, listId: 1, recordType: "account", recordId: 501 },
      { id: 2, workspaceId: LSI, listId: 1, recordType: "account", recordId: 502 },
      { id: 3, workspaceId: LSI, listId: 2, recordType: "account", recordId: 502 },
    );
    rows("customers").push(
      { id: 1001, workspaceId: LSI, accountId: 501, arr: "5000.00" },
      { id: 1002, workspaceId: LSI, accountId: 502, arr: "7000.00" },
    );
    rows("qbrs").push({ id: 1, workspaceId: LSI, customerId: 1002, status: "scheduled" });
    rows("support_tickets").push({ id: 1, workspaceId: LSI, customerId: 1002, subject: "Help" });
  });

  it("moves every reference to the survivor and keeps one customer", async () => {
    const r = await caller(ADMIN).companies.merge({ primaryAccountId: 501, duplicateAccountId: 502 });
    expect(row("contacts", 701).accountId).toBe(501);
    expect(row("opportunities", 801).accountId).toBe(501);
    expect(row("proposals", 901).accountId).toBe(501);
    expect(row("tasks", 1).relatedId).toBe(501);
    expect(row("tasks", 2).relatedId).toBe(502); // a CONTACT's task with the same number is not moved
    expect(row("crm_notes", 1).entityId).toBe(501);
    expect(row("account_briefs", 1).accountId).toBe(501);
    expect(row("accounts", 503).parentAccountId).toBe(501);
    // The list that already held the survivor holds it once.
    expect(rows("record_list_members").map((m) => [m.listId, m.recordId]).sort()).toEqual([[1, 501], [2, 501]]);
    // One customer, whose ARR stands; the duplicate's QBRs and tickets follow it.
    expect(rows("customers").map((c) => [c.id, c.accountId, c.arr])).toEqual([[1001, 501, "5000.00"]]);
    expect(row("qbrs", 1).customerId).toBe(1001);
    expect(row("support_tickets", 1).customerId).toBe(1001);
    expect(r.customerFolded).toEqual({ from: 1002, into: 1001, droppedArr: "7000.00" });
    expect(row("accounts", 502)).toMatchObject({ dataStatus: "merged" });
    expect(row("accounts", 502).archivedAt).toBeTruthy();
    expect(rows("activities").at(-1)).toMatchObject({ relatedType: "account", relatedId: 501, body: expect.stringContaining("ARR 7000.00") });
    expect(h.audits.at(-1)).toMatchObject({ entityType: "account_merge", after: expect.objectContaining({ merged: 502, customerFolded: r.customerFolded }) });
  });

  it("a lone customer row simply moves to the survivor", async () => {
    rows("customers").splice(0, 1);
    await caller(ADMIN).companies.merge({ primaryAccountId: 501, duplicateAccountId: 502 });
    expect(rows("customers").map((c) => [c.id, c.accountId])).toEqual([[1002, 501]]);
  });

  it("is all or nothing", async () => {
    h.failOn = (t) => t === "accounts" && row("contacts", 701).accountId === 501 && row("accounts", 503).parentAccountId === 501;
    expect((await refusal(caller(ADMIN).companies.merge({ primaryAccountId: 501, duplicateAccountId: 502 }))).message).toMatch(/failed/);
    expect(row("contacts", 701).accountId).toBe(502);
    expect(rows("customers")).toHaveLength(2);
    expect(row("accounts", 502).archivedAt).toBeNull();
  });

  it("refuses itself, a merged duplicate, and a non-admin", async () => {
    expect((await refusal(caller(ADMIN).companies.merge({ primaryAccountId: 501, duplicateAccountId: 501 }))).code).toBe("BAD_REQUEST");
    await caller(ADMIN).companies.merge({ primaryAccountId: 501, duplicateAccountId: 502 });
    expect((await refusal(caller(ADMIN).companies.merge({ primaryAccountId: 501, duplicateAccountId: 502 }))).message).toMatch(/already merged/);
    expect((await refusal(caller(ADMIN).companies.merge({ primaryAccountId: 502, duplicateAccountId: 503 }))).message).toMatch(/merged away already/);
    expect((await refusal(caller(REP).companies.merge({ primaryAccountId: 501, duplicateAccountId: 503 }))).code).toBe("FORBIDDEN");
  });
});

/* ── P9: contact merge ──────────────────────────────────────────────────── */

describe("merging two contacts (P9)", () => {
  beforeEach(() => {
    contact(701, { title: null, phone: "555-0100", email: "ann@acme.example" });
    contact(702, { title: "VP", phone: "555-0199", email: "ann.lee@acme.example" });
    rows("tasks").push({ id: 1, workspaceId: LSI, title: "Call", relatedType: "contact", relatedId: 702, status: "open" });
    rows("tasks").push({ id: 2, workspaceId: LSI, title: "Account task", relatedType: "account", relatedId: 702, status: "open" });
    rows("email_suppressions").push({ id: 1, workspaceId: LSI, email: "ann.lee@acme.example", contactId: 702 });
    rows("proposals").push({ id: 901, workspaceId: LSI, contactId: 702, title: "P", clientName: "Acme", status: "draft" });
    rows("prospects").push({ id: 301, workspaceId: LSI, firstName: "Ann", lastName: "Lee", linkedContactId: 702 });
    rows("opportunity_contact_roles").push(
      { id: 1, workspaceId: LSI, opportunityId: 801, contactId: 701, role: "champion" },
      { id: 2, workspaceId: LSI, opportunityId: 801, contactId: 702, role: "user" },
      { id: 3, workspaceId: LSI, opportunityId: 802, contactId: 702, role: "buyer" },
    );
    rows("enrollments").push(
      { id: 1, workspaceId: LSI, sequenceId: 5, contactId: 701, status: "active" },
      { id: 2, workspaceId: LSI, sequenceId: 5, contactId: 702, status: "active" },
      { id: 3, workspaceId: LSI, sequenceId: 6, contactId: 702, status: "active" },
    );
    rows("record_list_members").push(
      { id: 1, workspaceId: LSI, listId: 1, recordType: "contact", recordId: 701 },
      { id: 2, workspaceId: LSI, listId: 1, recordType: "contact", recordId: 702 },
    );
  });

  it("moves every reference, collapses doubles, audits the deleted row, then deletes it", async () => {
    const r = await caller(ADMIN).dataHealth.mergeContacts({ primaryId: 701, secondaryId: 702 });
    expect(r.mergedFields).toEqual(["title"]); // blank filled; the survivor's own phone kept
    expect(row("contacts", 701)).toMatchObject({ title: "VP", phone: "555-0100" });
    expect(row("tasks", 1).relatedId).toBe(701);
    expect(row("tasks", 2).relatedId).toBe(702); // an ACCOUNT's task with the same number stays
    // The opt-out follows the person: the survivor is not mailable through it.
    expect(row("email_suppressions", 1).contactId).toBe(701);
    expect(row("proposals", 901).contactId).toBe(701);
    expect(row("prospects", 301).linkedContactId).toBe(701);
    expect(rows("opportunity_contact_roles").map((x) => [x.opportunityId, x.contactId]).sort()).toEqual([[801, 701], [802, 701]]);
    // Not in sequence 5 twice: the duplicate's enrolment ends.
    expect(rows("enrollments").map((e) => [e.id, e.contactId, e.status])).toEqual([[1, 701, "active"], [2, 701, "exited"], [3, 701, "active"]]);
    expect(rows("record_list_members").map((m) => m.recordId)).toEqual([701]);
    expect(row("contacts", 702)).toBeUndefined();
    const audit = rows("audit_log").at(-1);
    expect(audit).toMatchObject({ entityType: "contact_merge", entityId: 701, actorUserId: ADMIN, action: "delete" });
    expect(audit.before).toMatchObject({ id: 702, email: "ann.lee@acme.example" });
  });

  it("is all or nothing", async () => {
    h.failOn = (t) => t === "enrollments";
    expect((await refusal(caller(ADMIN).dataHealth.mergeContacts({ primaryId: 701, secondaryId: 702 }))).message).toMatch(/failed/);
    expect(row("contacts", 702)).toBeTruthy();
    expect(row("tasks", 1).relatedId).toBe(702);
    expect(row("email_suppressions", 1).contactId).toBe(702);
    expect(rows("audit_log")).toHaveLength(0);
  });

  it("never merges a contact into itself, and is an admin action", async () => {
    expect((await refusal(caller(ADMIN).dataHealth.mergeContacts({ primaryId: 701, secondaryId: 701 }))).code).toBe("BAD_REQUEST");
    expect(row("contacts", 701)).toBeTruthy();
    expect((await refusal(caller(REP).dataHealth.mergeContacts({ primaryId: 701, secondaryId: 702 }))).code).toBe("FORBIDDEN");
    expect(row("contacts", 702)).toBeTruthy();
  });
});

/* ── R29: days picked as dates ──────────────────────────────────────────── */

describe("a day picked as a date stays that day (R29)", () => {
  it("a deadline lasts to the end of its day in the workspace's zone", () => {
    expect(endOfLocalDay("2026-11-18", "America/New_York")!.toISOString()).toBe("2026-11-19T04:59:59.999Z");
    expect(endOfLocalDay("2026-11-30", "UTC")!.toISOString()).toBe("2026-11-30T23:59:59.999Z"); // month end rolls over
    // New York's day of Nov 1, 2026 is 25 hours long (daylight time ends).
    expect(endOfLocalDay("2026-11-01", "America/New_York")!.toISOString()).toBe("2026-11-02T04:59:59.999Z");
    expect(endOfLocalDay("2026-02-30", "UTC")).toBeNull();
    // An instant is kept as sent.
    expect(deadlineFrom("2026-11-18T09:30:00.000Z", "America/New_York")!.toISOString()).toBe("2026-11-18T09:30:00.000Z");
    expect(deadlineFrom("", "UTC")).toBeNull();
    expect(calendarDayFrom("2026-12-03")!.toISOString()).toBe("2026-12-03T12:00:00.000Z");
  });

  it("a task due today is due today, not overdue at creation", async () => {
    const rep = caller(REP);
    await rep.tasks.create({ title: "Today", dueAt: "2026-11-18" });
    expect(rows("tasks").at(-1).dueAt.toISOString()).toBe("2026-11-19T04:59:59.999Z");
    const s = await rep.tasks.stats();
    expect(s.overdue).toBe(0);
    expect(s.dueToday).toBe(1);
  });

  it("a proposal expires at the end of its day, and a QBR keeps its day", async () => {
    const admin = caller(ADMIN);
    const { id } = await admin.proposals.create({ title: "P", clientName: "Acme", expiresAt: "2026-11-20", completionDate: "2027-01-15" });
    expect(row("proposals", id).expiresAt.toISOString()).toBe("2026-11-21T04:59:59.999Z");
    expect(row("proposals", id).completionDate.toISOString()).toBe("2027-01-15T12:00:00.000Z");
    rows("customers").push({ id: 1001, workspaceId: LSI, accountId: 501, arr: "0" });
    const q = await admin.cs.scheduleQbr({ customerId: 1001, scheduledAt: "2026-12-03" });
    expect(row("qbrs", q.id).scheduledAt.toISOString()).toBe("2026-12-03T12:00:00.000Z");
  });
});

/* ── Client fixes with no server half, pinned in their source ───────────── */

const ROOT = join(__dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
function clientFiles(dir = join(ROOT, "client", "src")): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? clientFiles(p) : /\.tsx$/.test(n) ? [p] : [];
  });
}

describe("the client fixes", () => {
  it("every component a page renders is imported or declared there (R1)", () => {
    // CustomFields.tsx rendered <ConfirmButton> without importing it: the page
    // threw as soon as one field existed, hidden among the tolerated tsc errors.
    const files = clientFiles();
    expect(files.length).toBeGreaterThan(200);
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const tags = new Set(Array.from(src.matchAll(/(^|[^\w.$])<([A-Z][A-Za-z0-9_]*)(?=[\s/>])/gm)).map((m) => m[2]));
      tags.forEach((t) => {
        const known = new RegExp(`import[^;]*\\b${t}\\b[^;]*from`).test(src)
          || new RegExp(`(function|const|let|var|class)\\s+${t}\\b`).test(src)
          || new RegExp(`\\{[^}]*\\b${t}\\b[^}]*\\}\\s*=`).test(src)
          || new RegExp(`\\w\\s*:\\s*${t}\\s*[,}]`).test(src)
          || new RegExp(`[({,]\\s*${t}\\s*[,}]`).test(src);
        if (!known) missing.push(`${relative(ROOT, f)}: <${t}>`);
      });
    }
    expect(missing).toEqual([]);
  });

  it("each bulk-action list clears its selection when its query changes (R4)", () => {
    const pins: Array<[string, string]> = [
      ["client/src/pages/usip/People.tsx", "useClearOnChange(listQuery, () => setChecked(new Set()));"],
      ["client/src/pages/usip/Companies.tsx", "useClearOnChange({ filters, sort, page }, () => setChecked(new Set()));"],
      ["client/src/pages/usip/Leads.tsx", "useClearOnChange({ search }, () => setSelectedIds(new Set()));"],
      ["client/src/pages/usip/Prospects.tsx", "useClearOnChange(listQuery, () => setSelectedIds(new Set()));"],
      ["client/src/pages/usip/Proposals.tsx", "useClearOnChange({ search, statusFilter, sortBy, expiryWindow }, () => setSelectedIds(new Set()));"],
    ];
    for (const [f, call] of pins) expect(read(f), f).toContain(call);
    // The list query is the scope, so a new filter cannot be left out of it.
    expect(read("client/src/pages/usip/People.tsx")).toContain("trpc.prospects.list.useQuery(listQuery)");
    expect(read("client/src/pages/usip/Prospects.tsx")).toContain("trpc.prospects.list.useQuery(listQuery)");
    const hook = read("client/src/hooks/useClearOnChange.ts");
    expect(hook).toContain("if (seen.current === key) return;");
  });

  it("the record drawer starts fresh for each record (R6)", () => {
    const src = read("client/src/components/usip/RecordDrawer.tsx");
    expect(src).toContain('<RecordDrawerForRecord key={`${props.relatedType}:${props.relatedId ?? "none"}`} {...props} />');
    expect(src).toContain('useState<DrawerTab>(() => (HAS_OVERVIEW.includes(relatedType) ? "overview" : "timeline"))');
    expect(src).toContain('const HAS_OVERVIEW: RelatedType[] = ["contact", "account", "opportunity"];');
  });

  it("amounts take cents (R28)", () => {
    const common = read("client/src/components/usip/Common.tsx");
    expect(common).toContain('{ type: "number", step: step ?? "0.01", min: allowNegative ? min : min ?? 0, max, inputMode: "decimal" as const }');
    for (const [f, field] of [
      ["client/src/pages/usip/Pipeline.tsx", '<Field name="value" label="Value ($)" type="money"'],
      ["client/src/pages/usip/Products.tsx", '<Field name="listPrice" label="List price" type="money"'],
      ["client/src/pages/usip/Products.tsx", '<Field name="cost" label="Cost" type="money"'],
      ["client/src/pages/usip/Customers.tsx", '<Field name="arrDelta" label="Δ ARR" type="money" allowNegative'],
      ["client/src/pages/usip/Team.tsx", '<Field name="quota" label="Annual quota (optional)" type="money"'],
    ]) expect(read(f), f).toContain(field);
  });
});
