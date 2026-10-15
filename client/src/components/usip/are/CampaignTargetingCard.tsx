/**
 * Targeting on a campaign's Settings tab: who discovery looks for (titles,
 * industries, places, keywords, company size) and who it must never pick
 * (never-target words). Saves through are.campaigns.update; see
 * @shared/campaignTargeting for why only the changed fields are written.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { CheckCircle2, Crosshair, Loader2 } from "lucide-react";
import { TagInput } from "@/components/usip/research/ResearchFields";
import {
  overridesWithTargeting, sameTargeting, targetingFromOverrides, targetingProblem,
  type CampaignTargeting,
} from "@shared/campaignTargeting";

const sizeValue = (v: string): number | null => {
  const n = Number(v);
  return v.trim() === "" || !Number.isFinite(n) || n < 0 ? null : Math.round(n);
};

export function CampaignTargetingCard({ campaign }: { campaign: { id: number; icpOverrides?: unknown; researchSectorId?: number | null } }) {
  const utils = trpc.useUtils();
  const saved = useMemo(() => targetingFromOverrides(campaign.icpOverrides), [campaign.icpOverrides]);
  const [draft, setDraft] = useState<CampaignTargeting | null>(null);
  const t = draft ?? saved;
  const dirty = draft != null && !sameTargeting(draft, saved);
  const problem = targetingProblem(t);
  const patch = (p: Partial<CampaignTargeting>) => setDraft({ ...t, ...p });

  // The linked research sector's never-target words apply too (services/research/neverTarget).
  const sectors = trpc.research.sectors.options.useQuery(undefined, { enabled: campaign.researchSectorId != null, staleTime: 60_000 });
  const sectorName = sectors.data?.find((s) => s.id === campaign.researchSectorId)?.name;

  const save = trpc.are.campaigns.update.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: () => {
      toast.success("Targeting saved");
      setDraft(null);
      utils.are.campaigns.get.invalidate({ id: campaign.id });
    },
  });

  return (
    <Card className="bg-card border">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Crosshair className="size-4 text-rose-500" />
          Targeting
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Who discovery looks for. Changes apply on the next discovery run; prospects already found stay. A field left empty falls back to the workspace's ICP (or research, per the ICP page).
        </p>
        <TagInput label="Job titles" value={t.titles} onChange={(v) => patch({ titles: v })} placeholder="County Administrator, IT Director…" />
        <TagInput label="Industries" value={t.industries} onChange={(v) => patch({ industries: v })} placeholder="Government Administration…" />
        <TagInput label="Places" value={t.places} onChange={(v) => patch({ places: v })} placeholder="Virginia, North Carolina…" />
        <TagInput label="Keywords" value={t.keywords} onChange={(v) => patch({ keywords: v })} placeholder="Board of Supervisors, digital services…" />
        <div className="space-y-2">
          <Label>Company size (employees)</Label>
          <div className="flex items-center gap-2">
            <Input type="number" min={0} className="h-8 w-28 text-sm" placeholder="Any" aria-label="Smallest company size"
              value={t.employeeMin ?? ""} onChange={(e) => patch({ employeeMin: sizeValue(e.target.value) })} />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="number" min={0} className="h-8 w-28 text-sm" placeholder="Any" aria-label="Largest company size"
              value={t.employeeMax ?? ""} onChange={(e) => patch({ employeeMax: sizeValue(e.target.value) })} />
          </div>
        </div>
        <TagInput
          label="Never target"
          hint={`Whole words that reject a person when found in their title, company or industry, at discovery, scoring and screening.${
            campaign.researchSectorId != null ? ` The current never-target words of ${sectorName ? `the ${sectorName} research sector` : "this campaign's research sector"} apply too.` : ""
          }`}
          value={t.exclude}
          onChange={(v) => patch({ exclude: v })}
          placeholder="consultant, retired…"
        />
        {problem && <p className="text-xs text-destructive">{problem}</p>}
        {dirty && (
          <div className="flex items-center gap-3">
            <Button
              className="gap-1.5"
              disabled={save.isPending || !!problem}
              onClick={() => save.mutate({ id: campaign.id, icpOverrides: overridesWithTargeting(campaign.icpOverrides, t) })}
            >
              {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
              Save targeting
            </Button>
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setDraft(null)}>
              Discard
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
