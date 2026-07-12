/**
 * reports.ts — the /reports builder backend.
 *
 * One `run` proc executes a report spec against a fixed per-object column
 * WHITELIST (never raw field names into SQL): pick an object, choose columns,
 * stack filters, optionally group by a column with count/sum/avg, sort, cap.
 * `exportCsv` renders the same spec as CSV text. `savedReports` CRUD persists
 * specs (config json) per workspace.
 *
 * Objects: deals (opportunities) · leads · prospects · contacts · activities.
 * Owner/actor user-id columns are resolved to names post-query.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, avg, count, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, or, sum, type SQL } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import { z } from "zod";
import { activities, contacts, leads, opportunities, prospects, savedReports, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";

/* ─── Object registry (the whitelist) ────────────────────────────────────── */

type ColKind = "text" | "number" | "date" | "user";
type ColDef = { col: MySqlColumn; label: string; kind: ColKind };
type ObjectDef = {
  table: typeof opportunities | typeof leads | typeof prospects | typeof contacts | typeof activities;
  wsCol: MySqlColumn;
  columns: Record<string, ColDef>;
  defaultColumns: string[];
};

const OBJECTS: Record<string, ObjectDef> = {
  deals: {
    table: opportunities,
    wsCol: opportunities.workspaceId,
    defaultColumns: ["name", "stage", "value", "winProb", "closeDate", "owner"],
    columns: {
      name: { col: opportunities.name, label: "Deal name", kind: "text" },
      stage: { col: opportunities.stage, label: "Stage", kind: "text" },
      value: { col: opportunities.value, label: "Value", kind: "number" },
      winProb: { col: opportunities.winProb, label: "Win probability", kind: "number" },
      closeDate: { col: opportunities.closeDate, label: "Close date", kind: "date" },
      daysInStage: { col: opportunities.daysInStage, label: "Days in stage", kind: "number" },
      nextStep: { col: opportunities.nextStep, label: "Next step", kind: "text" },
      winReason: { col: opportunities.winReason, label: "Win reason", kind: "text" },
      lostReason: { col: opportunities.lostReason, label: "Lost reason", kind: "text" },
      lastActivityAt: { col: opportunities.lastActivityAt, label: "Last activity", kind: "date" },
      owner: { col: opportunities.ownerUserId, label: "Owner", kind: "user" },
      createdAt: { col: opportunities.createdAt, label: "Created", kind: "date" },
    },
  },
  leads: {
    table: leads,
    wsCol: leads.workspaceId,
    defaultColumns: ["firstName", "lastName", "company", "status", "score", "owner"],
    columns: {
      firstName: { col: leads.firstName, label: "First name", kind: "text" },
      lastName: { col: leads.lastName, label: "Last name", kind: "text" },
      email: { col: leads.email, label: "Email", kind: "text" },
      phone: { col: leads.phone, label: "Phone", kind: "text" },
      company: { col: leads.company, label: "Company", kind: "text" },
      title: { col: leads.title, label: "Title", kind: "text" },
      source: { col: leads.source, label: "Source", kind: "text" },
      status: { col: leads.status, label: "Status", kind: "text" },
      score: { col: leads.score, label: "Score", kind: "number" },
      grade: { col: leads.grade, label: "Grade", kind: "text" },
      owner: { col: leads.ownerUserId, label: "Owner", kind: "user" },
      createdAt: { col: leads.createdAt, label: "Created", kind: "date" },
    },
  },
  prospects: {
    table: prospects,
    wsCol: prospects.workspaceId,
    defaultColumns: ["firstName", "lastName", "title", "company", "emailStatus", "createdAt"],
    columns: {
      firstName: { col: prospects.firstName, label: "First name", kind: "text" },
      lastName: { col: prospects.lastName, label: "Last name", kind: "text" },
      title: { col: prospects.title, label: "Title", kind: "text" },
      seniority: { col: prospects.seniority, label: "Seniority", kind: "text" },
      email: { col: prospects.email, label: "Email", kind: "text" },
      emailStatus: { col: prospects.emailStatus, label: "Email status", kind: "text" },
      phone: { col: prospects.phone, label: "Phone", kind: "text" },
      company: { col: prospects.company, label: "Company", kind: "text" },
      industry: { col: prospects.industry, label: "Industry", kind: "text" },
      city: { col: prospects.city, label: "City", kind: "text" },
      state: { col: prospects.state, label: "State", kind: "text" },
      country: { col: prospects.country, label: "Country", kind: "text" },
      createdAt: { col: prospects.createdAt, label: "Created", kind: "date" },
    },
  },
  contacts: {
    table: contacts,
    wsCol: contacts.workspaceId,
    defaultColumns: ["firstName", "lastName", "title", "companyName", "email", "owner"],
    columns: {
      firstName: { col: contacts.firstName, label: "First name", kind: "text" },
      lastName: { col: contacts.lastName, label: "Last name", kind: "text" },
      title: { col: contacts.title, label: "Title", kind: "text" },
      email: { col: contacts.email, label: "Email", kind: "text" },
      phone: { col: contacts.phone, label: "Phone", kind: "text" },
      companyName: { col: contacts.companyName, label: "Company", kind: "text" },
      seniority: { col: contacts.seniority, label: "Seniority", kind: "text" },
      city: { col: contacts.city, label: "City", kind: "text" },
      relStrengthLabel: { col: contacts.relStrengthLabel, label: "Relationship", kind: "text" },
      owner: { col: contacts.ownerUserId, label: "Owner", kind: "user" },
      createdAt: { col: contacts.createdAt, label: "Created", kind: "date" },
    },
  },
  activities: {
    table: activities,
    wsCol: activities.workspaceId,
    defaultColumns: ["type", "subject", "relatedType", "actor", "occurredAt"],
    columns: {
      type: { col: activities.type, label: "Type", kind: "text" },
      subject: { col: activities.subject, label: "Subject", kind: "text" },
      relatedType: { col: activities.relatedType, label: "Related to", kind: "text" },
      relatedId: { col: activities.relatedId, label: "Related id", kind: "number" },
      callDisposition: { col: activities.callDisposition, label: "Call disposition", kind: "text" },
      callDurationSec: { col: activities.callDurationSec, label: "Call duration (s)", kind: "number" },
      actor: { col: activities.actorUserId, label: "By", kind: "user" },
      occurredAt: { col: activities.occurredAt, label: "Occurred", kind: "date" },
    },
  },
};

/* ─── Spec schema ────────────────────────────────────────────────────────── */

const filterSchema = z.object({
  field: z.string().max(64),
  op: z.enum(["eq", "neq", "contains", "gt", "gte", "lt", "lte", "is_empty", "not_empty"]),
  value: z.string().max(500).optional(),
});

const specSchema = z.object({
  object: z.enum(["deals", "leads", "prospects", "contacts", "activities"]),
  columns: z.array(z.string().max(64)).min(1).max(20),
  filters: z.array(filterSchema).max(12).default([]),
  groupBy: z.string().max(64).optional(),
  aggregate: z.enum(["count", "sum_value", "avg_value"]).optional(), // sum/avg use aggregateField
  aggregateField: z.string().max(64).optional(),
  sort: z.object({ field: z.string().max(64), dir: z.enum(["asc", "desc"]) }).optional(),
  limit: z.number().int().min(1).max(1000).default(200),
});
export type ReportSpec = z.infer<typeof specSchema>;

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function colOrThrow(def: ObjectDef, field: string): ColDef {
  const c = def.columns[field];
  if (!c) throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown field "${field}"` });
  return c;
}

function filterToSql(def: ObjectDef, f: z.infer<typeof filterSchema>): SQL {
  const { col, kind } = colOrThrow(def, f.field);
  const v = f.value ?? "";
  const typed = (): string | number | Date => {
    if (kind === "number" || kind === "user") {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new TRPCError({ code: "BAD_REQUEST", message: `"${v}" is not a number` });
      return n;
    }
    if (kind === "date") {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: `"${v}" is not a date` });
      return d;
    }
    return v;
  };
  switch (f.op) {
    case "eq": return eq(col, typed());
    case "neq": return ne(col, typed());
    case "contains": return like(col, `%${v}%`);
    case "gt": return gt(col, typed());
    case "gte": return gte(col, typed());
    case "lt": return lt(col, typed());
    case "lte": return lte(col, typed());
    case "is_empty": return or(isNull(col), eq(col, "" as never))!;
    case "not_empty": return and(isNotNull(col), ne(col, "" as never))!;
  }
}

export async function runSpec(workspaceId: number, spec: ReportSpec): Promise<{ columns: { key: string; label: string; kind: ColKind }[]; rows: Record<string, unknown>[]; grouped: boolean }> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const def = OBJECTS[spec.object];

  const where = and(eq(def.wsCol, workspaceId), ...spec.filters.map((f) => filterToSql(def, f)));

  /* grouped mode: one row per group value + aggregate */
  if (spec.groupBy) {
    const g = colOrThrow(def, spec.groupBy);
    const aggField = spec.aggregateField ? colOrThrow(def, spec.aggregateField) : null;
    const aggExpr =
      spec.aggregate === "sum_value" && aggField ? sum(aggField.col)
      : spec.aggregate === "avg_value" && aggField ? avg(aggField.col)
      : count();
    const rows = await db
      .select({ group: g.col, agg: aggExpr, n: count() })
      .from(def.table)
      .where(where)
      .groupBy(g.col)
      .orderBy(desc(count()))
      .limit(spec.limit);
    const aggLabel =
      spec.aggregate === "sum_value" && spec.aggregateField ? `Sum of ${colOrThrow(def, spec.aggregateField).label}`
      : spec.aggregate === "avg_value" && spec.aggregateField ? `Avg ${colOrThrow(def, spec.aggregateField).label}`
      : "Count";
    let out = rows.map((r) => ({ group: r.group ?? "(empty)", agg: spec.aggregate && spec.aggregate !== "count" ? Number(r.agg ?? 0) : Number(r.n), n: Number(r.n) }));
    if (g.kind === "user") out = await resolveUserNames(out, "group");
    return {
      grouped: true,
      columns: [
        { key: "group", label: g.label, kind: g.kind === "user" ? "text" : g.kind },
        { key: "agg", label: aggLabel, kind: "number" },
        { key: "n", label: "Rows", kind: "number" },
      ],
      rows: out,
    };
  }

  /* flat mode */
  const sel: Record<string, MySqlColumn> = {};
  for (const key of spec.columns) sel[key] = colOrThrow(def, key).col;
  const sortCol = spec.sort ? colOrThrow(def, spec.sort.field).col : null;
  const base = db.select(sel).from(def.table).where(where).limit(spec.limit);
  const rows = (sortCol ? await base.orderBy(spec.sort!.dir === "asc" ? asc(sortCol) : desc(sortCol)) : await base) as Record<string, unknown>[];

  // resolve user-id columns to names
  let out = rows;
  for (const key of spec.columns) {
    if (def.columns[key].kind === "user") out = await resolveUserNames(out, key);
  }
  return {
    grouped: false,
    columns: spec.columns.map((key) => ({ key, label: def.columns[key].label, kind: def.columns[key].kind === "user" ? "text" : def.columns[key].kind })),
    rows: out,
  };
}

async function resolveUserNames<T extends Record<string, unknown>>(rows: T[], key: string): Promise<T[]> {
  const db = await getDb();
  const ids = [...new Set(rows.map((r) => r[key]).filter((v): v is number => typeof v === "number" && v > 0))];
  if (ids.length === 0) return rows;
  const found = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids));
  const byId = new Map(found.map((u) => [u.id, u.name || u.email || `User ${u.id}`]));
  return rows.map((r) => ({ ...r, [key]: typeof r[key] === "number" ? (byId.get(r[key] as number) ?? `User ${r[key]}`) : r[key] }));
}

function toCsv(columns: { key: string; label: string }[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => esc(c.label)).join(","), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(","))].join("\n");
}

/* ─── Preset reports (10) — code-defined, available to every workspace ───── */

export const PRESET_REPORTS: Array<{ key: string; name: string; description: string; spec: ReportSpec }> = [
  { key: "pipeline-by-stage", name: "Pipeline by stage", description: "Deal value and count per stage.", spec: { object: "deals", columns: ["stage", "value"], filters: [], groupBy: "stage", aggregate: "sum_value", aggregateField: "value", limit: 200 } },
  { key: "deals-by-owner", name: "Deal value by owner", description: "Who owns the pipeline.", spec: { object: "deals", columns: ["owner", "value"], filters: [], groupBy: "owner", aggregate: "sum_value", aggregateField: "value", limit: 200 } },
  { key: "upcoming-closes", name: "Upcoming close dates", description: "Open deals ordered by close date.", spec: { object: "deals", columns: ["name", "stage", "value", "winProb", "closeDate", "owner"], filters: [{ field: "closeDate", op: "not_empty" }, { field: "stage", op: "neq", value: "won" }, { field: "stage", op: "neq", value: "lost" }], sort: { field: "closeDate", dir: "asc" }, limit: 200 } },
  { key: "won-deals", name: "Won deals", description: "Closed-won, biggest first.", spec: { object: "deals", columns: ["name", "value", "winReason", "owner", "closeDate"], filters: [{ field: "stage", op: "eq", value: "won" }], sort: { field: "value", dir: "desc" }, limit: 200 } },
  { key: "lost-deals", name: "Lost deals & reasons", description: "What we lost and why.", spec: { object: "deals", columns: ["name", "value", "lostReason", "owner", "closeDate"], filters: [{ field: "stage", op: "eq", value: "lost" }], sort: { field: "value", dir: "desc" }, limit: 200 } },
  { key: "leads-by-status", name: "Lead funnel by status", description: "Lead counts per status.", spec: { object: "leads", columns: ["status"], filters: [], groupBy: "status", aggregate: "count", limit: 200 } },
  { key: "lead-quality-by-source", name: "Lead quality by source", description: "Average lead score per source.", spec: { object: "leads", columns: ["source", "score"], filters: [], groupBy: "source", aggregate: "avg_value", aggregateField: "score", limit: 200 } },
  { key: "prospects-by-email-status", name: "Prospects by email status", description: "Deliverability shape of your list.", spec: { object: "prospects", columns: ["emailStatus"], filters: [], groupBy: "emailStatus", aggregate: "count", limit: 200 } },
  { key: "sendable-prospects", name: "Sendable prospects", description: "Valid-email prospects ready to enroll.", spec: { object: "prospects", columns: ["firstName", "lastName", "title", "company", "email", "createdAt"], filters: [{ field: "emailStatus", op: "eq", value: "valid" }], sort: { field: "createdAt", dir: "desc" }, limit: 500 } },
  { key: "activity-by-type", name: "Activity volume by type", description: "Logged touches per activity type.", spec: { object: "activities", columns: ["type"], filters: [], groupBy: "type", aggregate: "count", limit: 200 } },
];

/* ─── Router ─────────────────────────────────────────────────────────────── */

export const reportsRouter = router({
  /** Column catalog per object — drives the builder UI. */
  schema: workspaceProcedure.query(() => {
    const out: Record<string, { defaultColumns: string[]; columns: { key: string; label: string; kind: ColKind }[] }> = {};
    for (const [obj, def] of Object.entries(OBJECTS)) {
      out[obj] = {
        defaultColumns: def.defaultColumns,
        columns: Object.entries(def.columns).map(([key, c]) => ({ key, label: c.label, kind: c.kind })),
      };
    }
    return out;
  }),

  run: workspaceProcedure.input(specSchema).query(async ({ ctx, input }) => {
    return runSpec(ctx.workspace.id, input);
  }),

  exportCsv: workspaceProcedure.input(specSchema).mutation(async ({ ctx, input }) => {
    const result = await runSpec(ctx.workspace.id, { ...input, limit: 1000 });
    return { csv: toCsv(result.columns, result.rows), rows: result.rows.length };
  }),

  /* saved reports */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    return db.select().from(savedReports).where(eq(savedReports.workspaceId, ctx.workspace.id)).orderBy(desc(savedReports.updatedAt));
  }),

  save: workspaceProcedure
    .input(z.object({ id: z.number().int().optional(), name: z.string().min(1).max(160), spec: specSchema }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (input.id) {
        const [existing] = await db.select({ id: savedReports.id }).from(savedReports)
          .where(and(eq(savedReports.id, input.id), eq(savedReports.workspaceId, ctx.workspace.id))).limit(1);
        if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
        await db.update(savedReports)
          .set({ name: input.name, object: input.spec.object, config: input.spec })
          .where(eq(savedReports.id, input.id));
        return { id: input.id };
      }
      const r = await db.insert(savedReports).values({
        workspaceId: ctx.workspace.id,
        ownerUserId: ctx.user.id,
        name: input.name,
        object: input.spec.object,
        config: input.spec,
      });
      return { id: Number((r as unknown as { insertId?: number })?.insertId ?? 0) };
    }),

  remove: workspaceProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    await db.delete(savedReports).where(and(eq(savedReports.id, input.id), eq(savedReports.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /** The 10 built-in preset reports (code-defined, same for every workspace). */
  presets: workspaceProcedure.query(() => PRESET_REPORTS),

  /** Configure email scheduling on a saved report (system-sender delivery). */
  setSchedule: workspaceProcedure
    .input(z.object({
      id: z.number().int(),
      freq: z.enum(["none", "daily", "weekly", "monthly"]),
      recipients: z.string().max(2000),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      const [r] = await db.select({ id: savedReports.id }).from(savedReports)
        .where(and(eq(savedReports.id, input.id), eq(savedReports.workspaceId, ctx.workspace.id))).limit(1);
      if (!r) throw new TRPCError({ code: "NOT_FOUND" });
      await db.update(savedReports)
        .set({ scheduleFreq: input.freq, scheduleRecipients: input.recipients.trim() || null })
        .where(eq(savedReports.id, input.id));
      return { ok: true };
    }),

  /** Email a saved report right now (uses its configured recipients). */
  sendNow: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const { emailSavedReport } = await import("../services/reportScheduler");
      const res = await emailSavedReport(input.id, ctx.workspace.id);
      if (!res.ok) throw new TRPCError({ code: "BAD_REQUEST", message: res.reason ?? "Send failed" });
      return res;
    }),
});
