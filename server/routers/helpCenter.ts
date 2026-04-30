/**
 * Help Center tRPC router
 * Covers: categories CRUD, articles CRUD + search, AI helper chat,
 * feedback, search logging, admin insights, learning preferences.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, ilike, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  aiHelpConversations,
  aiHelpMessages,
  helpArticleFeedback,
  helpArticles,
  helpCategories,
  helpSearchLog,
  userLearningPreferences,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { router } from "../_core/trpc";

/* ─── helpers ─────────────────────────────────────────────────────────────── */

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/* ─── router ──────────────────────────────────────────────────────────────── */

export const helpCenterRouter = router({
  /* ── Categories ─────────────────────────────────────────────────────────── */

  listCategories: workspaceProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    return db
      .select()
      .from(helpCategories)
      .where(eq(helpCategories.workspaceId, ctx.workspace.id))
      .orderBy(helpCategories.sortOrder, helpCategories.name);
  }),

  upsertCategory: adminWsProcedure
    .input(
      z.object({
        id: z.number().optional(),
        name: z.string().min(1).max(120),
        icon: z.string().max(64).default("BookOpen"),
        sortOrder: z.number().default(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      if (input.id) {
        await db
          .update(helpCategories)
          .set({ name: input.name, icon: input.icon, sortOrder: input.sortOrder })
          .where(and(eq(helpCategories.id, input.id), eq(helpCategories.workspaceId, ctx.workspace.id)));
        return { id: input.id };
      }
      const [res] = await db.insert(helpCategories).values({
        workspaceId: ctx.workspace.id,
        name: input.name,
        icon: input.icon,
        sortOrder: input.sortOrder,
      });
      return { id: (res as any).insertId as number };
    }),

  deleteCategory: adminWsProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      await db
        .delete(helpCategories)
        .where(and(eq(helpCategories.id, input.id), eq(helpCategories.workspaceId, ctx.workspace.id)));
    }),

  /* ── Articles ───────────────────────────────────────────────────────────── */

  listArticles: workspaceProcedure
    .input(
      z.object({
        categoryId: z.number().optional(),
        status: z.enum(["draft", "published", "all"]).default("published"),
        pageKey: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await requireDb();
      const conditions = [eq(helpArticles.workspaceId, ctx.workspace.id)];
      if (input.categoryId) conditions.push(eq(helpArticles.categoryId, input.categoryId));
      if (input.status !== "all") conditions.push(eq(helpArticles.status, input.status));
      if (input.pageKey) conditions.push(eq(helpArticles.pageKey, input.pageKey));
      return db
        .select()
        .from(helpArticles)
        .where(and(...conditions))
        .orderBy(desc(helpArticles.updatedAt))
        .limit(input.limit)
        .offset(input.offset);
    }),

  getArticle: workspaceProcedure
    .input(z.object({ id: z.number().optional(), slug: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const db = await requireDb();
      const conditions = [eq(helpArticles.workspaceId, ctx.workspace.id)];
      if (input.id) conditions.push(eq(helpArticles.id, input.id));
      else if (input.slug) conditions.push(eq(helpArticles.slug, input.slug));
      else throw new TRPCError({ code: "BAD_REQUEST", message: "id or slug required" });
      const [article] = await db.select().from(helpArticles).where(and(...conditions)).limit(1);
      if (!article) throw new TRPCError({ code: "NOT_FOUND" });
      // Increment view count
      await db.update(helpArticles).set({ viewCount: sql`${helpArticles.viewCount} + 1` }).where(eq(helpArticles.id, article.id));
      return article;
    }),

  searchArticles: workspaceProcedure
    .input(
      z.object({
        query: z.string().min(1).max(500),
        categoryId: z.number().optional(),
        limit: z.number().min(1).max(20).default(8),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await requireDb();
      const q = `%${input.query}%`;
      const searchConditions: any[] = [
        eq(helpArticles.workspaceId, ctx.workspace.id),
        eq(helpArticles.status, "published"),
        or(
          like(helpArticles.title, q),
          like(helpArticles.summary, q),
          like(helpArticles.bodyMarkdown, q),
        ),
      ];
      if (input.categoryId) searchConditions.push(eq(helpArticles.categoryId, input.categoryId));
      const results = await db
        .select()
        .from(helpArticles)
        .where(and(...searchConditions))
        .orderBy(desc(helpArticles.viewCount))
        .limit(input.limit);
      // Log the search
      await db.insert(helpSearchLog).values({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        query: input.query,
        resultsCount: results.length,
      });
      return results;
    }),

  logSearchClick: workspaceProcedure
    .input(z.object({ query: z.string(), articleId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      // Update the most recent search log entry for this user+query
      await db
        .update(helpSearchLog)
        .set({ clickedResultId: input.articleId })
        .where(
          and(
            eq(helpSearchLog.workspaceId, ctx.workspace.id),
            eq(helpSearchLog.userId, ctx.user.id),
            eq(helpSearchLog.query, input.query),
          ),
        );
    }),

  upsertArticle: adminWsProcedure
    .input(
      z.object({
        id: z.number().optional(),
        categoryId: z.number().optional(),
        slug: z.string().min(1).max(200),
        title: z.string().min(1).max(300),
        summary: z.string().max(500).optional(),
        bodyMarkdown: z.string().optional(),
        tags: z.array(z.string()).optional(),
        status: z.enum(["draft", "published", "archived"]).default("draft"),
        associatedTourId: z.number().optional(),
        pageKey: z.string().max(120).optional(),
        pageKeys: z.array(z.string()).optional(),
        readingTimeMinutes: z.number().int().min(1).max(120).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const { id, ...rest } = input;
      const payload = {
        ...rest,
        workspaceId: ctx.workspace.id,
        authorId: ctx.user.id,
        tags: rest.tags ?? [],
      };
      if (id) {
        await db
          .update(helpArticles)
          .set(payload)
          .where(and(eq(helpArticles.id, id), eq(helpArticles.workspaceId, ctx.workspace.id)));
        return { id };
      }
      const [res] = await db.insert(helpArticles).values(payload);
      return { id: (res as any).insertId as number };
    }),

  deleteArticle: adminWsProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      await db
        .delete(helpArticles)
        .where(and(eq(helpArticles.id, input.id), eq(helpArticles.workspaceId, ctx.workspace.id)));
    }),

  /* ── Feedback ───────────────────────────────────────────────────────────── */

  submitFeedback: workspaceProcedure
    .input(
      z.object({
        articleId: z.number(),
        helpful: z.boolean(),
        comment: z.string().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      await db.insert(helpArticleFeedback).values({
        articleId: input.articleId,
        userId: ctx.user.id,
        helpful: input.helpful,
        comment: input.comment,
      });
      // Update counts
      if (input.helpful) {
        await db.update(helpArticles).set({ helpfulCount: sql`${helpArticles.helpfulCount} + 1` }).where(eq(helpArticles.id, input.articleId));
      } else {
        await db.update(helpArticles).set({ notHelpfulCount: sql`${helpArticles.notHelpfulCount} + 1` }).where(eq(helpArticles.id, input.articleId));
      }
    }),

  /* ── AI Helper ──────────────────────────────────────────────────────────── */

  startConversation: workspaceProcedure.mutation(async ({ ctx }) => {
    const db = await requireDb();
    const [res] = await db.insert(aiHelpConversations).values({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
    });
    return { conversationId: (res as any).insertId as number };
  }),

  askAI: workspaceProcedure
    .input(
      z.object({
        conversationId: z.number(),
        message: z.string().min(1).max(2000),
        pageKey: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();

      // Verify conversation belongs to this user
      const [conv] = await db
        .select()
        .from(aiHelpConversations)
        .where(
          and(
            eq(aiHelpConversations.id, input.conversationId),
            eq(aiHelpConversations.userId, ctx.user.id),
          ),
        )
        .limit(1);
      if (!conv) throw new TRPCError({ code: "NOT_FOUND", message: "Conversation not found" });

      // Fetch recent articles for context
      const articles = await db
        .select({ id: helpArticles.id, title: helpArticles.title, summary: helpArticles.summary, bodyMarkdown: helpArticles.bodyMarkdown })
        .from(helpArticles)
        .where(and(eq(helpArticles.workspaceId, ctx.workspace.id), eq(helpArticles.status, "published")))
        .orderBy(desc(helpArticles.viewCount))
        .limit(20);

      // Fetch prior messages in conversation
      const priorMessages = await db
        .select()
        .from(aiHelpMessages)
        .where(eq(aiHelpMessages.conversationId, input.conversationId))
        .orderBy(aiHelpMessages.createdAt)
        .limit(10);

      // Build context
      const articleContext = articles
        .map((a) => `[Article ID ${a.id}] "${a.title}"\n${a.summary ?? ""}\n${(a.bodyMarkdown ?? "").slice(0, 600)}`)
        .join("\n\n---\n\n");

      const systemPrompt = `You are a helpful in-app assistant for a B2B SaaS sales platform called Velocity. 
Your job is to answer questions about how to use the platform based on the knowledge base articles provided.
Always be concise, friendly, and actionable. If you reference an article, include its ID in your response as [Article:ID].
Current page context: ${input.pageKey ?? "unknown"}.

Knowledge base articles:
${articleContext}`;

      const messages = [
        { role: "system" as const, content: systemPrompt },
        ...priorMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.body })),
        { role: "user" as const, content: input.message },
      ];

      // Save user message
      await db.insert(aiHelpMessages).values({
        conversationId: input.conversationId,
        role: "user",
        body: input.message,
      });

      // Call LLM
      const result = await invokeLLM({
        messages,
        maxTokens: 600,
        outputSchema: {
          type: "object",
          properties: {
            answer: { type: "string" },
            citedArticleIds: { type: "array", items: { type: "number" } },
            confidence: { type: "number", description: "0-100 confidence score" },
          },
          required: ["answer", "citedArticleIds", "confidence"],
        },
      });

      let answer = "";
      let citedArticleIds: number[] = [];
      let confidence = 80;

      try {
        const content = result.choices[0]?.message?.content;
        const text = typeof content === "string" ? content : JSON.stringify(content);
        const parsed = JSON.parse(text);
        answer = parsed.answer ?? text;
        citedArticleIds = parsed.citedArticleIds ?? [];
        confidence = parsed.confidence ?? 80;
      } catch {
        const content = result.choices[0]?.message?.content;
        answer = typeof content === "string" ? content : "I couldn't generate a response. Please try again.";
      }

      // Save assistant message
      const [msgRes] = await db.insert(aiHelpMessages).values({
        conversationId: input.conversationId,
        role: "assistant",
        body: answer,
        citedArticleIds,
        confidence: String(confidence),
      });

      // Update conversation lastMessageAt
      await db
        .update(aiHelpConversations)
        .set({ lastMessageAt: new Date() })
        .where(eq(aiHelpConversations.id, input.conversationId));

      return {
        messageId: (msgRes as any).insertId as number,
        answer,
        citedArticleIds,
        confidence,
      };
    }),

  getConversationMessages: workspaceProcedure
    .input(z.object({ conversationId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await requireDb();
      // Verify ownership
      const [conv] = await db
        .select()
        .from(aiHelpConversations)
        .where(and(eq(aiHelpConversations.id, input.conversationId), eq(aiHelpConversations.userId, ctx.user.id)))
        .limit(1);
      if (!conv) throw new TRPCError({ code: "NOT_FOUND" });
      return db
        .select()
        .from(aiHelpMessages)
        .where(eq(aiHelpMessages.conversationId, input.conversationId))
        .orderBy(aiHelpMessages.createdAt);
    }),

  /* ── AI Article Generation ──────────────────────────────────────────────── */

  generateArticleDraft: adminWsProcedure
    .input(
      z.object({
        topic: z.string().min(3).max(200),
        pageKey: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await invokeLLM({
        messages: [
          {
            role: "system",
            content: `You are a technical writer for a B2B SaaS sales platform called Velocity. 
Write a clear, concise help article in Markdown format. 
Include a title (# heading), a one-sentence summary, and step-by-step instructions with screenshots placeholders like ![Step 1](placeholder).
Keep the article under 600 words. Be friendly and action-oriented.`,
          },
          {
            role: "user",
            content: `Write a help article about: ${input.topic}${input.pageKey ? ` (context: ${input.pageKey} page)` : ""}`,
          },
        ],
        maxTokens: 1200,
        outputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
            bodyMarkdown: { type: "string" },
            suggestedSlug: { type: "string" },
            suggestedTags: { type: "array", items: { type: "string" } },
          },
          required: ["title", "summary", "bodyMarkdown", "suggestedSlug"],
        },
      });

      try {
        const content = result.choices[0]?.message?.content;
        const text = typeof content === "string" ? content : JSON.stringify(content);
        return JSON.parse(text);
      } catch {
        const content = result.choices[0]?.message?.content;
        return {
          title: input.topic,
          summary: "",
          bodyMarkdown: typeof content === "string" ? content : "",
          suggestedSlug: input.topic.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
          suggestedTags: [],
        };
      }
    }),

  /* ── Insights (admin) ───────────────────────────────────────────────────── */

  getInsights: adminWsProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    const [topArticles, recentSearches, unansweredSearches] = await Promise.all([
      db
        .select()
        .from(helpArticles)
        .where(eq(helpArticles.workspaceId, ctx.workspace.id))
        .orderBy(desc(helpArticles.viewCount))
        .limit(10),
      db
        .select()
        .from(helpSearchLog)
        .where(eq(helpSearchLog.workspaceId, ctx.workspace.id))
        .orderBy(desc(helpSearchLog.createdAt))
        .limit(20),
      db
        .select()
        .from(helpSearchLog)
        .where(and(eq(helpSearchLog.workspaceId, ctx.workspace.id), eq(helpSearchLog.resultsCount, 0)))
        .orderBy(desc(helpSearchLog.createdAt))
        .limit(10),
    ]);
    return { topArticles, recentSearches, unansweredSearches };
  }),

  /* ── Learning Preferences ───────────────────────────────────────────────── */

  getLearningPrefs: workspaceProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    const [prefs] = await db
      .select()
      .from(userLearningPreferences)
      .where(
        and(
          eq(userLearningPreferences.workspaceId, ctx.workspace.id),
          eq(userLearningPreferences.userId, ctx.user.id),
        ),
      )
      .limit(1);
    return (
      prefs ?? {
        showCoachMascot: true,
        showProactiveHints: true,
        completedOnboarding: false,
        preferredTourSpeed: "normal",
        dontShowHints: false,
      }
    );
  }),

  updateLearningPrefs: workspaceProcedure
    .input(
      z.object({
        showCoachMascot: z.boolean().optional(),
        showProactiveHints: z.boolean().optional(),
        completedOnboarding: z.boolean().optional(),
        preferredTourSpeed: z.enum(["slow", "normal", "fast"]).optional(),
        dontShowHints: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const existing = await db
        .select()
        .from(userLearningPreferences)
        .where(
          and(
            eq(userLearningPreferences.workspaceId, ctx.workspace.id),
            eq(userLearningPreferences.userId, ctx.user.id),
          ),
        )
        .limit(1);
      if (existing[0]) {
        await db
          .update(userLearningPreferences)
          .set(input)
          .where(
            and(
              eq(userLearningPreferences.workspaceId, ctx.workspace.id),
              eq(userLearningPreferences.userId, ctx.user.id),
            ),
          );
      } else {
        await db.insert(userLearningPreferences).values({
          workspaceId: ctx.workspace.id,
          userId: ctx.user.id,
          ...input,
        });
      }
    }),

  // ── Aliases so HelpCenter.tsx (createArticle/updateArticle) maps to upsertArticle ──
  createArticle: adminWsProcedure
    .input(
      z.object({
        categoryId: z.number().optional(),
        slug: z.string().min(1).max(200),
        title: z.string().min(1).max(300),
        summary: z.string().max(500).optional(),
        bodyMarkdown: z.string().optional(),
        tags: z.array(z.string()).optional(),
        status: z.enum(["draft", "published", "archived"]).default("draft"),
        associatedTourId: z.number().optional(),
        pageKey: z.string().max(120).optional(),
        pageKeys: z.array(z.string()).optional(),
        readingTimeMinutes: z.number().int().min(1).max(120).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const payload = { ...input, workspaceId: ctx.workspace.id, authorId: ctx.user.id, tags: input.tags ?? [] };
      const [res] = await db.insert(helpArticles).values(payload);
      return { id: (res as any).insertId as number };
    }),

  updateArticle: adminWsProcedure
    .input(
      z.object({
        id: z.number(),
        categoryId: z.number().optional(),
        slug: z.string().min(1).max(200).optional(),
        title: z.string().min(1).max(300).optional(),
        summary: z.string().max(500).optional(),
        bodyMarkdown: z.string().optional(),
        tags: z.array(z.string()).optional(),
        status: z.enum(["draft", "published", "archived"]).optional(),
        associatedTourId: z.number().optional(),
        pageKey: z.string().max(120).optional(),
        pageKeys: z.array(z.string()).optional(),
        readingTimeMinutes: z.number().int().min(1).max(120).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const { id, ...rest } = input;
      await db.update(helpArticles).set(rest).where(and(eq(helpArticles.id, id), eq(helpArticles.workspaceId, ctx.workspace.id)));
      return { id };
    }),
});
