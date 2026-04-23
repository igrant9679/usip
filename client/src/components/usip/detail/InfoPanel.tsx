/**
 * InfoPanel — Apollo-style label/value field rows.
 *
 * Usage:
 *   <InfoPanel title="Deal information" fields={[
 *     { label: "STAGE", value: <StageBadge stage="qualified" /> },
 *     { label: "AMOUNT", value: "$9,000" },
 *     { label: "CLOSE DATE", value: "Dec 19, 2025" },
 *   ]} />
 */
import { ChevronDown } from "lucide-react";
import { useState } from "react";

export interface InfoField {
  label: string;
  value: React.ReactNode;
  /** If true, the row is omitted when value is falsy */
  hideIfEmpty?: boolean;
}

interface InfoPanelProps {
  title: string;
  fields: InfoField[];
  /** Default: true */
  collapsible?: boolean;
  defaultOpen?: boolean;
  className?: string;
}

export function InfoPanel({
  title,
  fields,
  collapsible = true,
  defaultOpen = true,
  className = "",
}: InfoPanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const visible = fields.filter((f) => !f.hideIfEmpty || !!f.value);

  return (
    <div className={`border rounded-lg bg-card overflow-hidden ${className}`}>
      {/* Header */}
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => collapsible && setOpen((o) => !o)}
        disabled={!collapsible}
      >
        <span className="text-[13px] font-semibold text-foreground">{title}</span>
        {collapsible && (
          <ChevronDown
            className={`size-3.5 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
          />
        )}
      </button>

      {/* Field rows */}
      {open && (
        <div className="px-4 pb-4 space-y-0 divide-y divide-border/40">
          {visible.length === 0 && (
            <p className="text-[12px] text-muted-foreground py-3">No data available.</p>
          )}
          {visible.map((f, i) => (
            <div key={i} className="flex items-start gap-3 py-2.5">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium w-32 shrink-0 mt-0.5 leading-tight">
                {f.label}
              </span>
              <span className="text-[13px] text-foreground flex-1 min-w-0 break-words leading-snug">
                {f.value ?? <span className="text-muted-foreground/60">—</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
