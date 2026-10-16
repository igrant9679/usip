/**
 * Research, phase 1 (owner, 2026-10-14: "start phase 1"). Done when an admin
 * can build a market and its sectors by hand in one workspace, and no other
 * workspace can see them.
 *
 * The router is exercised through the REAL procedures (appRouter.createCaller,
 * real workspace and role middleware) against a small in-memory database. The
 * fake renders each drizzle condition with MySqlDialect and evaluates the SQL
 * it produced, so a missing `workspaceId = ?` is a row that leaks, not a
 * condition object that merely looks right.
 */
import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import {
  changedParts,
  cleanMarketContent,
  cleanPersonaResearch,
  cleanSectorContent,
  looksPersonal,
} from "@shared/researchShape";

const h = vi.hoisted(() => ({ db: null as any, wsId: 2, beforeUpdate: null as null | ((table: string) => void) }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { appRouter } from "./routers";
import { REVISIONS_KEPT, saveSector } from "./routers/research";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";

const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

/* ── The in-memory database (server/__fakes__/sqlFakeDb.ts) ─────────────── */

function makeDb(roles: Record<number, string>) {
  return makeSqlFakeDb({ roles, wsId: () => h.wsId, beforeUpdate: (t) => h.beforeUpdate?.(t) });
}

function caller(wsId: number) {
  h.wsId = wsId;
  const ctx = {
    user: { id: 1, openId: "u1", email: "owner@example.com", name: "Owner", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(wsId) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext;
  return appRouter.createCaller(ctx);
}

/* ── The shape ──────────────────────────────────────────────────────────── */

describe("the shared research shape", () => {
  it("cleans a sector: trims, dedupes case-insensitively, clamps scores, orders the size range, keeps only http links", () => {
    const { content } = cleanSectorContent({
      name: "  K-12 districts ",
      status: "nonsense",
      asOf: "2026-02-30x",
      scores: { reach: 9, money: "2", pain: 0, fit: null, access: "x" },
      targeting: { titles: ["Superintendent", "superintendent ", "", "CFO"], employeeMin: "5,000", employeeMax: 50 },
      sources: [{ title: "", url: "https://ed.gov/a" }, { title: "dup", url: "HTTPS://ED.GOV/A" }, { title: "bad", url: "javascript:alert(1)" }],
      glossary: "not a list",
    });
    expect(content.name).toBe("K-12 districts");
    expect(content.status).toBe("draft");
    expect(content.asOf).toBe("");
    expect(content.scores).toEqual({ reach: 5, money: 2, pain: 1, fit: null, access: null });
    expect(content.targeting.titles).toEqual(["Superintendent", "CFO"]);
    expect([content.targeting.employeeMin, content.targeting.employeeMax]).toEqual([50, 5000]);
    expect(content.sources).toEqual([{ title: "https://ed.gov/a", url: "https://ed.gov/a" }]);
    expect(content.facts.programs).toEqual([]);
    // V8 parses "2026-02-30" as March 2; the shape must not.
    const asOf = (v: string) => cleanSectorContent({ name: "x", asOf: v }).content.asOf;
    expect([asOf("2026-02-30"), asOf("2026-04-31"), asOf("2026-02-28"), asOf("2028-02-29")]).toEqual(["", "", "2026-02-28", "2028-02-29"]);
  });

  it("holds organizations, never people: emails and phone numbers are dropped and reported", () => {
    for (const s of ["jane.doe@district.org", "Call 555-123-4567", "(555) 123 4567", "+44 20 7946 0958", "5551234567", "mailto:x", "tel:911"]) {
      expect(looksPersonal(s), s).toBe(true);
    }
    for (const s of ["$1,250,000 a year", "13,000 districts", "2020 - 2025", "FY2024–FY2026", "Title I, Part A", "+15% since 2023", "https://www2.ed.gov/programs/titleiparta/index.html"]) {
      expect(looksPersonal(s), s).toBe(false);
    }
    const { content, dropped } = cleanSectorContent({
      name: "Counties",
      summary: "Ask the clerk at clerk@county.gov",
      buyers: { painPoints: ["Late reports", "Ring 555-867-5309"] },
      facts: { marketSize: [{ value: "3,143", label: "counties" }] },
    });
    expect(content.summary).toBe("");
    expect(content.buyers.painPoints).toEqual(["Late reports"]);
    expect(content.facts.marketSize).toEqual([{ value: "3,143", label: "counties", source: "" }]);
    expect(dropped).toEqual(["summary", "buyers.painPoints"]);
    expect(cleanPersonaResearch({ cares: "x@y.com", pains: ["Audits", " audits "] }).content).toEqual({ cares: "", pains: ["Audits"], objections: [], angle: "" });
  });

  it("a source link's digits are dates and ids, not a phone number; an email in a link still goes", () => {
    // 2026-10-16: a dated CRS report link was being dropped on every save.
    const crs = "https://www.everycrsreport.com/files/2026-05-27_R48958_6ead37cb994df92872d65d1504746904bebaf1e1.html";
    const { content, dropped } = cleanSectorContent({
      name: "Arts",
      sources: [{ title: "CRS", url: crs }, { title: "Mail", url: "https://x.org/?to=jane@arts.org" }],
      facts: { programs: [{ name: "Grants for Arts", url: "https://www.arts.gov/grants/2026/1234567890" }], marketSize: [{ value: "$207M", label: "NEA", source: crs }] },
      summary: "Call 5551234567",
    });
    expect(content.sources.map((s) => s.url)).toEqual([crs]);
    expect(content.facts.programs[0].url).toBe("https://www.arts.gov/grants/2026/1234567890");
    expect(content.facts.marketSize[0].source).toBe(crs);
    expect(content.summary).toBe("");
    expect(dropped).toEqual(["summary", "sources.url"]);
  });

  it("names the parts that changed between two versions", () => {
    const a = cleanSectorContent({ name: "A", targeting: { titles: ["CFO"] } }).content;
    const b = cleanSectorContent({ name: "A", targeting: { titles: ["CFO", "COO"] }, messaging: { avoid: ["Never say cheap"] } }).content;
    expect(changedParts(a, b)).toEqual(["targeting", "messaging"]);
    expect(changedParts(a, a)).toEqual([]);
    expect(changedParts(cleanMarketContent({ name: "M" }).content, cleanMarketContent({ name: "M", glossary: [{ term: "LEA", definition: "Local education agency" }] }).content)).toEqual(["glossary"]);
  });
});

/* ── The router ─────────────────────────────────────────────────────────── */

describe("research router", () => {
  beforeEach(() => {
    // The owner is admin in LSI Media (2) and CommunityForce (4); manager and rep elsewhere.
    h.db = makeDb({ 2: "admin", 4: "admin", 7: "manager", 8: "rep" });
    h.beforeUpdate = null;
  });

  it("an admin builds a market and its sectors by hand, and no other workspace can see or touch them", async () => {
    const lsi = caller(2);
    const m = await lsi.research.markets.create({ content: { name: "Regional authorities", tagline: "Federal money, local spend" } });
    const s = await caller(2).research.sectors.create({ marketId: m.id, content: { name: "K-12 districts", targeting: { titles: ["Superintendent"] } } });
    const p = await caller(2).personas.create({ name: "Director of Federal Programs", sectorId: s.id, cares: "Compliance", pains: ["Late allocations"] });

    const list = await caller(2).research.markets.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Regional authorities", sectorCount: 1, sectorsByStatus: { draft: 1, researched: 0, verified: 0 } });
    const got = await caller(2).research.markets.get({ id: m.id });
    expect(got.sectors).toEqual([expect.objectContaining({ id: s.id, name: "K-12 districts", personaCount: 1 })]);
    const sector = await caller(2).research.sectors.get({ id: s.id });
    expect(sector.sector.content.targeting.titles).toEqual(["Superintendent"]);
    expect(sector.personas.map((x: any) => x.id)).toEqual([p.id]);
    expect(await caller(2).research.sectors.options()).toEqual([expect.objectContaining({ id: s.id, marketName: "Regional authorities" })]);

    // CommunityForce, where the same person is also an admin, sees nothing of it.
    const cf = () => caller(4);
    expect(await cf().research.markets.list()).toEqual([]);
    expect(await cf().research.sectors.options()).toEqual([]);
    const notFound = { code: "NOT_FOUND" };
    await expect(cf().research.markets.get({ id: m.id })).rejects.toMatchObject(notFound);
    await expect(cf().research.sectors.get({ id: s.id })).rejects.toMatchObject(notFound);
    await expect(cf().research.markets.update({ id: m.id, expectedRevision: 1, content: { name: "Mine now" } })).rejects.toMatchObject(notFound);
    await expect(cf().research.sectors.update({ id: s.id, expectedRevision: 1, content: { name: "Mine now" } })).rejects.toMatchObject(notFound);
    await expect(cf().research.sectors.create({ marketId: m.id, content: { name: "Sneaky" } })).rejects.toMatchObject(notFound);
    await expect(cf().research.revisions.list({ entityType: "sector", entityId: s.id })).rejects.toMatchObject(notFound);
    await expect(cf().research.revisions.get({ entityType: "market", entityId: m.id, revision: 1 })).rejects.toMatchObject(notFound);
    await expect(cf().research.revisions.restore({ entityType: "sector", entityId: s.id, revision: 1, expectedRevision: 1 })).rejects.toMatchObject(notFound);
    await expect(cf().personas.create({ name: "Borrowed", sectorId: s.id })).rejects.toMatchObject(notFound);
    await expect(cf().research.sectors.delete({ id: s.id })).rejects.toMatchObject(notFound);
    await expect(cf().research.markets.delete({ id: m.id })).rejects.toMatchObject(notFound);

    // Still all there, unchanged.
    const after = await caller(2).research.sectors.get({ id: s.id });
    expect(after.sector.content.name).toBe("K-12 districts");
    expect(after.sector.revision).toBe(1);
  });

  it("every save is a version; a save from an old version is refused; restore saves the old content as a new version", async () => {
    const m = await caller(2).research.markets.create({ content: { name: "Healthcare" } });
    const s = await caller(2).research.sectors.create({ marketId: m.id, content: { name: "Rural hospitals" } });
    const v2 = await caller(2).research.sectors.update({ id: s.id, expectedRevision: 1, content: { name: "Rural hospitals", targeting: { titles: ["CFO"] } } });
    expect(v2).toMatchObject({ revision: 2, changed: ["targeting"] });

    // Someone else's tab still holds version 1.
    await expect(caller(2).research.sectors.update({ id: s.id, expectedRevision: 1, content: { name: "Overwritten" } })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await caller(2).research.sectors.get({ id: s.id })).sector.content.name).toBe("Rural hospitals");

    // Saving what is already there is not a new version.
    const same = await caller(2).research.sectors.update({ id: s.id, expectedRevision: 2, content: { name: "Rural hospitals", targeting: { titles: ["CFO"] } } });
    expect(same).toMatchObject({ revision: 2, changed: [] });

    const restored = await caller(2).research.revisions.restore({ entityType: "sector", entityId: s.id, revision: 1, expectedRevision: 2 });
    expect(restored).toMatchObject({ revision: 3, changed: ["targeting"] });
    expect((await caller(2).research.sectors.get({ id: s.id })).sector.content.targeting.titles).toEqual([]);

    const history = await caller(2).research.revisions.list({ entityType: "sector", entityId: s.id });
    expect(history.map((r) => [r.revision, r.note, r.changed])).toEqual([
      [3, "Restored version 1", ["targeting"]],
      [2, "Edited", ["targeting"]],
      [1, "Created", []],
    ]);
    // The saver has no users row here (as after an account is removed): named, not an error.
    expect(history[0].savedByName).toBe("A former member");
    const v2data = await caller(2).research.revisions.get({ entityType: "sector", entityId: s.id, revision: 2 });
    expect((v2data.data as any).targeting.titles).toEqual(["CFO"]);
  });

  it("a save that loses the race at the database is refused, and writes no version", async () => {
    const db = h.db;
    const m = await caller(2).research.markets.create({ content: { name: "Retail" } });
    const s = await caller(2).research.sectors.create({ marketId: m.id, content: { name: "Grocers" } });
    // Another save lands between our read and our write.
    h.beforeUpdate = (table) => {
      if (table !== "research_sectors") return;
      h.beforeUpdate = null;
      db.rowsOf("research_sectors").find((r: any) => r.id === s.id).revision = 2;
    };
    await expect(saveSector(db, { workspaceId: 2, userId: 1, id: s.id, expectedRevision: 1, content: { name: "Grocers", summary: "Mine" } }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(db.rowsOf("research_sectors")[0].summary).toBeNull();
    expect(db.rowsOf("research_revisions").filter((r: any) => r.entityType === "sector").map((r: any) => r.revision)).toEqual([1]);
  });

  it(`keeps the latest ${REVISIONS_KEPT} versions`, async () => {
    const m = await caller(2).research.markets.create({ content: { name: "Energy" } });
    for (let i = 1; i <= REVISIONS_KEPT; i++) {
      await caller(2).research.markets.update({ id: m.id, expectedRevision: i, content: { name: "Energy", tagline: `v${i + 1}` } });
    }
    const kept = h.db.rowsOf("research_revisions").map((r: any) => r.revision);
    expect(kept).toHaveLength(REVISIONS_KEPT);
    expect(Math.min(...kept)).toBe(2);
    expect(Math.max(...kept)).toBe(REVISIONS_KEPT + 1);
  });

  it("everyone reads; managers and admins edit; only admins delete", async () => {
    const m = await caller(7).research.markets.create({ content: { name: "Logistics" } });
    const s = await caller(7).research.sectors.create({ marketId: m.id, content: { name: "3PLs" } });
    await caller(7).research.sectors.update({ id: s.id, expectedRevision: 1, content: { name: "Third-party logistics" } });
    await expect(caller(7).research.sectors.delete({ id: s.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(7).research.markets.delete({ id: m.id })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // A rep in that workspace (same fake user, different role map) can read but not write.
    h.db = makeDb({ 7: "rep" });
    const repDb = h.db;
    repDb.rowsOf("research_markets").push({ id: 1, workspaceId: 7, name: "Logistics", status: "draft", source: "manual", revision: 1, updatedAt: new Date() });
    expect(await caller(7).research.markets.list()).toHaveLength(1);
    await expect(caller(7).research.markets.create({ content: { name: "Mine" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(7).research.markets.update({ id: 1, expectedRevision: 1, content: { name: "Mine" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(7).research.revisions.restore({ entityType: "market", entityId: 1, revision: 1, expectedRevision: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("deleting a market removes its sectors and every version, and keeps the personas, unlinked", async () => {
    const m = await caller(2).research.markets.create({ content: { name: "Higher ed" } });
    const s1 = await caller(2).research.sectors.create({ marketId: m.id, content: { name: "Community colleges" } });
    const s2 = await caller(2).research.sectors.create({ marketId: m.id, content: { name: "Universities" } });
    const other = await caller(2).research.markets.create({ content: { name: "Nonprofits" } });
    const keep = await caller(2).research.sectors.create({ marketId: other.id, content: { name: "Foundations" } });
    const p = await caller(2).personas.create({ name: "Financial aid director", sectorId: s1.id });
    const q = await caller(2).personas.create({ name: "Program officer", sectorId: keep.id });

    const r = await caller(2).research.markets.delete({ id: m.id });
    expect(r).toEqual({ success: true, sectorsDeleted: 2 });
    const db = h.db;
    expect(db.rowsOf("research_markets").map((x: any) => x.id)).toEqual([other.id]);
    expect(db.rowsOf("research_sectors").map((x: any) => x.id)).toEqual([keep.id]);
    expect(db.rowsOf("research_revisions").map((x: any) => `${x.entityType}:${x.entityId}`).sort()).toEqual([`market:${other.id}`, `sector:${keep.id}`]);
    const personaRows = db.rowsOf("personas");
    expect(personaRows.find((x: any) => x.id === p.id).sectorId).toBeNull();
    expect(personaRows.find((x: any) => x.id === q.id).sectorId).toBe(keep.id);
    void s2;
  });

  it("names are unique among siblings, a blank name is refused, and personal data is reported back", async () => {
    const m = await caller(2).research.markets.create({ content: { name: "Government" } });
    await expect(caller(2).research.markets.create({ content: { name: " government " } })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller(2).research.markets.create({ content: { name: "   " } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // The same sector name is fine in another market, not twice in one.
    const other = await caller(2).research.markets.create({ content: { name: "Utilities" } });
    await caller(2).research.sectors.create({ marketId: m.id, content: { name: "Counties" } });
    await caller(2).research.sectors.create({ marketId: other.id, content: { name: "Counties" } });
    await expect(caller(2).research.sectors.create({ marketId: m.id, content: { name: "COUNTIES" } })).rejects.toMatchObject({ code: "CONFLICT" });

    const s = await caller(2).research.sectors.create({ marketId: m.id, content: { name: "Cities", summary: "Mayor's cell 555-201-3344" } });
    expect(s.dropped).toEqual(["summary"]);
    expect(h.db.rowsOf("research_sectors").find((x: any) => x.id === s.id).summary).toBeNull();
  });

  it("personas keep the research fields, cleaned, and a persona's sector must be the workspace's own", async () => {
    const m = await caller(2).research.markets.create({ content: { name: "Ed" } });
    const s = await caller(2).research.sectors.create({ marketId: m.id, content: { name: "Districts" } });
    const p = await caller(2).personas.create({ name: "CFO", pains: ["Audits", "audits", "Call me at 555-201-3344"], objections: ["Too busy"], angle: "Show the trail", cares: "Clean audits" });
    let row = h.db.rowsOf("personas").find((x: any) => x.id === p.id);
    expect([row.pains, row.objections, row.angle, row.cares, row.sectorId]).toEqual([["Audits"], ["Too busy"], "Show the trail", "Clean audits", null]);

    await caller(2).personas.update({ id: p.id, sectorId: s.id, angle: "" });
    row = h.db.rowsOf("personas").find((x: any) => x.id === p.id);
    expect([row.sectorId, row.angle, row.pains]).toEqual([s.id, null, ["Audits"]]);

    await caller(2).personas.update({ id: p.id, sectorId: null });
    expect(h.db.rowsOf("personas").find((x: any) => x.id === p.id).sectorId).toBeNull();
  });
});

/* ── Wiring ─────────────────────────────────────────────────────────────── */

describe("research wiring", () => {
  it("migration 0201 creates the tables and the persona columns the schema declares", () => {
    const mig = read("server/_core/rawMigrations.ts");
    const block = mig.slice(mig.indexOf('name: "0201_research_foundation.sql"'), mig.indexOf("];", mig.indexOf('name: "0201_research_foundation.sql"')));
    const tick = "`";
    for (const t of ["research_markets", "research_sectors", "research_revisions"]) expect(block).toContain(`CREATE TABLE IF NOT EXISTS ${tick}${t}${tick}`);
    for (const c of ["sectorId", "cares", "pains", "objections", "angle", "source", "sourceRef"]) expect(block).toContain(`ALTER TABLE ${tick}personas${tick} ADD COLUMN ${tick}${c}${tick}`);
    const schema = read("drizzle/schema.ts");
    expect(schema).toContain('export const researchMarkets = mysqlTable(\n  "research_markets"');
    expect(schema).toContain('export const researchSectors = mysqlTable(\n  "research_sectors"');
    expect(schema).toContain('export const researchRevisions = mysqlTable(\n  "research_revisions"');
    expect(schema).toContain('sectorId: int("sectorId"),');
  });

  it("Research is on the rail under Prospecting, and Personas and ICP are its tabs", () => {
    const reg = read("client/src/lib/toolRegistry.ts");
    expect(reg).toContain('{ href: "/research", label: "Research", icon: Telescope, group: "Prospecting", primary: true,');
    expect(reg).toContain('{ href: "/personas", label: "Personas", icon: Users, group: "Prospecting",');
    expect(reg).toContain('{ href: "/are/icp", label: "ICP Agent", icon: Target, group: "Prospecting",');
    expect(reg).not.toContain('{ href: "/personas", label: "Personas", icon: Users, group: "Configuration",');
    const app = read("client/src/App.tsx");
    for (const r of ["/research", "/research/markets/:id", "/research/sectors/:id"]) expect(app).toContain(`<Route path="${r}">`);
    for (const page of ["client/src/pages/usip/Personas.tsx", "client/src/pages/usip/AREIcpAgent.tsx", "client/src/pages/usip/research/ResearchHome.tsx"]) {
      expect(read(page), page).toContain("<ResearchSubNav />");
    }
  });

  it("the pages save from the revision the edit started on, not the latest one fetched", () => {
    for (const page of ["client/src/pages/usip/research/ResearchMarket.tsx", "client/src/pages/usip/research/ResearchSector.tsx"]) {
      expect(read(page), page).toContain("expectedRevision: draft.baseRevision");
    }
    const hook = read("client/src/components/usip/research/ResearchFields.tsx");
    expect(hook).toContain("setDraft((d) => ({ value: { ...(d?.value ?? saved), ...p }, base: d?.base ?? revision }));");
  });
});
