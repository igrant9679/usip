/**
 * Every write procedure, called with another workspace's ids (audit
 * 2026-10-20, X1.1 and F4; final pass 2026-11-07).
 *
 * tenantScopeProcedures.test.ts pins the audit's own C1/C4-C9 cases and
 * tenantScope.test.ts scans every UPDATE/DELETE for a workspace filter. What
 * neither did was take EVERY mutation and hand it a foreign id. This does:
 *
 *   · every table with a workspaceId gets a row id 1 in the caller's
 *     workspace (2) and a row id 9001 in a stranger's (99); user 9001 is a
 *     member of 99 only;
 *   · for each mutation and each numeric *Id / *Ids field in its input
 *     (the record being edited, `id`/`ids`, is the caller's row 1), an input
 *     is generated from its zod schema with that one field set to 9001 and
 *     every other id the caller's own;
 *   · the call runs as a super admin of workspace 2 against the SQL fake,
 *     with the network, mail and AI stubbed to fail;
 *   · afterwards no row may hold 9001 that did not before, and no row of
 *     workspace 99 may have changed.
 *
 * A refusal, an unrelated failure and "nothing written" all pass; a foreign
 * id written onto a record, or a stranger's record changed, fails, naming the
 * procedure, the field and the column. The same input with the caller's own
 * id 1 is run first as a control, and the count of procedures it carries end
 * to end is pinned from below, so the scan cannot quietly stop reaching them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { MySqlTable } from "drizzle-orm/mysql-core";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./emailDelivery", async (a) => ({
  ...(await a<typeof import("./emailDelivery")>()),
  sendSystemEmail: async () => { throw new Error("mail is stubbed in this test"); },
  sendWorkspaceEmail: async () => { throw new Error("mail is stubbed in this test"); },
}));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async () => { throw new Error("AI is stubbed in this test"); },
}));

import * as schema from "../drizzle/schema";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

const HOME = 2;
const FOREIGN = 99;
const HOME_ID = 1;
const FOREIGN_ID = 9001;
const CALLER = 1;

/* ─── the database: one home row and one foreign row in every workspace table ── */

const WS_TABLES: Array<{ name: string; table: any }> = [];
for (const v of Object.values(schema)) {
  if (!is(v, MySqlTable)) continue;
  const cols = getTableColumns(v as any) as Record<string, unknown>;
  if ("workspaceId" in cols && "id" in cols) WS_TABLES.push({ name: getTableName(v as any), table: v });
}

function seed() {
  h.db = makeSqlFakeDb({ realMembers: true });
  const rows = (t: string) => h.db.rowsOf(t) as any[];
  for (const { name, table } of WS_TABLES) {
    const blank: Record<string, unknown> = {};
    for (const k of Object.keys(getTableColumns(table))) blank[k] = null;
    rows(name).push({ ...blank, id: HOME_ID, workspaceId: HOME, createdAt: new Date(), updatedAt: new Date() });
    rows(name).push({ ...blank, id: FOREIGN_ID, workspaceId: FOREIGN, createdAt: new Date(), updatedAt: new Date() });
  }
  rows("workspaces").push(
    { id: HOME, name: "Home", slug: "home", ownerUserId: CALLER, archivedAt: null, plan: "trial" },
    { id: FOREIGN, name: "Stranger", slug: "stranger", ownerUserId: FOREIGN_ID, archivedAt: null, plan: "trial" },
  );
  rows("users").push(
    { id: CALLER, openId: "o1", name: "Caller", email: "caller@home.example", role: "user", passwordHash: null, sessionVersion: 0, mfaTotpEnabledAt: new Date() },
    { id: FOREIGN_ID, openId: "o9001", name: "Stranger", email: "stranger@foreign.example", role: "user", passwordHash: null, sessionVersion: 0 },
  );
  // workspace_members has a workspaceId, so it was seeded above: row 1 is the
  // caller's own membership, row 9001 the stranger's in workspace 99.
  Object.assign(rows("workspace_members").find((r) => r.id === HOME_ID), { userId: CALLER, role: "super_admin", inviteToken: null, deactivatedAt: null });
  Object.assign(rows("workspace_members").find((r) => r.id === FOREIGN_ID), { userId: FOREIGN_ID, role: "super_admin", inviteToken: null, deactivatedAt: null });
}

function caller() {
  const user = (h.db.rowsOf("users") as any[]).find((u) => u.id === CALLER);
  return appRouter.createCaller({
    user: { ...user, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), loginMethod: "password" },
    req: { protocol: "https", headers: { "x-workspace-id": String(HOME) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {}, cookie: () => {}, setHeader: () => {} },
  } as unknown as TrpcContext);
}

/* ─── inputs, generated from each procedure's zod schema ─────────────────── */

type Def = { type: string; [k: string]: any };
const defOf = (s: any): Def | null => (s?._zod?.def ?? null);
const unwrap = (s: any): any => {
  let cur = s;
  for (let i = 0; i < 10; i++) {
    const d = defOf(cur);
    if (!d) return cur;
    if (["optional", "nullable", "default", "readonly", "nonoptional", "catch", "prefault"].includes(d.type)) cur = d.innerType;
    else if (d.type === "pipe") cur = d.in;
    else if (d.type === "lazy") cur = d.getter();
    else return cur;
  }
  return cur;
};
const isOptional = (s: any): boolean => {
  const d = defOf(s);
  return !!d && (d.type === "optional" || d.type === "default" || d.type === "prefault" || (d.type === "nullable" && isOptional(d.innerType)));
};
const checks = (d: Def) => ((d.checks ?? []) as any[]).map((c) => c?._zod?.def ?? c?.def ?? c);

/** An id-carrying field: numeric, named *Id or *Ids. `workspaceId` is not a link. */
const isIdName = (k: string) => /(Id|Ids)$/.test(k) && !/^(workspaceId|fromWorkspaceId|toWorkspaceId)$/.test(k);
const isNumericish = (s: any): boolean => {
  const d = defOf(unwrap(s));
  if (!d) return false;
  if (d.type === "number" || d.type === "int") return true;
  if (d.type === "array") return isNumericish(d.element);
  return false;
};

function gen(s: any, path: string, ctx: { target: string; value: number }): unknown {
  const inner = unwrap(s);
  const d = defOf(inner);
  if (!d) return undefined;
  const leaf = path.replace(/.*\./, "").replace(/\[\]/g, "");
  switch (d.type) {
    case "object": {
      const shape = typeof d.shape === "function" ? d.shape() : d.shape;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(shape ?? {})) {
        const p = path ? `${path}.${k}` : k;
        const onTargetPath = ctx.target === p || ctx.target.startsWith(`${p}.`) || ctx.target.startsWith(`${p}[]`);
        // The type that goes with a target id ("relatedType" beside "relatedId").
        const typeOfTarget = /Type$/.test(k) && ctx.target === `${path ? `${path}.` : ""}${k.replace(/Type$/, "Id")}`;
        if (isOptional(v) && !onTargetPath && !typeOfTarget) continue;
        const val = gen(v, p, ctx);
        if (val !== undefined) out[k] = val;
      }
      return out;
    }
    case "array": {
      const one = gen(d.element, `${path}[]`, ctx);
      return one === undefined ? [] : [one];
    }
    case "number":
    case "int": {
      if (path === ctx.target || `${path}[]` === ctx.target || path.replace(/\[\]$/, "") === ctx.target) return ctx.value;
      if (leaf === "id" || leaf === "ids" || isIdName(leaf)) return HOME_ID;
      let v = 1;
      for (const c of checks(d)) {
        if (c.check === "greater_than") v = Math.max(v, Number(c.value) + (c.inclusive ? 0 : 1));
        if (c.check === "less_than") v = Math.min(v, Number(c.value) - (c.inclusive ? 0 : 1));
      }
      return v;
    }
    case "string": {
      // z.email() carries its format on the def; z.string().email() on a check.
      const format = d.format ?? checks(d).find((c) => c.check === "string_format")?.format;
      if (format === "email") return "someone@example.com";
      if (format === "url") return "https://example.com/x";
      if (format === "uuid" || format === "guid") return "00000000-0000-4000-8000-000000000000";
      if (format === "datetime") return new Date().toISOString();
      if (format === "date") return "2026-01-15";
      // A free-text record type ("relatedType", "entityType") names a kind
      // every workspace table is seeded for, so the call can reach its id.
      if (leaf === "relatedType" || leaf === "entityType" || leaf === "linkedEntityType") return "account";
      let min = 1, max = 64;
      for (const c of checks(d)) {
        if (c.check === "min_length") min = Math.max(min, Number(c.minimum));
        if (c.check === "max_length") max = Math.min(max, Number(c.maximum));
        if (c.check === "length_equals") { min = Number(c.length); max = min; }
      }
      return "x".repeat(Math.max(1, Math.min(min, max)));
    }
    case "boolean": return false;
    case "date": return new Date();
    case "enum": return Object.values(d.entries ?? {})[0];
    case "literal": return (d.values ?? [])[0];
    case "union": return gen((d.options ?? [])[0], path, ctx);
    case "record": return {};
    case "tuple": return (d.items ?? []).map((it: any, i: number) => gen(it, `${path}.${i}`, ctx));
    case "null": return null;
    default: return undefined;
  }
}

/** Every numeric id field in a schema, as paths ("patch.accountId", "steps[].sequenceId"). */
function idFields(s: any, path = "", depth = 0): string[] {
  if (depth > 4) return [];
  const d = defOf(unwrap(s));
  if (!d) return [];
  if (d.type === "object") {
    const shape = typeof d.shape === "function" ? d.shape() : d.shape;
    const out: string[] = [];
    for (const [k, v] of Object.entries(shape ?? {})) {
      const p = path ? `${path}.${k}` : k;
      if (isIdName(k) && isNumericish(v)) out.push(p);
      else out.push(...idFields(v, p, depth + 1));
    }
    return out;
  }
  if (d.type === "array") return idFields(d.element, `${path}[]`, depth + 1);
  return [];
}

/* ─── one call, and what it wrote ────────────────────────────────────────── */

type Snapshot = Map<string, Array<Record<string, unknown>>>;
const snap = (): Snapshot => new Map(Array.from((h.db.tables as Map<string, any[]>).entries()).map(([k, rs]) => [k, rs.map((r) => ({ ...r }))]));
const holds = (v: unknown): boolean => {
  if (v === FOREIGN_ID || v === String(FOREIGN_ID)) return true;
  if (Array.isArray(v)) return v.some(holds);
  if (v && typeof v === "object" && !(v instanceof Date)) return Object.values(v).some(holds);
  if (typeof v === "string" && v.startsWith("[") && v.includes(String(FOREIGN_ID))) return true;
  return false;
};
const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : JSON.stringify(a) === JSON.stringify(b));

function leaksBetween(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  for (const [t, rows] of Array.from(after.entries())) {
    const old = new Map((before.get(t) ?? []).map((r) => [r.id, r]));
    for (const r of rows) {
      const was = old.get(r.id);
      for (const [k, v] of Object.entries(r)) {
        if (k === "id" || k === "updatedAt") continue;
        // An audit row's before/after is a record of what was asked, input
        // ids included (G49 records them on purpose); its entityId is a claim
        // that something was done to that record, and is checked.
        if (t === "audit_log" && (k === "before" || k === "after")) continue;
        if (was && same(was[k], v)) continue;
        if (holds(v)) out.push(`${t}.${k} = ${FOREIGN_ID}${was ? "" : " (new row)"}`);
        if (was && was.workspaceId === FOREIGN && !same(was[k], v)) out.push(`changed workspace ${FOREIGN}'s ${t} row (${k})`);
      }
      if (!was && r.workspaceId === FOREIGN) out.push(`inserted a ${t} row into workspace ${FOREIGN}`);
    }
    // A stranger's row that disappeared was deleted.
    for (const r of before.get(t) ?? []) {
      if (r.workspaceId === FOREIGN && !rows.some((x) => x.id === r.id)) out.push(`deleted workspace ${FOREIGN}'s ${t} row`);
    }
  }
  return Array.from(new Set(out));
}

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
async function run(path: string, input: unknown): Promise<{ ok: boolean; error?: string; leaks: string[] }> {
  seed();
  const before = snap();
  let ok = false;
  let error: string | undefined;
  const fn = path.split(".").reduce((o: any, k) => o?.[k], caller() as any);
  try {
    await Promise.race([
      fn(input),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), 3000)),
    ]);
    ok = true;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  await settle();
  return { ok, error, leaks: leaksBetween(before, snap()) };
}

/* ─── the scan ───────────────────────────────────────────────────────────── */

type Pair = { path: string; field: string };
const results: Array<Pair & { control: boolean; foreignOk: boolean; leaks: string[]; error?: string }> = [];
let skipped = 0;
const skippedPairs: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  globalThis.fetch = (async () => { throw new Error("network is stubbed in this test"); }) as typeof fetch;
  const procs = (appRouter as any)._def.procedures as Record<string, any>;
  for (const [path, p] of Object.entries(procs)) {
    if (p._def.type !== "mutation") continue;
    const input = (p._def.inputs ?? [])[0];
    if (!input) continue;
    for (const field of idFields(input)) {
      const home = gen(input, "", { target: field, value: HOME_ID });
      const foreign = gen(input, "", { target: field, value: FOREIGN_ID });
      const parsed = input.safeParse(foreign);
      if (!input.safeParse(home).success || !parsed.success) { skipped++; skippedPairs.push(`${path} ${field}: ${parsed.success ? "home" : JSON.stringify(parsed.error.issues[0]).slice(0, 160)}`); continue; }
      const control = await run(path, home);
      const out = await run(path, foreign);
      results.push({ path, field, control: control.ok, foreignOk: out.ok, leaks: out.leaks, error: out.error });
    }
  }
}, 600_000);
afterAll(async () => {
  globalThis.fetch = realFetch;
  // FOREIGN_ID_DUMP=<file> writes every pair's outcome, to see what the scan reached.
  if (process.env.FOREIGN_ID_DUMP) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.FOREIGN_ID_DUMP, JSON.stringify({ skipped, skippedPairs, results }, null, 1));
  }
});

describe("no write procedure accepts another workspace's id", () => {
  it("scans every mutation's id fields", () => {
    // 2026-11-07: about 360 (procedure, field) pairs generate a valid input.
    expect(results.length).toBeGreaterThan(300);
    const exercised = results.filter((r) => r.control).length;
    if (process.env.FOREIGN_ID_REPORT) {
      console.log(`[foreignIdWrites] pairs ${results.length}, control ran end to end ${exercised}, inputs not generated ${skipped}`);
    }
    // The control run (the caller's own id) gets all the way through for at
    // least this many; a drop means the scan stopped reaching procedures.
    expect(exercised).toBeGreaterThan(120);
  });

  it("none writes a foreign id or touches a stranger's row", () => {
    const leaks = results.filter((r) => r.leaks.length > 0).map((r) => `${r.path} ${r.field}: ${r.leaks.join("; ")}`);
    expect(leaks).toEqual([]);
  });

  it("the cases the audit named, and those this scan found, are reached and refused", () => {
    const find = (path: string, field: string) => results.find((r) => r.path === path && r.field === field);
    for (const [path, field] of [
      // Named by the audit (X1.1).
      ["proposals.create", "contactId"],
      ["proposals.create", "accountId"],
      ["proposals.update", "contactId"],
      ["proposals.update", "accountId"],
      ["activities.addNote", "relatedId"],
      ["activities.logCall", "relatedId"],
      // Found by this scan on 2026-11-07, each one a foreign id written.
      ["activities.logMeeting", "relatedId"],
      ["tasks.bulk", "targets[].relatedId"],
      ["tasks.bulk", "template.ownerUserId"],
      ["meetings.create", "relatedId"],
      ["crmNotes.create", "entityId"],
      ["sequences.assign", "userId"],
      ["campaigns.update", "patch.ownerUserId"],
      ["campaigns.attachComponent", "campaignId"],
      ["quotes.create", "lineItems[].productId"],
      ["settings.save", "systemSenderAccountId"],
      ["dashboardLayouts.saveLayout", "dashboardId"],
      ["oppIntelligence.addCoOwner", "userId"],
      ["pipelineAlerts.logActivityOnDeal", "opportunityId"],
      ["are.campaigns.create", "icpProfileId"],
      ["are.campaigns.applyBestFit", "picks[].prospectId"],
      ["are.campaigns.applyBestFit", "picks[].campaignId"],
      ["mailboxAi.triageThread", "accountId"],
      ["helpCenter.createArticle", "categoryId"],
      ["helpCenter.updateArticle", "associatedTourId"],
      ["tours.upsert", "prerequisiteTourId"],
      ["tours.startTour", "tourId"],
      ["mindmaps.createLinkedTask", "mindmapId"],
      ["mindmaps.createLinkedTask", "ownerUserId"],
      ["mindmaps.createLinkedNote", "mindmapId"],
      ["linkedinEnrichment.createBatch", "rows[].prospectId"],
      ["linkedinEnrichment.acknowledgeChanges", "prospectId"],
      ["scoring.createGroup", "modelId"],
      ["scoring.recalcModel", "modelId"],
      ["companies.archive", "accountId"],
    ] as const) {
      const r = find(path, field);
      expect(r, `${path} ${field} was scanned`).toBeTruthy();
      expect(r!.control, `${path} with the caller's own id runs`).toBe(true);
      expect(r!.foreignOk, `${path} with a foreign ${field} is refused`).toBe(false);
    }
  });
});
