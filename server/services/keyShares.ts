/**
 * Keys one workspace lends another (owner ask 2026-11-13: "give admins the
 * ability to share API keys and tokens with other Spaces"; migration 0440).
 *
 * A LIVE LINK, not a copy. A `workspace_key_shares` row says "workspace T may
 * use workspace O's key of this kind". Nothing is stored in T: every read
 * comes here and reads O's own column at that moment, so
 *   - rotating or clearing the key in O changes it for T on the next call,
 *   - deleting the row stops T's use at once,
 *   - T never holds the key and is never shown it, masked or not.
 *
 * The order every key read follows: the workspace's OWN key first, then a key
 * lent to it, then whatever fallback that vendor already had (the deployment's
 * key, where the platform owner allowed it). A lent key is the lender's own
 * key and nothing else: a workspace cannot pass on a key it borrows.
 *
 * **Every** read of a shareable key must go through here. A share that only
 * some of the app honours would show "connected" in Settings and fail in the
 * engine, which is worse than no share at all.
 *
 * A failed read lends nothing (the same rule the opt-in platform keys follow
 * in services/reoon and services/quickenrich).
 */
import { and, eq, inArray } from "drizzle-orm";
import { prospectSourceCredentials, workspaceKeyShares, workspaceSettings, workspaces } from "../../drizzle/schema";
import { getDb } from "../db";
import { tryDecryptSecret } from "../_core/crypto";

/** Keys kept as a column on the lender's workspace_settings row. */
export const SETTINGS_SHARE_KINDS = ["anthropic", "openai", "gemini", "xai", "apollo", "reoon", "quickenrich"] as const;
/** Keys kept as the lender's prospect_source_credentials row (the source's slug). */
export const SOURCE_SHARE_KINDS = ["warmysender", "leadocean"] as const;
export const SHARE_KINDS = [...SETTINGS_SHARE_KINDS, ...SOURCE_SHARE_KINDS] as const;

export type SettingsShareKind = (typeof SETTINGS_SHARE_KINDS)[number];
export type SourceShareKind = (typeof SOURCE_SHARE_KINDS)[number];
export type ShareKind = (typeof SHARE_KINDS)[number];

export const SHARE_KIND_LABEL: Record<ShareKind, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  gemini: "Google Gemini",
  xai: "xAI (voice agents)",
  apollo: "Apollo",
  reoon: "Reoon email verifier",
  quickenrich: "QuickEnrich",
  warmysender: "WarmySender",
  leadocean: "LeadOcean",
};

const SETTINGS_COLUMN: Record<SettingsShareKind, "anthropicApiKeyEnc" | "openaiApiKeyEnc" | "geminiApiKeyEnc" | "xaiApiKeyEnc" | "apolloApiKeyEnc" | "reoonApiKeyEnc" | "quickenrichApiKeyEnc"> = {
  anthropic: "anthropicApiKeyEnc",
  openai: "openaiApiKeyEnc",
  gemini: "geminiApiKeyEnc",
  xai: "xaiApiKeyEnc",
  apollo: "apolloApiKeyEnc",
  reoon: "reoonApiKeyEnc",
  quickenrich: "quickenrichApiKeyEnc",
};

export function isShareKind(v: string): v is ShareKind {
  return (SHARE_KINDS as readonly string[]).includes(v);
}
export function isSourceShareKind(v: string): v is SourceShareKind {
  return (SOURCE_SHARE_KINDS as readonly string[]).includes(v);
}

/**
 * Who lends `workspaceId` each of `kinds`: kind → the lender's workspace id.
 * An archived lender lends nothing: its keys are not in use anywhere.
 */
export async function lendersFor(workspaceId: number, kinds: readonly ShareKind[]): Promise<Partial<Record<ShareKind, number>>> {
  if (!workspaceId || kinds.length === 0) return {};
  try {
    const db = await getDb();
    if (!db) return {};
    const rows = await db
      .select({ owner: workspaceKeyShares.ownerWorkspaceId, kind: workspaceKeyShares.keyKind })
      .from(workspaceKeyShares)
      .where(and(eq(workspaceKeyShares.targetWorkspaceId, workspaceId), inArray(workspaceKeyShares.keyKind, [...kinds])));
    if (rows.length === 0) return {};
    const owners = Array.from(new Set(rows.map((r) => r.owner))).filter((id) => id !== workspaceId);
    if (owners.length === 0) return {};
    const live = new Set(
      (await db.select({ id: workspaces.id, archivedAt: workspaces.archivedAt }).from(workspaces).where(inArray(workspaces.id, owners)))
        .filter((w) => !w.archivedAt)
        .map((w) => w.id),
    );
    const out: Partial<Record<ShareKind, number>> = {};
    for (const r of rows) if (isShareKind(r.kind) && live.has(r.owner)) out[r.kind] = r.owner;
    return out;
  } catch (e) {
    console.error("[keyShares] lender lookup failed:", (e as Error).message);
    return {};
  }
}

export type LinkedKey = { ownerWorkspaceId: number; key: string };

/**
 * The keys other workspaces lend this one, decrypted, for the kinds asked.
 * Only the lender's OWN column is read, so a borrowed key is never passed on.
 * Ask only for the kinds the workspace has no key of its own for.
 */
export async function linkedKeys(workspaceId: number, kinds: readonly SettingsShareKind[]): Promise<Partial<Record<SettingsShareKind, LinkedKey>>> {
  const lenders = await lendersFor(workspaceId, kinds);
  const owners = Array.from(new Set(Object.values(lenders))) as number[];
  if (owners.length === 0) return {};
  try {
    const db = await getDb();
    if (!db) return {};
    const rows = await db
      .select({
        workspaceId: workspaceSettings.workspaceId,
        anthropicApiKeyEnc: workspaceSettings.anthropicApiKeyEnc,
        openaiApiKeyEnc: workspaceSettings.openaiApiKeyEnc,
        geminiApiKeyEnc: workspaceSettings.geminiApiKeyEnc,
        xaiApiKeyEnc: workspaceSettings.xaiApiKeyEnc,
        apolloApiKeyEnc: workspaceSettings.apolloApiKeyEnc,
        reoonApiKeyEnc: workspaceSettings.reoonApiKeyEnc,
        quickenrichApiKeyEnc: workspaceSettings.quickenrichApiKeyEnc,
      })
      .from(workspaceSettings)
      .where(inArray(workspaceSettings.workspaceId, owners));
    const byOwner = new Map(rows.map((r) => [r.workspaceId, r]));
    const out: Partial<Record<SettingsShareKind, LinkedKey>> = {};
    for (const kind of kinds) {
      const owner = lenders[kind];
      if (!owner) continue;
      const key = tryDecryptSecret(byOwner.get(owner)?.[SETTINGS_COLUMN[kind]]);
      if (key) out[kind] = { ownerWorkspaceId: owner, key };
    }
    return out;
  } catch (e) {
    console.error("[keyShares] linked key read failed:", (e as Error).message);
    return {};
  }
}

/** One lent key, or "" when nobody lends this workspace a usable one. */
export async function linkedKey(workspaceId: number, kind: SettingsShareKind): Promise<string> {
  return (await linkedKeys(workspaceId, [kind]))[kind]?.key ?? "";
}

/**
 * The lender's credential row for a table-mode prospect source, or null.
 * The borrower gets the lender's secrets and the lender's non-secret config
 * (the account's own settings); a revoked row lends nothing.
 */
export async function linkedSourceRow(
  workspaceId: number,
  slug: SourceShareKind,
): Promise<{ ownerWorkspaceId: number; row: typeof prospectSourceCredentials.$inferSelect } | null> {
  const owner = (await lendersFor(workspaceId, [slug]))[slug];
  if (!owner) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const [row] = await db
      .select()
      .from(prospectSourceCredentials)
      .where(and(eq(prospectSourceCredentials.workspaceId, owner), eq(prospectSourceCredentials.sourceSlug, slug)))
      .limit(1);
    if (!row || row.status === "revoked" || !row.credentialsEnc) return null;
    return { ownerWorkspaceId: owner, row };
  } catch (e) {
    console.error("[keyShares] linked source read failed:", (e as Error).message);
    return null;
  }
}

/** The workspaces borrowing a lender's key for one source (the polling crons walk these too). */
export async function workspacesBorrowingSource(slug: SourceShareKind): Promise<number[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select({ target: workspaceKeyShares.targetWorkspaceId })
      .from(workspaceKeyShares)
      .where(eq(workspaceKeyShares.keyKind, slug));
    return Array.from(new Set(rows.map((r) => r.target)));
  } catch {
    return [];
  }
}

export type BorrowedKey = { kind: ShareKind; ownerWorkspaceId: number; ownerName: string; usable: boolean };

/**
 * What this workspace borrows, for Settings: who lends each key and whether
 * the lender still has one to lend. Names only — never a key, never its tail:
 * a borrower's members have no business reading the lender's key suffix.
 */
export async function borrowedKeys(workspaceId: number): Promise<BorrowedKey[]> {
  const lenders = await lendersFor(workspaceId, SHARE_KINDS);
  const kinds = Object.keys(lenders) as ShareKind[];
  if (kinds.length === 0) return [];
  const settingsKinds = kinds.filter((k): k is SettingsShareKind => !isSourceShareKind(k));
  const keys = await linkedKeys(workspaceId, settingsKinds);
  const names = new Map<number, string>();
  try {
    const db = await getDb();
    if (db) {
      const owners = Array.from(new Set(Object.values(lenders))) as number[];
      for (const w of await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(inArray(workspaces.id, owners))) names.set(w.id, w.name);
    }
  } catch { /* names are decoration; the link still stands */ }
  const out: BorrowedKey[] = [];
  for (const kind of SHARE_KINDS) {
    const owner = lenders[kind];
    if (!owner) continue;
    const usable = isSourceShareKind(kind) ? !!(await linkedSourceRow(workspaceId, kind)) : !!keys[kind as SettingsShareKind];
    out.push({ kind, ownerWorkspaceId: owner, ownerName: names.get(owner) ?? "another workspace", usable });
  }
  return out;
}

/** The lender's name for one key this workspace borrows and can use, or null. For the per-key status cards. */
export async function sharedFromName(workspaceId: number, kind: ShareKind): Promise<string | null> {
  const b = (await borrowedKeys(workspaceId)).find((x) => x.kind === kind);
  return b && b.usable ? b.ownerName : null;
}

/**
 * The lender's name when `key` (what a getter resolved for this workspace) is
 * a lent one, else null. For views that only hold the resolved key and must
 * not show a borrowed key's tail.
 */
export async function lenderOfKey(workspaceId: number, kind: SettingsShareKind, key: string): Promise<string | null> {
  if (!key) return null;
  const lent = (await linkedKeys(workspaceId, [kind]))[kind];
  if (!lent || lent.key !== key) return null;
  return (await sharedFromName(workspaceId, kind)) ?? "another workspace";
}

/**
 * The kinds this workspace has a key OF ITS OWN for — the only ones it can
 * lend. Reads its own columns and its own source rows, never a borrowed key.
 */
export async function ownKeyKinds(workspaceId: number): Promise<Set<ShareKind>> {
  const out = new Set<ShareKind>();
  const db = await getDb();
  if (!db) return out;
  const [row] = await db
    .select({
      anthropicApiKeyEnc: workspaceSettings.anthropicApiKeyEnc,
      openaiApiKeyEnc: workspaceSettings.openaiApiKeyEnc,
      geminiApiKeyEnc: workspaceSettings.geminiApiKeyEnc,
      xaiApiKeyEnc: workspaceSettings.xaiApiKeyEnc,
      apolloApiKeyEnc: workspaceSettings.apolloApiKeyEnc,
      reoonApiKeyEnc: workspaceSettings.reoonApiKeyEnc,
      quickenrichApiKeyEnc: workspaceSettings.quickenrichApiKeyEnc,
    })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  for (const kind of SETTINGS_SHARE_KINDS) if (tryDecryptSecret(row?.[SETTINGS_COLUMN[kind]])) out.add(kind);
  const sources = await db
    .select({ slug: prospectSourceCredentials.sourceSlug, status: prospectSourceCredentials.status, enc: prospectSourceCredentials.credentialsEnc })
    .from(prospectSourceCredentials)
    .where(eq(prospectSourceCredentials.workspaceId, workspaceId));
  for (const r of sources) if (isSourceShareKind(r.slug) && r.status !== "revoked" && tryDecryptSecret(r.enc)) out.add(r.slug);
  return out;
}
