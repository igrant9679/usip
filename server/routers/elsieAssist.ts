/**
 * elsieAssist — the Assist pane's endpoints (shared/elsieAssist.ts has the why).
 *
 *   get        the suggestions for the page the user is on (any member)
 *   prefs      this user's own settings for the pane: open or closed, kinds muted
 *   setPrefs   change them (open, mute a kind, unmute a kind)
 *   setDailyCap  the workspace's daily number of model passes (admins)
 *
 * Read-only towards the workspace's records: a suggestion's button opens a
 * page or puts a request to Elsie in her chat, where a change still shows its
 * confirm card. Nothing here changes a record.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { workspaceSettings } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import {
  ASSIST_DAILY_CAP_MAX,
  ASSIST_KIND_IDS,
  assistPlaceFor,
  type AssistKind,
} from "@shared/elsieAssist";
import {
  assistDailyCap,
  assistPassesToday,
  buildCandidates,
  loadAssistPrefs,
  saveAssistPrefs,
  suggestionsFor,
  type AssistCaller,
} from "../services/elsieAssist";

const kindEnum = z.enum(ASSIST_KIND_IDS as [AssistKind, ...AssistKind[]]);

async function getCaller(ctx: unknown): Promise<AssistCaller> {
  // Dynamic import breaks the routers.ts ⇄ elsieAssist.ts cycle (as routers/assistant.ts does).
  const { appRouter } = await import("../routers");
  return appRouter.createCaller(ctx as never) as unknown as AssistCaller;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

export const elsieAssistRouter = router({
  get: workspaceProcedure
    .input(z.object({ pagePath: z.string().max(300) }))
    .query(async ({ ctx, input }) => {
      const db = await requireDb();
      const prefs = await loadAssistPrefs(db, ctx.user.id);
      const where = assistPlaceFor(input.pagePath);
      if (!where) {
        const [cap, used] = await Promise.all([assistDailyCap(db, ctx.workspace.id), assistPassesToday(db, ctx.workspace.id)]);
        return { place: null, suggestions: [], muted: prefs.muted, passes: { used, cap } };
      }
      const candidates = await buildCandidates({
        db,
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        caller: await getCaller(ctx),
        place: where.place,
        id: where.id,
      });
      const { suggestions, passes } = await suggestionsFor({ db, workspaceId: ctx.workspace.id, candidates, muted: prefs.muted });
      return { place: where.place, suggestions, muted: prefs.muted, passes };
    }),

  prefs: workspaceProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    return loadAssistPrefs(db, ctx.user.id);
  }),

  setPrefs: workspaceProcedure
    .input(z.object({ open: z.boolean().optional(), mute: kindEnum.optional(), unmute: kindEnum.optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const prefs = await loadAssistPrefs(db, ctx.user.id);
      const muted = new Set(prefs.muted);
      if (input.mute) muted.add(input.mute);
      if (input.unmute) muted.delete(input.unmute);
      const next = { open: input.open ?? prefs.open, muted: Array.from(muted) };
      await saveAssistPrefs(db, ctx.user.id, next);
      return next;
    }),

  /** `cap: null` goes back to the default; 0 turns the model's rewording off (the rules' own lines still show). */
  setDailyCap: adminWsProcedure
    .input(z.object({ cap: z.number().int().min(0).max(ASSIST_DAILY_CAP_MAX).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const before = await assistDailyCap(db, ctx.workspace.id);
      const [existing] = await db
        .select({ workspaceId: workspaceSettings.workspaceId })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
        .limit(1);
      if (!existing) await db.insert(workspaceSettings).values({ workspaceId: ctx.workspace.id });
      await db.update(workspaceSettings).set({ elsieAssistDailyCap: input.cap }).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      const cap = await assistDailyCap(db, ctx.workspace.id);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "elsie_assist_daily_cap", entityId: ctx.workspace.id, before: { cap: before }, after: { cap } });
      return { cap };
    }),
});
