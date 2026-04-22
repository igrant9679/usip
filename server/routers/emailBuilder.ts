/**
 * Email Builder routers
 * - emailTemplatesRouter: CRUD + renderPreview for visual email templates
 * - snippetsRouter: CRUD for reusable content snippets
 * - brandVoiceRouter: get/save brand voice profile
 * - emailPromptTemplatesRouter: list/create/activate prompt template versions
 */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  brandVoiceProfiles,
  emailPromptTemplates,
  emailSnippets,
  emailTemplates,
} from "../../drizzle/schema";
import {
  adminWsProcedure,
  managerProcedure,
  repProcedure,
  workspaceProcedure,
} from "../_core/workspace";
import { router } from "../_core/trpc";
import { invokeLLM } from "../_core/llm";

/* ─── Merge-tag resolver ─────────────────────────────────────────────────── */

const MERGE_TAGS: Record<string, string> = {
  firstName: "Alex",
  lastName: "Johnson",
  company: "Acme Corp",
  title: "VP of Sales",
  senderName: "Your Name",
  senderTitle: "Account Executive",
  senderCompany: "LSI Media",
};

/**
 * Resolves {{tag}} and {{customField.key}} placeholders.
 * Falls back to the tag name in brackets when no value is found.
 */
export function resolveMergeTags(
  text: string,
  overrides: Record<string, string> = {},
): string {
  const ctx = { ...MERGE_TAGS, ...overrides };
  return text.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    const trimmed = key.trim();
    if (trimmed.startsWith("customField.")) {
      const fieldKey = trimmed.slice("customField.".length);
      return overrides[`customField.${fieldKey}`] ?? `[${fieldKey}]`;
    }
    return ctx[trimmed] ?? `[${trimmed}]`;
  });
}

/* ─── Design-data → HTML renderer ───────────────────────────────────────── */

interface Block {
  id: string;
  type: string;
  props: Record<string, unknown>;
  sortOrder: number;
}

function blockToHtml(block: Block): string {
  const p = block.props;
  switch (block.type) {
    case "header":
      return `<div style="background:${p.bgColor ?? "#14B89A"};padding:24px;text-align:center;">
        ${p.logoUrl ? `<img src="${p.logoUrl}" alt="logo" style="max-height:48px;margin-bottom:12px;display:block;margin-left:auto;margin-right:auto;">` : ""}
        <h1 style="margin:0;color:${p.textColor ?? "#ffffff"};font-size:24px;font-family:sans-serif;">${p.headline ?? ""}</h1>
        ${p.subheadline ? `<p style="margin:8px 0 0;color:${p.textColor ?? "#ffffff"};opacity:0.85;font-size:14px;font-family:sans-serif;">${p.subheadline}</p>` : ""}
      </div>`;

    case "text":
      return `<div style="padding:16px 24px;font-family:sans-serif;font-size:${p.fontSize ?? 14}px;color:${p.color ?? "#1a1a1a"};line-height:1.6;">
        ${p.content ?? ""}
      </div>`;

    case "image":
      return `<div style="padding:8px 24px;text-align:${p.align ?? "center"};">
        <img src="${p.src ?? ""}" alt="${p.alt ?? ""}" style="max-width:100%;border-radius:${p.borderRadius ?? 4}px;">
        ${p.caption ? `<p style="margin:6px 0 0;font-size:12px;color:#666;font-family:sans-serif;">${p.caption}</p>` : ""}
      </div>`;

    case "button":
      return `<div style="padding:16px 24px;text-align:${p.align ?? "center"};">
        <a href="${p.url ?? "#"}" style="display:inline-block;background:${p.bgColor ?? "#14B89A"};color:${p.textColor ?? "#ffffff"};padding:12px 28px;border-radius:${p.borderRadius ?? 4}px;text-decoration:none;font-family:sans-serif;font-size:14px;font-weight:600;">${p.label ?? "Click here"}</a>
      </div>`;

    case "divider":
      return `<div style="padding:8px 24px;"><hr style="border:none;border-top:${p.thickness ?? 1}px ${p.style ?? "solid"} ${p.color ?? "#e5e7eb"};margin:0;"></div>`;

    case "spacer":
      return `<div style="height:${p.height ?? 24}px;"></div>`;

    case "two_column": {
      const leftContent = String(p.leftContent ?? "");
      const rightContent = String(p.rightContent ?? "");
      const split = Number(p.split ?? 50);
      return `<div style="display:flex;padding:8px 24px;gap:16px;">
        <div style="flex:${split};font-family:sans-serif;font-size:14px;color:#1a1a1a;">${leftContent}</div>
        <div style="flex:${100 - split};font-family:sans-serif;font-size:14px;color:#1a1a1a;">${rightContent}</div>
      </div>`;
    }

    case "footer":
      return `<div style="background:${p.bgColor ?? "#f9fafb"};padding:16px 24px;text-align:center;font-family:sans-serif;font-size:12px;color:${p.textColor ?? "#6b7280"};">
        ${p.content ?? ""}
        ${p.unsubscribeUrl ? `<br><a href="${p.unsubscribeUrl}" style="color:#6b7280;">Unsubscribe</a>` : ""}
      </div>`;

    default:
      return "";
  }
}

export function renderDesignToHtml(
  designData: Block[],
  subject: string,
  mergeOverrides: Record<string, string> = {},
): string {
  const sorted = [...designData].sort((a, b) => a.sortOrder - b.sortOrder);
  const body = sorted.map(blockToHtml).join("\n");
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
<tr><td>${body}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return resolveMergeTags(html, mergeOverrides);
}

/* ─── emailTemplatesRouter ───────────────────────────────────────────────── */

export const emailTemplatesRouter = router({
  list: workspaceProcedure
    .input(z.object({ status: z.enum(["draft", "active", "archived", "all"]).default("all") }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select()
        .from(emailTemplates)
        .where(
          input.status === "all"
            ? eq(emailTemplates.workspaceId, ctx.workspace.id)
            : and(
                eq(emailTemplates.workspaceId, ctx.workspace.id),
                eq(emailTemplates.status, input.status),
              ),
        )
        .orderBy(desc(emailTemplates.updatedAt));
      return rows;
    }),

  get: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [row] = await db
        .select()
        .from(emailTemplates)
        .where(
          and(
            eq(emailTemplates.id, input.id),
            eq(emailTemplates.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return row;
    }),

  create: repProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().optional(),
        category: z.string().default("general"),
        subject: z.string().default(""),
        designData: z.array(z.any()).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [result] = await db.insert(emailTemplates).values({
        workspaceId: ctx.workspace.id,
        name: input.name,
        description: input.description ?? null,
        category: input.category,
        subject: input.subject,
        designData: input.designData,
        htmlOutput: renderDesignToHtml(input.designData as Block[], input.subject),
        plainOutput: "",
        status: "draft",
        createdByUserId: ctx.user.id,
      });
      return { id: (result as any).insertId as number };
    }),

  save: repProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().optional(),
        category: z.string().optional(),
        subject: z.string().optional(),
        designData: z.array(z.any()).optional(),
        status: z.enum(["draft", "active", "archived"]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [existing] = await db
        .select()
        .from(emailTemplates)
        .where(
          and(
            eq(emailTemplates.id, input.id),
            eq(emailTemplates.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });

      const designData = (input.designData ?? existing.designData) as Block[];
      const subject = input.subject ?? existing.subject ?? "";
      const htmlOutput = renderDesignToHtml(designData, subject);

      await db
        .update(emailTemplates)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.category !== undefined && { category: input.category }),
          ...(input.subject !== undefined && { subject: input.subject }),
          ...(input.designData !== undefined && { designData: input.designData }),
          ...(input.status !== undefined && { status: input.status }),
          htmlOutput,
        })
        .where(
          and(
            eq(emailTemplates.id, input.id),
            eq(emailTemplates.workspaceId, ctx.workspace.id),
          ),
        );
      return { ok: true };
    }),

  duplicate: repProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [src] = await db
        .select()
        .from(emailTemplates)
        .where(
          and(
            eq(emailTemplates.id, input.id),
            eq(emailTemplates.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);
      if (!src) throw new TRPCError({ code: "NOT_FOUND" });
      const [result] = await db.insert(emailTemplates).values({
        workspaceId: ctx.workspace.id,
        name: `${src.name} (copy)`,
        description: src.description,
        category: src.category,
        subject: src.subject,
        designData: src.designData,
        htmlOutput: src.htmlOutput,
        plainOutput: src.plainOutput,
        status: "draft",
        createdByUserId: ctx.user.id,
      });
      return { id: (result as any).insertId as number };
    }),

  archive: managerProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(emailTemplates)
        .set({ status: "archived" })
        .where(
          and(
            eq(emailTemplates.id, input.id),
            eq(emailTemplates.workspaceId, ctx.workspace.id),
          ),
        );
      return { ok: true };
    }),

  renderPreview: workspaceProcedure
    .input(
      z.object({
        id: z.number(),
        mergeOverrides: z.record(z.string(), z.string()).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [row] = await db
        .select()
        .from(emailTemplates)
        .where(
          and(
            eq(emailTemplates.id, input.id),
            eq(emailTemplates.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      const overrides = (input.mergeOverrides ?? {}) as Record<string, string>;
      const html = renderDesignToHtml(
        row.designData as Block[],
        row.subject ?? "",
        overrides,
      );
      const resolvedSubject = resolveMergeTags(
        row.subject ?? "",
        overrides,
      );
      return { html, resolvedSubject };
    }),

  /** AI-assisted block content rewrite */
  rewriteBlock: repProcedure
    .input(
      z.object({
        content: z.string(),
        instruction: z.enum(["rewrite", "shorten", "lengthen", "make_formal", "make_casual"]),
        tone: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const instructionMap: Record<string, string> = {
        rewrite: "Rewrite the following email block content to be more compelling.",
        shorten: "Shorten the following email block content significantly while keeping the key message.",
        lengthen: "Expand the following email block content with more detail and context.",
        make_formal: "Rewrite the following email block content in a formal, professional tone.",
        make_casual: "Rewrite the following email block content in a friendly, conversational tone.",
      };
      const prompt = instructionMap[input.instruction] ?? instructionMap.rewrite!;
      const res = await invokeLLM({
        messages: [
          {
            role: "system",
            content: `You are an expert email copywriter. ${input.tone ? `Write in a ${input.tone} tone.` : ""} Return only the rewritten content with no extra commentary.`,
          },
          { role: "user", content: `${prompt}\n\n---\n${input.content}` },
        ],
      });
      const rewritten = (res as any).choices?.[0]?.message?.content ?? input.content;
      return { content: rewritten };
    }),
});

/* ─── snippetsRouter ─────────────────────────────────────────────────────── */

const SNIPPET_CATEGORIES = ["opener", "value_prop", "social_proof", "objection_handler", "cta", "closing", "ps"] as const;

export const snippetsRouter = router({
  list: workspaceProcedure
    .input(
      z.object({
        category: z.enum(SNIPPET_CATEGORIES).optional(),
        search: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select()
        .from(emailSnippets)
        .where(
          input.category
            ? and(
                eq(emailSnippets.workspaceId, ctx.workspace.id),
                eq(emailSnippets.category, input.category),
              )
            : eq(emailSnippets.workspaceId, ctx.workspace.id),
        )
        .orderBy(desc(emailSnippets.updatedAt));
      if (input.search) {
        const q = input.search.toLowerCase();
        return rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.bodyPlain.toLowerCase().includes(q),
        );
      }
      return rows;
    }),

  create: repProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        category: z.enum(SNIPPET_CATEGORIES),
        bodyHtml: z.string().min(1),
        bodyPlain: z.string().min(1),
        mergeTagsUsed: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [result] = await db.insert(emailSnippets).values({
        workspaceId: ctx.workspace.id,
        name: input.name,
        category: input.category,
        bodyHtml: input.bodyHtml,
        bodyPlain: input.bodyPlain,
        mergeTagsUsed: input.mergeTagsUsed ?? [],
        createdByUserId: ctx.user.id,
      });
      return { id: (result as any).insertId as number };
    }),

  update: repProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(200).optional(),
        category: z.enum(SNIPPET_CATEGORIES).optional(),
        bodyHtml: z.string().optional(),
        bodyPlain: z.string().optional(),
        mergeTagsUsed: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [existing] = await db
        .select({ id: emailSnippets.id })
        .from(emailSnippets)
        .where(
          and(
            eq(emailSnippets.id, input.id),
            eq(emailSnippets.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      await db
        .update(emailSnippets)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.category !== undefined && { category: input.category }),
          ...(input.bodyHtml !== undefined && { bodyHtml: input.bodyHtml }),
          ...(input.bodyPlain !== undefined && { bodyPlain: input.bodyPlain }),
          ...(input.mergeTagsUsed !== undefined && { mergeTagsUsed: input.mergeTagsUsed }),
        })
        .where(
          and(
            eq(emailSnippets.id, input.id),
            eq(emailSnippets.workspaceId, ctx.workspace.id),
          ),
        );
      return { ok: true };
    }),

  delete: managerProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .delete(emailSnippets)
        .where(
          and(
            eq(emailSnippets.id, input.id),
            eq(emailSnippets.workspaceId, ctx.workspace.id),
          ),
        );
      return { ok: true };
    }),

  /** AI-generate a snippet for a given category */
  generate: repProcedure
    .input(
      z.object({
        category: z.enum(SNIPPET_CATEGORIES),
        context: z.string().optional(),
        tone: z.string().default("professional"),
      }),
    )
    .mutation(async ({ input }) => {
      const categoryDescriptions: Record<string, string> = {
        opener: "an engaging opening line that creates rapport",
        value_prop: "a concise value proposition statement",
        social_proof: "a social proof statement with a customer reference",
        objection_handler: "a response to a common sales objection",
        cta: "a clear, compelling call-to-action",
        closing: "a warm, professional closing paragraph",
        ps: "a P.S. line that reinforces the key message",
      };
      const desc = categoryDescriptions[input.category] ?? "email content";
      const res = await invokeLLM({
        messages: [
          {
            role: "system",
            content: `You are an expert B2B sales copywriter. Write in a ${input.tone} tone. Return only the snippet text with no commentary. Use {{firstName}}, {{company}}, {{title}} merge tags where natural.`,
          },
          {
            role: "user",
            content: `Write ${desc} for a B2B sales email.${input.context ? ` Context: ${input.context}` : ""}`,
          },
        ],
      });
      const content = (res as any).choices?.[0]?.message?.content ?? "";
      return { content };
    }),
});

/* ─── brandVoiceRouter ───────────────────────────────────────────────────── */

export const brandVoiceRouter = router({
  get: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db
      .select()
      .from(brandVoiceProfiles)
      .where(eq(brandVoiceProfiles.workspaceId, ctx.workspace.id))
      .limit(1);
    return row ?? null;
  }),

  save: adminWsProcedure
    .input(
      z.object({
        tone: z.enum(["professional", "conversational", "direct", "empathetic", "authoritative"]).optional(),
        vocabulary: z.array(z.string()).optional(),
        avoidWords: z.array(z.string()).optional(),
        signatureHtml: z.string().optional(),
        fromName: z.string().max(120).optional(),
        fromEmail: z.string().email().optional(),
        primaryColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/, "Must be a valid hex color")
          .optional(),
        secondaryColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/, "Must be a valid hex color")
          .optional(),
        applyToAI: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const existing = await db
        .select({ workspaceId: brandVoiceProfiles.workspaceId })
        .from(brandVoiceProfiles)
        .where(eq(brandVoiceProfiles.workspaceId, ctx.workspace.id))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(brandVoiceProfiles).values({
          workspaceId: ctx.workspace.id,
          tone: input.tone ?? "professional",
          vocabulary: input.vocabulary ?? [],
          avoidWords: input.avoidWords ?? [],
          signatureHtml: input.signatureHtml ?? null,
          fromName: input.fromName ?? null,
          fromEmail: input.fromEmail ?? null,
          primaryColor: input.primaryColor ?? "#14B89A",
          secondaryColor: input.secondaryColor ?? "#0F766E",
          applyToAI: input.applyToAI ?? true,
        });
      } else {
        await db
          .update(brandVoiceProfiles)
          .set({
            ...(input.tone !== undefined && { tone: input.tone }),
            ...(input.vocabulary !== undefined && { vocabulary: input.vocabulary }),
            ...(input.avoidWords !== undefined && { avoidWords: input.avoidWords }),
            ...(input.signatureHtml !== undefined && { signatureHtml: input.signatureHtml }),
            ...(input.fromName !== undefined && { fromName: input.fromName }),
            ...(input.fromEmail !== undefined && { fromEmail: input.fromEmail }),
            ...(input.primaryColor !== undefined && { primaryColor: input.primaryColor }),
            ...(input.secondaryColor !== undefined && { secondaryColor: input.secondaryColor }),
            ...(input.applyToAI !== undefined && { applyToAI: input.applyToAI }),
          })
          .where(eq(brandVoiceProfiles.workspaceId, ctx.workspace.id));
      }
      return { ok: true };
    }),
});

/* ─── emailPromptTemplatesRouter ─────────────────────────────────────────── */

const GOALS = ["intro", "follow_up", "meeting_request", "value_prop", "breakup", "check_in"] as const;

export const emailPromptTemplatesRouter = router({
  list: workspaceProcedure
    .input(z.object({ goal: z.enum(GOALS).optional() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select()
        .from(emailPromptTemplates)
        .where(
          input.goal
            ? and(
                eq(emailPromptTemplates.workspaceId, ctx.workspace.id),
                eq(emailPromptTemplates.goal, input.goal),
              )
            : eq(emailPromptTemplates.workspaceId, ctx.workspace.id),
        )
        .orderBy(desc(emailPromptTemplates.createdAt));
      return rows;
    }),

  create: managerProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        goal: z.enum(GOALS),
        promptText: z.string().min(10),
        abGroup: z.enum(["A", "B"]).default("A"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [result] = await db.insert(emailPromptTemplates).values({
        workspaceId: ctx.workspace.id,
        name: input.name,
        goal: input.goal,
        promptText: input.promptText,
        isActive: false,
        abGroup: input.abGroup,
        createdByUserId: ctx.user.id,
      });
      return { id: (result as any).insertId as number };
    }),

  update: managerProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(200).optional(),
        promptText: z.string().min(10).optional(),
        abGroup: z.enum(["A", "B"]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [existing] = await db
        .select({ id: emailPromptTemplates.id })
        .from(emailPromptTemplates)
        .where(
          and(
            eq(emailPromptTemplates.id, input.id),
            eq(emailPromptTemplates.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      await db
        .update(emailPromptTemplates)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.promptText !== undefined && { promptText: input.promptText }),
          ...(input.abGroup !== undefined && { abGroup: input.abGroup }),
        })
        .where(
          and(
            eq(emailPromptTemplates.id, input.id),
            eq(emailPromptTemplates.workspaceId, ctx.workspace.id),
          ),
        );
      return { ok: true };
    }),

  activate: managerProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Get the goal of the template being activated
      const [target] = await db
        .select()
        .from(emailPromptTemplates)
        .where(
          and(
            eq(emailPromptTemplates.id, input.id),
            eq(emailPromptTemplates.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);
      if (!target) throw new TRPCError({ code: "NOT_FOUND" });

      // Deactivate all others with the same goal
      await db
        .update(emailPromptTemplates)
        .set({ isActive: false })
        .where(
          and(
            eq(emailPromptTemplates.workspaceId, ctx.workspace.id),
            eq(emailPromptTemplates.goal, target.goal),
          ),
        );

      // Activate the target
      await db
        .update(emailPromptTemplates)
        .set({ isActive: true })
        .where(
          and(
            eq(emailPromptTemplates.id, input.id),
            eq(emailPromptTemplates.workspaceId, ctx.workspace.id),
          ),
        );
      return { ok: true };
    }),

  delete: adminWsProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .delete(emailPromptTemplates)
        .where(
          and(
            eq(emailPromptTemplates.id, input.id),
            eq(emailPromptTemplates.workspaceId, ctx.workspace.id),
          ),
        );
      return { ok: true };
    }),
});
