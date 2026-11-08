/**
 * G71, the parts the 2026-11-06 pass left (audit 2026-10-20; final pass
 * 2026-11-07):
 *
 *   1 · The workflow editor asks for names, not ids: people, sequences, stages,
 *       accounts and campaigns are picked by name, condition fields show their
 *       labels, and update_field offers only the fields the engine can set.
 *       A blank "person" means the record's owner, in the engine as on screen.
 *   2 · A form can be edited after it is made (forms.update had no caller).
 *   3 · The legacy editor's AI suggestion panel has actions: add one, dismiss
 *       one, add all — added rules start switched off — and the v2 panel's
 *       "Add all" no longer says the rules arrive enabled.
 *
 * Screens are pinned by source (slices, never a raw indexOf), the engine and
 * forms.update run against the SQL-evaluating fake.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "c".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateArchivedWorkspaceCache } from "./_core/workspaceArchive";
import { executeRuleActions, pickedUserId } from "./services/workflowEngine";
import { formFieldsFrom } from "../client/src/pages/usip/FormsV2";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const WS = 2, REP = 22, OWNER = 23;
const slice = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, `"${from}" not found`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b, `"${to}" not found after "${from}"`).toBeGreaterThan(-1);
  return src.slice(a, b);
};

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  invalidateArchivedWorkspaceCache();
  rows("workspaces").push({ id: WS, name: "Acme", slug: "acme", ownerUserId: REP, archivedAt: null, plan: "trial" });
  rows("users").push({ id: REP, openId: "local:22", name: "Ray Rep", email: "ray@acme.example", role: "user", loginMethod: "password" });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: REP, role: "rep", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date(), createdAt: new Date() });
});

/* ── 1 · names, not ids ───────────────────────────────────────────────── */

describe("the workflow editor picks by name (G71)", () => {
  const page = read("client/src/pages/usip/Workflows.tsx");

  it("action settings are per action, with pickers where the engine wants an id", () => {
    const params = slice(page, "function ActionParams(", "function RuleEditor(");
    expect(params).toContain('pick("userId", "person to notify", users, "The record\'s owner")');
    expect(params).toContain('pick("ownerUserId", "assign to", users, "The record\'s owner")');
    expect(params).toContain('pick("sequenceId", "sequence", options.sequences.map(');
    expect(params).toContain('pick("field", "field to set", updatableFields(entity).map(');
    // update_field's value follows the field: a person, a stage, a status.
    expect(params).toContain('if (fieldKey === "ownerUserId")');
    expect(params).toContain('else if (fieldKey === "stage")');
    expect(params).toContain('else if (fieldKey === "status")');
    // Unknown params a saved rule carries stay editable, so a save never drops them.
    expect(params).toContain("const extra = Object.keys(p).filter((k) => known.indexOf(k) < 0);");
  });

  it("the old one-text-box-per-param editor is gone from the actions", () => {
    const editor = slice(page, "function RuleEditor(", "function DryRunPanel(");
    expect(editor).not.toContain("Object.entries(a.params).map(");
    expect(editor).toContain("<ActionParams act={a} index={i} entity={entity} options={options}");
  });

  it("condition fields show their labels, and values are picked by what the field names", () => {
    const editor = slice(page, "function RuleEditor(", "function DryRunPanel(");
    expect(editor).toContain("{fieldOptions.map((f) => <option key={f} value={f}>{payloadField(f).label}</option>)}");
    expect(editor).toContain("<ConditionValue field={c.field} op={c.op}");
    const value = slice(page, "function ConditionValue(", "function updatableFields(");
    for (const ref of ['f.ref === "user"', 'f.ref === "stage"', 'f.ref === "campaign"', 'f.ref === "account"']) expect(value, ref).toContain(ref);
    expect(value).toContain('<RecordSearch type="account"');
    expect(value).toContain("if (f.values)");
  });

  it("deal_stuck's stage and signal_received's signal are picked from lists", () => {
    const editor = slice(page, "function RuleEditor(", "function DryRunPanel(");
    expect(editor).toContain('<NamedSelect ariaLabel="Stage (any if blank)"');
    expect(editor).not.toContain('placeholder="e.g. Proposal"');
    expect(editor).toContain('<NamedSelect ariaLabel="Which signal"');
  });

  it("a saved value the lists don't know is kept, not rewritten on save", () => {
    const sel = slice(page, "function NamedSelect(", "function RecordSearch(");
    expect(sel).toContain('{!known && <option value={value}>{value} (not found)</option>}');
  });

  it("the rule list and the suggestions show trigger and action names, not ids", () => {
    expect(page).toContain("{isDeadTrigger(r.triggerType) ? r.triggerType : triggerLabel(r.triggerType)}");
    const panel = slice(page, "{/* AI Workflow Suggestions Panel */}", '<div className="p-4 md:p-5 grid');
    expect(panel).toContain("triggerLabel(String(s.triggerType");
    expect(panel).toContain("actionLabel(String(a?.type");
  });

  it("a blank person means the record's owner in the engine too", async () => {
    expect(pickedUserId("")).toBeNull();
    expect(pickedUserId("0")).toBeNull();
    expect(pickedUserId("23")).toBe(23);
    await executeRuleActions(WS, { id: 1, name: "R", actions: [
      { type: "notify_user", params: { userId: "", message: "hi" } },
      { type: "create_task", params: { title: "T", ownerUserId: "" } },
    ] }, { payload: {}, relatedType: "lead", relatedId: 5, ownerUserId: OWNER });
    expect(rows("notifications")).toHaveLength(1);
    expect(rows("notifications")[0].userId).toBe(OWNER);
    expect(rows("tasks")[0].ownerUserId).toBe(OWNER);
  });
});

/* ── 2 · editing a form ───────────────────────────────────────────────── */

describe("a form can be edited after it is made (G71)", () => {
  beforeEach(() => {
    rows("sequences").push({ id: 50, workspaceId: WS, name: "Ours", status: "active" }, { id: 60, workspaceId: 4, name: "Theirs", status: "active" });
    rows("forms").push({
      id: 80, workspaceId: WS, publicId: "pub80", title: "Contcat us", description: null, status: "active",
      fields: [{ key: "email", label: "Email", required: true }, { key: "budget", label: "Budget" }],
      autoCreateLead: true, autoRoute: true, autoEnrollSequenceId: null, redirectUrl: null, createdByUserId: REP, submitCount: 3,
    });
  });
  const rep = () => appRouter.createCaller({
    user: rows("users").find((u) => u.id === REP),
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);

  it("the dialog's fields: palette picks with their required flags, then the form's own extra fields", () => {
    expect(formFieldsFrom({ firstName: true, email: true }, { email: true }, [{ key: "email", label: "Email", required: true }, { key: "budget", label: "Budget" }])).toEqual([
      { key: "firstName", label: "First name", required: false },
      { key: "email", label: "Email", required: true },
      { key: "budget", label: "Budget" },
    ]);
  });

  it("forms.update changes the live form and keeps its link and its count", async () => {
    await rep().forms.update({ id: 80, patch: { title: "Contact us", fields: [{ key: "email", label: "Email", required: true }], autoEnrollSequenceId: 50, redirectUrl: null } });
    expect(rows("forms")[0]).toMatchObject({ title: "Contact us", publicId: "pub80", submitCount: 3, autoEnrollSequenceId: 50 });
    // Another workspace's sequence is still refused, as at create.
    await expect(rep().forms.update({ id: 80, patch: { autoEnrollSequenceId: 60 } })).rejects.toThrow();
  });

  it("FormsV2 opens the same dialog to edit and saves through forms.update", () => {
    const src = read("client/src/pages/usip/FormsV2.tsx");
    expect(src).toContain("const update = trpc.forms.update.useMutation({");
    expect(src).toContain("onClick={() => setEditing(f)}><Pencil className=\"size-3\" /> Edit</Button>");
    expect(src).toContain("editing={editing} onCreate={(v) => update.mutate({ id: editing.id, patch: v })} />");
    const dialog = slice(src, "function CreateFormDialog(", "function SubmissionsDialog(");
    expect(dialog).toContain("const fields = formFieldsFrom(selected, required, existing);");
    expect(dialog).toContain('{editing ? (pending ? "Saving…" : "Save changes")');
  });
});

/* ── 3 · the suggestion panels ────────────────────────────────────────── */

describe("the AI suggestion panels have actions (G71)", () => {
  it("each suggestion can be added or dismissed, and all added at once, in the legacy editor", () => {
    const page = read("client/src/pages/usip/Workflows.tsx");
    expect(page).toContain("const applySuggestion = trpc.workflowsAi.applySuggestion.useMutation({");
    expect(page).toContain("const dismissSuggestion = trpc.workflowsAi.dismissSuggestion.useMutation({");
    expect(page).toContain("const applyAllSuggestions = trpc.workflowsAi.applyAllSuggestions.useMutation({");
    const panel = slice(page, "{/* AI Workflow Suggestions Panel */}", '<div className="p-4 md:p-5 grid');
    expect(panel).toContain("onClick={() => applySuggestion.mutate({ id: s.id })}");
    expect(panel).toContain("onClick={() => dismissSuggestion.mutate({ id: s.id })}");
    expect(panel).toContain("onConfirm={() => applyAllSuggestions.mutate()}");
    // Added rules are created switched off (G61), and the confirm says so.
    expect(panel).toContain("switched off. Nothing fires until you open a rule");
  });

  it("the v2 panel's Add all no longer promises enabled rules", () => {
    const v2 = read("client/src/pages/usip/WorkflowsV2.tsx");
    expect(v2).not.toContain("Each suggestion becomes an enabled workflow rule");
    expect(v2).toContain("Each suggestion becomes a workflow rule, switched off.");
  });
});
