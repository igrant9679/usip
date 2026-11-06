import { leadTierLabel, type LeadTier } from "@shared/leadTier";

export type SavedScore = {
  scored: boolean;
  total: number;
  tier: LeadTier | null;
  scoredAt: Date | string | null;
};

/**
 * The line under a lead's score breakdown, saying what the lead holds now
 * (audit 2026-10-20, P12, P119). The breakdown is what the next re-score
 * saves; this says whether that is already saved, when it was scored, and
 * says "Not scored yet" for a lead never scored, which used to read Cold.
 */
export function savedScoreLine(saved: SavedScore, total: number, opts: { unsavedWeights?: boolean; now?: number } = {}): string {
  if (!saved.scored) {
    return "Not scored yet. The hourly re-score saves this total; Recompute also asks the AI for its fit.";
  }
  const when = saved.scoredAt ? `scored ${relativeTime(new Date(saved.scoredAt).getTime(), opts.now ?? Date.now())}` : "scored";
  if (opts.unsavedWeights) {
    return `With your unsaved weights. Saved score: ${saved.total} (${leadTierLabel(saved.tier)}), ${when}.`;
  }
  if (saved.total !== total) {
    return `Saved score: ${saved.total} (${leadTierLabel(saved.tier)}), ${when}. The next re-score saves ${total}.`;
  }
  return `Saved, ${when}.`;
}

function relativeTime(at: number, now: number): string {
  const mins = Math.round((now - at) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
