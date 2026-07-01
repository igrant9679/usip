/**
 * CompanyLogoService — resolve/update a company logo from PERMITTED sources
 * only (user upload, CRM import, authorized enrichment provider, permitted
 * public URL, or the company's own website favicon/logo). No scraping of
 * access-controlled surfaces. When nothing permitted is available, the frontend
 * CompanyAvatar renders a domain/initials lettermark — so the backend stores a
 * real logo URL only when a permitted source provided one.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { accounts, companyLogoAssets } from "../../../drizzle/schema";
import { normalizeDomain } from "./normalize";

const PERMITTED = new Set([
  "user_uploaded", "crm_import", "enrichment_provider", "permitted_public_url",
  "website_favicon", "website_logo", "manual_entry",
]);

export interface ResolvedLogo { url: string | null; sourceType: string | null; status: string; }

/** The logo to display for an account (permitted stored URL, else null). */
export function resolveCompanyLogo(account: {
  logoUrl?: string | null; logoSourceType?: string | null; logoStatus?: string | null;
}): ResolvedLogo {
  if (account.logoUrl && account.logoStatus === "available" && account.logoSourceType && PERMITTED.has(account.logoSourceType)) {
    return { url: account.logoUrl, sourceType: account.logoSourceType, status: "available" };
  }
  return { url: null, sourceType: null, status: account.logoStatus ?? "unknown" };
}

/** Deterministic favicon URL for a domain (company's own site — permitted). */
export function faviconUrlForDomain(domain?: string | null): string | null {
  const d = normalizeDomain(domain);
  if (!d) return null;
  // Google S2 favicon service — domain-only, no user PII; widely used as a
  // permitted public favicon source with graceful client-side fallback.
  return `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(d)}`;
}

export async function updateCompanyLogo(ws: number, accountId: number, logo: {
  logoUrl: string; sourceType: string; sourceUrl?: string | null;
}): Promise<{ ok: boolean; reason?: string }> {
  if (!PERMITTED.has(logo.sourceType)) return { ok: false, reason: "logo source not permitted" };
  if (!/^https:\/\//i.test(logo.logoUrl)) return { ok: false, reason: "logo url must be https" };
  const db = await getDb();
  if (!db) return { ok: false, reason: "db unavailable" };
  await db.update(accounts).set({
    logoUrl: logo.logoUrl, logoSourceType: logo.sourceType, logoSourceUrl: logo.sourceUrl ?? null,
    logoStatus: "available", logoLastVerifiedAt: new Date(),
  } as never).where(and(eq(accounts.workspaceId, ws), eq(accounts.id, accountId)));
  await db.insert(companyLogoAssets).values({
    workspaceId: ws, accountId, logoUrl: logo.logoUrl, sourceType: logo.sourceType,
    sourceUrl: logo.sourceUrl ?? null, status: "available", lastVerifiedAt: new Date(),
  } as never);
  return { ok: true };
}

/** Mark a logo status (e.g. failed_to_load / blocked_by_policy / removed). */
export async function setCompanyLogoStatus(ws: number, accountId: number, status: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(accounts).set({ logoStatus: status } as never)
    .where(and(eq(accounts.workspaceId, ws), eq(accounts.id, accountId)));
}

export async function clearCompanyLogo(ws: number, accountId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(accounts).set({ logoUrl: null, logoSourceType: null, logoSourceUrl: null, logoStatus: "removed" } as never)
    .where(and(eq(accounts.workspaceId, ws), eq(accounts.id, accountId)));
}
