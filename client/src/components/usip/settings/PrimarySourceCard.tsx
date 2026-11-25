/**
 * PrimarySourceCard — which prospect source this workspace tries FIRST
 * (owner, 2026-11-24: "each workspace to pick which leads/prospect source to
 * use as a primary source; the unselected will be fallback. They should be
 * able to do this in settings").
 *
 * It is not a second setting. The workspace already has one checking order
 * (Revenue Engine → Settings, "Prospect Sources & Checking Order"), and the
 * primary is whichever source that order checks first. Picking one here moves
 * it to the front of that same order; the others keep their places and are
 * the fallbacks. So this card and that list can never disagree.
 *
 * What it does not do: switch a source on, connect a key, or make a source
 * that bills its previews (LeadOcean) run where nobody ticked it.
 */
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Link } from "wouter";
import { Check, ListOrdered, Loader2 } from "lucide-react";
import { isAdminRole } from "@shared/roleRank";
import { fallbackSourcesOf, primarySourceOf, type PrimarySourceId } from "@shared/areSources";
import { useSourceNames } from "@/lib/sourceNames";


/** One line on what choosing this source means, beyond its name. */
const NOTE: Record<PrimarySourceId, string> = {
  quickenrich: "Free to search. An email costs one credit when it is found during enrichment.",
  warmysender: "Free to search, with addresses hidden. One lead unit per new person saved.",
  apollo: "Free to search: people and company details, no emails (those are found during enrichment).",
  leadocean: "Bills every search row, so it still runs only where a campaign or search ticks it. As primary it goes first there.",
  linkedin: "Searches through the LinkedIn accounts connected in this workspace, within their daily limits.",
};

export function PrimarySourceCard() {
  const names = useSourceNames();
  const labelOf = (id: string) => names.label(id);
  const utils = trpc.useUtils();
  const me = trpc.profile.getMe.useQuery();
  const isAdmin = isAdminRole(me.data?.role);
  const settings = trpc.settings.getAreSettings.useQuery();
  const describe = trpc.prospectSources.describe.useQuery(undefined);
  const onPlan = trpc.prospectSources.choices.useQuery(undefined, { retry: false }).data?.onPlan === true;
  const setPrimary = trpc.settings.setPrimarySource.useMutation({
    onSuccess: (r) => {
      void utils.settings.getAreSettings.invalidate();
      void utils.prospectSources.describe.invalidate();
      toast.success(r.changed ? `${labelOf(r.primary)} is now the primary source. The others are fallbacks.` : `${labelOf(r.primary)} is already the primary source.`);
    },
    onError: (e) => toast.error(e.message || "The primary source could not be changed."),
  });

  const order = settings.data?.areSourceOrder ?? null;
  const mask = (settings.data?.areScraperSources ?? {}) as Record<string, unknown>;
  const primary = primarySourceOf(order);
  const fallbacks = fallbackSourcesOf(order);

  /** Why a source would be skipped today, or null when it can run. */
  const blocker = (id: PrimarySourceId): string | null => {
    if (mask[id] === false) return "Switched off";
    if (id === "linkedin") return null;
    const s = describe.data?.find((x) => x.slug === id);
    if (!s) return null;
    if (!s.credential.configured) return "Not connected";
    if (s.credential.status === "invalid") return "Key rejected";
    return null;
  };
  const primaryBlocker = blocker(primary);
  // A workspace on a membership plan finds people through ONE chosen source
  // (ProspectSourceChoiceCard); a primary with fallbacks does not apply there.
  if (onPlan) return null;

  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm space-y-4" data-primary-source-card>
      <div className="flex items-start gap-2.5">
        <ListOrdered className="size-4 mt-0.5 shrink-0 text-violet-500" />
        <div className="flex-1">
          <h2 className="text-[15px] font-semibold">Primary prospect source</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            The source this workspace tries first when it looks for new people: in Revenue Engine campaigns, Source search and the Search box lookup. The others are fallbacks, tried in order when the primary cannot fill a search. When two sources find the same person, the primary's record is the one kept.
          </p>
        </div>
      </div>

      {settings.isLoading ? (
        <div className="text-[12px] text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading…</div>
      ) : (
        <div role="radiogroup" aria-label="Primary prospect source" className="space-y-1.5">
          {/* The primary, then the fallbacks in the order they are tried. */}
          {[primary, ...fallbacks].map((id) => {
            const chosen = id === primary;
            const why = blocker(id);
            const place = fallbacks.indexOf(id);
            return (
              <button
                key={id} type="button" role="radio" aria-checked={chosen} data-primary-source={id}
                disabled={!isAdmin || setPrimary.isPending || chosen}
                onClick={() => setPrimary.mutate({ source: id })}
                className={cn(
                  "w-full flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                  chosen ? "border-primary bg-primary/5" : "border-border/70 hover:bg-muted/50",
                  !isAdmin && !chosen && "cursor-default hover:bg-transparent",
                )}
              >
                <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", chosen ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50")}>
                  {chosen ? <Check className="size-3" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] font-medium">
                    {labelOf(id)}
                    <span className={cn("text-[11px] font-normal", chosen ? "text-primary" : "text-muted-foreground")}>
                      {chosen ? "Primary" : `Fallback ${place + 1}`}
                    </span>
                    {why ? <span className="text-[11px] font-normal text-amber-700 dark:text-amber-400">{why}</span> : null}
                  </span>
                  <span className="block text-[12px] text-muted-foreground">{NOTE[id]}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {primaryBlocker ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5 text-[12px] text-amber-800 dark:text-amber-300" data-primary-source-warning>
          {labelOf(primary)} is the primary source but cannot run: {primaryBlocker.toLowerCase()}. Searches skip it and go straight to the fallbacks until that is fixed, on its card below.
        </p>
      ) : null}

      <p className="text-[12px] text-muted-foreground">
        {isAdmin ? "Choosing a source changes the order only. It switches nothing on or off and spends nothing." : "Only workspace admins can change the primary source."}{" "}
        The full order, with your own contacts, places and news, is on <Link href="/are/settings" className="underline underline-offset-2">Revenue Engine settings</Link>.
      </p>
    </section>
  );
}
