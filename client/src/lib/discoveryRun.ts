/**
 * Following a discovery run to its end (audit 2026-10-20, P72).
 *
 * `discovery.search` used to hold the request open for the whole fan-out and
 * answer with the result; a lost response left the run going with no run id
 * on the page. It now answers at once with the run id, a background job does
 * the work, and the page follows the run. `useFollowRun` polls the run while
 * it is running and calls `onDone` once, with the finished row, so the toast
 * that used to come from the request comes from the run instead.
 *
 * `runSummary` is that toast's text, pure so a test can read it: what was
 * SAVED (P61), what was left out, what was already in People (F38), and a run
 * kept for review says it is not saved yet.
 */
import { useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";

export type FinishedRun = {
  id: number;
  status: string;
  errorMessage?: string | null;
  rawFindCount: number;
  prospectsCreated: number;
  prospectsUpdated?: number | null;
  prospectsSkipped?: number | null;
  accountsCreated?: number | null;
  highConfidenceCount: number;
  mediumConfidenceCount: number;
  lowConfidenceCount: number;
  heldForReview?: boolean | null;
  alreadyInPeople?: number | null;
  /** A campaign launch (A56): how many saved people the campaign took, and refused. */
  addedToCampaign?: number | null;
  notAddedToCampaign?: number | null;
};

export function runSummary(r: FinishedRun): { ok: boolean; text: string } {
  if (r.status === "failed") return { ok: false, text: `Run #${r.id}: ${r.errorMessage ?? "the finds could not be saved"}` };
  const already = r.alreadyInPeople ? ` · ${r.alreadyInPeople} already in People` : "";
  if (r.heldForReview) {
    return { ok: true, text: `Run #${r.id} found ${r.rawFindCount} — not saved yet${already}. Review them below, then Save to People.` };
  }
  const saved = `${r.prospectsCreated} new + ${r.prospectsUpdated ?? 0} updated`
    + (r.prospectsSkipped ? ` · ${r.prospectsSkipped} not saved` : "")
    + (r.accountsCreated ? ` · ${r.accountsCreated} compan${r.accountsCreated === 1 ? "y" : "ies"} saved` : "");
  const campaign = r.addedToCampaign != null
    ? ` · ${r.addedToCampaign} added to this campaign${r.notAddedToCampaign ? ` (${r.notAddedToCampaign} not added: already in a campaign or sequence, or unidentifiable — see Logs)` : ""}`
    : "";
  return {
    ok: true,
    text: `Discovery complete — ${r.rawFindCount} raw / ${saved}${already}${campaign} / ${r.highConfidenceCount} high · ${r.mediumConfidenceCount} medium · ${r.lowConfidenceCount} low`,
  };
}

/**
 * Poll a run while it runs; `onDone` fires once when it stops running. A run
 * this page just started is `arm`ed, so it fires even if the first read finds
 * it already finished; a run merely reopened from history does not fire.
 */
export function useFollowRun(runId: number | null, onDone: (run: FinishedRun) => void) {
  const q = trpc.discovery.getRun.useQuery({ id: runId ?? 0 }, {
    enabled: runId != null,
    refetchInterval: (query) => ((query.state.data as { status?: string } | undefined)?.status === "running" ? 3000 : false),
  });
  const seenRunning = useRef<number | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const run = q.data as FinishedRun | undefined;
    if (!run || runId == null || run.id !== runId) return;
    if (run.status === "running") { seenRunning.current = runId; return; }
    if (seenRunning.current === runId) {
      seenRunning.current = null;
      done.current(run);
    }
  }, [q.data, runId]);
  return { query: q, arm: (id: number) => { seenRunning.current = id; } };
}
