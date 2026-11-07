/**
 * Research, lists, scoring and routing: role and ownership checks (audit
 * 2026-10-20, P31, P47, P120, P127, P133).
 *
 *   P31  · a manager writes personas and categories, an admin deletes them
 *   P47  · adding to a list takes the list's row lock first, so two adds can't
 *          both insert the same member (no unique key: live duplicates)
 *   P120 · Scoring and Routing offer their admin controls to admins only
 *   P127 · a routing rule's targets are active members, its changes are
 *          audited, and lead writes are scoped to the workspace
 *   P133 · saving a segment rule locks the segment first, for the same reason
 *
 * Procedures run against the SQL-evaluating fake with real membership rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableName } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, audits: [] as any[] };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async (e: unknown) => { h.audits.push(e); } }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

const WS = 2, FOREIGN = 9, ME = 1, ANN = 21, GONE = 22, STRANGER = 23;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const as = (role: string) => { rows("workspace_members").find((m) => m.userId === ME).role = role; return caller(); };
const block = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`missing ${start}`);
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j < 0 ? undefined : j);
};

/** Every SELECT … FOR UPDATE, by table, and whether it ran inside a transaction. */
function watchLocks() {
  const locks: Array<{ table: string; inTx: boolean; first: boolean }> = [];
  let depth = 0;
  let selectsInTx = 0;
  const realTx = h.db.transaction;
  h.db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    depth++; selectsInTx = 0;
    try { return await realTx(fn); } finally { depth--; }
  };
  const realSelect = h.db.select;
  h.db.select = (p?: Record<string, unknown>) => {
    const b = realSelect(p);
    let table = "?";
    const from = b.from;
    b.from = (t: any) => { table = getTableName(t); if (depth > 0) selectsInTx++; return from.call(b, t); };
    const lock = b.for;
    b.for = (s: string) => { locks.push({ table, inTx: depth > 0, first: selectsInTx === 1 }); return lock.call(b, s); };
    return b;
  };
  return locks;
}

beforeEach(() => {
  h.audits = [];
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: ME, archivedAt: null, plan: "trial" });
  rows("users").push({ id: ME, name: "Me" }, { id: ANN, name: "Ann" }, { id: GONE, name: "Gone" }, { id: STRANGER, name: "Else" });
  rows("workspace_members").push(
    { id: 1, workspaceId: WS, userId: ME, role: "rep", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
    { id: 2, workspaceId: WS, userId: ANN, role: "rep", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
    { id: 3, workspaceId: WS, userId: GONE, role: "rep", deactivatedAt: new Date(), inviteToken: null, lastActiveAt: new Date() },
    { id: 4, workspaceId: FOREIGN, userId: STRANGER, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
  );
  rows("personas").push({ id: 5, workspaceId: WS, name: "Clerks", targetTitles: [], targetIndustries: [], targetGeographies: [], keywords: [], categoryId: null });
  rows("persona_categories").push({ id: 6, workspaceId: WS, name: "Gov", sortOrder: 0 });
});

describe("P31: personas and categories", () => {
  it("a rep can neither write nor delete them", async () => {
    const r = as("rep");
    for (const run of [
      () => r.personas.create({ name: "New" }),
      () => r.personas.createFromPreset({ presetKey: "healthtech_buyers" }),
      () => r.personas.update({ id: 5, name: "Renamed" }),
      () => r.personas.delete({ id: 5 }),
      () => r.personas.createCategory({ name: "New" }),
      () => r.personas.updateCategory({ id: 6, name: "Renamed" }),
      () => r.personas.deleteCategory({ id: 6 }),
      () => r.personas.reorderCategories({ ids: [6] }),
    ]) await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(rows("personas").map((p) => p.name)).toEqual(["Clerks"]);
    expect(rows("persona_categories").map((c) => c.name)).toEqual(["Gov"]);
  });

  it("a manager writes them but cannot delete them; an admin can", async () => {
    const m = as("manager");
    await m.personas.update({ id: 5, name: "Renamed" });
    await m.personas.createCategory({ name: "Health" });
    expect(rows("personas")[0].name).toBe("Renamed");
    await expect(m.personas.delete({ id: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(m.personas.deleteCategory({ id: 6 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await as("admin").personas.delete({ id: 5 });
    expect(rows("personas")).toHaveLength(0);
  });

  it("the page offers writes to managers and deletes to admins only", () => {
    const src = read("client/src/pages/usip/Personas.tsx");
    expect(src).toContain("const { isManager: canEdit, isAdmin: canDelete } = useWorkspaceRole();");
    expect(block(src, "<PageHeader", "</PageHeader>")).toContain("{canEdit && (");
    const row = block(src, "const renderPersona = ", "const personaList = ");
    expect(block(row, "{canEdit && (", ")}")).toContain('aria-label="Edit persona"');
    expect(block(row, "{canDelete && (", ")}")).toContain('aria-label="Delete persona"');
    expect(src).toContain("disabled={!canEdit || fromPreset.isPending}");
    expect(block(src, "{canDelete && (\n                    <Button", "</Button>")).toContain('title="Delete category"');
  });
});

describe("P47: adding to a list", () => {
  beforeEach(() => {
    rows("record_lists").push({ id: 30, workspaceId: WS, name: "L", entityType: "people" });
    rows("prospects").push({ id: 40, workspaceId: WS, firstName: "P" }, { id: 41, workspaceId: WS, firstName: "Q" });
  });

  it("locks the list row first, inside the transaction that inserts", async () => {
    const locks = watchLocks();
    const r = await as("rep").recordLists.addMembers({ listId: 30, recordType: "prospect", recordIds: [40, 41, 40] });
    expect(r).toMatchObject({ added: 2 });
    expect(locks).toEqual([{ table: "record_lists", inTx: true, first: true }]);
    // A second add of the same people adds nobody.
    expect(await as("rep").recordLists.addMembers({ listId: 30, recordType: "prospect", recordIds: [40, 41] })).toMatchObject({ added: 0, alreadyOn: 2 });
    expect(rows("record_list_members")).toHaveLength(2);
  });
});

describe("P127: routing rules", () => {
  const rule = (o: Record<string, unknown> = {}) => ({ name: "R", priority: 10, enabled: true, conditions: { all: [], any: [] }, strategy: "direct" as const, targetUserIds: [ANN], ...o });

  it("refuses a target who has left or works elsewhere, and saves an active one", async () => {
    const a = as("admin");
    await expect(a.leadRouting.save(rule({ targetUserIds: [ANN, GONE] }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(a.leadRouting.save(rule({ targetUserIds: [STRANGER] }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(rows("lead_routing_rules")).toHaveLength(0);
    await a.leadRouting.save(rule());
    expect(rows("lead_routing_rules")).toHaveLength(1);
  });

  it("records who created, changed, reordered and deleted a rule", async () => {
    const a = as("admin");
    const { id } = await a.leadRouting.save(rule());
    await a.leadRouting.save(rule({ id, name: "R2" }));
    await a.leadRouting.reorder({ orderedIds: [id] });
    await a.leadRouting.remove({ id });
    const mine = h.audits.filter((e) => e.entityType === "lead_routing_rule");
    expect(mine.map((e) => e.action)).toEqual(["create", "update", "update", "delete"]);
    expect(mine[1].before).toMatchObject({ name: "R" });
    expect(mine[3].before).toMatchObject({ name: "R2" });
  });

  it("an edit of another workspace's rule is refused and changes nothing", async () => {
    rows("lead_routing_rules").push({ id: 90, workspaceId: FOREIGN, name: "Theirs", priority: 10, enabled: true, conditions: {}, strategy: "direct", targetUserIds: [STRANGER], rrCursor: 0 });
    await expect(as("admin").leadRouting.save(rule({ id: 90, name: "Mine now" }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rows("lead_routing_rules")[0].name).toBe("Theirs");
  });

  it("lead writes name the workspace", () => {
    const src = read("server/routers/leadScoring.ts");
    expect(src).not.toMatch(/\.update\(leads\)[^;]*\.where\(eq\(leads\.id/);
    expect(src).toContain(".where(and(eq(leads.id, leadId), eq(leads.workspaceId, workspaceId)))");
    expect(src).toContain(".where(and(eq(leads.id, lead.id), eq(leads.workspaceId, ctx.workspace.id)))");
  });
});

describe("P120: Scoring and Routing show admin controls to admins only", () => {
  it("Lead Scoring", () => {
    const src = read("client/src/pages/usip/LeadScoring.tsx");
    expect(src).toContain("const isAdmin = useWorkspaceRole().isAdmin;");
    const header = block(src, "<PageHeader", "</PageHeader>");
    expect(block(header, "{isAdmin && (", "</>")).toContain("Recompute all");
    expect(block(header, "{isAdmin && (", "</>")).toContain("save.mutate(cfg)");
    expect(src).toContain("{isAdmin && <Button size=\"sm\" variant=\"ghost\" className=\"h-6\" disabled={cancelRecompute.isPending}");
  });

  it("Lead Routing", () => {
    const src = read("client/src/pages/usip/LeadRouting.tsx");
    expect(src).toContain("const isAdmin = useWorkspaceRole().isAdmin;");
    expect(block(block(src, "<PageHeader", "</PageHeader>"), "{isAdmin && (", "</Button>")).toContain("New rule");
    expect(src).toContain("draggable={isAdmin && !reordering}");
    expect(block(src, "{isAdmin && (\n                          <>", "</>")).toContain('aria-label="Move rule up"');
    const actions = block(src, '<td className="px-3 py-2 text-right space-x-1">', "</td>");
    expect(block(actions, "{isAdmin && (<>", "</>)}")).toContain("remove.mutate({ id: r.id })");
  });
});

describe("P133: saving a segment rule", () => {
  beforeEach(() => {
    rows("audience_segments").push({ id: 50, workspaceId: WS, name: "S", rules: [{ field: "title", op: "contains", value: "x" }], matchType: "all" }, { id: 51, workspaceId: FOREIGN, name: "Theirs", rules: [], matchType: "all" });
    rows("sequences").push({ id: 60, workspaceId: WS, name: "Seq", status: "active" });
  });

  it("locks the segment first, inside the transaction that inserts", async () => {
    const locks = watchLocks();
    await as("admin").segmentRules.save({ segmentId: 50, sequenceId: 60, enabled: false });
    expect(locks).toEqual([{ table: "audience_segments", inTx: true, first: true }]);
    await as("admin").segmentRules.save({ segmentId: 50, sequenceId: 60, enabled: false });
    expect(rows("segment_sequence_rules")).toHaveLength(1);
  });

  it("still refuses another workspace's segment", async () => {
    await expect(as("admin").segmentRules.save({ segmentId: 51, sequenceId: 60, enabled: false })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(rows("segment_sequence_rules")).toHaveLength(0);
  });
});
