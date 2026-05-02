/**
 * Tours tRPC router
 * Covers: tour CRUD, step CRUD, user progress tracking,
 * achievements, recommendations, and tour analytics.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  tourAchievements,
  tours,
  tourSteps,
  userTourProgress,
  workspaceMembers,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { router } from "../_core/trpc";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

const TOUR_BADGES: Record<string, string> = {
  onboarding: "🎓 Onboarding Complete",
  feature: "⭐ Feature Mastered",
  whats_new: "🆕 Up to Date",
  custom: "🏆 Tour Complete",
};

export const toursRouter = router({
  /* ── Tour CRUD ──────────────────────────────────────────────────────────── */

  list: workspaceProcedure
    .input(
      z.object({
        type: z.enum(["onboarding", "feature", "whats_new", "custom", "all"]).default("all"),
        status: z.enum(["draft", "published", "all"]).default("published"),
        pageKey: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await requireDb();
      const conditions = [eq(tours.workspaceId, ctx.workspace.id)];
      if (input.type !== "all") conditions.push(eq(tours.type, input.type));
      if (input.status !== "all") conditions.push(eq(tours.status, input.status));
      if (input.pageKey) conditions.push(eq(tours.pageKey, input.pageKey));
      return db.select().from(tours).where(and(...conditions)).orderBy(tours.type, tours.name);
    }),

  get: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await requireDb();
      const [tour] = await db
        .select()
        .from(tours)
        .where(and(eq(tours.id, input.id), eq(tours.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!tour) throw new TRPCError({ code: "NOT_FOUND" });
      // Select explicit columns so the query degrades gracefully if routeTo
      // column hasn't been added by migration 0054 yet.
      let steps: typeof tourSteps.$inferSelect[] = [];
      try {
        steps = await db
          .select()
          .from(tourSteps)
          .where(eq(tourSteps.tourId, input.id))
          .orderBy(tourSteps.sortOrder);
      } catch {
        // Fallback: select without routeTo for pre-migration databases.
        // db.execute() in Drizzle MySQL returns a tuple: [rows[], fields].
        const [fallbackRows] = await db.execute(
          sql`SELECT id, tourId, sortOrder, targetSelector, targetDataTourId,
                  title, bodyMarkdown, visualTreatment, advanceCondition,
                  advanceConfig, skipAllowed, backAllowed, branchingRules, createdAt
           FROM tour_steps WHERE tourId = ${input.id} ORDER BY sortOrder`,
        ) as unknown as [Record<string, unknown>[], unknown];
        steps = (fallbackRows ?? []) as typeof tourSteps.$inferSelect[];
      }
      return { ...tour, steps };
    }),

  upsert: adminWsProcedure
    .input(
      z.object({
        id: z.number().optional(),
        name: z.string().min(1).max(200),
        description: z.string().optional(),
        type: z.enum(["onboarding", "feature", "whats_new", "custom"]).default("feature"),
        roleTags: z.array(z.string()).optional(),
        estimatedMinutes: z.number().min(1).max(60).default(3),
        prerequisiteTourId: z.number().optional(),
        status: z.enum(["draft", "published"]).default("draft"),
        pageKey: z.string().max(120).optional(),
        steps: z
          .array(
            z.object({
              id: z.number().optional(),
              sortOrder: z.number(),
              targetSelector: z.string().max(500).optional(),
              targetDataTourId: z.string().max(200).optional(),
              routeTo: z.string().max(200).optional(),
              title: z.string().min(1).max(300),
              bodyMarkdown: z.string().optional(),
              visualTreatment: z.enum(["spotlight", "pulse", "arrow", "coach"]).default("spotlight"),
              advanceCondition: z
                .enum(["next_button", "element_clicked", "form_field_filled", "route_changed", "custom_event"])
                .default("next_button"),
              advanceConfig: z.any().optional(),
              skipAllowed: z.boolean().default(true),
              backAllowed: z.boolean().default(true),
              branchingRules: z.any().optional(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const { id, steps, ...rest } = input;
      const payload = { ...rest, workspaceId: ctx.workspace.id, createdBy: ctx.user.id };

      let tourId = id;
      if (id) {
        await db
          .update(tours)
          .set(rest)
          .where(and(eq(tours.id, id), eq(tours.workspaceId, ctx.workspace.id)));
      } else {
        const [res] = await db.insert(tours).values(payload);
        tourId = (res as any).insertId as number;
      }

      // Upsert steps
      if (steps && tourId) {
        for (const step of steps) {
          const { id: stepId, ...stepRest } = step;
          if (stepId) {
            await db
              .update(tourSteps)
              .set(stepRest)
              .where(and(eq(tourSteps.id, stepId), eq(tourSteps.tourId, tourId)));
          } else {
            await db.insert(tourSteps).values({ ...stepRest, tourId });
          }
        }
      }

      return { id: tourId };
    }),

  deleteStep: adminWsProcedure
    .input(z.object({ stepId: z.number(), tourId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      // Verify tour belongs to workspace
      const [tour] = await db
        .select()
        .from(tours)
        .where(and(eq(tours.id, input.tourId), eq(tours.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!tour) throw new TRPCError({ code: "NOT_FOUND" });
      await db.delete(tourSteps).where(and(eq(tourSteps.id, input.stepId), eq(tourSteps.tourId, input.tourId)));
    }),

  deleteTour: adminWsProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      await db.delete(tourSteps).where(eq(tourSteps.tourId, input.id));
      await db.delete(tours).where(and(eq(tours.id, input.id), eq(tours.workspaceId, ctx.workspace.id)));
    }),

  /* ── Progress ───────────────────────────────────────────────────────────── */

  getMyProgress: workspaceProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    return db
      .select()
      .from(userTourProgress)
      .where(
        and(
          eq(userTourProgress.workspaceId, ctx.workspace.id),
          eq(userTourProgress.userId, ctx.user.id),
        ),
      );
  }),

  startTour: workspaceProcedure
    .input(z.object({ tourId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const existing = await db
        .select()
        .from(userTourProgress)
        .where(
          and(
            eq(userTourProgress.userId, ctx.user.id),
            eq(userTourProgress.tourId, input.tourId),
          ),
        )
        .limit(1);
      if (existing[0]) {
        if (existing[0].status === "completed") return { alreadyCompleted: true };
        await db
          .update(userTourProgress)
          .set({ status: "in_progress", lastResumedAt: new Date() })
          .where(eq(userTourProgress.id, existing[0].id));
        return { alreadyCompleted: false, currentStep: existing[0].currentStep };
      }
      await db.insert(userTourProgress).values({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        tourId: input.tourId,
        status: "in_progress",
        startedAt: new Date(),
      });
      return { alreadyCompleted: false, currentStep: 0 };
    }),

  advanceStep: workspaceProcedure
    .input(z.object({ tourId: z.number(), stepIndex: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      await db
        .update(userTourProgress)
        .set({ currentStep: input.stepIndex, lastResumedAt: new Date() })
        .where(
          and(
            eq(userTourProgress.userId, ctx.user.id),
            eq(userTourProgress.tourId, input.tourId),
          ),
        );
    }),

  completeTour: workspaceProcedure
    .input(z.object({ tourId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      await db
        .update(userTourProgress)
        .set({ status: "completed", completedAt: new Date() })
        .where(
          and(
            eq(userTourProgress.userId, ctx.user.id),
            eq(userTourProgress.tourId, input.tourId),
          ),
        );

      // Award achievement
      const [tour] = await db.select().from(tours).where(eq(tours.id, input.tourId)).limit(1);
      const badge = tour ? TOUR_BADGES[tour.type] ?? "🏆 Tour Complete" : "🏆 Tour Complete";
      await db.insert(tourAchievements).values({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        tourId: input.tourId,
        badge,
      });

      return { badge };
    }),

  skipTour: workspaceProcedure
    .input(z.object({ tourId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const existing = await db
        .select()
        .from(userTourProgress)
        .where(and(eq(userTourProgress.userId, ctx.user.id), eq(userTourProgress.tourId, input.tourId)))
        .limit(1);
      if (existing[0]) {
        await db
          .update(userTourProgress)
          .set({ status: "skipped" })
          .where(eq(userTourProgress.id, existing[0].id));
      } else {
        await db.insert(userTourProgress).values({
          workspaceId: ctx.workspace.id,
          userId: ctx.user.id,
          tourId: input.tourId,
          status: "skipped",
        });
      }
    }),

  /* ── Achievements ───────────────────────────────────────────────────────── */

  getMyAchievements: workspaceProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    return db
      .select()
      .from(tourAchievements)
      .where(
        and(
          eq(tourAchievements.workspaceId, ctx.workspace.id),
          eq(tourAchievements.userId, ctx.user.id),
        ),
      )
      .orderBy(desc(tourAchievements.earnedAt));
  }),

  /* ── Recommendations ────────────────────────────────────────────────────── */

  getRecommended: workspaceProcedure
    .input(z.object({ pageKey: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const db = await requireDb();

      // Get tours the user has already completed or skipped
      const doneProgress = await db
        .select({ tourId: userTourProgress.tourId })
        .from(userTourProgress)
        .where(
          and(
            eq(userTourProgress.userId, ctx.user.id),
            inArray(userTourProgress.status, ["completed", "skipped"]),
          ),
        );
      const doneIds = doneProgress.map((r) => r.tourId);

      const conditions = [
        eq(tours.workspaceId, ctx.workspace.id),
        eq(tours.status, "published"),
      ];
      if (doneIds.length > 0) {
        conditions.push(ne(tours.id, doneIds[0])); // simplified exclusion
      }
      if (input.pageKey) conditions.push(eq(tours.pageKey, input.pageKey));

      const allTours = await db
        .select()
        .from(tours)
        .where(and(...conditions))
        .orderBy(tours.type, tours.estimatedMinutes)
        .limit(6);

      // Filter out all done tours client-side (simpler than complex SQL NOT IN)
      return allTours.filter((t) => !doneIds.includes(t.id));
    }),

  /* ── Analytics (admin) ──────────────────────────────────────────────────── */

  getAnalytics: adminWsProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    const [allTours, allProgress, allAchievements] = await Promise.all([
      db.select().from(tours).where(eq(tours.workspaceId, ctx.workspace.id)),
      db.select().from(userTourProgress).where(eq(userTourProgress.workspaceId, ctx.workspace.id)),
      db.select().from(tourAchievements).where(eq(tourAchievements.workspaceId, ctx.workspace.id)),
    ]);

    const completionByTour = allTours.map((tour) => {
      const tourProgress = allProgress.filter((p) => p.tourId === tour.id);
      const completed = tourProgress.filter((p) => p.status === "completed").length;
      const started = tourProgress.filter((p) => p.status === "in_progress").length;
      const skipped = tourProgress.filter((p) => p.status === "skipped").length;
      return {
        tourId: tour.id,
        tourName: tour.name,
        type: tour.type,
        started,
        completed,
        skipped,
        completionRate: tourProgress.length > 0 ? Math.round((completed / tourProgress.length) * 100) : 0,
      };
    });

    return {
      totalTours: allTours.length,
      totalCompletions: allAchievements.length,
      completionByTour,
    };
  }),

  // ── Aliases so TourBuilder.tsx (create/update/delete) maps to the same logic ──
  create: adminWsProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().optional(),
        type: z.enum(["onboarding", "feature", "whats_new", "custom"]).default("feature"),
        roleTags: z.array(z.string()).optional(),
        estimatedMinutes: z.number().min(1).max(60).default(3),
        status: z.enum(["draft", "published"]).default("draft"),
        pageKey: z.string().max(120).optional(),
        steps: z.array(z.any()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const { steps, ...rest } = input;
      const payload = { ...rest, workspaceId: ctx.workspace.id, createdBy: ctx.user.id };
      const [res] = await db.insert(tours).values(payload);
      const tourId = (res as any).insertId as number;
      if (steps && tourId) {
        for (const step of steps) {
          const { id: _id, ...stepRest } = step;
          await db.insert(tourSteps).values({ ...stepRest, tourId });
        }
      }
      return { id: tourId };
    }),

  update: adminWsProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().optional(),
        type: z.enum(["onboarding", "feature", "whats_new", "custom"]).optional(),
        roleTags: z.array(z.string()).optional(),
        estimatedMinutes: z.number().min(1).max(60).optional(),
        status: z.enum(["draft", "published"]).optional(),
        pageKey: z.string().max(120).optional(),
        steps: z.array(z.any()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const { id, steps, ...rest } = input;
      await db.update(tours).set(rest).where(and(eq(tours.id, id), eq(tours.workspaceId, ctx.workspace.id)));
      if (steps) {
        for (const step of steps) {
          const { id: stepId, ...stepRest } = step;
          if (stepId) {
            await db.update(tourSteps).set(stepRest).where(and(eq(tourSteps.id, stepId), eq(tourSteps.tourId, id)));
          } else {
            await db.insert(tourSteps).values({ ...stepRest, tourId: id });
          }
        }
      }
      return { id };
    }),

  delete: adminWsProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      await db.delete(tourSteps).where(eq(tourSteps.tourId, input.id));
      await db.delete(tours).where(and(eq(tours.id, input.id), eq(tours.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),
});
