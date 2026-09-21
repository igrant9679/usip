/**
 * IntelligenceDossier — the enrichment dossier for ONE campaign queue row
 * (prospect_intelligence is keyed by prospect_queue.id). Extracted from
 * ARECampaignDetail 2026-09-20 so the person record (/prospects/:id) can
 * show the same dossier — pass { id: queueId }.
 */
import { trpc } from "@/lib/trpc";
import { UNSENDABLE_CHANNEL_REASON, isSendableChannel } from "@shared/areSequenceSteps";
import { EmptyState } from "@/components/usip/Shell";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Activity, FlaskConical, Loader2, MessageSquare, Newspaper, Sparkles, Target, Zap,
} from "lucide-react";

export function IntelligenceDossier({ prospect }: { prospect: any }) {
  const { data: intel, isLoading } = trpc.are.prospects.getIntelligence.useQuery(
    { prospectId: prospect.id },
    { enabled: !!prospect.id },
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-16 justify-center">
        <Loader2 className="size-4 animate-spin" /> Building intelligence dossier…
      </div>
    );
  }

  if (!intel) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="No intelligence yet"
        description="Run the Enrich Agent on this prospect to generate their intelligence dossier."
      />
    );
  }

  const hooks = (intel.personalisationHooks as Array<{ hook: string; hookType: string }> | null) ?? [];
  const triggers = (intel.triggerEvents as Array<{ type: string; description: string; date?: string }> | null) ?? [];
  const pains = (intel.painSignals as Array<{ signal: string; evidence: string; strength: number }> | null) ?? [];
  const news = (intel.recentNews as Array<{ headline: string; url?: string; date?: string; sentiment?: string }> | null) ?? [];
  const events = (intel.industryEvents as Array<{ eventName: string; date?: string; role?: string }> | null) ?? [];
  const sequence = (intel.generatedSequence as Array<{ stepIndex: number; day: number; channel: string; subject?: string; body: string }> | null) ?? [];
  const qualityScore = intel.sequenceQualityScore ?? 0;
  const recommendedChannel = typeof intel.recommendedChannel === "string" ? intel.recommendedChannel : "email";

  return (
    <div className="space-y-6 pb-8">
      {/* Confidence + channel */}
      <div className="flex items-center gap-4 p-3 rounded-xl bg-muted/50 border">
        <div className="text-center">
          <div className="text-2xl font-bold tabular-nums" style={{ color: (intel.enrichmentConfidence ?? 0) >= 70 ? "#34D399" : "#F59E0B" }}>
            {intel.enrichmentConfidence ?? 0}%
          </div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Confidence</div>
        </div>
        <Separator orientation="vertical" className="h-10" />
        <div>
          {/* The enricher used to be asked for one of email/linkedin/sms/voice
              and whatever it picked was printed here as advice. A prospect
              "best reached by SMS" is not advice when nothing in the product
              can send one — the value still shows (it is what is stored) but
              it is labelled for what it is. 2026-09-20. */}
          <div className="text-sm font-medium capitalize">{recommendedChannel}</div>
          <div className="text-[10px] text-muted-foreground">
            Recommended channel
            {!isSendableChannel(recommendedChannel) && (
              <span className="ml-1 text-amber-600" title={UNSENDABLE_CHANNEL_REASON[recommendedChannel]}>
                · not available
              </span>
            )}
          </div>
        </div>
        {typeof intel.recommendedTiming === "string" && intel.recommendedTiming.length > 0 && (
          <>
            <Separator orientation="vertical" className="h-10" />
            <div>
              <div className="text-sm font-medium">{intel.recommendedTiming}</div>
              <div className="text-[10px] text-muted-foreground">Best timing</div>
            </div>
          </>
        )}
      </div>

      {/* Company one-liner */}
      {typeof intel.companyOneLiner === "string" && intel.companyOneLiner.length > 0 && (
        <blockquote className="border-l-4 border-primary/40 pl-3 py-1 text-sm text-muted-foreground italic">
          {intel.companyOneLiner}
        </blockquote>
      )}

      {/* Personalisation hooks */}
      {hooks.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            <Sparkles className="size-3 text-emerald-500" /> Personalisation Hooks
          </div>
          <div className="space-y-2">
            {hooks.map((h, i) => (
              <div key={i} className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
                <div className="text-xs leading-relaxed">{h.hook}</div>
                <div className="text-[10px] text-muted-foreground mt-1 capitalize">{h.hookType?.replace(/_/g, " ")}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trigger events */}
      {triggers.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            <Zap className="size-3 text-amber-500" /> Trigger Events
          </div>
          <div className="space-y-1.5">
            {triggers.map((t, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className="text-amber-500 mt-0.5 shrink-0">▸</span>
                <div>
                  <span className="font-medium">{t.type}: </span>
                  <span className="text-muted-foreground">{t.description}</span>
                  {t.date && <span className="text-muted-foreground/60 ml-1">({t.date})</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pain signals */}
      {pains.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            <Target className="size-3 text-red-500" /> Pain Signals
          </div>
          <div className="space-y-2">
            {pains.map((p, i) => (
              <div key={i} className="rounded-lg border bg-card px-3 py-2">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-xs font-medium">{p.signal}</span>
                  <div className="flex items-center gap-1">
                    {Array.from({ length: 5 }).map((_, j) => (
                      <div key={j} className={`size-1.5 rounded-full ${j < (p.strength ?? 0) ? "bg-red-500" : "bg-muted"}`} />
                    ))}
                  </div>
                </div>
                <div className="text-[11px] text-muted-foreground">{p.evidence}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent news */}
      {news.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            <Newspaper className="size-3 text-blue-500" /> Recent News
          </div>
          <div className="space-y-1.5">
            {news.map((n, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <div className="size-1.5 rounded-full bg-blue-400 mt-1.5 shrink-0" />
                <div>
                  <span className="text-blue-600 dark:text-blue-400">{n.headline}</span>
                  {n.date && <span className="text-muted-foreground ml-2">{n.date}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Industry events */}
      {events.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            <Activity className="size-3 text-violet-500" /> Industry Events
          </div>
          <div className="space-y-1.5">
            {events.map((e, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <div className="size-1.5 rounded-full bg-violet-400 mt-1.5 shrink-0" />
                <div>
                  <span className="font-medium">{e.eventName}</span>
                  {e.date && <span className="text-muted-foreground ml-2">{e.date}</span>}
                  {e.role && <span className="text-muted-foreground"> · {e.role}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Generated sequence */}
      {sequence.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <MessageSquare className="size-3 text-emerald-500" /> Generated Sequence
            </div>
            <div className="flex items-center gap-2">
              <div className="text-[11px] text-muted-foreground">Quality</div>
              <div className="w-20">
                <Progress value={(qualityScore / 40) * 100} className="h-1.5" />
              </div>
              <div className="text-[11px] font-mono tabular-nums text-emerald-600">{qualityScore}/40</div>
            </div>
          </div>
          <div className="space-y-3">
            {sequence.map((step) => (
              <div key={step.stepIndex} className="rounded-xl border bg-card p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5">Day {step.day}</Badge>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 border-blue-500/30 text-blue-600 bg-blue-500/10 capitalize">
                    {step.channel}
                  </Badge>
                  {/* Sequences written before 2026-09-20 carry sms/voice steps
                      the engine skips. Saying so here beats a step that reads
                      as scheduled and silently never leaves. */}
                  {!isSendableChannel(step.channel) && (
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 h-5 border-amber-500/30 text-amber-600 bg-amber-500/10"
                      title={UNSENDABLE_CHANNEL_REASON[String(step.channel ?? "").toLowerCase()]}
                    >
                      will not send
                    </Badge>
                  )}
                  {step.subject && (
                    <span className="text-xs font-medium truncate flex-1">{step.subject}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default IntelligenceDossier;
