/**
 * /contacts/:id — contact profile.
 */
import { useParams, Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Shell, PageHeader, EmptyState } from "@/components/usip/Shell";
import { EntityDetailTabs } from "@/components/usip/EntityDetail";
import { RelatedTasks } from "@/pages/usip/Tasks";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, User, Mail, Phone, Linkedin, Building2 } from "lucide-react";

export default function ContactDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = Number(idStr);
  const [, setLocation] = useLocation();
  const { data, isLoading } = trpc.contacts.getWithAccount.useQuery({ id }, { enabled: !Number.isNaN(id) });

  if (isLoading) return <Shell title="Contact"><div className="p-6 text-sm text-muted-foreground">Loading…</div></Shell>;
  if (!data || !data.contact) return <Shell title="Contact"><EmptyState title="Contact not found" /></Shell>;

  const c = data.contact;
  const account = data.account ?? null;

  const overview = (
    <div className="space-y-3">
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <Card><CardContent className="pt-4 space-y-2 text-sm">
        <div className="flex items-center gap-2"><User className="size-4 text-muted-foreground" /><span className="font-medium">{c.firstName} {c.lastName}</span>{c.isPrimary && <Badge>Primary</Badge>}</div>
        {c.title && <div className="text-muted-foreground">{c.title}</div>}
        {c.email && <div className="flex items-center gap-2"><Mail className="size-4 text-muted-foreground" /><a href={`mailto:${c.email}`} className="hover:underline">{c.email}</a>{c.emailVerificationStatus && <Badge variant="outline" className="text-[10px]">{c.emailVerificationStatus}</Badge>}</div>}
        {c.phone && <div className="flex items-center gap-2"><Phone className="size-4 text-muted-foreground" />{c.phone}</div>}
        {c.linkedinUrl && <div className="flex items-center gap-2"><Linkedin className="size-4 text-muted-foreground" /><a href={c.linkedinUrl} target="_blank" rel="noreferrer" className="hover:underline">LinkedIn</a></div>}
        {c.city && <div className="text-muted-foreground">City: <span className="text-foreground">{c.city}</span></div>}
        {c.seniority && <div className="text-muted-foreground">Seniority: <span className="text-foreground">{c.seniority}</span></div>}
      </CardContent></Card>
      <Card><CardContent className="pt-4 space-y-2 text-sm">
        <div className="font-medium flex items-center gap-2"><Building2 className="size-4" /> Account</div>
        {account ? (
          <div>
            <Link href={`/accounts/${account.id}`} className="font-medium hover:underline">{account.name}</Link>
            {account.industry && <div className="text-xs text-muted-foreground">{account.industry}</div>}
            {account.domain && <div className="text-xs text-muted-foreground">{account.domain}</div>}
          </div>
        ) : <div className="text-xs text-muted-foreground">Not linked to an account.</div>}
      </CardContent></Card>
    </div>
    <RelatedTasks entityType="contact" entityId={c.id} />
    </div>
  );

  return (
    <Shell title={`${c.firstName} ${c.lastName}`}>
      <PageHeader title={`${c.firstName} ${c.lastName}`} description={c.title ?? undefined} icon={<User className="size-5" />}>
        <Button variant="outline" size="sm" onClick={() => setLocation("/contacts")}><ArrowLeft className="size-4 mr-1" /> Back</Button>
      </PageHeader>
      <div className="p-6">
        <EntityDetailTabs entityType="contact" entityId={c.id} overview={overview} />
      </div>
    </Shell>
  );
}
