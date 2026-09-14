/**
 * Apollo.io as a registry adapter — search-only, zero credits, no emails
 * (owner decision, permanent; server/apolloSearchOnly.test.ts pins that no
 * `/people/match` line exists anywhere). Acquisition mode "none": the
 * company domain Apollo hands over is what the free enrichment path needs.
 *
 * Budget: the existing per-day pull cap (workspace_settings.apolloDailyPullCap)
 * metered through are_scrape_jobs, unchanged.
 */
import type { SourceCapabilities } from "@shared/prospectSources";
import type { ProspectRecord, ProspectSource } from "../types";
import { apolloPulledToday, apolloSearchPeople, apolloTestKey, getApolloDailyCap } from "../../apollo";
import { areScrapeJobs } from "../../../../drizzle/schema";
import { getDb } from "../../../db";

const CAPS: SourceCapabilities = {
  supportedFilters: ["jobTitle", "seniority", "country", "stateProvince", "city", "headcountRange"],
  approximatedFilters: ["industry", "keyword", "companyName"],
  supportsFreePreview: true,
  returnsMaskedPreview: true, // never an email on the search path
  supportsMobilePhone: false,
  supportsVerification: false,
  maxBatchSize: 100,
  geographicCoverage: [],
};

export function createApolloSource(): ProspectSource & { acquisition: "none"; recordUsage: (ws: number, n: number, q: string) => Promise<void> } {
  return {
    slug: "apollo",
    displayName: "Apollo.io",
    docsUrl: "https://docs.apollo.io",
    credentialMode: "legacy",
    acquisition: "none",
    capabilities: () => CAPS,
    budgetPeriods: () => [],

    async validateCredentials(c) {
      const r = await apolloTestKey(c.workspaceId);
      return { ok: r.ok, message: r.message ?? (r.ok ? "Key accepted" : "Key rejected"), terminal: !r.ok };
    },

    async search(criteria, c, limit, ctx) {
      const cap = await getApolloDailyCap(c.workspaceId);
      const used = await apolloPulledToday(c.workspaceId);
      const headroom = Math.max(0, cap - used);
      if (headroom <= 0) return { ok: false, reason: "budget_exhausted", message: `daily record cap reached (${used}/${cap})` };
      const locations = criteria.countries.concat(criteria.stateProvinces, criteria.cities);
      const res = await apolloSearchPeople(c.workspaceId, {
        titles: criteria.jobTitles, seniorities: criteria.seniorities, industries: criteria.industries,
        locations, keywords: criteria.keywords.concat(criteria.companyNames),
        employeeMin: criteria.headcountRange?.min, employeeMax: criteria.headcountRange?.max,
        page: ctx.cursor ? Math.max(1, Number(ctx.cursor) || 1) : 1,
        perPage: Math.min(limit, headroom, 100),
      });
      if (!res.ok) {
        const msg = res.error ?? "Apollo search failed";
        return { ok: false, reason: /No Apollo API key/i.test(msg) ? "no_credentials" : /429|rate/i.test(msg) ? "rate_limited" : /401|403/.test(msg) ? "unauthorized" : "unavailable", message: msg };
      }
      const records: ProspectRecord[] = res.prospects.map((p) => ({
        externalId: p.linkedinUrl || p.sourceUrl || `${p.firstName} ${p.lastName}@${p.companyDomain}`,
        firstName: p.firstName, lastName: p.lastName, jobTitle: p.title || null, seniority: null,
        companyName: p.companyName || null, companyDomain: p.companyDomain || null,
        email: null, emailIsMasked: true, emailVerifiedAt: null,
        mobilePhone: null, businessPhone: null, linkedinUrl: p.linkedinUrl || null,
        city: null, stateProvince: null, country: p.geography || null, industry: p.industry || null, headcount: p.companySize || null,
        rawSourcePayload: { sourceUrl: p.sourceUrl, confidence: p.confidence },
      }));
      const page = ctx.cursor ? Math.max(1, Number(ctx.cursor) || 1) : 1;
      return { ok: true, records, nextCursor: records.length > 0 ? String(page + 1) : null, totalAvailable: res.totalAvailable, alreadyCharged: false, unitsSpent: 0 };
    },

    async acquire(externalIds) {
      // Never. Emails come from the free enrichment path.
      return { ok: true, records: [], unitsSpent: 0, failedExternalIds: externalIds };
    },

    async remainingBudget(c) {
      const cap = await getApolloDailyCap(c.workspaceId);
      const used = await apolloPulledToday(c.workspaceId);
      return [{ bucket: "leads", remaining: Math.max(0, cap - used), limit: cap, used, resetsAt: null, fundedBy: "daily record cap (search costs no credits)" }];
    },

    async recordUsage(workspaceId, n, query) {
      if (n <= 0) return;
      const db = await getDb();
      if (!db) return;
      try {
        await db.insert(areScrapeJobs).values({
          workspaceId, campaignId: null, sourceType: "apollo", query: query.slice(0, 2000),
          status: "complete", resultCount: n, scrapedAt: new Date(),
        } as never);
      } catch (e) {
        console.error("[prospectSources] apollo pull-ledger write failed:", (e as Error).message);
      }
    },
  };
}
