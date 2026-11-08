/**
 * A proposal's Pricing tab (audit 2026-10-20, F34, and F36's versioned
 * quotes). The quote IS the proposal's pricing section: priced from the
 * product catalogue, saved as a new version each time it changes (every
 * earlier version stays here, viewable), downloadable as the quote PDF, with
 * the AI pricing advice the Quotes page had. Saving sets the proposal's price;
 * the linked deal's value changes only when the person says so, in a dialog
 * that names both amounts. The client sees the current version's table on the
 * portal. /quotes now redirects here (client/src/lib/retiredRoutes.ts).
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Download, History, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { invalidateDealReads } from "@/lib/crmCache";
import { confirmAction } from "@/components/usip/Common";
import { useSourceBudgets } from "@/components/usip/SpendPreview";
import { aiCallText } from "@shared/spendPreview";
import { computeQuoteTotals } from "@shared/quoteTotals";
import { getDisplayCurrency } from "@shared/money";

type Line = { productId?: number; name: string; description?: string; quantity: number; unitPrice: number; discountPct: number };
const blankLine = (): Line => ({ name: "", quantity: 1, unitPrice: 0, discountPct: 0 });

/** Money on a priced document always shows cents, in the workspace currency. */
export function pricingMoney(n: number | string | null | undefined): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: getDisplayCurrency(), minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n ?? 0));
}

/** What saving would do to the deal: the question the dialog asks, or null when nothing changes. */
export function dealValueQuestion(dealValue: string | number | null | undefined, newTotalCents: number): { from: number; to: number } | null {
  if (dealValue == null) return null;
  const from = Number(dealValue);
  const to = newTotalCents / 100;
  return Math.round(from * 100) === newTotalCents ? null : { from, to };
}

function LinesTable({ lines, totals }: { lines: any[]; totals: { subtotal: unknown; discountTotal: unknown; total: unknown } }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground border-b"><tr>
          <th className="text-left px-2 py-1.5">Item</th><th className="text-right px-2 py-1.5">Qty</th>
          <th className="text-right px-2 py-1.5">Unit price</th><th className="text-right px-2 py-1.5">Discount</th><th className="text-right px-2 py-1.5">Line total</th>
        </tr></thead>
        <tbody className="divide-y">
          {lines.map((l: any) => (
            <tr key={l.id ?? l.name}>
              <td className="px-2 py-1.5">{l.name}{l.description && <div className="text-xs text-muted-foreground">{l.description}</div>}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{l.quantity}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{pricingMoney(l.unitPrice)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{Number(l.discountPct ?? 0) > 0 ? `${Number(l.discountPct)}%` : "—"}</td>
              <td className="px-2 py-1.5 text-right tabular-nums font-medium">{pricingMoney(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 text-sm tabular-nums flex justify-end flex-wrap gap-4">
        <div>Subtotal {pricingMoney(totals.subtotal as number)}</div>
        <div>Discount −{pricingMoney(totals.discountTotal as number)}</div>
        <div className="font-semibold">Total {pricingMoney(totals.total as number)}</div>
      </div>
    </div>
  );
}

function VersionRow({ v, isCurrent }: { v: any; isCurrent: boolean }) {
  const [open, setOpen] = useState(false);
  const detail = trpc.quotes.get.useQuery({ id: v.id }, { enabled: open });
  return (
    <li className="py-2">
      <div className="flex items-center gap-3 text-sm">
        <span className="font-medium">Version {v.version}</span>
        <span className="tabular-nums">{pricingMoney(v.total)}</span>
        <span className="text-xs text-muted-foreground capitalize">{v.status}</span>
        <span className="text-xs text-muted-foreground">{v.createdAt ? new Date(v.createdAt).toLocaleString() : ""}</span>
        <span className="text-xs text-muted-foreground">{isCurrent ? "Current" : v.supersededAt ? `Replaced ${new Date(v.supersededAt).toLocaleDateString()}` : ""}</span>
        <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronUp className="size-3 mr-1" /> : <ChevronDown className="size-3 mr-1" />}{open ? "Hide" : "View"}
        </Button>
      </div>
      {open && (detail.data ? (
        <div className="mt-2 rounded border bg-muted/30 p-2"><LinesTable lines={detail.data.lineItems} totals={detail.data} /></div>
      ) : <div className="mt-2 text-xs text-muted-foreground">Loading…</div>)}
    </li>
  );
}

export function ProposalPricing({ proposalId }: { proposalId: number }) {
  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.proposals.pricing.useQuery({ proposalId });
  const products = trpc.products.list.useQuery();
  const budgets = useSourceBudgets();
  const [editing, setEditing] = useState(false);
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [notes, setNotes] = useState("");
  const [terms, setTerms] = useState("");
  const [ask, setAsk] = useState<{ from: number; to: number } | null>(null);
  const current = data?.current ?? null;

  // The editor starts from the current version: a change is a new version of it.
  useEffect(() => {
    if (!editing) return;
    if (current) {
      setLines(current.lineItems.map((l: any) => ({ productId: l.productId ?? undefined, name: l.name, description: l.description ?? undefined, quantity: l.quantity, unitPrice: Number(l.unitPrice), discountPct: Number(l.discountPct) })));
      setNotes(current.notes ?? "");
      setTerms(current.terms ?? "");
    } else {
      setLines([blankLine()]); setNotes(""); setTerms("");
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = trpc.proposals.savePricing.useMutation({
    onSuccess: (r) => {
      utils.proposals.pricing.invalidate({ proposalId });
      utils.proposals.get.invalidate();
      // The proposal's price, and the deal's value when it moved (R31).
      invalidateDealReads(utils);
      setEditing(false); setAsk(null);
      toast.success(`Pricing version ${r.version} saved${r.dealValueChanged ? "; the deal's value was set to it" : ""}`);
    },
    onError: (e) => toast.error(e.message),
  });
  const pdf = trpc.quotes.generatePdf.useMutation({
    onSuccess: (r) => { utils.proposals.pricing.invalidate({ proposalId }); window.open(r.url, "_blank"); },
    onError: (e) => toast.error(e.message),
  });
  const aiPricing = trpc.quotesAi.suggestPricing.useMutation({
    onSuccess: () => { utils.proposals.pricing.invalidate({ proposalId }); toast.success("AI pricing advice ready"); },
    onError: (e: any) => toast.error(e.message),
  });

  const totals = computeQuoteTotals(lines);
  const valid = lines.length > 0 && lines.every((l) => l.name.trim() && l.quantity >= 1 && l.unitPrice >= 0 && l.discountPct >= 0 && l.discountPct <= 100);
  const updLine = (i: number, p: Partial<Line>) => setLines((arr) => arr.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const submit = (setDealValue: boolean) => save.mutate({
    proposalId, lineItems: lines.map((l) => ({ ...l, name: l.name.trim() })),
    notes: notes.trim() || undefined, terms: terms.trim() || undefined, setDealValue,
  });
  const onSave = () => {
    if (!valid) { toast.error("Each line needs a name, a quantity of 1 or more and a price"); return; }
    // The deal's value moves only when the person says so (F34).
    const q = dealValueQuestion(data?.dealValue, totals.totalCents);
    if (q) setAsk(q); else submit(false);
  };

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading pricing…</div>;
  if (error) return <div className="text-sm text-destructive">{error.message}</div>;
  if (!data) return null;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="font-semibold">Pricing</h3>
        {current && <span className="text-xs text-muted-foreground">Version {current.version} · {pricingMoney(current.total)}</span>}
        <div className="ml-auto flex gap-2">
          {current && (
            <Button size="sm" variant="outline" disabled={pdf.isPending} onClick={() => pdf.mutate({ id: current.id })}>
              <Download className="size-3.5 mr-1" />{pdf.isPending ? "Building PDF…" : "Quote PDF"}
            </Button>
          )}
          {!data.locked && data.linkedOpportunityId && !editing && (
            <Button size="sm" onClick={() => setEditing(true)}>{current ? "Change pricing" : "Price this proposal"}</Button>
          )}
        </div>
      </div>

      {!data.linkedOpportunityId && (
        <p className="text-sm text-muted-foreground rounded-lg border p-3">Link this proposal to a deal (Overview → Pipeline) to price it: its pricing sets the deal's value.</p>
      )}
      {data.locked && <p className="text-xs text-muted-foreground">Accepted: this is the pricing the client agreed to. Duplicate the proposal to price a new version.</p>}

      {!editing && current && (
        <div className="rounded-lg border p-3 space-y-2">
          <LinesTable lines={current.lineItems} totals={current} />
          {current.notes && <div className="text-xs"><span className="font-medium">Notes:</span> {current.notes}</div>}
          {current.terms && <div className="text-xs"><span className="font-medium">Terms:</span> {current.terms}</div>}
          {/* The AI pricing advice the Quotes page had, ported here; it spends AI tokens, so it says so first. */}
          {current.aiPriceMin != null ? (
            <div className="rounded border bg-violet-50/60 dark:bg-violet-900/20 p-2 text-xs">
              <Sparkles className="size-3 inline mr-1 text-violet-600" />
              AI pricing: {pricingMoney(current.aiPriceMin)}–{pricingMoney(current.aiPriceMax)}, max discount {String(current.aiDiscountCeil ?? "—")}%
              {current.aiPriceRationale && <p className="text-muted-foreground mt-1">{current.aiPriceRationale}</p>}
            </div>
          ) : (
            <button type="button" className="text-[11px] text-muted-foreground hover:text-violet-600 inline-flex items-center gap-1" disabled={aiPricing.isPending}
              onClick={() => confirmAction({
                title: "Get AI pricing advice?",
                description: aiCallText(1, budgets.data?.ai, "over this pricing and up to 20 of your won deals"),
                confirmLabel: "Get advice",
              }, () => aiPricing.mutate({ quoteId: current.id }))}>
              <Sparkles className="size-3" />{aiPricing.isPending ? "Analysing…" : "Get AI pricing advice"}
            </button>
          )}
        </div>
      )}
      {!editing && !current && data.linkedOpportunityId && <p className="text-sm text-muted-foreground">No pricing yet.</p>}

      {editing && (
        <div className="rounded-lg border p-3 space-y-3">
          <ul className="space-y-2">
            {lines.map((li, i) => (
              <li key={i} className="grid grid-cols-12 gap-1.5 items-center">
                <select aria-label={`Line ${i + 1} product`} className="col-span-3 text-xs border rounded h-9 px-2 bg-background" value={li.productId ?? ""}
                  onChange={(e) => {
                    const pid = e.target.value ? Number(e.target.value) : undefined;
                    const p = (products.data ?? []).find((x: any) => x.id === pid);
                    updLine(i, { productId: pid, name: p?.name ?? li.name, unitPrice: p ? Number(p.listPrice) : li.unitPrice });
                  }}>
                  <option value="">— Custom —</option>
                  {(products.data ?? []).filter((p: any) => p.active || p.id === li.productId).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input aria-label={`Line ${i + 1} item name`} className="col-span-3 text-sm border rounded h-9 px-2 bg-background" placeholder="Item name" value={li.name} onChange={(e) => updLine(i, { name: e.target.value })} />
                <input aria-label={`Line ${i + 1} quantity`} type="number" min={1} className="col-span-1 text-sm border rounded h-9 px-2 bg-background" value={li.quantity} onChange={(e) => updLine(i, { quantity: Number(e.target.value) })} />
                <input aria-label={`Line ${i + 1} unit price`} type="number" step="0.01" min={0} className="col-span-2 text-sm border rounded h-9 px-2 bg-background" value={li.unitPrice} onChange={(e) => updLine(i, { unitPrice: Number(e.target.value) })} />
                <input aria-label={`Line ${i + 1} discount %`} type="number" min={0} max={100} className="col-span-2 text-sm border rounded h-9 px-2 bg-background" value={li.discountPct} onChange={(e) => updLine(i, { discountPct: Number(e.target.value) })} />
                <Button aria-label={`Remove line ${i + 1}`} type="button" size="sm" variant="ghost" className="col-span-1" disabled={lines.length === 1} onClick={() => setLines((arr) => arr.filter((_, k) => k !== i))}><Trash2 className="size-3.5" /></Button>
              </li>
            ))}
          </ul>
          <Button type="button" size="sm" variant="outline" onClick={() => setLines((arr) => [...arr, blankLine()])}><Plus className="size-3.5 mr-1" />Line item</Button>
          <div className="text-sm tabular-nums flex justify-end flex-wrap gap-4">
            <div>Subtotal {pricingMoney(totals.subtotalCents / 100)}</div>
            <div>Discount −{pricingMoney(totals.discountTotalCents / 100)}</div>
            <div className="font-semibold">Total {pricingMoney(totals.totalCents / 100)}</div>
          </div>
          <label className="block text-xs font-medium">Notes (shown to the client)
            <textarea aria-label="Pricing notes" className="mt-1 w-full rounded border bg-background p-2 text-sm" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <label className="block text-xs font-medium">Terms (shown to the client)
            <textarea aria-label="Pricing terms" className="mt-1 w-full rounded border bg-background p-2 text-sm" rows={2} value={terms} onChange={(e) => setTerms(e.target.value)} />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" disabled={!valid || save.isPending} onClick={onSave}>{current ? `Save as version ${current.version + 1}` : "Save pricing"}</Button>
          </div>
        </div>
      )}

      {data.versions.length > 0 && (
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5"><History className="size-3" /> Pricing versions</div>
          <ul className="divide-y rounded-lg border px-3">
            {data.versions.map((v: any) => <VersionRow key={v.id} v={v} isCurrent={!v.supersededAt} />)}
          </ul>
        </div>
      )}

      {/* The deal's value changes only on a yes (F34). */}
      <Dialog open={!!ask} onOpenChange={(o) => { if (!o) setAsk(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change the deal's value too?</DialogTitle>
            <DialogDescription>
              This pricing comes to {ask ? pricingMoney(ask.to) : ""}. The linked deal is worth {ask ? pricingMoney(ask.from) : ""}. The proposal's price becomes the new total either way.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" onClick={() => setAsk(null)}>Cancel</Button>
            <Button variant="outline" disabled={save.isPending} onClick={() => submit(false)}>Save, keep the deal at {ask ? pricingMoney(ask.from) : ""}</Button>
            <Button disabled={save.isPending} onClick={() => submit(true)}>Save and set the deal to {ask ? pricingMoney(ask.to) : ""}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
