/**
 * Companies sourced by Research (owner, 2026-10-16: "the companies imported or
 * identified by the Research module ... should be identified as sourced by
 * Research"; "I already did the import ... can you mark them for me?").
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, wsId: 4 }));
vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { markAllDownstreamAccounts, markDownstreamAccounts } from "./services/research/accountSource";
import { companySourceLabel, isResearchSource, RESEARCH_SOURCES } from "@shared/researchSource";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const T0 = new Date("2026-10-16T18:30:00Z");
const before = new Date("2026-09-01T00:00:00Z");
const after = new Date("2026-10-16T18:31:00Z");

function seed() {
  const db = h.db;
  db.rowsOf("downstream_links").push({ id: 1, workspaceId: 4, downstreamWorkspaceId: "regional-authorities", status: "active", createdAt: T0 });
  db.rowsOf("research_external_refs").push(
    { workspaceId: 4, linkId: 1, kind: "sector", ref: "regional-authorities/local-gov", velocityId: 30 },
    { workspaceId: 4, linkId: 1, kind: "sector", ref: "regional-authorities/k12", velocityId: 31 },
    ...[1, 2, 3, 4, 5].map((id) => ({ workspaceId: 4, linkId: 1, kind: "account", ref: `org-${id}`, velocityId: id })),
  );
  const acct = (id: number, o: Record<string, unknown>) => ({ id, workspaceId: 4, name: `Org ${id}`, customFields: { downstreamRef: `org-${id}`, downstreamSegmentRef: "regional-authorities/local-gov" }, ...o });
  db.rowsOf("accounts").push(
    acct(1, { sourceType: null, researchSectorId: null, createdAt: after }), // created by the import
    acct(2, { sourceType: "prospect_import", researchSectorId: null, createdAt: before }), // matched, has a source
    acct(3, { sourceType: null, researchSectorId: null, createdAt: before }), // matched, no source recorded
    acct(4, { sourceType: null, researchSectorId: 99, createdAt: after }), // a sector someone already set
    acct(5, { sourceType: null, researchSectorId: null, createdAt: after, customFields: { downstreamRef: "org-5", downstreamSegmentRef: "regional-authorities/not-imported" } }),
    { id: 6, workspaceId: 2, name: "LSI's own", sourceType: null, researchSectorId: null, createdAt: after, customFields: { downstreamSegmentRef: "regional-authorities/local-gov" } },
  );
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { 4: "admin", 2: "admin" }, wsId: () => h.wsId });
  seed();
});

const row = (id: number) => h.db.rowsOf("accounts").find((a: any) => a.id === id);

describe("marking the companies a Downstream import brought in", () => {
  it("companies the import created are sourced by Research; every one gets its research sector", async () => {
    expect(await markDownstreamAccounts(h.db, 4, 1)).toEqual({ sector: 3, source: 3 });
    expect(row(1)).toMatchObject({ sourceType: RESEARCH_SOURCES.downstream, researchSectorId: 30 });
    // Matched companies that existed before keep their own source.
    expect(row(2)).toMatchObject({ sourceType: "prospect_import", researchSectorId: 30 });
    expect(row(3)).toMatchObject({ sourceType: null, researchSectorId: 30 });
    // A sector already set is not replaced; a segment that was not imported has no sector.
    expect(row(4)).toMatchObject({ sourceType: RESEARCH_SOURCES.downstream, researchSectorId: 99 });
    expect(row(5)).toMatchObject({ sourceType: RESEARCH_SOURCES.downstream, researchSectorId: null });
    // Another workspace's company is never touched.
    expect(row(6)).toMatchObject({ sourceType: null, researchSectorId: null });
  });

  it("is safe to run again, and runs for every link at startup", async () => {
    await markAllDownstreamAccounts();
    expect(row(1)).toMatchObject({ sourceType: RESEARCH_SOURCES.downstream, researchSectorId: 30 });
    expect(await markDownstreamAccounts(h.db, 4, 1)).toEqual({ sector: 0, source: 0 });
    expect(await markDownstreamAccounts(h.db, 2, 1)).toEqual({ sector: 0, source: 0 }); // the link is workspace 4's
  });

  it("the import tags as it creates and marks at the end; startup marks earlier imports", () => {
    const imp = read("server/services/research/downstreamImport.ts");
    expect(imp).toContain("            sourceType: RESEARCH_SOURCES.downstream,\n            researchSectorId: sectorIdByRef.get(o.segmentRef) ?? null,");
    expect(imp).toContain("  await markDownstreamAccounts(db, workspaceId, link.id);\n");
    expect(read("server/_core/index.ts")).toContain('import("../services/research/accountSource").then((m) => m.markAllDownstreamAccounts())');
  });

  it("companies a research-sector campaign creates are sourced by Research too", () => {
    const p = read("server/services/are/approvePromotion.ts");
    expect(p).toContain('{ sourceType: sectorId != null ? RESEARCH_SOURCES.campaign : "are_approval" },');
    expect(p).toContain("eq(accounts.workspaceId, workspaceId), isNull(accounts.researchSectorId)));");
  });
});

describe("finding them on the Companies page", () => {
  function caller(ws: number) {
    h.wsId = ws;
    return appRouter.createCaller({
      user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
      req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
      res: { clearCookie: () => {} },
    } as unknown as TrpcContext);
  }
  const ids = async (filters: Record<string, unknown>) =>
    (await caller(4).companies.search({ filters, sort: { field: "name", direction: "asc" }, page: 1, perPage: 50 } as any)).data.map((a: any) => a.id);

  it("filter by sourced by Research, by being in a research sector, or by sector; each row says its source", async () => {
    await markDownstreamAccounts(h.db, 4, 1);
    h.db.rowsOf("accounts").push({ id: 7, workspaceId: 4, name: "Org 7", sourceType: RESEARCH_SOURCES.campaign, researchSectorId: 31, createdAt: after });
    expect(await ids({ research: "sourced" })).toEqual([1, 4, 5, 7]);
    expect(await ids({ research: "in_sector" })).toEqual([1, 2, 3, 4, 7]);
    expect(await ids({ researchSectorIds: [31] })).toEqual([7]);
    const r = await caller(4).companies.search({ filters: {}, sort: { field: "name", direction: "asc" }, page: 1, perPage: 50 } as any);
    expect(r.data.find((a: any) => a.id === 1)).toMatchObject({ sourceType: "research_downstream", researchSectorId: 30 });
    expect(r.data.some((a: any) => a.id === 6)).toBe(false);
  });

  it("labels, the Research badge and the company's Research panel", () => {
    expect(isResearchSource("research_downstream")).toBe(true);
    expect(isResearchSource("are_approval")).toBe(false);
    expect(isResearchSource(null)).toBe(false);
    expect(companySourceLabel("research_downstream")).toBe("Research (Downstream)");
    expect(companySourceLabel("research_campaign")).toBe("Research (campaign)");
    expect(companySourceLabel("some_new_source")).toBe("Some new source");
    expect(companySourceLabel(null)).toBe("Not recorded");
    const page = read("client/src/pages/usip/Companies.tsx");
    expect(page).toContain('<FilterGroup label="Research" icon={Telescope}');
    expect(page).toContain("{isResearchSource(a.sourceType) && (");
    expect(read("client/src/pages/usip/CompanyProfile.tsx")).toContain("<CompanyResearchCard account={c as any} />");
  });
});
