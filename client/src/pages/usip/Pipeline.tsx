import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Field, fmt$, FormDialog, SelectField } from "@/components/usip/Common";
import { PageHeader, Shell } from "@/components/usip/Shell";
import { RecordDrawer } from "@/components/usip/RecordDrawer";
import { trpc } from "@/lib/trpc";
import { Brain, Download, Loader2, Plus, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const STAGES = [
  { id: "discovery", label: "Discovery" },
  { id: "qualified", label: "Qualified" },
  { id: "proposal", label: "Proposal" },
  { id: "negotiation", label: "Negotiation" },
  { id: "won", label: "Won" },
  { id: "lost", label: "Lost" },
] as const;

function WinProbBadge({ prob, aiGenerated }: { prob: number; aiGenerated?: boolean }) {
  const color =
    prob >= 70
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
      : prob >= 40
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
      : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-1.5 py-0.5 rounded-full ${color}`}>
      {aiGenerated && <Brain className="size-2.5" />}
      {prob}%
    </span>
  );
}

function DealCard({
  opp, intel, onOpen, onAnalyze, isAnalyzing,
}: {
  opp: any; intel: any | null; onOpen: () => void;
  onAnalyze: (e: React.MouseEvent) => void; isAnalyzing: boolean;
}) {
  const winProb = intel ? Math.round(Number(intel.winProbability)) : opp.winProb;
  const nba: any[] = (intel?.nextBestActions as any) ?? [];
  const topNba = nba[0] ?? null;

  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", String(opp.id))}
      onClick={onOpen}
      className="bg-card border rounded-lg p-3 cursor-pointer hover:shadow-md hover:border-[#14B89A] transition-all group"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{opp.name}</div>
          <div className="text-[11px] text-muted-foreground truncate mt-0.5">{opp.accountName}</div>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onAnalyze}
                disabled={isAnalyzing}
                className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted"
              >
                {isAnalyzing ? (
                  <Loader2 className="size-3 animate-spin text-muted-foreground" />
                ) : (
                  <Brain className="size-3 text-muted-foreground" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {isAnalyzing ? "Analyzing..." : "Run AI analysis"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <div className="flex items-center justify-between mt-2">
        <div className="font-mono text-sm tabular-nums whitespace-nowrap">{fmt$(Number(opp.value))}</div>
        <WinProbBadge prob={winProb} aiGenerated={!!intel} />
      </div>

      {intel?.winProbabilityRationale && (
        <p className="text-[10px] text-muted-foreground mt-1.5 line-clamp-2 leading-relaxed">
          {intel.winProbabilityRationale}
        </p>
      )}

      {topNba && (
        <div className="mt-2 pt-2 border-t border-dashed">
          <div className="flex items-start gap-1.5">
            <Zap
              className={`size-3 mt-0.5 shrink-0 ${
                topNba.priority === "high" ? "text-red-500"
                  : topNba.priority === "medium" ? "text-amber-500"
                  : "text-blue-500"
              }`}
            />
            <p className="text-[10px] text-foreground/80 line-clamp-2 leading-relaxed">{topNba.action}</p>
          </div>
        </div>
      )}

      {!intel && (
        <p className="text-[10px] text-muted-foreground/60 mt-2 italic">No AI analysis yet</p>
      )}
    </div>
  );
}

export default function Pipeline() {
  const utils = trpc.useUtils();
  const { data } = trpc.opportunities.board.useQuery();
  const { data: accounts } = trpc.accounts.list.useQuery();
  const { data: boardIntel = [] } = trpc.oppIntelligence.getIntelligenceForBoard.useQuery();

  const intelMap = useMemo(() => {
    const m = new Map<number, any>();
    boardIntel.forEach((i) => m.set(i.opportunityId, i));
    return m;
  }, [boardIntel]);

  const [analyzingIds, setAnalyzingIds] = useState<Set<number>>(new Set());

  const generateIntel = trpc.oppIntelligence.generateIntelligence.useMutation({
    onSuccess: (_data, vars) => {
      utils.oppIntelligence.getIntelligenceForBoard.invalidate();
      utils.opportunities.board.invalidate();
      setAnalyzingIds((prev) => { const next = new Set(prev); next.delete(vars.opportunityId); return next; });
      toast.success("AI analysis complete");
    },
    onError: (e, vars) => {
      setAnalyzingIds((prev) => { const next = new Set(prev); next.delete(vars.opportunityId); return next; });
      toast.error(e.message);
    },
  });

  const handleAnalyze = (e: React.MouseEvent, opportunityId: number) => {
    e.stopPropagation();
    setAnalyzingIds((prev) => new Set(prev).add(opportunityId));
    generateIntel.mutate({ opportunityId });
  };

  const setStage = trpc.opportunities.setStage.useMutation({
    onMutate: async ({ id, stage }) => {
      await utils.opportunities.board.cancel();
      const prev = utils.opportunities.board.getData();
      utils.opportunities.board.setData(undefined, (old) => (old ?? []).map((o) => (o.id === id ? { ...o, stage } : o)));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) utils.opportunities.board.setData(undefined, ctx.prev); toast.error("Move failed"); },
    onSettled: () => utils.opportunities.board.invalidate(),
  });

  const [addOpen, setAddOpen] = useState(false);
  const [drawer, setDrawer] = useState<{ id: number; name: string; subtitle: string } | null>(null);

  const create = trpc.opportunities.create.useMutation({
    onSuccess: () => { utils.opportunities.board.invalidate(); setAddOpen(false); toast.success("Opportunity created"); },
  });

  const grouped = useMemo(() => {
    const buckets: Record<string, typeof data> = {};
    STAGES.forEach((s) => (buckets[s.id] = []));
    (data ?? []).forEach((o) => buckets[o.stage]?.push(o));
    return buckets;
  }, [data]);

  return (
    <Shell title="Pipeline">
      <PageHeader title="Pipeline" description="Drag cards between stages. Hover a card and click the brain icon to run AI analysis.">
        <Button variant="outline" onClick={() => {
          const rows = data ?? [];
          if (!rows.length) return;
          const cols = ["id", "name", "stage", "value", "winProb", "closeDate", "accountName", "createdAt"];
          const lines = [cols.join(","), ...rows.map((r: any) => cols.map((c) => JSON.stringify(r[c] ?? "")).join(","))];
          const blob = new Blob([lines.join("\n")], { type: "text/csv" });
          const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `pipeline-${Date.now()}.csv`; a.click();
        }} disabled={!data?.length}>
          <Download className="size-4" /> Export CSV
        </Button>
        <Button onClick={() => setAddOpen(true)}><Plus className="size-4" /> New opportunity</Button>
      </PageHeader>

      <div className="p-4 overflow-x-auto">
        <div className="flex gap-3 min-w-max">
          {STAGES.map((s) => {
            const items = grouped[s.id] ?? [];
            const total = items.reduce((sum, o) => sum + Number(o.value ?? 0), 0);
            const avgProb = items.length > 0
              ? Math.round(items.reduce((sum, o) => {
                  const intel = intelMap.get(o.id);
                  return sum + (intel ? Math.round(Number(intel.winProbability)) : o.winProb);
                }, 0) / items.length)
              : null;
            return (
              <div
                key={s.id}
                className="w-72 shrink-0 bg-secondary/40 border rounded-lg flex flex-col"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const id = Number(e.dataTransfer.getData("text/plain"));
                  if (id) setStage.mutate({ id, stage: s.id });
                }}
              >
                <div className="px-3 py-2 border-b flex items-center gap-2">
                  <div className="text-sm font-medium">{s.label}</div>
                  <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{items.length} · {fmt$(total)}</span>
                    {avgProb !== null && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">avg {avgProb}%</Badge>
                    )}
                  </div>
                </div>
                <div className="flex-1 p-2 space-y-2 min-h-[60vh]">
                  {items.map((o) => (
                    <DealCard
                      key={o.id}
                      opp={o}
                      intel={intelMap.get(o.id) ?? null}
                      onOpen={() => setDrawer({
                        id: o.id,
                        name: o.name,
                        subtitle: `${o.accountName} · ${fmt$(Number(o.value))} · ${
                          intelMap.get(o.id)
                            ? `${Math.round(Number(intelMap.get(o.id)!.winProbability))}% (AI)`
                            : `${o.winProb}%`
                        }`,
                      })}
                      onAnalyze={(e) => handleAnalyze(e, o.id)}
                      isAnalyzing={analyzingIds.has(o.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <FormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="New opportunity"
        isPending={create.isPending}
        onSubmit={(f) => create.mutate({
          name: String(f.get("name")),
          accountId: Number(f.get("accountId")),
          value: Number(f.get("value")),
          stage: f.get("stage") as any,
          winProb: Number(f.get("winProb") ?? 25),
        })}
      >
        <Field name="name" label="Name" required />
        <SelectField
          name="accountId"
          label="Account"
          options={(accounts ?? []).map((a) => ({ value: String(a.id), label: a.name }))}
        />
        <div className="grid grid-cols-3 gap-3">
          <Field name="value" label="Value ($)" type="number" required defaultValue={10000} />
          <SelectField name="stage" label="Stage" options={STAGES.map((s) => ({ value: s.id, label: s.label }))} defaultValue="discovery" />
          <Field name="winProb" label="Win %" type="number" defaultValue={25} />
        </div>
      </FormDialog>

      <RecordDrawer
        open={!!drawer}
        onOpenChange={(v) => !v && setDrawer(null)}
        relatedType="opportunity"
        relatedId={drawer?.id ?? null}
        title={drawer?.name ?? ""}
        subtitle={drawer?.subtitle}
      />
    </Shell>
  );
}
