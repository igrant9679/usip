/**
 * Who approves, and how much the Revenue Engine sends (audit 2026-10-20,
 * batch E2).
 *
 *   A16 an unset auto-approve threshold means off on every screen and in the
 *       engine: Full Auto with no threshold approves nobody
 *   A17 the New Campaign wizard starts on the most manual values when ARE
 *       Settings have not loaded or failed, never on Full Auto
 *
 * The screen pass runs against the SQL-evaluating fake; the AI writer is
 * mocked to fail, so an approved prospect goes no further than approval.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, sends: [] as string[] };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./routers/are/notify", async (a) => ({ ...(await a<typeof import("./routers/are/notify")>()), areNotify: async () => {} }));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async () => { throw new Error("no model in tests"); },
}));
vi.mock("./services/sendWindow", async (a) => ({ ...(await a<typeof import("./services/sendWindow")>()), inSendWindow: async () => true }));
vi.mock("./mergeVars", async (a) => ({ ...(await a<typeof import("./mergeVars")>()), resolveBookingUrl: async () => "" }));
vi.mock("./emailDelivery", async (a) => ({
  ...(await a<typeof import("./emailDelivery")>()),
  sendCampaignEmailViaPool: async (_ws: number, msg: any) => {
    h.sends.push(msg.to);
    return { ok: true, accountId: 1, fromEmail: "rep@lsi.example" };
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { approveLineFor, runAreEngine, __resetEngineLogRepeatsForTests } from "./areEngine";
import { wizardDefaults } from "../client/src/pages/usip/areCampaignsModel";
import { approveThresholdSummary } from "@shared/areApproveThreshold";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const statusOf = (id: number) => rows("prospect_queue").find((p) => p.id === id)?.sequenceStatus;
const reasonOf = (id: number) => rows("prospect_queue").find((p) => p.id === id)?.rejectionReason;

function seedScreen(campaign: Record<string, unknown>) {
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 20, archivedAt: null, plan: "trial" });
  rows("workspace_settings").push({ workspaceId: WS, timezone: "America/New_York", outboundPausedAt: null, areDefaultDailySendCap: 50 });
  rows("are_campaigns").push({
    id: 7, workspaceId: WS, name: "Counties", status: "active", ownerUserId: 20, autonomyMode: "full",
    autoApproveThreshold: null, channelsEnabled: { email: true }, targetProspectCount: 0, dailySendCap: 50,
    stepGapDays: 3, prospectSources: [], icpOverrides: {}, discoveryQueryState: null, ...campaign,
  });
  for (const [id, score] of [[1, 90], [2, 50], [3, 20]] as const) {
    rows("prospect_queue").push({
      id, workspaceId: WS, campaignId: 7, firstName: "Pat", lastName: `P${id}`, email: `p${id}@example.com`,
      icpMatchScore: score, enrichmentStatus: "complete", sequenceStatus: "pending",
    });
  }
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.sends = [];
  __resetEngineLogRepeatsForTests();
});

describe("an unset auto-approve threshold is off (A16)", () => {
  it("Full Auto with no threshold approves nobody; only the junk floor rejects", async () => {
    seedScreen({ autoApproveThreshold: null });
    await runAreEngine({ workspaceId: WS });
    expect(statusOf(1)).toBe("pending");
    expect(statusOf(2)).toBe("pending");
    expect(statusOf(3)).toBe("skipped");
    expect(reasonOf(3)).toContain("below floor 30");
  });

  it("Full Auto with a threshold approves at or above it and rejects below it, as the copy says", async () => {
    seedScreen({ autoApproveThreshold: 70 });
    await runAreEngine({ workspaceId: WS });
    expect(statusOf(1)).not.toBe("pending");
    expect(["approved", "enrolled"]).toContain(statusOf(1));
    expect(statusOf(2)).toBe("skipped");
    expect(reasonOf(2)).toContain("below approve threshold 70");
    expect(approveThresholdSummary(70)).toBe("Approve at or above 70, reject below");
  });

  it("Batch approval has no approve line even with a threshold stored", async () => {
    seedScreen({ autonomyMode: "batch_approval", autoApproveThreshold: 40 });
    await runAreEngine({ workspaceId: WS });
    expect(statusOf(1)).toBe("pending");
    expect(statusOf(2)).toBe("pending");
    expect(approveLineFor({ autonomyMode: "batch_approval", autoApproveThreshold: 40 })).toBeNull();
    expect(approveLineFor({ autonomyMode: "full", autoApproveThreshold: null })).toBeNull();
    expect(approveLineFor({ autonomyMode: "full", autoApproveThreshold: 55 })).toBe(55);
  });

  it("the three screens say the same thing for unset, from one place", () => {
    const off = approveThresholdSummary(null);
    expect(off).toContain("nothing is approved automatically");
    const detail = read("client/src/pages/usip/ARECampaignDetail.tsx");
    const settings = read("client/src/pages/usip/ARESettings.tsx");
    const wizard = read("client/src/pages/usip/ARECampaigns.tsx");
    for (const src of [detail, settings, wizard]) expect(src).toContain('from "@shared/areApproveThreshold"');
    // The old readings of "unset": a 60 default, "or everyone is approved", "Disabled".
    expect(wizard).not.toContain("areDefaultAutoApproveThreshold ?? 60");
    expect(detail).not.toContain("or everyone is approved");
    expect(settings).not.toContain('italic">Disabled<');
    // Only Full Auto shows the threshold.
    expect(detail).toContain('{autonomyActive === "full" && (');
    expect(wizard).toContain('{form.autonomyMode === "full" && (');
    expect(wizard).toContain('autoApproveThreshold: form.autonomyMode === "full" ? form.autoApproveThreshold : null,');
  });
});

describe("the wizard's defaults when ARE Settings have not loaded (A17)", () => {
  it("loading or failed starts on Batch approval with no threshold", () => {
    for (const s of [undefined, null]) {
      const d = wizardDefaults(s);
      expect(d.autonomyMode).toBe("batch_approval");
      expect(d.autoApproveThreshold).toBeNull();
    }
  });

  it("loaded settings are used as saved, and an unset threshold stays unset", () => {
    const d = wizardDefaults({ areDefaultAutonomyMode: "full", areDefaultAutoApproveThreshold: null, areDefaultDailySendCap: 80 });
    expect(d.autonomyMode).toBe("full");
    expect(d.autoApproveThreshold).toBeNull();
    expect(d.dailySendCap).toBe(80);
    expect(wizardDefaults({ areDefaultAutonomyMode: "batch_approval", areDefaultAutoApproveThreshold: 65 }).autoApproveThreshold).toBe(65);
  });

  it("the wizard reads them through wizardDefaults and says when they did not load", () => {
    const wizard = read("client/src/pages/usip/ARECampaigns.tsx");
    expect(wizard).toContain("const wsDefaults = useMemo(() => wizardDefaults(wsSettings), [wsSettings]);");
    expect(wizard).not.toContain('areDefaultAutonomyMode ?? "full"');
    expect(wizard).toContain("Your ARE Settings defaults didn't load");
  });
});

describe("ARE Settings' Daily Send Cap caps the Revenue Engine (A19)", () => {
  const seedDispatch = (cap: number | undefined) => {
    rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 20, archivedAt: null, plan: "trial" });
    rows("workspace_settings").push({ workspaceId: WS, timezone: "UTC", outboundPausedAt: null, emailOpenTracking: false, ...(cap === undefined ? {} : { areDefaultDailySendCap: cap }) });
    for (const id of [7, 8]) {
      rows("are_campaigns").push({
        id, workspaceId: WS, name: `C${id}`, status: "active", ownerUserId: 20, autonomyMode: "batch_approval",
        channelsEnabled: { email: true }, targetProspectCount: 0, dailySendCap: 50, stepGapDays: 3, prospectSources: [],
        icpOverrides: {}, discoveryQueryState: null,
      });
    }
    const due = new Date(Date.now() - 60_000);
    for (const id of [1, 2, 3]) {
      rows("prospect_queue").push({ id, workspaceId: WS, campaignId: 7, firstName: "Pat", lastName: `P${id}`, email: `p${id}@example.com`, sequenceStatus: "enrolled", enrichmentStatus: "complete" });
      rows("prospect_intelligence").push({ id: 100 + id, workspaceId: WS, prospectQueueId: id, copyHoldReason: null });
      rows("are_execution_queue").push({ id: 50 + id, workspaceId: WS, campaignId: 7, prospectQueueId: id, stepIndex: 0, channel: "email", status: "scheduled", scheduledAt: new Date(due.getTime() + id), messageContent: { subject: "Hello", body: "A short note." } });
    }
  };

  it("stops the engine at the workspace cap even when the campaign's own cap has room", async () => {
    seedDispatch(2);
    await runAreEngine({ workspaceId: WS });
    expect(h.sends).toEqual(["p1@example.com", "p2@example.com"]);
    expect(rows("are_engine_logs").map((l) => String(l.message)).join("\n")).toContain("the workspace's Revenue Engine daily cap: 0 of 2 sent today across all campaigns");
  });

  it("counts what every campaign in the workspace sent today, and nothing from another workspace", async () => {
    seedDispatch(2);
    rows("are_execution_queue").push({ id: 90, workspaceId: WS, campaignId: 8, prospectQueueId: 99, stepIndex: 0, channel: "linkedin", status: "sent", executedAt: new Date(), scheduledAt: new Date() });
    rows("are_execution_queue").push({ id: 91, workspaceId: 4, campaignId: 30, prospectQueueId: 98, stepIndex: 0, channel: "email", status: "sent", executedAt: new Date(), scheduledAt: new Date() });
    await runAreEngine({ workspaceId: WS });
    expect(h.sends).toEqual(["p1@example.com"]);
  });

  it("with no settings row the cap is the column's default, 50", async () => {
    seedDispatch(undefined);
    await runAreEngine({ workspaceId: WS });
    expect(h.sends).toHaveLength(3);
  });

  it("manual and Sequence mail keep the limit they are under, and the refusal names them", () => {
    const limits = read("server/sendLimits.ts");
    expect(limits).toContain(".select({ cap: workspaceSettings.areDefaultDailySendCap })");
    expect(limits).toContain("const wsCap = settings?.cap ?? DEFAULT_WORKSPACE_DAILY_CAP;");
    expect(limits).toContain("Workspace daily cap for manual and Sequence email reached");
    const settings = read("client/src/pages/usip/ARESettings.tsx");
    expect(settings).toContain("The most the Revenue Engine sends in a day across all its campaigns");
    expect(settings).toContain("separately caps the");
    expect(settings).not.toContain("Maximum emails sent per day across all active ARE campaigns.");
  });
});
