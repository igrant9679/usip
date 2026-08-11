import { z } from "zod";
import { notifyOwner } from "./notification";
import { adminProcedure, publicProcedure, router } from "./trpc";

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
