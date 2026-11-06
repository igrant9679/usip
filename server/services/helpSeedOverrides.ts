/**
 * What a person changed in Help, so the boot seed leaves it alone (audit
 * 2026-10-20, G21).
 *
 * seedHelpContent and seedTours re-apply their articles (by slug) and tours (by
 * name) on every deploy, which is how shipped help updates reach workspaces
 * that already have the content. They also reverted every admin edit 20 s
 * after each deploy and re-created anything an admin had deleted. Every admin
 * write to an article or tour now records its key here first; the seeds skip
 * a recorded key, and keep updating the ones nobody has touched.
 *
 * Recorded for any article or tour, seeded or not: a key the seed never ships
 * costs one row and changes nothing.
 */
import { and, eq } from "drizzle-orm";
import { helpSeedOverrides } from "../../drizzle/schema";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type HelpSeedKind = "article" | "tour";

/**
 * Record that a person edited or deleted the article/tour whose seed key (slug
 * or name, as it was before this write) is `seedKey`. A later delete replaces
 * an earlier "edited". Failure is logged, not thrown: the admin's own write
 * should not fail because this bookkeeping did.
 */
export async function noteHelpOverride(
  db: Db,
  workspaceId: number,
  kind: HelpSeedKind,
  seedKey: string | null | undefined,
  action: "edited" | "deleted",
  userId: number | null,
): Promise<void> {
  if (!seedKey) return;
  try {
    await db
      .insert(helpSeedOverrides)
      .values({ workspaceId, kind, seedKey: seedKey.slice(0, 200), action, userId })
      .onDuplicateKeyUpdate({ set: action === "deleted" ? { action, userId } : { userId } });
  } catch (e) {
    console.error(`[HelpSeedOverrides] could not record ${kind} "${seedKey}" (${action}):`, (e as Error)?.message ?? e);
  }
}

/**
 * The keys of `kind` a person has changed in this workspace, or null when they
 * could not be read (the seed then treats every existing row as changed and
 * only adds what is missing, rather than risk overwriting an edit).
 */
export async function helpOverrideKeys(db: Db, workspaceId: number, kind: HelpSeedKind): Promise<Set<string> | null> {
  try {
    const rows = await db
      .select({ seedKey: helpSeedOverrides.seedKey })
      .from(helpSeedOverrides)
      .where(and(eq(helpSeedOverrides.workspaceId, workspaceId), eq(helpSeedOverrides.kind, kind)));
    return new Set(rows.map((r) => r.seedKey));
  } catch (e) {
    console.error(`[HelpSeedOverrides] could not read ${kind} overrides for workspace ${workspaceId}:`, (e as Error)?.message ?? e);
    return null;
  }
}
