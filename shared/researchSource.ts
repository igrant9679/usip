/**
 * Companies sourced by Research (owner, 2026-10-16: "the companies imported
 * or identified by the Research module ... should be identified as sourced by
 * Research"). accounts.source_type says where a company came from;
 * accounts.research_sector_id says which research sector it belongs to, for
 * any company, whatever created it.
 */

export const RESEARCH_SOURCES = {
  /** Created by a Downstream import. */
  downstream: "research_downstream",
  /** Created when someone approved a prospect of a campaign tied to a research sector. */
  campaign: "research_campaign",
} as const;

export function isResearchSource(sourceType: string | null | undefined): boolean {
  return typeof sourceType === "string" && sourceType.startsWith("research_");
}

const LABEL: Record<string, string> = {
  research_downstream: "Research (Downstream)",
  research_campaign: "Research (campaign)",
  are_approval: "Campaign approval",
  prospect_import: "Prospect import",
  job_change: "Job change",
};

/** How a company's source reads on the page. */
export function companySourceLabel(sourceType: string | null | undefined): string {
  if (!sourceType) return "Not recorded";
  return LABEL[sourceType] ?? sourceType.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
