/**
 * Mind map and landing page saves keep what was drawn (audit 2026-10-20, G22, G60).
 *
 * G22: a save deleted every node and edge, then inserted, with no transaction
 * and no length limits, so one over-long label failed the insert and left the
 * map empty; and a copy cached from before the last save loaded on revisit and
 * the next save put it back over the newer one.
 *
 * G60: one boolean said "unsaved", so an edit made while a save was in flight
 * was cleared with it and never sent; nothing asked before leaving; and the
 * landing page's Publish put the stored version live, not the one on screen.
 *
 * The router runs against the SQL-evaluating fake (its transaction rolls back
 * on a throw); the client half is the shared SaveTracker plus source pins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableName } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { SaveTracker, confirmLeaveWhile } from "../client/src/lib/saveTracker";

const WS = 2;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const node = (id: string, label = id) => ({ id, type: "topic" as const, label, posX: 0, posY: 0 });
async function code(p: Promise<unknown>) {
  try { await p; return "OK"; } catch (e: any) { return e?.code ?? e?.message; }
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("users").push({ id: 1, name: "Me" });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: 1, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
  rows("mindmaps").push({ id: 7, workspaceId: WS, name: "Plan", createdByUserId: 1, updatedAt: new Date("2026-11-01T10:00:00Z") });
  rows("mindmap_nodes").push(
    { id: "a", mindmapId: 7, workspaceId: WS, type: "root", label: "Root", posX: 0, posY: 0 },
    { id: "b", mindmapId: 7, workspaceId: WS, type: "topic", label: "Kept", posX: 10, posY: 10 },
  );
  rows("mindmap_edges").push({ id: "a-b", mindmapId: 7, workspaceId: WS, source: "a", target: "b" });
});

const nodeLabels = () => rows("mindmap_nodes").filter((n) => n.mindmapId === 7).map((n) => n.label).sort();

describe("a failed save leaves the map as it was (G22)", () => {
  it("a label longer than the column is refused before anything is deleted", async () => {
    expect(await code(caller().mindmaps.saveCanvas({ id: 7, nodes: [node("a", "x".repeat(241))], edges: [] }))).toBe("BAD_REQUEST");
    expect(nodeLabels()).toEqual(["Kept", "Root"]);
  });

  it("an insert that fails mid-save rolls the delete back", async () => {
    const insert = h.db.insert;
    h.db.insert = (t: any) => {
      if (getTableName(t) !== "mindmap_edges") return insert(t);
      return { values: () => Promise.reject(new Error("Data too long for column 'label'")) };
    };
    expect(await code(caller().mindmaps.saveCanvas({ id: 7, nodes: [node("a", "New")], edges: [{ id: "e", source: "a", target: "a" }] }))).not.toBe("OK");
    h.db.insert = insert;
    expect(nodeLabels()).toEqual(["Kept", "Root"]);
    expect(rows("mindmap_edges").map((e) => e.id)).toEqual(["a-b"]);
  });
});

describe("an older copy can't overwrite a newer save (G22)", () => {
  it("a save based on the version it loaded goes through, and returns the next version", async () => {
    const { version } = await caller().mindmaps.getCanvas({ id: 7 });
    const saved = await caller().mindmaps.saveCanvas({ id: 7, baseVersion: version, nodes: [node("a", "Mine")], edges: [] });
    expect(nodeLabels()).toEqual(["Mine"]);
    expect((await caller().mindmaps.getCanvas({ id: 7 })).version).toBe(saved.version);
  });

  it("a save based on a version that has since been saved over is refused", async () => {
    const { version: stale } = await caller().mindmaps.getCanvas({ id: 7 });
    rows("mindmaps")[0].updatedAt = new Date("2026-11-01T10:05:00Z"); // saved elsewhere
    expect(await code(caller().mindmaps.saveCanvas({ id: 7, baseVersion: stale, nodes: [node("a", "Old")], edges: [] }))).toBe("CONFLICT");
    expect(nodeLabels()).toEqual(["Kept", "Root"]);
  });

  it("Keep mine saves without a version and overwrites", async () => {
    rows("mindmaps")[0].updatedAt = new Date("2026-11-01T10:05:00Z");
    expect(await code(caller().mindmaps.saveCanvas({ id: 7, nodes: [node("a", "Mine anyway")], edges: [] }))).toBe("OK");
    expect(nodeLabels()).toEqual(["Mine anyway"]);
  });
});

describe("an edit made during a save stays unsaved (G60)", () => {
  it("the tracker clears only the edits a save began with", () => {
    const t = new SaveTracker();
    t.edit();
    const upTo = t.begin();
    t.edit(); // typed while the save is in flight
    t.saved(upTo);
    expect(t.dirty).toBe(true);
    t.saved(t.begin());
    expect(t.dirty).toBe(false);
  });

  it("an older save landing late doesn't clear a newer one's edits", () => {
    const t = new SaveTracker();
    t.edit();
    const first = t.begin();
    t.edit();
    const second = t.begin();
    t.saved(second);
    t.saved(first);
    expect(t.dirty).toBe(false);
    t.edit();
    t.saved(first);
    expect(t.dirty).toBe(true);
  });

  it("closing the tab asks only while something is unsaved", () => {
    const t = new SaveTracker();
    const listener = confirmLeaveWhile(() => t.dirty);
    const ev = () => ({ preventDefault: vi.fn(), returnValue: undefined as unknown }) as any;
    const clean = ev();
    listener(clean);
    expect(clean.preventDefault).not.toHaveBeenCalled();
    t.edit();
    const dirty = ev();
    listener(dirty);
    expect(dirty.preventDefault).toHaveBeenCalled();
  });
});

describe("the screens use it", () => {
  it("the mind map counts edits, sends its version, re-reads on open, and guards leaving", () => {
    const s = read("client/src/pages/usip/MindmapCanvas.tsx");
    expect(s).toContain("const upTo = tracker.begin();");
    expect(s).toContain("tracker.saved(upTo);");
    expect(s).not.toContain("setDirty(false)");
    expect(s).toContain("baseVersion: opts.overwrite ? undefined : versionRef.current");
    expect(s).toContain('trpc.mindmaps.getCanvas.useQuery({ id: mapId }, { refetchOnMount: "always" })');
    expect(s).toContain("if (!canvasData || tracker.dirty) return;");
    expect(s).toContain('window.addEventListener("beforeunload", onBeforeUnload)');
    expect(s).toContain("utils.mindmaps.getCanvas.invalidate({ id: mapId })");
  });

  it("the landing page saves before it publishes, and keeps edits over a refetch", () => {
    const s = read("client/src/pages/usip/LandingPages.tsx");
    const publish = s.slice(s.indexOf("const publish = async"), s.indexOf("const toggleField"));
    expect(publish).toContain("if (tracker.dirty && !(await save())) return;");
    expect(publish).toContain('setStatus.mutate({ id: form.id, status: "published" })');
    expect(s).toContain("onClick={() => void publish()}");
    expect(s).not.toMatch(/onClick=\{\(\) => setStatus\.mutate\(\{ id: form\.id, status: "published" \}\)\}/);
    expect(s).toContain("if (formId.current === d.id && tracker.dirty) return;");
    expect(s).toContain("tracker.saved(upTo);");
    expect(s).toContain('window.addEventListener("beforeunload", onBeforeUnload)');
    expect(s).toContain("leaveEditor(() => setSelectedId(p.id))");
  });
});
