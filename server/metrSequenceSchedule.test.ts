/**
 * A sequence's own time zone and its waiting drafts (audit 2026-10-20, U15):
 * every IANA zone in sequence settings (the canvas panel listed twelve, the v2
 * editor none), the workspace's by default; and an "N drafts awaiting review"
 * banner on each sequence linking to exactly those drafts.
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
import { allTimezones, timezoneGroups, utcOffsetLabel } from "@shared/timezones";
import { feedSourceApplies } from "@shared/emailActivity";

const WS = 2, OTHER = 4;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "latin1").replace(/\r\n/g, "\n").replace(/\0/g, "");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "a@lsi.example", name: "A", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  rows("sequences").push(
    { id: 7, workspaceId: WS, name: "Q4", status: "paused", settings: { sendWindowStart: "09:00" }, isTemplate: false, ownerUserId: 1 },
    { id: 8, workspaceId: WS, name: "Other", status: "active", settings: {}, isTemplate: false, ownerUserId: 1 },
  );
});

describe("every time zone, the workspace's by default (U15)", () => {
  it("lists the runtime's whole IANA list, grouped, UTC first, with offsets", () => {
    const zones = allTimezones();
    expect(zones[0]).toBe("UTC");
    expect(zones.length).toBeGreaterThan(300);
    for (const z of ["America/Phoenix", "Asia/Kolkata", "America/Sao_Paulo", "Asia/Kathmandu", "Pacific/Auckland"]) expect(zones).toContain(z);
    expect(timezoneGroups().map((g) => g.region)).toEqual(expect.arrayContaining(["America", "Europe", "Asia", "Australia"]));
    // A fixed January instant: New York is on standard time, Kolkata a half-hour zone.
    const JAN = Date.UTC(2026, 0, 15, 12);
    expect(utcOffsetLabel("America/New_York", JAN)).toBe("UTC−05:00");
    expect(utcOffsetLabel("Asia/Kolkata", JAN)).toBe("UTC+05:30");
  });

  it("the picker's first choice is the workspace's zone, which stores none of the sequence's own", () => {
    const src = read("client/src/components/usip/TimezonePicker.tsx");
    expect(src).toContain("<option value={WORKSPACE_TZ}>{workspaceZone ? `Workspace time zone (${workspaceZone})` : \"Workspace time zone\"}</option>");
    // Both callers name the workspace's zone on it.
    expect(read("client/src/components/usip/SequenceScheduleSettings.tsx")).toContain("workspaceZone={wsZone}");
    expect(read("client/src/pages/usip/SequenceCanvas.tsx")).toContain("workspaceZone={workspaceZone}");
    expect(src).toContain("onChange(e.target.value === WORKSPACE_TZ ? null : e.target.value)");
    expect(src).toContain("timezoneGroups()");
  });

  it("the canvas panel and the v2 editor both use it", () => {
    const panel = read("client/src/components/usip/canvas/SequenceSettingsPanel.tsx");
    expect(panel).toContain("<TimezonePicker");
    expect(panel).not.toContain('"Australia/Sydney",');
    const editor = read("client/src/pages/usip/SequenceEditor.tsx");
    const settingsTab = editor.slice(editor.indexOf('{tab === "Settings" && ('));
    expect(settingsTab).toContain("<SequenceScheduleSettings sequenceId={id} settings={seq.settings}");
    expect(settingsTab).not.toContain("Change this sequence's window from its canvas");
    const card = read("client/src/components/usip/SequenceScheduleSettings.tsx");
    expect(card).toContain('<TimezonePicker label="Sequence time zone" value={zone} onChange={setZone}');
    expect(card).toContain("save.mutate({ id: sequenceId, settings: { timezone: zone, sendWindowStart: start, sendWindowEnd: end, skipWeekends } })");
  });

  it("saving keeps the rest of the settings, clears back to the workspace's zone, and refuses a zone that doesn't exist", async () => {
    await caller().sequences.updateMeta({ id: 7, settings: { timezone: "Asia/Kolkata", sendWindowEnd: "17:00", skipWeekends: false } });
    expect(rows("sequences").find((s: any) => s.id === 7).settings).toEqual({ sendWindowStart: "09:00", timezone: "Asia/Kolkata", sendWindowEnd: "17:00", skipWeekends: false });
    await caller().sequences.updateMeta({ id: 7, settings: { timezone: null } });
    expect(rows("sequences").find((s: any) => s.id === 7).settings.timezone).toBeUndefined();
    await expect(caller().sequences.updateMeta({ id: 7, settings: { timezone: "Mars/Olympus_Mons" } })).rejects.toThrow(/time zone/);
  });
});

describe("N drafts awaiting review, on each sequence (U15)", () => {
  beforeEach(() => {
    const d = (id: number, o: Record<string, unknown>) => rows("email_drafts").push({ id, workspaceId: WS, sequenceId: 7, status: "pending_review", subject: "s", body: "b", createdAt: new Date(), ...o });
    d(1, {});
    d(2, { status: "ai_pending_review" });
    d(3, { status: "approved" });
    d(4, { status: "sent" });
    d(5, { status: "rejected" });
    d(6, { sequenceId: 8 });
    d(7, { workspaceId: OTHER });
    d(8, { status: "approved" }); // its send left a log row: the log row's story, as on the Emails page
    rows("email_log").push({ id: 1, workspaceId: WS, draftId: 8, sequenceId: 7, source: "sequence", status: "failed", sentAt: new Date() });
  });

  it("counts this sequence's waiting drafts, as its link lists them", async () => {
    const w = await caller().emailActivity.sequenceDraftsWaiting({ sequenceId: 7 });
    expect(w).toEqual({ review: 2, approved: 1, total: 3, href: "/v2/emails?status=awaiting&sequence=7" });
    expect(await caller().emailActivity.sequenceDraftsWaiting({ sequenceId: 9 })).toMatchObject({ total: 0 });
  });

  it("the Emails page filters to one sequence: its sent mail and drafts only", async () => {
    rows("email_log").push(
      { id: 2, workspaceId: WS, sequenceId: 7, source: "sequence", status: "sent", sentAt: new Date(), subject: "a" },
      { id: 3, workspaceId: WS, sequenceId: 8, source: "sequence", status: "sent", sentAt: new Date(), subject: "b" },
    );
    const res = await caller().emailActivity.list({ status: "sent", sequenceId: 7 });
    expect(res.rows.map((r) => r.key)).toEqual(["log:2"]);
    // Campaign steps and inbound mail have no sequence, so they are not queried at all.
    const f = { direction: "all" as const, source: "all", status: "all", sequenceId: 7 };
    expect(feedSourceApplies(f, "queued")).toBe(false);
    expect(feedSourceApplies(f, "inbound")).toBe(false);
    expect(feedSourceApplies(f, "draft")).toBe(true);
    expect(feedSourceApplies(f, "log")).toBe(true);
    const src = read("server/routers/emailActivity.ts");
    expect(src).toContain("if (input.sequenceId) conds.push(eq(emailDrafts.sequenceId, input.sequenceId));");
  });

  it("the banner is on the v2 editor and the canvas, hidden at zero, and the Emails page reads ?sequence=", () => {
    const banner = read("client/src/components/usip/SequenceReviewBanner.tsx");
    expect(banner).toContain("if (!d || d.total === 0) return null;");
    expect(banner).toContain("awaiting review");
    expect(banner).toContain("<Link href={d.href}");
    expect(read("client/src/pages/usip/SequenceEditor.tsx")).toContain("<SequenceReviewBanner sequenceId={id}");
    expect(read("client/src/pages/usip/SequenceCanvas.tsx")).toContain("<SequenceReviewBanner sequenceId={sequenceId}");
    const emails = read("client/src/pages/usip/EmailsV2.tsx");
    expect(emails).toContain('const n = Number(initial.get("sequence"));');
    expect(emails).toContain("...(sequenceFilter ? { sequenceId: sequenceFilter } : {})");
    expect(emails).toContain('aria-label="Show every sequence\'s mail"');
  });
});
