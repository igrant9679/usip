/**
 * The AI Assistant's data explorer — generic, read-only, workspace-scoped
 * queries over the core business tables, so "how many…", "which…", and
 * "audit…" questions never dead-end on a missing purpose-built tool.
 *
 * The safety model is structural, mirroring assistantTools' tiers:
 *
 *  - Every query is ANDed with `workspaceCol = workspaceId` before any model-
 *    supplied filter is even looked at. There is no spec shape that removes it.
 *  - The model can only name entities and columns in the REGISTRY below.
 *    Tables holding credentials or tokens (users, workspaceSettings,
 *    sendingAccounts, calendarAccounts, unipileAccounts, smtpConfigs,
 *    workspaceIntegrations, scimProviders) are not in it, and per-table
 *    column whitelists exclude heavy blobs (raw JSON payloads, HTML bodies)
 *    and PII-ish plumbing (ip, userAgent) from tables that carry them.
 *  - It is SELECT-only by construction: the spec vocabulary has no verb.
 *
 * Filters/aggregates compile through drizzle's own builders — no string SQL
 * ever contains a model-supplied value.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, sql, type SQL } from "drizzle-orm";
import type { AnyMySqlColumn, MySqlTable } from "drizzle-orm/mysql-core";
import { z } from "zod";
import { getDb } from "../db";
import {
  accounts, activities, areCampaigns, areExecutionQueue, auditLog, brandObservations,
  calendarEvents, contacts, emailDrafts, emailLog, emailReplies, enrollments, leads,
  meetings, notifications, opportunities, prospectQueue, prospects, recordLists,
  sequences, tasks,
} from "../../drizzle/schema";

/* ─── The registry: what the assistant may query ─────────────────────────── */

type ColumnMap = Record<string, AnyMySqlColumn>;
export interface ExplorerEntity {
  table: MySqlTable;
  workspaceCol: AnyMySqlColumn;
  description: string;
  columns: ColumnMap;
}

const entity = (table: MySqlTable, workspaceCol: AnyMySqlColumn, description: string, columns: ColumnMap): ExplorerEntity =>
  ({ table, workspaceCol, description, columns });

export const EXPLORER_ENTITIES: Record<string, ExplorerEntity> = {
  people: entity(prospects, prospects.workspaceId,
    "People (prospects) — the sitewide person records, INCLUDING archived ones (verificationStatus 'rejected' = archived; filter it out with neq for the working set).",
    {
      id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName,
      title: prospects.title, seniority: prospects.seniority, company: prospects.company,
      companyDomain: prospects.companyDomain, industry: prospects.industry,
      email: prospects.email, emailStatus: prospects.emailStatus, phone: prospects.phone,
      linkedinUrl: prospects.linkedinUrl, city: prospects.city, state: prospects.state,
      country: prospects.country, accountId: prospects.accountId,
      confidenceScore: prospects.confidenceScore, confidenceTier: prospects.confidenceTier,
      verificationStatus: prospects.verificationStatus, lastEnrichedAt: prospects.lastEnrichedAt,
      createdAt: prospects.createdAt, updatedAt: prospects.updatedAt,
    }),
  companies: entity(accounts, accounts.workspaceId,
    "Companies (accounts), INCLUDING archived ones — filter archivedAt is_null for the active companies the UI shows. domain is null when unresolved.",
    {
      id: accounts.id, name: accounts.name, domain: accounts.domain, industry: accounts.industry,
      employeeCount: accounts.employeeCount, revenue: accounts.revenue, region: accounts.region,
      hqCity: accounts.hqCity, hqState: accounts.hqState, hqCountry: accounts.hqCountry,
      accountStage: accounts.accountStage, accountScore: accounts.accountScore,
      accountRating: accounts.accountRating, ownerUserId: accounts.ownerUserId,
      brandConfidence: accounts.brandConfidence, brandVerifiedAt: accounts.brandVerifiedAt,
      lastEnrichedAt: accounts.lastEnrichedAt, archivedAt: accounts.archivedAt,
      createdAt: accounts.createdAt, updatedAt: accounts.updatedAt,
    }),
  contacts: entity(contacts, contacts.workspaceId,
    "CRM contacts (promoted people linked to accounts).",
    {
      id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName,
      title: contacts.title, email: contacts.email, phone: contacts.phone,
      accountId: contacts.accountId, companyName: contacts.companyName,
      companyDomain: contacts.companyDomain, city: contacts.city, seniority: contacts.seniority,
      isPrimary: contacts.isPrimary, ownerUserId: contacts.ownerUserId,
      emailVerificationStatus: contacts.emailVerificationStatus, createdAt: contacts.createdAt,
    }),
  leads: entity(leads, leads.workspaceId,
    "CRM leads with score/grade and conversion links.",
    {
      id: leads.id, firstName: leads.firstName, lastName: leads.lastName, email: leads.email,
      company: leads.company, title: leads.title, source: leads.source, status: leads.status,
      score: leads.score, grade: leads.grade, ownerUserId: leads.ownerUserId, createdAt: leads.createdAt,
    }),
  deals: entity(opportunities, opportunities.workspaceId,
    "Deals/opportunities. value is decimal-as-string; stage is free text per pipeline.",
    {
      id: opportunities.id, name: opportunities.name, stage: opportunities.stage,
      value: opportunities.value, winProb: opportunities.winProb, closeDate: opportunities.closeDate,
      accountId: opportunities.accountId, ownerUserId: opportunities.ownerUserId,
      daysInStage: opportunities.daysInStage, lastActivityAt: opportunities.lastActivityAt,
      createdAt: opportunities.createdAt,
    }),
  tasks: entity(tasks, tasks.workspaceId,
    "Tasks. relatedType/relatedId point at the person/deal a task is about.",
    {
      id: tasks.id, title: tasks.title, type: tasks.type, priority: tasks.priority,
      status: tasks.status, dueAt: tasks.dueAt, completedAt: tasks.completedAt,
      ownerUserId: tasks.ownerUserId, relatedType: tasks.relatedType, relatedId: tasks.relatedId,
      source: tasks.source, createdAt: tasks.createdAt,
    }),
  meetings: entity(meetings, meetings.workspaceId,
    "Meetings/proposals. inviteSent says whether a calendar invite actually went out.",
    {
      id: meetings.id, title: meetings.title, status: meetings.status,
      contactName: meetings.contactName, contactEmail: meetings.contactEmail, company: meetings.company,
      scheduledAt: meetings.scheduledAt, durationMin: meetings.durationMin,
      relatedType: meetings.relatedType, relatedId: meetings.relatedId,
      inviteSent: meetings.inviteSent, source: meetings.source, ownerUserId: meetings.ownerUserId,
      createdAt: meetings.createdAt,
    }),
  activities: entity(activities, activities.workspaceId,
    "Activity timeline entries (calls, notes, meetings held…).",
    {
      id: activities.id, type: activities.type, subject: activities.subject, body: activities.body,
      relatedType: activities.relatedType, relatedId: activities.relatedId,
      occurredAt: activities.occurredAt, actorUserId: activities.actorUserId, createdAt: activities.createdAt,
    }),
  sequences: entity(sequences, sequences.workspaceId,
    "Sequences (manual outreach cadences).",
    {
      id: sequences.id, name: sequences.name, status: sequences.status,
      enrolledCount: sequences.enrolledCount, dailyCap: sequences.dailyCap,
      isTemplate: sequences.isTemplate, ownerUserId: sequences.ownerUserId, createdAt: sequences.createdAt,
    }),
  sequence_enrollments: entity(enrollments, enrollments.workspaceId,
    "Who is enrolled in which sequence, at which step.",
    {
      id: enrollments.id, sequenceId: enrollments.sequenceId, prospectId: enrollments.prospectId,
      contactId: enrollments.contactId, status: enrollments.status, currentStep: enrollments.currentStep,
      startedAt: enrollments.startedAt, nextActionAt: enrollments.nextActionAt,
    }),
  email_drafts: entity(emailDrafts, emailDrafts.workspaceId,
    "Email drafts and their review/send state (open/click counts live here).",
    {
      id: emailDrafts.id, subject: emailDrafts.subject, status: emailDrafts.status,
      toEmail: emailDrafts.toEmail, toProspectId: emailDrafts.toProspectId,
      sequenceId: emailDrafts.sequenceId, aiGenerated: emailDrafts.aiGenerated,
      openCount: emailDrafts.openCount, clickCount: emailDrafts.clickCount,
      sentAt: emailDrafts.sentAt, bouncedAt: emailDrafts.bouncedAt, createdAt: emailDrafts.createdAt,
    }),
  email_log: entity(emailLog, emailLog.workspaceId,
    "Every outbound email the platform sent (source says which system sent it).",
    {
      id: emailLog.id, source: emailLog.source, campaignId: emailLog.campaignId,
      sequenceId: emailLog.sequenceId, fromEmail: emailLog.fromEmail, toEmail: emailLog.toEmail,
      subject: emailLog.subject, status: emailLog.status, failureReason: emailLog.failureReason,
      sentAt: emailLog.sentAt, createdAt: emailLog.createdAt,
    }),
  email_replies: entity(emailReplies, emailReplies.workspaceId,
    "Synced INBOUND mail. Rows with a draftId are replies to something we sent; the rest is all synced mail — scope with draftId not_null for real replies.",
    {
      id: emailReplies.id, draftId: emailReplies.draftId, fromEmail: emailReplies.fromEmail,
      fromName: emailReplies.fromName, subject: emailReplies.subject,
      replyClass: emailReplies.replyClass, sentiment: emailReplies.sentiment,
      receivedAt: emailReplies.receivedAt, handledAt: emailReplies.handledAt, meetingId: emailReplies.meetingId,
    }),
  campaigns: entity(areCampaigns, areCampaigns.workspaceId,
    "Autonomous (ARE) campaigns with their funnel counters.",
    {
      id: areCampaigns.id, name: areCampaigns.name, status: areCampaigns.status,
      autonomyMode: areCampaigns.autonomyMode, goalType: areCampaigns.goalType,
      targetProspectCount: areCampaigns.targetProspectCount, dailySendCap: areCampaigns.dailySendCap,
      prospectsDiscovered: areCampaigns.prospectsDiscovered, prospectsEnrolled: areCampaigns.prospectsEnrolled,
      prospectsContacted: areCampaigns.prospectsContacted, prospectsReplied: areCampaigns.prospectsReplied,
      meetingsBooked: areCampaigns.meetingsBooked, opportunitiesCreated: areCampaigns.opportunitiesCreated,
      startedAt: areCampaigns.startedAt, createdAt: areCampaigns.createdAt,
    }),
  campaign_prospects: entity(prospectQueue, prospectQueue.workspaceId,
    "The per-campaign prospect queue (discovery → enrichment → approval → sequence).",
    {
      id: prospectQueue.id, campaignId: prospectQueue.campaignId, firstName: prospectQueue.firstName,
      lastName: prospectQueue.lastName, email: prospectQueue.email, title: prospectQueue.title,
      companyName: prospectQueue.companyName, companyDomain: prospectQueue.companyDomain,
      icpMatchScore: prospectQueue.icpMatchScore, enrichmentStatus: prospectQueue.enrichmentStatus,
      sequenceStatus: prospectQueue.sequenceStatus, rejectionReason: prospectQueue.rejectionReason,
      personProspectId: prospectQueue.personProspectId, createdAt: prospectQueue.createdAt,
    }),
  campaign_sends: entity(areExecutionQueue, areExecutionQueue.workspaceId,
    "Scheduled/executed campaign steps (the send queue).",
    {
      id: areExecutionQueue.id, campaignId: areExecutionQueue.campaignId,
      prospectQueueId: areExecutionQueue.prospectQueueId, stepIndex: areExecutionQueue.stepIndex,
      channel: areExecutionQueue.channel, status: areExecutionQueue.status,
      scheduledAt: areExecutionQueue.scheduledAt, executedAt: areExecutionQueue.executedAt,
      openCount: areExecutionQueue.openCount, failureReason: areExecutionQueue.failureReason,
    }),
  brand_observations: entity(brandObservations, brandObservations.workspaceId,
    "What brand providers reported per company (the company-identity evidence trail).",
    {
      id: brandObservations.id, accountId: brandObservations.accountId,
      provider: brandObservations.provider, rawName: brandObservations.rawName,
      rawDomain: brandObservations.rawDomain, matchBasis: brandObservations.matchBasis,
      matchConfidence: brandObservations.matchConfidence, claimed: brandObservations.claimed,
      observedAt: brandObservations.observedAt,
    }),
  calendar_events: entity(calendarEvents, calendarEvents.workspaceId,
    "Synced calendar events.",
    {
      id: calendarEvents.id, title: calendarEvents.title, startAt: calendarEvents.startAt,
      endAt: calendarEvents.endAt, allDay: calendarEvents.allDay, location: calendarEvents.location,
      relatedType: calendarEvents.relatedType, relatedId: calendarEvents.relatedId, userId: calendarEvents.userId,
    }),
  audit_log: entity(auditLog, auditLog.workspaceId,
    "Who changed what, when (ip/userAgent and full row payloads are not exposed here).",
    {
      id: auditLog.id, action: auditLog.action, entityType: auditLog.entityType,
      entityId: auditLog.entityId, actorUserId: auditLog.actorUserId, createdAt: auditLog.createdAt,
    }),
  lists: entity(recordLists, recordLists.workspaceId,
    "Saved record lists (people or companies).",
    {
      id: recordLists.id, name: recordLists.name, entityType: recordLists.entityType,
      description: recordLists.description, createdByUserId: recordLists.createdByUserId,
      createdAt: recordLists.createdAt,
    }),
  notifications: entity(notifications, notifications.workspaceId,
    "In-app notifications (readAt null = unread).",
    {
      id: notifications.id, userId: notifications.userId, kind: notifications.kind,
      title: notifications.title, relatedType: notifications.relatedType,
      relatedId: notifications.relatedId, readAt: notifications.readAt, createdAt: notifications.createdAt,
    }),
};

/* ─── Spec ───────────────────────────────────────────────────────────────── */

const FILTER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "starts_with", "is_null", "not_null"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

const filterValue = z.union([
  z.string().max(500), z.number(), z.boolean(),
  z.array(z.union([z.string().max(200), z.number()])).min(1).max(50),
]);

export const EXPLORER_SPEC = z.object({
  entity: z.string().min(1).max(60),
  select: z.array(z.string().min(1).max(60)).min(1).max(15).optional(),
  filters: z.array(z.object({
    column: z.string().min(1).max(60),
    op: z.enum(FILTER_OPS),
    value: filterValue.optional(),
  })).max(10).optional(),
  groupBy: z.array(z.string().min(1).max(60)).min(1).max(3).optional(),
  aggregate: z.array(z.object({
    fn: z.enum(["count", "sum", "avg", "min", "max"]),
    column: z.string().min(1).max(60).optional(),
    as: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/).optional(),
  })).min(1).max(5).optional(),
  sort: z.array(z.object({
    by: z.string().min(1).max(60),
    direction: z.enum(["asc", "desc"]).default("desc"),
  })).max(3).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type ExplorerSpec = z.infer<typeof EXPLORER_SPEC>;

/* ─── Compilation (pure — tested without a database) ─────────────────────── */

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);

function resolveEntity(name: string): ExplorerEntity {
  const def = EXPLORER_ENTITIES[name];
  if (!def) {
    throw new Error(`Unknown entity "${name}". Valid entities: ${Object.keys(EXPLORER_ENTITIES).join(", ")}`);
  }
  return def;
}

function resolveColumn(def: ExplorerEntity, entityName: string, key: string): AnyMySqlColumn {
  const col = def.columns[key];
  if (!col) {
    throw new Error(`Unknown column "${key}" on "${entityName}". Valid columns: ${Object.keys(def.columns).join(", ")}`);
  }
  return col;
}

/** Coerce a filter value to the column's runtime type (dates arrive as ISO strings). */
function coerceValue(col: AnyMySqlColumn, value: unknown): unknown {
  if (col.dataType === "date" && typeof value === "string") {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new Error(`"${value}" is not a valid date`);
    return d;
  }
  if (col.dataType === "number" && typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return value;
}

function buildFilter(def: ExplorerEntity, entityName: string, f: NonNullable<ExplorerSpec["filters"]>[number]): SQL {
  const col = resolveColumn(def, entityName, f.column);
  const needsValue = f.op !== "is_null" && f.op !== "not_null";
  if (needsValue && f.value === undefined) throw new Error(`Filter on "${f.column}" (${f.op}) needs a value`);
  switch (f.op) {
    case "eq": return eq(col, coerceValue(col, f.value) as never);
    case "neq": return ne(col, coerceValue(col, f.value) as never);
    case "gt": return gt(col, coerceValue(col, f.value) as never);
    case "gte": return gte(col, coerceValue(col, f.value) as never);
    case "lt": return lt(col, coerceValue(col, f.value) as never);
    case "lte": return lte(col, coerceValue(col, f.value) as never);
    case "in": {
      if (!Array.isArray(f.value)) throw new Error(`"in" filter on "${f.column}" needs an array value`);
      return inArray(col, f.value.map((v) => coerceValue(col, v)) as never[]);
    }
    case "contains":
    case "starts_with": {
      if (col.dataType !== "string") throw new Error(`"${f.op}" only works on text columns; "${f.column}" is ${col.dataType}`);
      const v = escapeLike(String(f.value));
      return like(col, f.op === "contains" ? `%${v}%` : `${v}%`);
    }
    case "is_null": return isNull(col);
    case "not_null": return isNotNull(col);
  }
}

export interface CompiledExplorerQuery {
  def: ExplorerEntity;
  /** ALWAYS includes the workspace guard — built here, unconditionally. */
  where: SQL;
  fields: Record<string, AnyMySqlColumn | SQL | SQL.Aliased>;
  groupCols: AnyMySqlColumn[];
  orderBy: SQL[];
  limit: number;
  isAggregate: boolean;
}

export function compileExplorerQuery(workspaceId: number, rawSpec: unknown): CompiledExplorerQuery {
  const spec = EXPLORER_SPEC.parse(rawSpec);
  const def = resolveEntity(spec.entity);

  const filterExprs = (spec.filters ?? []).map((f) => buildFilter(def, spec.entity, f));
  // The workspace guard is not a filter the model supplies — it is the frame
  // every model-supplied filter lives inside.
  const where = and(eq(def.workspaceCol, workspaceId), ...filterExprs)!;

  const isAggregate = (spec.aggregate?.length ?? 0) > 0 || (spec.groupBy?.length ?? 0) > 0;
  const fields: CompiledExplorerQuery["fields"] = {};
  const sortable = new Map<string, AnyMySqlColumn | SQL | SQL.Aliased>();
  const groupCols: AnyMySqlColumn[] = [];

  if (isAggregate) {
    for (const key of spec.groupBy ?? []) {
      const col = resolveColumn(def, spec.entity, key);
      fields[key] = col; groupCols.push(col); sortable.set(key, col);
    }
    const aggs = spec.aggregate?.length ? spec.aggregate : [{ fn: "count" as const, column: undefined, as: undefined }];
    for (const a of aggs) {
      const alias = a.as ?? (a.column ? `${a.fn}_${a.column}` : a.fn);
      if (fields[alias]) throw new Error(`Duplicate output name "${alias}"`);
      let expr: SQL;
      if (a.fn === "count") {
        expr = a.column
          ? sql`count(${resolveColumn(def, spec.entity, a.column)})`.mapWith(Number)
          : sql`count(*)`.mapWith(Number);
      } else {
        if (!a.column) throw new Error(`${a.fn} needs a column`);
        const col = resolveColumn(def, spec.entity, a.column);
        if (col.dataType !== "number" && col.dataType !== "date" && col.dataType !== "string") {
          throw new Error(`${a.fn} does not work on "${a.column}" (${col.dataType})`);
        }
        expr = sql`${sql.raw(a.fn)}(${col})`;
        if (a.fn === "sum" || a.fn === "avg") expr = expr.mapWith(Number);
      }
      fields[alias] = expr; sortable.set(alias, expr);
    }
  } else {
    const keys = spec.select ?? Object.keys(def.columns);
    for (const key of keys) {
      fields[key] = resolveColumn(def, spec.entity, key);
      sortable.set(key, fields[key] as AnyMySqlColumn);
    }
    // Sorting by a column you did not select is legitimate.
    for (const key of Object.keys(def.columns)) if (!sortable.has(key)) sortable.set(key, def.columns[key]);
  }

  const orderBy = (spec.sort ?? []).map((s) => {
    const target = sortable.get(s.by);
    if (!target) throw new Error(`Cannot sort by "${s.by}" — it is not a column or output of this query`);
    return s.direction === "asc" ? asc(target as never) : desc(target as never);
  });

  return { def, where, fields, groupCols, orderBy, limit: spec.limit, isAggregate };
}

/* ─── Execution ──────────────────────────────────────────────────────────── */

const truncate = (v: unknown): unknown =>
  typeof v === "string" && v.length > 280 ? `${v.slice(0, 280)}…` : v;

export async function runExplorerQuery(
  workspaceId: number,
  rawSpec: unknown,
): Promise<{ rows: Record<string, unknown>[]; total?: number }> {
  const q = compileExplorerQuery(workspaceId, rawSpec);
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  let query = db.select(q.fields as never).from(q.def.table as never).where(q.where).$dynamic();
  if (q.groupCols.length) query = query.groupBy(...q.groupCols);
  if (q.orderBy.length) query = query.orderBy(...q.orderBy);
  const rows = (await query.limit(q.limit)) as Record<string, unknown>[];

  const out: { rows: Record<string, unknown>[]; total?: number } = {
    rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, truncate(v)]))),
  };
  // For plain row queries, also report how many rows match beyond the limit —
  // "25 rows" must never be mistaken for "25 total".
  if (!q.isAggregate) {
    const [{ n }] = (await db.select({ n: sql`count(*)`.mapWith(Number) }).from(q.def.table as never).where(q.where)) as Array<{ n: number }>;
    out.total = n;
  }
  return out;
}

/* ─── Catalog (for list_data_entities) ───────────────────────────────────── */

export function buildEntityCatalog(): Array<{ entity: string; description: string; columns: string[] }> {
  return Object.entries(EXPLORER_ENTITIES).map(([name, def]) => ({
    entity: name,
    description: def.description,
    columns: Object.entries(def.columns).map(([k, c]) => `${k}:${c.dataType}`),
  }));
}
