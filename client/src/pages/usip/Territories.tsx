import { Button } from "@/components/ui/button";
import { Field, FormDialog, Section, SelectField, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Map, Plus, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function Territories() {
  const utils = trpc.useUtils();
  const { data } = trpc.territories.list.useQuery();
  const { data: rules } = trpc.crmTerritoryRules.list.useQuery();
  const { data: members } = trpc.team.list.useQuery();
  const [open, setOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const create = trpc.territories.create.useMutation({ onSuccess: () => { utils.territories.list.invalidate(); setOpen(false); toast.success("Territory created"); } });
  const del = trpc.territories.delete.useMutation({ onSuccess: () => utils.territories.list.invalidate() });
  const createRule = trpc.crmTerritoryRules.create.useMutation({
    onSuccess: () => { utils.crmTerritoryRules.list.invalidate(); setRuleOpen(false); toast.success("Rule created"); },
  });
  const delRule = trpc.crmTerritoryRules.delete.useMutation({ onSuccess: () => utils.crmTerritoryRules.list.invalidate() });

  return (
    <Shell title="Territories">
      <PageHeader title="Territories" description="Define geographic or account-based territories and assign reps accordingly. Territory rules automatically route new leads and accounts to the correct owner on creation." pageKey="territories"
        icon={<Map className="size-5" />}
      >
        <Button variant="outline" onClick={() => setRuleOpen(true)}><Zap className="size-4" /> New routing rule</Button>
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> New territory</Button>
      </PageHeader>
      <div className="p-6 space-y-6">
        <Section title={`Territories (${data?.length ?? 0})`}>
          {(data ?? []).length === 0 ? <EmptyState icon={Map} title="None yet" /> : (
            <ul className="divide-y">
              {data!.map((t) => (
                <li key={t.id} className="p-3 flex items-center text-sm">
                  <div className="flex-1">
                    <div className="font-medium">{t.name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">Rules: {JSON.stringify(t.rules ?? {})}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => del.mutate({ id: t.id })}><Trash2 className="size-3.5" /></Button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Routing rules (${rules?.length ?? 0})`} description="First-match-wins rules that auto-assign new accounts to a territory and owner on creation. Lower priority = higher precedence.">
          {(rules ?? []).length === 0 ? <EmptyState icon={Zap} title="No rules" description="Add a rule to auto-route new accounts." /> : (
            <ul className="divide-y rounded-lg border bg-card">
              {(rules ?? []).map((r) => {
                const terr = (data ?? []).find((t: any) => t.id === r.territoryId);
                const owner = (members ?? []).find((m: any) => m.userId === r.ownerUserId);
                const conds = [
                  r.industry && `industry=${r.industry}`,
                  r.country && `country=${r.country}`,
                  r.state && `state=${r.state}`,
                  r.companyContains && `company~"${r.companyContains}"`,
                ].filter(Boolean).join(" · ") || "any";
                return (
                  <li key={r.id} className="p-3 flex items-center gap-3 text-sm">
                    <Badge variant="outline" className="shrink-0">P{r.priority}</Badge>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-muted-foreground">{conds}</div>
                    </div>
                    <div className="text-xs text-muted-foreground text-right">
                      → {terr?.name ?? "(no territory)"} / {(owner as any)?.name ?? "(no owner)"}
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => delRule.mutate({ id: r.id })}><Trash2 className="size-3.5" /></Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>

      <FormDialog open={ruleOpen} onOpenChange={setRuleOpen} title="New routing rule" isPending={createRule.isPending}
        onSubmit={(f) => {
          createRule.mutate({
            name: String(f.get("name")),
            priority: Number(f.get("priority") ?? 100),
            industry: String(f.get("industry") ?? "") || undefined,
            country: String(f.get("country") ?? "") || undefined,
            state: String(f.get("state") ?? "") || undefined,
            companyContains: String(f.get("companyContains") ?? "") || undefined,
            territoryId: f.get("territoryId") ? Number(f.get("territoryId")) : undefined,
            ownerUserId: f.get("ownerUserId") ? Number(f.get("ownerUserId")) : undefined,
            active: true,
          });
        }}>
        <Field name="name" label="Rule name" required placeholder="EMEA Enterprise" />
        <Field name="priority" label="Priority (lower = higher precedence)" type="number" defaultValue={100} />
        <div className="grid grid-cols-2 gap-3">
          <Field name="industry" label="Industry equals" placeholder="any" />
          <Field name="country" label="Country/region equals" placeholder="any" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field name="state" label="State equals" placeholder="any" />
          <Field name="companyContains" label="Company name contains" placeholder="any" />
        </div>
        <SelectField name="territoryId" label="Assign to territory"
          options={[{ value: "", label: "— None —" }, ...((data ?? []).map((t: any) => ({ value: String(t.id), label: t.name })))]} />
        <SelectField name="ownerUserId" label="Assign to owner"
          options={[{ value: "", label: "— Skip —" }, ...((members ?? []).map((m: any) => ({ value: String(m.userId), label: m.name ?? `User ${m.userId}` })))]} />
      </FormDialog>

      <FormDialog open={open} onOpenChange={setOpen} title="New territory" isPending={create.isPending}
        onSubmit={(f) => {
          let rules: any = {};
          try { rules = JSON.parse(String(f.get("rules") ?? "{}")); } catch {}
          create.mutate({ name: String(f.get("name")), rules });
        }}>
        <Field name="name" label="Name" required />
        <TextareaField name="rules" label="Rules (JSON)" defaultValue={`{"region":"NA","segment":"mid_market"}`} rows={3} />
      </FormDialog>
    </Shell>
  );
}
