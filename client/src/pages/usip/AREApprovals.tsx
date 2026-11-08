/**
 * AREApprovals — every prospect waiting for a decision, across campaigns
 * (/are/approvals; audit 2026-10-20, F16).
 *
 * The hub's "N awaiting your approval" pill opened the first campaign with
 * any; approving across campaigns meant visiting each one. This queue reads
 * are.approvals: filters for campaign, ICP score, source and kind (new, or
 * back after a canceled sequence), "approve all at or above a score" with a
 * count first, and reject with the same reasons a campaign's tab offers.
 *
 * Approving queues work and sends nothing by itself: each campaign's engine
 * writes the sequences and sends within that campaign's cap and send window,
 * and nothing goes while outbound is paused or from a paused or draft
 * campaign. The confirm says so.
 */
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { CheckCircle2, ExternalLink, Loader2, Search, ShieldCheck, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Shell, PageHeader, EmptyState, QueryError } from "@/components/usip/Shell";
import { AreSubNav } from "@/components/usip/are/AreSubNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { confirmAction } from "@/components/usip/Common";
import { RejectProspectDialog, RejectReasonPicker, type RejectTarget } from "@/components/usip/are/RejectProspectDialog";
import { useClearOnChange } from "@/hooks/useClearOnChange";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { PERSON_REJECT_PRESETS } from "@shared/rejectionKind";
import { areStatusLabel } from "@shared/areCampaignLabels";
import { invalidateCampaignReads } from "@/lib/entityCache";

const PAGE = 50;
const PRESETS: string[] = [...PERSON_REJECT_PRESETS];
type Kind = "all" | "new" | "returned";
const KIND_LABEL: Record<Kind, string> = { all: "All waiting", new: "New", returned: "Back after a canceled sequence" };
const sourceLabel = (s: string) => s.replace(/_/g, " ");

/** What "approve all at or above" will do, in words, from its dry run. Exported for the tests. */
export function approveAboveMessage(p: { count: number; byCampaign: Array<{ name: string; status: string; count: number }> }, minScore: number): string {
  const active = p.byCampaign.filter((c) => c.status === "active").reduce((n, c) => n + c.count, 0);
  const where = p.byCampaign.slice(0, 5).map((c) => `${c.count} in ${c.name} (${areStatusLabel(c.status).toLowerCase()})`).join(", ");
  return `${p.count} ${p.count === 1 ? "person scores" : "people score"} ${minScore} or more: ${where}${p.byCampaign.length > 5 ? ", …" : ""}. `
    + `Approving queues their sequences; it sends nothing by itself. `
    + (active > 0
      ? `The ${active} in active campaigns are written and sent on each campaign's cadence, within its daily cap and send window. `
      : "None is in an active campaign, so nothing goes until a campaign is activated. ")
    + "Nothing is sent while outbound is paused for the workspace.";
}

export default function AREApprovals() {
  const utils = trpc.useUtils();
  const [campaignId, setCampaignId] = useState<number | null>(null);
  const [minScore, setMinScore] = useState<number | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("all");
  const [search, setSearch] = useState("");
  const searchQ = useDebouncedValue(search.trim());
  const filter = {
    ...(campaignId ? { campaignId } : {}),
    ...(minScore != null ? { minScore } : {}),
    ...(source ? { source } : {}),
    ...(kind !== "all" ? { kind } : {}),
    ...(searchQ ? { search: searchQ } : {}),
  };
  const [page, setPage] = useState(1);
  useClearOnChange(filter, () => setPage(1));
  const q = trpc.are.approvals.queue.useQuery({ ...filter, limit: PAGE, offset: (page - 1) * PAGE }, { placeholderData: (prev) => prev });
  const rows = q.data?.rows ?? [];
  const pages = Math.max(1, Math.ceil((q.data?.total ?? 0) / PAGE));

  // Selection, cleared when the filter changes so a mass action touches only rows on view.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  useClearOnChange(filter, () => setSelected(new Set()));
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const refresh = () => {
    invalidateCampaignReads(utils);
  };

  const approveOne = trpc.are.prospects.approve.useMutation({
    onSuccess: () => { toast.success("Approved — the engine writes their sequence on its next run"); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const approveSelected = trpc.are.approvals.approveSelected.useMutation({
    onSuccess: (r) => { toast.success(`${r.approved} approved across ${r.campaigns} campaign${r.campaigns === 1 ? "" : "s"}`); setSelected(new Set()); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const approveAbove = trpc.are.approvals.approveAbove.useMutation({
    onSuccess: (r) => { toast.success(`${r.approved} approved across ${r.campaigns} campaign${r.campaigns === 1 ? "" : "s"}`); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const bulkReject = trpc.are.prospects.bulkReject.useMutation({
    onSuccess: (r) => { toast.success(`${r.rejected} rejected`); setSelected(new Set()); setRejectManyOpen(false); setRejectReason(""); refresh(); },
    onError: (e) => toast.error(e.message),
  });
  const [rejectTarget, setRejectTarget] = useState<RejectTarget | null>(null);
  const [rejectManyOpen, setRejectManyOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  /** "Approve all at or above": count first, confirm with the count, then approve no more than it. */
  const [aboveScore, setAboveScore] = useState(70);
  const [counting, setCounting] = useState(false);
  const runApproveAbove = async () => {
    setCounting(true);
    try {
      const { minScore: _drop, ...rest } = filter as typeof filter & { minScore?: number };
      const preview = await utils.are.approvals.approveAbovePreview.fetch({ ...rest, minScore: aboveScore }, { staleTime: 0 });
      if (preview.count === 0) { toast.info(`Nobody waiting scores ${aboveScore} or more${Object.keys(rest).length ? " with these filters" : ""}.`); return; }
      if (preview.capped) { toast.error(`More than ${preview.max.toLocaleString()} match. Raise the score or narrow the filters.`); return; }
      confirmAction({
        title: `Approve ${preview.count} ${preview.count === 1 ? "person" : "people"}?`,
        description: approveAboveMessage(preview, aboveScore),
        confirmLabel: `Approve ${preview.count}`,
        destructive: false,
      }, () => approveAbove.mutate({ ...rest, minScore: aboveScore, confirmedCount: preview.count }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't count them");
    } finally {
      setCounting(false);
    }
  };

  const filtered = Object.keys(filter).length > 0;

  return (
    <Shell title="Approvals">
      <PageHeader
        title="Approvals"
        pageKey="are-approvals"
        description="Every enriched prospect waiting for a decision, in every campaign. Approving queues their sequence; each campaign sends within its own cap and send window, and nothing goes while outbound is paused."
        icon={<ShieldCheck className="size-5" />}
      />
      <AreSubNav />
      <div className="p-4 md:p-6 space-y-4 max-w-6xl">
        {/* Filters (F16): campaign, score, source, kind, search — all on the server. */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="approvals-campaign" className="text-xs">Campaign</Label>
            <select id="approvals-campaign" className="h-8 rounded-md border border-input bg-background px-2 text-xs max-w-[220px]"
              value={campaignId ?? ""} onChange={(e) => setCampaignId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">All campaigns</option>
              {(q.data?.byCampaign ?? []).map((c) => <option key={c.campaignId} value={c.campaignId}>{c.name} ({c.count})</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="approvals-min" className="text-xs">ICP score at least</Label>
            <Input id="approvals-min" type="number" min={0} max={100} className="h-8 w-24 text-xs" placeholder="Any"
              value={minScore ?? ""} onChange={(e) => setMinScore(e.target.value === "" ? null : Math.max(0, Math.min(100, Math.round(Number(e.target.value)) || 0)))} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="approvals-source" className="text-xs">Source</Label>
            <select id="approvals-source" className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={source ?? ""} onChange={(e) => setSource(e.target.value || null)}>
              <option value="">All sources</option>
              {(q.data?.bySource ?? []).map((s) => <option key={s.source} value={s.source}>{sourceLabel(s.source)} ({s.count})</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="approvals-kind" className="text-xs">Kind</Label>
            <select id="approvals-kind" className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="all">{KIND_LABEL.all} ({((q.data?.byKind.new ?? 0) + (q.data?.byKind.returned ?? 0)).toLocaleString()})</option>
              <option value="new">{KIND_LABEL.new} ({(q.data?.byKind.new ?? 0).toLocaleString()})</option>
              <option value="returned">{KIND_LABEL.returned} ({(q.data?.byKind.returned ?? 0).toLocaleString()})</option>
            </select>
          </div>
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input aria-label="Search the queue" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, email, company, title…" className="h-8 pl-8 text-xs" />
          </div>
          {filtered && (
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => { setCampaignId(null); setMinScore(null); setSource(null); setKind("all"); setSearch(""); }}>
              <X className="size-3 mr-1" /> Clear filters
            </Button>
          )}
        </div>

        {/* Approve all at or above a score: a dry-run count, then a confirm with that count (F16). */}
        <div className="rounded-xl border bg-card px-3 py-2.5 flex flex-wrap items-center gap-2 text-xs">
          <Label htmlFor="approvals-above" className="text-xs">Approve everyone waiting who scores at least</Label>
          <Input id="approvals-above" type="number" min={0} max={100} className="h-7 w-20 text-xs"
            value={aboveScore} onChange={(e) => setAboveScore(Math.max(0, Math.min(100, Math.round(Number(e.target.value)) || 0)))} />
          <span className="text-muted-foreground">{filtered ? "with the other filters above" : "in every campaign"}</span>
          <Button size="sm" className="h-7 text-xs gap-1.5 ml-auto" disabled={counting || approveAbove.isPending} onClick={() => void runApproveAbove()}>
            {counting || approveAbove.isPending ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />} Count and approve…
          </Button>
        </div>

        {/* Selection actions */}
        {selected.size > 0 && (
          <div className="rounded-lg border bg-muted/40 px-3 py-2 flex flex-wrap items-center gap-2 text-xs">
            <span><strong>{selected.size}</strong> selected</span>
            <Button size="sm" className="h-7 text-xs gap-1" disabled={approveSelected.isPending}
              onClick={() => confirmAction({
                title: `Approve ${selected.size} ${selected.size === 1 ? "person" : "people"}?`,
                description: "Approving queues their sequences; each campaign writes and sends them within its own cap and send window. Nothing is sent while outbound is paused, or from a paused or draft campaign.",
                confirmLabel: "Approve",
                destructive: false,
              }, () => approveSelected.mutate({ prospectIds: Array.from(selected) }))}>
              <CheckCircle2 className="size-3" /> Approve
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setRejectManyOpen(true)}>
              <X className="size-3" /> Reject…
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}

        {q.isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center text-sm"><Loader2 className="size-4 animate-spin" /> Loading the queue…</div>
        ) : q.error && !q.data ? (
          <QueryError what="the approval queue" message={q.error.message} onRetry={() => q.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={ShieldCheck}
            title={filtered ? "Nobody matches these filters" : "Nothing waiting for approval"}
            description={filtered ? "Clear a filter to see the rest of the queue." : "Enriched prospects waiting for a decision, in any campaign, appear here."} />
        ) : (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer select-none">
              <Checkbox checked={allOnPage} onCheckedChange={() => setSelected(allOnPage ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Select all on this page" />
              All {rows.length} on this page · {(q.data?.total ?? 0).toLocaleString()} waiting{filtered ? " with these filters" : ""}
            </label>
            <div className="rounded-xl border bg-card divide-y">
              {rows.map((r) => {
                const name = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || r.email || "—";
                return (
                  <div key={r.id} className={`flex flex-wrap sm:flex-nowrap items-center gap-3 px-3 py-2.5 ${selected.has(r.id) ? "bg-primary/5" : ""}`}>
                    <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggle(r.id)} aria-label={`Select ${name}`} />
                    <span className="w-9 text-center text-sm font-semibold tabular-nums" title="ICP score">{r.icpMatchScore}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{name}</div>
                      <div className="text-xs text-muted-foreground truncate">{[r.title, r.companyName].filter(Boolean).join(" · ") || "—"}</div>
                    </div>
                    <div className="hidden md:flex flex-col items-end text-[11px] text-muted-foreground shrink-0 max-w-[200px]">
                      <Link href={`/are/campaigns/${r.campaignId}?prospect=${r.id}`} className="truncate hover:underline text-foreground/90 inline-flex items-center gap-1">
                        {r.campaignName} <ExternalLink className="size-3" />
                      </Link>
                      <span>{areStatusLabel(r.campaignStatus)} · {sourceLabel(String(r.sourceType))}</span>
                    </div>
                    {r.sequenceStatus === "canceled" && <Badge variant="outline" className="text-[10px] shrink-0">Back for review</Badge>}
                    <div className="flex items-center gap-1 shrink-0">
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] gap-1 text-emerald-600" disabled={approveOne.isPending}
                        onClick={() => approveOne.mutate({ prospectId: r.id })}>
                        <CheckCircle2 className="size-3" /> Approve
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] gap-1 text-muted-foreground hover:text-destructive"
                        onClick={() => setRejectTarget({ id: r.id, name, sequenceStatus: r.sequenceStatus })}>
                        <X className="size-3" /> Reject…
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            {pages > 1 && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Page {page} of {pages}</span>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" className="h-7" disabled={page <= 1} onClick={() => { setSelected(new Set()); setPage((p) => p - 1); }}>Previous</Button>
                  <Button size="sm" variant="outline" className="h-7" disabled={page >= pages} onClick={() => { setSelected(new Set()); setPage((p) => p + 1); }}>Next</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* One prospect: the campaign tab's own dialog, with its presets and its Undo. */}
      <RejectProspectDialog target={rejectTarget} presets={PRESETS} onClose={() => setRejectTarget(null)} onChanged={refresh} />

      {/* Several: one reason for all of them, from the same presets. */}
      <Dialog open={rejectManyOpen} onOpenChange={(o) => { if (!o) { setRejectManyOpen(false); setRejectReason(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject {selected.size} {selected.size === 1 ? "prospect" : "prospects"}?</DialogTitle>
            <DialogDescription>They leave the review queue and nothing is sent to them. Each can be restored from its campaign's Rejections tab.</DialogDescription>
          </DialogHeader>
          <RejectReasonPicker presets={PRESETS} reason={rejectReason} onChange={setRejectReason} />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => { setRejectManyOpen(false); setRejectReason(""); }}>Cancel</Button>
            <Button variant="destructive" size="sm" disabled={bulkReject.isPending || selected.size === 0}
              onClick={() => bulkReject.mutate({ prospectIds: Array.from(selected), reason: rejectReason.trim() || undefined })}>
              {bulkReject.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
