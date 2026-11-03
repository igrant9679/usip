/**
 * A campaign's stored source list has one reading, and everything shows it.
 *
 *   an explicit empty list is "no discovery", a null or dead-ids-only list is the
 *   defaults · the Sources tab, Source Health and the engine agree on every shape
 *   · a campaign with discovery off shows no box ticked, so changing one box
 *   cannot switch on the rest · a campaign with no source says so, before and
 *   after saving · the optimizer can't turn a list into every default, and its
 *   revert can't switch discovery back on.
 *
 * Everything runs against the real router, engine and rendered card. Every source
 * but `internal` is masked at workspace level, so nothing here calls a vendor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { runDiscovery, __resetEngineLogRepeatsForTests } from "./areEngine";
import { APPLY_HANDLERS } from "./services/optimization/apply";
import { ARE_DEFAULT_SOURCES, ARE_OPT_IN_SOURCES, ARE_SOURCES, DISCOVERY_OFF_NOTE, campaignSources, discoveryIsOff, toggledSources } from "@shared/areSources";
import { CampaignSourcesCard } from "../client/src/components/usip/are/CampaignSourcesCard";

const WS = 2;
const CAMPAIGN = 7;
const OFF_WORDS = "Discovery is off for this campaign";
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = () => rows("are_campaigns").find((c) => c.id === CAMPAIGN);
const queued = () => rows("prospect_queue").filter((p) => p.campaignId === CAMPAIGN);
const skipped = () => rows("are_engine_logs").some((l) => /Discovery skipped — no usable sources/.test(l.message));
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

/** The card as the page renders it. */
function card(stored: unknown, draft: string[] | null = null) {
  const html = renderToStaticMarkup(createElement(CampaignSourcesCard, { stored, draft, onChange: () => {} }));
  const boxes = html.match(/<button[^>]*role="checkbox"[^>]*>/g) ?? [];
  expect(boxes).toHaveLength(ARE_SOURCES.length);
  return { html, ticked: ARE_SOURCES.map((s) => s.id).filter((_, i) => /aria-checked="true"/.test(boxes[i]!)) };
}
/** The order the card lists them in, for comparing with a stored list. */
const inCardOrder = (ids: readonly string[]) => ARE_SOURCES.map((s) => s.id).filter((id) => ids.includes(id));

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  __resetEngineLogRepeatsForTests();
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("workspace_settings").push({ workspaceId: WS, areSourceOrder: null, icpFallback: null, areScraperSources: { quickenrich: false, warmysender: false, linkedin: false, apollo: false, google_business: false, news: false, leadocean: false } });
  rows("are_campaigns").push({
    id: CAMPAIGN, workspaceId: WS, name: "Counties", status: "active", targetProspectCount: 10, prospectSources: [],
    icpOverrides: { targetTitles: ["County Administrator"] }, discoveryQueryState: null, researchSectorId: null, researchPersonaId: null,
  });
  // Someone in the CRM who matches the targeting: the person discovery would pull in.
  rows("leads").push({ id: 60, workspaceId: WS, firstName: "Sam", lastName: "Stranger", email: "sam@example.com", title: "County Administrator", company: "Acme", status: "new", createdAt: new Date(), updatedAt: new Date() });
});

/* ── The reading ─────────────────────────────────────────────────────────── */

describe("the one reading of a stored list", () => {
  it.each([
    ["an explicit empty list is no discovery", [], []],
    ["null, the legacy shape, is the defaults", null, ARE_DEFAULT_SOURCES],
    ["undefined is the defaults", undefined, ARE_DEFAULT_SOURCES],
    ["dead ids alone are the defaults", ["web", "ai_research"], ARE_DEFAULT_SOURCES],
    ["something that is not a list is the defaults", "internal", ARE_DEFAULT_SOURCES],
    ["dead ids are dropped from a live list", ["web", "news"], ["news"]],
    ["a list is kept as it is", ["internal", "news"], ["internal", "news"]],
    ["an opt-in source counts once ticked", ["leadocean"], ["leadocean"]],
  ])("%s", (_name, stored, want) => {
    expect(campaignSources(stored)).toEqual(want);
  });

  it("only an empty list is off", () => {
    expect(discoveryIsOff([])).toBe(true);
    for (const on of [null, undefined, "", ["web"], ["news"], {}]) expect(discoveryIsOff(on)).toBe(false);
  });

  it("the defaults never include a source that bills its previews", () => {
    for (const id of ARE_OPT_IN_SOURCES) expect(campaignSources(null)).not.toContain(id);
  });

  it("hands back its own copy, so a caller can't change the defaults", () => {
    const first = campaignSources(null);
    expect(first).not.toBe(ARE_DEFAULT_SOURCES);
    expect(first).toEqual(ARE_DEFAULT_SOURCES);
  });

  it("a box changes that one source and nothing else", () => {
    expect(toggledSources([], "news")).toEqual(["news"]);
    expect(toggledSources(["news"], "news")).toEqual([]);
    expect(toggledSources(["internal", "news"], "news")).toEqual(["internal"]);
    expect(toggledSources(["internal"], "news")).toEqual(["internal", "news"]);
  });
});

/* ── Everyone agrees ─────────────────────────────────────────────────────── */

describe("the tab, Source Health and the engine agree", () => {
  it.each([
    // stored, boxes ticked, discovery off, finds the matching person (only `internal` is unmasked).
    ["[]", [], [], true, false],
    ["null", null, ARE_DEFAULT_SOURCES, false, true],
    ["dead ids alone", ["web"], ARE_DEFAULT_SOURCES, false, true],
    ["internal", ["internal"], ["internal"], false, true],
    ["a dead id and internal", ["web", "internal"], ["internal"], false, true],
    ["a source the workspace disabled", ["news"], ["news"], false, false],
  ])("%s", async (_name, stored, boxes, off, finds) => {
    row().prospectSources = stored;

    expect(card(stored).ticked).toEqual(inCardOrder(boxes as string[]));
    expect(card(stored).html.includes(OFF_WORDS)).toBe(off);

    const health = await caller().are.campaigns.sourceHealth({ campaignId: CAMPAIGN });
    expect(health.sources.filter((s) => s.selectedOnCampaign).map((s) => s.slug)).toEqual(inCardOrder(boxes as string[]));
    expect(health.discovery.explicitlyNone).toBe(off);

    await runDiscovery(row(), 5);
    expect(queued().map((p) => p.email)).toEqual(finds ? ["sam@example.com"] : []);
    expect(skipped()).toBe(!finds);
  });
});

/* ── The path that pulled strangers in ───────────────────────────────────── */

describe("a campaign with discovery off stays off until someone turns it on", () => {
  it("an accepted proposal shows no box ticked, so there is nothing to untick", () => {
    expect(card([]).ticked).toEqual([]);
  });

  it("ticking one source saves that one, not every default beside it", async () => {
    const draft = toggledSources(campaignSources(row().prospectSources), "news");
    expect(card(row().prospectSources, draft).ticked).toEqual(["news"]);
    await caller().are.campaigns.update({ id: CAMPAIGN, prospectSources: draft });
    expect(row().prospectSources).toEqual(["news"]);
    // News is masked here, so this campaign still finds nobody.
    await runDiscovery(row(), 5);
    expect(queued()).toEqual([]);
  });

  it("clearing every box, saving and coming back still reads as off, and still says so", async () => {
    row().prospectSources = ["internal", "news"];
    const cleared = toggledSources(toggledSources(campaignSources(row().prospectSources), "internal"), "news");
    expect(cleared).toEqual([]);
    expect(card(row().prospectSources, cleared).html).toContain(OFF_WORDS);

    await caller().are.campaigns.update({ id: CAMPAIGN, prospectSources: cleared });
    const back = await caller().are.campaigns.get({ id: CAMPAIGN });
    expect(back.prospectSources).toEqual([]);
    expect(card(back.prospectSources).ticked).toEqual([]);
    expect(card(back.prospectSources).html).toContain(OFF_WORDS);

    await runDiscovery(row(), 5);
    expect(queued()).toEqual([]);
  });

  it("a draft speaks over what is stored, either way", () => {
    expect(card(["internal"], []).html).toContain(OFF_WORDS);
    expect(card(["internal"], []).ticked).toEqual([]);
    expect(card([], ["internal"]).html).not.toContain(OFF_WORDS);
    expect(card([], ["internal"]).ticked).toEqual(["internal"]);
  });

  it("a campaign with sources says nothing about being off", () => {
    expect(card(["internal"]).html).not.toContain(OFF_WORDS);
    expect(card(null).html).not.toContain(OFF_WORDS);
  });
});

/* ── The words ───────────────────────────────────────────────────────────── */

describe("what a campaign with no source says", () => {
  it("says what the engine does, and how to change it", () => {
    expect(DISCOVERY_OFF_NOTE).toContain(OFF_WORDS);
    expect(DISCOVERY_OFF_NOTE).toContain("won't look for anyone new");
    expect(DISCOVERY_OFF_NOTE).toContain("Tick a source to turn discovery on.");
  });

  it("the claim that nothing selected runs every source is gone", () => {
    for (const file of ["client/src/pages/usip/ARECampaignDetail.tsx", "client/src/components/usip/are/CampaignSourcesCard.tsx"]) {
      expect(read(file), file).not.toContain("does not mean off");
      expect(read(file), file).not.toContain("falls back to running");
    }
  });

  it("says when discovery really runs, which is below the target and not when a queue drains (A15)", () => {
    expect(card(["internal"]).html).toContain("Discovery runs on every engine tick while this campaign has fewer working prospects than its target");
    expect(card(["internal"]).html).not.toContain("drains");
    // The engine's own condition, so the sentence can't outlive it unnoticed.
    expect(read("server/areEngine.ts")).toContain("if (working < campaign.targetProspectCount) {");
  });

  it("the new-campaign wizard says it too, on the step and on the review", () => {
    const src = read("client/src/pages/usip/ARECampaigns.tsx");
    expect(src).toContain("{form.prospectSources.length === 0 && (");
    expect(src).toContain("{DISCOVERY_OFF_NOTE}</p>");
    expect(src).toContain("none, so discovery is off");
    expect(src).toContain("toggledSources(f.prospectSources, id)");
  });

  it("the page uses the card, and keeps no reading of its own", () => {
    const src = read("client/src/pages/usip/ARECampaignDetail.tsx");
    expect(src).toContain("<CampaignSourcesCard stored={(campaign as any)?.prospectSources} draft={sourcesDraft} onChange={setSourcesDraft} />");
    expect(src).not.toContain("normalizeSources");
    expect(src).not.toContain("ARE_DEFAULT_SOURCES");
    // The Save button still sends what was picked, an empty list included.
    expect(src).toContain("...(sourcesDraft !== null ? { prospectSources: sourcesDraft } : {}),");
  });

  it("the server keeps no second copy of the rule", () => {
    for (const file of ["server/areEngine.ts", "server/routers/are/campaigns.ts"]) {
      expect(read(file), file).not.toContain("explicitlyNone ? []");
      expect(read(file), file).toContain("campaignSources(campaign.prospectSources)");
    }
  });
});

/* ── The optimizer ───────────────────────────────────────────────────────── */

describe("the optimizer's source change respects the reading", () => {
  const handler = APPLY_HANDLERS.deprioritise_unproductive_source!;
  const rec = (source = "news", extra: Record<string, unknown> = {}) => ({ id: 1, scopeLabel: source, proposedValue: {}, ...extra }) as any;

  it("drops a source from a campaign with others left, and records it", async () => {
    row().prospectSources = ["news", "apollo"];
    rows("optimization_recommendations").push({ id: 1, workspaceId: WS });
    const out = await handler.apply(WS, rec());
    expect(out.ok).toBe(true);
    expect(row().prospectSources).toEqual(["apollo"]);
    expect(rows("optimization_recommendations")[0].resultDelta).toEqual({ revertTargets: [CAMPAIGN], source: "news" });
  });

  it.each([
    ["its only source", ["news"]],
    ["its last live source, which would leave dead ids that read as every default", ["web", "news"]],
  ])("leaves %s", async (_name, list) => {
    row().prospectSources = list;
    const out = await handler.apply(WS, rec());
    expect(out).toMatchObject({ ok: true, detail: expect.stringContaining("No campaign needed changing") });
    expect(row().prospectSources).toEqual(list);
  });

  it("can drop a dead id while a live one remains", async () => {
    row().prospectSources = ["web", "news"];
    rows("optimization_recommendations").push({ id: 1, workspaceId: WS });
    await handler.apply(WS, rec("web"));
    expect(row().prospectSources).toEqual(["news"]);
  });

  it.each([["off", []], ["on the defaults", null]])("does not touch a campaign %s", async (_name, stored) => {
    row().prospectSources = stored;
    await handler.apply(WS, rec());
    expect(row().prospectSources).toEqual(stored);
  });

  it("revert puts the source back", async () => {
    row().prospectSources = ["apollo"];
    const out = await handler.revert(WS, rec("news", { resultDelta: { revertTargets: [CAMPAIGN], source: "news" } }));
    expect(row().prospectSources).toEqual(["apollo", "news"]);
    expect(out.detail).toContain("to 1 campaign(s)");
  });

  it.each([["turned off", []], ["back on the defaults", null]])("revert leaves a campaign since %s alone", async (_name, stored) => {
    row().prospectSources = stored;
    const out = await handler.revert(WS, rec("news", { resultDelta: { revertTargets: [CAMPAIGN], source: "news" } }));
    expect(row().prospectSources).toEqual(stored);
    expect(out.detail).toContain("to 0 campaign(s)");
  });
});
