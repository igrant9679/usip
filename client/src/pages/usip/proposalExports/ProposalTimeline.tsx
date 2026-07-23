/**
 * Visual milestone timeline for a proposal.
 *
 * Renders the milestones list as a vertical timeline with numbered nodes,
 * connecting line, date pills, descriptions, and owner badges. Read-only
 * by design — editing milestones still happens via the existing form.
 *
 * Color scheme matches the brand (navy/blue/teal/amber for the four owners).
 */

import { Calendar, User, Briefcase, Users } from "lucide-react";

export type TimelineMilestone = {
  id?: number;
  name: string;
  milestoneDate?: string | Date | null;
  description?: string | null;
  owner?: "lsi_media" | "client" | "both" | string | null;
  sortOrder?: number;
};

const OWNER_STYLE: Record<string, { label: string; bg: string; ring: string; text: string; Icon: React.ComponentType<{ className?: string }> }> = {
  lsi_media: { label: "Our Team", bg: "bg-blue-600", ring: "ring-blue-100", text: "text-blue-700", Icon: Briefcase },
  client: { label: "Client", bg: "bg-amber-500", ring: "ring-amber-100", text: "text-amber-700", Icon: User },
  both: { label: "Both", bg: "bg-teal-600", ring: "ring-teal-100", text: "text-teal-700", Icon: Users },
};

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "TBD";
  try {
    const date = typeof d === "string" ? new Date(d) : d;
    if (isNaN(date.getTime())) return "TBD";
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "TBD";
  }
}

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

export function ProposalTimeline({
  milestones,
  startDate,
  endDate,
}: {
  milestones: TimelineMilestone[];
  /** Optional project start date — shown as a gray "Kickoff" node at the top. */
  startDate?: string | Date | null;
  /** Optional project end date — shown as a green "Delivery" node at the bottom. */
  endDate?: string | Date | null;
}) {
  if (!milestones?.length && !startDate && !endDate) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        No milestones yet. Add some below to populate the timeline.
      </div>
    );
  }

  // Compute total span for the progress hint at the top
  const dateRange = (() => {
    if (!startDate || !endDate) return null;
    try {
      const s = new Date(startDate);
      const e = new Date(endDate);
      if (isNaN(s.getTime()) || isNaN(e.getTime())) return null;
      return daysBetween(s, e);
    } catch {
      return null;
    }
  })();

  const sorted = [...milestones].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  return (
    <div className="space-y-4">
      {dateRange !== null && (
        <div className="rounded-md border bg-blue-50/40 px-4 py-2 text-xs text-blue-900 flex items-center gap-2">
          <Calendar className="size-3.5" />
          <span>
            Project span: <strong>{dateRange} days</strong>
            {startDate ? ` from ${fmtDate(startDate)}` : ""}
            {endDate ? ` to ${fmtDate(endDate)}` : ""}
          </span>
        </div>
      )}

      <div className="relative pl-8">
        {/* Vertical connecting line */}
        <div className="absolute left-3 top-2 bottom-2 w-0.5 bg-gradient-to-b from-blue-200 via-blue-300 to-teal-300" />

        {/* Kickoff node */}
        {startDate && (
          <TimelineRow
            number="●"
            color="bg-slate-500"
            ring="ring-slate-100"
            title="Project Kickoff"
            date={fmtDate(startDate)}
            description={null}
            ownerKey={null}
            isStart
          />
        )}

        {sorted.map((m, i) => (
          <TimelineRow
            key={m.id ?? i}
            number={String(i + 1)}
            color={OWNER_STYLE[String(m.owner)]?.bg ?? "bg-blue-600"}
            ring={OWNER_STYLE[String(m.owner)]?.ring ?? "ring-blue-100"}
            title={m.name}
            date={fmtDate(m.milestoneDate)}
            description={m.description ?? null}
            ownerKey={String(m.owner ?? "lsi_media")}
          />
        ))}

        {/* Delivery node */}
        {endDate && (
          <TimelineRow
            number="✓"
            color="bg-emerald-600"
            ring="ring-emerald-100"
            title="Project Delivery"
            date={fmtDate(endDate)}
            description={null}
            ownerKey={null}
            isEnd
          />
        )}
      </div>
    </div>
  );
}

function TimelineRow({
  number,
  color,
  ring,
  title,
  date,
  description,
  ownerKey,
  isStart,
  isEnd,
}: {
  number: string;
  color: string;
  ring: string;
  title: string;
  date: string;
  description: string | null;
  ownerKey: string | null;
  isStart?: boolean;
  isEnd?: boolean;
}) {
  const owner = ownerKey ? OWNER_STYLE[ownerKey] : null;
  return (
    <div className="relative pb-6 last:pb-0">
      {/* Numbered circle node */}
      <div
        className={`absolute -left-8 top-0.5 flex size-6 items-center justify-center rounded-full text-white text-xs font-bold ring-4 ${color} ${ring}`}
      >
        {number}
      </div>

      {/* Content */}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className={`font-semibold text-sm ${isStart || isEnd ? "text-muted-foreground uppercase tracking-wider text-xs" : ""}`}>
            {title}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">{date}</span>
          {owner && (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted ${owner.text}`}
            >
              <owner.Icon className="size-2.5" />
              {owner.label}
            </span>
          )}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground leading-relaxed max-w-xl">{description}</p>
        )}
      </div>
    </div>
  );
}
