/**
 * Registry stubs — Hunter.io and Lemlist. Best-guess manifests so the
 * capability union and the source strip already show them as "available,
 * not configured"; every call answers `not_implemented`. The shape is
 * proven against two real vendors first (WarmySender, QuickEnrich); these
 * become real by replacing this file's factory with an adapter, nothing else.
 */
import type { SourceCapabilities } from "@shared/prospectSources";
import type { ProspectSource } from "../types";

function stub(slug: "hunter" | "lemlist", displayName: string, docsUrl: string, caps: SourceCapabilities): ProspectSource & { acquisition: "on_demand" } {
  const notImpl = { ok: false as const, reason: "not_implemented" as const, message: `${displayName} is registered but not implemented yet` };
  return {
    slug, displayName, docsUrl, credentialMode: "table", acquisition: "on_demand",
    capabilities: () => caps,
    budgetPeriods: () => [],
    async validateCredentials() { return { ok: false, message: notImpl.message, terminal: true }; },
    async search() { return notImpl; },
    async acquire() { return notImpl; },
    async remainingBudget() { return []; },
  };
}

export const createHunterSource = () => stub("hunter", "Hunter.io", "https://hunter.io/api-documentation", {
  // Domain-oriented: find people at a company domain.
  supportedFilters: ["companyDomain", "jobTitle", "seniority", "department"],
  approximatedFilters: ["companyName"],
  supportsFreePreview: true, returnsMaskedPreview: true, supportsMobilePhone: false,
  supportsVerification: true, maxBatchSize: 100, geographicCoverage: [],
});

export const createLemlistSource = () => stub("lemlist", "Lemlist", "https://developer.lemlist.com", {
  supportedFilters: ["jobTitle", "industry", "country", "companyName", "keyword"],
  approximatedFilters: ["seniority"],
  supportsFreePreview: false, returnsMaskedPreview: false, supportsMobilePhone: true,
  supportsVerification: true, maxBatchSize: 50, geographicCoverage: [],
});
