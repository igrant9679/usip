/**
 * search — the one search box (owner, 2026-11-23: "a simple way to type in a
 * company name, person's name or email address and see their enriched info").
 *
 *   search.records   people, companies and leads in this workspace that
 *                    match what was typed, with the facts already on each
 *
 * The header's "Search…" box calls it (CommandPalette), and so does Elsie
 * (assistantActionCatalog). A read; it changes nothing and calls no vendor.
 */
import { z } from "zod";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { searchRecords } from "../services/recordSearch";

export const searchRouter = router({
  records: workspaceProcedure
    .input(z.object({ q: z.string().max(200) }))
    .query(({ ctx, input }) => searchRecords(ctx.workspace.id, input.q)),
});
