/**
 * "Why is this campaign stalled?" — F11 (owner's audit, High).
 *
 * One count per gate, from `are.campaigns.stallReasons`. The engine already
 * writes every one of these as a log line; what it never had was a surface, so
 * answering "why is nothing happening" meant opening the Logs tab and
 * reconstructing the state from prose.
 *
 * TWO BLOCKS, AND THE SPLIT IS THE POINT. Seven of the nine gates are stored
 * state and can be counted. Two — the send window and the sender pool — leave
 * no per-row trace whatsoever: due rows just stay `scheduled`, and a spent pool
 * re-schedules its rows and clears their failureReason, leaving one dispatch log
 * line. So those two are reported in the PRESENT TENSE, in their own block,
 * saying what is true now; the counts block never mixes with them. A historical
 * count for either would have to be invented, and a made-up number is worse
 * than an absent one because it looks like evidence.
 *
 * For the same reason nothing here renders an unknown as 0. A zero means "we
 * counted, there are none"; when the read fails the panel says so in words.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { describeEnrichmentError, type EnrichmentErrorTone } from "@shared/enrichmentErrorLabel";
import { trpc } from "@/lib/trpc";
import { Clock, Loader2, Users } from "lucide-react";
import type { ReactNode } from "react";

/** Same tones the Prospects tab uses for the same error strings. Class strings
 *  live here, not in shared/, because Tailwind's content scan is rooted at
 *  client/ — a class it cannot see is never generated. */
const TONE_CLASS: Record<EnrichmentErrorTone, string> = {
  info: "text-[#8B5A2B] dark:text-[#C08457]",
  warn: "text-amber-600 dark:text-amber-500",
  error: "text-destructive/90",
};

/** The headline sentence per `topReason` key. The server picks the key by what
 *  the blocker STOPS (whole campaign before some rows); the wording is here. */
const TOP_REASON: Record<string, string> = {
  workspacePaused: "Outbound is paused for this whole workspace — no campaign sends until it is lifted.",
  campaignNotActive: "This campaign is not active — the engine only works active campaigns.",
  windowClosed: "The send window is closed, and steps are waiting on it.",
  capUsed: "Today's send cap is used up.",
  copyHeld: "Sequences are held for a research avoid rule and need a person.",
  noEmail: "Approved people are waiting for an email address.",
  unusableSequence: "Written sequences have no sendable steps — they need regenerating.",
  noDossier: "Approved people have no written sequence yet.",
  enrichmentFailed: "Enrichment failed for some of these people.",
  prospectsPaused: "Some people's sequences are paused.",
  queueFull: "The prospect queue is full, so discovery is idle.",
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * A timestamp in the WORKSPACE's zone, which is the zone the window and the cap
 * are defined in. An unusable zone falls back to a visibly-labelled UTC string
 * rather than the viewer's own zone, which would render a different hour under
 * a "workspace zone" claim.
 */
function inZone(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

/** One gate: its count, what the count counts, and a way to the rows. */
function Gate({ label, value, note, children, onJump, jumpLabel }: {
  label: string;
  value: string | number;
  note?: string;
  children?: ReactNode;
  onJump?: () => void;
  jumpLabel?: string;
}) {
  const zero = value === 0;
  return (
    <div className="flex items-start gap-3 py-2 border-b border-border/40 last:border-0">
      <div className={`text-sm font-semibold tabular-nums min-w-[3.5rem] ${zero ? "text-muted-foreground/60" : ""}`}>
        {value}
      </div>
      <div className="min-w-0 flex-1">
        <div className={`text-xs font-medium ${zero ? "text-muted-foreground" : ""}`}>{label}</div>
        {note && <div className="text-[11px] text-muted-foreground mt-0.5">{note}</div>}
        {children}
      </div>
      {onJump && !zero && (
        <Button size="sm" variant="ghost" className="text-[11px] h-6 px-2 shrink-0" onClick={onJump}>
          {jumpLabel ?? "Show"}
        </Button>
      )}
    </div>
  );
}

export function CampaignStallPanel({ campaignId, onJump }: {
  campaignId: number;
  /** Switches the page's tab — the detail page keeps `tab` in state, so a gate
   *  points at the tab that holds its rows. It does not pre-filter that tab:
   *  no per-gate filter exists there, and a button that claimed to filter and
   *  did not would be its own small lie. */
  onJump: (tab: string) => void;
}) {
  const { data, isLoading, isError, error } = trpc.are.campaigns.stallReasons.useQuery(
    { campaignId },
    // A minute: the engine ticks every ten, and the window and the pool are
    // present-tense claims that go stale on their own.
    { refetchInterval: 60_000 },
  );

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Reading the campaign's gates…
        </CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-4 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Why this campaign is stalled: not determined.</span>{" "}
          The gates could not be read{error?.message ? ` (${error.message})` : ""}. None of these counts is zero —
          they are unknown, and the Logs tab still has the engine's own lines.
        </CardContent>
      </Card>
    );
  }

  const { sending: s, gates: g } = data;
  const headline = data.topReason ? TOP_REASON[data.topReason] : null;

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        {/* ── Headline: the spec's "with the top reason" ── */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-semibold">Why isn't this campaign sending?</div>
            <div className={`text-xs mt-0.5 ${headline ? "text-foreground" : "text-emerald-600 dark:text-emerald-500"}`}>
              {headline ?? "Nothing is blocking it right now — every gate below is clear."}
            </div>
          </div>
          <Badge variant="outline" className="text-[10px] px-2 py-0.5 shrink-0">
            checked {inZone(data.checkedAt, data.timezone)}
          </Badge>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          {/* ── Block 1: present tense only ─────────────────────────────── */}
          <div className="rounded-md border border-border/60 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Clock className="size-3.5" /> Stopping sends right now
            </div>
            <div className="text-[11px] text-muted-foreground/80 mt-1 mb-2">
              These two gates leave no per-row trace, so they describe this moment — not a period.
            </div>

            <div className="text-xs space-y-1 py-2 border-t border-border/40">
              <div className="font-medium">
                {g.paused.workspaceOutbound
                  ? "Outbound is paused for this workspace, so the window stays shut"
                  : s.windowOpen
                    ? "Send window is open"
                    : "Send window is closed"}
              </div>
              <div className="text-[11px] text-muted-foreground">
                It runs {s.windowDescription} ({data.timezone}).
                {!s.windowOpen && s.nextOpenAt && ` Opens ${inZone(s.nextOpenAt, data.timezone)}.`}
                {/* No "opens at" while paused: the pause has no end date, so an
                    hour would promise a send that is not coming. */}
                {g.paused.workspaceOutbound && " The pause has no end date — an admin lifts it in Settings."}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {s.dueNow === 0
                  ? "No steps are due at this moment."
                  : s.windowOpen
                    ? `${s.dueNow} ${plural(s.dueNow, "step is", "steps are")} due and ${plural(s.dueNow, "goes", "go")} on the next tick.`
                    : `${s.dueNow} ${plural(s.dueNow, "step is", "steps are")} due and ${plural(s.dueNow, "goes", "go")} at the first tick inside the window.`}
              </div>
            </div>

            <div className="text-xs space-y-1 py-2 border-t border-border/40">
              <div className="font-medium">
                {s.poolSpent ? "Sender pool reported every mailbox spent" : "No spent sender pool on record"}
              </div>
              {s.poolSpent ? (
                <>
                  <div className="text-[11px] text-muted-foreground">
                    Last seen {inZone(s.poolSpent.lastSeenAt, data.timezone)}
                    {s.poolSpent.repeatCount > 1 && `, ${s.poolSpent.repeatCount} ticks running`}
                    {s.poolSpent.reason && ` — ${s.poolSpent.reason}`}.
                  </div>
                  {/* Said out loud because the alternative is an operator
                      reading a stale line as a live pool reading. */}
                  <div className="text-[11px] text-muted-foreground/80">
                    This is the engine's last word on the pool, not a live check of it. Held steps were put back on the
                    calendar, so nothing was lost.
                  </div>
                  <Button size="sm" variant="ghost" className="text-[11px] h-6 px-2 -ml-2" onClick={() => onJump("logs")}>
                    Open the engine log
                  </Button>
                </>
              ) : (
                /* Not "0": the log is all there is, and it is kept for 30 days. */
                <div className="text-[11px] text-muted-foreground">
                  The engine has not reported a spent pool for this campaign in the last {s.poolLogRetentionDays} days,
                  which is as far back as its log is kept.
                </div>
              )}
            </div>
          </div>

          {/* ── Block 2: counts from stored state ───────────────────────── */}
          <div className="rounded-md border border-border/60 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Users className="size-3.5" /> Why prospects aren't moving
            </div>
            <div className="text-[11px] text-muted-foreground/80 mt-1 mb-2">
              Counted from stored state, each the way the engine itself counts it.
            </div>

            <div className="border-t border-border/40">
              <Gate
                label="Waiting for an email address"
                value={g.noEmail}
                note="Approved, the written sequence has an email step, no address found yet."
                onJump={() => onJump("prospects")}
              />
              <Gate
                label="Enrichment failed"
                value={g.enrichmentFailed.count}
                onJump={() => onJump("prospects")}
              >
                {g.enrichmentFailed.reasons.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {g.enrichmentFailed.reasons.map((r, i) => {
                      const d = describeEnrichmentError(r.reason);
                      return (
                        <li key={i} className="text-[11px]">
                          <span className="tabular-nums text-muted-foreground">{r.count}×</span>{" "}
                          <span className={d ? TONE_CLASS[d.tone] : "text-muted-foreground"}>
                            {d?.label ?? "No reason recorded"}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Gate>
              <Gate
                label="No written sequence yet"
                value={g.noDossier}
                note="Approved, and the engine has not written their copy yet — it does a page per tick."
                onJump={() => onJump("prospects")}
              />
              <Gate
                label="Sequence has no sendable steps"
                value={g.unusableSequence}
                note="Written, but nothing in it can be sent. These need regenerating; waiting will not clear them."
                onJump={() => onJump("sequences")}
                jumpLabel="Sequences"
              />
              <Gate
                label="Copy held for a research avoid rule"
                value={g.copyHeld.count}
                note="Release or regenerate on the person's dossier."
                onJump={() => onJump("prospects")}
              >
                {g.copyHeld.reasons.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {g.copyHeld.reasons.map((r, i) => (
                      <li key={i} className="text-[11px] text-muted-foreground">
                        <span className="tabular-nums">{r.count}×</span> {r.reason ?? "No reason recorded"}
                      </li>
                    ))}
                  </ul>
                )}
              </Gate>
              <Gate
                label="Sent today, against the daily cap"
                value={`${g.cap.sentToday}/${g.cap.cap}`}
                note={g.cap.remaining === 0
                  ? "Cap reached. Sending resumes when the workspace's day rolls over, not at UTC midnight."
                  : `${g.cap.remaining} left today.`}
              />
              {/* Three facts, never one: a campaign can be active itself while
                  every prospect is held and the workspace pause is on. */}
              <Gate
                label="Paused"
                value={(g.paused.workspaceOutbound ? 1 : 0) + (g.paused.campaignStatus !== "active" ? 1 : 0) + (g.paused.prospects > 0 ? 1 : 0)}
                note="Three separate switches, three different fixes."
              >
                <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                  <li>
                    Workspace outbound: {g.paused.workspaceOutbound ? "paused" : "running"}
                  </li>
                  <li>
                    This campaign: {g.paused.campaignStatus}
                    {g.paused.campaignStatus !== "active" && " — the engine skips it"}
                  </li>
                  <li>
                    {g.paused.prospects === 0
                      ? "No individual prospect is paused"
                      : `${g.paused.prospects} ${plural(g.paused.prospects, "prospect's sequence is", "prospects' sequences are")} paused — their steps are held, not deleted`}
                  </li>
                </ul>
              </Gate>
              <Gate
                label="Prospect queue"
                value={`${g.queue.working}/${g.queue.target}`}
                note={g.queue.full
                  ? "Queue full, so discovery stays idle. Reject rows you do not want, or raise the target."
                  : g.queue.discoveryRestingUntil
                    // Below target and searching are different claims. This row
                    // said "runs on every tick" unconditionally until F12
                    // (2026-10-30) surfaced the rest state it was ignoring.
                    ? `Below target, but discovery is resting until ${inZone(g.queue.discoveryRestingUntil, data.timezone)} — the last run found nobody new.`
                    : "Below target — discovery runs on every tick."}
              >
                {g.queue.rejected > 0 && (
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {g.queue.rejected} rejected {plural(g.queue.rejected, "row", "rows")} excluded from that count — they
                    are inert, and counting them once held every campaign at "queue full" forever.
                  </div>
                )}
              </Gate>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
