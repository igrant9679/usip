/**
 * Proposals router — Phase A
 * Covers: list, get, create, update, updateStatus, updateSection,
 *         upsertMilestone, deleteMilestone, submitFeedback (public),
 *         getByShareToken (public), generateSectionContent (AI),
 *         duplicate, sendToClient
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";
import {
  proposals,
  proposalSections,
  proposalMilestones,
  proposalFeedback,
} from "../../drizzle/schema";
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
    return rows;
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
      return { proposal, sections, milestones, feedback };
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
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      await getProposalOrThrow(db, input.id, ctx.workspace.id);
      const { id, rfpDeadline, completionDate, budget, ...rest } = input;
      const patch: Record<string, unknown> = { ...rest };
      if (rfpDeadline !== undefined) patch.rfpDeadline = rfpDeadline ? new Date(rfpDeadline) : null;
      if (completionDate !== undefined)
        patch.completionDate = completionDate ? new Date(completionDate) : null;
      if (budget !== undefined) patch.budget = budget != null ? String(budget) : null;
      await db.update(proposals).set(patch).where(eq(proposals.id, id));
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

      // Send email (non-fatal — we still mark as sent even if email fails)
      let emailOk = false;
      try {
        const { sendWorkspaceEmail } = await import("../emailDelivery");
        const result = await sendWorkspaceEmail(ctx.workspace.id, {
          to: proposal.clientEmail,
          subject: `${senderName} has shared a proposal with you: ${proposal.title}`,
          html: `
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
    <a href="${shareUrl}" style="display:inline-block;background:#0f766e;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
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
</div>`,
        });
        emailOk = result.ok;
      } catch (_e) {
        // Non-fatal: mark as sent regardless
      }

      // Mark proposal as sent
      await db
        .update(proposals)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(proposals.id, input.id));

      return { ok: true, emailSent: emailOk, shareUrl };
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
});
