/**
 * One AI research run (/research/runs/:id): what it is doing while it works,
 * and the review when it is done. A person ticks the parts of the draft (and
 * the personas) they want and saves them as a version of the market or
 * sector; nothing the run wrote is used anywhere until then.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { Shell, PageHeader, QueryError, TableSkeleton } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { ChevronDown, ExternalLink, Sparkles, Square } from "lucide-react";
import { Crumbs, Section, readableText, useResearchRoles } from "@/components/usip/research/ResearchFields";
import { RunStatusBadge } from "@/components/usip/research/ResearchRuns";
import { MARKET_RUN_PARTS, RUN_PART_LABEL, SECTOR_RUN_PARTS } from "@shared/researchShape";
import { RESEARCH_MODELS, formatUsd, researchModelOf } from "@shared/researchModels";

/** The fields a part covers, for showing it. */
const PART_FIELDS: Record<string, string[]> = {
  summary: ["tagline", "summary"],
  overview: ["tagline", "overview"],
};

function partValue(content: any, part: string): unknown {
  if (!content) return null;
  const fields = PART_FIELDS[part];
  if (!fields) return content[part];
  return Object.fromEntries(fields.map((f) => [f, content[f]]));
}

function Lines({ value }: { value: unknown }) {
  const text = readableText(value);
  return text ? <div className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{text}</div> : <div className="text-xs italic text-muted-foreground">Nothing</div>;
}

export default function ResearchRun() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [, navigate] = useLocation();
  const { canEdit } = useResearchRoles();
  const q = trpc.research.runs.get.useQuery({ id }, {
    enabled: Number.isFinite(id) && id > 0,
    refetchInterval: (query) => {
      const s = (query.state.data as any)?.status;
      return s === "queued" || s === "running" ? 3000 : false;
    },
  });
  const run = q.data;
  const utils = trpc.useUtils();

  const parts: readonly string[] = run?.kind === "market" ? MARKET_RUN_PARTS : SECTOR_RUN_PARTS;
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [pickedPersonas, setPickedPersonas] = useState<Set<number> | null>(null);
  const [showBrief, setShowBrief] = useState(false);
  const draft = run?.draft as any;
  const personas: any[] = draft?.kind === "sector" ? draft.personas ?? [] : [];

  // Everything ticked to start with; a part the draft left empty starts unticked.
  useEffect(() => {
    if (!draft || picked) return;
    setPicked(new Set(parts.filter((p) => readableText(partValue(draft.content, p)))));
    setPickedPersonas(new Set(personas.map((_, i) => i)));
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = trpc.research.runs.cancel.useMutation({ onError: (e) => toast.error(e.message), onSuccess: () => q.refetch() });
  const redraft = trpc.research.runs.redraft.useMutation({ onError: (e) => toast.error(e.message), onSuccess: () => { toast.success("Drafting again"); q.refetch(); } });
  const discard = trpc.research.runs.discard.useMutation({ onError: (e) => toast.error(e.message), onSuccess: () => { toast.success("Draft discarded"); q.refetch(); } });
  const accept = trpc.research.runs.accept.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: async (r) => {
      toast.success("Saved");
      await utils.research.invalidate();
      navigate(r.resultType === "market" ? `/research/markets/${r.resultId}` : `/research/sectors/${r.resultId}`);
    },
  });

  const progress = run?.progress ?? [];
  const searches = useMemo(() => progress.filter((p) => p.line.startsWith("Searching")).length, [progress]);

  if (q.error) {
    return (
      <Shell title="Research run">
        <Crumbs items={[{ href: "/research", label: "Research" }, { label: "AI research run" }]} />
        <div className="p-4 md:p-6"><Card><CardContent className="pt-6"><QueryError message={q.error.message} onRetry={() => q.refetch()} /></CardContent></Card></div>
      </Shell>
    );
  }
  if (!run) {
    return <Shell title="Research run"><div className="p-4 md:p-6"><Card><CardContent className="pt-6"><TableSkeleton rows={6} /></CardContent></Card></div></Shell>;
  }

  const working = run.status === "queued" || run.status === "running";
  const refresh = run.current != null;
  const target = run.kind === "market" ? "market" : "sector";
  const crumbs = [{ href: "/research", label: "Research" }];
  if (run.marketId != null && run.marketName) crumbs.push({ href: `/research/markets/${run.marketId}`, label: run.marketName });
  if (run.kind === "sector" && run.sectorId != null) crumbs.push({ href: `/research/sectors/${run.sectorId}`, label: run.subject });
  const reviewable = run.status === "done" && !run.outcome && draft;
  const nothingPicked = (picked?.size ?? 0) === 0 && (pickedPersonas?.size ?? 0) === 0;

  return (
    <Shell title={`Research: ${run.subject}`}>
      <Crumbs items={[...crumbs, { label: `AI research run ${run.id}` } as any]} />
      <PageHeader
        icon={<Sparkles className="size-5" />}
        title={`AI research: ${run.subject}`}
        description={`${refresh ? "Refresh of this" : "A new"} ${target}${run.focus ? `. Focus: ${run.focus}` : ""}`}
      >
        <RunStatusBadge status={run.status} outcome={run.outcome} />
        {working && (run.mine || canEdit) && (
          <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate({ id })}>
            <Square className="size-3.5 mr-1" /> Stop
          </Button>
        )}
      </PageHeader>

      <div className="p-4 md:p-6 space-y-4 w-full max-w-5xl">
        <Card>
          <CardContent className="pt-5 grid gap-3 grid-cols-2 sm:grid-cols-4 text-sm">
            <div><div className="text-xs text-muted-foreground">Cost so far</div><div className="font-semibold">{formatUsd(run.costUsd)}</div></div>
            <div><div className="text-xs text-muted-foreground">Web searches</div><div className="font-semibold">{run.searches}</div></div>
            <div><div className="text-xs text-muted-foreground">Pages read</div><div className="font-semibold">{run.fetches}</div></div>
            <div><div className="text-xs text-muted-foreground">Model</div><div className="font-semibold">{RESEARCH_MODELS[researchModelOf(run.model)].label}</div></div>
          </CardContent>
        </Card>

        {run.status === "failed" && (
          <Card><CardContent className="pt-5 text-sm space-y-3">
            <div className="text-destructive">{run.error ?? "The run failed."}</div>
            {run.brief && canEdit && (
              <div className="flex items-center gap-2 flex-wrap">
                <Button size="sm" disabled={redraft.isPending} onClick={() => redraft.mutate({ id })}>Draft again from this research</Button>
                <span className="text-xs text-muted-foreground">The research is saved, so only the drafting step runs again.</span>
              </div>
            )}
          </CardContent></Card>
        )}

        {(working || !reviewable) && progress.length > 0 && (
          <Section title={working ? "Working" : "What the run did"} description={working ? "This page updates by itself. You can leave it; the run carries on." : undefined}>
            <ol className="space-y-1 text-xs max-h-[50vh] overflow-y-auto">
              {progress.map((p, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-muted-foreground tabular-nums shrink-0">{new Date(p.at).toLocaleTimeString()}</span>
                  <span className="break-all">{p.line}</span>
                </li>
              ))}
            </ol>
            {working && searches === 0 && <p className="text-xs text-muted-foreground">Starting up. The first searches usually show within a minute.</p>}
          </Section>
        )}

        {run.status === "done" && run.outcome && (
          <Card><CardContent className="pt-5 text-sm">
            {run.outcome === "accepted"
              ? <>Saved{run.resultId ? <> into the <Link className="underline" href={run.resultType === "market" ? `/research/markets/${run.resultId}` : `/research/sectors/${run.resultId}`}>{run.resultType}</Link></> : null}.</>
              : "This draft was discarded."}
          </CardContent></Card>
        )}

        {reviewable && (
          <>
            <Section
              title="Review the draft"
              description={refresh
                ? "Tick what to take. A ticked part replaces what you have (sources are added to yours). Saving makes a new version, so you can restore the old one."
                : `Tick what to keep. Saving creates the ${target} as a Draft; you mark it Researched once you have checked it.`}
            >
              {run.dropped.length > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs space-y-1">
                  <div className="font-medium">Removed before you saw it</div>
                  {run.dropped.slice(0, 12).map((d, i) => <div key={i} className="break-all">{d.startsWith("link ") ? d : `${d}: looked like an email address or phone number`}</div>)}
                  {run.dropped.length > 12 && <div>and {run.dropped.length - 12} more</div>}
                </div>
              )}
              <div className="space-y-2">
                {parts.map((p) => {
                  const proposed = partValue(draft.content, p);
                  const now = refresh ? partValue(run.current!.content, p) : null;
                  const checked = picked?.has(p) ?? false;
                  return (
                    <label key={p} className="flex items-start gap-3 rounded-md border p-3 cursor-pointer has-[:checked]:border-primary/60">
                      <Checkbox
                        checked={checked}
                        disabled={!canEdit}
                        onCheckedChange={(v) => setPicked((s) => { const n = new Set(s ?? []); if (v) n.add(p); else n.delete(p); return n; })}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0 space-y-1.5">
                        <div className="text-sm font-medium">{RUN_PART_LABEL[p] ?? p}</div>
                        {refresh ? (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-0.5">Now</div><Lines value={now} /></div>
                            <div><div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-0.5">Proposed</div><Lines value={proposed} /></div>
                          </div>
                        ) : <Lines value={proposed} />}
                      </div>
                    </label>
                  );
                })}
              </div>
              {personas.length > 0 && (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Personas to add to the sector</div>
                  {personas.map((pp, i) => (
                    <label key={i} className="flex items-start gap-3 rounded-md border p-3 cursor-pointer has-[:checked]:border-primary/60">
                      <Checkbox
                        checked={pickedPersonas?.has(i) ?? false}
                        disabled={!canEdit}
                        onCheckedChange={(v) => setPickedPersonas((s) => { const n = new Set(s ?? []); if (v) n.add(i); else n.delete(i); return n; })}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0 space-y-1 text-xs">
                        <div className="text-sm font-medium">{pp.name}</div>
                        {pp.titles?.length > 0 && <div className="flex flex-wrap gap-1">{pp.titles.slice(0, 6).map((t: string) => <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>)}</div>}
                        {pp.cares && <div className="text-muted-foreground">Cares about: {pp.cares}</div>}
                        {pp.pains?.length > 0 && <div className="text-muted-foreground">Pains: {pp.pains.join("; ")}</div>}
                        {pp.objections?.length > 0 && <div className="text-muted-foreground">Objections: {pp.objections.join("; ")}</div>}
                        {pp.angle && <div className="text-muted-foreground">Angle: {pp.angle}</div>}
                      </div>
                    </label>
                  ))}
                </div>
              )}
              {canEdit ? (
                <div className="flex gap-2 flex-wrap">
                  <Button
                    disabled={accept.isPending || nothingPicked}
                    onClick={() => accept.mutate({
                      id,
                      parts: Array.from(picked ?? []),
                      personas: Array.from(pickedPersonas ?? []),
                      ...(run.current ? { expectedRevision: run.current.revision } : {}),
                    })}
                  >
                    Save selected
                  </Button>
                  <Button variant="outline" disabled={discard.isPending} onClick={() => discard.mutate({ id })}>Discard draft</Button>
                </div>
              ) : <p className="text-xs text-muted-foreground">Managers and admins save research.</p>}
            </Section>
          </>
        )}

        {run.brief && (
          <Section
            title="The research brief"
            description="What the run found, in its own words, with the source of each figure."
            actions={<Button variant="ghost" size="sm" onClick={() => setShowBrief((v) => !v)}>{showBrief ? "Hide" : "Show"} <ChevronDown className={`size-4 ml-1 transition-transform ${showBrief ? "rotate-180" : ""}`} /></Button>}
          >
            {showBrief && <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{run.brief}</div>}
          </Section>
        )}

        {run.sources.length > 0 && (
          <Section title={`Pages searched and read (${run.sources.length})`}>
            <ul className="space-y-1 text-xs max-h-[40vh] overflow-y-auto">
              {run.sources.map((s, i) => (
                <li key={i} className="flex items-start gap-1.5 min-w-0">
                  <ExternalLink className="size-3 mt-0.5 shrink-0 text-muted-foreground" />
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline break-all">{s.title || s.url}</a>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </Shell>
  );
}
