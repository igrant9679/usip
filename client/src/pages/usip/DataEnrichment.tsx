/**
 * DataEnrichment — Prospect & enrich → "Data enrichment" (/v2/data-enrichment).
 *
 * Modelled on Apollo's Data enrichment area: a tabbed page
 * (Data health center / CRM / CSV / Job change alerts / Form enrichment).
 * The Data health center wires its donuts + stats to the real
 * `dataHealth.getMetrics` query (contact email/phone completeness + freshness);
 * the other tabs are connect/upsell landings (no backend yet).
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Database,
  ChevronDown,
  Zap,
  Mail,
  Phone,
  ShieldCheck,
  CreditCard,
  Activity,
  RefreshCw,
  Upload,
  Users,
  Clock,
  Sparkles,
  CheckCircle2,
} from "lucide-react";

/* ── inline donut chart ── */
function Donut({ pct, color, sub }: { pct: number; color: string; sub?: string }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const dash = (c * Math.max(0, Math.min(100, pct))) / 100;
  return (
    <svg viewBox="0 0 100 100" className="size-28 shrink-0">
      <circle cx="50" cy="50" r={r} fill="none" stroke="currentColor" className="text-muted/40" strokeWidth="10" />
      <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${dash} ${c}`} transform="rotate(-90 50 50)" />
      <text x="50" y="48" textAnchor="middle" className="fill-foreground" fontSize="16" fontWeight="700">{pct}%</text>
      {sub && <text x="50" y="63" textAnchor="middle" className="fill-muted-foreground" fontSize="8">{sub}</text>}
    </svg>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

function Card({ title, tag, children, footer }: { title: string; tag?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card shadow-sm p-4 flex flex-col">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {tag && <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{tag}</span>}
      </div>
      <div className="flex-1">{children}</div>
      {footer && <div className="mt-3 flex items-center justify-end gap-2">{footer}</div>}
    </div>
  );
}

const TABS = ["Data health center", "CRM", "CSV", "Job change alerts", "Form enrichment"] as const;
type Tab = (typeof TABS)[number];

export default function DataEnrichment() {
  const [, setLocation] = useLocation();
  const accent = useAccentColor();
  const [tab, setTab] = useState<Tab>("Data health center");

  const { data: m, isLoading } = trpc.dataHealth.getMetrics.useQuery();
  const metrics = m as
    | { total: number; withEmail: number; withPhone: number; pctWithEmail: number; pctWithPhone: number; pctEnriched: number; pctVerified: number; enrichedLast90Days: number }
    | undefined;

  const stat = (icon: any, label: string, value: string, hint?: string) => {
    const Icon = icon;
    return (
      <div className="rounded-lg border bg-card p-3 shadow-sm min-w-0" style={{ borderLeft: `3px solid ${accent}`, backgroundImage: `linear-gradient(135deg, ${accent}14 0%, transparent 70%)` }}>
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground"><Icon className="size-3.5" /> {label}</div>
        <div className="text-xl font-semibold tabular-nums mt-0.5" style={{ color: accent }}>{value}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </div>
    );
  };

  return (
    <Shell title="Data enrichment">
      <div className="flex flex-col h-full min-h-0">
        {/* header */}
        <div className="relative shrink-0 flex items-center gap-2 px-4 pt-2.5 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <div className="flex items-center gap-2 pb-2 w-full">
            <Database className="size-4" style={{ color: accent }} />
            <h1 className="text-[15px] font-semibold tracking-tight">Data enrichment</h1>
            <div className="flex-1" />
            <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => setLocation("/data-health")}>View scheduled jobs <span className="text-muted-foreground">0</span></Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="h-7 gap-1.5" style={{ backgroundColor: accent }}><Zap className="size-3.5" /> Automate Enrichment <ChevronDown className="size-3 opacity-70" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setLocation("/are")}><Sparkles className="size-4 mr-2" /> Auto-enrich with ARE</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLocation("/data-health")}><Activity className="size-4 mr-2" /> Schedule enrichment job</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* tabs */}
        <div className="shrink-0 border-b border-border px-4 flex items-center gap-1 bg-card/40 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn("relative px-3 py-2 text-[13px] whitespace-nowrap transition-colors", tab === t ? "font-semibold" : "text-muted-foreground hover:text-foreground")}
              style={tab === t ? { color: accent } : undefined}
            >
              <span className="inline-flex items-center gap-1.5">{t}{t === "CRM" && <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">New</span>}</span>
              {tab === t && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full" style={{ backgroundColor: accent }} />}
            </button>
          ))}
        </div>

        {/* body */}
        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6">
          {tab === "Data health center" && (
            <div className="space-y-5">
              {/* top stats */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {stat(Users, "Total contacts", isLoading ? "—" : (metrics?.total ?? 0).toLocaleString())}
                {stat(Mail, "With an email", isLoading ? "—" : (metrics?.withEmail ?? 0).toLocaleString(), metrics ? `${metrics.pctWithEmail}% of contacts` : undefined)}
                {stat(Phone, "With a phone", isLoading ? "—" : (metrics?.withPhone ?? 0).toLocaleString(), metrics ? `${metrics.pctWithPhone}% of contacts` : undefined)}
                {stat(ShieldCheck, "Email verified", isLoading ? "—" : `${metrics?.pctVerified ?? 0}%`, "of contacts")}
              </div>

              {/* cards grid */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <Card title="Email completeness" tag="Contacts" footer={<Button variant="outline" size="sm" className="h-7" onClick={() => setLocation("/contacts")}>View contacts</Button>}>
                  <div className="flex items-center gap-4">
                    <Donut pct={metrics?.pctWithEmail ?? 0} color={accent} sub={`${metrics?.withEmail ?? 0}`} />
                    <div className="space-y-1.5">
                      <LegendDot color={accent} label={`${metrics?.pctWithEmail ?? 0}% have an email`} />
                      <LegendDot color="#cbd5e1" label={`${100 - (metrics?.pctWithEmail ?? 0)}% missing email`} />
                    </div>
                  </div>
                </Card>

                <Card title="Phone completeness" tag="Contacts" footer={<Button variant="outline" size="sm" className="h-7" onClick={() => setLocation("/contacts")}>View contacts</Button>}>
                  <div className="flex items-center gap-4">
                    <Donut pct={metrics?.pctWithPhone ?? 0} color="#8b5cf6" sub={`${metrics?.withPhone ?? 0}`} />
                    <div className="space-y-1.5">
                      <LegendDot color="#8b5cf6" label={`${metrics?.pctWithPhone ?? 0}% have a phone`} />
                      <LegendDot color="#cbd5e1" label={`${100 - (metrics?.pctWithPhone ?? 0)}% missing phone`} />
                    </div>
                  </div>
                </Card>

                <Card title="Enrichment freshness" tag="Last 90 days" footer={<Button variant="outline" size="sm" className="h-7" onClick={() => setLocation("/data-health")}>Schedule</Button>}>
                  <div className="flex items-center gap-4">
                    <Donut pct={metrics?.pctEnriched ?? 0} color="#10b981" sub={`${metrics?.enrichedLast90Days ?? 0}`} />
                    <div className="space-y-1.5">
                      <LegendDot color="#10b981" label={`${metrics?.pctEnriched ?? 0}% updated recently`} />
                      <LegendDot color="#cbd5e1" label={`${100 - (metrics?.pctEnriched ?? 0)}% may be stale`} />
                    </div>
                  </div>
                </Card>

                <Card title="Credit usage" tag="API & Apollo data">
                  <div className="text-center py-6">
                    <CreditCard className="size-7 mx-auto text-muted-foreground opacity-50 mb-2" />
                    <div className="text-sm font-medium">Track your credit usage</div>
                    <p className="text-xs text-muted-foreground mt-1">Stay on top of your credits for data enrichment.</p>
                    <Button size="sm" className="mt-3" style={{ backgroundColor: accent }} onClick={() => setLocation("/data-health")}>Create scheduled enrichment</Button>
                  </div>
                </Card>

                <Card title="Enrichment job activity" tag="ARE & enrichment">
                  <div className="text-center py-6">
                    <Activity className="size-7 mx-auto text-muted-foreground opacity-50 mb-2" />
                    <div className="text-sm font-medium">No enrichment activities yet</div>
                    <p className="text-xs text-muted-foreground mt-1">Schedule enrichment jobs to track changes and monitor progress.</p>
                    <Button size="sm" className="mt-3" style={{ backgroundColor: accent }} onClick={() => setLocation("/are")}>Create scheduled enrichment</Button>
                  </div>
                </Card>

                <Card title="CRM status" tag="CRM data">
                  <div className="text-center py-6">
                    <RefreshCw className="size-7 mx-auto text-muted-foreground opacity-50 mb-2" />
                    <div className="text-sm font-medium">Check your CRM data status</div>
                    <p className="text-xs text-muted-foreground mt-1">Sync your CRM to see if your data is up-to-date or needs enriching.</p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={() => setTab("CRM")}>Connect CRM</Button>
                  </div>
                </Card>
              </div>
            </div>
          )}

          {tab === "CRM" && (
            <div className="max-w-3xl mx-auto text-center py-10">
              <div className="mx-auto size-12 rounded-xl text-white flex items-center justify-center mb-4 shadow-sm" style={{ backgroundColor: accent }}><RefreshCw className="size-6" /></div>
              <h2 className="text-lg font-semibold">Enrich existing records across your CRM systems</h2>
              <p className="text-sm text-muted-foreground mt-1 max-w-xl mx-auto">Boost your CRM effectiveness with dynamic enrichment, effortlessly updating contact and account details to keep your data consistently synchronized.</p>
              <div className="mt-5 flex items-center justify-center gap-2">
                <Button className="gap-1.5" style={{ backgroundColor: accent }} onClick={() => setLocation("/settings")}>Connect Salesforce</Button>
                <Button variant="outline" className="gap-1.5" onClick={() => setLocation("/settings")}>Connect HubSpot</Button>
              </div>
              <div className="mt-10">
                <div className="text-sm font-semibold mb-4">Key benefits</div>
                <div className="grid sm:grid-cols-3 gap-5 text-left">
                  {[
                    { icon: Users, t: "Enhance customer connections", b: "Enrich CRM fields with accurate data, integrating leads cleanly into your sales strategy." },
                    { icon: Clock, t: "Save time & streamline workflows", b: "Cut manual data entry so reps focus on selling, not cleanup." },
                    { icon: CheckCircle2, t: "Ensure data consistency", b: "Keep records accurate and consistent across platforms, reducing errors." },
                  ].map((k) => {
                    const Icon = k.icon;
                    return (
                      <div key={k.t} className="rounded-xl border bg-card p-4 shadow-sm">
                        <Icon className="size-5 mb-2" style={{ color: accent }} />
                        <div className="text-[13px] font-semibold">{k.t}</div>
                        <p className="text-[12px] text-muted-foreground mt-1">{k.b}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {tab === "CSV" && (
            <div className="max-w-2xl mx-auto text-center py-10">
              <div className="flex items-center justify-end mb-2">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setLocation("/import")}><Upload className="size-4" /> Import CSV</Button>
              </div>
              <div className="rounded-xl border bg-card shadow-sm p-4 text-left">
                <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground mb-2"><Database className="size-3.5" /> Sample · records with missing data</div>
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground"><th className="py-1">Name</th><th>Company</th><th>Email</th><th>Phone</th></tr></thead>
                  <tbody>
                    {["Sarah Chen", "James Miller", "Maria Santos", "Alex Kim", "Tom Wright"].map((n) => (
                      <tr key={n} className="border-t border-border/60">
                        <td className="py-2 font-medium">{n}</td>
                        {[0, 1, 2].map((i) => <td key={i} className="py-2"><span className="block h-2 w-20 rounded bg-muted" /></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h2 className="text-base font-semibold mt-6">Fill data gaps in any list</h2>
              <p className="text-sm text-muted-foreground mt-1">Upload a CSV and fill missing fields with verified data to complete your records faster.</p>
              <Button className="mt-4" style={{ backgroundColor: accent }} onClick={() => setLocation("/import")}>Import a CSV to enrich</Button>
              <p className="text-[11px] text-muted-foreground mt-4 inline-flex items-center gap-1"><Activity className="size-3" /> 97% email accuracy, verified in real time</p>
            </div>
          )}

          {(tab === "Job change alerts" || tab === "Form enrichment") && (
            <div className="max-w-md mx-auto text-center py-20">
              <div className="mx-auto size-12 rounded-full bg-secondary flex items-center justify-center mb-3">
                {tab === "Job change alerts" ? <RefreshCw className="size-5 text-muted-foreground" /> : <Database className="size-5 text-muted-foreground" />}
              </div>
              <h2 className="text-sm font-semibold">{tab}</h2>
              <p className="text-sm text-muted-foreground mt-1">
                {tab === "Job change alerts"
                  ? "Get notified when your saved contacts change jobs so you can re-engage. Coming soon."
                  : "Automatically enrich records captured from your web forms. Coming soon."}
              </p>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
