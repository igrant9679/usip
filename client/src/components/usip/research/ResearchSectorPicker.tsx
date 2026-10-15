/**
 * "Write for": the research sector a template or snippet is written for.
 * Templates go to many recipients, so no one prospect's research applies;
 * the writer picks the sector and the AI gets its research (pains, words,
 * what to lead with, what never to say). Only Researched and Verified sectors
 * are offered, since the writers never use a draft. Renders nothing in a
 * workspace without one, so those writers look exactly as before.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Telescope } from "lucide-react";

export function ResearchSectorPicker({ value, onChange, compact = false }: {
  value: number | undefined;
  onChange: (sectorId: number | undefined) => void;
  /** One small select for a toolbar, no label or hint. */
  compact?: boolean;
}) {
  const { data = [] } = trpc.research.sectors.options.useQuery(undefined, { staleTime: 60_000 });
  const usable = data.filter((s) => s.status === "researched" || s.status === "verified");
  if (!usable.length) return null;
  // A remembered sector that was deleted or set back to Draft reads as none.
  const current = value != null && usable.some((s) => s.id === value) ? String(value) : "none";
  const select = (
    <Select value={current} onValueChange={(v) => onChange(v === "none" ? undefined : Number(v))}>
      <SelectTrigger className={compact ? "h-8 w-[200px] text-xs shrink-0" : "h-8 text-sm"} title="The research sector the AI writes for">
        {compact && <Telescope className="size-3.5 mr-1 shrink-0 text-muted-foreground" />}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">{compact ? "No research sector" : "None"}</SelectItem>
        {usable.map((s) => (
          <SelectItem key={s.id} value={String(s.id)}>{s.marketName} › {s.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  if (compact) return select;
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">Write for</Label>
      {select}
      <p className="text-xs text-muted-foreground">The AI uses this sector's research: its buyers' pains, their words, what to lead with and what never to say.</p>
    </div>
  );
}

const storageKey = (key: string) => `usip:researchSector:${key}`;

/** Remember a choice per template (this browser only; a convenience, never required). */
export function rememberSector(key: string, sectorId: number | undefined) {
  try {
    if (sectorId) window.localStorage.setItem(storageKey(key), String(sectorId));
    else window.localStorage.removeItem(storageKey(key));
  } catch {
    /* storage can be unavailable; the choice just isn't remembered */
  }
}

export function useRememberedSector(key: string): [number | undefined, (v: number | undefined) => void] {
  const [value, setValue] = useState<number | undefined>(() => {
    try {
      const n = Number(window.localStorage.getItem(storageKey(key)));
      return Number.isInteger(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  });
  return [value, (v) => { setValue(v); rememberSector(key, v); }];
}
