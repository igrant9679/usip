/**
 * How a Revenue Engine campaign's status and autonomy are named, one map for
 * every screen (audit 2026-10-20, A76). The hub printed "batch approval", the
 * list "batch_approval", the page "batch approval" and the wizard "Batch
 * Approval"; review_release, which runs as Batch approval, printed as itself.
 */

export const ARE_CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  completed: "Completed",
};

export const ARE_AUTONOMY_LABEL: Record<string, string> = {
  full: "Fully autonomous",
  batch_approval: "Batch approval",
  // Removed 2026-09-02; the engine runs any row still carrying it as Batch approval.
  review_release: "Batch approval",
};

export const areStatusLabel = (s: string | null | undefined): string => ARE_CAMPAIGN_STATUS_LABEL[s ?? ""] ?? String(s ?? "");
export const areAutonomyLabel = (m: string | null | undefined): string => ARE_AUTONOMY_LABEL[m ?? ""] ?? String(m ?? "");
