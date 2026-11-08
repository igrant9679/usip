/**
 * The Reports page's deep links and a scheduled report's last-send status
 * (audit 2026-10-20, F45). Pure, so the page and the tests share them.
 */

/** /reports?report=<saved id> or /reports?report=preset:<key>. */
export function reportHref(r: { id?: number | null; preset?: string | null }): string {
  if (r.id) return `/reports?report=${r.id}`;
  if (r.preset) return `/reports?report=preset:${encodeURIComponent(r.preset)}`;
  return "/reports";
}

type Scheduled = {
  scheduleFreq?: string | null;
  scheduleLastSentAt?: string | Date | null;
  scheduleLastAttemptAt?: string | Date | null;
  scheduleLastResult?: string | null;
  scheduleLastError?: string | null;
  scheduleLastSentTo?: number | null;
};

const when = (v: string | Date) => new Date(v).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * What to say about a report's emailing, or null when it has never been tried
 * and is not scheduled. A failed last attempt says so, with its reason and
 * when it last went through.
 */
export function scheduleStatus(r: Scheduled): { text: string; failed: boolean } | null {
  const lastSent = r.scheduleLastSentAt ? `Last sent ${when(r.scheduleLastSentAt)}${r.scheduleLastSentTo ? ` to ${r.scheduleLastSentTo} recipient${r.scheduleLastSentTo === 1 ? "" : "s"}` : ""}` : null;
  if (r.scheduleLastResult === "failed" && r.scheduleLastAttemptAt) {
    const why = r.scheduleLastError ? `: ${r.scheduleLastError}` : "";
    return { text: `Last send failed ${when(r.scheduleLastAttemptAt)}${why}.${lastSent ? ` ${lastSent}.` : " Never sent."}`, failed: true };
  }
  if (lastSent) return { text: `${lastSent}.`, failed: false };
  if (r.scheduleFreq && r.scheduleFreq !== "none") return { text: `Emailed ${r.scheduleFreq}; not sent yet.`, failed: false };
  return null;
}
