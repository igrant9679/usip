/**
 * The two task pages (audit 2026-10-20, batch Rc): R72 · R104.
 *
 *   R72 · /tasks and /v2/tasks read one overdue rule and one scope rule (a
 *         rep sees their own tasks, a manager everyone's); snoozed tasks come
 *         back when the snooze ends; "Recently closed" is the latest closed.
 *         Neither page is merged or retired — that is the owner's decision.
 *   R104 · a task is linked to a record found by name, on both pages, and the
 *         v2 dialog keeps what was typed until the save lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  roles: {} as Record<number, string>,
  data: {} as Record<string, unknown>,
  tz: "America/New_York",
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/workspaceTimezone", async (a) => ({
  ...(await a<typeof import("./services/workspaceTimezone")>()),
  getWorkspaceTimezone: async () => h.tz,
}));
vi.mock("@/lib/trpc", () => {
  const noop: any = new Proxy(() => undefined, { get: () => noop, apply: () => undefined });
  const node = (path: string[]): any => new Proxy({}, {
    get(_t, key: string) {
      if (key === "useQuery") return () => ({ data: h.data[path.join(".")], isLoading: false, error: null });
      if (key === "useMutation") return () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false });
      if (key === "useUtils") return () => noop;
      return node([...path, key]);
    },
  });
  return { trpc: node([]) };
});

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { recentlyClosed, seesAllTasks, taskDueState } from "@shared/taskRules";
import { RelatedRecordPicker } from "../client/src/components/usip/RelatedRecordPicker";

const WS = 2;
const REP = 21;
const OTHER = 22;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Wednesday 2026-11-18, 15:00 New York (20:00 UTC). */
const T0 = new Date("2026-11-18T20:00:00Z").getTime();
const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
function block(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`anchor not found: ${start}`);
  const j = src.indexOf(end, i + start.length);
  if (j < 0) throw new Error(`end anchor not found after ${start}: ${end}`);
  return src.slice(i, j + end.length);
}
const rows = (t: string) => h.db.rowsOf(t) as any[];

function caller(role: string) {
  h.roles[WS] = role;
  return appRouter.createCaller({
    user: { id: REP, openId: "u", email: "rep@lsi.example", name: "Rep", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
function task(id: number, over: Record<string, unknown> = {}) {
  rows("tasks").push({
    id, workspaceId: WS, title: `T${id}`, status: "open", type: "todo", priority: "normal", source: "manual",
    ownerUserId: REP, dueAt: null, snoozedUntil: null, completedAt: null, relatedType: null, relatedId: null,
    createdAt: new Date(T0 - 10 * DAY), updatedAt: new Date(T0 - 10 * DAY), ...over,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  h.roles = {};
  h.db = makeSqlFakeDb({ roles: h.roles, wsId: () => WS });
  h.data = {};
  h.tz = "America/New_York";
});
afterEach(() => { vi.useRealTimers(); });

describe("R72: one overdue rule", () => {
  it("overdue from the moment a task is due; today ends at the workspace's midnight", () => {
    const ny = "America/New_York";
    // Due at 10:00 New York today, read at 15:00: overdue (the old /tasks rule said "today").
    expect(taskDueState(new Date("2026-11-18T15:00:00Z"), T0, ny)).toBe("overdue");
    // Due at the end of today in New York — 04:59:59 UTC tomorrow — is today.
    expect(taskDueState(new Date("2026-11-19T04:59:59Z"), T0, ny)).toBe("today");
    expect(taskDueState(new Date("2026-11-19T05:30:00Z"), T0, ny)).toBe("upcoming");
    // The same instant in a UTC workspace is already tomorrow.
    expect(taskDueState(new Date("2026-11-19T04:59:59Z"), T0, "UTC")).toBe("upcoming");
    expect(taskDueState(null, T0, ny)).toBe("none");
  });

  it("the stat cards count by that rule", async () => {
    task(1, { dueAt: new Date(T0 - 5 * HOUR) });
    task(2, { dueAt: new Date("2026-11-19T04:00:00Z") });
    task(3, { dueAt: new Date(T0 + 3 * DAY) });
    const s = await caller("rep").tasks.stats({ mine: true });
    expect(s).toMatchObject({ open: 3, overdue: 1, dueToday: 1 });
  });

  it("both pages bucket with it", () => {
    const v1 = read("client/src/pages/usip/Tasks.tsx");
    const bucket = block(v1, "export function bucketize(", "\n}\n");
    expect(bucket).toContain("const due = taskDueState(t.dueAt, nowMs, timeZone);");
    expect(bucket).not.toContain("startToday");
    expect(v1).toContain("bucketize(filtered, timezone)");
    const v2 = read("client/src/pages/usip/TasksV2.tsx");
    expect(v2).toContain(`const isOverdue = taskDueState(t.dueAt, now, timezone) === "overdue";`);
  });
});

describe("R72: one scope rule", () => {
  beforeEach(() => {
    task(1);
    task(2, { ownerUserId: OTHER });
    task(3, { ownerUserId: OTHER, status: "done", completedAt: new Date(T0 - DAY) });
  });

  it("a rep's pages list and count their own tasks; a manager's everyone's", async () => {
    expect((await caller("rep").tasks.list({ mine: true })).map((t: any) => t.id)).toEqual([1]);
    expect((await caller("rep").tasks.stats({ mine: true }))).toMatchObject({ open: 1, completed: 0 });
    expect((await caller("manager").tasks.list({ mine: true })).map((t: any) => t.id).sort()).toEqual([1, 2, 3]);
    expect((await caller("manager").tasks.stats({ mine: true }))).toMatchObject({ open: 2, completed: 1 });
    expect(seesAllTasks("rep")).toBe(false);
    expect(seesAllTasks("admin")).toBe(true);
  });

  it("other readers that don't ask for the scope are unchanged", async () => {
    expect((await caller("rep").tasks.list({})).map((t: any) => t.id).sort()).toEqual([1, 2, 3]);
  });

  it("both pages ask for it, and only a manager gets the assignee filter", () => {
    const v1 = read("client/src/pages/usip/Tasks.tsx");
    expect(v1).toContain("trpc.tasks.list.useQuery({ mine: true })");
    expect(block(v1, "{seesAll && (", "\n          )}")).toContain(`aria-label="Assignee"`);
    const v2 = read("client/src/pages/usip/TasksV2.tsx");
    expect(v2).toContain("const active = trpc.tasks.list.useQuery({ mine: true });");
    expect(v2).toContain("const stats = trpc.tasks.stats.useQuery({ mine: true });");
    expect(block(v2, "{seesAll && <>", "</>}")).toContain(`id="queue-assignee"`);
  });
});

describe("R72: snoozed tasks wake, and Recently closed is the latest", () => {
  it("a snooze that has run out is open again; one still running stays snoozed", async () => {
    task(1, { status: "snoozed", snoozedUntil: new Date(T0 - HOUR), dueAt: new Date(T0 - HOUR) });
    task(2, { status: "snoozed", snoozedUntil: new Date(T0 + DAY), dueAt: new Date(T0 + DAY) });
    const list = await caller("rep").tasks.list({ mine: true });
    expect(list.find((t: any) => t.id === 1)).toMatchObject({ status: "open", snoozedUntil: null });
    expect(list.find((t: any) => t.id === 2)).toMatchObject({ status: "snoozed" });
  });

  it("the stat cards wake them too", async () => {
    task(1, { status: "snoozed", snoozedUntil: new Date(T0 - HOUR), dueAt: new Date(T0 - HOUR) });
    expect(await caller("rep").tasks.stats({ mine: true })).toMatchObject({ open: 1, overdue: 1, snoozed: 0 });
  });

  it("latest closed first, dismissed ones by when they changed", () => {
    const rowsIn = [
      { id: 1, status: "done", completedAt: new Date(T0 - 30 * DAY), updatedAt: new Date(T0 - 30 * DAY) },
      { id: 2, status: "done", completedAt: new Date(T0 - HOUR), updatedAt: new Date(T0 - HOUR) },
      { id: 3, status: "cancelled", completedAt: null, updatedAt: new Date(T0 - 2 * HOUR) },
      { id: 4, status: "open", completedAt: null, updatedAt: new Date(T0) },
    ];
    expect(recentlyClosed(rowsIn).map((t) => t.id)).toEqual([2, 3, 1]);
    expect(recentlyClosed(rowsIn, 2).map((t) => t.id)).toEqual([2, 3]);
    expect(read("client/src/pages/usip/TasksV2.tsx")).toContain("const done = useMemo(() => recentlyClosed(activeTasks, 10), [activeTasks]);");
  });
});

describe("R104: a task is linked by name, and the v2 dialog keeps its text until saved", () => {
  it("the picker searches by kind of record and shows the one picked", () => {
    const empty = renderToStaticMarkup(createElement(RelatedRecordPicker, { value: null, onChange: () => {} }));
    expect(empty).toContain(`aria-label="Related record type"`);
    expect(empty).toContain("Company");
    const picked = renderToStaticMarkup(createElement(RelatedRecordPicker, { value: { type: "opportunity", id: 9, label: "Acme renewal" }, onChange: () => {} }));
    expect(picked).toContain("Deal:");
    expect(picked).toContain("Acme renewal");
    expect(picked).toContain(`aria-label="Clear related record"`);
  });

  it("both dialogs use it, and send its type and id", () => {
    const v1 = read("client/src/pages/usip/Tasks.tsx");
    expect(v1).not.toContain(`label="Related ID"`);
    expect(v1).toContain("relatedType: related?.type,");
    expect(v1).toContain("relatedId: related?.id,");
    const v2 = read("client/src/pages/usip/TasksV2.tsx");
    const dialog = block(v2, "function NewTaskDialog(", "\n}\n");
    expect(dialog).toContain("<RelatedRecordPicker value={related} onChange={setRelated}");
    const submit = block(dialog, "const submit = () => {", "\n  };");
    expect(submit).toContain("relatedType: related?.type,");
    // The fields clear in the success callback, not straight after the call.
    const afterCall = submit.slice(submit.indexOf("}, () => {"));
    expect(afterCall).toContain(`setTitle("");`);
    expect(submit.slice(0, submit.indexOf("}, () => {"))).not.toContain(`setTitle("");`);
    expect(v2).toContain("onCreate={(v, saved) => create.mutate(v, { onSuccess: saved })}");
  });

  it("a linked task stores its record", async () => {
    await caller("rep").tasks.create({ title: "Call about renewal", relatedType: "opportunity", relatedId: 9 });
    expect(rows("tasks")[0]).toMatchObject({ relatedType: "opportunity", relatedId: 9 });
  });
});
