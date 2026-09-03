/**
 * AddToMenu — the ONE "put this person into outreach" action (seams audit,
 * phase 2). Mounted on every surface that shows a person: People (row, bulk
 * bar, drawer), Company profile, Lists, Leads, Saved People, detail pages.
 *
 * Before this existed the app made you act on the CAMPAIGN (a button inside
 * one campaign's page) rather than on the person, and only People rows
 * could go into a campaign at all. The menu names the choice the user is
 * actually making — the two engines write copy in opposite ways:
 *   Campaign  — the engine writes every email for this person
 *   Sequence  — one fixed message per step, the same to everyone
 * plus List (bookmark, no outreach). Any person type is accepted; the
 * server resolves contacts and leads to their People row.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { Activity, Bot, ChevronDown, ChevronRight, Loader2, ListChecks, Plus } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface AddToMenuProps {
  prospectIds?: number[];
  contactIds?: number[];
  leadIds?: number[];
  trigger?: ReactNode;
  /** Compact trigger label (bulk bar / row). */
  label?: string;
  align?: "start" | "end";
  onDone?: () => void;
}

type Pane = "root" | "campaign" | "sequence" | "bestfit";

export function AddToMenu({ prospectIds = [], contactIds = [], leadIds = [], trigger, label = "Add to…", align = "start", onDone }: AddToMenuProps) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>("root");
  const utils = trpc.useUtils();
  const n = prospectIds.length + contactIds.length + leadIds.length;

  const campaignsQ = trpc.are.campaigns.list.useQuery({ limit: 100 }, { enabled: open && pane === "campaign" });
  const sequencesQ = trpc.sequences.list.useQuery(undefined, { enabled: open && pane === "sequence" });
  const campaigns = useMemo(() => ((campaignsQ.data ?? []) as any[]).filter((c) => c.status !== "archived" && c.status !== "completed"), [campaignsQ.data]);
  const sequences = useMemo(() => ((sequencesQ.data ?? []) as any[]).filter((s) => s.status !== "archived"), [sequencesQ.data]);

  const close = () => { setOpen(false); setPane("root"); onDone?.(); };
  const invalidatePeople = () => {
    utils.prospects.enrollmentsFor.invalidate();
    utils.prospects.list.invalidate();
  };

  const pushExisting = trpc.are.prospects.pushExisting.useMutation({
    onSuccess: (r: any, vars: any) => {
      const name = campaigns.find((c) => c.id === vars.campaignId)?.name ?? "campaign";
      if (r.added.length > 0) toast.success(`Added ${r.added.length} to "${name}" — the engine will enrich and write their emails`);
      if (r.skipped.length > 0) {
        const reasons = Array.from(new Set(r.skipped.map((s: any) => String(s.reason)))).slice(0, 2).join(" · ");
        toast[r.added.length > 0 ? "info" : "error"](`${r.skipped.length} skipped: ${reasons}`);
      }
      invalidatePeople();
      utils.are.prospects.list.invalidate();
      close();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const bulkEnroll = trpc.sequences.bulkEnroll.useMutation({
    onSuccess: (r: any, vars: any) => {
      const name = sequences.find((s) => s.id === vars.sequenceId)?.name ?? "sequence";
      if (r.enrolled > 0) toast.success(`Enrolled ${r.enrolled} in "${name}"`);
      const notes: string[] = [];
      if (r.skippedAlreadyEnrolled > 0) notes.push(`${r.skippedAlreadyEnrolled} already enrolled`);
      if (r.skippedInCampaign > 0) notes.push(`${r.skippedInCampaign} skipped — a campaign is already working them`);
      if (r.blockedInvalidEmail > 0) notes.push(`${r.blockedInvalidEmail} blocked — invalid or missing email`);
      if (notes.length) toast[r.enrolled > 0 ? "info" : "error"](notes.join(" · "));
      if (r.enrolled === 0 && notes.length === 0) toast.info("No one enrolled");
      utils.sequences.getEnrollmentStats.invalidate({ sequenceId: vars.sequenceId });
      invalidatePeople();
      close();
    },
    onError: (e: any) => toast.error(e.message),
  });
  // Phase 3: the router scores every active campaign; the user confirms.
  const bestFitQ = trpc.are.campaigns.routeBestFit.useQuery({ prospectIds, contactIds, leadIds }, { enabled: open && pane === "bestfit", retry: false });
  const applyBestFit = trpc.are.campaigns.applyBestFit.useMutation({
    onSuccess: (r: any) => {
      if (r.added > 0) toast.success(`Added ${r.added} to their best-fit campaign${r.added === 1 ? "" : "s"} — the engine will enrich and write their emails`);
      if (r.skipped > 0) toast.info(`${r.skipped} skipped (already in outreach or unidentifiable)`);
      invalidatePeople();
      utils.are.prospects.list.invalidate();
      close();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const routable = ((bestFitQ.data?.picks ?? []) as any[]).filter((p) => p.campaignId != null);
  const pending = pushExisting.isPending || bulkEnroll.isPending || applyBestFit.isPending;

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setPane("root"); }}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" className="gap-1.5">
            <Plus className="size-4" /> {label} <ChevronDown className="size-3 opacity-60" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-80 p-0">
        {pane === "root" && (
          <div className="py-1">
            <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">Add {n === 1 ? "this person" : `${n} people`} to</div>
            <button type="button" onClick={() => setPane("bestfit")} className="w-full flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted text-left">
              <Bot className="size-4 mt-0.5 shrink-0 text-violet-600" />
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-medium">Best-fit campaign ✦</span>
                <span className="block text-[11.5px] text-muted-foreground">The engine scores every active campaign and shows its pick</span>
              </span>
              <ChevronRight className="size-3.5 mt-1 text-muted-foreground" />
            </button>
            <button type="button" onClick={() => setPane("campaign")} className="w-full flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted text-left">
              <Bot className="size-4 mt-0.5 shrink-0 text-violet-600" />
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-medium">Campaign</span>
                <span className="block text-[11.5px] text-muted-foreground">The engine writes every email for each person</span>
              </span>
              <ChevronRight className="size-3.5 mt-1 text-muted-foreground" />
            </button>
            <button type="button" onClick={() => setPane("sequence")} className="w-full flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted text-left">
              <Activity className="size-4 mt-0.5 shrink-0 text-sky-600" />
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-medium">Sequence</span>
                <span className="block text-[11.5px] text-muted-foreground">One fixed message per step, the same to everyone</span>
              </span>
              <ChevronRight className="size-3.5 mt-1 text-muted-foreground" />
            </button>
            {prospectIds.length > 0 && contactIds.length === 0 && leadIds.length === 0 && (
              <Link href="/v2/lists" onClick={close} className="w-full flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted text-left">
                <ListChecks className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-medium">List</span>
                  <span className="block text-[11.5px] text-muted-foreground">Bookmark them — no outreach</span>
                </span>
              </Link>
            )}
          </div>
        )}
        {pane === "bestfit" && (
          <div>
            <button type="button" onClick={() => setPane("root")} className="w-full px-3 py-2 border-b text-[13px] font-medium text-left hover:bg-muted">‹ Best-fit campaign</button>
            <div className="max-h-72 overflow-y-auto py-1">
              {bestFitQ.isLoading ? (
                <div className="px-3 py-4 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Scoring against every active campaign…</div>
              ) : bestFitQ.error ? (
                <p className="px-3 py-4 text-[13px] text-red-600">{bestFitQ.error.message}</p>
              ) : ((bestFitQ.data?.picks ?? []) as any[]).length === 0 ? (
                <p className="px-3 py-4 text-[13px] text-muted-foreground">No one to route.</p>
              ) : ((bestFitQ.data?.picks ?? []) as any[]).map((p) => (
                <div key={p.prospectId} className="px-3 py-2 border-b last:border-0">
                  <div className="flex items-center gap-2 text-[13px]">
                    <span className="font-medium truncate flex-1">{p.name}</span>
                    {p.campaignId != null ? <span className="text-[10px] font-semibold text-violet-700 dark:text-violet-300">{p.fit}/100</span> : <span className="text-[10px] text-muted-foreground">no fit</span>}
                  </div>
                  <div className="text-[11.5px] text-muted-foreground">
                    {p.campaignId != null ? <><span className="text-foreground/90">→ {p.campaignName}</span>{p.reasoning ? ` — ${p.reasoning}` : ""}</> : p.skipReason}
                  </div>
                </div>
              ))}
            </div>
            {routable.length > 0 && (
              <div className="p-2 border-t">
                <Button size="sm" className="w-full" disabled={pending}
                  onClick={() => applyBestFit.mutate({ picks: routable.map((p) => ({ prospectId: p.prospectId, campaignId: p.campaignId, fit: p.fit, reasoning: String(p.reasoning ?? "").slice(0, 400) })) })}>
                  {applyBestFit.isPending ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
                  Add {routable.length} to {routable.length === 1 ? "this" : "their"} best-fit campaign{routable.length === 1 ? "" : "s"}
                </Button>
              </div>
            )}
          </div>
        )}
        {pane === "campaign" && (
          <div>
            <button type="button" onClick={() => setPane("root")} className="w-full px-3 py-2 border-b text-[13px] font-medium text-left hover:bg-muted">‹ Campaign</button>
            <div className="max-h-64 overflow-y-auto py-1">
              {campaignsQ.isLoading ? (
                <div className="px-3 py-4 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Loading…</div>
              ) : campaigns.length === 0 ? (
                <p className="px-3 py-4 text-[13px] text-muted-foreground">No campaigns yet — <Link href="/are/campaigns" className="underline">create one</Link> first.</p>
              ) : campaigns.map((c) => (
                <button key={c.id} type="button" disabled={pending}
                  onClick={() => pushExisting.mutate({ campaignId: c.id, prospectIds, contactIds, leadIds })}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-muted text-left disabled:opacity-60">
                  <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="text-[10px] text-muted-foreground capitalize">{c.status}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {pane === "sequence" && (
          <div>
            <button type="button" onClick={() => setPane("root")} className="w-full px-3 py-2 border-b text-[13px] font-medium text-left hover:bg-muted">‹ Sequence</button>
            <div className="max-h-64 overflow-y-auto py-1">
              {sequencesQ.isLoading ? (
                <div className="px-3 py-4 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Loading…</div>
              ) : sequences.length === 0 ? (
                <p className="px-3 py-4 text-[13px] text-muted-foreground">No sequences yet — <Link href="/v2/sequences" className="underline">create one</Link> first.</p>
              ) : sequences.map((s) => (
                <button key={s.id} type="button" disabled={pending}
                  onClick={() => bulkEnroll.mutate({ sequenceId: s.id, prospectIds, contactIds, leadIds })}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-muted text-left disabled:opacity-60">
                  <Activity className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{s.name}</span>
                  <span className="text-[10px] text-muted-foreground capitalize">{s.status}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * "In: …" — where this person is right now. Reads a batched map the page
 * fetched once (prospects.enrollmentsFor); renders nothing when idle.
 */
export type EnrollmentMap = Record<number, { campaigns: Array<{ campaignId: number; campaignName: string; sequenceStatus: string }>; sequences: Array<{ sequenceId: number; sequenceName: string; status: string; currentStep: number }> }>;

export function EnrollmentChip({ prospectId, map }: { prospectId: number; map?: EnrollmentMap }) {
  const e = map?.[prospectId];
  if (!e) return null;
  const c = e.campaigns[0];
  const s = e.sequences[0];
  if (c) {
    return (
      <Link href={`/are/campaigns/${c.campaignId}`} onClick={(ev) => ev.stopPropagation()}
        title={`In campaign "${c.campaignName}" — ${c.sequenceStatus}`}
        className="inline-flex items-center gap-1 rounded-full border border-violet-300/60 bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300 px-1.5 py-0.5 text-[10px] font-medium max-w-[160px]">
        <Bot className="size-3 shrink-0" /><span className="truncate">In: {c.campaignName}</span>
      </Link>
    );
  }
  if (s) {
    return (
      <Link href={`/v2/sequences/${s.sequenceId}`} onClick={(ev) => ev.stopPropagation()}
        title={`In sequence "${s.sequenceName}" — step ${s.currentStep + 1}`}
        className="inline-flex items-center gap-1 rounded-full border border-sky-300/60 bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300 px-1.5 py-0.5 text-[10px] font-medium max-w-[160px]">
        <Activity className="size-3 shrink-0" /><span className="truncate">In: {s.sequenceName}</span>
      </Link>
    );
  }
  return null;
}
