import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { invalidateDealReads } from "@/lib/crmCache";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, Shell } from "@/components/usip/Shell";
import {
  AlertTriangle,
  Clock,
  TrendingDown,
  UserX,
  DollarSign,
  RefreshCw,
  CheckCircle,
  Loader2,
  Activity,
  XCircle,
  Timer,
  MessageSquarePlus,
  ArrowRightCircle,
  Mail,
  Trash2,
  CalendarX,
  AlarmClock,
  AlarmClockOff,
} from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";
import { ConfirmButton } from "@/components/usip/Common";
import { useLostReasonPrompt } from "@/components/usip/LostReasonDialog";
import { formatAmount } from "@shared/money";
import { pressable } from "@/lib/pressable";
import { useAuth } from "@/_core/hooks/useAuth";
import { useWorkspaceRole } from "@/hooks/useWorkspaceRole";
import { FailedLoadsBanner } from "@/components/usip/QueryState";

const ALERT_CONFIG: Record<
  string,
  { label: string; icon: React.ComponentType<any>; color: string; bg: string; description: (d: any) => string }
> = {
  no_activity: {
    label: "No Activity",
    icon: Clock,
    color: "text-orange-600",
    bg: "bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800",
    description: (d) => `No activity logged in the past ${d?.daysSinceActivity ?? 14} days`,
  },
  closing_soon_regression: {
    label: "Closing Soon / Low Win Prob",
    icon: TrendingDown,
    color: "text-red-600",
    bg: "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800",
    description: (d) =>
      `Closing in ${d?.daysUntilClose ?? "?"} days with only ${d?.winProb ?? "?"}% win probability`,
  },
  // A close date that has passed — it was counted as "closing soon" (R38).
  past_close_date: {
    label: "Past Close Date",
    icon: CalendarX,
    color: "text-rose-700",
    bg: "bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-800",
    description: (d) =>
      `Close date passed ${d?.daysPastClose ?? "?"} day${d?.daysPastClose === 1 ? "" : "s"} ago, still open at ${d?.winProb ?? "?"}% win probability`,
  },
  amount_change: {
    label: "Amount Changed",
    icon: DollarSign,
    color: "text-yellow-600",
    bg: "bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800",
    description: (d) =>
      d?.previousAmount && d?.currentAmount
        ? `Amount changed from $${Number(d.previousAmount).toLocaleString()} to $${Number(d.currentAmount).toLocaleString()}`
        : "Deal amount has changed significantly",
  },
  no_champion: {
    label: "No Champion",
    icon: UserX,
    color: "text-purple-600",
    bg: "bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800",
    description: (d) => `No contact roles linked to this ${d?.stage ?? ""} opportunity`,
  },
};

// ─── Log Activity Dialog ──────────────────────────────────────────────────────
function LogActivityDialog({
  deal, open, onClose, onSuccess,
}: { deal: any; open: boolean; onClose: () => void; onSuccess: () => void }) {
  const [note, setNote] = useState("");
  const logActivity = trpc.pipelineAlerts.logActivityOnDeal.useMutation({
    onSuccess: () => { toast.success("Activity logged"); setNote(""); onSuccess(); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Log Activity — {deal?.name}</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">Add a note to this deal's activity timeline.</p>
          <Textarea aria-label="Activity note" placeholder="e.g. Called prospect — left voicemail" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => logActivity.mutate({ opportunityId: deal.id, note })} disabled={!note.trim() || logActivity.isPending}>
            {logActivity.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Log Activity
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Move Stage Dialog ────────────────────────────────────────────────────────
function MoveStageDialog({
  deal, open, onClose, onSuccess,
}: { deal: any; open: boolean; onClose: () => void; onSuccess: () => void }) {
  const [newStage, setNewStage] = useState("");
  // Pull the real stage keys for this deal's pipeline (falls back to the
  // workspace default pipeline) so the dropdown can never offer a stage the
  // kanban board doesn't have — which previously orphaned the deal.
  const pipelineQ = trpc.crmPipelines.get.useQuery(
    { pipelineId: deal?.pipelineId ?? undefined },
    { enabled: open },
  );
  const stages = pipelineQ.data?.stages ?? [];
  const utils = trpc.useUtils();
  const moveStage = trpc.pipelineAlerts.moveDealStage.useMutation({
    // The deal's own pages and numbers too, not just this list (R31).
    onSuccess: () => { toast.success(`Deal moved to ${newStage}`); setNewStage(""); invalidateDealReads(utils); onSuccess(); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  // A move to a lost stage asks why first; Skip still moves it (F28).
  const lostPrompt = useLostReasonPrompt((v: { opportunityId: number; newStage: string }) => moveStage.mutate(v));
  const target = stages.find((s: any) => s.key === newStage);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Move Stage — {deal?.name}</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">Current: <span className="font-medium capitalize">{deal?.stage}</span> ({deal?.daysInStage ?? 0} days)</p>
          <Select value={newStage} onValueChange={setNewStage}>
            <SelectTrigger><SelectValue placeholder={pipelineQ.isLoading ? "Loading stages…" : "Select new stage…"} /></SelectTrigger>
            <SelectContent>
              {stages.filter((s: any) => s.key !== deal?.stage).map((s: any) => (
                <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => lostPrompt.ask({ opportunityId: deal.id, newStage }, { isLost: !!target?.isLost, dealName: deal?.name ?? "this deal", stageLabel: target?.label ?? newStage })} disabled={!newStage || moveStage.isPending}>
            {moveStage.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Move Stage
          </Button>
        </DialogFooter>
        {/* Inside the content, so the nested dialog layers over this one. */}
        {lostPrompt.dialog}
      </DialogContent>
    </Dialog>
  );
}

// ─── Stuck Deal Card ──────────────────────────────────────────────────────────
function StuckDealCard({ deal, onAction }: { deal: any; onAction: () => void }) {
  const [logOpen, setLogOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  return (
    <>
      <div className="flex items-start gap-3 p-3 rounded-lg border bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800">
        <Timer className="h-5 w-5 mt-0.5 shrink-0 text-amber-600" />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">{deal.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Stuck in <span className="font-medium capitalize">{deal.stage?.replace(/_/g, " ")}</span> for{" "}
                <span className="font-semibold text-amber-700 dark:text-amber-400">{deal.daysInStage ?? 0} days</span>
                {" "}(threshold: {deal.threshold} days)
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Badge variant="outline" className="text-xs text-amber-600 border-amber-400">Stuck Deal</Badge>
              <Badge variant="secondary" className="text-xs capitalize">{deal.stage?.replace(/_/g, " ")}</Badge>
            </div>
          </div>
          <div className="flex items-center gap-3 mt-2">
            {deal.value && <span className="text-xs text-muted-foreground">${Number(deal.value).toLocaleString()}</span>}
            {deal.ownerName && <span className="text-xs text-muted-foreground">Owner: {deal.ownerName}</span>}
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" className="h-6 text-xs px-2 text-blue-600 hover:text-blue-700" onClick={() => setLogOpen(true)}>
                <MessageSquarePlus className="h-3 w-3 mr-1" />Log Activity
              </Button>
              <Button size="sm" variant="ghost" className="h-6 text-xs px-2 text-emerald-600 hover:text-emerald-700" onClick={() => setMoveOpen(true)}>
                <ArrowRightCircle className="h-3 w-3 mr-1" />Move Stage
              </Button>
              <Link href="/pipeline"><Button size="sm" variant="ghost" className="h-6 text-xs px-2">View</Button></Link>
            </div>
          </div>
        </div>
      </div>
      <LogActivityDialog deal={deal} open={logOpen} onClose={() => setLogOpen(false)} onSuccess={onAction} />
      <MoveStageDialog deal={deal} open={moveOpen} onClose={() => setMoveOpen(false)} onSuccess={onAction} />
    </>
  );
}

/**
 * The queue grouped by deal (audit 2026-10-20, U25): a deal with three alerts
 * was three separate cards. Deals with the most alerts first, then the
 * newest; each deal's alerts newest first.
 */
export function groupAlertsByDeal<A extends { opportunityId: number; createdAt?: string | Date | null; opportunity?: any }>(alerts: A[]) {
  const groups = new Map<number, { opportunityId: number; opportunity: any; alerts: A[]; newest: number }>();
  for (const a of alerts) {
    const t = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const g = groups.get(a.opportunityId) ?? { opportunityId: a.opportunityId, opportunity: a.opportunity ?? null, alerts: [], newest: 0 };
    g.alerts.push(a);
    g.newest = Math.max(g.newest, t);
    groups.set(a.opportunityId, g);
  }
  const at = (a: A) => (a.createdAt ? new Date(a.createdAt).getTime() : 0);
  return Array.from(groups.values())
    .map((g) => ({ ...g, alerts: g.alerts.slice().sort((x, y) => at(y) - at(x)) }))
    .sort((a, b) => b.alerts.length - a.alerts.length || b.newest - a.newest);
}

/** "YYYY-MM-DD", `days` from today on this device's calendar. */
function dayFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ─── Snooze Dialog (U25) ──────────────────────────────────────────────────────
function SnoozeDialog({ alert, open, onClose, onDone }: { alert: any; open: boolean; onClose: () => void; onDone: () => void }) {
  const [until, setUntil] = useState(dayFromToday(3));
  const snooze = trpc.pipelineAlerts.snooze.useMutation({
    onSuccess: () => { toast.success(`Snoozed until ${until}. It comes back then if the deal still needs it.`); onDone(); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Snooze alert — {alert?.opportunity?.name ?? "deal"}</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">Off the queue until the day you pick. It still clears itself if the deal no longer needs it.</p>
          <div className="flex flex-wrap gap-1.5">
            {[["Tomorrow", 1], ["3 days", 3], ["1 week", 7], ["2 weeks", 14]].map(([label, n]) => (
              <Button key={label} type="button" size="sm" variant={until === dayFromToday(n as number) ? "default" : "outline"} className="h-7 text-xs"
                onClick={() => setUntil(dayFromToday(n as number))}>{label}</Button>
            ))}
          </div>
          <label className="block text-xs font-medium" htmlFor="snooze-until">Until</label>
          <input id="snooze-until" type="date" min={dayFromToday(1)} value={until} onChange={(e) => setUntil(e.target.value)}
            className="h-9 w-full text-sm rounded-md border bg-background px-2" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => snooze.mutate({ alertId: alert.id, until })} disabled={!until || snooze.isPending}>
            {snooze.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Snooze
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AlertCard({ alert, onDismiss }: { alert: any; onDismiss: () => void }) {
  const config = ALERT_CONFIG[alert.alertType] ?? {
    label: alert.alertType,
    icon: AlertTriangle,
    color: "text-gray-600",
    bg: "bg-gray-50 dark:bg-gray-900/20 border-gray-200",
    description: () => "Alert",
  };
  const Icon = config.icon;
  const details = alert.details ?? {};

  const dismiss = trpc.pipelineAlerts.dismiss.useMutation({
    onSuccess: () => { toast.success("Dismissed for 7 days. It comes back after that if the deal still needs it."); onDismiss(); },
    onError: (e) => toast.error(e.message),
  });
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const snoozedUntil = alert.snoozedUntil && new Date(alert.snoozedUntil).getTime() > Date.now() ? new Date(alert.snoozedUntil) : null;
  const wake = trpc.pipelineAlerts.unsnooze.useMutation({
    onSuccess: () => { toast.success("Back on the queue"); onDismiss(); },
    onError: (e) => toast.error(e.message),
  });
  // Clearing an alert hides it from everyone: the deal's owner or a manager (R37).
  const { user } = useAuth();
  const isManager = useWorkspaceRole().isManager;
  const canDismiss = isManager || (alert.opportunity?.ownerUserId != null && alert.opportunity.ownerUserId === user?.id);

  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg border ${config.bg}`}>
      <Icon className={`h-5 w-5 mt-0.5 shrink-0 ${config.color}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">
              {alert.opportunity?.name ?? `Opp #${alert.opportunityId}`}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">{config.description(details)}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Badge variant="outline" className={`text-xs ${config.color}`}>
              {config.label}
            </Badge>
            {alert.opportunity?.stage && (
              <Badge variant="secondary" className="text-xs capitalize">
                {alert.opportunity.stage}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 mt-2">
          {alert.opportunity?.value && (
            <span className="text-xs text-muted-foreground">
              ${Number(alert.opportunity.value).toLocaleString()}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {new Date(alert.createdAt).toLocaleDateString()}
          </span>
          {snoozedUntil && <span className="text-xs text-muted-foreground">Snoozed until {snoozedUntil.toLocaleDateString()}</span>}
          <div className="ml-auto flex gap-2">
            {/* This was href={`/pipeline`} — a template literal with nothing
                interpolated into it, so every alert's "View Opp" landed on the
                generic board and the alert could not be investigated. The
                detail route (/opportunities/:id) existed the whole time. */}
            <Link href={`/opportunities/${alert.opportunityId}`}>
              <Button size="sm" variant="ghost" className="h-6 text-xs px-2">
                View Opp
              </Button>
            </Link>
            {canDismiss && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-xs px-2 text-muted-foreground hover:text-foreground"
                onClick={() => dismiss.mutate({ alertId: alert.id })}
                disabled={dismiss.isPending}
              >
                {dismiss.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <XCircle className="h-3 w-3" />
                )}
                Dismiss
              </Button>
            )}
            {/* Snooze to a day, or wake a snoozed one (U25): the same people as Dismiss. */}
            {canDismiss && snoozedUntil && (
              <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => wake.mutate({ alertId: alert.id })} disabled={wake.isPending}>
                <AlarmClockOff className="h-3 w-3 mr-1" />Wake now
              </Button>
            )}
            {canDismiss && !snoozedUntil && (
              <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => setSnoozeOpen(true)}>
                <AlarmClock className="h-3 w-3 mr-1" />Snooze
              </Button>
            )}
          </div>
        </div>
      </div>
      {snoozeOpen && <SnoozeDialog alert={alert} open={snoozeOpen} onClose={() => setSnoozeOpen(false)} onDone={onDismiss} />}
    </div>
  );
}

/** One deal's alerts under one heading that opens the deal (U25). */
function DealAlertGroup({ group, onChange }: { group: { opportunityId: number; opportunity: any; alerts: any[] }; onChange: () => void }) {
  const o = group.opportunity;
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        <Link href={`/opportunities/${group.opportunityId}`} className="text-sm font-semibold hover:underline truncate">
          {o?.name ?? `Opp #${group.opportunityId}`}
        </Link>
        {o?.stage && <Badge variant="secondary" className="text-xs capitalize">{o.stage}</Badge>}
        {o?.value && <span className="text-xs text-muted-foreground">{formatAmount(o.value)}</span>}
        <Badge variant="outline" className="ml-auto text-xs">{group.alerts.length} alert{group.alerts.length === 1 ? "" : "s"}</Badge>
      </div>
      <div className="p-2 space-y-2">
        {group.alerts.map((alert: any) => <AlertCard key={alert.id} alert={alert} onDismiss={onChange} />)}
      </div>
    </div>
  );
}

export default function PipelineAlerts() {
  const [filterType, setFilterType] = useState<string>("all");
  // The queue, or what is snoozed off it (U25).
  const [showSnoozed, setShowSnoozed] = useState(false);

  const { data: summary, refetch: refetchSummary } = trpc.pipelineAlerts.summary.useQuery(undefined, {
    refetchInterval: 30000,
  });
  const { data: alerts = [], isLoading, refetch } = trpc.pipelineAlerts.list.useQuery(
    { limit: 100, snoozed: showSnoozed },
    { refetchInterval: 30000 }
  );
  const { data: stuckDeals = [], isLoading: stuckLoading, refetch: refetchStuck } =
    trpc.pipelineAlerts.getStuckDeals.useQuery({}, { refetchInterval: 60000 });

  const scan = trpc.pipelineAlerts.scan.useMutation({
    onSuccess: (data) => {
      toast.success(`Scan complete — ${data.created} new, ${data.resolved} resolved (${data.scanned} open deals checked)`);
      refetch();
      refetchSummary();
      refetchStuck();
    },
    onError: (e) => toast.error(e.message),
  });

  const sendDigest = trpc.pipelineAlerts.sendDigest.useMutation({
    onSuccess: (data) => {
      if (data.sent) {
        toast.success(`Digest sent to ${data.recipient} — ${data.count} stuck deal${data.count !== 1 ? "s" : ""} included`);
      } else {
        toast.info(data.reason ?? "No stuck deals to include in digest");
      }
    },
    onError: (e) => toast.error(e.message),
  });

  // Clear all hard-deletes every alert: an admin's (R37).
  const isAdmin = useWorkspaceRole().isAdmin;
  const clearAll = trpc.pipelineAlerts.clearAll.useMutation({
    onSuccess: (data) => {
      toast.success(`Deleted ${data.deleted} alert${data.deleted === 1 ? "" : "s"}`);
      refetch();
      refetchSummary();
    },
    onError: (e) => toast.error(e.message),
  });

  const handleRefresh = () => {
    refetch();
    refetchSummary();
    refetchStuck();
  };

  const filteredAlerts =
    filterType === "all" ? alerts : alerts.filter((a: any) => a.alertType === filterType);
  const dealGroups = groupAlertsByDeal(filteredAlerts as any[]);

  const totalAlerts = summary?.total ?? 0;
  const filterTypes = ["all", "no_activity", "closing_soon_regression", "past_close_date", "amount_change", "no_champion", "deal_stuck"];

  return (
    <Shell title="Pipeline Alerts">
      <PageHeader
        title="Pipeline Health Alerts" pageKey="pipeline-alerts"
        description="Alerts for deals with no activity in 14 days, a close date that passed or slipped, no champion, or a large change in amount. Deals that changed are checked every 15 minutes and every open deal at least every few hours; deal-stuck workflow rules set per-stage thresholds."
      
        icon={<AlertTriangle className="size-5" />}
      >
        <Button variant="outline" size="sm" onClick={handleRefresh}>
          <RefreshCw className="h-4 w-4 mr-1" />
          Refresh
        </Button>
        {isAdmin && totalAlerts > 0 && (
          <ConfirmButton
            variant="outline"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onConfirm={() => clearAll.mutate()}
            disabled={clearAll.isPending}
            ariaLabel="Delete every alert for this workspace"
            title={`Delete all ${totalAlerts} alert${totalAlerts === 1 ? "" : "s"}?`}
            description="This hard-deletes every alert row for the workspace. New ones will appear on the next health scan. This cannot be undone."
            confirmLabel="Delete all"
          >
            {clearAll.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <Trash2 className="h-4 w-4 mr-1" />
            )}
            Clear all
          </ConfirmButton>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => sendDigest.mutate()}
          disabled={sendDigest.isPending}
          title="Email a digest of stuck deals to the workspace owner"
        >
          {sendDigest.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1" />
          ) : (
            <Mail className="h-4 w-4 mr-1" />
          )}
          Send Digest
        </Button>
        <Button size="sm" onClick={() => scan.mutate()} disabled={scan.isPending}>
          {scan.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1" />
          ) : (
            <Activity className="h-4 w-4 mr-1" />
          )}
          Run Health Scan
        </Button>
      </PageHeader>
      {/* A failed load says so instead of showing an empty page (audit X1.6). */}
      <div className="px-4 md:px-6 pt-2 empty:hidden"><FailedLoadsBanner /></div>
      <div className="p-4 md:p-5 space-y-6">

      {/* Summary KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { type: "no_activity", label: "No Activity", icon: Clock, color: "text-orange-600" },
          { type: "closing_soon_regression", label: "Closing Soon", icon: TrendingDown, color: "text-red-600" },
          { type: "past_close_date", label: "Past Close", icon: CalendarX, color: "text-rose-700" },
          { type: "no_champion", label: "No Champion", icon: UserX, color: "text-purple-600" },
          { type: "amount_change", label: "Amount Changed", icon: DollarSign, color: "text-yellow-600" },
          { type: "deal_stuck", label: "Stuck Deals", icon: Timer, color: "text-amber-600", stuckCount: true },
        ].map(({ type, label, icon: Icon, color, stuckCount }) => (
          <Card
            key={type}
            className={`cursor-pointer transition-all ${filterType === type ? "ring-2 ring-primary" : "hover:shadow-md"}`}
            {...pressable(() => setFilterType(filterType === type ? "all" : type))}
          >
            <CardContent className="p-4 flex items-center gap-3">
              <Icon className={`h-8 w-8 ${color} shrink-0`} />
              <div>
                <p className="text-2xl font-bold tabular-nums">
                  {stuckCount ? (stuckDeals as any[]).length : (summary?.byType?.[type] ?? 0)}
                </p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-muted-foreground">Filter:</span>
        {filterTypes.map((t) => (
          <Button
            key={t}
            size="sm"
            variant={filterType === t ? "default" : "outline"}
            onClick={() => setFilterType(t)}
            className="capitalize text-xs"
          >
            {t === "all"
              ? `All (${totalAlerts + (stuckDeals as any[]).length})`
              : t === "deal_stuck"
              ? `Stuck Deals (${(stuckDeals as any[]).length})`
              : ALERT_CONFIG[t]?.label ?? t}
          </Button>
        ))}
        <Button size="sm" variant={showSnoozed ? "default" : "outline"} className="text-xs ml-auto" aria-pressed={showSnoozed}
          onClick={() => setShowSnoozed((v) => !v)}>
          <AlarmClock className="h-3 w-3 mr-1" />{showSnoozed ? "Back to the queue" : `Snoozed (${summary?.snoozed ?? 0})`}
        </Button>
      </div>

      {/* Stuck Deals section */}
      {(filterType === "all" || filterType === "deal_stuck") && (
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-2">
            <Timer className="h-4 w-4 text-amber-500" />
            Stuck Deals ({(stuckDeals as any[]).length})
          </h3>
          {stuckLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading stuck deals…
            </div>
          ) : (stuckDeals as any[]).length === 0 ? (
            <Card>
              <CardContent className="flex items-center justify-center py-6 text-center">
                <div>
                  <CheckCircle className="h-8 w-8 text-emerald-500/40 mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">No stuck deals detected</p>
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    Configure deal-stuck workflow rules to set stage thresholds
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {(stuckDeals as any[]).map((deal) => (
                <StuckDealCard key={deal.id} deal={deal} onAction={handleRefresh} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Health Alerts section */}
      {filterType !== "deal_stuck" && (
        <div>
          {filterType !== "all" && (
            <h3 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-orange-500" />
              Health Alerts ({filteredAlerts.length})
            </h3>
          )}
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading alerts…
            </div>
          ) : filteredAlerts.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <CheckCircle className="h-12 w-12 text-emerald-500/40 mb-3" />
                <p className="font-medium text-muted-foreground">
                  {filterType === "all" ? "No active health alerts" : `No ${ALERT_CONFIG[filterType]?.label ?? filterType} alerts`}
                </p>
                <p className="text-sm text-muted-foreground/70 mt-1">
                  {totalAlerts === 0
                    ? "Run a health scan to detect at-risk opportunities"
                    : "All alerts in this category have been dismissed"}
                </p>
                {totalAlerts === 0 && (
                  <Button className="mt-4" size="sm" onClick={() => scan.mutate()} disabled={scan.isPending}>
                    {scan.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Activity className="h-4 w-4 mr-1" />}
                    Run Health Scan
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {dealGroups.map((g) => (
                <DealAlertGroup key={g.opportunityId} group={g} onChange={handleRefresh} />
              ))}
            </div>
          )}
        </div>
      )}
      </div>
    </Shell>
  );
}
