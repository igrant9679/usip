import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, isNotNull, lt, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { invokeLLM } from "../_core/llm";
import {
  accounts,
  activities,
  contacts,
  crmNotes,
  crmPipelines,
  crmPipelineStages,
  crmTerritoryRules,
  customers,
  dealLineItems,
  emailDrafts,
  leads,
  opportunities,
  opportunityContactRoles,
  opportunityStageHistory,
  products,
  prospects,
  tasks,
  enrollments,
  sendingAccounts,
  sequences,
  territories,
  unipileAccounts,
  users,
  workspaceMembers,
  workspaceSettings,
  proposals,
  qbrs,
  supportTickets,
  contractAmendments,
  quotes,
  quoteLineItems,
  opportunityIntelligence,
  stageApprovals,
  pipelineAlerts,
  contactAccountLinks,
} from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { getDb } from "../db";
import { createEmailAdapter } from "../emailAdapter";
import { linkEmailLogToDraft } from "../services/email/logSend";
import { router } from "../_core/trpc";
import { repProcedure, workspaceProcedure } from "../_core/workspace";
import { activeOwnerOrNull } from "../_core/activeMembers";
import { assertOwnerInWorkspace, assertRowInWorkspace } from "../services/foreignIds";
import { defaultPipelineId, invalidateStageIndex, resolvedStageFor, stageIndexFor, stageResolver } from "../_core/stageSemantics";
import { isSuppressed, makeUnsubscribeUrl, unsubscribeHeaders } from "../unsubscribe";
import { assertSendAllowed } from "../sendLimits";
import {
  boardDealsWhere, changeOpportunityStage, moveDealsOffStage, moveDealsToPipeline, rekeyStageDeals, restampStageDeals,
  stageDatesForNewDeal,
} from "../services/stageChange";
import { normalizeCalendarDate } from "@shared/calendarDate";
import {
  addMonths, closedIn, closeMonthKey, currentRanges, dollars, inRange, instantMonthKey, loadMetricDeals,
  monthKey, openTotals, zonedYmd, type Range,
} from "../services/dealMetrics";
import { getWorkspaceTimezone } from "../services/workspaceTimezone";
import { appBaseUrl as publicAppOrigin } from "../appUrl";
// One arithmetic rule for line-item money, shared with quotes. See
// shared/quoteTotals.ts — a deal line and a quote line do the same sum.
import { centsToDecimal, computeQuoteTotals, toCents } from "@shared/quoteTotals";
import { escapeHtml as sharedEscapeHtml } from "@shared/escapeHtml";
import { isHtmlBody, htmlBodyToText } from "@shared/emailBody";
import { renderMergeFields, resolveBookingUrl, scrubForSend } from "../mergeVars";
import { businessDomainFromEmail, normalizedAccountFields } from "../services/company/normalize";
import { accountMatchesForLead, findContactByEmail } from "../services/crmMatching";
import { ACTIVE_ENROLLMENT_STATUSES } from "../services/crossEngineEnrollment";
import { assertOutboundNotPaused } from "../services/outboundPause";

/** The ONE public origin — see server/appUrl.ts. */
const getAppBaseUrl = publicAppOrigin;

function unsubscribeFooterHtml(unsubscribeUrl: string): string {
  return `<p style="margin:32px 0 0;color:#9ca3af;font-size:11px;text-align:center;line-height:1.5">
    Don't want these emails? <a href="${unsubscribeUrl}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a>
  </p>`;
}

function unsubscribeFooterText(unsubscribeUrl: string): string {
  return `\n\n—\nUnsubscribe: ${unsubscribeUrl}`;
}

/** Minimal HTML-escaper for wrapping plain-text bodies into a simple HTML mail. */
// One escaper for the whole codebase — @shared/escapeHtml. Five copies existed
// and two of them did not escape `"`; the weakest was the one interpolating
// into HTML attributes. escapeHtmlWithLinks below still layers link handling
// on top of it.
const escapeHtml = sharedEscapeHtml;

/**
 * Escape HTML, then turn URLs into proper <a href> anchors.
 *
 * Two link forms are recognized, in order:
 *   1. Markdown: [readable text](https://url) — preferred for AI output,
 *      lets the recipient see "case study" instead of a long URL
 *   2. Bare http(s) URLs — auto-linked with the URL itself as the label
 *
 * Important for Unipile click tracking: the provider rewrites the href
 * of every <a> tag at send time into a tracked redirect. Plain-text
 * URLs (auto-linked by the email client at display time) bypass that
 * rewrite, so a click never fires the email_tracking webhook.
 */
function escapeHtmlWithLinks(s: string): string {
  // Stash markdown links first so the bare-URL pass doesn't double-process
  // the URL portion inside them. We replace each [label](url) with a
  // sentinel, escape the rest of the string, then restore as anchors.
  const placeholders: Array<{ label: string; url: string }> = [];
  const mdRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const withSentinels = s.replace(mdRe, (_m, label: string, url: string) => {
    const i = placeholders.length;
    placeholders.push({ label, url });
    return `@MD${i}@`;
  });

  let escaped = escapeHtml(withSentinels);

  // Pass 1: auto-anchor bare URLs. Must run BEFORE restoring markdown
  // sentinels so the bare-URL regex doesn't match the URL inside an
  // inserted anchor's href and produce nested <a> tags.
  const urlRe = /(https?:\/\/[^\s<>"']+)/g;
  escaped = escaped.replace(urlRe, (raw) => {
    let url = raw;
    let trailing = "";
    while (/[.,;:)\]!?]$/.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    return `<a href="${url}" style="color:#2563eb;text-decoration:underline">${url}</a>${trailing}`;
  });

  // Pass 2: restore markdown sentinels as proper anchors. Both label
  // and url get HTML-escaped on the way out for safety.
  return escaped.replace(/@MD(\d+)@/g, (_m, idxStr: string) => {
    const p = placeholders[Number(idxStr)];
    if (!p) return _m;
    return `<a href="${escapeHtml(p.url)}" style="color:#2563eb;text-decoration:underline">${escapeHtml(p.label)}</a>`;
  });
}

/**
 * One merge-field renderer — `renderMergeFields` from ../mergeVars.
 *
 * This file and routers/sequences.ts each carried a byte-identical private
 * copy, and both matched keys by a rule that the mergeVars implementation on
 * the draft/bulk send path did not share. Four substitution implementations,
 * three different answers to "does {{first_name}} resolve?".
 */

/* ──────────────────────────────────────────────────────────────────────── */

/** Remove the records owned by the given accounts so deleting an account
 *  doesn't leave orphans pointing at a now-missing account. Covers three
 *  branches and their hard (NOT NULL) dependents, each deleted child-first:
 *   - customers → QBRs, support tickets, contract amendments
 *   - opportunities → contact roles, line items, quotes (+ quote line items),
 *     stage history, intelligence, stage approvals, pipeline alerts
 *   - contacts → opportunity contact roles, enrichment history + jobs
 *  Nullable soft-links (proposals, enrollments, prospects.linkedContactId,
 *  …) are left intact — they render gracefully when their target is gone.
 *  Scoped to the workspace; child deletes are bounded by parent ids that were
 *  themselves workspace-scoped. */
async function cascadeDeleteAccountDependents(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  workspaceId: number,
  accountIds: number[],
): Promise<void> {
  if (accountIds.length === 0) return;

  // ── Customers + customer-success dependents ──────────────────────────────
  const custRows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.workspaceId, workspaceId), inArray(customers.accountId, accountIds)));
  const customerIds = custRows.map((c) => c.id);
  if (customerIds.length > 0) {
    await db.delete(qbrs).where(and(eq(qbrs.workspaceId, workspaceId), inArray(qbrs.customerId, customerIds)));
    await db.delete(supportTickets).where(and(eq(supportTickets.workspaceId, workspaceId), inArray(supportTickets.customerId, customerIds)));
    await db.delete(contractAmendments).where(and(eq(contractAmendments.workspaceId, workspaceId), inArray(contractAmendments.customerId, customerIds)));
    await db.delete(customers).where(and(eq(customers.workspaceId, workspaceId), inArray(customers.id, customerIds)));
  }

  // ── Opportunities + dependents ───────────────────────────────────────────
  const oppRows = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(and(eq(opportunities.workspaceId, workspaceId), inArray(opportunities.accountId, accountIds)));
  const oppIds = oppRows.map((o) => o.id);
  if (oppIds.length > 0) {
    const quoteRows = await db
      .select({ id: quotes.id })
      .from(quotes)
      .where(and(eq(quotes.workspaceId, workspaceId), inArray(quotes.opportunityId, oppIds)));
    const quoteIds = quoteRows.map((q) => q.id);
    if (quoteIds.length > 0) {
      await db.delete(quoteLineItems).where(inArray(quoteLineItems.quoteId, quoteIds));
      await db.delete(quotes).where(and(eq(quotes.workspaceId, workspaceId), inArray(quotes.id, quoteIds)));
    }
    await db.delete(dealLineItems).where(inArray(dealLineItems.opportunityId, oppIds));
    await db.delete(opportunityContactRoles).where(inArray(opportunityContactRoles.opportunityId, oppIds));
    await db.delete(opportunityStageHistory).where(inArray(opportunityStageHistory.opportunityId, oppIds));
    await db.delete(opportunityIntelligence).where(inArray(opportunityIntelligence.opportunityId, oppIds));
    await db.delete(stageApprovals).where(inArray(stageApprovals.opportunityId, oppIds));
    await db.delete(pipelineAlerts).where(inArray(pipelineAlerts.opportunityId, oppIds));
    await db.delete(opportunities).where(and(eq(opportunities.workspaceId, workspaceId), inArray(opportunities.id, oppIds)));
  }

  // ── Contacts + dependents ────────────────────────────────────────────────
  const contactRows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), inArray(contacts.accountId, accountIds)));
  const contactIds = contactRows.map((c) => c.id);
  if (contactIds.length > 0) {
    await db.delete(opportunityContactRoles).where(inArray(opportunityContactRoles.contactId, contactIds));
    // (Clodura execution tables removed 2026-08-11 — nothing to cascade.)
    await db.delete(contacts).where(and(eq(contacts.workspaceId, workspaceId), inArray(contacts.id, contactIds)));
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* What an update may change                                                */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * 🔴 EXPLICIT PATCH SCHEMAS (audit 2026-10-20, C7). Every update below took
 * `patch: z.record(any)` and passed it to `.set()`. The WHERE was scoped to
 * the caller's workspace, so the row edited was always theirs — but the patch
 * itself could say `{ workspaceId: 4 }` and move the record into another
 * tenant, or rewrite `id`, or point `ownerUserId` / `accountId` /
 * `territoryId` at another tenant's rows.
 *
 * Each schema lists the fields a person may edit, typed and sized to the
 * column. `.strict()`: an unknown key is an error that names it, not a field
 * silently dropped while the save reports success. Ids that survive the
 * schema are checked against the workspace (services/foreignIds.ts).
 * Machine-owned columns (scores, normalised keys, enrichment provenance,
 * logo and brand state, conversion links) are not editable here.
 */
const optText = (max: number) => z.string().max(max).nullable().optional();
const optId = z.number().int().positive().nullable().optional();
const optMoney = z.union([z.number().min(0), z.string().regex(/^\d+(\.\d{1,2})?$/)]).nullable().optional();

export const ACCOUNT_PATCH = z.object({
  name: z.string().min(1).max(200).optional(),
  domain: optText(200),
  industry: optText(80),
  subIndustry: optText(80),
  region: optText(80),
  employeeBand: optText(40),
  revenueBand: optText(40),
  employeeCount: z.number().int().min(0).nullable().optional(),
  revenue: optMoney,
  arr: optMoney,
  description: optText(20000),
  notes: optText(20000),
  color: optText(16),
  websiteUrl: optText(2048),
  linkedinCompanyUrl: optText(2048),
  hqCity: optText(80),
  hqState: optText(80),
  hqCountry: optText(80),
  companyPhone: optText(40),
  foundedYear: z.number().int().min(1000).max(3000).nullable().optional(),
  accountStage: optText(64),
  accountRating: optText(16),
  legalName: optText(240),
  parentAccountId: optId,
  territoryId: optId,
  ownerUserId: z.number().int().positive().optional(),
}).strict();

export const CONTACT_PATCH = z.object({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  title: optText(120),
  email: optText(320),
  phone: optText(40),
  linkedinUrl: optText(2048),
  city: optText(80),
  seniority: optText(32),
  isPrimary: z.boolean().optional(),
  accountId: optId,
  ownerUserId: z.number().int().positive().optional(),
}).strict();

export const LEAD_PATCH = z.object({
  firstName: z.string().min(1).max(80).optional(),
  lastName: z.string().min(1).max(80).optional(),
  email: optText(320),
  phone: optText(40),
  company: optText(200),
  title: optText(120),
  source: optText(60),
  status: z.enum(["new", "working", "qualified", "unqualified", "converted"]).optional(),
  tags: z.array(z.string().max(60)).max(50).nullable().optional(),
  ownerUserId: z.number().int().positive().optional(),
}).strict();

export const OPPORTUNITY_PATCH = z.object({
  name: z.string().min(1).max(200).optional(),
  // Accepted only so a client echoing the CURRENT stage is not an error; a
  // change is refused below — stage moves go through setStage.
  stage: z.string().min(1).max(60).optional(),
  value: optMoney,
  winProb: z.number().int().min(0).max(100).optional(),
  closeDate: z.union([z.string(), z.date()]).nullable().optional(),
  nextStep: optText(20000),
  aiNote: optText(20000),
  lostReason: optText(120),
  winReason: optText(120),
  pipelineId: optId,
  accountId: z.number().int().positive().optional(),
  ownerUserId: z.number().int().positive().optional(),
}).strict();

export const TERRITORY_PATCH = z.object({
  name: z.string().min(1).max(120).optional(),
  rules: z.record(z.string(), z.any()).nullable().optional(),
  ownerUserId: optId,
}).strict();

export const PRODUCT_PATCH = z.object({
  sku: z.string().min(1).max(60).optional(),
  name: z.string().min(1).max(200).optional(),
  description: optText(20000),
  category: optText(80),
  listPrice: z.number().min(0).optional(),
  cost: z.number().min(0).optional(),
  billingCycle: z.enum(["one_time", "monthly", "annual"]).optional(),
  active: z.boolean().optional(),
}).strict();

export const TERRITORY_RULE_PATCH = z.object({
  name: z.string().min(1).max(120).optional(),
  priority: z.number().int().optional(),
  industry: optText(80),
  country: optText(80),
  state: optText(80),
  companyContains: optText(120),
  territoryId: optId,
  ownerUserId: optId,
  active: z.boolean().optional(),
}).strict();

export const accountsRouter = router({
  list: workspaceProcedure
    .input(z.object({ search: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const rows = await db
        .select()
        .from(accounts)
        .where(eq(accounts.workspaceId, ctx.workspace.id))
        .orderBy(desc(accounts.updatedAt));
      const q = input?.search?.toLowerCase().trim();
      return q ? rows.filter((r) => r.name.toLowerCase().includes(q) || (r.domain ?? "").toLowerCase().includes(q)) : rows;
    }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db.select().from(accounts).where(and(eq(accounts.id, input.id), eq(accounts.workspaceId, ctx.workspace.id)));
    return row ?? null;
  }),

  /** Build a tree view of all accounts (parent → children + ARR rollup). */
  hierarchy: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { roots: [] as any[] };
    const all = await db.select().from(accounts).where(eq(accounts.workspaceId, ctx.workspace.id));
    const byId = new Map(all.map((a) => [a.id, { ...a, children: [] as any[], rolledArr: Number(a.arr ?? 0) }]));
    const roots: any[] = [];
    for (const a of Array.from(byId.values())) {
      if (a.parentAccountId && byId.has(a.parentAccountId)) byId.get(a.parentAccountId)!.children.push(a);
      else roots.push(a);
    }
    const roll = (n: any): number => {
      let total = Number(n.arr ?? 0);
      for (const c of n.children) total += roll(c);
      n.rolledArr = total;
      return total;
    };
    roots.forEach(roll);
    return { roots };
  }),

  /**
   * NO record_created / record_updated fire on accounts, deliberately (v1,
   * 2026-09-20). runAction's update_field allowlist has no `account` entry and
   * enroll_sequence / send_email_draft both reject anything that is not a
   * person — so an account-triggered rule would fail on three of the eight
   * actions the builder offers, which is worse than not offering the entity.
   * Widening those maps is its own item; until then the entity selector offers
   * lead / contact / opportunity / any.
   */
  create: repProcedure
    .input(
      z.object({
        name: z.string().min(1),
        domain: z.string().optional(),
        industry: z.string().optional(),
        region: z.string().optional(),
        employeeBand: z.string().optional(),
        revenueBand: z.string().optional(),
        parentAccountId: z.number().optional(),
        territoryId: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Linked ids must be this workspace's (audit 2026-10-20, C7).
      await assertRowInWorkspace(db, "account", input.parentAccountId, ctx.workspace.id);
      await assertRowInWorkspace(db, "territory", input.territoryId, ctx.workspace.id);
      // Apply territory rules first; explicit input.territoryId always wins.
      let resolvedTerritoryId = input.territoryId ?? null;
      let resolvedOwnerId: number = ctx.user.id;
      if (!resolvedTerritoryId) {
        const routed = await applyTerritoryRules(db, ctx.workspace.id, {
          industry: input.industry ?? null,
          // `region` is the only geography an account carries (free text like
          // "CA, US"). It was passed as country only, so any territory rule
          // built on "State equals" could never match and silently never
          // fired. Expose it to both fields so either spelling works.
          country: input.region ?? null,
          state: input.region ?? null,
          company: input.name,
        });
        if (routed) {
          resolvedTerritoryId = routed.territoryId ?? resolvedTerritoryId;
          /**
           * A territory rule stores an ownerUserId and nothing revalidated it,
           * so a rule written before a rep left kept filing every matching new
           * account under them. Same shape as `lead_routing_rules.targetUserIds`.
           *
           * No fallback had to be invented: `resolvedOwnerId` already defaults
           * to the rep creating the account, who is by definition present.
           */
          const routedOwner = await activeOwnerOrNull(ctx.workspace.id, routed.ownerUserId);
          if (routedOwner) resolvedOwnerId = routedOwner;
        }
      }
      const r = await db.insert(accounts).values({ ...input, ...normalizedAccountFields(input.name, (input as { domain?: string | null }).domain), workspaceId: ctx.workspace.id, territoryId: resolvedTerritoryId ?? undefined, ownerUserId: resolvedOwnerId });
      const id = Number((r as any)[0]?.insertId ?? 0);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "account", entityId: id, after: { ...input, territoryId: resolvedTerritoryId, ownerUserId: resolvedOwnerId } });
      return { id };
    }),

  update: repProcedure
    .input(z.object({ id: z.number(), patch: ACCOUNT_PATCH }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db.select().from(accounts).where(and(eq(accounts.id, input.id), eq(accounts.workspaceId, ctx.workspace.id)));
      if (!before) throw new TRPCError({ code: "NOT_FOUND" });
      if (input.patch.parentAccountId === input.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "An account cannot be its own parent." });
      }
      await assertRowInWorkspace(db, "account", input.patch.parentAccountId, ctx.workspace.id);
      await assertRowInWorkspace(db, "territory", input.patch.territoryId, ctx.workspace.id);
      await assertOwnerInWorkspace(ctx.workspace.id, input.patch.ownerUserId);
      const patch: Record<string, unknown> = { ...input.patch };
      if (patch.revenue != null) patch.revenue = String(patch.revenue);
      if (patch.arr != null) patch.arr = String(patch.arr);
      // The dedupe keys follow the name and domain they are derived from.
      if (input.patch.name !== undefined || input.patch.domain !== undefined) {
        Object.assign(patch, normalizedAccountFields(input.patch.name ?? before.name, input.patch.domain !== undefined ? input.patch.domain : before.domain));
      }
      if (Object.keys(patch).length === 0) return { ok: true };
      await db.update(accounts).set(patch as never).where(and(eq(accounts.id, input.id), eq(accounts.workspaceId, ctx.workspace.id)));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "account", entityId: input.id, before, after: input.patch });
      return { ok: true };
    }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(accounts).where(and(eq(accounts.id, input.id), eq(accounts.workspaceId, ctx.workspace.id)));
    await cascadeDeleteAccountDependents(db, ctx.workspace.id, [input.id]);
    await db.delete(accounts).where(and(eq(accounts.id, input.id), eq(accounts.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "account", entityId: input.id, before });
    return { ok: true };
  }),

  bulkDelete: repProcedure
    .input(z.object({ ids: z.array(z.number()).min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.workspaceId, ctx.workspace.id), inArray(accounts.id, input.ids)));
      if (rows.length === 0) return { deleted: 0 };
      await cascadeDeleteAccountDependents(db, ctx.workspace.id, rows.map((r) => r.id));
      await db.delete(accounts).where(and(eq(accounts.workspaceId, ctx.workspace.id), inArray(accounts.id, rows.map((r) => r.id))));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "account_bulk", entityId: 0, after: { ids: rows.map((r) => r.id) } });
      return { deleted: rows.length };
    }),

  /** Detail view: account row + all associated contacts. */
  getWithContacts: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [account] = await db.select().from(accounts).where(and(eq(accounts.id, input.id), eq(accounts.workspaceId, ctx.workspace.id)));
      if (!account) return null;
      const accountContacts = await db.select().from(contacts).where(and(eq(contacts.accountId, input.id), eq(contacts.workspaceId, ctx.workspace.id))).orderBy(contacts.firstName);
      return { account, contacts: accountContacts };
    }),
});

/* ──────────────────────────────────────────────────────────────────────── */

export const contactsRouter = router({
  list: workspaceProcedure
    .input(z.object({ accountId: z.number().optional(), search: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      let rows = await db.select().from(contacts).where(eq(contacts.workspaceId, ctx.workspace.id)).orderBy(desc(contacts.updatedAt));
      if (input?.accountId) rows = rows.filter((c) => c.accountId === input.accountId);
      const q = input?.search?.toLowerCase().trim();
      if (q) rows = rows.filter((c) => `${c.firstName} ${c.lastName} ${c.email ?? ""}`.toLowerCase().includes(q));
      return rows;
    }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db.select().from(contacts).where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)));
    return row ?? null;
  }),

  create: repProcedure
    .input(
      z.object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        title: z.string().optional(),
        accountId: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await assertRowInWorkspace(db, "account", input.accountId, ctx.workspace.id);
      const r = await db.insert(contacts).values({ ...input, workspaceId: ctx.workspace.id, ownerUserId: ctx.user.id });
      const id = Number((r as any)[0]?.insertId ?? 0);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "contact", entityId: id, after: input });
      // People-as-master (0160): every new contact gets its canonical People
      // record. Fire-and-forget — the daily backfill heals a miss.
      void import("../services/personLink")
        .then((m) => m.upsertPersonForContact(ctx.workspace.id, {
          id, firstName: input.firstName, lastName: input.lastName,
          email: input.email ?? null, phone: input.phone ?? null, title: input.title ?? null,
          linkedinUrl: null, companyName: null, companyDomain: null,
        }))
        .catch((e) => console.error("[personLink] contact create link failed:", (e as Error).message));
      // record_created was lead-only until 2026-09-20 — the builder offered
      // "when a record is created" and a contact could never trigger it. Placed
      // after the personLink block so the departedOwnerCascade /
      // contactPersonLink source windows stay as they were.
      void import("../services/workflowEngine")
        .then((m) => m.fireRecordCreated(ctx.workspace.id, "contact", id, {
          title: input.title, email: input.email, accountId: input.accountId,
        }, ctx.user.id))
        .catch(() => { /* workflow firing is best-effort */ });
      return { id };
    }),

  update: repProcedure.input(z.object({ id: z.number(), patch: CONTACT_PATCH })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(contacts).where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)));
    if (!before) throw new TRPCError({ code: "NOT_FOUND" });
    await assertRowInWorkspace(db, "account", input.patch.accountId, ctx.workspace.id);
    await assertOwnerInWorkspace(ctx.workspace.id, input.patch.ownerUserId);
    if (Object.keys(input.patch).length === 0) return { ok: true };
    await db.update(contacts).set(input.patch).where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "contact", entityId: input.id, before, after: input.patch });
    void import("../services/workflowEngine")
      .then((m) => m.fireRecordUpdated(ctx.workspace.id, "contact", input.id, before, input.patch, before.ownerUserId ?? null))
      .catch(() => { /* workflow firing is best-effort */ });
    return { ok: true };
  }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(contacts).where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)));
    await db.delete(contacts).where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "contact", entityId: input.id, before });
    return { ok: true };
  }),

  bulkDelete: repProcedure
    .input(z.object({ ids: z.array(z.number()).min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Full rows into the audit `before` — the only copy of a hard-deleted
      // record. Same asymmetry as prospects.bulkDelete: single delete captured
      // the row, bulk captured ids, and bulk is what people use.
      const rows = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.workspaceId, ctx.workspace.id), inArray(contacts.id, input.ids)));
      if (rows.length === 0) return { deleted: 0 };
      const ids = rows.map((r) => r.id);
      await db.delete(contacts).where(and(eq(contacts.workspaceId, ctx.workspace.id), inArray(contacts.id, ids)));
      // People rows point back at their linked contact (prospects.linkedContactId).
      // A deleted contact must not leave that pointer dangling — a People row
      // naming a contact id that no longer exists is a stale link that reads
      // as "has a CRM contact" everywhere it is checked. Nothing cleared it
      // before; on 2026-08-17 every sampled LSI People row pointed at a contact
      // about to be deleted. Cleared here, in the same operation, tenant-scoped.
      await db.update(prospects).set({ linkedContactId: null })
        .where(and(eq(prospects.workspaceId, ctx.workspace.id), inArray(prospects.linkedContactId, ids)));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "contact_bulk", entityId: 0, before: { rows }, after: { ids } });
      return { deleted: rows.length };
    }),

  /** Detail view: contact row + joined account row. */
  getWithAccount: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [contact] = await db.select().from(contacts).where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)));
      if (!contact) return null;
      const account = contact.accountId
        ? (await db.select().from(accounts).where(and(eq(accounts.id, contact.accountId), eq(accounts.workspaceId, ctx.workspace.id))))[0] ?? null
        : null;
      return { contact, account };
    }),

  /** Bulk enroll contacts into a sequence */
  bulkAddToSequence: repProcedure
    .input(
      z.object({
        contactIds: z.array(z.number()).min(1),
        sequenceId: z.number(),
        startStep: z.number().default(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Verify sequence belongs to workspace
      const [seq] = await db
        .select({ id: sequences.id, name: sequences.name })
        .from(sequences)
        .where(and(eq(sequences.id, input.sequenceId), eq(sequences.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!seq) throw new TRPCError({ code: "NOT_FOUND", message: "Sequence not found" });

      // Check enrollment guard setting
      const [settings] = await db
        .select({ blockInvalid: workspaceSettings.blockInvalidEmailsFromSequences })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
        .limit(1);
      const blockInvalid = settings?.blockInvalid ?? false;

      // Fetch contacts
      const rows = await db
        .select({ id: contacts.id, email: contacts.email, emailVerificationStatus: contacts.emailVerificationStatus })
        .from(contacts)
        .where(and(eq(contacts.workspaceId, ctx.workspace.id), inArray(contacts.id, input.contactIds)));

      const results: { contactId: number; status: "enrolled" | "skipped"; reason?: string }[] = [];

      for (const contact of rows) {
        // Guard: block invalid emails
        if (blockInvalid && contact.emailVerificationStatus === "invalid") {
          results.push({ contactId: contact.id, status: "skipped", reason: "Invalid email address" });
          continue;
        }
        // Check if already enrolled. 'paused' counts as enrolled, and the
        // workspaceId term is not decoration: since migration 0181 a paused
        // row can carry a resumeAt, so an active-only gate let an OOO-snoozed
        // person be bulk-enrolled into the SAME sequence and the resume sweep
        // then made both rows live — two sends to one human from one sequence,
        // created automatically.
        const [existing] = await db
          .select({ id: enrollments.id })
          .from(enrollments)
          .where(
            and(
              eq(enrollments.workspaceId, ctx.workspace.id),
              eq(enrollments.sequenceId, input.sequenceId),
              eq(enrollments.contactId, contact.id),
              inArray(enrollments.status, [...ACTIVE_ENROLLMENT_STATUSES]),
            ),
          )
          .limit(1);
        if (existing) {
          results.push({ contactId: contact.id, status: "skipped", reason: "Already enrolled" });
          continue;
        }
        await db.insert(enrollments).values({
          workspaceId: ctx.workspace.id,
          sequenceId: input.sequenceId,
          contactId: contact.id,
          currentStep: input.startStep,
          status: "active",
        });
        results.push({ contactId: contact.id, status: "enrolled" });
      }

      const enrolled = results.filter((r) => r.status === "enrolled").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      return { enrolled, skipped, results, sequenceName: seq.name };
    }),

  /**
   * Send an ad-hoc email to a list of contacts.
   *
   * Resolves the sending account in this order:
   *   1. Explicit `fromAccountId` from input (caller-controlled)
   *   2. The current user's bridged personal Unipile mailbox (joins
   *      sending_accounts → unipile_accounts on userId)
   *   3. Any workspace sending account (shared SMTP outreach pool fallback)
   *
   * Per-contact failures don't fail the batch — they're recorded as
   * skipped with the reason. The emailDraft row is created with
   * status="sent" only after a successful adapter.sendEmail call;
   * delivery failures leave a status="failed" row for audit.
   */
  sendAdHocEmail: repProcedure
    .input(
      z.object({
        contactIds: z.array(z.number()).min(1),
        subject: z.string().min(1),
        body: z.string().min(1),
        aiGenerated: z.boolean().default(false),
        /** Optional override; otherwise the rep's personal mailbox is used. */
        fromAccountId: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Pause all outbound holds person sends too (owner, 2026-10-06: "Block everything").
      await assertOutboundNotPaused(ctx.workspace.id);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // ── 1. Resolve sending account ────────────────────────────────────
      let fromAccount: typeof sendingAccounts.$inferSelect | undefined;

      if (input.fromAccountId) {
        const [explicit] = await db
          .select()
          .from(sendingAccounts)
          .where(
            and(
              eq(sendingAccounts.id, input.fromAccountId),
              eq(sendingAccounts.workspaceId, ctx.workspace.id),
            ),
          )
          .limit(1);
        if (!explicit) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Specified sending account not found in this workspace.",
          });
        }
        fromAccount = explicit;
      }

      if (!fromAccount) {
        // Prefer the current user's bridged personal Microsoft mailbox.
        const [personal] = await db
          .select({ sa: sendingAccounts })
          .from(sendingAccounts)
          .innerJoin(
            unipileAccounts,
            eq(sendingAccounts.unipileAccountId, unipileAccounts.unipileAccountId),
          )
          .where(
            and(
              eq(sendingAccounts.workspaceId, ctx.workspace.id),
              eq(unipileAccounts.userId, ctx.user.id),
              isNotNull(sendingAccounts.unipileAccountId),
            ),
          )
          .limit(1);
        if (personal) fromAccount = personal.sa;
      }

      if (!fromAccount) {
        // Last resort: any workspace SMTP account.
        const [fallback] = await db
          .select()
          .from(sendingAccounts)
          .where(eq(sendingAccounts.workspaceId, ctx.workspace.id))
          .limit(1);
        if (fallback) fromAccount = fallback;
      }

      if (!fromAccount) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "No sending account available. Connect your personal mailbox in Connected Accounts, or have an admin add a workspace SMTP account.",
        });
      }

      const adapter = createEmailAdapter(fromAccount);

      // ── 2. Fetch target contacts (with linked account name for merge fields)
      const rows = await db
        .select({
          id: contacts.id,
          email: contacts.email,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          title: contacts.title,
          accountName: accounts.name,
        })
        .from(contacts)
        .leftJoin(accounts, eq(accounts.id, contacts.accountId))
        .where(
          and(
            eq(contacts.workspaceId, ctx.workspace.id),
            inArray(contacts.id, input.contactIds),
          ),
        );

      // Sender identity for {{senderName}} / {{senderEmail}} + per-user
      // signature override.
      const [senderRow] = await db
        .select({
          name: users.name,
          email: users.email,
          emailSignature: users.emailSignature,
        })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);
      const senderName = senderRow?.name ?? fromAccount.fromName ?? fromAccount.name ?? "";
      const senderEmail = senderRow?.email ?? fromAccount.fromEmail ?? "";

      // Signature resolution: prefer the sender's per-user override
      // (users.emailSignature) over the workspace default
      // (workspace_settings.emailSignature). Empty/null on both = no
      // signature appended.
      const [wsSettings] = await db
        .select({ emailSignature: workspaceSettings.emailSignature })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
        .limit(1);
      const userSignature = senderRow?.emailSignature?.trim() ?? "";
      const workspaceSignature =
        userSignature.length > 0
          ? userSignature
          : (wsSettings?.emailSignature ?? "").trim();
      const bodyMentionsSignatureToken = /\{\{\s*signature\s*\}\}/i.test(input.body);

      // {{senderTitle}} / {{senderCompany}} are offered in the Email Builder
      // token list but were missing from both merge maps, and unmatched
      // tokens render literally — so recipients saw the raw braces.
      const [senderMember] = await db
        .select({ title: workspaceMembers.title })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, ctx.workspace.id),
            eq(workspaceMembers.userId, ctx.user.id),
          ),
        )
        .limit(1);
      const senderTitle = senderMember?.title ?? "";
      const senderCompany = ctx.workspace.name ?? "";

      const results: {
        contactId: number;
        status: "sent" | "skipped" | "failed";
        reason?: string;
        messageId?: string;
      }[] = [];

      // ── 3. Send + record per contact ──────────────────────────────────
      // One sender ⇒ one booking link for the whole batch. In the map so the
      // token set stays in parity with every other send path
      // (mergeVarCoverage.test.ts) — an advertised token missing from ONE
      // map is deleted at that path's send boundary and nowhere else.
      const bookingLink = await resolveBookingUrl(ctx.workspace.id, ctx.user.id);
      for (const contact of rows) {
        if (!contact.email) {
          results.push({
            contactId: contact.id,
            status: "skipped",
            reason: "No email address",
          });
          continue;
        }
        // Suppression check — skip silently with a clear reason in the
        // result array. Recipients on the suppression list (unsubscribed,
        // bounced, or admin-added) never receive outbound mail.
        if (await isSuppressed(ctx.workspace.id, contact.email)) {
          results.push({
            contactId: contact.id,
            status: "skipped",
            reason: "Recipient is on the email suppression list (unsubscribed or bounced)",
          });
          continue;
        }

        // Substitute {{merge_fields}} per recipient. Done in plain text
        // BEFORE the HTML wrap, otherwise escapeHtml would corrupt the
        // token delimiters and the regex would no longer match.
        const mergeVars: Record<string, string> = {
          firstName: contact.firstName ?? "",
          lastName: contact.lastName ?? "",
          fullName: [contact.firstName, contact.lastName].filter(Boolean).join(" "),
          email: contact.email ?? "",
          title: contact.title ?? "",
          company: contact.accountName ?? "",
          accountName: contact.accountName ?? "",
          senderName,
          senderEmail,
          senderTitle,
          senderCompany,
          bookingLink,
          signature: workspaceSignature,
        };
        // scrubForSend: the renderer leaves unknown tokens visible for
        // reviewers; the send boundary must not (see mergeVars).
        const renderedSubject = scrubForSend(renderMergeFields(input.subject, mergeVars), "crm.send.subject");
        // Render body WITHOUT signature substitution first — we want to
        // wrap body paragraphs and signature lines with different spacing,
        // so we need to render them as separate HTML blocks below.
        const mergeVarsNoSig = { ...mergeVars, signature: "" };
        const renderedBody = scrubForSend(renderMergeFields(input.body, mergeVarsNoSig), "crm.send.body");

        // Rich-editor bodies are HTML fragments and pass through as markup;
        // plain text keeps the escape-and-wrap contract. shared/emailBody
        // decides — the same vocabulary every send path uses.
        const bodyIsHtml = isHtmlBody(renderedBody);
        const renderedBodyPlain = bodyIsHtml ? htmlBodyToText(renderedBody) : renderedBody;

        // The plain-text version always includes the signature inline.
        const renderedBodyText =
          bodyMentionsSignatureToken
            ? (() => {
                const withSig = scrubForSend(renderMergeFields(input.body, mergeVars), "crm.send.bodyText");
                return bodyIsHtml ? htmlBodyToText(withSig) : withSig;
              })()
            : workspaceSignature
              ? `${renderedBodyPlain.replace(/\s+$/, "")}\n\n${workspaceSignature}`
              : renderedBodyPlain;

        // Build the HTML body in two distinct blocks so Outlook doesn't
        // apply paragraph-spacing inside the signature:
        //   <p>body line</p><p>body line</p>... (margin: 0 0 8px)
        //   <div>sig line<br>sig line<br>...</div> (line-height 1.4)
        const bodyHtmlBlock = bodyIsHtml
          ? renderedBody
          : renderedBody
              .split("\n")
              .map((line) => `<p style="margin:0 0 8px">${escapeHtmlWithLinks(line)}</p>`)
              .join("");
        const sigHtmlBlock = workspaceSignature
          ? `<div style="margin-top:18px;color:#555;line-height:1.4">${workspaceSignature.split("\n").map(escapeHtml).join("<br>")}</div>`
          : "";
        const unsubscribeUrl = makeUnsubscribeUrl(getAppBaseUrl(), ctx.workspace.id, contact.email);
        const fullBodyHtml = bodyHtmlBlock + sigHtmlBlock + unsubscribeFooterHtml(unsubscribeUrl);
        const fullBodyText = renderedBodyText + unsubscribeFooterText(unsubscribeUrl);

        let sentMessageId: string | undefined;
        let deliveryError: string | undefined;
        try {
          // Workspace + per-account cap gate (assertSendAllowed throws
          // TRPCError, caught below and recorded as a failed result so
          // the bulk send doesn't abort on a single cap-hit).
          await assertSendAllowed(ctx.workspace.id, fromAccount.id);
          const sendRes = await adapter.sendEmail({
            fromEmail: fromAccount.fromEmail,
            fromName: fromAccount.fromName ?? fromAccount.name,
            to: contact.email,
            subject: renderedSubject,
            bodyHtml: fullBodyHtml,
            bodyText: fullBodyText,
            // Sales touch — enable open/click tracking. Webhook events
            // flow back via /api/unipile/email-tracking-webhook and bump
            // openCount / clickCount on the matching emailDrafts row.
            track: true,
            // Sitewide email log (migration 0163). The draft is written below,
            // only on success, so the log row is linked to it afterwards by
            // message id — see linkEmailLogToDraft.
            logMeta: {
              source: input.aiGenerated ? "ai_draft" : "crm",
              contactId: contact.id,
              userId: ctx.user.id,
            },
            // RFC 8058 one-click unsubscribe, same recipient and token as the
            // in-body footer above.
            headers: unsubscribeHeaders(getAppBaseUrl(), ctx.workspace.id, contact.email),
          });
          sentMessageId = sendRes.messageId;
        } catch (err) {
          deliveryError = err instanceof Error ? err.message : String(err);
          console.error(
            `[crm.sendAdHocEmail] delivery failed for contact ${contact.id} (${contact.email}): ${deliveryError}`,
          );
        }

        // Only create the emailDraft + activity rows on successful delivery.
        // Persist the RENDERED subject/body (not the template with raw
        // {{tokens}}), so the contact timeline reflects what was actually
        // sent. emailDrafts.status doesn't have a "failed" enum value yet
        // (future migration); for now, failures surface only in the API
        // response + audit log so the user can retry.
        if (sentMessageId) {
          const inserted = await db.insert(emailDrafts).values({
            workspaceId: ctx.workspace.id,
            toContactId: contact.id,
            subject: renderedSubject,
            body: renderedBodyText,
            status: "sent",
            aiGenerated: input.aiGenerated,
            createdByUserId: ctx.user.id,
            sentAt: new Date(),
            // Persist Unipile's tracking_id so the email-tracking webhook
            // can match opens/clicks back to this row by trackingToken.
            // Cap at 64 chars to match the column width — Unipile ids
            // we've seen are 22 chars but column is varchar(64).
            trackingToken: sentMessageId.slice(0, 64),
          });
          // Join the log row to the draft that owns this send's open/click
          // counters, so the Emails page can show them (migration 0163).
          const draftId = Number((inserted as unknown as { insertId?: number })?.insertId ?? 0);
          if (draftId) await linkEmailLogToDraft(ctx.workspace.id, sentMessageId, draftId);
          await db.insert(activities).values({
            workspaceId: ctx.workspace.id,
            type: "email",
            relatedType: "contact",
            relatedId: contact.id,
            subject: renderedSubject,
            body: renderedBodyText,
            actorUserId: ctx.user.id,
            occurredAt: new Date(),
          });
        }

        await recordAudit({
          workspaceId: ctx.workspace.id,
          actorUserId: ctx.user.id,
          action: "create",
          entityType: "email_draft",
          entityId: 0,
          after: {
            contactId: contact.id,
            subject: input.subject,
            aiGenerated: input.aiGenerated,
            fromAccountId: fromAccount.id,
            deliveryStatus: sentMessageId ? "sent" : "failed",
            messageId: sentMessageId,
            error: deliveryError,
          },
        });

        if (sentMessageId) {
          results.push({
            contactId: contact.id,
            status: "sent",
            messageId: sentMessageId,
          });
        } else {
          results.push({
            contactId: contact.id,
            status: "failed",
            reason: deliveryError ?? "Unknown delivery error",
          });
        }
      }

      const sent = results.filter((r) => r.status === "sent").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      const failed = results.filter((r) => r.status === "failed").length;
      return {
        sent,
        skipped,
        failed,
        results,
        fromAccount: {
          id: fromAccount.id,
          name: fromAccount.name,
          fromEmail: fromAccount.fromEmail,
        },
      };
    }),

  /** AI-powered contact enrichment: suggest missing firmographic fields using LLM. */
  enrich: repProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [contact] = await db.select().from(contacts).where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)));
      if (!contact) throw new TRPCError({ code: "NOT_FOUND" });

      // Get account name if linked
      let accountName = "";
      if (contact.accountId) {
        const [acct] = await db.select({ name: accounts.name }).from(accounts).where(and(eq(accounts.id, contact.accountId), eq(accounts.workspaceId, ctx.workspace.id)));
        accountName = acct?.name ?? "";
      }

      const prompt = `You are a B2B sales data enrichment assistant. Based on the following contact information, suggest likely values for any missing fields. Return ONLY a JSON object with the fields listed in the schema — do not include fields that are already filled in or that you cannot reasonably infer.

Contact:
- Name: ${contact.firstName} ${contact.lastName}
- Email: ${contact.email ?? "unknown"}
- Current title: ${contact.title ?? "unknown"}
- Phone: ${contact.phone ?? "unknown"}
- Company: ${accountName || "unknown"}
- LinkedIn: ${contact.linkedinUrl ?? "unknown"}
- City: ${contact.city ?? "unknown"}
- Seniority: ${contact.seniority ?? "unknown"}

Return a JSON object with ONLY the fields you can reasonably suggest from this information. Possible fields: title, phone, linkedinUrl, city, seniority. For seniority use one of: c_suite, vp, director, manager, individual_contributor. Do not hallucinate — only suggest values you are reasonably confident about based on the name, email domain, and company.`;

      const response = await invokeLLM({
        messages: [
          { role: "system", content: "You are a B2B data enrichment assistant. Return only valid JSON." },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "enrichment",
            strict: true,
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
                phone: { type: "string" },
                linkedinUrl: { type: "string" },
                city: { type: "string" },
                seniority: { type: "string" },
              },
              required: [],
              additionalProperties: false,
            },
          },
        },
      });

      const raw = response?.choices?.[0]?.message?.content ?? "{}";
      let suggestions: Record<string, string> = {};
      try { suggestions = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)); } catch { suggestions = {}; }

      // Only apply non-empty suggestions to fields that are currently empty
      const patch: Record<string, any> = {};
      for (const [field, value] of Object.entries(suggestions)) {
        if (!value || typeof value !== "string") continue;
        const current = (contact as any)[field];
        if (current === null || current === undefined || current === "") {
          patch[field] = value;
        }
      }

      if (Object.keys(patch).length > 0) {
        await db.update(contacts).set(patch).where(and(eq(contacts.id, input.id), eq(contacts.workspaceId, ctx.workspace.id)));
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "contact", entityId: input.id, before: contact, after: patch });
      }

      return { suggestions, applied: patch, fieldsUpdated: Object.keys(patch) };
    }),
});

/* ──────────────────────────────────────────────────────────────────────── */

export const leadsRouter = router({
  list: workspaceProcedure
    .input(z.object({ status: z.string().optional(), search: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      let rows = await db.select().from(leads).where(eq(leads.workspaceId, ctx.workspace.id)).orderBy(desc(leads.score));
      if (input?.status) rows = rows.filter((l) => l.status === input.status);
      const q = input?.search?.toLowerCase().trim();
      if (q) rows = rows.filter((l) => `${l.firstName} ${l.lastName} ${l.company ?? ""} ${l.email ?? ""}`.toLowerCase().includes(q));
      return rows;
    }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db.select().from(leads).where(and(eq(leads.id, input.id), eq(leads.workspaceId, ctx.workspace.id)));
    return row ?? null;
  }),

  create: repProcedure
    .input(
      z.object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        company: z.string().optional(),
        title: z.string().optional(),
        source: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Apply lead-routing rules first; fall back to creator as owner.
      const { routeLeadOwner } = await import("./leadScoring");
      const routedOwner = await routeLeadOwner(ctx.workspace.id, {
        title: input.title ?? null,
        company: input.company ?? null,
        source: input.source ?? null,
        score: 0,
        industry: null,
        country: null,
        state: null,
        city: null,
      });
      const ownerUserId = routedOwner ?? ctx.user.id;
      const r = await db.insert(leads).values({ ...input, workspaceId: ctx.workspace.id, ownerUserId, status: "new" });
      const id = Number((r as any)[0]?.insertId ?? 0);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "lead", entityId: id, after: { ...input, ownerUserId, routed: routedOwner != null } });
      // Fire user-defined `record_created` workflow rules (best-effort, non-blocking).
      // Only the keys RECORD_FIELDS declares for a lead are passed: the helper
      // fills any it is not given with null and drops anything else, so the
      // builder's condition list and this payload cannot drift apart, and a
      // webhook action does not POST the person's phone number to a
      // customer-configured URL. `score`/`grade` are deliberately absent —
      // leadScoring writes them after the insert, so at this moment they are
      // only ever the column default (2026-09-20).
      if (id) {
        void import("../services/workflowEngine")
          .then((m) => m.fireRecordCreated(ctx.workspace.id, "lead", id, {
            company: input.company, title: input.title, source: input.source,
            email: input.email, status: "new",
          }, ownerUserId))
          .catch(() => { /* workflow firing is best-effort */ });
      }
      return { id, ownerUserId, routed: routedOwner != null };
    }),

  update: repProcedure.input(z.object({ id: z.number(), patch: LEAD_PATCH })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(leads).where(and(eq(leads.id, input.id), eq(leads.workspaceId, ctx.workspace.id)));
    if (!before) throw new TRPCError({ code: "NOT_FOUND" });
    await assertOwnerInWorkspace(ctx.workspace.id, input.patch.ownerUserId);
    if (Object.keys(input.patch).length === 0) return { ok: true };
    await db.update(leads).set(input.patch).where(and(eq(leads.id, input.id), eq(leads.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "lead", entityId: input.id, before, after: input.patch });

    // record_updated was offered in the rule builder but had no dispatch site
    // anywhere, so rules using it sat at fireCount 0 forever. The shared helper
    // builds the merged post-update row plus `changed` (the patched field
    // names), so all three entities report the same shape.
    void import("../services/workflowEngine")
      .then((m) => m.fireRecordUpdated(ctx.workspace.id, "lead", input.id, before, input.patch, before.ownerUserId ?? null))
      .catch(() => { /* workflow firing is best-effort */ });

    // Sequences can be configured to auto-enrol on a status change. That
    // trigger existed and was tested but nothing ever fired it.
    const newStatus = (input.patch as Record<string, unknown>).status;
    if (typeof newStatus === "string" && newStatus !== before.status) {
      void import("../sequenceEngine")
        .then((m) => m.autoEnrollByTriggers({
          kind: "status_change",
          workspaceId: ctx.workspace.id,
          leadId: input.id,
          newStatus,
        }))
        .catch((e) => console.error(`[CRM] lead ${input.id} auto-enroll failed:`, e));
    }
    return { ok: true };
  }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(leads).where(and(eq(leads.id, input.id), eq(leads.workspaceId, ctx.workspace.id)));
    await db.delete(leads).where(and(eq(leads.id, input.id), eq(leads.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "lead", entityId: input.id, before });
    return { ok: true };
  }),

  bulkDelete: repProcedure
    .input(z.object({ ids: z.array(z.number()).min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select({ id: leads.id })
        .from(leads)
        .where(and(eq(leads.workspaceId, ctx.workspace.id), inArray(leads.id, input.ids)));
      if (rows.length === 0) return { deleted: 0 };
      await db.delete(leads).where(and(eq(leads.workspaceId, ctx.workspace.id), inArray(leads.id, rows.map((r) => r.id))));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "lead_bulk", entityId: 0, after: { ids: rows.map((r) => r.id) } });
      return { deleted: rows.length };
    }),

  /**
   * What converting this lead would match (audit 2026-10-20, R8): accounts it
   * may already be — its work-email domain, then its company name — and a
   * contact that already has its address. The convert dialog shows these
   * before anything is created.
   */
  convertPreview: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [lead] = await db.select().from(leads).where(and(eq(leads.id, input.id), eq(leads.workspaceId, ctx.workspace.id)));
    if (!lead) throw new TRPCError({ code: "NOT_FOUND" });
    const accountMatches = await accountMatchesForLead(db, ctx.workspace.id, lead);
    const contactId = lead.email ? await findContactByEmail(db, ctx.workspace.id, lead.email) : null;
    const [contactMatch] = contactId
      ? await db.select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, accountId: contacts.accountId })
        .from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, ctx.workspace.id))).limit(1)
      : [];
    return {
      alreadyConverted: lead.status === "converted",
      accountMatches,
      contactMatch: contactMatch ?? null,
      newAccountName: lead.company ?? `${lead.firstName} ${lead.lastName}`,
    };
  }),

  /**
   * Convert a lead → account + contact (+ an opportunity, only if asked).
   *
   * Audit 2026-10-20, R8: a double click converted twice; every conversion
   * made a NEW account and contact, so a second person from Acme made a
   * second Acme; and it always invented a $25,000, 25% deal in a stage key
   * ("discovery") the pipeline might not have. Now the lead is claimed first
   * (a second convert is refused), the account and contact are the ones the
   * user picked — or the match, when they said nothing — and a deal is made
   * only on request, with the value given, in the default pipeline's first
   * open stage. The writes run in one transaction: a failure leaves the lead
   * unconverted and nothing half-made.
   *
   * accountId / contactId: a number uses that record; null forces a new one;
   * omitted takes the match if there is one.
   */
  convert: repProcedure
    .input(z.object({
      id: z.number(),
      accountId: z.number().int().positive().nullable().optional(),
      contactId: z.number().int().positive().nullable().optional(),
      createOpportunity: z.boolean().default(false),
      opportunityValue: z.number().min(0).optional(),
      opportunityName: z.string().trim().min(1).max(200).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const ws = ctx.workspace.id;
      const [lead] = await db.select().from(leads).where(and(eq(leads.id, input.id), eq(leads.workspaceId, ws)));
      if (!lead) throw new TRPCError({ code: "NOT_FOUND" });
      if (lead.status === "converted") throw new TRPCError({ code: "CONFLICT", message: "This lead was already converted." });
      await assertRowInWorkspace(db, "account", input.accountId, ws);
      await assertRowInWorkspace(db, "contact", input.contactId, ws);

      const convName = lead.company ?? `${lead.firstName} ${lead.lastName}`;
      const domain = businessDomainFromEmail(lead.email) || null;
      // The deal's stage: the default pipeline's first OPEN stage, by flags.
      let deal: { pipelineId: number | null; key: string; winProb: number; meta: { isWon: boolean; isLost: boolean } } | null = null;
      if (input.createOpportunity) {
        const stages = await stageResolver(db, ws);
        const pipelineId = await defaultPipelineId(db, ws);
        const key = stages.allowedKeys(pipelineId).find((k) => { const m = stages.resolve(pipelineId, k); return !m.isWon && !m.isLost; });
        if (!key) throw new TRPCError({ code: "BAD_REQUEST", message: "The default pipeline has no open stage to put the deal in." });
        const meta = stages.resolve(pipelineId, key);
        deal = { pipelineId, key, winProb: meta.defaultWinProb ?? 20, meta };
      }

      const done = await db.transaction(async (tx) => {
        // Claim the lead before creating anything: of two converts, one lands.
        const claim = await tx.update(leads).set({ status: "converted" })
          .where(and(eq(leads.id, lead.id), eq(leads.workspaceId, ws), ne(leads.status, "converted")));
        if (Number((claim as any)?.[0]?.affectedRows ?? 0) !== 1) {
          throw new TRPCError({ code: "CONFLICT", message: "This lead was already converted." });
        }

        let accountId = input.accountId ?? null;
        if (accountId == null && input.accountId === undefined) accountId = (await accountMatchesForLead(tx, ws, lead))[0]?.id ?? null;
        const accountCreated = accountId == null;
        if (accountCreated) {
          const accR = await tx.insert(accounts).values({
            workspaceId: ws, name: convName, domain: domain ?? undefined, ...normalizedAccountFields(convName, domain), ownerUserId: ctx.user.id,
          });
          accountId = Number((accR as any)[0]?.insertId ?? 0);
        }

        let contactId = input.contactId ?? null;
        if (contactId == null && input.contactId === undefined && lead.email) contactId = await findContactByEmail(tx, ws, lead.email);
        const contactCreated = contactId == null;
        if (contactCreated) {
          const conR = await tx.insert(contacts).values({
            workspaceId: ws, accountId: accountId!, firstName: lead.firstName, lastName: lead.lastName, email: lead.email, phone: lead.phone, title: lead.title, isPrimary: true, ownerUserId: ctx.user.id,
          });
          contactId = Number((conR as any)[0]?.insertId ?? 0);
        }

        let opportunityId: number | null = null;
        if (deal) {
          const oR = await tx.insert(opportunities).values({
            workspaceId: ws, accountId: accountId!, pipelineId: deal.pipelineId,
            name: input.opportunityName ?? `${convName} – New opportunity`,
            stage: deal.key, value: String(input.opportunityValue ?? 0), winProb: deal.winProb, ownerUserId: ctx.user.id,
            ...stageDatesForNewDeal(deal.meta),
          } as never);
          opportunityId = Number((oR as any)[0]?.insertId ?? 0);
        }

        await tx.update(leads).set({
          convertedAccountId: accountId,
          convertedContactId: contactId,
          convertedOpportunityId: opportunityId,
        }).where(and(eq(leads.id, lead.id), eq(leads.workspaceId, ws)));
        return { accountId: accountId!, contactId: contactId!, opportunityId, accountCreated, contactCreated };
      });
      const { accountId, contactId, opportunityId } = done;

      if (done.contactCreated) {
        // People-as-master (0160): the converted lead's contact links to a
        // canonical People record too. Fire-and-forget; backfill heals misses.
        void import("../services/personLink")
          .then((m) => m.upsertPersonForContact(ws, {
            id: contactId, firstName: lead.firstName, lastName: lead.lastName,
            email: lead.email ?? null, phone: lead.phone ?? null, title: lead.title ?? null,
            linkedinUrl: null, companyName: lead.company ?? null, companyDomain: domain,
          }))
          .catch((e) => console.error("[personLink] lead-convert link failed:", (e as Error).message));
      }

      // Follow the conversion through to People (audit 2026-09-20): prospect
      // rows that pointed at this LEAD keep working after it converts — the
      // meeting autopilot's owner lookup, the company profile and enrichment
      // all prefer linkedContactId, and without this writeback they saw a
      // converted lead as still lead-only. Best-effort, never blocks convert.
      try {
        await db.update(prospects)
          .set({ linkedContactId: contactId, accountId } as never)
          .where(and(
            eq(prospects.workspaceId, ws),
            eq(prospects.linkedLeadId, lead.id),
            isNull(prospects.linkedContactId),
          ));
        if (done.contactCreated) {
          await db.insert(contactAccountLinks).values({
            workspaceId: ws,
            personType: "contact",
            personId: contactId,
            accountId,
            relationshipType: "current_employer",
            titleAtCompany: lead.title ?? null,
            sourceType: "lead_convert",
          } as never);
        }
      } catch (e) {
        console.error("[crm.convert] prospect/account-link writeback failed:", (e as Error).message);
      }

      await recordAudit({ workspaceId: ws, actorUserId: ctx.user.id, action: "update", entityType: "lead", entityId: lead.id, after: { converted: true, accountId, contactId, opportunityId, accountCreated: done.accountCreated, contactCreated: done.contactCreated } });
      /**
       * Conversion is up to three record events at once. Fired after the
       * audit, and only for records this conversion CREATED — a reused
       * contact was created long ago.
       *
       * No record_created for the ACCOUNT — accounts are out of scope for v1
       * (runAction's update_field/enroll_sequence/send_email_draft all reject
       * an account, so such a rule would fail on three of the eight actions).
       */
      void import("../services/workflowEngine")
        .then(async (m) => {
          // `source: "lead_convert"` is the key a rule uses to EXCLUDE the
          // events one conversion click emits — it is in the contact and
          // lead field vocabularies for that reason.
          if (done.contactCreated) {
            await m.fireRecordCreated(ws, "contact", contactId, {
              email: lead.email, title: lead.title, accountId, source: "lead_convert",
            }, ctx.user.id);
          }
          if (opportunityId && deal) {
            await m.fireRecordCreated(ws, "opportunity", opportunityId, {
              name: input.opportunityName ?? `${convName} – New opportunity`,
              stage: deal.key, value: Number(input.opportunityValue ?? 0), winProb: deal.winProb, accountId,
            }, ctx.user.id);
          }
          // The "when a lead converts" rule people actually want.
          await m.fireRecordUpdated(ws, "lead", lead.id, lead, {
            status: "converted", convertedAccountId: accountId,
            convertedContactId: contactId, convertedOpportunityId: opportunityId,
          }, lead.ownerUserId ?? null);
        })
        .catch(() => { /* workflow firing is best-effort */ });
      return { accountId, contactId, opportunityId, accountCreated: done.accountCreated, contactCreated: done.contactCreated };
    }),

  /** AI lead scoring re-run for one lead. Server-side LLM. */
  rescore: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [lead] = await db.select().from(leads).where(and(eq(leads.id, input.id), eq(leads.workspaceId, ctx.workspace.id)));
    if (!lead) throw new TRPCError({ code: "NOT_FOUND" });

    const { invokeLLM } = await import("../_core/llm");
    let score = 50;
    let grade = "C";
    let reasons: string[] = ["Default heuristic score"];
    try {
      const out = await invokeLLM({
        messages: [
          { role: "system", content: "You score B2B sales leads. Output JSON only." },
          {
            role: "user",
            content: `Score this lead 0-100. Title weighting: C-level/VP=high, manager=medium, individual=low. Engagement is unknown. Return JSON {score:int, grade:"A"|"B"|"C"|"D", reasons:[string]}.\n\nName: ${lead.firstName} ${lead.lastName}\nTitle: ${lead.title}\nCompany: ${lead.company}\nSource: ${lead.source}`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "lead_score",
            strict: true,
            schema: {
              type: "object",
              properties: {
                score: { type: "integer" },
                grade: { type: "string", enum: ["A", "B", "C", "D"] },
                reasons: { type: "array", items: { type: "string" } },
              },
              required: ["score", "grade", "reasons"],
              additionalProperties: false,
            },
          },
        },
      });
      const content = out.choices?.[0]?.message?.content;
      const parsed = typeof content === "string" ? JSON.parse(content) : content;
      score = Math.max(0, Math.min(100, Number(parsed.score)));
      grade = String(parsed.grade);
      reasons = Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 6) : reasons;
    } catch (e) {
      console.warn("[lead.rescore] LLM failed; using heuristic", e);
      const titleLow = (lead.title ?? "").toLowerCase();
      let s = 40;
      if (/chief|cxo|cmo|cro|cfo|ceo/.test(titleLow)) s += 35;
      else if (/vp|vice president|head/.test(titleLow)) s += 25;
      else if (/director/.test(titleLow)) s += 15;
      else if (/manager/.test(titleLow)) s += 8;
      score = Math.min(100, s + Math.floor(Math.random() * 15));
      grade = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D";
      reasons = [`Title-based ${score}`, "Engagement unknown — assumed neutral"];
    }
    await db.update(leads).set({ score, grade, scoreReasons: reasons }).where(eq(leads.id, lead.id));
    return { score, grade, reasons };
  }),

  /** Send an ad-hoc email to a lead and log it in the timeline */
  /**
   * Send an ad-hoc email to a single lead. Same delivery path as
   * contacts.sendAdHocEmail — adapter resolution, merge-field rendering,
   * signature append, tracking opt-in — just sourced from the lead row.
   */
  sendAdHocEmail: repProcedure
    .input(
      z.object({
        leadId: z.number(),
        subject: z.string().min(1),
        body: z.string().min(1),
        aiGenerated: z.boolean().default(false),
        fromAccountId: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Pause all outbound holds person sends too (owner, 2026-10-06: "Block everything").
      await assertOutboundNotPaused(ctx.workspace.id);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [lead] = await db
        .select()
        .from(leads)
        .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, ctx.workspace.id)));
      if (!lead) throw new TRPCError({ code: "NOT_FOUND" });
      if (!lead.email)
        throw new TRPCError({ code: "BAD_REQUEST", message: "Lead has no email address" });

      // Suppression check — refuse to send if lead.email is on the
      // workspace's suppression list. Surface a clear error rather than
      // silently dropping (the lead path sends to a single recipient).
      if (await isSuppressed(ctx.workspace.id, lead.email)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${lead.email} has unsubscribed or is on the suppression list.`,
        });
      }

      // ── Resolve sending account (same precedence as contacts path) ────
      let fromAccount: typeof sendingAccounts.$inferSelect | undefined;
      if (input.fromAccountId) {
        const [explicit] = await db
          .select()
          .from(sendingAccounts)
          .where(
            and(
              eq(sendingAccounts.id, input.fromAccountId),
              eq(sendingAccounts.workspaceId, ctx.workspace.id),
            ),
          )
          .limit(1);
        if (!explicit) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Specified sending account not found in this workspace.",
          });
        }
        fromAccount = explicit;
      }
      if (!fromAccount) {
        const [personal] = await db
          .select({ sa: sendingAccounts })
          .from(sendingAccounts)
          .innerJoin(
            unipileAccounts,
            eq(sendingAccounts.unipileAccountId, unipileAccounts.unipileAccountId),
          )
          .where(
            and(
              eq(sendingAccounts.workspaceId, ctx.workspace.id),
              eq(unipileAccounts.userId, ctx.user.id),
              isNotNull(sendingAccounts.unipileAccountId),
            ),
          )
          .limit(1);
        if (personal) fromAccount = personal.sa;
      }
      if (!fromAccount) {
        const [fallback] = await db
          .select()
          .from(sendingAccounts)
          .where(eq(sendingAccounts.workspaceId, ctx.workspace.id))
          .limit(1);
        if (fallback) fromAccount = fallback;
      }
      if (!fromAccount) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "No sending account available. Connect your personal mailbox in Connected Accounts, or have an admin add a workspace SMTP account.",
        });
      }
      const adapter = createEmailAdapter(fromAccount);

      // Sender + signature precedence (user override → workspace default).
      const [senderRow] = await db
        .select({ name: users.name, email: users.email, emailSignature: users.emailSignature })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);
      const senderName = senderRow?.name ?? fromAccount.fromName ?? fromAccount.name ?? "";
      const senderEmail = senderRow?.email ?? fromAccount.fromEmail ?? "";
      const [wsSettings] = await db
        .select({ emailSignature: workspaceSettings.emailSignature })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
        .limit(1);
      const userSignature = senderRow?.emailSignature?.trim() ?? "";
      const workspaceSignature =
        userSignature.length > 0 ? userSignature : (wsSettings?.emailSignature ?? "").trim();
      const bodyMentionsSignatureToken = /\{\{\s*signature\s*\}\}/i.test(input.body);

      // {{senderTitle}} / {{senderCompany}} — same omission that was fixed for
      // the CONTACT send path a few hundred lines above and in sequences.ts, and
      // missed here. renderMergeFields returns `hit ?? match`, so an absent key
      // is emitted VERBATIM: a prospect received the literal "{{senderCompany}}".
      // Two of the Email Builder's starter templates bake that token into their
      // footer, so it did not need anyone to type it.
      const [adHocSenderMember] = await db
        .select({ title: workspaceMembers.title })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, ctx.workspace.id),
            eq(workspaceMembers.userId, ctx.user.id),
          ),
        )
        .limit(1);

      // Merge fields (leads carry their own company string — no join).
      const mergeVars: Record<string, string> = {
        firstName: lead.firstName ?? "",
        lastName: lead.lastName ?? "",
        fullName: [lead.firstName, lead.lastName].filter(Boolean).join(" "),
        email: lead.email ?? "",
        title: lead.title ?? "",
        company: lead.company ?? "",
        accountName: lead.company ?? "",
        senderName,
        senderEmail,
        senderTitle: adHocSenderMember?.title ?? "",
        senderCompany: ctx.workspace.name ?? "",
        bookingLink: await resolveBookingUrl(ctx.workspace.id, ctx.user.id),
        signature: workspaceSignature,
      };
      const renderedSubject = renderMergeFields(input.subject, mergeVars);
      const mergeVarsNoSig = { ...mergeVars, signature: "" };
      const renderedBody = renderMergeFields(input.body, mergeVarsNoSig);
      // Same format contract as the contacts path — see shared/emailBody.
      const bodyIsHtml = isHtmlBody(renderedBody);
      const renderedBodyPlain = bodyIsHtml ? htmlBodyToText(renderedBody) : renderedBody;
      const renderedBodyText = bodyMentionsSignatureToken
        ? (() => {
            const withSig = renderMergeFields(input.body, mergeVars);
            return bodyIsHtml ? htmlBodyToText(withSig) : withSig;
          })()
        : workspaceSignature
          ? `${renderedBodyPlain.replace(/\s+$/, "")}\n\n${workspaceSignature}`
          : renderedBodyPlain;
      const bodyHtmlBlock = bodyIsHtml
        ? renderedBody
        : renderedBody
            .split("\n")
            .map((line) => `<p style="margin:0 0 8px">${escapeHtmlWithLinks(line)}</p>`)
            .join("");
      const sigHtmlBlock = workspaceSignature
        ? `<div style="margin-top:18px;color:#555;line-height:1.4">${workspaceSignature.split("\n").map(escapeHtml).join("<br>")}</div>`
        : "";
      const unsubscribeUrl = makeUnsubscribeUrl(getAppBaseUrl(), ctx.workspace.id, lead.email);
      const fullBodyHtml = bodyHtmlBlock + sigHtmlBlock + unsubscribeFooterHtml(unsubscribeUrl);
      const fullBodyText = renderedBodyText + unsubscribeFooterText(unsubscribeUrl);

      let sentMessageId: string | undefined;
      let deliveryError: string | undefined;
      try {
        await assertSendAllowed(ctx.workspace.id, fromAccount.id);
        const sendRes = await adapter.sendEmail({
          fromEmail: fromAccount.fromEmail,
          fromName: fromAccount.fromName ?? fromAccount.name,
          to: lead.email,
          subject: renderedSubject,
          bodyHtml: fullBodyHtml,
          bodyText: fullBodyText,
          track: true,
          // Sitewide email log (migration 0163). The draft is written below,
          // only on success, so the log row is linked to it afterwards by
          // message id — see linkEmailLogToDraft.
          logMeta: {
            source: input.aiGenerated ? "ai_draft" : "crm",
            leadId: lead.id,
            userId: ctx.user.id,
          },
          headers: unsubscribeHeaders(getAppBaseUrl(), ctx.workspace.id, lead.email),
        });
        sentMessageId = sendRes.messageId;
      } catch (err) {
        deliveryError = err instanceof Error ? err.message : String(err);
        console.error(
          `[leads.sendAdHocEmail] delivery failed for lead ${lead.id} (${lead.email}): ${deliveryError}`,
        );
      }

      if (sentMessageId) {
        const inserted = await db.insert(emailDrafts).values({
          workspaceId: ctx.workspace.id,
          toLeadId: lead.id,
          toEmail: lead.email,
          subject: renderedSubject,
          body: renderedBodyText,
          status: "sent",
          aiGenerated: input.aiGenerated,
          createdByUserId: ctx.user.id,
          sentAt: new Date(),
          trackingToken: sentMessageId.slice(0, 64),
        });
        // Join the log row to the draft that owns this send's open/click
        // counters, so the Emails page can show them (migration 0163).
        const draftId = Number((inserted as unknown as { insertId?: number })?.insertId ?? 0);
        if (draftId) await linkEmailLogToDraft(ctx.workspace.id, sentMessageId, draftId);
        await db.insert(activities).values({
          workspaceId: ctx.workspace.id,
          type: "email",
          relatedType: "lead",
          relatedId: lead.id,
          subject: renderedSubject,
          body: renderedBodyText,
          actorUserId: ctx.user.id,
          occurredAt: new Date(),
        });
      }

      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "email_draft",
        entityId: 0,
        after: {
          leadId: lead.id,
          subject: renderedSubject,
          aiGenerated: input.aiGenerated,
          fromAccountId: fromAccount.id,
          deliveryStatus: sentMessageId ? "sent" : "failed",
          messageId: sentMessageId,
          error: deliveryError,
        },
      });

      if (sentMessageId) {
        return {
          ok: true,
          status: "sent" as const,
          messageId: sentMessageId,
          fromAccount: { id: fromAccount.id, name: fromAccount.name, fromEmail: fromAccount.fromEmail },
        };
      }
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: deliveryError ?? "Unknown delivery error",
      });
    }),
});

/* ──────────────────────────────────────────────────────────────────────── */

export const opportunitiesRouter = router({
  list: workspaceProcedure
    .input(z.object({ stage: z.string().optional(), ownerOnly: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      let rows = await db.select().from(opportunities).where(eq(opportunities.workspaceId, ctx.workspace.id)).orderBy(desc(opportunities.updatedAt));
      if (input?.stage) rows = rows.filter((o) => o.stage === input.stage);
      if (input?.ownerOnly) rows = rows.filter((o) => o.ownerUserId === ctx.user.id);
      return rows;
    }),

  /** Kanban board grouped by stage. */
  board: workspaceProcedure.input(z.object({ ownerUserId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const where = input?.ownerUserId
      ? and(eq(opportunities.workspaceId, ctx.workspace.id), eq(opportunities.ownerUserId, input.ownerUserId))
      : eq(opportunities.workspaceId, ctx.workspace.id);
    const rows = await db.select().from(opportunities).where(where);
    const acctRows = await db.select().from(accounts).where(eq(accounts.workspaceId, ctx.workspace.id));
    const accMap = new Map(acctRows.map((a) => [a.id, a.name]));
    return rows.map((r) => ({ ...r, accountName: accMap.get(r.accountId) ?? "?" }));
  }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db.select().from(opportunities).where(and(eq(opportunities.id, input.id), eq(opportunities.workspaceId, ctx.workspace.id)));
    return row ?? null;
  }),

  create: repProcedure
    .input(
      z.object({
        name: z.string().min(1),
        accountId: z.number(),
        value: z.number().min(0).default(0),
        stage: z.string().min(1).max(60).default("discovery"),
        pipelineId: z.number().optional(),
        winProb: z.number().min(0).max(100).default(20),
        closeDate: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // A deal on another tenant's account surfaced that account through the
      // won-deal → customer path into cs.get (audit 2026-10-20, C8).
      await assertRowInWorkspace(db, "account", input.accountId, ctx.workspace.id);
      await assertRowInWorkspace(db, "pipeline", input.pipelineId, ctx.workspace.id);
      // The same rule a move obeys (R20): a stage the deal's pipeline has no
      // column for strands it off every board.
      const stages = await stageResolver(db, ctx.workspace.id);
      if (!stages.allowedKeys(input.pipelineId ?? null).includes(input.stage)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `"${input.stage}" is not a stage in this pipeline. Pick one of its own stages.` });
      }
      const meta = stages.resolve(input.pipelineId ?? null, input.stage);
      const r = await db.insert(opportunities).values({
        workspaceId: ctx.workspace.id, accountId: input.accountId, name: input.name,
        value: String(input.value), stage: input.stage, winProb: input.winProb,
        pipelineId: input.pipelineId ?? null,
        // A calendar date, kept on the day picked (R16/R29).
        closeDate: normalizeCalendarDate(input.closeDate), ownerUserId: ctx.user.id,
        ...stageDatesForNewDeal(meta),
      } as never);
      const id = Number((r as any)[0]?.insertId ?? 0);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "opportunity", entityId: id, after: input });
      void import("../services/workflowEngine")
        .then((m) => m.fireRecordCreated(ctx.workspace.id, "opportunity", id, {
          name: input.name, stage: input.stage, value: input.value, winProb: input.winProb, accountId: input.accountId,
        }, ctx.user.id))
        .catch(() => { /* workflow firing is best-effort */ });
      return { id };
    }),

  /**
   * Move card on Kanban. Every stage move goes through services/stageChange
   * (audit 2026-10-20, R21): history, owner notice, closed-won → Customer,
   * closed-lost → win-back, audit, workflow rules, and the won/lost dates
   * quota counts from. A drop back on the same column changes nothing (R13);
   * a stage from another pipeline is refused (R20).
   */
  setStage: repProcedure.input(z.object({ id: z.number(), stage: z.string().min(1).max(60) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const r = await changeOpportunityStage(db, {
      workspaceId: ctx.workspace.id,
      opportunityId: input.id,
      toStage: input.stage,
      actorUserId: ctx.user.id,
      actorName: ctx.user.name ?? null,
      source: "board",
    });
    return { ok: true, changed: r.changed, customerCreated: r.customerCreated };
  }),

  update: repProcedure.input(z.object({ id: z.number(), patch: OPPORTUNITY_PATCH })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(opportunities).where(and(eq(opportunities.id, input.id), eq(opportunities.workspaceId, ctx.workspace.id)));
    if (!before) throw new TRPCError({ code: "NOT_FOUND" });
    await assertRowInWorkspace(db, "account", input.patch.accountId, ctx.workspace.id);
    await assertRowInWorkspace(db, "pipeline", input.patch.pipelineId, ctx.workspace.id);
    await assertOwnerInWorkspace(ctx.workspace.id, input.patch.ownerUserId);
    const patch: any = { ...input.patch };
    // A stage written through this generic patch bypasses everything a stage
    // change means here: stage history, daysInStage, the closed-won customer
    // record, the closed-lost win-back task, ARE attribution (all in
    // setStage). No UI sends it this way; refuse loudly rather than let an
    // API caller silently skip the pipeline machinery (audit 2026-09-20).
    if (patch.stage !== undefined && patch.stage !== before.stage) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Use opportunities.setStage to change stage — the generic update would skip stage history and closed-won/lost handling." });
    }
    delete patch.stage;
    if (patch.value != null) patch.value = String(patch.value);
    // A calendar date: "2026-11-14" was parsed as UTC midnight, the evening of
    // the 13th west of Greenwich (R16/R29). Null clears it.
    if (patch.closeDate !== undefined) patch.closeDate = normalizeCalendarDate(patch.closeDate);
    if (Object.keys(patch).length === 0) return { ok: true };
    await db.update(opportunities).set(patch).where(and(eq(opportunities.id, input.id), eq(opportunities.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "opportunity", entityId: input.id, before, after: input.patch });
    // Stage is refused above, so this can never double with stage_changed.
    void import("../services/workflowEngine")
      .then((m) => m.fireRecordUpdated(ctx.workspace.id, "opportunity", input.id, before, patch, before.ownerUserId ?? null))
      .catch(() => { /* workflow firing is best-effort */ });
    return { ok: true };
  }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [before] = await db.select().from(opportunities).where(and(eq(opportunities.id, input.id), eq(opportunities.workspaceId, ctx.workspace.id)));
    await db.delete(opportunities).where(and(eq(opportunities.id, input.id), eq(opportunities.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "opportunity", entityId: input.id, before });
    return { ok: true };
  }),

  /* ── Contact Roles ── */
  listRoles: workspaceProcedure.input(z.object({ opportunityId: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const roles = await db.select().from(opportunityContactRoles).where(and(eq(opportunityContactRoles.opportunityId, input.opportunityId), eq(opportunityContactRoles.workspaceId, ctx.workspace.id)));
    if (roles.length === 0) return [];
    const cs = await db.select().from(contacts).where(eq(contacts.workspaceId, ctx.workspace.id));
    const cMap = new Map(cs.map((c) => [c.id, c]));
    return roles.map((r) => ({ ...r, contact: cMap.get(r.contactId) ?? null }));
  }),

  addRole: repProcedure
    .input(z.object({ opportunityId: z.number(), contactId: z.number(), role: z.enum(["champion", "decision_maker", "influencer", "evaluator", "blocker", "user", "other"]), isPrimary: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      try {
        await db.insert(opportunityContactRoles).values({ ...input, workspaceId: ctx.workspace.id });
      } catch (e) {
        throw new TRPCError({ code: "CONFLICT", message: "That contact already has that role on this opportunity." });
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "opportunity_contact_role", after: input });
      return { ok: true };
    }),

  removeRole: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(opportunityContactRoles).where(and(eq(opportunityContactRoles.id, input.id), eq(opportunityContactRoles.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /* ── Line items ── */
  listLineItems: workspaceProcedure.input(z.object({ opportunityId: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const items = await db.select().from(dealLineItems).where(and(eq(dealLineItems.opportunityId, input.opportunityId), eq(dealLineItems.workspaceId, ctx.workspace.id)));
    const ps = await db.select().from(products).where(eq(products.workspaceId, ctx.workspace.id));
    const pMap = new Map(ps.map((p) => [p.id, p]));
    return items.map((i) => ({ ...i, product: pMap.get(i.productId) ?? null }));
  }),

  addLineItem: repProcedure
    .input(z.object({ opportunityId: z.number(), productId: z.number(), quantity: z.number().int().min(1).default(1), unitPrice: z.number().min(0), discountPct: z.number().min(0).max(100).default(0) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // opportunityId is caller-controlled — verify it belongs to this
      // workspace before attaching items or rewriting its value.
      const [opp] = await db.select({ id: opportunities.id }).from(opportunities)
        .where(and(eq(opportunities.id, input.opportunityId), eq(opportunities.workspaceId, ctx.workspace.id)));
      if (!opp) throw new TRPCError({ code: "NOT_FOUND", message: "Opportunity not found" });
      // Same arithmetic rule as a quote line — @shared/quoteTotals, in integer
      // cents. This was a fourth copy of the formula: it stored `unitPrice`
      // rounded by the DECIMAL(14,2) column while computing `lineTotal` from the
      // unrounded input, so a line could fail to multiply out, and the sum below
      // then became the opportunity's value.
      const [line] = computeQuoteTotals([input]).lines;
      await db.insert(dealLineItems).values({
        workspaceId: ctx.workspace.id,
        opportunityId: input.opportunityId,
        productId: input.productId,
        quantity: line.quantity,
        unitPrice: centsToDecimal(line.unitPriceCents),
        discountPct: String(input.discountPct),
        lineTotal: centsToDecimal(line.lineTotalCents),
      });
      // Update opp value to sum of line items (workspace-scoped). Summed in
      // cents so N lines cannot drift the pipeline figure by N half-cents.
      const items = await db.select().from(dealLineItems).where(and(eq(dealLineItems.opportunityId, input.opportunityId), eq(dealLineItems.workspaceId, ctx.workspace.id)));
      const totalCents = items.reduce((s, i) => s + toCents(Number(i.lineTotal)), 0);
      await db.update(opportunities).set({ value: centsToDecimal(totalCents) }).where(and(eq(opportunities.id, input.opportunityId), eq(opportunities.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  removeLineItem: repProcedure.input(z.object({ id: z.number(), opportunityId: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(dealLineItems).where(and(eq(dealLineItems.id, input.id), eq(dealLineItems.workspaceId, ctx.workspace.id)));
    const items = await db.select().from(dealLineItems).where(and(eq(dealLineItems.opportunityId, input.opportunityId), eq(dealLineItems.workspaceId, ctx.workspace.id)));
    const totalCents = items.reduce((s, i) => s + toCents(Number(i.lineTotal)), 0);
    // Workspace-scoped: opportunityId is caller-controlled, so an unscoped
    // update could rewrite another tenant's opportunity value.
    await db.update(opportunities).set({ value: centsToDecimal(totalCents) }).where(and(eq(opportunities.id, input.opportunityId), eq(opportunities.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /**
   * Weighted pipeline forecast grouped by expected close month. OPEN deals
   * only (audit 2026-10-20, R19): won deals were summed into "Total pipeline",
   * so closing a deal never moved the number. Close months are calendar months
   * of the close date. Every figure comes from services/dealMetrics, the same
   * classification the Dashboard, Deals, Forecast and Quota read (R39).
   */
  forecast: workspaceProcedure
    .input(z.object({ stages: z.array(z.string()).optional() }).optional())
    .query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const open = (await loadMetricDeals(db, ctx.workspace.id)).filter((d) => d.status === "open");
    const keys = open.map((d) => d.stage);
    const availableStages = keys.filter((k, i) => keys.indexOf(k) === i).sort();
    const filterStages = input?.stages && input.stages.length > 0 ? input.stages : null;
    const rows = filterStages ? open.filter((d) => filterStages.includes(d.stage)) : open;
    // Accumulated in cents, converted once.
    const byMonth: Record<string, { month: string; total: number; weighted: number; count: number; stages: Record<string, number> }> = {};
    const byStage: Record<string, { stage: string; total: number; weighted: number; count: number }> = {};
    for (const d of rows) {
      const weighted = (d.valueCents * d.winProb) / 100;
      const st = (byStage[d.stage] ??= { stage: d.stage, total: 0, weighted: 0, count: 0 });
      st.total += d.valueCents;
      st.weighted += weighted;
      st.count++;
      const key = closeMonthKey(d) ?? "no-date";
      const mo = (byMonth[key] ??= { month: key, total: 0, weighted: 0, count: 0, stages: {} });
      mo.total += d.valueCents;
      mo.weighted += weighted;
      mo.count++;
      mo.stages[d.stage] = (mo.stages[d.stage] ?? 0) + d.valueCents;
    }
    const months = Object.values(byMonth)
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((m) => ({
        ...m, total: dollars(m.total), weighted: dollars(m.weighted),
        stages: Object.fromEntries(Object.entries(m.stages).map(([k, v]) => [k, dollars(v)])),
      }));
    const stages = Object.values(byStage).map((st) => ({ ...st, total: dollars(st.total), weighted: dollars(st.weighted) }));
    const totals = openTotals(rows);
    return { grandTotal: totals.value, grandWeighted: totals.weighted, months, stages, availableStages };
  }),

  /**
   * The headline deal numbers, workspace-wide, for any page that shows them
   * (the Deals header computed its own from the board rows, R39).
   */
  summary: workspaceProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const deals = await loadMetricDeals(db, ctx.workspace.id);
      const tz = await getWorkspaceTimezone(ctx.workspace.id);
      const r = currentRanges(tz);
      return {
        open: openTotals(deals),
        won: closedIn(deals, "won"),
        lost: closedIn(deals, "lost"),
        wonThisMonth: closedIn(deals, "won", r.month),
        wonThisQuarter: closedIn(deals, "won", r.quarter),
        lostThisQuarter: closedIn(deals, "lost", r.quarter),
      };
    }),

  /** Detail view: opportunity + account + contact roles + recent activities. */
  getWithRelated: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [opp] = await db.select().from(opportunities).where(and(eq(opportunities.id, input.id), eq(opportunities.workspaceId, ctx.workspace.id)));
      if (!opp) return null;
      const account = (await db.select().from(accounts).where(and(eq(accounts.id, opp.accountId), eq(accounts.workspaceId, ctx.workspace.id))))[0] ?? null;
      const roles = await db.select().from(opportunityContactRoles).where(and(eq(opportunityContactRoles.opportunityId, input.id), eq(opportunityContactRoles.workspaceId, ctx.workspace.id)));
      const contactIds = roles.map((r) => r.contactId);
      const oppContacts = contactIds.length > 0
        ? await db.select().from(contacts).where(and(eq(contacts.workspaceId, ctx.workspace.id), inArray(contacts.id, contactIds)))
        : [];
      const cMap = new Map(oppContacts.map((c) => [c.id, c]));
      const contactRoles = roles.map((r) => ({ ...r, contact: cMap.get(r.contactId) ?? null }));
      // The detail page's Win/Loss reason editors tested `stage === "won"`, so a
      // workspace with a custom closing stage was offered neither field and
      // could never record why a deal closed. The row carries pipelineId, so
      // resolve the flags here rather than making the client guess.
      const stageMeta = await resolvedStageFor(db, ctx.workspace.id, opp.pipelineId ?? null, opp.stage);
      return { opportunity: opp, account, contactRoles, stageMeta: { isWon: stageMeta.isWon, isLost: stageMeta.isLost } };
    }),

  /**
   * Chronological timeline of all activities for an opportunity.
   * Includes calls, meetings, notes, and AI meeting summaries pushed to the opportunity.
   */
  getTimeline: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Verify opportunity belongs to workspace
      const [opp] = await db
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(and(eq(opportunities.id, input.id), eq(opportunities.workspaceId, ctx.workspace.id)));
      if (!opp) throw new TRPCError({ code: "NOT_FOUND", message: "Opportunity not found" });
      // Fetch all activities linked to this opportunity
      const rows = await db
        .select()
        .from(activities)
        .where(
          and(
            eq(activities.workspaceId, ctx.workspace.id),
            eq(activities.relatedType, "opportunity"),
            eq(activities.relatedId, input.id),
          )
        )
        .orderBy(desc(activities.createdAt))
        .limit(200);
      return rows.map((a) => ({
        id: a.id,
        type: a.type,
        subject: a.subject ?? null,
        body: a.body ?? null,
        disposition: a.disposition ?? null,
        occurredAt: a.occurredAt ?? a.createdAt,
        createdAt: a.createdAt,
        createdByUserId: a.createdByUserId ?? null,
        // Flag activities that are pushed AI meeting summaries
        isMeetingSummary: a.type === "note" && typeof a.subject === "string" && a.subject.startsWith("Meeting Summary:"),
      }));
    }),

  /**
   * Revenue chart data: closed-won value and weighted pipeline forecast
   * grouped by month, for the Mockup B Dashboard home screen.
   */
  revenueChart: workspaceProcedure
    .input(z.object({ months: z.number().int().min(1).max(24).default(6) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const deals = await loadMetricDeals(db, ctx.workspace.id);
      const tz = await getWorkspaceTimezone(ctx.workspace.id);

      // Month buckets for the last N months in the workspace's zone, stepped
      // from day 1: setMonth() on the 29th–31st skipped or repeated a month
      // (R83). Cents until the end.
      const buckets: Record<string, { label: string; revenue: number; forecast: number }> = {};
      const { y, m } = zonedYmd(tz, new Date());
      for (let i = input.months - 1; i >= 0; i--) {
        const b = addMonths(y, m, -i);
        const label = new Date(Date.UTC(b.y, b.m - 1, 15)).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
        buckets[monthKey(b.y, b.m)] = { label, revenue: 0, forecast: 0 };
      }

      for (const d of deals) {
        if (d.status === "won" && d.wonAt) {
          // Revenue lands in the month it was WON — the close date is only
          // what someone expected.
          const bucket = buckets[instantMonthKey(tz, d.wonAt)];
          if (bucket) bucket.revenue += d.valueCents;
        } else if (d.status === "open") {
          const key = closeMonthKey(d);
          const bucket = key ? buckets[key] : undefined;
          if (bucket) bucket.forecast += (d.valueCents * d.winProb) / 100;
        }
      }

      return Object.values(buckets).map((b) => ({ ...b, revenue: dollars(b.revenue), forecast: dollars(b.forecast) }));
    }),

  /** Live stat-card deltas: current vs previous month for pipeline, closed-won, leads, customers. */
  dashboardStats: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const wid = ctx.workspace.id;
    const tz = await getWorkspaceTimezone(wid);
    const r = currentRanges(tz);
    const deals = await loadMetricDeals(db, wid);
    const allLeads = await db.select({ id: leads.id, createdAt: leads.createdAt }).from(leads).where(eq(leads.workspaceId, wid));
    const allCustomers = await db.select({ id: customers.id, createdAt: customers.createdAt }).from(customers).where(eq(customers.workspaceId, wid));
    const open = openTotals(deals);
    // The pipeline as it stood when this month began: deals that existed then
    // and were still open — open now, or closed since. The old figure summed
    // open deals whose updatedAt fell last month, which is not a pipeline.
    let pipelinePrevCents = 0;
    for (const d of deals) {
      if (!d.createdAt || d.createdAt >= r.month.start) continue;
      const closedAt = d.status === "won" ? d.wonAt : d.status === "lost" ? d.lostAt : null;
      if (d.status === "open" || (closedAt && closedAt >= r.month.start)) pipelinePrevCents += d.valueCents;
    }
    const pipelinePrev = dollars(pipelinePrevCents);
    // Won by WHEN it was won (R16/R17): updatedAt moved any edited old win
    // into this month.
    const closedWonNow = closedIn(deals, "won", r.month).count;
    const closedWonPrev = closedIn(deals, "won", r.prevMonth).count;
    const leadsNow = allLeads.filter((l) => inRange(l.createdAt, r.month)).length;
    const leadsPrev = allLeads.filter((l) => inRange(l.createdAt, r.prevMonth)).length;
    const custNow = allCustomers.length;
    const custPrev = allCustomers.filter((c) => c.createdAt != null && c.createdAt < r.month.start).length;
    const delta = (a: number, b: number) => b === 0 ? (a > 0 ? 100 : 0) : Math.round(((a - b) / b) * 100);
    // Proposal health counts
    const STALE_MS = 48 * 60 * 60 * 1000;
    const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;
    const nowTs = Date.now();
    const allProposals = await db
      .select({
        id: proposals.id,
        status: proposals.status,
        sentAt: proposals.sentAt,
        emailOpenedAt: proposals.emailOpenedAt,
        expiresAt: proposals.expiresAt,
      })
      .from(proposals)
      .where(eq(proposals.workspaceId, wid));
    const staleProposals = allProposals.filter(
      (p) =>
        p.status === "sent" &&
        p.emailOpenedAt === null &&
        p.sentAt !== null &&
        nowTs - new Date(p.sentAt).getTime() > STALE_MS,
    ).length;
    const expiringProposals = allProposals.filter(
      (p) =>
        p.expiresAt !== null &&
        new Date(p.expiresAt).getTime() >= nowTs &&
        new Date(p.expiresAt).getTime() - nowTs <= EXPIRING_SOON_MS &&
        p.status !== "accepted" &&
        p.status !== "not_accepted",
    ).length;
    return {
      pipelineValue: open.value,
      pipelineDelta: delta(open.value, pipelinePrev),
      weightedPipeline: open.weighted,
      closedWonCount: closedWonNow,
      closedWonValue: closedIn(deals, "won", r.month).value,
      closedWonDelta: delta(closedWonNow, closedWonPrev),
      activeLeads: allLeads.length,
      leadsDelta: delta(leadsNow, leadsPrev),
      customerCount: custNow,
      customerDelta: delta(custNow, custPrev),
      openOppsCount: open.count,
      totalWonValue: closedIn(deals, "won").value,
      staleProposals,
      expiringProposals,
    };
  }),

  /** Stage funnel: count + value per open pipeline stage. */
  /**
   * Chronological list of stage transitions for one opportunity.
   * Powers the "Stage history" tab on /opportunities/:id. Joined with
   * the team list client-side to surface who made each change.
   */
  stageHistory: workspaceProcedure
    .input(z.object({ opportunityId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(opportunityStageHistory)
        .where(and(
          eq(opportunityStageHistory.workspaceId, ctx.workspace.id),
          eq(opportunityStageHistory.opportunityId, input.opportunityId),
        ))
        .orderBy(desc(opportunityStageHistory.createdAt))
        .limit(100);
    }),

  /**
   * Per-rep forecast rollup: total open, weighted (value × winProb),
   * commit (≥90% prob), best-case (≥50% prob), won this quarter.
   * Powers the /forecast page.
   */
  forecastByRep: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const deals = await loadMetricDeals(db, ctx.workspace.id);
    const quarter = currentRanges(await getWorkspaceTimezone(ctx.workspace.id)).quarter;
    // Grouped first, then totalled by the same functions every page uses — so
    // the per-rep rows add up to the Pipeline and Deals totals exactly.
    const byOwner = new Map<string, { ownerUserId: number | null; deals: typeof deals }>();
    for (const d of deals) {
      const key = String(d.ownerUserId ?? "unassigned");
      if (!byOwner.has(key)) byOwner.set(key, { ownerUserId: d.ownerUserId, deals: [] });
      byOwner.get(key)!.deals.push(d);
    }
    return Array.from(byOwner.values()).map(({ ownerUserId, deals: own }) => {
      const open = openTotals(own);
      return {
        ownerUserId,
        openCount: open.count,
        total: open.value,
        weighted: open.weighted,
        commit: open.commit,
        bestCase: open.bestCase,
        // Won IN the quarter (wonAt), not expected to close in it.
        wonThisQuarter: closedIn(own, "won", quarter).value,
      };
    });
  }),

  stageFunnel: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const stages = await stageIndexFor(db, ctx.workspace.id);
    // Open by the deal's OWN pipeline's flags, like every other deal number.
    const rows = (await loadMetricDeals(db, ctx.workspace.id)).filter((d) => d.status === "open");

    // The order used to be hardcoded as ["prospect",…,"closing"] — stage keys
    // that do not exist in this system. The real default keys are discovery /
    // qualified / proposal / negotiation (+ won/lost, excluded above), so
    // `stageOrder.filter(s => map[s])` never matched "discovery" and EVERY
    // newly created opportunity was missing from the funnel chart.
    //
    // opportunities.stage is a varchar, not an enum, because custom pipelines
    // define their own keys — so read the workspace's actual stages rather
    // than hardcoding any list, and append any stage present in the data that
    // the pipeline config doesn't know about so nothing is ever dropped.
    const stageDefs = await db
      .select({ key: crmPipelineStages.key, label: crmPipelineStages.label, sortOrder: crmPipelineStages.sortOrder })
      .from(crmPipelineStages)
      .where(eq(crmPipelineStages.workspaceId, ctx.workspace.id))
      .orderBy(crmPipelineStages.sortOrder);

    const labelByKey = new Map<string, string>();
    const ordered: string[] = [];
    const seed = stageDefs.length > 0
      ? stageDefs
      : LEGACY_STAGES.map((s) => ({ key: s.key, label: s.label, sortOrder: s.sortOrder }));
    for (const s of seed) {
      if (stages.isClosed(s.key)) continue;
      if (!labelByKey.has(s.key)) { labelByKey.set(s.key, s.label); ordered.push(s.key); }
    }

    const map: Record<string, { count: number; value: number }> = {};
    for (const o of rows) {
      const s = o.stage ?? "discovery";
      if (!map[s]) map[s] = { count: 0, value: 0 };
      map[s].count++;
      map[s].value += o.valueCents;
    }
    // Any stage with deals but no definition still gets a column.
    for (const s of Object.keys(map)) {
      if (!labelByKey.has(s)) { labelByKey.set(s, s.charAt(0).toUpperCase() + s.slice(1)); ordered.push(s); }
    }

    return ordered
      .filter((s) => map[s])
      .map((s) => ({ stage: labelByKey.get(s) ?? s, count: map[s].count, value: dollars(map[s].value) }));
  }),

  /** Top 5 reps by closed-won value (won this month, fallback to all-time). */
  topReps: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const won = (await loadMetricDeals(db, ctx.workspace.id)).filter((d) => d.status === "won");
    const month = currentRanges(await getWorkspaceTimezone(ctx.workspace.id)).month;
    const thisMonth = won.filter((d) => inRange(d.wonAt, month));
    const buildMap = (src: typeof won) => {
      const m: Record<number, { value: number; count: number }> = {};
      for (const o of src) { const uid = o.ownerUserId ?? 0; if (!m[uid]) m[uid] = { value: 0, count: 0 }; m[uid].value += o.valueCents; m[uid].count++; }
      return m;
    };
    const source = Object.keys(buildMap(thisMonth)).length > 0 ? buildMap(thisMonth) : buildMap(won);
    const memberRows = await db.select({ userId: workspaceMembers.userId, name: users.name }).from(workspaceMembers).leftJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, ctx.workspace.id));
    const nameMap = Object.fromEntries(memberRows.map((m) => [m.userId, m.name ?? "Rep"]));
    return Object.entries(source).map(([uid, v]) => ({ userId: Number(uid), name: nameMap[Number(uid)] ?? "Rep", value: dollars(v.value), count: v.count })).sort((a, b) => b.value - a.value).slice(0, 5);
  }),

  /** Win/loss ratio for the last 90 days — by when each deal was won or lost. */
  winLoss: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { won: 0, lost: 0, wonValue: 0, lostValue: 0 };
    const deals = await loadMetricDeals(db, ctx.workspace.id);
    const last90: Range = { start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), end: new Date(Date.now() + 1) };
    const won = closedIn(deals, "won", last90);
    const lost = closedIn(deals, "lost", last90);
    return { won: won.count, lost: lost.count, wonValue: won.value, lostValue: lost.value };
  }),
});

/* ──────────────────────────────────────────────────────────────────────── */

export const territoriesRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(territories).where(eq(territories.workspaceId, ctx.workspace.id));
  }),

  create: workspaceProcedure
    .input(z.object({ name: z.string().min(1), rules: z.record(z.string(), z.any()).optional(), ownerUserId: z.number().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await assertOwnerInWorkspace(ctx.workspace.id, input.ownerUserId);
      await db.insert(territories).values({ ...input, workspaceId: ctx.workspace.id });
      return { ok: true };
    }),

  update: workspaceProcedure.input(z.object({ id: z.number(), patch: TERRITORY_PATCH })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await assertOwnerInWorkspace(ctx.workspace.id, input.patch.ownerUserId);
    if (Object.keys(input.patch).length === 0) return { ok: true };
    await db.update(territories).set(input.patch).where(and(eq(territories.id, input.id), eq(territories.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  delete: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(territories).where(and(eq(territories.id, input.id), eq(territories.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
});

/* ──────────────────────────────────────────────────────────────────────── */

export const productsRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(products).where(eq(products.workspaceId, ctx.workspace.id)).orderBy(products.name);
  }),

  create: workspaceProcedure
    .input(z.object({
      sku: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional(),
      category: z.string().optional(),
      listPrice: z.number().min(0),
      cost: z.number().min(0).default(0),
      billingCycle: z.enum(["one_time", "monthly", "annual"]).default("annual"),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      try {
        await db.insert(products).values({ ...input, listPrice: String(input.listPrice), cost: String(input.cost), workspaceId: ctx.workspace.id, active: true });
      } catch (e) {
        throw new TRPCError({ code: "CONFLICT", message: "SKU already exists" });
      }
      return { ok: true };
    }),

  update: workspaceProcedure.input(z.object({ id: z.number(), patch: PRODUCT_PATCH })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const patch: any = { ...input.patch };
    if (patch.listPrice !== undefined) patch.listPrice = String(patch.listPrice);
    if (patch.cost !== undefined) patch.cost = String(patch.cost);
    if (Object.keys(patch).length === 0) return { ok: true };
    await db.update(products).set(patch).where(and(eq(products.id, input.id), eq(products.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  delete: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(products).where(and(eq(products.id, input.id), eq(products.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
});

/* ──────────────────────────────────────────────────────────────────────── */
/* Territory routing rules — auto-assign accounts/leads to a territory/owner */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Apply territory rules to a candidate account/lead payload. Returns the
 * matched rule's territoryId + ownerUserId or nulls if no rule matched.
 * First-match-wins by priority (lower priority value = higher precedence).
 */
export async function applyTerritoryRules(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  workspaceId: number,
  payload: { industry?: string | null; country?: string | null; state?: string | null; company?: string | null },
): Promise<{ territoryId: number | null; ownerUserId: number | null } | null> {
  const rules = await db.select().from(crmTerritoryRules)
    .where(and(eq(crmTerritoryRules.workspaceId, workspaceId), eq(crmTerritoryRules.active, true)))
    .orderBy(crmTerritoryRules.priority, crmTerritoryRules.id);
  const company = (payload.company ?? "").toLowerCase();
  for (const r of rules) {
    if (r.industry && r.industry !== payload.industry) continue;
    if (r.country && r.country !== payload.country) continue;
    if (r.state && r.state !== payload.state) continue;
    if (r.companyContains && !company.includes(r.companyContains.toLowerCase())) continue;
    return { territoryId: r.territoryId ?? null, ownerUserId: r.ownerUserId ?? null };
  }
  return null;
}

export const crmTerritoryRulesRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(crmTerritoryRules)
      .where(eq(crmTerritoryRules.workspaceId, ctx.workspace.id))
      .orderBy(crmTerritoryRules.priority, crmTerritoryRules.id);
  }),

  create: repProcedure
    .input(z.object({
      name: z.string().min(1).max(120),
      priority: z.number().int().default(100),
      industry: z.string().max(80).optional(),
      country: z.string().max(80).optional(),
      state: z.string().max(80).optional(),
      companyContains: z.string().max(120).optional(),
      territoryId: z.number().optional(),
      ownerUserId: z.number().optional(),
      active: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await assertRowInWorkspace(db, "territory", input.territoryId, ctx.workspace.id);
      await assertOwnerInWorkspace(ctx.workspace.id, input.ownerUserId);
      const r = await db.insert(crmTerritoryRules).values({ ...input, workspaceId: ctx.workspace.id });
      return { id: Number((r as any)[0]?.insertId ?? 0) };
    }),

  update: repProcedure.input(z.object({ id: z.number(), patch: TERRITORY_RULE_PATCH })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await assertRowInWorkspace(db, "territory", input.patch.territoryId, ctx.workspace.id);
    await assertOwnerInWorkspace(ctx.workspace.id, input.patch.ownerUserId);
    if (Object.keys(input.patch).length === 0) return { ok: true };
    await db.update(crmTerritoryRules).set(input.patch).where(and(eq(crmTerritoryRules.id, input.id), eq(crmTerritoryRules.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(crmTerritoryRules).where(and(eq(crmTerritoryRules.id, input.id), eq(crmTerritoryRules.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
});

/* ──────────────────────────────────────────────────────────────────────── */
/* CRM Notes — pinnable freeform notes on any entity                         */
/* ──────────────────────────────────────────────────────────────────────── */

const VALID_NOTE_ENTITIES = ["account", "contact", "lead", "opportunity", "customer"] as const;

export const crmNotesRouter = router({
  list: workspaceProcedure
    .input(z.object({ entityType: z.enum(VALID_NOTE_ENTITIES), entityId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(crmNotes)
        .where(and(
          eq(crmNotes.workspaceId, ctx.workspace.id),
          eq(crmNotes.entityType, input.entityType),
          eq(crmNotes.entityId, input.entityId),
        ))
        .orderBy(desc(crmNotes.pinned), desc(crmNotes.createdAt))
        .limit(200);
    }),

  create: repProcedure
    .input(z.object({
      entityType: z.enum(VALID_NOTE_ENTITIES),
      entityId: z.number(),
      body: z.string().min(1).max(8000),
      pinned: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const r = await db.insert(crmNotes).values({
        workspaceId: ctx.workspace.id,
        entityType: input.entityType,
        entityId: input.entityId,
        body: input.body,
        pinned: input.pinned ?? false,
        createdByUserId: ctx.user.id,
      });
      return { id: Number((r as any)[0]?.insertId ?? 0) };
    }),

  update: repProcedure
    .input(z.object({ id: z.number(), body: z.string().min(1).max(8000).optional(), pinned: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const patch: any = {};
      if (input.body !== undefined) patch.body = input.body;
      if (input.pinned !== undefined) patch.pinned = input.pinned;
      if (Object.keys(patch).length === 0) return { ok: true };
      await db.update(crmNotes).set(patch).where(and(eq(crmNotes.id, input.id), eq(crmNotes.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(crmNotes).where(and(eq(crmNotes.id, input.id), eq(crmNotes.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
});

/* ──────────────────────────────────────────────────────────────────────── */
/* CRM Pipelines — multi-pipeline with configurable stages per workspace     */
/* ──────────────────────────────────────────────────────────────────────── */

/** Legacy stage shape; mirrors the hard-coded STAGES that Pipeline.tsx used. */
const LEGACY_STAGES = [
  { key: "discovery",   label: "Discovery",   sortOrder: 0, defaultWinProb: 15, isWon: false, isLost: false },
  { key: "qualified",   label: "Qualified",   sortOrder: 1, defaultWinProb: 30, isWon: false, isLost: false },
  { key: "proposal",    label: "Proposal",    sortOrder: 2, defaultWinProb: 55, isWon: false, isLost: false },
  { key: "negotiation", label: "Negotiation", sortOrder: 3, defaultWinProb: 75, isWon: false, isLost: false },
  { key: "won",         label: "Won",         sortOrder: 4, defaultWinProb: 100, isWon: true,  isLost: false },
  { key: "lost",        label: "Lost",        sortOrder: 5, defaultWinProb: 0,   isWon: false, isLost: true  },
];

/** Ensure the workspace has at least one pipeline; seed the legacy 6 stages if not.
 *  Self-healing: if a past check-then-insert race left more than one pipeline
 *  flagged isDefault, demote all but the lowest-id one so exactly one default
 *  exists. The lowest-id pipeline is treated as canonical. */
async function ensureDefaultPipeline(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, workspaceId: number): Promise<number> {
  const existing = await db.select().from(crmPipelines)
    .where(eq(crmPipelines.workspaceId, workspaceId))
    .orderBy(crmPipelines.id);
  if (existing.length > 0) {
    const canonical = existing.find((p) => p.isDefault) ?? existing[0];
    // Collapse any extra default flags down to the canonical one.
    const extraDefaults = existing.filter((p) => p.isDefault && p.id !== canonical.id);
    for (const p of extraDefaults) {
      await db.update(crmPipelines).set({ isDefault: false }).where(eq(crmPipelines.id, p.id));
    }
    return canonical.id;
  }
  const r = await db.insert(crmPipelines).values({ workspaceId, name: "Default", isDefault: true, sortOrder: 0 });
  const pipelineId = Number((r as any)[0]?.insertId ?? 0);
  // Guard the check-then-insert race: if a concurrent call already inserted a
  // pipeline, defer to the lowest-id one and drop the row we just created.
  const after = await db.select().from(crmPipelines)
    .where(eq(crmPipelines.workspaceId, workspaceId))
    .orderBy(crmPipelines.id);
  if (after.length > 1) {
    const canonical = after[0];
    if (canonical.id !== pipelineId) {
      await db.delete(crmPipelineStages).where(eq(crmPipelineStages.pipelineId, pipelineId));
      await db.delete(crmPipelines).where(eq(crmPipelines.id, pipelineId));
      return canonical.id;
    }
  }
  await db.insert(crmPipelineStages).values(LEGACY_STAGES.map((s) => ({ ...s, workspaceId, pipelineId })));
  return pipelineId;
}

/** The pipeline a stage belongs to, as the board-scoping helpers need it. */
async function pipelineRefFor(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, workspaceId: number, pipelineId: number) {
  const [row] = await db.select({ id: crmPipelines.id, isDefault: crmPipelines.isDefault }).from(crmPipelines)
    .where(and(eq(crmPipelines.id, pipelineId), eq(crmPipelines.workspaceId, workspaceId))).limit(1);
  return row ?? { id: pipelineId, isDefault: false };
}

async function assertStageKeyFree(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, workspaceId: number, pipelineId: number, key: string) {
  const [clash] = await db.select({ id: crmPipelineStages.id }).from(crmPipelineStages)
    .where(and(eq(crmPipelineStages.workspaceId, workspaceId), eq(crmPipelineStages.pipelineId, pipelineId), eq(crmPipelineStages.key, key)))
    .limit(1);
  if (clash) throw new TRPCError({ code: "CONFLICT", message: `This pipeline already has a stage with the key "${key}".` });
}

export const crmPipelinesRouter = router({
  /** Returns all pipelines for the workspace, seeding the Default one if none exist. */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    await ensureDefaultPipeline(db, ctx.workspace.id);
    return db.select().from(crmPipelines).where(eq(crmPipelines.workspaceId, ctx.workspace.id)).orderBy(crmPipelines.sortOrder, crmPipelines.id);
  }),

  /** Return one pipeline with its stages. If pipelineId is omitted, returns the default. */
  get: workspaceProcedure
    .input(z.object({ pipelineId: z.number().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const pipelineId = input?.pipelineId ?? await ensureDefaultPipeline(db, ctx.workspace.id);
      const [pipeline] = await db.select().from(crmPipelines)
        .where(and(eq(crmPipelines.id, pipelineId), eq(crmPipelines.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!pipeline) throw new TRPCError({ code: "NOT_FOUND" });
      const stageRows = await db.select().from(crmPipelineStages)
        .where(and(eq(crmPipelineStages.workspaceId, ctx.workspace.id), eq(crmPipelineStages.pipelineId, pipelineId)))
        .orderBy(crmPipelineStages.sortOrder, crmPipelineStages.id);
      // How many deals each stage holds, so the settings page can say what a
      // delete or a Won/Lost change will touch (R18).
      const onBoard = await db.select({ stage: opportunities.stage }).from(opportunities)
        .where(boardDealsWhere(ctx.workspace.id, pipeline));
      const counts = new Map<string, number>();
      for (const d of onBoard) counts.set(d.stage, (counts.get(d.stage) ?? 0) + 1);
      const stages = stageRows.map((st) => ({ ...st, dealCount: counts.get(st.key) ?? 0 }));
      return { pipeline, stages, dealCount: onBoard.length };
    }),

  createPipeline: repProcedure
    .input(z.object({ name: z.string().min(1).max(120), cloneFromPipelineId: z.number().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const r = await db.insert(crmPipelines).values({ workspaceId: ctx.workspace.id, name: input.name, isDefault: false, sortOrder: 99 });
      const pipelineId = Number((r as any)[0]?.insertId ?? 0);

      // Seed stages: clone from source pipeline or fall back to legacy template.
      let stageRows: typeof LEGACY_STAGES = LEGACY_STAGES;
      if (input.cloneFromPipelineId) {
        const src = await db.select().from(crmPipelineStages)
          .where(and(eq(crmPipelineStages.workspaceId, ctx.workspace.id), eq(crmPipelineStages.pipelineId, input.cloneFromPipelineId)))
          .orderBy(crmPipelineStages.sortOrder);
        if (src.length > 0) {
          stageRows = src.map((s) => ({
            key: s.key, label: s.label, sortOrder: s.sortOrder,
            defaultWinProb: s.defaultWinProb, isWon: s.isWon, isLost: s.isLost,
          }));
        }
      }
      await db.insert(crmPipelineStages).values(stageRows.map((s) => ({ ...s, workspaceId: ctx.workspace.id, pipelineId })));
      invalidateStageIndex(ctx.workspace.id);
      return { id: pipelineId };
    }),

  renamePipeline: repProcedure
    .input(z.object({ id: z.number(), name: z.string().min(1).max(120) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(crmPipelines).set({ name: input.name }).where(and(eq(crmPipelines.id, input.id), eq(crmPipelines.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  setDefault: repProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Clear other defaults, then set this one. Not transactional — acceptable per HANDOFF gotcha #4.
      await db.update(crmPipelines).set({ isDefault: false }).where(eq(crmPipelines.workspaceId, ctx.workspace.id));
      await db.update(crmPipelines).set({ isDefault: true }).where(and(eq(crmPipelines.id, input.id), eq(crmPipelines.workspaceId, ctx.workspace.id)));
      // The default pipeline is the fallback resolvedStageFor consults for a
      // deal with no pipelineId, so this changes the answer too.
      invalidateStageIndex(ctx.workspace.id);
      return { ok: true };
    }),

  deletePipeline: repProcedure
    .input(z.object({ id: z.number(), moveToPipelineId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Don't allow deleting the default pipeline.
      const [target] = await db.select().from(crmPipelines).where(and(eq(crmPipelines.id, input.id), eq(crmPipelines.workspaceId, ctx.workspace.id))).limit(1);
      if (!target) throw new TRPCError({ code: "NOT_FOUND" });
      if (target.isDefault) throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot delete the default pipeline" });
      // Its deals move to another pipeline first (R18): left behind, they sat
      // on no board while every revenue number still counted them.
      const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(opportunities).where(boardDealsWhere(ctx.workspace.id, target));
      let moved = 0;
      if (Number(n) > 0) {
        if (!input.moveToPipelineId || input.moveToPipelineId === input.id) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `${n} deal${Number(n) === 1 ? " is" : "s are"} in this pipeline. Pick a pipeline to move ${Number(n) === 1 ? "it" : "them"} to.` });
        }
        const [dest] = await db.select({ id: crmPipelines.id, name: crmPipelines.name }).from(crmPipelines)
          .where(and(eq(crmPipelines.id, input.moveToPipelineId), eq(crmPipelines.workspaceId, ctx.workspace.id))).limit(1);
        if (!dest) throw new TRPCError({ code: "NOT_FOUND", message: "That pipeline no longer exists." });
        moved = await moveDealsToPipeline(db, {
          workspaceId: ctx.workspace.id, from: target, toPipelineId: dest.id, actorUserId: ctx.user.id,
          note: `Pipeline "${target.name}" deleted — moved to "${dest.name}"`,
        });
      }
      await db.delete(crmPipelineStages).where(and(eq(crmPipelineStages.pipelineId, input.id), eq(crmPipelineStages.workspaceId, ctx.workspace.id)));
      await db.delete(crmPipelines).where(and(eq(crmPipelines.id, input.id), eq(crmPipelines.workspaceId, ctx.workspace.id)));
      invalidateStageIndex(ctx.workspace.id);
      return { ok: true, moved };
    }),

  createStage: repProcedure
    .input(z.object({
      pipelineId: z.number(),
      key: z.string().min(1).max(60),
      label: z.string().min(1).max(120),
      sortOrder: z.number().int().default(0),
      defaultWinProb: z.number().int().min(0).max(100).default(20),
      isWon: z.boolean().default(false),
      isLost: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await assertRowInWorkspace(db, "pipeline", input.pipelineId, ctx.workspace.id);
      // A key is how a deal names its stage; two stages sharing one in a
      // pipeline made the board put the deal in whichever came first (R18).
      await assertStageKeyFree(db, ctx.workspace.id, input.pipelineId, input.key);
      const r = await db.insert(crmPipelineStages).values({ ...input, workspaceId: ctx.workspace.id });
      invalidateStageIndex(ctx.workspace.id);
      return { id: Number((r as any)[0]?.insertId ?? 0) };
    }),

  updateStage: repProcedure
    .input(z.object({
      id: z.number(),
      patch: z.object({
        key: z.string().min(1).max(60).optional(),
        label: z.string().min(1).max(120).optional(),
        sortOrder: z.number().int().optional(),
        defaultWinProb: z.number().int().min(0).max(100).optional(),
        isWon: z.boolean().optional(),
        isLost: z.boolean().optional(),
      }),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [stage] = await db.select().from(crmPipelineStages)
        .where(and(eq(crmPipelineStages.id, input.id), eq(crmPipelineStages.workspaceId, ctx.workspace.id))).limit(1);
      if (!stage) throw new TRPCError({ code: "NOT_FOUND" });
      const pipeline = await pipelineRefFor(db, ctx.workspace.id, stage.pipelineId);
      const rekey = input.patch.key !== undefined && input.patch.key !== stage.key;
      if (rekey) await assertStageKeyFree(db, ctx.workspace.id, stage.pipelineId, input.patch.key!);
      await db.update(crmPipelineStages).set(input.patch).where(and(eq(crmPipelineStages.id, input.id), eq(crmPipelineStages.workspaceId, ctx.workspace.id)));
      // A new key carries the stage's deals with it; they held the old one and
      // fell off the board (R18).
      if (rekey) await rekeyStageDeals(db, { workspaceId: ctx.workspace.id, pipeline, fromKey: stage.key, toKey: input.patch.key! });
      // Ticking Won on a stage retroactively reclassifies every deal sitting in
      // it — that is the point of deriving at read time — so the memo has to
      // go, and the deals' won / lost dates follow the flags.
      const isWon = input.patch.isWon ?? !!stage.isWon;
      const isLost = input.patch.isLost ?? !!stage.isLost;
      if (isWon !== !!stage.isWon || isLost !== !!stage.isLost) {
        await restampStageDeals(db, { workspaceId: ctx.workspace.id, pipeline, key: input.patch.key ?? stage.key, isWon: isWon && !isLost, isLost });
      }
      invalidateStageIndex(ctx.workspace.id);
      return { ok: true };
    }),

  /**
   * Delete a stage (R18). Its deals move to another stage of the same kind in
   * the same pipeline — a won deal to another Won stage, so past revenue stays
   * revenue — and a pipeline keeps at least one Won stage.
   */
  deleteStage: repProcedure
    .input(z.object({ id: z.number(), moveToKey: z.string().min(1).max(60).optional() }))
    .mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [doomed] = await db.select().from(crmPipelineStages)
      .where(and(eq(crmPipelineStages.id, input.id), eq(crmPipelineStages.workspaceId, ctx.workspace.id))).limit(1);
    if (!doomed) throw new TRPCError({ code: "NOT_FOUND" });
    const siblings = await db.select().from(crmPipelineStages)
      .where(and(eq(crmPipelineStages.workspaceId, ctx.workspace.id), eq(crmPipelineStages.pipelineId, doomed.pipelineId)));
    const kind = (r: { isWon: unknown; isLost: unknown }) => (Number(r.isLost) ? "lost" : Number(r.isWon) ? "won" : "open");
    const others = siblings.filter((r) => r.id !== doomed.id);
    if (kind(doomed) === "won" && !others.some((r) => kind(r) === "won")) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "This is the pipeline's only Won stage — without one, no deal in it can be won. Add another Won stage first." });
    }
    const pipeline = await pipelineRefFor(db, ctx.workspace.id, doomed.pipelineId);
    const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(opportunities)
      .where(boardDealsWhere(ctx.workspace.id, pipeline, doomed.key));
    let moved = 0;
    if (Number(n) > 0) {
      const dest = others.find((r) => r.key === input.moveToKey);
      if (!dest) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `${n} deal${Number(n) === 1 ? " is" : "s are"} in this stage. Pick a stage to move ${Number(n) === 1 ? "it" : "them"} to.` });
      }
      if (kind(dest) !== kind(doomed)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Move these deals to another ${kind(doomed) === "open" ? "open" : kind(doomed) === "won" ? "Won" : "Lost"} stage, so their numbers stay where they are.` });
      }
      moved = await moveDealsOffStage(db, {
        workspaceId: ctx.workspace.id, pipeline, fromKey: doomed.key, toKey: dest.key, actorUserId: ctx.user.id,
        note: `Stage "${doomed.label}" deleted — moved to "${dest.label}"`,
      });
    }
    await db.delete(crmPipelineStages).where(and(eq(crmPipelineStages.id, input.id), eq(crmPipelineStages.workspaceId, ctx.workspace.id)));
    invalidateStageIndex(ctx.workspace.id);
    return { ok: true, moved };
  }),

  /** Bulk reorder — pass [{id, sortOrder}]. */
  reorderStages: repProcedure
    .input(z.object({ items: z.array(z.object({ id: z.number(), sortOrder: z.number().int() })).min(1) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      for (const it of input.items) {
        await db.update(crmPipelineStages).set({ sortOrder: it.sortOrder })
          .where(and(eq(crmPipelineStages.id, it.id), eq(crmPipelineStages.workspaceId, ctx.workspace.id)));
      }
      // sortOrder decides the column order of the funnel and stage-distribution
      // widgets, which now read this table instead of a hardcoded list.
      invalidateStageIndex(ctx.workspace.id);
      return { ok: true };
    }),
});
