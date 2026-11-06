/**
 * Audit 2026-10-20, O50: a settings read that failed counted as "not paused",
 * and the answer was cached for a minute per process. Outbound is paused on
 * three workspaces; a database blip opened each of them to every sender —
 * the engines (inSendWindow) and every person-send (isOutboundPaused) — until
 * the next read.
 *
 * Now a failed read is paused, for both, and is not cached; a pause switched
 * on in Settings clears the cache so it holds at once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { workspaceSettings } from "../drizzle/schema";

const h = vi.hoisted(() => ({ db: null as any, readFails: false, row: null as Record<string, unknown> | null, reads: 0 }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));

import { getWorkspaceSendWindow, inSendWindow, invalidateSendWindowCache } from "./services/sendWindow";
import { assertOutboundNotPaused, isOutboundPaused, OUTBOUND_PAUSED_MESSAGE } from "./services/outboundPause";

function makeDb() {
  const q = (): any => {
    const st: { table?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; }, where() { return b; }, limit() { return b; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) {
        if (st.table === workspaceSettings) {
          h.reads++;
          if (h.readFails) return rej(new Error("db down"));
          return res(h.row ? [h.row] : []);
        }
        return res([]);
      },
    };
    return b;
  };
  return { select: () => q() };
}

// Wednesday 2026-09-30, 10:00 in New York: inside the default window.
const MID_WINDOW = Date.UTC(2026, 8, 30, 14, 0);
const OPEN_ROW = { timezone: "America/New_York", startHour: 6, endHour: 17, days: "1,2,3,4,5", pausedAt: null };

beforeEach(() => {
  invalidateSendWindowCache();
  h.db = makeDb();
  h.readFails = false;
  h.row = { ...OPEN_ROW };
  h.reads = 0;
});

describe("the outbound pause fails closed", () => {
  it("a failed read is paused, for the engines and for person-sends", async () => {
    h.readFails = true;
    expect((await getWorkspaceSendWindow(2, MID_WINDOW)).paused).toBe(true);
    expect(await inSendWindow(2, MID_WINDOW)).toBe(false);
    expect(await isOutboundPaused(2)).toBe(true);
    await expect(assertOutboundNotPaused(2)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: OUTBOUND_PAUSED_MESSAGE });
  });

  it("no database at all is paused too", async () => {
    h.db = null;
    expect(await isOutboundPaused(2)).toBe(true);
    expect(await inSendWindow(2, MID_WINDOW)).toBe(false);
  });

  it("a failure is not cached: the next ask reads again and sees the real state", async () => {
    h.readFails = true;
    expect(await isOutboundPaused(2)).toBe(true);
    h.readFails = false;
    // No invalidation: the failure itself must not have been remembered.
    expect(await isOutboundPaused(2)).toBe(false);
    expect(h.reads).toBe(2);
    expect(await inSendWindow(2, MID_WINDOW)).toBe(true);
  });

  it("a good read is still cached for the minute, and a save clears it", async () => {
    expect(await isOutboundPaused(2)).toBe(false);
    h.row = { ...OPEN_ROW, pausedAt: new Date() };
    // Cached: the engines ask on every tick.
    expect(await isOutboundPaused(2)).toBe(false);
    // Settings → Pause all outbound saves through admin.updateSettings, which clears it.
    invalidateSendWindowCache(2);
    expect(await isOutboundPaused(2)).toBe(true);
    const admin = readFileSync("server/routers/admin.ts", "utf8");
    const save = admin.slice(admin.indexOf("patch.outboundPausedAt = input.outboundPaused"), admin.indexOf("await recordAudit({", admin.indexOf("patch.outboundPausedAt = input.outboundPaused")));
    expect(save).toContain("invalidateSendWindowCache(ctx.workspace.id);");
  });

  it("an unpaused, readable workspace is unchanged", async () => {
    expect((await getWorkspaceSendWindow(2, MID_WINDOW)).paused).toBe(false);
    expect(await inSendWindow(2, MID_WINDOW)).toBe(true);
    await expect(assertOutboundNotPaused(2)).resolves.toBeUndefined();
  });
});
