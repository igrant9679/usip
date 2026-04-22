import { Shell, PageHeader } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useLocation } from "wouter";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Copy,
  ExternalLink,
  Mail,
  Phone,
  RefreshCw,
  ShieldAlert,
  Users,
  XCircle,
} from "lucide-react";

function MetricCard({
  label,
  value,
  pct,
  icon: Icon,
  tone,
  fixHref,
  fixLabel,
}: {
  label: string;
  value: number;
  pct?: number;
  icon: any;
  tone: "default" | "success" | "warning" | "danger";
  fixHref?: string;
  fixLabel?: string;
}) {
  const [, setLocation] = useLocation();
  const toneRing =
    tone === "success"
      ? "border-emerald-200 bg-emerald-50/60"
      : tone === "warning"
      ? "border-amber-200 bg-amber-50/60"
      : tone === "danger"
      ? "border-rose-200 bg-rose-50/60"
      : "border-border bg-card";
  const iconCls =
    tone === "success"
      ? "text-emerald-600"
      : tone === "warning"
      ? "text-amber-600"
      : tone === "danger"
      ? "text-rose-600"
      : "text-muted-foreground";

  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-2 ${toneRing}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
        <Icon className={`size-4 ${iconCls}`} />
      </div>
      <div className="text-2xl font-bold tabular-nums">{value.toLocaleString()}</div>
      {pct !== undefined && (
        <div className="space-y-1">
          <Progress value={pct} className="h-1.5" />
          <div className="text-xs text-muted-foreground">{pct}% of contacts</div>
        </div>
      )}
      {fixHref && fixLabel && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-7 text-xs px-2 self-start"
          onClick={() => setLocation(fixHref)}
        >
          <ExternalLink className="size-3 mr-1" />
          {fixLabel}
        </Button>
      )}
    </div>
  );
}

function FieldCoverageBar({ label, pct }: { label: string; pct: number }) {
  const color =
    pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 text-sm text-muted-foreground shrink-0">{label}</div>
      <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-10 text-right text-sm font-mono tabular-nums">{pct}%</div>
    </div>
  );
}

export default function DataHealth() {
  const { data: metrics, isLoading: metricsLoading, refetch } = trpc.dataHealth.getMetrics.useQuery();
  const { data: dupes, isLoading: dupesLoading } = trpc.dataHealth.getDuplicateGroups.useQuery();

  const total = metrics?.total ?? 0;

  return (
    <Shell title="Data Health">
      <PageHeader
        title="Data Health"
        description="Monitor the quality and completeness of your contact database."
      >
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="size-3.5 mr-1.5" />
          Refresh
        </Button>
      </PageHeader>

      <div className="p-4 md:p-6 space-y-8">
        {/* KPI Summary Row */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Overview
          </h2>
          {metricsLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-28 rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <MetricCard
                label="Total Contacts"
                value={total}
                icon={Users}
                tone="default"
              />
              <MetricCard
                label="With Email"
                value={metrics?.withEmail ?? 0}
                pct={metrics?.pctWithEmail}
                icon={Mail}
                tone={
                  (metrics?.pctWithEmail ?? 0) >= 80
                    ? "success"
                    : (metrics?.pctWithEmail ?? 0) >= 50
                    ? "warning"
                    : "danger"
                }
                fixHref="/contacts?missingEmail=1"
                fixLabel="Fix Now"
              />
              <MetricCard
                label="With Phone"
                value={metrics?.withPhone ?? 0}
                pct={metrics?.pctWithPhone}
                icon={Phone}
                tone={
                  (metrics?.pctWithPhone ?? 0) >= 60
                    ? "success"
                    : (metrics?.pctWithPhone ?? 0) >= 30
                    ? "warning"
                    : "danger"
                }
              />
              <MetricCard
                label="Verified Emails"
                value={
                  (metrics?.verifiedValid ?? 0) +
                  (metrics?.verifiedAcceptAll ?? 0) +
                  (metrics?.verifiedRisky ?? 0) +
                  (metrics?.verifiedInvalid ?? 0)
                }
                pct={metrics?.pctVerified}
                icon={CheckCircle2}
                tone={
                  (metrics?.pctVerified ?? 0) >= 80
                    ? "success"
                    : (metrics?.pctVerified ?? 0) >= 40
                    ? "warning"
                    : "danger"
                }
                fixHref="/contacts?verif=unknown"
                fixLabel="Verify Now"
              />
              <MetricCard
                label="Invalid Emails"
                value={metrics?.verifiedInvalid ?? 0}
                icon={XCircle}
                tone={(metrics?.verifiedInvalid ?? 0) === 0 ? "success" : "danger"}
                fixHref="/contacts?verif=invalid"
                fixLabel="View Invalid"
              />
              <MetricCard
                label="Duplicates"
                value={metrics?.estimatedDuplicates ?? 0}
                icon={Copy}
                tone={(metrics?.estimatedDuplicates ?? 0) === 0 ? "success" : "warning"}
              />
            </div>
          )}
        </section>

        {/* Email Verification Breakdown */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Email Verification Breakdown
          </h2>
          {metricsLoading ? (
            <Skeleton className="h-24 rounded-xl" />
          ) : (
            <Card>
              <CardContent className="pt-5 pb-4">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  {[
                    { label: "Valid", value: metrics?.verifiedValid ?? 0, color: "bg-emerald-500", href: "/contacts?verif=valid" },
                    { label: "Accept-All", value: metrics?.verifiedAcceptAll ?? 0, color: "bg-yellow-500", href: "/contacts?verif=accept_all" },
                    { label: "Risky", value: metrics?.verifiedRisky ?? 0, color: "bg-orange-500", href: "/contacts?verif=risky" },
                    { label: "Invalid", value: metrics?.verifiedInvalid ?? 0, color: "bg-rose-500", href: "/contacts?verif=invalid" },
                    { label: "Not Verified", value: metrics?.verifiedUnknown ?? 0, color: "bg-gray-400", href: "/contacts?verif=unknown" },
                  ].map((item) => {
                    const pct = total > 0 ? Math.round((item.value / total) * 100) : 0;
                    return (
                      <div key={item.label} className="text-center space-y-1">
                        <div className={`mx-auto size-2 rounded-full ${item.color}`} />
                        <div className="text-xl font-bold tabular-nums">{item.value.toLocaleString()}</div>
                        <div className="text-xs text-muted-foreground">{item.label}</div>
                        <div className="text-xs font-mono text-muted-foreground">{pct}%</div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-[11px] px-2"
                          onClick={() => {}}
                        >
                          View
                        </Button>
                      </div>
                    );
                  })}
                </div>
                {/* Stacked bar */}
                <div className="mt-4 h-3 rounded-full overflow-hidden flex">
                  {[
                    { value: metrics?.verifiedValid ?? 0, color: "bg-emerald-500" },
                    { value: metrics?.verifiedAcceptAll ?? 0, color: "bg-yellow-500" },
                    { value: metrics?.verifiedRisky ?? 0, color: "bg-orange-500" },
                    { value: metrics?.verifiedInvalid ?? 0, color: "bg-rose-500" },
                    { value: metrics?.verifiedUnknown ?? 0, color: "bg-gray-300" },
                  ].map((seg, i) => {
                    const pct = total > 0 ? (seg.value / total) * 100 : 0;
                    return pct > 0 ? (
                      <div key={i} className={`${seg.color} h-full`} style={{ width: `${pct}%` }} />
                    ) : null;
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </section>

        {/* Field Coverage */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Field Coverage
          </h2>
          {metricsLoading ? (
            <Skeleton className="h-40 rounded-xl" />
          ) : (
            <Card>
              <CardContent className="pt-5 pb-4 space-y-3">
                <FieldCoverageBar label="Email" pct={metrics?.pctWithEmail ?? 0} />
                <FieldCoverageBar label="Phone" pct={metrics?.pctWithPhone ?? 0} />
                <FieldCoverageBar
                  label="Account"
                  pct={total > 0 ? Math.round(((metrics?.withCompany ?? 0) / total) * 100) : 0}
                />
                <FieldCoverageBar
                  label="Title"
                  pct={total > 0 ? Math.round(((metrics?.withTitle ?? 0) / total) * 100) : 0}
                />
                <FieldCoverageBar
                  label="LinkedIn URL"
                  pct={total > 0 ? Math.round(((metrics?.withLinkedIn ?? 0) / total) * 100) : 0}
                />
                <FieldCoverageBar label="Enriched (90d)" pct={metrics?.pctEnriched ?? 0} />
              </CardContent>
            </Card>
          )}
        </section>

        {/* Duplicate Detection */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Duplicate Detection
          </h2>
          {dupesLoading ? (
            <Skeleton className="h-40 rounded-xl" />
          ) : !dupes || dupes.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground text-sm">
                <CheckCircle2 className="size-8 mx-auto mb-2 text-emerald-500" />
                No duplicate contacts detected.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  Top Duplicate Groups ({dupes.length} found)
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="divide-y">
                  {dupes.map((group, i) => (
                    <div key={i} className="py-3 flex items-start gap-3">
                      <Badge
                        variant="secondary"
                        className={`shrink-0 mt-0.5 ${
                          group.type === "email"
                            ? "bg-blue-100 text-blue-700"
                            : "bg-purple-100 text-purple-700"
                        }`}
                      >
                        {group.type === "email" ? "Email" : "Name"}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{group.key}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {group.count} records: {group.names.slice(0, 3).join(", ")}
                          {group.names.length > 3 ? ` +${group.names.length - 3} more` : ""}
                        </div>
                      </div>
                      <Badge variant="outline" className="shrink-0">
                        {group.count}×
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </section>
      </div>
    </Shell>
  );
}
