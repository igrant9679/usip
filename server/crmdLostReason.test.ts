/**
 * A deal moved to Lost is asked why (audit 2026-10-20, F28).
 *
 *   - the one stage-change service records the reason given with the move,
 *     or "Not given" when the question was skipped, so the move never blocks;
 *   - both procedures that move a deal from a screen pass the reason through;
 *   - every screen path that moves a deal asks first when the target stage is
 *     a lost one: the board's drop, its card arrows and AI suggestion, the
 *     Deals board's Move menu, the deal page's stage picker and the alerts
 *     page's Move stage.
 *
 * Procedures run through the real router against the SQL-evaluating fake;
 * screens are pinned by their source.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "c".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { LOST_REASON_NOT_GIVEN, normalizeLostReason } from "@shared/lostReason";

const WS = 2, ME = 1;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u1", email: "u1@example.com", name: "U1", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const block = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`missing ${start}`);
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j < 0 ? undefined : j);
};
const deal = (id: number, o: Record<string, unknown> = {}) => rows("opportunities").push({
  id, workspaceId: WS, accountId: 1, name: `Deal ${id}`, stage: "discovery", value: "1000", winProb: 20,
  closeDate: null, pipelineId: 1, daysInStage: 0, stageEnteredAt: new Date(), ownerUserId: ME, lostReason: null, ...o,
});
const opp = (id: number) => rows("opportunities").find((o) => o.id === id);

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  invalidateStageIndex();
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: ME, archivedAt: null, plan: "trial" });
  rows("users").push({ id: ME, name: "Me" });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: ME, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
  rows("crm_pipelines").push({ id: 1, workspaceId: WS, name: "Default", isDefault: true, sortOrder: 0 });
  rows("crm_pipeline_stages").push(
    { id: 11, workspaceId: WS, pipelineId: 1, key: "discovery", label: "Discovery", sortOrder: 10, defaultWinProb: 20, isWon: false, isLost: false },
    { id: 15, workspaceId: WS, pipelineId: 1, key: "signed", label: "Signed", sortOrder: 50, defaultWinProb: 100, isWon: true, isLost: false },
    // A workspace's own lost stage, keyed something other than "lost".
    { id: 16, workspaceId: WS, pipelineId: 1, key: "dropped", label: "Dropped", sortOrder: 60, defaultWinProb: 0, isWon: false, isLost: true },
  );
  rows("accounts").push({ id: 1, workspaceId: WS, name: "Acme" });
});

describe("F28: the reason is recorded with the move to Lost", () => {
  it("the board's move stores the reason given, and the history says it", async () => {
    deal(1);
    const r = await caller().opportunities.setStage({ id: 1, stage: "dropped", lostReason: "  Lost to a   competitor " });
    expect(r.changed).toBe(true);
    expect(opp(1)).toMatchObject({ stage: "dropped", lostReason: "Lost to a competitor" });
    expect(opp(1).lostAt).toBeInstanceOf(Date);
    expect(rows("opportunity_stage_history").map((x) => x.note)).toEqual(["Lost: Lost to a competitor"]);
  });

  it("a skipped question still moves the deal, and records Not given", async () => {
    deal(1);
    deal(2);
    await caller().opportunities.setStage({ id: 1, stage: "dropped" });
    await caller().opportunities.setStage({ id: 2, stage: "dropped", lostReason: "   " });
    expect(opp(1)).toMatchObject({ stage: "dropped", lostReason: LOST_REASON_NOT_GIVEN });
    expect(opp(2)).toMatchObject({ stage: "dropped", lostReason: LOST_REASON_NOT_GIVEN });
  });

  it("the alerts page's move passes the reason through the same service", async () => {
    deal(1);
    await caller().pipelineAlerts.moveDealStage({ opportunityId: 1, newStage: "dropped", lostReason: "No budget" });
    expect(opp(1)).toMatchObject({ stage: "dropped", lostReason: "No budget" });
    deal(2);
    await caller().pipelineAlerts.moveDealStage({ opportunityId: 2, newStage: "dropped" });
    expect(opp(2).lostReason).toBe(LOST_REASON_NOT_GIVEN);
  });

  it("a move to any other stage leaves the stored reason alone", async () => {
    deal(1, { stage: "dropped", lostReason: "Timing", lostAt: new Date() });
    await caller().opportunities.setStage({ id: 1, stage: "discovery", lostReason: "ignored" });
    expect(opp(1)).toMatchObject({ stage: "discovery", lostReason: "Timing", lostAt: null });
    await caller().opportunities.setStage({ id: 1, stage: "signed" });
    expect(opp(1).lostReason).toBe("Timing");
  });

  it("the reason is capped to its column", () => {
    expect(normalizeLostReason("x".repeat(400))).toHaveLength(120);
    expect(normalizeLostReason(null)).toBe("Not given");
  });
});

describe("F28: every screen path that moves a deal asks first", () => {
  it("the board: a drop, the card's arrows and an accepted AI suggestion go through the prompt", () => {
    const page = read("client/src/pages/usip/Pipeline.tsx");
    expect(page).toContain("const lostPrompt = useLostReasonPrompt((v: { id: number; stage: string }) => setStage.mutate(v));");
    expect(page).toContain("if (id) requestMove(id, s.id);");
    expect(page).toContain("onMove={(toStage) => requestMove(o.id, toStage)}");
    const accept = block(page, "const handleAcceptStage = ", "const setStage = ");
    expect(accept).toContain("?.isLost) { requestMove(opportunityId, toStage); return; }");
    expect(page).toContain("{lostPrompt.dialog}");
    // No move reaches the mutation except through the prompt or the accept path.
    expect(page.split("setStage.mutate(").length - 1).toBe(2);
  });

  it("the Deals board's Move menu, the alerts page and the deal page", () => {
    const deals = read("client/src/pages/usip/DealsV2.tsx");
    expect(deals).toContain("onClick={() => requestMove(o, st)}");
    expect(deals).toContain("isLost: stageIdx.isLost(st.key)");
    expect(deals.split("setStage.mutate(").length - 1).toBe(1);
    expect(deals).toContain("{lostPrompt.dialog}");

    const alerts = block(read("client/src/pages/usip/PipelineAlerts.tsx"), "function MoveStageDialog(", "function StuckDealCard(");
    expect(alerts).toContain("lostPrompt.ask({ opportunityId: deal.id, newStage }, { isLost: !!target?.isLost");
    expect(alerts.split("moveStage.mutate(").length - 1).toBe(1);
    expect(alerts).toContain("{lostPrompt.dialog}");

    const detail = read("client/src/pages/usip/OpportunityDetail.tsx");
    expect(detail).toContain('aria-label="Stage"');
    expect(detail).toContain("lostPrompt.ask({ id: o.id, stage: st.key }, { isLost: !!st.isLost");
    expect(detail).toContain("{lostPrompt.dialog}");
  });

  it("the dialog offers a skip that still moves, and closing it moves nothing", () => {
    const dlg = read("client/src/components/usip/LostReasonDialog.tsx");
    expect(dlg).toContain("onClick={() => finish(null)}>Skip, move without a reason</Button>");
    expect(dlg).toContain("if (!opts.isLost) { move(vars); return; }");
    expect(dlg).toContain("onCancel={() => setPending(null)}");
    expect(dlg).toContain("if (pending) move({ ...pending.vars, lostReason: reason });");
  });
});
