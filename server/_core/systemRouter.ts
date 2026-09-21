import { z } from "zod";
import { notifyOwner } from "./notification";
import { adminRuntimePayload } from "../health";
import { adminProcedure, publicProcedure, router } from "./trpc";
import { adminWsProcedure } from "./workspace";

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
   * Gated with adminWsProcedure, NOT the adminProcedure used just below.
   * That one tests `users.role === "admin"`, a vestigial global flag no
   * production code path ever sets, so gating on it would ship an endpoint
   * nobody — including the owner — can call.
   */
  deployRuntime: adminWsProcedure.query(() => adminRuntimePayload()),

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
