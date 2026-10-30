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

/** Mirrors `TerritoryMode` in server/areEngine.ts; a guard test pins the three
 *  values against it so the two cannot drift. */
type TerritoryMode = "off" | "flag" | "reject";

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

  /**
   * F17's territory check. It lives here because it is a targeting rule, and
   * it saves on change rather than joining the Save targeting button: it is
   * one value with no draft state, and making an operator press Save to turn
   * off an auto-reject they have just seen misfire is the wrong order.
   *
   * `overridesWithTargeting` spreads the existing overrides, so this key and
   * the targeting fields do not clobber each other.
   */
  const territoryMode: TerritoryMode =
    ((campaign.icpOverrides as { territoryCheck?: unknown } | null | undefined)?.territoryCheck === "off" ? "off"
      : (campaign.icpOverrides as { territoryCheck?: unknown } | null | undefined)?.territoryCheck === "reject" ? "reject"
      : "flag");
  const setTerritoryMode = (mode: TerritoryMode) => {
    const base = (campaign.icpOverrides ?? {}) as Record<string, unknown>;
    save.mutate({ id: campaign.id, icpOverrides: { ...base, territoryCheck: mode } });
  };

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
        {/* ── F17: territory check ── */}
        <div className="rounded-lg border border-border/60 p-3 space-y-1.5">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <Label htmlFor="territory-check" className="text-xs font-medium">Territory check</Label>
            <select
              id="territory-check"
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={territoryMode}
              disabled={save.isPending}
              onChange={(e) => setTerritoryMode(e.target.value as TerritoryMode)}
            >
              <option value="off">Off</option>
              <option value="flag">Flag only</option>
              <option value="reject">Flag and auto-reject</option>
            </select>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {territoryMode === "off"
              ? "No place verdict is shown, and people outside these places are discovered and paid for like anyone else."
              : territoryMode === "reject"
                ? "People whose country or state these places exclude are rejected as they are found — visible in the Rejections tab and restorable. People whose place cannot be read are always kept."
                : "Every prospect shows In target area, Outside target area or Place unknown. Nothing is rejected."}
          </p>
          {territoryMode !== "off" && (
            <p className="text-[11px] text-muted-foreground/80">
              Either way, a source that charges per person is screened on its free preview first, so nobody outside
              these places is paid for.
            </p>
          )}
        </div>
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
