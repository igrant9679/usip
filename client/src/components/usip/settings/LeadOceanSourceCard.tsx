/**
 * LeadOceanSourceCard — this workspace's own LeadOcean key and options
 * (registry slug `leadocean`).
 *
 * What the key powers TODAY (say exactly this, never more): nothing on its own.
 * Saving a valid key makes LeadOcean available; a person then ticks it on a
 * campaign's Sources tab or on Source search. It is never added to a campaign
 * and never pre-ticked, because every preview row counts as a record.
 *
 * The key goes one way. This card sends it and never gets any of it back: the
 * server answers with `configured`, not a masked value. Plan, usage and limits
 * are what LeadOcean reports for this key, read for free on Test connection, so
 * nothing here assumes a plan.
 */
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle, Loader2, ShieldCheck, Waves } from "lucide-react";
import { confirmAction } from "@/components/usip/Common";
import { isAdminRole } from "@shared/roleRank";
import {
  LEADOCEAN_DEFAULT_EMAIL_STATUSES,
  LEADOCEAN_EMAIL_STATUSES,
  LEADOCEAN_EMAIL_STATUS_LABELS,
  LEADOCEAN_WORK_EMAIL_STATUSES,
  leadoceanAcceptedStatuses,
  type LeadoceanEmailStatus,
} from "@shared/prospectSources";

type Reported = {
  plan?: string | null;
  searchView?: "full" | "thin" | null;
  requestsPerSecond?: number | null;
  records?: { ceiling: number | null; used: number | null; remaining: number | null; resetsAt: string | null } | null;
  usage?: { period: string | null; used: number | null; searchToday: number; enrichToday: number } | null;
  phoneCounters?: Record<string, number>;
  acceptedEmailStatuses?: LeadoceanEmailStatus[];
  fetchPhones?: boolean;
  dailyPeopleCap?: number;
};

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11.5px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-right">{value}</span>
    </div>
  );
}

export function LeadOceanSourceCard({ variant = "standalone" }: { variant?: "standalone" | "bare" }) {
  const utils = trpc.useUtils();
  const me = trpc.profile.getMe.useQuery();
  const isAdmin = isAdminRole(me.data?.role);
  const describe = trpc.prospectSources.describe.useQuery(undefined);
  const source = describe.data?.find((s) => s.slug === "leadocean");
  const cred = source?.credential;
  const configured = !!cred?.configured;
  const config = (cred?.config ?? {}) as Reported;
  const ledger = trpc.prospectSources.ledger.useQuery({ slug: "leadocean" }, { enabled: configured });

  const [key, setKey] = useState("");
  const [statuses, setStatuses] = useState<LeadoceanEmailStatus[]>([...LEADOCEAN_DEFAULT_EMAIL_STATUSES]);
  const [fetchPhones, setFetchPhones] = useState(false);
  const [cap, setCap] = useState("");
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !describe.data) return;
    setStatuses(leadoceanAcceptedStatuses(config.acceptedEmailStatuses));
    setFetchPhones(config.fetchPhones === true);
    setCap(config.dailyPeopleCap != null ? String(config.dailyPeopleCap) : "");
    setSeeded(true);
  }, [describe.data, seeded, config.acceptedEmailStatuses, config.fetchPhones, config.dailyPeopleCap]);

  const invalidate = () => { utils.prospectSources.describe.invalidate(); utils.prospectSources.ledger.invalidate(); };
  const validate = trpc.prospectSources.validate.useMutation({
    onSuccess: (r: any) => { invalidate(); toast.success(r?.message ?? "Key verified"); },
    onError: (e: any) => { invalidate(); toast.error(e?.message ?? "Key test failed"); },
  });
  const save = trpc.prospectSources.saveCredentials.useMutation({
    onSuccess: (_r: any, input: any) => {
      invalidate();
      setKey("");
      // The test is free, and it is what tells a valid key from a mistyped one.
      if (input?.apiKey) validate.mutate({ slug: "leadocean" });
      else toast.success("Saved");
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });
  const remove = trpc.prospectSources.removeCredentials.useMutation({
    onSuccess: () => { invalidate(); toast.success("Key removed"); },
    onError: (e: any) => toast.error(e?.message ?? "Could not remove"),
  });
  const setEnabled = trpc.prospectSources.setEnabled.useMutation({
    onSuccess: (r: any) => {
      invalidate();
      utils.settings.getAreSettings.invalidate();
      toast.success(r?.enabled ? "LeadOcean enabled" : "LeadOcean disabled: searches and campaigns skip it");
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not update"),
  });
  const enabled = source ? source.enabled !== false : true;
  const status = cred?.status ?? "unvalidated";

  const toggleStatus = (s: LeadoceanEmailStatus) => setStatuses((prev) => {
    if (!prev.includes(s)) return [...prev, s];
    const next = prev.filter((x) => x !== s);
    return next.length > 0 ? next : prev;
  });
  const looseStatus = statuses.some((s) => !LEADOCEAN_WORK_EMAIL_STATUSES.includes(s));
  const vendor = ledger.data?.vendor ?? [];
  const windows = vendor.filter((v) => v.fundedBy?.startsWith("LeadOcean"));
  const counters = Object.entries(config.phoneCounters ?? {});

  const body = (
    <>
      <div className="flex items-center gap-2 text-[13px]">
        <ShieldCheck className={cn("size-4", configured && status === "valid" ? "text-emerald-600" : status === "invalid" ? "text-rose-600" : "text-muted-foreground")} />
        {!configured ? (
          <span className="text-muted-foreground">Not connected. LeadOcean does not run for this workspace without its own key.</span>
        ) : status === "valid" ? (
          <span>Connected <span className="text-muted-foreground">· key saved{config.plan ? ` · ${config.plan} plan` : ""}{cred?.lastValidatedAt ? ` · tested ${new Date(cred.lastValidatedAt).toLocaleString()}` : ""}</span></span>
        ) : status === "invalid" ? (
          <span className="text-rose-700 dark:text-rose-400">Key rejected <span className="text-muted-foreground">· {cred?.validationError ?? "validation failed"}</span></span>
        ) : (
          <span>Saved, not yet tested <span className="text-muted-foreground">· key saved</span></span>
        )}
      </div>

      {configured && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/40 p-2.5">
          <div className="text-[12.5px]">
            <span className="font-medium">{enabled ? "Enabled" : "Disabled"}</span>
            <span className="text-muted-foreground">
              {enabled
                ? ": a campaign or a Source search that ticks it may use this source."
                : ": campaigns and searches skip it even when ticked. The key is kept."}
            </span>
          </div>
          <Switch aria-label="Use LeadOcean" checked={enabled} disabled={!isAdmin || setEnabled.isPending}
            onCheckedChange={(v) => setEnabled.mutate({ slug: "leadocean", enabled: v })} />
        </div>
      )}

      {source?.circuit.open && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5 text-[12px] text-amber-800 dark:text-amber-300">
          <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
          <span>Paused after {source.circuit.failures} consecutive failures. Resumes {source.circuit.openUntil ? new Date(source.circuit.openUntil).toLocaleTimeString() : "shortly"}.</span>
        </div>
      )}

      <div className="space-y-1.5">
        <Label>LeadOcean API key</Label>
        <Input aria-label="LeadOcean API key" type="password" value={key} onChange={(e) => setKey(e.target.value)} disabled={!isAdmin} autoComplete="off"
          placeholder={configured ? "Enter a new key to replace the saved one" : "Paste a lo_live_… key with the search and enrich scopes"} />
        <p className="text-[12px] text-muted-foreground">Create it at app.leadocean.io/keys. It is stored encrypted and is never shown again, here or anywhere.</p>
      </div>

      <div className="space-y-1.5">
        <Label>Email statuses to accept</Label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {LEADOCEAN_EMAIL_STATUSES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-[12.5px]">
              <Checkbox aria-label={`Accept ${LEADOCEAN_EMAIL_STATUS_LABELS[s]}`} checked={statuses.includes(s)} disabled={!isAdmin} onCheckedChange={() => toggleStatus(s)} />
              {LEADOCEAN_EMAIL_STATUS_LABELS[s]}
            </label>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">Undeliverable, disposable, spam-trap and abuse addresses are never accepted, whatever is ticked here. Every address still goes through Velocity's verification gate and suppression checks.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Daily cap on people pulled</Label>
          <Input aria-label="Daily cap on people pulled" type="number" min={1} value={cap} onChange={(e) => setCap(e.target.value)} disabled={!isAdmin} placeholder="No cap" />
          <p className="text-[11px] text-muted-foreground">Search rows per UTC day, for this workspace. Leave blank for no cap.</p>
        </div>
        <div className="space-y-1.5">
          <Label>Fetch phone numbers</Label>
          <div className="flex items-center gap-2 h-9">
            <Switch aria-label="Fetch phone numbers" checked={fetchPhones} disabled={!isAdmin} onCheckedChange={setFetchPhones} />
            <span className="text-[12.5px]">{fetchPhones ? "On" : "Off"}</span>
          </div>
          <p className="text-[11px] text-muted-foreground">Off asks LeadOcean for the work email alone, with no phone number in the answer.</p>
        </div>
      </div>
      {!fetchPhones && looseStatus && (
        <p className="text-[11px] text-amber-800 dark:text-amber-300">The statuses ticked include one the work-email lookup never returns, so Velocity uses LeadOcean's full lookup. That answer includes phone numbers. Velocity discards them, but a plan that meters phone reveals may count it.</p>
      )}

      {configured && (config.plan || config.records || windows.length > 0) && (
        <div className="rounded-lg border border-border/70 bg-muted/40 p-3 space-y-1.5">
          <div className="text-[12px] font-medium">What LeadOcean reports for this key</div>
          {config.plan && <Fact label="Plan" value={config.plan} />}
          {config.records?.used != null && <Fact label="Records used this period" value={config.records.used.toLocaleString()} />}
          {config.records?.remaining != null && <Fact label="Records left" value={config.records.remaining.toLocaleString()} />}
          {config.usage && <Fact label="Today" value={`${config.usage.searchToday.toLocaleString()} search · ${config.usage.enrichToday.toLocaleString()} enrich`} />}
          {config.requestsPerSecond != null && <Fact label="Rate" value={`${config.requestsPerSecond} requests a second`} />}
          {windows.map((w) => (
            <Fact key={w.fundedBy ?? ""} label={w.fundedBy ?? ""} value={`${(w.used ?? 0).toLocaleString()} / ${(w.limit ?? 0).toLocaleString()}`} />
          ))}
          {counters.map(([k, v]) => <Fact key={k} label={k} value={v.toLocaleString()} />)}
          {config.searchView === "thin" && (
            <p className="text-[11px] text-amber-800 dark:text-amber-300">This plan returns thin search rows: no name or email flags until a lookup, so a person can cost three records with phones off.</p>
          )}
        </div>
      )}

      <div className="rounded-lg border border-border/70 bg-muted/40 p-3 text-[12px] text-muted-foreground space-y-1">
        <p><span className="font-medium text-foreground">Every row and every lookup counts.</span> A search row is one record and the lookup for its address another, so a person costs two. Velocity asks LeadOcean first, for free, whether it will apply every filter, and buys nothing if it will not.</p>
        <p><span className="font-medium text-foreground">It never starts on its own.</span> Saving a key adds LeadOcean to no campaign. Tick it on a campaign's Sources tab, or on Source search.</p>
        <p><span className="font-medium text-foreground">States are approximate.</span> LeadOcean filters on the employer's headquarters, so Velocity checks each person's own place afterwards. On a campaign, someone it can show is elsewhere is not looked up, unless that campaign's territory check is off.</p>
        <p><span className="font-medium text-foreground">A person is pulled once.</span> LeadOcean keeps a list of who this workspace has seen, so a person dropped by one campaign's filters does not come back for another. People you previewed stay on that search: reopen it on Source search to promote them.</p>
      </div>

      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="gap-1.5" disabled={save.isPending || !seeded}
            onClick={() => {
              const n = Math.floor(Number(cap));
              const nextCap = cap.trim() === "" || !(n > 0) ? null : n;
              // Shown as saved: a 0 left in the box would read as a cap of zero.
              setCap(nextCap == null ? "" : String(nextCap));
              save.mutate({
                slug: "leadocean",
                ...(key.trim() ? { apiKey: key.trim() } : {}),
                config: { acceptedEmailStatuses: statuses, fetchPhones, dailyPeopleCap: nextCap },
              });
            }}>
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Save
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" disabled={!configured || validate.isPending} onClick={() => validate.mutate({ slug: "leadocean" })}>
            {validate.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Test connection
          </Button>
          {configured && (
            <Button variant="outline" size="sm" className="text-rose-600 hover:text-rose-600" disabled={remove.isPending}
              onClick={() => confirmAction({ title: "Remove this workspace's LeadOcean key?", description: "Campaigns and searches stop using LeadOcean until a key is saved again.", confirmLabel: "Remove" }, () => remove.mutate({ slug: "leadocean" }))}>
              Remove key
            </Button>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-muted-foreground">Only workspace admins can change the LeadOcean connection.</p>
      )}
    </>
  );

  if (variant === "bare") return <div className="space-y-4">{body}</div>;
  return (
    <section data-tour-id="leadocean-key-card" className="rounded-xl border border-border/70 bg-card p-5 shadow-sm space-y-4">
      <div className="flex items-start gap-2.5">
        <Waves className="size-4 mt-0.5 shrink-0 text-sky-600" />
        <div>
          <h2 className="text-[15px] font-semibold">LeadOcean</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">People search with verified work emails, on this workspace's own LeadOcean account. Stored encrypted.</p>
        </div>
      </div>
      {body}
    </section>
  );
}

export default LeadOceanSourceCard;
