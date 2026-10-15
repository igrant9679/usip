/**
 * Find Prospects, started from a research sector (Research phase 4). Picking a
 * sector fills the search with its first job title, industry, place and
 * keywords; each of its other titles is a chip that swaps the title in. A
 * single search takes one title, so a whole sector — every title, its
 * never-target words — is a campaign (Create campaign on the sector page).
 */
import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Telescope } from "lucide-react";

export type SectorSearchFields = { jobTitle: string; industry: string; location: string; keywords: string[] };

const NONE = "none";

export function StartFromSector({ onApply }: { onApply: (f: SectorSearchFields) => void }) {
  const options = trpc.research.sectors.options.useQuery();
  const [sectorId, setSectorId] = useState<string>(NONE);
  const sector = trpc.research.sectors.get.useQuery({ id: Number(sectorId) }, { enabled: sectorId !== NONE });
  const [title, setTitle] = useState<string>("");
  const t = sector.data?.sector.content.targeting;

  const apply = (jobTitle: string) => {
    if (!t) return;
    setTitle(jobTitle);
    onApply({ jobTitle, industry: t.industries[0] ?? "", location: t.geographies[0] ?? "", keywords: t.keywords.slice(0, 8) });
  };

  if (!options.data?.length) return null;
  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Telescope className="size-4 text-muted-foreground" />
        <Label className="text-xs">Start from a research sector</Label>
        <Select
          value={sectorId}
          onValueChange={(v) => { setSectorId(v); setTitle(""); }}
        >
          <SelectTrigger className="h-8 w-auto min-w-[14rem] text-xs"><SelectValue placeholder="Choose a sector" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Choose a sector</SelectItem>
            {options.data.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.marketName} › {s.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {t && (
        <div className="space-y-1.5 text-xs">
          {t.titles.length === 0 ? (
            <p className="text-muted-foreground">This sector has no job titles yet. Add them on its page under Targeting.</p>
          ) : (
            <>
              <p className="text-muted-foreground">Pick a title to search with (the sector's industry, place and keywords come along):</p>
              <div className="flex flex-wrap gap-1">
                {t.titles.slice(0, 20).map((x) => (
                  <button key={x} type="button" onClick={() => apply(x)}>
                    <Badge variant={title === x ? "default" : "outline"} className="text-[10px] cursor-pointer">{x}</Badge>
                  </button>
                ))}
              </div>
            </>
          )}
          {t.exclude.length > 0 && (
            <p className="text-muted-foreground">
              Never-target words ({t.exclude.slice(0, 6).join(", ")}) are applied by campaigns, not here: for every title at once with
              them filtered out, <Link href={`/research/sectors/${sectorId}`} className="underline">create a campaign from the sector</Link>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
