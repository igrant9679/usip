/**
 * search — the one search box (owner, 2026-11-23: "a simple way to type in a
 * company name, person's name or email address and see their enriched info",
 * and "if the search doesn't find the person or company then the app should
 * go out to the prospect sources to get the info, and offer to create a
 * record in the system").
 *
 *   search.records           people, companies and leads in this workspace
 *                            that match what was typed, with the facts on each
 *   search.lookup            the same name looked up OUTSIDE: LinkedIn and the
 *                            connected databases' free previews
 *   search.createFromLookup  one found row saved as a person or a company
 *
 * The header's "Search…" box calls all three (CommandPalette), and so does
 * Elsie (assistantActionCatalog): the two reads run for her at once, the save
 * is a card the user confirms.
 *
 * `lookup` is a QUERY though it reaches vendors: it writes no record, and a
 * query is what Elsie can read the answer of. What it does cost is one
 * LinkedIn search against the account's daily cap, so nothing calls it on a
 * keystroke: the box asks only when its row is pressed.
 */
import { z } from "zod";
import { router } from "../_core/trpc";
import { isAdminRole, workspaceProcedure } from "../_core/workspace";
import { recordAudit } from "../audit";
import { searchRecords } from "../services/recordSearch";
import { lookupOutside, saveFromLookup } from "../services/recordLookup";
import { LOOKUP_MAX } from "@shared/recordLookup";

const name = z.string().trim().min(1).max(80);
const optional = (max: number) => z.string().trim().max(max).nullish();

/** One row, as search.lookup handed it out in `save`. */
export const lookupSaveSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("linkedin_person"), firstName: name, lastName: name, title: optional(200), company: optional(200), linkedinUrl: z.string().trim().min(3).max(2048), location: optional(200) }),
  z.object({ type: z.literal("source_person"), runId: z.number().int().positive(), resultId: z.number().int().positive() }),
  z.object({ type: z.literal("company"), name: z.string().trim().min(1).max(200), domain: optional(200) }),
]);

export const searchRouter = router({
  records: workspaceProcedure
    .input(z.object({ q: z.string().max(200) }))
    .query(({ ctx, input }) => searchRecords(ctx.workspace.id, input.q)),

  lookup: workspaceProcedure
    .input(z.object({
      q: z.string().trim().min(2).max(200),
      kind: z.enum(["person", "company"]),
      /** The rest of a database search that was still going (result.pending.runId). LinkedIn is not asked again. */
      runId: z.number().int().positive().optional(),
      /** Rows per source: 6 when left out (the Search box), up to LOOKUP_MAX (the name lookup's list of a company's people). */
      limit: z.number().int().min(1).max(LOOKUP_MAX).optional(),
    }))
    .query(({ ctx, input }) => lookupOutside(
      { workspaceId: ctx.workspace.id, userId: ctx.user.id, isAdmin: isAdminRole(ctx.member.role) },
      input.q, input.kind, input.runId ?? null, { limit: input.limit ?? null },
    )),

  createFromLookup: workspaceProcedure
    .input(z.object({ save: lookupSaveSchema }))
    .mutation(async ({ ctx, input }) => {
      const r = await saveFromLookup(
        { workspaceId: ctx.workspace.id, userId: ctx.user.id, isAdmin: isAdminRole(ctx.member.role) },
        input.save,
      );
      if (r.created) {
        await recordAudit({
          workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create",
          entityType: r.kind === "person" ? "prospect" : "account", entityId: r.id,
          after: { via: "search_lookup", from: input.save.type, unitsSpent: r.unitsSpent },
        });
      }
      return r;
    }),
});
