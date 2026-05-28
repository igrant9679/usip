/**
 * /opportunities/:id — full deal page.
 *
 * Pulls `opportunities.getWithRelated` for account + contact roles, plus
 * a line-items list, plus an inline win/loss reason editor when the deal
 * is closed. Stage history is exposed as an extra tab.
 */
import { useParams, Link, useLocation } from "wouter";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Shell, PageHeader, EmptyState } from "@/components/usip/Shell";
import { EntityDetailTabs } from "@/components/usip/EntityDetail";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ArrowLeft, KanbanSquare, Building2, Users, DollarSign, Brain } from "lucide-react";
import { toast } from "sonner";

function fmt$(n: any) {
  const v = Number(n ?? 0);
  return v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v.toFixed(0)}`;
}

export default function OpportunityDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = Number(idStr);
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.opportunities.getWithRelated.useQuery({ id }, { enabled: !Number.isNaN(id) });
  const { data: lineItems } = trpc.opportunities.listLineItems.useQuery({ opportunityId: id }, { enabled: !Number.isNaN(id) });
  const { data: intel } = trpc.oppIntelligence.getIntelligence.useQuery({ opportunityId: id }, { enabled: !Number.isNaN(id) });

  const update = trpc.opportunities.update.useMutation({
    onSuccess: () => { utils.opportunities.getWithRelated.invalidate({ id }); toast.success("Saved"); },
    onError: (e) => toast.error(e.message),
  });

  const [reason, setReason] = useState("");

  if (isLoading) return <Shell title="Opportunity"><div className="p-6 text-sm text-muted-foreground">Loading…</div></Shell>;
  if (!data) return <Shell title="Opportunity"><EmptyState title="Opportunity not found" /></Shell>;

  const { opportunity: o, account, contactRoles } = data;
  const isClosedWon = o.stage === "won";
  const isClosedLost = o.stage === "lost";
  const reasonValue = isClosedWon ? o.winReason : isClosedLost ? o.lostReason : null;

  const overview = (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <Card className="md:col-span-2"><CardContent className="pt-4 space-y-2 text-sm">
        <div className="flex items-center gap-2 font-medium"><KanbanSquare className="size-4 text-muted-foreground" />{o.name}</div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline">{o.stage}</Badge>
          <Badge variant="secondary">{fmt$(o.value)}</Badge>
          <Badge>{o.winProb}%</Badge>
          {o.closeDate && <span className="text-xs text-muted-foreground">Close {new Date(o.closeDate).toLocaleDateString()}</span>}
          {o.daysInStage > 0 && <span className="text-xs text-muted-foreground">{o.daysInStage}d in stage</span>}
        </div>
        {o.nextStep && <div className="text-muted-foreground text-xs">Next: <span className="text-foreground">{o.nextStep}</span></div>}
        {account && (
          <div className="flex items-center gap-2 pt-2"><Building2 className="size-4 text-muted-foreground" />
            <Link href={`/accounts/${account.id}`} className="hover:underline font-medium">{account.name}</Link>
          </div>
        )}
        {(isClosedWon || isClosedLost) && (
          <div className="pt-3 border-t mt-3 space-y-1">
            <div className="text-xs font-medium">{isClosedWon ? "Win reason" : "Loss reason"}</div>
            <div className="flex gap-2">
              <Input defaultValue={reasonValue ?? ""} placeholder={isClosedWon ? "Why did we win?" : "Why did we lose?"}
                onChange={(e) => setReason(e.target.value)} />
              <Button size="sm" disabled={update.isPending}
                onClick={() => update.mutate({ id: o.id, patch: isClosedWon ? { winReason: reason } : { lostReason: reason } })}>
                Save
              </Button>
            </div>
          </div>
        )}
      </CardContent></Card>
      <Card><CardContent className="pt-4 space-y-2 text-sm">
        <div className="font-medium flex items-center gap-2"><Brain className="size-4" /> AI intelligence</div>
        {intel ? (
          <>
            <div className="text-muted-foreground">Win prob: <span className="text-foreground">{Math.round(Number(intel.winProbability))}%</span></div>
            {intel.suggestedStage && intel.suggestedStage !== o.stage && (
              <div className="text-muted-foreground">Suggests: <span className="text-foreground">{intel.suggestedStage}</span></div>
            )}
            {intel.aiSummary && <div className="text-xs">{intel.aiSummary}</div>}
          </>
        ) : <div className="text-xs text-muted-foreground">No analysis yet — run from Pipeline.</div>}
      </CardContent></Card>
    </div>
  );

  const related = (
    <div className="space-y-4">
      <section>
        <div className="font-medium flex items-center gap-2 mb-2"><Users className="size-4" /> Contact roles <Badge variant="outline">{contactRoles.length}</Badge></div>
        {contactRoles.length === 0 ? <EmptyState title="No contacts on this deal" /> :
          <ul className="rounded-lg border bg-card divide-y">
            {contactRoles.map((r: any) => (
              <li key={r.id} className="p-3 flex items-center gap-3 text-sm">
                <div className="flex-1">
                  {r.contact ? (
                    <Link href={`/contacts/${r.contact.id}`} className="font-medium hover:underline">
                      {r.contact.firstName} {r.contact.lastName}
                    </Link>
                  ) : <span className="text-muted-foreground">(deleted)</span>}
                  {r.role && <span className="text-xs text-muted-foreground"> · {r.role}</span>}
                </div>
                {r.isPrimary && <Badge>Primary</Badge>}
              </li>
            ))}
          </ul>
        }
      </section>
      <section>
        <div className="font-medium flex items-center gap-2 mb-2"><DollarSign className="size-4" /> Line items <Badge variant="outline">{lineItems?.length ?? 0}</Badge></div>
        {!lineItems || lineItems.length === 0 ? <EmptyState title="No line items" /> :
          <ul className="rounded-lg border bg-card divide-y">
            {lineItems.map((li: any) => (
              <li key={li.id} className="p-3 flex items-center gap-3 text-sm">
                <div className="flex-1">{li.productName ?? li.sku ?? `Item #${li.id}`}</div>
                <div className="text-muted-foreground">{li.quantity ?? 1} × {fmt$(li.unitPrice)}</div>
                <div className="font-medium w-20 text-right">{fmt$((li.quantity ?? 1) * Number(li.unitPrice ?? 0))}</div>
              </li>
            ))}
          </ul>
        }
      </section>
    </div>
  );

  // Stage history table exists in schema but has no router query yet;
  // expose it later in a follow-up. For now we just don't render the tab.
  const stageTab: any = null;

  return (
    <Shell title={o.name}>
      <PageHeader title={o.name} description={account?.name ?? undefined} icon={<KanbanSquare className="size-5" />}>
        <Button variant="outline" size="sm" onClick={() => setLocation("/pipeline")}><ArrowLeft className="size-4 mr-1" /> Back to pipeline</Button>
      </PageHeader>
      <div className="p-6">
        <EntityDetailTabs
          entityType="opportunity"
          entityId={o.id}
          overview={overview}
          related={related}
          extraTabs={stageTab ? [stageTab] : undefined}
        />
      </div>
    </Shell>
  );
}
