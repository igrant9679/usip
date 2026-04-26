/**
 * Proposals router — Phase A
 * Covers: list, get, create, update, updateStatus, updateSection,
 *         upsertMilestone, deleteMilestone, submitFeedback (public),
 *         getByShareToken (public), generateSectionContent (AI),
 *         duplicate, sendToClient, acceptProposal, acceptByToken
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, like, or } from "drizzle-orm";
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
} from "../../drizzle/schema";
import { createEmailAdapter } from "../emailAdapter";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { publicProcedure, router } from "../_core/trpc";
import {
  managerProcedure,
  repProcedure,
  workspaceProcedure,
} from "../_core/workspace";

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
      isExpired:
        r.expiresAt !== null &&
        new Date(r.expiresAt).getTime() < now,
      isExpiringSoon:
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
        contactId: z.number().optional(),
        accountId: z.number().optional(),
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
      const [result] = await db.insert(proposals).values({
        workspaceId: ctx.workspace.id,
        createdBy: ctx.user.id,
        title: input.title,
        clientName: input.clientName,
        clientEmail: input.clientEmail || null,
        clientWebsite: input.clientWebsite || null,
        orgAbbr: input.orgAbbr || null,
        contactId: input.contactId ?? null,
        accountId: input.accountId ?? null,
        projectType: input.projectType || null,
        rfpDeadline: input.rfpDeadline ? new Date(input.rfpDeadline) : null,
        completionDate: input.completionDate ? new Date(input.completionDate) : null,
        budget: input.budget != null ? String(input.budget) : null,
        description: input.description || null,
        requirements: input.requirements ?? [],
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
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
      await getProposalOrThrow(db, input.id, ctx.workspace.id);
      const { id, rfpDeadline, completionDate, budget, expiresAt, skipAutoExtend, ...rest } = input;
      const patch: Record<string, unknown> = { ...rest };
      if (rfpDeadline !== undefined) patch.rfpDeadline = rfpDeadline ? new Date(rfpDeadline) : null;
      if (completionDate !== undefined)
        patch.completionDate = completionDate ? new Date(completionDate) : null;
      if (budget !== undefined) patch.budget = budget != null ? String(budget) : null;
      if (expiresAt !== undefined) patch.expiresAt = expiresAt ? new Date(expiresAt) : null;
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
      const db = await getDb();
      await getProposalOrThrow(db, input.id, ctx.workspace.id);
      const patch: Record<string, unknown> = { status: input.status };
      if (input.status === "sent") patch.sentAt = new Date();
      if (input.status === "accepted") patch.acceptedAt = new Date();
      await db.update(proposals).set(patch).where(eq(proposals.id, input.id));
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
      await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
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
        milestoneDate: input.milestoneDate ? new Date(input.milestoneDate) : null,
        description: input.description || null,
        owner: input.owner,
        sortOrder: input.sortOrder,
      };
      if (input.id) {
        await db
          .update(proposalMilestones)
          .set(values)
          .where(eq(proposalMilestones.id, input.id));
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
      await db
        .delete(proposalMilestones)
        .where(eq(proposalMilestones.id, input.milestoneId));
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
      await db.update(proposals).set({ shareToken: token }).where(eq(proposals.id, input.id));
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
        subject: `Proposal created: "${input.title}"`,
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
        /** The frontend origin so the share URL resolves correctly. */
        origin: z.string().url(),
        /** Optional personal message to include in the email body. */
        message: z.string().optional(),
        /** Optional sending account ID to use (overrides workspace default). */
        sendingAccountId: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const proposal = await getProposalOrThrow(db, input.id, ctx.workspace.id);

      if (!proposal.clientEmail) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This proposal has no client email address. Add one in the Overview tab first.",
        });
      }

      // Ensure a share token exists
      let token = proposal.shareToken;
      if (!token) {
        token = generateShareToken();
        await db.update(proposals).set({ shareToken: token }).where(eq(proposals.id, input.id));
      }

      const shareUrl = `${input.origin}/p/${token}`;
      const clientName = proposal.clientName;
      const orgAbbr = proposal.orgAbbr ? ` (${proposal.orgAbbr})` : "";
      const senderName = ctx.user.name ?? ctx.workspace.name;
      const personalNote = input.message
        ? `<p style="margin:16px 0;padding:12px 16px;background:#f9fafb;border-left:3px solid #14b8a6;border-radius:4px;font-style:italic;color:#374151">${input.message.replace(/\n/g, "<br>")}</p>`
        : "";

      // ── Send email via team member's connected sending account (Unipile/SMTP) ──
      // Falls back to workspace SMTP config if no connected account is found.
      let emailOk = false;
      let senderEmail = "";
      const emailSubject = `${senderName} has shared a proposal with you: ${proposal.title}`;
      const emailHtml = `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827">
  <div style="margin-bottom:24px">
    <span style="font-size:13px;font-weight:600;letter-spacing:0.05em;color:#14b8a6;text-transform:uppercase">LSI Media · USIP</span>
  </div>
  <h2 style="margin:0 0 8px;font-size:20px;font-weight:700">You have a new proposal to review</h2>
  <p style="margin:0 0 16px;color:#6b7280">Hi ${clientName}${orgAbbr},</p>
  <p style="margin:0 0 16px;color:#374151">
    <strong>${senderName}</strong> from <strong>${ctx.workspace.name}</strong> has shared a proposal with you:
    <strong>${proposal.title}</strong>.
  </p>
  ${personalNote}
  <p style="margin:24px 0">
    <a href="${input.origin}/api/track/proposal-click/${token}?dest=${encodeURIComponent(shareUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
      View Proposal →
    </a>
  </p>
  <p style="color:#6b7280;font-size:13px">Or copy this link into your browser:</p>
  <p style="color:#14b8a6;font-size:12px;word-break:break-all"><a href="${shareUrl}" style="color:#14b8a6">${shareUrl}</a></p>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
  <p style="color:#9ca3af;font-size:12px">
    You can view the proposal and leave feedback without creating an account.
    If you did not expect this email, you can safely ignore it.
  </p>
  <!-- Tracking pixel: 1x1 transparent GIF, logs open event server-side -->
  <img src="${input.origin}/api/track/proposal-open/${token}" width="1" height="1" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0" alt="" />
</div>`;
      try {
        // Use specified account if provided, else prefer the first enabled connected account
        const [sendingAcc] = input.sendingAccountId
          ? await db
              .select()
              .from(sendingAccounts)
              .where(and(
                eq(sendingAccounts.id, input.sendingAccountId),
                eq(sendingAccounts.workspaceId, ctx.workspace.id),
                eq(sendingAccounts.enabled, true),
              ))
              .limit(1)
          : await db
              .select()
              .from(sendingAccounts)
              .where(and(eq(sendingAccounts.workspaceId, ctx.workspace.id), eq(sendingAccounts.enabled, true)))
              .limit(1);
        if (sendingAcc) {
          const adapter = createEmailAdapter(sendingAcc);
          await adapter.sendEmail({
            fromEmail: sendingAcc.fromEmail,
            fromName: sendingAcc.fromName ?? senderName,
            to: proposal.clientEmail!,
            subject: emailSubject,
            bodyHtml: emailHtml,
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
          });
          emailOk = result.ok;
        }
      } catch (_e) {
        // Non-fatal: mark as sent regardless
      }

      // Mark proposal as sent
      await db
        .update(proposals)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(proposals.id, input.id));

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
      // Mark accepted
      await db
        .update(proposals)
        .set({ status: "accepted", acceptedAt: new Date() })
        .where(eq(proposals.id, input.id));
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
      const wsRows = await db
        .select({ ownerUserId: workspaces.ownerUserId })
        .from(workspaces)
        .where(eq(workspaces.id, ctx.workspace.id))
        .limit(1);
      const ownerUserId = wsRows[0]?.ownerUserId;
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
      let opportunityId = proposal.linkedOpportunityId ?? null;
      if (proposal.accountId) {
        const oppValue = proposal.budget ? String(proposal.budget) : "0";
        if (opportunityId) {
          // Update existing opportunity to "won" stage
          await db
            .update(opportunities)
            .set({ stage: "won", winProb: 100, value: oppValue, updatedAt: new Date() })
            .where(eq(opportunities.id, opportunityId));
        } else {
          // Create a new opportunity in "won" stage
          const oppResult = await db.insert(opportunities).values({
            workspaceId: ctx.workspace.id,
            accountId: proposal.accountId,
            name: proposal.title,
            stage: "won",
            value: oppValue,
            winProb: 100,
            ownerUserId: ctx.user.id,
            closeDate: new Date(),
            nextStep: `Kickoff: follow up on accepted proposal "${proposal.title}"`,
          });
          opportunityId = Number((oppResult as any)[0]?.insertId ?? 0) || null;
          // Link the opportunity back to the proposal
          if (opportunityId) {
            await db
              .update(proposals)
              .set({ linkedOpportunityId: opportunityId })
              .where(eq(proposals.id, input.id));
          }
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
      await db.delete(proposals).where(eq(proposals.id, input.id));
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
      const systemPrompt = `You are an expert proposal writer for LSI Media, a professional services firm. Write compelling, professional proposal content in clear, concise prose. Use markdown formatting (headers, bullets where appropriate). Do not include placeholder text — write real, polished content.`;
      const userPrompt = `Write the "${sectionLabel}" section for a proposal to ${clientName}${orgAbbr ? ` (${orgAbbr})` : ""}.
${projectType ? `Project type: ${projectType}` : ""}
${description ? `Project description: ${description}` : ""}
${budget ? `Budget: $${budget.toLocaleString()}` : ""}

Write 2-4 paragraphs of professional proposal content for this section. Be specific and persuasive.`;
      const response = await invokeLLM({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      const content =
        (response as any)?.choices?.[0]?.message?.content ?? "Content generation failed.";
      return { content };
    }),

  // ── Public procedures (no auth required) ─────────────────────────────────

  /** Get proposal by share token — public, for client portal. */
  getByShareToken: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rows = await db
        .select()
        .from(proposals)
        .where(eq(proposals.shareToken, input.token))
        .limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
      const proposal = rows[0];
      const [sections, milestones] = await Promise.all([
        getSections(db, proposal.id),
        getMilestones(db, proposal.id),
      ]);
      return { proposal, sections, milestones };
    }),

  /** Submit client feedback — public. */
  submitFeedback: publicProcedure
    .input(
      z.object({
        token: z.string(),
        authorName: z.string().min(1),
        authorEmail: z.string().email().optional().or(z.literal("")),
        message: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rows = await db
        .select({ id: proposals.id })
        .from(proposals)
        .where(eq(proposals.shareToken, input.token))
        .limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
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
    .input(z.object({ token: z.string(), clientName: z.string().optional() }))
    .mutation(async ({ input }) => {
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
      // Mark accepted
      await db
        .update(proposals)
        .set({ status: "accepted", acceptedAt: new Date() })
        .where(eq(proposals.id, proposal.id));
      // Get workspace owner
      const wsRows = await db
        .select({ ownerUserId: workspaces.ownerUserId })
        .from(workspaces)
        .where(eq(workspaces.id, proposal.workspaceId))
        .limit(1);
      const ownerUserId = wsRows[0]?.ownerUserId;
      if (ownerUserId) {
        // Create follow-up task for owner
        await db.insert(tasks).values({
          workspaceId: proposal.workspaceId,
          title: `Follow up: ${proposal.title} — accepted by ${proposal.clientName}`,
          description: `Client ${proposal.clientName} accepted the proposal via the client portal. Schedule a kickoff meeting and send the contract.`,
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
      let opportunityId = proposal.linkedOpportunityId ?? null;
      if (proposal.accountId) {
        const oppValue = proposal.budget ? String(proposal.budget) : "0";
        if (opportunityId) {
          await db
            .update(opportunities)
            .set({ stage: "won", winProb: 100, value: oppValue, updatedAt: new Date() })
            .where(eq(opportunities.id, opportunityId));
        } else {
          const oppResult = await db.insert(opportunities).values({
            workspaceId: proposal.workspaceId,
            accountId: proposal.accountId,
            name: proposal.title,
            stage: "won",
            value: oppValue,
            winProb: 100,
            ownerUserId: ownerUserId ?? undefined,
            closeDate: new Date(),
            nextStep: `Kickoff: ${proposal.clientName} accepted the proposal via client portal.`,
          });
          opportunityId = Number((oppResult as any)[0]?.insertId ?? 0) || null;
          if (opportunityId) {
            await db
              .update(proposals)
              .set({ linkedOpportunityId: opportunityId })
              .where(eq(proposals.id, proposal.id));
          }
        }
      }
      return { ok: true, alreadyAccepted: false, opportunityId };
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
      // Verify the proposal belongs to this workspace
      await getProposalOrThrow(db, rev.proposalId, ctx.workspace.id);
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
        .where(eq(proposals.id, input.proposalId));
      return { ok: true };
    }),
  /**
   * List enabled sending accounts for the workspace (used by the account picker in Send to Client).
   */
  listSendingAccounts: repProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rows = await db
        .select({
          id: sendingAccounts.id,
          name: sendingAccounts.name,
          fromEmail: sendingAccounts.fromEmail,
          fromName: sendingAccounts.fromName,
          provider: sendingAccounts.provider,
        })
        .from(sendingAccounts)
        .where(and(eq(sendingAccounts.workspaceId, ctx.workspace.id), eq(sendingAccounts.enabled, true)))
        .orderBy(sendingAccounts.name);
      return rows;
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
      const db = getDb();
      const proposal = await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      const feedbackRows = await db
        .select({ id: proposalFeedback.id })
        .from(proposalFeedback)
        .where(eq(proposalFeedback.proposalId, proposal.id));
      const score = computeEngagementScore(proposal, feedbackRows.length);
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
            detail: `The proposal "${proposal.title}" engagement score decreased by ${prevScore - score} points.`,
          });
          const { notifyOwner } = await import("../_core/notification");
          await notifyOwner({
            title: `Proposal engagement dropped: ${proposal.title}`,
            content: `Score fell from ${prevScore} to ${score}/100. Consider following up with ${proposal.clientName || "the client"}.`,
          });
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
        token: z.string(),
        reason: z.string().min(1).max(2000),
        clientName: z.string().optional(),
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
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
      const proposal = rows[0];
      // Get workspace owner
      const wsRows = await db
        .select({ ownerUserId: workspaces.ownerUserId })
        .from(workspaces)
        .where(eq(workspaces.id, proposal.workspaceId))
        .limit(1);
      const ownerUserId = wsRows[0]?.ownerUserId;
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
          isRead: false,
        });
      }
      // Log activity
      await db.insert(activities).values({
        workspaceId: proposal.workspaceId,
        type: "note",
        relatedType: "proposal",
        relatedId: proposal.id,
        subject: "Client requested an extension",
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
      const db = getDb();
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
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
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
      const db = await getDb();
      const proposal = await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      const newDate = new Date(input.newExpiresAt);
      await db
        .update(proposals)
        .set({ expiresAt: newDate, updatedAt: new Date() })
        .where(eq(proposals.id, input.proposalId));
      // Log activity
      await logProposalActivity(db, {
        workspaceId: ctx.workspace.id,
        proposalId: input.proposalId,
        actorUserId: ctx.user.id,
        actorName: ctx.user.name ?? undefined,
        subject: `Extension approved — new expiry: ${newDate.toLocaleDateString()}`,
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
<p>Great news — your extension request has been approved. The proposal <strong>${proposal.title}</strong> is now valid until <strong>${newDate.toLocaleDateString()}</strong>.</p>
${input.note ? `<p>${input.note}</p>` : ""}
${proposal.shareToken ? `<p><a href="${process.env.MANUS_APP_URL ?? ""}/p/${proposal.shareToken}">View proposal &rarr;</a></p>` : ""}
<p>Best regards,<br/>${ctx.user.name ?? "The team"}</p>`;
          if (sendingAcc) {
            const adapter = createEmailAdapter(sendingAcc);
            await adapter.sendEmail({
              fromEmail: sendingAcc.fromEmail,
              fromName: sendingAcc.fromName ?? ctx.user.name ?? "USIP",
              to: proposal.clientEmail,
              subject,
              bodyHtml: html,
            });
          } else {
            const { sendWorkspaceEmail } = await import("../emailDelivery");
            await sendWorkspaceEmail(ctx.workspace.id, { to: proposal.clientEmail, subject, html });
          }
        } catch (_e) {
          // Non-fatal
        }
      }
      return { ok: true };
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
      const db = await getDb();
      const proposal = await getProposalOrThrow(db, input.proposalId, ctx.workspace.id);
      // Log activity
      await logProposalActivity(db, {
        workspaceId: ctx.workspace.id,
        proposalId: input.proposalId,
        actorUserId: ctx.user.id,
        actorName: ctx.user.name ?? undefined,
        subject: "Extension request declined",
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
            });
          } else {
            const { sendWorkspaceEmail } = await import("../emailDelivery");
            await sendWorkspaceEmail(ctx.workspace.id, { to: proposal.clientEmail, subject, html });
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
    .input(z.object({ token: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const rows = await db
        .select({ id: proposals.id })
        .from(proposals)
        .where(eq(proposals.shareToken, input.token))
        .limit(1);
      if (!rows[0]) return [];
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
    for (const [proposalId, acts] of byProposal.entries()) {
      const hasRequest = acts.some((a) => a.subject.toLowerCase().includes("extension requested"));
      const hasResolution = acts.some(
        (a) =>
          a.subject.toLowerCase().includes("extension approved") ||
          a.subject.toLowerCase().includes("extension declined"),
      );
      if (hasRequest && !hasResolution) {
        const req = acts.find((a) => a.subject.toLowerCase().includes("extension requested"))!;
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
    .input(z.object({ token: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { status: "none" as const, resolvedAt: null, newExpiresAt: null, reason: null };
      const [proposal] = await db
        .select({ id: proposals.id, expiresAt: proposals.expiresAt })
        .from(proposals)
        .where(eq(proposals.shareToken, input.token))
        .limit(1);
      if (!proposal) return { status: "none" as const, resolvedAt: null, newExpiresAt: null, reason: null };
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
      if (latest.subject.toLowerCase().includes("extension approved")) {
        return {
          status: "approved" as const,
          resolvedAt: latest.occurredAt,
          newExpiresAt: proposal.expiresAt ?? null,
          reason: latest.body ?? null,
        };
      }
      if (latest.subject.toLowerCase().includes("extension declined")) {
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
  /** Return last 30 daily score snapshots for a proposal (newest first) */
  getScoreHistory: workspaceProcedure
    .input(z.object({ proposalId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await getProposalOrThrow(getDb(), input.proposalId, ctx.workspace.id);
      const rows = await getDb()
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
