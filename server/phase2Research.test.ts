/**
 * Phase 2 of the 2026-10-20 audit, slice D — segments and discovery —
 * against the real routers and services and the SQL-evaluating fake.
 *
 *   a segment needs rules, and each rule an operator and value its field
 *   takes (P1, P19) · auto-enrol screens like every enrolment and says what
 *   it skipped (P2) · discovery never overwrites a person's review (P3) ·
 *   account mode keeps every person and saves company-only finds (P15) ·
 *   and the client halves: the segment editor per segment, field-aware
 *   defaults, list search on the server (P18), re-score asks first (P3).
 *
 * Time is frozen at T0 — Wednesday 2026-11-18, 15:00 UTC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  inCampaign: new Set<number>(),
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/crossEngineEnrollment", async (a) => ({
  ...(await a<typeof import("./services/crossEngineEnrollment")>()),
  // Contact ids stand in for their People rows; the test says who a campaign is working.
  resolveToPeopleIds: async (_ws: number, input: { contactIds?: number[] }) => ({ prospectIds: (input.contactIds ?? []).map((id) => 9000 + id), unresolved: [] }),
  activeCampaignsForProspects: async (_ws: number, ids: number[]) => new Map(ids.filter((id) => h.inCampaign.has(id - 9000)).map((id) => [id, [{ campaignId: 1, campaignName: "C" }]])),
}));
vi.mock("./services/enrichment/fieldHistory", async (a) => ({
  ...(await a<typeof import("./services/enrichment/fieldHistory")>()),
  recordFieldHistory: async () => {},
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { runSegmentEnrollmentForWorkspace } from "./routers/segmentRules";
import { discoveryVerdict, persistAsProspects, processRun, type ScoredCandidate } from "./services/discovery/consolidate";
import { applySegmentRule, matchesSegment, segmentProblem } from "@shared/segmentRules";

const LSI = 2;
const ADMIN = 20;
const REP = 21;
const T0 = new Date("2026-11-18T15:00:00Z").getTime();

const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);

function seed() {
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
}
const contact = (id: number, over: Record<string, unknown> = {}) => rows("contacts").push({
  id, workspaceId: LSI, accountId: null, firstName: `C${id}`, lastName: "Lee", email: `c${id}@acme.example`, isPrimary: false,
  emailVerificationStatus: "valid", linkedinUrl: null, companyDomain: null, createdAt: new Date("2026-10-01T12:00:00Z"), ...over,
});

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  h.db = makeSqlFakeDb({ realMembers: true });
  h.inCampaign = new Set();
  seed();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ── P1, P19: segment rules ─────────────────────────────────────────────── */

const rule = (field: string, operator: string, value = "") => ({ id: `${field}-${operator}`, field, operator, value }) as any;

describe("a segment says what it means (P1, P19)", () => {
  it("refuses no rules, an operator its field does not take, and a value that cannot match", async () => {
    const admin = caller(ADMIN);
    const save = (rules: any[]) => refusal(admin.segments.create({ name: "S", matchType: "all", rules }));
    expect((await save([])).message).toMatch(/at least one rule/);
    expect((await save([rule("isPrimary", "contains", "true")])).message).toMatch(/does not apply/);
    expect((await save([rule("emailVerificationStatus", "contains", "valid")])).message).toMatch(/does not apply/);
    expect((await save([rule("isPrimary", "equals", "")])).message).toMatch(/needs a value/);
    expect((await save([rule("createdAt", "gt", "last week")])).message).toMatch(/not a date/);
    expect((await save([rule("emailVerificationStatus", "equals", "great")])).message).toMatch(/not an email status/);
    expect(rows("audience_segments")).toHaveLength(0);
    // …and an edit is held to the same rules.
    const { id } = await admin.segments.create({ name: "S", matchType: "all", rules: [rule("title", "contains", "vp")] });
    expect((await refusal(admin.segments.update({ id, name: "S", matchType: "all", rules: [] }))).code).toBe("BAD_REQUEST");
  });

  it("evaluates each kind of field the way it is stored", () => {
    const c = { isPrimary: true, emailVerificationStatus: "invalid", createdAt: new Date("2026-11-02T09:00:00Z"), title: "VP Sales" };
    expect(applySegmentRule(c, rule("isPrimary", "equals", "true"))).toBe(true);
    expect(applySegmentRule({ isPrimary: false }, rule("isPrimary", "equals", "true"))).toBe(false);
    expect(applySegmentRule(c, rule("emailVerificationStatus", "equals", "valid"))).toBe(false); // "valid" is not "invalid"
    expect(applySegmentRule(c, rule("createdAt", "gt", "2026-11-01"))).toBe(true);
    expect(applySegmentRule(c, rule("createdAt", "gt", "2026-11-02"))).toBe(false); // after the 2nd means from the 3rd
    expect(applySegmentRule(c, rule("createdAt", "lt", "2026-11-03"))).toBe(true);
    expect(applySegmentRule(c, rule("title", "contains", "sales"))).toBe(true);
    expect(applySegmentRule(c, rule("isPrimary", "gt", "1"))).toBe(false); // a mismatched operator matches nobody
    expect(applySegmentRule(c, rule("title", "gt", "2026-01-01"))).toBe(false);
    expect(applySegmentRule(c, rule("emailVerificationStatus", "contains", "valid"))).toBe(false); // contains is for text
    expect(applySegmentRule({ isPrimary: true }, rule("isPrimary", "not_equals", "false"))).toBe(true);
    expect(segmentProblem([rule("isPrimary", "equals", "maybe")])).toMatch(/Yes or No/);
    expect(matchesSegment(c, [], "all")).toBe(false);
    expect(segmentProblem([rule("title", "is_empty")])).toBeNull();
  });
});

/* ── P2: segment auto-enrol ─────────────────────────────────────────────── */

describe("segment auto-enrol screens like every enrolment (P2)", () => {
  beforeEach(() => {
    rows("sequences").push({ id: 5, workspaceId: LSI, name: "Seq", status: "active" });
    rows("workspace_settings").push({ id: 1, workspaceId: LSI, blockInvalidEmailsFromSequences: true });
    contact(1, { title: "VP" });                                                   // clean
    contact(2, { title: "VP", emailVerificationStatus: "invalid" });              // invalid address
    contact(3, { title: "VP", email: "lead3@acme.example" });                     // the same person as an enrolled lead
    contact(4, { title: "VP" });                                                   // a campaign is working them
    contact(5, { title: "VP", email: "optout@acme.example" });                    // suppressed
    contact(6, { title: "Analyst" });                                              // not in the segment
    rows("leads").push({ id: 30, workspaceId: LSI, firstName: "L", lastName: "Three", email: "LEAD3@acme.example" });
    rows("enrollments").push({ id: 1, workspaceId: LSI, sequenceId: 5, leadId: 30, contactId: null, prospectId: null, status: "active" });
    rows("email_suppressions").push({ id: 1, workspaceId: LSI, email: "optout@acme.example", reason: "unsubscribe", contactId: null, linkedinUrl: null, domain: null });
    h.inCampaign = new Set([4]);
    // The People row a campaign works, linked to contact 4.
    rows("prospects").push({ id: 9004, workspaceId: LSI, firstName: "C4", lastName: "Lee", email: "c4@acme.example", linkedContactId: 4, linkedLeadId: null });
    rows("audience_segments").push({ id: 7, workspaceId: LSI, name: "VPs", matchType: "all", rules: [rule("title", "contains", "vp")] });
    rows("audience_segments").push({ id: 8, workspaceId: LSI, name: "Everyone (by mistake)", matchType: "all", rules: [] });
    rows("segment_sequence_rules").push(
      { id: 1, workspaceId: LSI, segmentId: 7, sequenceId: 5, enabled: true, enrolledCount: 0, lastRunSummary: null },
      { id: 2, workspaceId: LSI, segmentId: 8, sequenceId: 5, enabled: true, enrolledCount: 0, lastRunSummary: null },
    );
  });

  it("enrols only the clean match, records why the rest were skipped, and refuses a rule-less segment", async () => {
    const r = await runSegmentEnrollmentForWorkspace(LSI);
    expect(rows("enrollments").filter((e) => e.contactId != null).map((e) => e.contactId)).toEqual([1]);
    expect(r.enrolled).toBe(1);
    expect(row("segment_sequence_rules", 1).lastRunSummary).toMatchObject({
      matched: 5, enrolled: 1, skipped: { invalidEmail: 1, alreadyEnrolled: 1, inCampaign: 1, suppressed: 1 },
    });
    expect(row("segment_sequence_rules", 1).enrolledCount).toBe(1);
    expect(row("segment_sequence_rules", 2).lastRunSummary).toMatchObject({ enrolled: 0, refused: expect.stringMatching(/no rules/) });
    // A second run finds them all accounted for.
    await runSegmentEnrollmentForWorkspace(LSI);
    expect(rows("enrollments").filter((e) => e.contactId != null)).toHaveLength(1);
  });
});

/* ── P3: discovery and human review ─────────────────────────────────────── */

const candidate = (over: Partial<ScoredCandidate>): ScoredCandidate => ({
  firstName: "Ann", lastName: "Lee", title: "VP", companyName: "Acme", companyDomain: "acme.example",
  linkedinUrl: null, email: "ann@acme.example", phone: null, location: null, sourceUrls: [], sourceRows: [],
  sources: new Set(["web"]), conflicts: {}, score: 90, tier: "high", status: "verified", notes: [], linkedinUrlVerified: false,
  ...over,
} as ScoredCandidate);
const person = (id: number, over: Record<string, unknown>) => rows("prospects").push({
  id, workspaceId: LSI, firstName: "Ann", lastName: "Lee", company: "Acme", email: null, title: null, phone: null,
  companyDomain: null, linkedinUrl: null, fieldProvenance: {}, verificationStatus: null, verificationSetBy: null, ...over,
});

describe("discovery never overwrites a person's review (P3)", () => {
  it("leaves an archived person alone, keeps a human's verdict, never downgrades a verified one", async () => {
    person(1, { email: "archived@acme.example", verificationStatus: "rejected", verificationSetBy: "human", title: "Old" });
    person(2, { email: "human@acme.example", verificationStatus: "needs_review", verificationSetBy: "human" });
    person(3, { email: "verified@acme.example", verificationStatus: "verified", verificationSetBy: "discovery" });
    person(4, { email: "review@acme.example", verificationStatus: "needs_review", verificationSetBy: "discovery" });
    const r = await persistAsProspects(LSI, 9, [
      candidate({ email: "archived@acme.example", status: "verified", title: "New" }),
      candidate({ email: "human@acme.example", status: "verified" }),
      candidate({ email: "verified@acme.example", status: "needs_review", tier: "medium", score: 60 }),
      candidate({ email: "review@acme.example", status: "verified" }),
    ]);
    expect(r.prospectsSkippedArchived).toBe(1);
    expect(row("prospects", 1)).toMatchObject({ verificationStatus: "rejected", title: "Old" });
    expect(row("prospects", 2)).toMatchObject({ verificationStatus: "needs_review", verificationSetBy: "human" });
    expect(row("prospects", 3).verificationStatus).toBe("verified");
    expect(row("prospects", 4)).toMatchObject({ verificationStatus: "verified", verificationSetBy: "discovery" });
    expect(discoveryVerdict(undefined, "needs_review")).toMatchObject({ verificationStatus: "needs_review", verificationSetBy: "discovery" });
  });

  it("a review set on People is recorded as a human's", async () => {
    person(1, { verificationStatus: "needs_review", verificationSetBy: "discovery" });
    person(2, { verificationStatus: "verified" });
    await caller(REP).prospects.update({ id: 1, verificationStatus: "verified" });
    await caller(REP).prospects.archive({ id: 2 });
    expect(row("prospects", 1)).toMatchObject({ verificationStatus: "verified", verificationSetBy: "human", verificationSetByUserId: REP });
    expect(row("prospects", 2)).toMatchObject({ verificationStatus: "rejected", verificationSetBy: "human", verificationSetByUserId: REP });
  });
});

/* ── P15: account mode ──────────────────────────────────────────────────── */

describe("account mode keeps every person and saves the companies it finds (P15)", () => {
  it("two people at one company are two people; company-only finds become accounts", async () => {
    rows("accounts").push({ id: 501, workspaceId: LSI, name: "Gamma Ltd", normalizedName: "gamma", normalizedDomain: "gamma.example", archivedAt: null });
    const find = (id: number, over: Record<string, unknown>) => rows("raw_finds").push({
      id, workspaceId: LSI, runId: 9, source: "web", firstName: null, lastName: null, title: null, companyName: null,
      companyDomain: null, linkedinUrl: null, email: null, phone: null, location: null, sourceUrl: null, snippet: null, ...over,
    });
    find(1, { firstName: "Ann", lastName: "Lee", title: "CEO", companyName: "Acme", companyDomain: "acme.example", email: "ann@acme.example" });
    find(2, { firstName: "Bo", lastName: "Ng", title: "CFO", companyName: "Acme", companyDomain: "acme.example", email: "bo@acme.example" });
    find(3, { source: "google_business", companyName: "Beta Bakery", companyDomain: "beta.example" });
    find(4, { source: "news", companyName: "Gamma Ltd", companyDomain: "gamma.example" });
    find(5, { source: "google_business", companyName: "Beta Bakery", companyDomain: "https://www.beta.example/" });
    const r = await processRun(LSI, 9, "account");
    expect(r.prospectsCreated).toBe(2);
    expect(rows("prospects").map((p) => p.firstName).sort()).toEqual(["Ann", "Bo"]);
    expect(r).toMatchObject({ accountsCreated: 1, accountsMatched: 1 });
    expect(rows("accounts").map((a) => a.name).sort()).toEqual(["Beta Bakery", "Gamma Ltd"]);
    // Person mode leaves company-only finds out, as before.
    rows("prospects").splice(0);
    await processRun(LSI, 9, "person");
    expect(rows("accounts")).toHaveLength(2);
  });
});

/* ── The client halves ──────────────────────────────────────────────────── */

const client = (...p: string[]) => readFileSync(join(__dirname, "..", "client", "src", ...p), "utf8").replace(/\r\n/g, "\n");

describe("the client halves", () => {
  it("the segment editor mounts per segment and starts each field on its own operator (P1, P19)", () => {
    const src = client("pages", "usip", "Segments.tsx");
    expect(src).toContain("{builderOpen && (");
    expect(src).toContain('key={editing?.id ?? "new"}');
    expect(src).toContain("onChange({ ...rule, field, operator: defaultOperatorFor(field), value: defaultValueFor(field) });");
    expect(src).toContain("if (form.rules.length === 0) { toast.error(");
    expect(src).not.toContain('value={rule.value || "true"}');
  });

  it("list search runs on the server, a page at a time (P18)", () => {
    const src = client("pages", "usip", "ListDetail.tsx");
    expect(src).toContain("{ page, perPage: PER_PAGE, search: search || undefined }");
    expect(src).not.toContain("{ page: 1, perPage: 100 }");
  });

  it("re-scoring a discovery run asks first (P3)", () => {
    const src = client("pages", "usip", "FindProspects.tsx");
    expect(src).toMatch(/onClick=\{\(\) => confirmAction\(\{\s*title: `Re-score run #\$\{run\.id\}\?`/);
  });
});
