/**
 * "Create campaign from sector" (Research phase 4): a DRAFT Revenue Engine
 * campaign that searches for the sector's (or a persona's) titles, industries,
 * places, keywords and company size, rejects its never-target words, and has
 * its AI writers use this sector's research. Nothing is launched: the campaign
 * opens as a draft for a person to review and start.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Megaphone } from "lucide-react";
import type { SectorContent } from "@shared/researchShape";
import { overridesFromSector } from "@shared/researchTargeting";
import { icpLabels } from "@shared/icpShape";

const NONE = "none";

export function CreateCampaignFromSector({ sectorId, sector, personas }: { sectorId: number; sector: SectorContent; personas: any[] }) {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [persona, setPersona] = useState<string>(NONE);
  useEffect(() => {
    if (!open) return;
    setName(`${sector.shortName || sector.name} (Research)`.slice(0, 200));
    setPersona(personas.length === 1 ? String(personas[0].id) : NONE);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = personas.find((p) => String(p.id) === persona);
  const personaTitles = chosen ? icpLabels(chosen.targetTitles, "title") : [];
  const overrides = overridesFromSector(sector.targeting, personaTitles);
  const titles = overrides.targetTitles as string[];
  const exclude = overrides.exclude as string[];

  const create = trpc.are.campaigns.create.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: (r: any) => {
      toast.success("Draft campaign created. Review it, then start it.");
      setOpen(false);
      const id = r?.id ?? r?.campaignId;
      navigate(id ? `/are/campaigns/${id}` : "/are/campaigns");
    },
  });

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Megaphone className="size-4 mr-1" /> Create campaign
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create a campaign from {sector.name}</DialogTitle>
            <DialogDescription>
              A draft Revenue Engine campaign that searches with this sector's targeting, rejects its never-target words, and
              writes with this research. Nothing starts until you start it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="space-y-2">
              <Label htmlFor="camp-name">Campaign name</Label>
              <Input id="camp-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </div>
            {personas.length > 0 && (
              <div className="space-y-2">
                <Label>Persona</Label>
                <Select value={persona} onValueChange={setPersona}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>The whole sector</SelectItem>
                    {personas.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">A persona narrows the search to its own job titles and gives the writers its angle.</p>
              </div>
            )}
            <div className="rounded-md border p-3 space-y-2 text-xs">
              <div><span className="font-medium">Titles:</span> {titles.length ? titles.slice(0, 12).join(", ") + (titles.length > 12 ? ` and ${titles.length - 12} more` : "") : <span className="text-destructive">none — add job titles to the sector or persona first</span>}</div>
              {sector.targeting.industries.length > 0 && <div><span className="font-medium">Industries:</span> {sector.targeting.industries.join(", ")}</div>}
              {sector.targeting.geographies.length > 0 && <div><span className="font-medium">Places:</span> {sector.targeting.geographies.join(", ")}</div>}
              {(sector.targeting.employeeMin != null || sector.targeting.employeeMax != null) && (
                <div><span className="font-medium">Size:</span> {sector.targeting.employeeMin ?? 1}–{sector.targeting.employeeMax ?? "any"} employees</div>
              )}
              {exclude.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="font-medium">Never target:</span>
                  {exclude.map((w) => <Badge key={w} variant="outline" className="text-[10px]">{w}</Badge>)}
                </div>
              )}
            </div>
            {sector.status === "draft" && (
              <p className="text-xs text-amber-700 dark:text-amber-300">This sector is a Draft: the campaign uses its targeting now, but its writers use the research only once you mark the sector Researched or Verified.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={create.isPending || !name.trim() || titles.length === 0}
              onClick={() => create.mutate({
                name: name.trim(),
                ...(chosen ? { personaId: chosen.id } : {}),
                researchSectorId: sectorId,
                icpOverrides: overrides,
                launch: false,
              } as any)}
            >
              Create draft campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
