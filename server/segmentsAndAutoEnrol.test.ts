/**
 * Segments and their auto-enrol rules say what they do (audit 2026-10-20,
 * batch Pa).
 *
 *   a segment's members can be seen, a page at a time (P20) · segments read
 *   CRM contacts, and say so (P21) · counts can be refreshed and the copy
 *   doesn't claim more (P53) · a segment a rule uses isn't deleted out from
 *   under it, and broadcasts let go of it (P54) · the header says hourly (P56) ·
 *   a rule is turned on only for a count someone was shown and confirmed (P57) ·
 *   deleting a rule asks (P60) · Run now refreshes the rows (P129) · Pause is
 *   not "rule saved" and leaves the Add form alone (P130) · people skipped and
 *   rules refused are two numbers (P131) · the hourly notice links to a page
 *   that exists (P132) · rules carry their names (P137) · a rule on a paused
 *   sequence doesn't read Active (P138) · Unknown is an email status, and the
 *   page has a title (P140).
 *
 * Procedures run against the SQL-evaluating fake. Screens are rendered with
 * their queries stubbed and their buttons' handlers captured, so a click is a
 * call, and a real procedure's answer is handed to the screen that shows it.
 *
 * Auto-enrolment is never widened here: every rule stays on contacts, and the
 * tests below pin that turning one on needs a confirmed count.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return {
    db: null as any,
    notices: [] as Array<{ title: string; content: string }>,
    // The client side: query results by path, what each useMutation was given, calls, toasts, confirms, buttons.
    queries: {} as Record<string, unknown>,
    queryInputs: [] as Array<[string, unknown, unknown]>,
    mutations: {} as Record<string, any[]>,
    calls: [] as Array<{ path: string; vars: any }>,
    invalidated: [] as string[],
    fetchers: {} as Record<string, (input: any) => unknown>,
    toasts: [] as Array<{ kind: string; msg: string; opts?: any }>,
    confirms: [] as Array<{ opts: any; cb: () => void }>,
    buttons: [] as any[],
    titles: [] as unknown[],
    params: {} as Record<string, string>,
    nav: [] as string[],
    role: "admin",
  };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./_core/notification", async (a) => ({
  ...(await a<typeof import("./_core/notification")>()),
  notifyOwner: async (n: { title: string; content: string }) => { h.notices.push(n); return true; },
}));
vi.mock("./services/crossEngineEnrollment", async (a) => ({
  ...(await a<typeof import("./services/crossEngineEnrollment")>()),
  // Contacts stand in for their People rows; no campaign is working anyone.
  resolveToPeopleIds: async (_ws: number, input: { contactIds?: number[] }) => ({ prospectIds: (input.contactIds ?? []).map((id) => 9000 + id), unresolved: [] }),
  activeCampaignsForProspects: async () => new Map(),
}));

vi.mock("@/lib/trpc", () => {
  const proc = (path: string) => ({
    useQuery: (input: unknown, opts?: unknown) => { h.queryInputs.push([path, input, opts]); return h.queries[path] ?? { data: undefined, isLoading: false, error: null }; },
    useMutation: (opts: any) => {
      (h.mutations[path] ??= []).push(opts);
      return { mutate: (vars: any) => { h.calls.push({ path, vars }); }, mutateAsync: async (vars: any) => { h.calls.push({ path, vars }); }, isPending: false };
    },
  });
  const leaf = (path: string) => ({
    invalidate: () => { h.invalidated.push(path); },
    fetch: async (input: unknown) => h.fetchers[path]?.(input),
  });
  // 2026-11-08 (audit X1.7): the family helpers invalidate whole routers
  // (recorded as "segments.*") and some reads three deep.
  const deep = (path: string): any => new Proxy(leaf(path), { get: (t: any, k: string) => (k in t ? t[k] : deep(`${path}.${k}`)) });
  const utils = new Proxy({}, { get: (_t, r: string) => new Proxy({ invalidate: () => { h.invalidated.push(`${r}.*`); } } as any, { get: (u: any, p: string) => (p in u ? u[p] : deep(`${r}.${p}`)) }) });
  const trpc = new Proxy({ useUtils: () => utils } as Record<string, unknown>, {
    get: (t, r: string) => (r in t ? t[r] : new Proxy({}, { get: (_u, p: string) => proc(`${r}.${p}`) })),
  });
  return { trpc };
});
vi.mock("@/components/usip/Shell", async () => {
  const { createElement: el } = await import("react");
  return {
    Shell: ({ title, children }: any) => { h.titles.push(title); return el("main", null, children); },
    PageHeader: ({ title, description, children }: any) => el("header", null, el("h1", null, title), el("p", null, description), children),
    SubNav: () => null,
    EmptyState: ({ title, description, action }: any) => el("div", null, title, " ", description, action),
    QueryError: ({ what, message }: any) => el("div", null, `Couldn't load ${what}: ${message}`),
    useAccentColor: () => "#123456",
  };
});
vi.mock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => ({ current: { role: h.role } }) }));
vi.mock("@/components/usip/Common", () => ({ confirmAction: (opts: any, cb: () => void) => { h.confirms.push({ opts, cb }); } }));
vi.mock("sonner", () => {
  const rec = (kind: string) => (msg: string, opts?: unknown) => { h.toasts.push({ kind, msg, opts }); };
  return { toast: Object.assign(rec("default"), { success: rec("success"), error: rec("error"), info: rec("info"), warning: rec("warning") }) };
});
vi.mock("@/components/ui/button", async () => {
  const { createElement: el } = await import("react");
  return {
    Button: (props: any) => {
      h.buttons.push(props);
      return props.asChild ? props.children : el("button", { "aria-label": props["aria-label"], disabled: props.disabled, title: props.title }, props.children);
    },
  };
});
vi.mock("@/components/ui/select", async () => {
  const { createElement: el } = await import("react");
  return {
    Select: ({ children }: any) => el("div", null, children),
    SelectTrigger: ({ children }: any) => el("div", null, children),
    SelectValue: ({ placeholder }: any) => el("span", null, placeholder),
    SelectContent: ({ children }: any) => el("div", null, children),
    SelectItem: ({ value, children }: any) => el("div", { "data-value": value }, children),
  };
});
vi.mock("wouter", async () => {
  const { createElement: el } = await import("react");
  return {
    useParams: () => h.params,
    useLocation: () => ["/", (to: string) => { h.nav.push(to); }],
    useSearch: () => "",
    Link: ({ href, children }: any) => el("a", { href }, children),
  };
});

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { runSegmentEnrollmentForAllWorkspaces, runSegmentEnrollmentForWorkspace } from "./routers/segmentRules";
import { segmentProblem } from "@shared/segmentRules";
import { countSegment } from "./services/segmentSql";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";
import SegmentRules from "../client/src/pages/usip/SegmentRules";
import Segments from "../client/src/pages/usip/Segments";
import { ruleState, runSummary, turnOnSummary } from "../client/src/lib/segmentAutoEnrol";

const WS = 2, OTHER = 9;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
/** Markup without React's text separators, so "12 CRM contacts" reads as written. */
const html = (el: any) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");
/** A captured button whose label or text includes `text`. */
const textOf = (b: any) => html(createElement("span", null, b.children));

function caller(role = "admin") {
  h.db = h.db ?? makeSqlFakeDb({ roles: { [WS]: role }, wsId: () => WS });
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

const contact = (id: number, o: Record<string, unknown> = {}) => rows("contacts").push({
  id, workspaceId: WS, accountId: null, firstName: `C${id}`, lastName: "Lee", title: "VP", email: `c${id}@acme.example`, phone: null,
  linkedinUrl: null, city: null, seniority: null, isPrimary: false, emailVerificationStatus: "valid", companyName: "Acme",
  companyDomain: null, personProspectId: null, createdAt: new Date("2026-10-01T12:00:00Z"), ...o,
});
const vpRule = { id: "r1", field: "title", operator: "contains", value: "vp" } as const;
const segment = (id: number, o: Record<string, unknown> = {}) => rows("audience_segments").push({
  id, workspaceId: WS, name: `Seg ${id}`, description: null, matchType: "all", rules: [vpRule], contactCount: 0, lastEvaluatedAt: null, ...o,
});
const sequence = (id: number, status = "active", o: Record<string, unknown> = {}) => rows("sequences").push({ id, workspaceId: WS, name: `Seq ${id}`, status, ...o });
const rule = (id: number, segmentId: number, sequenceId: number, o: Record<string, unknown> = {}) => rows("segment_sequence_rules").push({
  id, workspaceId: WS, segmentId, sequenceId, enabled: true, enrolledCount: 0, lastRunAt: null, lastRunSummary: null, ...o,
});

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  _clearWorkspaceTimezoneCache();
  h.notices = [];
  h.queries = {}; h.queryInputs = []; h.mutations = {}; h.calls = []; h.invalidated = []; h.fetchers = {};
  h.toasts = []; h.confirms = []; h.buttons = []; h.titles = []; h.params = {}; h.nav = []; h.role = "admin";
});

/* ── P20, P21: a segment's members ───────────────────────────────────────── */

describe("a segment's members can be seen, a page at a time (P20)", () => {
  beforeEach(() => {
    for (let i = 1; i <= 60; i++) contact(i, i === 7 ? { personProspectId: 4007 } : {});
    contact(61, { title: "Analyst" });
    rows("contacts").push({ id: 62, workspaceId: OTHER, firstName: "X", lastName: "Y", title: "VP", email: "x@other.example", createdAt: new Date() });
    segment(5);
    rows("audience_segments").push({ id: 6, workspaceId: OTHER, name: "Theirs", matchType: "all", rules: [vpRule] });
  });

  it("pages through this workspace's matching contacts, newest first, with how many there are now", async () => {
    const p1 = await caller().segments.getContacts({ id: 5, perPage: 50 });
    expect(p1.total).toBe(60);
    expect(p1.rows).toHaveLength(50);
    expect(p1.rows[0].id).toBe(60);
    const p2 = await caller().segments.getContacts({ id: 5, page: 2, perPage: 50 });
    expect(p2.rows.map((r) => r.id)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    // The columns the page shows, and the People record behind a contact (P21).
    expect(Object.keys(p2.rows[0]).sort()).toEqual(["companyName", "createdAt", "email", "emailVerificationStatus", "firstName", "id", "lastName", "personProspectId", "title"]);
    expect(p2.rows.find((r) => r.id === 7)!.personProspectId).toBe(4007);
  });

  it("another workspace's segment is not found, not empty", async () => {
    expect((await refusal(caller().segments.getContacts({ id: 6 }))).code).toBe("NOT_FOUND");
    expect((await refusal(caller().segments.getContacts({ id: 999 }))).code).toBe("NOT_FOUND");
  });

  it("View opens the segment's own page, which lists them; it went to /contacts and lost the id", async () => {
    h.queries["segments.list"] = { data: rows("audience_segments").filter((s) => s.workspaceId === WS), isLoading: false };
    html(createElement(Segments));
    const view = h.buttons.find((b) => b["aria-label"] === "View the contacts in Seg 5");
    view.onClick();
    expect(h.nav).toEqual(["/segments/5"]);

    h.buttons = [];
    h.params = { id: "5" };
    h.queries["segments.list"] = { data: rows("audience_segments").filter((s) => s.workspaceId === WS), isFetched: true };
    h.queries["segments.getContacts"] = { data: await caller().segments.getContacts({ id: 5, page: 2, perPage: 50 }), isLoading: false };
    const page = html(createElement(Segments));
    expect(h.queryInputs.find(([p]) => p === "segments.getContacts")![1]).toEqual({ id: 5, page: 1, perPage: 50 });
    expect(page).toContain("60 CRM contacts now");
    expect(page).toContain("C7 Lee");
    expect(page).toContain('href="/prospects/4007"');
    expect(page).toContain("Not in People");
    expect(page).toContain("Page 1 of 2");
    expect(h.titles).toContain("Seg 5");
  });

  it("a segment that isn't here says not found", () => {
    h.params = { id: "6" };
    h.queries["segments.list"] = { data: rows("audience_segments").filter((s) => s.workspaceId === WS), isFetched: true };
    expect(html(createElement(Segments))).toContain("Segment not found");
  });
});

describe("segments say they read CRM contacts, not People (P21), and counts can be refreshed (P53)", () => {
  it("the index labels its counts, says what it reads and when it counted, and Refresh counts is wired", () => {
    segment(5, { contactCount: 12, lastEvaluatedAt: new Date("2026-11-01T12:00:00Z") });
    h.queries["segments.list"] = { data: rows("audience_segments"), isLoading: false };
    const page = html(createElement(Segments));
    // 2026-11-07 (audit P21): segments read People now; one not moved (no
    // subject, as these fixtures) still labels its count as CRM contacts.
    expect(page).toContain("12 CRM contacts");
    expect(page).toContain("Segments read People (since 2026-11-07; they read CRM contacts before).");
    expect(page).not.toContain("Segments update automatically");
    expect(page).toContain("Counted ");
    const refresh = h.buttons.find((b) => textOf(b).includes("Refresh counts"));
    refresh.onClick();
    expect(h.calls).toEqual([{ path: "segments.refresh", vars: {} }]);
    h.mutations["segments.refresh"][0].onSuccess();
    // The list family's helper refreshes every segment read (X1.7).
    expect(h.invalidated).toContain("segments.*");
  });

  it("refresh recounts every segment from the contacts table", async () => {
    contact(1); contact(2); contact(3, { title: "Analyst" });
    segment(5, { contactCount: 0 });
    await caller().segments.refresh({});
    expect(row("audience_segments", 5).contactCount).toBe(2);
  });

  it("the auto-enrol page says rules enrol People, and that moved rules were switched off", () => {
    // 2026-11-07 (audit P21): the decision this pinned (stay on contacts) was
    // the owner's to change, and is changed; the page says what is true now.
    h.queries["segmentRules.list"] = { data: [], isLoading: false };
    expect(html(createElement(SegmentRules))).toContain("Rules enrol People (segments moved from CRM contacts on 2026-11-07). Every rule on a moved segment was switched off");
  });

  it("evaluation stays on contacts: someone only in People is in no segment and is never enrolled", async () => {
    rows("prospects").push({ id: 500, workspaceId: WS, firstName: "P", lastName: "Only", title: "VP", email: "p@acme.example" });
    segment(5); sequence(3); rule(1, 5, 3);
    expect(await countSegment(h.db, WS, [vpRule], "all")).toBe(0);
    await runSegmentEnrollmentForWorkspace(WS);
    expect(rows("enrollments")).toEqual([]);
  });
});

/* ── P54: deleting a segment ─────────────────────────────────────────────── */

describe("a segment's delete leaves nothing pointing at nothing (P54)", () => {
  beforeEach(() => {
    segment(5); segment(8); sequence(3);
    rule(1, 5, 3);
    rows("campaigns").push(
      { id: 70, workspaceId: WS, name: "Broadcast", audienceType: "segment", audienceSegmentId: 8 },
      { id: 71, workspaceId: OTHER, name: "Theirs", audienceType: "segment", audienceSegmentId: 8 },
    );
  });

  it("refuses while an auto-enrol rule uses it, and says where to go", async () => {
    const r = await refusal(caller().segments.delete({ id: 5 }));
    expect(r.code).toBe("PRECONDITION_FAILED");
    expect(r.message).toBe("1 auto-enroll rule uses this segment. Delete it on Segment Auto-Enroll first.");
    expect(row("audience_segments", 5)).toBeTruthy();
    // Once the rule is gone, it goes.
    await caller().segmentRules.delete({ id: 1 });
    await caller().segments.delete({ id: 5 });
    expect(row("audience_segments", 5)).toBeUndefined();
  });

  it("clears this workspace's broadcasts' link to it, and no one else's", async () => {
    await caller().segments.delete({ id: 8 });
    expect(row("audience_segments", 8)).toBeUndefined();
    expect(row("campaigns", 70).audienceSegmentId).toBeNull();
    expect(row("campaigns", 71).audienceSegmentId).toBe(8);
  });

  it("another workspace's segment is not found", async () => {
    rows("audience_segments").push({ id: 66, workspaceId: OTHER, name: "Theirs", matchType: "all", rules: [vpRule] });
    expect((await refusal(caller().segments.delete({ id: 66 }))).code).toBe("NOT_FOUND");
    expect(row("audience_segments", 66)).toBeTruthy();
  });
});

/* ── P57: turning a rule on ──────────────────────────────────────────────── */

describe("a rule is turned on only for a count someone confirmed (P57)", () => {
  beforeEach(() => {
    for (let i = 1; i <= 5; i++) contact(i);
    contact(6, { title: "Analyst" });
    // "Email is not empty": the segment that matches everyone.
    segment(5, { name: "Everyone with an email", rules: [{ id: "e", field: "email", operator: "is_not_empty", value: "" }] });
    segment(7, { name: "VPs" });
    sequence(3); sequence(4, "paused");
    rows("enrollments").push({ id: 1, workspaceId: WS, sequenceId: 3, contactId: 2, leadId: null, prospectId: null, status: "active" });
  });

  it("previews who it would enrol, says when that is everyone, and writes nothing", async () => {
    const before = JSON.stringify([rows("prospects"), rows("contacts"), rows("enrollments")]);
    const p = await caller().segmentRules.preview({ segmentId: 5, sequenceId: 3 });
    expect(p).toMatchObject({ refused: null, matched: 6, alreadyEnrolled: 1, wouldEnrol: 5, contactsInWorkspace: 6, sequenceStatus: "active" });
    expect(JSON.stringify([rows("prospects"), rows("contacts"), rows("enrollments")])).toBe(before);
    const { title, description } = turnOnSummary(p);
    expect(title).toBe("Enrol up to 5 contacts?");
    expect(description).toContain("6 contacts match the segment now, which is every contact in this workspace.");
    expect(description).toContain("1 are already in the sequence");
  });

  it("refuses to add a rule with no confirmed count, or a count lower than now", async () => {
    let r = await refusal(caller().segmentRules.save({ segmentId: 5, sequenceId: 3, enabled: true }));
    expect(r.code).toBe("PRECONDITION_FAILED");
    expect(r.message).toContain("up to 5 contacts");
    r = await refusal(caller().segmentRules.save({ segmentId: 5, sequenceId: 3, enabled: true, confirmedWouldEnrol: 4 }));
    expect(r.message).toContain("more than the 4 you confirmed");
    expect(rows("segment_sequence_rules")).toEqual([]);
    await caller().segmentRules.save({ segmentId: 5, sequenceId: 3, enabled: true, confirmedWouldEnrol: 5 });
    expect(rows("segment_sequence_rules")).toHaveLength(1);
  });

  it("re-enabling a paused rule needs the count too; pausing never does", async () => {
    rule(1, 5, 3, { enabled: true });
    await caller().segmentRules.save({ id: 1, segmentId: 5, sequenceId: 3, enabled: false });
    expect(row("segment_sequence_rules", 1).enabled).toBe(false);
    expect((await refusal(caller().segmentRules.save({ id: 1, segmentId: 5, sequenceId: 3, enabled: true }))).code).toBe("PRECONDITION_FAILED");
    expect(row("segment_sequence_rules", 1).enabled).toBe(false);
    await caller().segmentRules.save({ id: 1, segmentId: 5, sequenceId: 3, enabled: true, confirmedWouldEnrol: 5 });
    expect(row("segment_sequence_rules", 1).enabled).toBe(true);
  });

  it("the count is the rule's own, read from the saved row, not the ids the caller sends", async () => {
    rule(1, 5, 3, { enabled: false });
    // Claims the small segment; the rule's own segment matches six.
    const r = await refusal(caller().segmentRules.save({ id: 1, segmentId: 7, sequenceId: 3, enabled: true, confirmedWouldEnrol: 4 }));
    expect(r.message).toContain("up to 5");
  });

  it("another workspace's segment, sequence or rule can't be wired", async () => {
    rows("audience_segments").push({ id: 66, workspaceId: OTHER, name: "Theirs", matchType: "all", rules: [vpRule] });
    rows("segment_sequence_rules").push({ id: 9, workspaceId: OTHER, segmentId: 66, sequenceId: 3, enabled: false });
    expect((await refusal(caller().segmentRules.save({ segmentId: 66, sequenceId: 3, enabled: true, confirmedWouldEnrol: 99 }))).code).toBe("BAD_REQUEST");
    expect((await refusal(caller().segmentRules.save({ id: 9, segmentId: 66, sequenceId: 3, enabled: true, confirmedWouldEnrol: 99 }))).code).toBe("NOT_FOUND");
    expect(row("segment_sequence_rules", 9).enabled).toBe(false);
  });

  it("a rep can't preview or turn one on", async () => {
    h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
    expect((await refusal(caller("rep").segmentRules.preview({ segmentId: 5, sequenceId: 3 }))).code).toBe("FORBIDDEN");
  });

  it("Add rule asks with the count, then sends the confirmed count", async () => {
    const p = await caller().segmentRules.preview({ segmentId: 5, sequenceId: 3 });
    h.fetchers["segmentRules.preview"] = () => p;
    h.queries["segmentRules.list"] = { data: [], isLoading: false };
    html(createElement(SegmentRules));
    // A static render has nothing picked, so the ids are empty; the count and the confirm are what's checked.
    const add = h.buttons.find((b) => textOf(b).includes("Add rule"));
    await add.onClick();
    expect(h.calls).toEqual([]);
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0].opts.title).toBe("Enrol up to 5 contacts?");
    expect(h.confirms[0].opts.confirmLabel).toBe("Turn on");
    h.confirms[0].cb();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].path).toBe("segmentRules.save");
    expect(h.calls[0].vars).toMatchObject({ enabled: true, confirmedWouldEnrol: 5 });
  });

  it("the Add form's line says how many before Add is pressed", async () => {
    const p = await caller().segmentRules.preview({ segmentId: 5, sequenceId: 3 });
    const { wouldEnrolLine } = await import("../client/src/lib/segmentAutoEnrol");
    expect(wouldEnrolLine(p)).toBe("Up to 5 contacts would be enrolled · 6 match (every contact in this workspace)");
    expect(read("client/src/pages/usip/SegmentRules.tsx")).toContain("preview.data ? wouldEnrolLine(preview.data) : null");
  });

  it("Workflows' switch asks with the count before turning a rule on, and not before pausing", () => {
    const src = read("client/src/pages/usip/WorkflowsV2.tsx");
    expect(src).toContain("? confirmTurnOn(r, (confirmedWouldEnrol) => saveSegRule.mutate({ id: r.id, segmentId: r.segmentId, sequenceId: r.sequenceId, enabled: true, confirmedWouldEnrol }))");
    expect(src).toContain(": saveSegRule.mutate({ id: r.id, segmentId: r.segmentId, sequenceId: r.sequenceId, enabled: false })} />");
    expect(src).not.toContain("sequenceId: r.sequenceId, enabled: v })");
  });
});

/* ── The Segment Auto-Enroll page ────────────────────────────────────────── */

describe("the Segment Auto-Enroll page", () => {
  beforeEach(() => {
    segment(5, { name: "VPs" }); sequence(3, "active", { name: "Intro" }); sequence(4, "paused", { name: "Paused one" });
    rule(1, 5, 3); rule(2, 5, 4); rule(3, 5, 3, { enabled: false });
  });
  const render = async () => {
    h.queries["segmentRules.list"] = { data: await caller().segmentRules.list(), isLoading: false };
    h.buttons = [];
    return html(createElement(SegmentRules));
  };
  const button = (text: string) => h.buttons.find((b) => b["aria-label"] === text || textOf(b).includes(text));

  it("rules carry their segment's and sequence's names and status (P137)", async () => {
    rows("segment_sequence_rules").push({ id: 4, workspaceId: WS, segmentId: 77, sequenceId: 3, enabled: true });
    const list = await caller().segmentRules.list();
    expect(list.find((r) => r.id === 1)).toMatchObject({ segmentName: "VPs", sequenceName: "Intro", sequenceStatus: "active" });
    expect(list.find((r) => r.id === 2)).toMatchObject({ sequenceName: "Paused one", sequenceStatus: "paused" });
    expect(list.find((r) => r.id === 4)).toMatchObject({ segmentName: null });
    // The Workflows card reads these two names.
    expect(read("client/src/pages/usip/WorkflowsV2.tsx")).toContain("{r.segmentName ?? `Segment #${r.segmentId}`} → {r.sequenceName ?? `Sequence #${r.sequenceId}`}");
  });

  it("a rule on a paused sequence says it isn't enrolling, not Active (P138)", async () => {
    const html = await render();
    expect(html.match(/>Active</g)).toHaveLength(1);
    expect(html).toContain("Not enrolling");
    expect(html).toContain("Its sequence is paused.");
    expect(ruleState({ enabled: true, segmentName: null, sequenceStatus: "active" })).toMatchObject({ label: "Not enrolling", why: "Its segment no longer exists." });
    expect(ruleState({ enabled: false, segmentName: "x", sequenceStatus: "active" }).label).toBe("Paused");
  });

  it("the header says hourly, not on every update (P56), and the tab has a title (P140)", async () => {
    const html = await render();
    // 2026-11-07 (audit P21): People, not contacts; still hourly.
    expect(html).toContain("Every hour, each enabled rule enrols the people its segment matches");
    expect(html).not.toContain("Rules evaluate on every record update");
    expect(h.titles).toContain("Segment Auto-Enroll");
  });

  it("Delete asks first, naming the rule (P60)", async () => {
    await render();
    button("Delete rule").onClick();
    expect(h.calls).toEqual([]);
    expect(h.confirms[0].opts.title).toBe('Delete the rule "VPs → Intro"?');
    h.confirms[0].cb();
    expect(h.calls).toEqual([{ path: "segmentRules.delete", vars: { id: 1 } }]);
  });

  it("Pause says paused and leaves the Add form alone; Add clears it (P130)", async () => {
    await render();
    const [add, toggle] = h.mutations["segmentRules.save"];
    button("Pause").onClick();
    expect(h.calls).toEqual([{ path: "segmentRules.save", vars: { id: 1, segmentId: 5, sequenceId: 3, enabled: false } }]);
    expect(h.confirms).toEqual([]);
    toggle.onSuccess({ ok: true }, { enabled: false });
    expect(h.toasts.map((t) => t.msg)).toEqual(["Rule paused"]);
    expect(String(toggle.onSuccess)).not.toContain("setNewSegmentId");
    expect(String(add.onSuccess)).toContain('setNewSegmentId("")');
  });

  it("Enable asks with the count first (P57)", async () => {
    h.fetchers["segmentRules.preview"] = () => ({ refused: null, matched: 3, alreadyEnrolled: 0, wouldEnrol: 3, contactsInWorkspace: 10, sequenceStatus: "active" });
    await render();
    await button("Enable").onClick();
    expect(h.calls).toEqual([]);
    expect(h.confirms[0].opts.title).toBe("Enrol up to 3 contacts?");
    h.confirms[0].cb();
    expect(h.calls).toEqual([{ path: "segmentRules.save", vars: { id: 3, segmentId: 5, sequenceId: 3, enabled: true, confirmedWouldEnrol: 3 } }]);
  });

  it("Run now refreshes the rows and keeps people and rules apart (P129, P131)", async () => {
    await render();
    const [runNow] = h.mutations["segmentRules.runEnrollment"];
    runNow.onSuccess({ ok: true, enrolled: 2, peopleSkipped: 3, rulesRefused: 1, rules: 3 });
    expect(h.invalidated).toContain("segmentRules.*");
    // 2026-11-07 (audit P21): rules enrol People or contacts, so the toast says "skipped" without naming either.
    expect(h.toasts.map((t) => t.msg)).toEqual(["Enrollment complete — 2 enrolled · 3 skipped · 1 rule refused (see its row)"]);
  });
});

/* ── P131, P132: the run and its notice ──────────────────────────────────── */

describe("the hourly run counts people and rules apart, and links to a real page (P131, P132)", () => {
  beforeEach(() => {
    contact(1); contact(2, { emailVerificationStatus: "invalid" }); contact(3);
    rows("workspace_settings").push({ id: 1, workspaceId: WS, blockInvalidEmailsFromSequences: true });
    rows("enrollments").push({ id: 1, workspaceId: WS, sequenceId: 3, contactId: 3, leadId: null, prospectId: null, status: "active" });
    segment(5); segment(6, { rules: [] });
    sequence(3); sequence(4, "paused");
    rule(1, 5, 3);       // enrols 1, skips 2 people
    rule(2, 5, 4);       // refused: the sequence is paused
    rule(3, 6, 3);       // refused: no rules
    rule(4, 99, 3);      // refused: no segment
  });

  it("one workspace: two people skipped and three rules refused, not five 'skipped'", async () => {
    const r = await runSegmentEnrollmentForWorkspace(WS);
    expect(r).toEqual({ enrolled: 1, peopleSkipped: 2, rulesRefused: 3, rules: 4 });
    expect(row("segment_sequence_rules", 1).lastRunSummary).toMatchObject({ matched: 3, enrolled: 1, skipped: { invalidEmail: 1, alreadyEnrolled: 1 } });
    expect(runSummary(r)).toBe("Enrollment complete — 1 enrolled · 2 skipped · 3 rules refused (see their rows)");
  });

  it("the owner's notice separates them and links to /segment-rules, a route the app has", async () => {
    const r = await runSegmentEnrollmentForAllWorkspaces();
    expect(r).toMatchObject({ enrolled: 1, peopleSkipped: 2, rulesRefused: 3 });
    expect(h.notices).toHaveLength(1);
    const { content } = h.notices[0];
    expect(content).toContain("• Contacts skipped (already enrolled, invalid email, in a campaign or suppressed): 2");
    expect(content).toContain("• Rules that enrolled no one because they were refused: 3");
    expect(content).toContain("(/segment-rules)");
    expect(content).not.toContain("/segment-auto-enroll");
    expect(read("client/src/App.tsx")).toContain('<Route path="/segment-rules">');
  });
});

/* ── P140: Unknown ───────────────────────────────────────────────────────── */

describe("Unknown is an email status a segment can use (P140)", () => {
  it("the server takes it, the SQL matches it, and the editor offers it", async () => {
    expect(segmentProblem([{ field: "emailVerificationStatus", operator: "equals", value: "unknown" }])).toBeNull();
    contact(1, { emailVerificationStatus: "unknown" }); contact(2);
    expect(await countSegment(h.db, WS, [{ field: "emailVerificationStatus", operator: "equals", value: "unknown" }], "all")).toBe(1);
    // 2026-11-07 (audit P21): a new segment is on People, whose email status is the same five values.
    rows("prospects").push({ id: 801, workspaceId: WS, firstName: "U", lastName: "N", emailStatus: "unknown", verificationStatus: null }, { id: 802, workspaceId: WS, firstName: "V", lastName: "N", emailStatus: "valid", verificationStatus: null });
    await caller().segments.create({ name: "Unverified", matchType: "all", rules: [{ id: "u", field: "emailVerificationStatus", operator: "equals", value: "unknown" }] });
    expect(rows("audience_segments")[0]).toMatchObject({ subject: "people", contactCount: 1 });
    // The editor's status list is the server's, labelled.
    expect(read("client/src/pages/usip/Segments.tsx")).toContain("const EMAIL_STATUS_VALUES = STATUS_VALUES.map((value) => ({ value, label: EMAIL_STATUS_LABELS[value] ?? value }));");
    expect(read("client/src/pages/usip/Segments.tsx")).toContain('unknown: "Unknown"');
  });
});
