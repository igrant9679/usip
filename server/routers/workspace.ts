import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { ensureUserHasWorkspace } from "../seed";
import {
  getDb,
  getUserWorkspaces,
  getWorkspaceCounts,
  getWorkspaceMembers,
} from "../db";
import { eq } from "drizzle-orm";
import { workspaces, workspaceSettings, brandVoiceProfiles } from "../../drizzle/schema";
import { slugify } from "@shared/slugify";

export const workspaceRouter = router({
  /**
   * Returns workspaces the current user is a member of.
   * Auto-bootstraps a demo workspace + seed data if the user has none.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    let mine = await getUserWorkspaces(ctx.user.id);
    if (mine.length === 0) {
      await ensureUserHasWorkspace(ctx.user.id, ctx.user.name);
      mine = await getUserWorkspaces(ctx.user.id);
    }
    return mine;
  }),

  current: workspaceProcedure.query(({ ctx }) => ({
    workspace: ctx.workspace,
    member: ctx.member,
  })),

  /**
   * Create a new workspace. **super_admin only.**
   *
   * Until now a `workspaces` row could only come into existence from seed.ts —
   * there was no in-product path at all, which is awkward for anything keyed on
   * a workspace (the Reoon/Apollo keys, autopilot modes, ICP profiles all are).
   *
   * The gate is deliberately "super_admin of a workspace you are already in",
   * not "any authenticated user": this is the agency shape, one workspace per
   * client, spun up by the operator — not self-serve tenant signup.
   *
   * `seedDemoData` defaults FALSE. A client workspace full of invented accounts
   * and [Demo] campaigns is worse than an empty one, and several engines read
   * those rows as real (the enrichment sweeper has to filter them out by name).
   * Help Center content is always seeded — it is enablement, not demo data.
   * Pipelines self-heal via ensureDefaultPipeline, so an empty workspace works.
   */
  create: workspaceProcedure
    .input(z.object({
      name: z.string().trim().min(2).max(120),
      seedDemoData: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.member.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only super admins can create workspaces." });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // slug is UNIQUE — derive from the name, then add entropy. Retry rather
      // than trusting one draw, so two workspaces named the same never collide.
      const base = slugify(input.name, 40) || "workspace"; // workspace slugs cap at 40
      let workspaceId = 0;
      let slug = "";
      for (let attempt = 0; attempt < 5 && !workspaceId; attempt++) {
        slug = `${base}-${Math.random().toString(36).slice(2, 7)}`.slice(0, 64);
        try {
          const r = await db.insert(workspaces).values({
            name: input.name,
            slug,
            ownerUserId: ctx.user.id,
            plan: "trial",
          });
          workspaceId = Number((r as any)[0]?.insertId ?? 0) || 0;
        } catch (e) {
          if (attempt === 4) {
            console.error("[workspace.create] insert failed:", (e as Error).message);
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not create the workspace." });
          }
        }
      }
      if (!workspaceId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not create the workspace." });

      // The creator must be a member, or they cannot open what they just made.
      const { workspaceMembers } = await import("../../drizzle/schema");
      await db.insert(workspaceMembers).values({
        workspaceId,
        userId: ctx.user.id,
        role: "super_admin",
        title: "Owner",
      });

      // Give per-workspace settings a home up front. Several dedicated setters
      // ensure this row lazily, but not all do, and a missing row makes those
      // saves look like they worked while writing nothing.
      try {
        await db.insert(workspaceSettings).values({ workspaceId });
      } catch (e) {
        console.error("[workspace.create] settings row failed:", (e as Error).message);
      }

      try {
        if (input.seedDemoData) {
          const { seedWorkspace } = await import("../seed");
          await seedWorkspace(workspaceId, ctx.user.id);
        } else {
          const { seedHelpContent } = await import("../seedHelpContent");
          await seedHelpContent(db as never, workspaceId);
        }
      } catch (e) {
        // The workspace exists and is usable; content seeding is not worth
        // failing the whole creation over.
        console.error("[workspace.create] seeding failed:", (e as Error).message);
      }

      return { id: workspaceId, slug, name: input.name };
    }),

  /**
   * Rename the workspace (admin+). The name is tenant-facing: it brands
   * proposal emails, AI prompts, and the workspace switcher — there was
   * previously no way to change it at all.
   */
  rename: workspaceProcedure
    .input(z.object({ name: z.string().trim().min(2).max(120) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.member.role !== "admin" && ctx.member.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Requires admin role" });
      }
      const { getDb } = await import("../db");
      const { workspaces } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(workspaces)
        .set({ name: input.name })
        .where(eq(workspaces.id, ctx.workspace.id));
      return { ok: true, name: input.name };
    }),

  /**
   * Aggregated per-workspace branding for the Branding settings section:
   * logo + display name (workspaces), colours + company profile
   * (workspace_settings), and brand voice (brand_voice_profiles) in one read.
   * Colours + company fields are ALSO editable via settings.save; voice via
   * brandVoice.save; the logo via updateBranding below. This is a read-only
   * convenience aggregator so the section renders from a single query.
   */
  getBranding: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [ws] = await db
      .select({ id: workspaces.id, name: workspaces.name, logoUrl: workspaces.logoUrl })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspace.id));
    const [s] = await db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
    const [voice] = await db
      .select()
      .from(brandVoiceProfiles)
      .where(eq(brandVoiceProfiles.workspaceId, ctx.workspace.id));
    return {
      name: ws?.name ?? "",
      logoUrl: ws?.logoUrl ?? null,
      brandPrimary: s?.brandPrimary ?? "#14B89A",
      brandAccent: s?.brandAccent ?? "#0F766E",
      companyDescription: s?.companyDescription ?? "",
      valueProposition: s?.valueProposition ?? "",
      companyIndustry: s?.companyIndustry ?? "",
      companyWebsite: s?.companyWebsite ?? "",
      companyKeywords: Array.isArray(s?.companyKeywords) ? (s!.companyKeywords as string[]) : [],
      companyTopics: Array.isArray(s?.companyTopics) ? (s!.companyTopics as string[]) : [],
      voice: voice
        ? { tone: voice.tone, vocabulary: voice.vocabulary ?? [], avoidWords: voice.avoidWords ?? [], applyToAI: voice.applyToAI }
        : null,
    };
  }),

  /**
   * Set the workspace logo URL (admin+). The logo lives on workspaces.logoUrl
   * and is rendered in the Shell + workspace switcher. Pass null to clear.
   */
  updateBranding: workspaceProcedure
    .input(z.object({ logoUrl: z.string().url().max(1000).nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.member.role !== "admin" && ctx.member.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Requires admin role" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(workspaces)
        .set({ logoUrl: input.logoUrl })
        .where(eq(workspaces.id, ctx.workspace.id));
      return { ok: true, logoUrl: input.logoUrl };
    }),

  members: workspaceProcedure.query(async ({ ctx }) => {
    return getWorkspaceMembers(ctx.workspace.id);
  }),

  summary: workspaceProcedure.query(async ({ ctx }) => {
    return getWorkspaceCounts(ctx.workspace.id);
  }),

  /**
   * Honest 7-day daily series for the Home hero sparklines: activities
   * logged, meetings scheduled, and inbound replies received per UTC day.
   */
  trend7d: workspaceProcedure.query(async ({ ctx }) => {
    const { getDb } = await import("../db");
    const { sql } = await import("drizzle-orm");
    const db = await getDb();
    const empty = Array.from({ length: 7 }, () => 0);
    if (!db) return { activities: empty, meetings: empty, replies: empty };
    const since = new Date(Date.now() - 6 * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);
    const dayKey = (d: Date) => d.toISOString().slice(0, 10);
    const days = Array.from({ length: 7 }, (_, i) => dayKey(new Date(since.getTime() + i * 86_400_000)));
    const bucket = async (table: string, dateCol: string): Promise<number[]> => {
      const rows = (await db.execute(
        sql.raw(`SELECT DATE(${dateCol}) d, COUNT(*) n FROM \`${table}\` WHERE workspaceId = ${Number(ctx.workspace.id)} AND ${dateCol} >= '${since.toISOString().slice(0, 19).replace("T", " ")}' GROUP BY DATE(${dateCol})`),
      )) as unknown as [Array<{ d: string | Date; n: number }>];
      const byDay = new Map((rows[0] ?? []).map((r) => [dayKey(new Date(r.d)), Number(r.n)]));
      return days.map((d) => byDay.get(d) ?? 0);
    };
    const [activities, meetings, replies] = await Promise.all([
      bucket("activities", "occurredAt"),
      bucket("meetings", "scheduledAt"),
      bucket("email_replies", "receivedAt"),
    ]);
    return { activities, meetings, replies };
  }),

  switch: protectedProcedure
    .input(z.object({ workspaceId: z.number().int() }))
    .mutation(async ({ input, ctx }) => {
      const mine = await getUserWorkspaces(ctx.user.id);
      const ok = mine.find((w) => w.id === input.workspaceId);
      if (!ok) throw new Error("Not a member of that workspace");
      // Frontend persists the current workspace id and sends it via header on each call.
      return { ok: true, workspaceId: input.workspaceId };
    }),
});
