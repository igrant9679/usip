/**
 * Per-source health for one campaign — F12, "shows which sources earn their
 * cost".
 *
 * Scope first, because it is the whole reason this component is small: the
 * workspace back office already exists. Settings → Data sources shows every
 * registry vendor's capabilities, credential status, circuit state and budget;
 * Settings → Billing reports spend per vendor per day. Both are workspace-wide.
 * This answers the question neither can: of the sources THIS campaign is set to
 * use, which will run on the next tick, in what order, which are resting, and
 * what each returned last time. It links to the back office rather than
 * reprinting it.
 *
 * Three things it says out loud rather than implying:
 *   • four of the seven sources are not instrumented at all — they are
 *     hand-written branches in the engine with no credential row, breaker or
 *     ledger — and they are listed anyway, because leaving them out would
 *     answer "which sources earn their cost" by omission;
 *   • a breaker reading that is not durable is labelled as process memory;
 *   • spend is a WORKSPACE total for a UTC day, because the ledger has no
 *     campaign column and its day is UTC.
 *
 * And "last success or error" is shown as LAST ATTEMPT, because no per-source
 * success time is stored anywhere — see the server procedure's note.
 */
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Link } from "wouter";
import { Database, Loader2 } from "lucide-react";

const ORDINAL = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th"];
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function when(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      .format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace("T", " ") + " UTC";
  }
}

type Health = RouterOutputs["are"]["campaigns"]["sourceHealth"];
type Source = Health["sources"][number];

/**
 * The one line that says why a source will or will not run, in the order the
 * engine applies the gates — so the reason shown is the reason that is
 * actually operative, not the first one that happens to be true.
 */
function verdict(s: Source): { text: string; tone: "ok" | "muted" | "warn" | "bad" } {
  if (!s.selectedOnCampaign) return { text: "Not selected for this campaign", tone: "muted" };
  if (!s.enabledInWorkspace) return { text: "Disabled in workspace Settings", tone: "muted" };
  if (s.rest) {
    return {
      text: `Resting after ${s.rest.emptyRuns} empty ${plural(s.rest.emptyRuns, "run", "runs")} — next attempt ${when(s.rest.until)}`,
      tone: "warn",
    };
  }
  if (s.breaker?.open) {
    const until = s.breaker.openUntil ? ` until ${when(s.breaker.openUntil)}` : "";
    return { text: `Paused after ${s.breaker.failures} consecutive ${plural(s.breaker.failures, "failure", "failures")}${until}`, tone: "bad" };
  }
  if (s.key && !s.key.configured) return { text: "No API key for this workspace", tone: "warn" };
  if (s.key?.status === "invalid") return { text: `Key failed validation${s.key.error ? `: ${s.key.error}` : ""}`, tone: "bad" };
  if (s.key?.status === "revoked") return { text: "Key revoked", tone: "bad" };
  if (s.runsAt == null) return { text: "Will not run", tone: "muted" };
  return { text: "Ready", tone: "ok" };
}

const TONE_CLASS: Record<"ok" | "muted" | "warn" | "bad", string> = {
  ok: "text-emerald-700 dark:text-emerald-400",
  muted: "text-muted-foreground",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-rose-700 dark:text-rose-400",
};

function SourceRow({ s }: { s: Source }) {
  const v = verdict(s);
  const budget = s.budget;
  const leads = budget?.buckets.find((b) => b.bucket === "leads");
  return (
    <tr className={`border-t border-border/50 align-top ${s.runsAt == null ? "opacity-70" : ""}`}>
      <td className="py-2 pr-3 whitespace-nowrap">
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {s.runsAt == null ? "—" : ORDINAL[s.runsAt] ?? `${s.runsAt + 1}th`}
        </span>
      </td>
      <td className="py-2 pr-3">
        <div className="text-xs font-medium">{s.label}</div>
        <div className={`text-[11px] ${TONE_CLASS[v.tone]}`}>{v.text}</div>
        {/* Said plainly, because the empty cells to the right are not zeros. */}
        {!s.instrumented && (
          <div className="text-[10.5px] text-muted-foreground/80 mt-0.5">
            Not instrumented — no key status, breaker or budget is tracked for this source.
          </div>
        )}
        {s.breaker && !s.breaker.durable && (
          <div className="text-[10.5px] text-muted-foreground/80 mt-0.5">
            Breaker state for this source is held in memory, not stored — a deploy forgets it.
          </div>
        )}
      </td>
      <td className="py-2 pr-3 text-[11px]">
        {!s.budget ? (
          <span className="text-muted-foreground">not tracked</span>
        ) : s.budget.leadsRemaining != null ? (
          <>
            {s.budget.leadsRemaining.toLocaleString()} left
            {leads?.limit != null && <span className="text-muted-foreground"> / {leads.limit.toLocaleString()}</span>}
            {leads?.fundedBy && <div className="text-[10.5px] text-muted-foreground">{leads.fundedBy}</div>}
          </>
        ) : (
          /* All-null buckets are the adapters' way of saying the vendor
             publishes no allowance — never "0 left". */
          <span className="text-muted-foreground">tracked locally — the vendor publishes no allowance</span>
        )}
      </td>
      <td className="py-2 pr-3 text-[11px]">
        {!s.lastAttempt ? (
          <span className="text-muted-foreground">no attempt on record</span>
        ) : s.lastAttempt.error ? (
          <span className="text-rose-700 dark:text-rose-400">{s.lastAttempt.error}</span>
        ) : s.lastAttempt.skipped ? (
          <span className="text-muted-foreground">skipped — {s.lastAttempt.skipped}</span>
        ) : (
          <>
            {s.lastAttempt.raw} returned → <span className="font-medium">{s.lastAttempt.kept} kept</span>
            {s.lastAttempt.raw > 0 && s.lastAttempt.kept === 0 && (
              <div className="text-[10.5px] text-muted-foreground">all duplicates or screened out</div>
            )}
          </>
        )}
      </td>
      <td className="py-2 text-[11px]">
        {!s.spendToday ? (
          <span className="text-muted-foreground">nothing recorded</span>
        ) : (
          <>
            {s.spendToday.meters.map((m, i) => (
              <div key={i}>
                {m.quantity.toLocaleString()} {m.meter}
                <span className="text-muted-foreground"> · {m.calls} {plural(m.calls, "call", "calls")}</span>
                {m.keySource !== "workspace" && <span className="text-muted-foreground"> · {m.keySource} key</span>}
              </div>
            ))}
          </>
        )}
      </td>
    </tr>
  );
}

export function CampaignSourceHealth({ campaignId }: { campaignId: number }) {
  const { data, isLoading, isError, error } = trpc.are.campaigns.sourceHealth.useQuery({ campaignId });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Reading source health…
        </CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-4 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Source health: not determined.</span>{" "}
          It could not be read{error?.message ? ` (${error.message})` : ""}. Nothing here is a zero.
        </CardContent>
      </Card>
    );
  }

  const d = data.discovery;
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-semibold flex items-center gap-1.5">
              <Database className="size-4" /> Which sources earn their cost
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              The sources this campaign will use, in the order they run — which is also dedup precedence, so a lower
              source is never paid for a person a higher one already found. Keys, order and the workspace-wide view live
              in <Link href="/v2/settings/data-sources" className="underline">Settings → Data sources</Link>.
            </div>
          </div>
          <Badge variant="outline" className="text-[10px] px-2 py-0.5 shrink-0">checked {when(data.checkedAt)}</Badge>
        </div>

        {/* ── The campaign-level fact, which is the thing no other surface says ── */}
        <div className="text-xs rounded-md border border-border/60 p-2.5">
          {d.noUsableSources ? (
            <span className="text-amber-700 dark:text-amber-400">
              {d.explicitlyNone
                ? "Discovery is off for this campaign — no sources are selected, which is a deliberate setting rather than a fault."
                : "No source will run — every source this campaign selected is disabled in workspace Settings."}
            </span>
          ) : d.restingUntil ? (
            <>
              <span className="text-amber-700 dark:text-amber-400 font-medium">
                Discovery is resting until {when(d.restingUntil)}.
              </span>{" "}
              <span className="text-muted-foreground">
                The last run found nobody new, so it waits {d.restWindowMinutes} minutes rather than asking the same
                sources for the same people every tick. Each source also backs off on its own, doubling after each
                empty run.
              </span>
            </>
          ) : d.lastRunAt ? (
            <span className="text-muted-foreground">
              Last ran {when(d.lastRunAt)} — {d.lastRunNew ?? 0} new{" "}
              {plural(d.lastRunNew ?? 0, "person", "people")} after dedupe.
            </span>
          ) : (
            /* Not "0 found": never having run and having found nobody are
               different facts. */
            <span className="text-muted-foreground">This campaign has no discovery run on record.</span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="pb-1 pr-3 font-medium">Order</th>
                <th className="pb-1 pr-3 font-medium">Source</th>
                <th className="pb-1 pr-3 font-medium">Budget today</th>
                <th className="pb-1 pr-3 font-medium">Last attempt</th>
                {/* The scope is in the header, where it cannot be read off. */}
                <th className="pb-1 font-medium">Spend · workspace, {data.spendDay} UTC</th>
              </tr>
            </thead>
            <tbody>
              {data.sources.map((s) => <SourceRow key={s.slug} s={s} />)}
            </tbody>
          </table>
        </div>

        <div className="text-[10.5px] text-muted-foreground/80">
          "Last attempt" is the engine's last discovery summary for this campaign, not a success time: nothing records
          when a source last succeeded. Engine logs are kept {data.logRetentionDays} days, so "no attempt on record"
          means none in that window.
        </div>
      </CardContent>
    </Card>
  );
}
