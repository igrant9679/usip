/**
 * Per-step performance in the v2 editor's Report tab (audit 2026-10-20, U14):
 * the legacy /sequences Performance tab had this table and the v2 report did
 * not. One row per step from `sequences.getStepAnalytics`, which counts in SQL
 * from the drafts each step wrote, replies included (genuine replies to that
 * step's emails, the shared reply scope).
 *
 * Same rules as SequenceReport: an unread number is a dash, a failed read says
 * so in words, and a rate over nothing sent is a dash rather than "0%".
 */
import { trpc } from "@/lib/trpc";

type StepRow = {
  stepIndex: number;
  stepType: string;
  stepLabel: string;
  sent: number;
  uniqueOpens: number;
  uniqueClicks: number;
  replied: number;
  bounced: number;
  openRate: number;
  clickRate: number;
  replyRate: number;
  bounceRate: number;
};

export function SequenceStepBreakdown({ sequenceId, accent }: { sequenceId: number; accent: string }) {
  const query = trpc.sequences.getStepAnalytics.useQuery({ sequenceId });
  const rows = query.isError ? null : ((query.data?.steps ?? null) as StepRow[] | null);
  const cell = (n: number, rate: number, sent: number) => (
    <>
      <span className="tabular-nums">{n}</span>
      <span className="ml-1 text-[11px] text-muted-foreground">({sent > 0 ? `${rate}%` : "—"})</span>
    </>
  );

  return (
    <div className="px-4 pb-6 md:px-6 max-w-3xl mx-auto">
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="px-3 pt-3 pb-2">
          <h2 className="text-sm font-semibold" style={{ color: accent }}>Per step</h2>
          <p className="text-[11px] text-muted-foreground">All time. Replies here are genuine replies to that step's emails.</p>
        </div>
        {query.isError ? (
          <p className="px-3 pb-3 text-[12px] text-amber-800 dark:text-amber-300">
            The per-step numbers could not be read, so none are shown.{query.error?.message ? ` ${query.error.message}` : ""}
          </p>
        ) : rows === null ? (
          <p className="px-3 pb-3 text-[12px] text-muted-foreground">Reading the steps…</p>
        ) : rows.length === 0 ? (
          <p className="px-3 pb-3 text-[12px] text-muted-foreground">This sequence has no steps yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-y text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Step</th>
                  <th className="px-2 py-2 font-medium text-right">Sent</th>
                  <th className="px-2 py-2 font-medium text-right">Opened</th>
                  <th className="px-2 py-2 font-medium text-right">Clicked</th>
                  <th className="px-2 py-2 font-medium text-right">Replied</th>
                  <th className="px-3 py-2 font-medium text-right">Bounced</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.stepIndex} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      <div className="font-medium">{s.stepIndex === -1 ? "Older drafts" : `Step ${s.stepIndex + 1}`}</div>
                      <div className="max-w-[260px] truncate text-[11px] text-muted-foreground" title={s.stepLabel}>{s.stepLabel}</div>
                    </td>
                    {s.stepType !== "email" && s.stepIndex !== -1 && s.sent === 0 ? (
                      <td colSpan={5} className="px-3 py-2 text-right text-[11px] text-muted-foreground">Not an email step</td>
                    ) : (
                      <>
                        <td className="px-2 py-2 text-right tabular-nums">{s.sent}</td>
                        <td className="px-2 py-2 text-right">{cell(s.uniqueOpens, s.openRate, s.sent)}</td>
                        <td className="px-2 py-2 text-right">{cell(s.uniqueClicks, s.clickRate, s.sent)}</td>
                        <td className="px-2 py-2 text-right">{cell(s.replied, s.replyRate, s.sent)}</td>
                        <td className="px-3 py-2 text-right">{cell(s.bounced, s.bounceRate, s.sent)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
