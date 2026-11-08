/**
 * Audit final pass, batch CRMP (2026-11-07): leads and People, against the
 * real routers and the SQL fake.
 *
 *   F31 · a converted lead's new company, contact and deal keep the lead's
 *         owner, unless the converter picks someone
 *   F33 · a lead made by promoting a person is scored when made, and that
 *         score never asks for an enrolment
 *   F36 · a lead is not created twice for one address without saying so; one
 *         company's People (?companyId=); who works at a company flagged
 *         "do not contact now" before an enrolment
 *   U28 · People and Companies keep the previous page on screen while the next
 *         one loads
 *
 * Screens are pinned by source. Time is frozen at T0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "d".repeat(64);
  return { db: null as any, enrolled: [] as any[] };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/workflowEngine", async (a) => ({
  ...(await a<typeof import("./services/workflowEngine")>()),
  fireRecordCreated: async () => {},
  fireRecordUpdated: async () => {},
  fireStageChanged: async () => {},
}));
vi.mock("./services/personLink", async (a) => ({ ...(await a<typeof import("./services/personLink")>()), upsertPersonForContact: async () => {} }));
vi.mock("./services/policyNotify", async (a) => ({ ...(await a<typeof import("./services/policyNotify")>()), notifyIfEnabled: async () => {} }));
vi.mock("./sequenceEngine", async (a) => ({
  ...(await a<typeof import("./sequenceEngine")>()),
  autoEnrollByTriggers: async (e: any) => { h.enrolled.push(e); },
}));
vi.mock("./_core/llm", async (a) => ({ ...(await a<typeof import("./_core/llm")>()), invokeLLM: async () => { throw new Error("no AI in tests"); } }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { invalidateArchivedWorkspaceCache } from "./_core/workspaceArchive";

const WS = 2, OTHER = 7;
const ADMIN = 20, REP = 21, LEFT = 22, OUTSIDER = 30;
const T0 = new Date("2026-11-18T15:00:00Z").getTime();
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
/** The block of `src` from `start` to the next `end` after it; throws if `start` is absent. */
const block = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`missing ${start}`);
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j < 0 ? undefined : j);
};

function seed() {
  rows("workspaces").push(
    { id: WS, name: "LSI", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" },
    { id: OTHER, name: "Other", slug: "other", ownerUserId: OUTSIDER, archivedAt: null, plan: "trial" },
  );
  const user = (id: number) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: `u${id}@lsi.example`, loginMethod: "password", role: "user",
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN), user(REP), user(LEFT), user(OUTSIDER));
  const member = (id: number, workspaceId: number, userId: number, role: string, deactivatedAt: Date | null = null) => ({
    id, workspaceId, userId, role, title: null, quota: null, deactivatedAt, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(
    member(1, WS, ADMIN, "admin"), member(2, WS, REP, "rep"), member(3, WS, LEFT, "rep", new Date(T0 - 86_400_000)),
    member(4, OTHER, OUTSIDER, "admin"),
  );
  rows("workspace_settings").push({ workspaceId: WS, llmMonthlyTokenCap: null, outboundPausedAt: null, timezone: "UTC" });
  rows("crm_pipelines").push({ id: 1, workspaceId: WS, name: "Default", isDefault: true, sortOrder: 0 });
  rows("crm_pipeline_stages").push(
    { id: 11, workspaceId: WS, pipelineId: 1, key: "lead_in", label: "Lead in", sortOrder: 10, defaultWinProb: 15, isWon: false, isLost: false },
    { id: 12, workspaceId: WS, pipelineId: 1, key: "won", label: "Won", sortOrder: 90, defaultWinProb: 100, isWon: true, isLost: false },
  );
}

function lead(id: number, over: Record<string, unknown> = {}) {
  rows("leads").push({
    id, workspaceId: WS, firstName: "Ann", lastName: "Lee", email: "ann.lee@acme.example", phone: null, company: "Acme",
    title: "VP Ops", source: null, status: "new", score: 0, grade: null, scoreReasons: null, scoredAt: null,
    convertedContactId: null, convertedAccountId: null, convertedOpportunityId: null, ownerUserId: REP, ...over,
  });
}

function caller(userId: number, ws = WS) {
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
  h.db = makeSqlFakeDb({ realMembers: true });
  h.enrolled = [];
  invalidateStageIndex();
  invalidateArchivedWorkspaceCache();
  seed();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ── F31 ─────────────────────────────────────────────────────────────── */

describe("a converted lead keeps its owner (F31)", () => {
  it("the new company, contact and deal go to the lead's owner, not to whoever converts it", async () => {
    lead(1);
    expect((await caller(ADMIN).leads.convertPreview({ id: 1 })).leadOwnerUserId).toBe(REP);
    const r = await caller(ADMIN).leads.convert({ id: 1, accountId: null, contactId: null, createOpportunity: true, opportunityValue: 10 });
    expect(row("accounts", r.accountId).ownerUserId).toBe(REP);
    expect(row("contacts", r.contactId).ownerUserId).toBe(REP);
    expect(row("opportunities", r.opportunityId!).ownerUserId).toBe(REP);
  });

  it("a person the converter picks gets them instead", async () => {
    lead(1);
    const r = await caller(REP).leads.convert({ id: 1, accountId: null, contactId: null, createOpportunity: true, opportunityValue: 0, ownerUserId: ADMIN });
    expect([row("accounts", r.accountId).ownerUserId, row("contacts", r.contactId).ownerUserId, row("opportunities", r.opportunityId!).ownerUserId])
      .toEqual([ADMIN, ADMIN, ADMIN]);
  });

  it("a lead owner who has left falls back to the converter, and an outsider cannot be picked", async () => {
    lead(1, { ownerUserId: LEFT });
    expect((await caller(ADMIN).leads.convertPreview({ id: 1 })).leadOwnerUserId).toBeNull();
    expect((await refusal(caller(ADMIN).leads.convert({ id: 1, accountId: null, contactId: null, ownerUserId: OUTSIDER }))).code).toBe("BAD_REQUEST");
    expect(row("leads", 1).status).toBe("new");
    const r = await caller(ADMIN).leads.convert({ id: 1, accountId: null, contactId: null });
    expect(row("contacts", r.contactId).ownerUserId).toBe(ADMIN);
  });

  it("the dialog offers the lead's owner by default and sends a pick only when made", () => {
    const src = read("client/src/components/usip/ConvertLeadDialog.tsx");
    expect(src).toContain(`ownerUserId: owner === "lead" ? undefined : Number(owner),`);
    expect(src).toContain(`<select id="convert-owner" value={owner}`);
    expect(src).toContain(`setOwner("lead");`);
  });
});

/* ── F33 ─────────────────────────────────────────────────────────────── */

describe("a lead made from a person is scored when made, and enrols no one (F33)", () => {
  it("promoteToLead scores the new lead off the request, without asking for an enrolment", async () => {
    rows("prospects").push({
      id: 1, workspaceId: WS, firstName: "Cara", lastName: "Diaz", email: "cara@county.example", title: "Chief Executive Officer",
      company: "County Works", phone: null, emailStatus: null, verificationStatus: null, linkedContactId: null, linkedLeadId: null, accountId: null,
    });
    const r = await caller(REP).prospects.promoteToLead({ prospectId: 1 });
    expect(r.created).toBe(true);
    await vi.waitFor(() => expect(row("leads", r.leadId).scoredAt).toBeInstanceOf(Date));
    expect(row("leads", r.leadId).score).toBeGreaterThan(0);
    expect(rows("lead_score_history").filter((x) => x.leadId === r.leadId)).toHaveLength(1);
    expect(h.enrolled).toEqual([]);
  });

  it("a booking's new lead is scored the same way", () => {
    const src = read("server/routers/bookingLinks.ts");
    const branch = block(src, "if (leadId) {\n      const createdLeadId = leadId;", "// Proposed meeting at the chosen time");
    expect(branch).toContain("m.scoreNewLeadInBackground(link.workspaceId, createdLeadId)");
  });

  it("the intake trigger never asks for an enrolment", () => {
    const src = read("server/routers/leadScoring.ts");
    expect(src).toContain(`const askEnrol = opts.trigger === "intake" ? false :`);
    expect(block(src, "export function scoreNewLeadInBackground", "\n}\n")).toContain(`trigger: "intake"`);
  });
});

/* ── F36 ─────────────────────────────────────────────────────────────── */

describe("one address, one lead, unless the person says otherwise (F36)", () => {
  it("refuses a second lead for an address a lead or a contact already has, in any case", async () => {
    lead(1);
    rows("contacts").push({ id: 5, workspaceId: WS, accountId: null, firstName: "Bo", lastName: "Ng", email: "Bo@Beta.example", companyName: "Beta", ownerUserId: REP });
    const a = await refusal(caller(REP).leads.create({ firstName: "Ann", lastName: "Lee", email: "ANN.LEE@acme.example" }));
    expect(a.code).toBe("CONFLICT");
    expect(a.message).toContain("lead #1, by email");
    expect((await refusal(caller(REP).leads.create({ firstName: "Bo", lastName: "Ng", email: "bo@beta.example" }))).message).toContain("contact #5");
    expect(rows("leads")).toHaveLength(1);
    const dupes = await caller(REP).leads.duplicateCheck({ email: "bo@beta.example" });
    expect(dupes.map((d) => [d.kind, d.id, d.matchedBy])).toEqual([["contact", 5, "email"]]);
  });

  it("creates it when told to, and a different address goes straight in", async () => {
    lead(1);
    const r = await caller(REP).leads.create({ firstName: "Ann", lastName: "Lee", email: "ann.lee@acme.example", allowDuplicate: true });
    expect(row("leads", r.id).email).toBe("ann.lee@acme.example");
    await caller(REP).leads.create({ firstName: "Cy", lastName: "Fox", email: "cy@acme.example" });
    expect(rows("leads")).toHaveLength(3);
  });

  it("with no address, the same name at the same company is a match and a name alone is not", async () => {
    lead(1, { email: null });
    expect((await refusal(caller(REP).leads.create({ firstName: "ann", lastName: "LEE", company: "acme" }))).message).toContain("by name + company");
    await caller(REP).leads.create({ firstName: "Ann", lastName: "Lee", company: "Other Co" });
    await caller(REP).leads.create({ firstName: "Ann", lastName: "Lee" });
    expect(rows("leads")).toHaveLength(3);
  });

  it("another workspace's lead is not a match", async () => {
    lead(1, { workspaceId: OTHER });
    await caller(REP).leads.create({ firstName: "Ann", lastName: "Lee", email: "ann.lee@acme.example" });
    expect(rows("leads").filter((l) => l.workspaceId === WS)).toHaveLength(1);
  });

  it("the New lead dialog checks first and creates anyway only when asked", () => {
    const src = read("client/src/pages/usip/Leads.tsx");
    const dialog = block(src, "function CreateLeadDialog", "\nfunction Field(");
    expect(dialog).toContain("utils.leads.duplicateCheck.fetch(");
    expect(dialog).toContain("create.mutate({ ...pending, allowDuplicate: true })");
    expect(dialog).toContain("This person may already be here");
  });
});

describe("one company's People (F36)", () => {
  const person = (id: number, accountId: number | null, workspaceId = WS) => ({
    id, workspaceId, firstName: `P${id}`, lastName: "X", email: null, title: null, company: "Acme", emailStatus: null,
    verificationStatus: null, linkedContactId: null, linkedLeadId: null, accountId, createdAt: new Date(T0 - id * 1000),
  });
  it("prospects.list takes companyId and returns that company's people only", async () => {
    rows("prospects").push(person(1, 50), person(2, 51), person(3, 50), person(4, 50, OTHER));
    const r = await caller(REP).prospects.list({ page: 1, perPage: 50, companyId: 50 });
    expect(r.data.map((p: any) => p.id).sort()).toEqual([1, 3]);
    expect(r.total).toBe(2);
  });

  it("a saved search can keep the company filter, only for this workspace's company", async () => {
    rows("accounts").push({ id: 50, workspaceId: WS, name: "Acme" }, { id: 60, workspaceId: OTHER, name: "Theirs" });
    const config = (companyId: number) => ({ columns: ["name"] as any, filters: { companyId }, sort: { field: "relevance" as const, dir: "desc" as const } });
    expect((await refusal(caller(REP).savedSearches.save({ surface: "people", name: "Theirs", config: config(60) } as any))).code).toBe("NOT_FOUND");
    const { id } = await caller(REP).savedSearches.save({ surface: "people", name: "Acme people", config: config(50) } as any);
    expect(rows("saved_searches").find((s) => s.id === id).config.filters).toEqual({ companyId: 50 });
    const { normalizeViewConfig } = await import("../client/src/components/usip/people/savedSearchConfig");
    expect(normalizeViewConfig({ columns: ["name"], filters: { companyId: 50 } }).filters).toEqual({ companyId: 50 });
    expect(normalizeViewConfig({ columns: ["name"], filters: { companyId: "50" } }).filters).toEqual({});
  });

  it("People reads ?companyId=, shows it as a removable filter, and the company page links to it", () => {
    const src = read("client/src/pages/usip/People.tsx");
    // 2026-11-08 (audit U6): read (and written) through the shared URL-state hook.
    expect(src).toContain(`const [companyId, setCompanyId] = useUrlState("companyId", urlParam.id());`);
    expect(block(src, "const listQuery = {", "};")).toContain("companyId: companyId ?? undefined,");
    expect(src).toContain(`case "companyId": setCompanyId(null); resetPage(); break;`);
    expect(read("client/src/pages/usip/CompanyProfile.tsx")).toContain("setLocation(`/v2/people?companyId=${id}`)");
  });
});

describe("who works at a company flagged do not contact now, before an enrolment (F36)", () => {
  beforeEach(() => {
    rows("accounts").push(
      { id: 50, workspaceId: WS, name: "Distressed Inc", customFields: { downstreamFit: { flags: ["financial-distress"] } }, archivedAt: null },
      { id: 51, workspaceId: WS, name: "Healthy Co", customFields: { downstreamFit: { flags: ["small-budget"] } }, archivedAt: null },
      { id: 52, workspaceId: OTHER, name: "Theirs", customFields: { downstreamFit: { flags: ["financial-distress"] } }, archivedAt: null },
    );
    rows("prospects").push(
      { id: 1, workspaceId: WS, firstName: "A", lastName: "A", accountId: 50 },
      { id: 2, workspaceId: WS, firstName: "B", lastName: "B", accountId: 51 },
      { id: 3, workspaceId: WS, firstName: "C", lastName: "C", accountId: 52 },
    );
    rows("contacts").push({ id: 7, workspaceId: WS, firstName: "D", lastName: "D", accountId: 50 });
    lead(9, { company: "Distressed Inc" });
    lead(10, { company: "Healthy Co" });
  });

  it("names them, counts them, and lists their ids by kind", async () => {
    const r = await caller(REP).prospects.doNotContactCompanies({ prospectIds: [1, 2, 3], contactIds: [7], leadIds: [9, 10] });
    expect(r.people).toBe(3);
    expect(r.companies).toEqual([{ accountId: 50, name: "Distressed Inc", people: 3 }]);
    expect(r.flagged).toEqual({ prospectIds: [1], contactIds: [7], leadIds: [9] });
  });

  it("finds none among people at unflagged companies", async () => {
    const r = await caller(REP).prospects.doNotContactCompanies({ prospectIds: [2], leadIds: [10] });
    expect(r).toEqual({ people: 0, companies: [], flagged: { prospectIds: [], contactIds: [], leadIds: [] } });
  });

  it("the Add to… review holds Confirm until the person leaves them out or includes them", () => {
    const src = read("client/src/components/usip/AddToMenu.tsx");
    expect(src).toContain(`const dncBlocks = !!picked && (dnc == null || (dncFlagged && dncChoice === "ask"));`);
    expect(src).toContain("<Button size=\"sm\" onClick={confirm} disabled={pending || dncBlocks}>");
    expect(src).toContain(`const skip = dncFlagged && dncChoice === "leave_out" ? dnc!.flagged : null;`);
  });
});

/* ── U28 ─────────────────────────────────────────────────────────────── */

describe("the previous page stays visible while the next loads (U28)", () => {
  it("People's list query keeps its last page", () => {
    expect(read("client/src/pages/usip/People.tsx")).toContain("trpc.prospects.list.useQuery(listQuery, { placeholderData: (prev) => prev });");
  });
  it("Companies' search keeps its last page", () => {
    expect(read("client/src/pages/usip/Companies.tsx")).toContain("trpc.companies.search.useQuery({ filters, sort, page, perPage }, { placeholderData: (prev) => prev });");
  });
});
