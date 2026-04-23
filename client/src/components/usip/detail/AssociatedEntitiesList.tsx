/**
 * AssociatedEntitiesList — Apollo-style list of related records (contacts, accounts, etc.)
 * Each row shows an avatar/initials, primary label, secondary label, and optional badge.
 * Clicking a row triggers onSelect(item).
 */
import { ChevronDown } from "lucide-react";
import { useState } from "react";

export interface AssociatedEntity {
  id: number;
  /** Displayed as the main row label */
  name: string;
  /** Displayed below the name in muted text */
  subtitle?: string;
  /** Optional badge text (e.g. email verification status) */
  badge?: string;
  badgeTone?: "success" | "warning" | "danger" | "neutral";
}

interface AssociatedEntitiesListProps {
  title: string;
  entities: AssociatedEntity[];
  onSelect?: (entity: AssociatedEntity) => void;
  emptyMessage?: string;
  /** Max rows to show before "Show more" */
  maxVisible?: number;
  className?: string;
}

const BADGE_CLASSES: Record<string, string> = {
  success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  danger: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  neutral: "bg-muted text-muted-foreground",
};

function Initials({ name }: { name: string }) {
  const parts = name.trim().split(/\s+/);
  const letters =
    parts.length >= 2
      ? `${parts[0]![0]}${parts[parts.length - 1]![0]}`
      : name.slice(0, 2);
  return (
    <div className="size-7 rounded-full bg-muted flex items-center justify-center shrink-0">
      <span className="text-[10px] font-semibold uppercase text-muted-foreground">
        {letters.toUpperCase()}
      </span>
    </div>
  );
}

export function AssociatedEntitiesList({
  title,
  entities,
  onSelect,
  emptyMessage = "None associated.",
  maxVisible = 5,
  className = "",
}: AssociatedEntitiesListProps) {
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(true);
  const visible = expanded ? entities : entities.slice(0, maxVisible);

  return (
    <div className={`border rounded-lg bg-card overflow-hidden ${className}`}>
      {/* Header */}
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-[13px] font-semibold text-foreground">
          {title}
          {entities.length > 0 && (
            <span className="ml-1.5 text-[11px] text-muted-foreground font-normal">
              ({entities.length})
            </span>
          )}
        </span>
        <ChevronDown
          className={`size-3.5 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>

      {open && (
        <div className="pb-2">
          {entities.length === 0 && (
            <p className="text-[12px] text-muted-foreground px-4 py-3">{emptyMessage}</p>
          )}
          {visible.map((entity) => (
            <div
              key={entity.id}
              role={onSelect ? "button" : undefined}
              tabIndex={onSelect ? 0 : undefined}
              onClick={() => onSelect?.(entity)}
              onKeyDown={(e) => e.key === "Enter" && onSelect?.(entity)}
              className={`flex items-center gap-3 px-4 py-2.5 ${
                onSelect
                  ? "cursor-pointer hover:bg-muted/40 transition-colors"
                  : ""
              }`}
            >
              <Initials name={entity.name} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-foreground truncate leading-snug">
                  {entity.name}
                </div>
                {entity.subtitle && (
                  <div className="text-[11px] text-muted-foreground truncate leading-tight">
                    {entity.subtitle}
                  </div>
                )}
              </div>
              {entity.badge && (
                <span
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${
                    BADGE_CLASSES[entity.badgeTone ?? "neutral"]
                  }`}
                >
                  {entity.badge}
                </span>
              )}
            </div>
          ))}
          {entities.length > maxVisible && (
            <button
              type="button"
              className="w-full text-[11px] text-muted-foreground hover:text-foreground px-4 py-2 text-left transition-colors"
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded
                ? "Show fewer"
                : `Show ${entities.length - maxVisible} more…`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
