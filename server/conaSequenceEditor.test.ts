/**
 * U14 (audit 2026-10-20): one sequence editor.
 *
 * The v2 editor (/v2/sequences/:id) is the survivor. Legacy /sequences and its
 * canvas redirect to it, after everything only they had was folded in:
 *
 *   what either old screen saved loads and saves here unchanged, steps and
 *   settings both · the canvas's AI-written email steps and waits in hours ·
 *   A/B variants, read from the derived numbers, and kept at their step · the
 *   bulk enrol picker · the daily cap and reply detection · Archive and Delete
 *   · "Mark replied" · the prospect preview, showing the copy that sends · the
 *   per-step report · a note for a canvas drawing that held more than ran ·
 *   the redirects keep a canvas deep link's id.
 *
 * Procedures run for real against the SQL-evaluating fake; screens are pinned
 * by slicing their source, and the small components are rendered.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, mutated: [] as Array<{ name: string; input: unknown }> };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("@/lib/trpc", () => {
  const mutation = (name: string) => ({ useMutation: () => ({ mutate: (input: unknown) => h.mutated.push({ name, input }), isPending: false }) });
  return {
    trpc: {
      useUtils: () => new Proxy({}, { get: () => new Proxy({}, { get: () => ({ invalidate: () => {} }) }) }),
      sequences: { pauseOnReply: mutation("pauseOnReply") },
    },
  };
});

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { RETIRED_ROUTES, retiredRedirectUrl } from "../client/src/lib/retiredRoutes";
import { stepWithDisplacedVariants, waitDaysFrom, waitParts } from "../client/src/lib/sequenceSteps";
import { canvasLeftovers } from "../client/src/lib/canvasSupport";
import { extractEmails } from "../client/src/components/usip/EmailClientPreview";
import { variantCountsByStep } from "../client/src/components/usip/SequenceAbTests";
import { SequenceMarkReply } from "../client/src/components/usip/SequenceMarkReply";

const WS = 2;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
/** The text between two anchors, both of which must exist. */
function between(src: string, from: string, to: string): string {
  const i = src.indexOf(from);
  expect(i, `anchor "${from}"`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(to, i + from.length);
  expect(j, `anchor "${to}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}
const EDITOR = read("client/src/pages/usip/SequenceEditor.tsx");
const APP = read("client/src/App.tsx");

function caller() {
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
const stored = (id: number) => rows("sequences").find((s) => s.id === id);
/** JSON as the database keeps it: undefined keys are not stored. */
const asStored = (v: unknown) => JSON.parse(JSON.stringify(v));

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  h.mutated = [];
  rows("sequences").push(
    { id: 1, workspaceId: WS, name: "Canvas-built", status: "paused", steps: [], settings: null, dailyCap: null, isTemplate: false, ownerUserId: 1 },
    { id: 2, workspaceId: WS, name: "Legacy-built", status: "draft", steps: [], settings: null, dailyCap: null, isTemplate: false, ownerUserId: 1 },
  );
});

/* ── What the old screens saved, loaded and saved by the v2 editor ─────────── */

/** A canvas as the retired canvas saved it, every field it wrote. */
const CANVAS = {
  nodes: [
    { id: "start-1", type: "start" as const, positionX: 250, positionY: 50, data: { label: "Sequence start" } },
    { id: "email-1", type: "email" as const, positionX: 250, positionY: 180, data: { label: "Opener", emailMode: "dynamic", aiTone: "friendly", aiLength: "short", aiFocus: "book a call about their stack" } },
    { id: "wait-1", type: "wait" as const, positionX: 250, positionY: 310, data: { delayDays: 1, delayHours: 6 } },
    { id: "cond-1", type: "condition" as const, positionX: 250, positionY: 440, data: { branchOn: "email_opened" } },
    { id: "email-2", type: "email" as const, positionX: 150, positionY: 570, data: { emailMode: "typed", staticSubject: "Following up", staticBody: "<p>Hi {{firstName}}</p>", staticTemplateId: 7, enabled: false } },
    { id: "act-1", type: "action" as const, positionX: 150, positionY: 700, data: { body: "Call them", actionType: "create_task" } },
    { id: "li-1", type: "linkedin_dm" as const, positionX: 150, positionY: 830, data: { linkedinMessage: "Hi {{firstName}}" } },
    { id: "li-2", type: "linkedin_invite" as const, positionX: 150, positionY: 960, data: { linkedinNote: "Let's connect" } },
    { id: "lost-1", type: "email" as const, positionX: 450, positionY: 570, data: { staticSubject: "On the FALSE path" } },
    { id: "goal-1", type: "goal" as const, positionX: 600, positionY: 700, data: {} },
  ],
  edges: [
    { id: "e1", source: "start-1", target: "email-1" },
    { id: "e2", source: "email-1", target: "wait-1" },
    { id: "e3", source: "wait-1", target: "cond-1" },
    { id: "e4", source: "cond-1", target: "email-2", sourceHandle: "true" },
    { id: "e5", source: "cond-1", target: "lost-1", sourceHandle: "false" },
    { id: "e6", source: "email-2", target: "act-1" },
    { id: "e7", source: "act-1", target: "li-1" },
    { id: "e8", source: "li-1", target: "li-2" },
  ],
};

describe("what the retired canvas saved loads and saves unchanged in the v2 editor", () => {
  it("steps: the canvas's save, read back, saved by the editor as it loads them, is what was stored", async () => {
    await caller().sequences.saveCanvas({ id: 1, ...CANVAS });
    const fromCanvas = asStored(stored(1).steps);
    // The steps the engine runs carry every field the canvas wrote.
    expect(fromCanvas).toEqual([
      { type: "email", subject: "", body: "", emailMode: "dynamic", aiTone: "friendly", aiLength: "short", aiFocus: "book a call about their stack" },
      { type: "wait", days: 1.25 },
      { type: "email", subject: "Following up", body: "<p>Hi {{firstName}}</p>", templateId: 7, enabled: false },
      { type: "task", body: "Call them" },
      { type: "linkedin_dm", body: "Hi {{firstName}}" },
      { type: "linkedin_invite", note: "Let's connect" },
    ]);
    // The editor loads `sequences.get` and saves its `steps` through updateSteps.
    const loaded = await caller().sequences.get({ id: 1 });
    await caller().sequences.updateSteps({ id: 1, steps: (loaded as any).steps });
    expect(asStored(stored(1).steps)).toEqual(fromCanvas);
    // And again, so a second save is not where something drops.
    await caller().sequences.updateSteps({ id: 1, steps: asStored(stored(1).steps) });
    expect(asStored(stored(1).steps)).toEqual(fromCanvas);
  });

  it("the editor shows that wait as it was saved, and keeps it: 1 day 6 hours is 1.25 days", () => {
    expect(waitParts(1.25)).toEqual({ days: 1, hours: 6 });
    const p = waitParts(1.25);
    expect(waitDaysFrom(p.days, p.hours)).toBe(1.25);
    // A plain day count stays a whole number, so a list-built wait is not rewritten.
    expect(waitDaysFrom(waitParts(3).days, waitParts(3).hours)).toBe(3);
    expect(waitParts(0)).toEqual({ days: 0, hours: 0 });
    expect(waitDaysFrom(70, 5)).toBe(60);
    // A third of a day reads as 8 hours and is kept, not rounded away, until edited.
    expect(waitParts(1 / 3)).toEqual({ days: 0, hours: 8 });
  });

  it("settings: the canvas panel's and the legacy dialog's choices survive the v2 settings saves", async () => {
    // As the canvas panel saved them (SequenceCanvas handleSettingsSave), then
    // the legacy edit dialog (handleSaveSettings), which also set the cap.
    await caller().sequences.updateMeta({ id: 1, name: "Canvas-built", description: "d", settings: { timezone: "America/Chicago", sendWindowStart: "09:00", sendWindowEnd: "17:00", skipWeekends: false, replyDetection: false } });
    await caller().sequences.updateMeta({ id: 1, name: "Canvas-built", description: "d", dailyCap: 25, settings: { skipWeekends: false, replyDetection: false, sendWindowStart: "09:00", sendWindowEnd: "17:00" } });
    const before = asStored(stored(1).settings);
    expect(before).toEqual({ timezone: "America/Chicago", sendWindowStart: "09:00", sendWindowEnd: "17:00", skipWeekends: false, replyDetection: false });
    expect(stored(1).dailyCap).toBe(25);

    // What the v2 settings tab sends when its fields are saved as loaded
    // (pinned to the screen's source below).
    await caller().sequences.updateMeta({ id: 1, settings: { timezone: before.timezone, sendWindowStart: before.sendWindowStart, sendWindowEnd: before.sendWindowEnd, skipWeekends: before.skipWeekends } });
    await caller().sequences.update({ id: 1, patch: { name: "Canvas-built", description: "d", dailyCap: 25 } });
    await caller().sequences.updateMeta({ id: 1, settings: { replyDetection: false } });
    expect(asStored(stored(1).settings)).toEqual(before);
    expect(stored(1).dailyCap).toBe(25);

    // Turning reply detection back on changes that key and nothing else.
    await caller().sequences.updateMeta({ id: 1, settings: { replyDetection: true } });
    expect(asStored(stored(1).settings)).toEqual({ ...before, replyDetection: true });
    // An emptied cap clears it, as the legacy dialog's blank did.
    await caller().sequences.update({ id: 1, patch: { name: "Canvas-built", description: "d", dailyCap: null } });
    expect(stored(1).dailyCap).toBeNull();
  });

  it("the v2 screens send exactly those payloads", () => {
    const schedule = read("client/src/components/usip/SequenceScheduleSettings.tsx");
    expect(schedule).toContain("save.mutate({ id: sequenceId, settings: { timezone: zone, sendWindowStart: start, sendWindowEnd: end, skipWeekends } })");
    // Loaded from what is stored, with the engine's defaults when unset.
    expect(schedule).toContain('const [start, setStart] = useState(s.sendWindowStart || "08:00");');
    expect(schedule).toContain("const [skipWeekends, setSkipWeekends] = useState(s.skipWeekends !== false);");
    expect(EDITOR).toContain('patch: { name: name.trim(), description: description.trim() || null, dailyCap: dailyCap.trim() === "" ? null : Math.round(Number(dailyCap)) }');
    expect(EDITOR).toContain('setDailyCap(seq.dailyCap != null ? String(seq.dailyCap) : "");');
    expect(EDITOR).toContain("onCheckedChange={(on) => saveReplyDetection.mutate({ id, settings: { replyDetection: on } })}");
    expect(EDITOR).toContain("checked={(seq.settings as { replyDetection?: boolean } | null)?.replyDetection !== false}");
  });

  it("steps the legacy edit dialog saved (template copy, rich-text task) round-trip too", async () => {
    const legacy = [
      { type: "email", subject: "Intro", body: "<table><tr><td>Built</td></tr></table>", templateId: 3 },
      { type: "wait", days: 2 },
      { type: "task", body: "<p>Call and <strong>reference</strong> the post</p>" },
    ];
    await caller().sequences.updateSteps({ id: 2, steps: legacy as any });
    const loaded = await caller().sequences.get({ id: 2 });
    await caller().sequences.updateSteps({ id: 2, steps: (loaded as any).steps });
    expect(asStored(stored(2).steps)).toEqual(legacy);
    // The editor keeps an HTML task in a rich-text editor instead of showing its markup.
    const task = between(EDITOR, 'if (step.type === "task") {', 'if (step.type === "linkedin_invite")');
    expect(task).toContain('isHtmlBody(step.body ?? "")');
    expect(task).toContain("<RichTextEditor");
  });
});

/* ── What the canvas had that the editor did not ───────────────────────────── */

describe("the canvas's AI-written email steps and waits in hours", () => {
  const email = between(EDITOR, 'if (step.type === "email") {', 'if (step.type === "wait") {');

  it("an AI step shows as one, with its tone, length and goal, saved at once", () => {
    expect(email).toContain('const ai = step.emailMode === "dynamic";');
    expect(email).toContain('aria-label="AI tone"');
    expect(email).toContain('aria-label="AI length"');
    expect(email).toContain('aria-label="What the AI email is for"');
    expect(email).toContain("onCommit({ aiTone: e.target.value } as Partial<Step>)");
    expect(email).toContain("onCommit({ aiLength: e.target.value } as Partial<Step>)");
    // The engine skips a dynamic step with no goal; the screen says so.
    expect(email).toContain("Without this the step is skipped");
  });

  it("switching to AI says what it spends and asks first; switching back needs no question", () => {
    const confirm = between(email, "<ConfirmButton", "</ConfirmButton>");
    expect(confirm).toContain("one AI call each, up to about 700 tokens");
    expect(confirm).toContain("${enrolledCount}");
    expect(confirm).toContain("nothing goes out while outbound sending is paused");
    expect(confirm).toContain('onConfirm={() => onCommit({ emailMode: "dynamic"');
    expect(email).toContain('onClick={() => { if (ai) onCommit({ emailMode: "typed" } as Partial<Step>); }}');
  });

  it("a wait has days and hours", () => {
    const wait = between(EDITOR, 'if (step.type === "wait") {', 'if (step.type === "task") {');
    expect(wait).toContain("const parts = waitParts(step.days);");
    expect(wait).toContain('aria-label="Wait hours"');
    expect(wait).toContain("onChange({ days: waitDaysFrom(parts.days, Number(e.target.value)) } as any)");
  });

  it("a drawing that held more than ran says so, before a save redraws it", async () => {
    const left = canvasLeftovers(CANVAS.nodes, CANVAS.edges);
    expect(left.unreached).toBe(2); // the FALSE-path email and the loose goal
    expect(left.notes.join(" ")).toContain("1 condition on this canvas doesn't branch yet");
    expect(left.notes.join(" ")).toContain("1 goal isn't available yet");
    // A straight line, the shape any save from the editor leaves (stepsToCanvas:
    // start-1 → <type>-1 → <type>-2 …), has nothing to say. Built here because
    // the fake numbers every inserted row's id, and canvas ids are strings.
    const line = [
      { id: "start-1", type: "start" }, { id: "email-1", type: "email" }, { id: "wait-2", type: "wait" }, { id: "action-3", type: "action", data: { body: "Call" } },
    ];
    const lineEdges = [
      { id: "e-start-1-email-1", source: "start-1", target: "email-1", sourceHandle: null },
      { id: "e-email-1-wait-2", source: "email-1", target: "wait-2", sourceHandle: null },
      { id: "e-wait-2-action-3", source: "wait-2", target: "action-3", sourceHandle: null },
    ];
    expect(canvasLeftovers(line, lineEdges)).toEqual({ notes: [], unreached: 0 });
    expect(canvasLeftovers([], [])).toEqual({ notes: [], unreached: 0 });
    const note = between(EDITOR, "{(leftovers.notes.length > 0 || leftovers.unreached > 0) && (", "</div>\n              )}");
    expect(note).toContain("Saving them here redraws the canvas as a straight line");
    expect(EDITOR).toContain("trpc.sequences.getCanvas.useQuery({ id }");
  });
});

/* ── What legacy /sequences had that the editor did not ────────────────────── */

describe("A/B tests", () => {
  const ab = read("client/src/components/usip/SequenceAbTests.tsx");

  it("a tab in the editor, locked while the server would refuse", () => {
    expect(EDITOR).toContain('const TABS = ["Editor", "Contacts", "A/B tests", "Activity", "Report", "Settings"] as const;');
    const tab = between(EDITOR, '{tab === "A/B tests" && (', ")}");
    expect(tab).toContain("<SequenceAbTests");
    expect(tab).toContain('seq.status === "active" ? "Pause the sequence to change its variants."');
  });

  it("reads the derived numbers, never the dead counters, and says what a variant does to sending", () => {
    expect(ab).toContain("trpc.sequenceAb.list.useQuery({ sequenceId, stepIndex }");
    expect(ab).not.toMatch(/sequenceAb\.getStats\.useQuery/);
    expect(ab).toContain("the step's own copy\n          is not sent");
    expect(ab).toContain("Sends still follow the splits");
  });

  it("a step with variants cannot be moved or removed out from under them", () => {
    const counts = variantCountsByStep([{ stepIndex: 2 }, { stepIndex: 2 }, { stepIndex: 4 }]);
    expect(counts.get(2)).toBe(2);
    // Removing step 0 shifts step 2 (and 4): refused at the first one.
    expect(stepWithDisplacedVariants({ kind: "remove", at: 0 }, 5, counts)).toBe(2);
    expect(stepWithDisplacedVariants({ kind: "remove", at: 3 }, 5, counts)).toBe(4);
    // Removing the last step, which has none, is fine.
    expect(stepWithDisplacedVariants({ kind: "remove", at: 4 }, 6, new Map([[2, 1]]))).toBeNull();
    expect(stepWithDisplacedVariants({ kind: "move", from: 0, to: 1 }, 5, counts)).toBeNull();
    expect(stepWithDisplacedVariants({ kind: "move", from: 1, to: 2 }, 5, counts)).toBe(2);
    expect(EDITOR).toContain('if (displacesVariants({ kind: "remove", at: i })) return;');
    expect(EDITOR).toContain('if (displacesVariants({ kind: "move", from: i, to: j })) return;');
  });
});

describe("enrolments", () => {
  it("Add contacts opens the bulk enrol picker in the editor, from the header and the empty tab", () => {
    expect(EDITOR).toContain("onClick={() => setEnrollOpen(true)}><Users className=\"size-3.5\" /> Add contacts</Button>");
    expect(EDITOR).toContain("onAddContacts={() => setEnrollOpen(true)}");
    expect(EDITOR).not.toContain('setLocation("/v2/people")');
    expect(EDITOR).toContain("<SequenceEnrollDialog sequenceId={id} open={enrollOpen} onClose={() => setEnrollOpen(false)} />");
  });

  it("the picker is legacy's own, moved, and refreshes every enrolment read itself", () => {
    const dialog = read("client/src/components/usip/SequenceEnrollDialog.tsx");
    expect(dialog).toContain("trpc.prospects.list.useQuery({ page: prospectPage, perPage: ENROLL_PROSPECTS_PER_PAGE, search: debounced || undefined })");
    expect(dialog).toContain("trpc.sequences.bulkEnroll.useMutation");
    expect(dialog).toContain("invalidateEnrollmentReads(utils, sequenceId);");
    expect(dialog).toContain("r.heldUntilActive");
    expect(read("client/src/pages/usip/Sequences.tsx")).toContain('import { SequenceEnrollDialog } from "@/components/usip/SequenceEnrollDialog";');
  });

  it("Mark replied is offered on an active row, asks first, and is pauseOnReply", () => {
    const active = renderToStaticMarkup(createElement(SequenceMarkReply, { enrollment: { id: 5, status: "active", personName: "Sam" }, sequenceId: 1 }));
    expect(active).toContain(">Mark replied<");
    for (const s of ["paused", "finished", "exited"]) {
      expect(renderToStaticMarkup(createElement(SequenceMarkReply, { enrollment: { id: 5, status: s }, sequenceId: 1 }))).toBe("");
    }
    const src = read("client/src/components/usip/SequenceMarkReply.tsx");
    expect(src).toContain("onConfirm={() => replied.mutate({ enrollmentId: enrollment.id })}");
    expect(src).toContain("a task to follow up their reply is filed for tomorrow");
    expect(EDITOR).toContain("<SequenceMarkReply enrollment={e} sequenceId={sequenceId} />");
  });
});

describe("archive, delete, preview and the per-step report", () => {
  it("Archive asks first and says it ends the enrolments; an archived one can come back as a draft", () => {
    const archive = between(EDITOR, '{seq.status !== "archived" && (', "</ConfirmButton>");
    expect(archive).toContain("Everyone still active or paused in it is taken out");
    expect(archive).toContain('onConfirm={() => setStatus.mutate({ id, status: "archived" })}');
    expect(EDITOR).toContain('onClick={() => setStatus.mutate({ id, status: "draft" })}');
  });

  it("Delete asks first, with legacy's words about what stays", () => {
    const del = between(EDITOR, "{/* Delete, from legacy /sequences (U14), saying what stays (O22). */}", "</ConfirmButton>");
    expect(del).toContain("Emails it already sent stay in the Emails log, and their unsubscribe links keep working.");
    expect(del).toContain("onConfirm={() => removeSeq.mutate({ id })}");
  });

  it("the preview shows each step's own copy, skips a skipped step and says an AI step has none yet", () => {
    const emails = extractEmails([
      { type: "email", subject: "Mine", body: "<p>copy</p>", templateId: 9 },
      { type: "wait", days: 2 },
      { type: "email", subject: "Gone", body: "x", enabled: false },
      { type: "email", subject: "", body: "", emailMode: "dynamic", aiFocus: "<b>a call</b>" },
    ]);
    expect(emails.map((e) => [e.stepIndex, e.day, e.subject])).toEqual([[0, 1, "Mine"], [3, 3, "(written by AI when this step runs)"]]);
    expect(emails[0].body).toBe("<p>copy</p>");
    expect(emails[1].body).toContain("&lt;b&gt;a call&lt;/b&gt;");
    const preview = read("client/src/components/usip/EmailClientPreview.tsx");
    expect(preview).not.toContain("tpl?.htmlOutput");
    expect(EDITOR).toContain("<EmailClientPreview open={previewOpen} onClose={() => setPreviewOpen(false)} steps={steps} sequenceName={seq.name} />");
  });

  it("the Report tab has the per-step table", () => {
    expect(EDITOR).toContain('{tab === "Report" && <SequenceStepBreakdown sequenceId={id} accent={accent} />}');
    const table = read("client/src/components/usip/SequenceStepBreakdown.tsx");
    expect(table).toContain("trpc.sequences.getStepAnalytics.useQuery({ sequenceId })");
    expect(table).toContain('sent > 0 ? `${rate}%` : "—"');
  });

  it("the Scheduling card reads the sequence's real window, not a fixed one", () => {
    const card = between(EDITOR, '<h2 className="text-sm font-semibold mb-2">Scheduling</h2>', "<SequenceScheduleSettings");
    expect(card).toContain("{describeSendWindow(seq.settings)}");
    expect(card).not.toMatch(/9(:00)?\s?(am|AM)|8:00 AM|Mon(day)?\s?[–-]\s?Fri(day)?,/);
  });
});

/* ── The old routes ─────────────────────────────────────────────────────────── */

describe("legacy /sequences and the canvas redirect to the editor", () => {
  it("both routes render the redirect, and the canvas keeps its sequence id", () => {
    expect(APP).toContain('<Route path="/sequences"><AuthGate><RetiredRedirect from="/sequences" /></AuthGate></Route>');
    expect(APP).toContain('<Route path="/sequences/:id/canvas"><AuthGate><RetiredRedirect from="/sequences/:id/canvas" /></AuthGate></Route>');
    expect(RETIRED_ROUTES["/sequences"]).toBe("/v2/sequences");
    expect(retiredRedirectUrl("/sequences")).toBe("/v2/sequences");
    expect(retiredRedirectUrl("/sequences/:id/canvas", { params: { id: "42" } })).toBe("/v2/sequences/42");
    expect(retiredRedirectUrl("/sequences/:id/canvas", { params: { id: "42" }, search: "?from=email" })).toBe("/v2/sequences/42?from=email");
  });

  it("nothing in the app still links to them", () => {
    for (const f of ["client/src/components/usip/settings/GuidedMailboxSetup.tsx", "client/src/components/usip/Shell.tsx", "client/src/components/usip/Elsie.tsx", "client/src/pages/usip/SequencesV2.tsx", "client/src/pages/usip/SequenceEditor.tsx"]) {
      expect(read(f), f).not.toMatch(/["'`]\/sequences(["'`/?]|$)/m);
    }
    const help = read("server/seedHelpContent.ts");
    expect(help).not.toContain('"/sequences"');
    // The tour that pointed at legacy's New button points at the v2 one.
    expect(read("client/src/pages/usip/SequencesV2.tsx")).toContain('data-tour-id="sequences-new-button"');
  });
});
