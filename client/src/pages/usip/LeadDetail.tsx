/**
 * /leads/:id — lead profile with score history + convert CTA.
 */
import { useParams, Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { CustomFieldsPanel } from "@/components/usip/CustomFieldsPanel";
import { Shell, PageHeader, EmptyState } from "@/components/usip/Shell";
import { EntityDetailTabs } from "@/components/usip/EntityDetail";
import { RelatedTasks } from "@/pages/usip/Tasks";
import { AddToSequenceButton } from "@/components/usip/AddToSequenceButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Target, Mail, Phone, Briefcase, Zap } from "lucide-react";
import { toast } from "sonner";

export default function LeadDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = Number(idStr);
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const { data: lead, isLoading } = trpc.leads.get.useQuery({ id }, { enabled: !Number.isNaN(id) });
  const convert = trpc.leads.convert.useMutation({
    onSuccess: ({ accountId, contactId, opportunityId }) => {
      utils.leads.get.invalidate({ id });
      toast.success("Converted");
      if (opportunityId) setLocation(`/opportunities/${opportunityId}`);
      else if (contactId) setLocation(`/contacts/${contactId}`);
      else if (accountId) setLocation(`/accounts/${accountId}`);
    },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading) return <Shell title="Lead"><div className="p-4 md:p-5 text-sm text-muted-foreground">Loading…</div></Shell>;
  if (!lead) return <Shell title="Lead"><EmptyState title="Lead not found" /></Shell>;

  const converted = lead.status === "converted";

  const overview = (
    <div className="space-y-3">
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <Card><CardContent className="pt-4 space-y-2 text-sm">
        <div className="flex items-center gap-2 font-medium"><Target className="size-4 text-muted-foreground" />{lead.firstName} {lead.lastName}</div>
        {lead.title && <div className="text-muted-foreground">{lead.title}</div>}
        {lead.company && <div className="flex items-center gap-2"><Briefcase className="size-4 text-muted-foreground" />{lead.company}</div>}
        {lead.email && <div className="flex items-center gap-2"><Mail className="size-4 text-muted-foreground" /><a href={`mailto:${lead.email}`} className="hover:underline">{lead.email}</a></div>}
        {lead.phone && <div className="flex items-center gap-2"><Phone className="size-4 text-muted-foreground" />{lead.phone}</div>}
        <div className="flex items-center gap-2 pt-1">
          <Badge variant="outline">{lead.status}</Badge>
          {lead.grade && <Badge>Grade {lead.grade}</Badge>}
          <Badge variant="secondary">Score {lead.score}</Badge>
          {lead.source && <Badge variant="outline">{lead.source}</Badge>}
        </div>
      </CardContent></Card>
      <Card><CardContent className="pt-4 space-y-2 text-sm">
        <div className="font-medium flex items-center gap-2"><Zap className="size-4" /> AI next action</div>
        {lead.aiNextAction ? (
          <>
            <div>{lead.aiNextAction}</div>
            {lead.aiNextActionNote && <div className="text-xs text-muted-foreground">{lead.aiNextActionNote}</div>}
          </>
        ) : <div className="text-xs text-muted-foreground">No AI suggestion yet.</div>}
        {!converted && (
          <div className="pt-2">
            <Button size="sm" disabled={convert.isPending}
              onClick={() => convert.mutate({ id: lead.id, createOpportunity: true })}>
              {convert.isPending ? "Converting…" : "Convert to opportunity"}
            </Button>
            <p className="text-xs text-muted-foreground mt-1">Creates the account, primary contact, and opportunity, then opens the deal.</p>
          </div>
        )}
        {converted && (
          <div className="text-xs text-muted-foreground pt-2">
            Converted →{" "}
            {lead.convertedAccountId && <Link className="hover:underline" href={`/accounts/${lead.convertedAccountId}`}>account</Link>}
            {lead.convertedContactId && <> · <Link className="hover:underline" href={`/contacts/${lead.convertedContactId}`}>contact</Link></>}
            {lead.convertedOpportunityId && <> · <Link className="hover:underline" href={`/opportunities/${lead.convertedOpportunityId}`}>opportunity</Link></>}
          </div>
        )}
      </CardContent></Card>
    </div>
    <CustomFieldsPanel entityType="lead" entityId={lead.id} />
    <RelatedTasks entityType="lead" entityId={lead.id} />
    </div>
  );

  return (
    <Shell title={`${lead.firstName} ${lead.lastName}`}>
      <PageHeader title={`${lead.firstName} ${lead.lastName}`} description={lead.company ?? undefined} icon={<Target className="size-5" />}>
        <AddToSequenceButton entityType="lead" entityId={lead.id} />
        <Button variant="outline" size="sm" onClick={() => setLocation("/leads")}><ArrowLeft className="size-4 mr-1" /> Back</Button>
      </PageHeader>
      <div className="p-4 md:p-5">
        <EntityDetailTabs entityType="lead" entityId={lead.id} overview={overview} />
      </div>
    </Shell>
  );
}
