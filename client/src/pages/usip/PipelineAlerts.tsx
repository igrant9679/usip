import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
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
} from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";

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

  const scan = trpc.pipelineAlerts.scan.useMutation({
    onSuccess: (data) => {
      toast.success(`Scan complete — ${data.created} new alerts created (${data.scanned} opportunities checked)`);
      refetch();
      refetchSummary();
    },
    onError: (e) => toast.error(e.message),
  });

  const handleRefresh = () => {
    refetch();
    refetchSummary();
  };

  const filteredAlerts =
    filterType === "all" ? alerts : alerts.filter((a: any) => a.alertType === filterType);

  const totalAlerts = summary?.total ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <AlertTriangle className="h-6 w-6 text-orange-500" />
            Pipeline Health Alerts
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Proactive alerts for at-risk opportunities — no activity, closing soon, missing contacts
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => scan.mutate()}
            disabled={scan.isPending}
          >
            {scan.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <Activity className="h-4 w-4 mr-1" />
            )}
            Run Health Scan
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { type: "no_activity", label: "No Activity", icon: Clock, color: "text-orange-600" },
          { type: "closing_soon_regression", label: "Closing Soon", icon: TrendingDown, color: "text-red-600" },
          { type: "no_champion", label: "No Champion", icon: UserX, color: "text-purple-600" },
          { type: "amount_change", label: "Amount Changed", icon: DollarSign, color: "text-yellow-600" },
        ].map(({ type, label, icon: Icon, color }) => (
          <Card
            key={type}
            className={`cursor-pointer transition-all ${filterType === type ? "ring-2 ring-primary" : "hover:shadow-md"}`}
            onClick={() => setFilterType(filterType === type ? "all" : type)}
          >
            <CardContent className="p-4 flex items-center gap-3">
              <Icon className={`h-8 w-8 ${color} shrink-0`} />
              <div>
                <p className="text-2xl font-bold tabular-nums">
                  {summary?.byType?.[type] ?? 0}
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
        {["all", "no_activity", "closing_soon_regression", "no_champion", "amount_change"].map((t) => (
          <Button
            key={t}
            size="sm"
            variant={filterType === t ? "default" : "outline"}
            onClick={() => setFilterType(t)}
            className="capitalize text-xs"
          >
            {t === "all" ? `All (${totalAlerts})` : ALERT_CONFIG[t]?.label ?? t}
          </Button>
        ))}
      </div>

      {/* Alert list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading alerts...
        </div>
      ) : filteredAlerts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <CheckCircle className="h-12 w-12 text-emerald-500/40 mb-3" />
            <p className="font-medium text-muted-foreground">
              {filterType === "all" ? "No active alerts" : `No ${ALERT_CONFIG[filterType]?.label ?? filterType} alerts`}
            </p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              {totalAlerts === 0
                ? "Run a health scan to detect at-risk opportunities"
                : "All alerts in this category have been dismissed"}
            </p>
            {totalAlerts === 0 && (
              <Button
                className="mt-4"
                size="sm"
                onClick={() => scan.mutate()}
                disabled={scan.isPending}
              >
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
  );
}
