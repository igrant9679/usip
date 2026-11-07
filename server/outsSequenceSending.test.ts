/**
 * Per-sequence review-or-auto-send (audit 2026-10-20, F22) and recipient-time
 * sending (F18): the rules, the worker's wiring and the screens. The engine's
 * behaviour with recipient time on is exercised in phase1Sends ("a sequence
 * can send in each person's time zone…").
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
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { autoSendGroups, describeSequenceAutoSend, sequenceAutoSend } from "@shared/sequenceAutoSend";
import { nextSendAt, nextWindowOpening, recipientZone, validZone } from "@shared/recipientTime";

const WS = 2;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "a@lsi.example", name: "A", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

/* ── F22 ────────────────────────────────────────────────────────────────── */

describe("each sequence can review or auto-send for itself (F22)", () => {
  const wsOn = { aiAutoSendEnabled: true, aiAutoSendScoreMin: 70, aiAutoSendAllowUnscored: false };
  const wsOff = { ...wsOn, aiAutoSendEnabled: false };

  it("a sequence that says nothing follows the workspace, exactly as before", () => {
    expect(sequenceAutoSend(null)).toEqual({ mode: "workspace", scoreMin: null, allowUnscored: null });
    expect(sequenceAutoSend({ autoSend: "nonsense" }).mode).toBe("workspace");
    expect(autoSendGroups(wsOn, [{ id: 1, settings: {} }, { id: 2, settings: null }]))
      .toEqual([{ kind: "workspace", sequenceId: null, exceptIds: [], scoreMin: 70, allowUnscored: false, scorePeople: false }]);
    expect(autoSendGroups(wsOff, [{ id: 1, settings: {} }])).toEqual([]);
  });

  it("'review' keeps a sequence out even when the workspace auto-sends", () => {
    const g = autoSendGroups(wsOn, [{ id: 1, settings: { autoSend: "review" } }, { id: 2, settings: {} }]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ kind: "workspace", exceptIds: [1] });
  });

  it("'auto' sends at its own threshold, scores people too, even with the workspace switch off", () => {
    const g = autoSendGroups(wsOff, [{ id: 3, settings: { autoSend: "auto", autoSendScoreMin: 40, autoSendAllowUnscored: true } }]);
    expect(g).toEqual([{ kind: "sequence", sequenceId: 3, exceptIds: [], scoreMin: 40, allowUnscored: true, scorePeople: true }]);
    // Unset threshold and unscored choice fall back to the workspace's.
    const g2 = autoSendGroups(wsOn, [{ id: 3, settings: { autoSend: "auto" } }]);
    expect(g2).toEqual([
      { kind: "workspace", sequenceId: null, exceptIds: [3], scoreMin: 70, allowUnscored: false, scorePeople: false },
      { kind: "sequence", sequenceId: 3, exceptIds: [], scoreMin: 70, allowUnscored: false, scorePeople: true },
    ]);
    expect(sequenceAutoSend({ autoSend: "auto", autoSendScoreMin: 140 }).scoreMin).toBe(100);
  });

  it("says what will happen, in words", () => {
    expect(describeSequenceAutoSend({ mode: "workspace", scoreMin: null, allowUnscored: null }, wsOff)).toContain("auto-send is off");
    expect(describeSequenceAutoSend({ mode: "review", scoreMin: null, allowUnscored: null }, wsOn)).toContain("waits for a person");
    expect(describeSequenceAutoSend({ mode: "auto", scoreMin: 40, allowUnscored: null }, wsOff)).toContain("scoring 40 or more");
  });

  it("the worker sends by these groups, inside the send window that the pause keeps shut", () => {
    const seq = readFileSync(join(__dirname, "routers", "sequences.ts"), "latin1").replace(/\r\n/g, "\n");
    const fn = seq.slice(seq.indexOf("export async function autoSendForAllWorkspaces"), seq.indexOf("export const emailDraftsRouter"));
    expect(fn).toContain(".map((ws) => ({ ws, groups: autoSendGroups(ws, seqsByWs.get(ws.workspaceId) ?? []) }))");
    expect(fn).toContain('list.some((s) => sequenceAutoSend(s.settings).mode === "auto")');
    // The pause: the window check comes before any group is read.
    const perWs = fn.slice(fn.indexOf("for (const { ws, groups } of targets) {"));
    expect(perWs.indexOf("if (!(await inSendWindow(ws.workspaceId))) continue;")).toBeGreaterThan(-1);
    expect(perWs.indexOf("if (!(await inSendWindow(ws.workspaceId))) continue;")).toBeLessThan(perWs.indexOf("for (const group of groups) {"));
    // Each group's scope and gate are in the candidates' WHERE, and the 50-a-tick budget is per workspace.
    const cand = fn.slice(fn.indexOf("const candidatesAfter = (afterId: number) => db"), fn.indexOf(".limit(50); // bounded per workspace per tick"));
    expect(cand).toContain("groupScope,");
    expect(cand).toContain("sendableGate,");
    expect(fn).toContain("group.kind === \"sequence\" && group.sequenceId != null");
    expect(fn).toContain("notInArray(emailDrafts.sequenceId, group.exceptIds)");
    expect(fn).toContain("ELSE ${priorityScoreResults.priorityScore} END");
    expect(fn).toContain("eq(priorityScoreResults.workspaceId, emailDrafts.workspaceId), eq(priorityScoreResults.objectType, \"person\")");
  });

  it("the sequence's Settings tab sets it, saving 'follow the workspace' as no setting at all", () => {
    const editor = read("client/src/pages/usip/SequenceEditor.tsx");
    expect(editor).toContain("<SequenceSendingSettings sequenceId={id} settings={seq.settings} accent={accent} />");
    const panel = read("client/src/components/usip/SequenceSendingSettings.tsx");
    expect(panel).toContain('autoSend: mode === "workspace" ? null : mode,');
    expect(panel).toContain("recipientTime: recipientTime ? true : null,");
    expect(panel).toContain("trpc.sequences.updateMeta.useMutation");
    expect(panel).toContain("Nothing sends while outbound is paused");
  });
});

/* ── F18 ────────────────────────────────────────────────────────────────── */

describe("recipient-time sending picks the person's zone and the window's next opening (F18)", () => {
  const W = { sendWindowStart: "08:00", sendWindowEnd: "18:00", skipWeekends: true };

  it("the zone: stored, else told from state/province, else the sequence's", () => {
    expect(recipientZone({ timezone: "Europe/London", state: "CA" }, "America/New_York")).toEqual({ zone: "Europe/London", source: "stored" });
    expect(recipientZone({ timezone: "Mars/Olympus", state: "CA", country: "US" }, "America/New_York")).toEqual({ zone: "America/Los_Angeles", source: "location" });
    expect(recipientZone({ state: "ON", country: "Canada" }, "UTC")).toEqual({ zone: "America/Toronto", source: "location" });
    expect(recipientZone({ state: "Bavaria", country: "Germany" }, "America/Chicago")).toEqual({ zone: "America/Chicago", source: "sequence" });
    expect(recipientZone(null, "not a zone")).toEqual({ zone: "UTC", source: "sequence" });
    expect(validZone("Asia/Kolkata")).toBe("Asia/Kolkata");
  });

  it("the next opening, in that zone, across the weekend and a :30 offset (fixed dates)", () => {
    const tue = Date.parse("2026-11-10T12:00:00Z"); // Tuesday
    expect(nextWindowOpening(tue, "Europe/London", W)).toBe(tue); // 12:00 London: open now
    expect(new Date(nextWindowOpening(tue, "America/Los_Angeles", W)!).toISOString()).toBe("2026-11-10T16:00:00.000Z"); // 08:00 PST
    expect(new Date(nextWindowOpening(tue, "Asia/Tokyo", W)!).toISOString()).toBe("2026-11-10T23:00:00.000Z"); // 08:00 Wed JST
    expect(new Date(nextWindowOpening(Date.parse("2026-11-10T13:00:00Z"), "Asia/Kolkata", W)!).toISOString()).toBe("2026-11-11T02:30:00.000Z"); // 18:30 IST -> 08:00 IST
    const sat = Date.parse("2026-11-14T12:00:00Z");
    expect(new Date(nextWindowOpening(sat, "Europe/London", W)!).toISOString()).toBe("2026-11-16T08:00:00.000Z"); // Monday
  });

  it("'next send at' is the later of now and the step's due time, moved into the window; nothing for a stopped enrolment", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect(nextSendAt({ status: "active", nextActionAt: new Date("2026-11-12T03:00:00Z") }, "Europe/London", W, now)).toBe(Date.parse("2026-11-12T08:00:00Z"));
    expect(nextSendAt({ status: "active", nextActionAt: null }, "Europe/London", W, now)).toBe(now);
    expect(nextSendAt({ status: "paused", nextActionAt: null }, "Europe/London", W, now)).toBeNull();
  });

  it("the engine asks for the person's zone only when the sequence has it on", () => {
    const engine = read("server/sequenceEngine.ts");
    expect(engine).toContain("const windowCfg = sequenceUsesRecipientTime(seq.settings)");
    expect(engine).toContain("if (!inSequenceWindow(windowCfg, now)) {");
    expect(engine).toContain("await hold(nextWindowOpen(windowCfg, now));");
    // The caps still count the sequence's own day.
    expect(engine).toContain("startOfLocalDay(cfg.timezone, now), seq.id)");
  });
});

describe("a person's own time zone can be stored (F18)", () => {
  beforeEach(() => {
    h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
    rows("prospects").push({ id: 301, workspaceId: WS, firstName: "Ann", lastName: "Lee", email: "ann@acme.example", timezone: null });
  });

  it("saves a real zone, refuses a made-up one, and blank clears it", async () => {
    await caller().prospects.update({ id: 301, timezone: "Europe/London" });
    expect(rows("prospects")[0].timezone).toBe("Europe/London");
    await expect(caller().prospects.update({ id: 301, timezone: "Mars/Olympus" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller().prospects.update({ id: 301, timezone: "" });
    expect(rows("prospects")[0].timezone).toBeNull();
  });

  it("the person's edit form has the field, and migration 0342 adds the column", () => {
    expect(read("client/src/pages/usip/ProspectDetail.tsx")).toContain('"city","state","country","timezone"] as const');
    const m = read("server/_core/rawMigrations.ts");
    expect(m).toContain("ALTER TABLE `prospects` ADD COLUMN `timezone` varchar(64) NULL");
  });
});
