/**
 * WarmySenderSourceCard — BYOK key + allowance settings for the WarmySender
 * lead database (registry slug `warmysender`).
 *
 * What the key powers TODAY (say exactly this, never more): campaigns and
 * the Source search page search WarmySender's lead database for free
 * (masked previews) and spend one lead unit per net-new person acquired;
 * the budget ledger below meters that against the plan's daily pace and
 * monthly allowance, plus any purchased credits you record here. Test
 * connection validates the key, records its scopes and tier, and captures
 * the search tool's parameter schema — which is how the registry learns
 * whether the vendor filters on job title natively.
 */
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Flame, Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { confirmAction } from "@/components/usip/Common";

function Bar({ label, used, reserved, limit, resetsAt }: { label: string; used: number; reserved: number; limit: number | null; resetsAt: string | Date | null }) {
  const total = limit ?? null;
  const pct = total && total > 0 ? Math.min(100, Math.round(((used + reserved) / total) * 100)) : null;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11.5px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {used.toLocaleString()}{reserved > 0 ? <span className="text-muted-foreground"> (+{reserved} held)</span> : null}
          {total != null ? <> / {total.toLocaleString()}</> : <span className="text-muted-foreground"> · uncapped</span>}
        </span>
      </div>
      {pct != null && (
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div className={cn("h-full rounded-full", pct >= 90 ? "bg-rose-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${pct}%` }} />
        </div>
      )}
      {resetsAt ? <div className="text-[10.5px] text-muted-foreground">resets {new Date(resetsAt).toLocaleDateString()}</div> : null}
    </div>
  );
}

export function WarmySenderSourceCard({ variant = "standalone" }: { variant?: "standalone" | "bare" }) {
  const utils = trpc.useUtils();
  const me = trpc.profile.getMe.useQuery();
  const isAdmin = me.data?.role === "admin" || me.data?.role === "super_admin";
  const describe = trpc.prospectSources.describe.useQuery(undefined);
  const source = describe.data?.find((s) => s.slug === "warmysender");
  const cred = source?.credential;
  const configured = !!cred?.configured;
  const config = (cred?.config ?? {}) as { billingAnniversaryDay?: number; monthlyLeadAllowance?: number; leadCreditBalance?: number; scopes?: string[]; tier?: string; toolSchemas?: Record<string, unknown>; sampleRowKeys?: string[] };
  const ledger = trpc.prospectSources.ledger.useQuery({ slug: "warmysender" }, { enabled: configured });

  const [key, setKey] = useState("");
  const [anniv, setAnniv] = useState("");
  const [monthly, setMonthly] = useState("");
  const [credits, setCredits] = useState("");
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !describe.data) return;
    setAnniv(config.billingAnniversaryDay ? String(config.billingAnniversaryDay) : "");
    setMonthly(config.monthlyLeadAllowance != null ? String(config.monthlyLeadAllowance) : "");
    setCredits(config.leadCreditBalance != null ? String(config.leadCreditBalance) : "");
    setSeeded(true);
  }, [describe.data, seeded, config.billingAnniversaryDay, config.monthlyLeadAllowance, config.leadCreditBalance]);

  const invalidate = () => { utils.prospectSources.describe.invalidate(); utils.prospectSources.ledger.invalidate(); };
  const save = trpc.prospectSources.saveCredentials.useMutation({
    onSuccess: () => { invalidate(); setKey(""); toast.success("Saved — test the connection to validate the key"); },
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });
  const validate = trpc.prospectSources.validate.useMutation({
    onSuccess: (r: any) => { invalidate(); toast.success(r?.message ?? "Key verified"); },
    onError: (e: any) => { invalidate(); toast.error(e?.message ?? "Key test failed"); },
  });
  const remove = trpc.prospectSources.removeCredentials.useMutation({
    onSuccess: () => { invalidate(); toast.success("Key removed"); },
    onError: (e: any) => toast.error(e?.message ?? "Could not remove"),
  });

  const titleNative = source?.capabilities.supportedFilters.includes("jobTitle");
  const status = cred?.status ?? "unvalidated";

  const body = (
    <>
      <div className="flex items-center gap-2 text-[13px]">
        <ShieldCheck className={cn("size-4", configured && status === "valid" ? "text-emerald-600" : status === "invalid" ? "text-rose-600" : "text-muted-foreground")} />
        {!configured ? (
          <span className="text-muted-foreground">Not connected.</span>
        ) : status === "valid" ? (
          <span>Connected <span className="text-muted-foreground">· key {cred?.masked}{config.tier ? ` · ${config.tier} plan` : ""}{cred?.lastValidatedAt ? ` · validated ${new Date(cred.lastValidatedAt).toLocaleString()}` : ""}</span></span>
        ) : status === "invalid" ? (
          <span className="text-rose-700 dark:text-rose-400">Key rejected <span className="text-muted-foreground">· {cred?.validationError ?? "validation failed"}</span></span>
        ) : (
          <span>Saved, not yet tested <span className="text-muted-foreground">· key {cred?.masked}</span></span>
        )}
      </div>

      {source?.circuit.open && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5 text-[12px] text-amber-800 dark:text-amber-300">
          <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
          <span>Paused after {source.circuit.failures} consecutive failures — resumes {source.circuit.openUntil ? new Date(source.circuit.openUntil).toLocaleTimeString() : "shortly"}. Searches skip this source until then.</span>
        </div>
      )}

      <div className="space-y-1.5">
        <Label>WarmySender API key</Label>
        <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} disabled={!isAdmin} autoComplete="off"
          placeholder={configured ? "Enter a new key to replace the saved one" : "Paste a ws_… key with leads:read, leads:write and verification:read"} />
        <p className="text-[12px] text-muted-foreground">Create it in WarmySender → Settings → API Keys. Grant <code>leads:read</code>, <code>leads:write</code> and <code>verification:read</code>; other scopes are never used.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label>Billing anniversary day</Label>
          <Input type="number" min={1} max={28} value={anniv} onChange={(e) => setAnniv(e.target.value)} disabled={!isAdmin} placeholder="1–28" />
          <p className="text-[11px] text-muted-foreground">The plan's lead allowance resets on this day each month.</p>
        </div>
        <div className="space-y-1.5">
          <Label>Monthly lead allowance</Label>
          <Input type="number" min={0} value={monthly} onChange={(e) => setMonthly(e.target.value)} disabled={!isAdmin} placeholder={config.tier ? "from plan" : "e.g. 2000"} />
          <p className="text-[11px] text-muted-foreground">Leave blank to use the plan tier's default. Daily pace is a thirtieth of this.</p>
        </div>
        <div className="space-y-1.5">
          <Label>Purchased lead credits</Label>
          <Input type="number" min={0} value={credits} onChange={(e) => setCredits(e.target.value)} disabled={!isAdmin} placeholder="0" />
          <p className="text-[11px] text-muted-foreground">Top-up credits never expire and skip the daily pace; they spend after plan leads.</p>
        </div>
      </div>

      {configured && ledger.data?.configured && (
        <div className="rounded-lg border border-border/70 bg-muted/40 p-3 space-y-3">
          <div className="text-[12px] font-medium">Budget ledger</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {ledger.data.rows.filter((r) => r.bucket === "leads").map((r) => (
              <Bar key={`${r.bucket}-${r.granularity}-${r.periodKey}`} label={`Leads · ${r.granularity === "daily" ? "today" : r.granularity === "monthly" ? "this billing month" : "purchased credits"}`}
                used={r.unitsConsumed} reserved={r.unitsReserved} limit={r.unitsLimit} resetsAt={r.resetsAt as any} />
            ))}
            {ledger.data.vendor.filter((v) => v.bucket === "verification" && v.limit != null).map((v) => (
              <Bar key="ver" label={`Verification · this month (vendor-reported${v.fundedBy ? `, ${v.fundedBy}` : ""})`} used={v.used ?? 0} reserved={0} limit={v.limit} resetsAt={null} />
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            WarmySender publishes no endpoint for the remaining <em>lead</em> allowance, so leads are tracked here from what Velocity spends; a refusal from the vendor closes the day's row. Verification comes from their allowance endpoint.
          </p>
        </div>
      )}

      <div className="rounded-lg border border-border/70 bg-muted/40 p-3 text-[12px] text-muted-foreground space-y-1">
        <p><span className="font-medium text-foreground">Searching is free and masked.</span> Campaigns with the "WarmySender leads" source ticked, and the Source search page, preview matches at no cost; one lead unit is spent per <em>net-new</em> person acquired — never for someone already in People or a campaign queue, and never for a record without an email.</p>
        <p><span className="font-medium text-foreground">Coverage is US and Canada, business phones only.</span> {titleNative === undefined ? "Job-title filtering is confirmed on Test connection." : titleNative ? "Their search tool filters on job title natively." : "Their search tool has no native title filter — titles are keyword-matched and this source ranks below title-capable sources for title-led searches."}</p>
        <p>Every acquired address still goes through the same verification gate as any other before it can be promoted or mailed.</p>
      </div>

      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="gap-1.5" disabled={save.isPending || (!key.trim() && !seeded)}
            onClick={() => {
              const toInt = (v: string) => (v.trim() === "" ? null : Math.max(0, Math.floor(Number(v) || 0)));
              const a = toInt(anniv);
              save.mutate({
                slug: "warmysender",
                ...(key.trim() ? { apiKey: key.trim() } : {}),
                config: {
                  billingAnniversaryDay: a == null ? null : Math.min(28, Math.max(1, a)),
                  monthlyLeadAllowance: toInt(monthly),
                  leadCreditBalance: toInt(credits),
                },
              });
            }}>
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Save
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" disabled={!configured || validate.isPending} onClick={() => validate.mutate({ slug: "warmysender" })}>
            {validate.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Test connection
          </Button>
          {configured && (
            <Button variant="outline" size="sm" className="text-rose-600 hover:text-rose-600" disabled={remove.isPending}
              onClick={() => confirmAction({ title: "Remove this workspace's WarmySender key?", description: "Campaigns and searches stop using WarmySender until a key is saved again. Ledger history is kept.", confirmLabel: "Remove" }, () => remove.mutate({ slug: "warmysender" }))}>
              Remove key
            </Button>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-muted-foreground">Only workspace admins can change the WarmySender connection.</p>
      )}
    </>
  );

  if (variant === "bare") return <div className="space-y-4">{body}</div>;
  return (
    <section data-tour-id="warmysender-key-card" className="rounded-xl border border-border/70 bg-card p-5 shadow-sm space-y-4">
      <div className="flex items-start gap-2.5">
        <Flame className="size-4 mt-0.5 shrink-0 text-orange-500" />
        <div>
          <h2 className="text-[15px] font-semibold">WarmySender</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">B2B lead database (200M+ contacts, US/Canada deepest) with free masked search and pay-per-net-new acquisition. Stored encrypted.</p>
        </div>
      </div>
      {body}
    </section>
  );
}

export default WarmySenderSourceCard;
