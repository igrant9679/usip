/**
 * TableSourceKeyCard — a workspace's OWN key for a prospect source that keeps
 * its key in the credential table and needs nothing beyond it (A-Leads,
 * CluGTM; owner go-ahead 2026-11-25).
 *
 * In the pool workspace this is where the platform owner pastes the account's
 * key; Settings → Billing and credits then shares it with every workspace as
 * "Source N". In any other workspace the key is that workspace's own, which
 * always wins and is never counted. A key from the pool is never shown here:
 * members read pool sources by number, never by vendor (owner 2026-11-25).
 *
 * The key goes one way: the server answers `configured`, never a masked value.
 * The vendor reports no allowance through its API, so the monthly figure here
 * is the account's plan, counted in Velocity's own ledger.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, ShieldCheck } from "lucide-react";
import { confirmAction } from "@/components/usip/Common";
import { isAdminRole } from "@shared/roleRank";

export type TableSourceSlug = "aleads" | "clugtm";

/** What each card says. An own-key card may name its vendor. */
const VENDORS: Record<TableSourceSlug, { vendorName: string; blurb: string; unit: string; defaultMonthly: number }> = {
  aleads: {
    vendorName: "A-Leads", unit: "credits", defaultMonthly: 100_000,
    blurb: "Verified B2B contacts. An address is found by name and company website, one credit each; a miss costs nothing. 6,000 calls a day.",
  },
  clugtm: {
    vendorName: "CluGTM", unit: "records", defaultMonthly: 25_000,
    blurb: "People search, with emails found afterwards by its own enrichment (one credit each, refunded when nothing is found).",
  },
};

export function TableSourceKeyCard({ slug }: { slug: TableSourceSlug }) {
  const { vendorName, blurb, unit, defaultMonthly } = VENDORS[slug];
  const utils = trpc.useUtils();
  const me = trpc.profile.getMe.useQuery();
  const isAdmin = isAdminRole(me.data?.role);
  const describe = trpc.prospectSources.describe.useQuery(undefined);
  const source = describe.data?.find((s) => s.slug === slug);
  const cred = source?.credential;
  const configured = !!cred?.configured && cred?.source !== "pool";
  const config = (cred?.config ?? {}) as { monthlyLeadAllowance?: number | null };
  const [key, setKey] = useState("");
  const [monthly, setMonthly] = useState<string | null>(null);
  const shownMonthly = monthly ?? (config.monthlyLeadAllowance != null ? String(config.monthlyLeadAllowance) : "");

  const invalidate = () => { utils.prospectSources.describe.invalidate(); };
  const validate = trpc.prospectSources.validate.useMutation({
    onSuccess: (r: any) => { invalidate(); toast.success(r?.message ?? "Key verified"); },
    onError: (e: any) => { invalidate(); toast.error(e?.message ?? "Key test failed"); },
  });
  const save = trpc.prospectSources.saveCredentials.useMutation({
    onSuccess: (_r: any, input: any) => {
      invalidate();
      setKey("");
      if (input?.apiKey) validate.mutate({ slug });
      else toast.success("Saved");
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });
  const remove = trpc.prospectSources.removeCredentials.useMutation({
    onSuccess: () => { invalidate(); toast.success("Key removed"); },
    onError: (e: any) => toast.error(e?.message ?? "Could not remove"),
  });
  const setEnabled = trpc.prospectSources.setEnabled.useMutation({
    onSuccess: (r: any) => { invalidate(); toast.success(r?.enabled ? `${vendorName} enabled` : `${vendorName} disabled: searches and campaigns skip it`); },
    onError: (e: any) => toast.error(e?.message ?? "Could not update"),
  });
  const enabled = source ? source.enabled !== false : true;
  const status = cred?.status ?? "unvalidated";
  const busy = save.isPending || validate.isPending || remove.isPending;

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3" data-testid={`table-source-card-${slug}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium flex items-center gap-1.5"><ShieldCheck className="size-4 text-muted-foreground" /> Your own {vendorName} key (optional)</div>
          <p className="text-[12px] text-muted-foreground mt-0.5">{blurb}</p>
        </div>
        {configured && (
          <Switch aria-label={`Use ${vendorName}`} checked={enabled} disabled={!isAdmin || setEnabled.isPending}
            onCheckedChange={(v) => setEnabled.mutate({ slug, enabled: v })} />
        )}
      </div>
      <div className="text-[12px]">
        {configured
          ? <span>Key saved · {status === "valid" ? "verified" : status === "invalid" ? `rejected${cred?.validationError ? `: ${cred.validationError}` : ""}` : "not tested yet"}</span>
          : <span className="text-muted-foreground">No key saved.</span>}
      </div>
      {isAdmin && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor={`${slug}-key`} className="text-[11.5px]">{configured ? "Replace key" : "API key"}</Label>
              <Input id={`${slug}-key`} type="password" autoComplete="off" className="h-8 w-72 text-xs" value={key} onChange={(e) => setKey(e.target.value)} />
            </div>
            <Button size="sm" className="h-8" disabled={busy || !key.trim()} onClick={() => save.mutate({ slug, apiKey: key.trim() })}>
              {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
            </Button>
            {configured && <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => validate.mutate({ slug })}>Test connection</Button>}
            {configured && (
              <Button size="sm" variant="ghost" className="h-8 text-red-600" disabled={busy}
                onClick={() => confirmAction({ title: `Remove this workspace's ${vendorName} key?`, description: `Campaigns and searches stop using ${vendorName} on this workspace's own key until one is saved again.`, confirmLabel: "Remove" }, () => remove.mutate({ slug }))}>
                Remove
              </Button>
            )}
          </div>
          {configured && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor={`${slug}-monthly`} className="text-[11.5px]">Monthly allowance ({unit})</Label>
                <Input id={`${slug}-monthly`} type="number" min={1} className="h-8 w-32 text-xs" placeholder={defaultMonthly.toLocaleString("en-US")}
                  value={shownMonthly} onChange={(e) => setMonthly(e.target.value)} />
              </div>
              <Button size="sm" variant="outline" className="h-8" disabled={busy}
                onClick={() => save.mutate({ slug, config: { monthlyLeadAllowance: shownMonthly.trim() === "" ? null : Math.max(1, Math.floor(Number(shownMonthly) || 0)) } })}>
                Save allowance
              </Button>
              <span className="text-[11px] text-muted-foreground">{vendorName} reports no allowance through its API, so Velocity counts it.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
