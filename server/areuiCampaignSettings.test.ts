/**
 * Campaign Settings that edit every field, with one Save (audit 2026-10-20, U11).
 *
 *   the basics — name, daily cap, target, channels, goal, template — are
 *   editable after creation; the header shows sent today / cap and the send
 *   window; every card's unsaved changes are counted and saved by one Save,
 *   and the page asks before anyone leaves with them.
 *
 *   While outbound is paused, a cap only goes down and a channel only off;
 *   a cap is never raised past the workspace's Revenue Engine cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "a".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateSendWindowCache } from "./services/sendWindow";
import { basicsChanges, basicsProblem, sendIncreaseRefusal } from "@shared/areCampaignBasics";
import { CampaignBasicsCard } from "../client/src/components/usip/are/CampaignBasicsCard";

const WS = 2, OTHER = 9;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const camp = () => rows("are_campaigns").find((c) => c.id === 7 && c.workspaceId === WS);
const block = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b, `end anchor not found: ${to}`).toBeGreaterThan(a);
  return src.slice(a, b);
};
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const pause = (on: boolean) => { rows("workspace_settings")[0].outboundPausedAt = on ? new Date() : null; invalidateSendWindowCache(); };

beforeEach(() => {
  invalidateSendWindowCache();
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  rows("are_campaigns").push(
    { id: 7, workspaceId: WS, name: "Counties", status: "active", dailySendCap: 40, targetProspectCount: 100, channelsEnabled: { email: true, linkedin: false }, goalType: "reply", sequenceTemplate: "standard_7step" },
    { id: 7, workspaceId: OTHER, name: "Theirs", status: "active", dailySendCap: 40, channelsEnabled: { email: true } },
  );
  rows("workspace_settings").push({ workspaceId: WS, timezone: "America/New_York", areDefaultDailySendCap: 120, outboundPausedAt: null, sendWindowStartHour: 9, sendWindowEndHour: 17, sendWindowDays: [1, 2, 3, 4, 5] });
});

describe("the cap and the channels, on the server", () => {
  it("every basic is editable after creation", async () => {
    await caller().are.campaigns.update({ id: 7, name: "Counties East", dailySendCap: 60, targetProspectCount: 250, channelsEnabled: { email: true, linkedin: true }, goalType: "meeting_booked", sequenceTemplate: "aggressive_3step" });
    expect(camp()).toMatchObject({ name: "Counties East", dailySendCap: 60, targetProspectCount: 250, channelsEnabled: { email: true, linkedin: true }, goalType: "meeting_booked", sequenceTemplate: "aggressive_3step" });
  });

  it("while outbound is paused: a higher cap or a new channel is refused; lower and off are fine", async () => {
    pause(true);
    await expect(caller().are.campaigns.update({ id: 7, dailySendCap: 41 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("Outbound is paused") });
    await expect(caller().are.campaigns.update({ id: 7, channelsEnabled: { email: true, linkedin: true } })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(camp()).toMatchObject({ dailySendCap: 40, channelsEnabled: { email: true, linkedin: false } });
    await caller().are.campaigns.update({ id: 7, dailySendCap: 10 });
    await caller().are.campaigns.update({ id: 7, channelsEnabled: { email: false, linkedin: false } });
    expect(camp()).toMatchObject({ dailySendCap: 10, channelsEnabled: { email: false, linkedin: false } });
    // Other fields save as before.
    await caller().are.campaigns.update({ id: 7, name: "Renamed while paused" });
    expect(camp().name).toBe("Renamed while paused");
  });

  it("never past the workspace's Revenue Engine cap; lowering a cap already above it is allowed", async () => {
    await expect(caller().are.campaigns.update({ id: 7, dailySendCap: 121 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("120 a day across all campaigns") });
    await caller().are.campaigns.update({ id: 7, dailySendCap: 120 });
    camp().dailySendCap = 300;
    await caller().are.campaigns.update({ id: 7, dailySendCap: 200 });
    expect(camp().dailySendCap).toBe(200);
  });

  it("another workspace's campaign is not found, and untouched", async () => {
    rows("are_campaigns").splice(0, 1);
    await expect(caller().are.campaigns.update({ id: 7, dailySendCap: 10 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rows("are_campaigns")[0].dailySendCap).toBe(40);
  });

  it("capContext: the workspace cap and today's sends, the mailboxes and their limits, the pause", async () => {
    rows("sending_accounts").push(
      { id: 1, workspaceId: WS, enabled: true, dailySendLimit: 50 },
      { id: 2, workspaceId: WS, enabled: true, dailySendLimit: 30 },
      { id: 3, workspaceId: WS, enabled: false, dailySendLimit: 500 },
      { id: 4, workspaceId: OTHER, enabled: true, dailySendLimit: 500 },
    );
    rows("are_execution_queue").push({ id: 1, workspaceId: WS, campaignId: 7, status: "sent", executedAt: new Date() });
    expect(await caller().are.campaigns.capContext()).toEqual({ workspaceCap: 120, workspaceSentToday: 1, mailboxes: 2, mailboxDailyTotal: 80, outboundPaused: false });
  });
});

describe("the shared rules", () => {
  const saved = { name: "Counties", dailySendCap: 40, targetProspectCount: 100, channelsEnabled: { email: true, linkedin: false }, goalType: "reply", sequenceTemplate: "standard_7step" };

  it("only what differs is written, and named", () => {
    expect(basicsChanges(saved, { name: "Counties", dailySendCap: 40 })).toEqual({ payload: {}, changed: [] });
    expect(basicsChanges(saved, { name: " New ", channelsEnabled: { email: true, linkedin: true }, goalType: "meeting_booked" })).toEqual({
      payload: { name: "New", channelsEnabled: { email: true, linkedin: true }, goalType: "meeting_booked" },
      changed: ["name", "channels", "goal"],
    });
  });

  it("a draft that can't be saved says why", () => {
    expect(basicsProblem({ name: "x" })).toMatch(/at least 2/);
    expect(basicsProblem({ dailySendCap: 0 })).toMatch(/1 to 500/);
    expect(basicsProblem({ targetProspectCount: 20000 })).toMatch(/1 to 10,000/);
    expect(basicsProblem({ channelsEnabled: { email: false, linkedin: false } })).toMatch(/at least one channel/);
    expect(basicsProblem({ name: "Fine", dailySendCap: 30 })).toBeNull();
  });

  it("the refusal: paused blocks up and on, the workspace cap blocks past it", () => {
    const ctx = { outboundPaused: false, workspaceCap: 100 };
    expect(sendIncreaseRefusal(saved, { dailySendCap: 50 }, ctx)).toBeNull();
    expect(sendIncreaseRefusal(saved, { dailySendCap: 101 }, ctx)).toMatch(/100 a day/);
    expect(sendIncreaseRefusal(saved, { dailySendCap: 50 }, { ...ctx, outboundPaused: true })).toMatch(/paused/);
    expect(sendIncreaseRefusal(saved, { channelsEnabled: { email: true, linkedin: true } }, { ...ctx, outboundPaused: true })).toMatch(/paused/);
    expect(sendIncreaseRefusal(saved, { dailySendCap: 5, channelsEnabled: { email: false, linkedin: false } }, { ...ctx, outboundPaused: true })).toBeNull();
    // A stored map with no email key reads email as on, as the engine reads it.
    expect(sendIncreaseRefusal({ dailySendCap: 40, channelsEnabled: null }, { channelsEnabled: { email: true, linkedin: false } }, { ...ctx, outboundPaused: true })).toBeNull();
  });
});

describe("the Basics card", () => {
  const campaign = { name: "Counties", dailySendCap: 40, targetProspectCount: 100, channelsEnabled: { email: true, linkedin: false }, goalType: "reply", sequenceTemplate: "standard_7step" };

  it("shows every basic with its label, and the caps it sits inside", () => {
    const html = renderToStaticMarkup(createElement(CampaignBasicsCard, { campaign, draft: {}, onChange: () => {}, cap: { workspaceCap: 120, workspaceSentToday: 7, mailboxes: 2, mailboxDailyTotal: 80, outboundPaused: false } }));
    for (const id of ["campaign-name", "campaign-cap", "campaign-target", "campaign-goal", "campaign-template"]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`for="${id}"`);
    }
    expect(html).toContain('value="Counties"');
    expect(html).toContain("the workspace&#x27;s cap of 120 a day across all campaigns (7 sent today)");
    expect(html).toContain("2 mailboxes, 80 a day between them");
    expect(html).toContain("Aggressive 3-Step");
  });

  it("says the server's refusal before Save", () => {
    const html = renderToStaticMarkup(createElement(CampaignBasicsCard, { campaign, draft: { dailySendCap: 60 }, onChange: () => {}, cap: { workspaceCap: 120, workspaceSentToday: 0, mailboxes: 0, mailboxDailyTotal: 0, outboundPaused: true } }));
    expect(html).toContain("Outbound is paused for this workspace");
  });
});

describe("the page: header, one Save, the leave guard", () => {
  const page = read("client/src/pages/usip/ARECampaignDetail.tsx");

  it("the header shows sent today / cap and the send window, from the stall panel's read", () => {
    expect(page).toContain("const capAndWindow = trpc.are.campaigns.stallReasons.useQuery({ campaignId }, { enabled: validId, refetchInterval: 60_000 });");
    const header = block(page, "<PageHeader\n        title={campaign.name}", "</PageHeader>");
    expect(header).toContain("Sent today {capAndWindow.data.gates.cap.sentToday} / {capAndWindow.data.gates.cap.cap}");
    expect(header).toContain("Window ${capAndWindow.data.sending.windowDescription}");
  });

  it("Settings carries the basics, research and prompts, and stays mounted once opened", () => {
    const tab = block(page, '<TabsContent value="settings"', "</TabsContent>");
    expect(tab).toContain('forceMount={opened("settings") ? true : undefined}');
    expect(tab).toContain("data-[state=inactive]:hidden");
    expect(tab).toContain("<settingsDrafts.Provider>");
    expect(tab).toContain("<CampaignBasicsCard campaign={campaign} draft={basicsDraft} onChange={setBasicsDraft} cap={capCtx.data} />");
    expect(tab).toContain("<CampaignResearchCard campaignId={campaignId} campaign={campaign} />");
    expect(tab).toContain("<SequencePromptCard campaignId={campaignId} campaign={campaign} />");
    // The Sequences tab points there instead of holding its own copies.
    const seq = block(page, "function SequencesTab(", "function SequenceDrawer(");
    expect(seq).not.toContain("<SequencePromptCard");
    expect(seq).not.toContain("<CampaignResearchCard");
    expect(seq).toContain("are on the Settings tab.");
  });

  it("one Save counts every card's changes and writes them all; the basics go in the main update", () => {
    const tab = block(page, '<TabsContent value="settings"', "</TabsContent>");
    const bar = block(tab, "{unsavedCount > 0 && (", "</settingsDrafts.Provider>");
    expect(bar).toContain("{unsaved.map((u) => u.label).join(\", \")}");
    expect(bar).toContain("const save = () => void saveAllSettings();");
    expect(bar).toContain("Save all changes");
    expect(bar).toContain("onClick={discardAllSettings}");
    const saveAll = block(page, "const saveAllSettings = async () => {", "\n  };\n");
    expect(saveAll).toContain("...basics.payload,");
    expect(saveAll).toContain("if (Object.keys(main).length > 1) await updateCampaign.mutateAsync(main);");
    expect(saveAll).toContain("for (const e of Object.values(settingsDrafts.entries)) await e.save();");
    expect(saveAll).toContain("...(copyDirty ? { copyMode: copyActive");
    // The old per-tab Save that listed six drafts is gone.
    expect(page).not.toContain("{(thresholdDraft !== undefined || minConfDraft !== null || s2oEnabled !== null || sourcesDraft !== null || autonomyDraft !== null || gapDraft !== null) && (");
  });

  it("the page asks before leaving with unsaved changes", () => {
    expect(page).toContain("useUnsavedChangesGuard(unsavedCount > 0);");
    const guard = read("client/src/components/usip/are/settingsDrafts.tsx");
    expect(guard).toContain('window.addEventListener("beforeunload", onUnload);');
    expect(guard).toContain('document.addEventListener("click", onClick, true);');
    expect(guard).toContain("() => navigate(dest)");
  });

  it("the cards with their own draft register it with the one Save", () => {
    expect(read("client/src/components/usip/are/CampaignTargetingCard.tsx")).toContain('useRegisterDraft("targeting", {');
    expect(read("client/src/components/usip/are/CampaignResearchCard.tsx")).toContain('useRegisterDraft("research", {');
    expect(block(page, "function SequencePromptCard(", "/* ─── Sequences tab v2")).toContain('useRegisterDraft("prompts", {');
  });
});
