/**
 * ARE Campaign Detail — full prospect review queue with AI intelligence dossiers,
 * sequence viewer, A/B variant panel, signal feed, and scraper controls.
 */
import { Shell } from "@/components/usip/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  ArrowLeft,
  Bot,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Eye,
  FlaskConical,
  Globe,
  Linkedin,
  Loader2,
  MessageSquare,
  Newspaper,
  Pause,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Sparkles,
  Target,
  Trash2,
  TrendingUp,
  Users,
  X,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "wouter";
import { toast } from "sonner";

const SOURCE_ICON: Record<string, React.ElementType> = {
  internal: Users,
  google_business: Globe,
  linkedin: Linkedin,
  web: Globe,
  news: Newspaper,
  ai_research: Brain,
};

const STATUS_COLOR: Record<string, string> = {
  pending: "#94A3B8",
  enriching: "#F59E0B",
  complete: "#34D399",
  failed: "#F87171",
};

const SEQ_STATUS_COLOR: Record<string, string> = {
  pending: "#94A3B8",
  approved: "#34D399",
  enrolled: "#60A5FA",
  skipped: "#F87171",
  completed: "#A78BFA",
  replied: "#FB923C",
};

function ProspectRow({
  p,
  campaignId,
  onSelect,
  selected,
}: {
  p: {
    id: number;
    firstName: string;
    lastName: string;
    title?: string | null;
    companyName?: string | null;
    industry?: string | null;
    sourceType: string;
    icpMatchScore?: number | null;
    enrichmentStatus: string;
    sequenceStatus: string;
  };
  campaignId: number;
  onSelect: (id: number) => void;
  selected: boolean;
}) {
  const utils = trpc.useUtils();
  const enrich = trpc.are.prospects.enrich.useMutation({
    onSuccess: () => {
      toast.success("Enrichment started");
      setTimeout(() => utils.are.prospects.list.invalidate(), 3000);
    },
    onError: (e) => toast.error(e.message),
  });
  const approve = trpc.are.prospects.approve.useMutation({
    onSuccess: () => {
      toast.success("Prospect approved");
      utils.are.prospects.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const skip = trpc.are.prospects.skip.useMutation({
    onSuccess: () => utils.are.prospects.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const genSeq = trpc.are.prospects.generateSequence.useMutation({
    onSuccess: () => {
      toast.success("Sequence generation started");
      setTimeout(() => utils.are.prospects.list.invalidate(), 5000);
    },
    onError: (e) => toast.error(e.message),
  });

  const SrcIcon = SOURCE_ICON[p.sourceType] ?? Globe;

  return (
    <div
      className={`flex items-center gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-all ${
        selected ? "border-emerald-500/50 bg-emerald-500/10" : "border-white/10 bg-white/5 hover:bg-white/10"
      }`}
      onClick={() => onSelect(p.id)}
    >
      <SrcIcon className="size-4 text-white/30 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white truncate">{p.firstName} {p.lastName}</span>
          {p.icpMatchScore != null && (
            <Badge
              className="text-[10px] border-0"
              style={{
                backgroundColor: p.icpMatchScore >= 70 ? "#34D39922" : p.icpMatchScore >= 40 ? "#F59E0B22" : "#F8717122",
                color: p.icpMatchScore >= 70 ? "#34D399" : p.icpMatchScore >= 40 ? "#F59E0B" : "#F87171",
              }}
            >
              {p.icpMatchScore}% ICP
            </Badge>
          )}
        </div>
        <div className="text-xs text-white/40 truncate">
          {p.title ?? "—"} · {p.companyName ?? "—"} · {p.industry ?? "—"}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Badge
          className="text-[10px] border-0"
          style={{
            backgroundColor: STATUS_COLOR[p.enrichmentStatus] + "22",
            color: STATUS_COLOR[p.enrichmentStatus],
          }}
        >
          {p.enrichmentStatus}
        </Badge>
        <Badge
          className="text-[10px] border-0"
          style={{
            backgroundColor: SEQ_STATUS_COLOR[p.sequenceStatus] + "22",
            color: SEQ_STATUS_COLOR[p.sequenceStatus],
          }}
        >
          {p.sequenceStatus}
        </Badge>
      </div>
      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
        {p.enrichmentStatus === "pending" && (
          <Button
            size="sm"
            variant="ghost"
            className="text-blue-400 hover:text-blue-300 text-xs gap-1 h-7 px-2"
            onClick={() => enrich.mutate({ prospectId: p.id })}
            disabled={enrich.isPending}
          >
            <FlaskConical className="size-3" /> Enrich
          </Button>
        )}
        {p.enrichmentStatus === "complete" && p.sequenceStatus === "pending" && (
          <Button
            size="sm"
            variant="ghost"
            className="text-violet-400 hover:text-violet-300 text-xs gap-1 h-7 px-2"
            onClick={() => genSeq.mutate({ prospectId: p.id, campaignId })}
            disabled={genSeq.isPending}
          >
            <Sparkles className="size-3" /> Sequence
          </Button>
        )}
        {p.sequenceStatus === "pending" && p.enrichmentStatus === "complete" && (
          <Button
            size="sm"
            variant="ghost"
            className="text-emerald-400 hover:text-emerald-300 text-xs gap-1 h-7 px-2"
            onClick={() => approve.mutate({ prospectId: p.id })}
            disabled={approve.isPending}
          >
            <CheckCircle2 className="size-3" /> Approve
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-red-400/50 hover:text-red-400 text-xs h-7 px-2"
          onClick={() => skip.mutate({ prospectId: p.id })}
          disabled={skip.isPending}
        >
          <X className="size-3" />
        </Button>
      </div>
    </div>
  );
}

function IntelligencePanel({ prospectId, workspaceId }: { prospectId: number; workspaceId?: number }) {
  const { data: intel, isLoading } = trpc.are.prospects.getIntelligence.useQuery({ prospectId });

  if (isLoading) return (
    <div className="flex items-center gap-2 text-white/40 py-8 justify-center">
      <Loader2 className="size-4 animate-spin" /> Loading intelligence…
    </div>
  );

  if (!intel) return (
    <div className="text-center py-8 text-white/30 text-sm">
      No intelligence yet — run Enrich Agent first.
    </div>
  );

  const hooks = (intel.personalisationHooks as Array<{ hook: string; hookType: string }> | null) ?? [];
  const triggers = (intel.triggerEvents as Array<{ type: string; description: string; date: string }> | null) ?? [];
  const pains = (intel.painSignals as Array<{ signal: string; evidence: string; strength: number }> | null) ?? [];
  const news = (intel.recentNews as Array<{ headline: string; url: string; date: string; sentiment: string }> | null) ?? [];
  const events = (intel.industryEvents as Array<{ eventName: string; date: string; role: string }> | null) ?? [];
  const sequence = (intel.generatedSequence as Array<{ stepIndex: number; day: number; channel: string; subject?: string; body: string }> | null) ?? [];

  return (
    <div className="space-y-5 text-sm">
      {/* ICP Score */}
      <div className="flex items-center gap-3">
        <div className="text-xs text-white/40">Enrichment Confidence</div>
        <div
          className="text-sm font-bold"
          style={{ color: (intel.enrichmentConfidence ?? 0) >= 70 ? "#34D399" : "#F59E0B" }}
        >
          {intel.enrichmentConfidence ?? 0}%
        </div>
        <div className="text-xs text-white/30">· Recommended: {intel.recommendedChannel}</div>
      </div>

      {/* Company one-liner */}
      {intel.companyOneLiner && (
        <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-xs text-white/70 italic">
          "{intel.companyOneLiner}"
        </div>
      )}

      {/* Personalisation Hooks */}
      {hooks.length > 0 && (
        <div>
          <div className="text-xs text-white/40 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Sparkles className="size-3 text-emerald-400" /> Personalisation Hooks
          </div>
          <div className="space-y-2">
            {hooks.map((h, i) => (
              <div key={i} className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2">
                <div className="text-xs text-emerald-300 leading-relaxed">{h.hook}</div>
                <div className="text-[10px] text-white/30 mt-1">{h.hookType}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trigger Events */}
      {triggers.length > 0 && (
        <div>
          <div className="text-xs text-white/40 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Zap className="size-3 text-yellow-400" /> Trigger Events
          </div>
          <div className="space-y-1.5">
            {triggers.map((t, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-white/60">
                <span className="text-yellow-400 mt-0.5 shrink-0">▸</span>
                <span><strong className="text-white/80">{t.type}:</strong> {t.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pain Signals */}
      {pains.length > 0 && (
        <div>
          <div className="text-xs text-white/40 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Target className="size-3 text-red-400" /> Pain Signals
          </div>
          <div className="space-y-1.5">
            {pains.map((p, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-white/60">
                <span className="text-red-400 mt-0.5 shrink-0">▸</span>
                <span><strong className="text-white/80">{p.signal}:</strong> {p.evidence}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent News */}
      {news.length > 0 && (
        <div>
          <div className="text-xs text-white/40 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Newspaper className="size-3 text-blue-400" /> Recent News
          </div>
          <div className="space-y-1.5">
            {news.map((n, i) => (
              <div key={i} className="text-xs text-white/60">
                <span className="text-blue-300">{n.headline}</span>
                <span className="text-white/30 ml-2">{n.date}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Industry Events */}
      {events.length > 0 && (
        <div>
          <div className="text-xs text-white/40 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Activity className="size-3 text-violet-400" /> Industry Events
          </div>
          <div className="space-y-1.5">
            {events.map((e, i) => (
              <div key={i} className="text-xs text-white/60">
                <span className="text-violet-300">{e.eventName}</span>
                <span className="text-white/30 ml-2">{e.date}</span>
                {e.role && <span className="text-white/30 ml-1">· {e.role}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Generated Sequence */}
      {sequence.length > 0 && (
        <div>
          <div className="text-xs text-white/40 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <MessageSquare className="size-3 text-emerald-400" /> Generated Sequence
            <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[10px] ml-1">
              Quality: {intel.sequenceQualityScore ?? 0}/40
            </Badge>
          </div>
          <div className="space-y-3">
            {sequence.map((step) => (
              <div key={step.stepIndex} className="rounded-lg border border-white/10 bg-white/5 p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <Badge className="bg-white/10 text-white/50 border-white/10 text-[10px]">Day {step.day}</Badge>
                  <Badge className="bg-blue-500/20 text-blue-300 border-blue-500/20 text-[10px] capitalize">{step.channel}</Badge>
                  {step.subject && <span className="text-xs text-white/60 truncate">{step.subject}</span>}
                </div>
                <p className="text-xs text-white/50 leading-relaxed whitespace-pre-wrap">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ARECampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const campaignId = parseInt(id ?? "0");
  const utils = trpc.useUtils();

  const { data: campaign, isLoading: loadingCampaign } = trpc.are.campaigns.get.useQuery({ id: campaignId });
  const { data: prospects, isLoading: loadingProspects } = trpc.are.prospects.list.useQuery({ campaignId, limit: 100 });
  const { data: signals } = trpc.are.execution.getSignalLog.useQuery({ campaignId, limit: 30 });
  const { data: abVariants } = trpc.are.prospects.getAbVariants.useQuery({ campaignId });

  const [selectedProspectId, setSelectedProspectId] = useState<number | null>(null);
  const [scrapeQuery, setScrapeQuery] = useState("");
  const [scrapeSource, setScrapeSource] = useState<"google_business" | "linkedin" | "web" | "news">("google_business");

  const setStatus = trpc.are.campaigns.setStatus.useMutation({
    onSuccess: () => utils.are.campaigns.get.invalidate({ id: campaignId }),
    onError: (e) => toast.error(e.message),
  });

  const enrichBatch = trpc.are.prospects.enrichBatch.useMutation({
    onSuccess: (d) => {
      toast.success(`Enrichment started for ${d.started} prospects`);
      setTimeout(() => utils.are.prospects.list.invalidate(), 3000);
    },
    onError: (e) => toast.error(e.message),
  });

  const scrape = trpc.are.scraper.run.useMutation({
    onSuccess: (d) => {
      toast.success(`Scraped ${d.prospectsAdded} prospects from ${d.source}`);
      utils.are.prospects.list.invalidate();
      utils.are.campaigns.get.invalidate({ id: campaignId });
    },
    onError: (e) => toast.error(e.message),
  });

  if (loadingCampaign) {
    return (
      <Shell title="Campaign">
        <div className="flex items-center gap-2 text-white/40 py-24 justify-center">
          <Loader2 className="size-5 animate-spin" /> Loading…
        </div>
      </Shell>
    );
  }

  if (!campaign) {
    return (
      <Shell title="Campaign">
        <div className="p-6 text-white/40">Campaign not found.</div>
      </Shell>
    );
  }

  const selectedProspect = prospects?.find((p) => p.id === selectedProspectId);

  return (
    <Shell title={campaign.name}>
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Link href="/are/campaigns">
                <Button variant="ghost" size="sm" className="text-white/40 hover:text-white gap-1 text-xs p-0 h-auto">
                  <ArrowLeft className="size-3" /> Campaigns
                </Button>
              </Link>
            </div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-white">{campaign.name}</h1>
              <Badge
                className="text-[10px] border-0"
                style={{
                  backgroundColor: campaign.status === "active" ? "#34D39922" : "#94A3B822",
                  color: campaign.status === "active" ? "#34D399" : "#94A3B8",
                }}
              >
                {campaign.status}
              </Badge>
              <Badge className="bg-white/10 text-white/50 border-white/10 text-[10px]">{campaign.autonomyMode}</Badge>
            </div>
            {campaign.description && (
              <p className="text-xs text-white/40 mt-1">{campaign.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {campaign.status === "active" ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-yellow-400 hover:text-yellow-300 gap-1"
                onClick={() => setStatus.mutate({ id: campaignId, status: "paused" })}
              >
                <Pause className="size-4" /> Pause
              </Button>
            ) : (
              <Button
                size="sm"
                className="bg-emerald-500 hover:bg-emerald-600 text-black gap-1"
                onClick={() => setStatus.mutate({ id: campaignId, status: "active" })}
              >
                <Play className="size-4" /> Activate
              </Button>
            )}
          </div>
        </div>

        {/* Metrics Row */}
        <div className="grid grid-cols-4 sm:grid-cols-7 gap-3">
          {[
            { label: "Discovered", value: campaign.prospectsDiscovered, color: "#60A5FA" },
            { label: "Enriched", value: campaign.prospectsEnriched, color: "#A78BFA" },
            { label: "Approved", value: campaign.prospectsApproved, color: "#34D399" },
            { label: "Enrolled", value: campaign.prospectsEnrolled, color: "#F59E0B" },
            { label: "Contacted", value: campaign.prospectsContacted, color: "#FB923C" },
            { label: "Replied", value: campaign.prospectsReplied, color: "#F87171" },
            { label: "Meetings", value: campaign.meetingsBooked, color: "#34D399" },
          ].map((m) => (
            <div key={m.label} className="rounded-xl border border-white/10 bg-white/5 p-3 text-center">
              <div className="text-xl font-bold" style={{ color: m.color }}>{m.value}</div>
              <div className="text-[10px] text-white/40 uppercase tracking-wider">{m.label}</div>
            </div>
          ))}
        </div>

        <Tabs defaultValue="prospects">
          <TabsList className="bg-white/5 border border-white/10">
            <TabsTrigger value="prospects" className="text-xs data-[state=active]:bg-white/10 data-[state=active]:text-white text-white/50">
              Prospects ({prospects?.length ?? 0})
            </TabsTrigger>
            <TabsTrigger value="scraper" className="text-xs data-[state=active]:bg-white/10 data-[state=active]:text-white text-white/50">
              Scraper
            </TabsTrigger>
            <TabsTrigger value="ab" className="text-xs data-[state=active]:bg-white/10 data-[state=active]:text-white text-white/50">
              A/B Variants
            </TabsTrigger>
            <TabsTrigger value="signals" className="text-xs data-[state=active]:bg-white/10 data-[state=active]:text-white text-white/50">
              Signal Feed
            </TabsTrigger>
          </TabsList>

          {/* Prospects Tab */}
          <TabsContent value="prospects" className="mt-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs text-white/40">
                {prospects?.filter((p) => p.enrichmentStatus === "pending").length ?? 0} pending enrichment ·{" "}
                {prospects?.filter((p) => p.sequenceStatus === "pending" && p.enrichmentStatus === "complete").length ?? 0} awaiting approval
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-blue-400 hover:text-blue-300 gap-1 text-xs"
                onClick={() => enrichBatch.mutate({ campaignId, limit: 20 })}
                disabled={enrichBatch.isPending}
              >
                {enrichBatch.isPending ? <Loader2 className="size-3 animate-spin" /> : <FlaskConical className="size-3" />}
                Enrich Batch (20)
              </Button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Prospect list */}
              <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
                {loadingProspects ? (
                  <div className="flex items-center gap-2 text-white/40 py-8 justify-center">
                    <Loader2 className="size-4 animate-spin" /> Loading…
                  </div>
                ) : !prospects || prospects.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-white/30 text-sm">
                    No prospects yet. Use the Scraper tab to discover prospects.
                  </div>
                ) : (
                  prospects.map((p) => (
                    <ProspectRow
                      key={p.id}
                      p={p}
                      campaignId={campaignId}
                      onSelect={setSelectedProspectId}
                      selected={selectedProspectId === p.id}
                    />
                  ))
                )}
              </div>

              {/* Intelligence panel */}
              <div className="rounded-xl border border-white/10 bg-white/5 p-4 max-h-[600px] overflow-y-auto">
                {!selectedProspect ? (
                  <div className="flex flex-col items-center justify-center h-40 text-white/30 text-sm gap-2">
                    <Eye className="size-6" />
                    Select a prospect to view their AI intelligence dossier
                  </div>
                ) : (
                  <>
                    <div className="mb-3 pb-3 border-b border-white/10">
                      <div className="text-sm font-medium text-white">{selectedProspect.firstName} {selectedProspect.lastName}</div>
                      <div className="text-xs text-white/40">{selectedProspect.title} · {selectedProspect.companyName}</div>
                    </div>
                    <IntelligencePanel prospectId={selectedProspect.id} />
                  </>
                )}
              </div>
            </div>
          </TabsContent>

          {/* Scraper Tab */}
          <TabsContent value="scraper" className="mt-4">
            <div className="space-y-4 max-w-xl">
              <div className="text-sm text-white/60 leading-relaxed">
                Discover new prospects from external sources. The AI extraction engine normalises all results into structured prospect records.
              </div>
              <div className="space-y-3">
                <div>
                  <div className="text-xs text-white/40 mb-1.5">Source</div>
                  <div className="flex gap-2 flex-wrap">
                    {(["google_business", "linkedin", "web", "news"] as const).map((s) => {
                      const Icon = SOURCE_ICON[s] ?? Globe;
                      return (
                        <button
                          key={s}
                          onClick={() => setScrapeSource(s)}
                          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-all ${
                            scrapeSource === s
                              ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400"
                              : "border-white/10 bg-white/5 text-white/50 hover:bg-white/10"
                          }`}
                        >
                          <Icon className="size-3" />
                          {s.replace("_", " ")}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-white/40 mb-1.5">Search Query / Topic</div>
                  <div className="flex gap-2">
                    <input
                      value={scrapeQuery}
                      onChange={(e) => setScrapeQuery(e.target.value)}
                      placeholder={
                        scrapeSource === "google_business" ? "e.g. SaaS companies London"
                        : scrapeSource === "linkedin" ? "e.g. VP Sales fintech"
                        : scrapeSource === "news" ? "e.g. Series B funding 2024"
                        : "e.g. B2B software companies hiring"
                      }
                      className="flex-1 rounded-lg border border-white/10 bg-white/5 text-white text-sm px-3 py-2 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/50"
                    />
                    <Button
                      onClick={() => scrape.mutate({ campaignId, source: scrapeSource, query: scrapeQuery, limit: 20 })}
                      disabled={scrape.isPending || !scrapeQuery.trim()}
                      className="bg-emerald-500 hover:bg-emerald-600 text-black gap-2"
                    >
                      {scrape.isPending ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                      Scrape
                    </Button>
                  </div>
                </div>
                <div className="text-xs text-white/30 leading-relaxed">
                  The AI extraction engine will parse results and add qualifying prospects to the queue.
                  Google Business returns company listings with contact info. LinkedIn returns people profiles.
                  News returns companies making relevant announcements. Web returns general directory results.
                </div>
              </div>
            </div>
          </TabsContent>

          {/* A/B Variants Tab */}
          <TabsContent value="ab" className="mt-4">
            {!abVariants || abVariants.length === 0 ? (
              <div className="text-center py-8 text-white/30 text-sm">
                No A/B variants yet — generate sequences for prospects to see variants here.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="text-xs text-white/40 leading-relaxed">
                  The Sequence Agent automatically generates two variants per step: Variant A uses a personalisation hook,
                  Variant B uses a trigger event hook. Performance data updates as messages are sent.
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {abVariants.map((v) => (
                    <Card key={v.id} className="bg-white/5 border-white/10">
                      <CardHeader className="pb-2">
                        <div className="flex items-center gap-2">
                          <Badge
                            className="text-[10px] border-0"
                            style={{
                              backgroundColor: v.variantKey === "A" ? "#34D39922" : "#60A5FA22",
                              color: v.variantKey === "A" ? "#34D399" : "#60A5FA",
                            }}
                          >
                            Variant {v.variantKey}
                          </Badge>
                          <span className="text-xs text-white/50">Step {v.stepIndex}</span>
                          <Badge className="bg-white/10 text-white/40 border-white/10 text-[10px]">{v.hookType}</Badge>
                        </div>
                        {v.subjectLine && (
                          <div className="text-xs text-white/70 font-medium mt-1">{v.subjectLine}</div>
                        )}
                      </CardHeader>
                      <CardContent>
                        <p className="text-xs text-white/50 leading-relaxed">{v.bodyPreview}</p>
                        <div className="flex items-center gap-4 mt-3 text-[10px] text-white/30">
                          <span>Sent: {v.sentCount}</span>
                          <span>Opens: {v.openCount}</span>
                          <span>Replies: {v.replyCount}</span>
                          {v.sentCount > 0 && (
                            <span className="text-emerald-400">
                              {((v.replyCount / v.sentCount) * 100).toFixed(1)}% reply rate
                            </span>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>

          {/* Signal Feed Tab */}
          <TabsContent value="signals" className="mt-4">
            {!signals || signals.length === 0 ? (
              <div className="text-center py-8 text-white/30 text-sm">
                No signals yet — signals appear here as prospects engage with your outreach.
              </div>
            ) : (
              <div className="space-y-2">
                {signals.map((s) => {
                  const sentimentColor =
                    s.sentiment === "positive" ? "#34D399"
                    : s.sentiment === "negative" ? "#F87171"
                    : s.sentiment === "objection" ? "#F59E0B"
                    : "#94A3B8";
                  return (
                    <div key={s.id} className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                      <div className="size-2 rounded-full mt-1.5 shrink-0" style={{ backgroundColor: sentimentColor }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-white/70 font-medium">{s.signalType.replace(/_/g, " ")}</div>
                        {s.sentimentReason && (
                          <div className="text-xs text-white/40 mt-0.5">{s.sentimentReason}</div>
                        )}
                        {s.actionTaken && s.actionTaken !== "no_action" && (
                          <div className="text-xs text-emerald-400/70 mt-0.5">Action: {s.actionTaken.replace(/_/g, " ")}</div>
                        )}
                      </div>
                      <div className="text-[10px] text-white/30 shrink-0">
                        {new Date(s.processedAt).toLocaleString()}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </Shell>
  );
}
