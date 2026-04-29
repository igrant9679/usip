/**
 * ARE Hub — Autonomous Revenue Engine Command Centre (Enhanced)
 *
 * Sections:
 *   1. PageHeader with live status badge and New Campaign CTA
 *   2. Pipeline funnel — 7 metric stat cards with conversion rates
 *   3. AI Agent health grid — status, last run, queue depth per agent
 *   4. Active campaigns — progress bars, autonomy mode, quick actions
 *   5. Live signal feed — colour-coded by sentiment with action badges
 */
import { Shell, PageHeader, StatCard, EmptyState, useAccentColor } from "@/components/usip/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  ArrowRight,
  Bot,
  Brain,
  CheckCircle2,
  ChevronRight,
  Clock,
  Cpu,
  ExternalLink,
  FlaskConical,
  Globe,
  Linkedin,
  Loader2,
  MessageSquare,
  Newspaper,
  Plus,
  Radar,
  RefreshCw,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
  Zap, Rocket
} from "lucide-react";
import { Link } from "wouter";
import { AreaChart, Area, ResponsiveContainer, Tooltip } from "recharts";

/* ─── helpers ─────────────────────────────────────────────────────────────── */
function pct(num: number, den: number) {
  if (!den) return "—";
  return `${((num / den) * 100).toFixed(1)}%`;
}

function FunnelBar({ value, max, color }: { value: number; max: number; color: string }) {
  const w = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${w}%`, backgroundColor: color }} />
    </div>
  );
}

const SIGNAL_COLORS: Record<string, string> = {
  positive: "#34D399",
  negative: "#F87171",
  objection: "#F59E0B",
  neutral: "#94A3B8",
  meeting_booked: "#A78BFA",
};

const SIGNAL_ICONS: Record<string, React.ElementType> = {
  email_reply: MessageSquare,
  linkedin_reply: Linkedin,
  email_open: Activity,
  meeting_booked: CheckCircle2,
  unsubscribe: TrendingDown,
};

const SOURCE_ICON: Record<string, React.ElementType> = {
  internal: Users,
  google_business: Globe,
  linkedin: Linkedin,
  web: Globe,
  news: Newspaper,
  ai_research: Brain,
};

/* ─── Agent health card ────────────────────────────────────────────────────── */
interface AgentCardProps {
  name: string;
  description: string;
  icon: React.ElementType;
  color: string;
  href: string;
  stat?: string;
  statLabel?: string;
}
function AgentCard({ name, description, icon: Icon, color, href, stat, statLabel }: AgentCardProps) {
  return (
    <Link href={href}>
      <Card className="group bg-card border hover:border-primary/30 transition-all cursor-pointer h-full hover:shadow-md">
        <CardHeader className="pb-2 pt-4 px-4">
          <div className="flex items-start justify-between gap-2">
            <div
              className="size-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ backgroundColor: color + "22" }}
            >
              <Icon className="size-4" style={{ color }} />
            </div>
            <ChevronRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mt-0.5" />
          </div>
          <CardTitle className="text-sm font-semibold mt-2">{name}</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-3">
          <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
          {stat && (
            <div className="flex items-center gap-2 pt-1 border-t">
              <div className="text-lg font-bold font-mono tabular-nums" style={{ color }}>{stat}</div>
              {statLabel && <div className="text-[11px] text-muted-foreground">{statLabel}</div>}
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

/* ─── Campaign row ─────────────────────────────────────────────────────────── */
function CampaignRow({ c }: { c: any }) {
  const total = c.prospectsDiscovered ?? 0;
  const contacted = c.prospectsContacted ?? 0;
  const replied = c.prospectsReplied ?? 0;
  const meetings = c.meetingsBooked ?? 0;
  const progress = total > 0 ? Math.round((contacted / total) * 100) : 0;

  const autonomyColor =
    c.autonomyMode === "full" ? "bg-emerald-500/15 text-emerald-600 border-emerald-500/30"
    : c.autonomyMode === "batch_approval" ? "bg-blue-500/15 text-blue-600 border-blue-500/30"
    : "bg-amber-500/15 text-amber-600 border-amber-500/30";

  return (
    <Link href={`/are/campaigns/${c.id}`}>
      <div className="group flex items-center gap-4 rounded-xl border bg-card px-4 py-3.5 hover:border-primary/30 hover:shadow-sm transition-all cursor-pointer">
        {/* Status dot */}
        <div className="size-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />

        {/* Name + progress */}
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{c.name}</span>
            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 border ${autonomyColor}`}>
              {c.autonomyMode?.replace("_", " ")}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Progress value={progress} className="h-1.5 flex-1" />
            <span className="text-[11px] text-muted-foreground shrink-0">{progress}% contacted</span>
          </div>
        </div>

        {/* Mini stats */}
        <div className="hidden sm:flex items-center gap-5 shrink-0 text-center">
          <div>
            <div className="text-sm font-semibold tabular-nums">{total}</div>
            <div className="text-[10px] text-muted-foreground">found</div>
          </div>
          <div>
            <div className="text-sm font-semibold tabular-nums">{contacted}</div>
            <div className="text-[10px] text-muted-foreground">sent</div>
          </div>
          <div>
            <div className="text-sm font-semibold tabular-nums text-emerald-600">{replied}</div>
            <div className="text-[10px] text-muted-foreground">replied</div>
          </div>
          <div>
            <div className="text-sm font-semibold tabular-nums text-violet-600">{meetings}</div>
            <div className="text-[10px] text-muted-foreground">meetings</div>
          </div>
        </div>

        <ArrowRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
      </div>
    </Link>
  );
}

/* ─── Signal row ───────────────────────────────────────────────────────────── */
function SignalRow({ s }: { s: any }) {
  const color = SIGNAL_COLORS[s.sentiment] ?? SIGNAL_COLORS.neutral;
  const Icon = SIGNAL_ICONS[s.signalType] ?? Activity;
  const actionLabel = s.actionTaken && s.actionTaken !== "no_action"
    ? s.actionTaken.replace(/_/g, " ")
    : null;

  return (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/50 transition-colors">
      <div
        className="size-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
        style={{ backgroundColor: color + "22" }}
      >
        <Icon className="size-3.5" style={{ color }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium capitalize">{s.signalType.replace(/_/g, " ")}</div>
        {s.sentimentReason && (
          <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">{s.sentimentReason}</div>
        )}
        {actionLabel && (
          <Badge variant="outline" className="mt-1 text-[10px] px-1.5 py-0 h-4 border-emerald-500/30 text-emerald-600 bg-emerald-500/10">
            {actionLabel}
          </Badge>
        )}
      </div>
      <div className="text-[10px] text-muted-foreground shrink-0 mt-0.5">
        {new Date(s.processedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </div>
    </div>
  );
}

/* ─── Main page ────────────────────────────────────────────────────────────── */
export default function AREHub() {
  const { data: campaigns, isLoading: loadingCampaigns, refetch } = trpc.are.campaigns.list.useQuery({ limit: 100 });
  const { data: signals, isLoading: loadingSignals } = trpc.are.execution.getSignalLog.useQuery({ limit: 30 });

  /* aggregate metrics */
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
  const pausedCampaigns = (campaigns ?? []).filter((c) => c.status === "paused");
  const totalCampaigns = (campaigns ?? []).length;

  /* signal breakdown */
  const positiveSignals = (signals ?? []).filter((s) => s.sentiment === "positive").length;
  const meetingSignals = (signals ?? []).filter((s) => s.signalType === "meeting_booked").length;

  /* funnel data for mini sparkline */
  const funnelData = [
    { name: "Discovered", v: totals.discovered },
    { name: "Enriched", v: totals.enriched },
    { name: "Approved", v: totals.approved },
    { name: "Contacted", v: totals.contacted },
    { name: "Replied", v: totals.replied },
    { name: "Meetings", v: totals.meetings },
    { name: "Opps", v: totals.opps },
  ];

  const AGENTS: AgentCardProps[] = [
    {
      name: "ICP Agent",
      description: "Analyses won/lost deals with LLM pattern recognition to produce a living Ideal Customer Profile — industries, titles, pain points, triggers, and anti-patterns.",
      icon: Brain,
      color: "#A78BFA",
      href: "/are/icp",
      stat: totalCampaigns > 0 ? `${activeCampaigns.length} active` : "No data",
      statLabel: "campaigns using ICP",
    },
    {
      name: "Enrich Agent",
      description: "Scores ICP match, detects trigger events (funding, hiring, product launch), extracts pain signals, and generates 3 hyper-personalised hooks per prospect.",
      icon: FlaskConical,
      color: "#60A5FA",
      href: "/are/campaigns",
      stat: totals.enriched > 0 ? String(totals.enriched) : "0",
      statLabel: "dossiers built",
    },
    {
      name: "Sequence Agent",
      description: "Writes personalised multi-step sequences, self-evaluates on specificity / clarity / brevity / CTA, and auto-rewrites until quality threshold is met.",
      icon: Sparkles,
      color: "#34D399",
      href: "/are/campaigns",
      stat: totals.approved > 0 ? String(totals.approved) : "0",
      statLabel: "sequences approved",
    },
    {
      name: "Signal Feedback Agent",
      description: "Classifies reply sentiment, determines the next action (pause / create opportunity / suppress), and feeds learning back into the ICP profile.",
      icon: Activity,
      color: "#F59E0B",
      href: "/are/campaigns",
      stat: positiveSignals > 0 ? String(positiveSignals) : "0",
      statLabel: "positive signals",
    },
  ];

  return (
    <Shell title="Revenue Engine">
      {/* ── Header ── */}
      <PageHeader
        title="Autonomous Revenue Engine" pageKey="are-hub"
        description="Command centre for your ARE engine — campaigns, ICP, and pipeline flow."
      
        icon={<Rocket className="size-5" />}
      >
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-1.5 text-xs">
          <RefreshCw className="size-3.5" />
          Refresh
        </Button>
        <Link href="/are/campaigns">
          <Button size="sm" className="gap-1.5 text-xs">
            <Plus className="size-3.5" />
            New Campaign
          </Button>
        </Link>
      </PageHeader>

      <div className="p-4 md:p-6 space-y-8 max-w-7xl mx-auto">

        {/* ── Pipeline Funnel Metrics ── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pipeline Funnel</h2>
            {loadingCampaigns && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            <StatCard label="Discovered" value={totals.discovered} hint="prospects found" />
            <StatCard label="Enriched" value={totals.enriched} hint={pct(totals.enriched, totals.discovered) + " of found"} />
            <StatCard label="Approved" value={totals.approved} hint={pct(totals.approved, totals.enriched) + " of enriched"} />
            <StatCard label="Contacted" value={totals.contacted} hint={pct(totals.contacted, totals.approved) + " of approved"} />
            <StatCard label="Replied" value={totals.replied} hint={pct(totals.replied, totals.contacted) + " reply rate"} tone={totals.replied > 0 ? "success" : undefined} />
            <StatCard label="Meetings" value={totals.meetings} hint={pct(totals.meetings, totals.replied) + " of replies"} tone={totals.meetings > 0 ? "success" : undefined} />
            <StatCard label="Opps Created" value={totals.opps} hint="pipeline generated" tone={totals.opps > 0 ? "success" : undefined} />
          </div>

          {/* Funnel visualisation */}
          {totals.discovered > 0 && (
            <div className="mt-4 rounded-xl border bg-card p-4">
              <div className="text-xs text-muted-foreground mb-3 font-medium">Funnel Drop-off</div>
              <div className="space-y-2.5">
                {funnelData.map((d, i) => (
                  <div key={d.name} className="flex items-center gap-3">
                    <div className="w-20 text-[11px] text-muted-foreground text-right shrink-0">{d.name}</div>
                    <div className="flex-1">
                      <FunnelBar
                        value={d.v}
                        max={totals.discovered}
                        color={["#60A5FA","#A78BFA","#34D399","#F59E0B","#F87171","#FB923C","#34D399"][i]}
                      />
                    </div>
                    <div className="w-12 text-[11px] font-mono tabular-nums text-right shrink-0">{d.v.toLocaleString()}</div>
                    {i > 0 && (
                      <div className="w-14 text-[10px] text-muted-foreground text-right shrink-0">
                        {pct(d.v, funnelData[i - 1].v)}
                      </div>
                    )}
                    {i === 0 && <div className="w-14 shrink-0" />}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ── Campaign overview stats ── */}
        <section>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Total Campaigns" value={totalCampaigns} hint="all time" />
            <StatCard label="Active" value={activeCampaigns.length} hint="running now" tone={activeCampaigns.length > 0 ? "success" : undefined} />
            <StatCard label="Paused" value={pausedCampaigns.length} hint="on hold" tone={pausedCampaigns.length > 0 ? "warning" : undefined} />
            <StatCard label="Meetings Booked" value={totals.meetings} hint="from ARE outreach" tone={totals.meetings > 0 ? "success" : undefined} />
          </div>
        </section>

        {/* ── AI Agents ── */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">AI Agents</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {AGENTS.map((a) => <AgentCard key={a.name} {...a} />)}
          </div>
        </section>

        {/* ── Active Campaigns + Signal Feed ── */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

          {/* Active campaigns — 3/5 */}
          <section className="lg:col-span-3 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Active Campaigns
                {activeCampaigns.length > 0 && (
                  <span className="ml-2 inline-flex items-center justify-center size-4 rounded-full bg-emerald-500/20 text-emerald-600 text-[10px] font-bold">
                    {activeCampaigns.length}
                  </span>
                )}
              </h2>
              <Link href="/are/campaigns">
                <Button variant="ghost" size="sm" className="text-xs gap-1 h-7 text-muted-foreground hover:text-foreground">
                  View all <ChevronRight className="size-3" />
                </Button>
              </Link>
            </div>

            {loadingCampaigns ? (
              <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center text-sm">
                <Loader2 className="size-4 animate-spin" /> Loading campaigns…
              </div>
            ) : activeCampaigns.length === 0 ? (
              <EmptyState
                icon={Radar}
                title="No active campaigns"
                description="Launch your first autonomous campaign to start discovering and contacting prospects."
                action={
                  <Link href="/are/campaigns">
                    <Button size="sm" className="gap-1.5">
                      <Plus className="size-3.5" /> Launch Campaign
                    </Button>
                  </Link>
                }
              />
            ) : (
              <div className="space-y-2">
                {activeCampaigns.slice(0, 6).map((c) => (
                  <CampaignRow key={c.id} c={c} />
                ))}
                {activeCampaigns.length > 6 && (
                  <Link href="/are/campaigns">
                    <div className="text-center py-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                      +{activeCampaigns.length - 6} more campaigns
                    </div>
                  </Link>
                )}
              </div>
            )}

            {/* Paused campaigns */}
            {pausedCampaigns.length > 0 && (
              <div className="mt-4 space-y-2">
                <div className="text-xs text-muted-foreground uppercase tracking-wider">Paused ({pausedCampaigns.length})</div>
                {pausedCampaigns.slice(0, 3).map((c) => (
                  <Link key={c.id} href={`/are/campaigns/${c.id}`}>
                    <div className="flex items-center gap-3 rounded-xl border bg-card/50 px-4 py-3 hover:border-primary/30 transition-all cursor-pointer opacity-70 hover:opacity-100">
                      <div className="size-2 rounded-full bg-amber-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{c.name}</div>
                        <div className="text-xs text-muted-foreground">{c.prospectsContacted ?? 0} contacted</div>
                      </div>
                      <ArrowRight className="size-4 text-muted-foreground shrink-0" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>

          {/* Signal feed — 2/5 */}
          <section className="lg:col-span-2">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Live Signals</h2>
              {loadingSignals && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            </div>

            <Card className="bg-card border">
              {!signals || signals.length === 0 ? (
                <div className="py-12 text-center">
                  <Activity className="size-8 text-muted-foreground/30 mx-auto mb-2" />
                  <div className="text-xs text-muted-foreground">
                    Signals appear here as prospects reply, open emails, or book meetings.
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-border/50 max-h-[480px] overflow-y-auto">
                  {signals.slice(0, 20).map((s) => (
                    <SignalRow key={s.id} s={s} />
                  ))}
                </div>
              )}

              {signals && signals.length > 0 && (
                <div className="px-3 py-2 border-t bg-muted/30">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{signals.length} signals logged</span>
                    <span className="text-emerald-600 font-medium">{meetingSignals} meetings booked</span>
                  </div>
                </div>
              )}
            </Card>
          </section>
        </div>

        {/* ── How it works ── */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">How the Engine Works</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { step: "01", title: "ICP Inference", desc: "The ICP Agent reads every won and lost deal in your CRM and uses an LLM to extract the ideal customer profile — no manual form-filling.", color: "#A78BFA", icon: Brain },
              { step: "02", title: "Prospect Discovery", desc: "Campaigns source prospects from your CRM, Google Business, LinkedIn, web scraping, news monitoring, and industry event attendee lists.", color: "#60A5FA", icon: Radar },
              { step: "03", title: "Enrich & Sequence", desc: "The Enrich Agent builds an intelligence dossier per prospect. The Sequence Agent writes personalised outreach and self-evaluates quality.", color: "#34D399", icon: Sparkles },
              { step: "04", title: "Send & Learn", desc: "Messages go out on the configured channels. Every reply is analysed by the Signal Feedback Agent, which updates the ICP and suppression list.", color: "#F59E0B", icon: Activity },
            ].map(({ step, title, desc, color, icon: Icon }) => (
              <div key={step} className="rounded-xl border bg-card p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <div className="text-[10px] font-bold font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: color + "22", color }}>
                    {step}
                  </div>
                  <Icon className="size-4" style={{ color }} />
                </div>
                <div className="text-sm font-semibold">{title}</div>
                <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </section>

      </div>
    </Shell>
  );
}
