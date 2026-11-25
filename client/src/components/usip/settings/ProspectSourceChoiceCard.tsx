/**
 * ProspectSourceChoiceCard — the one prospect source a workspace on a
 * membership plan finds people through (owner 2026-11-25: "only allow
 * workspaces to select/use 1 prospect data source at a time, but they can
 * change which one at any time").
 *
 * Every choice reads "Source N — description", never the vendor's name, with
 * whether it still has room this month (the plan's month, today's limit, and
 * the shared pool's ceiling). Admins change it; it saves at once and applies
 * to campaign discovery, Find prospects, Source search and the Search box.
 * Email lookups during enrichment are not affected. A workspace with no plan
 * sees nothing here: it keeps the Primary prospect source card and its
 * waterfall.
 */
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Check, Loader2, Radar } from "lucide-react";
import { isAdminRole } from "@shared/roleRank";

export function ProspectSourceChoiceCard() {
  const utils = trpc.useUtils();
  const me = trpc.profile.getMe.useQuery();
  const isAdmin = isAdminRole(me.data?.role);
  const q = trpc.prospectSources.choices.useQuery(undefined, { retry: false });
  const set = trpc.prospectSources.setChoice.useMutation({
    onSuccess: () => {
      void utils.prospectSources.choices.invalidate();
      void utils.spend.budgets.invalidate();
      toast.success("Prospect source changed. Searches use it from now on.");
    },
    onError: (e) => toast.error(e.message || "The prospect source could not be changed."),
  });
  const d = q.data;
  if (!d || !d.onPlan) return null;

  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm space-y-3" data-prospect-source-choice>
      <div className="flex items-start gap-2.5">
        <Radar className="size-4 mt-0.5 shrink-0 text-violet-500" />
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-semibold">Prospect source</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            On your plan, new people are found through one source at a time: in Revenue Engine campaigns, Find prospects, Source search and the Search box. Choose any source below; you can change it at any time. Email lookups for people you already have are not affected.
          </p>
        </div>
      </div>
      {d.choices.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">No prospect source is available to this workspace yet.</p>
      ) : (
        <div role="radiogroup" aria-label="Prospect source" className="space-y-1.5">
          {d.choices.map((c) => {
            const active = d.current === c.slug;
            return (
              <button
                key={c.slug}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={!isAdmin || set.isPending}
                onClick={() => { if (!active) set.mutate({ slug: c.slug as never }); }}
                className={cn(
                  "w-full text-left rounded-lg border px-3 py-2 flex items-start gap-2.5 transition-colors",
                  active ? "border-violet-400 bg-violet-50/60 dark:bg-violet-950/20" : "border-border/70 hover:bg-muted/40",
                  !isAdmin && "cursor-default",
                )}
              >
                <span className={cn("mt-0.5 size-4 rounded-full border flex items-center justify-center shrink-0", active ? "border-violet-500 bg-violet-500 text-white" : "border-muted-foreground/40")}>
                  {active && <Check className="size-3" />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-medium">
                    {c.label} — {c.description}
                    {c.keyFrom === "own" && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">(your own key)</span>}
                    {c.isDefault && !d.chosen && active && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">(default)</span>}
                  </span>
                  <span className={cn("block text-[12px]", c.hasRoom ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
                    {c.hasRoom ? (c.keyFrom === "own" ? "Your own key: not counted" : "Has room this month") : `No room: ${c.roomNote}`}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {set.isPending && <div className="text-[12px] text-muted-foreground flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" /> Saving…</div>}
      {!isAdmin && <p className="text-[12px] text-muted-foreground">Only workspace admins can change the prospect source.</p>}
      {d.chosen && isAdmin && (
        <button type="button" className="text-[12px] text-muted-foreground underline" onClick={() => set.mutate({ slug: null })} disabled={set.isPending}>
          Use the default (the source with the most room)
        </button>
      )}
    </section>
  );
}
