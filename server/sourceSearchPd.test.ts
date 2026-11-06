/**
 * Source search spends nothing for nothing, finds a running search again, and
 * promotes to the right people (audit 2026-10-20, batch Pd), plus the
 * WarmySender adapter's flat contacts (N2) and the settings redaction (N3).
 *
 *   P68  "Has email" / "Has phone" alone are not a filtered search
 *   P77  the same search still going is found again, not started twice
 *   P71  promote stamps each row with the person it became, reports what was
 *        not saved, links companies, and marks a failed save failed
 *   N2   contact2…contact5 flat fields are a business's further people, and
 *        each acquired record goes back to its own preview
 *   N3   the redaction drops secrets by name, not every name with "key" in it
 *
 * No vendor is called: the registry's eligibility is stubbed and the staged
 * rows come from QuickEnrich, which acquires nothing on promote.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: null as any, gate: null as null | Promise<void>, associate: 0 }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./services/enrichment/fieldHistory", async (a) => ({ ...(await a<typeof import("./services/enrichment/fieldHistory")>()), recordFieldHistory: async () => {} }));
vi.mock("./services/company/associationService", async (a) => ({
  ...(await a<typeof import("./services/company/associationService")>()),
  associateUnlinkedProspects: async () => { h.associate++; return { linked: 0, created: 0, needsReview: 0, missing: 0 }; },
}));
vi.mock("./services/prospectSources/registry", async (a) => ({
  ...(await a<typeof import("./services/prospectSources/registry")>()),
  eligibleFor: async () => { if (h.gate) await h.gate; return { eligible: [], skipped: [] }; },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { emptyCriteria, matchCapabilities, narrowingFilters, LEADOCEAN_CAPABILITIES, type SearchCriteria } from "@shared/prospectSources";
import { promoteResults, startRun } from "./services/prospectSources/searchRuns";
import { acquiredFor } from "./services/prospectSources/executor";
import { mapLeadRow } from "./services/prospectSources/adapters/warmysender";
import { isSecretName, redactConfig } from "./routers/prospectSources";
import type { ProspectRecord } from "./services/prospectSources/types";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
const crit = (over: Partial<SearchCriteria>): SearchCriteria => ({ ...emptyCriteria(), ...over });
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.gate = null;
  h.associate = 0;
});

/* ── P68 ──────────────────────────────────────────────────────────────── */

describe("presence flags alone are not a filtered search (P68)", () => {
  it("no source runs and the server refuses to start", async () => {
    const onlyEmail = crit({ hasEmail: true });
    expect(narrowingFilters(onlyEmail)).toEqual([]);
    expect(narrowingFilters(crit({ hasEmail: true, hasPhone: true, jobTitles: ["CFO"] }))).toEqual(["jobTitle"]);
    // LeadOcean supports hasEmail natively: it still cannot run on it alone.
    expect(matchCapabilities(LEADOCEAN_CAPABILITIES, onlyEmail).verdict).toBe("cannot");
    expect(matchCapabilities(LEADOCEAN_CAPABILITIES, crit({ hasEmail: true, jobTitles: ["CFO"] })).verdict).toBe("full");
    await expect(startRun(WS, 1, onlyEmail, 25)).rejects.toThrow(/besides Has email/);
    await expect(startRun(WS, 1, crit({ hasEmail: true, hasPhone: true }), 25)).rejects.toThrow();
    expect(rows("prospect_search_runs")).toHaveLength(0);
  });
});

/* ── P77 ──────────────────────────────────────────────────────────────── */

describe("a search still going is found again (P77)", () => {
  it("the same search returns the running run; a finished one or a different one starts anew", async () => {
    let release!: () => void;
    h.gate = new Promise<void>((r) => { release = r; });
    const c = crit({ jobTitles: ["CFO"], hasEmail: true });
    const a = await startRun(WS, 1, c, 25, ["warmysender"]);
    const b = await startRun(WS, 1, crit({ hasEmail: true, jobTitles: ["cfo "] }), 25, ["warmysender"]);
    expect(b).toEqual({ runId: a.runId, alreadyRunning: true });
    const other = await startRun(WS, 1, crit({ jobTitles: ["Treasurer"] }), 25, ["warmysender"]);
    expect(other.runId).not.toBe(a.runId);
    expect(rows("prospect_search_runs")).toHaveLength(2);
    release();
    await settle();
    expect(row("prospect_search_runs", a.runId).status).toBe("complete");
    const again = await startRun(WS, 1, c, 25, ["warmysender"]);
    expect(again.alreadyRunning).toBeUndefined();
    expect(again.runId).not.toBe(a.runId);
  });
});

/* ── P71 ──────────────────────────────────────────────────────────────── */

const rec = (externalId: string, over: Partial<ProspectRecord>): ProspectRecord => ({
  externalId, firstName: "", lastName: "", jobTitle: null, seniority: null, companyName: null, companyDomain: null,
  email: null, emailIsMasked: false, emailVerifiedAt: null, mobilePhone: null, businessPhone: null, linkedinUrl: null,
  city: null, stateProvince: null, country: null, industry: null, headcount: null, rawSourcePayload: {}, ...over,
} as ProspectRecord);
const staged = (id: number, r: ProspectRecord) => rows("prospect_search_results").push({
  id, workspaceId: WS, runId: 50, sourceSlug: "quickenrich", externalId: r.externalId, rawPayload: {}, normalized: r,
  dedupeKey: null, isNetNew: true, wasCharged: false, emailIsMasked: false, promotedProspectId: null,
});

describe("promote stamps each row with the person it became (P71)", () => {
  it("matches back exactly, says what was not saved and why, and links companies", async () => {
    rows("prospect_search_runs").push({ id: 50, workspaceId: WS, status: "complete", criteria: {}, batchTarget: 25 });
    // Already in People, stored in another case and URL shape.
    rows("prospects").push({ id: 300, workspaceId: WS, firstName: "jane", lastName: "doe", company: "Acme", email: null, linkedinUrl: "https://www.linkedin.com/in/Jane-Doe/", fieldProvenance: {}, verificationStatus: "needs_review", verificationSetBy: "discovery" });
    rows("email_suppressions").push({ id: 1, workspaceId: WS, email: "gone@beta.example", reason: "unsubscribe" });
    staged(1, rec("q1", { firstName: "Jane", lastName: "Doe", companyName: "Acme", linkedinUrl: "linkedin.com/in/jane-doe", city: "Austin", stateProvince: "Texas", country: "US" }));
    staged(2, rec("q2", { firstName: "Gone", lastName: "Away", companyName: "Beta", email: "gone@beta.example" }));
    staged(3, rec("q3", { firstName: "New", lastName: "Person", companyName: "Gamma", linkedinUrl: "https://www.linkedin.com/in/new-person" }));
    const r = await promoteResults(WS, 1, 50, [1, 2, 3]);
    expect(r.promoted).toBe(2);
    expect(row("prospect_search_results", 1).promotedProspectId).toBe(300);
    expect(row("prospect_search_results", 2).promotedProspectId).toBeNull();
    const created = rows("prospects").find((p) => p.firstName === "New");
    expect(row("prospect_search_results", 3).promotedProspectId).toBe(created.id);
    expect(r.errors).toContain("1 not saved to People: 1 on a suppression list");
    await settle();
    expect(row("discovery_runs", r.discoveryRunId!)).toMatchObject({ status: "complete" });
    await vi.waitFor(() => expect(h.associate).toBe(1), { timeout: 15000 });
    // The place reached People in its parts (P65, source search's half).
    expect(row("prospects", 300)).toMatchObject({ city: "Austin", state: "Texas", country: "US" });
    expect((r.persisted as any).saved).toBeUndefined();
  });

  it("a save that throws marks the discovery run failed and says nothing acquired is lost", async () => {
    rows("prospect_search_runs").push({ id: 50, workspaceId: WS, status: "complete", criteria: {}, batchTarget: 25 });
    rows("prospects").push({ id: 300, workspaceId: WS, firstName: "Jane", lastName: "Doe", company: "Acme", linkedinUrl: "https://www.linkedin.com/in/jane-doe", fieldProvenance: {} });
    staged(1, rec("q1", { firstName: "Jane", lastName: "Doe", companyName: "Acme", linkedinUrl: "https://www.linkedin.com/in/jane-doe" }));
    const db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS, beforeUpdate: (t) => { if (t === "prospects") throw new Error("disk full"); } });
    for (const t of ["prospect_search_runs", "prospects", "prospect_search_results"]) db.rowsOf(t).push(...rows(t));
    h.db = db;
    const r = await promoteResults(WS, 1, 50, [1]);
    expect(r.promoted).toBe(0);
    expect(r.errors.join(" ")).toMatch(/Saving to People failed \(disk full\)/);
    expect(row("discovery_runs", r.discoveryRunId!)).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("disk full") });
  });
});

/* ── N2 ───────────────────────────────────────────────────────────────── */

/** Shaped like a live search_leads row (2026-11-06): the business, its first
 *  person on the row itself, and its 2nd to 5th people in flat fields. */
const LIVE_ROW = {
  id: "lead_8812", business_name: "Riverside Dental Group", website: "https://www.riversidedental.example/", phone: "555-0100",
  city: "Richmond", state: "Virginia", country: "US", category: "Dentist",
  contact_name: "Maria Lopez", job_title: "Practice Owner", email: "m***@riversidedental.example",
  contact2_name: "Sam Patel", contact2_title: "Office Manager", contact2_email: "s***@riversidedental.example", contact2_phone: "555-0101",
  contact3_name: "Lee Chan, DDS", contact3_title: "Associate Dentist", contact3_email: "lee@riversidedental.example", contact3_linkedin: "https://www.linkedin.com/in/lee-chan",
  contact4_name: "", contact4_title: "", contact4_email: "",
  contact5_name: "Ana Ruiz", contact5_title: "Hygienist", contact5_email: null,
};

describe("a business's 2nd to 5th people are kept (N2)", () => {
  it("reads contact2…contact5 as people #2 to #5 beside the first, skipping empty slots", () => {
    const people = mapLeadRow(LIVE_ROW);
    expect(people.map((p) => [p.externalId, p.firstName, p.lastName, p.jobTitle])).toEqual([
      ["lead_8812", "Maria", "Lopez", "Practice Owner"],
      ["lead_8812#2", "Sam", "Patel", "Office Manager"],
      ["lead_8812#3", "Lee", "Chan", "Associate Dentist"],
      ["lead_8812#5", "Ana", "Ruiz", "Hygienist"],
    ]);
    expect(people[1]).toMatchObject({ email: null, emailIsMasked: true, businessPhone: "555-0101", companyName: "Riverside Dental Group", companyDomain: "riversidedental.example", city: "Richmond" });
    expect(people[2]).toMatchObject({ email: "lee@riversidedental.example", linkedinUrl: "https://www.linkedin.com/in/lee-chan" });
    // A contacts array keeps its own numbering.
    expect(mapLeadRow({ id: "B1", business_name: "Acme", contacts: [{ contact_name: "A B" }, { contact_name: "C D" }] }).map((p) => p.externalId)).toEqual(["B1#0", "B1#1"]);
  });

  it("each acquired person goes back to their own preview, not all to the last one", () => {
    const previews = mapLeadRow(LIVE_ROW);
    const exported = mapLeadRow({ ...LIVE_ROW, email: "maria@riversidedental.example", contact2_email: "sam@riversidedental.example" });
    expect(previews.map((p) => acquiredFor(p, exported)?.firstName)).toEqual(["Maria", "Sam", "Lee", "Ana"]);
    // Numbered differently on export: matched by name inside the business.
    const renumbered = exported.map((r, i) => ({ ...r, externalId: `lead_8812#${i}` }));
    expect(previews.map((p) => acquiredFor(p, renumbered)?.firstName)).toEqual(["Maria", "Sam", "Lee", "Ana"]);
    // A business's only person matches by its id when no name says otherwise; a different person does not.
    expect(acquiredFor(rec("X#3", {}), [rec("X", { firstName: "Zoe" })])?.firstName).toBe("Zoe");
    expect(acquiredFor(rec("X#3", { firstName: "Zed" }), [rec("X", { firstName: "Zoe" })])).toBeUndefined();
    // An unnumbered id (LeadOcean's) matches exactly whatever the names say.
    expect(acquiredFor(rec("lo-1", { firstName: "J" }), [rec("lo-1", { firstName: "Jane" })])?.firstName).toBe("Jane");
    expect(acquiredFor(rec("Y", { firstName: "Zed" }), [rec("X", { firstName: "Zed" })])).toBeUndefined();
  });
});

/* ── N3 ───────────────────────────────────────────────────────────────── */

describe("the settings redaction drops secrets by name (N3)", () => {
  it("keeps sampleRowKeys and the rest of the config, drops anything named like a secret", () => {
    const out = redactConfig({
      sampleRowKeys: ["id", "contact2_name"], tier: "pro", toolSchemas: { a: 1 }, probeRows: 3,
      apiKey: "x", api_key: "x", key: "x", secretKey: "x", clientSecret: "x", accessToken: "x", password: "x", authorization: "x",
    });
    expect(out).toEqual({ sampleRowKeys: ["id", "contact2_name"], tier: "pro", toolSchemas: { a: 1 }, probeRows: 3 });
    expect(isSecretName("sampleRowKeys")).toBe(false);
    expect(isSecretName("monkey")).toBe(false);
    expect(isSecretName("refresh_token")).toBe(true);
  });
});
