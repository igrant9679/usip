import { Button } from "@/components/ui/button";
import { ConfirmButton, Field, fmt$, fmtDate, FormDialog, Section, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { computeQuoteTotals, formatMoney, formatMoneyCents } from "@shared/quoteTotals";
import { EmptyState, PageHeader, QueryError, Shell, TableSkeleton } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { ExternalLink, FileText, Plus, Send, Trash2, Receipt, Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type LineItem = { productId?: number; name: string; description?: string; quantity: number; unitPrice: number; discountPct: number };

function AiPricingPanel({ quote }: { quote: any }) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const score = trpc.quotesAi.suggestPricing.useMutation({
    onSuccess: () => utils.quotes.list.invalidate(),
    onError: (e: any) => toast.error(e.message),
  });

  const hasRec = quote.aiPriceMin != null;

  return (
    <div className="mt-1">
      {hasRec ? (
        <div>
          <button
            className="flex items-center gap-1 text-[11px] text-violet-600 hover:text-violet-700 transition-colors"
            onClick={() => setOpen((v) => !v)}
          >
            <Sparkles className="size-3" />
            AI pricing: {fmt$(Number(quote.aiPriceMin))}–{fmt$(Number(quote.aiPriceMax))}
            {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
          {open && (
            <div className="mt-1 rounded border bg-violet-50/60 p-2 text-xs space-y-1">
              <div className="flex gap-4">
                <div><span className="text-muted-foreground">Min: </span><span className="font-mono font-medium">{fmt$(Number(quote.aiPriceMin))}</span></div>
                <div><span className="text-muted-foreground">Max: </span><span className="font-mono font-medium">{fmt$(Number(quote.aiPriceMax))}</span></div>
                <div><span className="text-muted-foreground">Max discount: </span><span className="font-mono font-medium">{quote.aiDiscountCeil}%</span></div>
              </div>
              {quote.aiPriceRationale && (
                <p className="text-muted-foreground leading-relaxed">{quote.aiPriceRationale}</p>
              )}
            </div>
          )}
        </div>
      ) : (
        <button
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-violet-600 transition-colors"
          onClick={() => score.mutate({ quoteId: quote.id })}
          disabled={score.isPending}
        >
          <Sparkles className="size-3" />
          {score.isPending ? "Analysing…" : "Get AI pricing recommendation"}
        </button>
      )}
    </div>
  );
}

export default function Quotes() {
  const utils = trpc.useUtils();
  const list = trpc.quotes.list.useQuery();
  const opps = trpc.opportunities.list.useQuery();
  const products = trpc.products.list.useQuery();
  const oppMap = new Map((opps.data ?? []).map((o) => [o.id, o]));

  const [openNew, setOpenNew] = useState(false);
  const [oppId, setOppId] = useState<string>("");
  const [lis, setLis] = useState<LineItem[]>([{ name: "", quantity: 1, unitPrice: 0, discountPct: 0 }]);

  const create = trpc.quotes.create.useMutation({ onSuccess: () => { utils.quotes.list.invalidate(); setOpenNew(false); setLis([{ name: "", quantity: 1, unitPrice: 0, discountPct: 0 }]); toast.success("Quote created"); }, onError: (e) => toast.error(e.message) });
  const genPdf = trpc.quotes.generatePdf.useMutation({ onSuccess: (r) => { utils.quotes.list.invalidate(); window.open(r.url, "_blank"); }, onError: (e) => toast.error(e.message) });
  const send = trpc.quotes.send.useMutation({ onSuccess: () => { utils.quotes.list.invalidate(); toast.success("Sent"); }, onError: (e) => toast.error(e.message) });
  const setStatus = trpc.quotes.setStatus.useMutation({ onSuccess: () => utils.quotes.list.invalidate(), onError: (e) => toast.error(e.message) });
  const del = trpc.quotes.delete.useMutation({ onSuccess: () => { utils.quotes.list.invalidate(); toast.success("Quote deleted"); }, onError: (e) => toast.error(e.message) });

  // The same function the server uses to WRITE these columns (@shared/quoteTotals).
  // This preview used to reimplement the formula in floats, so the figure the
  // user approved was computed by different code than the figure stored.
  const totals = computeQuoteTotals(lis);

  const updLi = (i: number, p: Partial<LineItem>) => setLis((arr) => arr.map((x, k) => (k === i ? { ...x, ...p } : x)));

  return (
    <Shell title="Quotes (CPQ)">
      <PageHeader title="Quotes & proposals" description="Generate and manage price quotes linked directly to open opportunities. Add line items from your product catalogue, apply discounts, and send quotes for e-signature in one step." pageKey="quotes"
        icon={<Receipt className="size-5" />}
      >
        <Button onClick={() => setOpenNew(true)}><Plus className="size-4" /> New quote</Button>
      </PageHeader>
      <div className="p-4 md:p-5">
        <Section title={`Quotes (${list.data?.length ?? 0})`}>
          {list.error ? <QueryError message={list.error.message} onRetry={() => list.refetch()} /> : list.isLoading ? <TableSkeleton rows={6} /> : (list.data ?? []).length === 0 ? <EmptyState icon={FileText} title="No quotes yet" description="Build a quote to send pricing to a customer. Quotes you create — and their accept/reject status — show up here." /> : (
            <ul className="divide-y">
              {list.data!.map((q) => {
                const o = oppMap.get(q.opportunityId);
                return (
                  <li key={q.id} className="p-3 text-sm">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="min-w-0">
                        <div className="font-mono tabular-nums text-xs text-muted-foreground">{q.quoteNumber}</div>
                        <div className="font-medium truncate" title={o?.name ?? "—"}>{o?.name ?? "—"}</div>
                      </div>
                      <StatusPill tone={q.status === "accepted" ? "success" : q.status === "sent" ? "info" : q.status === "rejected" || q.status === "expired" ? "danger" : "muted"}>{q.status}</StatusPill>
                      <div className="ml-auto font-mono tabular-nums whitespace-nowrap shrink-0">{formatMoney(q.total)}</div>
                      <div className="text-xs text-muted-foreground whitespace-nowrap shrink-0">{fmtDate(q.expiresAt)}</div>
                      <div className="flex gap-1">
                        {!q.pdfUrl && <Button size="sm" variant="ghost" onClick={() => genPdf.mutate({ id: q.id })}>Generate</Button>}
                        {q.pdfUrl && <Button size="sm" variant="ghost" onClick={() => window.open(q.pdfUrl!, "_blank")}><ExternalLink className="size-3.5" /></Button>}
                        {/* Says what it does. It marks the quote sent; it does
                            NOT email anyone — there is no send path here, the
                            rep delivers the PDF themselves. The old copy
                            promised an email that was never sent, claimed a log
                            entry that was never written, and said "can't be
                            unsent" three lines above a comment calling Send the
                            reversible one of the two. */}
                        {q.status === "draft" && q.pdfUrl && <ConfirmButton size="sm" variant="ghost" destructive={false} ariaLabel="Mark quote as sent" title="Mark this quote as sent?" description="Marks the quote as sent and records who did it. It does not email the customer — send them the PDF yourself. There's no undo from here; once marked, you can record it as Accepted or Rejected." confirmLabel="Mark sent" onConfirm={() => send.mutate({ id: q.id })}><Send className="size-3.5" /></ConfirmButton>}
                        {q.status === "sent" && (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: q.id, status: "accepted" })}>Accept</Button>
                            <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: q.id, status: "rejected" })}>Reject</Button>
                          </>
                        )}
                        {/* Confirmed: this deletes the quote AND every line item.
                            It was a bare one-click delete sitting beside a Send
                            button that DOES confirm — and Send is the reversible
                            one of the two. */}
                        <ConfirmButton size="sm" variant="ghost" ariaLabel="Delete quote"
                          title={`Delete quote ${q.quoteNumber}?`}
                          description="The quote and all of its line items are permanently deleted. Any PDF already sent to the customer stays valid."
                          confirmLabel="Delete" onConfirm={() => del.mutate({ id: q.id })}>
                          <Trash2 className="size-3.5" />
                        </ConfirmButton>
                      </div>
                    </div>
                    {/* AI pricing recommendation */}
                    <AiPricingPanel quote={q} />
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>

      <FormDialog open={openNew} onOpenChange={setOpenNew} title="New quote" submitLabel="Create"
        isPending={create.isPending}
        onSubmit={(form) => {
          if (!oppId) { toast.error("Pick an opportunity"); return; }
          if (lis.some((li) => !li.name.trim())) { toast.error("Each line item needs a name"); return; }
          // FormDialog hands its FormData to onSubmit. This callback took no
          // argument, so the Notes and Terms the user typed were DISCARDED —
          // silently, on the terms of a document a customer signs. The column,
          // the input and the PDF section all existed; only this line was missing.
          const notes = String(form.get("notes") ?? "").trim();
          const terms = String(form.get("terms") ?? "").trim();
          create.mutate({
            opportunityId: Number(oppId),
            expiresInDays: 30,
            lineItems: lis,
            notes: notes || undefined,
            terms: terms || undefined,
          });
        }}>
        <div className="space-y-1">
          <label className="text-sm font-medium">Opportunity</label>
          <select className="w-full text-sm rounded-md border bg-background px-3 py-2 h-10" value={oppId} onChange={(e) => setOppId(e.target.value)}>
            <option value="">— Select —</option>
            {(opps.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        <div>
          <div className="text-xs uppercase text-muted-foreground mb-1">Line items</div>
          <ul className="space-y-2">
            {lis.map((li, i) => (
              <li key={i} className="grid grid-cols-12 gap-1.5 items-center">
                <select className="col-span-3 text-xs border rounded h-9 px-2"
                  value={li.productId ?? ""}
                  onChange={(e) => {
                    const pid = e.target.value ? Number(e.target.value) : undefined;
                    const p = (products.data ?? []).find((x) => x.id === pid);
                    updLi(i, { productId: pid, name: p?.name ?? li.name, unitPrice: p ? Number(p.listPrice) : li.unitPrice });
                  }}>
                  <option value="">— Custom —</option>
                  {(products.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input className="col-span-3 text-sm border rounded h-9 px-2" placeholder="Item name" value={li.name} onChange={(e) => updLi(i, { name: e.target.value })} />
                <input type="number" className="col-span-1 text-sm border rounded h-9 px-2" value={li.quantity} onChange={(e) => updLi(i, { quantity: Number(e.target.value) })} />
                <input type="number" className="col-span-2 text-sm border rounded h-9 px-2" value={li.unitPrice} onChange={(e) => updLi(i, { unitPrice: Number(e.target.value) })} />
                <input type="number" className="col-span-2 text-sm border rounded h-9 px-2" value={li.discountPct} onChange={(e) => updLi(i, { discountPct: Number(e.target.value) })} />
                <Button type="button" size="sm" variant="ghost" className="col-span-1" onClick={() => setLis((arr) => arr.filter((_, k) => k !== i))}><Trash2 className="size-3.5" /></Button>
              </li>
            ))}
          </ul>
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => setLis((arr) => [...arr, { name: "", quantity: 1, unitPrice: 0, discountPct: 0 }])}>+ Line item</Button>
          <div className="mt-3 text-sm font-mono tabular-nums flex justify-end flex-wrap gap-4">
            {/* formatMoneyCents, not fmt$: money on a quote always shows cents.
                fmt$ is toLocaleString(), which renders 1234.5 as "$1,234.5". */}
            <div>Subtotal: {formatMoneyCents(totals.subtotalCents)}</div>
            <div>Discount: −{formatMoneyCents(totals.discountTotalCents)}</div>
            <div className="font-bold">Total: {formatMoneyCents(totals.totalCents)}</div>
          </div>
        </div>
        <TextareaField name="notes" label="Notes" rows={2} />
        <TextareaField name="terms" label="Terms" rows={2} />
      </FormDialog>
    </Shell>
  );
}
