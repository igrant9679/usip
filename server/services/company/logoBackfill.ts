/**
 * Logo backfill — run the automated logo workflow over accounts that have a
 * domain but no stored logo yet. Free (fetches only the companies' own
 * public assets), bounded per run, and terminal-state honest: an account
 * whose domain yields nothing usable is marked `unavailable` so the sweep
 * doesn't re-fetch the same dead site every 6 hours; a later domain change
 * resets it to `unknown` naturally via account edits.
 */
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { getDb } from "../../db";
import { accounts } from "../../../drizzle/schema";
import { normalizeDomain } from "./normalize";
import { fetchAndProcessLogo } from "./logoPipeline";
import { updateCompanyLogo, setCompanyLogoStatus } from "./logoService";

export interface LogoBackfillResult { scanned: number; set: number; unavailable: number; skipped: number }

export async function backfillCompanyLogos(limit = 50): Promise<LogoBackfillResult> {
  const out: LogoBackfillResult = { scanned: 0, set: 0, unavailable: 0, skipped: 0 };
  const db = await getDb();
  if (!db) return out;

  const rows = await db
    .select({ id: accounts.id, workspaceId: accounts.workspaceId, domain: accounts.domain })
    .from(accounts)
    .where(and(
      isNotNull(accounts.domain),
      ne(accounts.domain, ""),
      isNull(accounts.logoUrl),
      or(eq(accounts.logoStatus, "unknown"), isNull(accounts.logoStatus)),
    ))
    .limit(limit);

  for (const r of rows) {
    out.scanned++;
    const domain = normalizeDomain(r.domain);
    if (!domain) { out.skipped++; continue; }
    try {
      const logo = await fetchAndProcessLogo(domain);
      if (logo.ok && logo.dataUri) {
        await updateCompanyLogo(r.workspaceId, r.id, {
          logoUrl: logo.dataUri,
          sourceType: logo.kind === "favicon_service" ? "website_favicon" : "website_logo",
          sourceUrl: logo.sourceUrl ?? null,
        });
        out.set++;
      } else {
        await setCompanyLogoStatus(r.workspaceId, r.id, "unavailable");
        out.unavailable++;
      }
    } catch {
      out.skipped++; // transient — retry next run
    }
  }
  return out;
}
