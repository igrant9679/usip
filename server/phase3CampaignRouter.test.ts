/**
 * Phase 3 of the seams audit (owner: "Start phase 3", 2026-09-02): the
 * best-fit campaign router. Nothing in the product evaluated a person against
 * more than one campaign before; exclusivity was a first-writer race.
 *
 * The decision rule is pure and tested EXECUTED; the plumbing is pinned.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { choosePick, MIN_FIT, CLEAR_GAP, TIEBREAK_TOP_K } from "./services/campaignRouter";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");
const client = (...p: string[]) => read("..", "client", "src", ...p);

describe("choosePick — the decision rule, executed", () => {
  const c = (campaignId: number, fit: number) => ({ campaignId, campaignName: `C${campaignId}`, fit });

  it("nothing above the floor → no pick, no model call", () => {
    const r = choosePick([c(1, MIN_FIT - 1), c(2, 0)]);
    expect(r.pick).toBeNull();
    expect(r.needsTiebreak).toBe(false);
  });

  it("one eligible campaign → take it without the model", () => {
    const r = choosePick([c(1, 60), c(2, 10)]);
    expect(r.pick?.campaignId).toBe(1);
    expect(r.needsTiebreak).toBe(false);
  });

  it("a clear leader (gap ≥ CLEAR_GAP) → take it without the model", () => {
    const r = choosePick([c(1, 40), c(2, 40 + CLEAR_GAP), c(3, 30)]);
    expect(r.pick?.campaignId).toBe(2);
    expect(r.needsTiebreak).toBe(false);
  });

  it("a close call → provisional leader, ask the model, top-k contenders only", () => {
    const r = choosePick([c(1, 50), c(2, 50 + CLEAR_GAP - 1), c(3, 45), c(4, 44), c(5, 10)]);
    expect(r.pick?.campaignId).toBe(2);
    expect(r.needsTiebreak).toBe(true);
    expect(r.contenders.map((x) => x.campaignId)).toEqual([2, 1, 3].slice(0, TIEBREAK_TOP_K));
    // The ruled-out campaign never reaches the model.
    expect(r.contenders.some((x) => x.campaignId === 5)).toBe(false);
  });

  it("exact ties resolve deterministically (lower id first) and still go to the model", () => {
    const r = choosePick([c(9, 70), c(3, 70)]);
    expect(r.pick?.campaignId).toBe(3);
    expect(r.needsTiebreak).toBe(true);
  });
});

describe("the router composes the pieces that already existed", () => {
  const router = read("services", "campaignRouter.ts");
  it("effective ICP per campaign, deterministic fit, ownership + other-engine checks, the one write path", () => {
    expect(router).toContain('import { buildEffectiveIcp, scoringTargetsOf } from "./are/effectiveIcp"');
    expect(router).toContain('import { scoreIcpMatch } from "../areEngine"');
    expect(router).toContain("activeCampaignsForProspects(workspaceId, people.map((p) => p.id))");
    expect(router).toContain("activeSequencesForProspects(workspaceId, people.map((p) => p.id))");
    expect(router).toContain('await import("./are/pushPeople")');
  });
  it("the model chooses only among the contenders it is given", () => {
    expect(router).toContain("Choose ONLY among the candidates given");
    expect(router).toContain("contenders.find((c) => c.campaignId === parsed.campaignId) ?? pick");
  });
  it("a campaign's own icpProfileId is finally read", () => {
    expect(router).toContain("pinnedById.get(c.icpProfileId)");
  });
  it("effectiveIcp is the ONE merge — prospects.ts imports it instead of keeping a copy", () => {
    const p = read("routers", "are", "prospects.ts");
    expect(p).toContain('import { buildEffectiveIcp } from "../../services/are/effectiveIcp"');
    expect(p).not.toContain("function buildEffectiveIcp(");
  });
  it("pushExisting and the router share one insert path", () => {
    const p = read("routers", "are", "prospects.ts");
    expect(p).toContain('await import("../../services/are/pushPeople")');
    expect(p).not.toContain("db.insert(prospectQueue).values({\n          workspaceId: ctx.workspace.id,\n          campaignId: input.campaignId,");
    expect(read("services", "are", "pushPeople.ts")).toContain("icpMatchScore: opts.routing?.fit ?? 0");
  });
});

describe("the dial, the triggers, and the queue", () => {
  it("Off / Approve / Auto in the Autonomy Center, included in the bulk setters", () => {
    const page = client("pages", "usip", "WorkflowsV2.tsx");
    expect(page).toContain('key: "routing", label: "Campaign Routing"');
    const setAll = page.slice(page.indexOf("const setAll = "), page.indexOf("const turnOnFullAutonomy"));
    expect(setAll).toContain("setRoutingAp.mutate({ mode: mode as any })");
    const full = page.slice(page.indexOf("const turnOnFullAutonomy"), page.indexOf("const areSettings = "));
    expect(full).toContain('setRoutingAp.mutate({ mode: "approval" as any })');
  });
  it("the cron sweep is scheduled and honors mode + daily cap", () => {
    const idx = read("_core", "index.ts");
    expect(idx).toContain('import { runCampaignRoutingAllWorkspaces } from "../services/campaignRouter"');
    expect(idx).toContain("setInterval(runRouting, 30 * 60 * 1000)");
    const router = read("services", "campaignRouter.ts");
    expect(router).toContain('ne(workspaceSettings.campaignRoutingMode, "off")');
    expect(router).toContain("const remaining = cap - Number(today?.n ?? 0);");
  });
  it("manual trigger lives in the Add to… menu and confirms before enrolling", () => {
    const menu = client("components", "usip", "AddToMenu.tsx");
    expect(menu).toContain("Best-fit campaign ✦");
    expect(menu).toContain("trpc.are.campaigns.routeBestFit.useQuery");
    expect(menu).toContain("trpc.are.campaigns.applyBestFit.useMutation");
  });
  it("approval mode's picks reach the attention list and the hub's review queue", () => {
    expect(read("routers", "attention.ts")).toContain("routingSuggestions.count");
    expect(client("components", "usip", "AttentionPanel.tsx")).toContain("s.routingSuggestions");
    expect(client("pages", "usip", "AREHub.tsx")).toContain("<RoutingSuggestions />");
    expect(client("components", "usip", "RoutingSuggestions.tsx")).toContain("trpc.are.campaigns.decideRoutingSuggestion.useMutation");
  });
  it("migration 0176 adds the dial columns and the suggestions table", () => {
    const m = read("_core", "rawMigrations.ts");
    expect(m).toContain("0176_campaign_routing");
    expect(m).toContain("`campaignRoutingMode` ENUM('off','approval','auto')");
    expect(m).toContain("CREATE TABLE IF NOT EXISTS `campaign_routing_suggestions`");
  });
});
