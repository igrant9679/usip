/**
 * AI research runs (Research module, phase 2): the dialog that starts one,
 * the recent-runs card, the run status badge, and the admin settings (model
 * and runs per person per day). A run writes a draft; the run page
 * (pages/usip/research/ResearchRun.tsx) is where a person reviews and saves it.
 */
import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Sparkles, Trash2 } from "lucide-react";
import { confirmAction } from "@/components/usip/Common";
import { Section, useResearchRoles } from "./ResearchFields";
import { RESEARCH_MODELS, formatUsd, researchModelOf } from "@shared/researchModels";
import { QueryError } from "@/components/usip/Shell";

export type RunTarget =
  | { kind: "market" }
  | { kind: "market"; marketId: number; name: string }
  | { kind: "sector"; marketId: number; marketName: string; subject?: string }
  | { kind: "sector"; sectorId: number; name: string };

const STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: "Waiting", cls: "bg-muted text-muted-foreground" },
  running: { label: "Researching", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  done: { label: "Ready to review", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  failed: { label: "Failed", cls: "bg-destructive/15 text-destructive" },
  cancelled: { label: "Stopped", cls: "bg-muted text-muted-foreground" },
};

export function RunStatusBadge({ status, outcome }: { status: string; outcome?: string | null }) {
  if (status === "done" && outcome === "accepted") return <Badge variant="outline" className="text-[10px] border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">Saved</Badge>;
  if (status === "done" && outcome === "discarded") return <Badge variant="outline" className="text-[10px] border-transparent bg-muted text-muted-foreground">Discarded</Badge>;
  const s = STATUS[status] ?? STATUS.queued;
  return (
    <Badge variant="outline" className={`text-[10px] border-transparent gap-1 ${s.cls}`}>
      {(status === "running" || status === "queued") && <Loader2 className="size-3 animate-spin" />} {s.label}
    </Badge>
  );
}

const when = (d: string | Date) => new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Starts a run and opens its page. */
export function StartRunDialog({ target, open, onOpenChange }: { target: RunTarget; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [, navigate] = useLocation();
  const settings = trpc.research.settings.get.useQuery(undefined, { enabled: open });
  const runs = trpc.research.runs.list.useQuery({ limit: 1 }, { enabled: open });
  const [subject, setSubject] = useState("");
  const [focus, setFocus] = useState("");
  useEffect(() => {
    if (open) {
      setSubject("subject" in target && target.subject ? target.subject : "");
      setFocus("");
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = trpc.research.runs.start.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: (r) => { onOpenChange(false); navigate(`/research/runs/${r.id}`); },
  });

  const isNew = !("sectorId" in target) && !("name" in target);
  const title =
    target.kind === "market"
      ? "name" in target ? `Refresh "${target.name}" with AI research` : "Research a new market with AI"
      : "sectorId" in target ? `Refresh "${target.name}" with AI research` : `Research a new sector in ${target.marketName}`;
  const model = researchModelOf(settings.data?.model);
  const used = runs.data?.usedToday ?? 0;
  const cap = runs.data?.dailyRuns ?? settings.data?.dailyRuns ?? 10;
  const noKey = settings.data && !settings.data.hasKey;
  const full = used >= cap;

  const submit = () => {
    if (isNew && !subject.trim()) { toast.error(target.kind === "market" ? "Name the market" : "Name the sector"); return; }
    start.mutate({
      kind: target.kind,
      ...("marketId" in target ? { marketId: target.marketId } : {}),
      ...("sectorId" in target ? { sectorId: target.sectorId } : {}),
      ...(isNew ? { subject: subject.trim() } : {}),
      focus: focus.trim() || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            AI searches the web and reads the most useful pages, then writes a draft with a source for every figure. Nothing changes until you review the draft and save the parts you want.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {isNew && (
            <div className="space-y-2">
              <Label htmlFor="run-subject">{target.kind === "market" ? "Market" : "Sector"}</Label>
              <Input id="run-subject" autoFocus maxLength={160} value={subject} onChange={(e) => setSubject(e.target.value)}
                placeholder={target.kind === "market" ? "e.g. Regional authorities" : "e.g. K-12 school districts"} />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="run-focus">Focus (optional)</Label>
            <Textarea id="run-focus" rows={3} maxLength={2000} value={focus} onChange={(e) => setFocus(e.target.value)}
              placeholder="e.g. US only; mid-sized organizations; how they budget for software" />
          </div>
          <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-1">
            <div>
              Runs on <span className="font-medium">{RESEARCH_MODELS[model].label}</span> with up to 12 web searches and 8 page reads, billed to this workspace's own Anthropic key. You see the cost as it runs; a run usually takes a few minutes.
            </div>
            <div>You have used {used} of {cap} runs in the last 24 hours.</div>
          </div>
          {noKey && <p className="text-xs text-destructive">This workspace has no Anthropic key of its own. An admin can add one in Settings → Integrations → AI provider keys.</p>}
          {full && runs.data?.nextFreeAt && <p className="text-xs text-destructive">Your next run frees up at {when(runs.data.nextFreeAt)}.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={start.isPending || !!noKey || full}>
            {start.isPending ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Sparkles className="size-4 mr-1" />} Start research
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The workspace's recent runs, newest first. */
/** What removing runs means, said once in every confirmation. */
const REMOVE_NOTE = "They leave this list but stay on record: what they cost still counts toward today's runs, and a link to one still opens it.";

export function RecentRuns() {
  const { canEdit, canDelete: isAdmin } = useResearchRoles();
  const utils = trpc.useUtils();
  const q = trpc.research.runs.list.useQuery({ limit: 10 }, {
    refetchInterval: (query) => ((query.state.data as any)?.runs ?? []).some((r: any) => r.status === "queued" || r.status === "running") ? 4000 : false,
  });
  const remove = trpc.research.runs.remove.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: async (r) => {
      toast.success(r.removed === 1 ? "Run removed" : `${r.removed} runs removed`);
      await utils.research.runs.list.invalidate();
    },
  });
  const runs = q.data?.runs ?? [];
  // A failed load said nothing at all (audit 2026-10-20, P113).
  if (q.error && !q.data) return <Section title="AI research runs"><QueryError compact what="recent runs" message={q.error.message} onRetry={() => q.refetch()} /></Section>;
  if (!q.data || runs.length === 0) return null;
  // Its starter or an admin, once it has stopped.
  const removable = (r: (typeof runs)[number]) => canEdit && (r.mine || isAdmin) && r.status !== "queued" && r.status !== "running";
  const failed = runs.filter((r) => r.status === "failed" && removable(r));
  const removeOne = (r: (typeof runs)[number]) => confirmAction(
    {
      title: `Remove "${r.subject}" from this list?`,
      description: (r.status === "done" && !r.outcome ? "Its draft has not been saved and will be set aside. " : "") + REMOVE_NOTE.replace("They leave", "It leaves").replace("to one", "to it"),
      confirmLabel: "Remove",
    },
    () => remove.mutate({ ids: [r.id] }),
  );
  return (
    <Section
      title="AI research runs"
      description={`You have used ${q.data.usedToday} of ${q.data.dailyRuns} runs in the last 24 hours.`}
      actions={failed.length > 0 ? (
        <Button
          size="sm"
          variant="outline"
          disabled={remove.isPending}
          onClick={() => confirmAction(
            { title: `Remove ${failed.length} failed ${failed.length === 1 ? "run" : "runs"}?`, description: REMOVE_NOTE, confirmLabel: "Remove" },
            () => remove.mutate({ ids: failed.map((r) => r.id) }),
          )}
        >
          <Trash2 className="size-4 mr-1" /> Remove failed runs
        </Button>
      ) : undefined}
    >
      <div className="divide-y rounded-md border">
        {runs.map((r) => (
          <div key={r.id} className="flex items-center gap-1 hover:bg-accent/40">
            <Link href={`/research/runs/${r.id}`} className="flex flex-1 min-w-0 items-center gap-3 p-2.5 text-sm">
              <div className="flex-1 min-w-0">
                <div className="truncate">
                  <span className="font-medium">{r.subject}</span>
                  <span className="text-muted-foreground"> · {r.kind === "market" ? "market" : "sector"}{(r.kind === "market" ? r.marketId : r.sectorId) != null ? " refresh" : ""}</span>
                </div>
                <div className="text-xs text-muted-foreground">{r.byName} · {when(r.createdAt)} · {formatUsd(r.costUsd)} · {r.searches} {r.searches === 1 ? "search" : "searches"}</div>
              </div>
              <RunStatusBadge status={r.status} outcome={r.outcome} />
            </Link>
            {removable(r) && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 mr-1.5 shrink-0"
                title="Remove from this list"
                aria-label={`Remove ${r.subject} from this list`}
                disabled={remove.isPending}
                onClick={() => removeOne(r)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

/**
 * The runs behind a market or sector, so what each one learned (its brief and
 * sources, on the run's page) stays one click away, including runs removed
 * from the Research page.
 */
export function RunsForRecord({ kind, id }: { kind: "market" | "sector"; id: number }) {
  const q = trpc.research.runs.forRecord.useQuery({ kind, id });
  const runs = q.data ?? [];
  if (runs.length === 0) return null;
  return (
    <Section title="Research runs" description={`The AI research behind this ${kind}. Each run's page has its full brief: what it found, with the source of every figure.`}>
      <div className="divide-y rounded-md border">
        {runs.map((r) => (
          <Link key={r.id} href={`/research/runs/${r.id}`} className="flex items-center gap-3 p-2.5 hover:bg-accent/40 text-sm">
            <div className="flex-1 min-w-0">
              <div className="truncate font-medium">{r.subject}</div>
              <div className="text-xs text-muted-foreground">
                {when(r.createdAt)} · {formatUsd(r.costUsd)} · {r.searches} {r.searches === 1 ? "search" : "searches"}{r.removedAt ? " · removed from the Research page" : ""}
              </div>
            </div>
            <RunStatusBadge status={r.status} outcome={r.outcome} />
          </Link>
        ))}
      </div>
    </Section>
  );
}

/** Admins: which model research uses, and how many runs each person gets per day. */
export function ResearchSettingsButton() {
  const { canDelete: isAdmin } = useResearchRoles();
  const [open, setOpen] = useState(false);
  const q = trpc.research.settings.get.useQuery(undefined, { enabled: open });
  const utils = trpc.useUtils();
  const [model, setModel] = useState<string>("");
  const [daily, setDaily] = useState<string>("");
  useEffect(() => {
    if (open && q.data) { setModel(q.data.model); setDaily(String(q.data.dailyRuns)); }
  }, [open, q.data]);
  const save = trpc.research.settings.set.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: async () => { toast.success("Research settings saved"); setOpen(false); await utils.research.settings.get.invalidate(); await utils.research.runs.list.invalidate(); },
  });
  if (!isAdmin) return null;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>AI research settings</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>AI research settings</DialogTitle>
            <DialogDescription>Runs bill this workspace's own Anthropic key. Prices are Anthropic's list prices per million tokens; web search adds $10 per 1,000 searches.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger><SelectValue placeholder="Choose a model" /></SelectTrigger>
                <SelectContent>
                  {(q.data?.models ?? []).map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.label} (${m.input} in / ${m.output} out). {m.note}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="daily-runs">Runs per person per day</Label>
              <Input id="daily-runs" type="number" min={1} max={50} value={daily} onChange={(e) => setDaily(e.target.value)} />
              <p className="text-xs text-muted-foreground">Counted over the last 24 hours. A run that fails before spending anything does not count.</p>
            </div>
            {q.data && !q.data.hasKey && <p className="text-xs text-destructive">This workspace has no Anthropic key of its own yet; add one in Settings → Integrations → AI provider keys.</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={save.isPending || !model || !(Number(daily) >= 1 && Number(daily) <= 50)} onClick={() => save.mutate({ model, dailyRuns: Math.round(Number(daily)) })}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
