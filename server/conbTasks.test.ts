/**
 * One task page (audit 2026-10-20, R72 and X6.3; batch CONB, 2026-11-08).
 *
 *   /tasks is retired into /v2/tasks, folding first: /v2/tasks has /tasks'
 *   Today / Upcoming / Overdue / Done / All tabs (as views, `?view=`), its
 *   related-record filter, Reopen on a closed task and Cancel on an open one.
 *   The bucketing is one shared rule (@shared/taskRules). Home, Calls and
 *   Analytics read the Tasks page's scope: a rep's own tasks, a manager's
 *   everyone's.
 *
 * The page is rendered with its queries stubbed and its handlers captured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  calls: [] as Array<{ path: string; vars: any }>,
  buttons: [] as any[],
  items: [] as any[],
  search: "",
  role: "rep",
  nav: [] as string[],
}));

vi.mock("@/lib/trpc", () => {
  const proc = (path: string) => ({
    useQuery: (input: any) => {
      const q = h.queries[path];
      return (typeof q === "function" ? q(input) : q) ?? { data: undefined, isLoading: false, error: null };
    },
    useMutation: () => ({ mutate: (vars: any) => { h.calls.push({ path, vars }); }, mutateAsync: async () => ({}), isPending: false }),
  });
  const utils = new Proxy({}, { get: () => new Proxy({}, { get: () => ({ invalidate: () => {} }) }) });
  return {
    trpc: new Proxy({ useUtils: () => utils } as Record<string, unknown>, {
      get: (t, r: string) => (r in t ? t[r] : new Proxy({}, { get: (_u, p: string) => proc(`${r}.${p}`) })),
    }),
  };
});
vi.mock("@/components/usip/Shell", async () => {
  const { createElement: el } = await import("react");
  return { Shell: ({ children }: any) => el("main", null, children), useAccentColor: () => "#123456" };
});
vi.mock("wouter", async () => {
  const { createElement: el } = await import("react");
  return {
    Link: ({ href, children, className }: any) => el("a", { href, className }, children),
    useLocation: () => ["/v2/tasks", (to: string) => { h.nav.push(to); }],
    useSearch: () => h.search,
  };
});
vi.mock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => ({ current: { id: 2, role: h.role } }) }));
vi.mock("@/hooks/useWorkspaceTimezone", () => ({ useWorkspaceTimezone: () => ({ timezone: "America/New_York" }) }));
vi.mock("@/components/usip/RelatedRecordPicker", () => ({ RelatedRecordPicker: () => null }));
vi.mock("@/components/usip/Common", async () => {
  const { createElement: el } = await import("react");
  return { confirmAction: () => {}, ConfirmButton: ({ children }: any) => el("button", null, children) };
});
vi.mock("@/components/ui/button", async () => {
  const { createElement: el } = await import("react");
  return {
    Button: (props: any) => {
      h.buttons.push(props);
      return el("button", { "aria-label": props["aria-label"], title: props.title }, props.children);
    },
  };
});
// A closed menu renders nothing on the server; render its items inline so they can be read and pressed.
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { createElement: el } = await import("react");
  const pass = ({ children }: any) => el("div", null, children);
  return {
    DropdownMenu: pass, DropdownMenuTrigger: pass, DropdownMenuContent: pass, DropdownMenuLabel: pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: (props: any) => { h.items.push(props); return el("div", { role: "menuitem" }, props.children); },
  };
});
vi.mock("@/components/ui/select", async () => {
  const { createElement: el } = await import("react");
  const pass = ({ children }: any) => el("div", null, children);
  return { Select: pass, SelectTrigger: pass, SelectValue: () => null, SelectContent: pass, SelectItem: pass };
});
vi.mock("@/components/ui/dialog", async (a) => ({ ...(await a<typeof import("../client/src/components/ui/dialog")>()), Dialog: () => null }));

import TasksV2, { TASK_VIEWS, taskViewFrom } from "../client/src/pages/usip/TasksV2";
import { bucketTasks } from "@shared/taskRules";
import { RETIRED_ROUTES, retiredRedirectUrl } from "../client/src/lib/retiredRoutes";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Wednesday 2026-11-18, 15:00 New York (20:00 UTC). */
const T0 = new Date("2026-11-18T20:00:00Z").getTime();

const TASKS = [
  { id: 1, title: "Overdue call", type: "call", status: "open", dueAt: new Date(T0 - 2 * HOUR), ownerUserId: 21, relatedType: "lead", relatedId: 5 },
  { id: 2, title: "Due tonight", type: "todo", status: "open", dueAt: new Date(T0 + 2 * HOUR), ownerUserId: 21, relatedType: "opportunity", relatedId: 9 },
  { id: 3, title: "Next week prep", type: "meeting_prep", status: "in_progress", dueAt: new Date(T0 + 6 * DAY), ownerUserId: 21, relatedType: null, relatedId: null },
  { id: 4, title: "Finished long ago", type: "todo", status: "done", dueAt: new Date(T0 - 30 * DAY), completedAt: new Date(T0 - 20 * DAY), updatedAt: new Date(T0 - 20 * DAY), ownerUserId: 21 },
  { id: 5, title: "Finished this morning", type: "todo", status: "done", dueAt: new Date(T0 - 40 * DAY), completedAt: new Date(T0 - 5 * HOUR), updatedAt: new Date(T0 - 5 * HOUR), ownerUserId: 21 },
  { id: 6, title: "Dropped yesterday", type: "todo", status: "cancelled", dueAt: null, completedAt: null, updatedAt: new Date(T0 - DAY), ownerUserId: 21 },
  { id: 7, title: "Snoozed till Friday", type: "todo", status: "snoozed", dueAt: new Date(T0 + 2 * DAY), ownerUserId: 21 },
];

function render(search = ""): string {
  h.search = search;
  h.buttons = [];
  h.items = [];
  return renderToStaticMarkup(createElement(TasksV2));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  h.calls = [];
  h.nav = [];
  h.role = "rep";
  h.queries = {
    // The page's second list is the AI drafts (status "draft"): none here.
    "tasks.list": (input: any) => ({ data: input?.status === "draft" ? [] : TASKS, isLoading: false, error: null }),
    "tasks.stats": { data: { open: 3, dueToday: 1, overdue: 1, completed: 2, draftsPending: 0, snoozed: 1, aiOpen: 0 }, isLoading: false, error: null },
    "tasks.approvalQueue": { data: { chatFollowUps: [], socialInvites: [] } },
    "tasks.getAutopilotSettings": { data: { mode: "off", autoTaskDailyCap: 25 } },
    "team.list": { data: [{ userId: 21, name: "Rep" }] },
  };
});
afterEach(() => { vi.useRealTimers(); });

describe("the shared buckets /tasks had", () => {
  it("sorts workable tasks into Today, Overdue and Upcoming; snoozed and closed ones are in none", () => {
    const b = bucketTasks(TASKS, "America/New_York", T0);
    expect(b.overdue.map((t) => t.id)).toEqual([1]);
    expect(b.today.map((t) => t.id)).toEqual([2]);
    expect(b.upcoming.map((t) => t.id)).toEqual([3]);
  });
  it("an undated open task is Upcoming, as on /tasks", () => {
    expect(bucketTasks([{ status: "open", dueAt: null }], "UTC", T0).upcoming).toHaveLength(1);
  });
});

describe("/v2/tasks has /tasks' tabs, as views", () => {
  it("lists the six views, and ?view= picks one (anything else is the queue)", () => {
    expect(TASK_VIEWS.map((v) => v.id)).toEqual(["queue", "today", "overdue", "upcoming", "done", "all"]);
    expect(taskViewFrom("?view=overdue")).toBe("overdue");
    expect(taskViewFrom("view=done")).toBe("done");
    expect(taskViewFrom("?view=nonsense")).toBe("queue");
    expect(taskViewFrom("")).toBe("queue");
  });

  it("the tab strip is a real tablist with a count on each tab", () => {
    const html = render();
    expect(html).toContain('role="tablist" aria-label="Task views"');
    expect(html).toMatch(/aria-selected="true"[^>]*>Queue <span[^>]*>4<\/span>/);
    expect(html).toMatch(/>Overdue <span[^>]*>1<\/span>/);
    expect(html).toMatch(/>Done <span[^>]*>2<\/span>/);
    expect(html).toMatch(/>All <span[^>]*>7<\/span>/);
  });

  it("Overdue lists only what is overdue", () => {
    const html = render("?view=overdue");
    expect(html).toContain("Overdue call");
    expect(html).not.toContain("Due tonight");
    expect(html).not.toContain("Next week prep");
    // The queue's own "Recently closed" belongs to the queue view only.
    expect(html).not.toContain("Recently closed");
  });

  it("Today lists what is due by the workspace's midnight", () => {
    const html = render("?view=today");
    expect(html).toContain("Due tonight");
    expect(html).not.toContain("Overdue call");
  });

  it("Done lists done tasks latest first, each with Reopen, and Reopen opens it", () => {
    const html = render("?view=done");
    expect(html.indexOf("Finished this morning")).toBeGreaterThan(-1);
    expect(html.indexOf("Finished long ago")).toBeGreaterThan(html.indexOf("Finished this morning"));
    expect(html).not.toContain("Dropped yesterday");
    const reopen = h.buttons.filter((b) => b.children === "Reopen");
    expect(reopen).toHaveLength(2);
    reopen[0].onClick();
    expect(h.calls).toContainEqual({ path: "tasks.setStatus", vars: { id: 5, status: "open" } });
  });

  it("All includes cancelled tasks, which can be reopened too", () => {
    const html = render("?view=all");
    expect(html).toContain("Dropped yesterday");
    expect(html).toContain("Snoozed till Friday");
    expect(h.buttons.filter((b) => b.children === "Reopen")).toHaveLength(3);
  });

  it("Recently closed (the queue view) is newest first and can reopen", () => {
    const html = render();
    const closed = html.slice(html.indexOf("Recently closed"));
    expect(closed.indexOf("Finished this morning")).toBeLessThan(closed.indexOf("Dropped yesterday"));
    expect(closed.indexOf("Dropped yesterday")).toBeLessThan(closed.indexOf("Finished long ago"));
    expect(h.buttons.some((b) => b.children === "Reopen")).toBe(true);
  });

  it("an open task's menu has /tasks' Cancel, which keeps it in the history", () => {
    render();
    const cancel = h.items.find((i) => JSON.stringify(i.children).includes("Cancel task"));
    expect(cancel).toBeTruthy();
    cancel.onClick();
    expect(h.calls.some((c) => c.path === "tasks.setStatus" && c.vars.status === "cancelled")).toBe(true);
  });

  it("picking a view writes ?view= back, so the view can be linked", () => {
    const src = read("client/src/pages/usip/TasksV2.tsx");
    expect(src).toContain('navigate(v === "queue" ? "/v2/tasks" : `/v2/tasks?view=${v}`, { replace: true });');
  });
});

describe("/v2/tasks has /tasks' related-record filter", () => {
  it("is a labelled select over the five record kinds", () => {
    const html = render();
    expect(html).toContain('<label for="queue-related"');
    expect(html).toContain('id="queue-related"');
    for (const k of ["account", "contact", "lead", "opportunity", "prospect"]) expect(html).toContain(`<option value="${k}">${k}</option>`);
  });
  it("narrows every view through one rule with the assignee filter", () => {
    const src = read("client/src/pages/usip/TasksV2.tsx");
    expect(src).toContain("(!relTypeFilter || t.relatedType === relTypeFilter)");
    expect(src).toContain("() => activeTasks.filter((t) => !approvalIds.has(t.id)).filter(passes),");
    expect(src).toContain("const queueRows = useShowMore(listed, { view, assigneeFilter, relTypeFilter });");
  });
});

describe("/tasks is retired, folding first", () => {
  it("redirects to /v2/tasks, keeping the query string", () => {
    expect(RETIRED_ROUTES["/tasks"]).toBe("/v2/tasks");
    expect(retiredRedirectUrl("/tasks", { search: "?view=overdue" })).toBe("/v2/tasks?view=overdue");
    expect(read("client/src/App.tsx")).toContain('<Route path="/tasks"><AuthGate><RetiredRedirect from="/tasks" /></AuthGate></Route>');
  });
  it("the old page file stays, unrouted, still exporting RelatedTasks", () => {
    const app = read("client/src/App.tsx");
    expect(app).toContain('const Tasks = lazyChunk(() => import("@/pages/usip/Tasks"));');
    expect(read("client/src/pages/usip/Tasks.tsx")).toContain("export function RelatedTasks(");
  });
});

describe("Home, Calls and Analytics read the Tasks page's scope", () => {
  it("each asks for `mine`, so a rep reads their own tasks and a manager everyone's", () => {
    const calls = read("client/src/pages/usip/Calls.tsx");
    expect(calls).toContain('trpc.tasks.list.useQuery({ type: "call", status: "open", limit: CALL_QUEUE_LIMIT, order: "soonest", mine: true });');
    expect(calls).toContain('trpc.tasks.list.useQuery({ type: "call", status: "done", limit: DONE_SHOWN, order: "recent", mine: true });');
    expect(calls).toContain('trpc.tasks.stats.useQuery({ type: "call", mine: true });');
    expect(read("client/src/pages/usip/AnalyticsV2.tsx")).toContain("const taskStats = trpc.tasks.stats.useQuery({ mine: true });");
    expect(read("client/src/pages/usip/Home.tsx")).toContain("const taskStats = trpc.tasks.stats.useQuery({ mine: true }).data as any;");
  });
  it("Home's due-today chip opens the Today view", () => {
    expect(read("client/src/pages/usip/Home.tsx")).toContain('setLocation("/v2/tasks?view=today")');
  });
});
