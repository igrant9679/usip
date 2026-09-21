import { z } from "zod";
import { notifyOwner } from "./notification";
import { adminRuntimePayload } from "../health";
import { adminProcedure, publicProcedure, router } from "./trpc";
import { superAdminProcedure } from "./workspace";

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
   * NOT adminProcedure, the one used just below: that tests `users.role`, a
   * two-value global flag separate from the workspace role. It IS set to
   * "admin" for the owner, so it would work — but it has no other callers,
   * nothing in the app writes it, and no UI shows it, so what it means
   * today rests on whatever set it by hand.
   */
  deployRuntime: superAdminProcedure.query(() => adminRuntimePayload()),

  notifyOwner: adminProcedure
    .input(
      z.object({
        title: z.string().min(1, "title is required"),
        content: z.string().min(1, "content is required"),
      })
    )
    .mutation(async ({ input }) => {
      const delivered = await notifyOwner(input);
      return {
        success: delivered,
      } as const;
    }),
});
