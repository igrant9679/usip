/**
 * AREPerformance — "What's Working" (/are/performance)
 *
 * Phase 1 of the continuous-optimisation layer. The honest measurement surface:
 * it reports what the outbound machine actually produced, with NO AI and no
 * recommendations. Later phases propose (and, in Auto, apply) tweaks — those
 * proposals are only trustworthy if this screen's numbers are right, so this
 * ships and gets reviewed first.
 *
 * Three deliberate rules, because a dashboard that flatters is worse than none:
 *   1. Rank by OUTCOMES, not volume. A source that finds 500 prospects and books
 *      nothing ranks below one that finds 20 and books three.
 *   2. Never render a rate off a tiny denominator without saying so — a "0%
 *      reply rate" from 3 sends is noise, not a finding.
 *   3. Distinguish "measured zero" from "not measured". ARE campaign sends carry
 *      no tracking pixel, so opens are reported as unavailable, never as 0.
 */
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Shell, PageHeader, SubNav, StatCard, EmptyState, useAccentColor } from "@/components/usip/Shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, Info, Loader2, MailOpen, Radar, TrendingUp } from "lucide-react";

/** Below this many sends a per-row rate is noise; we show the count, not a verdict. */
const MIN_ROW_SAMPLE = 20;

const SOURCE_LABEL: Record<string, string> = {
  internal_contact: "Internal — contacts",
  internal_lead: "Internal — leads",
  google_business: "Google Business",
  linkedin_company: "LinkedIn — companies",
  linkedin_people: "LinkedIn — people",
  web_scrape: "Web scrape",
  news_event: "News event",
  industry_event: "Industry event",
  apollo: "Apollo.io",
  zoominfo: "ZoomInfo",
  clay: "Clay",
  ai_research: "AI research",
};

const REPLY_LABEL: Record<string, string> = {
  willing_to_meet: "Willing to meet",
  follow_up_question: "Follow-up question",
  person_referral: "Referral to someone else",
  out_of_office: "Out of office",
  already_left_company_or_not_right_person: "Left company / wrong person",
  not_interested: "Not interested",
  unsubscribe: "Unsubscribe",
  none_of_the_above: "Other",
  unclassified: "Unclassified",
};

const label = (map: Record<string, string>, k: string) => map[k] ?? k.replace(/_/g, " ");

/** A rate cell that refuses to imply significance from a tiny sample. */
function RateCell({ value, sample }: { value: number; sample: number }) {
  if (sample <= 0) return <span className="text-muted-foreground">—</span>;
  const thin = sample < MIN_ROW_SAMPLE;
  return (
    <span
      className={thin ? "text-muted-foreground" : value > 0 ? "font-semibold text-emerald-600 dark:text-emerald-400" : ""}
      title={thin ? `Only ${sample} in the denominator — treat as indicative, not conclusive` : undefined}
    >
      {value.toFixed(1)}%{thin && <span className="ml-0.5 text-[10px] align-super">*</span>}
    </span>
  );
}

const th = "px-3 py-2 text-left text-[11px] font-medium text-muted-foreground whitespace-nowrap";
const td = "px-3 py-2 text-[13px] tabular-nums whitespace-nowrap border-t border-border/60";

export default function AREPerformance() {
  const accent = useAccentColor();
  const steps = trpc.are.metrics.sequenceSteps.useQuery(undefined as any, { retry: false });
  const sources = trpc.are.metrics.sourceYield.useQuery(undefined as any, { retry: false });
  const replies = trpc.are.metrics.replyMix.useQuery(undefined as any, { retry: false });

  const stepRows = steps.data ?? [];
  const sourceRows = sources.data ?? [];
  const replyRows = replies.data ?? [];

  const totalSent = stepRows.reduce((n, r) => n + r.sent, 0);
  const totalReplies = stepRows.reduce((n, r) => n + r.replies, 0);
  const totalMeetings = stepRows.reduce((n, r) => n + r.meetings, 0);
  const totalContacted = sourceRows.reduce((n, r) => n + r.contacted, 0);
  const sourceMeetings = sourceRows.reduce((n, r) => n + r.meetings, 0);
  const positive = replyRows.find((r) => r.replyClass === "willing_to_meet")?.count ?? 0;

  // The best-performing step by meetings, only once there's enough to mean it.
  const bestStep = [...stepRows]
    .filter((r) => r.sent >= MIN_ROW_SAMPLE)
    .sort((a, b) => b.meetingRate - a.meetingRate)[0];

  const loading = steps.isLoading || sources.isLoading || replies.isLoading;
  const nothingYet = !loading && stepRows.length === 0 && sourceRows.length === 0 && replyRows.length === 0;

  return (
    <Shell title="What's Working">
      <PageHeader
        title="What's Working"
        pageKey="are-performance"
        description="Measured outcomes across the outbound machine — which sequence steps, sources, and replies actually produce meetings. Reported as-is: no estimates, no projections."
        icon={<TrendingUp className="size-5" />}
      />
      <SubNav items={[
        { href: "/are", label: "Hub", title: "Revenue Engine command centre" },
        { href: "/are/performance", label: "What's Working", title: "Measured performance across the engine" },
        { href: "/are/icp", label: "ICP Agent", title: "Manage the Ideal Customer Profile agent" },
        { href: "/are/campaigns", label: "Campaigns", title: "All ARE-managed outbound campaigns" },
        { href: "/are/settings", label: "ARE Settings", title: "ARE configuration, throttles, and limits" },
      ]} />

      <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">
        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
        ) : nothingYet ? (
          <EmptyState
            icon={BarChart3}
            title="No measured activity yet"
            description="Once sequences send and prospects reply, this page reports exactly what produced meetings. Nothing here is estimated — an empty page means nothing has happened yet, not that measurement is broken."
            action={<Link href="/are/campaigns" className="text-sm font-medium hover:underline" style={{ color: accent }}>Go to campaigns</Link>}
          />
        ) : (
          <>
            {/* Headline counters — raw counts only, no derived claims. */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatCard label="Sequence emails sent" value={totalSent} hint="Drafts with status 'sent' that belong to a sequence step" />
              <StatCard label="Replies" value={totalReplies} hint="Inbound replies attributed to a sequence step" />
              <StatCard label="Willing to meet" value={positive} tone={positive > 0 ? "success" : undefined} hint="Replies classified as wanting a meeting" />
              <StatCard label="Meetings from steps" value={totalMeetings} tone={totalMeetings > 0 ? "success" : undefined} hint="Replies that produced a meeting record" />
            </div>

            {/* What is and isn't measured — stated up front, not buried. */}
            <Card className="border-dashed">
              <CardContent className="p-3.5 flex gap-2.5 text-[12px] text-muted-foreground">
                <Info className="size-4 shrink-0 mt-0.5" style={{ color: accent }} />
                <div className="space-y-1">
                  <p>
                    <span className="font-medium text-foreground">Rates marked <span className="align-super text-[10px]">*</span> come from fewer than {MIN_ROW_SAMPLE} sends</span> — directional only, not a verdict. Rows are ranked by outcome, never by volume.
                  </p>
                  <p className="flex items-center gap-1.5">
                    <MailOpen className="size-3.5 shrink-0" />
                    Sequence email opens are tracked. <span className="font-medium text-foreground">ARE campaign sends are not</span> — those go out through the sending pool with no tracking pixel, so opens are shown as unavailable rather than as zero.
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* ── Sequence step performance ── */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <BarChart3 className="size-4" style={{ color: accent }} /> Sequence steps
                  {bestStep && (
                    <span className="ml-auto text-[11px] font-normal text-muted-foreground">
                      Best: sequence {bestStep.sequenceId} · step {bestStep.stepIndex + 1} ({bestStep.meetingRate.toFixed(1)}% → meeting)
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                {stepRows.length === 0 ? (
                  <p className="px-4 pb-4 text-[13px] text-muted-foreground">No sequence email has been sent yet, so there is no per-step performance to report.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[760px]">
                      <thead>
                        <tr>
                          <th className={th}>Sequence</th>
                          <th className={th}>Step</th>
                          <th className={th}>Sent</th>
                          <th className={th}>Opens</th>
                          <th className={th}>Open rate</th>
                          <th className={th}>Replies</th>
                          <th className={th}>Reply rate</th>
                          <th className={th}>Willing to meet</th>
                          <th className={th}>Meetings</th>
                          <th className={th}>Meeting rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stepRows.map((r) => (
                          <tr key={`${r.sequenceId}-${r.stepIndex}`} className="hover:bg-muted/50">
                            <td className={td}>{r.sequenceId}</td>
                            <td className={td}>{r.stepIndex + 1}</td>
                            <td className={td}>{r.sent}</td>
                            <td className={td}>{r.opens}</td>
                            <td className={td}><RateCell value={r.openRate} sample={r.sent} /></td>
                            <td className={td}>{r.replies}</td>
                            <td className={td}><RateCell value={r.replyRate} sample={r.sent} /></td>
                            <td className={td}>{r.positiveReplies}</td>
                            <td className={td}>{r.meetings}</td>
                            <td className={td}><RateCell value={r.meetingRate} sample={r.sent} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ── Source yield ── */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Radar className="size-4" style={{ color: accent }} /> Prospect sources
                  <span className="ml-auto text-[11px] font-normal text-muted-foreground">
                    Ranked by meetings per contacted — {sourceMeetings} meeting{sourceMeetings === 1 ? "" : "s"} from {totalContacted} contacted
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                {sourceRows.length === 0 ? (
                  <p className="px-4 pb-4 text-[13px] text-muted-foreground">No prospects have been sourced yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[760px]">
                      <thead>
                        <tr>
                          <th className={th}>Source</th>
                          <th className={th}>Found</th>
                          <th className={th}>Avg ICP</th>
                          <th className={th}>Contacted</th>
                          <th className={th}>Replied</th>
                          <th className={th}>Reply rate</th>
                          <th className={th}>Meetings</th>
                          <th className={th}>Meeting rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sourceRows.map((r) => (
                          <tr key={r.sourceType} className="hover:bg-muted/50">
                            <td className={`${td} font-medium`}>{label(SOURCE_LABEL, r.sourceType)}</td>
                            <td className={td}>{r.discovered}</td>
                            <td className={td}>{r.avgIcpScore || <span className="text-muted-foreground">—</span>}</td>
                            <td className={td}>{r.contacted}</td>
                            <td className={td}>{r.replied}</td>
                            <td className={td}><RateCell value={r.replyRate} sample={r.contacted} /></td>
                            <td className={td}>{r.meetings}</td>
                            <td className={td}><RateCell value={r.meetingRate} sample={r.contacted} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ── Reply mix ── */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <MailOpen className="size-4" style={{ color: accent }} /> Reply mix
                  <span className="ml-auto text-[11px] font-normal text-muted-foreground">What replies actually say</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                {replyRows.length === 0 ? (
                  <p className="px-4 pb-4 text-[13px] text-muted-foreground">No inbound replies recorded yet. A raw reply count would hide whether replies progress deals — this breaks them out by intent once they arrive.</p>
                ) : (
                  <ul className="divide-y divide-border/60">
                    {replyRows.map((r) => {
                      const good = r.replyClass === "willing_to_meet";
                      return (
                        <li key={r.replyClass} className="flex items-center gap-3 px-4 py-2.5">
                          <span className={`text-[13px] flex-1 ${good ? "font-medium" : ""}`}>{label(REPLY_LABEL, r.replyClass)}</span>
                          <span className="text-[13px] tabular-nums">{r.count}</span>
                          <span className="w-28 h-1.5 rounded-full bg-muted overflow-hidden">
                            <span
                              className="block h-full rounded-full"
                              style={{ width: `${Math.min(100, r.share)}%`, backgroundColor: good ? "#10b981" : accent }}
                            />
                          </span>
                          <span className="w-12 text-right text-[12px] tabular-nums text-muted-foreground">{r.share.toFixed(1)}%</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </Shell>
  );
}
