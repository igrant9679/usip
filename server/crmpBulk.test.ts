/**
 * Audit final pass, batch CRMP (2026-11-07): bulk actions on the server.
 *
 *   F30 · "Select all N matching" on People, Companies and Leads: the action
 *         names the list's filter, the server reads the same filter the list
 *         counts, refuses when the count is no longer the confirmed one, and
 *         runs the action as a job through the page's own procedures
 *   R66 · People's Enrich fully runs on the server as a job, not in batches
 *         of ten from the browser, and queues one LinkedIn lookup job after
 *
 * Against the real routers, the real job runner and the SQL fake; every
 * vendor is mocked and nothing leaves the process.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "a".repeat(64);
  return { db: null as any, role: "manager", enriched: [] as number[], linkedin: [] as number[][], companies: [] as number[][], audits: [] as any[] };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async (x: any) => { h.audits.push(x); } }));
vi.mock("./services/enrichment/comprehensivePass", async (a) => ({
  ...(await a<typeof import("./services/enrichment/comprehensivePass")>()),
  runComprehensiveEnrichment: async (o: { prospectId: number }) => { h.enriched.push(o.prospectId); return { ok: true, email: null, emailStatus: null, credits: { quick: 0, power: 0 }, phases: { pattern: "skipped" } }; },
}));
vi.mock("./services/linkedinEnrichment/health", async (a) => ({
  ...(await a<typeof import("./services/linkedinEnrichment/health")>()),
  checkLinkedInEnrichmentHealth: async () => ({ status: "connected", missing_requirements: [], linkedin_capable_account_count: 1 }),
}));
vi.mock("./services/linkedinEnrichment/orchestrator", async (a) => ({
  ...(await a<typeof import("./services/linkedinEnrichment/orchestrator")>()),
  runForProspects: async (o: { prospectIds: number[] }) => { h.linkedin.push(o.prospectIds); return { jobId: 99, total: o.prospectIds.length }; },
}));
vi.mock("./services/linkedinLookup", async (a) => ({ ...(await a<typeof import("./services/linkedinLookup")>()), listUsableAccounts: async () => [] }));
vi.mock("./services/company/enrichmentService", async (a) => ({
  ...(await a<typeof import("./services/company/enrichmentService")>()),
  bulkEnrichCompanies: async (_ws: number, ids: number[]) => { h.companies.push(ids); return { processed: ids.length, ok: ids.length }; },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { tickJobs, __resetJobRunnerForTests } from "./services/jobs/runner";
import { BULK_JOB } from "./services/bulkByFilter";

const WS = 2, OTHER = 9;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const user = { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
const caller = () => appRouter.createCaller({
  user,
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}
const person = (id: number, o: Record<string, unknown> = {}) => rows("prospects").push({
  id, workspaceId: WS, firstName: `P${id}`, lastName: "X", email: `p${id}@acme.example`, title: null, company: "Acme",
  emailStatus: null, verificationStatus: null, linkedContactId: null, linkedLeadId: null, accountId: null, linkedinUrl: null,
  createdAt: new Date(2026, 9, id), ...o,
});
async function drain() { for (let i = 0; i < 10; i++) if ((await tickJobs(60_000)) === 0) break; }

beforeEach(() => {
  h.role = "manager";
  h.enriched = []; h.linkedin = []; h.companies = []; h.audits = [];
  h.db = makeSqlFakeDb({ roles: new Proxy({}, { get: (_t, k) => (Number(k) === WS ? h.role : undefined) }) as Record<number, string>, wsId: () => WS });
  __resetJobRunnerForTests();
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("users").push({ ...user });
});

describe("Select all N matching acts on exactly the people the list counts (F30)", () => {
  beforeEach(() => {
    for (let id = 1; id <= 6; id++) person(id, { company: id <= 4 ? "Acme" : "Beta" });
    person(7, { company: "Acme", verificationStatus: "rejected" }); // archived: the list hides it
    person(8, { company: "Acme", workspaceId: OTHER });
  });

  it("the matching ids and count are the list's", async () => {
    const filter = { companyQ: "acme" };
    const list = await caller().prospects.list({ page: 1, perPage: 50, ...filter });
    const m = await caller().prospects.matchingIds({ filter });
    expect(m).toEqual({ ids: [1, 2, 3, 4], total: list.total, capped: false });
  });

  it("a count that changed since the confirmation refuses, and nothing is queued", async () => {
    const r = await refusal(caller().prospects.bulkByFilter({ action: "delete", filter: { companyQ: "acme" }, expectedTotal: 5 }));
    expect(r.code).toBe("CONFLICT");
    expect(r.message).toContain("4 people match these filters now, not 5");
    expect(rows("bulk_jobs")).toHaveLength(0);
  });

  it("delete by filter is a job through prospects.bulkDelete that removes the matching people only", async () => {
    const q = await caller().prospects.bulkByFilter({ action: "delete", filter: { companyQ: "acme" }, expectedTotal: 4 });
    expect(rows("bulk_jobs")[0]).toMatchObject({ id: q.jobId, kind: BULK_JOB, total: 4, status: "queued" });
    expect(rows("bulk_jobs")[0].payload).toMatchObject({ entity: "people", action: "delete", ids: [1, 2, 3, 4] });
    await drain();
    expect(rows("prospects").map((p) => p.id).sort((a, b) => a - b)).toEqual([5, 6, 7, 8]);
    const job = await caller().prospects.bulkJob({ jobId: q.jobId });
    expect(job).toMatchObject({ status: "done", done: 4, failed: 0, message: "Deleted 4 of 4" });
    // The rows are kept for a restore by bulkDelete's own audit entry.
    expect(h.audits.find((a) => a.entityType === "prospect_bulk").before.rows).toHaveLength(4);
    expect(h.audits.find((a) => a.entityType === "bulk_people_delete").after).toMatchObject({ requested: 4, done: 4, outcome: "done" });
  });

  it("add to list by filter adds through recordLists.addMembers, and refuses another workspace's list", async () => {
    rows("record_lists").push({ id: 30, workspaceId: WS, name: "Q4", entityType: "people", updatedAt: new Date() }, { id: 31, workspaceId: OTHER, name: "Theirs", entityType: "people", updatedAt: new Date() });
    expect((await refusal(caller().prospects.bulkByFilter({ action: "addToList", filter: { companyQ: "beta" }, expectedTotal: 2, params: { listId: 31 } }))).code).toBe("NOT_FOUND");
    await caller().prospects.bulkByFilter({ action: "addToList", filter: { companyQ: "beta" }, expectedTotal: 2, params: { listId: 30 } });
    await drain();
    expect(rows("record_list_members").map((m) => [m.listId, m.recordId])).toEqual([[30, 5], [30, 6]]);
  });

  it("verify keeps its 200-at-a-time limit", async () => {
    for (let id = 100; id < 302; id++) person(id, { company: "Gamma" });
    const r = await refusal(caller().prospects.bulkByFilter({ action: "verify", filter: { companyQ: "gamma" }, expectedTotal: 202 }));
    expect(r.code).toBe("BAD_REQUEST");
    expect(r.message).toContain("at most 200 people at a time");
  });

  it("each slice runs as the person who started it: a role lost since stops the job instead of failing everyone", async () => {
    rows("accounts").push({ id: 10, workspaceId: WS, name: "Acme Inc", domain: null, normalizedDomain: null, archivedAt: null, industry: "Software" });
    const q = await caller().companies.bulkByFilter({ action: "enrich", filters: { industries: ["Software"] }, expectedTotal: 1 });
    h.role = "rep";
    await drain();
    const job = rows("bulk_jobs").find((j) => j.id === q.jobId);
    expect(job.status).toBe("done");
    expect(String(job.message)).toMatch(/^Stopped: /);
    expect(h.companies).toEqual([]);
  });
});

describe("People's Enrich fully runs on the server (R66)", () => {
  it("a selection becomes one job, a person at a time, then one LinkedIn lookup job for those still without a profile", async () => {
    person(1, { linkedinUrl: "https://www.linkedin.com/in/one" });
    person(2);
    person(3, { linkedinUrl: "https://www.linkedin.com/in/three" });
    person(4, { workspaceId: OTHER });
    rows("prospect_linkedin_enrichments").push({ id: 1, workspaceId: WS, prospectId: 3, linkedinDataStatus: "enriched", linkedinLastRetrievedAt: new Date() });
    const q = await caller().prospects.enrichFullBulk({ ids: [3, 1, 2, 4] });
    expect(q.total).toBe(3); // another workspace's person never goes in
    expect(h.enriched).toEqual([]); // nothing ran inside the request
    await drain();
    expect(h.enriched).toEqual([1, 2, 3]);
    expect(h.linkedin).toEqual([[1]]);
    expect(h.audits.find((a) => a.entityType === "bulk_people_enrichFull").after).toMatchObject({ requested: 3, done: 3, linkedin: "LinkedIn lookups queued for 1" });
  });

  it("the toolbar starts the job and follows it; it no longer loops ten at a time from the browser", () => {
    const src = read("client/src/components/usip/people/SelectionToolbar.tsx");
    const enrich = src.slice(src.indexOf("function EnrichMenu"), src.indexOf("function MoreMenu"));
    expect(enrich).toContain("else enrichFullBulk.mutate({ ids: selectedIds });");
    expect(enrich).not.toContain("findContactInfoBatch");
    expect(enrich).not.toContain("const CHUNK = 10;");
    // The spend is stated first, as before (F8).
    expect(enrich).toContain("description: `${enrichFullyText(n, budgets.data)} It runs on the server in the background; you can leave this page.`,");
  });
});

describe("Companies and Leads take all matching too (F30)", () => {
  it("companies: enrich by filter is a job through bulkEnrich, for managers", async () => {
    rows("accounts").push(
      { id: 10, workspaceId: WS, name: "Acme Inc", domain: null, normalizedDomain: null, archivedAt: null, industry: "Software" },
      { id: 11, workspaceId: WS, name: "Acme Labs", domain: null, normalizedDomain: null, archivedAt: null, industry: "Software" },
      { id: 12, workspaceId: WS, name: "Beta", domain: null, normalizedDomain: null, archivedAt: null, industry: "Retail" },
    );
    const filters = { industries: ["Software"] };
    expect((await caller().companies.search({ filters, page: 1, perPage: 50 })).total).toBe(2);
    await caller().companies.bulkByFilter({ action: "enrich", filters, expectedTotal: 2 });
    await drain();
    expect(h.companies).toEqual([[10, 11]]);
    h.role = "rep";
    expect((await refusal(caller().companies.bulkByFilter({ action: "enrich", filters, expectedTotal: 2 }))).code).toBe("FORBIDDEN");
  });

  it("leads: the matching ids, and delete by filter as a job through leads.bulkDelete", async () => {
    rows("leads").push(
      { id: 1, workspaceId: WS, firstName: "Ann", lastName: "Lee", company: "Acme", email: "a@acme.example", status: "new", score: 10 },
      { id: 2, workspaceId: WS, firstName: "Bo", lastName: "Ng", company: "Acme", email: "b@acme.example", status: "new", score: 20 },
      { id: 3, workspaceId: WS, firstName: "Cy", lastName: "Fox", company: "Beta", email: "c@beta.example", status: "new", score: 30 },
      { id: 4, workspaceId: OTHER, firstName: "Di", lastName: "Ra", company: "Acme", email: "d@acme.example", status: "new", score: 40 },
    );
    expect(await caller().leads.matchingIds({ search: "acme" })).toEqual({ ids: [2, 1], total: 2, capped: false });
    await caller().leads.bulkByFilter({ action: "delete", filter: { search: "acme" }, expectedTotal: 2 });
    await drain();
    expect(rows("leads").map((l) => l.id)).toEqual([3, 4]);
  });

  it("each page offers Select all N matching once its page is selected, and acts by the filter", () => {
    const people = read("client/src/pages/usip/People.tsx");
    expect(people).toContain("{(matchingAll || (allOnPageChecked && total > rows.length)) && (");
    expect(people).toContain("matching={matchingAll ? { filter: matchFilter, total } : undefined}");
    const companies = read("client/src/pages/usip/Companies.tsx");
    expect(companies).toContain("enrichMatching.mutate({ action: \"enrich\", filters, expectedTotal: total })");
    const leads = read("client/src/pages/usip/Leads.tsx");
    expect(leads).toContain("deleteMatching.mutate({ action: \"delete\", filter: { search: query || undefined }, expectedTotal: total });");
    expect(leads).toContain("leadIds={matchingAll ? matchIds : Array.from(selectedIds)}");
  });

  it("the assistant cannot start a bulk action on all matching or a bulk enrich: those are a person's click", async () => {
    const { buildCatalogFrom } = await import("./services/assistantActionCatalog");
    const paths = buildCatalogFrom(appRouter as never).map((e) => e.path);
    for (const p of ["prospects.bulkByFilter", "leads.bulkByFilter", "companies.bulkByFilter", "prospects.enrichFullBulk"]) expect(paths).not.toContain(p);
    expect(paths).toContain("prospects.matchingIds");
  });

  it("enrolling all matching goes through Add to… with the matching ids, so every enrolment check applies; the bulk job never enrols", () => {
    const toolbar = read("client/src/components/usip/people/SelectionToolbar.tsx");
    expect(toolbar).toContain("<AddToMenu prospectIds={actIds} label=\"Add to…\"");
    const svc = read("server/services/bulkByFilter.ts");
    expect(svc).not.toMatch(/bulkEnroll|pushExisting|enrol\(/);
    expect(read("server/routers/prospects.ts")).toContain(`action: z.enum(["delete", "optOut", "addToList", "tasks", "enrichFull", "verify"]),`);
  });
});
