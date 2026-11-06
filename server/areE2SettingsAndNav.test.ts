/**
 * ARE Settings, the campaign list and the Revenue Engine's navigation (audit
 * 2026-10-20, batch E2).
 *
 *   A60 Save writes only what changed; Discard reverts; the quality threshold
 *       nobody reads is gone; Reset All does what it says
 *   A62 the campaign list pages past 50; applying a persona keeps its places,
 *       size and id
 *   A73 the wizard, the targeting card and the ICP page say what the engine does
 *   A76 one sub-nav, the hub's New Campaign opens the wizard, one label map
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { areSettingsDraft, changedAreSettings } from "../client/src/pages/usip/areSettingsModel";
import { employeeRangeOf, personaToTargeting } from "../client/src/pages/usip/areCampaignsModel";
import { areAutonomyLabel, areStatusLabel } from "@shared/areCampaignLabels";

const WS = 2;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const settingsPage = read("client/src/pages/usip/ARESettings.tsx");
const list = read("client/src/pages/usip/ARECampaigns.tsx");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
});

describe("ARE Settings (A60)", () => {
  const loaded = areSettingsDraft({ areDefaultAutonomyMode: "batch_approval", areDefaultDailySendCap: 40, areDefaultChannels: { email: true, linkedin: true } });

  it("Save sends only the fields that changed", () => {
    expect(changedAreSettings(loaded, { ...loaded })).toEqual({});
    expect(changedAreSettings(loaded, { ...loaded, areDefaultDailySendCap: 60 })).toEqual({ areDefaultDailySendCap: 60 });
    expect(changedAreSettings(loaded, { ...loaded, areDefaultChannels: { email: true, linkedin: false } })).toEqual({ areDefaultChannels: { email: true, linkedin: false } });
    expect(areSettingsDraft({ areDefaultAutonomyMode: "review_release" }).areDefaultAutonomyMode).toBe("batch_approval");
    expect(settingsPage).toContain("const patch = changedAreSettings(loaded, {");
    expect(settingsPage).toContain("save.mutate(patch);");
  });

  it("Discard puts the form back from what was loaded", () => {
    expect(settingsPage).toContain("onClick={() => { if (loaded) hydrate(loaded); }}");
    expect(settingsPage).not.toContain("onClick={() => { utils.settings.getAreSettings.invalidate(); setDirty(false); }}");
  });

  it("the quality threshold nothing reads has no control, and Reset All sets every campaign to Batch approval", () => {
    expect(settingsPage).not.toContain('aria-label="Sequence quality threshold"');
    expect(settingsPage).not.toContain("are automatically rewritten before sending");
    expect(settingsPage).not.toContain("contact your admin");
    expect(settingsPage).toContain('}, () => resetAll.mutate({ mode: "batch_approval" }))}');
    expect(settingsPage).toContain("const resetAll = trpc.are.campaigns.setAllAutonomy.useMutation({");
  });
});

describe("the campaign list and the wizard's personas (A62)", () => {
  it("pages past the newest 50, with a count", async () => {
    for (let i = 1; i <= 3; i++) rows("are_campaigns").push({ id: i, workspaceId: WS, name: `C${i}`, status: "active", createdAt: new Date(Date.UTC(2026, 9, i)) });
    rows("are_campaigns").push({ id: 9, workspaceId: 4, name: "Theirs", status: "active", createdAt: new Date() });
    expect((await caller().are.campaigns.list({ limit: 2, offset: 0 })).map((c) => c.id)).toEqual([3, 2]);
    expect((await caller().are.campaigns.list({ limit: 2, offset: 2 })).map((c) => c.id)).toEqual([1]);
    expect(await caller().are.campaigns.count({})).toEqual({ total: 3 });
    expect(list).toContain("{ limit: CAMPAIGN_PAGE, offset: (listPage - 1) * CAMPAIGN_PAGE },");
  });

  it("a persona brings its places, its size and itself", () => {
    const t = personaToTargeting({ id: 12, targetTitles: ["Clerk"], targetIndustries: ["Government"], targetGeographies: ["Virginia"], employeeMin: 51, employeeMax: 200, keywords: ["board"] });
    expect(t).toEqual({ personaId: 12, targetTitles: ["Clerk"], targetIndustries: ["Government"], targetGeographies: ["Virginia"], keywords: ["board"], employeeBand: "51-200", personaEmployeeMin: null, personaEmployeeMax: null });
    const odd = personaToTargeting({ key: "preset", employeeMin: 75, employeeMax: 900 });
    expect(odd).toMatchObject({ personaId: null, employeeBand: "persona", personaEmployeeMin: 75, personaEmployeeMax: 900 });
    expect(employeeRangeOf("persona", 75, 900)).toEqual({ employeeMin: 75, employeeMax: 900 });
    expect(employeeRangeOf("51-200", null, null)).toEqual({ employeeMin: 51, employeeMax: 200 });
    expect(list).toContain("onApply={(p) => setForm((f) => ({ ...f, ...personaToTargeting(p) }))}");
    expect(list).toContain("...(form.personaId != null ? { personaId: form.personaId } : {}),");
  });
});

describe("copy says what the engine does (A73)", () => {
  it("the wizard says every 3 minutes inside the send window, not every 10 minutes 24/7", () => {
    expect(list).not.toContain("every 10 min");
    expect(list).not.toContain("24/7");
    expect(list).toContain("every 3 minutes");
  });

  it("the targeting card, the opportunity switch and the ICP page", () => {
    expect(read("client/src/components/usip/are/CampaignTargetingCard.tsx")).not.toContain("prospects already found stay");
    const detail = read("client/src/pages/usip/ARECampaignDetail.tsx");
    expect(detail).toContain("A booked meeting always adds the person to your CRM as a contact");
    expect(detail).not.toContain("The campaign owner is notified via in-app notification.");
    const icp = read("client/src/pages/usip/AREIcpAgent.tsx");
    expect(icp).not.toContain("buying triggers, pain points");
    expect(icp).not.toContain("reads every opportunity (won and lost), account, and contact");
  });
});

describe("one sub-nav, one label map (A76)", () => {
  it("the engine's pages share AreSubNav, and the hub's New Campaign opens the wizard", () => {
    for (const f of ["AREHub", "AREPerformance", "ARECampaigns", "ARESettings"]) {
      const src = read(`client/src/pages/usip/${f}.tsx`);
      expect(src, f).toContain("<AreSubNav />");
      expect(src, f).not.toContain("<SubNav items={[");
    }
    expect(read("client/src/pages/usip/AREHub.tsx")).toContain('<Link href="/are/campaigns?new=1">');
    expect(list).toContain('new URLSearchParams(window.location.search).get("new") === "1"');
  });

  it("status and autonomy read the same everywhere", () => {
    expect(areAutonomyLabel("batch_approval")).toBe("Batch approval");
    expect(areAutonomyLabel("review_release")).toBe("Batch approval");
    expect(areStatusLabel("paused")).toBe("Paused");
    expect(list).not.toContain("{c.autonomyMode}</Badge>");
    expect(read("client/src/pages/usip/ARECampaignDetail.tsx")).toContain("{areAutonomyLabel(campaign.autonomyMode)}");
    expect(read("client/src/pages/usip/AREHub.tsx")).not.toContain('c.autonomyMode?.replace("_", " ")');
  });
});
