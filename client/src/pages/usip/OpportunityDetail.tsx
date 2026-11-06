/**
 * /opportunities/:id — full deal page.
 *
 * Pulls `opportunities.getWithRelated` for account + contact roles, plus
 * a line-items list, plus an inline win/loss reason editor when the deal
 * is closed. Stage history is exposed as an extra tab.
 *
 * Line items and contact roles are edited here (audit 2026-10-20, R35): the
 * server procedures existed and no screen called them, so neither could ever
 * be added. A line shows its product and its stored total, which carries the
 * discount (R34).
 */
import { useParams, Link, useLocation } from "wouter";
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { CustomFieldsPanel } from "@/components/usip/CustomFieldsPanel";
import { Shell, EmptyState } from "@/components/usip/Shell";
import { DetailHeader, DetailSection, DetailBody } from "@/components/usip/DetailShell";
import { EntityDetailTabs } from "@/components/usip/EntityDetail";
import { RelatedTasks } from "@/pages/usip/Tasks";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { KanbanSquare, Building2, Users, DollarSign, Brain, Loader2, Trash2, Plus } from "lucide-react";
import { ConfirmButton } from "@/components/usip/Common";
import { toast } from "sonner";
import { formatCalendarDate, storedToCalendarDate } from "@shared/calendarDate";
import { OPPORTUNITY_DELETE_SCOPE } from "@shared/dealDelete";
import { FORECAST_CATEGORIES, FORECAST_CATEGORY_LABEL, type ForecastCategory } from "@shared/forecastCategory";

function fmt$(n: any) {
  // Full, comma-grouped amount to match the list pages (e.g. $1,250,000).
  // The old K-only format mis-rendered millions as "$5000.0K".
  return `$${Math.round(Number(n ?? 0)).toLocaleString()}`;
}

/** A line's money to the cent: a discounted line is rarely whole dollars. */
function fmtCents(n: any) {
  return `$${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const ROLE_OPTIONS = ["champion", "decision_maker", "influencer", "evaluator", "blocker", "user", "other"] as const;
const roleLabel = (r: string) => r.replace(/_/g, " ");

/** Line items: the product, quantity × price less any discount, and the stored line total. */
export function DealLineItems({ opportunityId, items, onChanged }: { opportunityId: number; items: any[]; onChanged: () => void }) {
  const { data: products } = trpc.products.list.useQuery();
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [discountPct, setDiscountPct] = useState("0");
  const add = trpc.opportunities.addLineItem.useMutation({
    onSuccess: () => { setProductId(""); setQuantity("1"); setUnitPrice(""); setDiscountPct("0"); onChanged(); toast.success("Line item added"); },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.opportunities.removeLineItem.useMutation({
    onSuccess: () => { onChanged(); toast.success("Line item removed"); },
    onError: (e) => toast.error(e.message),
  });
  const active = (products ?? []).filter((p: any) => p.active !== false);
  const pick = (id: string) => {
    setProductId(id);
    const p = active.find((x: any) => String(x.id) === id);
    if (p) setUnitPrice(String(Number(p.listPrice ?? 0)));
  };
  const valid = !!productId && Number(quantity) >= 1 && Number.isInteger(Number(quantity))
    && unitPrice !== "" && Number(unitPrice) >= 0 && Number(discountPct) >= 0 && Number(discountPct) <= 100;
  return (
    <section>
      <div className="font-medium flex items-center gap-2 mb-2"><DollarSign className="size-4" /> Line items <Badge variant="outline">{items.length}</Badge></div>
      {items.length === 0 ? <EmptyState title="No line items" /> :
        <ul className="rounded-lg border bg-card divide-y">
          {items.map((li: any) => (
            <li key={li.id} className="p-3 flex items-center gap-3 text-sm">
              <div className="flex-1 min-w-0 truncate">{li.product?.name ?? `Product #${li.productId} (removed)`}</div>
              <div className="text-muted-foreground tabular-nums">
                {li.quantity ?? 1} × {fmtCents(li.unitPrice)}{Number(li.discountPct ?? 0) > 0 ? ` − ${Number(li.discountPct)}%` : ""}
              </div>
              <div className="font-medium w-24 text-right tabular-nums">{fmtCents(li.lineTotal)}</div>
              <ConfirmButton variant="ghost" size="sm" ariaLabel={`Remove ${li.product?.name ?? "line item"}`}
                title="Remove this line item?" description="The deal's amount is recalculated from the lines that remain." confirmLabel="Remove"
                disabled={remove.isPending} onConfirm={() => remove.mutate({ id: li.id, opportunityId })}>
                <Trash2 className="size-3.5" />
              </ConfirmButton>
            </li>
          ))}
        </ul>
      }
      <p className="text-xs text-muted-foreground mt-2">Adding or removing a line sets the deal's amount to the sum of its lines.</p>
      {active.length === 0 ? (
        <p className="text-xs text-muted-foreground mt-1">No products yet. <Link href="/products" className="underline">Add products</Link> to price this deal by line.</p>
      ) : (
        <form className="mt-2 grid grid-cols-2 md:grid-cols-[1fr_5rem_7rem_5rem_auto] gap-2 items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            add.mutate({ opportunityId, productId: Number(productId), quantity: Number(quantity), unitPrice: Number(unitPrice), discountPct: Number(discountPct) });
          }}>
          <select aria-label="Product" value={productId} onChange={(e) => pick(e.target.value)} className="col-span-2 md:col-span-1 h-9 text-sm rounded-md border bg-background px-2">
            <option value="">Choose a product…</option>
            {active.map((p: any) => <option key={p.id} value={String(p.id)}>{p.name}{p.sku ? ` (${p.sku})` : ""}</option>)}
          </select>
          <Input aria-label="Quantity" type="number" min={1} step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} className="h-9" />
          <Input aria-label="Unit price" type="number" min={0} step="0.01" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} className="h-9" placeholder="Unit price" />
          <Input aria-label="Discount %" type="number" min={0} max={100} step="0.01" value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} className="h-9" />
          <Button type="submit" size="sm" disabled={!valid || add.isPending} className="gap-1"><Plus className="size-3.5" /> Add line</Button>
        </form>
      )}
    </section>
  );
}

/** Contact roles: who on the account plays which part in this deal. */
export function DealContactRoles({ opportunityId, accountId, accountName, roles, onChanged }: {
  opportunityId: number; accountId: number | null; accountName: string | null; roles: any[]; onChanged: () => void;
}) {
  const { data: acct } = trpc.accounts.getWithContacts.useQuery({ id: accountId ?? 0 }, { enabled: !!accountId });
  const [contactId, setContactId] = useState("");
  const [role, setRole] = useState<(typeof ROLE_OPTIONS)[number]>("champion");
  const [isPrimary, setIsPrimary] = useState(false);
  const add = trpc.opportunities.addRole.useMutation({
    onSuccess: () => { setContactId(""); setIsPrimary(false); onChanged(); toast.success("Contact role added"); },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.opportunities.removeRole.useMutation({
    onSuccess: () => { onChanged(); toast.success("Contact role removed"); },
    onError: (e) => toast.error(e.message),
  });
  const people = acct?.contacts ?? [];
  return (
    <section>
      <div className="font-medium flex items-center gap-2 mb-2"><Users className="size-4" /> Contact roles <Badge variant="outline">{roles.length}</Badge></div>
      {roles.length === 0 ? <EmptyState title="No contacts on this deal" /> :
        <ul className="rounded-lg border bg-card divide-y">
          {roles.map((r: any) => (
            <li key={r.id} className="p-3 flex items-center gap-3 text-sm">
              <div className="flex-1">
                {r.contact ? (
                  <Link href={`/contacts/${r.contact.id}`} className="font-medium hover:underline">
                    {r.contact.firstName} {r.contact.lastName}
                  </Link>
                ) : <span className="text-muted-foreground">(deleted)</span>}
                {r.role && <span className="text-xs text-muted-foreground"> · {roleLabel(r.role)}</span>}
              </div>
              {r.isPrimary && <Badge>Primary</Badge>}
              <ConfirmButton variant="ghost" size="sm" ariaLabel="Remove this contact role"
                title="Remove this contact role?" description="The contact stays; only their role on this deal is removed." confirmLabel="Remove"
                disabled={remove.isPending} onConfirm={() => remove.mutate({ id: r.id })}>
                <Trash2 className="size-3.5" />
              </ConfirmButton>
            </li>
          ))}
        </ul>
      }
      {!accountId ? null : people.length === 0 ? (
        <p className="text-xs text-muted-foreground mt-2">{accountName ?? "This account"} has no contacts yet. Add one to the account to give it a role here.</p>
      ) : (
        <form className="mt-2 grid grid-cols-2 md:grid-cols-[1fr_10rem_auto_auto] gap-2 items-center"
          onSubmit={(e) => {
            e.preventDefault();
            if (!contactId) return;
            add.mutate({ opportunityId, contactId: Number(contactId), role, isPrimary });
          }}>
          <select aria-label="Contact" value={contactId} onChange={(e) => setContactId(e.target.value)} className="col-span-2 md:col-span-1 h-9 text-sm rounded-md border bg-background px-2">
            <option value="">Choose a contact at {accountName ?? "the account"}…</option>
            {people.map((c: any) => <option key={c.id} value={String(c.id)}>{c.firstName} {c.lastName}{c.title ? ` — ${c.title}` : ""}</option>)}
          </select>
          <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as (typeof ROLE_OPTIONS)[number])} className="h-9 text-sm rounded-md border bg-background px-2 capitalize">
            {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>
          <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} /> Primary</label>
          <Button type="submit" size="sm" disabled={!contactId || add.isPending} className="gap-1"><Plus className="size-3.5" /> Add role</Button>
        </form>
      )}
    </section>
  );
}

export default function OpportunityDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = Number(idStr);
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.opportunities.getWithRelated.useQuery({ id }, { enabled: !Number.isNaN(id) });
  const { data: lineItems } = trpc.opportunities.listLineItems.useQuery({ opportunityId: id }, { enabled: !Number.isNaN(id) });
  const { data: intel } = trpc.oppIntelligence.getIntelligence.useQuery({ opportunityId: id }, { enabled: !Number.isNaN(id) });
  const { data: stageHistory } = trpc.opportunities.stageHistory.useQuery({ opportunityId: id }, { enabled: !Number.isNaN(id) });
  const { data: members } = trpc.team.list.useQuery();

  const update = trpc.opportunities.update.useMutation({
    onSuccess: () => { utils.opportunities.getWithRelated.invalidate({ id }); toast.success("Saved"); },
    onError: (e) => toast.error(e.message),
  });

  // Delete was previously reachable ONLY from the pipeline board's record
  // drawer — this page had no way to remove the record you were looking at.
  const del = trpc.opportunities.delete.useMutation({
    onSuccess: () => {
      toast.success("Opportunity deleted");
      utils.opportunities.board.invalidate();
      utils.opportunities.list.invalidate();
      setLocation("/pipeline");
    },
    onError: (e) => toast.error(`Failed to delete: ${e.message}`),
  });

  const [reason, setReason] = useState("");
  // Seed the reason editor from the stored value so saving an unedited field
  // re-persists it instead of clobbering winReason/lostReason with "".
  useEffect(() => {
    const op = data?.opportunity;
    if (!op) return;
    const meta = data?.stageMeta;
    setReason((meta?.isWon ? op.winReason : meta?.isLost ? op.lostReason : "") ?? "");
  }, [data]);

  if (isLoading) return <Shell title="Opportunity"><div className="p-4 md:p-5 text-sm text-muted-foreground">Loading…</div></Shell>;
  if (!data) return <Shell title="Opportunity"><EmptyState title="Opportunity not found" /></Shell>;

  const { opportunity: o, account, contactRoles } = data;
  // Flags, not the key — see crm.getWithRelated.
  const isClosedWon = !!data.stageMeta?.isWon;
  const isClosedLost = !!data.stageMeta?.isLost;
  const reasonValue = isClosedWon ? o.winReason : isClosedLost ? o.lostReason : null;

  const overview = (
    <div className="space-y-5">
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <DetailSection title="Deal" className="md:col-span-2">
        <div className="space-y-2 text-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline">{o.stage}</Badge>
          <Badge variant="secondary">{fmt$(o.value)}</Badge>
          <Badge>{o.winProb}%</Badge>
          {o.daysInStage > 0 && <span className="text-xs text-muted-foreground">{o.daysInStage}d in stage</span>}
        </div>
        {/* No screen could set a close date (audit 2026-10-20, R16), so the
            forecast's months were mostly "No close date". A calendar date:
            the server stores the day picked, not midnight UTC. */}
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Expected close
          <Input type="date" className="h-7 w-40 text-xs" disabled={update.isPending}
            key={storedToCalendarDate(o.closeDate) ?? "none"}
            defaultValue={storedToCalendarDate(o.closeDate) ?? ""}
            onBlur={(e) => {
              const next = e.target.value || null;
              if (next !== (storedToCalendarDate(o.closeDate) ?? null)) update.mutate({ id: o.id, patch: { closeDate: next } });
            }} />
        </label>
        {/* A rep's forecast call (audit 2026-10-20, R41): Commit was "90%
            or more", which no stage defaults to, so it was nearly always $0. */}
        {!isClosedWon && !isClosedLost && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Forecast
            <select aria-label="Forecast category" className="h-7 text-xs rounded-md border bg-background px-2" disabled={update.isPending}
              value={o.forecastCategory ?? ""}
              onChange={(e) => update.mutate({ id: o.id, patch: { forecastCategory: (e.target.value || null) as ForecastCategory | null } })}>
              <option value="">By win % ({o.winProb >= 90 ? "Commit" : o.winProb >= 50 ? "Best case" : "Pipeline"})</option>
              {FORECAST_CATEGORIES.map((c) => <option key={c} value={c}>{FORECAST_CATEGORY_LABEL[c]}</option>)}
            </select>
          </label>
        )}
        {o.nextStep &&<div className="text-muted-foreground text-xs">Next: <span className="text-foreground">{o.nextStep}</span></div>}
        {account && (
          <div className="flex items-center gap-2 pt-2"><Building2 className="size-4 text-muted-foreground" />
            <Link href={`/accounts/${account.id}`} className="hover:underline font-medium">{account.name}</Link>
          </div>
        )}
        {(isClosedWon || isClosedLost) && (
          <div className="pt-3 border-t mt-3 space-y-1">
            <div className="text-xs font-medium">{isClosedWon ? "Win reason" : "Loss reason"}</div>
            <div className="flex gap-2">
              <Input aria-label={isClosedWon ? "Win reason" : "Loss reason"} value={reason} placeholder={isClosedWon ? "Why did we win?" : "Why did we lose?"}
                onChange={(e) => setReason(e.target.value)} />
              <Button size="sm" disabled={update.isPending} className="gap-1.5"
                onClick={() => update.mutate({ id: o.id, patch: isClosedWon ? { winReason: reason } : { lostReason: reason } })}>
                {update.isPending && <Loader2 className="size-3.5 animate-spin" />}
                Save
              </Button>
            </div>
          </div>
        )}
        </div>
      </DetailSection>
      <DetailSection title="AI intelligence" tag={<Brain className="size-3" />}>
        <div className="space-y-2 text-sm">
        {intel ? (
          <>
            <div className="text-muted-foreground">Win prob: <span className="text-foreground">{Math.round(Number(intel.winProbability))}%</span></div>
            {intel.suggestedStage && intel.suggestedStage !== o.stage && (
              <div className="text-muted-foreground">Suggests: <span className="text-foreground">{intel.suggestedStage}</span></div>
            )}
            {/* The intelligence row has no aiSummary column, so this never showed (X3.3);
                the AI's own reasoning for the win probability is the summary it writes. */}
            {intel.winProbabilityRationale && <div className="text-xs">{intel.winProbabilityRationale}</div>}
          </>
        ) : <div className="text-xs text-muted-foreground">No analysis yet — run from Pipeline.</div>}
        </div>
      </DetailSection>
    </div>
    <CustomFieldsPanel entityType="opportunity" entityId={o.id} />
    <RelatedTasks entityType="opportunity" entityId={o.id} />
    </div>
  );

  // A line changes the deal's amount, so the header and the boards re-read too.
  const lineItemsChanged = () => {
    utils.opportunities.listLineItems.invalidate({ opportunityId: id });
    utils.opportunities.getWithRelated.invalidate({ id });
    utils.opportunities.board.invalidate();
  };
  const rolesChanged = () => utils.opportunities.getWithRelated.invalidate({ id });

  const related = (
    <div className="space-y-6">
      <DealContactRoles opportunityId={o.id} accountId={account?.id ?? null} accountName={account?.name ?? null} roles={contactRoles} onChanged={rolesChanged} />
      <DealLineItems opportunityId={o.id} items={lineItems ?? []} onChanged={lineItemsChanged} />
    </div>
  );

  const memberName = (uid: number | null | undefined): string => {
    if (!uid) return "—";
    const m = (members ?? []).find((x: any) => x.userId === uid);
    return (m as any)?.name ?? `User ${uid}`;
  };
  const fmtTs = (t: any): string => { try { return t ? new Date(t).toLocaleString() : "—"; } catch { return "—"; } };

  const stageTab = stageHistory && stageHistory.length > 0 ? {
    value: "stages",
    label: "Stage history",
    content: (
      <ul className="rounded-lg border bg-card divide-y">
        {stageHistory.map((h: any) => (
          <li key={h.id} className="p-3 flex items-center gap-3 text-sm">
            <Badge variant="outline">{h.fromStage ?? "—"}</Badge>
            <span className="text-muted-foreground">→</span>
            <Badge>{h.toStage}</Badge>
            {typeof h.daysInPrevStage === "number" && (
              <span className="text-xs text-muted-foreground">{h.daysInPrevStage}d in prev</span>
            )}
            <span className="text-xs text-muted-foreground ml-auto">{memberName(h.changedByUserId)} · {fmtTs(h.createdAt)}</span>
          </li>
        ))}
      </ul>
    ),
  } : (stageHistory ? {
    // Loaded but empty — render a friendly placeholder so the tab still
    // shows up once an opportunity has *any* recorded transition. While
    // empty we just don't surface it (existing behavior).
    value: "stages",
    label: "Stage history",
    content: (
      <div className="text-sm text-muted-foreground p-6 rounded-lg border bg-card">
        No stage transitions recorded yet. Moves on the Pipeline board after this update will appear here.
      </div>
    ),
  } : null);

  return (
    <Shell title={o.name}>
      <div className="flex flex-col h-full min-h-0">
      <DetailHeader
        back={{ href: "/v2/deals", label: "Deals" }}
        icon={<KanbanSquare />}
        title={o.name}
        tourId="page-opportunity-detail"
        badges={<>
          <Badge variant="outline" className="text-[11px]">{o.stage}</Badge>
          <Badge variant="secondary" className="text-[11px]">{fmt$(o.value)}</Badge>
          <Badge className="text-[11px]">{o.winProb}%</Badge>
        </>}
        meta={<>
          {account && <Link href={`/accounts/${account.id}`} className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Building2 className="size-3.5" />{account.name}</Link>}
          {o.closeDate && <span>Close {formatCalendarDate(o.closeDate)}</span>}
          {o.daysInStage > 0 && <span>{o.daysInStage}d in stage</span>}
        </>}
        actions={<ConfirmButton
          variant="outline"
          size="sm"
          ariaLabel="Delete this opportunity"
          title="Delete this opportunity?"
          description={`"${o.name}" will be permanently deleted, ${OPPORTUNITY_DELETE_SCOPE}. This cannot be undone.`}
          confirmLabel="Delete"
          disabled={del.isPending}
          className="text-destructive hover:text-destructive hover:bg-destructive/10"
          onConfirm={() => del.mutate({ id })}
        >
          <Trash2 className="size-4 mr-1" /> Delete
        </ConfirmButton>}
      />
      <DetailBody>
        <EntityDetailTabs
          entityType="opportunity"
          entityId={o.id}
          overview={overview}
          related={related}
          extraTabs={stageTab ? [stageTab] : undefined}
        />
      </DetailBody>
      </div>
    </Shell>
  );
}
