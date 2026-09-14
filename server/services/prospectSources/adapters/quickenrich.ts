/**
 * QuickEnrich as a registry adapter — a thin shell over the existing client
 * (services/quickenrich.ts), which stays the one place their API shape and
 * key resolution live.
 *
 * What the vendor actually exposes (probed live 2026-08-21/24, recorded in
 * the client): search-by-criteria via POST /api/employees/contact-finder
 * (free; title / industry_linkedin controlled vocabulary / country_code;
 * returns has_email flags and LinkedIn URLs, never addresses) and
 * enrichment-by-LinkedIn-URL (1 credit, charged on delivery). No balance
 * endpoint; marketed as uncapped by credits, so the ledger models the
 * monthly bucket with `unitsLimit: null` and the existing daily pull cap
 * (workspace_settings.quickenrichDailyPullCap, metered through
 * are_scrape_jobs — one budget across every surface) stays the brake.
 *
 * Acquisition mode is "none" inside the waterfall: emails are found later by
 * the enrichment sweep, Reoon-verified before anything is written (owner's
 * non-negotiable). The adapter still implements acquire() for the staged
 * search page's explicit "acquire selected" action.
 */
import type { SearchCriteria, SourceCapabilities } from "@shared/prospectSources";
import type { ProspectRecord, ProspectSource } from "../types";
import {
  buildQuickenrichFilters,
  getQuickenrichDailyPullCap,
  getQuickenrichIndustries,
  quickenrichContactFinder,
  quickenrichFindEmailByLinkedIn,
  quickenrichPulledToday,
  quickenrichTestKey,
} from "../../quickenrich";
import { areScrapeJobs } from "../../../../drizzle/schema";
import { getDb } from "../../../db";

const CAPS: SourceCapabilities = {
  supportedFilters: ["jobTitle", "industry", "country"],
  approximatedFilters: ["keyword", "seniority"],
  supportsFreePreview: true,
  returnsMaskedPreview: true, // has_email flag only, never the address
  supportsMobilePhone: true,   // marketed; delivered through enrichment
  supportsVerification: false,
  maxBatchSize: 50,
  geographicCoverage: [],
};

export function createQuickEnrichSource(): ProspectSource & { acquisition: "none"; recordUsage: (ws: number, n: number, q: string) => Promise<void> } {
  return {
    slug: "quickenrich",
    displayName: "QuickEnrich",
    docsUrl: "https://quickenrich.io",
    credentialMode: "legacy",
    acquisition: "none",
    capabilities: () => CAPS,
    budgetPeriods: () => [],

    async validateCredentials(c) {
      const r = await quickenrichTestKey(c.secrets.apiKey ?? "");
      return { ok: r.ok, message: r.message, terminal: !r.ok && (r.status === 401 || r.status === 403) };
    },

    async search(criteria: SearchCriteria, c, limit, ctx) {
      const apiKey = c.secrets.apiKey ?? "";
      const cap = await getQuickenrichDailyPullCap(c.workspaceId);
      const used = await quickenrichPulledToday(c.workspaceId);
      const headroom = Math.max(0, cap - used);
      if (headroom <= 0) return { ok: false, reason: "budget_exhausted", message: `daily pull cap reached (${used}/${cap})` };
      const titles = criteria.jobTitles.concat(criteria.seniorities.map((s) => `${s}`)).filter(Boolean);
      const allowed = criteria.industries.length > 0 ? await getQuickenrichIndustries(apiKey) : null;
      const { body } = buildQuickenrichFilters({ titles, industries: criteria.industries, geos: criteria.countries }, allowed);
      if (!body) return { ok: false, reason: "invalid_params", message: "no title or mappable industry filter — refusing to search their whole database" };
      const page = ctx.cursor ? Math.max(1, Number(ctx.cursor) || 1) : 1;
      body.page = page;
      const res = await quickenrichContactFinder(apiKey, body);
      if (!res.ok) {
        const msg = res.error;
        return { ok: false, reason: /HTTP 429/.test(msg) ? "rate_limited" : /HTTP 40[13]/.test(msg) ? "unauthorized" : /HTTP 422/.test(msg) ? "invalid_params" : "unavailable", message: msg };
      }
      const ranked = res.people.slice().sort((a, b) => Number(b.hasEmail) - Number(a.hasEmail));
      const kept = ranked.slice(0, Math.min(limit, headroom));
      const records: ProspectRecord[] = kept.map((p) => ({
        externalId: p.linkedinUrl ?? `${p.firstName} ${p.lastName}@${p.companyDomain ?? p.companyName ?? ""}`,
        firstName: p.firstName, lastName: p.lastName, jobTitle: p.title, seniority: null,
        companyName: p.companyName, companyDomain: p.companyDomain,
        email: null, emailIsMasked: p.hasEmail, emailVerifiedAt: null,
        mobilePhone: null, businessPhone: null, linkedinUrl: p.linkedinUrl,
        city: null, stateProvince: null, country: null, industry: null, headcount: null,
        rawSourcePayload: { hasEmail: p.hasEmail },
      }));
      return { ok: true, records, nextCursor: res.people.length > 0 ? String(page + 1) : null, totalAvailable: null, alreadyCharged: false, unitsSpent: 0 };
    },

    async acquire(externalIds, c) {
      const apiKey = c.secrets.apiKey ?? "";
      const records: ProspectRecord[] = [];
      const failed: string[] = [];
      let units = 0;
      for (let i = 0; i < externalIds.length; i++) {
        const url = externalIds[i];
        if (!/linkedin\.com/i.test(url)) { failed.push(url); continue; }
        const r = await quickenrichFindEmailByLinkedIn(apiKey, url);
        if (r.email) {
          units += 1;
          records.push({
            externalId: url, firstName: "", lastName: "", jobTitle: null, seniority: null,
            companyName: r.companyName, companyDomain: r.companyDomain,
            email: r.email, emailIsMasked: false, emailVerifiedAt: null,
            mobilePhone: null, businessPhone: null, linkedinUrl: url,
            city: null, stateProvince: null, country: null, industry: null, headcount: null,
            rawSourcePayload: { reason: r.reason },
          });
        } else failed.push(url);
      }
      return { ok: true, records, unitsSpent: units, failedExternalIds: failed };
    },

    async remainingBudget(c) {
      const cap = await getQuickenrichDailyPullCap(c.workspaceId);
      const used = await quickenrichPulledToday(c.workspaceId);
      return [{ bucket: "leads", remaining: Math.max(0, cap - used), limit: cap, used, resetsAt: null, fundedBy: "daily pull cap (discovery is free)" }];
    },

    /** Every pull writes the ledger the caps read — the discovery/index.ts rule. */
    async recordUsage(workspaceId, n, query) {
      if (n <= 0) return;
      const db = await getDb();
      if (!db) return;
      try {
        await db.insert(areScrapeJobs).values({
          workspaceId, campaignId: null, sourceType: "quickenrich", query: query.slice(0, 2000),
          status: "complete", resultCount: n, scrapedAt: new Date(),
        } as never);
      } catch (e) {
        console.error("[prospectSources] quickenrich pull-ledger write failed:", (e as Error).message);
      }
    },
  };
}
