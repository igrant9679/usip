/**
 * SortMenu — the "Sort" control (sort-icon button + chevron).
 *
 * Opens a popover with a "Sort by" label (+ info icon), a field Select, a
 * direction Select (Ascending / Descending), and an Apply button that is
 * disabled until a valid field is chosen. Pending field/direction live locally
 * and reset to unset each time the popover opens (matching Apollo's "Select…"
 * default); committing calls onApply so the page re-sorts the loaded rows.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowUpDown, ChevronDown, Info } from "lucide-react";
import { SORT_FIELDS, type SortField, type SortDir } from "./peopleShared";

export function SortMenu({ onApply }: { onApply: (field: SortField, dir: SortDir) => void }) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<SortField | "">("");
  const [dir, setDir] = useState<SortDir>("desc");

  // Reset the pending selection each time the popover opens (Apollo shows an
  // unselected "Select…" with Descending pre-chosen and Apply disabled).
  const handleOpenChange = (o: boolean) => {
    if (o) { setField(""); setDir("desc"); }
    setOpen(o);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <ArrowUpDown className="size-4" /> Sort <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3 space-y-3">
        <div className="flex items-center gap-1.5 text-[13px] font-medium">
          Sort by
          <Info className="size-3.5 text-muted-foreground" />
        </div>

        <Select value={field} onValueChange={(v) => setField(v as SortField)}>
          <SelectTrigger className="h-8 text-[13px]">
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {SORT_FIELDS.map((f) => (
              <SelectItem key={f.value} value={f.value} className="text-[13px]">{f.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={dir} onValueChange={(v) => setDir(v as SortDir)}>
          <SelectTrigger className="h-8 text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="asc" className="text-[13px]">Ascending</SelectItem>
            <SelectItem value="desc" className="text-[13px]">Descending</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex justify-end pt-1">
          <Button
            size="sm"
            className="h-8"
            disabled={!field}
            onClick={() => { if (field) { onApply(field, dir); setOpen(false); } }}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
