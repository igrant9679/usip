/**
 * Archive enforcement (2026-08-12, owner-approved) — the flag finally bites,
 * and it bit BOTH halves at once:
 *
 *   · the request path: workspaceProcedure refuses members below super_admin
 *     on an archived workspace (behavioral, real middleware via createCaller);
 *   · the autonomous path: every per-workspace engine skips archived
 *     workspaces through _core/workspaceArchive (structural sweep — an
 *     engine that forgets is exactly the "archived workspace keeps sending"
 *     hole the old docstring admitted to).
 *
 * Un-archive shipped in the same change, per the standing rule that
 * enforcement without a way back is a one-way lockout.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { prospectFieldHistory } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { appRouter } from "./routers";

/* ── Behavioral: the middleware gate ─────────────────────────────────────── */

function makeDb(role: string, archivedAt: Date | null) {
  const builder = () => {
    const st: { table?: unknown; joined: boolean } = { joined: false };
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin() { st.joined = true; return b; },
      where() { return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) {
        if (st.joined) {
          res([{
            ws: { id: 1, name: "Acme", ownerUserId: 1, archivedAt },
            mb: { id: 1, userId: 1, workspaceId: 1, role, deactivatedAt: null, lastActiveAt: new Date() },
          }]);
        } else if (st.table === prospectFieldHistory) {
          res([]);
        } else {
          rej(new Error("fake db: unscripted select"));
        }
      },
    };
    return b;
  };
  return { select: () => builder() };
}

function makeCtx(): TrpcContext {
  return {
    user: {
      id: 1, openId: "user-1", email: "u1@example.com", name: "User 1",
      loginMethod: "manus", role: "user",
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext;
}

describe("the request path refuses an archived workspace", () => {
  it("a rep is locked out with a message that names the way back", async () => {
    h.db = makeDb("rep", new Date("2026-08-12T00:00:00Z"));
    await expect(appRouter.createCaller(makeCtx()).prospects.fieldHistory({ prospectId: 1 }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("archived") });
  });

  it("an admin is locked out too — only super_admin can still enter", async () => {
    h.db = makeDb("admin", new Date("2026-08-12T00:00:00Z"));
    await expect(appRouter.createCaller(makeCtx()).prospects.fieldHistory({ prospectId: 1 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a super_admin still gets in — a lock nobody can open is a loss, not a lock", async () => {
    h.db = makeDb("super_admin", new Date("2026-08-12T00:00:00Z"));
    await expect(appRouter.createCaller(makeCtx()).prospects.fieldHistory({ prospectId: 1 }))
      .resolves.toEqual([]);
  });

  it("an unarchived workspace is untouched by the gate", async () => {
    h.db = makeDb("rep", null);
    await expect(appRouter.createCaller(makeCtx()).prospects.fieldHistory({ prospectId: 1 }))
      .resolves.toEqual([]);
  });
});

/* ── Structural: every autonomous engine consults the freeze ─────────────── */

describe("every per-workspace engine skips archived workspaces", () => {
  /**
   * Seeders are exempt on purpose: they are idempotent boot-time content
   * (help articles, tours, demo data) that must be fresh again the moment a
   * workspace is un-archived, and they send nothing and spend nothing.
   */
  const EXEMPT = new Set([
    "server/seedAreDemo.ts",
    "server/seedHelpContent.ts",
    "server/seedTours.ts",
  ]);

  const engineFiles = () => {
    const out = execFileSync("git", [
      "grep", "-l", "-E", "export async function [A-Za-z]+AllWorkspaces\\(", "--", "server",
    ], { encoding: "utf8" }).split("\n").filter(Boolean).filter((f) => !EXEMPT.has(f));
    // The two engines whose names predate the *AllWorkspaces convention but
    // which send more than everything else combined.
    out.push("server/areEngine.ts", "server/sequenceEngine.ts");
    return [...new Set(out)];
  };

  it("finds the engine fleet (floor guards the grep itself)", () => {
    expect(engineFiles().length).toBeGreaterThanOrEqual(13);
  });

  it("each engine imports the freeze and skips on it", () => {
    for (const f of engineFiles()) {
      const src = readFileSync(f, "utf8");
      expect(src.includes("archivedWorkspaceIds"), `${f} does not consult _core/workspaceArchive — an archived workspace would keep working there`).toBe(true);
      expect(/archivedWs\.has\(/.test(src), `${f} fetches the archived set but never skips on it`).toBe(true);
    }
  });
});

/* ── The mutations keep the cache honest ─────────────────────────────────── */

describe("archive/un-archive invalidate the engines' cache", () => {
  it("both mutations bust the 60s cache so the next tick sees the change", () => {
    const admin = readFileSync("server/routers/admin.ts", "utf8");
    const archiveAt = admin.indexOf("archiveWorkspace: adminWsProcedure");
    const unarchiveAt = admin.indexOf("unarchiveWorkspace: adminWsProcedure");
    expect(archiveAt).toBeGreaterThan(-1);
    expect(unarchiveAt, "un-archive is missing — enforcement without it is a one-way lockout").toBeGreaterThan(-1);
    const archiveBody = admin.slice(archiveAt, unarchiveAt);
    const unarchiveBody = admin.slice(unarchiveAt, unarchiveAt + 1600);
    expect(archiveBody.includes("invalidateArchivedWorkspaceCache()")).toBe(true);
    expect(unarchiveBody.includes("invalidateArchivedWorkspaceCache()")).toBe(true);
    expect(unarchiveBody.includes("archivedAt: null"), "un-archive does not clear the stamp").toBe(true);
  });
});
