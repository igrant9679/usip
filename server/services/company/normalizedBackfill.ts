/**
 * Normalized-column backfill (roadmap P1.5) — existing accounts created by
 * the pre-P1.4 raw paths (CSV import, Places save, manual create, lead
 * bridge, crmMatching) have NULL `normalized_name`/`normalized_domain`,
 * which makes them permanently invisible to `findWorkspaceAccountMatch`
 * and `findDuplicateAccounts`. This computes the two identity-index
 * columns for rows that lack them. Idempotent, bounded, values-only —
 * no display field is ever touched.
 */
import { and, eq, isNull, isNotNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { accounts } from "../../../drizzle/schema";
import { normalizedAccountFields } from "./normalize";

export async function backfillNormalizedAccountFields(limit = 500): Promise<{ scanned: number; updated: number }> {
  const db = await getDb();
  if (!db) return { scanned: 0, updated: 0 };

  const rows = await db
    .select({ id: accounts.id, name: accounts.name, domain: accounts.domain })
    .from(accounts)
    .where(or(
      and(isNull(accounts.normalizedName), ne(accounts.name, "")),
      and(isNull(accounts.normalizedDomain), isNotNull(accounts.domain), sql`${accounts.domain} <> ''`),
    ))
    .limit(limit);

  let updated = 0;
  for (const r of rows) {
    const fields = normalizedAccountFields(r.name, r.domain);
    if (!fields.normalizedName && !fields.normalizedDomain) continue;
    await db.update(accounts).set(fields as never).where(eq(accounts.id, r.id));
    updated++;
  }
  return { scanned: rows.length, updated };
}
