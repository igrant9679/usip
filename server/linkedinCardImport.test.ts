/**
 * Find prospects' LinkedIn search card (audit 2026-10-20, batch Pd).
 *
 *   P76  hits are saved to People, the table the rest of the tab writes, as a
 *        discovery run — not to CRM Leads — and matched like any find (P64)
 *   P75  each hit is checked on its own, so one odd field fails nothing else
 *   P149 a search with nothing in it is refused before it reaches the account
 *
 * Against the real router and the SQL-evaluating fake; the LinkedIn vendor
 * client is stubbed and never reached.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, associate: 0, vendorSearch: 0 }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/enrichment/fieldHistory", async (a) => ({ ...(await a<typeof import("./services/enrichment/fieldHistory")>()), recordFieldHistory: async () => {} }));
vi.mock("./services/company/associationService", async (a) => ({
  ...(await a<typeof import("./services/company/associationService")>()),
  associateUnlinkedProspects: async () => { h.associate++; return { linked: 0, created: 0, needsReview: 0, missing: 0 }; },
}));
vi.mock("./lib/unipile", async (a) => ({
  ...(await a<typeof import("./lib/unipile")>()),
  searchLinkedIn: async () => { h.vendorSearch++; return { items: [] }; },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { linkedInSearchHasTerms, searchHitFields } from "./routers/unipile";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.associate = 0;
  h.vendorSearch = 0;
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
});

describe("the LinkedIn card saves to People, row by row (P75, P76), and never searches for nothing (P149)", () => {
  it("one odd field does not fail the rest; people land in People as a run, matched like any find", async () => {
    rows("prospects").push({
      id: 3, workspaceId: WS, firstName: "Bo", lastName: "Ng", company: "Beta", email: null, title: "Old title",
      linkedinUrl: "https://www.linkedin.com/in/Bo-Ng/", fieldProvenance: {}, verificationStatus: "needs_review", verificationSetBy: "discovery",
    });
    const r = await caller().unipile.importSearchHitsToPeople({ hits: [
      // company as an object, a null and a number: all fine.
      { name: "Jane Doe, MBA", headline: "Director of Grants", company: { name: "Acme" }, location: null, public_profile_url: "https://www.linkedin.com/in/jane-doe", provider_id: 12345 },
      // Already in People under another spelling of the same profile URL.
      { first_name: "Bo", last_name: "Ng", title: "COO", company: "Beta", profile_url: "linkedin.com/in/bo-ng?trk=x" },
      // Not a hit at all, and one with no last name.
      "garbage", null, { first_name: "Mononym" },
    ] });
    expect(r).toMatchObject({ created: 1, updated: 1, skipped: 3 });
    expect(rows("leads")).toHaveLength(0);
    const jane = rows("prospects").find((p) => p.firstName === "Jane");
    expect(jane).toMatchObject({ lastName: "Doe", company: "Acme", linkedinUrl: "https://www.linkedin.com/in/jane-doe", lastDiscoveryRunId: r.runId });
    expect(row("prospects", 3).lastDiscoveryRunId).toBe(r.runId);
    expect(row("discovery_runs", r.runId!)).toMatchObject({ status: "complete", input: { fromLinkedInSearch: true } });
    expect(rows("raw_finds").every((f) => f.source === "linkedin_search")).toBe(true);
    await vi.waitFor(() => expect(h.associate).toBe(1), { timeout: 15000 });
  });

  it("reads one hit's fields tolerantly", () => {
    expect(searchHitFields({ company: { name: "Acme" }, location: 7, profile_url: "https://evil.example/in/x", public_profile_url: "https://www.linkedin.com/in/a" }))
      .toMatchObject({ company: "Acme", location: "7", url: "https://www.linkedin.com/in/a" });
    expect(searchHitFields({ profile_url: "https://evil.example/in/x" })!.url).toBeUndefined();
    expect(searchHitFields([1])).toBeNull();
    expect(searchHitFields("x")).toBeNull();
  });

  it("refuses a search with no keywords and no filter, before the account is used", async () => {
    await expect(caller().unipile.searchLinkedIn({ api: "sales_navigator", category: "people", filters: {}, limit: 10 }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().unipile.searchLinkedIn({ api: "sales_navigator", category: "people", keywords: "  ", filters: { location: [] }, limit: 10 }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.vendorSearch).toBe(0);
    expect(linkedInSearchHasTerms(undefined, { location: [102] })).toBe(true);
    expect(linkedInSearchHasTerms(undefined, { tenure: [{ min: 2 }] })).toBe(true);
    expect(linkedInSearchHasTerms("cfo", {})).toBe(true);
    expect(linkedInSearchHasTerms("", { industry: [], tenure: [{}] })).toBe(false);
  });
});
