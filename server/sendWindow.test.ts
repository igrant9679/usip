/**
 * The workspace send window (owner ask 2026-09-25: "Build the send window,
 * 6 AM–5 PM weekdays", adjustable per workspace). Velocity was sending at any
 * hour: Autonomous meeting invites went out at 8:36 PM, and Revenue Engine
 * emails, reminders and auto-replies had no window at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { emailReplies, unipileAccounts, unipileMessages, workspaceSettings } from "../drizzle/schema";
import {
  DEFAULT_SEND_WINDOW, describeSendWindow, formatSendDays, isWithinSendWindow, normalizeSendWindow, parseSendDays,
} from "@shared/sendWindow";

const h = vi.hoisted(() => ({ db: null as any, sendEmail: null as any, sendDm: null as any, bookingUrl: "https://getvelocityai.app/b/khaja", tier: "chat" as string | null }));
vi.mock("./db", async (importActual) => ({ ...(await importActual<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./emailDelivery", async (importActual) => ({ ...(await importActual<typeof import("./emailDelivery")>()), sendWorkspaceEmail: (...a: unknown[]) => h.sendEmail(...a) }));
vi.mock("./lib/unipile", async (importActual) => ({ ...(await importActual<typeof import("./lib/unipile")>()), sendMessage: (...a: unknown[]) => h.sendDm(...a) }));
vi.mock("./mergeVars", async (importActual) => ({ ...(await importActual<typeof import("./mergeVars")>()), resolveBookingUrl: async () => h.bookingUrl }));
vi.mock("./_core/workspaceArchive", async (importActual) => ({ ...(await importActual<typeof import("./_core/workspaceArchive")>()), archivedWorkspaceIds: async () => new Set<number>() }));
// The real gate (socialAutopilotMaySend) with a chosen conversation tier.
vi.mock("./services/replyScope", async (importActual) => ({
  ...(await importActual<typeof import("./services/replyScope")>()),
  resolveSocialOutreachScope: async () => ({ tier: h.tier, linkedContactId: null, linkedLeadId: null }),
}));
vi.mock("./_core/activeMembers", async (importActual) => ({ ...(await importActual<typeof import("./_core/activeMembers")>()), activeOwnerOrNull: async (_w: number, u: number | null) => u }));

import { getWorkspaceSendWindow, inSendWindow, invalidateSendWindowCache } from "./services/sendWindow";
import { HELD_BOOKING_LINK_MAX_AGE_MS, sendHeldBookingLinks } from "./services/replyClassifier";

const NY = "America/New_York";
// Wednesday 2026-09-30, and Saturday 2026-10-03 (EDT = UTC−4).
const wedNY = (h: number, m = 0) => Date.UTC(2026, 8, 30, h + 4, m);
const satNY = (h: number) => Date.UTC(2026, 9, 3, h + 4, 0);

describe("the window rule", () => {
  it("defaults to 6 AM–5 PM, Mon–Fri", () => {
    expect(DEFAULT_SEND_WINDOW).toEqual({ startHour: 6, endHour: 17, days: [1, 2, 3, 4, 5] });
    expect(describeSendWindow(DEFAULT_SEND_WINDOW)).toBe("6:00 AM–5:00 PM, Mon–Fri");
  });

  it("opens at 6:00 and closes at 17:00 sharp, in the workspace's zone", () => {
    const w = DEFAULT_SEND_WINDOW;
    expect(isWithinSendWindow(wedNY(5, 59), NY, w)).toBe(false);
    expect(isWithinSendWindow(wedNY(6, 0), NY, w)).toBe(true);
    expect(isWithinSendWindow(wedNY(16, 59), NY, w)).toBe(true);
    expect(isWithinSendWindow(wedNY(17, 0), NY, w)).toBe(false);
    expect(isWithinSendWindow(wedNY(20, 36), NY, w)).toBe(false); // the 8:36 PM invites
  });

  it("the same instant is judged in the workspace's zone, not UTC", () => {
    // 5:30 AM in New York is 9:30 UTC.
    expect(isWithinSendWindow(wedNY(5, 30), "UTC", DEFAULT_SEND_WINDOW)).toBe(true);
    expect(isWithinSendWindow(wedNY(5, 30), NY, DEFAULT_SEND_WINDOW)).toBe(false);
  });

  it("weekends are closed unless chosen", () => {
    expect(isWithinSendWindow(satNY(10), NY, DEFAULT_SEND_WINDOW)).toBe(false);
    expect(isWithinSendWindow(satNY(10), NY, { startHour: 6, endHour: 17, days: [6] })).toBe(true);
  });

  it("an unusable window falls back to the default hours; days parse strictly", () => {
    expect(normalizeSendWindow({ startHour: 18, endHour: 9, days: "1,2" })).toEqual({ startHour: 6, endHour: 17, days: [1, 2] });
    expect(parseSendDays("5,1,1,9,x")).toEqual([1, 5]);
    expect(parseSendDays("")).toEqual([1, 2, 3, 4, 5]);
    expect(formatSendDays([5, 1, 3])).toBe("1,3,5");
    expect(describeSendWindow({ startHour: 8, endHour: 24, days: [0, 6] })).toBe("8:00 AM–midnight, Sun, Sat");
  });
});

// ── The server read ────────────────────────────────────────────────────────
let settingsRow: Record<string, unknown> | null;
let readFails = false;
type Cap = { updates: { table: unknown; set: any; where: unknown }[] };
let cap: Cap;
let pendingEmails: any[];
let pendingDms: any[];

function makeDb() {
  const b = (fields?: Record<string, unknown>) => {
    const st: { table?: unknown } = {};
    const q: any = {
      from(t: unknown) { st.table = t; return q; }, where() { return q; }, limit() { return q; }, orderBy() { return q; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) {
        if (st.table === workspaceSettings) {
          if (readFails) return rej(new Error("db down"));
          return res(settingsRow ? [settingsRow] : []);
        }
        if (st.table === emailReplies) return res(pendingEmails);
        if (st.table === unipileMessages) return res(pendingDms);
        if (st.table === unipileAccounts) return res([{ userId: 5721 }]);
        return res([]);
      },
    };
    return q;
  };
  return {
    select: (fields?: Record<string, unknown>) => b(fields),
    update: (t: unknown) => { const u: any = { table: t }; const q: any = { set(v: any) { u.set = v; return q; }, where(c: unknown) { u.where = c; cap.updates.push(u); return Promise.resolve([]); } }; return q; },
  };
}

beforeEach(() => {
  invalidateSendWindowCache();
  settingsRow = { timezone: NY, startHour: 6, endHour: 17, days: "1,2,3,4,5" };
  readFails = false;
  cap = { updates: [] };
  pendingEmails = [];
  pendingDms = [];
  h.db = makeDb();
  h.sendEmail = vi.fn().mockResolvedValue({ ok: true });
  h.sendDm = vi.fn().mockResolvedValue({ id: "m1" });
  h.tier = "chat";
});

describe("inSendWindow", () => {
  it("reads the workspace's own window and zone", async () => {
    settingsRow = { timezone: NY, startHour: 9, endHour: 12, days: "3" };
    expect(await getWorkspaceSendWindow(4)).toEqual({ timezone: NY, window: { startHour: 9, endHour: 12, days: [3] } });
    expect(await inSendWindow(4, wedNY(10))).toBe(true);
    invalidateSendWindowCache(4);
    expect(await inSendWindow(4, wedNY(13))).toBe(false);
  });

  it("a failed read falls back to the DEFAULT window, never to always-open", async () => {
    readFails = true;
    expect(await inSendWindow(4, Date.UTC(2026, 8, 30, 3, 0))).toBe(false); // 3 AM UTC
    invalidateSendWindowCache(4);
    expect(await inSendWindow(4, Date.UTC(2026, 8, 30, 10, 0))).toBe(true);
  });

  it("a saved change applies at once: Settings clears the cache", () => {
    const admin = readFileSync("server/routers/admin.ts", "utf8");
    expect(admin).toContain("invalidateSendWindowCache(ctx.workspace.id);");
  });
});

describe("held booking-link replies", () => {
  const now = wedNY(10);

  it("inside the window: sent, and the pending mark cleared as sent", async () => {
    pendingEmails = [{ id: 71, workspaceId: 4, userId: 5721, fromEmail: "ada@example.org", fromName: "Ada Lovelace", subject: "Intro", pendingAt: new Date(now - 12 * 3_600_000) }];
    expect(await sendHeldBookingLinks(now)).toEqual({ sent: 1, held: 0, dropped: 0 });
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect(h.sendEmail.mock.calls[0][1]).toMatchObject({ to: "ada@example.org", subject: "Re: Intro" });
    expect(h.sendEmail.mock.calls[0][1].html).toContain(h.bookingUrl);
    expect(cap.updates[0].set).toEqual({ bookingLinkPendingAt: null, autoActionTaken: "booking_link_sent" });
  });

  it("still outside the window: left pending, nothing sent", async () => {
    pendingEmails = [{ id: 71, workspaceId: 4, userId: 5721, fromEmail: "ada@example.org", fromName: "Ada", subject: null, pendingAt: new Date(now) }];
    expect(await sendHeldBookingLinks(satNY(10))).toEqual({ sent: 0, held: 1, dropped: 0 });
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(cap.updates).toEqual([]);
  });

  it("older than a week: dropped, never sent", async () => {
    pendingEmails = [{ id: 71, workspaceId: 4, userId: 5721, fromEmail: "ada@example.org", fromName: "Ada", subject: null, pendingAt: new Date(now - HELD_BOOKING_LINK_MAX_AGE_MS - 1) }];
    expect(await sendHeldBookingLinks(now)).toEqual({ sent: 0, held: 0, dropped: 1 });
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(cap.updates[0].set).toEqual({ bookingLinkPendingAt: null });
  });

  it("a failed send clears the mark too: never sent twice", async () => {
    h.sendEmail.mockResolvedValue({ ok: false, reason: "smtp down" });
    pendingEmails = [{ id: 71, workspaceId: 4, userId: 5721, fromEmail: "ada@example.org", fromName: "Ada", subject: null, pendingAt: new Date(now) }];
    expect(await sendHeldBookingLinks(now)).toEqual({ sent: 0, held: 0, dropped: 0 });
    expect(cap.updates[0].set).toEqual({ bookingLinkPendingAt: null });
  });

  it("a held LinkedIn one goes in-thread once the window opens", async () => {
    pendingDms = [{ id: 81, workspaceId: 4, chatId: "chat-9", senderName: "Bo Diddley", unipileAccountId: "acc-li", senderProviderId: "p-9", pendingAt: new Date(now) }];
    expect(await sendHeldBookingLinks(now)).toEqual({ sent: 1, held: 0, dropped: 0 });
    expect(h.sendDm).toHaveBeenCalledWith({ chatId: "chat-9", text: expect.stringContaining(h.bookingUrl) });
    expect(h.sendDm.mock.calls[0][0].text).toContain("Great to hear, Bo!");
    expect(cap.updates[0].set).toEqual({ bookingLinkPendingAt: null, autoActionTaken: "booking_link_sent" });
  });

  it("the outreach gate is re-checked at send time: a conversation we never started gets nothing", async () => {
    h.tier = "invite"; // an accepted invite alone is not consent to receive our link
    pendingDms = [{ id: 81, workspaceId: 4, chatId: "chat-9", senderName: "Bo", unipileAccountId: "acc-li", senderProviderId: "p-9", pendingAt: new Date(now) }];
    expect(await sendHeldBookingLinks(now)).toEqual({ sent: 0, held: 0, dropped: 0 });
    expect(h.sendDm).not.toHaveBeenCalled();
    expect(cap.updates[0].set).toEqual({ bookingLinkPendingAt: null });
  });

  it("held email links are read only from genuine replies to our outreach", () => {
    expect(readFileSync("server/services/replyClassifier.ts", "utf8"))
      .toContain("}).from(emailReplies).where(and(isNotNull(emailReplies.bookingLinkPendingAt), genuineReplyScope())).limit(100);");
  });
});

describe("every sender that goes out on its own waits for the window", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("Revenue Engine dispatch", () => {
    const s = read("server/areEngine.ts");
    expect(s).toContain("const windowOpen = await inSendWindow(wsId);");
    expect(s).toContain("const due = !windowOpen ? [] : await db");
  });
  it("sequence auto-send and the sequence LinkedIn DM step", () => {
    expect(read("server/routers/sequences.ts")).toContain("if (!(await inSendWindow(ws.workspaceId))) continue;");
    expect(read("server/sequenceEngine.ts")).toContain('if (step.type === "linkedin_dm" && !(await inSendWindow(enrollment.workspaceId))) {');
  });
  it("Autonomous meeting invites, and meeting reminders", () => {
    expect(read("server/services/meetingScheduler.ts")).toContain('if (ws.meetingAutopilotMode === "auto" && !(await inSendWindow(ws.workspaceId))) continue;');
    expect(read("server/services/meetingReminders.ts")).toContain("if (!(await inSendWindow(m.workspaceId))) continue;");
  });
  it("chat follow-ups", () => {
    expect(read("server/services/chatFollowUp.ts")).toContain('if (agent.followUpMode === "auto" && !(await inSendWindow(agent.workspaceId))) continue;');
  });
  it("booking-link auto-replies are held, not dropped, and swept every tick", () => {
    const s = read("server/services/replyClassifier.ts").replace(/\r\n/g, "\n");
    // The hold is decided by the window, on both paths.
    expect(s).toContain("        if (!(await inSendWindow(workspaceId))) {\n          // Outside the workspace send window (owner ask 2026-09-25): held,");
    expect(s).toContain("        if (!(await inSendWindow(workspaceId))) {\n          // Held for the workspace send window, as the email path is.");
    expect(s).toContain("await db.update(emailReplies).set({ bookingLinkPendingAt: new Date() } as never)");
    expect(s).toContain("await db.update(unipileMessages).set({ bookingLinkPendingAt: new Date() } as never)");
    expect(s).toContain("const held = await sendHeldBookingLinks();");
  });
  it("Settings refuses a window that never opens, and stores the days as text", () => {
    const admin = read("server/routers/admin.ts");
    expect(admin).toContain("sendWindowDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),");
    expect(admin).toContain("const start = input.sendWindowStartHour ?? current.sendWindowStartHour;");
    expect(admin).toContain("const end = input.sendWindowEndHour ?? current.sendWindowEndHour;");
    expect(admin).toContain('if (!(start < end)) {\n          throw new TRPCError({ code: "BAD_REQUEST", message: "The send window must start before it ends." });');
    expect(admin).toContain("if (input.sendWindowDays !== undefined) patch.sendWindowDays = formatSendDays(input.sendWindowDays);");
  });

  it("the migration and the Settings page", () => {
    const mig = read("server/_core/rawMigrations.ts");
    expect(mig).toContain("\"ALTER TABLE `workspace_settings` ADD COLUMN `sendWindowStartHour` int NOT NULL DEFAULT 6\"");
    expect(mig).toContain("\"ALTER TABLE `workspace_settings` ADD COLUMN `sendWindowEndHour` int NOT NULL DEFAULT 17\"");
    expect(mig).toContain("\"ALTER TABLE `workspace_settings` ADD COLUMN `sendWindowDays` varchar(20) NOT NULL DEFAULT '1,2,3,4,5'\"");
    const page = read("client/src/pages/usip/Settings.tsx");
    expect(page).toContain("<SendWindowSection settings={settings} save={save} canEdit={canEdit} />");
    expect(page).toContain("save({ sendWindowStartHour: startHour, sendWindowEndHour: endHour, sendWindowDays: days })");
  });
});
