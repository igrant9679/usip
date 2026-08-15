/**
 * LinkedIn Activity Limits (/settings/linkedin-limits).
 *
 * The controls that decide whether a connected LinkedIn account keeps working.
 * Until now the product's protections were four hardcoded numbers in four
 * files that could not see each other — and the invite cap silently overrode
 * the one setting that did exist, so raising it reported success and changed
 * nothing. @shared/linkedinLimits explains the reasoning behind each field.
 *
 * The page leads with what each account has ALREADY done, because the limit
 * that matters is the trailing week and nobody can hold that in their head.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Shell, useAccentColor, EmptyState } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Linkedin, ShieldCheck, AlertTriangle, Clock, Info, RotateCcw, History, Activity,
} from "lucide-react";
import {
  DEFAULT_LINKEDIN_POLICY, POLICY_BOUNDS, usedPct,
  type LinkedInLimitPolicy,
} from "@shared/linkedinLimits";

const DAY_LABEL = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A short list of zones covering where reps actually sit. */
const TIMEZONES = [
  "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo",
  "Australia/Sydney", "Pacific/Auckland",
];

function fmt(d?: string | Date | null): string {
  if (!d) return "never";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "never";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** A used/cap bar that turns amber then red as the budget runs out. */
function Budget({ label, used, cap, hint }: { label: string; used: number; cap: number; hint?: string }) {
  const pct = usedPct(used, cap);
  const tone = pct >= 100 ? "#e11d48" : pct >= 75 ? "#d97706" : "#059669";
  return (
    <div title={hint}>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums font-medium" style={{ color: tone }}>{used} / {cap}</span>
      </div>
      <Progress value={pct} className="h-1.5 mt-1" />
    </div>
  );
}

function NumField({ label, hint, value, bounds, onChange }: {
  label: string; hint: string; value: number;
  bounds: { min: number; max: number };
  onChange: (n: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium">{label}</Label>
      <Input
        type="number"
        className="h-8 text-xs"
        min={bounds.min}
        max={bounds.max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <p className="text-[11px] text-muted-foreground leading-snug">{hint}</p>
    </div>
  );
}

function PolicyEditor({
  title,
  subtitle,
  policy,
  saving,
  onSave,
  onReset,
}: {
  title: string;
  subtitle: string;
  policy: LinkedInLimitPolicy;
  saving: boolean;
  onSave: (p: LinkedInLimitPolicy) => void;
  onReset?: () => void;
}) {
  const [draft, setDraft] = useState<LinkedInLimitPolicy>(policy);
  useEffect(() => { setDraft(policy); }, [policy]);
  const set = <K extends keyof LinkedInLimitPolicy>(k: K, v: LinkedInLimitPolicy[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(policy);

  // The one cross-field check worth making loudly: a daily cap that, run every
  // permitted day, would breach the weekly ceiling.
  const weeklyImplied = draft.dailyInviteCap * Math.max(1, draft.workingDays.length);
  const dailyOverrunsWeekly = weeklyImplied > draft.weeklyInviteCap;

  return (
    <div className="rounded-xl border bg-card p-4 space-y-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">{draft.enabled ? "Active" : "Paused"}</span>
          <Switch checked={draft.enabled} onCheckedChange={(v) => set("enabled", v)} />
        </div>
      </div>

      {!draft.enabled && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
          Paused means every automated LinkedIn action is refused — invites, messages, profile lookups and enrichment.
          It does not mean unlimited.
        </div>
      )}

      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Volume</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <NumField
            label="Invites per week"
            hint="The binding limit. LinkedIn restricts on the trailing week, not the day — widely reported around 100."
            value={draft.weeklyInviteCap}
            bounds={POLICY_BOUNDS.weeklyInviteCap}
            onChange={(n) => set("weeklyInviteCap", n)}
          />
          <NumField
            label="Invites per day"
            hint="Smooths the weekly budget so it isn't spent in two days."
            value={draft.dailyInviteCap}
            bounds={POLICY_BOUNDS.dailyInviteCap}
            onChange={(n) => set("dailyInviteCap", n)}
          />
          <NumField
            label="Messages per day"
            hint="Opener DMs sent when an invite is accepted."
            value={draft.dailyMessageCap}
            bounds={POLICY_BOUNDS.dailyMessageCap}
            onChange={(n) => set("dailyMessageCap", n)}
          />
          <NumField
            label="Profile lookups per day"
            hint="Enrichment and company backfill read profiles through this account."
            value={draft.dailyLookupCap}
            bounds={POLICY_BOUNDS.dailyLookupCap}
            onChange={(n) => set("dailyLookupCap", n)}
          />
          <NumField
            label="Total actions per day"
            hint="Everything together. Four separately reasonable caps can still add up to an account that looks automated."
            value={draft.dailyActionCap}
            bounds={POLICY_BOUNDS.dailyActionCap}
            onChange={(n) => set("dailyActionCap", n)}
          />
          <NumField
            label="Warm-up period (days)"
            hint="A newly connected account starts at 20% of these limits and ramps to full over this many days."
            value={draft.warmupDays}
            bounds={POLICY_BOUNDS.warmupDays}
            onChange={(n) => set("warmupDays", n)}
          />
        </div>
        {dailyOverrunsWeekly && (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
            <Info className="size-3.5 mt-0.5 shrink-0" />
            <span>
              {draft.dailyInviteCap}/day across {draft.workingDays.length} working days is {weeklyImplied} a week, above
              your weekly ceiling of {draft.weeklyInviteCap}. The weekly limit wins, so invites will simply stop partway
              through the week. That is safe, but the daily number is misleading — lower it to about{" "}
              {Math.max(1, Math.floor(draft.weeklyInviteCap / Math.max(1, draft.workingDays.length)))} to spread evenly.
            </span>
          </div>
        )}
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Pacing</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <NumField
            label="Minimum gap between actions (seconds)"
            hint="Twenty invites fired back-to-back reads as automation however modest the daily total is."
            value={draft.minSpacingSeconds}
            bounds={POLICY_BOUNDS.minSpacingSeconds}
            onChange={(n) => set("minSpacingSeconds", n)}
          />
          <NumField
            label="Random extra delay, up to (seconds)"
            hint="Added to the gap so the rhythm varies. A perfectly regular cadence is itself a signal."
            value={draft.jitterSeconds}
            bounds={POLICY_BOUNDS.jitterSeconds}
            onChange={(n) => set("jitterSeconds", n)}
          />
        </div>
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">When it may run</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label className="text-xs font-medium">From</Label>
            <Select value={String(draft.workingHourStart)} onValueChange={(v) => set("workingHourStart", Number(v))}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, h) => (
                  <SelectItem key={h} value={String(h)}>{String(h).padStart(2, "0")}:00</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-medium">Until</Label>
            <Select value={String(draft.workingHourEnd)} onValueChange={(v) => set("workingHourEnd", Number(v))}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                  <SelectItem key={h} value={String(h)}>{String(h).padStart(2, "0")}:00</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-medium">Timezone</Label>
            <Select value={draft.timezone} onValueChange={(v) => set("timezone", v)}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => <SelectItem key={tz} value={tz}>{tz}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-3">
          {[1, 2, 3, 4, 5, 6, 7].map((d) => {
            const on = draft.workingDays.includes(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => set("workingDays", on ? draft.workingDays.filter((x) => x !== d) : [...draft.workingDays, d].sort())}
                className={cn(
                  "rounded-md border px-2.5 h-7 text-[11px] font-medium transition-colors",
                  on ? "border-primary/50 bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {DAY_LABEL[d]}
              </button>
            );
          })}
        </div>
        {draft.workingDays.length === 0 && (
          <p className="mt-2 text-[11px] text-rose-600 dark:text-rose-400">
            No days selected — nothing will ever run. Pick at least one.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" disabled={!dirty || saving || draft.workingDays.length === 0} onClick={() => onSave(draft)}>
          {saving ? "Saving…" : "Save limits"}
        </Button>
        {dirty && (
          <Button size="sm" variant="ghost" onClick={() => setDraft(policy)}>Discard</Button>
        )}
        {onReset && (
          <Button size="sm" variant="ghost" className="ml-auto gap-1.5" onClick={onReset}>
            <RotateCcw className="size-3.5" /> Follow workspace default
          </Button>
        )}
      </div>
    </div>
  );
}

export default function LinkedInLimits() {
  const accent = useAccentColor();
  const utils = trpc.useUtils();
  const overview = trpc.linkedinLimits.overview.useQuery(undefined as never, { retry: false });
  const [editing, setEditing] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);

  const save = trpc.linkedinLimits.setPolicy.useMutation({
    onSuccess: () => { utils.linkedinLimits.overview.invalidate(); toast.success("Limits saved"); },
    onError: (e) => toast.error(e.message.includes("FORBIDDEN") ? "Only admins can change LinkedIn limits" : e.message),
  });
  const clear = trpc.linkedinLimits.clearAccountPolicy.useMutation({
    onSuccess: () => { utils.linkedinLimits.overview.invalidate(); toast.success("Account now follows the workspace default"); },
    onError: (e) => toast.error(e.message),
  });
  const recent = trpc.linkedinLimits.recentActivity.useQuery(
    { unipileAccountId: historyFor ?? "", limit: 60 },
    { enabled: !!historyFor, retry: false },
  );

  const data = overview.data;
  const accounts = data?.accounts ?? [];
  const atRisk = useMemo(
    () => accounts.filter((a) => !a.currentVerdict.allowed && a.currentVerdict.reason !== "outside_hours" && a.currentVerdict.reason !== "outside_days"),
    [accounts],
  );

  return (
    <Shell title="LinkedIn limits">
      <div className="flex flex-col h-full min-h-0">
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Linkedin className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">LinkedIn activity limits</h1>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-5">
          <div className="rounded-lg border bg-card px-4 py-3 flex items-start gap-3">
            <ShieldCheck className="size-4 mt-0.5 shrink-0" style={{ color: accent }} />
            <div className="text-xs text-muted-foreground leading-relaxed">
              These limits govern every automated LinkedIn action Velocity takes — connection invites, opener messages,
              profile lookups for enrichment, and the likes sent to warm a prospect before an invite. They apply{" "}
              <strong>per connected account</strong>, because that is what LinkedIn restricts.
              <br />
              <span className="text-foreground/70">
                LinkedIn publishes no limits, and the real thresholds vary with account age and history. Every default
                here is a deliberately conservative guess, which is exactly why they are settings.
              </span>
            </div>
          </div>

          {atRisk.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex items-start gap-3">
              <AlertTriangle className="size-4 mt-0.5 shrink-0 text-amber-600" />
              <div className="text-xs text-amber-700 dark:text-amber-400">
                {atRisk.length} account{atRisk.length === 1 ? " is" : "s are"} currently held:{" "}
                {atRisk.map((a) => a.ownerName || a.unipileAccountId).join(", ")}. Automation will resume on its own —
                nothing is broken.
              </div>
            </div>
          )}

          {overview.isLoading ? (
            <div className="space-y-3">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-40 rounded-xl bg-muted/50 animate-pulse" />)}</div>
          ) : overview.error ? (
            <p className="text-sm text-muted-foreground">Couldn’t load limits. {overview.error.message}</p>
          ) : accounts.length === 0 ? (
            <EmptyState
              icon={Linkedin}
              title="No LinkedIn accounts connected"
              description="Connect a LinkedIn account in Connected Accounts. These limits apply the moment one is linked — an unconfigured account follows the workspace default rather than running unrestricted."
            />
          ) : (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold">Connected accounts</h2>
              {accounts.map((a) => {
                const isOpen = editing === a.unipileAccountId;
                return (
                  <div key={a.unipileAccountId} className="rounded-xl border bg-card overflow-hidden">
                    <div className="p-4 space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Linkedin className="size-4 text-[#0A66C2]" />
                        <span className="text-sm font-medium">{a.ownerName || a.ownerEmail || a.unipileAccountId}</span>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 capitalize">{a.status}</Badge>
                        {a.policySource === "account" ? (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-primary/40 text-primary">Custom limits</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-muted-foreground">Workspace default</Badge>
                        )}
                        {a.warmupFactor < 1 && (
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 h-4 border-amber-500/40 text-amber-600"
                            title={`Connected ${a.ageDays ?? "?"} days ago — limits are scaled to ${Math.round(a.warmupFactor * 100)}% while it warms up.`}
                          >
                            Warming up · {Math.round(a.warmupFactor * 100)}%
                          </Badge>
                        )}
                        <div className="flex-1" />
                        <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                          <Clock className="size-3" /> last action {fmt(a.usage.lastActionAt)}
                        </span>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                        <Budget
                          label="Invites this week"
                          used={a.usage.invitesWeek}
                          cap={a.effectiveCaps.weeklyInvite}
                          hint="Rolling 7 days — the limit LinkedIn actually restricts on."
                        />
                        <Budget label="Invites today" used={a.usage.invitesToday} cap={a.effectiveCaps.dailyInvite} />
                        <Budget label="Messages today" used={a.usage.messagesToday} cap={a.effectiveCaps.dailyMessage} />
                        <Budget
                          label="All actions today"
                          used={a.usage.totalToday}
                          cap={a.effectiveCaps.dailyAction}
                          hint="Invites, messages, lookups and warming likes together."
                        />
                      </div>

                      <div className={cn(
                        "rounded-md px-3 py-2 text-[11px] flex items-start gap-2",
                        a.currentVerdict.allowed
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                          : "bg-muted text-muted-foreground",
                      )}>
                        <Activity className="size-3.5 mt-0.5 shrink-0" />
                        <span>
                          {a.currentVerdict.allowed
                            ? "Ready — the next invite may go out now."
                            : a.currentVerdict.message}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" onClick={() => setEditing(isOpen ? null : a.unipileAccountId)}>
                          {isOpen ? "Close" : a.policySource === "account" ? "Edit limits" : "Set custom limits"}
                        </Button>
                        <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setHistoryFor(a.unipileAccountId)}>
                          <History className="size-3.5" /> Recent activity
                        </Button>
                      </div>
                    </div>

                    {isOpen && (
                      <div className="border-t bg-muted/20 p-4">
                        <PolicyEditor
                          title={`Limits for ${a.ownerName || a.unipileAccountId}`}
                          subtitle="These override the workspace default for this account only."
                          policy={a.policy}
                          saving={save.isPending}
                          onSave={(p) => save.mutate({ unipileAccountId: a.unipileAccountId, policy: p })}
                          onReset={a.policySource === "account"
                            ? () => clear.mutate({ unipileAccountId: a.unipileAccountId })
                            : undefined}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {data && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold">Workspace default</h2>
              <p className="text-xs text-muted-foreground">
                Applied to every connected account without its own limits — including any connected in future.
                {data.usingBuiltinDefault && " Nothing has been saved yet, so the built-in defaults are shown."}
              </p>
              <PolicyEditor
                title="Default for all LinkedIn accounts"
                subtitle="Conservative on purpose. Raise deliberately, and watch the weekly invite number."
                policy={data.workspaceDefault ?? DEFAULT_LINKEDIN_POLICY}
                saving={save.isPending}
                onSave={(p) => save.mutate({ unipileAccountId: null, policy: p })}
              />
            </div>
          )}
        </div>
      </div>

      <Dialog open={!!historyFor} onOpenChange={(o) => { if (!o) setHistoryFor(null); }}>
        <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="text-base">Recent LinkedIn activity</DialogTitle></DialogHeader>
          {recent.isLoading ? (
            <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-8 rounded bg-muted/50 animate-pulse" />)}</div>
          ) : (recent.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No recorded activity for this account yet.</p>
          ) : (
            <div className="divide-y">
              {(recent.data ?? []).map((r) => (
                <div key={r.id} className="flex items-center gap-2 py-1.5 text-xs">
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 capitalize shrink-0">{r.kind}</Badge>
                  <span className="min-w-0 truncate text-muted-foreground">{r.targetIdentifier || "—"}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground">{fmt(r.occurredAt)}</span>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
