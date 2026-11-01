/**
 * The territory verdict on a prospect — F17, one component so the row and the
 * dossier cannot drift apart.
 *
 * Four states, and only the first two are verdicts about the person.
 *
 * `unknown` means their place could not be read, which is common and honest:
 * two discovery sources write an empty place, internal leads never have one,
 * and QuickEnrich writes none at all unless its states route ran. `no_targets`
 * means the CAMPAIGN named no places, so nobody could be judged either way
 * (added 2026-10-31, after the live app showed a campaign with no ICP telling
 * its owner there was "not enough place detail" above a prospect reading
 * "Boston, MA"). Both render as quiet, neutral facts with the reason in the
 * tooltip — never as a warning, and never as "outside".
 *
 * The place that was judged rides along in the title, because a verdict whose
 * input is invisible cannot be argued with, and this one is wrong often enough
 * to need arguing with.
 */
import { Badge } from "@/components/ui/badge";

export type PlaceVerdict = "inside" | "elsewhere" | "unknown" | "no_targets";

const STYLE: Record<PlaceVerdict, { label: string; className: string; why: string }> = {
  inside: {
    label: "In target area",
    className: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
    why: "Their place matches one of the campaign's places.",
  },
  elsewhere: {
    label: "Outside target area",
    className: "border-rose-500/40 text-rose-700 dark:text-rose-400",
    why: "Their country or state is one the campaign's places exclude.",
  },
  unknown: {
    label: "Place unknown",
    className: "border-border text-muted-foreground",
    why: "Not enough place detail to judge — this is not the same as being outside the area.",
  },
  /**
   * The campaign's gap, not the person's. Until 2026-10-31 this case borrowed
   * `unknown`, so a campaign with no ICP at all told the owner there was "not
   * enough place detail to judge" while showing him a perfectly readable
   * "Boston, MA" in the same sentence — pointing him at the prospect records
   * when the fix was in the campaign's targeting.
   */
  no_targets: {
    label: "No target area",
    className: "border-border text-muted-foreground",
    why: "This campaign names no places, so there is nothing to judge anyone against. Set them in its targeting.",
  },
};

export function PlaceVerdictBadge({ verdict, place, className }: {
  verdict?: PlaceVerdict | null;
  /** What was actually read, shown in the tooltip. */
  place?: string | null;
  className?: string;
}) {
  if (!verdict) return null;
  const s = STYLE[verdict];
  if (!s) return null;
  const read = String(place ?? "").trim();
  // "No place was recorded" belongs only to verdicts that turned on the place.
  // Under `no_targets` nothing was judged, so saying their place is missing
  // would be a second wrong blame on top of the one this verdict exists to
  // undo.
  const from = read ? ` Read from: "${read}".` : verdict === "no_targets" ? "" : " No place was recorded for them.";
  return (
    <Badge
      variant="outline"
      className={`text-[10px] px-1.5 py-0 font-normal ${s.className} ${className ?? ""}`}
      title={`${s.why}${from}`}
    >
      {s.label}
    </Badge>
  );
}
