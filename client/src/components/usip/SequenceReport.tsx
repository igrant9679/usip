import { trpc } from "@/lib/trpc";
import { useState } from "react";

const NOT_READ = "—";

/**
 * A sequence's real numbers, from sequences.getPerformanceAnalytics. An unknown
 * is never drawn as a zero: until the query answers, or if it fails, the tiles
 * read a dash and a failure is said in words. A rate with nothing to divide by
 * is a dash too, because "0% opened" reads as a result when nothing was sent.
 *
 * The date range filters the emails only. Enrollments have no send date to
 * filter on, so the exit rate is always all time, and it says so.
 */
export function SequenceReport({ sequenceId, accent }: { sequenceId: number; accent: string }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const filtered = !!dateFrom || !!dateTo;
  const query = trpc.sequences.getPerformanceAnalytics.useQuery({
    sequenceId,
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
  });
  const row = query.isError ? null : query.data?.[0] ?? null;
  const sent = row?.sent ?? 0;
  const rate = (value: number | undefined, of: number) => (row && of > 0 ? `${value ?? 0}%` : NOT_READ);

  const tiles = [
    { label: "Emails sent", value: row ? String(row.sent) : NOT_READ, sub: filtered ? "in this range" : "all time" },
    { label: "Open rate", value: rate(row?.openRate, sent), sub: row ? `${row.uniqueOpens} unique opens` : "" },
    { label: "Click rate", value: rate(row?.clickRate, sent), sub: row ? `${row.uniqueClicks} unique clicks` : "" },
    { label: "Bounce rate", value: rate(row?.bounceRate, sent), sub: row ? `${row.bounced} bounced` : "" },
    { label: "Exit rate", value: rate(row?.exitRate, row?.totalEnrolled ?? 0), sub: row ? `${row.exited} of ${row.totalEnrolled} exited, all time` : "" },
  ];
  const funnel = row ? [
    { label: "Sent", value: row.sent, pct: 100 },
    { label: "Opened", value: row.uniqueOpens, pct: row.openRate },
    { label: "Clicked", value: row.uniqueClicks, pct: row.clickRate },
    { label: "Bounced", value: row.bounced, pct: row.bounceRate },
  ] : [];
  const field = "h-8 rounded-md border bg-background px-2 text-xs text-foreground";

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3 shadow-sm">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          From
          <input aria-label="From" type="date" className={field} value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          To
          <input aria-label="To" type="date" className={field} value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} />
        </label>
        {filtered && (
          <button type="button" className="h-8 rounded-md border px-3 text-xs text-muted-foreground hover:text-foreground" onClick={() => { setDateFrom(""); setDateTo(""); }}>
            Clear dates
          </button>
        )}
        <p className="text-[11px] text-muted-foreground basis-full">Days are in the workspace's time zone. Replies and meetings are not counted here yet.</p>
      </div>

      {query.isError && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          These numbers could not be read, so they are shown as unknown rather than zero.
          {query.error?.message ? ` ${query.error.message}` : ""}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border bg-card p-3 shadow-sm">
            <div className="text-[11px] text-muted-foreground">{t.label}</div>
            <div className="text-xl font-semibold tabular-nums" style={row ? { color: accent } : undefined}>{t.value}</div>
            <div className="text-[11px] text-muted-foreground min-h-4">{t.sub}</div>
          </div>
        ))}
      </div>

      {row && sent === 0 && (
        <p className="text-sm text-muted-foreground">
          {filtered ? "Nothing was sent in this range." : "Nothing has been sent yet. This report fills in once the sequence sends."}
        </p>
      )}

      {row && sent > 0 && (
        <div className="rounded-xl border bg-card p-3 shadow-sm space-y-2">
          {funnel.map((f) => (
            <div key={f.label} className="flex items-center gap-3 text-sm">
              <span className="w-16 shrink-0 text-xs text-muted-foreground">{f.label}</span>
              <div className="h-2 min-w-0 flex-1 rounded-full bg-muted">
                <div className="h-2 rounded-full" style={{ width: `${Math.min(100, f.pct)}%`, backgroundColor: accent }} />
              </div>
              <span className="w-10 shrink-0 text-right text-xs tabular-nums">{f.value}</span>
              <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{f.pct}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
