/**
 * What the v2 sequence editor took over from legacy /sequences.
 *
 *   pause, resume and exit one person, through procedures that refuse a stale
 *   row and file no false reply task · how many people sit at each step, counted
 *   off the rows the tab lists · real numbers on the Report tab, where an unknown
 *   and a rate with nothing to divide by are dashes · a template picker that asks
 *   before replacing anything, and keeps Email Builder HTML out of the rich-text
 *   editor until someone chooses to edit it.
 *
 * Procedures run for real against the SQL-evaluating fake. Components are
 * rendered with their query results stubbed, so a real procedure's answer can be
 * handed straight to the screen that shows it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, report: {} as Record<string, unknown>, reportInputs: [] as unknown[], templates: {} as Record<string, unknown> };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("@/lib/trpc", () => {
  const mutation = { useMutation: () => ({ mutate: () => {}, isPending: false }) };
  return {
    trpc: {
      useUtils: () => new Proxy({}, { get: () => new Proxy({}, { get: () => ({ invalidate: () => {} }) }) }),
      sequences: {
        pauseEnrollment: mutation, resumeEnrollment: mutation, exitEnrollment: mutation,
        getPerformanceAnalytics: { useQuery: (input: unknown) => { h.reportInputs.push(input); return h.report; } },
      },
      emailTemplates: { list: { useQuery: () => h.templates } },
    },
  };
});

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { applyTemplate, detachTemplate, hasBodyContent, stepDistribution, templateWouldReplace, usableTemplates, type EmailStep } from "../client/src/lib/sequenceSteps";
import { SequenceEnrollmentActions } from "../client/src/components/usip/SequenceEnrollmentActions";
import { SequenceReport } from "../client/src/components/usip/SequenceReport";
import { StepTemplatePicker } from "../client/src/components/usip/StepTemplatePicker";

const WS = 2, OTHER = 9;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const enrollment = (id: number) => rows("enrollments").find((e) => e.id === id);
const html = (el: any) => renderToStaticMarkup(el);
const report = () => html(createElement(SequenceReport, { sequenceId: 1, accent: "#123456" }));

function caller(role: "rep" | "viewer" = "rep") {
  h.db.setRole?.(WS, role);
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e; }
  throw new Error("expected a refusal");
}

const DUE = new Date("2026-12-01T15:00:00Z");
beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  h.report = {};
  h.reportInputs = [];
  h.templates = { data: [], isLoading: false, isError: false };
  rows("sequences").push({ id: 1, workspaceId: WS, name: "One", status: "draft", steps: [], isTemplate: false, ownerUserId: 1 });
  rows("enrollments").push(
    { id: 11, workspaceId: WS, sequenceId: 1, status: "active", currentStep: 0, nextActionAt: DUE, resumeAt: new Date("2026-12-05T00:00:00Z"), contactId: 5 },
    { id: 12, workspaceId: WS, sequenceId: 1, status: "paused", currentStep: 1, nextActionAt: DUE, resumeAt: new Date("2026-12-05T00:00:00Z"), contactId: 6 },
    { id: 13, workspaceId: WS, sequenceId: 1, status: "finished", currentStep: 2, nextActionAt: null, resumeAt: null, contactId: 7 },
    { id: 14, workspaceId: WS, sequenceId: 1, status: "exited", currentStep: 1, nextActionAt: null, resumeAt: null, contactId: 8 },
    { id: 21, workspaceId: OTHER, sequenceId: 9, status: "active", currentStep: 0, nextActionAt: DUE, resumeAt: null, contactId: 9 },
  );
});

/* ── Acting on one person ────────────────────────────────────────────────── */

describe("pausing someone", () => {
  it("pauses them, keeps the step's due time, and overrides a snooze", async () => {
    await caller().sequences.pauseEnrollment({ id: 11 });
    expect(enrollment(11)).toMatchObject({ status: "paused", resumeAt: null, nextActionAt: DUE });
  });

  it("does not claim a reply: pauseOnReply files a task saying one was detected, this does not", async () => {
    await caller().sequences.pauseEnrollment({ id: 11 });
    expect(rows("tasks")).toEqual([]);
    // The legacy door does, which is why it isn't used for a plain pause.
    await caller().sequences.pauseOnReply({ enrollmentId: 12 });
    enrollment(12).status = "active";
    await caller().sequences.pauseOnReply({ enrollmentId: 12 });
    expect(rows("tasks").map((t) => t.title)).toEqual(["Reply detected — review sequence enrollment"]);
  });

  it.each([[12, "paused"], [13, "finished"], [14, "exited"]])("refuses enrolment %i, which is %s, and leaves it alone", async (id, status) => {
    const e = await refusal(caller().sequences.pauseEnrollment({ id }));
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toContain(status);
    expect(enrollment(id).status).toBe(status);
  });

  it("can't reach another workspace's enrolment", async () => {
    expect((await refusal(caller().sequences.pauseEnrollment({ id: 21 }))).code).toBe("NOT_FOUND");
    expect(enrollment(21).status).toBe("active");
  });

  it("then Resume brings them back on the schedule they had", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T15:00:00Z"));
    try {
      await caller().sequences.pauseEnrollment({ id: 11 });
      await caller().sequences.resumeEnrollment({ id: 11 });
      expect(enrollment(11)).toMatchObject({ status: "active", resumeAt: null, nextActionAt: DUE });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("taking someone out", () => {
  it.each([[11, "active"], [12, "paused"]])("exits enrolment %i, which is %s, and clears any snooze", async (id) => {
    await caller().sequences.exitEnrollment({ id });
    expect(enrollment(id)).toMatchObject({ status: "exited", resumeAt: null });
  });

  it.each([[13, "finished"], [14, "exited"]])("refuses enrolment %i, which is %s, so a stale tab can't move the exit rate", async (id, status) => {
    const e = await refusal(caller().sequences.exitEnrollment({ id }));
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toContain(status);
    expect(enrollment(id).status).toBe(status);
  });

  it("can't reach another workspace's enrolment", async () => {
    expect((await refusal(caller().sequences.exitEnrollment({ id: 21 }))).code).toBe("NOT_FOUND");
    expect(enrollment(21).status).toBe("active");
  });
});

describe("the buttons on a row", () => {
  const actions = (status: string) => html(createElement(SequenceEnrollmentActions, { enrollment: { id: 1, status, personName: "Sam" }, sequenceId: 1 }));

  it("an active person can be paused or taken out", () => {
    expect(actions("active")).toContain(">Pause<");
    expect(actions("active")).toContain(">Exit<");
    expect(actions("active")).not.toContain(">Resume<");
  });
  it("a paused person can be resumed or taken out", () => {
    expect(actions("paused")).toContain(">Resume<");
    expect(actions("paused")).toContain(">Exit<");
    expect(actions("paused")).not.toContain(">Pause<");
  });
  it.each(["finished", "exited", "something new"])("%s offers nothing", (status) => {
    expect(actions(status)).toBe("");
  });
  it("each button calls its own procedure, Exit asks first, and every outcome refreshes the list", () => {
    const src = read("client/src/components/usip/SequenceEnrollmentActions.tsx");
    expect(src).toContain("pause.mutate({ id: enrollment.id })");
    expect(src).toContain("resume.mutate({ id: enrollment.id })");
    expect(src).toContain("onConfirm={() => exit.mutate({ id: enrollment.id })}");
    expect(src).toContain("const done = (message: string) => () => { refresh(); toast.success(message); };");
    expect(src).toContain("const failed = (e: { message: string }) => { refresh(); toast.error(e.message); };");
    expect(src.match(/onError: failed/g)).toHaveLength(3);
    /**
     * 2026-11-06: this used to pin the hand-written
     * `utils.sequences.listEnrollments.invalidate({ sequenceId })`. That line
     * moved into `invalidateEnrollmentReads` (client/src/lib/enrollmentCache.ts)
     * because invalidating only the queries one screen happens to read is
     * exactly what left the v2 Contacts tab stale after an enrol from the
     * People page — this component's own refresh was missing the two legacy
     * reads, and the two bulk-enrol paths were missing this one. The
     * guarantee here is unchanged: every outcome refreshes. The full set of
     * reads, and the rule that every enrolment writer goes through one
     * function, are pinned by server/enrollmentCacheInvalidation.test.ts.
     */
    expect(src).toContain("const refresh = () => invalidateEnrollmentReads(utils, sequenceId);");
    expect(src).not.toContain("pauseOnReply.");
  });
});

/* ── People at each step ─────────────────────────────────────────────────── */

describe("how many people sit at each step", () => {
  it("counts active and paused only: someone finished or exited has left", () => {
    expect(stepDistribution([
      { status: "active", currentStep: 0 }, { status: "paused", currentStep: 1 }, { status: "active", currentStep: 1 },
      { status: "finished", currentStep: 2 }, { status: "exited", currentStep: 0 },
    ], 3)).toEqual({ perStep: [1, 2, 0], beyond: 0, total: 3 });
  });

  it("someone past the end is counted, so the bars still add up", () => {
    expect(stepDistribution([{ status: "active", currentStep: 3 }, { status: "paused", currentStep: 0 }], 2)).toEqual({ perStep: [1, 0], beyond: 1, total: 2 });
    expect(stepDistribution([{ status: "active", currentStep: 0 }], 0)).toEqual({ perStep: [], beyond: 1, total: 1 });
  });

  it("a missing or nonsense step reads as the first, as the row's own label does", () => {
    expect(stepDistribution([{ status: "active" }, { status: "active", currentStep: -1 }, { status: "active", currentStep: "2" }], 2).perStep).toEqual([3, 0]);
  });

  it("nobody is nobody", () => {
    expect(stepDistribution([], 3)).toEqual({ perStep: [0, 0, 0], beyond: 0, total: 0 });
  });

  it("reads the real procedure's rows", async () => {
    const list = await caller().sequences.listEnrollments({ sequenceId: 1 });
    expect(stepDistribution(list, 3)).toEqual({ perStep: [1, 1, 0], beyond: 0, total: 2 });
  });

  it("the tab counts off the rows it lists, only once they are read", () => {
    const src = read("client/src/pages/usip/SequenceEditor.tsx");
    expect(src).toContain("const atStep = useMemo(() => stepDistribution(known ?? [], steps.length), [known, steps.length]);");
    expect(src).toContain("{known && atStep.total > 0 && (");
    expect(src).toContain("{atStep.perStep[i]}");
    expect(src).toContain("{atStep.beyond > 0 && (");
  });
});

/* ── The Report tab ──────────────────────────────────────────────────────── */

describe("the Report tab", () => {
  const tile = (page: string, label: string) => {
    const at = page.indexOf(`>${label}<`);
    expect(at, label).toBeGreaterThan(-1);
    return page.slice(at + label.length + 2).match(/>([^<]+)</)?.[1];
  };

  it("asks for this sequence", () => {
    report();
    expect(h.reportInputs[0]).toEqual({ sequenceId: 1 });
  });

  it("an unread number is a dash, not a zero, and doesn't claim nothing was sent", () => {
    h.report = { data: undefined, isError: false };
    const page = report();
    for (const label of ["Emails sent", "Open rate", "Click rate", "Bounce rate", "Exit rate"]) expect(tile(page, label)).toBe("—");
    expect(page).not.toContain("0%");
    expect(page).not.toContain("Nothing has been sent");
  });

  it("a failed read says so in words, and shows no number", () => {
    h.report = { data: undefined, isError: true, error: { message: "boom" } };
    const page = report();
    expect(page).toContain("could not be read, so they are shown as unknown rather than zero. boom");
    expect(tile(page, "Emails sent")).toBe("—");
    expect(page).not.toContain("Nothing has been sent");
  });

  it("real numbers from the real procedure", async () => {
    rows("email_drafts").push(
      { id: 1, workspaceId: WS, sequenceId: 1, status: "sent", openCount: 2, clickCount: 1, bouncedAt: null, sentAt: new Date("2026-10-10T12:00:00Z") },
      { id: 2, workspaceId: WS, sequenceId: 1, status: "sent", openCount: 0, clickCount: 0, bouncedAt: new Date(), sentAt: new Date("2026-10-11T12:00:00Z") },
      { id: 3, workspaceId: WS, sequenceId: 1, status: "sent", openCount: 0, clickCount: 0, bouncedAt: null, sentAt: new Date("2026-10-12T12:00:00Z") },
      { id: 4, workspaceId: WS, sequenceId: 1, status: "sent", openCount: 1, clickCount: 0, bouncedAt: null, sentAt: new Date("2026-10-13T12:00:00Z") },
    );
    h.report = { data: await caller().sequences.getPerformanceAnalytics({ sequenceId: 1 }), isError: false };
    const page = report();
    expect(tile(page, "Emails sent")).toBe("4");
    expect(tile(page, "Open rate")).toBe("50%");
    expect(tile(page, "Click rate")).toBe("25%");
    expect(tile(page, "Bounce rate")).toBe("25%");
    expect(tile(page, "Exit rate")).toBe("25%");
    expect(page).toContain("2 unique opens");
    expect(page).toContain("1 of 4 exited, all time");
    expect(page).toContain(">Opened<");
    expect(page).not.toContain("Nothing has been sent");
  });

  it("nothing sent is zero sent, and a rate over nothing is a dash", async () => {
    h.report = { data: await caller().sequences.getPerformanceAnalytics({ sequenceId: 1 }), isError: false };
    const page = report();
    expect(tile(page, "Emails sent")).toBe("0");
    for (const label of ["Open rate", "Click rate", "Bounce rate"]) expect(tile(page, label)).toBe("—");
    expect(tile(page, "Exit rate")).toBe("25%"); // Exit rate is over enrollments, and there are four.
    expect(page).toContain("Nothing has been sent yet");
    expect(page).not.toContain(">Opened<");
  });

  it("says what it doesn't count, and filters on the workspace's days", () => {
    const page = report();
    expect(page).toContain("Replies and meetings are not counted here yet.");
    expect(page).toContain("Days are in the workspace&#x27;s time zone.");
    const src = read("client/src/components/usip/SequenceReport.tsx");
    expect(src).toContain("...(dateFrom ? { dateFrom } : {}),");
    expect(src).toContain("...(dateTo ? { dateTo } : {}),");
    expect(src).toContain('filtered ? "Nothing was sent in this range."');
    expect(src).toContain('filtered ? "in this range" : "all time"');
  });

  it("the page uses it, and the old promise is gone", () => {
    const src = read("client/src/pages/usip/SequenceEditor.tsx");
    expect(src).toContain('{tab === "Report" && <SequenceReport sequenceId={id} accent={accent} />}');
    expect(src).not.toContain("populates once this sequence starts sending");
  });
});

/* ── The template picker ─────────────────────────────────────────────────── */

const blank: EmailStep = { type: "email", subject: "", body: "" };
const written: EmailStep = { type: "email", subject: "Hello", body: "<p>Mine</p>" };
const TEMPLATE = { id: 7, name: "Intro", subject: "From the template", htmlOutput: "<table><tr><td>Built</td></tr></table>", status: "active" };

describe("using a template", () => {
  it.each([
    ["nothing", "", false], ["an empty editor's markup", "<p></p>", false], ["a space", "<p>&nbsp; </p>", false],
    ["text", "<p>Hi</p>", true], ["only an image", '<p><img src="x"></p>', true], ["no body", undefined, false],
  ])("a body of %s", (_name, body, want) => {
    expect(hasBodyContent(body)).toBe(want);
  });

  it("asks only when something would be lost", () => {
    expect(templateWouldReplace(blank)).toBe(false);
    expect(templateWouldReplace({ ...blank, body: "<p></p>" })).toBe(false);
    expect(templateWouldReplace(written)).toBe(true);
    expect(templateWouldReplace({ ...blank, subject: "Only a subject" })).toBe(true);
    expect(templateWouldReplace({ ...blank, body: "<p>Only a body</p>" })).toBe(true);
    expect(templateWouldReplace({ ...blank, subject: "   " })).toBe(false);
    expect(templateWouldReplace({ ...blank, emailMode: "dynamic" })).toBe(true);
  });

  it("copies the subject and body, and records where they came from", () => {
    expect(applyTemplate(written, TEMPLATE)).toEqual({ type: "email", subject: "From the template", body: TEMPLATE.htmlOutput, templateId: 7 });
  });

  it("a template with no subject leaves the step's", () => {
    expect(applyTemplate(written, { ...TEMPLATE, subject: null }).subject).toBe("Hello");
    expect(applyTemplate(written, { ...TEMPLATE, subject: "  " }).subject).toBe("Hello");
  });

  it("an AI-written step becomes a typed one, or the engine would ignore the copy", () => {
    expect(applyTemplate({ ...blank, emailMode: "dynamic" }, TEMPLATE).emailMode).toBe("typed");
    expect(applyTemplate(blank, TEMPLATE)).not.toHaveProperty("emailMode");
    expect(applyTemplate({ ...blank, emailMode: "typed" }, TEMPLATE).emailMode).toBe("typed");
  });

  it("keeps a retired step retired", () => {
    expect(applyTemplate({ ...blank, enabled: false }, TEMPLATE).enabled).toBe(false);
  });

  it("detaching keeps the text and drops only the link", () => {
    const linked = applyTemplate(written, TEMPLATE);
    expect(detachTemplate(linked)).toEqual({ type: "email", subject: "From the template", body: TEMPLATE.htmlOutput });
  });

  it("offers no archived template, and none that was never built, which would blank the email", () => {
    const list = [TEMPLATE, { ...TEMPLATE, id: 8, status: "archived" }, { ...TEMPLATE, id: 9, htmlOutput: null }, { ...TEMPLATE, id: 10, htmlOutput: "<p></p>" }, { ...TEMPLATE, id: 11, status: "draft" }];
    expect(usableTemplates(list).map((t) => t.id)).toEqual([7, 11]);
  });

  it("survives the real save, and the server still refuses a running sequence", async () => {
    const linked = applyTemplate(written, TEMPLATE);
    await caller().sequences.updateSteps({ id: 1, steps: [linked] });
    expect(rows("sequences")[0].steps[0]).toMatchObject({ subject: "From the template", body: TEMPLATE.htmlOutput, templateId: 7 });
    await caller().sequences.updateSteps({ id: 1, steps: [detachTemplate(linked)] });
    expect(rows("sequences")[0].steps[0]).not.toHaveProperty("templateId");
    rows("sequences")[0].status = "active";
    expect((await refusal(caller().sequences.updateSteps({ id: 1, steps: [linked] }))).code).toBe("BAD_REQUEST");
  });
});

describe("the picker on screen", () => {
  const picker = (step: EmailStep = blank, blocked: string | null = null) =>
    html(createElement(Router, { ssrPath: "/" }, createElement(StepTemplatePicker, { step, blocked, onPick: () => {} })));
  /** The attribute, not the `disabled:` styling in its class. */
  const isDisabled = (page: string) => /<select[^>]*\sdisabled(=|\s|>)/.test(page);

  it("lists what can be used", () => {
    h.templates = { data: [TEMPLATE, { ...TEMPLATE, id: 8, name: "Old", status: "archived" }], isLoading: false, isError: false };
    const page = picker();
    expect(page).toContain("Use a template…");
    expect(page).toContain(">Intro<");
    expect(page).not.toContain(">Old<");
    expect(isDisabled(page)).toBe(false);
  });

  it.each([
    ["loading", { isLoading: true, isError: false }, "Loading templates…"],
    ["failed", { isLoading: false, isError: true }, "Templates could not be loaded"],
    ["none", { data: [], isLoading: false, isError: false }, "No templates yet"],
  ])("%s says so, and can't be used", (_name, state, words) => {
    h.templates = state;
    const page = picker();
    expect(page).toContain(words);
    expect(isDisabled(page)).toBe(true);
  });

  it("is off while the steps can't be changed, and says why", () => {
    h.templates = { data: [TEMPLATE], isLoading: false, isError: false };
    const page = picker(blank, "Pause the sequence to change its steps.");
    expect(page).toContain("Pause the sequence to change its steps.");
    expect(isDisabled(page)).toBe(true);
  });

  it("names the template a step came from, and links to it", () => {
    h.templates = { data: [TEMPLATE], isLoading: false, isError: false };
    const page = picker({ ...written, templateId: 7 });
    expect(page).toContain("From template:");
    expect(page).toContain('href="/email-builder/7"');
  });

  it("says so when that template is gone, rather than naming nothing", () => {
    h.templates = { data: [], isLoading: false, isError: false };
    expect(picker({ ...written, templateId: 7 })).toContain("deleted");
    expect(picker(written)).not.toContain("From template:");
  });

  it("asks before replacing, and only then", () => {
    const src = read("client/src/components/usip/StepTemplatePicker.tsx");
    expect(src).toContain("if (templateWouldReplace(step)) setPending(template);");
    expect(src).toContain("else onPick(template);");
    expect(src).toContain("onClick={() => { onPick(pending); setPending(null); }}");
    expect(src).toContain("onClick={() => setPending(null)}>Keep what's here<");
    expect(src).toContain("What's written here will be lost.");
    expect(src).toContain("This step is written by AI when it sends.");
  });
});

describe("the editor", () => {
  const src = () => read("client/src/pages/usip/SequenceEditor.tsx");

  it("saves a pick and a detach at once, since they leave no field to blur", () => {
    expect(src()).toContain("commit(steps.map((s, idx) => (idx === i && s.type === \"email\" ? change(s) : s)));");
    expect(src()).toContain("onPickTemplate={(t: TemplateChoice) => withEmailStep(i, (e) => applyTemplate(e, t))}");
    expect(src()).toContain("onDetachTemplate={() => withEmailStep(i, detachTemplate)}");
  });

  it("blocks them where the server would refuse", () => {
    expect(src()).toContain('const stepsBlocked = seq?.status === "active"');
    expect(src()).toContain('seq?.status === "archived"');
    expect(src()).toContain("blocked={stepsBlocked}");
    expect(src()).toContain('disabled={!!blocked} onClick={onDetachTemplate}');
  });

  it("shows a template's copy read-only, sanitised, and keeps it out of the rich-text editor", () => {
    const code = src();
    const preview = code.indexOf("{step.templateId ? (");
    const editor = code.indexOf("<RichTextEditor", preview);
    expect(preview).toBeGreaterThan(-1);
    expect(editor).toBeGreaterThan(preview);
    const linkedBranch = code.slice(preview, editor);
    expect(linkedBranch).toContain("sanitizeEmailHtml(step.body");
    expect(linkedBranch).toContain("This is the copy that sends.");
    expect(linkedBranch).toContain(">Edit the text here<");
    expect(linkedBranch).toContain(") : (");
  });

  it("no longer says the tab is read-only", () => {
    expect(src()).not.toContain("Read-only.");
    expect(src()).toContain("<SequenceEnrollmentActions enrollment={e} sequenceId={sequenceId} />");
  });
});
