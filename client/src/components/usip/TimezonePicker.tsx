/**
 * TimezonePicker — every IANA time zone, defaulting to the workspace's
 * (audit 2026-10-20, U15). A native select, grouped by region, so it types to
 * search on every platform and needs no extra library; each zone shows its
 * offset now. The first option, "Workspace time zone", stores no zone of the
 * sequence's own: the engine then uses the workspace's (Settings).
 */
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { timezoneGroups, utcOffsetLabel } from "@shared/timezones";

/** The value that means "no zone of its own". */
export const WORKSPACE_TZ = "__workspace__";

export function TimezonePicker({
  value, onChange, disabled, className, label = "Time zone", workspaceZone,
}: {
  /** The sequence's own zone, or null/undefined for the workspace's. */
  value: string | null | undefined;
  /** Called with a zone name, or null for the workspace's. */
  onChange: (zone: string | null) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
  /** The workspace's zone, named on the default choice when the caller knows it (useWorkspaceTimezone). */
  workspaceZone?: string | null;
}) {
  const groups = useMemo(() => timezoneGroups(), []);
  const now = Date.now();
  const known = !value || groups.some((g) => g.zones.includes(value));
  return (
    <select
      aria-label={label}
      value={value || WORKSPACE_TZ}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === WORKSPACE_TZ ? null : e.target.value)}
      className={cn("h-9 w-full rounded-md border border-border bg-background px-2 text-xs", className)}
    >
      <option value={WORKSPACE_TZ}>{workspaceZone ? `Workspace time zone (${workspaceZone})` : "Workspace time zone"}</option>
      {/* A zone saved before this picker that this browser doesn't list stays selectable. */}
      {!known && value ? <option value={value}>{value}</option> : null}
      {groups.map((g) => (
        <optgroup key={g.region} label={g.region}>
          {g.zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")} ({utcOffsetLabel(z, now)})</option>)}
        </optgroup>
      ))}
    </select>
  );
}
