/**
 * DashboardFilterBar — global filter controls for a dashboard.
 *
 * Filters exposed:
 *   - Date range: presets (Today, 7d, 30d, 90d, YTD, All) + custom date picker
 *   - Owner (rep user ID)
 *   - Stage (opportunity stage)
 *   - Source (lead source)
 *
 * The component is purely presentational — it calls `onChange` with the
 * current filter state whenever any value changes.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar, ChevronDown, Filter, X } from "lucide-react";
import { useState } from "react";

/* ─── Types ──────────────────────────────────────────────────────────────── */
export interface DashboardFilters {
  preset: string;        // "today" | "7d" | "30d" | "90d" | "ytd" | "all" | "custom"
  dateFrom?: string;     // ISO date string (YYYY-MM-DD)
  dateTo?: string;       // ISO date string (YYYY-MM-DD)
  ownerUserId?: number;
  stage?: string;
  source?: string;
}

export interface DashboardFilterBarProps {
  filters: DashboardFilters;
  onChange: (f: DashboardFilters) => void;
  /** Optional list of workspace members for the owner filter */
  members?: Array<{ userId: number; name: string }>;
}

/* ─── Preset definitions ─────────────────────────────────────────────────── */
const PRESETS: Array<{ label: string; value: string }> = [
  { label: "Today", value: "today" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
  { label: "Last 90 days", value: "90d" },
  { label: "Year to date", value: "ytd" },
  { label: "All time", value: "all" },
  { label: "Custom range", value: "custom" },
];

const STAGES = [
  { label: "Discovery", value: "discovery" },
  { label: "Qualified", value: "qualified" },
  { label: "Proposal", value: "proposal" },
  { label: "Negotiation", value: "negotiation" },
  { label: "Won", value: "won" },
  { label: "Lost", value: "lost" },
];

const SOURCES = [
  { label: "Inbound", value: "inbound" },
  { label: "Outbound", value: "outbound" },
  { label: "Referral", value: "referral" },
  { label: "Partner", value: "partner" },
  { label: "Event", value: "event" },
  { label: "Website", value: "website" },
  { label: "Cold Call", value: "cold_call" },
  { label: "Email Campaign", value: "email_campaign" },
];

/* ─── Preset → date range resolver ──────────────────────────────────────── */
export function resolvePresetDates(preset: string): { dateFrom?: string; dateTo?: string } {
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  switch (preset) {
    case "today":
      return { dateFrom: fmt(today), dateTo: fmt(today) };
    case "7d": {
      const from = new Date(today); from.setDate(from.getDate() - 6);
      return { dateFrom: fmt(from), dateTo: fmt(today) };
    }
    case "30d": {
      const from = new Date(today); from.setDate(from.getDate() - 29);
      return { dateFrom: fmt(from), dateTo: fmt(today) };
    }
    case "90d": {
      const from = new Date(today); from.setDate(from.getDate() - 89);
      return { dateFrom: fmt(from), dateTo: fmt(today) };
    }
    case "ytd": {
      const from = new Date(today.getFullYear(), 0, 1);
      return { dateFrom: fmt(from), dateTo: fmt(today) };
    }
    case "all":
    default:
      return {};
  }
}

/* ─── Active filter count badge ──────────────────────────────────────────── */
function activeCount(f: DashboardFilters): number {
  let n = 0;
  if (f.preset !== "all") n++;
  if (f.ownerUserId) n++;
  if (f.stage) n++;
  if (f.source) n++;
  return n;
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════════════════════════ */
export function DashboardFilterBar({ filters, onChange, members = [] }: DashboardFilterBarProps) {
  const [open, setOpen] = useState(false);
  const count = activeCount(filters);

  const update = (patch: Partial<DashboardFilters>) => {
    const next = { ...filters, ...patch };
    // When preset changes (not custom), clear custom dates
    if (patch.preset && patch.preset !== "custom") {
      const dates = resolvePresetDates(patch.preset);
      next.dateFrom = dates.dateFrom;
      next.dateTo = dates.dateTo;
    }
    onChange(next);
  };

  const reset = () => onChange({ preset: "all" });

  const presetLabel = PRESETS.find((p) => p.value === filters.preset)?.label ?? "All time";

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Date preset quick-select */}
      <div className="flex items-center gap-1 bg-secondary/50 rounded-lg p-0.5">
        {PRESETS.filter((p) => p.value !== "custom").map((p) => (
          <button
            key={p.value}
            onClick={() => update({ preset: p.value })}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              filters.preset === p.value
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Custom date range */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
            <Calendar className="h-3 w-3" />
            {filters.preset === "custom" && filters.dateFrom
              ? `${filters.dateFrom} → ${filters.dateTo ?? "…"}`
              : "Custom"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3" align="start">
          <div className="space-y-2">
            <p className="text-xs font-medium">Custom date range</p>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] text-muted-foreground uppercase tracking-wide">From</label>
              <Input
                type="date"
                className="h-7 text-xs"
                value={filters.dateFrom ?? ""}
                onChange={(e) => update({ preset: "custom", dateFrom: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] text-muted-foreground uppercase tracking-wide">To</label>
              <Input
                type="date"
                className="h-7 text-xs"
                value={filters.dateTo ?? ""}
                onChange={(e) => update({ preset: "custom", dateTo: e.target.value })}
              />
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Owner filter */}
      {members.length > 0 && (
        <Select
          value={filters.ownerUserId?.toString() ?? "all"}
          onValueChange={(v) => update({ ownerUserId: v === "all" ? undefined : Number(v) })}
        >
          <SelectTrigger className="h-7 w-[130px] text-xs">
            <SelectValue placeholder="Owner" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All owners</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.userId} value={m.userId.toString()}>{m.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Stage filter */}
      <Select
        value={filters.stage ?? "all"}
        onValueChange={(v) => update({ stage: v === "all" ? undefined : v })}
      >
        <SelectTrigger className="h-7 w-[120px] text-xs">
          <SelectValue placeholder="Stage" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All stages</SelectItem>
          {STAGES.map((s) => (
            <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Source filter */}
      <Select
        value={filters.source ?? "all"}
        onValueChange={(v) => update({ source: v === "all" ? undefined : v })}
      >
        <SelectTrigger className="h-7 w-[130px] text-xs">
          <SelectValue placeholder="Source" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All sources</SelectItem>
          {SOURCES.map((s) => (
            <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Active filter badge + reset */}
      {count > 0 && (
        <div className="flex items-center gap-1">
          <Badge variant="secondary" className="text-[10px] h-5 px-1.5 gap-1">
            <Filter className="h-2.5 w-2.5" />
            {count} active
          </Badge>
          <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={reset} title="Clear all filters">
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}
