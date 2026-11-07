/**
 * WebsiteVisitors — the Inbound → "Website visitors" surface
 * (/v2/website-visitors).
 *
 * First-party visitor tracking: a snippet (served at /v/track.js) posts page
 * views to /api/track using the workspace slug as the public key. Anonymous
 * IP→company de-anonymization needs a paid IP-intelligence provider and is
 * not included.
 *
 * Known-visitor matching (audit 2026-10-20, P5, P88, F40). Velocity adds a
 * SIGNED visitor id to every link to the workspace's own site in its emails
 * (sequence, campaign and record sends; services/visitorLinks.ts), while click
 * tracking is on. A visit through such a link is that person's, and shows as
 * verified. An unsigned id is still a claim anyone with the snippet could make,
 * and shows as one.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Globe, Copy, Check, Eye, Flame, Users, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useWorkspaceRole } from "@/hooks/useWorkspaceRole";
import { QueryError } from "@/components/usip/Shell";

const INTENT_TONE: Record<string, string> = {
  high: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  low: "bg-secondary text-muted-foreground",
};

function fmt(d?: string | Date | null): string {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export default function WebsiteVisitors() {
  const accent = useAccentColor();
  const { current } = useWorkspace();
  const [copied, setCopied] = useState(false);

  const stats = trpc.websiteVisitors.stats.useQuery(undefined as any, { retry: false });
  const known = trpc.websiteVisitors.listKnown.useQuery({ limit: 100 } as any, { retry: false });
  // Where outreach adds a signed visitor id (F40), and the switch that allows it.
  const sites = trpc.websiteVisitors.trackedSites.useQuery(undefined as any, { retry: false });
  const { isAdmin } = useWorkspaceRole();
  const utils = trpc.useUtils();
  const [extraSites, setExtraSites] = useState("");
  useEffect(() => { setExtraSites(sites.data?.listed ?? ""); }, [sites.data?.listed]);
  const saveSites = trpc.websiteVisitors.setTrackedSites.useMutation({
    onSuccess: () => { utils.websiteVisitors.trackedSites.invalidate(); toast.success("Tracked sites saved"); },
    onError: (e) => toast.error(e.message),
  });

  const slug = current?.slug ?? "YOUR_WORKSPACE_KEY";
  const snippet = `<!-- Velocity website-visitor tracking -->\n<script async src="https://getvelocityai.app/v/track.js"\n  data-workspace="${slug}"></script>`;
  // A failed read is not "no traffic": the tiles and the badge say they could
  // not load rather than showing zeros and "Not connected" (audit 2026-10-20, P154).
  const statsFailed = !!stats.error && !stats.data;
  const connected = (stats.data?.visits30d ?? 0) > 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be blocked; ignore */ }
  };

  const s = stats.data ?? { visits30d: 0, uniqueVisitors: 0, knownVisitors: 0, verifiedVisitors: 0, highIntent: 0 };
  const rows = (known.data ?? []) as any[];

  const stat = (icon: any, label: string, value: string | number) => {
    const Icon = icon;
    return (
      <div className="rounded-lg border bg-card p-4 shadow-sm" style={{ borderLeft: `3px solid ${accent}`, backgroundImage: `linear-gradient(135deg, ${accent}1a 0%, transparent 70%)` }}>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground"><Icon className="size-3.5" /> {label}</div>
        <div className="text-2xl font-semibold tabular-nums mt-1" style={{ color: accent }}>{value}</div>
      </div>
    );
  };

  return (
    <Shell title="Website visitors">
      <div data-tour-id="visitors-list" className="flex flex-col h-full min-h-0">
        <div className="relative shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 min-h-11 py-1.5 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Globe className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Website visitors</h1>
          <div className="flex-1" />
          {statsFailed ? (
            <span className="text-[11px] inline-flex items-center gap-1 text-muted-foreground">
              <span className="size-2 rounded-full bg-amber-500" /> Status unknown
            </span>
          ) : (
            <span className={cn("text-[11px] inline-flex items-center gap-1", connected ? "text-emerald-600" : "text-muted-foreground")}>
              <span className={cn("size-2 rounded-full", connected ? "bg-emerald-500" : "bg-muted-foreground/40")} /> {connected ? "Receiving traffic" : "Not connected"}
            </span>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-6">
          {statsFailed ? (
            <QueryError compact what="visit counts" message={stats.error?.message} onRetry={() => stats.refetch()} />
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {stat(Eye, "Visits (30d)", s.visits30d)}
              {stat(Users, "Unique visitors", s.uniqueVisitors)}
              {/* People a signed link id identified (F40); unsigned ids stay claims (P88). */}
              {stat(ShieldCheck, "People identified", (s as { verifiedVisitors?: number }).verifiedVisitors ?? 0)}
              {stat(Flame, "High-intent visits", s.highIntent)}
            </div>
          )}

          {/* connect tracking — collapses to a thin reminder once connected */}
          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <span className="shrink-0 size-10 rounded-xl text-white flex items-center justify-center" style={{ backgroundColor: accent }}><Globe className="size-5" /></span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold">Website tracking snippet</h2>
                <p className="text-sm text-muted-foreground mt-0.5">Add this before <code>&lt;/head&gt;</code> on every page. Velocity counts visits and flags the pages that show buying intent, such as pricing, demo and contact.</p>
                <p className="text-xs text-muted-foreground mt-1.5">
                  Visitors whose browser sends Do Not Track or Global Privacy Control are not tracked. Pages are stored
                  without their query strings, visits are kept for 180 days, and the visitor cookie lasts 30 days.
                </p>
                <div className="mt-3 rounded-lg border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all">{snippet}</div>
                <div className="mt-3 flex items-center gap-2">
                  <Button size="sm" className="gap-1.5" style={{ backgroundColor: accent }} onClick={copy}>
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />} {copied ? "Copied" : "Copy snippet"}
                  </Button>
                  <span className="text-[11px] text-muted-foreground">Anonymous company de-anonymization requires an IP-intelligence add-on.</span>
                </div>
              </div>
            </div>
          </div>

          {/* signed visitor links (F40) */}
          <div className="rounded-xl border bg-card p-5 shadow-sm space-y-2">
            <h2 className="text-base font-semibold flex items-center gap-2"><ShieldCheck className="size-4" style={{ color: accent }} /> Knowing who visited</h2>
            <p className="text-sm text-muted-foreground">
              Links to your own site in Velocity's emails (sequences, campaigns and emails from a record) carry a signed id
              for the person they went to, so a visit through one is known to be theirs. Links to other sites are left alone.
            </p>
            {sites.data && (
              <p className="text-xs text-muted-foreground">
                {sites.data.clickTracking
                  ? sites.data.hosts.length
                    ? <>Added to links to: <span className="font-medium text-foreground">{sites.data.hosts.join(", ")}</span>.</>
                    : <>No site to add it to yet: set your company website in Settings → Branding, or list your sites below.</>
                  : <>Off: click tracking is switched off in Settings → Email, and this follows it.</>}
              </p>
            )}
            {isAdmin && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Input aria-label="More of your own sites" value={extraSites} onChange={(e) => setExtraSites(e.target.value)} placeholder="Other sites of yours, e.g. shop.example.com, example.co.uk" className="max-w-md h-8 text-sm" />
                <Button size="sm" variant="outline" disabled={saveSites.isPending} onClick={() => saveSites.mutate({ domains: extraSites })}>
                  {saveSites.isPending ? "Saving…" : "Save sites"}
                </Button>
              </div>
            )}
          </div>

          {/* known-visitor intent */}
          <section>
            <h2 className="text-sm font-semibold mb-1 flex items-center gap-2"><Flame className="size-4" style={{ color: accent }} /> Visits that name a person</h2>
            <p className="text-xs text-muted-foreground mb-2 max-w-3xl">
              Verified visits came through a link Velocity signed for that person. An unverified one carried an id that
              wasn't signed, which anyone with your snippet could type, so treat it as a claim; it files no follow-up task.
            </p>
            <div className="rounded-xl border bg-card overflow-x-auto shadow-sm">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Person</th>
                    <th className="px-3 py-2 font-medium">Page</th>
                    <th className="px-3 py-2 font-medium">Intent</th>
                    <th className="px-3 py-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {known.isLoading ? (
                    <tr><td colSpan={4} className="px-3 py-8 text-center text-muted-foreground text-xs">Loading…</td></tr>
                  ) : known.error && !known.data ? (
                    <tr><td colSpan={4}><QueryError what="visits" message={known.error.message} onRetry={() => known.refetch()} /></td></tr>
                  ) : rows.length === 0 ? (
                    <tr><td colSpan={4}>
                      <div className="text-center py-14 px-4">
                        <Eye className="size-8 mx-auto text-muted-foreground opacity-50 mb-2" />
                        <div className="text-sm font-medium">No visits name a record</div>
                        <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">Visit counts and intent above work without this.</p>
                      </div>
                    </td></tr>
                  ) : rows.map((r) => {
                    const href = r.recordType === "contact" ? `/contacts/${r.recordId}` : r.recordType === "prospect" ? `/prospects/${r.recordId}` : `/leads/${r.recordId}`;
                    return (
                      <tr key={r.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-2">
                          <Link href={href} className="font-medium hover:underline">{r.name || "Unknown"}</Link>
                          {r.company && <span className="text-xs text-muted-foreground"> · {r.company}</span>}
                          {r.verified
                            ? <span className="ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">Verified</span>
                            : <span className="ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium bg-secondary text-muted-foreground">Unverified claim</span>}
                        </td>
                        {/* Wraps instead of cutting the path off (audit 2026-10-20, P160). */}
                        <td className="px-3 py-2 text-muted-foreground max-w-[280px] break-all">{r.path}</td>
                        <td className="px-3 py-2"><span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", INTENT_TONE[r.intent as string] ?? INTENT_TONE.low)}>{r.intent ?? "low"}</span></td>
                        <td className="px-3 py-2 text-[11px] tabular-nums text-muted-foreground whitespace-nowrap">{fmt(r.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </Shell>
  );
}
