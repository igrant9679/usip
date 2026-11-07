/**
 * The sequence screens say what the engine does, batch Oa of the 2026-10-20
 * audit:
 *
 *   O21 canvas nodes the engine cannot run are disabled and say so · O27 no
 *   exit-condition switches that nothing reads · O26 a template step shows the
 *   copy that sends, in v1 as in v2 · O37 legacy refreshes what it changed and
 *   has a plain Pause · O38 the v2 editor activates and pauses, and a refused
 *   edit puts the screen back · O39 its copy matches the engine · O40 the enrol
 *   dialog searches on the server · O48 email steps say they write drafts ·
 *   O55 the list shows only controls that work · O56 loading is not empty ·
 *   O60 a canvas wait offers what the server keeps.
 *
 * Components are rendered with their queries stubbed; page wiring is read from
 * the source, as the repo's other screen guards do.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({ autoSend: {} as Record<string, unknown> }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    emailAutoSend: { getAutoSendSettings: { useQuery: () => h.autoSend } },
    emailTemplates: { list: { useQuery: () => ({ data: [], isLoading: false, isError: false }) } },
  },
}));

import { NOT_RUN_NODE_TYPES, canvasNotRunNotes } from "../client/src/lib/canvasSupport";
import { describeSendWindow } from "../client/src/lib/sequenceSteps";
import { SEQUENCE_DRAFTS_HREF, SequenceDraftsNote } from "../client/src/components/usip/SequenceDraftsNote";
import { SequenceSettingsPanel, WHAT_STOPS_SOMEONE } from "../client/src/components/usip/canvas/SequenceSettingsPanel";
import { MAX_WAIT_DAYS, NodeEditPanel } from "../client/src/components/usip/canvas/NodeEditPanel";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const html = (el: any) => renderToStaticMarkup(createElement(Router, { ssrPath: "/" }, el));
/** The text between two markers, which must both exist in that order. */
function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${start} … ${end}`);
  return src.slice(a, b);
}
const panel = (type: string, data: Record<string, unknown> = {}, readOnly = false) =>
  html(createElement(NodeEditPanel, { node: { id: "n1", type, position: { x: 0, y: 0 }, data } as any, readOnly, onClose: () => {}, onSave: () => {} }));

beforeEach(() => { h.autoSend = {}; });

/* ═══ O21 ══════════════════════════════════════════════════════════════════ */

describe("canvas nodes the engine cannot run are disabled and say so (O21)", () => {
  it("names each kind that will not run as drawn, and nothing when all of it runs", () => {
    expect(canvasNotRunNotes([{ id: "s", type: "start" }, { id: "e", type: "email" }, { id: "w", type: "wait" }, { id: "t", type: "action", data: { actionType: "create_task" } }], [])).toEqual([]);
    const notes = canvasNotRunNotes(
      [{ id: "c", type: "condition" }, { id: "g", type: "goal" }, { id: "a", type: "action", data: { actionType: "apply_tag" } }, { id: "e", type: "email" }],
      [{ source: "c", target: "e", sourceHandle: "false" }],
    );
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(/^1 condition on this canvas doesn't branch yet: everyone follows the TRUE path, and the steps on the FALSE path never run\.$/);
    expect(notes[1]).toMatch(/^1 goal isn't available yet/);
    expect(notes[2]).toMatch(/only creates a task/);
  });

  it("the palette offers condition and goal disabled, and an action as the task it is", () => {
    const src = read("client/src/pages/usip/SequenceCanvas.tsx");
    const palette = between(src, "const PALETTE_ITEMS", "/* ─── Undo/redo stack");
    expect(palette).toMatch(/type: "condition", label: "Condition", description: "Not available yet[^"]*", notYet: true/);
    expect(palette).toMatch(/type: "goal", label: "Goal", description: "Not available yet[^"]*", notYet: true/);
    expect(palette).toContain('{ type: "action", label: "Task", description: "Create a task for the rep" }');
    expect(src).toContain("disabled={readOnly || item.notYet}");
    expect([...NOT_RUN_NODE_TYPES]).toEqual(["condition", "goal"]);
  });

  it("a sequence already holding them says so on its canvas", () => {
    const src = read("client/src/pages/usip/SequenceCanvas.tsx");
    expect(src).toContain("const notRunNotes = canvasNotRunNotes(nodes, edges);");
    expect(src).toMatch(/\{notRunNotes\.length > 0 && \(\s*<div role="note"/);
    expect(src).toContain("{notRunNotes.map((n) => <li key={n}>{n}</li>)}");
  });

  it("a condition's and a goal's panels say not available, and offer nothing to change", () => {
    const cond = panel("condition", { branchOn: "email_opened" });
    expect(cond).toContain("Not available yet. The engine doesn&#x27;t branch");
    expect(cond).toMatch(/<button[^>]*role="combobox"[^>]*disabled=""/);
    const goal = panel("goal", { goalType: "reply" });
    expect(goal).toContain("Not available yet. Nothing watches for this goal");
    expect(goal).toMatch(/<button[^>]*role="combobox"[^>]*disabled=""/);
  });

  it("an action's panel edits the task's text, and an old action type says it isn't available", () => {
    const task = panel("action", { body: "Call them" });
    expect(task).toContain(">Call them</textarea>");
    expect(task).not.toContain("Action type");
    expect(panel("action", { actionType: "apply_tag" })).toContain("This step was set to &quot;Apply tag&quot;, which isn&#x27;t available yet");
  });
});

/* ═══ O27 ══════════════════════════════════════════════════════════════════ */

describe("the settings panel has no exit-condition switches that nothing reads (O27)", () => {
  it("says what really stops someone instead", () => {
    const out = html(createElement(SequenceSettingsPanel, { open: true, readOnly: false, name: "S", description: "", settings: {}, onClose: () => {}, onSave: () => {} }));
    expect(out).not.toContain("Exit conditions");
    for (const label of ["Prospect replies", "Email hard bounces", "Prospect unsubscribes", "Goal node reached", "Manually exited"]) expect(out).not.toContain(label);
    expect(out).toContain("What stops someone");
    for (const line of WHAT_STOPS_SOMEONE) expect(out).toContain(line.replace(/'/g, "&#x27;"));
    expect(out).toContain("Pause someone&#x27;s enrolment when they reply");
    expect(out).not.toContain("Auto-exit when a reply is detected");
  });

  it("and the canvas no longer saves them", () => {
    const save = between(read("client/src/pages/usip/SequenceCanvas.tsx"), "const handleSettingsSave = (patch", "const anyPanelOpen");
    expect(save).not.toContain("exitConditions");
  });
});

/* ═══ O60 ══════════════════════════════════════════════════════════════════ */

describe("a canvas wait offers what the server keeps (O60)", () => {
  it("up to 60 days, and shows a list-built wait's days", () => {
    expect(MAX_WAIT_DAYS).toBe(60);
    expect(read("server/routers/sequences.ts")).toContain('z.object({ type: z.literal("wait"), days: z.number().min(0).max(60)');
    const out = panel("wait", { days: 3 });
    expect(out).toMatch(/<input[^>]*max="60"[^>]*value="3"/);
    expect(out).not.toContain('max="365"');
  });
});

/* ═══ O48 ══════════════════════════════════════════════════════════════════ */

describe("the sequence pages say email steps write drafts (O48)", () => {
  it("and whether auto-send is on here", () => {
    h.autoSend = { data: { aiAutoSendEnabled: false } };
    const off = html(createElement(SequenceDraftsNote));
    expect(off).toContain("Email steps don&#x27;t send by themselves");
    expect(off).toContain(`href="${SEQUENCE_DRAFTS_HREF.replace(/&/g, "&amp;")}"`);
    expect(off).toContain("Auto-send is off in this workspace.");
    h.autoSend = { data: { aiAutoSendEnabled: true } };
    expect(html(createElement(SequenceDraftsNote))).toContain("auto-send is on in this workspace");
    h.autoSend = { isLoading: true };
    expect(html(createElement(SequenceDraftsNote))).toContain("or auto-send does, if it&#x27;s on.");
  });

  it("on the lists, in the editor, on the canvas and in the help article", () => {
    expect(read("client/src/pages/usip/SequencesV2.tsx")).toContain("<SequenceDraftsNote />");
    expect(read("client/src/pages/usip/Sequences.tsx")).toContain("<SequenceDraftsNote />");
    // The legacy header promised branching and auto-stop rules, which never ran (O21, O27).
    expect(read("client/src/pages/usip/Sequences.tsx")).not.toContain("branching conditions, and auto-stop rules");
    const article = read("server/seedHelpContent.ts");
    expect(article).not.toContain("The engine creates and sends drafts on cadence.");
    expect(article).toContain("Email steps write **drafts** on cadence: nothing is sent until someone reviews and sends them");
    expect(read("client/src/pages/usip/SequenceEditor.tsx")).toContain('<SequenceDraftsNote className="mb-3" />');
    expect(read("client/src/pages/usip/SequenceCanvas.tsx")).toContain("Email steps write drafts: nothing is sent until someone reviews and sends them");
  });
});

/* ═══ O38, O39 — the v2 editor ═════════════════════════════════════════════ */

describe("the v2 editor activates and pauses, and its copy matches the engine (O38, O39)", () => {
  const src = read("client/src/pages/usip/SequenceEditor.tsx");

  it("Activate and Pause act on the sequence, here", () => {
    expect(src).toContain("const setStatus = trpc.sequences.setStatus.useMutation({");
    expect(src).toContain('onClick={() => setStatus.mutate({ id, status: "paused" })}');
    expect(src).toContain('onConfirm={() => setStatus.mutate({ id, status: "active" })}');
    expect(src).not.toContain('setLocation("/sequences")');
  });

  it("a refused step edit puts the saved steps back on screen", () => {
    const m = between(src, "const updateSteps = trpc.sequences.updateSteps.useMutation({", "const setStatus =");
    const onError = m.slice(m.indexOf("onError:"));
    expect(onError).toContain("seqQ.refetch()");
    expect(onError).toContain("setSteps(");
  });

  it("one email step, the real send window, and 'You' only for its creator", () => {
    const options = between(src, "const STEP_OPTIONS", "];");
    expect(options).not.toContain("Manual email");
    expect(options).not.toContain("Automatic email");
    expect(options).toContain('label: "Email"');
    expect(src).not.toContain("Mon–Fri, 8 AM–5 PM");
    expect(src).toContain("{describeSendWindow(seq.settings)}");
    expect(src).toContain('seq.ownerUserId === user?.id ? "You created the sequence." : "This sequence was created."');
    expect(describeSendWindow(null)).toBe("Email steps are drafted between 08:00 and 18:00 (the workspace's time zone), Monday to Friday.");
    expect(describeSendWindow({ timezone: "Europe/London", sendWindowStart: "09:30", sendWindowEnd: "16:00", skipWeekends: false }))
      .toBe("Email steps are drafted between 09:30 and 16:00 (Europe/London), every day.");
  });
});

/* ═══ O55 ══════════════════════════════════════════════════════════════════ */

describe("the sequences list shows only controls that do something (O55)", () => {
  it("no saved views, placeholder filters, idle checkboxes or placeholder tabs", () => {
    const src = read("client/src/pages/usip/SequencesV2.tsx");
    for (const dead of ["Save as new view", 'title="View options"', 'label="Starred"', 'label="Tags"', 'label="Performance"', 'label="Folders"', 'label="Shared by"', 'aria-label="Select all"', "const TABS", "Deliverability diagnostics and step-level health", "Open full sequences"]) {
      expect(src, dead).not.toContain(dead);
    }
    // What works stays.
    for (const live of ['label="Owned by"', 'label="Status"', 'aria-label="Search sequences"', "Sort by"]) expect(src, live).toContain(live);
  });
});

/* ═══ Legacy /sequences: O22, O26, O37, O40, O56 ═══════════════════════════ */

describe("legacy /sequences says what deleting does, shows the copy that sends, and refreshes what it changed", () => {
  const src = read("client/src/pages/usip/Sequences.tsx");

  it("deleting says the sent emails and their unsubscribe links stay (O22)", () => {
    expect(src).toContain("Emails it already sent stay in the Emails log, and their unsubscribe links keep working.");
    expect(src).not.toContain("and its steps will be deleted, and enrollments will stop.");
  });

  it("a template step shows its own copy and saves it as shown (O26)", () => {
    const save = between(src, "function handleSaveSteps() {", "\n  }\n");
    expect(save).toContain("updateSteps.mutate({ id: seq.id, steps });");
    expect(src).not.toContain("allTemplatesForSyncQ");
    const editor = between(src, "{step.templateId ? (", ") : (");
    expect(editor).toContain('sanitizeEmailHtml(step.body ?? "")');
    expect(editor).not.toContain("appliedTemplate.htmlOutput");
    expect(editor).toContain("{TEMPLATE_COPY_NOTE}");
    expect(src).toContain('const TEMPLATE_COPY_NOTE = "This is the copy that sends. Later changes to the template don\'t reach it; pick the template again to refresh it.";');
    // The same words as the v2 editor.
    expect(read("client/src/pages/usip/SequenceEditor.tsx")).toContain("This is the copy that sends. Later changes to the template don't reach it; pick the template again to refresh it.");
  });

  it("a status change refreshes the open detail, and an enrolment has a plain Pause (O37)", () => {
    const status = between(src, "const setStatus = trpc.sequences.setStatus.useMutation({", "onError:");
    expect(status).toContain("utils.sequences.get.invalidate({ id: vars.id })");
    expect(src).toContain("const pause = trpc.sequences.pauseEnrollment.useMutation({");
    expect(src).toContain("onClick={() => pause.mutate({ id: e.id })}");
    expect(src).toContain(">Mark replied</Button>");
  });

  it("the enrol dialog searches and pages on the server, marks prospect enrolments and reports every skip (O40)", () => {
    const dialog = between(src, "function EnrollDialog(", "// ─── EnrollmentStatsPanel");
    expect(dialog).toContain("trpc.prospects.list.useQuery({ page: prospectPage, perPage: ENROLL_PROSPECTS_PER_PAGE, search: debounced || undefined })");
    expect(dialog).toContain("trpc.contacts.list.useQuery({ search: debounced || undefined })");
    expect(dialog).toContain("trpc.leads.list.useQuery({ search: debounced || undefined })");
    expect(dialog).not.toContain("perPage: 200");
    expect(dialog).not.toContain("hay.includes(q)");
    expect(dialog).toContain("if (e.prospectId) alreadyProspectIds.add(e.prospectId);");
    expect(dialog).toContain("return alreadyProspectIds.has(p.id) ||");
    expect(dialog).toContain("skipped (in a Revenue Engine campaign)");
  });

  it("loading is not empty (O56)", () => {
    const list = between(src, 'title="All sequences"', "</Section>");
    expect(list.indexOf("isLoading ?")).toBeGreaterThan(-1);
    expect(list.indexOf("isLoading ?")).toBeLessThan(list.indexOf('title="None yet"'));
    const inbox = read("client/src/pages/usip/Inbox.tsx");
    const body = inbox.slice(inbox.indexOf("{/* Not read yet is not"));
    expect(body.indexOf("isLoading ?")).toBeGreaterThan(-1);
    expect(body.indexOf("isLoading ?")).toBeLessThan(body.indexOf(': "Inbox zero"'));
  });
});
