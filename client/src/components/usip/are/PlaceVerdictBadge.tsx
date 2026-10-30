/**
 * The territory verdict on a prospect — F17, one component so the row and the
 * dossier cannot drift apart.
 *
 * Three states, and the third is not a failure of the other two: `unknown`
 * means the place could not be read, which is common and honest. Two discovery
 * sources write an empty place, internal leads never have one, and QuickEnrich
 * writes none at all unless its states route ran. So `unknown` is rendered as a
 * quiet, neutral fact with the reason in its tooltip — not as a warning, and
 * never as "outside".
 *
 * The place that was judged rides along in the title, because a verdict whose
 * input is invisible cannot be argued with, and this one is wrong often enough
 * to need arguing with.
 */
import { Badge } from "@/components/ui/badge";

export type PlaceVerdict = "inside" | "elsewhere" | "unknown";

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
  return (
    <Badge
      variant="outline"
      className={`text-[10px] px-1.5 py-0 font-normal ${s.className} ${className ?? ""}`}
      title={`${s.why}${read ? ` Read from: "${read}".` : " No place was recorded for them."}`}
    >
      {s.label}
    </Badge>
  );
}
