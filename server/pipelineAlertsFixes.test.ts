/**
 * Pipeline alerts and the notices around them (audit 2026-10-20, batch Ra).
 *
 *   R2  — the stuck-deal digest and the proposal engagement notice go to this
 *         workspace's own people, not the platform operator; deal names are
 *         text in the mail, not markup · no sender pushes a workspace's records
 *         to the operator's notification service.
 *   R15 — a dismissal is a seven-day snooze, not fifteen minutes; an alert
 *         whose cause clears, or whose deal closes, resolves itself.
 *   R38 — a passed close date is its own alert, not "closing soon";
 *         amount_change is raised; one stage's stuck rule is that stage's.
 *
 * Procedures run through the real router against the SQL-evaluating fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  // The platform's own owner account: a user, but no member of workspace 2.
  process.env.OWNER_OPEN_ID = "platform-owner";
  return {
    db: null as any,
    sent: [] as Array<{ ws: number; to: unknown; subject: string; html: string }>,
    pushed: [] as unknown[],
  };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./emailDelivery", async (a) => ({
  ...(await a<typeof import("./emailDelivery")>()),
  sendSystemEmail: async (ws: number, o: { to: unknown; subject: string; html: string }) => { h.sent.push({ ws, ...o }); return { ok: true }; },
}));
vi.mock("./_core/notification", () => ({ notifyOwner: async (p: unknown) => { h.pushed.push(p); return true; } }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";
import { scanPipelineAlertsForWorkspace, stuckThresholds } from "./routers/pipelineAlerts";

const WS = 2, ME = 1, OWNER = 7, PLATFORM = 99, AUTHOR = 5;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = (userId = ME) => appRouter.createCaller({
  user: { id: userId, openId: `u${userId}`, email: `me${userId}@example.com`, name: "Me", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const member = (id: number, userId: number, role: string, o: Record<string, unknown> = {}) =>
  ({ id, workspaceId: WS, userId, role, deactivatedAt: null, inviteToken: null, lastActiveAt: new Date(), ...o });

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.sent = [];
  h.pushed = [];
  invalidateStageIndex();
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: OWNER, archivedAt: null, plan: "trial" });
  rows("users").push(
    { id: ME, name: "Me", email: "me@example.com", openId: "u1" },
    { id: OWNER, name: "Owner", email: "owner@example.com", openId: "u7" },
    { id: AUTHOR, name: "Author", email: "author@example.com", openId: "u5" },
    { id: PLATFORM, name: "Platform", email: "platform@example.com", openId: "platform-owner" },
  );
  rows("workspace_members").push(member(1, ME, "rep"), member(2, OWNER, "super_admin"), member(3, AUTHOR, "rep"));
});

describe("R2: the digest goes to this workspace's owner", () => {
  beforeEach(() => {
    rows("opportunities").push(
      { id: 1, workspaceId: WS, accountId: 1, name: `<img src=x onerror="alert(1)">`, stage: "discovery", value: "5000", daysInStage: 30, ownerUserId: ME },
    );
  });

  it("mails the workspace owner, never the platform owner", async () => {
    const r = await caller().pipelineAlerts.sendDigest();
    expect(r).toMatchObject({ sent: true, recipient: "owner@example.com" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe("owner@example.com");
    expect(JSON.stringify(h.sent)).not.toContain("platform@example.com");
  });

  it("an owner who has left hands the digest to a member who is still here", async () => {
    rows("workspace_members").find((m) => m.userId === OWNER).deactivatedAt = new Date();
    await caller().pipelineAlerts.sendDigest();
    expect(["me@example.com", "author@example.com"]).toContain(h.sent[0].to);
  });

  it("a deal's name is text in the mail, not markup", async () => {
    await caller().pipelineAlerts.sendDigest();
    expect(h.sent[0].html).not.toContain("<img");
    expect(h.sent[0].html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});

describe("R2: a proposal's engagement drop tells its author, in the app", () => {
  beforeEach(() => {
    rows("proposals").push({ id: 3, workspaceId: WS, createdBy: AUTHOR, title: "Q4 renewal", clientName: "Acme", status: "sent", sentAt: new Date(), emailOpenedAt: null, emailClickedAt: null });
    rows("proposal_score_history").push({ id: 1, proposalId: 3, score: 70, createdAt: new Date(Date.now() - 86_400_000) });
  });

  it("writes a notification for the author and pushes nothing to the platform", async () => {
    const r = await caller().proposals.snapshotScore({ proposalId: 3 });
    expect(r.dropped).toBe(true);
    const notes = rows("notifications").filter((n) => n.workspaceId === WS);
    expect(notes.map((n) => n.userId)).toEqual([AUTHOR]);
    expect(notes[0]).toMatchObject({ relatedType: "proposal", relatedId: 3 });
    expect(notes[0].title).toContain("Q4 renewal");
    expect(h.pushed).toEqual([]);
  });

  it("an author who has left: the workspace's owner hears instead", async () => {
    rows("workspace_members").find((m) => m.userId === AUTHOR).deactivatedAt = new Date();
    await caller().proposals.snapshotScore({ proposalId: 3 });
    expect(rows("notifications").map((n) => n.userId)).toEqual([OWNER]);
  });
});

describe("R2: no sender pushes a workspace's records to the platform operator", () => {
  /**
   * notifyOwner POSTs the operator's notification service — one inbox for the
   * whole install. The digests and notices of a workspace belong in that
   * workspace. What may still call it: platform-wide run summaries that carry
   * counts across every workspace and no workspace's records.
   */
  // 2026-11-07 (audit X6.2/G67): systemRouter's notifyOwner procedure had no caller and is deleted,
  // so systemRouter no longer imports it.
  const PLATFORM_SUMMARIES = ["server/nightlyBatch.ts", "server/routers/segmentRules.ts"];

  const files = (dir: string): string[] => readdirSync(join(root, dir)).flatMap((n) => {
    const rel = `${dir}/${n}`;
    if (statSync(join(root, rel)).isDirectory()) return n === "__fakes__" ? [] : files(rel);
    return /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [rel] : [];
  });

  it("only the platform-wide summaries import it", () => {
    const callers = files("server")
      .filter((f) => /from ["'][./]+(?:_core\/)?notification["']|import\(["'][./]+(?:_core\/)?notification["']\)/.test(read(f)))
      .filter((f) => f !== "server/_core/notification.ts")
      .map((f) => relative(root, join(root, f)).replace(/\\/g, "/"))
      .sort();
    expect(callers).toEqual(PLATFORM_SUMMARIES.slice().sort());
  });

  it("the meeting-booked signal and the rejection digest no longer call it", () => {
    expect(read("server/routers/are/execution.ts")).not.toMatch(/notifyOwner\(/);
    expect(read("server/emailTracking.ts")).not.toMatch(/notifyOwner\(/);
  });

  it("the reconnect mail prints the account's own names as text", () => {
    const mail = read("server/unipileWebhook.ts");
    expect(mail).toContain("<p>Hi ${escapeHtml(user.name ?? user.email.split(\"@\")[0])},</p>");
    expect(mail).toContain("<em>${escapeHtml(accountLabel)}</em>");
  });
});

/* ── The sweep (R15, R38) ──────────────────────────────────────────────── */

const DAY = 86_400_000;
/** A calendar date `n` days from today, stored as the app stores one (noon UTC). */
const dayFromToday = (n: number) => {
  const d = new Date(Date.now() + n * DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
};
const deal = (id: number, o: Record<string, unknown> = {}) => rows("opportunities").push({
  id, workspaceId: WS, accountId: 1, name: `Deal ${id}`, stage: "discovery", value: "10000", winProb: 60,
  closeDate: null, pipelineId: 1, daysInStage: 0, stageEnteredAt: new Date(), ownerUserId: ME, ...o,
});
const live = () => rows("pipeline_alerts").filter((a) => a.dismissedAt == null).map((a) => `${a.opportunityId}:${a.alertType}`).sort();
const stagesOf = (...extra: Array<Record<string, unknown>>) => {
  rows("crm_pipelines").push({ id: 1, workspaceId: WS, name: "Default", isDefault: true, sortOrder: 0 });
  rows("crm_pipeline_stages").push(
    { id: 11, workspaceId: WS, pipelineId: 1, key: "discovery", label: "Discovery", sortOrder: 10, defaultWinProb: 20, isWon: false, isLost: false },
    { id: 15, workspaceId: WS, pipelineId: 1, key: "signed", label: "Signed", sortOrder: 50, defaultWinProb: 100, isWon: true, isLost: false },
    ...extra,
  );
};

describe("R15 and R38: the alert sweep", () => {
  beforeEach(() => {
    _clearWorkspaceTimezoneCache();
    stagesOf();
    // Championed, so only the alert under test fires.
    rows("opportunity_contact_roles").push({ id: 1, workspaceId: WS, opportunityId: 1, contactId: 1, role: "champion" });
  });

  it("a dismissal holds for seven days, then the alert comes back if the deal still needs it", async () => {
    deal(1);
    await caller().pipelineAlerts.scan();
    expect(live()).toEqual(["1:no_activity"]);
    const [a] = rows("pipeline_alerts");
    await caller().pipelineAlerts.dismiss({ alertId: a.id });
    expect((await caller().pipelineAlerts.scan()).created).toBe(0);
    expect(live()).toEqual([]);
    a.dismissedAt = new Date(Date.now() - 8 * DAY);
    expect((await caller().pipelineAlerts.scan()).created).toBe(1);
    expect(live()).toEqual(["1:no_activity"]);
  });

  it("an alert whose cause clears resolves itself, and a new one is raised when it returns", async () => {
    deal(1);
    await scanPipelineAlertsForWorkspace(WS);
    rows("activities").push({ id: 1, workspaceId: WS, relatedType: "opportunity", relatedId: 1, type: "note", createdAt: new Date() });
    const r = await scanPipelineAlertsForWorkspace(WS);
    expect(r.resolved).toBe(1);
    expect(live()).toEqual([]);
    expect(rows("pipeline_alerts")[0].dismissedByUserId).toBeNull();
    // The activity ages out: a resolution does not snooze, so it is back.
    rows("activities")[0].createdAt = new Date(Date.now() - 20 * DAY);
    expect((await scanPipelineAlertsForWorkspace(WS)).created).toBe(1);
  });

  it("a deal that closes: its alerts leave the list and the counts at once, and the sweep resolves them", async () => {
    deal(1);
    deal(2);
    rows("opportunity_contact_roles").push({ id: 2, workspaceId: WS, opportunityId: 2, contactId: 1, role: "champion" });
    await scanPipelineAlertsForWorkspace(WS);
    expect(live()).toEqual(["1:no_activity", "2:no_activity"]);
    rows("opportunities").find((o) => o.id === 2).stage = "signed";
    invalidateStageIndex();
    expect((await caller().pipelineAlerts.list()).map((a: any) => a.opportunityId)).toEqual([1]);
    expect(await caller().pipelineAlerts.summary()).toMatchObject({ total: 1, byType: { no_activity: 1 } });
    expect((await scanPipelineAlertsForWorkspace(WS)).resolved).toBe(1);
    expect(live()).toEqual(["1:no_activity"]);
  });

  it("an alert on a deal that is gone is neither listed nor counted, and the sweep resolves it", async () => {
    deal(1);
    rows("pipeline_alerts").push({ id: 50, workspaceId: WS, opportunityId: 404, alertType: "no_champion", details: {}, dismissedAt: null, createdAt: new Date() });
    await scanPipelineAlertsForWorkspace(WS);
    rows("pipeline_alerts").find((a) => a.id === 50).dismissedAt = null;
    expect((await caller().pipelineAlerts.list()).map((a: any) => a.opportunityId)).toEqual([1]);
    expect((await caller().pipelineAlerts.summary()).total).toBe(1);
    expect((await scanPipelineAlertsForWorkspace(WS)).resolved).toBe(1);
  });

  it("a close date that has passed is past_close_date, not closing soon", async () => {
    rows("activities").push({ id: 1, workspaceId: WS, relatedType: "opportunity", relatedId: 1, type: "note", createdAt: new Date() });
    deal(1, { closeDate: dayFromToday(-12), winProb: 30 });
    await scanPipelineAlertsForWorkspace(WS);
    expect(live()).toEqual(["1:past_close_date"]);
    expect(rows("pipeline_alerts")[0].details).toMatchObject({ daysPastClose: 12, winProb: 30 });
  });

  it("closing soon is today up to 30 days out; a date that slips past swaps the alert", async () => {
    rows("activities").push({ id: 1, workspaceId: WS, relatedType: "opportunity", relatedId: 1, type: "note", createdAt: new Date() });
    deal(1, { closeDate: dayFromToday(10), winProb: 30 });
    await scanPipelineAlertsForWorkspace(WS);
    expect(live()).toEqual(["1:closing_soon_regression"]);
    expect(rows("pipeline_alerts")[0].details).toMatchObject({ daysUntilClose: 10 });
    rows("opportunities")[0].closeDate = dayFromToday(-1);
    await scanPipelineAlertsForWorkspace(WS);
    expect(live()).toEqual(["1:past_close_date"]);
  });

  it("the alerts page names the new type, counts it, and says what a dismissal does", () => {
    const page = read("client/src/pages/usip/PipelineAlerts.tsx");
    expect(page).toContain("past_close_date: {");
    expect(page).toContain('{ type: "past_close_date", label: "Past Close"');
    expect(page).toContain('"closing_soon_regression", "past_close_date", "amount_change"');
    expect(page).toContain("Dismissed for 7 days.");
    expect(page).toContain("`Amount changed from $${Number(d.previousAmount).toLocaleString()} to $${Number(d.currentAmount).toLocaleString()}`");
    expect(read("server/_core/rawMigrations.ts")).toContain("'no_champion','past_close_date') NOT NULL");
  });
});

describe("R38: amount_change is raised when a deal's amount moves", () => {
  beforeEach(() => stagesOf());
  const amountAlerts = () => rows("pipeline_alerts").filter((a) => a.alertType === "amount_change");

  it("a fifth or more either way raises one; a further change updates it", async () => {
    deal(1);
    await caller().opportunities.update({ id: 1, patch: { value: 10500 } });
    expect(amountAlerts()).toEqual([]);
    await caller().opportunities.update({ id: 1, patch: { value: 6000 } });
    expect(amountAlerts().map((a) => a.details)).toEqual([{ previousAmount: 10500, currentAmount: 6000, oppName: "Deal 1" }]);
    await caller().opportunities.update({ id: 1, patch: { value: 2000 } });
    expect(amountAlerts().map((a) => a.details)).toEqual([{ previousAmount: 10500, currentAmount: 2000, oppName: "Deal 1" }]);
  });

  it("line items that rewrite the amount count too; a closed deal raises nothing", async () => {
    deal(1);
    deal(2, { stage: "signed" });
    rows("products").push({ id: 4, workspaceId: WS, sku: "S", name: "Seat", listPrice: "100", active: true });
    await caller().opportunities.addLineItem({ opportunityId: 1, productId: 4, quantity: 2, unitPrice: 100 });
    expect(amountAlerts().map((a) => a.details)).toEqual([{ previousAmount: 10000, currentAmount: 200, oppName: "Deal 1" }]);
    await caller().opportunities.addLineItem({ opportunityId: 2, productId: 4, quantity: 2, unitPrice: 100 });
    expect(amountAlerts().map((a) => a.opportunityId)).toEqual([1]);
  });
});

describe("R38: a stage's stuck rule is that stage's alone", () => {
  beforeEach(() => {
    stagesOf({ id: 12, workspaceId: WS, pipelineId: 1, key: "proposal", label: "Proposal", sortOrder: 20, defaultWinProb: 50, isWon: false, isLost: false });
    rows("workflow_rules").push({ id: 1, workspaceId: WS, name: "Proposal stuck", enabled: true, triggerType: "deal_stuck", triggerConfig: { stage: "proposal", days: 2 } });
  });

  it("other stages keep the default", async () => {
    deal(1, { stage: "discovery", daysInStage: 3 });
    deal(2, { stage: "proposal", daysInStage: 3 });
    deal(3, { stage: "discovery", daysInStage: 8 });
    const stuck = await caller().pipelineAlerts.getStuckDeals({});
    expect(stuck.map((d: any) => [d.id, d.threshold])).toEqual([[2, 2], [3, 7]]);
  });

  it("a rule with no stage sets the default for every other stage", () => {
    const at = stuckThresholds([{ triggerConfig: { stage: "proposal", days: 2 } }, { triggerConfig: { days: 10 } }, { triggerConfig: { days: 12 } }], 7);
    expect([at("proposal"), at("discovery"), at(null)]).toEqual([2, 10, 10]);
    expect(stuckThresholds([], 7)("proposal")).toBe(7);
  });
});
