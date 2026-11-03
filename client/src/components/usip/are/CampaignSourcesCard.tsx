import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ARE_SOURCES, DISCOVERY_OFF_NOTE, campaignSources, toggledSources } from "@shared/areSources";
import { Globe, Zap } from "lucide-react";

/**
 * Where discovery finds new prospects for a campaign. The boxes show what the
 * engine will run: `campaignSources` is the reading it uses, so a campaign with
 * discovery off shows none ticked, and a box changes that one source only.
 */
export function CampaignSourcesCard({ stored, draft, onChange }: {
  stored: unknown;
  draft: string[] | null;
  onChange: (next: string[]) => void;
}) {
  const active: readonly string[] = draft ?? campaignSources(stored);
  return (
    <Card className="bg-card border">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Globe className="size-4 text-blue-500" />
          Prospect Sources
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Where discovery finds new prospects for this campaign. Changes apply on the next discovery run — discovery fires when the send queue drains below the daily cap.
        </p>
        <div className="space-y-2">
          {ARE_SOURCES.map((s) => (
            <label key={s.id} className="flex items-start gap-2.5 cursor-pointer">
              <Checkbox
                className="mt-0.5"
                checked={active.includes(s.id)}
                onCheckedChange={() => onChange(toggledSources(active, s.id))}
              />
              <span className="space-y-0.5">
                <span className="block text-xs font-medium text-foreground">{s.label}</span>
                <span className="block text-[11px] text-muted-foreground leading-snug">{s.description}</span>
              </span>
            </label>
          ))}
        </div>
        {active.length === 0 && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 text-xs">
            <Zap className="size-3.5 text-amber-500 mt-0.5 shrink-0" />
            <span className="text-amber-700 dark:text-amber-300">{DISCOVERY_OFF_NOTE}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
