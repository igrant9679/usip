/**
 * Deliverability — the "Deliverability suite" surface (/v2/deliverability).
 *
 * A hub that ties together the existing email-infrastructure data:
 *   - sendingAccounts.list      (warmup, bounce/spam rate, reputation, volume)
 *   - emailSuppressions.summary (unsubscribe / bounce / spam / manual counts)
 *   - senderPools.list          (rotation pools)
 * with deep-links to the existing management pages for editing.
 */
import { useMemo } from "react";
import { useLocation } from "wouter";
import { Shell, useAccentColor, StatCard } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Network,
  Mail,
  ShieldCheck,
  Flame,
  Ban,
  Layers,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
  Settings2,
} from "lucide-react";

type SendingAccount = {
  id: number;
  name?: string | null;
  provider?: string | null;
  fromEmail?: string | null;
  dailySendLimit?: number | null;
  warmupStatus?: string | null;
  bounceRate?: number | string | null;
  spamRate?: number | string | null;
  reputationTier?: string | null;
  connectionStatus?: string | null;
  enabled?: boolean | null;
  sentToday?: number | null;
  remainingToday?: number | null;
};

/** bounce/spam values may be stored as a fraction (0.02) or a percent (2). */
function pct(v: number | string | null | undefined): string {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
  if (!Number.isFinite(n) || n === 0) return "0%";
  const p = n <= 1 ? n * 100 : n;
  return `${p.toFixed(p < 10 ? 1 : 0)}%`;
}
function pctNum(v: number | string | null | undefined): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
  if (!Number.isFinite(n)) return 0;
  return n <= 1 ? n * 100 : n;
}

function warmupBadge(status?: string | null) {
  if (!status) return <span className="text-xs text-muted-foreground">—</span>;
  const s = status.toLowerCase();
  const tone = s.includes("active") || s.includes("complete") || s.includes("done") ? "emerald"
    : s.includes("warm") || s.includes("progress") ? "amber" : "slate";
  const cls = tone === "emerald" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
    : tone === "amber" ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
    : "bg-secondary text-muted-foreground";
  return <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium capitalize", cls)}><Flame className="size-3" /> {status.replace(/_/g, " ")}</span>;
}

function repBadge(tier?: string | null) {
  if (!tier) return <span className="text-xs text-muted-foreground">—</span>;
  const t = tier.toLowerCase();
  const variant = t.includes("high") || t.includes("good") || t.includes("excellent") ? "default"
    : t.includes("low") || t.includes("poor") || t.includes("risk") ? "destructive" : "secondary";
  return <Badge variant={variant as any} className="text-[10px] capitalize">{tier}</Badge>;
}

export default function Deliverability() {
  const [, setLocation] = useLocation();
  const accent = useAccentColor();

  const accountsQ = trpc.sendingAccounts.list.useQuery();
  const supprQ = trpc.emailSuppressions.summary.useQuery();
  const poolsQ = trpc.senderPools.list.useQuery();

  const accounts = (accountsQ.data ?? []) as SendingAccount[];
  const suppr = supprQ.data as { unsubscribe: number; bounce: number; spam_complaint: number; manual: number; total: number } | undefined;
  const pools = (poolsQ.data ?? []) as { id: number; name?: string | null; rotationStrategy?: string | null; enabled?: boolean | null; members?: any[] }[];

  const stats = useMemo(() => {
    const n = accounts.length;
    const avg = (sel: (a: SendingAccount) => number) => (n ? accounts.reduce((s, a) => s + sel(a), 0) / n : 0);
    const warming = accounts.filter((a) => (a.warmupStatus ?? "").toLowerCase().includes("warm") || (a.warmupStatus ?? "").toLowerCase().includes("progress")).length;
    const sentToday = accounts.reduce((s, a) => s + (a.sentToday ?? 0), 0);
    const capacity = accounts.reduce((s, a) => s + (a.dailySendLimit ?? 0), 0);
    return {
      n,
      avgBounce: avg((a) => pctNum(a.bounceRate)),
      avgSpam: avg((a) => pctNum(a.spamRate)),
      warming,
      sentToday,
      capacity,
    };
  }, [accounts]);

  const isLoading = accountsQ.isLoading || supprQ.isLoading || poolsQ.isLoading;
  const bounceTone = stats.avgBounce >= 5 ? "danger" : stats.avgBounce >= 2 ? "warning" : "success";
  const spamTone = stats.avgSpam >= 0.3 ? "danger" : stats.avgSpam >= 0.1 ? "warning" : "success";

  return (
    <Shell title="Deliverability suite">
      <div className="flex flex-col h-full min-h-0">
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Network className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Deliverability suite</h1>
          <div className="flex-1" />
          <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => setLocation("/sending-accounts")}>
            <Settings2 className="size-3.5" /> Manage accounts
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-6">
          {/* stat cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Sending accounts" value={stats.n} hint={`${stats.warming} warming up`} />
            <StatCard label="Avg bounce rate" value={isLoading ? "—" : pct(stats.avgBounce / 100)} tone={bounceTone as any} />
            <StatCard label="Avg spam rate" value={isLoading ? "—" : pct(stats.avgSpam / 100)} tone={spamTone as any} />
            <StatCard label="Sent today" value={stats.sentToday} hint={stats.capacity ? `of ${stats.capacity} cap` : undefined} />
          </div>

          {/* sending accounts table */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold flex items-center gap-2"><Mail className="size-4" style={{ color: accent }} /> Sending accounts</h2>
              <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={() => setLocation("/sending-accounts")}>Open <ExternalLink className="size-3.5" /></Button>
            </div>
            <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
              {isLoading ? (
                <div className="p-3 space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-10 rounded bg-muted/50 animate-pulse" />)}</div>
              ) : accounts.length === 0 ? (
                <div className="text-center py-12 px-4">
                  <Mail className="size-7 mx-auto text-muted-foreground opacity-50 mb-2" />
                  <div className="text-sm font-medium">No sending accounts connected</div>
                  <p className="text-xs text-muted-foreground mt-1">Connect a mailbox or SMTP account to send sequences and campaigns.</p>
                  <Button size="sm" className="mt-3" onClick={() => setLocation("/sending-accounts")}>Connect an account</Button>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Account</th>
                      <th className="px-3 py-2 font-medium">Warmup</th>
                      <th className="px-3 py-2 font-medium">Reputation</th>
                      <th className="px-3 py-2 font-medium text-right">Bounce</th>
                      <th className="px-3 py-2 font-medium text-right">Spam</th>
                      <th className="px-3 py-2 font-medium text-right">Today</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr key={a.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                        <td className="px-3 py-2">
                          <div className="font-medium truncate max-w-[200px]">{a.name || a.fromEmail || `Account ${a.id}`}</div>
                          <div className="text-[11px] text-muted-foreground truncate max-w-[200px]">{a.fromEmail}{a.provider ? ` · ${a.provider}` : ""}</div>
                        </td>
                        <td className="px-3 py-2">{warmupBadge(a.warmupStatus)}</td>
                        <td className="px-3 py-2">{repBadge(a.reputationTier)}</td>
                        <td className={cn("px-3 py-2 text-right tabular-nums", pctNum(a.bounceRate) >= 5 && "text-rose-600", pctNum(a.bounceRate) >= 2 && pctNum(a.bounceRate) < 5 && "text-amber-600")}>{pct(a.bounceRate)}</td>
                        <td className={cn("px-3 py-2 text-right tabular-nums", pctNum(a.spamRate) >= 0.3 && "text-rose-600")}>{pct(a.spamRate)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">{a.sentToday ?? 0}{a.dailySendLimit ? ` / ${a.dailySendLimit}` : ""}</td>
                        <td className="px-3 py-2">
                          {a.enabled === false ? (
                            <Badge variant="outline" className="text-[10px]">Paused</Badge>
                          ) : (a.connectionStatus ?? "").toLowerCase().includes("error") || (a.connectionStatus ?? "").toLowerCase().includes("disconnect") ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-rose-600"><AlertTriangle className="size-3" /> {a.connectionStatus}</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600"><CheckCircle2 className="size-3" /> {a.connectionStatus || "Connected"}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <div className="grid lg:grid-cols-2 gap-6">
            {/* suppressions */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold flex items-center gap-2"><Ban className="size-4" style={{ color: accent }} /> Suppressions</h2>
                <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={() => setLocation("/email-suppressions")}>Open <ExternalLink className="size-3.5" /></Button>
              </div>
              <div className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="text-2xl font-semibold tabular-nums" style={{ color: accent }}>{suppr?.total ?? 0}</div>
                <div className="text-xs text-muted-foreground mb-3">total suppressed addresses</div>
                <div className="grid grid-cols-2 gap-2 text-[13px]">
                  {[
                    { l: "Unsubscribes", v: suppr?.unsubscribe ?? 0 },
                    { l: "Bounces", v: suppr?.bounce ?? 0 },
                    { l: "Spam complaints", v: suppr?.spam_complaint ?? 0 },
                    { l: "Manual", v: suppr?.manual ?? 0 },
                  ].map((s) => (
                    <div key={s.l} className="flex items-center justify-between rounded-md border bg-background px-2.5 py-1.5">
                      <span className="text-muted-foreground">{s.l}</span>
                      <span className="font-semibold tabular-nums">{s.v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* sender pools */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold flex items-center gap-2"><Layers className="size-4" style={{ color: accent }} /> Sender pools</h2>
                <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={() => setLocation("/sending-accounts")}>Manage <ExternalLink className="size-3.5" /></Button>
              </div>
              <div className="rounded-xl border bg-card p-2 shadow-sm">
                {pools.length === 0 ? (
                  <div className="text-center py-8 px-4">
                    <Layers className="size-6 mx-auto text-muted-foreground opacity-50 mb-2" />
                    <p className="text-xs text-muted-foreground">No sender pools yet. Pools rotate sends across multiple accounts to protect reputation.</p>
                  </div>
                ) : (
                  <div className="divide-y divide-border/60">
                    {pools.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 px-2 py-2">
                        <ShieldCheck className="size-4 shrink-0" style={{ color: accent }} />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium truncate">{p.name || `Pool ${p.id}`}</div>
                          <div className="text-[11px] text-muted-foreground">{(p.members?.length ?? 0)} account{(p.members?.length ?? 0) === 1 ? "" : "s"}{p.rotationStrategy ? ` · ${p.rotationStrategy.replace(/_/g, " ")}` : ""}</div>
                        </div>
                        {p.enabled === false ? <Badge variant="outline" className="text-[10px]">Off</Badge> : <Badge variant="secondary" className="text-[10px]">Active</Badge>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </Shell>
  );
}
