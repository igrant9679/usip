/**
 * WebsiteVisitors — the Inbound → "Website visitors" surface
 * (/v2/website-visitors).
 *
 * There is no visitor-tracking backend yet, so this page is standalone: it
 * presents the de-anonymization product surface (stats + identified-companies
 * table) in an unconnected state, with the tracking-snippet install flow as
 * the call to action. Wire it to a real tracking pipeline later.
 */
import { useState } from "react";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { Button } from "@/components/ui/button";
import { Globe, Copy, Check, Eye, Building2, Flame, Plug } from "lucide-react";

export default function WebsiteVisitors() {
  const accent = useAccentColor();
  const [copied, setCopied] = useState(false);

  const snippet = `<!-- Velocity website-visitor tracking -->
<script async src="https://getvelocityai.app/v/track.js"
  data-workspace="YOUR_WORKSPACE_KEY"></script>`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked; ignore */
    }
  };

  const stat = (icon: any, label: string, value: string) => {
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
      <div className="flex flex-col h-full min-h-0">
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Globe className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Website visitors</h1>
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">New</span>
          <div className="flex-1" />
          <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><Plug className="size-3.5" /> Not connected</span>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {stat(Eye, "Visitors (30d)", "—")}
            {stat(Building2, "Companies identified", "—")}
            {stat(Flame, "High-intent accounts", "—")}
          </div>

          {/* connect tracking */}
          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <span className="shrink-0 size-10 rounded-xl text-white flex items-center justify-center" style={{ backgroundColor: accent }}><Globe className="size-5" /></span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold">Connect website tracking</h2>
                <p className="text-sm text-muted-foreground mt-0.5">Add the snippet to your site to de-anonymize visiting companies and surface buying intent. Once it's live, identified companies will appear in the table below.</p>
                <div className="mt-3 rounded-lg border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all">{snippet}</div>
                <div className="mt-3 flex items-center gap-2">
                  <Button size="sm" className="gap-1.5" style={{ backgroundColor: accent }} onClick={copy}>
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />} {copied ? "Copied" : "Copy snippet"}
                  </Button>
                  <span className="text-[11px] text-muted-foreground">Paste before <code>&lt;/head&gt;</code> on every page.</span>
                </div>
              </div>
            </div>
          </div>

          {/* identified companies — empty scaffold */}
          <section>
            <h2 className="text-sm font-semibold mb-2 flex items-center gap-2"><Building2 className="size-4" style={{ color: accent }} /> Identified companies</h2>
            <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Company</th>
                    <th className="px-3 py-2 font-medium">Pages viewed</th>
                    <th className="px-3 py-2 font-medium">Last visit</th>
                    <th className="px-3 py-2 font-medium">Intent</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={4}>
                      <div className="text-center py-14 px-4">
                        <Eye className="size-8 mx-auto text-muted-foreground opacity-50 mb-2" />
                        <div className="text-sm font-medium">No visitors yet</div>
                        <p className="text-xs text-muted-foreground mt-1">Once the tracking snippet is installed and your site gets traffic, the companies behind those visits show up here — ready to push into Companies, lists and sequences.</p>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </Shell>
  );
}
