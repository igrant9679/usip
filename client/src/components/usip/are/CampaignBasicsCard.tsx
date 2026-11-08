/**
 * A campaign's basics on its Settings tab (audit 2026-10-20, U11): name,
 * daily cap, target, channels, goal and sequence template, all set once in
 * the create wizard until now. The draft is the page's, so the tab's one Save
 * writes it with everything else; the rules for the cap and the channels are
 * @shared/areCampaignBasics, the same ones the server applies.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { SlidersHorizontal } from "lucide-react";
import { ARE_GOALS, CAP_MAX, CAP_MIN, TARGET_MAX, TARGET_MIN, basicsProblem, channelsOf, sendIncreaseRefusal, type AreGoal, type BasicsDraft } from "@shared/areCampaignBasics";
import { ARE_SEQUENCE_TEMPLATES } from "@shared/areSequenceTemplates";

export interface CapContext {
  workspaceCap: number;
  workspaceSentToday: number;
  mailboxes: number;
  mailboxDailyTotal: number;
  outboundPaused: boolean;
}

const num = (v: string): number => (v.trim() === "" ? NaN : Math.round(Number(v)));

export function CampaignBasicsCard({ campaign, draft, onChange, cap }: {
  campaign: { name: string; dailySendCap: number; targetProspectCount: number; channelsEnabled: unknown; goalType: string; sequenceTemplate: string };
  draft: BasicsDraft;
  onChange: (d: BasicsDraft) => void;
  cap?: CapContext | null;
}) {
  const name = draft.name ?? campaign.name;
  const dailySendCap = draft.dailySendCap ?? campaign.dailySendCap;
  const target = draft.targetProspectCount ?? campaign.targetProspectCount;
  const channels = draft.channelsEnabled ?? channelsOf(campaign.channelsEnabled);
  const goal = draft.goalType ?? (campaign.goalType as AreGoal);
  const template = draft.sequenceTemplate ?? campaign.sequenceTemplate;
  const patch = (p: BasicsDraft) => onChange({ ...draft, ...p });
  const problem = basicsProblem(draft);
  // The server's own rule, said before Save rather than after.
  const refusal = cap
    ? sendIncreaseRefusal(campaign, { dailySendCap: draft.dailySendCap, channelsEnabled: draft.channelsEnabled }, { outboundPaused: cap.outboundPaused, workspaceCap: cap.workspaceCap })
    : null;
  const knownTemplate = ARE_SEQUENCE_TEMPLATES.some((t) => t.value === template);

  return (
    <Card className="bg-card border">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <SlidersHorizontal className="size-4 text-emerald-500" />
          Basics
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="campaign-name" className="text-xs">Name</Label>
          <Input id="campaign-name" value={name} maxLength={200} onChange={(e) => patch({ name: e.target.value })} className="h-8 text-sm" />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="campaign-cap" className="text-xs">Daily send cap</Label>
            <Input id="campaign-cap" type="number" min={CAP_MIN} max={CAP_MAX} value={Number.isNaN(dailySendCap) ? "" : dailySendCap}
              onChange={(e) => patch({ dailySendCap: num(e.target.value) })} className="h-8 text-sm tabular-nums" />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Steps this campaign sends a day, email and LinkedIn together.
              {cap ? ` The engine also stops at the workspace's cap of ${cap.workspaceCap} a day across all campaigns (${cap.workspaceSentToday} sent today)` : ""}
              {cap && cap.mailboxes > 0 ? `, and at each mailbox's own limit: ${cap.mailboxes} mailbox${cap.mailboxes === 1 ? "" : "es"}, ${cap.mailboxDailyTotal.toLocaleString()} a day between them.` : cap ? "." : ""}
            </p>
            {cap && cap.mailboxes > 0 && dailySendCap > cap.mailboxDailyTotal && (
              <p className="text-[11px] text-amber-700 dark:text-amber-300">The mailboxes can send {cap.mailboxDailyTotal.toLocaleString()} a day in all, so this cap can't be reached by email.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="campaign-target" className="text-xs">Target prospects</Label>
            <Input id="campaign-target" type="number" min={TARGET_MIN} max={TARGET_MAX} value={Number.isNaN(target) ? "" : target}
              onChange={(e) => patch({ targetProspectCount: num(e.target.value) })} className="h-8 text-sm tabular-nums" />
            <p className="text-[11px] text-muted-foreground leading-relaxed">Discovery keeps looking until this many are in the campaign (rejected ones don't count). Raising it starts discovery again.</p>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-medium">Channels</div>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={channels.email} onCheckedChange={(v) => patch({ channelsEnabled: { ...channels, email: v === true } })} aria-label="Email" />
              Email
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={channels.linkedin} onCheckedChange={(v) => patch({ channelsEnabled: { ...channels, linkedin: v === true } })} aria-label="LinkedIn" />
              LinkedIn (from the campaign owner's account)
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground">New sequences use these channels; sequences already written keep theirs until regenerated.</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="campaign-goal" className="text-xs">Goal</Label>
            <select id="campaign-goal" className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={goal}
              onChange={(e) => patch({ goalType: e.target.value as AreGoal })}>
              {ARE_GOALS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="campaign-template" className="text-xs">Sequence template</Label>
            <select id="campaign-template" className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={template}
              onChange={(e) => patch({ sequenceTemplate: e.target.value })}>
              {!knownTemplate && <option value={template}>{template}</option>}
              {ARE_SEQUENCE_TEMPLATES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <p className="text-[11px] text-muted-foreground">
              {ARE_SEQUENCE_TEMPLATES.find((t) => t.value === template)?.description ?? "A template this build does not list; it keeps its step count."} Changing it writes a new campaign template for sequences written after you save.
            </p>
          </div>
        </div>

        {(problem || refusal) && <p className="text-xs text-destructive">{problem ?? refusal}</p>}
      </CardContent>
    </Card>
  );
}
