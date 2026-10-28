/**
 * Phase 4 of the 2026-10-20 audit, part 6 — the remaining unbounded queries
 * (X4.1–X4.4; R49, G58, P52, P49, P28, A34, A44, A45, R61, R66).
 *
 *   leads page in SQL with an id tiebreak · sequence analytics are grouped
 *   counts with no draft bodies · segment rules compile to SQL that agrees
 *   with the shared evaluator, rule for rule · list members page in SQL with
 *   the displayed columns · research tallies cap per sector or persona, say
 *   so, and read no message bodies · the campaign tabs count in SQL and page
 *   · People sorts end in the id · the alert sweep reads per chunk, not per
 *   deal · the engine screens a batch and sweeps completion grouped · long
 *   lists render 50 rows at a time · polling stops, searches wait for typing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { getTableName } from "drizzle-orm";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, wsId: 2, selects: [] as Array<{ table: string; cols: string[] | "*"; limit?: number; group?: boolean; rows?: number }> };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import {
  accounts, activities, areExecutionQueue, audienceSegments, crmPipelineStages, crmPipelines, areScrapeJobs, areSignalLog, contacts, emailDrafts, emailReplies, enrollments, leads,
  opportunities, opportunityContactRoles, pipelineAlerts, prospectIntelligence, prospectQueue, prospects,
  recordListMembers, recordLists, sequences,
} from "../drizzle/schema";
import { LEAD_ORDER, leadWhere, searchLeads } from "./services/leadSearch";
import { sequencePerformance } from "./services/sequenceAnalytics";
import { countSegment, ruleSql, segmentSql } from "./services/segmentSql";
import { listMemberPage, MAX_LIST_PROSPECT_IDS } from "./services/listMembers";
import { MAX_PROSPECTS, personaResultSummaries, sectorTallies } from "./services/research/results";
import { peopleOrder } from "./routers/prospects";
import { scanPipelineAlertsForWorkspace } from "./routers/pipelineAlerts";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { matchesSegment, type SegmentRule } from "@shared/segmentRules";
import { pipelinePollMs } from "../client/src/pages/usip/ResearchPipeline";
import { SHOW_MORE_STEP, useShowMore } from "../client/src/hooks/useShowMore";
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from "../client/src/hooks/useDebouncedValue";

const LSI = 2, OTHER = 9;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const T = (t: any) => h.db.rowsOf(getTableName(t)) as any[];
const sqlOf = (x: any) => new MySqlDialect().sqlToQuery(x).sql;
const html = (el: ReactElement) => renderToStaticMarkup(el);

function caller(ws = LSI) {
  h.wsId = ws;
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [LSI]: "admin", [OTHER]: "admin" }, wsId: () => h.wsId });
  h.selects = [];
  const real = h.db.select;
  h.db.select = (projection?: Record<string, unknown>) => {
    const b = real(projection);
    const entry: (typeof h.selects)[number] = { table: "", cols: projection ? Object.keys(projection) : "*" };
    h.selects.push(entry);
    const { from, limit, groupBy, then } = b;
    b.from = (t: any) => { entry.table = getTableName(t); return from(t); };
    b.limit = (n: number) => { entry.limit = n; return limit(n); };
    b.groupBy = (...c: any[]) => { entry.group = true; return groupBy(...c); };
    b.then = (res: any, rej: any) => then((rows: any[]) => { entry.rows = rows.length; res(rows); }, rej);
    return b;
  };
  invalidateStageIndex();
});

/* ── Leads (R49) ─────────────────────────────────────────────────────── */

const lead = (id: number, o: Record<string, unknown> = {}) => ({
  id, workspaceId: LSI, firstName: `F${id}`, lastName: `L${id}`, email: `p${id}@example.com`, phone: null, company: "Acme",
  title: null, source: null, status: "new", score: 50, grade: null, ownerUserId: 1, scoreReasons: { big: "x".repeat(50) },
  tags: null, customFields: null, aiNextAction: null, aiNextActionNote: null, createdAt: new Date(2026, 9, 1), updatedAt: new Date(2026, 9, 1), ...o,
});

describe("the Leads list pages in SQL (R49)", () => {
  it("every word must match a name, company or email; status and workspace are in the WHERE", async () => {
    T(leads).push(
      lead(1, { firstName: "Jane", company: "Acme" }), lead(2, { firstName: "Jane", company: "Globex" }),
      lead(3, { firstName: "Bob", email: "jane@acme.example" }), lead(4, { firstName: "Jane", company: "Acme", status: "qualified" }),
      lead(5, { firstName: "Jane", company: "Acme", workspaceId: OTHER }),
    );
    const r = await searchLeads(LSI, { search: "jane acme" });
    expect(r.rows.map((x) => x.id).sort()).toEqual([1, 3, 4]);
    expect((await searchLeads(LSI, { search: "JANE", status: "qualified" })).rows.map((x) => x.id)).toEqual([4]);
    const where = sqlOf(leadWhere(LSI, { search: "a b" }));
    expect(where).toContain("`leads`.`workspaceId` = ?");
    expect(where.match(/like/g)?.length).toBe(8);
  });

  it("ties on score keep one order, so each lead is on exactly one page", async () => {
    for (let id = 1; id <= 25; id++) T(leads).push(lead(id, { score: id % 3 === 0 ? 90 : 50 }));
    const seen: number[] = [];
    let total = 0;
    for (let page = 1; page <= 3; page++) {
      const r = await searchLeads(LSI, { page, perPage: 10 });
      total = r.total;
      seen.push(...r.rows.map((x) => x.id));
    }
    expect(total).toBe(25);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    // Highest score first, then newest id.
    expect(seen.slice(0, 8)).toEqual([24, 21, 18, 15, 12, 9, 6, 3]);
    expect(LEAD_ORDER.map(sqlOf)).toEqual(["`leads`.`score` desc", "`leads`.`id` desc"]);
  });

  it("the page reads ids, then only its rows, without the JSON columns", async () => {
    for (let id = 1; id <= 30; id++) T(leads).push(lead(id));
    await searchLeads(LSI, { page: 2, perPage: 10 });
    const own = h.selects.filter((s) => s.table === "leads");
    expect(own.find((s) => s.limit != null)).toMatchObject({ cols: ["id"], limit: 10 });
    const page = own.find((s) => Array.isArray(s.cols) && s.cols.includes("firstName"))!;
    expect(page.rows).toBe(10);
    expect(page.cols).not.toContain("scoreReasons");
    expect(page.cols).not.toContain("customFields");
    expect(own.some((s) => s.cols === "*")).toBe(false);
  });

  it("leads.list is bounded for pickers and exports; the page debounces and pages", async () => {
    for (let id = 1; id <= 12; id++) T(leads).push(lead(id));
    expect(await caller().leads.list({ limit: 5 })).toHaveLength(5);
    expect((await caller().leads.page({ page: 2, perPage: 10 })).rows).toHaveLength(2);
    const ui = read("client/src/pages/usip/Leads.tsx");
    expect(ui).toContain("const query = useDebouncedValue(search.trim());");
    expect(ui).toContain("trpc.leads.page.useQuery({ search: query || undefined, page, perPage: PAGE_SIZE }");
    expect(ui).toContain("utils.leads.list.fetch({ search: query || undefined, limit: 5000 })");
    expect(read("server/routers/crm.ts")).not.toMatch(/db\.select\(\)\.from\(leads\)\.where\(eq\(leads\.workspaceId, ctx\.workspace\.id\)\)\.orderBy/);
  });
});

/* ── Sequence analytics (G58) ────────────────────────────────────────── */

const draft = (id: number, sequenceId: number, o: Record<string, unknown> = {}) => ({
  id, workspaceId: LSI, sequenceId, status: "sent", openCount: 0, clickCount: 0, bouncedAt: null, sentAt: new Date("2026-10-10T12:00:00Z"),
  subject: "Hi", body: "x".repeat(2000), ...o,
});

describe("sequence analytics are grouped counts, no bodies (G58)", () => {
  beforeEach(() => {
    T(sequences).push({ id: 1, workspaceId: LSI, name: "One", status: "active" }, { id: 2, workspaceId: LSI, name: "Two", status: "draft" }, { id: 3, workspaceId: OTHER, name: "Theirs", status: "active" });
    T(emailDrafts).push(
      draft(1, 1, { openCount: 3, clickCount: 1 }), draft(2, 1, { openCount: 1 }), draft(3, 1, { bouncedAt: new Date() }),
      draft(4, 1, { status: "pending_review", sentAt: null, openCount: 2 }), draft(5, 1, { sentAt: new Date("2026-09-01T00:00:00Z") }),
      draft(6, 2, {}), draft(7, 3, { workspaceId: OTHER, openCount: 9 }),
      // Another workspace's draft that names this sequence id: never counted.
      draft(9, 1, { workspaceId: OTHER, openCount: 7, bouncedAt: new Date() }),
    );
    T(enrollments).push(
      { id: 1, workspaceId: LSI, sequenceId: 1, status: "active" }, { id: 2, workspaceId: LSI, sequenceId: 1, status: "exited" },
      { id: 3, workspaceId: LSI, sequenceId: 1, status: "finished" }, { id: 4, workspaceId: LSI, sequenceId: 2, status: "paused" },
    );
  });

  it("the numbers the old per-draft loop produced", async () => {
    const [one, two] = await sequencePerformance(LSI, {});
    expect(one).toEqual({
      sequenceId: 1, sequenceName: "One", status: "active", totalEnrolled: 3, active: 1, finished: 1, exited: 1, paused: 0,
      sent: 4, uniqueOpens: 3, uniqueClicks: 1, bounced: 1, totalOpens: 6, totalClicks: 1,
      openRate: 75, clickRate: 25, bounceRate: 25, exitRate: 33,
    });
    expect(two).toMatchObject({ sequenceId: 2, sent: 1, totalEnrolled: 1, paused: 1, openRate: 0 });
  });

  it("a date range keeps only drafts sent inside it; one sequence can be asked for", async () => {
    T(emailDrafts).push(draft(8, 1, { sentAt: new Date("2026-11-01T00:00:00Z"), openCount: 5 }));
    const [one] = await sequencePerformance(LSI, { sequenceId: 1, dateFrom: "2026-10-01", dateTo: "2026-10-31" });
    expect(one).toMatchObject({ sent: 3, uniqueOpens: 2, totalOpens: 4, bounced: 1 });
    expect(await sequencePerformance(LSI, { sequenceId: 3 })).toEqual([]);
  });

  it("no draft body is read, and the count of reads does not grow with sequences", async () => {
    await sequencePerformance(LSI, {});
    const reads = h.selects.filter((s) => s.table === "email_drafts");
    expect(reads.every((s) => Array.isArray(s.cols) && !s.cols.includes("body") && !s.cols.includes("subject"))).toBe(true);
    expect(reads.every((s) => s.group)).toBe(true);
    const before = h.selects.length;
    for (let id = 10; id < 40; id++) T(sequences).push({ id, workspaceId: LSI, name: `S${id}`, status: "active" });
    h.selects = [];
    await sequencePerformance(LSI, {});
    expect(h.selects.length).toBe(before);
  });
});

/* ── Segments (P52) ──────────────────────────────────────────────────── */

const contact = (id: number, o: Record<string, unknown> = {}) => ({
  id, workspaceId: LSI, firstName: `F${id}`, lastName: `L${id}`, title: null, email: null, phone: null, linkedinUrl: null,
  city: null, seniority: null, isPrimary: false, emailVerificationStatus: null, createdAt: new Date("2026-10-15T10:00:00Z"), ...o,
});

describe("segment rules compile to SQL that agrees with the evaluator (P52)", () => {
  const people = [
    contact(1, { email: "Ann@Acme.com", title: "VP Sales", city: "Boston", isPrimary: true, emailVerificationStatus: "valid", createdAt: new Date("2026-11-02T00:00:00Z") }),
    contact(2, { email: "", title: "", city: "boston", emailVerificationStatus: "invalid" }),
    contact(3, { email: "bob@globex.com", title: "Engineer", seniority: "senior", createdAt: new Date("2026-10-31T23:59:59Z") }),
    // isPrimary unset reads as No, in the evaluator and in SQL.
    contact(4, { title: "VP Marketing", linkedinUrl: "https://x/in/d", phone: "555", isPrimary: null }),
    contact(5, { email: "ann@acme.com", workspaceId: OTHER }),
  ];
  const rules: SegmentRule[] = [
    { field: "email", operator: "equals", value: "ann@acme.com" }, { field: "email", operator: "not_equals", value: "ann@acme.com" },
    { field: "email", operator: "contains", value: "ACME" }, { field: "email", operator: "not_contains", value: "acme" },
    { field: "email", operator: "is_empty", value: "" }, { field: "email", operator: "is_not_empty", value: "" },
    { field: "title", operator: "contains", value: "vp" }, { field: "city", operator: "equals", value: "BOSTON" },
    { field: "emailVerificationStatus", operator: "equals", value: "valid" }, { field: "emailVerificationStatus", operator: "not_equals", value: "valid" },
    { field: "emailVerificationStatus", operator: "contains", value: "valid" }, { field: "emailVerificationStatus", operator: "is_empty", value: "" },
    { field: "isPrimary", operator: "equals", value: "true" }, { field: "isPrimary", operator: "equals", value: "false" },
    { field: "isPrimary", operator: "not_equals", value: "true" }, { field: "isPrimary", operator: "is_empty", value: "" },
    { field: "createdAt", operator: "gt", value: "2026-10-31" }, { field: "createdAt", operator: "lt", value: "2026-10-31" },
    { field: "createdAt", operator: "gt", value: "not a date" }, { field: "seniority", operator: "is_not_empty", value: "" },
    { field: "phone", operator: "equals", value: "" }, { field: "phone", operator: "contains", value: "" },
    { field: "phone", operator: "not_contains", value: "" }, { field: "linkedinUrl", operator: "gt", value: "x" },
    { field: "company", operator: "equals", value: "x" },
  ];
  beforeEach(() => { T(contacts).push(...people); });
  const jsCount = (rs: SegmentRule[], m: "all" | "any") => people.filter((c) => c.workspaceId === LSI && matchesSegment(c, rs, m)).length;

  it("each rule alone: the database counts what matchesSegment counts", async () => {
    for (const r of rules) {
      expect(await countSegment(h.db, LSI, [r], "all"), `${r.field} ${r.operator} ${r.value}`).toBe(jsCount([r], "all"));
    }
  });

  it("all and any of several rules, and no rules", async () => {
    const combos: SegmentRule[][] = [[rules[2], rules[6]], [rules[4], rules[12]], [rules[7], rules[16], rules[24]], [rules[18], rules[3]]];
    for (const c of combos) for (const m of ["all", "any"] as const) {
      expect(await countSegment(h.db, LSI, c, m), `${m} ${JSON.stringify(c)}`).toBe(jsCount(c, m));
    }
    expect(await countSegment(h.db, LSI, [], "any")).toBe(0);
    expect(segmentSql([], "all")).toBeNull();
    expect(ruleSql({ field: "company", operator: "equals", value: "x" })).toBeNull();
  });

  it("the router counts in SQL and getContacts is bounded; no whole-table load remains", async () => {
    const r = await caller().segments.evaluate({ rules: [{ id: "r", ...rules[2] }], matchType: "all" });
    expect(r.count).toBe(1);
    expect(h.selects.filter((s) => s.table === "contacts").map((s) => s.cols)).toEqual([["n"]]);
    T(contacts).push(...Array.from({ length: 30 }, (_, i) => contact(100 + i, { title: "VP" })));
    await caller().segments.create({ name: "VPs", matchType: "all", rules: [{ id: "a", field: "title", operator: "contains", value: "vp" }] });
    const seg = T(audienceSegments).find((s: any) => s.name === "VPs");
    expect(seg.contactCount).toBe(32);
    expect(await caller().segments.getContacts({ id: seg.id, limit: 10 })).toHaveLength(10);
    for (const f of ["server/routers/segments.ts", "server/routers/segmentRules.ts"]) {
      expect(read(f), f).not.toMatch(/allContacts/);
    }
  });
});

/* ── List members (P49) ──────────────────────────────────────────────── */

const person = (id: number, o: Record<string, unknown> = {}) => ({
  id, workspaceId: LSI, firstName: `P${id}`, lastName: "Z", title: "CTO", company: "Acme", email: `p${id}@x.com`, emailStatus: null,
  linkedinUrl: null, city: null, state: null, country: null, phone: "555-0100", enrichmentData: { big: "x".repeat(100) }, ...o,
});
const member = (id: number, recordId: number, o: Record<string, unknown> = {}) => ({
  // Added in batches of five a minute: rows that tie on addedAt, as an import makes them.
  id, workspaceId: LSI, listId: 7, recordType: "prospect", recordId, addedAt: new Date(Date.UTC(2026, 9, 1, 0, Math.floor(id / 5))), ...o,
});

describe("list members page in SQL with the columns the list shows (P49)", () => {
  beforeEach(() => {
    T(recordLists).push({ id: 7, workspaceId: LSI, name: "People", entityType: "people" }, { id: 8, workspaceId: LSI, name: "Cos", entityType: "companies" });
    for (let i = 1; i <= 25; i++) { T(prospects).push(person(i, { firstName: i % 2 ? "Ann" : "Bob" })); T(recordListMembers).push(member(i, i)); }
    T(prospects).push(person(200, { workspaceId: OTHER }));
    // Gone, another workspace's membership, another kind, another workspace's person.
    T(recordListMembers).push(member(90, 999), member(91, 1, { workspaceId: OTHER }), member(92, 5, { recordType: "contact" }), member(93, 200));
    T(accounts).push({ id: 50, workspaceId: LSI, name: "Globex", domain: "globex.com", industry: "Energy", region: "EU", arr: "100", notes: "n" });
    T(recordListMembers).push(member(60, 50, { listId: 8, recordType: "account" }));
  });

  it("newest first, paged, members whose record is gone or of another kind left out", async () => {
    const p1 = await listMemberPage(LSI, { id: 7, perPage: 10 });
    expect(p1.total).toBe(25);
    expect(p1.rows.map((r) => r.memberId)).toEqual([25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
    const all: number[] = [];
    for (let page = 1; page <= 3; page++) all.push(...(await listMemberPage(LSI, { id: 7, page, perPage: 10 })).rows.map((r) => r.memberId));
    expect(new Set(all).size).toBe(25);
    // Ids only, for "Add all": every person on the list who is in this workspace.
    expect([...p1.prospectIds].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("search and name sort run in SQL", async () => {
    const ann = await listMemberPage(LSI, { id: 7, search: "ann", perPage: 50 });
    expect(ann.total).toBe(13);
    const byName = await listMemberPage(LSI, { id: 7, sort: "name", perPage: 50 });
    expect(byName.rows.slice(0, 2).map((r) => r.record.firstName)).toEqual(["Ann", "Ann"]);
    expect(byName.rows.at(-1)!.record.firstName).toBe("Bob");
  });

  it("the record carries what the list shows, never phones or enrichment blobs", async () => {
    const { rows } = await listMemberPage(LSI, { id: 7, perPage: 10 });
    expect(Object.keys(rows[0].record).sort()).toEqual(["city", "company", "country", "email", "emailStatus", "firstName", "id", "lastName", "linkedinUrl", "state", "title"]);
    const co = await listMemberPage(LSI, { id: 8 });
    expect(co.rows[0].record).toEqual({ id: 50, name: "Globex", domain: "globex.com", industry: "Energy", region: "EU", arr: "100" });
    expect(co.prospectIds).toEqual([]);
    expect(h.selects.some((s) => (s.table === "prospects" || s.table === "accounts") && s.cols === "*")).toBe(false);
  });

  it("another workspace's list is empty; the router and both screens use the page", async () => {
    expect((await listMemberPage(OTHER, { id: 7 })).total).toBe(0);
    expect((await caller().recordLists.members({ id: 7, perPage: 10 })).rows).toHaveLength(10);
    expect(MAX_LIST_PROSPECT_IDS).toBe(5000);
    expect(read("client/src/pages/usip/ListDetail.tsx")).toContain("const memberProspectIds = membersQ.data?.prospectIds ?? [];");
    expect(read("client/src/components/usip/are/AddExistingProspectsDialog.tsx")).toContain("Number(listMembers.data?.total ?? 0)");
  });
});

/* ── Research tallies (P28) ──────────────────────────────────────────── */

describe("research tallies: per sector or persona, flagged when capped, no bodies (P28)", () => {
  beforeEach(() => {
    for (let pq = 1; pq <= 6; pq++) {
      T(prospectIntelligence).push({ id: pq, workspaceId: LSI, prospectQueueId: pq, researchSectorId: pq <= 4 ? 1 : 2, researchPersonaId: pq % 2 ? 10 : 11, researchUse: null });
      T(areExecutionQueue).push({ id: pq, workspaceId: LSI, prospectQueueId: pq, status: "sent", stepIndex: 0, executedAt: new Date(), messageContent: { body: "Hello there. More text." } });
    }
    T(areSignalLog).push({ id: 1, workspaceId: LSI, prospectQueueId: 1, signalType: "email_reply", sentiment: "positive", processedAt: new Date() });
  });

  it("each sector and persona is tallied on its own, with capped false", async () => {
    expect(await sectorTallies(LSI, [1, 2])).toEqual({
      1: { written: 4, contacted: 4, replied: 1, positive: 1, meetings: 0, capped: false },
      2: { written: 2, contacted: 2, replied: 0, positive: 0, meetings: 0, capped: false },
    });
    // Only the sectors asked for.
    expect(Object.keys(await sectorTallies(LSI, [2]))).toEqual(["2"]);
    const p = await personaResultSummaries(LSI);
    expect(Object.keys(p)).toEqual(["10", "11"]);
    expect(p[10]).toMatchObject({ written: 3, replied: 1, capped: false });
  });

  it("no tally reads a message body; the cap is per group", async () => {
    await sectorTallies(LSI, [1, 2]);
    await personaResultSummaries(LSI);
    const sends = h.selects.filter((s) => s.table === "are_execution_queue");
    expect(sends.length).toBeGreaterThan(0);
    expect(sends.every((s) => Array.isArray(s.cols) && !s.cols.includes("messageContent"))).toBe(true);
    const capped = h.selects.filter((s) => s.table === "prospect_intelligence" && s.limit === MAX_PROSPECTS);
    expect(capped.length).toBe(4); // one read per sector (2) and per persona (2)
    expect(read("server/services/research/results.ts")).toContain("capped: Number(c.n) > MAX_PROSPECTS");
  });

});

/* ── ARE campaign tabs (A44, A45) ────────────────────────────────────── */

const q = (id: number, o: Record<string, unknown> = {}) => ({
  id, workspaceId: LSI, campaignId: 38, firstName: `Q${id}`, lastName: "R", title: null, companyName: "Co", sequenceStatus: "pending",
  enrichmentStatus: "complete", rejectionReason: null, rejectedAt: new Date(Date.UTC(2026, 9, 1, 0, id)), icpMatchScore: 50, ...o,
});

describe("the campaign tabs count in SQL and page (A44, A45)", () => {
  beforeEach(() => {
    for (let i = 1; i <= 12; i++) T(prospectQueue).push(q(i, { sequenceStatus: "skipped", rejectionReason: i <= 7 ? "Below ICP" : i <= 9 ? " Below ICP " : i === 10 ? "" : null }));
    T(prospectQueue).push(q(20), q(21, { enrichmentStatus: "pending" }), q(22, { sequenceStatus: "enrolled" }), q(23, { sequenceStatus: "sourcing" }), q(24, { campaignId: 39 }), q(25, { workspaceId: OTHER }));
  });

  it("rejection reasons are counted in SQL, merged when they differ by spaces or are missing", async () => {
    const r = await caller().are.prospects.getRejectionStats({ campaignId: 38, perPage: 10 });
    expect(r.total).toBe(12);
    expect(r.byReason).toEqual([{ reason: "Below ICP", count: 9 }, { reason: "No reason given", count: 3 }]);
    expect(r.items).toHaveLength(10);
    expect(r.itemsTotal).toBe(12);
    expect(r.items.map((x: any) => x.id).slice(0, 3)).toEqual([12, 11, 10]);
    expect(h.selects.some((s) => s.table === "prospect_queue" && s.group)).toBe(true);
  });

  it("a reason filter and its page come from the server", async () => {
    const none = await caller().are.prospects.getRejectionStats({ campaignId: 38, reason: "No reason given" });
    expect(none.items.map((x: any) => x.id).sort((a: number, b: number) => a - b)).toEqual([10, 11, 12]);
    const below = await caller().are.prospects.getRejectionStats({ campaignId: 38, reason: "Below ICP", perPage: 10 });
    expect(below.itemsTotal).toBe(7);
    expect(below.items.map((x: any) => x.id)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect((await caller().are.prospects.getRejectionStats({ campaignId: 38, page: 2, perPage: 10 })).items.map((x: any) => x.id)).toEqual([2, 1]);
  });

  it("the Prospects tab's counts cover the whole queue, not the loaded page", async () => {
    expect(await caller().are.prospects.statusCounts({ campaignId: 38 })).toEqual({
      inQueue: 3, pendingEnrich: 1, awaitingApproval: 1, byStatus: { skipped: 12, pending: 2, enrolled: 1, sourcing: 1 },
    });
    const ui = read("client/src/pages/usip/ARECampaignDetail.tsx");
    expect(ui).toContain("const pendingEnrich = queueCounts?.pendingEnrich ?? 0;");
    expect(ui).toContain("{ campaignId, limit: PROSPECT_PAGE, offset: (prospectPage - 1) * PROSPECT_PAGE }");
    expect(ui).not.toMatch(/prospects\?\.filter\(\(p\) => p\.enrichmentStatus === "pending"\)/);
    expect(ui).toContain("{ campaignId, reason: reasonFilter, page: rejPage, perPage: REJECTION_PAGE }");
  });

  it("scrape jobs leave out rawResults; dispatches and the queue order are bounded and stable", async () => {
    T(areScrapeJobs).push({ id: 1, workspaceId: LSI, campaignId: 38, sourceType: "web", query: "x", status: "complete", resultCount: 2, rawResults: [{ a: 1 }], errorMessage: null, scrapedAt: null, createdAt: new Date() });
    const [job] = await caller().are.scraper.listJobs({ campaignId: 38 });
    expect(job).not.toHaveProperty("rawResults");
    expect(job).toMatchObject({ id: 1, resultCount: 2 });
    await expect(caller().are.scraper.listJobs({ limit: 201 })).rejects.toThrow();
    expect(read("server/services/performanceMetrics.ts")).toMatch(/\.orderBy\(desc\(areExecutionQueue\.executedAt\), desc\(areExecutionQueue\.id\)\)\n\s+\.limit\(MAX_DISPATCHES\);/);
    expect(read("server/routers/are/prospects.ts")).toContain(".orderBy(desc(prospectQueue.icpMatchScore), desc(intentSignals), desc(prospectQueue.id))");
  });
});

/* ── People sorts end in the id (R61) ────────────────────────────────── */

describe("People sorts end in the id (R61)", () => {
  it("every sort field, both ways, and the default", () => {
    expect(peopleOrder("company", "asc").map(sqlOf)).toEqual(["`prospects`.`company` asc", "`prospects`.`id` asc"]);
    expect(peopleOrder("name", "desc").map(sqlOf)).toEqual(["`prospects`.`firstName` desc", "`prospects`.`lastName` desc", "`prospects`.`id` desc"]);
    for (const f of ["fit", "title", "email", "phone", "industry"]) expect(sqlOf(peopleOrder(f, "asc").at(-1)), f).toBe("`prospects`.`id` asc");
    expect(peopleOrder(undefined, undefined).map(sqlOf)).toEqual(["`prospects`.`createdAt` desc", "`prospects`.`id` desc"]);
    expect(read("server/routers/prospects.ts")).toContain("[desc(scoreResults.normalizedScore), desc(prospects.id)]");
  });
});

/* ── The 15-minute alert sweep (R66, X4.4) ───────────────────────────── */

describe("the alert sweep reads per chunk, not per deal (R66, X4.4)", () => {
  const deal = (id: number, o: Record<string, unknown> = {}) => T(opportunities).push({
    id, workspaceId: LSI, name: `Deal ${id}`, stage: "discovery", winProb: 60, closeDate: null, pipelineId: 1, daysInStage: 0,
    stageEnteredAt: new Date(), updatedAt: new Date(), customFields: { big: "x" }, ...o,
  });
  beforeEach(() => {
    T(crmPipelines).push({ id: 1, workspaceId: LSI, name: "Default", isDefault: true, sortOrder: 0 });
    T(crmPipelineStages).push(
      { id: 11, workspaceId: LSI, pipelineId: 1, key: "discovery", label: "Discovery", sortOrder: 10, defaultWinProb: 20, isWon: false, isLost: false },
      { id: 15, workspaceId: LSI, pipelineId: 1, key: "won", label: "Won", sortOrder: 50, defaultWinProb: 100, isWon: true, isLost: false },
    );
  });

  it("the same alerts, once each", async () => {
    deal(1); // no activity, no champion
    deal(2, { closeDate: new Date(Date.now() + 3 * 86_400_000), winProb: 30 }); // + closing soon
    deal(3); // active, championed
    deal(4, { stage: "won" }); // closed: not scanned
    deal(5, { closeDate: new Date(Date.now() + 3 * 86_400_000), winProb: 55 }); // closing soon, but likely
    T(activities).push({ id: 1, workspaceId: LSI, relatedType: "opportunity", relatedId: 3, createdAt: new Date(), type: "note" });
    T(opportunityContactRoles).push({ id: 1, opportunityId: 3, contactId: 1, role: "champion" });
    T(pipelineAlerts).push({ id: 1, workspaceId: LSI, opportunityId: 1, alertType: "no_champion", dismissedAt: null });
    const r = await scanPipelineAlertsForWorkspace(LSI);
    expect(r.scanned).toBe(4);
    const fresh = T(pipelineAlerts).filter((a) => a.id !== 1).map((a) => `${a.opportunityId}:${a.alertType}`).sort();
    expect(fresh).toEqual(["1:no_activity", "2:closing_soon_regression", "2:no_activity", "2:no_champion", "5:no_activity", "5:no_champion"]);
    expect(r.created).toBe(6);
    // A second sweep finds them open and adds nothing.
    expect((await scanPipelineAlertsForWorkspace(LSI)).created).toBe(0);
  });

  it("the number of reads does not grow with the number of deals", async () => {
    deal(1);
    await scanPipelineAlertsForWorkspace(LSI); // reads the stages once; they are cached after
    h.selects = [];
    await scanPipelineAlertsForWorkspace(LSI);
    const few = h.selects.length;
    for (let id = 2; id <= 60; id++) deal(id);
    h.selects = [];
    await scanPipelineAlertsForWorkspace(LSI);
    expect(h.selects.length).toBe(few);
    expect(h.selects.some((s) => s.table === "opportunities" && s.cols === "*")).toBe(false);
  });
});

/* ── The engine (A34) ────────────────────────────────────────────────── */

describe("the engine screens a batch and sweeps completion grouped (A34)", () => {
  const src = read("server/areEngine.ts");
  it("the screen pass takes the oldest SCREEN_BATCH enriched rows a tick", () => {
    expect(src).toContain("export const SCREEN_BATCH = 200;");
    expect(src).toMatch(/eq\(prospectQueue\.sequenceStatus, "pending"\),\n\s+\),\n\s+\)\n\s+\.orderBy\(prospectQueue\.id\)\n\s+\.limit\(SCREEN_BATCH\);/);
  });
  it("the completion sweep is one grouped read per chunk, not one per prospect", () => {
    expect(src).toContain(".where(inArray(areExecutionQueue.prospectQueueId, enrolledIds.slice(i, i + SWEEP_CHUNK)))\n        .groupBy(areExecutionQueue.prospectQueueId);");
    expect(src).not.toContain(".where(eq(areExecutionQueue.prospectQueueId, p.id));");
  });
});

/* ── Large lists, polling, typing (X4.2, X4.3) ───────────────────────── */

describe("long lists render 50 at a time; polling stops; searches wait for typing (X4.2, X4.3)", () => {
  const Probe = ({ n }: { n: number }) => {
    const r = useShowMore(Array.from({ length: n }, (_, i) => i));
    return createElement("i", null, `${r.shown.length}/${r.remaining}`);
  };
  it("useShowMore shows one step and counts the rest", () => {
    expect(SHOW_MORE_STEP).toBe(50);
    expect(html(createElement(Probe, { n: 130 }))).toBe("<i>50/80</i>");
    expect(html(createElement(Probe, { n: 20 }))).toBe("<i>20/0</i>");
  });
  it("Tasks and the audit log use it", () => {
    const tasks = read("client/src/pages/usip/TasksV2.tsx");
    expect(tasks).toContain("{queueRows.shown.map((t) => <QueueRow key={t.id} t={t} />)}");
    expect(tasks).toContain("{draftRows.shown.map((t) => <DraftRow key={t.id} t={t} />)}");
    expect(tasks).not.toContain("queue.map((t) => <QueueRow");
    expect(read("client/src/pages/usip/Audit.tsx")).toContain("{rows.shown.map((a) => (");
  });
  it("a finished or failed pipeline is not polled again", () => {
    expect([pipelinePollMs("running"), pipelinePollMs(undefined), pipelinePollMs("complete"), pipelinePollMs("failed")]).toEqual([2000, 2000, false, false]);
    expect(read("client/src/pages/usip/ResearchPipeline.tsx")).toContain("refetchInterval: (q) => pipelinePollMs(q.state.data?.status)");
  });
  it("a typed value reaches the query once typing pauses", () => {
    const P = ({ v }: { v: string }) => createElement("i", null, useDebouncedValue(v));
    expect(html(createElement(P, { v: "abc" }))).toBe("<i>abc</i>");
    expect(SEARCH_DEBOUNCE_MS).toBe(300);
    expect(read("client/src/pages/usip/Reports.tsx")).toContain("const settledSpec = useDebouncedValue(runnableSpec);");
  });
});
