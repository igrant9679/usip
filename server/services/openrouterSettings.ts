/**
 * A workspace's OWN OpenRouter key and model, as stored (migration 0448).
 *
 * READ BY ITSELF, as DeepSeek's are (services/deepseekSettings, which says
 * why): migrations are applied after the server starts, and a select that
 * names a column the table does not have yet fails whole, which would cost
 * every workspace every key it has until the migration landed. Here a failed
 * read means "no OpenRouter key", which is what every workspace had before.
 *
 * This is the raw column. A caller that wants the key a workspace can USE
 * also asks services/keyShares for a lent one, and then falls back to the
 * platform's shared key (OPENROUTER_API_KEY), as both model funnels do.
 */
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";

export type OpenrouterSettings = { keyEnc: string | null; model: string | null };

const NONE: OpenrouterSettings = { keyEnc: null, model: null };

export async function openrouterSettings(workspaceId: number | undefined): Promise<OpenrouterSettings> {
  if (!workspaceId) return NONE;
  try {
    const db = await getDb();
    if (!db) return NONE;
    const [row] = await db
      .select({ keyEnc: workspaceSettings.openrouterApiKeyEnc, model: workspaceSettings.openrouterModel })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1);
    return { keyEnc: row?.keyEnc ?? null, model: row?.model ?? null };
  } catch (err) {
    console.error(`[openrouter] could not read the OpenRouter settings of workspace ${workspaceId}; treating it as having none:`, err instanceof Error ? err.message : String(err));
    return NONE;
  }
}
