/**
 * /opportunities/:id — full deal page.
 *
 * Pulls `opportunities.getWithRelated` for account + contact roles, plus
 * a line-items list, plus an inline win/loss reason editor when the deal
 * is closed. Stage history is exposed as an extra tab.
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
import { KanbanSquare, Building2, Users, DollarSign, Brain, Loader2, Trash2 } from "lucide-react";
import { ConfirmButton } from "@/components/usip/Common";
import { toast } from "sonner";

function fmt$(n: any) {
  // Full, comma-grouped amount to match the list pages (e.g. $1,250,000).
  // The old K-only format mis-rendered millions as "$5000.0K".
  return `$${Math.round(Number(n ?? 0)).toLocaleString()}`;
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
    setReason((op.stage === "won" ? op.winReason : op.stage === "lost" ? op.lostReason : "") ?? "");
  }, [data]);

  if (isLoading) return <Shell title="Opportunity"><div className="p-4 md:p-5 text-sm text-muted-foreground">Loading…</div></Shell>;
  if (!data) return <Shell title="Opportunity"><EmptyState title="Opportunity not found" /></Shell>;

  const { opportunity: o, account, contactRoles } = data;
  const isClosedWon = o.stage === "won";
  const isClosedLost = o.stage === "lost";
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
              <Input value={reason} placeholder={isClosedWon ? "Why did we win?" : "Why did we lose?"}
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
            {intel.aiSummary && <div className="text-xs">{intel.aiSummary}</div>}
          </>
        ) : <div className="text-xs text-muted-foreground">No analysis yet — run from Pipeline.</div>}
        </div>
      </DetailSection>
    </div>
    <CustomFieldsPanel entityType="opportunity" entityId={o.id} />
    <RelatedTasks entityType="opportunity" entityId={o.id} />
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
          {o.closeDate && <span>Close {new Date(o.closeDate).toLocaleDateString()}</span>}
          {o.daysInStage > 0 && <span>{o.daysInStage}d in stage</span>}
        </>}
        actions={<ConfirmButton
          variant="outline"
          size="sm"
          ariaLabel="Delete this opportunity"
          title="Delete this opportunity?"
          description={`"${o.name}" will be permanently deleted, along with its stage history and line items. This cannot be undone.`}
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
