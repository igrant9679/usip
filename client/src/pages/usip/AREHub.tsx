/**
 * ARE Hub — Autonomous Revenue Engine Command Centre
 *
 * Top-level dashboard showing:
 *   - Live campaign metrics (discovered / enriched / approved / contacted / replied / meetings)
 *   - Agent status cards (ICP Agent, Enrich Agent, Sequence Agent, Signal Agent)
 *   - Recent signal feed
 *   - Quick-launch for new campaigns
 */
import { Shell } from "@/components/usip/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  ArrowRight,
  Bot,
  Brain,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Eye,
  FlaskConical,
  Loader2,
  MessageSquare,
  Plus,
  Radar,
  RefreshCw,
  Sparkles,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import { Link } from "wouter";

const AGENT_CARDS = [
  {
    id: "icp",
    name: "ICP Agent",
    description: "Continuously analyses won/lost deals to refine the Ideal Customer Profile using LLM pattern recognition.",
    icon: Brain,
    color: "#A78BFA",
    href: "/are/icp",
  },
  {
    id: "enrich",
    name: "Enrich Agent",
    description: "Scores ICP match, detects trigger events, extracts pain signals, and generates 3 personalisation hooks per prospect.",
    icon: FlaskConical,
    color: "#60A5FA",
    href: "/are/campaigns",
  },
  {
    id: "sequence",
    name: "Sequence Agent",
    description: "Writes personalised multi-step sequences, self-evaluates on 4 quality dimensions, and auto-rewrites until threshold is met.",
    icon: Sparkles,
    color: "#34D399",
    href: "/are/campaigns",
  },
  {
    id: "signal",
    name: "Signal Feedback Agent",
    description: "Analyses reply sentiment, determines action (pause / create opp / suppress), and feeds learning back into the ICP.",
    icon: Activity,
    color: "#F59E0B",
    href: "/are/campaigns",
  },
];

function MetricCard({ label, value, sub, color }: { label: string; value: number | string; sub?: string; color: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4 flex flex-col gap-1">
      <div className="text-xs text-white/50 uppercase tracking-wider">{label}</div>
      <div className="text-3xl font-bold" style={{ color }}>{value}</div>
      {sub && <div className="text-xs text-white/40">{sub}</div>}
    </div>
  );
}

export default function AREHub() {
  const { data: campaigns, isLoading: loadingCampaigns } = trpc.are.campaigns.list.useQuery({ limit: 100 });
  const { data: signals } = trpc.are.execution.getSignalLog.useQuery({ limit: 20 });

  // Aggregate metrics across all campaigns
  const totals = (campaigns ?? []).reduce(
    (acc, c) => ({
      discovered: acc.discovered + (c.prospectsDiscovered ?? 0),
      enriched: acc.enriched + (c.prospectsEnriched ?? 0),
      approved: acc.approved + (c.prospectsApproved ?? 0),
      contacted: acc.contacted + (c.prospectsContacted ?? 0),
      replied: acc.replied + (c.prospectsReplied ?? 0),
      meetings: acc.meetings + (c.meetingsBooked ?? 0),
      opps: acc.opps + (c.opportunitiesCreated ?? 0),
    }),
    { discovered: 0, enriched: 0, approved: 0, contacted: 0, replied: 0, meetings: 0, opps: 0 },
  );

  const activeCampaigns = (campaigns ?? []).filter((c) => c.status === "active");
  const replyRate = totals.contacted > 0 ? ((totals.replied / totals.contacted) * 100).toFixed(1) : "0.0";
  const meetingRate = totals.replied > 0 ? ((totals.meetings / totals.replied) * 100).toFixed(1) : "0.0";

  return (
    <Shell title="Revenue Engine">
      <div className="p-6 space-y-8 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Bot className="size-6 text-emerald-400" />
              <h1 className="text-2xl font-bold text-white">Autonomous Revenue Engine</h1>
              <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[10px] uppercase tracking-wider">
                AI-Native
              </Badge>
            </div>
            <p className="text-sm text-white/50 max-w-2xl">
              End-to-end autonomous prospecting: the ICP Agent learns from your wins, the Enrich Agent builds intelligence dossiers,
              the Sequence Agent writes and self-evaluates personalised outreach, and the Signal Feedback Agent closes the loop.
            </p>
          </div>
          <Link href="/are/campaigns">
            <Button className="bg-emerald-500 hover:bg-emerald-600 text-black gap-2 shrink-0">
              <Plus className="size-4" />
              New Campaign
            </Button>
          </Link>
        </div>

        {/* Live Metrics */}
        <div>
          <div className="text-xs text-white/40 uppercase tracking-wider mb-3">Live Pipeline Metrics</div>
          {loadingCampaigns ? (
            <div className="flex items-center gap-2 text-white/40"><Loader2 className="size-4 animate-spin" /> Loading…</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              <MetricCard label="Discovered" value={totals.discovered} sub="prospects found" color="#60A5FA" />
              <MetricCard label="Enriched" value={totals.enriched} sub="AI dossiers built" color="#A78BFA" />
              <MetricCard label="Approved" value={totals.approved} sub="ready to send" color="#34D399" />
              <MetricCard label="Contacted" value={totals.contacted} sub="messages sent" color="#F59E0B" />
              <MetricCard label="Replied" value={totals.replied} sub={`${replyRate}% reply rate`} color="#F87171" />
              <MetricCard label="Meetings" value={totals.meetings} sub={`${meetingRate}% of replies`} color="#FB923C" />
              <MetricCard label="Opps" value={totals.opps} sub="pipeline created" color="#34D399" />
            </div>
          )}
        </div>

        {/* Active Campaigns */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs text-white/40 uppercase tracking-wider">Active Campaigns ({activeCampaigns.length})</div>
            <Link href="/are/campaigns">
              <Button variant="ghost" size="sm" className="text-white/50 hover:text-white gap-1 text-xs">
                View all <ChevronRight className="size-3" />
              </Button>
            </Link>
          </div>
          {activeCampaigns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 p-8 text-center">
              <Radar className="size-8 text-white/20 mx-auto mb-2" />
              <div className="text-white/40 text-sm">No active campaigns yet.</div>
              <Link href="/are/campaigns">
                <Button size="sm" className="mt-3 bg-emerald-500 hover:bg-emerald-600 text-black gap-2">
                  <Plus className="size-3" /> Launch first campaign
                </Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {activeCampaigns.slice(0, 5).map((c) => (
                <Link key={c.id} href={`/are/campaigns/${c.id}`}>
                  <div className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3 hover:bg-white/10 transition-colors cursor-pointer">
                    <div className="size-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-white truncate">{c.name}</div>
                      <div className="text-xs text-white/40">
                        {c.prospectsDiscovered} discovered · {c.prospectsEnriched} enriched · {c.prospectsContacted} contacted
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <Badge className="bg-white/10 text-white/60 border-white/10 text-[10px]">{c.autonomyMode}</Badge>
                      <ArrowRight className="size-4 text-white/30" />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* AI Agent Cards */}
        <div>
          <div className="text-xs text-white/40 uppercase tracking-wider mb-3">AI Agents</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {AGENT_CARDS.map((agent) => {
              const Icon = agent.icon;
              return (
                <Link key={agent.id} href={agent.href}>
                  <Card className="bg-white/5 border-white/10 hover:bg-white/10 transition-colors cursor-pointer h-full">
                    <CardHeader className="pb-2">
                      <div className="flex items-center gap-2">
                        <div
                          className="size-8 rounded-lg flex items-center justify-center"
                          style={{ backgroundColor: agent.color + "22" }}
                        >
                          <Icon className="size-4" style={{ color: agent.color }} />
                        </div>
                        <CardTitle className="text-sm text-white">{agent.name}</CardTitle>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-xs text-white/50 leading-relaxed">{agent.description}</p>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        </div>

        {/* Signal Feed */}
        <div>
          <div className="text-xs text-white/40 uppercase tracking-wider mb-3">Recent Signals</div>
          {!signals || signals.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 p-6 text-center text-white/30 text-sm">
              No signals yet — signals appear here as prospects reply, open emails, or book meetings.
            </div>
          ) : (
            <div className="space-y-1.5">
              {signals.slice(0, 10).map((s) => {
                const sentimentColor =
                  s.sentiment === "positive" ? "#34D399"
                  : s.sentiment === "negative" ? "#F87171"
                  : s.sentiment === "objection" ? "#F59E0B"
                  : "#94A3B8";
                return (
                  <div key={s.id} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/5 px-3 py-2">
                    <div className="size-2 rounded-full shrink-0" style={{ backgroundColor: sentimentColor }} />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs text-white/70">{s.signalType.replace(/_/g, " ")}</span>
                      {s.sentimentReason && (
                        <span className="text-xs text-white/40 ml-2">— {s.sentimentReason}</span>
                      )}
                    </div>
                    {s.actionTaken && (
                      <Badge className="bg-white/10 text-white/50 border-white/10 text-[10px] shrink-0">
                        {s.actionTaken.replace(/_/g, " ")}
                      </Badge>
                    )}
                    <div className="text-[10px] text-white/30 shrink-0">
                      {new Date(s.processedAt).toLocaleTimeString()}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
