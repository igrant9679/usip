/**
 * RoutingSuggestions — the review queue for the best-fit campaign router in
 * approval mode (phase 3). Each card is one person the engine wants to put
 * in a campaign, with the fit, the reasoning, and the runners-up. Accept
 * enrolls through the same write path as "Add to…"; Dismiss records the
 * decision so the sweep does not re-suggest them.
 */
import { Bot, Check, Loader2, X } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

export function RoutingSuggestions() {
  const utils = trpc.useUtils();
  const q = trpc.are.campaigns.listRoutingSuggestions.useQuery({ limit: 50 }, { retry: false });
  const decide = trpc.are.campaigns.decideRoutingSuggestion.useMutation({
    onSuccess: (r, vars) => {
      if (vars.decision === "accept") toast.success(r.added > 0 ? "Added to the campaign — the engine will enrich and write their emails" : "Nothing added (already in outreach)");
      else toast.info("Dismissed");
      utils.are.campaigns.listRoutingSuggestions.invalidate();
      utils.attention.summary.invalidate();
      utils.are.prospects.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const rows = (q.data ?? []) as any[];
  if (q.isLoading || rows.length === 0) return null;

  return (
    <section className="lg:col-span-5" data-tour-id="are-routing-suggestions">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Best-fit picks waiting for your OK</h2>
        <span className="text-[11px] text-muted-foreground">{rows.length} suggested · <Link href="/v2/workflows" className="hover:underline">routing dial</Link></span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {rows.map((s) => (
          <div key={s.id} className="rounded-lg border bg-card p-3 flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Bot className="size-4 text-violet-600 shrink-0" />
              <span className="text-[13px] font-medium truncate flex-1">{`${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() || `#${s.prospectId}`}</span>
              <span className="text-[10px] font-semibold text-violet-700 dark:text-violet-300 tabular-nums">{s.fit}/100</span>
            </div>
            <div className="text-[11.5px] text-muted-foreground truncate">{[s.title, s.company].filter(Boolean).join(" · ")}</div>
            <div className="text-[12px]">→ <Link href={`/are/campaigns/${s.campaignId}`} className="font-medium hover:underline">{s.campaignName}</Link></div>
            {s.reasoning && <div className="text-[11.5px] text-muted-foreground">{s.reasoning}</div>}
            {Array.isArray(s.alternatives) && s.alternatives.length > 1 && (
              <div className="text-[10.5px] text-muted-foreground">Runners-up: {s.alternatives.filter((a: any) => a.campaignId !== s.campaignId).slice(0, 2).map((a: any) => `${a.fit}/100`).join(", ")}</div>
            )}
            <div className="flex gap-2 mt-1">
              <Button size="sm" className="h-7 gap-1 flex-1" disabled={decide.isPending} onClick={() => decide.mutate({ id: s.id, decision: "accept" })}>
                {decide.isPending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} Add to campaign
              </Button>
              <Button size="sm" variant="outline" className="h-7 gap-1" disabled={decide.isPending} onClick={() => decide.mutate({ id: s.id, decision: "dismiss" })}>
                <X className="size-3" /> Dismiss
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
