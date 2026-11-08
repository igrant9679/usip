/**
 * A status bar that says what is stopping sends right now (audit 2026-10-20,
 * U1), on Sequences, Emails, Mailbox, Meetings, Social and the Revenue
 * Engine: "Outbound paused", "Outside send window (opens 6:00 AM EST)",
 * "LinkedIn paused", "Apollo cap reached". One server read over the sources
 * the senders ask (services/sendingStatus.ts) and one shared component.
 * Display only: nothing here can make sending more likely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { invalidateSendWindowCache } from "./services/sendWindow";
import { sendingStatus } from "./services/sendingStatus";

const WS = 2;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
// A FIXED clock: Tuesday 2026-11-10, 05:00 in New York (EST) = 10:00 UTC — before a 6 AM window.
const EARLY = new Date(Date.UTC(2026, 10, 10, 10, 0));
// Tuesday 11:00 in New York = 16:00 UTC — inside it.
const MIDDAY = new Date(Date.UTC(2026, 10, 10, 16, 0));
const settings = () => rows("workspace_settings")[0];
const keys = async (at: Date) => (await sendingStatus(WS, at)).blocks.map((b) => b.key);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  invalidateSendWindowCache();
  rows("workspace_settings").push({
    workspaceId: WS, timezone: "America/New_York", sendWindowStartHour: 6, sendWindowEndHour: 17, sendWindowDays: "1,2,3,4,5",
    outboundPausedAt: null, areDefaultDailySendCap: 50, apolloApiKeyEnc: null, apolloDailyPullCap: 50,
  });
});
afterEach(() => { invalidateSendWindowCache(); });

describe("the pause and the send window (U1)", () => {
  it("before the window opens it says when it opens, in the workspace's time", async () => {
    const s = await sendingStatus(WS, EARLY);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({ key: "outside_window", label: "Outside send window (opens 6:00 AM EST)", tone: "wait" });
    // It holds automatic sends; what a person sends from the mailbox goes now.
    expect(s.blocks[0]!.surfaces).not.toContain("mailbox");
    expect(s.blocks[0]!.surfaces).toEqual(expect.arrayContaining(["sequences", "emails", "meetings", "social", "are"]));
    expect(await keys(MIDDAY)).toEqual([]);
  });

  it("a window that next opens another day names the day", async () => {
    // Friday 18:00 in New York: next opening is Monday 6:00 AM.
    const s = await sendingStatus(WS, new Date(Date.UTC(2026, 10, 13, 23, 0)));
    expect(s.blocks[0]!.label).toBe("Outside send window (opens Mon, 6:00 AM EST)");
  });

  it("paused: one 'Outbound paused' on every surface, the mailbox too, and no window line", async () => {
    settings().outboundPausedAt = new Date("2026-09-28T00:00:00Z");
    const s = await sendingStatus(WS, EARLY);
    expect(s.blocks.map((b) => b.key)).toEqual(["outbound_paused"]);
    expect(s.blocks[0]).toMatchObject({ label: "Outbound paused", tone: "stop" });
    expect(s.blocks[0]!.surfaces).toEqual(["sequences", "emails", "mailbox", "meetings", "social", "are"]);
  });
});

describe("LinkedIn, caps and discovery (U1)", () => {
  const account = (id: string, policy: Record<string, unknown> | null) => {
    rows("unipile_accounts").push({ id: rows("unipile_accounts").length + 1, workspaceId: WS, userId: 1, unipileAccountId: id, provider: "LINKEDIN", status: "OK", createdAt: new Date("2025-01-01T00:00:00Z") });
    if (policy) rows("linkedin_activity_limits").push({ id: rows("linkedin_activity_limits").length + 1, workspaceId: WS, unipileAccountId: id, enabled: true, weeklyInviteCap: 80, dailyInviteCap: 15, dailyMessageCap: 40, dailyLookupCap: 100, dailySearchCap: 30, dailyActionCap: 120, minSpacingSeconds: 0, jitterSeconds: 0, workingHourStart: 0, workingHourEnd: 24, workingDays: "1,2,3,4,5,6,7", timezone: "UTC", warmupDays: 0, ...policy });
  };

  it("LinkedIn paused when every account is switched off; not when one may act", async () => {
    account("acc-1", { enabled: false });
    const s = await sendingStatus(WS, MIDDAY);
    expect(s.blocks).toEqual([expect.objectContaining({ key: "linkedin", label: "LinkedIn paused", tone: "stop", surfaces: ["sequences", "social", "are"] })]);
    account("acc-2", {});
    expect(await keys(MIDDAY)).toEqual([]);
  });

  it("a workspace with no LinkedIn account has nothing to say about LinkedIn", async () => {
    expect(await keys(MIDDAY)).toEqual([]);
  });

  it("the daily email cap, once reached", async () => {
    settings().areDefaultDailySendCap = 2;
    for (let i = 1; i <= 2; i++) rows("email_drafts").push({ id: i, workspaceId: WS, status: "sent", sentAt: new Date(MIDDAY.getTime() - 3600_000) });
    const s = await sendingStatus(WS, MIDDAY);
    expect(s.blocks).toEqual([expect.objectContaining({ key: "email_cap", label: "Daily send cap reached (2/2)", surfaces: ["sequences", "emails", "mailbox"] })]);
  });

  it("Apollo cap reached, only with an Apollo key", async () => {
    settings().apolloDailyPullCap = 10;
    rows("are_scrape_jobs").push({ id: 1, workspaceId: WS, sourceType: "apollo", resultCount: 10, scrapedAt: new Date(MIDDAY.getTime() - 3600_000) });
    expect(await keys(MIDDAY)).toEqual([]);
    settings().apolloApiKeyEnc = "enc:xxx";
    const s = await sendingStatus(WS, MIDDAY);
    expect(s.blocks).toEqual([expect.objectContaining({ key: "apollo_cap", label: "Apollo cap reached", surfaces: ["are"] })]);
  });

  it("a source's current allowance used up, unless credits remain; a rolled period is history", async () => {
    const ledger = (o: Record<string, unknown>) => rows("prospect_source_budget_ledger").push({ id: rows("prospect_source_budget_ledger").length + 1, workspaceId: WS, sourceSlug: "warmysender", bucket: "leads", unitsConsumed: 0, unitsReserved: 0, heldAt: null, ...o });
    ledger({ granularity: "monthly", periodKey: "2026-11", unitsLimit: 500, unitsConsumed: 480, unitsReserved: 20, resetsAt: new Date("2026-12-01T00:00:00Z") });
    ledger({ granularity: "monthly", periodKey: "2026-10", unitsLimit: 500, unitsConsumed: 500, resetsAt: new Date("2026-11-01T00:00:00Z") });
    // Another source whose only full row is last month's: nothing to say.
    ledger({ sourceSlug: "leadocean", granularity: "monthly", periodKey: "2026-10", unitsLimit: 100, unitsConsumed: 100, resetsAt: new Date("2026-11-01T00:00:00Z") });
    const s = await sendingStatus(WS, MIDDAY);
    expect(s.blocks).toEqual([expect.objectContaining({ key: "source_cap:warmysender", label: "WarmySender cap reached", surfaces: ["are"] })]);
    ledger({ granularity: "credits", periodKey: "all", unitsLimit: 100, unitsConsumed: 40, resetsAt: null });
    expect(await keys(MIDDAY)).toEqual([]);
  });
});

describe("one read, one bar, on each page (U1)", () => {
  it("sendingStatus.current answers for the caller's workspace", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(EARLY);
    try {
      const r = await appRouter.createCaller({
        user: { id: 1, openId: "u", email: "a@lsi.example", name: "A", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
        req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
        res: { clearCookie: () => {} },
      } as unknown as TrpcContext).sendingStatus.current();
      expect(r.blocks.map((b) => b.key)).toEqual(["outside_window"]);
      expect(r.timezone).toBe("America/New_York");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the bar filters to its page's surface, hides when clear, and reads the one query", () => {
    const bar = read("client/src/components/usip/SendingStatusBar.tsx");
    expect(bar).toContain("trpc.sendingStatus.current.useQuery(");
    expect(bar).toContain(".filter((b) => b.surfaces.includes(surface))");
    expect(bar).toContain("if (blocks.length === 0) return null;");
    expect(bar).not.toMatch(/useMutation/);
  });

  it("is on Sequences, the sequence page, Emails, Mailbox, Meetings, Social and the Revenue Engine", () => {
    const pages: Array<[string, string]> = [
      ["SequencesV2", "sequences"], ["SequenceEditor", "sequences"], ["EmailsV2", "emails"], ["Mailbox", "mailbox"],
      ["MeetingsV2", "meetings"], ["Social", "social"], ["AREHub", "are"], ["ARECampaigns", "are"],
    ];
    for (const [page, surface] of pages) {
      const src = read(`client/src/pages/usip/${page}.tsx`);
      expect(src, page).toContain(`<SendingStatusBar surface="${surface}"`);
      expect(src, page).toContain('import { SendingStatusBar } from "@/components/usip/SendingStatusBar";');
    }
  });

  it("reads only: the service writes nothing", () => {
    const svc = read("server/services/sendingStatus.ts");
    expect(svc).not.toMatch(/\.insert\(|\.update\(|\.delete\(|recordLinkedInAction|sendEmail|deliver/);
  });
});
