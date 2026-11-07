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
 *
 * Picking a campaign or sequence is a REVIEW, not the enrolment (audit
 * 2026-10-20, R48): a mis-click on a row used to put everyone in at once. The
 * pick shows who goes where and enrols on Confirm. List picks a list here and
 * adds the people to it; it used to open the Lists page and drop them.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { Activity, Bot, ChevronDown, ChevronRight, Loader2, ListChecks, Plus } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { invalidateEnrollmentReads } from "@/lib/enrollmentCache";
import { PUSH_BATCH, pushChunks } from "@/lib/pushChunks";
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

type Pane = "root" | "campaign" | "sequence" | "bestfit" | "list";
type Pick = { kind: "campaign" | "sequence"; id: number; name: string; status?: string };

export function AddToMenu({ prospectIds = [], contactIds = [], leadIds = [], trigger, label = "Add to…", align = "start", onDone }: AddToMenuProps) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>("root");
  const [picked, setPicked] = useState<Pick | null>(null);
  const [listId, setListId] = useState<number | null>(null);
  const utils = trpc.useUtils();
  const n = prospectIds.length + contactIds.length + leadIds.length;

  const campaignsQ = trpc.are.campaigns.list.useQuery({ limit: 100 }, { enabled: open && pane === "campaign" });
  const sequencesQ = trpc.sequences.list.useQuery(undefined, { enabled: open && pane === "sequence" });
  const campaigns = useMemo(() => ((campaignsQ.data ?? []) as any[]).filter((c) => c.status !== "archived" && c.status !== "completed"), [campaignsQ.data]);
  const sequences = useMemo(() => ((sequencesQ.data ?? []) as any[]).filter((s) => s.status !== "archived"), [sequencesQ.data]);
  const listsQ = trpc.recordLists.list.useQuery(undefined, { enabled: open && pane === "list" });
  const lists = useMemo(() => ((listsQ.data ?? []) as any[]).filter((l) => l.entityType !== "companies"), [listsQ.data]);
  const go = (p: Pane) => { setPane(p); setPicked(null); setListId(null); };

  const close = () => { setOpen(false); go("root"); onDone?.(); };
  const invalidatePeople = () => {
    utils.prospects.enrollmentsFor.invalidate();
    utils.prospects.list.invalidate();
  };

  // A campaign takes 100 people a call, so more go in batches, one after
  // another, and are reported once (audit 2026-10-20, P48).
  const pushExisting = trpc.are.prospects.pushExisting.useMutation({
    onError: (e: any) => toast.error(e.message),
  });
  const [pushing, setPushing] = useState(false);
  const pushToCampaign = async (campaign: { id: number; name: string }) => {
    setPushing(true);
    const added: number[] = [];
    const skipped: Array<{ reason: string }> = [];
    let failed = false;
    try {
      for (const batch of pushChunks({ prospectIds, contactIds, leadIds })) {
        const r: any = await pushExisting.mutateAsync({ campaignId: campaign.id, ...batch });
        added.push(...r.added);
        skipped.push(...r.skipped);
      }
    } catch {
      failed = true; // onError said why; what went in before it is reported below
    } finally {
      setPushing(false);
    }
    if (added.length > 0) toast.success(`Added ${added.length} to "${campaign.name}" — the engine will enrich and write their emails`);
    if (skipped.length > 0) {
      const reasons = Array.from(new Set(skipped.map((s) => String(s.reason)))).slice(0, 2).join(" · ");
      toast[added.length > 0 ? "info" : "error"](`${skipped.length} skipped: ${reasons}`);
    }
    if (failed && n > PUSH_BATCH) toast.error(`Stopped after ${added.length + skipped.length} of ${n}; the rest were not added.`);
    invalidatePeople();
    utils.are.prospects.list.invalidate(); utils.are.prospects.statusCounts.invalidate();
    if (!failed) close();
  };
  const bulkEnroll = trpc.sequences.bulkEnroll.useMutation({
    onSuccess: (r: any, vars: any) => {
      const name = sequences.find((s) => s.id === vars.sequenceId)?.name ?? "sequence";
      if (r.enrolled > 0) toast.success(`Enrolled ${r.enrolled} in "${name}"`);
      const notes: string[] = [];
      if (r.skippedAlreadyEnrolled > 0) notes.push(`${r.skippedAlreadyEnrolled} already enrolled`);
      if (r.skippedInCampaign > 0) notes.push(`${r.skippedInCampaign} skipped — a campaign is already working them`);
      if (r.blockedInvalidEmail > 0) notes.push(`${r.blockedInvalidEmail} blocked — invalid or missing email`);
      if (r.skippedSuppressed > 0) notes.push(`${r.skippedSuppressed} skipped — on a suppression list`);
      if (notes.length) toast[r.enrolled > 0 ? "info" : "error"](notes.join(" · "));
      // A paused or draft sequence holds new enrolments (audit 2026-10-20, O1).
      if (r.enrolled > 0 && r.heldUntilActive) toast.info(`"${name}" is not active — nothing is sent until it is activated`);
      if (r.enrolled === 0 && notes.length === 0) toast.info("No one enrolled");
      invalidateEnrollmentReads(utils, vars.sequenceId);
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
      utils.are.prospects.list.invalidate(); utils.are.prospects.statusCounts.invalidate();
      close();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const addToList = trpc.recordLists.addMembers.useMutation({
    onSuccess: (r: any) => {
      const name = lists.find((l) => l.id === listId)?.name ?? "the list";
      toast.success(r.added > 0 ? `Added ${r.added} to "${name}"` : `Already in "${name}"`);
      utils.recordLists.list.invalidate();
      close();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const routable = ((bestFitQ.data?.picks ?? []) as any[]).filter((p) => p.campaignId != null);
  const pending = pushing || pushExisting.isPending || bulkEnroll.isPending || applyBestFit.isPending || addToList.isPending;
  // Best-fit scores at most one batch; it is not split, since scoring can call the model.
  const bestFitTooMany = n > PUSH_BATCH;
  const who = n === 1 ? "this person" : `${n} people`;
  const confirm = () => {
    if (!picked) return;
    if (picked.kind === "campaign") void pushToCampaign(picked);
    else bulkEnroll.mutate({ sequenceId: picked.id, prospectIds, contactIds, leadIds });
  };
  // The review: what Confirm will do, in words, before it does it.
  const review = picked && (
    <div className="p-2.5 border-t space-y-2">
      <p className="text-[12.5px]">
        Add {who} to the {picked.kind} <span className="font-medium">"{picked.name}"</span>
        {picked.kind === "campaign" ? " — the engine enriches them and writes their emails." : " — each step sends the same message to everyone."}
        {picked.kind === "campaign" && n > PUSH_BATCH ? <span className="block text-[11.5px] text-muted-foreground mt-0.5">They go in {PUSH_BATCH} at a time.</span> : null}
        {picked.status && picked.status !== "active" ? <span className="block text-[11.5px] text-amber-700 mt-0.5">It is {picked.status}: nothing is sent until it is active.</span> : null}
      </p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setPicked(null)} disabled={pending}>Back</Button>
        <Button size="sm" onClick={confirm} disabled={pending}>
          {pending ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
          Confirm
        </Button>
      </div>
    </div>
  );

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) go("root"); }}>
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
            <button type="button" disabled={bestFitTooMany} onClick={() => go("bestfit")} className="w-full flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted text-left disabled:opacity-60 disabled:hover:bg-transparent">
              <Bot className="size-4 mt-0.5 shrink-0 text-violet-600" />
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-medium">Best-fit campaign ✦</span>
                <span className="block text-[11.5px] text-muted-foreground">{bestFitTooMany ? `Scores up to ${PUSH_BATCH} people at a time; pick a campaign below instead` : "The engine scores every active campaign and shows its pick"}</span>
              </span>
              <ChevronRight className="size-3.5 mt-1 text-muted-foreground" />
            </button>
            <button type="button" onClick={() => go("campaign")} className="w-full flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted text-left">
              <Bot className="size-4 mt-0.5 shrink-0 text-violet-600" />
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-medium">Campaign</span>
                <span className="block text-[11.5px] text-muted-foreground">The engine writes every email for each person</span>
              </span>
              <ChevronRight className="size-3.5 mt-1 text-muted-foreground" />
            </button>
            <button type="button" onClick={() => go("sequence")} className="w-full flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted text-left">
              <Activity className="size-4 mt-0.5 shrink-0 text-sky-600" />
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-medium">Sequence</span>
                <span className="block text-[11.5px] text-muted-foreground">One fixed message per step, the same to everyone</span>
              </span>
              <ChevronRight className="size-3.5 mt-1 text-muted-foreground" />
            </button>
            {prospectIds.length > 0 && contactIds.length === 0 && leadIds.length === 0 && (
              <button type="button" onClick={() => go("list")} className="w-full flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted text-left">
                <ListChecks className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-medium">List</span>
                  <span className="block text-[11.5px] text-muted-foreground">Bookmark them — no outreach</span>
                </span>
                <ChevronRight className="size-3.5 mt-1 text-muted-foreground" />
              </button>
            )}
          </div>
        )}
        {pane === "bestfit" && (
          <div>
            <button type="button" onClick={() => go("root")} className="w-full px-3 py-2 border-b text-[13px] font-medium text-left hover:bg-muted">‹ Best-fit campaign</button>
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
            <button type="button" onClick={() => go("root")} className="w-full px-3 py-2 border-b text-[13px] font-medium text-left hover:bg-muted">‹ Campaign</button>
            <div className="max-h-64 overflow-y-auto py-1">
              {campaignsQ.isLoading ? (
                <div className="px-3 py-4 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Loading…</div>
              ) : campaigns.length === 0 ? (
                <p className="px-3 py-4 text-[13px] text-muted-foreground">No campaigns yet — <Link href="/are/campaigns" className="underline">create one</Link> first.</p>
              ) : campaigns.map((c) => (
                <button key={c.id} type="button" disabled={pending} aria-pressed={picked?.kind === "campaign" && picked.id === c.id}
                  onClick={() => setPicked({ kind: "campaign", id: c.id, name: c.name, status: c.status })}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-muted text-left disabled:opacity-60 ${picked?.kind === "campaign" && picked.id === c.id ? "bg-muted" : ""}`}>
                  <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{c.name}</span>
                  {/* Phase 6: the copy model is the difference the user is choosing. */}
                  <span className="text-[10px] text-muted-foreground">{c.copyMode === "fixed" ? "fixed copy" : "AI copy"}</span>
                  <span className="text-[10px] text-muted-foreground capitalize">{c.status}</span>
                </button>
              ))}
            </div>
            {review}
          </div>
        )}
        {pane === "sequence" && (
          <div>
            <button type="button" onClick={() => go("root")} className="w-full px-3 py-2 border-b text-[13px] font-medium text-left hover:bg-muted">‹ Sequence</button>
            <div className="max-h-64 overflow-y-auto py-1">
              {sequencesQ.isLoading ? (
                <div className="px-3 py-4 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Loading…</div>
              ) : sequences.length === 0 ? (
                <p className="px-3 py-4 text-[13px] text-muted-foreground">No sequences yet — <Link href="/v2/sequences" className="underline">create one</Link> first.</p>
              ) : sequences.map((s) => (
                <button key={s.id} type="button" disabled={pending} aria-pressed={picked?.kind === "sequence" && picked.id === s.id}
                  onClick={() => setPicked({ kind: "sequence", id: s.id, name: s.name, status: s.status })}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-muted text-left disabled:opacity-60 ${picked?.kind === "sequence" && picked.id === s.id ? "bg-muted" : ""}`}>
                  <Activity className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{s.name}</span>
                  <span className="text-[10px] text-muted-foreground capitalize">{s.status}</span>
                </button>
              ))}
            </div>
            {review}
          </div>
        )}
        {pane === "list" && (
          <div>
            <button type="button" onClick={() => go("root")} className="w-full px-3 py-2 border-b text-[13px] font-medium text-left hover:bg-muted">‹ List</button>
            <div className="max-h-64 overflow-y-auto py-1">
              {listsQ.isLoading ? (
                <div className="px-3 py-4 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Loading…</div>
              ) : lists.length === 0 ? (
                <p className="px-3 py-4 text-[13px] text-muted-foreground">No lists yet — <Link href="/v2/lists" className="underline">create one</Link> first.</p>
              ) : lists.map((l) => (
                <label key={l.id} className="flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-muted cursor-pointer">
                  <input type="radio" name="addto-list" checked={listId === l.id} onChange={() => setListId(l.id)} className="size-3.5 accent-current" />
                  <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{l.name}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{l.memberCount ?? 0}</span>
                </label>
              ))}
            </div>
            <div className="p-2 border-t flex justify-end">
              <Button size="sm" disabled={listId == null || pending}
                onClick={() => listId != null && addToList.mutate({ listId, recordType: "prospect", recordIds: prospectIds })}>
                {addToList.isPending ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
                Add {who} to list
              </Button>
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
