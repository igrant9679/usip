/**
 * What's Working measures the Revenue Engine (audit 2026-10-20, batch E2).
 *
 *   A22 the step table is the engine's own steps (are_execution_queue), not CRM
 *       Sequence drafts; the CRM table stays, labelled as a different product
 *   A63 no rate passes 100%; one reply population — the people the engine
 *       contacted who replied, each once — behind the headline, the step table,
 *       the sources and the reply mix; a failed read shows as an error
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { computeAreStepCells, getAreStepStats, getReplyMix } from "./services/performanceMetrics";

const WS = 2, OTHER = 9;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const t0 = Date.UTC(2026, 9, 1);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  rows("are_campaigns").push({ id: 7, workspaceId: WS, name: "Counties" }, { id: 8, workspaceId: WS, name: "Cities" });
  const send = (id: number, o: Record<string, unknown>) => rows("are_execution_queue").push({
    id, workspaceId: WS, campaignId: 7, channel: "email", status: "sent", trackingToken: `t${id}`, openedAt: null, ...o,
  });
  // Person 1: two steps, opened step 1, replied twice after step 2.
  send(1, { prospectQueueId: 1, stepIndex: 0, executedAt: new Date(t0), openedAt: new Date(t0 + 1) });
  send(2, { prospectQueueId: 1, stepIndex: 1, executedAt: new Date(t0 + 86_400_000) });
  // Person 2: one step, no pixel (sent before tracking), replied and met.
  send(3, { prospectQueueId: 2, stepIndex: 0, executedAt: new Date(t0), trackingToken: null });
  // Person 3: another campaign, no reply.
  send(4, { prospectQueueId: 3, stepIndex: 0, campaignId: 8, executedAt: new Date(t0) });
  // Scheduled, not sent; and another workspace's send.
  send(5, { prospectQueueId: 4, stepIndex: 0, status: "scheduled", executedAt: null });
  rows("are_execution_queue").push({ id: 6, workspaceId: OTHER, campaignId: 70, prospectQueueId: 1, stepIndex: 0, status: "sent", executedAt: new Date(t0), trackingToken: "x" });
  const sig = (id: number, prospectQueueId: number, signalType: string, workspaceId = WS) =>
    rows("are_signal_log").push({ id, workspaceId, campaignId: 7, prospectQueueId, signalType, processedAt: new Date(t0 + 2 * 86_400_000) });
  sig(1, 1, "email_reply");
  sig(2, 1, "email_reply");
  sig(3, 2, "email_reply");
  sig(4, 2, "meeting_booked");
  sig(5, 4, "email_reply");            // never sent anything: not in the population
  sig(6, 3, "email_reply", OTHER);     // another workspace
  const reply = (id: number, o: Record<string, unknown>) => rows("email_replies").push({ id, workspaceId: WS, draftId: null, campaignId: 7, ...o });
  reply(1, { prospectQueueId: 1, replyClass: "follow_up_question" });
  reply(2, { prospectQueueId: 1, replyClass: "willing_to_meet" });
  reply(3, { prospectQueueId: 2, replyClass: null });
  reply(4, { prospectQueueId: null, campaignId: null, draftId: 900, replyClass: "not_interested" }); // a CRM Sequence reply
  reply(5, { prospectQueueId: null, campaignId: null, draftId: null, replyClass: null });           // the wider mailbox
});

describe("the step table is the engine's own steps (A22)", () => {
  it("one row per campaign step, from sent engine steps in this workspace", async () => {
    const stats = await getAreStepStats(WS);
    expect(stats.map((s) => `${s.campaignName}:${s.stepIndex}:${s.sent}`)).toEqual(["Counties:0:2", "Counties:1:1", "Cities:0:1"]);
  });

  it("the page reads it, and the CRM table is labelled as another product", () => {
    const page = read("client/src/pages/usip/AREPerformance.tsx");
    expect(page).toContain("trpc.are.metrics.areSteps.useQuery(");
    expect(page).toContain("const totalSent = areStepRows.reduce((n, r) => n + r.sent, 0);");
    expect(page).toContain("CRM Sequences (not the Revenue Engine)");
    expect(page).not.toContain('label="Sequence emails sent"');
  });
});

describe("rates stay at or under 100%, over one population (A63)", () => {
  it("opens count once per message with a pixel; a reply counts once per person, on their last step", () => {
    const cells = computeAreStepCells(
      [
        { campaignId: 7, prospectQueueId: 1, stepIndex: 0, executedAt: new Date(t0), openedAt: new Date(t0), trackingToken: "a" },
        { campaignId: 7, prospectQueueId: 1, stepIndex: 1, executedAt: new Date(t0 + 1000), openedAt: new Date(t0), trackingToken: null },
      ],
      [{ prospectQueueId: 1, signalType: "email_reply" }, { prospectQueueId: 1, signalType: "email_reply" }, { prospectQueueId: 1, signalType: "email_reply" }],
    );
    expect(cells.get("7:0")).toMatchObject({ sent: 1, trackable: 1, opens: 1, replies: 0 });
    expect(cells.get("7:1")).toMatchObject({ sent: 1, trackable: 0, opens: 0, replies: 1 });
  });

  it("no step's rate passes 100%", async () => {
    for (const s of await getAreStepStats(WS)) {
      expect(s.openRate).toBeLessThanOrEqual(100);
      expect(s.replyRate).toBeLessThanOrEqual(100);
      expect(s.meetingRate).toBeLessThanOrEqual(100);
    }
    const step2 = (await getAreStepStats(WS)).find((s) => s.campaignId === 7 && s.stepIndex === 1)!;
    expect(step2).toMatchObject({ sent: 1, replies: 1, replyRate: 100 });
  });

  it("the reply mix is the same people as the step table, each once, by their latest reply", async () => {
    const stats = await getAreStepStats(WS);
    const mix = await getReplyMix(WS);
    expect(mix.attributed).toBe(2);
    expect(stats.reduce((n, s) => n + s.replies, 0)).toBe(mix.attributed);
    expect(mix.classes.map((c) => `${c.replyClass}:${c.count}`).sort()).toEqual(["unclassified:1", "willing_to_meet:1"]);
    expect(mix.classes.reduce((n, c) => n + c.share, 0)).toBe(100);
    expect(mix.unattributedInbound).toBe(1);
  });

  it("CRM Sequence opens and replies are counted per message, and sources only count people contacted", () => {
    const pm = read("server/services/performanceMetrics.ts");
    expect(pm).not.toContain("opens: sql<number>`coalesce(sum(${emailDrafts.openCount}), 0)`");
    expect(pm).toContain("opens: sql<number>`coalesce(sum(case when ${emailDrafts.openCount} > 0 then 1 else 0 end), 0)`");
    expect(pm).toContain("replies: sql<number>`count(distinct ${emailReplies.draftId})`");
    const yieldFn = pm.slice(pm.indexOf("export async function getSourceYieldStats"), pm.indexOf("/* ─── Inbound reply mix"));
    expect(yieldFn).toContain("exists(db.select({ one: sql`1` }).from(areExecutionQueue)");
  });

  it("a failed read shows as an error in its own card, not as nothing yet", () => {
    const page = read("client/src/pages/usip/AREPerformance.tsx");
    for (const what of ["the Revenue Engine's steps", "the CRM Sequence steps", "the prospect sources", "the reply mix"]) {
      expect(page).toContain(`<QueryError compact what="${what}"`);
    }
  });
});
