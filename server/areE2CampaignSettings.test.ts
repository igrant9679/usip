/**
 * A campaign's Settings tab (audit 2026-10-20, batch E2).
 *
 *   A14 the fit gate's copy says what the engine does — rejects lower scores on
 *       its next run — and Settings counts and confirms who that is
 *   A46 the Copy card saves on its own and keeps the other cards' drafts; the
 *       tab's Save writes only what was edited
 *   A47 a fixed step's day is the one the engine uses, and an empty fixed
 *       campaign cannot be saved
 *   A48 the page is keyed by campaign id, so drafts never cross campaigns
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
import { fixedStepDay, usableFixedSteps } from "@shared/areFixedCopy";

const WS = 2, OTHER = 9;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const detail = read("client/src/pages/usip/ARECampaignDetail.tsx");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  rows("are_campaigns").push(
    { id: 7, workspaceId: WS, name: "Counties", status: "active", copyMode: "per_person", fixedSteps: null, minConfidence: null },
    { id: 8, workspaceId: WS, name: "Fixed", status: "draft", copyMode: "fixed", fixedSteps: [{ stepIndex: 0, day: 0, channel: "email", subject: "Hi", body: "Hello" }] },
  );
});

describe("the fit gate says what it does and counts who it rejects (A14)", () => {
  beforeEach(() => {
    const p = (id: number, o: Record<string, unknown>) => rows("prospect_queue").push({
      id, workspaceId: WS, campaignId: 7, sequenceStatus: "pending", enrichmentStatus: "pending", icpMatchScore: 30, ...o,
    });
    p(1, {});                                                            // waiting below 40: rejected
    p(2, { sequenceStatus: "sourcing", enrichmentStatus: "enriching", icpMatchScore: 10 }); // also
    p(3, { icpMatchScore: 0 });                                          // not scored yet: kept
    p(4, { icpMatchScore: 55 });                                         // above the gate
    p(5, { enrichmentStatus: "complete", icpMatchScore: 20 });           // already enriched: not this pass
    p(6, { sequenceStatus: "skipped" });                                 // already rejected
    p(7, { campaignId: 9 });                                             // another campaign
    p(8, { workspaceId: OTHER });                                        // another workspace
  });

  it("counts the engine's own predicate, scoped to this campaign and workspace", async () => {
    expect(await caller().are.campaigns.fitGatePreview({ id: 7, minConfidence: 40 })).toEqual({ wouldReject: 2 });
    expect(await caller().are.campaigns.fitGatePreview({ id: 7, minConfidence: 20 })).toEqual({ wouldReject: 1 });
    expect(await caller().are.campaigns.fitGatePreview({ id: 7, minConfidence: 0 })).toEqual({ wouldReject: 0 });
  });

  it("the card no longer says lower-fit prospects stay, and Save confirms the count first", () => {
    expect(detail).not.toContain("Lower-fit prospects stay in the queue");
    expect(detail).toContain("rejected on the engine's next run (within a few minutes)");
    expect(detail).toContain("const n = minConfDraft !== null ? fitGatePreview.data?.wouldReject ?? 0 : 0;");
    const save = detail.slice(detail.indexOf("const n = minConfDraft !== null"), detail.indexOf("const n = minConfDraft !== null") + 700);
    expect(save).toContain("confirmAction({");
    expect(save).toContain('confirmLabel: "Save and reject"');
    expect(save).toContain("}, save);");
  });
});

describe("the Copy card saves on its own (A46)", () => {
  it("has its own mutation, which clears its own drafts and nobody else's", () => {
    const start = detail.indexOf("const saveCopy = trpc.are.campaigns.update.useMutation({");
    expect(start).toBeGreaterThan(-1);
    const block = detail.slice(start, detail.indexOf("onError:", start));
    expect(block).toContain("setCopyDraft(null);");
    expect(block).toContain("setFixedDraft(null);");
    expect(block).not.toContain("setThresholdDraft");
    expect(block).not.toContain("setMinConfDraft");
    expect(detail).toContain("onClick={() => saveCopy.mutate({");
    expect(detail).not.toContain("onClick={() => updateCampaign.mutate({ id: campaign!.id, copyMode");
  });

  it("the tab's Save writes only the fields that were edited", () => {
    expect(detail).toContain("...(thresholdDraft !== undefined ? { autoApproveThreshold: thresholdDraft } : {}),");
    expect(detail).toContain("...(minConfDraft !== null ? { minConfidence: minConfDraft } : {}),");
    expect(detail).toContain("...(s2oEnabled !== null ? { signalToOpportunityEnabled: s2oEnabled } : {}),");
    // Disable on a campaign with a threshold is an edit (null), not "no draft".
    expect(detail).toContain("useState<number | null | undefined>(undefined);");
  });
});

describe("fixed copy (A47)", () => {
  it("an empty fixed campaign is refused, from either field", async () => {
    await expect(caller().are.campaigns.update({ id: 7, copyMode: "fixed", fixedSteps: [] })).rejects.toThrow(/at least one step with a subject or a body/);
    await expect(caller().are.campaigns.update({ id: 7, copyMode: "fixed", fixedSteps: [{ stepIndex: 0, day: 0, channel: "email", subject: " ", body: "" }] })).rejects.toThrow(/at least one step/);
    await expect(caller().are.campaigns.update({ id: 8, fixedSteps: [] })).rejects.toThrow(/at least one step/);
    await expect(caller().are.campaigns.update({ id: 7, copyMode: "fixed" })).rejects.toThrow(/at least one step/);
    expect(rows("are_campaigns").find((c) => c.id === 7).copyMode).toBe("per_person");
  });

  it("one usable step saves, and per-person copy needs none", async () => {
    await caller().are.campaigns.update({ id: 7, copyMode: "fixed", fixedSteps: [{ stepIndex: 0, day: 0, channel: "email", subject: "Hi", body: "" }] });
    expect(rows("are_campaigns").find((c) => c.id === 7).copyMode).toBe("fixed");
    await caller().are.campaigns.update({ id: 8, copyMode: "per_person", fixedSteps: [] });
    expect(rows("are_campaigns").find((c) => c.id === 8).copyMode).toBe("per_person");
  });

  it("the day shown is the engine's spacing, not a typed number", () => {
    expect(fixedStepDay(0, 7)).toBe(0);
    expect(fixedStepDay(3, 4)).toBe(12);
    expect(usableFixedSteps([{ subject: "", body: "" }, { body: "x" }])).toBe(1);
    expect(detail).not.toContain("aria-label={`Step ${i + 1} day`}");
    expect(detail).toContain("· day {fixedStepDay(i, gapActive)}");
    expect(detail).toContain('(copyActive === "fixed" && usableFixedSteps(fixedSteps) === 0)');
  });
});

describe("the page is keyed by campaign id (A48)", () => {
  it("a new id mounts a new page", () => {
    const start = detail.indexOf("export default function ARECampaignDetail() {");
    expect(detail.slice(start, start + 200)).toContain('return <ARECampaignDetailPage key={id ?? ""} />;');
  });
});
