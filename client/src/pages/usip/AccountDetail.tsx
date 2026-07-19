/**
 * /accounts/:id — full account profile with tabs.
 *
 * Pulls `accounts.getWithContacts` for the header + contacts list, then
 * lists opportunities under the account in the Related tab. Everything
 * else (activities/notes/files) is shared via EntityDetailTabs.
 */
import { useParams, Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { CustomFieldsPanel } from "@/components/usip/CustomFieldsPanel";
import { Shell, PageHeader, EmptyState } from "@/components/usip/Shell";
import { EntityDetailTabs } from "@/components/usip/EntityDetail";
import { RelatedTasks } from "@/pages/usip/Tasks";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Building2, Globe, MapPin, Users, KanbanSquare } from "lucide-react";

function fmt$(n: any) {
  // Full, comma-grouped amount to match the list pages (e.g. $1,250,000).
  // The old K-only format mis-rendered millions as "$5000.0K".
  return `$${Math.round(Number(n ?? 0)).toLocaleString()}`;
}

export default function AccountDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = Number(idStr);
  const [, setLocation] = useLocation();
  const { data, isLoading } = trpc.accounts.getWithContacts.useQuery({ id }, { enabled: !Number.isNaN(id) });
  const { data: opps } = trpc.opportunities.list.useQuery();

  if (isLoading) return <Shell title="Account"><div className="p-4 md:p-5 text-sm text-muted-foreground">Loading…</div></Shell>;
  if (!data) return <Shell title="Account"><EmptyState title="Account not found" /></Shell>;

  const { account, contacts: accContacts } = data;
  const accOpps = (opps ?? []).filter((o: any) => o.accountId === account.id);

  const overview = (
    <div className="space-y-3">
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <Card><CardContent className="pt-4 space-y-2 text-sm">
        <div className="flex items-center gap-2"><Building2 className="size-4 text-muted-foreground" /><span className="font-medium">{account.name}</span></div>
        {account.domain && <div className="flex items-center gap-2 text-muted-foreground"><Globe className="size-4" /><a href={`https://${account.domain}`} target="_blank" rel="noreferrer" className="hover:underline">{account.domain}</a></div>}
        {account.region && <div className="flex items-center gap-2 text-muted-foreground"><MapPin className="size-4" />{account.region}</div>}
        {account.industry && <div className="text-muted-foreground">Industry: <span className="text-foreground">{account.industry}</span></div>}
        {account.employeeBand && <div className="text-muted-foreground">Employees: <span className="text-foreground">{account.employeeBand}</span></div>}
        {account.revenueBand && <div className="text-muted-foreground">Revenue: <span className="text-foreground">{account.revenueBand}</span></div>}
        {account.arr != null && Number(account.arr) > 0 && <div className="text-muted-foreground">ARR: <span className="text-foreground font-medium">{fmt$(account.arr)}</span></div>}
      </CardContent></Card>
      <Card><CardContent className="pt-4 space-y-2 text-sm">
        <div className="font-medium flex items-center gap-2"><Users className="size-4" /> Contacts <Badge variant="outline">{accContacts.length}</Badge></div>
        {accContacts.length === 0 ? <div className="text-xs text-muted-foreground">No contacts linked.</div> :
          <ul className="space-y-1">
            {accContacts.slice(0, 8).map((c) => (
              <li key={c.id} className="text-sm">
                <Link href={`/contacts/${c.id}`} className="hover:underline">{c.firstName} {c.lastName}</Link>
                {c.title && <span className="text-muted-foreground"> · {c.title}</span>}
              </li>
            ))}
          </ul>
        }
      </CardContent></Card>
    </div>
    <CustomFieldsPanel entityType="account" entityId={account.id} />
    <RelatedTasks entityType="account" entityId={account.id} />
    </div>
  );

  const related = (
    <div className="space-y-3">
      <div className="font-medium flex items-center gap-2"><KanbanSquare className="size-4" /> Opportunities <Badge variant="outline">{accOpps.length}</Badge></div>
      {accOpps.length === 0 ? <EmptyState title="No opportunities" /> :
        <ul className="rounded-lg border bg-card divide-y">
          {accOpps.map((o: any) => (
            <li key={o.id} className="p-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <Link href={`/opportunities/${o.id}`} className="text-sm font-medium hover:underline">{o.name}</Link>
                <div className="text-xs text-muted-foreground">{o.stage} · {fmt$(o.value)} · {o.winProb}%</div>
              </div>
            </li>
          ))}
        </ul>
      }
    </div>
  );

  return (
    <Shell title={account.name}>
      <PageHeader title={account.name} description={account.industry ?? undefined} icon={<Building2 className="size-5" />}>
        <Button variant="outline" size="sm" onClick={() => setLocation("/accounts")}><ArrowLeft className="size-4 mr-1" /> Back</Button>
      </PageHeader>
      <div className="p-4 md:p-5">
        <EntityDetailTabs entityType="account" entityId={account.id} overview={overview} related={related} />
      </div>
    </Shell>
  );
}
