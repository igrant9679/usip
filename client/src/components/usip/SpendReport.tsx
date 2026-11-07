/**
 * The cost report (audit 2026-10-20, Phase 3) on Settings → Billing.
 *
 * One line per vendor, unit, model and paying key, one column per UTC day,
 * because that is how each vendor's usage page counts: a week of these
 * columns is what gets checked against Anthropic's, Reoon's and QuickEnrich's
 * own dashboards. Dollars only where a list price is on file.
 *
 * The platform owner (users.role 'admin') also sees every workspace, the
 * shared keys' totals, and the per-workspace switches for the deployment's
 * Reoon and QuickEnrich keys (owner decision 2026-10-27: opt-in).
 */
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Section } from "@/components/usip/Common";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { METER_LABEL, VENDOR_LABEL, type SpendSummary } from "@shared/spendReport";
import { formatUsd } from "@shared/researchModels";

const n = (v: number) => v.toLocaleString();

export function SpendTable({ summary, empty }: { summary: SpendSummary; empty: string }) {
  if (summary.lines.length === 0) return <div className="p-4 text-sm text-muted-foreground">{empty}</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="text-left font-medium px-3 py-2">Vendor</th>
            <th className="text-left font-medium px-3 py-2">Unit</th>
            <th className="text-left font-medium px-3 py-2">Model</th>
            <th className="text-left font-medium px-3 py-2">Key</th>
            {summary.days.map((d) => (
              <th key={d} className="text-right font-medium px-2 py-2 whitespace-nowrap">{d.slice(5)}</th>
            ))}
            <th className="text-right font-medium px-3 py-2">Total</th>
            <th className="text-right font-medium px-3 py-2">Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {summary.lines.map((l) => (
            <tr key={`${l.vendor}|${l.meter}|${l.model}|${l.keySource}`} className="border-b last:border-0">
              <td className="px-3 py-1.5 whitespace-nowrap">{VENDOR_LABEL[l.vendor] ?? l.vendor}</td>
              <td className="px-3 py-1.5 whitespace-nowrap">{METER_LABEL[l.meter] ?? l.meter}</td>
              <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">{l.model || "—"}</td>
              <td className="px-3 py-1.5 whitespace-nowrap">{l.keySource === "shared" ? "Shared" : "Own"}</td>
              {summary.days.map((d) => (
                <td key={d} className="text-right px-2 py-1.5 tabular-nums">{l.perDay[d] ? n(l.perDay[d]) : ""}</td>
              ))}
              <td className="text-right px-3 py-1.5 tabular-nums font-medium">{n(l.total)}</td>
              <td className="text-right px-3 py-1.5 tabular-nums">{l.estUsd === null ? "—" : formatUsd(l.estUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopFeatures({ summary }: { summary: SpendSummary }) {
  const top = summary.features.slice(0, 8);
  if (top.length === 0) return null;
  return (
    <div className="px-4 py-3 border-t text-xs space-y-1">
      <div className="font-medium">Where it went</div>
      {top.map((f) => (
        <div key={`${f.vendor}|${f.feature}|${f.meter}`} className="flex gap-2">
          <span className="text-muted-foreground w-28 shrink-0">{VENDOR_LABEL[f.vendor] ?? f.vendor}</span>
          <span className="flex-1 truncate">{f.feature}</span>
          <span className="tabular-nums">{n(f.total)} {f.meter === "tokens" ? "tokens" : (METER_LABEL[f.meter] ?? f.meter).toLowerCase()}</span>
        </div>
      ))}
    </div>
  );
}

function PeriodPicker({ days, setDays }: { days: number; setDays: (d: number) => void }) {
  return (
    <div className="flex gap-1">
      {[7, 30].map((d) => (
        <Button key={d} size="sm" variant={days === d ? "default" : "outline"} onClick={() => setDays(d)}>
          {d} days
        </Button>
      ))}
    </div>
  );
}

/**
 * This calendar month at a glance (audit 2026-10-20, F8: "a monthly spend
 * card"): each vendor's units since the 1st, and the priced total. The table
 * below keeps the per-day detail a vendor dashboard is checked against.
 */
export function MonthSpendCard() {
  const q = trpc.spend.month.useQuery();
  if (q.isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading this month…</div>;
  if (q.error) return <div className="p-4 text-sm text-red-600 dark:text-red-400">This month's spend could not load: {q.error.message}</div>;
  const s = q.data!;
  // One row per vendor and unit, summed across models and keys.
  const totals = new Map<string, { vendor: string; meter: string; total: number; estUsd: number | null }>();
  for (const l of s.lines) {
    const k = `${l.vendor}|${l.meter}`;
    const t = totals.get(k) ?? { vendor: l.vendor, meter: l.meter, total: 0, estUsd: null };
    t.total += l.total;
    if (l.estUsd !== null) t.estUsd = (t.estUsd ?? 0) + l.estUsd;
    totals.set(k, t);
  }
  const rows = Array.from(totals.values());
  return (
    <div className="p-4 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-medium">{s.month} so far</div>
        <div className="text-sm tabular-nums">{s.estUsd > 0 ? `${formatUsd(s.estUsd)} priced at list` : "No priced usage"}</div>
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">Nothing paid for this month.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
          {rows.map((r) => (
            <div key={`${r.vendor}|${r.meter}`} className="flex justify-between gap-2">
              <span className="text-muted-foreground truncate">{VENDOR_LABEL[r.vendor] ?? r.vendor} · {METER_LABEL[r.meter] ?? r.meter}</span>
              <span className="tabular-nums shrink-0">{n(r.total)}{r.estUsd !== null ? ` · ${formatUsd(r.estUsd)}` : ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SpendSection() {
  const [days, setDays] = useState(7);
  const q = trpc.spend.report.useQuery({ days });
  const { user } = useAuth();
  return (
    <>
      <Section title="This month" description="Paid usage since the 1st (UTC days, as the vendors count them). Dollars only where a list price is on file.">
        <MonthSpendCard />
      </Section>
      <Section
        title="Paid usage"
        description="What this workspace spent with each vendor, per day (UTC, as the vendors count it). Est. cost is shown only where a list price is on file."
        right={<PeriodPicker days={days} setDays={setDays} />}
      >
        {q.isLoading && <div className="p-4 text-sm text-muted-foreground">Loading…</div>}
        {q.error && <div className="p-4 text-sm text-red-600 dark:text-red-400">{q.error.message}</div>}
        {q.data && (
          <>
            <SpendTable summary={q.data} empty="Nothing paid for in this period." />
            {q.data.estUsd > 0 && (
              <div className="px-4 py-2 border-t text-xs text-muted-foreground">
                Priced lines total {formatUsd(q.data.estUsd)} at list price. "Own" is billed to this workspace's key; "Shared" to the platform's.
              </div>
            )}
            <TopFeatures summary={q.data} />
          </>
        )}
      </Section>
      {user?.role === "admin" && <PlatformSpendSection />}
    </>
  );
}

function SharedKeyCell({
  workspaceId, vendor, allowed, cap, usedToday, ownKey, configured,
}: {
  workspaceId: number; vendor: "reoon" | "quickenrich"; allowed: boolean; cap: number | null;
  usedToday: number; ownKey: boolean; configured: boolean;
}) {
  const utils = trpc.useUtils();
  const [capText, setCapText] = useState(cap === null ? "" : String(cap));
  const save = trpc.spend.setSharedKey.useMutation({
    onSuccess: () => { utils.spend.platform.invalidate(); toast.success("Saved"); },
    onError: (e) => toast.error(e.message),
  });
  const capValue = capText.trim() === "" ? null : Math.max(0, Math.floor(Number(capText) || 0));
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Switch aria-label="Allow shared key"
          checked={allowed}
          disabled={!configured || save.isPending}
          onCheckedChange={(v) => save.mutate({ workspaceId, vendor, allowed: v, dailyCap: capValue })}
        />
        <span className="text-xs">{ownKey ? "Own key (shared unused)" : allowed ? `${n(usedToday)} today` : "Off"}</span>
      </div>
      {allowed && (
        <div className="flex items-center gap-1">
          <Input aria-label="Monthly cap"
            className="h-7 w-24 text-xs"
            type="number"
            min={0}
            placeholder="No cap"
            value={capText}
            onChange={(e) => setCapText(e.target.value)}
          />
          <Button size="sm" variant="outline" className="h-7" disabled={save.isPending} onClick={() => save.mutate({ workspaceId, vendor, allowed, dailyCap: capValue })}>
            Set cap
          </Button>
        </div>
      )}
    </div>
  );
}

function PlatformSpendSection() {
  const [days, setDays] = useState(7);
  const q = trpc.spend.platform.useQuery({ days });
  const d = q.data;
  return (
    <>
      <Section
        title="Shared keys (platform owner)"
        description="The deployment's own Reoon and QuickEnrich accounts. A workspace without its own key may use them only when switched on here; a daily cap counts that workspace's paid units on the shared key (blank = none)."
        right={<PeriodPicker days={days} setDays={setDays} />}
      >
        {q.error && <div className="p-4 text-sm text-red-600 dark:text-red-400">{q.error.message}</div>}
        {d && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left font-medium px-3 py-2">Workspace</th>
                  <th className="text-left font-medium px-3 py-2">Shared Reoon key</th>
                  <th className="text-left font-medium px-3 py-2">Shared QuickEnrich key</th>
                  <th className="text-right font-medium px-3 py-2">Est. AI cost ({days} days)</th>
                </tr>
              </thead>
              <tbody>
                {d.workspaces.map((w) => (
                  <tr key={w.id} className="border-b last:border-0 align-top">
                    <td className="px-3 py-2">
                      {w.name} <span className="text-muted-foreground">#{w.id}{w.archived ? " · archived" : ""}</span>
                    </td>
                    <td className="px-3 py-2">
                      <SharedKeyCell key={`r${w.sharedReoonDailyCap}`} workspaceId={w.id} vendor="reoon" allowed={w.sharedReoonKey} cap={w.sharedReoonDailyCap}
                        usedToday={w.sharedUsedToday.reoon} ownKey={w.ownReoonKey} configured={d.sharedKeysConfigured.reoon} />
                    </td>
                    <td className="px-3 py-2">
                      <SharedKeyCell key={`q${w.sharedQuickenrichDailyCap}`} workspaceId={w.id} vendor="quickenrich" allowed={w.sharedQuickenrichKey} cap={w.sharedQuickenrichDailyCap}
                        usedToday={w.sharedUsedToday.quickenrich} ownKey={w.ownQuickenrichKey} configured={d.sharedKeysConfigured.quickenrich} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{w.summary.estUsd > 0 ? formatUsd(w.summary.estUsd) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {d && (
        <Section
          title="Billed to the platform's keys"
          description="Every workspace's use of the deployment's own keys, per day: compare this with each vendor's usage page for the platform account."
        >
          <SpendTable summary={d.sharedKeys} empty="Nothing billed to the shared keys in this period." />
        </Section>
      )}
      {d && d.unattributed.lines.length > 0 && (
        <Section
          title="Not attributed to a workspace"
          description="Paid calls made with no workspace to bill. Each one names the feature that made it; there should be none."
        >
          <SpendTable summary={d.unattributed} empty="" />
          <TopFeatures summary={d.unattributed} />
        </Section>
      )}
    </>
  );
}
