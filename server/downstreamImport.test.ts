/**
 * Research phase 5: importing Downstream's v2 export (owner, 2026-10-14:
 * "start phase 5"). Done when CommunityForce's Regional Authorities export
 * lands only in its own workspace, a re-import changes nothing, and an award
 * shows up as a sourced hook in ARE copy.
 *
 * The fixture is the real example from Downstream's
 * docs/velocity-integration.md (commit 6e3bd4f), varied per test.
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
import { accounts } from "../drizzle/schema";
import { appRouter } from "./routers";
import { __clearDownstreamDrafts } from "./services/research/downstreamImport";
import { __clearResearchContextCache, researchContextFor } from "./services/research/context";
import { downstreamAccountFor } from "./services/research/downstreamAccounts";
import { parseDownstreamFile } from "@shared/downstreamContract";
import {
  accountFromDownstream,
  awardHook,
  mostRelevantAward,
  withAward,
  cleanLinkSettings,
  effectiveDownstreamTargeting,
  marketExtras,
  segmentToSector,
  sellerAllowed,
} from "@shared/downstreamMap";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const EXAMPLE = JSON.parse(read("server/__fakes__/downstreamExample.json"));
const K12 = "regional-authorities/k12";
const LOCALGOV = "regional-authorities/local-gov";

/** The example, made whole enough to exercise every path. */
function exportFile(over: (f: any) => void = () => {}) {
  const f = JSON.parse(JSON.stringify(EXAMPLE));
  f.segments[0].targeting.titles = ["Director of Federal Programs", "Superintendent"];
  f.segments[0].targeting.exclude = ["student"];
  const lg = JSON.parse(JSON.stringify(f.segments[0]));
  lg.ref = LOCALGOV;
  lg.name = "Local governments";
  lg.shortName = "Local gov";
  lg.revision = 1;
  f.segments.push(lg);
  f.organizations[0].segmentRef = K12;
  f.organizations[0].website = "https://www.angelicministries.org/about";
  const distressed = JSON.parse(JSON.stringify(f.organizations[0]));
  distressed.ref = "regional-authorities/prospects/distressed";
  distressed.name = "Struggling County Schools";
  distressed.website = "strugglingschools.org";
  distressed.seller.fit.flags = ["financial-distress"];
  f.organizations.push(distressed);
  over(f);
  return JSON.stringify(f);
}

function caller(ws: number) {
  h.wsId = ws;
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  // CommunityForce = 4, LSI Media = 2, a manager-only workspace = 7.
  h.db = makeSqlFakeDb({ roles: { 2: "admin", 4: "admin", 7: "manager" }, wsId: () => h.wsId });
  __clearDownstreamDrafts();
  __clearResearchContextCache();
});

/* ── The file ───────────────────────────────────────────────────────────── */

describe("reading an export", () => {
  it("accepts the real v2 example", () => {
    const r = parseDownstreamFile(JSON.stringify(EXAMPLE));
    expect(r.ok).toBe(true);
  });

  it("refuses anything else with a reason a person can act on", () => {
    expect(parseDownstreamFile("not json")).toMatchObject({ ok: false, error: expect.stringMatching(/not a JSON file/) });
    expect(parseDownstreamFile(JSON.stringify({ ...EXAMPLE, format: "other" }))).toMatchObject({ ok: false, error: expect.stringMatching(/not a Downstream export/) });
    expect(parseDownstreamFile(JSON.stringify({ ...EXAMPLE, version: 1 }))).toMatchObject({ ok: false, error: expect.stringMatching(/version 1; Velocity reads version 2/) });
    expect(parseDownstreamFile(JSON.stringify({ ...EXAMPLE, segments: "nope" }))).toMatchObject({ ok: false, error: expect.stringMatching(/does not match version 2: segments/) });
    const many = { ...EXAMPLE, segments: Array.from({ length: 201 }, () => EXAMPLE.segments[0]) };
    expect(parseDownstreamFile(JSON.stringify(many))).toMatchObject({ ok: false, error: expect.stringMatching(/201 segments; the limit is 200/) });
    expect(parseDownstreamFile(" ".repeat(15 * 1024 * 1024 + 10))).toMatchObject({ ok: false, error: expect.stringMatching(/limit is 15 MB/) });
  });

  it("drops anything that looks like a personal email or phone number, and says where", () => {
    const f = JSON.parse(exportFile());
    f.segments[0].summary = "Call the director at 555-201-3344";
    f.personas[0].pains = ["Late allocations", "email jane@district.org"];
    const r = parseDownstreamFile(JSON.stringify(f));
    if (!r.ok) throw new Error(r.error);
    expect(r.file.segments[0].summary).toBe("");
    expect(r.file.personas[0].pains).toEqual(["Late allocations"]);
    expect(r.dropped).toEqual(["segments[0].summary", "personas[0].pains[1]"]);
  });

  it("an id or a link with ten digits in a row is not a phone number; an email in a link still goes", () => {
    // 2026-10-16: CommunityForce's real export lost 14 organization refs like these, and a dated report link.
    const f = JSON.parse(exportFile());
    f.organizations[0].ref = "regional-authorities/prospects/7353593813e9";
    f.organizations[0].segmentRef = K12;
    f.segments[0].sources = [
      { title: "CRS R48958", url: "https://www.everycrsreport.com/files/2026-05-27_R48958_6ead37cb994df92872d65d1504746904bebaf1e1.html" },
      { title: "Write to us", url: "https://example.org/contact?to=jane@district.org" },
    ];
    f.segments[0].summary = "Phone the clerk on 5552013344";
    const r = parseDownstreamFile(JSON.stringify(f));
    if (!r.ok) throw new Error(r.error);
    expect(r.file.organizations[0].ref).toBe("regional-authorities/prospects/7353593813e9");
    expect(r.file.segments[0].sources.map((s) => s.url)).toEqual(["https://www.everycrsreport.com/files/2026-05-27_R48958_6ead37cb994df92872d65d1504746904bebaf1e1.html", ""]);
    expect(r.file.segments[0].summary).toBe("");
    expect(r.dropped).toEqual(["segments[0].summary", "segments[0].sources[1].url"]);
  });
});

describe("each company narrows the market, and seller layers are only the seller's", () => {
  const seg = EXAMPLE.segments[0];

  it("territory and size replace, titles are added and removed, never-target words are added", () => {
    const t = effectiveDownstreamTargeting(
      { ...seg.targeting, titles: ["Superintendent", "Director of Federal Programs"], geographies: ["United States"], exclude: ["student"], employeeMin: 10, employeeMax: 900 },
      cleanLinkSettings({ territory: ["Kentucky"], employeeMax: 5000, addTitles: ["Federal Programs Coordinator"], removeTitles: ["SUPERINTENDENT "], exclude: ["vendor", "Student"] }),
    );
    expect(t.titles).toEqual(["Director of Federal Programs", "Federal Programs Coordinator"]);
    expect(t.geographies).toEqual(["Kentucky"]);
    expect([t.employeeMin, t.employeeMax]).toEqual([10, 5000]);
    expect(t.exclude).toEqual(["student", "vendor"]);
  });

  it("without the seller's say-so there is no product messaging, no fit, no tiers", () => {
    expect(sellerAllowed({ audience: "seller" }, false)).toBe(false);
    expect(sellerAllowed({ audience: "market" }, true)).toBe(false);
    expect(sellerAllowed({ audience: "seller" }, true)).toBe(true);
    const off = segmentToSector(seg, cleanLinkSettings({}), false);
    expect([off.messaging.leadWith, off.messaging.sampleOpening, off.scores.fit]).toEqual([[], "", null]);
    expect(off.messaging.avoid).toEqual(seg.market.avoid);
    const on = segmentToSector(seg, cleanLinkSettings({}), true);
    expect(on.messaging.leadWith).toEqual(seg.seller.leadWith);
    expect(on.messaging.sampleOpening).toBe(seg.seller.sampleOpeningLine);
    expect(on.scores.fit).toBe(seg.seller.fitScore);
    expect(marketExtras(EXAMPLE, false).stats).not.toHaveProperty("tiers");
    expect(marketExtras(EXAMPLE, true).stats).toHaveProperty("tiers");
    expect(accountFromDownstream(EXAMPLE.organizations[0], false).fit).toBeNull();
    expect(accountFromDownstream(EXAMPLE.organizations[0], true).fit?.product).toBe("discover-raise");
  });

  it("an award is a one-line, sourced hook", () => {
    expect(awardHook(EXAMPLE.organizations[0].award)).toEqual({
      hook: "Appalachian Regional Commission awarded $500,000 for Supportive housing and training through INSPIRE (FY2023); the project has ended",
      sourceUrl: "https://www.arc.gov/wp-content/uploads/2023/09/INSPIRE-Award-Summaries-by-State-September-2023.pdf",
    });
    expect(awardHook(null)).toBeNull();
    expect(awardHook({ funder: "ARC" } as any)).toBeNull();
  });
});

/* ── Importing ──────────────────────────────────────────────────────────── */

const commit = (ws: number, token: string, over: Record<string, unknown> = {}) =>
  caller(ws).research.downstream.commit({ token, useSellerMessaging: true, segments: [K12], importOrganizations: true, takeDownstream: [], ...over } as any);

describe("CommunityForce's export", () => {
  it("imports only into the workspace it is linked to, as a market, a sector, personas and accounts with their awards", async () => {
    const p = await caller(4).research.downstream.preview({ fileText: exportFile() });
    expect(p.link.state).toBe("unassigned");
    expect(p.segments.map((s) => [s.ref, s.state, s.ticked])).toEqual([[K12, "new", false], [LOCALGOV, "new", false]]);
    expect(p.sellerName).toBe("CommunityForce");
    await expect(commit(4, p.token)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const r = await commit(4, p.token, { assign: true });
    expect(r.counts).toMatchObject({ created: 3, accountsCreated: 2 }); // market, sector, one k12 persona
    const db = h.db;
    const [link] = db.rowsOf("downstream_links");
    expect(link).toMatchObject({ workspaceId: 4, downstreamWorkspaceId: "regional-authorities", useSellerMessaging: true, audience: "seller" });
    expect(link.settings.segments).toEqual([K12]);

    const market = db.rowsOf("research_markets")[0];
    expect(market).toMatchObject({ workspaceId: 4, name: "Regional Authorities", source: "downstream", sourceRef: "regional-authorities" });
    expect(market.extras.funders.map((f: any) => f.ref)).toEqual(["regional-authorities/authorities/dra"]);
    expect(market.extras.stats).toHaveProperty("tiers");
    expect(market.suggestedSectors.map((s: any) => s.name)).toEqual(["Local governments"]);

    const [sector] = db.rowsOf("research_sectors");
    expect(sector).toMatchObject({ workspaceId: 4, marketId: market.id, source: "downstream", sourceRef: K12, status: "researched" });
    expect(sector.targeting.titles).toEqual(["Director of Federal Programs", "Superintendent"]);
    expect(sector.messaging.leadWith.length).toBe(1);

    const persons = db.rowsOf("personas");
    expect(persons.map((x: any) => [x.name, x.sectorId, x.source])).toEqual([["Director of Federal Programs", sector.id, "downstream"]]);
    expect(persons[0].pains).toEqual(["Late allocations", "Audit findings"]);
    expect(db.rowsOf("persona_categories")[0]).toMatchObject({ workspaceId: 4, name: "Downstream: Regional Authorities" });

    const accts = db.rowsOf("accounts");
    expect(accts.map((a: any) => [a.workspaceId, a.name, a.normalizedDomain])).toEqual([
      [4, "Angelic Ministries", "angelicministries.org"],
      [4, "Struggling County Schools", "strugglingschools.org"],
    ]);
    expect(accts[0].customFields).toMatchObject({ downstreamRef: "regional-authorities/prospects/33b98f6ab880", intentTopics: ["INSPIRE"] });
    expect(accts[0].customFields.downstreamAward.funder).toBe("Appalachian Regional Commission");
    expect(accts[0].customFields.downstreamFit.product).toBe("discover-raise");
    // Sourced by Research, in the sector its segment became (2026-10-16).
    expect(accts.map((a: any) => [a.sourceType, a.researchSectorId])).toEqual([["research_downstream", sector.id], ["research_downstream", sector.id]]);

    // LSI Media sees none of it, and cannot use CommunityForce's preview.
    expect(await caller(2).research.markets.list()).toEqual([]);
    const p2 = await caller(2).research.downstream.preview({ fileText: exportFile() });
    expect(p2.link.state).toBe("unassigned");
    const fresh = await caller(4).research.downstream.preview({ fileText: exportFile() });
    await expect(commit(2, fresh.token, { assign: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await caller(2).research.downstream.links()).toEqual([]);
  });

  it("re-importing the same file changes nothing", async () => {
    const p = await caller(4).research.downstream.preview({ fileText: exportFile() });
    await commit(4, p.token, { assign: true });
    const db = h.db;
    const before = JSON.stringify({ m: db.rowsOf("research_markets"), s: db.rowsOf("research_sectors").map((x: any) => ({ ...x, updatedAt: 0 })), v: db.rowsOf("research_revisions").length, a: db.rowsOf("accounts").length, p: db.rowsOf("personas").length });

    const again = await caller(4).research.downstream.preview({ fileText: exportFile() });
    expect(again.link.state).toBe("assigned");
    expect(again.market.state).toBe("unchanged");
    expect(again.segments.find((s) => s.ref === K12)).toMatchObject({ state: "unchanged", ticked: true });
    expect(again.segments.find((s) => s.ref === K12)!.personas.map((x) => x.state)).toEqual(["unchanged"]);
    const r = await commit(4, again.token);
    expect(r.counts).toEqual({ created: 0, updated: 0, unchanged: 3, keptYours: 0, accountsCreated: 0, accountsMatched: 0, accountsUpdated: 0, accountsUnchanged: 2 });
    const after = JSON.stringify({ m: db.rowsOf("research_markets"), s: db.rowsOf("research_sectors").map((x: any) => ({ ...x, updatedAt: 0 })), v: db.rowsOf("research_revisions").length, a: db.rowsOf("accounts").length, p: db.rowsOf("personas").length });
    expect(JSON.parse(after)).toEqual(JSON.parse(before));
  });

  it("a newer revision updates; a record edited here is kept unless the person chooses Downstream's", async () => {
    const p = await caller(4).research.downstream.preview({ fileText: exportFile() });
    await commit(4, p.token, { assign: true });
    const sectorId = h.db.rowsOf("research_sectors")[0].id;

    // A newer export: the sector's summary changed.
    const newer = exportFile((f) => { f.segments[0].revision = 3; f.segments[0].summary = "Updated research"; });
    let pv = await caller(4).research.downstream.preview({ fileText: newer });
    expect(pv.segments.find((s) => s.ref === K12)!.state).toBe("updated");

    // ...but someone edits the sector here first.
    await caller(4).research.sectors.update({ id: sectorId, expectedRevision: 1, content: { ...h.db.rowsOf("research_sectors")[0], summary: "Our own notes" } });
    pv = await caller(4).research.downstream.preview({ fileText: newer });
    expect(pv.segments.find((s) => s.ref === K12)!.state).toBe("conflict");
    let r = await commit(4, pv.token);
    expect(r.counts.keptYours).toBe(1);
    expect(h.db.rowsOf("research_sectors")[0].summary).toBe("Our own notes");

    pv = await caller(4).research.downstream.preview({ fileText: newer });
    r = await commit(4, pv.token, { takeDownstream: [K12] });
    expect(r.counts.updated).toBeGreaterThanOrEqual(1);
    const s = h.db.rowsOf("research_sectors")[0];
    expect(s.summary).toBe("Updated research");
    const history = await caller(4).research.revisions.list({ entityType: "sector", entityId: sectorId });
    expect(history.map((x) => x.note)).toEqual(["Downstream import (revision 3)", "Edited", "Imported from Downstream (revision 2)"]);
  });

  it("a changed award updates the same account, not a new one", async () => {
    await commit(4, (await caller(4).research.downstream.preview({ fileText: exportFile() })).token, { assign: true });
    const changed = exportFile((f) => { f.organizations[0].award.amount = "$750,000"; });
    const r = await commit(4, (await caller(4).research.downstream.preview({ fileText: changed })).token);
    expect(r.counts).toMatchObject({ accountsCreated: 0, accountsMatched: 0, accountsUpdated: 1, accountsUnchanged: 1 });
    expect(h.db.rowsOf("accounts")[0].customFields.downstreamAward.amount).toBe("$750,000");
    expect(h.db.rowsOf("accounts")[0].customFields.intentTopics).toEqual(["INSPIRE"]);
  });

  it("re-importing an unchanged file does not pass an edit made here off as Downstream's", async () => {
    const p = await caller(4).research.downstream.preview({ fileText: exportFile() });
    await commit(4, p.token, { assign: true });
    const s = h.db.rowsOf("research_sectors")[0];
    await caller(4).research.sectors.update({ id: s.id, expectedRevision: 1, content: { ...s, summary: "Our own notes" } });
    await commit(4, (await caller(4).research.downstream.preview({ fileText: exportFile() })).token);
    const newer = exportFile((f) => { f.segments[0].revision = 3; f.segments[0].summary = "Updated research"; });
    const pv = await caller(4).research.downstream.preview({ fileText: newer });
    expect(pv.segments.find((x) => x.ref === K12)!.state).toBe("conflict");
    await commit(4, pv.token);
    expect(h.db.rowsOf("research_sectors")[0].summary).toBe("Our own notes");
  });

  it("statistics refresh on their own; a market edited here stays a conflict until someone chooses", async () => {
    const p = await caller(4).research.downstream.preview({ fileText: exportFile() });
    await commit(4, p.token, { assign: true });
    const m = h.db.rowsOf("research_markets")[0];
    await caller(4).research.markets.update({ id: m.id, expectedRevision: 1, content: { ...m, overview: { ...m.overview, headline: "Our own headline" } } });

    // Only the statistics changed: they are Downstream's alone, so no conflict.
    const statsOnly = exportFile((f) => { f.marketStats.organizations = 99999; });
    let pv = await caller(4).research.downstream.preview({ fileText: statsOnly });
    expect(pv.market.state).toBe("unchanged");
    await commit(4, pv.token);
    expect(h.db.rowsOf("research_markets")[0]).toMatchObject({ overview: { headline: "Our own headline" }, revision: 2 });
    expect(h.db.rowsOf("research_markets")[0].extras.stats.organizations).toBe(99999);

    // The overview changed in Downstream too: kept, and still a conflict next time.
    const both = exportFile((f) => { f.marketStats.organizations = 99999; f.knowledge.overview.headline = "Downstream's new headline"; });
    pv = await caller(4).research.downstream.preview({ fileText: both });
    expect(pv.market.state).toBe("conflict");
    expect((await commit(4, pv.token)).counts.keptYours).toBe(1);
    pv = await caller(4).research.downstream.preview({ fileText: both });
    expect(pv.market.state).toBe("conflict");
    await commit(4, pv.token, { takeDownstream: ["regional-authorities"] });
    expect(h.db.rowsOf("research_markets")[0].overview.headline).toBe("Downstream's new headline");
    expect((await caller(4).research.downstream.preview({ fileText: both })).market.state).toBe("unchanged");
  });

  it("an organization that is already an account is matched, never duplicated, and only in its own workspace", async () => {
    await h.db.insert(accounts).values([
      // LSI Media's comes first, so a match that ignored the workspace would find it.
      { workspaceId: 2, name: "Angelic Ministries", normalizedName: "angelic ministries", domain: "angelicministries.org", normalizedDomain: "angelicministries.org", customFields: {} },
      { workspaceId: 4, name: "Angelic Ministries Inc", normalizedName: "angelic ministries", domain: "angelicministries.org", normalizedDomain: "angelicministries.org", customFields: { owner: "kept" }, sourceType: "prospect_import", createdAt: new Date("2026-09-01") },
    ]);
    const p = await caller(4).research.downstream.preview({ fileText: exportFile() });
    const r = await commit(4, p.token, { assign: true });
    expect(r.counts).toMatchObject({ accountsMatched: 1, accountsCreated: 1 });
    const [lsi, cf] = h.db.rowsOf("accounts");
    expect(cf.name).toBe("Angelic Ministries Inc");
    expect(cf.customFields).toMatchObject({ owner: "kept", downstreamRef: "regional-authorities/prospects/33b98f6ab880" });
    // A company that already existed keeps its own source, and gains its research sector.
    expect(cf).toMatchObject({ sourceType: "prospect_import", researchSectorId: h.db.rowsOf("research_sectors")[0].id });
    expect(lsi.customFields).toEqual({});
    expect(h.db.rowsOf("accounts").filter((a: any) => a.workspaceId === 4)).toHaveLength(2);
  });

  it("a market export, or a seller export the company does not claim, stores no seller layer", async () => {
    let p = await caller(4).research.downstream.preview({ fileText: exportFile((f) => { f.audience = "market"; }) });
    await commit(4, p.token, { assign: true, useSellerMessaging: true });
    expect(h.db.rowsOf("research_sectors")[0].messaging.leadWith).toEqual([]);
    expect(h.db.rowsOf("accounts")[0].customFields.downstreamFit).toBeUndefined();
    expect(h.db.rowsOf("research_markets")[0].extras.stats).not.toHaveProperty("tiers");

    h.db = makeSqlFakeDb({ roles: { 4: "admin" }, wsId: () => h.wsId });
    p = await caller(4).research.downstream.preview({ fileText: exportFile() });
    await commit(4, p.token, { assign: true, useSellerMessaging: false });
    expect(h.db.rowsOf("research_sectors")[0].messaging.leadWith).toEqual([]);
    expect(h.db.rowsOf("downstream_links")[0].useSellerMessaging).toBe(false);
  });

  it("only admins import; a paused link imports nothing and its research is not used", async () => {
    await expect(caller(7).research.downstream.preview({ fileText: exportFile() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const p = await caller(4).research.downstream.preview({ fileText: exportFile() });
    await commit(4, p.token, { assign: true });
    __clearResearchContextCache();
    expect((await researchContextFor(4, { surface: "outreach", prospectTitle: "Superintendent" })).sectorId).toBe(h.db.rowsOf("research_sectors")[0].id);

    const linkId = h.db.rowsOf("downstream_links")[0].id;
    await caller(4).research.downstream.setStatus({ id: linkId, status: "paused" });
    expect((await researchContextFor(4, { surface: "outreach", prospectTitle: "Superintendent" })).block).toBe("");
    const p2 = await caller(4).research.downstream.preview({ fileText: exportFile() });
    await expect(commit(4, p2.token)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller(2).research.downstream.setStatus({ id: linkId, status: "active" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("every award a company has (2026-10-16)", () => {
  const award = (year: string, stage: string, amount = "$100,000") => ({ funder: "ARC", program: "POWER", project: `Project ${year}`, amount, year: `FY${year}`, stage, sourceUrl: "https://arc.gov/x" }) as any;

  it("the copy leads with a live award: ending soon, then active, then the most recent and largest", () => {
    const ended25 = { ...award("2025", "ended"), ref: "a" };
    const active24 = { ...award("2024", "active"), ref: "b" };
    const ending23 = { ...award("2023", "ends-within-6-months"), ref: "c" };
    expect(mostRelevantAward([ended25, active24, ending23])?.ref).toBe("c");
    expect(mostRelevantAward([ended25, active24])?.ref).toBe("b");
    expect(mostRelevantAward([{ ...award("2022", "ended"), ref: "d" }, ended25])?.ref).toBe("a");
    expect(mostRelevantAward([{ ...award("2025", "ended", "$5,000"), ref: "e" }, { ...ended25, amount: "$900,000" }])?.ref).toBe("a");
    expect(mostRelevantAward([])).toBeNull();
  });

  it("an award joins the list once per Downstream row, replacing that row's old one, newest first", () => {
    let list = withAward(undefined, "r1", award("2023", "ended"));
    list = withAward(list, "r2", award("2025", "active"));
    list = withAward(list, "r1", award("2024", "ended")); // r1 changed
    expect(list.map((a) => [a.ref, a.year])).toEqual([["r2", "FY2025"], ["r1", "FY2024"]]);
    expect(withAward([{ junk: true }, null], "r3", null)).toEqual([]);
  });

  /** Angelic Ministries three times, as Downstream lists it: one row per award. */
  const threeAwards = () => exportFile((f) => {
    const base = f.organizations[0];
    f.organizations.push(
      { ...JSON.parse(JSON.stringify(base)), ref: "regional-authorities/prospects/am-2025", award: { ...base.award, year: "FY2025", stage: "active", project: "Food pantry" } },
      { ...JSON.parse(JSON.stringify(base)), ref: "regional-authorities/prospects/am-2024", award: { ...base.award, year: "FY2024", stage: "ends-within-6-months", project: "Housing" } },
    );
  });

  it("several rows of one organization make one company that keeps every award", async () => {
    const p = await caller(4).research.downstream.preview({ fileText: threeAwards() });
    await commit(4, p.token, { assign: true });
    const am = h.db.rowsOf("accounts").filter((a: any) => a.normalizedDomain === "angelicministries.org");
    expect(am).toHaveLength(1);
    expect(am[0].customFields.downstreamAwards.map((a: any) => a.year)).toEqual(["FY2025", "FY2024", "FY2023"]);
    expect(am[0].customFields.downstreamAward).toMatchObject({ year: "FY2024", stage: "ends-within-6-months", ref: "regional-authorities/prospects/am-2024" });
    const facts = await downstreamAccountFor(4, { companyDomain: "angelicministries.org" });
    expect(facts?.award?.project).toBe("Housing");
  });

  it("companies imported with one award get the rest from re-importing the file, once; after that nothing changes", async () => {
    let p = await caller(4).research.downstream.preview({ fileText: threeAwards() });
    await commit(4, p.token, { assign: true });
    // As an import before 2026-10-16 left it: only the last row's award.
    const am = h.db.rowsOf("accounts").find((a: any) => a.normalizedDomain === "angelicministries.org");
    am.customFields = { ...am.customFields, downstreamAward: am.customFields.downstreamAwards[0] };
    delete am.customFields.downstreamAwards;
    p = await caller(4).research.downstream.preview({ fileText: threeAwards() });
    const r = await commit(4, p.token);
    expect(r.counts.accountsUnchanged).toBe(4);
    expect(am.customFields.downstreamAwards.map((a: any) => a.year)).toEqual(["FY2025", "FY2024", "FY2023"]);
    expect(am.customFields.downstreamAward.year).toBe("FY2024");
    const snapshot = JSON.stringify(h.db.rowsOf("accounts").map((a: any) => a.customFields));
    p = await caller(4).research.downstream.preview({ fileText: threeAwards() });
    await commit(4, p.token);
    expect(JSON.stringify(h.db.rowsOf("accounts").map((a: any) => a.customFields))).toBe(snapshot);
  });
});

describe("the award reaches the copy", () => {
  it("a prospect at an imported organization gets the award as its first, sourced hook", async () => {
    const p = await caller(4).research.downstream.preview({ fileText: exportFile() });
    await commit(4, p.token, { assign: true });
    const facts = await downstreamAccountFor(4, { companyDomain: "angelicministries.org", companyName: "Angelic Ministries" });
    expect(facts?.award?.program).toBe("INSPIRE");
    expect(await downstreamAccountFor(2, { companyDomain: "angelicministries.org" })).toBeNull();

    const agent = read("server/routers/are/prospects.ts");
    expect(agent).toContain("const dsAccount = await downstreamAccountFor(workspaceId, { companyDomain: prospect.companyDomain, companyName: prospect.companyName });");
    expect(agent).toContain('[{ hook: award.hook, source: award.sourceUrl || "Downstream", verifiedAt: new Date().toISOString(), hookType: "award" }, ...intelArray(enrichData.personalisationHooks)]');
    expect(agent).toMatch(/triggerEvents,\n\s+painSignals: enrichData\.painSignals,\n\s+personalisationHooks,/);
    // primaryHookOf takes the first hook, so the copy leads with the award.
    expect(agent).toContain("if (hooks[0]?.hook) return { hook: hooks[0].hook, hookType: hooks[0].hookType || \"personalisation\" };");
  });

  it("the seller's 'financial distress' flag keeps an organization from being contacted now", async () => {
    const p = await caller(4).research.downstream.preview({ fileText: exportFile() });
    await commit(4, p.token, { assign: true });
    const facts = await downstreamAccountFor(4, { companyDomain: "strugglingschools.org" });
    expect(facts?.fit?.flags).toEqual(["financial-distress"]);
    const engine = read("server/areEngine.ts");
    expect(engine).toContain('if (ds?.fit?.flags?.includes("financial-distress")) {');
    expect(engine).toContain('rejectionReason: "Downstream: the organization is in financial distress — do not contact now"');
  });
});
