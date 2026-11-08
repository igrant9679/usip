/**
 * Proposals router — Phase A
 * Covers: list, get, create, update, updateStatus, updateSection,
 *         upsertMilestone, deleteMilestone, submitFeedback (public),
 *         getByShareToken (public), generateSectionContent (AI),
 *         duplicate, sendToClient, acceptProposal, acceptByToken
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, inArray, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";
import {
  proposals,
  proposalSections,
  proposalMilestones,
  proposalFeedback,
  proposalRevisions,
  tasks,
  notifications,
  workspaces,
  opportunities,
  sendingAccounts,
  activities,
  users,
  proposalScoreHistory,
  contacts,
  accounts,
  workspaceMembers,
  quotes,
  quoteLineItems,
  products,
} from "../../drizzle/schema";
import { createEmailAdapter } from "../emailAdapter";
import { getDb } from "../db";
import { appUrl } from "../appUrl";
import { invokeLLM } from "../_core/llm";
import { researchUseForProposal } from "../services/research/recipient";
import { activeOwnerOrNull, workspaceNotifyUserId } from "../_core/activeMembers";
import { changeOpportunityStage, stageDatesForNewDeal } from "../services/stageChange";
import { EXTENSION_SUBJECT, extensionEventOf, openExtensionRequest } from "@shared/proposalExtension";
import { defaultPipelineId, stageResolver } from "../_core/stageSemantics";
import { calendarDayFrom, deadlineFrom } from "../services/calendarDeadline";
import { getWorkspaceTimezone } from "../services/workspaceTimezone";
import { canonicalWonStageKey } from "../_core/stageSemantics";
import { ensureCustomerForWonOpp } from "../services/wonToCustomer";
import { publicProcedure, router } from "../_core/trpc";
import {
  managerProcedure,
  repProcedure,
  workspaceProcedure,
} from "../_core/workspace";
import { assertOutboundNotPaused } from "../services/outboundPause";
import { assertRowInWorkspace } from "../services/foreignIds";
import { acceptanceRecord, PORTAL_UNAVAILABLE, portalMilestone, portalPricing, portalSection, portalView, proposalShareEmailHtml, servedOnPortal } from "../services/proposalPortal";
import { clientIpOf } from "../_core/clientIp";
import { recordAudit } from "../audit";
import { currentPricing, writePricingVersion } from "../services/quoteFold";

// ── Section keys ─────────────────────────────────────────────────────────────
export const SECTION_KEYS = [
  "executive_summary",
  "firm_overview",
  "our_approach",
  "timeline_narrative",
  "pricing",
  "case_studies",
  "references",
  "terms",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

const SECTION_LABELS: Record<SectionKey, string> = {
  executive_summary: "Executive Summary",
  firm_overview: "Firm Overview",
  our_approach: "Our Approach",
  timeline_narrative: "Timeline Narrative",
  pricing: "Pricing",
  case_studies: "Case Studies",
  references: "References",
  terms: "Terms & Conditions",
};

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getProposalOrThrow(
  db: Awaited<ReturnType<typeof getDb>>,
  proposalId: number,
  workspaceId: number,
) {
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  const rows = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), eq(proposals.workspaceId, workspaceId)))
    .limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
  return rows[0];
}

async function getSections(db: Awaited<ReturnType<typeof getDb>>, proposalId: number) {
  if (!db) return [];
  return db.select().from(proposalSections).where(eq(proposalSections.proposalId, proposalId));
}

async function getMilestones(db: Awaited<ReturnType<typeof getDb>>, proposalId: number) {
  if (!db) return [];
  return db
    .select()
    .from(proposalMilestones)
    .where(eq(proposalMilestones.proposalId, proposalId))
    .orderBy(proposalMilestones.sortOrder);
}

function generateShareToken() {
  return crypto.randomBytes(32).toString("hex");
}

/** Statuses a client can accept from: the proposal is out with them (R24). */
const ACCEPTABLE_STATUSES = ["sent", "under_review", "revision_requested"] as const;

/** Reopening the portal within this long is the same visit (F48). */
export const PORTAL_VIEW_GAP_MS = 30 * 60_000;

/**
 * Insert a system activity row for a proposal event.
 * Non-fatal — errors are silently swallowed so they never break the main flow.
 */
async function logProposalActivity(
  db: Awaited<ReturnType<typeof getDb>>,
  opts: {
    workspaceId: number;
    proposalId: number;
    actorUserId?: number;
    actorName?: string;
    subject: string;
    body?: string;
  },
) {
  if (!db) return;
  try {
    await db.insert(activities).values({
      workspaceId: opts.workspaceId,
      type: "system",
      relatedType: "proposal",
      relatedId: opts.proposalId,
      subject: opts.subject,
      body: opts.body ?? null,
      actorUserId: opts.actorUserId ?? null,
      occurredAt: new Date(),
    });
  } catch (_e) {
    // non-fatal
  }
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * The mailboxes a proposal can be sent from, in the order the send picks its
 * default: this workspace's enabled sending accounts, oldest first (R70). The
 * Send-from picker lists exactly these, so "Auto" names the one used.
 */
function proposalSenders(db: Db, workspaceId: number) {
  return db
    .select()
    .from(sendingAccounts)
    .where(and(eq(sendingAccounts.workspaceId, workspaceId), eq(sendingAccounts.enabled, true)))
    .orderBy(asc(sendingAccounts.id));
}

/**
 * An accepted proposal's content is what the client agreed to, so it is
 * locked (audit 2026-10-20, R69): every section stayed editable after
 * acceptance, and nothing kept what had been accepted.
 */
function assertContentEditable(proposal: { status: string }) {
  if (proposal.status === "accepted") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This proposal was accepted, so its content is locked. Duplicate it to work on a new version." });
  }
}

/**
 * Keep the accepted content as one revision per section (R69), so History
 * shows exactly what the client accepted. Best-effort: the acceptance has
 * already landed and must not fail on this.
 */
async function snapshotAcceptedSections(db: Db, proposalId: number, savedByUserId: number | null) {
  try {
    const sections = await getSections(db, proposalId);
    for (const s of sections) {
      await db.insert(proposalRevisions).values({
        proposalId,
        sectionKey: s.sectionKey,
        content: s.content ?? "",
        savedByUserId: savedByUserId ?? undefined,
        savedByName: "Accepted version",
      });
    }
  } catch (e) {
    console.warn(`[proposals] accepted-version snapshot failed for proposal ${proposalId}:`, e);
  }
}

/**
 * The pricing the client accepted (audit 2026-10-20, F34): the proposal's
 * current quote version is recorded as accepted, so its version history says
 * which price was agreed. Best-effort, like the section snapshot.
 */
async function acceptCurrentPricing(db: Db, workspaceId: number, proposalId: number) {
  try {
    await db.update(quotes).set({ status: "accepted" })
      .where(and(eq(quotes.workspaceId, workspaceId), eq(quotes.proposalId, proposalId), isNull(quotes.supersededAt)));
  } catch (e) {
    console.warn(`[proposals] accepted pricing stamp failed for proposal ${proposalId}:`, e);
  }
}

/**
 * The linked deal an acceptance should close won, or null when there is
 * nothing to close. A deal already closed — won or lost — is left alone
 * (audit 2026-10-20, R25): accepting a proposal does not turn a lost deal
 * into a win, or move the date a won one closed.
 */
async function openLinkedDeal(db: Db, workspaceId: number, opportunityId: number) {
  const [opp] = await db
    .select({ pipelineId: opportunities.pipelineId, stage: opportunities.stage })
    .from(opportunities)
    .where(and(eq(opportunities.id, opportunityId), eq(opportunities.workspaceId, workspaceId)));
  if (!opp) return null;
  const meta = (await stageResolver(db, workspaceId)).resolve(opp.pipelineId ?? null, opp.stage);
  return meta.isWon || meta.isLost ? null : opp;
}

/**
 * The company, contact and deal a new proposal names, each checked against
 * this workspace (R25). The wizard sent none of them, so accepting a proposal
 * made in the UI closed no deal; now it can name all three. The company is
 * taken from the deal, else the contact, when the caller names none.
 */
async function proposalLinks(
  db: Db,
  workspaceId: number,
  input: { accountId?: number; contactId?: number; linkedOpportunityId?: number },
): Promise<{ accountId: number | null; contactId: number | null; linkedOpportunityId: number | null }> {
  let accountId = input.accountId ?? null;
  if (input.linkedOpportunityId != null) {
    const [opp] = await db.select({ accountId: opportunities.accountId }).from(opportunities)
      .where(and(eq(opportunities.id, input.linkedOpportunityId), eq(opportunities.workspaceId, workspaceId))).limit(1);
    if (!opp) throw new TRPCError({ code: "NOT_FOUND", message: "Deal not found" });
    if (accountId != null && opp.accountId !== accountId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "That deal belongs to a different company." });
    }
    accountId = accountId ?? opp.accountId ?? null;
  }
  if (input.contactId != null) {
    const [c] = await db.select({ accountId: contacts.accountId }).from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.workspaceId, workspaceId))).limit(1);
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Contact not found" });
    accountId = accountId ?? c.accountId ?? null;
  }
  if (accountId != null) {
    const [a] = await db.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.workspaceId, workspaceId))).limit(1);
    if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Company not found" });
  }
  return { accountId, contactId: input.contactId ?? null, linkedOpportunityId: input.linkedOpportunityId ?? null };
}

/**
 * Compute a 0-100 engagement score for a proposal row.
 * Scoring:
 *   +20  sentAt is set (proposal has been sent)
 *   +25  emailOpenedAt is set (client opened the email)
 *   +25  emailClickedAt is set (client clicked the portal link)
 *   +15  feedbackCount >= 1
 *   +15  status is accepted
 */
function computeEngagementScore(p: {
  sentAt: Date | null;
  emailOpenedAt: Date | null;
  emailClickedAt: Date | null;
  status: string;
  feedbackCount?: number;
}): number {
  let score = 0;
  if (p.sentAt) score += 20;
  if (p.emailOpenedAt) score += 25;
  if (p.emailClickedAt) score += 25;
  if ((p.feedbackCount ?? 0) >= 1) score += 15;
  if (p.status === "accepted") score += 15;
  return Math.min(score, 100);
}
// ── Router ────────────────────────────────────────────────────────────────────
export const proposalsRouter = router({
  /** List proposals in the workspace. Reps see only their own; managers+ see all. */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const isManager = ["manager", "admin", "super_admin"].includes(ctx.member.role);
    const rows = await db
      .select()
      .from(proposals)
      .where(
        isManager
          ? eq(proposals.workspaceId, ctx.workspace.id)
          : and(
              eq(proposals.workspaceId, ctx.workspace.id),
              eq(proposals.createdBy, ctx.user.id),
            ),
      )
      .orderBy(desc(proposals.updatedAt));
    // Enrich with feedback counts and engagement scores
    const proposalIds = rows.map((r) => r.id);
    let feedbackCounts: Map<number, number> = new Map();
    if (proposalIds.length > 0) {
      const fbRows = await db
        .select({ proposalId: proposalFeedback.proposalId })
        .from(proposalFeedback)
        .where(or(...proposalIds.map((id) => eq(proposalFeedback.proposalId, id))));
      for (const fb of fbRows) {
        feedbackCounts.set(fb.proposalId, (feedbackCounts.get(fb.proposalId) ?? 0) + 1);
      }
    }
    const now = Date.now();
    const STALE_MS = 48 * 60 * 60 * 1000; // 48 hours
    const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    return rows.map((r) => ({
      ...r,
      feedbackCount: feedbackCounts.get(r.id) ?? 0,
      engagementScore: computeEngagementScore({
        sentAt: r.sentAt ?? null,
        emailOpenedAt: r.emailOpenedAt ?? null,
        emailClickedAt: r.emailClickedAt ?? null,
        status: r.status,
        feedbackCount: feedbackCounts.get(r.id) ?? 0,
      }),
      isStale:
        r.status === "sent" &&
        r.emailOpenedAt === null &&
        r.sentAt !== null &&
        now - new Date(r.sentAt).getTime() > STALE_MS,
      // An accepted proposal is done with its expiry date: it read "Expired"
      // once the date passed (audit 2026-10-20, R91).
      isExpired:
        r.status !== "accepted" &&
        r.expiresAt !== null &&
        new Date(r.expiresAt).getTime() < now,
      isExpiringSoon:
        r.status !== "accepted" &&
        r.expiresAt !== null &&
        new Date(r.expiresAt).getTime() >= now &&
        new Date(r.expiresAt).getTime() - now <= EXPIRING_SOON_MS,
    }));
  }),

  /** Get a single proposal with sections, milestones, and feedback. */
  get: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      const proposal = await getProposalOrThrow(db, input.id, ctx.workspace.id);
      const [sections, milestones, feedback] = await Promise.all([
        getSections(db, input.id),
        getMilestones(db, input.id),
        db
          ? db
              .select()
              .from(proposalFeedback)
              .where(eq(proposalFeedback.proposalId, input.id))
              .orderBy(desc(proposalFeedback.createdAt))
          : [],
      ]);
      const engagementScore = computeEngagementScore({
        sentAt: proposal.sentAt ?? null,
        emailOpenedAt: proposal.emailOpenedAt ?? null,
        emailClickedAt: proposal.emailClickedAt ?? null,
        status: proposal.status,
        feedbackCount: feedback.length,
      });
      // Count approved extensions
      const extensionApprovedActs = db
        ? await db
            .select({ id: activities.id })
            .from(activities)
            .where(
              and(
                eq(activities.relatedType, "proposal"),
                eq(activities.relatedId, input.id),
                like(activities.subject, "%Extension approved%"),
              ),
            )
        : [];
      const extensionCount = extensionApprovedActs.length;
      return { proposal: { ...proposal, engagementScore, extensionCount }, sections, milestones, feedback };
    }),

  /** Create a new proposal (rep+). */
  create: repProcedure
    .input(
      z.object({
        title: z.string().min(1),
        clientName: z.string().min(1),
        clientEmail: z.string().email().optional().or(z.literal("")),
        clientWebsite: z.string().optional(),
        orgAbbr: z.string().max(32).optional(),
        contactId: z.number().int().positive().optional(),
        accountId: z.number().int().positive().optional(),
        /** The deal acceptance closes won (R25). */
        linkedOpportunityId: z.number().int().positive().optional(),
        projectType: z.string().optional(),
        rfpDeadline: z.string().optional(),
        completionDate: z.string().optional(),
        budget: z.number().optional(),
        description: z.string().optional(),
        requirements: z.array(z.string()).optional(),
        expiresAt: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const tz = await getWorkspaceTimezone(ctx.workspace.id);
      const links = await proposalLinks(db, ctx.workspace.id, input);
      const [result] = await db.insert(proposals).values({
        workspaceId: ctx.workspace.id,
        createdBy: ctx.user.id,
        title: input.title,
        clientName: input.clientName,
        clientEmail: input.clientEmail || null,
        clientWebsite: input.clientWebsite || null,
        orgAbbr: input.orgAbbr || null,
        contactId: links.contactId,
        accountId: links.accountId,
        linkedOpportunityId: links.linkedOpportunityId,
        projectType: input.projectType || null,
        // Days picked as dates (R29): a deadline lasts its whole day in the
        // workspace's zone; a completion date is a day on the calendar.
        rfpDeadline: deadlineFrom(input.rfpDeadline, tz),
        completionDate: calendarDayFrom(input.completionDate),
        budget: input.budget != null ? String(input.budget) : null,
        description: input.description || null,
        requirements: input.requirements ?? [],
        expiresAt: deadlineFrom(input.expiresAt, tz),
        status: "draft",
      });
      return { id: (result as any).insertId as number };
    }),

  /** Update proposal metadata (title, client info, dates, etc.). */
  update: repProcedure
    .input(
      z.object({
        id: z.number(),
        title: z.string().min(1).optional(),
        clientName: z.string().optional(),
        clientEmail: z.string().optional(),
        clientWebsite: z.string().optional(),
        orgAbbr: z.string().optional(),
        contactId: z.number().nullable().optional(),
        accountId: z.number().nullable().optional(),
        projectType: z.string().optional(),
        rfpDeadline: z.string().nullable().optional(),
        completionDate: z.string().nullable().optional(),
        budget: z.number().nullable().optional(),
        description: z.string().optional(),
        requirements: z.array(z.string()).optional(),
        expiresAt: z.string().nullable().optional(),
        skipAutoExtend: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      await getProposalOrThrow(db, input.id, ctx.workspace.id);
      // The contact and company it links to are this workspace's (audit
      // 2026-10-20, X1.1): create checked them (proposalLinks), update stored
      // whatever ids it was sent. Null clears a link, as before.
      await assertRowInWorkspace(db, "contact", input.contactId, ctx.workspace.id);
      await assertRowInWorkspace(db, "account", input.accountId, ctx.workspace.id);
      const { id, rfpDeadline, completionDate, budget, expiresAt, skipAutoExtend, ...rest } = input;
      const patch: Record<string, unknown> = { ...rest };
      if (rfpDeadline !== undefined) patch.rfpDeadline = rfpDeadline ? new Date(rfpDeadline) : null;
      if (completionDate !== undefined)
        patch.completionDate = completionDate ? new Date(completionDate) : null;
      if (budget !== undefined) patch.budget = budget != null ? String(budget) : null;
      if (expiresAt !== undefined) patch.expiresAt = deadlineFrom(expiresAt, await getWorkspaceTimezone(ctx.workspace.id));
      if (skipAutoExtend !== undefined) patch.skipAutoExtend = skipAutoExtend;
      await db.update(proposals).set(patch).where(eq(proposals.id, id));
      // Sync budget to linked opportunity if budget changed
      if (budget !== undefined && budget != null) {
        const [updated] = await db
          .select({ linkedOpportunityId: proposals.linkedOpportunityId })
          .from(proposals)
          .where(eq(proposals.id, id))
          .limit(1);
        if (updated?.linkedOpportunityId) {
          await db
            .update(opportunities)
            .set({ value: String(budget), updatedAt: new Date() })
            .where(eq(opportunities.id, updated.linkedOpportunityId));
        }
      }
      // Log activity
      const changedFields = Object.keys(patch).filter((k) => k !== "updatedAt");
      if (changedFields.length > 0) {
        await logProposalActivity(db, {
          workspaceId: ctx.workspace.id,
          proposalId: id,
          actorUserId: ctx.user.id,
          actorName: ctx.user.name ?? undefined,
          subject: `Proposal updated`,
          body: `Fields changed: ${changedFields.join(", ")}`,
        });
      }
      return { ok: true };
    }),

  /** Transition proposal status. */
  updateStatus: repProcedure
    .input(
      z.object({
        id: z.number(),
        status: z.enum([
          "draft",
          "sent",
          "under_review",
          "accepted",
          "not_accepted",
          "revision_requested",
        ]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // "Accepted" is not a label: it closes the linked deal, raises the
      // follow-up and tells the owner. Setting it here skipped all of that
      // (audit 2026-10-20, R26) — acceptance goes through acceptProposal.
      if (input.status === "accepted") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Use Accept to accept a proposal — it closes the linked deal and creates the follow-up." });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      await getProposalOrThrow(db, input.id, ctx.workspace.id);
      const patch: Record<string, unknown> = { status: input.status };
      if (input.status === "sent") patch.sentAt = new Date();
      await db.update(proposals).set(patch).where(and(eq(proposals.id, input.id), eq(proposals.workspaceId, ctx.workspace.id)));
      await logProposalActivity(db, {
        workspaceId: ctx.workspace.id,
        proposalId: input.id,
        actorUserId: ctx.user.id,
        actorName: ctx.user.name ?? undefined,
        subject: `Status changed to "${input.status}"`,
      });
      return { ok: true };
    }),

  /** Upsert a content section (create or update). */
  updateSection: repProcedure
    .input(
      z.object({
        proposalId: z.number(),
        sectionKey: z.string(),
        content: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      assertContentEditable(await getProposalOrThrow(db, input.proposalId, ctx.workspace.id));
      // Try update first, then insert
      const existing = await db
        .select({ id: proposalSections.id })
        .from(proposalSections)
        .where(
          and(
            eq(proposalSections.proposalId, input.proposalId),
            eq(proposalSections.sectionKey, input.sectionKey),
          ),
        )
        .limit(1);
      if (existing[0]) {
        await db
          .update(proposalSections)
          .set({ content: input.content })
          .where(eq(proposalSections.id, existing[0].id));
      } else {
        await db.insert(proposalSections).values({
          proposalId: input.proposalId,
          sectionKey: input.sectionKey,
          content: input.content,
        });
      }
      return { ok: true };
    }),

  /** Upsert a milestone (create if no id, update if id provided). */
  upsertMilestone: repProcedure
    .input(
      z.object({
        proposalId: z.number(),
        id: z.number().optional(),
        name: z.string().min(1),
        milestoneDate: z.string().optional(),
        description: z.string().optional(),
        owner: z.enum(["lsi_media", "client", "both"]).default("lsi_media"),
        sortOrder: z.number().default(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      const values = {
        proposalId: input.proposalId,
        name: input.name,
        milestoneDate: calendarDayFrom(input.milestoneDate),
        description: input.description || null,
        owner: input.owner,
        sortOrder: input.sortOrder,
      };
      if (input.id) {
        await db
          .update(proposalMilestones)
          .set(values)
          // Tied to the proposal verified by getProposalOrThrow above. `input.id`
          // is its own caller-supplied id, so on its own it reached any
          // workspace's milestone — the same defect as deleteMilestone, in the
          // upsert. proposal_milestones has no workspaceId column, so the parent
          // is the only available scope (tsc is what caught the difference).
          .where(and(eq(proposalMilestones.id, input.id), eq(proposalMilestones.proposalId, input.proposalId)));
        return { id: input.id };
      } else {
        const [r] = await db.insert(proposalMilestones).values(values);
        return { id: (r as any).insertId as number };
      }
    }),

  /** Delete a milestone. */
  deleteMilestone: repProcedure
    .input(z.object({ proposalId: z.number(), milestoneId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      // ⚠️ Tied to the proposal that was just verified. `milestoneId` is its own
      // caller-supplied id, so on its own it reached any workspace's milestone —
      // and proposal_milestones has no workspaceId column, which makes the parent
      // the ONLY possible scope rather than a redundant one.
      await db
        .delete(proposalMilestones)
        .where(and(
          eq(proposalMilestones.id, input.milestoneId),
          eq(proposalMilestones.proposalId, input.proposalId),
        ));
      return { ok: true };
    }),

  /** Generate (or regenerate) a share token and return the share URL. */
  generateShareLink: repProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await getProposalOrThrow(db, input.id, ctx.workspace.id);
      const token = generateShareToken();
      await db.update(proposals).set({ shareToken: token }).where(and(eq(proposals.id, input.id), eq(proposals.workspaceId, ctx.workspace.id)));
      return { token };
    }),

  /**
   * Duplicate a proposal — copies metadata, all sections, and all milestones
   * into a new draft titled "{original title} (Copy)". Feedback is NOT copied.
   */
  duplicate: repProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const src = await getProposalOrThrow(db, input.id, ctx.workspace.id);

      // Insert the new proposal (reset status to draft, clear share/sent timestamps)
      const [newResult] = await db.insert(proposals).values({
        workspaceId: ctx.workspace.id,
        createdBy: ctx.user.id,
        title: `${src.title} (Copy)`,
        clientName: src.clientName,
        clientEmail: src.clientEmail,
        clientWebsite: src.clientWebsite,
        orgAbbr: src.orgAbbr,
        contactId: src.contactId,
        accountId: src.accountId,
        projectType: src.projectType,
        rfpDeadline: src.rfpDeadline,
        completionDate: src.completionDate,
        budget: src.budget,
        description: src.description,
        requirements: src.requirements ?? [],
        status: "draft",
        shareToken: null,
        sentAt: null,
        acceptedAt: null,
      });
      const newId = (newResult as any).insertId as number;

      // Copy sections
      const srcSections = await getSections(db, input.id);
      if (srcSections.length > 0) {
        await db.insert(proposalSections).values(
          srcSections.map((s) => ({
            proposalId: newId,
            sectionKey: s.sectionKey,
            content: s.content,
          })),
        );
      }

      // Copy milestones
      const srcMilestones = await getMilestones(db, input.id);
      if (srcMilestones.length > 0) {
        await db.insert(proposalMilestones).values(
          srcMilestones.map((m) => ({
            proposalId: newId,
            name: m.name,
            milestoneDate: m.milestoneDate,
            description: m.description,
            owner: m.owner,
            sortOrder: m.sortOrder,
          })),
        );
      }

      // Log activity
      await logProposalActivity(db, {
        workspaceId: ctx.workspace.id,
        proposalId: newId,
        actorUserId: ctx.user.id,
        actorName: ctx.user.name ?? undefined,
        // input is { id } here: this logged 'Proposal created: "undefined"' (X3.7, R91).
        subject: `Proposal duplicated from "${src.title}"`,
      });
      return { id: newId };
    }),

  /**
   * Send the proposal portal link to the client via email.
   * Ensures a share token exists (generates one if not), marks status as "sent",
   * and sends a branded email to clientEmail.
   */
  sendToClient: repProcedure
    .input(
      z.object({
        id: z.number(),
        /** Ignored since R92: every link is built from appUrl(). Kept so older clients still validate. */
        origin: z.string().url().optional(),
        /** Optional personal message to include in the email body. */
        message: z.string().optional(),
        /** Optional sending account ID to use (overrides workspace default). */
        sendingAccountId: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Pause all outbound holds person sends too (owner, 2026-10-06: "Block everything").
      await assertOutboundNotPaused(ctx.workspace.id);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const proposal = await getProposalOrThrow(db, input.id, ctx.workspace.id);

      if (!proposal.clientEmail) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This proposal has no client email address. Add one in the Overview tab first.",
        });
      }

      // The mailbox it goes from, from the same list, in the same order, as
      // the Send-from picker (audit 2026-10-20, R70). The picker read another
      // list, so "Auto (x)" could name a mailbox this never used, and a picked
      // mailbox that was disabled was swapped silently for the workspace SMTP.
      const senders = await proposalSenders(db, ctx.workspace.id);
      const sendingAcc = input.sendingAccountId != null
        ? senders.find((a) => a.id === input.sendingAccountId)
        : senders[0];
      if (input.sendingAccountId != null && !sendingAcc) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That mailbox is disabled or no longer in this workspace. Pick another under Send from." });
      }

      // Ensure a share token exists
      let token = proposal.shareToken;
      if (!token) {
        token = generateShareToken();
        await db.update(proposals).set({ shareToken: token }).where(and(eq(proposals.id, input.id), eq(proposals.workspaceId, ctx.workspace.id)));
      }

      const senderName = ctx.user.name ?? ctx.workspace.name;
      // Links from appUrl(), not the browser's origin, and every value escaped (R92).
      const { html: emailHtml, shareUrl } = proposalShareEmailHtml({
        token,
        workspaceName: ctx.workspace.name,
        senderName,
        clientName: proposal.clientName,
        orgAbbr: proposal.orgAbbr,
        title: proposal.title,
        message: input.message,
      });

      // ── Send email via team member's connected sending account (Unipile/SMTP) ──
      // Falls back to workspace SMTP config if no connected account is found.
      let emailOk = false;
      let senderEmail = "";
      const emailSubject = `${senderName} has shared a proposal with you: ${proposal.title}`;
      try {
        // The mailbox resolved above, before anything was written.
        if (sendingAcc) {
          const adapter = createEmailAdapter(sendingAcc);
          await adapter.sendEmail({
            fromEmail: sendingAcc.fromEmail,
            fromName: sendingAcc.fromName ?? senderName,
            to: proposal.clientEmail!,
            subject: emailSubject,
            bodyHtml: emailHtml,
            // Sitewide email log (migration 0163) — proposal mail kept no
            // record of its own.
            logMeta: {
              source: "proposal",
              sourceLabel: `Proposal #${proposal.id}`,
              userId: ctx.user.id,
            },
          });
          senderEmail = sendingAcc.fromEmail;
          emailOk = true;
        } else {
          // Fallback to workspace SMTP config
          const { sendWorkspaceEmail } = await import("../emailDelivery");
          const result = await sendWorkspaceEmail(ctx.workspace.id, {
            to: proposal.clientEmail!,
            subject: emailSubject,
            html: emailHtml,
            logSource: "proposal",
            logLabel: `Proposal #${proposal.id}`,
          });
          emailOk = result.ok;
        }
      } catch (_e) {
        // Non-fatal: mark as sent regardless
      }

      // A send moves a draft or a revision to Sent — nothing else (audit
      // 2026-10-20, R27): a resend set an ACCEPTED proposal back to Sent, even
      // when the email never went. sentAt records an actual delivery.
      if (proposal.status === "draft" || proposal.status === "revision_requested") {
        await db
          .update(proposals)
          .set({ status: "sent", sentAt: new Date() })
          .where(and(eq(proposals.id, input.id), eq(proposals.workspaceId, ctx.workspace.id), inArray(proposals.status, ["draft", "revision_requested"])));
      } else if (emailOk) {
        await db
          .update(proposals)
          .set({ sentAt: new Date() })
          .where(and(eq(proposals.id, input.id), eq(proposals.workspaceId, ctx.workspace.id)));
      }

      const deliveryNote = emailOk
        ? `Email sent to ${proposal.clientEmail}${senderEmail ? ` from ${senderEmail}` : ""}`
        : "Proposal marked as sent. Connect an email account in My Mailbox or configure SMTP in Settings → Email Delivery.";
      await logProposalActivity(db, {
        workspaceId: ctx.workspace.id,
        proposalId: input.id,
        actorUserId: ctx.user.id,
        actorName: ctx.user.name ?? undefined,
        subject: `Proposal sent to ${proposal.clientEmail}`,
        body: emailOk
          ? `Email delivered${senderEmail ? ` from ${senderEmail}` : ""}.`
          : "Proposal marked as sent. Email delivery pending SMTP/account configuration.",
      });
      return { ok: true, emailSent: emailOk, shareUrl, deliveryNote, senderEmail };
    }),
  /**
   * Accept a proposal internally (rep+). Marks status=accepted, creates a
   * follow-up task, and sends an in-app notification to the workspace owner.
   */
  acceptProposal: repProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const proposal = await getProposalOrThrow(db, input.id, ctx.workspace.id);
      // Mark accepted — once. A double click ran every side effect twice: two
      // follow-up tasks, two notices, two deal-won fires (audit 2026-10-20, R24).
      const claim = await db
        .update(proposals)
        .set({ status: "accepted", acceptedAt: new Date() })
        .where(and(eq(proposals.id, input.id), eq(proposals.workspaceId, ctx.workspace.id), ne(proposals.status, "accepted")));
      if (Number((claim as any)?.[0]?.affectedRows ?? 0) !== 1) {
        return { ok: true, alreadyAccepted: true, opportunityId: proposal.linkedOpportunityId ?? null, taskId: null };
      }
      await snapshotAcceptedSections(db, input.id, ctx.user.id);
      await acceptCurrentPricing(db, ctx.workspace.id, input.id);
      // Create follow-up task
      const taskTitle = `Follow up: ${proposal.title} — accepted by ${proposal.clientName}`;
      const taskResult = await db.insert(tasks).values({
        workspaceId: ctx.workspace.id,
        title: taskTitle,
        description: `Proposal "${proposal.title}" was accepted. Schedule a kickoff meeting and send the contract.`,
        type: "follow_up",
        priority: "high",
        status: "open",
        ownerUserId: ctx.user.id,
        relatedType: "proposal",
        relatedId: input.id,
        dueAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days from now
      });
      const taskId = Number((taskResult as any)[0]?.insertId ?? 0);
      // Notify workspace owner (if different from current user)
      const ownerUserId = await workspaceNotifyUserId(ctx.workspace.id);
      if (ownerUserId && ownerUserId !== ctx.user.id) {
        await db.insert(notifications).values({
          workspaceId: ctx.workspace.id,
          userId: ownerUserId,
          kind: "deal_won",
          title: `Proposal accepted: ${proposal.title}`,
          body: `${proposal.clientName} accepted the proposal. A follow-up task has been created.`,
          relatedType: "proposal",
          relatedId: input.id,
        });
      }
      // ── Auto-create or update Pipeline opportunity ──
      // A LINKED deal is closed won whether or not the proposal carries an
      // account (audit 2026-10-20, R25): the wizard sent none, so accepting a
      // proposal made in the UI left its deal open. It now sends the company,
      // the contact and the deal the rep picked. The move goes
      // through the one stage-change service (R21), which also makes a
      // repeated accept a no-op for the deal.
      let opportunityId = proposal.linkedOpportunityId ?? null;
      const oppValue = proposal.budget ? String(proposal.budget) : "0";
      if (opportunityId) {
        // A deal already closed is left as it is, value and all.
        const existingOpp = await openLinkedDeal(db, ctx.workspace.id, opportunityId);
        if (existingOpp) {
          // The workspace's OWN won stage: the literal "won" parked the deal in
          // a key a custom pipeline has no column for.
          const wonStage = await canonicalWonStageKey(db, ctx.workspace.id, existingOpp.pipelineId ?? null);
          await changeOpportunityStage(db, {
            workspaceId: ctx.workspace.id,
            opportunityId,
            toStage: wonStage,
            actorUserId: ctx.user.id,
            actorName: ctx.user.name ?? null,
            source: "proposal",
            note: `Proposal "${proposal.title}" accepted`,
            alsoSet: { value: oppValue },
          });
        }
      } else if (proposal.accountId) {
        // Create a new opportunity already in the won stage. No stage move to
        // report; the dates say when it was won.
        const wonStage = await canonicalWonStageKey(db, ctx.workspace.id, null);
        const now = new Date();
        const oppResult = await db.insert(opportunities).values({
          workspaceId: ctx.workspace.id,
          accountId: proposal.accountId,
          name: proposal.title,
          stage: wonStage,
          value: oppValue,
          winProb: 100,
          ownerUserId: ctx.user.id,
          closeDate: now,
          stageEnteredAt: now,
          wonAt: now,
          nextStep: `Kickoff: follow up on accepted proposal "${proposal.title}"`,
        } as never);
        opportunityId = Number((oppResult as any)[0]?.insertId ?? 0) || null;
        // Link the opportunity back to the proposal
        if (opportunityId) {
          await db
            .update(proposals)
            .set({ linkedOpportunityId: opportunityId })
            .where(and(eq(proposals.id, input.id), eq(proposals.workspaceId, ctx.workspace.id)));
        }
        try {
          await ensureCustomerForWonOpp(db, ctx.workspace.id, { accountId: proposal.accountId, value: oppValue, ownerUserId: ctx.user.id }, ctx.user.id);
        } catch (e) {
          console.warn("[proposals.acceptProposal] closed-won customer creation failed:", e);
        }
      }
      await logProposalActivity(db, {
        workspaceId: ctx.workspace.id,
        proposalId: input.id,
        actorUserId: ctx.user.id,
        actorName: ctx.user.name ?? undefined,
        subject: `Proposal accepted`,
        body: `Accepted internally by ${ctx.user.name ?? "a team member"}.`,
      });
      return { ok: true, taskId, opportunityId };
    }),
  /** Delete a proposal (manager+ only). */
  delete: managerProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await getProposalOrThrow(db, input.id, ctx.workspace.id);
      await db.delete(proposalMilestones).where(eq(proposalMilestones.proposalId, input.id));
      await db.delete(proposalSections).where(eq(proposalSections.proposalId, input.id));
      await db.delete(proposalFeedback).where(eq(proposalFeedback.proposalId, input.id));
      // Its pricing versions are part of it (F34): the quotes and their lines go too.
      const pricing = await db.select({ id: quotes.id }).from(quotes)
        .where(and(eq(quotes.workspaceId, ctx.workspace.id), eq(quotes.proposalId, input.id)));
      if (pricing.length > 0) {
        await db.delete(quoteLineItems).where(and(eq(quoteLineItems.workspaceId, ctx.workspace.id), inArray(quoteLineItems.quoteId, pricing.map((q) => q.id))));
        await db.delete(quotes).where(and(eq(quotes.workspaceId, ctx.workspace.id), eq(quotes.proposalId, input.id)));
      }
      await db.delete(proposals).where(and(eq(proposals.id, input.id), eq(proposals.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  // ── AI content generation ─────────────────────────────────────────────────

  /** Generate content for a specific section using the LLM. */
  generateSectionContent: repProcedure
    .input(
      z.object({
        proposalId: z.number(),
        sectionKey: z.string(),
        context: z.object({
          clientName: z.string(),
          orgAbbr: z.string().optional(),
          projectType: z.string().optional(),
          description: z.string().optional(),
          budget: z.number().optional(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      const sectionLabel =
        SECTION_LABELS[input.sectionKey as SectionKey] ?? input.sectionKey;
      const { clientName, orgAbbr, projectType, description, budget } = input.context;
      const systemPrompt = `You are an expert proposal writer for ${ctx.workspace.name}. Write compelling, professional proposal content in clear, concise prose. Use markdown formatting (headers, bullets where appropriate). Do not include placeholder text — write real, polished content.`;
      const userPrompt = `Write the "${sectionLabel}" section for a proposal to ${clientName}${orgAbbr ? ` (${orgAbbr})` : ""}.
${projectType ? `Project type: ${projectType}` : ""}
${description ? `Project description: ${description}` : ""}
${budget ? `Budget: $${budget.toLocaleString()}` : ""}

Write 2-4 paragraphs of professional proposal content for this section. Be specific and persuasive.`;
      const response = await invokeLLM({
        sendersBrand: true,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        // The client's market research, through the proposal's contact, account or client email.
        research: await researchUseForProposal(ctx.workspace.id, input.proposalId),
      });
      const content =
        (response as any)?.choices?.[0]?.message?.content ?? "Content generation failed.";
      return { content };
    }),

  // ── Public procedures (no auth required) ─────────────────────────────────

  /** Get proposal by share token — public, for client portal. */
  getByShareToken: publicProcedure
    .input(z.object({ token: z.string().min(1).max(128) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rows = await db
        .select()
        .from(proposals)
        .where(eq(proposals.shareToken, input.token))
        .limit(1);
      // A draft is not served, and says what an unknown link says (G40).
      if (!rows[0] || !servedOnPortal(rows[0].status)) throw new TRPCError({ code: "NOT_FOUND", message: PORTAL_UNAVAILABLE });
      const proposal = rows[0];
      const [sections, milestones, pricing] = await Promise.all([
        getSections(db, proposal.id),
        getMilestones(db, proposal.id),
        currentPricing(db, proposal.workspaceId, proposal.id),
      ]);
      // The fields the portal shows, not the internal row (R67); the pricing
      // section is the current quote version's table (F34).
      return { proposal: portalView(proposal), sections: sections.map(portalSection), milestones: milestones.map(portalMilestone), pricing: portalPricing(pricing) };
    }),

  /**
   * The portal was opened (audit 2026-10-20, F48): first and last viewed and
   * a view count, shown to the team on the proposal. Nothing about the viewer
   * is kept — no address, no browser — only when. Reopening within
   * PORTAL_VIEW_GAP_MS is the same visit, so a refresh does not count twice,
   * and a signed-in member of the proposal's own workspace (a rep checking
   * the link) is not counted at all. A draft or unknown link records nothing.
   */
  recordView: publicProcedure
    .input(z.object({ token: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [p] = await db.select({ id: proposals.id, workspaceId: proposals.workspaceId, status: proposals.status })
        .from(proposals).where(eq(proposals.shareToken, input.token)).limit(1);
      if (!p || !servedOnPortal(p.status)) return { counted: false };
      if (ctx.user) {
        const [m] = await db.select({ id: workspaceMembers.id }).from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, p.workspaceId), eq(workspaceMembers.userId, ctx.user.id))).limit(1);
        if (m) return { counted: false };
      }
      const now = new Date();
      const visit = await db.update(proposals)
        .set({
          portalViewCount: sql`${proposals.portalViewCount} + 1`,
          portalFirstViewedAt: sql`COALESCE(${proposals.portalFirstViewedAt}, ${now})`,
          portalLastViewedAt: now,
        } as never)
        .where(and(
          eq(proposals.id, p.id),
          or(isNull(proposals.portalLastViewedAt), lt(proposals.portalLastViewedAt, new Date(now.getTime() - PORTAL_VIEW_GAP_MS))),
        ));
      if (Number((visit as any)?.[0]?.affectedRows ?? 0) === 1) return { counted: true };
      // The same visit: only the last-viewed time moves.
      await db.update(proposals).set({ portalLastViewedAt: now } as never).where(eq(proposals.id, p.id));
      return { counted: false };
    }),

  /** Submit client feedback — public. */
  submitFeedback: publicProcedure
    .input(
      // Capped (G40): a public write a stranger can repeat.
      z.object({
        token: z.string().min(1).max(128),
        authorName: z.string().trim().min(1).max(200),
        authorEmail: z.string().email().max(320).optional().or(z.literal("")),
        message: z.string().trim().min(1).max(5000),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rows = await db
        .select({ id: proposals.id, status: proposals.status })
        .from(proposals)
        .where(eq(proposals.shareToken, input.token))
        .limit(1);
      if (!rows[0] || !servedOnPortal(rows[0].status)) throw new TRPCError({ code: "NOT_FOUND", message: PORTAL_UNAVAILABLE });
      await db.insert(proposalFeedback).values({
        proposalId: rows[0].id,
        authorName: input.authorName,
        authorEmail: input.authorEmail || null,
        message: input.message,
      });
      // Also update status to under_review if it was sent
      await db
        .update(proposals)
        .set({ status: "under_review" })
        .where(
          and(
            eq(proposals.id, rows[0].id),
            eq(proposals.status, "sent"),
          ),
        );
      return { ok: true };
    }),
  /**
   * Accept proposal by share token — public, for the client portal.
   * Marks status=accepted, creates a follow-up task for the workspace owner,
   * and sends an in-app notification to the workspace owner.
   */
  acceptByToken: publicProcedure
    .input(z.object({
      token: z.string().min(1).max(128),
      /** Legacy name for signerName, from portals loaded before G18. */
      clientName: z.string().max(200).optional(),
      /** The name the person accepting typed (G18). */
      signerName: z.string().trim().max(200).optional(),
      signerEmail: z.string().email().max(320).optional().or(z.literal("")),
      /** Their browser's IANA time zone, for the record. */
      timeZone: z.string().max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rows = await db
        .select()
        .from(proposals)
        .where(eq(proposals.shareToken, input.token))
        .limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
      const proposal = rows[0];
      // Idempotent: if already accepted, return ok
      if (proposal.status === "accepted") return { ok: true, alreadyAccepted: true };
      // Only a proposal that is out with the client, and not expired, can be
      // accepted (audit 2026-10-20, R24): drafts, declined and expired ones
      // were accepted from the link, and a double click ran every side effect
      // twice. The update names the states it accepts from, so of two clicks
      // one lands.
      //
      // The e-signature record (audit 2026-10-20, F48) is written by that same
      // update, so it is the winning click's: the name typed, the email given,
      // the server's time and the address the request came from. It is shown
      // on the proposal; the timeline keeps the fuller record below.
      const signerName = (input.signerName || input.clientName || "").trim().slice(0, 200) || null;
      const signerEmail = (input.signerEmail || "").trim().slice(0, 320) || null;
      const signerIp = (ctx.req ? clientIpOf(ctx.req as never) : null)?.slice(0, 64) || null;
      const claim = await db
        .update(proposals)
        .set({ status: "accepted", acceptedAt: new Date(), acceptedSignerName: signerName, acceptedSignerEmail: signerEmail, acceptedIp: signerIp })
        .where(and(
          eq(proposals.id, proposal.id),
          inArray(proposals.status, ACCEPTABLE_STATUSES),
          or(isNull(proposals.expiresAt), gt(proposals.expiresAt, new Date())),
        ));
      if (Number((claim as any)?.[0]?.affectedRows ?? 0) !== 1) {
        const [now] = await db.select({ status: proposals.status, expiresAt: proposals.expiresAt }).from(proposals).where(eq(proposals.id, proposal.id)).limit(1);
        if (now?.status === "accepted") return { ok: true, alreadyAccepted: true };
        if (now?.expiresAt && new Date(now.expiresAt).getTime() <= Date.now()) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This proposal has expired. Request an extension and the team will get back to you." });
        }
        throw new TRPCError({ code: "BAD_REQUEST", message: "This proposal is not open for acceptance. Contact the team that sent it." });
      }
      await snapshotAcceptedSections(db, proposal.id, null);
      await acceptCurrentPricing(db, proposal.workspaceId, proposal.id);
      /**
       * Who accepted (audit 2026-10-20, G18). Written only by the click that
       * won the claim above, so a double click records one acceptance.
       */
      const signer = signerName;
      await logProposalActivity(db, {
        workspaceId: proposal.workspaceId,
        proposalId: proposal.id,
        subject: signer ? `Accepted by ${signer} on the client portal`.slice(0, 240) : "Accepted on the client portal",
        body: acceptanceRecord({
          signerName: signer,
          signerEmail,
          ip: signerIp,
          userAgent: String((ctx.req as { headers?: Record<string, unknown> } | undefined)?.headers?.["user-agent"] ?? "") || null,
          timeZone: input.timeZone ?? null,
          at: new Date(),
        }),
      });
      /**
       * PUBLIC PATH — the client accepts from a share link, with no session.
       * The resulting follow-up task is the only thing that tells the business
       * a deal just closed, and it was addressed to a raw `ownerUserId`. If
       * that person had left, the acceptance landed in nobody's queue.
       */
      const ownerUserId = await workspaceNotifyUserId(proposal.workspaceId);
      if (ownerUserId) {
        // Create follow-up task for owner
        await db.insert(tasks).values({
          workspaceId: proposal.workspaceId,
          title: `Follow up: ${proposal.title} — accepted by ${signer ?? proposal.clientName}`.slice(0, 240),
          description: `${signer ? `${signer} (${proposal.clientName})` : `Client ${proposal.clientName}`} accepted the proposal via the client portal. Schedule a kickoff meeting and send the contract.`,
          type: "follow_up",
          priority: "high",
          status: "open",
          ownerUserId,
          relatedType: "proposal",
          relatedId: proposal.id,
          dueAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        });
        // In-app notification
        await db.insert(notifications).values({
          workspaceId: proposal.workspaceId,
          userId: ownerUserId,
          kind: "deal_won",
          title: `Proposal accepted: ${proposal.title}`,
          body: `${proposal.clientName} accepted the proposal via the client portal. A follow-up task has been created.`,
          relatedType: "proposal",
          relatedId: proposal.id,
        });
      }
      // ── Auto-create Pipeline opportunity ──
      // A linked deal is closed won whether or not the proposal has an account
      // (R25), through the one stage-change service (R21).
      let opportunityId = proposal.linkedOpportunityId ?? null;
      const oppValue = proposal.budget ? String(proposal.budget) : "0";
      if (opportunityId) {
        const existingOpp = await openLinkedDeal(db, proposal.workspaceId, opportunityId);
        if (existingOpp) {
          const wonStage = await canonicalWonStageKey(db, proposal.workspaceId, existingOpp.pipelineId ?? null);
          await changeOpportunityStage(db, {
            workspaceId: proposal.workspaceId,
            opportunityId,
            toStage: wonStage,
            actorUserId: null,
            actorName: proposal.clientName ?? null,
            source: "proposal_portal",
            note: `Proposal "${proposal.title}" accepted on the client portal`,
            alsoSet: { value: oppValue },
          });
        }
      } else if (proposal.accountId) {
        const wonStage = await canonicalWonStageKey(db, proposal.workspaceId, null);
        const now = new Date();
        const oppResult = await db.insert(opportunities).values({
          workspaceId: proposal.workspaceId,
          accountId: proposal.accountId,
          name: proposal.title,
          stage: wonStage,
          value: oppValue,
          winProb: 100,
          ownerUserId: ownerUserId ?? undefined,
          closeDate: now,
          stageEnteredAt: now,
          wonAt: now,
          nextStep: `Kickoff: ${proposal.clientName} accepted the proposal via client portal.`,
        } as never);
        opportunityId = Number((oppResult as any)[0]?.insertId ?? 0) || null;
        if (opportunityId) {
          await db
            .update(proposals)
            .set({ linkedOpportunityId: opportunityId })
            .where(eq(proposals.id, proposal.id));
        }
        // cmUserId falls back to the caller, and this path has no session —
        // so the customer is only created when the workspace still has an
        // active member to own it.
        if (ownerUserId) {
          try {
            await ensureCustomerForWonOpp(db, proposal.workspaceId, { accountId: proposal.accountId, value: oppValue, ownerUserId }, ownerUserId);
          } catch (e) {
            console.warn("[proposals.acceptByToken] closed-won customer creation failed:", e);
          }
        }
      }
      return { ok: true, alreadyAccepted: false, opportunityId };
    }),

  /**
   * Decline by share token — public, the portal's other answer (audit
   * 2026-10-20, G70: a client could accept or say nothing). Marks the
   * proposal not accepted, records who declined and why, and tells the team
   * the way acceptance does: a notification to the workspace's standing
   * recipient and an activity on the proposal. A linked deal is left where it
   * is (a rep decides whether a "no" loses it). Only a proposal that is out
   * with the client can be declined, and of two clicks one lands.
   */
  declineByToken: publicProcedure
    .input(z.object({
      token: z.string().min(1).max(128),
      signerName: z.string().trim().max(200).optional(),
      reason: z.string().trim().max(2000).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [proposal] = await db.select().from(proposals).where(eq(proposals.shareToken, input.token)).limit(1);
      if (!proposal || !servedOnPortal(proposal.status)) throw new TRPCError({ code: "NOT_FOUND", message: PORTAL_UNAVAILABLE });
      if (proposal.status === "not_accepted") return { ok: true, alreadyDeclined: true };
      const claim = await db
        .update(proposals)
        .set({ status: "not_accepted" })
        .where(and(eq(proposals.id, proposal.id), inArray(proposals.status, ACCEPTABLE_STATUSES)));
      if (Number((claim as any)?.[0]?.affectedRows ?? 0) !== 1) {
        const [now] = await db.select({ status: proposals.status }).from(proposals).where(eq(proposals.id, proposal.id)).limit(1);
        if (now?.status === "not_accepted") return { ok: true, alreadyDeclined: true };
        throw new TRPCError({ code: "BAD_REQUEST", message: "This proposal can no longer be declined here. Contact the team that sent it." });
      }
      const who = (input.signerName || "").trim() || proposal.clientName || "The client";
      const reason = (input.reason || "").trim();
      await logProposalActivity(db, {
        workspaceId: proposal.workspaceId,
        proposalId: proposal.id,
        subject: `Declined by ${who} on the client portal`.slice(0, 240),
        body: reason ? `Reason given: ${reason}` : "No reason given.",
      });
      const ownerUserId = await workspaceNotifyUserId(proposal.workspaceId);
      if (ownerUserId) {
        await db.insert(notifications).values({
          workspaceId: proposal.workspaceId,
          userId: ownerUserId,
          kind: "system",
          title: `Proposal declined: ${proposal.title}`.slice(0, 240),
          body: `${who} declined the proposal on the client portal.${reason ? ` Reason: ${reason.slice(0, 500)}` : ""}`,
          relatedType: "proposal",
          relatedId: proposal.id,
        });
      }
      return { ok: true, alreadyDeclined: false };
    }),
  // ── Proposal revision history ─────────────────────────────────────────────
  /**
   * Restore a past revision back into the live section content.
   * Also snapshots a new revision tagged as "restored from revision #N".
   */
  restoreRevision: repProcedure
    .input(z.object({ revisionId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      // Load the revision
      const [rev] = await db
        .select()
        .from(proposalRevisions)
        .where(eq(proposalRevisions.id, input.revisionId))
        .limit(1);
      if (!rev) throw new TRPCError({ code: "NOT_FOUND", message: "Revision not found" });
      // Verify the proposal belongs to this workspace, and is not locked (R69)
      assertContentEditable(await getProposalOrThrow(db, rev.proposalId, ctx.workspace.id));
      // Upsert the section content (same pattern as updateSection)
      const existing = await db
        .select({ id: proposalSections.id })
        .from(proposalSections)
        .where(and(eq(proposalSections.proposalId, rev.proposalId), eq(proposalSections.sectionKey, rev.sectionKey)))
        .limit(1);
      if (existing[0]) {
        await db
          .update(proposalSections)
          .set({ content: rev.content })
          .where(eq(proposalSections.id, existing[0].id));
      } else {
        await db.insert(proposalSections).values({
          proposalId: rev.proposalId,
          sectionKey: rev.sectionKey,
          content: rev.content,
        });
      }
      // Snapshot a new revision tagged as a restore
      await db.insert(proposalRevisions).values({
        proposalId: rev.proposalId,
        sectionKey: rev.sectionKey,
        content: rev.content,
        savedByUserId: ctx.user.id,
        savedByName: `${ctx.user.name ?? "User"} (restored from revision #${rev.id})`,
      });
      return { ok: true, sectionKey: rev.sectionKey, content: rev.content };
    }),
  /**
   * Create an OPEN deal for this proposal and link it (audit 2026-10-20,
   * R26). "Create & Link" called acceptProposal, so creating a deal for a
   * proposal still being written marked it accepted and the deal won.
   */
  createOpportunity: repProcedure
    .input(z.object({ proposalId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const proposal = await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      if (proposal.linkedOpportunityId) {
        throw new TRPCError({ code: "CONFLICT", message: "This proposal already has a linked deal." });
      }
      // A deal belongs to a company: the proposal's, else its contact's.
      let accountId = proposal.accountId ?? null;
      if (!accountId && proposal.contactId) {
        const [c] = await db.select({ accountId: contacts.accountId }).from(contacts)
          .where(and(eq(contacts.id, proposal.contactId), eq(contacts.workspaceId, ctx.workspace.id))).limit(1);
        accountId = c?.accountId ?? null;
      }
      if (!accountId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Link the proposal to a company (or a contact at one) first — a deal belongs to a company." });
      }
      const stages = await stageResolver(db, ctx.workspace.id);
      const pipelineId = await defaultPipelineId(db, ctx.workspace.id);
      const key = stages.allowedKeys(pipelineId).find((k) => { const m = stages.resolve(pipelineId, k); return !m.isWon && !m.isLost; });
      if (!key) throw new TRPCError({ code: "BAD_REQUEST", message: "The default pipeline has no open stage to put the deal in." });
      const meta = stages.resolve(pipelineId, key);
      const r = await db.insert(opportunities).values({
        workspaceId: ctx.workspace.id, accountId, pipelineId, name: proposal.title.slice(0, 200), stage: key,
        value: proposal.budget ? String(proposal.budget) : "0", winProb: meta.defaultWinProb ?? 20, ownerUserId: ctx.user.id,
        ...stageDatesForNewDeal(meta),
      } as never);
      const opportunityId = Number((r as any)[0]?.insertId ?? 0);
      await db.update(proposals).set({ linkedOpportunityId: opportunityId })
        .where(and(eq(proposals.id, proposal.id), eq(proposals.workspaceId, ctx.workspace.id)));
      await logProposalActivity(db, {
        workspaceId: ctx.workspace.id, proposalId: proposal.id, actorUserId: ctx.user.id, actorName: ctx.user.name ?? undefined,
        subject: `Deal created and linked (#${opportunityId})`,
      });
      return { opportunityId };
    }),

  /**
   * Link or unlink an existing opportunity to a proposal.
   * Pass opportunityId=null to unlink.
   */
  linkOpportunity: repProcedure
    .input(z.object({
      proposalId: z.number(),
      opportunityId: z.number().nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      if (input.opportunityId !== null) {
        const [opp] = await db
          .select({ id: opportunities.id })
          .from(opportunities)
          .where(and(eq(opportunities.id, input.opportunityId), eq(opportunities.workspaceId, ctx.workspace.id)))
          .limit(1);
        if (!opp) throw new TRPCError({ code: "NOT_FOUND", message: "Opportunity not found" });
      }
      await db
        .update(proposals)
        .set({ linkedOpportunityId: input.opportunityId })
        .where(and(eq(proposals.id, input.proposalId), eq(proposals.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  // ── Pricing: the quote is the proposal's pricing section (F34, F36) ───────

  /**
   * The proposal's pricing: the current quote version with its lines, every
   * version (newest first) for the history, and the linked deal's value so
   * the page can say whether saving would change it.
   */
  pricing: workspaceProcedure
    .input(z.object({ proposalId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const proposal = await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      const current = await currentPricing(db, ctx.workspace.id, proposal.id);
      const versions = await db.select({
        id: quotes.id, version: quotes.version, total: quotes.total, status: quotes.status, quoteNumber: quotes.quoteNumber,
        createdAt: quotes.createdAt, createdByUserId: quotes.createdByUserId, supersededAt: quotes.supersededAt, pdfUrl: quotes.pdfUrl,
      }).from(quotes)
        .where(and(eq(quotes.workspaceId, ctx.workspace.id), eq(quotes.proposalId, proposal.id)))
        .orderBy(desc(quotes.version), desc(quotes.id));
      let dealValue: string | null = null;
      if (proposal.linkedOpportunityId) {
        const [opp] = await db.select({ value: opportunities.value }).from(opportunities)
          .where(and(eq(opportunities.id, proposal.linkedOpportunityId), eq(opportunities.workspaceId, ctx.workspace.id))).limit(1);
        dealValue = opp ? String(opp.value) : null;
      }
      return { current, versions, linkedOpportunityId: proposal.linkedOpportunityId ?? null, dealValue, locked: proposal.status === "accepted" };
    }),

  /**
   * A pricing change: a new quote version for the proposal (the one it
   * replaces is kept, superseded), which becomes the proposal's price. The
   * linked deal's value moves to the new total only when `setDealValue` —
   * the page asks first, naming both amounts. An accepted proposal's pricing
   * is what the client agreed to, so it is not changed here.
   */
  savePricing: repProcedure
    .input(z.object({
      proposalId: z.number(),
      lineItems: z.array(z.object({
        productId: z.number().optional(),
        name: z.string().trim().min(1).max(200),
        description: z.string().max(2000).optional(),
        quantity: z.number().int().min(1).max(1_000_000),
        unitPrice: z.number().min(0).max(1e10),
        discountPct: z.number().min(0).max(100).default(0),
      })).min(1).max(200),
      notes: z.string().max(5000).optional(),
      terms: z.string().max(10000).optional(),
      expiresInDays: z.number().int().min(1).max(180).default(30),
      setDealValue: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const proposal = await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      if (proposal.status === "accepted") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This proposal was accepted; its pricing is what the client agreed to. Duplicate it to price a new version." });
      }
      if (!proposal.linkedOpportunityId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Link this proposal to a deal first: its pricing sets the deal's value." });
      }
      const [opp] = await db.select({ id: opportunities.id, name: opportunities.name, stage: opportunities.stage, value: opportunities.value })
        .from(opportunities).where(and(eq(opportunities.id, proposal.linkedOpportunityId), eq(opportunities.workspaceId, ctx.workspace.id))).limit(1);
      if (!opp) throw new TRPCError({ code: "BAD_REQUEST", message: "The deal this proposal is linked to is gone. Link it to a deal first." });
      // A line's product, when it names one, is this workspace's (X1.1).
      const productIds = input.lineItems.map((l) => l.productId).filter((id): id is number => typeof id === "number");
      if (productIds.length > 0) {
        const found = await db.select({ id: products.id }).from(products).where(and(eq(products.workspaceId, ctx.workspace.id), inArray(products.id, productIds)));
        if (new Set(found.map((p) => p.id)).size !== new Set(productIds).size) throw new TRPCError({ code: "NOT_FOUND", message: "A product on this pricing is not in this workspace." });
      }
      const v = await writePricingVersion(db, {
        workspaceId: ctx.workspace.id, proposalId: proposal.id, opportunityId: opp.id, actorUserId: ctx.user.id,
        lineItems: input.lineItems, notes: input.notes?.trim() || null, terms: input.terms?.trim() || null, expiresInDays: input.expiresInDays,
      });
      // The proposal's price is its pricing section's total: one document.
      await db.update(proposals).set({ budget: v.total }).where(and(eq(proposals.id, proposal.id), eq(proposals.workspaceId, ctx.workspace.id)));
      let dealValueChanged = false;
      if (input.setDealValue && Number(opp.value ?? 0) !== Number(v.total)) {
        await db.update(opportunities).set({ value: v.total } as never)
          .where(and(eq(opportunities.id, opp.id), eq(opportunities.workspaceId, ctx.workspace.id)));
        // A large move of the amount is an alert, as on any other write (R38).
        const { noteAmountChange } = await import("./pipelineAlerts");
        await noteAmountChange(db, ctx.workspace.id, opp, Number(opp.value ?? 0), Number(v.total));
        await recordAudit({
          workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "opportunity", entityId: opp.id,
          before: { value: opp.value }, after: { value: v.total, source: "proposal_pricing", proposalId: proposal.id, version: v.version },
        });
        dealValueChanged = true;
      }
      await logProposalActivity(db, {
        workspaceId: ctx.workspace.id,
        proposalId: proposal.id,
        actorUserId: ctx.user.id,
        actorName: ctx.user.name ?? undefined,
        subject: `Pricing version ${v.version} saved`,
        body: `Total ${v.total}.${dealValueChanged ? ` The deal's value was set to it (was ${opp.value}).` : " The deal's value was left as it was."}`,
      });
      return { quoteId: v.quoteId, version: v.version, total: v.total, dealValueChanged };
    }),

  /**
   * A company's OPEN deals, for the new-proposal wizard's "Deal" picker (R25).
   * Closed ones are left out: accepting never moves them.
   */
  dealOptions: workspaceProcedure
    .input(z.object({ accountId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const rows = await db
        .select({ id: opportunities.id, name: opportunities.name, stage: opportunities.stage, value: opportunities.value, pipelineId: opportunities.pipelineId })
        .from(opportunities)
        .where(and(eq(opportunities.workspaceId, ctx.workspace.id), eq(opportunities.accountId, input.accountId)))
        .orderBy(desc(opportunities.updatedAt));
      const stages = await stageResolver(db, ctx.workspace.id);
      return rows
        .filter((o) => { const m = stages.resolve(o.pipelineId ?? null, o.stage); return !m.isWon && !m.isLost; })
        .map(({ pipelineId: _p, ...o }) => o);
    }),

  /**
   * List enabled sending accounts for the workspace (used by the account picker in Send to Client).
   */
  listSendingAccounts: repProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      // The send's own list and order (R70): the first row is the one "Auto" uses.
      const rows = await proposalSenders(db, ctx.workspace.id);
      return rows.map((a) => ({ id: a.id, name: a.name, fromEmail: a.fromEmail, fromName: a.fromName, provider: a.provider }));
    }),
  /**
   * Snapshot the current content of a section into proposal_revisions.
   * Called automatically when a section is saved.
   */
  saveRevision: repProcedure
    .input(z.object({
      proposalId: z.number(),
      sectionKey: z.string(),
      content: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      await db.insert(proposalRevisions).values({
        proposalId: input.proposalId,
        sectionKey: input.sectionKey,
        content: input.content,
        savedByUserId: ctx.user.id,
        savedByName: ctx.user.name ?? undefined,
      });
      return { ok: true };
    }),
  /**
   * List revision history for a proposal, ordered newest-first.
   */
  listRevisions: repProcedure
    .input(z.object({ proposalId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      const rows = await db
        .select()
        .from(proposalRevisions)
        .where(eq(proposalRevisions.proposalId, input.proposalId))
        .orderBy(desc(proposalRevisions.createdAt));
      return rows;
    }),
  /**
   * List activity feed for a proposal (system events + manual notes).
   * Returns newest-first, enriched with actor display name.
   */
  listActivity: repProcedure
    .input(z.object({ proposalId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      const rows = await db
        .select({
          id: activities.id,
          type: activities.type,
          subject: activities.subject,
          body: activities.body,
          actorUserId: activities.actorUserId,
          occurredAt: activities.occurredAt,
        })
        .from(activities)
        .where(
          and(
            eq(activities.workspaceId, ctx.workspace.id),
            eq(activities.relatedType, "proposal"),
            eq(activities.relatedId, input.proposalId),
          ),
        )
        .orderBy(desc(activities.occurredAt));
      // Enrich with actor names
      const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter(Boolean) as number[])];
      let nameMap: Map<number, string> = new Map();
      if (actorIds.length > 0) {
        const userRows = await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(or(...actorIds.map((id) => eq(users.id, id))));
        nameMap = new Map(userRows.map((u) => [u.id, u.name ?? "Unknown"]));
      }
      return rows.map((r) => ({
        ...r,
        actorName: r.actorUserId ? (nameMap.get(r.actorUserId) ?? "System") : "System",
      }));
    }),
  /** Snapshot today's engagement score for a proposal */
  snapshotScore: workspaceProcedure
    .input(z.object({ proposalId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const proposal = await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      const feedbackRows = await db
        .select({ id: proposalFeedback.id })
        .from(proposalFeedback)
        .where(eq(proposalFeedback.proposalId, proposal.id));
      // The count goes in the object: as a second argument it was ignored, the
      // score came out 15 low and could report a drop that did not happen.
      const score = computeEngagementScore({ ...proposal, feedbackCount: feedbackRows.length });
      // Check for score drop vs most recent snapshot
      const [prevSnapshot] = await db
        .select({ score: proposalScoreHistory.score })
        .from(proposalScoreHistory)
        .where(eq(proposalScoreHistory.proposalId, proposal.id))
        .orderBy(desc(proposalScoreHistory.createdAt))
        .limit(1);
      const prevScore = prevSnapshot?.score ?? null;
      await db.insert(proposalScoreHistory).values({
        proposalId: proposal.id,
        score,
      });
      // Alert on score drop (non-fatal)
      if (prevScore !== null && score < prevScore) {
        try {
          await logProposalActivity(db, {
            proposalId: proposal.id,
            workspaceId: ctx.workspace.id,
            actorUserId: ctx.user.id,
            subject: `Engagement score dropped from ${prevScore} to ${score}`,
            body: `The proposal "${proposal.title}" engagement score decreased by ${prevScore - score} points.`,
          });
          // To the proposal's author in this workspace, or its owner if they
          // have left (audit 2026-10-20, R2). notifyOwner POSTs the platform
          // operator's notification service, so every workspace's client
          // engagement went to one person outside it.
          const recipient = (await activeOwnerOrNull(ctx.workspace.id, proposal.createdBy))
            ?? (await workspaceNotifyUserId(ctx.workspace.id));
          if (recipient) {
            await db.insert(notifications).values({
              workspaceId: ctx.workspace.id,
              userId: recipient,
              kind: "system",
              title: `Proposal engagement dropped: ${proposal.title}`,
              body: `Score fell from ${prevScore} to ${score}/100. Consider following up with ${proposal.clientName || "the client"}.`,
              relatedType: "proposal",
              relatedId: proposal.id,
            });
          }
        } catch {
          // non-fatal
        }
      }
      return { ok: true, score, prevScore, dropped: prevScore !== null && score < prevScore };
    }),

  /**
   * Request an extension — public, for the client portal.
   * Client submits a reason; creates a task + in-app notification for the workspace owner.
   */
  requestExtension: publicProcedure
    .input(
      z.object({
        token: z.string().min(1).max(128),
        reason: z.string().trim().min(1).max(2000),
        clientName: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rows = await db
        .select()
        .from(proposals)
        .where(eq(proposals.shareToken, input.token))
        .limit(1);
      if (!rows[0] || !servedOnPortal(rows[0].status)) throw new TRPCError({ code: "NOT_FOUND", message: PORTAL_UNAVAILABLE });
      const proposal = rows[0];
      // PUBLIC PATH — extension request from a share link, same reasoning.
      const ownerUserId = await workspaceNotifyUserId(proposal.workspaceId);
      const clientLabel = input.clientName ?? proposal.clientName;
      const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // due in 24h
      // Create a task for the rep
      if (ownerUserId) {
        await db.insert(tasks).values({
          workspaceId: proposal.workspaceId,
          title: `Extension requested: "${proposal.title}"`,
          description: `${clientLabel} has requested an extension.

Reason: ${input.reason}`,
          type: "follow_up",
          priority: "high",
          status: "open",
          dueAt,
          ownerUserId,
          relatedType: "proposal",
          relatedId: proposal.id,
        });
        // In-app notification
        await db.insert(notifications).values({
          workspaceId: proposal.workspaceId,
          userId: ownerUserId,
          kind: "system",
          title: `Extension requested: "${proposal.title}"`,
          body: `${clientLabel} has requested an extension. Reason: ${input.reason.slice(0, 200)}`,
          // `isRead` is not a column — unread is `readAt IS NULL`, which is
          // already the default. Drizzle dropped the key silently, so the
          // intent happened to be met; the line was still a lie about what
          // this table stores.
        });
      }
      // Log activity
      await db.insert(activities).values({
        workspaceId: proposal.workspaceId,
        type: "note",
        relatedType: "proposal",
        relatedId: proposal.id,
        subject: EXTENSION_SUBJECT.requested,
        body: `${clientLabel} submitted an extension request via the proposal portal.

Reason: ${input.reason}`,
        actorUserId: null,
        occurredAt: new Date(),
      });
      return { ok: true };
    }),

  /** Bulk-set expiresAt on multiple proposals at once. */
  bulkSetExpiry: workspaceProcedure
    .input(
      z.object({
        ids: z.array(z.number().int().positive()).min(1).max(200),
        expiresAt: z.string().nullable(), // ISO date string or null to clear
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const { inArray } = await import("drizzle-orm");
      // Verify all proposals belong to this workspace
      const rows = await db
        .select({ id: proposals.id })
        .from(proposals)
        .where(
          and(
            inArray(proposals.id, input.ids),
            eq(proposals.workspaceId, ctx.workspace.id),
          ),
        );
      const validIds = rows.map((r) => r.id);
      if (validIds.length === 0) return { updated: 0 };
      await db
        .update(proposals)
        .set({
          expiresAt: deadlineFrom(input.expiresAt, await getWorkspaceTimezone(ctx.workspace.id)),
          updatedAt: new Date(),
        })
        .where(inArray(proposals.id, validIds));
      return { updated: validIds.length };
    }),

  /**
   * Approve a client extension request. Updates expiresAt to the new date,
   * logs an activity, and sends a notification email to the client.
   */
  approveExtension: workspaceProcedure
    .input(
      z.object({
        proposalId: z.number().int().positive(),
        newExpiresAt: z.string(), // ISO date string
        note: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Pause all outbound holds person sends too (owner, 2026-10-06: "Block everything").
      await assertOutboundNotPaused(ctx.workspace.id);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const proposal = await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      // The day picked lasts to its end in the workspace's zone (R29), and it
      // must be in the future (R68: the default was a week past an expiry
      // that had already gone).
      const tz = await getWorkspaceTimezone(ctx.workspace.id);
      const newDate = deadlineFrom(input.newExpiresAt, tz);
      if (!newDate || newDate.getTime() <= Date.now()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a new expiry date after today." });
      }
      // An expired proposal was marked Not Accepted by the expiry sweep; an
      // approved extension puts it back in front of the client (R68).
      await db
        .update(proposals)
        .set({ expiresAt: newDate, updatedAt: new Date(), ...(proposal.status === "not_accepted" ? { status: "sent" as const } : {}) })
        .where(and(eq(proposals.id, input.proposalId), eq(proposals.workspaceId, ctx.workspace.id)));
      // Log activity
      await logProposalActivity(db, {
        workspaceId: ctx.workspace.id,
        proposalId: input.proposalId,
        actorUserId: ctx.user.id,
        actorName: ctx.user.name ?? undefined,
        subject: `${EXTENSION_SUBJECT.approved} — new expiry: ${newDate.toLocaleDateString("en-US", { timeZone: tz })}`,
        body: input.note ?? undefined,
      });
      // Send email to client if possible
      if (proposal.clientEmail) {
        try {
          const [sendingAcc] = await db
            .select()
            .from(sendingAccounts)
            .where(and(eq(sendingAccounts.workspaceId, ctx.workspace.id), eq(sendingAccounts.enabled, true)))
            .limit(1);
          const subject = `Your proposal has been extended — "${proposal.title}"`;
          const html = `<p>Hi ${proposal.clientName ?? "there"},</p>
<p>Great news — your extension request has been approved. The proposal <strong>${proposal.title}</strong> is now valid until <strong>${newDate.toLocaleDateString("en-US", { timeZone: tz })}</strong>.</p>
${input.note ? `<p>${input.note}</p>` : ""}
${proposal.shareToken ? `<p><a href="${appUrl(`/p/${proposal.shareToken}`)}">View proposal &rarr;</a></p>` : ""}
<p>Best regards,<br/>${ctx.user.name ?? "The team"}</p>`;
          if (sendingAcc) {
            const adapter = createEmailAdapter(sendingAcc);
            await adapter.sendEmail({
              fromEmail: sendingAcc.fromEmail,
              fromName: sendingAcc.fromName ?? ctx.user.name ?? "USIP",
              to: proposal.clientEmail,
              subject,
              bodyHtml: html,
              logMeta: {
                source: "proposal",
                sourceLabel: `Proposal #${proposal.id}`,
                userId: ctx.user.id,
              },
            });
          } else {
            const { sendWorkspaceEmail } = await import("../emailDelivery");
            await sendWorkspaceEmail(ctx.workspace.id, {
              to: proposal.clientEmail, subject, html,
              logSource: "proposal", logLabel: `Proposal #${proposal.id}`,
            });
          }
        } catch (_e) {
          // Non-fatal
        }
      }
      return { ok: true };
    }),

  /**
   * Approve several extension requests at once (owner ask 2026-09-08:
   * "approve all" on every approvals screen). Each item runs the single
   * approveExtension above through the app router, so the activity log and
   * the client email are identical to a one-at-a-time approval. The client
   * supplies each new expiry (its default is +7 days on the current one).
   */
  approveExtensionsBulk: workspaceProcedure
    .input(z.object({
      items: z.array(z.object({ proposalId: z.number().int().positive(), newExpiresAt: z.string() })).min(1).max(50),
      note: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }): Promise<{ approved: number; failed: Array<{ proposalId: number; detail: string }> }> => {
      // Pause all outbound holds person sends too (owner, 2026-10-06: "Block everything").
      await assertOutboundNotPaused(ctx.workspace.id);
      const { appRouter } = await import("../routers");
      const caller = appRouter.createCaller(ctx as never);
      let approved = 0;
      const failed: Array<{ proposalId: number; detail: string }> = [];
      for (const item of input.items) {
        try {
          await caller.proposals.approveExtension({ proposalId: item.proposalId, newExpiresAt: item.newExpiresAt, note: input.note });
          approved++;
        } catch (e) {
          failed.push({ proposalId: item.proposalId, detail: (e as Error).message });
        }
      }
      return { approved, failed };
    }),
  /**
   * Deny a client extension request. Logs an activity and optionally sends
   * a decline email to the client.
   */
  denyExtension: workspaceProcedure
    .input(
      z.object({
        proposalId: z.number().int().positive(),
        reason: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Pause all outbound holds person sends too (owner, 2026-10-06: "Block everything").
      await assertOutboundNotPaused(ctx.workspace.id);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const proposal = await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      // Log activity
      await logProposalActivity(db, {
        workspaceId: ctx.workspace.id,
        proposalId: input.proposalId,
        actorUserId: ctx.user.id,
        actorName: ctx.user.name ?? undefined,
        subject: EXTENSION_SUBJECT.declined,
        body: input.reason ?? undefined,
      });
      // Send decline email to client if possible
      if (proposal.clientEmail) {
        try {
          const [sendingAcc] = await db
            .select()
            .from(sendingAccounts)
            .where(and(eq(sendingAccounts.workspaceId, ctx.workspace.id), eq(sendingAccounts.enabled, true)))
            .limit(1);
          const subject = `Regarding your extension request — "${proposal.title}"`;
          const html = `<p>Hi ${proposal.clientName ?? "there"},</p>
<p>Thank you for your interest in <strong>${proposal.title}</strong>. Unfortunately, we are unable to extend the proposal at this time.</p>
${input.reason ? `<p>${input.reason}</p>` : ""}
<p>Please don\'t hesitate to reach out if you have any questions.</p>
<p>Best regards,<br/>${ctx.user.name ?? "The team"}</p>`;
          if (sendingAcc) {
            const adapter = createEmailAdapter(sendingAcc);
            await adapter.sendEmail({
              fromEmail: sendingAcc.fromEmail,
              fromName: sendingAcc.fromName ?? ctx.user.name ?? "USIP",
              to: proposal.clientEmail,
              subject,
              bodyHtml: html,
              logMeta: {
                source: "proposal",
                sourceLabel: `Proposal #${proposal.id}`,
                userId: ctx.user.id,
              },
            });
          } else {
            const { sendWorkspaceEmail } = await import("../emailDelivery");
            await sendWorkspaceEmail(ctx.workspace.id, {
              to: proposal.clientEmail, subject, html,
              logSource: "proposal", logLabel: `Proposal #${proposal.id}`,
            });
          }
        } catch (_e) {
          // Non-fatal
        }
      }
      return { ok: true };
    }),
  /**
   * Public: return extension-related activity events for the portal timeline.
   * Filters activities whose subject contains "extension" for the given shareToken.
   */
  getExtensionHistory: publicProcedure
    .input(z.object({ token: z.string().min(1).max(128) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const rows = await db
        .select({ id: proposals.id, status: proposals.status })
        .from(proposals)
        .where(eq(proposals.shareToken, input.token))
        .limit(1);
      if (!rows[0] || !servedOnPortal(rows[0].status)) return [];
      const proposalId = rows[0].id;
      const events = await db
        .select({
          id: activities.id,
          subject: activities.subject,
          body: activities.body,
          occurredAt: activities.occurredAt,
        })
        .from(activities)
        .where(
          and(
            eq(activities.relatedType, "proposal"),
            eq(activities.relatedId, proposalId),
            like(activities.subject, "%extension%"),
          ),
        )
        .orderBy(asc(activities.occurredAt));
      return events;
    }),
  /**
   * Protected: list proposals that have a pending extension request
   * (extension_requested activity with no subsequent approved/denied activity).
   */
  listExtensionPending: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const isManager = ["manager", "admin", "super_admin"].includes(ctx.member.role);
    const proposalRows = await db
      .select({
        id: proposals.id,
        title: proposals.title,
        clientName: proposals.clientName,
        clientEmail: proposals.clientEmail,
        expiresAt: proposals.expiresAt,
        status: proposals.status,
      })
      .from(proposals)
      .where(
        isManager
          ? eq(proposals.workspaceId, ctx.workspace.id)
          : and(eq(proposals.workspaceId, ctx.workspace.id), eq(proposals.createdBy, ctx.user.id)),
      );
    if (proposalRows.length === 0) return [];
    const proposalIds = proposalRows.map((r) => r.id);
    const actRows = await db
      .select({
        relatedId: activities.relatedId,
        subject: activities.subject,
        body: activities.body,
        occurredAt: activities.occurredAt,
      })
      .from(activities)
      .where(
        and(
          eq(activities.relatedType, "proposal"),
          or(...proposalIds.map((id) => eq(activities.relatedId, id))),
          like(activities.subject, "%extension%"),
        ),
      )
      .orderBy(asc(activities.occurredAt));
    const byProposal = new Map<number, typeof actRows>();
    for (const a of actRows) {
      if (!byProposal.has(a.relatedId)) byProposal.set(a.relatedId, []);
      byProposal.get(a.relatedId)!.push(a);
    }
    const pending: Array<{
      id: number;
      title: string;
      clientName: string | null;
      clientEmail: string | null;
      expiresAt: Date | null;
      status: string;
      requestedAt: Date;
      reason: string | null;
    }> = [];
    for (const [proposalId, acts] of Array.from(byProposal.entries())) {
      // Open when the LATEST extension event is a request (R23): "ever
      // resolved" hid every request after the first answer.
      const req = openExtensionRequest(acts);
      if (req) {
        const proposal = proposalRows.find((p) => p.id === proposalId)!;
        pending.push({
          id: proposalId,
          title: proposal.title,
          clientName: proposal.clientName,
          clientEmail: proposal.clientEmail,
          expiresAt: proposal.expiresAt,
          status: proposal.status,
          requestedAt: req.occurredAt,
          reason: req.body,
        });
      }
    }
    return pending;
  }),
  /**
   * Public: return the latest extension status for a proposal by shareToken.
   * Returns { status: "none"|"pending"|"approved"|"denied", resolvedAt, newExpiresAt, reason }
   */
  getExtensionStatus: publicProcedure
    .input(z.object({ token: z.string().min(1).max(128) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { status: "none" as const, resolvedAt: null, newExpiresAt: null, reason: null };
      const [proposal] = await db
        .select({ id: proposals.id, expiresAt: proposals.expiresAt, status: proposals.status })
        .from(proposals)
        .where(eq(proposals.shareToken, input.token))
        .limit(1);
      if (!proposal || !servedOnPortal(proposal.status)) return { status: "none" as const, resolvedAt: null, newExpiresAt: null, reason: null };
      // Get all extension-related activities for this proposal, newest first
      const extActs = await db
        .select({ id: activities.id, subject: activities.subject, body: activities.body, occurredAt: activities.occurredAt })
        .from(activities)
        .where(
          and(
            eq(activities.relatedType, "proposal"),
            eq(activities.relatedId, proposal.id),
            or(
              like(activities.subject, "%Extension requested%"),
              like(activities.subject, "%Extension approved%"),
              like(activities.subject, "%Extension declined%"),
            ),
          ),
        )
        .orderBy(desc(activities.occurredAt));
      if (extActs.length === 0) return { status: "none" as const, resolvedAt: null, newExpiresAt: null, reason: null };
      const latest = extActs[0];
      if (extensionEventOf(latest.subject) === "approved") {
        return {
          status: "approved" as const,
          resolvedAt: latest.occurredAt,
          newExpiresAt: proposal.expiresAt ?? null,
          reason: latest.body ?? null,
        };
      }
      if (extensionEventOf(latest.subject) === "declined") {
        return {
          status: "denied" as const,
          resolvedAt: latest.occurredAt,
          newExpiresAt: null,
          reason: latest.body ?? null,
        };
      }
      // Latest is a request with no resolution
      return { status: "pending" as const, resolvedAt: null, newExpiresAt: null, reason: latest.body ?? null };
    }),
  /**
   * Protected: return full extension event history for a proposal
   * (for the ProposalDetail Extensions sub-section).
   */
  listExtensionDetails: workspaceProcedure
    .input(z.object({ proposalId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      const rows = await db
        .select({
          id: activities.id,
          subject: activities.subject,
          body: activities.body,
          occurredAt: activities.occurredAt,
          actorUserId: activities.actorUserId,
        })
        .from(activities)
        .where(
          and(
            eq(activities.relatedType, "proposal"),
            eq(activities.relatedId, input.proposalId),
            like(activities.subject, "%extension%"),
          ),
        )
        .orderBy(asc(activities.occurredAt));
      return rows;
    }),
  /** Return last 30 daily score snapshots for a proposal (newest first) */
  getScoreHistory: workspaceProcedure
    .input(z.object({ proposalId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      const rows = await db
        .select({
          id: proposalScoreHistory.id,
          score: proposalScoreHistory.score,
          createdAt: proposalScoreHistory.createdAt,
        })
        .from(proposalScoreHistory)
        .where(eq(proposalScoreHistory.proposalId, input.proposalId))
        .orderBy(desc(proposalScoreHistory.createdAt))
        .limit(30);
      return rows;
    }),

});
