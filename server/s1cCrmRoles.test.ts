/**
 * CRM role and ownership checks (audit 2026-10-20, R37, R55, R63, R73).
 *
 *   R37 · territories and their rules are a manager's, pipelines and stages an
 *         admin's; an alert is cleared by its deal's owner or a manager, all of
 *         them by a manager, and Clear all (a hard delete) by an admin
 *   R55 · an import's owner is an active member of this workspace
 *   R63 · the People export's read refuses without export_data, and the Leads
 *         and Pipeline CSVs use the one safe cell
 *   R73 · a task's related record is a known kind and this workspace's row
 *
 * Procedures run against the SQL-evaluating fake with real membership rows,
 * and the real permission check.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
// The permission check calls db.ts's own getDb, which the mock above never
// reaches (see permissionEnforcement.test.ts): the driver delegates to the fake.
vi.mock("drizzle-orm/mysql2", () => ({
  drizzle: () => ({ select: (...a: unknown[]) => (h.db as any).select(...a) }),
}));
process.env.DATABASE_URL = process.env.DATABASE_URL || "mysql://fake/s1c-crm-tests";
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { csvCell } from "@shared/csvCell";

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

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: ME, archivedAt: null, plan: "trial" });
  rows("users").push({ id: ME, name: "Me" }, { id: ANN, name: "Ann" }, { id: GONE, name: "Gone" }, { id: STRANGER, name: "Else" });
  rows("workspace_members").push(
    { id: 1, workspaceId: WS, userId: ME, role: "rep", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
    { id: 2, workspaceId: WS, userId: ANN, role: "rep", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
    { id: 3, workspaceId: WS, userId: GONE, role: "rep", deactivatedAt: new Date(), inviteToken: null, lastActiveAt: new Date() },
    { id: 4, workspaceId: FOREIGN, userId: STRANGER, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
  );
});

describe("R37: territories, pipelines and alerts", () => {
  beforeEach(() => {
    rows("territories").push({ id: 10, workspaceId: WS, name: "East", rules: {} });
    rows("crm_territory_rules").push({ id: 11, workspaceId: WS, name: "R", priority: 100, active: true });
    rows("crm_pipelines").push({ id: 12, workspaceId: WS, name: "Main", isDefault: true });
    rows("crm_pipeline_stages").push({ id: 13, workspaceId: WS, pipelineId: 12, key: "discovery", label: "Discovery", sortOrder: 0, defaultWinProb: 10, isWon: false, isLost: false });
    rows("opportunities").push(
      { id: 20, workspaceId: WS, name: "Mine", stage: "discovery", ownerUserId: ME, value: 1 },
      { id: 21, workspaceId: WS, name: "Ann's", stage: "discovery", ownerUserId: ANN, value: 1 },
    );
    rows("pipeline_alerts").push(
      { id: 30, workspaceId: WS, opportunityId: 20, alertType: "no_activity", dismissedAt: null },
      { id: 31, workspaceId: WS, opportunityId: 21, alertType: "no_activity", dismissedAt: null },
      { id: 32, workspaceId: WS, opportunityId: 999, alertType: "no_activity", dismissedAt: null },
    );
  });

  it("a rep cannot change territories, their rules or pipelines", async () => {
    const r = as("rep");
    for (const run of [
      () => r.territories.create({ name: "West" }),
      () => r.territories.update({ id: 10, patch: { name: "Renamed" } }),
      () => r.territories.delete({ id: 10 }),
      () => r.crmTerritoryRules.create({ name: "New" }),
      () => r.crmTerritoryRules.delete({ id: 11 }),
      () => r.crmPipelines.renamePipeline({ id: 12, name: "Renamed" }),
      () => r.crmPipelines.updateStage({ id: 13, patch: { isWon: true } }),
      () => r.crmPipelines.deleteStage({ id: 13 }),
    ]) await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(rows("territories")[0].name).toBe("East");
    expect(rows("crm_territory_rules")).toHaveLength(1);
    expect(rows("crm_pipelines")[0].name).toBe("Main");
    expect(rows("crm_pipeline_stages")[0].isWon).toBe(false);
  });

  it("a manager changes territories but not pipelines; an admin changes pipelines", async () => {
    const m = as("manager");
    await m.territories.update({ id: 10, patch: { name: "North" } });
    await m.crmTerritoryRules.delete({ id: 11 });
    expect(rows("territories")[0].name).toBe("North");
    expect(rows("crm_territory_rules")).toHaveLength(0);
    await expect(m.crmPipelines.renamePipeline({ id: 12, name: "Renamed" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await as("admin").crmPipelines.renamePipeline({ id: 12, name: "Renamed" });
    expect(rows("crm_pipelines")[0].name).toBe("Renamed");
  });

  it("a rep clears alerts on their own deal and on a deal that is gone, not on someone else's", async () => {
    const r = as("rep");
    await r.pipelineAlerts.dismiss({ alertId: 30 });
    await r.pipelineAlerts.dismiss({ alertId: 32 });
    await expect(r.pipelineAlerts.dismiss({ alertId: 31 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(r.pipelineAlerts.dismissAllForOpp({ opportunityId: 21 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(rows("pipeline_alerts").filter((a) => a.dismissedAt).map((a) => a.id)).toEqual([30, 32]);
    await as("manager").pipelineAlerts.dismiss({ alertId: 31 });
    expect(rows("pipeline_alerts").find((a) => a.id === 31).dismissedAt).not.toBeNull();
  });

  it("dismissing them all is a manager's, and Clear all an admin's", async () => {
    await expect(as("rep").pipelineAlerts.dismissAll()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("manager").pipelineAlerts.clearAll()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(rows("pipeline_alerts")).toHaveLength(3);
    await as("manager").pipelineAlerts.dismissAll();
    await as("admin").pipelineAlerts.clearAll();
    expect(rows("pipeline_alerts")).toHaveLength(0);
  });

  it("the screens offer each control only to who may use it", () => {
    const terr = read("client/src/pages/usip/Territories.tsx");
    expect(terr).toContain("const canEdit = useWorkspaceRole().isManager;");
    expect(terr).toContain("{canEdit && <Button onClick={() => setOpen(true)}><Plus className=\"size-4\" /> New territory</Button>}");
    // The deletes are Ra's confirm buttons (R76), offered to managers only.
    expect(block(terr, "{canEdit && (() => {", "</ConfirmButton>")).toContain('<ConfirmButton ariaLabel="Delete territory"');
    expect(block(terr, "{canEdit && (\n                      <ConfirmButton", "</ConfirmButton>")).toContain('ariaLabel="Delete rule"');
    const pipes = read("client/src/pages/usip/SettingsPipelines.tsx");
    expect(pipes).toContain("const canEdit = useWorkspaceRole().isAdmin;");
    expect(pipes).toContain("{canEdit && <Button size=\"sm\" onClick={() => setNewOpen(true)}>");
    expect(block(pipes, "{canEdit && (\n                        <Button aria-label=\"Delete stage\"", "</Button>")).toContain("askDeleteStage(s)");
    expect(pipes).toContain("<input type=\"checkbox\" disabled={!canEdit} checked={s.isWon}");
    expect(block(pipes, "{canEdit ? (\n                <div className=\"flex items-center gap-1\">", "An admin changes pipelines and stages.")).toContain("setRenameOpen(true)");
    const alerts = read("client/src/pages/usip/PipelineAlerts.tsx");
    expect(alerts).toContain("const canDismiss = isManager || (alert.opportunity?.ownerUserId != null && alert.opportunity.ownerUserId === user?.id);");
    expect(block(alerts, "{canDismiss && (", "</Button>")).toContain("dismiss.mutate({ alertId: alert.id })");
    expect(alerts).toContain("{isAdmin && totalAlerts > 0 && (");
  });
});

describe("R55: an import's owner works here", () => {
  const FILE = "Email,First,Last,Company\nnew@acme.example,New,Person,Acme\n";
  const mapping = { Email: "email", First: "firstName", Last: "lastName", Company: "company" };
  const commit = (ownerUserId?: number) => as("admin").imports.commit({
    csvText: FILE, filename: "f.csv", fieldMapping: mapping, destination: "prospects",
    ...(ownerUserId != null ? { postImportActions: { ownerUserId } } : {}),
  });

  it("refuses another workspace's user and a leaver before anything is written", async () => {
    await expect(commit(STRANGER)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(commit(GONE)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(rows("contact_imports")).toHaveLength(0);
    expect(rows("prospects")).toHaveLength(0);
  });

  it("imports under an active member", async () => {
    await commit(ANN);
    expect(rows("contact_imports")).toHaveLength(1);
  });
});

describe("R63: exports", () => {
  beforeEach(() => {
    rows("prospects").push({ id: 40, workspaceId: WS, firstName: "P", email: "p@acme.example" });
  });

  it("the People export's read refuses a rep, as the export permission's default says", async () => {
    await expect(as("rep").prospects.exportSelected({ prospectIds: [40] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await as("admin").prospects.exportSelected({ prospectIds: [40] })).toHaveLength(1);
  });

  it("…and serves a rep someone has granted it to", async () => {
    rows("member_permissions").push({ id: 1, workspaceId: WS, userId: ME, feature: "export_data", granted: true });
    expect(await as("rep").prospects.exportSelected({ prospectIds: [40] })).toHaveLength(1);
  });

  it("Leads and Pipeline build each cell with the shared csvCell, not JSON.stringify", () => {
    for (const page of ["client/src/pages/usip/Leads.tsx", "client/src/pages/usip/Pipeline.tsx"]) {
      const src = read(page);
      expect(src).toContain('import { csvCell } from "@shared/csvCell";');
      expect(src).toContain("cols.map((c) => csvCell(r[c])).join(\",\")");
      expect(src).not.toContain("JSON.stringify(r[c]");
    }
    // What that changes, on the two cells the old way got wrong.
    expect(csvCell('Acme "West"')).toBe('"Acme ""West"""');
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
  });
});

describe("R73: what a task is about", () => {
  beforeEach(() => {
    rows("opportunities").push({ id: 50, workspaceId: WS, name: "Ours", stage: "discovery" }, { id: 51, workspaceId: FOREIGN, name: "Theirs", stage: "discovery" });
    rows("sending_accounts").push({ id: 60, workspaceId: WS, name: "Box", fromEmail: "box@acme.example", provider: "generic_smtp", enabled: true });
    rows("prospects").push({ id: 70, workspaceId: WS, firstName: "P" }, { id: 71, workspaceId: FOREIGN, firstName: "Q" });
  });

  it("refuses another workspace's record, an unknown kind, and an id with no kind", async () => {
    const r = as("rep");
    await expect(r.tasks.create({ title: "T", relatedType: "opportunity", relatedId: 51 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(r.tasks.create({ title: "T", relatedType: "workspace", relatedId: 50 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(r.tasks.create({ title: "T", relatedType: "constructor", relatedId: 50 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(r.tasks.create({ title: "T", relatedId: 50 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(rows("tasks")).toHaveLength(0);
  });

  it("files a task against this workspace's deal, mailbox, or nothing", async () => {
    const r = as("rep");
    await r.tasks.create({ title: "Deal", relatedType: "opportunity", relatedId: 50 });
    await r.tasks.create({ title: "Snooze", relatedType: "mailbox_thread", relatedId: 60 });
    await r.tasks.create({ title: "Loose" });
    expect(rows("tasks").map((t) => t.title)).toEqual(["Deal", "Snooze", "Loose"]);
  });

  it("bulk tasks go to this workspace's people only", async () => {
    expect(await as("rep").tasks.bulkCreateForProspects({ prospectIds: [70, 71], title: "Call" })).toEqual({ created: 1 });
    expect(rows("tasks").map((t) => t.relatedId)).toEqual([70]);
  });
});
