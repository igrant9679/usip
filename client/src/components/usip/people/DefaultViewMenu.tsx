/**
 * DefaultViewMenu — the People page "Default view" switcher (top-left).
 *
 * A table/grid-icon button + label + chevron that opens a popover with a
 * search box, the All/Your/Starred/Assigned/Shared tab row, the list of saved
 * searches (the system "Default view" carries a System pill + selected check),
 * and a "Create saved search" affordance that hands off to the Search-settings
 * create flow. Selecting a view bubbles up so the page can apply its columns
 * and relabel the button. Closes on outside-click / Escape (Radix Popover).
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ChevronDown, Check, Plus, Search, Table2, Star } from "lucide-react";
import type { SavedView } from "./peopleShared";

const TABS = [
  { id: "all", label: "All searches" },
  { id: "yours", label: "Your searches" },
  { id: "starred", label: "Starred" },
  { id: "assigned", label: "Assigned to you" },
  { id: "shared", label: "Shared" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function DefaultViewMenu({
  views,
  activeViewId,
  onSelect,
  onCreate,
}: {
  views: SavedView[];
  activeViewId: string;
  onSelect: (v: SavedView) => void;
  onCreate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<TabId>("all");

  const activeName = views.find((v) => v.id === activeViewId)?.name ?? "Default view";

  const filtered = useMemo(() => {
    return views.filter((v) => {
      if (q && !v.name.toLowerCase().includes(q.toLowerCase())) return false;
      if (tab === "yours") return v.scope === "yours" || v.system;
      if (tab === "starred") return !!v.starred;
      if (tab === "assigned") return v.scope === "yours";
      if (tab === "shared") return v.scope === "shared";
      return true;
    });
  }, [views, q, tab]);

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

        {/* tabs */}
        <div className="flex items-center gap-4 px-3 pt-2 border-b text-[13px] overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "pb-2 -mb-px border-b-2 whitespace-nowrap transition-colors",
                tab === t.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* rows */}
        <div className="max-h-64 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">No saved searches</p>
          ) : (
            filtered.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => { onSelect(v); setOpen(false); }}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-muted text-left",
                  v.id === activeViewId && "bg-muted/60",
                )}
              >
                <Table2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{v.name}</span>
                {v.starred && <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" />}
                {v.system && (
                  <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">System</span>
                )}
                {v.id === activeViewId && <Check className="size-4 shrink-0 text-foreground" />}
              </button>
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
