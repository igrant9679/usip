/**
 * CampaignProposals — the review queue for NEW campaigns the engine proposes
 * (owner ask 2026-09-04: "suggest new Sequences to be created based on
 * analysis of the People"). Each card is one audience no active campaign
 * targets: who they are, how many, the targeting a campaign for them would
 * carry, and the copy mode. "Create campaign & add" creates it (active,
 * batch approval — nothing sends until the first batch is approved) and
 * pushes the people in through the same write path as "Add to…"; Dismiss
 * records the decision so those people are not re-proposed for a month.
 *
 * Runs on the Campaign Routing dial (Autonomy Center): Approve fills this
 * queue hourly; Auto creates the campaigns itself. "Analyse now" runs the
 * analysis on demand and always leaves the result here for a human.
 */
import { Bot, Check, Loader2, Sparkles, X } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type Targeting = { targetTitles?: string[]; targetIndustries?: string[]; targetGeographies?: string[]; keywords?: string[] };

export function CampaignProposals() {
  const utils = trpc.useUtils();
  const q = trpc.are.campaigns.listProposals.useQuery({ limit: 10 }, { retry: false });
  const routing = trpc.are.campaigns.getRoutingSettings.useQuery(undefined, { retry: false });
  const refresh = () => {
    utils.are.campaigns.listProposals.invalidate();
    utils.are.campaigns.list.invalidate();
    utils.attention.summary.invalidate();
  };
  const decide = trpc.are.campaigns.decideProposal.useMutation({
    onSuccess: (r, vars) => {
      if (vars.decision === "accept") {
        toast.success(r.campaignId
          ? `Campaign created — ${r.added} added${r.skipped ? `, ${r.skipped} skipped (already in outreach)` : ""}. The engine will enrich and write their emails; the first batch waits for your approval.`
          : "Nothing created");
      } else toast.info("Dismissed — these people won't be re-proposed for 30 days");
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const generate = trpc.are.campaigns.generateProposals.useMutation({
    onSuccess: (r) => {
      if (r.created > 0) toast.success(`${r.created} campaign${r.created === 1 ? "" : "s"} proposed from ${r.unplaced} people no campaign fits`);
      else if (r.skippedPending > 0) toast.info("Decide the pending proposals first — the queue holds three at a time");
      else toast.info(r.unplaced === 0 ? "Everyone with an email already fits a campaign or is in one" : `${r.unplaced} people fit no campaign, but no group is big enough (8+) to be one yet`);
      refresh();
    },
    onError: (e) => toast.error(e.message.includes("FORBIDDEN") ? "Only admins can run the analysis" : e.message),
  });
  const rows = (q.data ?? []) as any[];
  const mode = routing.data?.mode ?? "off";
  const pending = decide.isPending || generate.isPending;

  return (
    <section className="lg:col-span-5" data-tour-id="are-campaign-proposals">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-violet-500" /> Campaigns the engine proposes
          {rows.length > 0 && <span className="ml-1 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-300">{rows.length}</span>}
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {mode === "off" ? <>Campaign Routing is off — <Link href="/v2/workflows" className="underline">turn it on</Link> to analyse hourly</>
              : mode === "auto" ? "Auto: new campaigns are created for you" : "Approve: proposals wait here for you"}
          </span>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" disabled={pending} onClick={() => generate.mutate()}>
            {generate.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Bot className="size-3.5" />} Analyse People now
          </Button>
        </div>
      </div>

      {q.isLoading ? null : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground rounded-lg border border-dashed px-3 py-3">
          No proposals right now. The engine groups people no active campaign fits by industry, job family and country, and proposes a campaign for each group of eight or more.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((p) => {
            const t = (p.targeting ?? {}) as Targeting;
            const chips = [
              ...(t.targetTitles ?? []).slice(0, 4).map((x) => ({ k: `t${x}`, label: x, tone: "border-violet-300/60 text-violet-700 dark:text-violet-300" })),
              ...(t.targetIndustries ?? []).slice(0, 2).map((x) => ({ k: `i${x}`, label: x, tone: "border-sky-300/60 text-sky-700 dark:text-sky-300" })),
              ...(t.targetGeographies ?? []).slice(0, 2).map((x) => ({ k: `g${x}`, label: x, tone: "border-emerald-300/60 text-emerald-700 dark:text-emerald-300" })),
            ];
            return (
              <div key={p.id} className="rounded-lg border bg-card p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold leading-snug">{p.name}</div>
                    <div className="text-[11.5px] text-muted-foreground">
                      {p.size} {p.size === 1 ? "person" : "people"} no campaign fits · {p.copyMode === "fixed" ? "fixed copy" : "AI copy per person"}
                      {p.source === "manual" ? " · from your analysis" : ""}
                    </div>
                  </div>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 shrink-0">Proposed</Badge>
                </div>
                {p.description && <p className="text-xs leading-relaxed">{p.description}</p>}
                {p.valueProposition && <p className="text-xs leading-relaxed text-muted-foreground"><span className="font-medium text-foreground/80">Opens with:</span> “{p.valueProposition}”</p>}
                {chips.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {chips.map((c) => <span key={c.k} className={`rounded-full border px-1.5 py-0.5 text-[10px] ${c.tone}`}>{c.label}</span>)}
                  </div>
                )}
                {p.reasoning && <p className="text-[11px] text-muted-foreground italic">{p.reasoning}</p>}
                <div className="flex items-center gap-2 pt-1">
                  <Button size="sm" className="h-7 text-xs gap-1" disabled={pending} onClick={() => decide.mutate({ id: p.id, decision: "accept" })}>
                    {decide.isPending && decide.variables?.id === p.id && decide.variables?.decision === "accept" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                    Create campaign & add {p.size}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" disabled={pending} onClick={() => decide.mutate({ id: p.id, decision: "dismiss" })}>
                    <X className="size-3.5" /> Dismiss
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
