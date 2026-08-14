/**
 * The workspace's single SendGrid API key (owner ask 2026-08-14: "add an entry
 * in the integrations settings page for one SendGrid API key").
 *
 * Stored on the `sendgrid` row of workspace_integrations, ENCRYPTED, under
 * `apiKeyEnc`. Two things that are deliberately not the house default for that
 * table:
 *
 *  - `workspace_integrations.config` is plain JSON and `integrations.list` is a
 *    workspaceProcedure — any MEMBER can read it. A live API key must not sit
 *    there in the clear, so it is encrypted at rest and the list path redacts
 *    it to `hasApiKey` (see integrations.ts).
 *  - It is resolved server-side per use and never returned to a client, the
 *    same rule sendingAccounts already applies to its per-account copy.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { workspaceIntegrations } from "../../drizzle/schema";
import { encryptSecret, tryDecryptSecret } from "../_core/crypto";

export const SENDGRID_PROVIDER = "sendgrid" as const;
/** The config field holding the ciphertext. Redacted everywhere it is read. */
export const SENDGRID_KEY_FIELD = "apiKeyEnc";

/** The workspace's SendGrid key in plaintext, or null. Never return this. */
export async function getWorkspaceSendgridKey(workspaceId: number): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select({ config: workspaceIntegrations.config })
    .from(workspaceIntegrations)
    .where(and(
      eq(workspaceIntegrations.workspaceId, workspaceId),
      eq(workspaceIntegrations.provider, SENDGRID_PROVIDER),
    ))
    .limit(1);
  const enc = (row?.config as Record<string, unknown> | null)?.[SENDGRID_KEY_FIELD];
  return typeof enc === "string" ? (tryDecryptSecret(enc) || null) : null;
}

/** Store (or clear) the workspace key. Returns whether a key is now set. */
export async function setWorkspaceSendgridKey(workspaceId: number, apiKey: string | null): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const [existing] = await db
    .select({ id: workspaceIntegrations.id, config: workspaceIntegrations.config })
    .from(workspaceIntegrations)
    .where(and(
      eq(workspaceIntegrations.workspaceId, workspaceId),
      eq(workspaceIntegrations.provider, SENDGRID_PROVIDER),
    ))
    .limit(1);

  const prev = (existing?.config as Record<string, unknown> | null) ?? {};
  const next = { ...prev };
  const trimmed = apiKey?.trim();
  if (trimmed) next[SENDGRID_KEY_FIELD] = encryptSecret(trimmed);
  else delete next[SENDGRID_KEY_FIELD];
  const hasKey = !!next[SENDGRID_KEY_FIELD];

  if (existing) {
    await db.update(workspaceIntegrations)
      .set({ config: next, status: hasKey ? "connected" : "disconnected" } as never)
      .where(eq(workspaceIntegrations.id, existing.id));
  } else {
    await db.insert(workspaceIntegrations).values({
      workspaceId, provider: SENDGRID_PROVIDER,
      status: hasKey ? "connected" : "disconnected", config: next,
    } as never);
  }
  return hasKey;
}

/**
 * Strip the ciphertext out of a config before it goes to a client, leaving a
 * boolean in its place. Applied by integrations.list to EVERY provider row —
 * a redactor that only knows about one provider stops being true the moment
 * someone adds another secret.
 */
export function redactIntegrationConfig(config: unknown): Record<string, unknown> {
  const c = (config ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (/enc$|secret|token|apikey|api_key|password/i.test(k)) {
      out[`has${k[0]!.toUpperCase()}${k.slice(1)}`.replace(/Enc$/, "")] = typeof v === "string" ? v.length > 0 : !!v;
      continue;
    }
    out[k] = v;
  }
  return out;
}
