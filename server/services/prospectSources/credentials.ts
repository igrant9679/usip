/**
 * Credential store for prospect-data vendors.
 *
 * Two modes, one contract (`loadCredentials`):
 *   - "table"  — the generic `prospect_source_credentials` row (migration
 *                0179): encrypted JSON of secrets + a non-secret config blob
 *                + validation status + circuit-breaker state. New vendors
 *                live here; adding one needs no DDL.
 *   - "legacy" — Apollo / QuickEnrich keep their `workspace_settings` columns
 *                and BYOK cards (routers/apollo.ts, routers/quickenrich.ts);
 *                this module reads them through the same key resolvers those
 *                routers use, so there is still exactly one place each key
 *                resolves from.
 *
 * Secrets never leave this module in the clear except inside a
 * SourceCredentials object handed to an adapter. Status reads return masked
 * values only.
 */
import { and, eq } from "drizzle-orm";
import { prospectSourceCredentials } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { encryptSecret, maskSecret, tryDecryptSecret } from "../../_core/crypto";
import type { CredentialStatus, ProspectSourceSlug } from "@shared/prospectSources";
import type { CredentialValidationResult, ProspectSource, SourceCredentials } from "./types";
import { getApolloKey } from "../apollo";
import { getQuickEnrichKey } from "../quickenrich";
import { isSourceShareKind, lenderOfKey, linkedSourceRow, sharedFromName, workspacesBorrowingSource, SOURCE_SHARE_KINDS } from "../keyShares";

export interface CredentialRowView {
  slug: ProspectSourceSlug;
  configured: boolean;
  masked: string;
  status: CredentialStatus;
  lastValidatedAt: Date | null;
  validationError: string | null;
  config: Record<string, unknown>;
  consecutiveFailures: number;
  circuitOpenUntil: Date | null;
  /**
   * "workspace" = this workspace's own key; "env" = deploy-wide fallback
   * (legacy vendors only); "linked" = a key another workspace lends this one
   * (services/keyShares), named in `sharedFrom` and never shown, masked or not.
   */
  source: "workspace" | "env" | "linked" | "none";
  sharedFrom?: string | null;
}

function parseSecrets(enc: string | null | undefined): Record<string, string> {
  const raw = tryDecryptSecret(enc);
  if (!raw) return {};
  try {
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? (j as Record<string, string>) : {};
  } catch {
    // Pre-JSON single-key format, tolerated.
    return { apiKey: raw };
  }
}

/** Decrypted credentials for an adapter, or null when the workspace has none usable. */
export async function loadCredentials(workspaceId: number, source: ProspectSource): Promise<SourceCredentials | null> {
  if (source.credentialMode === "legacy") {
    const apiKey = source.slug === "apollo" ? await getApolloKey(workspaceId)
      : source.slug === "quickenrich" ? await getQuickEnrichKey(workspaceId)
      : "";
    if (!apiKey) return null;
    return { slug: source.slug, workspaceId, secrets: { apiKey }, config: {} };
  }
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(prospectSourceCredentials)
    .where(and(eq(prospectSourceCredentials.workspaceId, workspaceId), eq(prospectSourceCredentials.sourceSlug, source.slug)))
    .limit(1);
  const own = row && row.status !== "revoked" ? parseSecrets(row.credentialsEnc) : {};
  if (own.apiKey) {
    return {
      slug: source.slug,
      workspaceId,
      secrets: own,
      config: (row!.config && typeof row!.config === "object" ? row!.config : {}) as Record<string, unknown>,
    };
  }
  // No key of its own: one another workspace lends it (services/keyShares).
  // The lender's secrets and the lender's account settings, billed and
  // counted as this workspace's searches.
  if (!isSourceShareKind(source.slug)) return null;
  const lent = await linkedSourceRow(workspaceId, source.slug);
  const secrets = parseSecrets(lent?.row.credentialsEnc);
  if (!lent || !secrets.apiKey) return null;
  return {
    slug: source.slug,
    workspaceId,
    secrets,
    config: (lent.row.config && typeof lent.row.config === "object" ? lent.row.config : {}) as Record<string, unknown>,
  };
}

/** Masked status for one source (UI). Never returns plaintext. */
export async function credentialView(workspaceId: number, source: ProspectSource): Promise<CredentialRowView> {
  const base: CredentialRowView = {
    slug: source.slug, configured: false, masked: "", status: "unvalidated", lastValidatedAt: null,
    validationError: null, config: {}, consecutiveFailures: 0, circuitOpenUntil: null, source: "none",
  };
  if (source.credentialMode === "legacy") {
    const key = source.slug === "apollo" ? await getApolloKey(workspaceId)
      : source.slug === "quickenrich" ? await getQuickEnrichKey(workspaceId) : "";
    const envKey = source.slug === "quickenrich" ? (process.env.QUICKENRICH_API_KEY ?? "") : "";
    // A lent key is in use and named, never shown — not even its tail.
    const lentFrom = key && (source.slug === "apollo" || source.slug === "quickenrich") ? await lenderOfKey(workspaceId, source.slug, key) : null;
    return {
      ...base,
      configured: key.length > 0,
      masked: lentFrom ? "" : maskSecret(key),
      status: key ? "valid" : "unvalidated",
      source: key ? (lentFrom ? "linked" : envKey && key === envKey ? "env" : "workspace") : "none",
      sharedFrom: lentFrom,
    };
  }
  const db = await getDb();
  if (!db) return base;
  const [row] = await db
    .select()
    .from(prospectSourceCredentials)
    .where(and(eq(prospectSourceCredentials.workspaceId, workspaceId), eq(prospectSourceCredentials.sourceSlug, source.slug)))
    .limit(1);
  const secrets = row && row.status !== "revoked" ? parseSecrets(row.credentialsEnc) : {};
  if (!secrets.apiKey && isSourceShareKind(source.slug)) {
    // Borrowed: in use, named, and never shown — not even its tail.
    const lent = await linkedSourceRow(workspaceId, source.slug);
    if (lent && parseSecrets(lent.row.credentialsEnc).apiKey) {
      return {
        ...base,
        configured: true,
        status: lent.row.status,
        lastValidatedAt: lent.row.lastValidatedAt ?? null,
        config: (lent.row.config && typeof lent.row.config === "object" ? lent.row.config : {}) as Record<string, unknown>,
        source: "linked",
        sharedFrom: await sharedFromName(workspaceId, source.slug),
      };
    }
  }
  if (!row) return base;
  return {
    ...base,
    configured: !!secrets.apiKey,
    masked: source.writeOnlyKey ? "" : maskSecret(secrets.apiKey ?? ""),
    status: row.status,
    lastValidatedAt: row.lastValidatedAt ?? null,
    validationError: row.validationError ?? null,
    config: (row.config && typeof row.config === "object" ? row.config : {}) as Record<string, unknown>,
    consecutiveFailures: row.consecutiveFailures ?? 0,
    circuitOpenUntil: row.circuitOpenUntil ?? null,
    source: secrets.apiKey ? "workspace" : "none",
  };
}

/**
 * Upsert secrets and/or config. A changed secret resets status to
 * `unvalidated` (a key we have not tested is a key we do not trust yet);
 * `secrets: {}` with apiKey "" clears the credential (status → revoked).
 */
export async function saveCredentials(
  workspaceId: number,
  slug: ProspectSourceSlug,
  patch: { secrets?: Record<string, string>; config?: Record<string, unknown> },
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const [existing] = await db
    .select({ id: prospectSourceCredentials.id, config: prospectSourceCredentials.config, enc: prospectSourceCredentials.credentialsEnc })
    .from(prospectSourceCredentials)
    .where(and(eq(prospectSourceCredentials.workspaceId, workspaceId), eq(prospectSourceCredentials.sourceSlug, slug)))
    .limit(1);
  const mergedConfig = {
    ...((existing?.config && typeof existing.config === "object" ? existing.config : {}) as Record<string, unknown>),
    ...(patch.config ?? {}),
  };
  const updates: Record<string, unknown> = { config: mergedConfig };
  if (patch.secrets) {
    const clearing = !patch.secrets.apiKey;
    updates.credentialsEnc = clearing ? null : encryptSecret(JSON.stringify(patch.secrets));
    updates.status = clearing ? "revoked" : "unvalidated";
    updates.validationError = null;
    updates.consecutiveFailures = 0;
    updates.circuitOpenUntil = null;
  }
  if (existing) {
    await db.update(prospectSourceCredentials).set(updates as never)
      .where(and(eq(prospectSourceCredentials.id, existing.id), eq(prospectSourceCredentials.workspaceId, workspaceId)));
  } else {
    await db.insert(prospectSourceCredentials).values({ workspaceId, sourceSlug: slug, ...updates } as never);
  }
}

/** Persist a validation outcome and merge what the vendor told us into config. */
export async function recordValidation(
  workspaceId: number,
  slug: ProspectSourceSlug,
  result: CredentialValidationResult,
): Promise<void> {
  // The vendor could not be asked: that is not a verdict on the key.
  if (result.transient) return;
  const db = await getDb();
  if (!db) return;
  const [existing] = await db
    .select({ id: prospectSourceCredentials.id, config: prospectSourceCredentials.config })
    .from(prospectSourceCredentials)
    .where(and(eq(prospectSourceCredentials.workspaceId, workspaceId), eq(prospectSourceCredentials.sourceSlug, slug)))
    .limit(1);
  if (!existing) return;
  const mergedConfig = {
    ...((existing.config && typeof existing.config === "object" ? existing.config : {}) as Record<string, unknown>),
    ...(result.discovered ?? {}),
  };
  await db.update(prospectSourceCredentials).set({
    status: result.ok ? "valid" : "invalid",
    lastValidatedAt: new Date(),
    validationError: result.ok ? null : result.message.slice(0, 2000),
    config: mergedConfig,
    ...(result.ok ? { consecutiveFailures: 0, circuitOpenUntil: null } : {}),
  } as never).where(and(eq(prospectSourceCredentials.id, existing.id), eq(prospectSourceCredentials.workspaceId, workspaceId)));
}

/** Every table-mode credential row a workspace has (for nightly revalidation). */
export async function listCredentialSlugs(workspaceId: number): Promise<ProspectSourceSlug[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ slug: prospectSourceCredentials.sourceSlug, status: prospectSourceCredentials.status })
    .from(prospectSourceCredentials)
    .where(eq(prospectSourceCredentials.workspaceId, workspaceId));
  return rows.filter((r) => r.status !== "revoked").map((r) => r.slug as ProspectSourceSlug);
}

/** All workspaces holding a live table-mode credential (cron fan-out). */
export async function workspacesWithCredentials(): Promise<Array<{ workspaceId: number; slug: ProspectSourceSlug }>> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ workspaceId: prospectSourceCredentials.workspaceId, slug: prospectSourceCredentials.sourceSlug, status: prospectSourceCredentials.status, enc: prospectSourceCredentials.credentialsEnc })
    .from(prospectSourceCredentials);
  const out = rows.filter((r) => r.status !== "revoked" && !!r.enc).map((r) => ({ workspaceId: r.workspaceId, slug: r.slug as ProspectSourceSlug }));
  // A workspace borrowing a key has no row of its own, and its runs need
  // polling all the same (services/keyShares).
  const seen = new Set(out.map((o) => `${o.workspaceId}:${o.slug}`));
  for (const slug of SOURCE_SHARE_KINDS) {
    for (const workspaceId of await workspacesBorrowingSource(slug)) {
      if (!seen.has(`${workspaceId}:${slug}`)) { seen.add(`${workspaceId}:${slug}`); out.push({ workspaceId, slug: slug as ProspectSourceSlug }); }
    }
  }
  return out;
}
