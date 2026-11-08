import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { pressable } from "@/lib/pressable";
import { cn } from "@/lib/utils";

/**
 * A list page's rows as stacked cards on a phone (audit 2026-10-20, U8).
 *
 * A table seven or eight columns wide on a 375 px screen is a sideways
 * scroll with the name pinned and everything else off screen. On a phone the
 * main list pages render this instead, from the same rows and the same cell
 * renderers the table uses, so a card shows exactly what the row does:
 *
 *   phone
 *     ? <RecordCards rows={rows} rowKey={(r) => r.id} primary={(r) => r.name}
 *         fields={[{ key: "title", label: "Title", render: (r) => r.title }]}
 *         onOpen={(r) => open(r.id)} selected={(r) => r.id === openId}
 *         checked={(r) => picked.has(r.id)} onCheck={(r) => toggle(r.id)} />
 *     : <table>…</table>
 *
 * One card per row: an optional checkbox (the bulk selection, kept), the
 * primary line, then label / value pairs. A card opens like its row (click,
 * Enter or Space); the checkbox and anything interactive inside a value stop
 * there.
 */
export type CardField<T> = { key: string; label: ReactNode; render: (row: T) => ReactNode };

export function RecordCards<T>({
  rows,
  rowKey,
  primary,
  fields,
  onOpen,
  selected,
  checked,
  onCheck,
  checkLabel = "Select",
  busy,
  className,
  label,
  footer,
}: {
  rows: readonly T[];
  /** The row's own actions (the table's last column), under the fields. */
  footer?: (row: T) => ReactNode;
  rowKey: (row: T) => string | number;
  /** The card's first line (the row's name cell). */
  primary: (row: T) => ReactNode;
  fields: CardField<T>[];
  onOpen?: (row: T) => void;
  selected?: (row: T) => boolean;
  checked?: (row: T) => boolean;
  onCheck?: (row: T) => void;
  checkLabel?: string;
  /** The next page is loading behind these rows. */
  busy?: boolean;
  className?: string;
  /** Names the list for a screen reader ("People", "Companies"). */
  label?: string;
}) {
  return (
    <ul
      aria-label={label}
      aria-busy={busy || undefined}
      data-record-cards=""
      className={cn("divide-y divide-border/60 transition-opacity", busy && "opacity-60", className)}
    >
      {rows.map((row) => {
        const on = selected?.(row) ?? false;
        return (
          <li key={rowKey(row)} className={cn("relative bg-background", on && "bg-muted")}>
            {on && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-foreground/70" />}
            <div
              {...(onOpen ? pressable(() => onOpen(row), { row: true }) : {})}
              className={cn("flex items-start gap-3 px-3 py-2.5", onOpen && "cursor-pointer hover:bg-muted/60")}
            >
              {onCheck && (
                <span className="pt-0.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  <Checkbox aria-label={checkLabel} checked={checked?.(row) ?? false} onCheckedChange={() => onCheck(row)} className="size-4" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="min-w-0 text-[13.5px] font-medium">{primary(row)}</div>
                {fields.length > 0 && (
                  <dl className="mt-1.5 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
                    {fields.map((f) => (
                      <div key={f.key} className="contents">
                        <dt className="text-muted-foreground whitespace-nowrap">{f.label}</dt>
                        <dd className="min-w-0 break-words">{f.render(row)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {footer && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    {footer(row)}
                  </div>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
