/**
 * "Start a campaign from this persona" (audit 2026-10-20, U18): a DRAFT
 * Revenue Engine campaign that searches with the persona's titles,
 * industries, places, size and keywords, and whose writers use the persona
 * (and its sector's research). Nothing is launched: `launch: false` keeps it
 * a draft for a person to review and start, as "Create campaign" on a sector
 * does (CreateCampaignFromSector).
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { invalidateCampaignReads } from "@/lib/entityCache";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Megaphone } from "lucide-react";
import { icpLabels } from "@shared/icpShape";
import { personaResearchCompleteness } from "@shared/researchShape";

/** What a persona's draft campaign would search for, and why it can't be made when it would search for nothing. */
export function personaCampaignTargeting(p: { targetTitles?: unknown; targetIndustries?: unknown; targetGeographies?: unknown; keywords?: unknown; employeeMin?: number | null; employeeMax?: number | null }) {
  const titles = icpLabels(p.targetTitles, "title");
  const industries = icpLabels(p.targetIndustries, "industry");
  const places = icpLabels(p.targetGeographies, "geography");
  const keywords = Array.isArray(p.keywords) ? (p.keywords as unknown[]).map(String).filter((k) => k.trim()) : [];
  const empty = titles.length === 0 && industries.length === 0 && keywords.length === 0;
  return { titles, industries, places, keywords, empty };
}

const list = (xs: string[], n = 10) => xs.slice(0, n).join(", ") + (xs.length > n ? ` and ${xs.length - n} more` : "");

export function StartCampaignFromPersona({ persona, sectorName }: { persona: any; sectorName?: string | null }) {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName(`${persona.name} campaign`.slice(0, 200));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = personaCampaignTargeting(persona);
  const research = personaResearchCompleteness(persona);
  const utils = trpc.useUtils();
  const create = trpc.are.campaigns.create.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: async (r: any) => {
      toast.success("Draft campaign created. Review it, then start it.");
      setOpen(false);
      await utils.personas.list.invalidate();
      invalidateCampaignReads(utils);
      navigate(r?.id ? `/are/campaigns/${r.id}` : "/are/campaigns");
    },
  });
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} title="Start a draft campaign from this persona">
        <Megaphone className="size-3.5" /> Start campaign
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Start a campaign from {persona.name}</DialogTitle>
            <DialogDescription>
              A draft Revenue Engine campaign that searches with this persona's targeting and writes with what you know about this
              buyer. Nothing starts until you start it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="space-y-2">
              <Label htmlFor="persona-camp-name">Campaign name</Label>
              <Input id="persona-camp-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="rounded-md border p-3 space-y-1.5 text-xs">
              <div><span className="font-medium">Titles:</span> {t.titles.length ? list(t.titles) : "none"}</div>
              <div><span className="font-medium">Industries:</span> {t.industries.length ? list(t.industries) : "none"}</div>
              {t.places.length > 0 && <div><span className="font-medium">Places:</span> {list(t.places)}</div>}
              {(persona.employeeMin != null || persona.employeeMax != null) && (
                <div><span className="font-medium">Size:</span> {persona.employeeMin ?? 1}–{persona.employeeMax ?? "any"} employees</div>
              )}
              {t.keywords.length > 0 && <div><span className="font-medium">Keywords:</span> {list(t.keywords)}</div>}
              {sectorName && <div><span className="font-medium">Research sector:</span> {sectorName}</div>}
            </div>
            {t.empty && <p className="text-xs text-destructive">This persona has no titles, industries or keywords, so the campaign would search for nobody. Add some first.</p>}
            {research.level !== "complete" && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                {research.level === "none"
                  ? "This persona has no research yet, so the writers will know nothing about this buyer beyond the job titles."
                  : `This persona's research is missing ${research.missing.join(", ")}; the writers use what is there.`}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={create.isPending || name.trim().length < 2 || t.empty}
              onClick={() => create.mutate({ name: name.trim(), personaId: persona.id, launch: false } as any)}
            >
              Create draft campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
