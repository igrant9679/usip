/**
 * "Audit & fix" on the Revenue Engine hub (tracker 3; audit 2026-10-20, A43).
 *
 *   chained duplicates are one group · rows moved to Rejections carry the
 *   reason, and a moved row's unsent steps stop · duplicates are settled
 *   before anything is spent on them, a search that found nothing is not
 *   repeated for 30 days, and a row already waiting for enrichment is not
 *   re-queued · the run reports what it found and what it changed, and the
 *   card keeps that report · it asks first, and a rep is not offered it.
 *
 * The real audit and reconcile run on the SQL-evaluating fake; LinkedIn and
 * person linking are stubbed, so nothing reaches a vendor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({ db: null as any, searches: [] as string[] }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./services/personLink", async (a) => ({
  ...(await a<typeof import("./services/personLink")>()),
  linkUnlinkedQueueRows: async () => ({ scanned: 0, linked: 0, created: 0, skippedNoIdentity: 0, failed: 0 }),
}));
vi.mock("./services/linkedinLookup", async (a) => ({
  ...(await a<typeof import("./services/linkedinLookup")>()),
  searchLinkedInProfiles: async (o: { keywords: string }) => { h.searches.push(o.keywords); return { ok: true, viaAccountId: "acct", hits: [], message: "none" }; },
}));
vi.mock("./services/linkedinEnrichment/orchestrator", () => ({ runForProspects: async () => ({ total: 0 }) }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { auditQueueProspects, reconcileQueueProspects } from "./services/are/prospectReconcile";
import { areExecutionQueue, linkedinActivityLog, prospectQueue } from "../drizzle/schema";
import { ReconcileReport, reconcileReportLines } from "../client/src/components/usip/are/ProspectQualityCard";

const WS = 2;
const T = (t: any) => h.db.rowsOf(getTableName(t)) as any[];
const row = (id: number) => T(prospectQueue).find((r) => r.id === id);
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const q = (id: number, o: Record<string, unknown> = {}) => ({
  id, workspaceId: WS, campaignId: 1, personProspectId: null, sequenceStatus: "pending", enrichmentStatus: "complete",
  firstName: null, lastName: null, email: null, linkedinUrl: null, sourceUrl: null, title: null, companyName: null, companyDomain: null,
  rejectedAt: null, rejectedByUserId: null, rejectionReason: null, ...o,
});
const run = () => reconcileQueueProspects({ workspaceId: WS, userId: 7, isAdmin: false, linkedinSearchBudget: 10 });

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.searches = [];
});

describe("duplicates are found through a chain (union-find)", () => {
  it("A shares an email with C, B a profile with C: one person, one group of three", async () => {
    T(prospectQueue).push(
      q(1, { campaignId: 1, firstName: "Amy", lastName: "Ng", email: "amy@acme.example" }),
      q(2, { campaignId: 2, firstName: "Amy", lastName: "N.", linkedinUrl: "https://www.linkedin.com/in/amy-ng-1" }),
      q(3, { campaignId: 3, firstName: "Amy", lastName: "Ng", email: "amy@acme.example", linkedinUrl: "https://linkedin.com/in/amy-ng-1/" }),
    );
    const a = await auditQueueProspects(WS);
    expect(a.duplicateGroups).toBe(1);
    expect(a.duplicateRows).toBe(2);
    expect(a.crossCampaignGroups).toBe(1);
  });
});

describe("the fix says why, stops what it moves, and doesn't spend twice", () => {
  beforeEach(() => {
    T(prospectQueue).push(
      // One person twice: the enrolled row is kept, the pending one moves.
      q(1, { sequenceStatus: "enrolled", firstName: "Dee", lastName: "Kay", email: "dee@co.example", companyName: "Co" }),
      q(2, { campaignId: 2, sequenceStatus: "approved", firstName: "Dee", lastName: "Kay", email: "dee@co.example", companyName: "Co" }),
      // No way to identify this one.
      q(3, { sourceUrl: "https://example.org/list" }),
      // Named, no profile: searched once, then not again for 30 days.
      q(4, { firstName: "Lee", lastName: "Moss", companyName: "Bramble" }),
      q(5, { firstName: "Ana", lastName: "Ruiz", companyName: "Fennel" }),
      // Nameless with a profile, already waiting for enrichment.
      q(6, { linkedinUrl: "https://linkedin.com/in/someone-6", enrichmentStatus: "pending" }),
      q(7, { linkedinUrl: "https://linkedin.com/in/someone-7", enrichmentStatus: "failed" }),
    );
    T(areExecutionQueue).push({ id: 50, workspaceId: WS, campaignId: 2, prospectQueueId: 2, stepIndex: 0, status: "scheduled", failureReason: null });
    T(linkedinActivityLog).push({ id: 1, workspaceId: WS, unipileAccountId: "acct", kind: "search", source: "reconcile", targetIdentifier: "Lee Moss Bramble", occurredAt: new Date(Date.now() - 3 * 86_400_000) });
  });

  it("a duplicate goes to Rejections with the row it duplicates, and its scheduled step stops", async () => {
    const r = await run();
    expect(row(1).sequenceStatus).toBe("enrolled");
    expect(row(2)).toMatchObject({ sequenceStatus: "skipped", rejectedByUserId: 7, rejectionReason: "Audit & fix: the same person as row 1 in campaign 1" });
    expect(T(areExecutionQueue)[0]).toMatchObject({ status: "skipped", failureReason: "Audit & fix: the same person as row 1 in campaign 1" });
    expect(row(3)).toMatchObject({ sequenceStatus: "skipped", rejectionReason: "Audit & fix: no name, email or LinkedIn profile to identify this person" });
    expect(r.duplicatesSkipped).toBe(1);
    expect(r.flaggedUnreconcilable).toBe(1);
    expect(r.changes).toHaveLength(2);
    expect(r.changes[0]).toMatch(/^row 2 \(campaign 2, was approved\) moved to Rejections: the same person as row 1 in campaign 1/);
  });

  it("the duplicate is settled before searching, a recent search is not repeated, a waiting row is not re-queued", async () => {
    const r = await run();
    // Dee once — the kept row, not the duplicate that leaves (both were
    // searched when duplicates were settled last) — and Ana. Lee was
    // searched three days ago and found nothing, so not again.
    expect(h.searches).toEqual(["Dee Kay Co", "Ana Ruiz Fennel"]);
    expect(r.linkedinSearched).toBe(2);
    expect(r.linkedinSearchesSaved).toBe(1);
    // Row 6 was already pending; row 7 (failed) goes back.
    expect(r.requeuedForEnrichment).toBe(1);
    expect(row(7).enrichmentStatus).toBe("pending");
  });

  it("reports what it found before it changed anything", async () => {
    const r = await run();
    expect(r.found).toMatchObject({ duplicateRows: 1, crossCampaignGroups: 1, unreconcilable: 1, missingName: 3 });
    expect(r.found).not.toHaveProperty("flaggedRowIds");
    const lines = reconcileReportLines(r as any);
    expect(lines.found).toContain("1 duplicate row (1 person in more than one campaign)");
    expect(lines.changed).toContain("Moved 1 duplicate to Rejections, keeping the most engaged row");
    expect(lines.changed).toContain("Searched LinkedIn for 2 people; found 0 confident matches");
  });
});

describe("the card asks first, keeps the report, and is a manager's", () => {
  const card = read("client/src/components/usip/are/ProspectQualityCard.tsx");

  it("renders what was found, what changed, the rows moved and what could not be fixed", () => {
    const html = renderToStaticMarkup(createElement(ReconcileReport, { result: {
      scanned: 40, found: { missingName: 2, badLinkedinUrl: 1, badSourceUrl: 0, unlinkedPerson: 0, duplicateRows: 1, crossCampaignGroups: 0, unreconcilable: 0 },
      linksScrubbed: 1, personsLinked: 0, personsCreated: 0, requeuedForEnrichment: 2, linkedinFound: 0, linkedinSearched: 0, linkedinSearchesSaved: 3,
      profileRetrievesQueued: 0, duplicatesSkipped: 1, flaggedUnreconcilable: 0,
      changes: ["row 9 (campaign 1, was pending) moved to Rejections: the same person as row 4 in this campaign, which is kept."],
      notes: ["LinkedIn discovery unavailable: No LinkedIn accounts are bridged in this workspace."],
    } }));
    expect(html).toContain("Checked 40 prospects: found 3 kinds of problem, made 3 kinds of change.");
    expect(html).toContain("2 prospects with no name");
    expect(html).toContain("Cleared broken links on 1 row");
    expect(html).toContain("Rows moved to Rejections (1)");
    expect(html).toContain("the same person as row 4 in this campaign");
    expect(html).toContain("LinkedIn discovery unavailable");
    expect(html).toContain("Not searched again: 3 people");
    const nothing = reconcileReportLines({ scanned: 5, found: { missingName: 0, badLinkedinUrl: 0, badSourceUrl: 0, unlinkedPerson: 0, duplicateRows: 0, crossCampaignGroups: 0, unreconcilable: 0 },
      linksScrubbed: 0, personsLinked: 0, personsCreated: 0, requeuedForEnrichment: 0, linkedinFound: 0, linkedinSearched: 0, linkedinSearchesSaved: 0,
      profileRetrievesQueued: 0, duplicatesSkipped: 0, flaggedUnreconcilable: 0, changes: [], notes: [] });
    expect(nothing.summary).toBe("Checked 5 prospects: nothing needed fixing.");
  });

  it("the button confirms first, the report stays, and a rep sees who can run it", () => {
    expect(card).toContain("const canFix = rankOf(current?.role) >= ROLE_RANK.manager;");
    expect(card).toContain("{canFix ? (\n            <ConfirmButton");
    expect(card).toContain("onConfirm={() => reconcile.mutate({ linkedinSearchBudget: RECONCILE_SEARCH_BUDGET })}");
    expect(card).toContain("A manager or admin can run Audit &amp; fix.");
    expect(card).toContain("setReport(r);");
    expect(card).toContain("{report && <ReconcileReport result={report} onClose={() => setReport(null)} />}");
    // The notes used to go to the browser console.
    expect(card).not.toContain("console.log");
    expect(read("client/src/pages/usip/AREHub.tsx")).toContain('import { ProspectQualityCard } from "@/components/usip/are/ProspectQualityCard";');
  });
});
