/**
 * Campaign proposals (owner ask 2026-09-04): "suggest new Sequences to be
 * created based on analysis of the People" — and the explainer that says
 * which of the three "sequences" is which.
 *
 * The clustering and the deterministic draft are pure and tested EXECUTED;
 * the plumbing (dial, cron, hub, attention, migration, explainer mounts) is
 * pinned as text.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MIN_CLUSTER_SIZE, clusterKeyOf, clusterPeople, fallbackDraft, titleFamily, topValues, type ClusterPerson,
} from "./services/campaignProposals";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");
const client = (...p: string[]) => read("..", "client", "src", ...p);

const person = (id: number, extra: Partial<ClusterPerson> = {}): ClusterPerson => ({
  id, title: null, seniority: null, functionalArea: null, industry: null, country: null, company: null, ...extra,
});

describe("titleFamily — coarse on purpose, so an audience can form", () => {
  it("puts the grants titles that vary by org into one family", () => {
    for (const t of ["Director of Grants", "Grants Manager", "Sponsored Programs Officer", "Awards Administrator"]) expect(titleFamily(t)).toBe("grants");
  });
  it("first matching rule wins, and falls back to the functional area", () => {
    expect(titleFamily("CFO")).toBe("finance");
    expect(titleFamily("Executive Director")).toBe("executive");
    expect(titleFamily("Widget Wrangler", "Marketing")).toBe("marketing");
    expect(titleFamily("Widget Wrangler", "Basket weaving")).toBe("basket weaving");
    expect(titleFamily(null, null)).toBeNull();
  });
});

describe("clusterPeople — audiences big enough to be a campaign", () => {
  const grants = (id: number) => person(id, { title: "Grants Manager", industry: "Non-profit", country: "United States" });
  const finance = (id: number) => person(id, { title: "CFO", industry: "Non-profit", country: "United States" });
  it("groups by industry × title family × country, drops small groups, largest first", () => {
    const rows = [...Array.from({ length: 10 }, (_, i) => grants(i + 1)), ...Array.from({ length: 8 }, (_, i) => finance(100 + i)), person(500, { title: "CFO", industry: "Banking", country: "Canada" })];
    const out = clusterPeople(rows);
    expect(out.map((c) => [c.key, c.people.length])).toEqual([["non-profit|grants|united states", 10], ["non-profit|finance|united states", 8]]);
    expect(out[0].industry).toBe("non-profit");
    expect(out[0].family).toBe("grants");
    expect(out[0].country).toBe("united states");
  });
  it("respects the minimum size and never clusters people with no signal at all", () => {
    expect(MIN_CLUSTER_SIZE).toBe(8);
    expect(clusterPeople(Array.from({ length: 7 }, (_, i) => grants(i)))).toEqual([]);
    expect(clusterPeople(Array.from({ length: 20 }, (_, i) => person(i)))).toEqual([]);
    expect(clusterKeyOf(person(1))).toBe("-|-|-");
  });
  it("is case- and whitespace-insensitive on the key", () => {
    expect(clusterKeyOf(person(1, { title: "grants  MANAGER", industry: " Non-Profit ", country: "united STATES" })))
      .toBe("non-profit|grants|united states");
  });
});

describe("the deterministic draft — what a proposal is when the model is unavailable", () => {
  it("names the audience, targets its top titles, and says how many people", () => {
    const people = [
      ...Array.from({ length: 6 }, (_, i) => person(i, { title: "Grants Manager", industry: "Non-profit", country: "United States" })),
      ...Array.from({ length: 3 }, (_, i) => person(10 + i, { title: "Director of Grants", industry: "Non-profit", country: "United States" })),
    ];
    const [c] = clusterPeople(people);
    const d = fallbackDraft(c);
    expect(d.name).toBe("Grants leaders in Non-Profit (United States)");
    expect(d.targeting.targetTitles).toEqual(["Grants Manager", "Director of Grants"]);
    expect(d.targeting.targetIndustries).toEqual(["Non-Profit"]);
    expect(d.targeting.targetGeographies).toEqual(["United States"]);
    expect(d.copyMode).toBe("per_person");
    expect(d.usedModel).toBe(false);
    expect(d.description).toContain("9 people");
  });
  it("topValues counts case-insensitively and keeps the first spelling", () => {
    expect(topValues([person(1, { title: "CFO" }), person(2, { title: "cfo" }), person(3, { title: "COO" })], (p) => p.title))
      .toEqual([{ value: "CFO", count: 2 }, { value: "COO", count: 1 }]);
  });
});

describe("the plumbing", () => {
  const svc = read("services", "campaignProposals.ts");
  it("unplaced = the ROUTER's own verdict, not a second scorer — and never a tiebreak model call", () => {
    expect(svc).toContain('import { routeProspects } from "./campaignRouter"');
    expect(svc).toContain("const picks = await routeProspects(workspaceId, candidates.map((c) => c.id), { deterministicOnly: true });");
    // The router honours the flag: a close call takes its provisional leader.
    const router = read("services", "campaignRouter.ts");
    expect(router).toContain("opts: { deterministicOnly?: boolean } = {},");
    expect(router).toContain("if (!needsTiebreak || opts.deterministicOnly) {");
  });
  it("a failed model draft says so ON the proposal, and a pending one can be redrafted", () => {
    expect(svc).toContain("Model draft unavailable: ${msg}");
    expect(svc).toContain("export async function redraftProposal(");
    expect(read("routers", "are", "campaigns.ts")).toContain("redraftProposal: adminWsProcedure");
    expect(client("components", "usip", "CampaignProposals.tsx")).toContain("trpc.are.campaigns.redraftProposal.useMutation");
    expect(svc).toContain('p.campaignId == null && !/^Already in|^In the sequence/.test(p.skipReason ?? "")');
  });
  it("accept creates the campaign ACTIVE with batch approval, no discovery, and pushes through the one write path", () => {
    const fn = svc.slice(svc.indexOf("export async function acceptProposal"), svc.indexOf("export async function dismissProposal"));
    expect(fn).toContain('autonomyMode: "batch_approval"');
    expect(fn).toContain("prospectSources: []");
    expect(fn).toContain('status: "active"');
    expect(fn).toContain('await import("./are/pushPeople")');
    expect(fn).toContain("pushPeopleIntoCampaign(workspaceId, campaignId, ids.slice(i, i + 100), { generateSequence: true })");
  });
  it("runs under the Campaign Routing dial, skips archived workspaces, and only auto-creates its own sweep proposals", () => {
    expect(svc).toContain('ne(workspaceSettings.campaignRoutingMode, "off")');
    expect(svc).toContain("archivedWs.has(ws.workspaceId)");
    expect(svc).toContain('if (ws.campaignRoutingMode === "auto")');
    expect(svc).toContain('if (p.source !== "sweep") continue;');
  });
  it("dismissed people cool down, pending people are not re-proposed, the queue holds three", () => {
    expect(svc).toContain("export const DISMISS_COOLDOWN_DAYS = 30;");
    expect(svc).toContain("export const MAX_PENDING_PROPOSALS = 3;");
    expect(svc).toContain("const unplaced = await findUnplacedPeople(workspaceId, covered);");
    expect(svc).toContain("filter((c) => !pendingKeys.has(c.key))");
  });
  it("schema + migration 0178", () => {
    expect(read("..", "drizzle", "schema.ts")).toContain('export const campaignProposals = mysqlTable(\n  "campaign_proposals"');
    const m = read("_core", "rawMigrations.ts");
    expect(m).toContain("0178_campaign_proposals");
    expect(m).toContain("CREATE TABLE IF NOT EXISTS `campaign_proposals`");
  });
  it("procedures, cron, attention, hub, Autonomy Center blurb", () => {
    const c = read("routers", "are", "campaigns.ts");
    for (const s of ["listProposals: workspaceProcedure", "decideProposal: workspaceProcedure", "generateProposals: adminWsProcedure"]) expect(c).toContain(s);
    const idx = read("_core", "index.ts");
    expect(idx).toContain('import { runCampaignProposalsAllWorkspaces } from "../services/campaignProposals"');
    expect(idx).toContain('guardOverlap("CampaignProposals"');
    expect(idx).toContain("setInterval(runProposals, 60 * 60 * 1000)");
    const att = read("routers", "attention.ts");
    expect(att).toContain("campaignProposals.count");
    expect(att).toContain("routingSuggestions.count + campaignProposals.count");
    expect(client("components", "usip", "AttentionPanel.tsx")).toContain("s.campaignProposals");
    expect(client("pages", "usip", "AREHub.tsx")).toContain("<CampaignProposals />");
    const comp = client("components", "usip", "CampaignProposals.tsx");
    expect(comp).toContain("trpc.are.campaigns.decideProposal.useMutation");
    expect(comp).toContain("trpc.are.campaigns.generateProposals.useMutation");
    expect(client("pages", "usip", "WorkflowsV2.tsx")).toContain("propose new campaigns for the ones nothing fits");
  });
});

describe("the explainer — one component on all three surfaces", () => {
  it("is mounted on the Sequences page, the campaigns list and the campaign's Sequences tab, each marked as current", () => {
    expect(client("pages", "usip", "SequencesV2.tsx")).toContain('<OutreachExplainer current="sequences" />');
    expect(client("pages", "usip", "ARECampaigns.tsx")).toContain('<OutreachExplainer current="campaigns" />');
    expect(client("pages", "usip", "ARECampaignDetail.tsx")).toContain('<OutreachExplainer current="campaign-sequences-tab" />');
  });
  it("its Learn more resolves to a seeded article, and the nav tip points there too", () => {
    const seed = read("seedHelpContent.ts");
    expect(seed).toContain('slug: "sequences-vs-campaigns"');
    expect(seed).toContain('pageKey: "sequences"');
    expect(client("components", "usip", "OutreachExplainer.tsx")).toContain('href="/help/sequences-vs-campaigns"');
    expect(client("lib", "helpText.ts")).toContain('article: "sequences-vs-campaigns"');
  });
});
