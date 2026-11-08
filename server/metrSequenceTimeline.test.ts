/**
 * A timeline preview per sequence (audit 2026-10-20, U4): the real send dates
 * after waits, windows, weekends and time zone. The preview walks the steps
 * with the functions the engine runs on (@shared/sequenceTimeline, imported by
 * server/sequenceEngine.ts) — never a second copy of the rules — and this file
 * pins that they agree: the real engine is run over one enrolment on a fake
 * clock, through a weekend, a clock change, a window that opens before the
 * workspace's, a wait, a task, a LinkedIn step and a retired step, and every
 * step happens when the preview says it will.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, tz: "America/New_York", paused: false }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./_core/workspaceArchive", async (a) => ({ ...(await a<typeof import("./_core/workspaceArchive")>()), archivedWorkspaceIds: async () => new Set<number>() }));
// The workspace send window, as the engine's LinkedIn gate reads it, on the fake clock.
vi.mock("./services/sendWindow", async (a) => {
  const real = await a<typeof import("./services/sendWindow")>();
  const { isWithinSendWindow } = await import("@shared/sendWindow");
  return {
    ...real,
    inSendWindow: async () => !h.paused && isWithinSendWindow(Date.now(), h.tz, { startHour: 8, endHour: 17, days: [1, 2, 3, 4, 5] }),
    getWorkspaceSendWindow: async () => ({ timezone: h.tz, window: { startHour: 8, endHour: 17, days: [1, 2, 3, 4, 5] }, paused: h.paused }),
  };
});
vi.mock("./services/workspaceTimezone", async (a) => ({ ...(await a<typeof import("./services/workspaceTimezone")>()), getWorkspaceTimezone: async () => h.tz }));
vi.mock("./services/outboundPause", async (a) => ({ ...(await a<typeof import("./services/outboundPause")>()), isOutboundPaused: async () => h.paused, assertOutboundNotPaused: async () => {} }));
vi.mock("./mergeVars", async (a) => ({ ...(await a<typeof import("./mergeVars")>()), resolveBookingUrl: async () => "", buildMergeContextFromDb: async () => ({}) }));
vi.mock("./campaignCounters", async (a) => ({ ...(await a<typeof import("./campaignCounters")>()), bumpCampaignCounter: async () => {} }));
vi.mock("./services/crossEngineEnrollment", async (a) => ({
  ...(await a<typeof import("./services/crossEngineEnrollment")>()),
  resolveToPeopleIds: async () => ({ prospectIds: [] }),
  activeCampaignsForProspects: async () => new Map(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { processEnrollments } from "./sequenceEngine";
import { isWithinSendWindow, nextSendWindowOpening } from "@shared/sendWindow";
import { projectTimeline, waitDueAt, nextSequenceWindowOpen, sequenceWindowOf } from "@shared/sequenceTimeline";

const WS = 2;
const REP = 21;
const NY = "America/New_York";
const WSW = { startHour: 8, endHour: 17, days: [1, 2, 3, 4, 5] };
const rows = (t: string) => h.db.rowsOf(t) as any[];
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
// Saturday 2026-10-31, 21:00 in New York (EDT) — the night before the clock goes back.
const START = Date.UTC(2026, 10, 1, 1, 0);

const STEPS = [
  { type: "email", subject: "Intro", body: "Hi" },
  { type: "wait", days: 2 },
  { type: "email", subject: "Follow-up", body: "Hi again" },
  { type: "task", body: "Call them" },
  // Ends on a Saturday morning, so the LinkedIn step waits for Monday's workspace window.
  { type: "wait", days: 3 },
  { type: "linkedin_invite", note: "" },
  { type: "wait", days: 1 },
  { type: "email", subject: "Retired", body: "x", enabled: false },
  { type: "email", subject: "Last note", body: "Bye" },
];
// The sequence drafts from 07:00, an hour before the workspace window opens, so an
// early draft waits for that window to go out, and the next step waits for it.
const SETTINGS = { sendWindowStart: "07:00", sendWindowEnd: "17:00", skipWeekends: true };

function seed(settings: Record<string, unknown> = SETTINGS) {
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: REP, archivedAt: null, plan: "trial" });
  rows("users").push({ id: REP, openId: "local:21", name: "Rep", email: "rep@lsi.example", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: REP, role: "admin", deactivatedAt: null, lastActiveAt: new Date(), inviteToken: null, createdAt: new Date() });
  rows("leads").push({ id: 201, workspaceId: WS, firstName: "Ann", lastName: "Lee", email: "ann@acme.example", title: null, company: "Acme", customFields: null });
  rows("sequences").push({
    id: 1, workspaceId: WS, name: "Timeline", description: null, status: "active", steps: STEPS, settings,
    dailyCap: null, ownerUserId: REP, assignedToUserId: null, enrollmentTrigger: null, exitConditions: null,
    isTemplate: false, visibility: "team", sourceTemplateId: null, enrolledCount: 0, createdAt: new Date(), updatedAt: new Date(),
  });
  rows("enrollments").push({ id: 1, workspaceId: WS, sequenceId: 1, contactId: null, leadId: 201, prospectId: null, status: "active", currentStep: 0, startedAt: new Date(START), nextActionAt: new Date(START), resumeAt: null });
}

const caller = () => appRouter.createCaller({
  user: rows("users")[0],
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

/**
 * Run the real engine over the enrolment, jumping the clock to each moment it
 * is due (what its five-minute ticks do, without the ticks). Each draft is
 * "auto-sent" the first moment the workspace window is open, which is the
 * world the preview assumes. Returns when each step ran and when each email
 * was drafted.
 */
async function runEngine(): Promise<{ ran: Map<number, number>; drafted: Map<number, number>; tasks: number[] }> {
  const ran = new Map<number, number>();
  const drafted = new Map<number, number>();
  const sendAt = new Map<number, number>();
  for (let guard = 0; guard < 300; guard++) {
    const e = rows("enrollments")[0];
    if (e.status !== "active") break;
    const due = new Date(e.nextActionAt).getTime();
    vi.setSystemTime(new Date(Math.max(Date.now(), due)));
    for (const d of rows("email_drafts")) {
      const at = sendAt.get(d.id);
      if (at !== undefined && at <= Date.now() && d.status !== "sent") { d.status = "sent"; d.sentAt = new Date(at); }
    }
    const before = e.currentStep;
    await processEnrollments();
    if (e.currentStep !== before) ran.set(before, Date.now());
    for (const d of rows("email_drafts")) {
      if (sendAt.has(d.id)) continue;
      const now = Date.now();
      drafted.set(d.stepIndex, now);
      sendAt.set(d.id, isWithinSendWindow(now, NY, WSW) ? now : nextSendWindowOpening(now, NY, WSW)!);
    }
  }
  return { ran, drafted, tasks: rows("tasks").map((t: any) => new Date(t.createdAt).getTime()) };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(START)); h.tz = NY; h.paused = false; });
afterEach(() => { vi.useRealTimers(); });

describe("the preview and the engine agree (U4)", () => {
  it("every step, on a fixture through a weekend, a clock change, an early window, a wait, a task, LinkedIn and a retired step", async () => {
    seed();
    const preview = projectTimeline(STEPS as any, { startMs: START, settings: SETTINGS, workspaceZone: NY, workspaceWindow: WSW });
    const engine = await runEngine();
    expect(rows("enrollments")[0].status).toBe("finished");
    for (const entry of preview.entries) {
      expect(engine.ran.get(entry.index), `step ${entry.index} (${entry.type})`).toBe(entry.atMs);
      if (entry.type === "email" && !entry.skipped) expect(engine.drafted.get(entry.index), `draft ${entry.index}`).toBe(entry.atMs);
    }
    // Three emails drafted (the retired one never is), one task.
    expect(engine.drafted.size).toBe(3);
    expect(engine.tasks).toEqual([preview.entries[3]!.atMs]);
    // The LinkedIn step came due on Saturday and waited for Monday 08:00 in New York.
    expect(preview.entries[5]).toMatchObject({ type: "linkedin_invite", notes: ["Waits for the workspace send window."] });
    expect(new Date(preview.entries[5]!.atMs!).toISOString()).toBe("2026-11-09T13:03:00.000Z");
  });

  it("and the dates are the ones a person expects: Monday's window after the weekend, in New York's new offset", () => {
    const p = projectTimeline(STEPS as any, { startMs: START, settings: SETTINGS, workspaceZone: NY, workspaceWindow: WSW });
    const at = (i: number) => new Date(p.entries[i]!.atMs!).toISOString();
    // Monday 2 Nov 07:00 EST (12:00 UTC): drafted at the sequence's opening…
    expect(at(0)).toBe("2026-11-02T12:00:00.000Z");
    // …sent at 08:00 when the workspace window opens…
    expect(new Date(p.entries[0]!.sentAtMs!).toISOString()).toBe("2026-11-02T13:00:00.000Z");
    expect(p.entries[0]!.notes).toEqual(expect.arrayContaining(["Weekend: waits for Monday's window.", "Goes out when the workspace send window opens."]));
    // …and the wait starts once it has gone (the quarter-hour re-check after 08:00), counted once.
    expect(at(1)).toBe("2026-11-02T13:01:00.000Z");
    expect(new Date(p.entries[1]!.untilMs!).toISOString()).toBe("2026-11-04T13:01:00.000Z");
    expect(p.emailZone).toBe(NY);
    expect(p.zoneSource).toBe("workspace");
  });

  it("with recipient time on, an example person's zone moves the email steps", async () => {
    const settings = { ...SETTINGS, recipientTime: true };
    const p = projectTimeline(STEPS as any, { startMs: START, settings, workspaceZone: NY, workspaceWindow: WSW, recipient: { timezone: "America/Los_Angeles" } });
    expect(p.emailZone).toBe("America/Los_Angeles");
    expect(p.zoneSource).toBe("stored");
    // 07:00 in Los Angeles on Monday = 15:00 UTC; New York's window is open then, so it goes at once.
    expect(new Date(p.entries[0]!.atMs!).toISOString()).toBe("2026-11-02T15:00:00.000Z");
    expect(p.entries[0]!.sentAtMs).toBe(p.entries[0]!.atMs);
  });

  it("the engine imports these rules and keeps no copy of its own", () => {
    const engine = read("server/sequenceEngine.ts");
    expect(engine).toContain('} from "@shared/sequenceTimeline";');
    for (const fn of ["inSequenceWindow", "nextSequenceWindowOpen", "sequenceWindowOf", "stepWaitDays", "waitDueAt", "STEP_GAP_MS", "HOLD_RECHECK_MS"]) {
      expect(engine.slice(engine.indexOf("import {\n  HOLD_RECHECK_MS"), engine.indexOf('} from "@shared/sequenceTimeline";'))).toContain(fn);
    }
    expect(engine).not.toContain("function inSequenceWindow(");
    expect(engine).not.toContain("const STEP_GAP_MS =");
    expect(engine).not.toContain("const HOLD_RECHECK_MS =");
    expect(engine).not.toContain("(step.waitDays ?? 1) * 86_400_000");
    // And the shared rules are what they were.
    expect(waitDueAt(1000, 5000, 2)).toBe(5000 + 2 * 86_400_000);
    expect(waitDueAt(9000, 5000, undefined)).toBe(9000 + 86_400_000);
    const cfg = sequenceWindowOf({}, "UTC");
    expect(cfg).toEqual({ timezone: "UTC", sendWindowStart: "08:00", sendWindowEnd: "18:00", skipWeekends: true });
    // Saturday 12:00 UTC → Monday 08:00 UTC.
    expect(new Date(nextSequenceWindowOpen(cfg, Date.UTC(2026, 10, 7, 12))).toISOString()).toBe("2026-11-09T08:00:00.000Z");
  });
});

describe("the preview, on the server and on the page (U4)", () => {
  it("sequenceTimeline.preview projects this sequence, in this workspace only, and says what it assumes", async () => {
    seed();
    const r = await caller().sequenceTimeline.preview({ sequenceId: 1, startAt: new Date(START).toISOString() });
    const p = projectTimeline(STEPS as any, { startMs: START, settings: SETTINGS, workspaceZone: NY, workspaceWindow: WSW });
    expect(r.entries).toEqual(p.entries);
    expect(r).toMatchObject({ emailZone: NY, workspaceZone: NY, outboundPaused: false, sequenceWindow: { start: "07:00", end: "17:00", skipWeekends: true } });
    expect(r.assumptions.length).toBeGreaterThan(0);
    rows("sequences")[0].workspaceId = 9;
    await expect(caller().sequenceTimeline.preview({ sequenceId: 1 })).rejects.toThrow(/NOT_FOUND/);
  });

  it("the v2 editor shows it", () => {
    const editor = read("client/src/pages/usip/SequenceEditor.tsx");
    expect(editor).toContain("<SequenceTimelinePreview sequenceId={id}");
    const card = read("client/src/components/usip/SequenceTimelinePreview.tsx");
    expect(card).toContain("trpc.sequenceTimeline.preview.useQuery(");
    expect(card).toContain("data.outboundPaused");
    expect(card).toContain("data.assumptions");
  });
});
