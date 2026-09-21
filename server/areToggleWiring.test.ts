/**
 * The ARE Settings controls that saved a value and changed nothing (2026-09-20).
 *
 * areSettingsWiring.test.ts catches "a column no code mentions". These four
 * survived it the way the quietest dead wiring always does — by being
 * mentioned. Two of them were worse than unread:
 *
 *   · "Prospect auto-approved" and "Meeting booked via signal" named EVENTS
 *     THAT WERE NEVER EMITTED. areEngine.ts inserted no notification at all,
 *     and the meeting_booked branch only called notifyOwner(), which POSTs an
 *     external service and writes no `notifications` row. So the switch was
 *     inert in both positions, and the harmful position was ON: a user who
 *     wanted the alert had no way to discover they would never get one.
 *   · "ICP profile updated" gated the two notices that follow a button the
 *     user had just pressed, while the cron that regenerates ICPs unattended
 *     told nobody.
 *   · "Max Concurrent Campaigns" was a slider whose number no code read, on a
 *     card that says in so many words "the ARE will not start new campaigns
 *     beyond this limit".
 *
 * So this file pins the two halves that make a toggle real: a GATE that reads
 * the column, and a DISPATCH SITE for every event the gate can silence. Either
 * half missing is the bug, and a forward-only check would pass with either.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { areCampaigns, workspaceSettings } from "../drizzle/schema";
import { areNotify, notifyGateColumn } from "./routers/are/notify";
import { campaignHeadroom } from "./services/are/campaignConcurrency";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  workspaceNotifyUserId: vi.fn(),
}));
vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDb: mocks.getDb,
}));
vi.mock("./_core/activeMembers", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  workspaceNotifyUserId: mocks.workspaceNotifyUserId,
}));

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * A db that dispatches on the real drizzle table objects (the
 * icpSchedule.test.ts / enrichmentSweeper.test.ts pattern). It does NOT
 * interpret WHERE clauses — every assertion below turns on WHICH table was
 * asked and WHETHER a row came back, which is all these two functions branch
 * on.
 */
function fakeDb(rows: Map<unknown, Record<string, unknown>[]>) {
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const asked: unknown[] = [];
  const db: any = {
    select: () => {
      let table: unknown;
      const q: any = {
        from: (t: unknown) => { table = t; asked.push(t); return q; },
        where: () => q,
        limit: () => q,
        then: (res: any, rej: any) => Promise.resolve(rows.get(table) ?? []).then(res, rej),
      };
      return q;
    },
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => { inserts.push({ table, values }); },
    }),
  };
  return { db, inserts, asked };
}

const NOTIFY = read("server/routers/are/notify.ts");

describe("the three notification switches actually gate something", () => {
  it("areNotify reads all three columns", () => {
    for (const col of ["areNotifyOnMeetingBooked", "areNotifyOnAutoApprove", "areNotifyOnIcpUpdate"]) {
      expect(NOTIFY.includes(col), `${col} is not read in notify.ts — its toggle is inert`).toBe(true);
    }
  });

  it("the gate compares to false explicitly, so a missing settings row fails OPEN", () => {
    /**
     * getOrSeedSettings writes workspace_settings lazily, so a workspace that
     * has never opened the ARE Settings page has NO row. `if (!s[col])` there
     * reads undefined as "off" and mutes the event for every such workspace —
     * silently, and in the direction nobody would ever report.
     */
    expect(NOTIFY).toContain("=== false");
    expect(
      /if \(!s[.[]/.test(NOTIFY),
      "notify.ts gates on a falsy read — a workspace with no settings row would be muted",
    ).toBe(false);
  });

  it("the gate sits ABOVE the recipient lookup", () => {
    // departedOwnerCascade.test.ts slices this file from `export async
    // function areNotify(` to `db.insert(notifications)` and requires the
    // recipient lookup and its null-check to be ADJACENT statements. Anything
    // inserted between them breaks that pin; pinning the order here means a
    // later edit fails HERE, where the reason is written down.
    const gate = NOTIFY.indexOf("const col = notifyGateColumn(");
    const recipient = NOTIFY.indexOf("const recipient = await workspaceNotifyUserId");
    expect(gate).toBeGreaterThan(-1);
    expect(recipient).toBeGreaterThan(gate);
  });

  it("an event with no switch is unsilenceable, not silently muted", () => {
    // signal_classified fires on every email open and hook_enhanced on every
    // enhancement. Neither has a control on the page, so neither may pay for a
    // settings SELECT — and, more importantly, neither may be switched off by
    // a control the user cannot see.
    expect(notifyGateColumn("signal_classified")).toBeUndefined();
    expect(notifyGateColumn("hook_enhanced")).toBeUndefined();
    expect(notifyGateColumn("meeting_booked")).toBe("areNotifyOnMeetingBooked");
    expect(notifyGateColumn("auto_approved")).toBe("areNotifyOnAutoApprove");
    expect(notifyGateColumn("icp_updated")).toBe("areNotifyOnIcpUpdate");
  });

  it("every gated event is dispatched from the file this list names", () => {
    /**
     * THE PIN THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. The check above proves
     * a switch is read; this proves there is something for it to switch off.
     * Both directions: the map's keys must BE the gate's keys, so adding a
     * fourth toggle without an emit fails, and so does moving an emit out of
     * the file named here.
     */
    const SITES: Record<string, string> = {
      meeting_booked: "server/routers/are/execution.ts",
      auto_approved: "server/areEngine.ts",
      icp_updated: "server/routers/are/icp.ts",
    };
    const gated = ["meeting_booked", "auto_approved", "icp_updated", "signal_classified", "hook_enhanced", "campaign_completed"]
      .filter((t) => notifyGateColumn(t) !== undefined);
    expect(Object.keys(SITES).sort()).toEqual(gated.sort());
    for (const type of Object.keys(SITES)) {
      const src = read(SITES[type]);
      expect(
        src.includes(`eventType: "${type}"`),
        `${type} can be switched off on ARE Settings but is dispatched from nowhere — ${SITES[type]} never emits it`,
      ).toBe(true);
    }
  });

  it("the meeting_booked campaign read is scoped to the workspace", () => {
    // ingestSignal takes campaignId as raw user input and never checks it
    // against ctx.workspace.id, so an unscoped lookup put another tenant's
    // campaign name into this tenant's notification body.
    const exec = read("server/routers/are/execution.ts");
    expect(exec).toMatch(/eq\(areCampaigns\.workspaceId, workspaceId\)/);
  });
});

describe("Max Concurrent Campaigns is a start gate, and only a start gate", () => {
  const conc = read("server/services/are/campaignConcurrency.ts");
  const campaigns = read("server/routers/are/campaigns.ts");
  const proposals = read("server/services/campaignProposals.ts");

  it("the helper reads the column and counts only ACTIVE campaigns", () => {
    expect(conc).toContain("areMaxConcurrentCampaigns");
    expect(conc).toMatch(/eq\(areCampaigns\.status, "active"\)/);
    expect(conc).toMatch(/eq\(areCampaigns\.workspaceId, workspaceId\)/);
  });

  it("both activation doors in the campaigns router consult it", () => {
    const create = campaigns.slice(campaigns.indexOf("create: workspaceProcedure"), campaigns.indexOf("$returningId()"));
    const setStatus = campaigns.slice(campaigns.indexOf("setStatus: workspaceProcedure"));
    expect(create).toContain("campaignHeadroom(ctx.workspace.id)");
    expect(create).toContain("if (input.launch)"); // a DRAFT is never refused
    expect(setStatus).toContain("campaignHeadroom(ctx.workspace.id)");
  });

  it("re-activating an already-active campaign is never refused", () => {
    // The campaign occupies the slot it is being counted against, so a no-op
    // re-save at exactly the limit would fail and read as a broken button.
    const setStatus = campaigns.slice(campaigns.indexOf("setStatus: workspaceProcedure"));
    expect(setStatus).toMatch(/current\.status !== "active"/);
  });

  it("the cap error names a control the reader can actually reach", () => {
    // are.campaigns.setStatus is workspaceProcedure and settings
    // .updateAreSettings is adminWsProcedure, so the rep who hits this cannot
    // clear it. The same string is read out by the assistant in chat.
    expect(conc).toContain("ask a workspace admin");
  });

  it("the engine never applies the cap to a campaign already running", () => {
    // The card promises the ARE "will not START new campaigns beyond this
    // limit". Freezing live campaigns mid-sequence because someone moved a
    // slider is a worse outcome than the inert toggle this replaced.
    expect(read("server/areEngine.ts")).not.toContain("campaignHeadroom");
  });

  it("the proposal path HOLDS at the cap instead of throwing", () => {
    /**
     * The Auto cron loops proposals inside one try/catch, so a throw here
     * abandons the workspace's remaining proposals; and the manual accept
     * converts any throw into NOT_FOUND "Proposal not found", which is a lie
     * about a proposal the user is looking at.
     */
    const fn = proposals.slice(
      proposals.indexOf("export async function acceptProposal"),
      proposals.indexOf("export async function dismissProposal"),
    );
    const gate = fn.indexOf("campaignHeadroom(workspaceId)");
    const insert = fn.indexOf("db.insert(areCampaigns)");
    expect(gate).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(gate);
    expect(fn).toContain("return { campaignId: null");
    expect(
      fn.slice(gate, insert).includes("throw"),
      "acceptProposal throws at the cap — the Auto cron would drop the workspace's other proposals",
    ).toBe(false);
  });
});

/* ── The halves above, executed ──────────────────────────────────────────── */

describe("areNotify honours the switch (executed, not read)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceNotifyUserId.mockResolvedValue(7);
  });

  const runWith = async (settingsRow: Record<string, unknown> | null, eventType: string) => {
    const rows = new Map<unknown, Record<string, unknown>[]>();
    if (settingsRow) rows.set(workspaceSettings, [settingsRow]);
    const { db, inserts, asked } = fakeDb(rows);
    mocks.getDb.mockResolvedValue(db);
    await areNotify({ workspaceId: 1, eventType: eventType as never, title: "t", body: "b" });
    return { inserts, asked };
  };

  it("writes nothing when the switch is off", async () => {
    const { inserts } = await runWith({ areNotifyOnMeetingBooked: false }, "meeting_booked");
    expect(inserts).toEqual([]);
  });

  it("writes when the switch is on", async () => {
    const { inserts } = await runWith({ areNotifyOnMeetingBooked: true }, "meeting_booked");
    expect(inserts.length).toBe(1);
    expect(inserts[0].values.kind).toBe("are_event");
  });

  it("writes when the workspace has no settings row at all", async () => {
    // The failure that would never be reported: getOrSeedSettings writes the
    // row lazily, so this is a normal state, and muting it would silence the
    // product's loudest signal for every workspace that never opened the page.
    const { inserts } = await runWith(null, "meeting_booked");
    expect(inserts.length).toBe(1);
  });

  it("an ungated event never even reads workspace_settings", async () => {
    const { inserts, asked } = await runWith({ areNotifyOnMeetingBooked: false }, "signal_classified");
    expect(inserts.length).toBe(1);
    expect(asked).not.toContain(workspaceSettings);
  });
});

describe("campaignHeadroom (executed)", () => {
  beforeEach(() => vi.clearAllMocks());

  const run = async (active: number, settingsRow: Record<string, unknown> | null) => {
    const rows = new Map<unknown, Record<string, unknown>[]>();
    rows.set(areCampaigns, [{ n: active }]);
    if (settingsRow) rows.set(workspaceSettings, [settingsRow]);
    const { db } = fakeDb(rows);
    mocks.getDb.mockResolvedValue(db);
    return campaignHeadroom(1);
  };

  it("has room below the limit and none at it", async () => {
    expect(await run(3, { max: 5 })).toEqual({ active: 3, max: 5, hasRoom: true });
    expect(await run(5, { max: 5 })).toEqual({ active: 5, max: 5, hasRoom: false });
    // Above it — the state every workspace with 6+ active campaigns is in
    // until migration 0184 raises their cap.
    expect((await run(9, { max: 5 })).hasRoom).toBe(false);
  });

  it("falls back to the schema default when the settings row is missing", async () => {
    expect(await run(2, null)).toEqual({ active: 2, max: 5, hasRoom: true });
  });

  it("fails OPEN with no database", async () => {
    // A cap that cannot be read must not become a lockout: the failure mode of
    // a start gate is refusing work that should have run.
    mocks.getDb.mockResolvedValue(null);
    expect((await campaignHeadroom(1)).hasRoom).toBe(true);
  });
});

describe("ARE Settings points at the real brand voice instead of owning a second one", () => {
  const page = read("client/src/pages/usip/ARESettings.tsx");

  it("the duplicate tone picker is gone", () => {
    // It wrote a column buildBrandContext() has never read, so a workspace
    // could set a tone here and get copy written in the tone set elsewhere.
    expect(page).not.toContain("areBrandVoice");
    expect(page).not.toContain("consultative");
    expect(read("server/routers/admin.ts")).not.toContain("areBrandVoice");
    expect(read("drizzle/schema.ts")).not.toMatch(/areBrandVoice:\s*varchar/);
  });

  it("the page sends the reader to the one editor, and warns about the master switch", () => {
    expect(page).toContain("/brand-voice");
    // brandContext.ts returns "" outright when applyToAI is false, so a page
    // that offers a voice without naming that switch is the same bug one layer
    // down: a control that appears to work and does nothing.
    expect(page).toContain("Apply to AI");
  });

  it("the ARE sequence writer still builds its prompt from the real profile", () => {
    expect(read("server/routers/are/prospects.ts")).toContain("buildBrandContext(campaign.workspaceId)");
    expect(read("server/services/brandContext.ts")).toMatch(/voice\.applyToAI === false/);
  });
});
