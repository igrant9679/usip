/**
 * Which research a campaign's AI writers use (Research phase 3): the sector
 * and the persona. Without a choice the writers match each prospect's title to
 * a persona or sector; naming them here makes every sequence use that research.
 * Only Researched or Verified sectors are used by the writers.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { neverTargetFromOverrides } from "@shared/researchTargeting";

const NONE = "none";

export function CampaignResearchCard({ campaignId, campaign }: { campaignId: number; campaign: any }) {
  const utils = trpc.useUtils();
  const sectors = trpc.research.sectors.options.useQuery();
  const personas = trpc.personas.list.useQuery();
  const [sector, setSector] = useState<string>(NONE);
  const [persona, setPersona] = useState<string>(NONE);
  useEffect(() => {
    setSector(campaign?.researchSectorId != null ? String(campaign.researchSectorId) : NONE);
    setPersona(campaign?.personaId != null ? String(campaign.personaId) : NONE);
  }, [campaign?.researchSectorId, campaign?.personaId]);
  const update = trpc.are.campaigns.update.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: async () => {
      toast.success("Saved — new sequences use this research; regenerate existing ones to apply it");
      await utils.are.campaigns.get.invalidate({ id: campaignId });
    },
  });

  const savedSector = campaign?.researchSectorId != null ? String(campaign.researchSectorId) : NONE;
  const savedPersona = campaign?.personaId != null ? String(campaign.personaId) : NONE;
  const dirty = sector !== savedSector || persona !== savedPersona;
  const chosen = (sectors.data ?? []).find((s) => String(s.id) === sector);
  const draftChosen = chosen && chosen.status === "draft";
  const neverTarget = neverTargetFromOverrides(campaign?.icpOverrides);

  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted-foreground leading-relaxed">
        The AI writes each email with your research on the prospect's market: what to never say, the buyer's pains and
        words, and what to lead with. Name the sector and persona here, or leave them unset and each prospect is matched
        by job title. <Link href="/research" className="underline">Research</Link>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Sector</Label>
          <Select value={sector} onValueChange={setSector}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Match by job title" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Match by job title</SelectItem>
              {(sectors.data ?? []).map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>{s.marketName} › {s.name}{s.status === "draft" ? " (draft)" : ""}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Persona</Label>
          <Select value={persona} onValueChange={setPersona}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Match by job title" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Match by job title</SelectItem>
              {(personas.data ?? []).map((p: any) => (
                <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {neverTarget.length > 0 && (
        <div className="space-y-1">
          <div className="font-medium">Never target</div>
          <div className="flex flex-wrap gap-1">
            {neverTarget.map((w) => <span key={w} className="rounded border px-1.5 py-0.5 text-[10px]">{w}</span>)}
          </div>
          <p className="text-muted-foreground">
            People whose title, company name or industry contains one of these are not queued by discovery, score 0, and are
            rejected at screening with the word named on the Rejections tab. The sector's own words apply too while it is
            Researched or Verified.
          </p>
        </div>
      )}
      {draftChosen && (
        <p className="text-amber-700 dark:text-amber-300">This sector is still a Draft, so the writers will not use it until you mark it Researched or Verified.</p>
      )}
      <Button
        size="sm"
        disabled={!dirty || update.isPending}
        onClick={() => update.mutate({
          id: campaignId,
          researchSectorId: sector === NONE ? null : Number(sector),
          personaId: persona === NONE ? null : Number(persona),
        })}
      >
        Save
      </Button>
    </div>
  );
}
