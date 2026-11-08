/**
 * Server load, audit 2026-10-20 O41 (the part PR #50 left): a sequence's step
 * stats and its enrolment counts were read row by row and counted in
 * JavaScript, and the Calls page read every task in the workspace to keep the
 * call tasks. They now count, filter and bound in SQL, with the same numbers:
 * each new result is checked against the OLD code, kept here verbatim as the
 * reference, on the same fixture.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, role: "rep" as string };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

const WS = 2;
const OTHER = 4;
const ME = 1;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "latin1").replace(/\r\n/g, "\n").replace(/\0/g, "");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "a@lsi.example", name: "A", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

/* ── The old code, verbatim in what it counted ─────────────────────────── */

type D = { id: number; workspaceId: number; sequenceId: number | null; stepIndex: number | null; status: string; openCount: number; clickCount: number; bouncedAt: Date | null };
type R = { workspaceId: number; draftId: number | null };

/** getStepAnalytics before O41: every draft read, rolled up per step here. */
function oldStepAnalytics(ws: number, seq: { id: number; steps: Array<{ type: string; subject?: string }> }, drafts: D[], replies: R[]) {
  const steps = seq.steps ?? [];
  const mine = drafts.filter((d) => d.workspaceId === ws && d.sequenceId === seq.id);
  const byStep = new Map<number, { sent: number; uniqueOpens: number; uniqueClicks: number; totalOpens: number; totalClicks: number; bounced: number; replied: number }>();
  for (const d of mine) {
    const idx = d.stepIndex ?? -1;
    const bucket = byStep.get(idx) ?? { sent: 0, uniqueOpens: 0, uniqueClicks: 0, totalOpens: 0, totalClicks: 0, bounced: 0, replied: 0 };
    if (d.status === "sent") bucket.sent += 1;
    const oc = d.openCount ?? 0;
    const cc = d.clickCount ?? 0;
    bucket.totalOpens += oc;
    bucket.totalClicks += cc;
    if (oc > 0) bucket.uniqueOpens += 1;
    if (cc > 0) bucket.uniqueClicks += 1;
    if (d.bouncedAt) bucket.bounced += 1;
    byStep.set(idx, bucket);
  }
  const idToStep = new Map(mine.map((d) => [d.id, d.stepIndex ?? -1]));
  for (const r of replies.filter((x) => x.workspaceId === ws && x.draftId != null && idToStep.has(x.draftId))) {
    const bucket = byStep.get(idToStep.get(r.draftId!)!);
    if (bucket) bucket.replied += 1;
  }
  const rate = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);
  const out: any[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const b = byStep.get(i) ?? { sent: 0, uniqueOpens: 0, uniqueClicks: 0, totalOpens: 0, totalClicks: 0, bounced: 0, replied: 0 };
    out.push({
      stepIndex: i, stepType: s?.type ?? "unknown",
      stepLabel: s?.type === "email" ? (s.subject ?? `Email step ${i + 1}`) : `${s?.type ?? "?"} step ${i + 1}`,
      sent: b.sent, uniqueOpens: b.uniqueOpens, uniqueClicks: b.uniqueClicks, bounced: b.bounced, replied: b.replied,
      openRate: rate(b.uniqueOpens, b.sent), clickRate: rate(b.uniqueClicks, b.sent), replyRate: rate(b.replied, b.sent), bounceRate: rate(b.bounced, b.sent),
    });
  }
  const legacy = byStep.get(-1);
  if (legacy && legacy.sent > 0) {
    out.push({
      stepIndex: -1, stepType: "unknown", stepLabel: "(legacy / pre-0063 drafts)",
      sent: legacy.sent, uniqueOpens: legacy.uniqueOpens, uniqueClicks: legacy.uniqueClicks, bounced: legacy.bounced, replied: legacy.replied,
      openRate: rate(legacy.uniqueOpens, legacy.sent), clickRate: rate(legacy.uniqueClicks, legacy.sent), replyRate: rate(legacy.replied, legacy.sent), bounceRate: rate(legacy.bounced, legacy.sent),
    });
  }
  return { sequenceId: seq.id, steps: out };
}

/** getEnrollmentStepStats and getEnrollmentStats before O41. */
function oldEnrollmentCounts(ws: number, sequenceId: number, enr: Array<{ workspaceId: number; sequenceId: number; currentStep: number; status: string }>) {
  const mine = enr.filter((e) => e.workspaceId === ws && e.sequenceId === sequenceId);
  const stepCounts: Record<number, number> = {};
  for (const r of mine) stepCounts[r.currentStep] = (stepCounts[r.currentStep] ?? 0) + 1;
  const stats = { active: 0, paused: 0, finished: 0, exited: 0 };
  for (const row of mine) stats[row.status as keyof typeof stats]++;
  return { steps: Object.entries(stepCounts).map(([step, count]) => ({ step: Number(step), count })), stats };
}

/* ── Fixture ───────────────────────────────────────────────────────────── */

const STEPS = [
  { type: "email", subject: "Intro" },
  { type: "wait", days: 3 },
  { type: "email" },
  { type: "linkedin_dm" },
  { type: "email", subject: "Last note" },
];

function seed() {
  h.db = makeSqlFakeDb({ roles: { [WS]: h.role, [OTHER]: h.role }, wsId: () => WS });
  rows("sequences").push(
    { id: 5, workspaceId: WS, name: "Q4", status: "active", steps: STEPS, isTemplate: false },
    { id: 6, workspaceId: OTHER, name: "Theirs", status: "active", steps: STEPS, isTemplate: false },
  );
  const drafts: D[] = [];
  let id = 100;
  const add = (o: Partial<D>) => drafts.push({ id: id++, workspaceId: WS, sequenceId: 5, stepIndex: 0, status: "sent", openCount: 0, clickCount: 0, bouncedAt: null, ...o } as D);
  add({ openCount: 3, clickCount: 1 });
  add({ openCount: 1 });
  add({});
  add({ status: "pending_review", openCount: 2 }); // opened but not sent: counted as an open, not a send (old rule)
  add({ bouncedAt: new Date("2026-11-01T00:00:00Z") });
  add({ stepIndex: 2, openCount: 1, clickCount: 2 });
  add({ stepIndex: 2 });
  add({ stepIndex: 2, status: "rejected" });
  add({ stepIndex: 4, status: "approved" });
  add({ stepIndex: null }); // legacy, sent
  add({ stepIndex: null, openCount: 1 });
  add({ sequenceId: 9 }); // another sequence
  add({ workspaceId: OTHER, sequenceId: 5 }); // another workspace's draft on the same id
  for (const d of drafts) rows("email_drafts").push(d);
  const replies: R[] = [
    { workspaceId: WS, draftId: 100 }, { workspaceId: WS, draftId: 100 }, // two replies to one email: two rows, as before
    { workspaceId: WS, draftId: 105 },
    { workspaceId: WS, draftId: 109 }, // the legacy draft
    { workspaceId: WS, draftId: 111 }, // another sequence
    { workspaceId: OTHER, draftId: 112 },
    { workspaceId: WS, draftId: null }, // private mail
  ];
  let rid = 1;
  for (const r of replies) rows("email_replies").push({ id: rid++, ...r, campaignId: null, receivedAt: new Date() });
  const enr = [
    { workspaceId: WS, sequenceId: 5, currentStep: 0, status: "active" },
    { workspaceId: WS, sequenceId: 5, currentStep: 2, status: "active" },
    { workspaceId: WS, sequenceId: 5, currentStep: 2, status: "paused" },
    { workspaceId: WS, sequenceId: 5, currentStep: 5, status: "finished" },
    { workspaceId: WS, sequenceId: 5, currentStep: 1, status: "exited" },
    { workspaceId: WS, sequenceId: 6, currentStep: 0, status: "active" },
    { workspaceId: OTHER, sequenceId: 5, currentStep: 0, status: "active" },
  ];
  let eid = 1;
  for (const e of enr) rows("enrollments").push({ id: eid++, ...e });
  return { drafts, replies, enr };
}

beforeEach(() => { h.role = "rep"; });

describe("a sequence's step stats count in SQL, with the old numbers (O41)", () => {
  it("getStepAnalytics equals the old per-draft rollup on the same fixture", async () => {
    const { drafts, replies } = seed();
    const res = await caller().sequences.getStepAnalytics({ sequenceId: 5 });
    const old = oldStepAnalytics(WS, { id: 5, steps: STEPS as any }, drafts, replies);
    expect(res.steps).toEqual(old.steps);
    // The fixture exercises what matters: the legacy row, replies, opens on an unsent draft.
    expect(res.steps.find((s) => s.stepIndex === -1)).toMatchObject({ sent: 2, uniqueOpens: 1, replied: 1 });
    expect(res.steps[0]).toMatchObject({ sent: 4, uniqueOpens: 3, uniqueClicks: 1, bounced: 1, replied: 2 });
  });

  it("enrolment step and status counts equal the old row-by-row counts", async () => {
    const { enr } = seed();
    const old = oldEnrollmentCounts(WS, 5, enr);
    expect(await caller().sequences.getEnrollmentStepStats({ sequenceId: 5 })).toEqual(old.steps);
    expect(await caller().sequences.getEnrollmentStats({ sequenceId: 5 })).toEqual(old.stats);
  });

  it("no longer reads the sequence's drafts or enrolments row by row", () => {
    const src = read("server/routers/sequences.ts");
    const step = src.slice(src.indexOf("getStepAnalytics: workspaceProcedure"), src.indexOf("Send an emailDrafts row through the EmailAdapter"));
    expect(step).toContain("await stepAnalytics(db, ctx.workspace.id, seq)");
    expect(step).not.toContain(".from(emailDrafts)");
    const enrStep = src.slice(src.indexOf("getEnrollmentStepStats: workspaceProcedure"), src.indexOf("getPerformanceAnalytics: workspaceProcedure"));
    expect(enrStep).toContain("enrollmentStepCounts(db, ctx.workspace.id, input.sequenceId)");
    expect(enrStep).not.toContain("db.select().from(enrollments)");
    const engine = read("server/sequenceEngine.ts");
    const stats = engine.slice(engine.indexOf("export async function getEnrollmentStats("), engine.indexOf("export async function getEnrollmentStats(") + 900);
    expect(stats).toContain("enrollmentStatusCounts(db, workspaceId, sequenceId)");
    const svc = read("server/services/sequenceAnalytics.ts");
    const fn = svc.slice(svc.indexOf("export async function stepAnalytics("), svc.indexOf("export async function enrollmentStepCounts("));
    expect(fn.match(/\.groupBy\(emailDrafts\.stepIndex\)/g)?.length).toBe(2);
    expect(fn).toContain("genuineReplyScope()");
  });
});

/* ── Call tasks ────────────────────────────────────────────────────────── */

type T = { id: number; workspaceId: number; type: string; status: string; ownerUserId: number | null; source: string; relatedType: string | null; relatedId: number | null; dueAt: Date | null; updatedAt: Date };

/** tasks.list before O41: every task read, then filtered here. */
function oldTasksList(all: T[], ws: number, me: number, role: string, input: Record<string, any>) {
  let r = all.filter((t) => t.workspaceId === ws).sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0));
  if (input.ownerOnly) r = r.filter((t) => t.ownerUserId === me);
  const scopeOwner = input.mine && !["manager", "admin", "super_admin"].includes(role) ? me : null;
  if (scopeOwner !== null) r = r.filter((t) => t.ownerUserId === scopeOwner);
  if (input.status) r = r.filter((t) => t.status === input.status);
  else if (!input.includeDrafts) r = r.filter((t) => t.status !== "draft");
  if (input.type) r = r.filter((t) => t.type === input.type);
  if (input.source) r = r.filter((t) => t.source === input.source);
  if (input.relatedType && input.relatedId) r = r.filter((t) => t.relatedType === input.relatedType && t.relatedId === input.relatedId);
  return r.map((t) => t.id).sort((a, b) => a - b);
}

function seedTasks(): T[] {
  h.db = makeSqlFakeDb({ roles: { [WS]: h.role }, wsId: () => WS });
  const at = (d: number) => new Date(Date.UTC(2026, 10, d, 15));
  const all: T[] = [];
  let id = 1;
  const add = (o: Partial<T>) => all.push({ id: id++, workspaceId: WS, type: "call", status: "open", ownerUserId: ME, source: "manual", relatedType: "contact", relatedId: 7, dueAt: at(10), updatedAt: at(1), ...o } as T);
  add({});
  add({ dueAt: at(3) });
  add({ ownerUserId: 9 });
  add({ status: "done", updatedAt: at(5) });
  add({ status: "done", updatedAt: at(6), ownerUserId: 9 });
  add({ status: "draft" });
  add({ type: "email" });
  add({ type: "email", source: "ai", relatedType: "lead", relatedId: 3 });
  add({ dueAt: null });
  add({ workspaceId: OTHER });
  for (const t of all) rows("tasks").push({ ...t, title: `t${t.id}`, priority: "normal", snoozedUntil: null, createdAt: at(1) });
  return all;
}

describe("tasks filter in SQL, and the Calls page reads call tasks only (O41)", () => {
  const inputs: Array<Record<string, any>> = [
    {}, { type: "call" }, { type: "call", status: "open" }, { status: "done" }, { includeDrafts: true },
    { ownerOnly: true }, { mine: true }, { source: "ai" }, { relatedType: "contact", relatedId: 7 }, { type: "email", includeDrafts: true },
  ];
  for (const role of ["rep", "manager"]) {
    it(`returns exactly the old rows for every filter (${role})`, async () => {
      h.role = role;
      const all = seedTasks();
      for (const input of inputs) {
        const got = (await caller().tasks.list(input as any)).map((t: any) => t.id).sort((a: number, b: number) => a - b);
        expect(got, JSON.stringify(input)).toEqual(oldTasksList(all, WS, ME, role, input));
      }
    });
  }

  it("bounds a page when asked, and orders a Completed list newest first", async () => {
    seedTasks();
    expect(await caller().tasks.list({ type: "call", status: "open", limit: 2 })).toHaveLength(2);
    const done = await caller().tasks.list({ type: "call", status: "done", order: "recent" });
    expect(done.map((t: any) => t.id)).toEqual([5, 4]);
    // Undated last in the bounded queue (MySQL sorts NULL first otherwise).
    const src = read("server/routers/activities.ts");
    expect(src).toContain('input?.order === "soonest" ? [sql`${tasks.dueAt} is null`, asc(tasks.dueAt), asc(tasks.id)]');
  });

  it("counts one type of task on the workspace's day", async () => {
    seedTasks();
    const s = await caller().tasks.stats({ type: "call" });
    // Open call tasks in WS: ids 1, 2, 3, 9 (draft 6 and done 4, 5 are not open).
    expect(s.open).toBe(4);
    expect(s.completed).toBe(2);
    const all = await caller().tasks.stats();
    expect(all.open).toBe(6);
  });

  it("the Calls page asks for call tasks, bounded, and counts on the server", () => {
    const src = read("client/src/pages/usip/Calls.tsx");
    const page = src.slice(src.indexOf("export default function Calls()"));
    expect(page).toContain('trpc.tasks.list.useQuery({ type: "call", status: "open", limit: CALL_QUEUE_LIMIT, order: "soonest" })');
    expect(page).toContain('trpc.tasks.list.useQuery({ type: "call", status: "done", limit: DONE_SHOWN, order: "recent" })');
    expect(page).toContain('trpc.tasks.stats.useQuery({ type: "call" })');
    expect(page).not.toContain("trpc.tasks.list.useQuery({})");
    expect(page).not.toContain("setHours(24, 0, 0, 0)");
  });
});
