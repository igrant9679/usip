/**
 * ICP Agent Page — View and manage the AI-inferred Ideal Customer Profile
 */
import { Shell } from "@/components/usip/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Brain, CheckCircle2, Loader2, RefreshCw, Sparkles, TrendingUp } from "lucide-react";
import { toast } from "sonner";

export default function AREIcpAgent() {
  const utils = trpc.useUtils();
  const { data: icp, isLoading } = trpc.are.icp.getCurrent.useQuery();
  const { data: history } = trpc.are.icp.getHistory.useQuery({ limit: 5 });
  const regenerate = trpc.are.icp.regenerate.useMutation({
    onSuccess: () => {
      toast.success("ICP Agent triggered — re-inference running in the background.");
      setTimeout(() => utils.are.icp.getCurrent.invalidate(), 5000);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Shell title="ICP Agent">
      <div className="p-6 space-y-8 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Brain className="size-5 text-violet-400" />
              <h1 className="text-xl font-bold text-white">ICP Agent</h1>
              <Badge className="bg-violet-500/20 text-violet-400 border-violet-500/30 text-[10px]">AI-Inferred</Badge>
            </div>
            <p className="text-sm text-white/50 max-w-xl">
              The ICP Agent analyses your historical won and lost deals, extracts champion titles, industry patterns, and deal
              velocity signals, then produces a living Ideal Customer Profile — no manual form-filling required.
            </p>
          </div>
          <Button
            onClick={() => regenerate.mutate()}
            disabled={regenerate.isPending}
            className="bg-violet-500 hover:bg-violet-600 text-white gap-2 shrink-0"
          >
            {regenerate.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Re-infer ICP
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-white/40 py-12 justify-center">
            <Loader2 className="size-5 animate-spin" /> Loading ICP…
          </div>
        ) : !icp ? (
          <div className="rounded-xl border border-dashed border-white/10 p-12 text-center">
            <Brain className="size-10 text-white/20 mx-auto mb-3" />
            <div className="text-white/50 mb-4">No ICP profile yet. Click "Re-infer ICP" to have the AI analyse your deal history.</div>
            <Button onClick={() => regenerate.mutate()} disabled={regenerate.isPending} className="bg-violet-500 hover:bg-violet-600 text-white gap-2">
              {regenerate.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              Generate ICP
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Summary */}
            <Card className="bg-white/5 border-white/10">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm text-white flex items-center gap-2">
                    <CheckCircle2 className="size-4 text-emerald-400" />
                    Active ICP — v{icp.version}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[10px]">
                      Confidence: {icp.confidenceScore ?? 0}%
                    </Badge>
                    <span className="text-[10px] text-white/30">
                      Updated {new Date(icp.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {icp.summary && (
                  <p className="text-sm text-white/70 leading-relaxed border-l-2 border-violet-500/50 pl-3">{icp.summary}</p>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Target Industries */}
                  <div>
                    <div className="text-xs text-white/40 uppercase tracking-wider mb-2">Target Industries</div>
                    <div className="flex flex-wrap gap-1.5">
                      {((icp.targetIndustries as string[]) ?? []).map((ind) => (
                        <Badge key={ind} className="bg-blue-500/20 text-blue-300 border-blue-500/20 text-[11px]">{ind}</Badge>
                      ))}
                    </div>
                  </div>

                  {/* Target Titles */}
                  <div>
                    <div className="text-xs text-white/40 uppercase tracking-wider mb-2">Champion Titles</div>
                    <div className="flex flex-wrap gap-1.5">
                      {((icp.targetTitles as string[]) ?? []).map((t) => (
                        <Badge key={t} className="bg-violet-500/20 text-violet-300 border-violet-500/20 text-[11px]">{t}</Badge>
                      ))}
                    </div>
                  </div>

                  {/* Company Size */}
                  <div>
                    <div className="text-xs text-white/40 uppercase tracking-wider mb-2">Company Size</div>
                    <div className="text-sm text-white/80">
                      {icp.targetCompanySizeMin ?? "?"} – {icp.targetCompanySizeMax ?? "?"} employees
                    </div>
                  </div>

                  {/* Geographies */}
                  <div>
                    <div className="text-xs text-white/40 uppercase tracking-wider mb-2">Target Geographies</div>
                    <div className="flex flex-wrap gap-1.5">
                      {((icp.targetGeographies as string[]) ?? []).map((g) => (
                        <Badge key={g} className="bg-emerald-500/20 text-emerald-300 border-emerald-500/20 text-[11px]">{g}</Badge>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Pain Points */}
                {(icp.commonPainPoints as string[] | null)?.length ? (
                  <div>
                    <div className="text-xs text-white/40 uppercase tracking-wider mb-2">Common Pain Points</div>
                    <ul className="space-y-1">
                      {(icp.commonPainPoints as string[]).map((p, i) => (
                        <li key={i} className="text-xs text-white/60 flex items-start gap-2">
                          <span className="text-orange-400 mt-0.5">▸</span> {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {/* Buying Triggers */}
                {(icp.buyingTriggers as string[] | null)?.length ? (
                  <div>
                    <div className="text-xs text-white/40 uppercase tracking-wider mb-2">Buying Triggers</div>
                    <ul className="space-y-1">
                      {(icp.buyingTriggers as string[]).map((t, i) => (
                        <li key={i} className="text-xs text-white/60 flex items-start gap-2">
                          <span className="text-emerald-400 mt-0.5">✓</span> {t}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {/* Anti-patterns */}
                {(icp.antiPatterns as string[] | null)?.length ? (
                  <div>
                    <div className="text-xs text-white/40 uppercase tracking-wider mb-2">Anti-Patterns (Disqualifiers)</div>
                    <ul className="space-y-1">
                      {(icp.antiPatterns as string[]).map((a, i) => (
                        <li key={i} className="text-xs text-white/60 flex items-start gap-2">
                          <span className="text-red-400 mt-0.5">✗</span> {a}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {/* Evidence Summary */}
                {icp.evidenceSummary && (
                  <div>
                    <div className="text-xs text-white/40 uppercase tracking-wider mb-2">Evidence Summary</div>
                    <p className="text-xs text-white/50 leading-relaxed">{String(icp.evidenceSummary)}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Version History */}
            {history && history.length > 1 && (
              <div>
                <div className="text-xs text-white/40 uppercase tracking-wider mb-3">Version History</div>
                <div className="space-y-2">
                  {history.slice(1).map((h) => (
                    <div key={h.id} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/5 px-3 py-2">
                      <TrendingUp className="size-3.5 text-white/30 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-xs text-white/60">v{h.version}</span>
                        <span className="text-xs text-white/30 ml-2">{new Date(h.updatedAt).toLocaleDateString()}</span>
                      </div>
                      <Badge className="bg-white/10 text-white/40 border-white/10 text-[10px]">
                        {h.confidenceScore ?? 0}% confidence
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Shell>
  );
}
