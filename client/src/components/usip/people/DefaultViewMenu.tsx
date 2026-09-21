/**
 * DefaultViewMenu — the People page "Default view" switcher (top-left).
 *
 * A table/grid-icon button + label + chevron that opens a popover with a
 * search box, the list of saved searches (the system "Default view" carries a
 * System pill + selected check), per-row Update/Delete affordances, and a
 * "Create saved search" footer that hands off to the Search-settings create
 * flow. Selecting a view bubbles up so the page can apply its columns, filters
 * and sort and relabel the button. Closes on outside-click / Escape (Radix
 * Popover).
 *
 * The All/Yours/Starred/Assigned/Shared tab row is GONE (2026-09-20). Saved
 * searches are private per user (migration 0185) and nothing has ever been
 * able to star or assign one, so four of the five tabs were structurally empty
 * and the fifth duplicated the list. An empty tab is a promise the screen
 * cannot keep.
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ChevronDown, Check, Plus, Save, Search, Table2, Trash2 } from "lucide-react";
import type { SavedView } from "./peopleShared";

export function DefaultViewMenu({
  views,
  activeViewId,
  onSelect,
  onCreate,
  onUpdate,
  onRemove,
}: {
  views: SavedView[];
  activeViewId: string;
  onSelect: (v: SavedView) => void;
  onCreate: () => void;
  /** Overwrite this search with what the page is showing right now. */
  onUpdate?: (v: SavedView) => void;
  onRemove?: (v: SavedView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const activeName = views.find((v) => v.id === activeViewId)?.name ?? "Default view";

  const filtered = useMemo(
    () => views.filter((v) => !q || v.name.toLowerCase().includes(q.toLowerCase())),
    [views, q],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Table2 className="size-4" /> {activeName} <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[420px] p-0">
        {/* search */}
        <div className="p-2.5 border-b">
          <div className="flex items-center gap-2 px-2 h-8 rounded-md border bg-background">
            <Search className="size-3.5 text-muted-foreground shrink-0" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="flex-1 bg-transparent outline-none text-[13px] min-w-0"
            />
          </div>
        </div>

        {/* rows — the row action buttons sit OUTSIDE the select button: a
            button nested in a button is invalid HTML and the inner click was
            swallowed by the row's own handler. */}
        <div className="max-h-64 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">No saved searches</p>
          ) : (
            filtered.map((v) => (
              <div
                key={v.id}
                className={cn(
                  "group/row flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-muted",
                  v.id === activeViewId && "bg-muted/60",
                )}
              >
                <button
                  type="button"
                  onClick={() => { onSelect(v); setOpen(false); }}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <Table2 className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{v.name}</span>
                </button>
                {v.system && (
                  <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">System</span>
                )}
                {!v.system && onUpdate && v.id === activeViewId && (
                  <button
                    type="button"
                    title="Save the current filters, columns and sort to this search"
                    onClick={(e) => { e.stopPropagation(); onUpdate(v); setOpen(false); }}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                    aria-label={`Update ${v.name}`}
                  >
                    <Save className="size-3.5" />
                  </button>
                )}
                {!v.system && onRemove && (
                  <button
                    type="button"
                    title="Delete this saved search"
                    onClick={(e) => { e.stopPropagation(); onRemove(v); }}
                    className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-rose-600 group-hover/row:opacity-100"
                    aria-label={`Delete ${v.name}`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
                {v.id === activeViewId && <Check className="size-4 shrink-0 text-foreground" />}
              </div>
            ))
          )}
        </div>

        {/* footer */}
        <div className="border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-[13px]"
            onClick={() => { setOpen(false); onCreate(); }}
          >
            <Plus className="size-4" /> Create saved search
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
