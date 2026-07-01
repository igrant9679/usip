/**
 * CompanyEnrichmentService — firmographic enrichment for a workspace account
 * and its global organization.
 *
 * Velocity has no licensed firmographic vendor wired yet, so enrichment here is
 * the pipeline + provider-agnostic apply path: it derives what it safely can
 * (canonical domain/website from existing fields, a permitted favicon logo),
 * records an organization_enrichment_events row, and stamps last_enriched_at.
 * mapProviderOrganizationToVelocitySchema + updateCompanyFields are the seam a
 * real provider (or CRM import) plugs into later. Never blocks company creation.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import {
  accounts, globalOrganizations, organizationEnrichmentEvents, organizationTechnologies,
} from "../../../drizzle/schema";
import { normalizeDomain, normalizeWebsite } from "./normalize";
import { faviconUrlForDomain } from "./logoService";

export interface CompanyFields {
  name?: string; domain?: string; websiteUrl?: string; linkedinCompanyUrl?: string;
  industry?: string; subIndustry?: string; employeeCount?: number; revenue?: number;
  description?: string; hqCity?: string; hqState?: string; hqCountry?: string;
  companyPhone?: string; foundedYear?: number; logoUrl?: string; technologies?: string[];
}

/** Map an external provider payload onto Velocity's account fields (stub-ready). */
export function mapProviderOrganizationToVelocitySchema(provider: Record<string, unknown>): CompanyFields {
  const s = (k: string) => (typeof provider[k] === "string" ? (provider[k] as string) : undefined);
  const n = (k: string) => (typeof provider[k] === "number" ? (provider[k] as number) : undefined);
  return {
    name: s("name") ?? s("company_name"),
    domain: s("domain"), websiteUrl: s("website") ?? s("website_url"),
    linkedinCompanyUrl: s("linkedin_company_url") ?? s("linkedin_url"),
    industry: s("industry"), subIndustry: s("sub_industry"),
    employeeCount: n("employee_count"), revenue: n("revenue"),
    description: s("description"), hqCity: s("hq_city") ?? s("city"),
    hqState: s("hq_state") ?? s("state"), hqCountry: s("hq_country") ?? s("country"),
    companyPhone: s("company_phone") ?? s("phone"), foundedYear: n("founded_year"),
    logoUrl: s("logo_url"), technologies: Array.isArray(provider.technologies) ? (provider.technologies as string[]) : undefined,
  };
}

/** Apply a partial firmographic patch to an account (+ its global org). */
export async function updateCompanyFields(ws: number, accountId: number, fields: CompanyFields): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const patch: Record<string, unknown> = {};
  const updated: string[] = [];
  const set = (col: string, val: unknown) => { if (val != null && val !== "") { patch[col] = val; updated.push(col); } };
  set("industry", fields.industry); set("subIndustry", fields.subIndustry);
  set("employeeCount", fields.employeeCount); set("revenue", fields.revenue == null ? null : String(fields.revenue));
  set("description", fields.description); set("companyPhone", fields.companyPhone);
  set("foundedYear", fields.foundedYear); set("hqCity", fields.hqCity);
  set("hqState", fields.hqState); set("hqCountry", fields.hqCountry);
  set("websiteUrl", fields.websiteUrl ? normalizeWebsite(fields.websiteUrl) : undefined);
  set("linkedinCompanyUrl", fields.linkedinCompanyUrl);
  if (fields.logoUrl && /^https:\/\//i.test(fields.logoUrl)) {
    patch.logoUrl = fields.logoUrl; patch.logoSourceType = "enrichment_provider";
    patch.logoStatus = "available"; patch.logoLastVerifiedAt = new Date(); updated.push("logoUrl");
  }
  if (Object.keys(patch).length) {
    patch.lastEnrichedAt = new Date(); patch.dataStatus = "enriched";
    await db.update(accounts).set(patch as never).where(and(eq(accounts.workspaceId, ws), eq(accounts.id, accountId)));
  }
  // Technologies → global org (powers the company Fit score `technologies` field).
  const [acct] = await db.select({ orgId: accounts.globalOrganizationId }).from(accounts)
    .where(and(eq(accounts.workspaceId, ws), eq(accounts.id, accountId))).limit(1);
  if (acct?.orgId && fields.technologies?.length) {
    for (const tech of fields.technologies.slice(0, 50)) {
      await db.insert(organizationTechnologies).values({
        globalOrganizationId: acct.orgId, technologyName: tech.slice(0, 120), sourceType: "enrichment_provider",
      } as never);
    }
    updated.push("technologies");
  }
  return updated;
}

/**
 * Enrich one account. Derives safe fields + logo favicon, records the event.
 * Real vendor retrieval plugs in via mapProviderOrganizationToVelocitySchema.
 */
export async function enrichCompany(ws: number, accountId: number, opts?: {
  userId?: number | null; provided?: Record<string, unknown> | null;
}): Promise<{ ok: boolean; fieldsUpdated: string[]; status: string }> {
  const db = await getDb();
  if (!db) return { ok: false, fieldsUpdated: [], status: "failed" };
  const [acct] = await db.select().from(accounts).where(and(eq(accounts.workspaceId, ws), eq(accounts.id, accountId))).limit(1);
  if (!acct) return { ok: false, fieldsUpdated: [], status: "failed" };

  let fieldsUpdated: string[] = [];
  let status = "partial";

  // If a provider/CRM payload was supplied, apply it.
  if (opts?.provided) {
    fieldsUpdated = await updateCompanyFields(ws, accountId, mapProviderOrganizationToVelocitySchema(opts.provided));
    status = "enriched";
  } else {
    // No vendor — derive canonical website + a permitted favicon logo.
    const patch: Record<string, unknown> = { lastEnrichedAt: new Date() };
    const domain = acct.normalizedDomain || normalizeDomain(acct.domain) || normalizeDomain(acct.websiteUrl);
    if (domain && !acct.websiteUrl) { patch.websiteUrl = `https://${domain}`; fieldsUpdated.push("websiteUrl"); }
    if (domain && (!acct.logoUrl || acct.logoStatus !== "available")) {
      const fav = faviconUrlForDomain(domain);
      if (fav) { patch.logoUrl = fav; patch.logoSourceType = "website_favicon"; patch.logoStatus = "available"; patch.logoLastVerifiedAt = new Date(); fieldsUpdated.push("logoUrl"); }
    }
    await db.update(accounts).set(patch as never).where(and(eq(accounts.workspaceId, ws), eq(accounts.id, accountId)));
  }

  // Mirror key firmographics onto the shared global org.
  if (acct.globalOrganizationId) {
    await db.update(globalOrganizations).set({ lastEnrichedAt: new Date() } as never)
      .where(eq(globalOrganizations.id, acct.globalOrganizationId));
  }

  await db.insert(organizationEnrichmentEvents).values({
    workspaceId: ws, accountId, globalOrganizationId: acct.globalOrganizationId ?? null,
    sourceVendor: opts?.provided ? "provider" : "internal_derive", sourceType: opts?.provided ? "enrichment_provider" : "website_favicon",
    status, fieldsUpdated: fieldsUpdated.length ? fieldsUpdated : null, enrichedByUserId: opts?.userId ?? null,
  } as never);

  return { ok: true, fieldsUpdated, status };
}

export async function bulkEnrichCompanies(ws: number, accountIds: number[], userId?: number | null): Promise<{ processed: number; ok: number }> {
  let ok = 0;
  for (const id of accountIds) {
    try { const r = await enrichCompany(ws, id, { userId }); if (r.ok) ok++; } catch { /* skip */ }
  }
  return { processed: accountIds.length, ok };
}
