import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminRuntimePayload } from "../health";
import { getDb } from "../db";
import { engineStatusFor } from "../services/engineStatus";
import { publicProcedure, router } from "./trpc";
import { adminWsProcedure, superAdminProcedure } from "./workspace";

export const systemRouter = router({
  /** Public branding config. The Logo Link client id is public BY DESIGN —
   *  Brandfetch's hotlink model embeds it in every <img> URL — so serving it
   *  to the client is the intended usage, not a leak. The SEARCH client id
   *  is deliberately absent here and never leaves the server. */
  brandingConfig: publicProcedure.query(() => ({
    brandfetchLogoClientId: process.env.BRANDFETCH_LOGO_CLIENT_ID ?? null,
  })),

  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),

  /**
   * Which runtime this deploy actually landed on. Admin-gated rather than
   * added to GET /api/health, which is public and deliberately capped at
   * four non-secret keys — see server/health.ts.
   *
   * superAdminProcedure, deliberately the NARROWEST workspace gate. This is
   * an infrastructure fact with no workspace dimension: it describes the
   * host every tenant shares, not the tenant asking. Under adminWsProcedure
   * the reader set was tenant-controlled and self-expanding — any workspace
   * admin can promote a peer to admin, and that peer could then read the
   * production host's exact Node patch version. A super_admin cannot be
   * minted the same way.
   *
   * NOT adminProcedure: that tests `users.role`, a two-value global flag
   * separate from the workspace role. It IS set to "admin" for the owner,
   * so it would work — but nothing in the app writes it and no UI shows it,
   * so what it means today rests on whatever set it by hand. (Its one user
   * here, notifyOwner, had no caller and was deleted: audit X6.2, 2026-11-07.)
   */
  deployRuntime: superAdminProcedure.query(() => adminRuntimePayload()),

  /**
   * The engine status page (audit 2026-10-20, F49): each engine's last tick
   * and failures, this workspace's queues and browser errors, and the slow
   * queries sampled. Admins: the queues and errors are their workspace's.
   * The engines and slow queries are the install's, so their error text and
   * statements are for a super admin only (services/engineStatus.ts).
   */
  engineStatus: adminWsProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    return engineStatusFor(db, ctx.workspace.id, { showErrors: ctx.member.role === "super_admin" });
  }),
});
