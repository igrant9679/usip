/**
 * /leads/:id — lead profile with score history + convert CTA.
 *
 * v2 detail shell (phase 5, 2026-09-02): DetailHeader + DetailSection from
 * components/usip/DetailShell — the same vocabulary as CompanyProfile, so
 * opening a lead from the list no longer flips the design language.
 */
import { useParams, Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { CustomFieldsPanel } from "@/components/usip/CustomFieldsPanel";
import { Shell, EmptyState } from "@/components/usip/Shell";
import { DetailHeader, DetailSection, DetailFact, DetailBody } from "@/components/usip/DetailShell";
import { EntityDetailTabs } from "@/components/usip/EntityDetail";
import { RelatedTasks } from "@/pages/usip/Tasks";
import { AddToMenu } from "@/components/usip/AddToMenu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Target, Mail, Phone, Briefcase, Zap, Building2 } from "lucide-react";
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

  if (isLoading) return <Shell title="Lead"><div className="p-6 space-y-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-16 rounded-lg bg-muted/50 animate-pulse" />)}</div></Shell>;
  if (!lead) return <Shell title="Lead"><EmptyState title="Lead not found" /></Shell>;

  const converted = lead.status === "converted";
  const name = `${lead.firstName} ${lead.lastName}`.trim();

  const overview = (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <DetailSection title="Lead details">
          <div className="grid grid-cols-2 gap-4">
            <DetailFact icon={Briefcase} label="Title" value={lead.title} />
            <DetailFact icon={Building2} label="Company" value={lead.company} />
            <DetailFact icon={Mail} label="Email" value={lead.email ? <a href={`mailto:${lead.email}`} className="hover:underline">{lead.email}</a> : null} />
            <DetailFact icon={Phone} label="Phone" value={lead.phone} />
            <DetailFact label="Source" value={lead.source} />
            <DetailFact label="Score" value={`${lead.score}${lead.grade ? ` · grade ${lead.grade}` : ""}`} />
          </div>
        </DetailSection>
        <DetailSection title="AI next action" tag={<Zap className="size-3" />}>
          {lead.aiNextAction ? (
            <>
              <div className="text-[13px]">{lead.aiNextAction}</div>
              {lead.aiNextActionNote && <div className="text-[12px] text-muted-foreground mt-1">{lead.aiNextActionNote}</div>}
            </>
          ) : <div className="text-[12px] text-muted-foreground">No AI suggestion yet.</div>}
          {!converted ? (
            <div className="pt-3">
              <Button size="sm" disabled={convert.isPending} onClick={() => convert.mutate({ id: lead.id, createOpportunity: true })}>
                {convert.isPending ? "Converting…" : "Convert to opportunity"}
              </Button>
              <p className="text-[11.5px] text-muted-foreground mt-1">Creates the account, primary contact, and opportunity, then opens the deal.</p>
            </div>
          ) : (
            <div className="text-[12px] text-muted-foreground pt-3">
              Converted →{" "}
              {lead.convertedAccountId && <Link className="hover:underline" href={`/accounts/${lead.convertedAccountId}`}>company</Link>}
              {lead.convertedContactId && <> · <Link className="hover:underline" href={`/contacts/${lead.convertedContactId}`}>person</Link></>}
              {lead.convertedOpportunityId && <> · <Link className="hover:underline" href={`/opportunities/${lead.convertedOpportunityId}`}>deal</Link></>}
            </div>
          )}
        </DetailSection>
      </div>
      <CustomFieldsPanel entityType="lead" entityId={lead.id} />
      <RelatedTasks entityType="lead" entityId={lead.id} />
    </div>
  );

  return (
    <Shell title={name}>
      <div className="flex flex-col h-full min-h-0">
        <DetailHeader
          back={{ href: "/leads", label: "Leads" }}
          icon={<Target />}
          title={name}
          tourId="page-lead-detail"
          badges={<>
            <Badge variant="outline" className="text-[11px]">{lead.status}</Badge>
            {lead.grade && <Badge className="text-[11px]">Grade {lead.grade}</Badge>}
            <Badge variant="secondary" className="text-[11px]">Score {lead.score}</Badge>
          </>}
          meta={<>
            {lead.title && <span className="inline-flex items-center gap-1"><Briefcase className="size-3.5" />{lead.title}</span>}
            {lead.company && <span className="inline-flex items-center gap-1"><Building2 className="size-3.5" />{lead.company}</span>}
            {lead.email && <a href={`mailto:${lead.email}`} className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Mail className="size-3.5" />{lead.email}</a>}
          </>}
          actions={<AddToMenu leadIds={[lead.id]} />}
        />
        <DetailBody>
          <EntityDetailTabs entityType="lead" entityId={lead.id} overview={overview} />
        </DetailBody>
      </div>
    </Shell>
  );
}
