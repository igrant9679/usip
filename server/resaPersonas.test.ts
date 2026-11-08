/**
 * Personas, the audit's final pass (2026-11-07, batch RESA, U18): search and
 * filters, "used by N campaigns", a research-completeness badge that follows
 * the writers' own rule, and "Start a campaign from this persona", which makes
 * a DRAFT campaign and never an active one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, wsId: 2, engineRuns: 0 }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
// A launch would kick the engine; a draft must not.
vi.mock("./areEngine", async (a) => ({ ...(await a<typeof import("./areEngine")>()), runAreEngine: async () => { h.engineRuns++; return {} as never; } }));

import { appRouter } from "./routers";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { personaResearchCompleteness } from "@shared/researchShape";
import { filterPersonas, isFiltering, NO_PERSONA_FILTER } from "../client/src/lib/personaFilters";
import { personaCampaignTargeting } from "../client/src/components/usip/research/StartCampaignFromPersona";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const block = (src: string, start: string, end: string) => {
  const at = src.indexOf(start);
  expect(at, `missing: ${start}`).toBeGreaterThan(-1);
  const stop = src.indexOf(end, at + start.length);
  return src.slice(at, stop === -1 ? undefined : stop + end.length);
};

function caller(wsId = 2) {
  h.wsId = wsId;
  return appRouter.createCaller({
    user: { id: 1, openId: "u1", email: "owner@example.com", name: "Owner", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(wsId) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

const persona = (id: number, over: Record<string, unknown> = {}) => {
  const row = {
    id, workspaceId: 2, name: `Persona ${id}`, description: null, targetTitles: ["Finance Director"], targetIndustries: ["Government Administration"],
    targetGeographies: ["United States"], employeeMin: null, employeeMax: null, keywords: [], categoryId: null, sectorId: null,
    cares: null, pains: [], objections: [], angle: null, isPreset: false, createdByUserId: 1, updatedAt: new Date(Date.now() - id * 1000), ...over,
  };
  rows("personas").push(row);
  return row;
};

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { 2: "rep", 4: "rep" }, wsId: () => h.wsId });
  h.engineRuns = 0;
});

describe("used by N campaigns (U18)", () => {
  it("counts this workspace's campaigns per persona, and the active ones", async () => {
    persona(1);
    persona(2);
    rows("are_campaigns").push(
      { id: 10, workspaceId: 2, name: "A", status: "active", personaId: 1 },
      { id: 11, workspaceId: 2, name: "B", status: "draft", personaId: 1 },
      { id: 12, workspaceId: 2, name: "C", status: "paused", personaId: null },
      // Another workspace's campaign naming the same id is not this persona's.
      { id: 13, workspaceId: 4, name: "D", status: "active", personaId: 2 },
    );
    const list = await caller().personas.list();
    expect(list.map((p: any) => [p.id, p.campaignCount, p.activeCampaignCount])).toEqual([[1, 2, 1], [2, 0, 0]]);
  });
});

describe("the research-completeness badge follows the writers' rule (U18)", () => {
  it("counts the four parts the writers use", () => {
    expect(personaResearchCompleteness({})).toEqual({ filled: 0, of: 4, missing: ["what they care about", "pains", "objections", "the angle"], level: "none" });
    expect(personaResearchCompleteness({ cares: "  ", pains: [" "], angle: "Show the trail" })).toMatchObject({ filled: 1, level: "partial" });
    expect(personaResearchCompleteness({ cares: "Audits", pains: ["Late funds"], objections: ["Busy"], angle: "Trail" })).toMatchObject({ filled: 4, missing: [], level: "complete" });
  });

  it("is the very rule the writers pick a persona by", () => {
    const ctx = read("server/services/research/context.ts");
    expect(ctx).toContain("const hasResearch = (p: PersonaRow) => personaResearchCompleteness(p).filled > 0;");
  });
});

describe("search and filters (U18)", () => {
  const list = [
    { id: 1, name: "Finance leads", description: "County CFOs", targetTitles: [{ title: "Chief Financial Officer", weight: 0.9 }], targetIndustries: ["Government"], keywords: ["audit"], sectorId: 5, cares: "x", pains: ["y"], objections: ["z"], angle: "a", campaignCount: 2 },
    { id: 2, name: "IT buyers", targetTitles: ["IT Director"], targetIndustries: ["Higher Education"], sectorId: null, campaignCount: 0 },
    { id: 3, name: "Grants", targetTitles: ["Grants Manager"], sectorId: 6, cares: "Compliance", campaignCount: 1 },
  ];
  const sectors = new Map([[5, "County government"], [6, "Nonprofits"]]);
  const ids = (f: any) => filterPersonas(list, { ...NO_PERSONA_FILTER, ...f }, sectors).map((p) => p.id);

  it("each word must appear somewhere: name, description, weighted titles, industries, keywords or sector", () => {
    expect(ids({ q: "chief audit" })).toEqual([1]);
    expect(ids({ q: "county" })).toEqual([1]);
    expect(ids({ q: "nonprofits" })).toEqual([3]);
    expect(ids({ q: "director education" })).toEqual([2]);
    expect(ids({ q: "nobody" })).toEqual([]);
  });

  it("filters by sector, research and use", () => {
    expect(ids({ sector: "none" })).toEqual([2]);
    expect(ids({ sector: 6 })).toEqual([3]);
    expect(ids({ research: "complete" })).toEqual([1]);
    expect(ids({ research: "partial" })).toEqual([3]);
    expect(ids({ research: "none" })).toEqual([2]);
    expect(ids({ use: "used" })).toEqual([1, 3]);
    expect(ids({ use: "unused" })).toEqual([2]);
    expect(isFiltering(NO_PERSONA_FILTER)).toBe(false);
    expect(isFiltering({ ...NO_PERSONA_FILTER, q: " " })).toBe(false);
    expect(isFiltering({ ...NO_PERSONA_FILTER, use: "used" })).toBe(true);
  });

  it("the page searches, filters, and shows each persona's badges", () => {
    const page = read("client/src/pages/usip/Personas.tsx");
    expect(page).toContain("const visible = filterPersonas(list as any[], filter, sectorName);");
    expect(page).toContain("for (const p of visible) {");
    for (const label of ['aria-label="Sector"', 'aria-label="Research"', 'aria-label="Campaigns"', 'id="persona-search"']) expect(page).toContain(label);
    const card = block(page, "const renderPersona = (p: any) => {", "\n  };");
    expect(card).toContain("personaResearchCompleteness(p)");
    expect(card).toContain('"No research: writers skip it"');
    expect(card).toContain("Used by ${used} campaign");
    expect(card).toContain("<StartCampaignFromPersona persona={p}");
  });
});

describe("Start a campaign from this persona makes a draft, never an active campaign (U18)", () => {
  it("the dialog asks for a draft", () => {
    const comp = read("client/src/components/usip/research/StartCampaignFromPersona.tsx");
    expect(comp).toContain("create.mutate({ name: name.trim(), personaId: persona.id, launch: false } as any)");
    expect(comp).not.toMatch(/launch:\s*true/);
    expect(personaCampaignTargeting({ targetTitles: [], targetIndustries: [], keywords: [] }).empty).toBe(true);
    expect(personaCampaignTargeting({ targetTitles: [{ title: "CFO", weight: 1 }] })).toMatchObject({ titles: ["CFO"], empty: false });
  });

  it("the campaign it creates is a draft with the persona's targeting, and nothing is kicked off", async () => {
    persona(1, { targetTitles: ["Finance Director"], keywords: ["audit"], employeeMin: 50 });
    const r = await caller().are.campaigns.create({ name: "Persona 1 campaign", personaId: 1, launch: false });
    expect(r).toMatchObject({ launched: false });
    const [c] = rows("are_campaigns");
    // The column's default is 'draft'; the fake leaves an unset column null.
    expect(c.status ?? "draft").toBe("draft");
    expect(c.startedAt ?? null).toBeNull();
    expect(c).toMatchObject({ personaId: 1, icpOverrides: expect.objectContaining({ targetTitles: ["Finance Director"], keywords: ["audit"], employeeMin: 50 }) });
    expect(h.engineRuns).toBe(0);
  });
});
