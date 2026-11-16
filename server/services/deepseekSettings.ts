/**
 * A workspace's OWN DeepSeek key and model, as stored (migration 0443).
 *
 * READ BY ITSELF, never in the select that reads the other providers' columns.
 * Migrations are applied after the server starts, and a select that names a
 * column the table does not have yet fails whole. The credential read every
 * model call makes would then lose all four keys at once and send every
 * workspace to the deployment's keys until the migration landed; the lent-key
 * read would lend nothing. Here a failed read means "no DeepSeek key", which
 * is what every workspace had before this existed.
 *
 * This is the raw column. A caller that wants the key a workspace can USE
 * also asks services/keyShares for a lent one, as it does for the others.
 */
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";

export type DeepseekSettings = { keyEnc: string | null; model: string | null };

const NONE: DeepseekSettings = { keyEnc: null, model: null };

export async function deepseekSettings(workspaceId: number | undefined): Promise<DeepseekSettings> {
  if (!workspaceId) return NONE;
  try {
    const db = await getDb();
    if (!db) return NONE;
    const [row] = await db
      .select({ keyEnc: workspaceSettings.deepseekApiKeyEnc, model: workspaceSettings.deepseekModel })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1);
    return { keyEnc: row?.keyEnc ?? null, model: row?.model ?? null };
  } catch (err) {
    console.error(`[deepseek] could not read the DeepSeek settings of workspace ${workspaceId}; treating it as having none:`, err instanceof Error ? err.message : String(err));
    return NONE;
  }
}
