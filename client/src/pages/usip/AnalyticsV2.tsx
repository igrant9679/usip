/**
 * AnalyticsV2 — the Automation → "Analytics" surface (/v2/analytics).
 *
 * The observability layer for the autonomous pipeline: the five-band revenue
 * funnel, plus pipeline/revenue and outreach performance. Read-only; pure-CSS
 * bars, no chart dependency.
 *
 * 🔴 2026-09-20: the funnel is no longer assembled here. Its five bands used to
 * come from five unrelated procs — every email the workspace had ever
 * transmitted, reply ROWS, live-only meetings, a 90-day win count — stacked
 * with "% conversion" chevrons between them, so band 2 routinely exceeded band
 * 1 and the chevron printed over 100%. One proc
 * (are.metrics.revenueFunnel) now answers all five from one population, and
 * the page's job is to render it and SAY what that population is. The rule
 * that keeps it fixed: nothing on this page may draw a conversion chevron
 * between two numbers it did not get from the same query.
 */
import { useMemo } from "react";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  BarChart3, TrendingUp, Users, Mail, MessageSquare, CalendarCheck, Trophy, ArrowDown, Share2,
} from "lucide-react";

/**
 * `email_log.source` values that are OUTREACH. The rest — proposal,
 * transactional, test, other (server/services/email/logSend.ts) — is mail the
 * workspace sends for other reasons, and counting it as outreach is why the
 * "Sent" card and the funnel's Contacted band disagreed by a factor of two
 * with nothing on screen to explain the gap.
 */
const OUTREACH_LOG_SOURCES = ["campaign", "sequence", "crm", "ai_draft", "mailbox"];

/**
 * Icon and colour per funnel band. Presentation only — the server owns the
 * labels, the order and the units, so a renamed stage cannot leave the page
 * and the help tour describing different funnels.
 */
const FUNNEL_LOOK: Record<string, { icon: typeof Mail; color: string }> = {
  sourced: { icon: Users, color: "#3B82F6" },
  contacted: { icon: Mail, color: "#8B5CF6" },
  replied: { icon: MessageSquare, color: "#6366F1" },
  meetings: { icon: CalendarCheck, color: "#059669" },
  closed: { icon: Trophy, color: "#d97706" },
};

function money(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return "$0";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return "$" + (n / 1000).toFixed(n >= 100_000 ? 0 : 1) + "k";
  return "$" + n.toFixed(0);
}

export default function AnalyticsV2() {
  const accent = useAccentColor();

  const dash = trpc.opportunities.dashboardStats.useQuery(undefined as any, { retry: false });
  const stageFunnel = trpc.opportunities.stageFunnel.useQuery(undefined as any, { retry: false });
  const winLoss = trpc.opportunities.winLoss.useQuery(undefined as any, { retry: false });
  const topReps = trpc.opportunities.topReps.useQuery(undefined as any, { retry: false });
  const seqPerf = trpc.sequences.getPerformanceAnalytics.useQuery({} as any, { retry: false });
  const taskStats = trpc.tasks.stats.useQuery();
  const meetStats = trpc.meetings.stats.useQuery();
  const convStats = trpc.conversations.stats.useQuery();
  const socialFunnel = trpc.unipile.socialFunnelStats.useQuery(undefined as any, { retry: false });

  // The whole funnel, from one query over one population. campaignId null =
  // every campaign, which is what the band labels say out loud below.
  const revFunnel = trpc.are.metrics.revenueFunnel.useQuery({ campaignId: null }, { retry: false });

  // Outreach performance reads the SITEWIDE send log (emailActivity.stats,
  // email_log 0163) — ARE campaign dispatch, sequences and mailbox sends in
  // one number, which is why it is a CARD and not a funnel band: it counts
  // messages the workspace transmitted, not people the engine reached.
  // It used to sum sequences.getPerformanceAnalytics only, a
  // product this workspace doesn't use, so the flagship analytics page said
  // "Outreach sent: 0" while the ARE campaigns had delivered hundreds
  // (owner report 2026-08-26). `enrolled` stays sequences-scoped — it is a
  // sequences concept and is labeled as such.
  // status:"sent" so bySource counts the SAME rows the `sent` total does —
  // "all" folds in unsent drafts, queued steps and inbound, and a subset that
  // is not a subset is how you get a sub-line bigger than its own headline.
  const emailStats = trpc.emailActivity.stats.useQuery({ status: "sent" }, { retry: false });
  const outreach = useMemo(() => {
    const es = (emailStats.data as any) ?? {};
    const rows = (seqPerf.data as any[]) ?? [];
    const enrolled = rows.reduce((s, r) => s + Number(r.totalEnrolled ?? 0), 0);
    const bySource = (es.bySource as Array<{ source: string; count: number }> | undefined) ?? [];
    return {
      sent: Number(es.sent ?? 0),
      openRate: Number(es.openRate ?? 0),
      clickRate: Number(es.clickRate ?? 0),
      enrolled,
      outreachSent: bySource
        .filter((r) => OUTREACH_LOG_SOURCES.indexOf(String(r.source)) >= 0)
        .reduce((s, r) => s + Number(r.count ?? 0), 0),
    };
  }, [emailStats.data, seqPerf.data]);

  const conv = convStats.data ?? { total: 0, willingToMeet: 0, meetingsProposed: 0 } as any;
  const meet = meetStats.data ?? { booked: 0, completed: 0, upcoming: 0 } as any;
  const wl = (winLoss.data as any) ?? { won: 0, lost: 0, wonValue: 0, lostValue: 0 };
  const d = (dash.data as any) ?? {};

  const funnelStages = revFunnel.data?.stages ?? [];
  const funnelMax = Math.max(1, ...funnelStages.map((f) => f.value));
  // Every meeting the workspace holds, from any source — the funnel band beside
  // it counts only engine-sourced people, so the two are labelled apart rather
  // than reconciled into one misleading number.
  const wsMeetings = revFunnel.data?.reconciliation.workspaceMeetingsBooked ?? (meet.booked ?? 0);

  // LinkedIn / Social channel funnel: invite → accept → opener → reply → interested → meeting.
  const sf = socialFunnel.data ?? { invitesSent: 0, invitesAccepted: 0, openersSent: 0, inboundReplies: 0, willingToMeet: 0, meetingsFromSocial: 0 } as any;
  const socialSteps = [
    { key: "invited", label: "Invites sent", value: sf.invitesSent ?? 0, icon: Share2, color: "#0A66C2" },
    { key: "accepted", label: "Invites accepted", value: sf.invitesAccepted ?? 0, icon: Users, color: "#3B82F6" },
    // unipile.socialFunnelStats counts every OUTBOUND DM here, not just the
    // first message of a thread; and the last band counts messages that
    // produced a meetings row, which is created `proposed` — a candidate the
    // attendee has not agreed to. Neither label said so (2026-09-20).
    { key: "openers", label: "Outbound messages", value: sf.openersSent ?? 0, icon: MessageSquare, color: "#8B5CF6" },
    { key: "replies", label: "Replies", value: sf.inboundReplies ?? 0, icon: MessageSquare, color: "#6366F1" },
    { key: "interested", label: "Interested (willing to meet)", value: sf.willingToMeet ?? 0, icon: Users, color: "#a855f7" },
    { key: "meetings", label: "Meetings proposed from social", value: sf.meetingsFromSocial ?? 0, icon: CalendarCheck, color: "#059669" },
  ];
  const socialMax = Math.max(1, ...socialSteps.map((f) => f.value));
  const socialActive = socialSteps.some((s) => s.value > 0);

  const stages = (stageFunnel.data as any[]) ?? [];
  const stageMax = Math.max(1, ...stages.map((s) => Number(s.value ?? 0)));
  const reps = (topReps.data as any[]) ?? [];

  const Stat = ({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: "good" | "ai" }) => {
    const color = tone === "good" ? "#059669" : tone === "ai" ? "#7c3aed" : accent;
    return (
      <div className="rounded-lg border bg-card p-3 shadow-sm" style={{ borderLeft: `3px solid ${color}` }}>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold tabular-nums mt-0.5" style={{ color }}>{value}</div>
        {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
      </div>
    );
  };

  return (
    <Shell title="Analytics">
      <div data-tour-id="analytics-overview" className="flex flex-col h-full min-h-0">
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <BarChart3 className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Analytics</h1>
          <span className="text-[11px] text-muted-foreground hidden sm:inline">· how the autonomous pipeline is performing</span>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-6">
          {/* Headline stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Pipeline value" value={money(d.pipelineValue)} sub={`${d.openOppsCount ?? 0} open deals`} />
            <Stat label="Closed-won (mo)" value={d.closedWonCount ?? 0} sub={money(d.totalWonValue) + " total"} tone="good" />
            <Stat label="Meetings booked" value={wsMeetings} sub={`${meet.upcoming ?? 0} upcoming · every source`} tone="good" />
            <Stat label="AI-interested replies" value={conv.willingToMeet ?? 0} sub={`of ${conv.total ?? 0} replies`} tone="ai" />
          </div>

          {/* Autonomous funnel */}
          <section>
            <h2 className="text-sm font-semibold mb-1 flex items-center gap-2"><TrendingUp className="size-4" style={{ color: accent }} /> Autonomous booking funnel</h2>
            {/* The scope, on the page, always. Five bands with no stated
                population is how four of them ended up measuring different
                people in different windows without anyone noticing. */}
            <div className="text-[11px] text-muted-foreground mb-2">All time · every campaign · people the engine sourced</div>
            <div className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
              {funnelStages.length === 0 ? (
                <div className="text-xs text-muted-foreground text-center py-4">
                  {revFunnel.isLoading ? "Loading…" : "No campaign prospects yet — the engine has nobody to count."}
                </div>
              ) : funnelStages.map((f, i) => {
                const look = FUNNEL_LOOK[f.key] ?? { icon: Mail, color: accent };
                const Icon = look.icon;
                const pct = Math.round((f.value / funnelMax) * 100);
                const prev = i > 0 ? funnelStages[i - 1] : null;
                // Only between bands measured in the SAME unit. Meetings are
                // people and Closed won is deals, so a percentage across that
                // boundary would be deals-per-person wearing a conversion
                // rate's label.
                const sameUnit = prev !== null && prev.unit === f.unit;
                const stepConv = prev && sameUnit && prev.value > 0 ? Math.round((f.value / prev.value) * 100) : null;
                return (
                  <div key={f.key}>
                    {i > 0 && (
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground pl-1 mb-1">
                        <ArrowDown className="size-3" /> {stepConv !== null ? `${stepConv}% conversion` : sameUnit ? "" : "deals, not people — no rate"}
                      </div>
                    )}
                    <div className="flex items-center gap-3">
                      <div className="w-40 shrink-0 flex items-center gap-2 text-[12px]">
                        <Icon className="size-3.5 shrink-0" style={{ color: look.color }} />
                        <span className="truncate">{f.label}</span>
                      </div>
                      <div className="flex-1 h-6 rounded bg-muted/40 overflow-hidden">
                        <div className="h-full rounded flex items-center justify-end px-2 transition-all" style={{ width: `${Math.max(pct, 6)}%`, backgroundColor: look.color }}>
                          <span className="text-[11px] font-semibold text-white tabular-nums">{f.value}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* LinkedIn / Social funnel — only shown once there's social activity */}
          {socialActive && (
            <section>
              <h2 className="text-sm font-semibold mb-2 flex items-center gap-2"><Share2 className="size-4" style={{ color: "#0A66C2" }} /> LinkedIn / Social funnel</h2>
              <div className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
                {socialSteps.map((f, i) => {
                  const pct = Math.round((f.value / socialMax) * 100);
                  const prev = i > 0 ? socialSteps[i - 1].value : null;
                  const stepConv = prev && prev > 0 ? Math.round((f.value / prev) * 100) : null;
                  return (
                    <div key={f.key}>
                      {i > 0 && (
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground pl-1 mb-1">
                          <ArrowDown className="size-3" /> {stepConv !== null ? `${stepConv}% conversion` : ""}
                        </div>
                      )}
                      <div className="flex items-center gap-3">
                        <div className="w-40 shrink-0 flex items-center gap-2 text-[12px]">
                          <f.icon className="size-3.5 shrink-0" style={{ color: f.color }} />
                          <span className="truncate">{f.label}</span>
                        </div>
                        <div className="flex-1 h-6 rounded bg-muted/40 overflow-hidden">
                          <div className="h-full rounded flex items-center justify-end px-2 transition-all" style={{ width: `${Math.max(pct, 6)}%`, backgroundColor: f.color }}>
                            <span className="text-[11px] font-semibold text-white tabular-nums">{f.value}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Pipeline by stage + Win/loss */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <section>
              <h2 className="text-sm font-semibold mb-2">Pipeline by stage</h2>
              <div className="rounded-xl border bg-card p-4 shadow-sm space-y-2.5">
                {stages.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-4">No open pipeline.</div>
                ) : stages.map((s: any) => (
                  <div key={s.stage} className="flex items-center gap-3">
                    <div className="w-24 shrink-0 text-[12px] capitalize truncate">{String(s.stage).replace(/_/g, " ")}</div>
                    <div className="flex-1 h-5 rounded bg-muted/40 overflow-hidden">
                      <div className="h-full rounded" style={{ width: `${Math.max(Math.round((Number(s.value ?? 0) / stageMax) * 100), 4)}%`, backgroundColor: accent }} />
                    </div>
                    <div className="w-24 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{money(s.value)} · {s.count}</div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h2 className="text-sm font-semibold mb-2">Win / loss (90 days)</h2>
              <div className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex items-end gap-4">
                  <div className="flex-1">
                    <div className="text-[11px] text-muted-foreground">Won</div>
                    <div className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">{wl.won ?? 0}</div>
                    <div className="text-[11px] text-muted-foreground">{money(wl.wonValue)}</div>
                  </div>
                  <div className="flex-1">
                    <div className="text-[11px] text-muted-foreground">Lost</div>
                    <div className="text-2xl font-semibold text-rose-600 dark:text-rose-400 tabular-nums">{wl.lost ?? 0}</div>
                    <div className="text-[11px] text-muted-foreground">{money(wl.lostValue)}</div>
                  </div>
                  <div className="flex-1">
                    <div className="text-[11px] text-muted-foreground">Win rate</div>
                    <div className="text-2xl font-semibold tabular-nums" style={{ color: accent }}>
                      {(wl.won + wl.lost) > 0 ? Math.round((wl.won / (wl.won + wl.lost)) * 100) : 0}%
                    </div>
                  </div>
                </div>
                <div className="mt-3 h-2.5 rounded-full overflow-hidden bg-rose-200/60 dark:bg-rose-900/30 flex">
                  <div className="h-full bg-emerald-500" style={{ width: `${(wl.won + wl.lost) > 0 ? (wl.won / (wl.won + wl.lost)) * 100 : 0}%` }} />
                </div>
              </div>
            </section>
          </div>

          {/* Outreach performance + Top reps */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <section>
              <h2 className="text-sm font-semibold mb-2 flex items-center gap-2"><Mail className="size-4" style={{ color: accent }} /> Outreach performance</h2>
              <div className="grid grid-cols-3 gap-3">
                {/* "Sent" sat six inches under the funnel's Contacted band and
                    was two to three times larger, because it counts every
                    email the workspace transmits. Named and split, so the gap
                    reads as two different questions instead of a contradiction. */}
                <Stat label="Emails transmitted" value={outreach.sent} sub={`${outreach.outreachSent.toLocaleString()} outreach · rest notifications, proposals, tests`} />
                <Stat label="Open rate" value={`${outreach.openRate}%`} />
                <Stat label="Click rate" value={`${outreach.clickRate}%`} />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-3">
                <Stat label="Enrolled (sequences)" value={outreach.enrolled} />
                <Stat label="AI tasks open" value={(taskStats.data as any)?.aiOpen ?? 0} tone="ai" />
                <Stat label="Replies to handle" value={(convStats.data as any)?.unhandled ?? 0} tone="ai" />
              </div>
            </section>

            <section>
              <h2 className="text-sm font-semibold mb-2 flex items-center gap-2"><Trophy className="size-4" style={{ color: accent }} /> Top reps</h2>
              <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
                {reps.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-6">No closed-won yet.</div>
                ) : reps.map((r: any, i: number) => (
                  <div key={r.userId ?? i} className="flex items-center gap-3 px-3 py-2 border-b border-border/60 last:border-0">
                    <span className={cn("shrink-0 size-6 rounded-full flex items-center justify-center text-[11px] font-semibold", i === 0 ? "text-white" : "bg-secondary text-muted-foreground")} style={i === 0 ? { backgroundColor: accent } : undefined}>{i + 1}</span>
                    <div className="min-w-0 flex-1 text-sm truncate">{r.name ?? `User ${r.userId}`}</div>
                    <div className="shrink-0 text-[12px] font-semibold tabular-nums" style={{ color: accent }}>{money(r.value)}</div>
                    <div className="shrink-0 w-10 text-right text-[11px] text-muted-foreground tabular-nums">{r.count}</div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </Shell>
  );
}
