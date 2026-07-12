/**
 * CompanyProfile (/v2/companies/:id) — the full company/account profile.
 *
 * Header (logo, identity, firmographics, score, stage, last-enriched + actions),
 * a details card, the linked contacts table (prospects + contacts auto-linked
 * via the company association layer), enrichment history and the activity
 * timeline. Reads via the `companies` router; logo falls back to favicon/initials.
 */
import { useMemo } from "react";
import { useRoute, useLocation } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { CompanyAvatar } from "@/components/usip/company/CompanyAvatar";
import {
  Globe, Link2, ExternalLink, Users, Building2, MapPin, DollarSign, Briefcase,
  RefreshCw, Archive, ArrowLeft, Sparkles, Calendar, Gauge,
} from "lucide-react";

const RANK: Record<string, number> = { super_admin: 4, admin: 3, manager: 2, rep: 1 };
const RATING_STYLE: Record<string, string> = {
  excellent: "bg-emerald-100 text-emerald-800", good: "bg-blue-100 text-blue-800",
  fair: "bg-amber-100 text-amber-800", not_a_fit: "bg-gray-100 text-gray-600",
};

function fmtMoney(n?: number | null) {
  if (!n) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}

export default function CompanyProfile() {
  const [, params] = useRoute("/v2/companies/:id");
  const [, setLocation] = useLocation();
  const accent = useAccentColor();
  const auth = useAuth();
  const canManage = (RANK[(auth.user as any)?.role ?? "rep"] ?? 0) >= RANK.manager;
  const isAdmin = (RANK[(auth.user as any)?.role ?? "rep"] ?? 0) >= RANK.admin;
  const id = Number(params?.id);
  const utils = trpc.useUtils();

  const { data: c, isLoading } = trpc.companies.get.useQuery({ accountId: id }, { enabled: Number.isFinite(id) });
  const { data: contacts } = trpc.companies.contacts.useQuery({ accountId: id }, { enabled: Number.isFinite(id) });
  const { data: history } = trpc.companies.enrichmentHistory.useQuery({ accountId: id }, { enabled: Number.isFinite(id) });
  const { data: activity } = trpc.companies.activity.useQuery({ accountId: id }, { enabled: Number.isFinite(id) });

  const enrich = trpc.companies.enrich.useMutation({
    onSuccess: (r) => { toast.success(`Enriched — ${r.fieldsUpdated.length} field(s) updated`); utils.companies.get.invalidate({ accountId: id }); utils.companies.enrichmentHistory.invalidate({ accountId: id }); },
    onError: (e) => toast.error(e.message),
  });
  const archive = trpc.companies.archive.useMutation({
    onSuccess: () => { toast.success("Company archived"); setLocation("/v2/companies"); },
    onError: (e) => toast.error(e.message),
  });

  const hq = useMemo(() => c ? [c.hqCity, c.hqState, c.hqCountry].filter(Boolean).join(", ") || c.region || null : null, [c]);

  if (isLoading) return <Shell title="Company"><div className="p-6 space-y-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 rounded-lg bg-muted/50 animate-pulse" />)}</div></Shell>;
  if (!c) return <Shell title="Company"><div className="p-10 text-center text-sm text-muted-foreground">Company not found. <button className="text-blue-600 hover:underline" onClick={() => setLocation("/v2/companies")}>Back to companies</button></div></Shell>;

  const score = c.score as { value: number | null; rating: string | null } | undefined;

  return (
    <Shell title={c.name}>
      <div className="flex flex-col h-full min-h-0" style={{ ["--co-accent" as any]: accent }}>
        {/* header */}
        <div className="relative shrink-0 border-b border-border bg-card/40 px-5 py-4">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <button onClick={() => setLocation("/v2/companies")} className="text-[12px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-3"><ArrowLeft className="size-3.5" /> Companies</button>
          <div className="flex items-start gap-4">
            <CompanyAvatar name={c.name} logoUrl={c.logo?.url} faviconUrl={c.logo?.faviconUrl} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-semibold tracking-tight truncate">{c.name}</h1>
                {score?.rating && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${RATING_STYLE[score.rating] ?? RATING_STYLE.not_a_fit}`}>{score.value != null ? Math.round(score.value) : "–"} {score.rating.replace("_", " ")}</span>}
                {c.accountStage && <Badge variant="outline" className="text-[11px]">{c.accountStage}</Badge>}
                {c.dataStatus && <Badge variant="secondary" className="text-[11px] capitalize">{c.dataStatus}</Badge>}
              </div>
              <div className="mt-1 flex items-center gap-3 text-[13px] text-muted-foreground flex-wrap">
                {c.domain && <a href={`https://${c.domain}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Globe className="size-3.5" />{c.domain}</a>}
                {c.linkedinCompanyUrl && <a href={c.linkedinCompanyUrl.startsWith("http") ? c.linkedinCompanyUrl : `https://${c.linkedinCompanyUrl}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Link2 className="size-3.5" />LinkedIn</a>}
                {c.industry && <span className="inline-flex items-center gap-1"><Briefcase className="size-3.5" />{c.industry}</span>}
                <span className="inline-flex items-center gap-1"><Users className="size-3.5" />{c.contactCount} contact{c.contactCount === 1 ? "" : "s"}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {canManage && <Button size="sm" className="gap-1.5" disabled={enrich.isPending} onClick={() => enrich.mutate({ accountId: id })}><RefreshCw className={`size-3.5 ${enrich.isPending ? "animate-spin" : ""}`} /> Enrich</Button>}
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setLocation(`/v2/people`)}><Sparkles className="size-3.5" /> Find people</Button>
              {isAdmin && <Button size="sm" variant="outline" className="gap-1.5 text-red-600" onClick={() => { if (confirm(`Archive ${c.name}?`)) archive.mutate({ accountId: id }); }}><Archive className="size-3.5" /></Button>}
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
          {/* details */}
          <section className="rounded-lg border border-border p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Company details</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
              <Detail icon={Briefcase} label="Industry" value={c.industry} />
              <Detail icon={Users} label="Employees" value={c.employeeCount ? c.employeeCount.toLocaleString() : c.employeeBand} />
              <Detail icon={DollarSign} label="Revenue" value={fmtMoney(c.revenue == null ? null : Number(c.revenue)) ?? c.revenueBand} />
              <Detail icon={MapPin} label="Headquarters" value={hq} />
              <Detail icon={Globe} label="Website" value={c.websiteUrl} />
              <Detail icon={Building2} label="Founded" value={c.foundedYear ? String(c.foundedYear) : null} />
              <Detail icon={Gauge} label="Company score" value={score?.value != null ? `${Math.round(score.value)} (${score.rating?.replace("_", " ")})` : null} />
              <Detail icon={Calendar} label="Last enriched" value={c.lastEnrichedAt ? new Date(c.lastEnrichedAt).toLocaleDateString() : null} />
            </div>
            {c.description && <p className="mt-3 text-[13px] text-muted-foreground whitespace-pre-wrap">{c.description}</p>}
          </section>

          {/* contacts */}
          <section className="rounded-lg border border-border">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">People at this company ({contacts?.length ?? 0})</div>
            </div>
            {contacts && contacts.length > 0 ? (
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border/60">
                  <tr><th className="px-4 py-1.5 font-medium">Name</th><th className="px-2 py-1.5 font-medium">Title</th><th className="px-2 py-1.5 font-medium">Email</th><th className="px-2 py-1.5 font-medium">Type</th></tr>
                </thead>
                <tbody>
                  {contacts.map((p: any) => (
                    <tr key={`${p.kind}-${p.id}`} className="border-b border-border/50 hover:bg-muted/40 cursor-pointer" onClick={() => setLocation(p.kind === "prospect" ? `/prospects/${p.id}` : `/contacts/${p.id}`)}>
                      <td className="px-4 py-1.5 font-medium">{p.firstName} {p.lastName}</td>
                      <td className="px-2 py-1.5 text-muted-foreground max-w-[220px] truncate">{p.title || "—"}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{p.email || "—"}</td>
                      <td className="px-2 py-1.5"><Badge variant="outline" className="text-[10px] capitalize">{p.kind}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            ) : <div className="px-4 py-6 text-[13px] text-muted-foreground">No linked people yet.</div>}
          </section>

          {/* enrichment history + activity */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <section className="rounded-lg border border-border p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Enrichment history</div>
              {history && history.length > 0 ? (
                <div className="space-y-1.5">
                  {history.map((h: any) => (
                    <div key={h.id} className="flex items-center justify-between text-[12px]">
                      <span className="text-muted-foreground">{h.sourceVendor} · {h.status}{Array.isArray(h.fieldsUpdated) && h.fieldsUpdated.length ? ` · ${h.fieldsUpdated.length} field(s)` : ""}</span>
                      <span className="text-muted-foreground/60">{new Date(h.createdAt).toLocaleDateString()}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="text-[13px] text-muted-foreground">Not enriched yet.</p>}
            </section>
            <section className="rounded-lg border border-border p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Activity</div>
              {activity && activity.length > 0 ? (
                <div className="space-y-1.5">
                  {activity.map((a: any) => (
                    <div key={a.id} className="flex items-center justify-between text-[12px]">
                      <span className="text-foreground/80 truncate max-w-[220px]">{a.subject || a.type}</span>
                      <span className="text-muted-foreground/60">{new Date(a.occurredAt).toLocaleDateString()}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="text-[13px] text-muted-foreground">No activity yet.</p>}
            </section>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Detail({ icon: Icon, label, value }: { icon: any; label: string; value?: string | null }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="truncate">{value || <span className="text-muted-foreground">—</span>}</div>
      </div>
    </div>
  );
}
