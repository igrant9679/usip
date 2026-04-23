/**
 * ActivityTimeline — Apollo-style chronological activity feed.
 * Groups activities by month, shows icon + subject + notes + timestamp.
 */
import { Calendar, MessageSquare, Phone, FileText } from "lucide-react";

export interface TimelineActivity {
  id: number;
  kind: "call" | "meeting" | "note" | string;
  subject?: string | null;
  notes?: string | null;
  disposition?: string | null;
  createdAt: Date | string | number;
}

interface ActivityTimelineProps {
  activities: TimelineActivity[];
  isLoading?: boolean;
  emptyMessage?: string;
  className?: string;
}

function fmtDate(d: Date | string | number): string {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtMonth(d: Date | string | number): string {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === "call") return <Phone className="size-3.5 text-[#14B89A]" />;
  if (kind === "meeting") return <Calendar className="size-3.5 text-blue-500" />;
  if (kind === "note") return <MessageSquare className="size-3.5 text-amber-500" />;
  return <FileText className="size-3.5 text-muted-foreground" />;
}

export function ActivityTimeline({
  activities,
  isLoading,
  emptyMessage = "No activity logged yet.",
  className = "",
}: ActivityTimelineProps) {
  if (isLoading) {
    return (
      <div className={`space-y-2 ${className}`}>
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <p className={`text-[12px] text-muted-foreground py-4 text-center ${className}`}>
        {emptyMessage}
      </p>
    );
  }

  // Group by month
  const groups = new Map<string, TimelineActivity[]>();
  for (const a of activities) {
    const key = fmtMonth(a.createdAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }

  return (
    <div className={`space-y-4 ${className}`}>
      {Array.from(groups.entries()).map(([month, items]) => (
        <div key={month}>
          {/* Month header */}
          <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-2 px-1">
            {month}
          </div>
          <div className="space-y-2">
            {items.map((a) => (
              <div
                key={a.id}
                className="border rounded-lg bg-card px-3 py-2.5 flex gap-3"
              >
                {/* Icon column */}
                <div className="mt-0.5 shrink-0">
                  <KindIcon kind={a.kind} />
                </div>
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-widest font-medium text-muted-foreground">
                      {a.kind}
                    </span>
                    {a.disposition && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground capitalize">
                        {a.disposition.replace(/_/g, " ")}
                      </span>
                    )}
                    <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
                      {fmtDate(a.createdAt)}
                    </span>
                  </div>
                  {a.subject && (
                    <div className="text-[13px] font-medium text-foreground mt-0.5 leading-snug">
                      {a.subject}
                    </div>
                  )}
                  {a.notes && (
                    <div className="text-[12px] text-foreground/80 mt-1 whitespace-pre-wrap line-clamp-3">
                      {a.notes}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
