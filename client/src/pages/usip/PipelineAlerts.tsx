import { useState } from "react";
import { trpc } from "@/lib/trpc";
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
} from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";

const PIPELINE_STAGES = [
  "prospecting",
  "qualification",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
];

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
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Log Activity — {deal?.name}</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">Add a note to this deal's activity timeline.</p>
          <Textarea placeholder="e.g. Called prospect — left voicemail" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
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
  const moveStage = trpc.pipelineAlerts.moveDealStage.useMutation({
    onSuccess: () => { toast.success(`Deal moved to ${newStage}`); setNewStage(""); onSuccess(); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Move Stage — {deal?.name}</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">Current: <span className="font-medium capitalize">{deal?.stage}</span> ({deal?.daysInStage ?? 0} days)</p>
          <Select value={newStage} onValueChange={setNewStage}>
            <SelectTrigger><SelectValue placeholder="Select new stage…" /></SelectTrigger>
            <SelectContent>
              {PIPELINE_STAGES.filter((s) => s !== deal?.stage).map((s) => (
                <SelectItem key={s} value={s}><span className="capitalize">{s.replace(/_/g, " ")}</span></SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => moveStage.mutate({ opportunityId: deal.id, newStage })} disabled={!newStage || moveStage.isPending}>
            {moveStage.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Move Stage
          </Button>
        </DialogFooter>
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
    onSuccess: () => { toast.success("Alert dismissed"); onDismiss(); },
    onError: (e) => toast.error(e.message),
  });

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
          <div className="ml-auto flex gap-2">
            <Link href={`/pipeline`}>
              <Button size="sm" variant="ghost" className="h-6 text-xs px-2">
                View Opp
              </Button>
            </Link>
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
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PipelineAlerts() {
  const [filterType, setFilterType] = useState<string>("all");

  const { data: summary, refetch: refetchSummary } = trpc.pipelineAlerts.summary.useQuery(undefined, {
    refetchInterval: 30000,
  });
  const { data: alerts = [], isLoading, refetch } = trpc.pipelineAlerts.list.useQuery(
    { limit: 100 },
    { refetchInterval: 30000 }
  );
  const { data: stuckDeals = [], isLoading: stuckLoading, refetch: refetchStuck } =
    trpc.pipelineAlerts.getStuckDeals.useQuery({}, { refetchInterval: 60000 });

  const scan = trpc.pipelineAlerts.scan.useMutation({
    onSuccess: (data) => {
      toast.success(`Scan complete — ${data.created} new alerts created (${data.scanned} opportunities checked)`);
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

  const handleRefresh = () => {
    refetch();
    refetchSummary();
    refetchStuck();
  };

  const filteredAlerts =
    filterType === "all" ? alerts : alerts.filter((a: any) => a.alertType === filterType);

  const totalAlerts = summary?.total ?? 0;
  const filterTypes = ["all", "no_activity", "closing_soon_regression", "amount_change", "no_champion", "deal_stuck"];

  return (
    <Shell title="Pipeline Alerts">
      <PageHeader
        title="Pipeline Health Alerts" pageKey="pipeline-alerts"
        description="Real-time alerts for stalled deals, at-risk accounts, and pipeline anomalies."
      
        icon={<AlertTriangle className="size-5" />}
      >
        <Button variant="outline" size="sm" onClick={handleRefresh}>
          <RefreshCw className="h-4 w-4 mr-1" />
          Refresh
        </Button>
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
      <div className="p-6 space-y-6">

      {/* Summary KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { type: "no_activity", label: "No Activity", icon: Clock, color: "text-orange-600" },
          { type: "closing_soon_regression", label: "Closing Soon", icon: TrendingDown, color: "text-red-600" },
          { type: "no_champion", label: "No Champion", icon: UserX, color: "text-purple-600" },
          { type: "amount_change", label: "Amount Changed", icon: DollarSign, color: "text-yellow-600" },
          { type: "deal_stuck", label: "Stuck Deals", icon: Timer, color: "text-amber-600", stuckCount: true },
        ].map(({ type, label, icon: Icon, color, stuckCount }) => (
          <Card
            key={type}
            className={`cursor-pointer transition-all ${filterType === type ? "ring-2 ring-primary" : "hover:shadow-md"}`}
            onClick={() => setFilterType(filterType === type ? "all" : type)}
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
            <div className="space-y-2">
              {filteredAlerts.map((alert: any) => (
                <AlertCard key={alert.id} alert={alert} onDismiss={handleRefresh} />
              ))}
            </div>
          )}
        </div>
      )}
      </div>
    </Shell>
  );
}
