/**
 * Phase 3 of the 2026-10-20 audit, part 2b — one LinkedIn lookup queue that
 * keeps to the account limits (P6, P7, P8, P90, P92, P153, P157).
 *
 *   a lookup the limits hold comes back TYPED, waits out a short spacing
 *   hold when the caller allows, and is never read as a missing profile ·
 *   "not found" is the only answer that says a profile is gone · bulk Enrich,
 *   batches and the daily check stop at a hold, leave the rest pending, and
 *   the queue resumes them · a reviewer confirms the candidate the run found,
 *   with no second lookup · a batch runs once and its failed rows can be
 *   retried · bulk Enrich is for managers and capped · "Run now" says what it
 *   will do.
 *
 * Time is frozen at T0 — Wednesday 2026-11-18, 15:00 UTC — except where a
 * test waits out a spacing hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  /** What the gate says next, one verdict per pick (then "allowed"). */
  verdicts: [] as Array<{ allowed: boolean; reason: string | null; retryAfterMs: number | null; message: string }>,
  picks: [] as string[][],
  /** Unipile profile fetches: identifier → raw profile, or an Error to throw. */
  unipile: new Map<string, unknown>(),
  fetched: [] as string[],
  /** When set, retrieveLinkedInProfileByUrl / retrieveByNameCompany answer from here. */
  script: null as null | ((kind: "url" | "name", arg: string) => any),
  retrieveCalls: [] as string[],
  applied: [] as any[],
}));

vi.mock("./services/linkedin/activityGate", async (a) => ({
  ...(await a<typeof import("./services/linkedin/activityGate")>()),
  pickAccountForAction: async (input: { candidates: string[] }) => {
    h.picks.push(input.candidates);
    const v = h.verdicts.shift() ?? { allowed: true, reason: null, retryAfterMs: null, message: "ok" };
    return v.allowed ? { unipileAccountId: input.candidates[0], verdict: { ...v, effectiveCaps: {} } } : { unipileAccountId: null, verdict: { ...v, effectiveCaps: {} } };
  },
  recordLinkedInAction: async () => {},
}));
vi.mock("./lib/unipile", async (a) => ({
  ...(await a<typeof import("./lib/unipile")>()),
  getLinkedInProfile: async (_acct: string, identifier: string) => {
    h.fetched.push(identifier);
    const r = h.unipile.get(identifier);
    if (r instanceof Error) throw r;
    if (!r) throw new Error(`Unipile GET /users/${identifier}?account_id=acct-1&linkedin_sections=experience → 404: {"type":"errors/resource_not_found"}`);
    return r;
  },
}));
vi.mock("./services/linkedinEnrichment/unipileProfile", async (a) => {
  const actual = await a<typeof import("./services/linkedinEnrichment/unipileProfile")>();
  return {
    ...actual,
    retrieveLinkedInProfileByUrl: async (o: any) => {
      h.retrieveCalls.push(o.linkedinUrl);
      return h.script ? h.script("url", o.linkedinUrl) : actual.retrieveLinkedInProfileByUrl(o);
    },
    retrieveByNameCompany: async (o: any) => {
      h.retrieveCalls.push(`name:${o.prospect.lastName}`);
      return h.script ? h.script("name", o.prospect.lastName) : actual.retrieveByNameCompany(o);
    },
  };
});
vi.mock("./services/linkedinEnrichment/enrichmentService", async (a) => ({
  ...(await a<typeof import("./services/linkedinEnrichment/enrichmentService")>()),
  applyEnrichment: async (o: any) => { h.applied.push(o); return { enrichmentId: 900 + h.applied.length, changes: [{ changeType: "title_changed" }], dataStatus: "enriched" }; },
}));
vi.mock("./services/linkedinEnrichment/health", () => ({
  checkLinkedInEnrichmentHealth: async () => ({ status: "connected", missing_requirements: [] }),
}));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { lookupProfile } from "./services/linkedinLookup";
import { retrieveLinkedInProfileByUrl as realRetrieve } from "./services/linkedinEnrichment/unipileProfile";
import { continueEnrichmentJobs, MAX_ENRICH_PER_JOB } from "./services/linkedinEnrichment/orchestrator";
import { continueBatches, retryFailedRows, startBatch } from "./services/linkedinEnrichment/batchService";
import { runDailyCheckForWorkspace, workspacesWithDailyCheckDue } from "./services/linkedinEnrichment/dailyCheck";
import { drainLinkedInLookups, __resetLookupQueueForTests } from "./services/linkedinEnrichment/lookupQueue";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const LSI = 2;
const ADMIN = 20;
const MANAGER = 22;
const REP = 21;
const T0 = new Date("2026-11-18T15:00:00Z").getTime();
const FAR = Number.POSITIVE_INFINITY;

const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);

function seed() {
  rows("workspaces").push({ id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  const user = (id: number, mail: string) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: mail, loginMethod: "password", role: "user",
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN, "admin@lsi.example"), user(REP, "rep@lsi.example"), user(MANAGER, "mgr@lsi.example"));
  const member = (id: number, userId: number, role: string) => ({
    id, workspaceId: LSI, userId, role, title: null, quota: null, deactivatedAt: null, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(member(1, ADMIN, "admin"), member(2, REP, "rep"), member(3, MANAGER, "manager"));
  rows("unipile_accounts").push(
    { id: 1, workspaceId: LSI, userId: ADMIN, unipileAccountId: "acct-1", provider: "LINKEDIN", displayName: "Admin LI", status: "OK" },
    { id: 2, workspaceId: LSI, userId: MANAGER, unipileAccountId: "acct-2", provider: "LINKEDIN", displayName: "Mgr LI", status: "OK" },
  );
}

function caller(userId: number) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(LSI) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

const hold = (message = "Outside this account's working hours.") =>
  ({ ok: false, status: "rate_limited", profile: null, viaAccountId: "acct-1", identifier: null, message, blocked: { reason: "outside_hours", retryAfterMs: null } });
const notFound = { ok: false, status: "no_match", profile: null, viaAccountId: "acct-1", identifier: null, message: "LinkedIn lookup failed: → 404" };
const vendorError = { ok: false, status: "vendor_error", profile: null, viaAccountId: "acct-1", identifier: null, message: "LinkedIn lookup failed: → 500" };
const profile = (id: string, over: Record<string, unknown> = {}) => ({
  profileUrl: `https://www.linkedin.com/in/${id}`, identifier: id, publicId: id, fullName: "Ada Lee", firstName: "Ada", lastName: "Lee",
  headline: "County Administrator", location: "Richmond, Virginia", industry: null, profileImageUrl: null, summaryAbout: null,
  currentTitle: "County Administrator", currentCompanyName: "Henrico County", currentCompanyLinkedinUrl: null, currentCompanyDomain: null,
  currentCompanyStartDate: null, connectionDegree: null, experience: [], education: [], ...over,
});
const found = (id: string, over: Record<string, unknown> = {}) =>
  ({ ok: true, status: "enriched", profile: profile(id, over), viaAccountId: "acct-1", identifier: id, message: "ok" });

const prospect = (id: number, slug: string | null, over: Record<string, unknown> = {}) => rows("prospects").push({
  id, workspaceId: LSI, firstName: "Ada", lastName: "Lee", company: "Henrico County", title: "County Administrator",
  linkedinUrl: slug ? `https://www.linkedin.com/in/${slug}` : null, verificationStatus: null, ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  h.db = makeSqlFakeDb({ realMembers: true });
  // The atomic daily-slot UPDATE runs through db.execute: grant the slot.
  h.db.execute = async () => [{ affectedRows: 1 }];
  h.verdicts = [];
  h.picks = [];
  h.unipile = new Map();
  h.fetched = [];
  h.script = null;
  h.retrieveCalls = [];
  h.applied = [];
  __resetLookupQueueForTests();
  seed();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ── The lookup: a hold is typed ────────────────────────────────────────── */

describe("a lookup the account limits hold comes back typed (P6/P7)", () => {
  const look = (waitMs = 0) => lookupProfile({ workspaceId: LSI, userId: ADMIN, isAdmin: true, linkedinUrl: "https://linkedin.com/in/ada-lee", waitMs, feature: "t" });

  it("held: nothing reaches LinkedIn, the log says blocked, the result says why", async () => {
    h.verdicts = [{ allowed: false, reason: "outside_hours", retryAfterMs: null, message: "Outside this account's working hours." }];
    const r = await look();
    expect(r).toEqual(expect.objectContaining({ ok: false, blocked: { reason: "outside_hours", retryAfterMs: null }, message: "Outside this account's working hours." }));
    expect(h.fetched).toEqual([]);
    expect(rows("linkedin_lookup_log")).toEqual([expect.objectContaining({ status: "blocked" })]);
  });

  it("every account with headroom is offered to the gate, so one account's hold does not block another", async () => {
    h.unipile.set("ada-lee", { first_name: "Ada", last_name: "Lee" });
    await look();
    expect(h.picks[0].sort()).toEqual(["acct-1", "acct-2"]);
  });

  it("a short spacing hold is waited out when the caller allows; a long one is not", async () => {
    vi.useRealTimers();
    h.unipile.set("ada-lee", { first_name: "Ada", last_name: "Lee" });
    h.verdicts = [{ allowed: false, reason: "spacing", retryAfterMs: 20, message: "Too soon." }];
    expect((await look(5_000)).ok).toBe(true);
    expect(h.fetched).toEqual(["ada-lee"]);
    h.verdicts = [{ allowed: false, reason: "spacing", retryAfterMs: 10 * 60_000, message: "Too soon." }];
    expect((await look(3 * 60_000)).blocked).toEqual({ reason: "spacing", retryAfterMs: 10 * 60_000 });
  });

  it("a lookup that reached LinkedIn is counted against the workspace", async () => {
    h.unipile.set("ada-lee", { first_name: "Ada", last_name: "Lee" });
    await look();
    expect(rows("spend_ledger")).toEqual([expect.objectContaining({ workspaceId: LSI, vendor: "linkedin", meter: "profile_lookups", quantity: 1, feature: "t" })]);
  });
});

describe("only 'not found' says a profile is gone", () => {
  const retrieve = () => realRetrieve({ workspaceId: LSI, userId: ADMIN, isAdmin: true, linkedinUrl: "https://linkedin.com/in/ada-lee" });

  it("a hold is rate_limited and typed; 404 is no_match; 429 is a hold; anything else is a vendor error", async () => {
    h.verdicts = [{ allowed: false, reason: "daily_kind_cap", retryAfterMs: null, message: "This account's lookups for today are used up." }];
    expect(await retrieve()).toEqual(expect.objectContaining({ status: "rate_limited", blocked: expect.objectContaining({ reason: "daily_kind_cap" }) }));
    expect((await retrieve()).status).toBe("no_match"); // nothing in h.unipile → Unipile's 404
    h.unipile.set("ada-lee", new Error("Unipile GET /users/ada-lee?account_id=acct-1 → 429: too many"));
    expect((await retrieve()).status).toBe("rate_limited");
    // Every Unipile error names account_id in its path: that is not a missing account.
    h.unipile.set("ada-lee", new Error("Unipile GET /users/ada-lee?account_id=acct-1 → 500: oops"));
    expect((await retrieve()).status).toBe("vendor_error");
  });
});

/* ── Bulk Enrich jobs ───────────────────────────────────────────────────── */

function enrichJob(id: number, prospectIds: number[], over: Record<string, unknown> = {}) {
  rows("linkedin_enrichment_jobs").push({ id, workspaceId: LSI, triggeredByUserId: ADMIN, triggerType: "people_bulk_action", status: "queued", totalProspects: prospectIds.length, options: {}, heartbeatAt: null, startedAt: null, ...over });
  prospectIds.forEach((pid, i) => rows("linkedin_enrichment_job_items").push({ id: id * 100 + i, jobId: id, workspaceId: LSI, prospectId: pid, status: "pending" }));
}
const item = (jobId: number, pid: number) => rows("linkedin_enrichment_job_items").find((r) => r.jobId === jobId && r.prospectId === pid);

describe("a bulk Enrich job stops at a hold and the queue resumes it (P7)", () => {
  it("held mid-run: that item stays pending, the job waits with the reason, nothing is marked failed", async () => {
    prospect(1, "ada-1"); prospect(2, "ada-2"); prospect(3, "ada-3");
    enrichJob(5, [1, 2, 3]);
    h.script = (_k, url) => (url.endsWith("ada-2") ? hold() : found(url.split("/in/")[1]));
    const r = await continueEnrichmentJobs(LSI, FAR);
    expect(r).toEqual({ looked: 1, held: "Outside this account's working hours." });
    expect(item(5, 1).status).toBe("enriched");
    expect(item(5, 2)).toEqual(expect.objectContaining({ status: "pending", errorMessage: expect.stringMatching(/Waiting for LinkedIn limits/) }));
    expect(item(5, 3).status).toBe("pending");
    expect(row("linkedin_enrichment_jobs", 5)).toEqual(expect.objectContaining({ status: "waiting", holdReason: "Outside this account's working hours." }));

    // Later the gate allows it: the same job finishes.
    h.script = (_k, url) => found(url.split("/in/")[1]);
    expect(await continueEnrichmentJobs(LSI, FAR)).toEqual({ looked: 2, held: null });
    expect([item(5, 2).status, item(5, 3).status]).toEqual(["enriched", "enriched"]);
    expect(row("linkedin_enrichment_jobs", 5)).toEqual(expect.objectContaining({ status: "completed", enrichedCount: 3, holdReason: null }));
  });

  it("a hold never spends the fallback search; a dead link (not found) does", async () => {
    prospect(1, "ada-1"); prospect(2, "ada-2");
    enrichJob(6, [1]);
    h.script = (k) => (k === "url" ? hold() : found("ada-1"));
    await continueEnrichmentJobs(LSI, FAR);
    expect(h.retrieveCalls).toEqual(["https://www.linkedin.com/in/ada-1"]);

    enrichJob(7, [2]);
    row("linkedin_enrichment_jobs", 6).status = "completed";
    h.retrieveCalls = [];
    h.script = (k) => (k === "url" ? notFound : found("ada-2b"));
    await continueEnrichmentJobs(LSI, FAR);
    expect(h.retrieveCalls).toEqual(["https://www.linkedin.com/in/ada-2", "name:Lee"]);
  });

  it("a job another worker is on is left alone; one whose worker died is taken over", async () => {
    prospect(1, "ada-1");
    enrichJob(8, [1], { status: "running", heartbeatAt: new Date(T0 - 60_000) });
    h.script = (_k, url) => found(url.split("/in/")[1]);
    expect(await continueEnrichmentJobs(LSI, FAR)).toEqual({ looked: 0, held: null });
    row("linkedin_enrichment_jobs", 8).heartbeatAt = new Date(T0 - 11 * 60_000);
    expect((await continueEnrichmentJobs(LSI, FAR)).looked).toBe(1);
  });
});

describe("a reviewer confirms the candidate the run found (P8)", () => {
  it("review items keep the candidate; confirming applies exactly it, with no second lookup", async () => {
    // The URL is the prospect's own, but the name differs: review, not auto-apply.
    prospect(1, "ada-1");
    enrichJob(9, [1]);
    h.script = () => found("ada-1", { fullName: "Adaline Leighton-Smythe", firstName: "Adaline", lastName: "Leighton-Smythe" });
    await continueEnrichmentJobs(LSI, FAR);
    const it9 = item(9, 1);
    expect(it9.status).toBe("needs_review");
    expect(it9.candidateProfile.profile.fullName).toBe("Adaline Leighton-Smythe");

    const list = await caller(MANAGER).linkedinEnrichment.listReviewItems();
    expect(list[0].candidate).toEqual(expect.objectContaining({ fullName: "Adaline Leighton-Smythe", profileUrl: "https://www.linkedin.com/in/ada-1" }));

    h.retrieveCalls = [];
    h.applied = [];
    const r = await caller(MANAGER).linkedinEnrichment.confirmEnrich({ itemId: it9.id });
    expect(r.ok).toBe(true);
    expect(h.retrieveCalls).toEqual([]);
    expect(h.applied).toEqual([expect.objectContaining({ prospectId: 1, profile: expect.objectContaining({ fullName: "Adaline Leighton-Smythe" }) })]);
    expect(item(9, 1).status).toBe("enriched");
  });

  it("an item from before the change kept nothing: confirm refuses instead of looking up", async () => {
    prospect(1, "ada-1");
    rows("linkedin_enrichment_job_items").push({ id: 77, jobId: 1, workspaceId: LSI, prospectId: 1, status: "needs_review", candidateProfile: null });
    expect((await refusal(caller(MANAGER).linkedinEnrichment.confirmEnrich({ itemId: 77 }))).message).toMatch(/Run Enrich again/);
    expect(h.retrieveCalls).toEqual([]);
  });
});

/* ── Batch imports ──────────────────────────────────────────────────────── */

function batch(id: number, urls: string[], over: Record<string, unknown> = {}) {
  rows("linkedin_enrichment_batches").push({ id, workspaceId: LSI, uploadedByUserId: ADMIN, sourceType: "pasted_urls", status: "validated", totalRows: urls.length, validRows: urls.length, invalidRows: 0, heartbeatAt: null, ...over });
  urls.forEach((u, i) => rows("linkedin_enrichment_batch_rows").push({ id: id * 100 + i, batchId: id, workspaceId: LSI, originalUrl: u, normalizedUrl: u, validationStatus: "valid", rowStatus: "pending" }));
}
const batchRow = (id: number) => row("linkedin_enrichment_batch_rows", id);

describe("a batch runs once, waits on the limits, and its failed rows can be retried (P7/P90)", () => {
  it("queued, worked by the queue, held at the second row, resumed later", async () => {
    batch(3, ["https://www.linkedin.com/in/a1", "https://www.linkedin.com/in/a2", "https://www.linkedin.com/in/a3"]);
    expect(await startBatch({ workspaceId: LSI, batchId: 3, userId: MANAGER })).toEqual({ status: "queued", pending: 3 });
    h.script = (_k, url) => (url.endsWith("a2") ? hold() : vendorError);
    expect(await continueBatches(LSI, FAR)).toEqual({ looked: 1, held: "Outside this account's working hours." });
    expect([batchRow(300).rowStatus, batchRow(301).rowStatus, batchRow(302).rowStatus]).toEqual(["failed", "pending", "pending"]);
    expect(row("linkedin_enrichment_batches", 3)).toEqual(expect.objectContaining({ status: "waiting", holdReason: "Outside this account's working hours.", runByUserId: MANAGER }));

    h.script = () => vendorError;
    await continueBatches(LSI, FAR);
    expect(row("linkedin_enrichment_batches", 3).status).toBe("completed");
    // Only the rows still pending were looked up: 300 was not paid for twice.
    expect(h.retrieveCalls.filter((u) => u.endsWith("a1"))).toHaveLength(1);

    expect(await retryFailedRows({ workspaceId: LSI, batchId: 3, userId: MANAGER })).toEqual({ retried: 3 });
    expect([batchRow(300).rowStatus, row("linkedin_enrichment_batches", 3).status]).toEqual(["pending", "queued"]);
  });

  it("refuses a batch that is running, or has nothing left to look up", async () => {
    batch(4, ["https://www.linkedin.com/in/b1"], { status: "running", heartbeatAt: new Date(T0 - 60_000) });
    await expect(startBatch({ workspaceId: LSI, batchId: 4, userId: ADMIN })).rejects.toThrow(/already running/);
    batch(5, ["https://www.linkedin.com/in/c1"]);
    batchRow(500).rowStatus = "enriched";
    await expect(startBatch({ workspaceId: LSI, batchId: 5, userId: ADMIN })).rejects.toThrow(/Nothing left to look up/);
  });

  it("the run button queues it for managers, and the page polls while it runs", async () => {
    batch(6, ["https://www.linkedin.com/in/d1"]);
    h.script = () => hold();
    expect((await refusal(caller(REP).linkedinEnrichment.runBatch({ batchId: 6 }))).code).toBe("FORBIDDEN");
    const r = await caller(MANAGER).linkedinEnrichment.runBatch({ batchId: 6 });
    expect(r).toEqual(expect.objectContaining({ batchId: 6, status: "queued", pending: 1, lookupsLeftToday: expect.any(Number) }));
    const page = read("client/src/pages/usip/LinkedInEnrichmentImport.tsx");
    expect(page).toContain('refetchInterval: (q) => (live((q.state.data as any)?.status) ? 5000 : false)');
    expect(page).toContain("retryMut.mutate({ batchId })");
  });
});

/* ── The daily change check ─────────────────────────────────────────────── */

function enrichment(id: number, pid: number) {
  prospect(pid, `p${pid}`);
  rows("prospect_linkedin_enrichments").push({
    id, workspaceId: LSI, prospectId: pid, linkedinProfileUrl: `https://www.linkedin.com/in/p${pid}`,
    linkedinSourceAccountId: "acct-1", linkedinLastCheckedAt: null, linkedinMatchStatus: "exact_match",
  });
}

describe("the daily change check paces through the day and raises no false alarms (P6)", () => {
  it("a hold parks the day's job; a vendor error is a failed check, not an alert; 'not found' is the alert", async () => {
    enrichment(1, 11); enrichment(2, 12); enrichment(3, 13);
    h.script = (_k, url) => (url.endsWith("p11") ? notFound : url.endsWith("p12") ? vendorError : hold());
    const first = await runDailyCheckForWorkspace({ workspaceId: LSI, trigger: "scheduled", deadline: FAR });
    expect(first).toEqual(expect.objectContaining({ checked: 0, failed: 2, held: "Outside this account's working hours." }));
    const alerts = rows("prospect_linkedin_field_changes").filter((c) => c.changeType === "profile_unavailable");
    expect(alerts.map((a) => a.prospectId)).toEqual([11]);
    expect(rows("linkedin_daily_check_jobs")).toEqual([expect.objectContaining({ status: "waiting", holdReason: "Outside this account's working hours.", failedCount: 2 })]);

    // The next turn the same day carries on in the same job, with only the
    // profile the hold left: the two that failed were checked for today.
    h.script = (_k, url) => found(url.split("/in/")[1]);
    h.retrieveCalls = [];
    const second = await runDailyCheckForWorkspace({ workspaceId: LSI, trigger: "scheduled", deadline: FAR });
    expect(second).toEqual(expect.objectContaining({ checked: 1, held: null }));
    expect(h.retrieveCalls).toEqual(["https://www.linkedin.com/in/p13"]);
    expect(rows("linkedin_daily_check_jobs")).toEqual([expect.objectContaining({ status: "completed", checkedCount: 1, failedCount: 2 })]);
  });

  it("the queue offers the check to workspaces whose day is not done", async () => {
    enrichment(1, 11);
    expect(await workspacesWithDailyCheckDue()).toEqual([LSI]);
    h.script = (_k, url) => found(url.split("/in/")[1]);
    const r = await drainLinkedInLookups({ budgetMs: 60_000 });
    expect(r.looked).toBe(1);
    expect(await workspacesWithDailyCheckDue()).toEqual([]);
  });

  it("no longer runs at 01:00: the queue runs every ten minutes instead", () => {
    const boot = read("server/_core/index.ts");
    expect(boot).not.toMatch(/scheduleLinkedInDailyCheck|setHours\(25, 0, 0, 0\)/);
    expect(boot).toMatch(/m\.drainLinkedInLookups\(\)[\s\S]{0,400}setInterval\(runLinkedInQueue, 10 \* 60 \* 1000\)/);
  });

  it("'Run now' says what it will do first, and is the workspace admins' (P157, P153)", async () => {
    enrichment(1, 11); enrichment(2, 12);
    expect(await caller(ADMIN).linkedinEnrichment.dailyCheckPreview()).toEqual({ due: 2, lookupsLeftToday: expect.any(Number) });
    expect((await refusal(caller(MANAGER).linkedinEnrichment.dailyCheckRun())).code).toBe("FORBIDDEN");
    const page = read("client/src/pages/usip/LinkedInEnrichmentImport.tsx");
    expect(page).toContain("await utils.linkedinEnrichment.dailyCheckPreview.fetch()");
    expect(page).not.toMatch(/\["admin", "super_admin"\]\.includes\(\(user as any\)\?\.role/);
    expect(page).toContain("const isAdmin = rank >= ROLE_RANK.admin;");
  });
});

/* ── P92: bulk Enrich is a manager's, and capped ────────────────────────── */

describe("bulk Enrich is for managers and capped (P92)", () => {
  it("a rep may enrich one person, not a selection or a list", async () => {
    prospect(1, "ada-1"); prospect(2, "ada-2");
    h.script = () => hold();
    expect((await refusal(caller(REP).linkedinEnrichment.run({ prospectIds: [1, 2] }))).code).toBe("FORBIDDEN");
    expect((await caller(REP).linkedinEnrichment.run({ prospectIds: [1] })).total).toBe(1);
    expect((await refusal(caller(REP).linkedinEnrichment.runForList({ listId: 1, enrichAll: true }))).code).toBe("FORBIDDEN");
  });

  it("'Enrich all' on a list larger than the cap is refused, saying why", async () => {
    for (let i = 1; i <= MAX_ENRICH_PER_JOB + 1; i++) rows("record_list_members").push({ id: i, workspaceId: LSI, listId: 1, recordType: "prospect", recordId: i });
    const r = await refusal(caller(MANAGER).linkedinEnrichment.runForList({ listId: 1, enrichAll: true }));
    expect(r.code).toBe("BAD_REQUEST");
    expect(r.message).toMatch(/at most 1,000 at a time/);
    expect(rows("linkedin_enrichment_jobs")).toHaveLength(0);
  });
});
