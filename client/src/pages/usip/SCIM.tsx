import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Field, FormDialog, Section, StatusPill, fmtDate } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function SCIM() {
  const utils = trpc.useUtils();
  const providers = trpc.scim.listProviders.useQuery();
  const events = trpc.scim.events.useQuery();
  const [open, setOpen] = useState(false);
  const [reveal, setReveal] = useState<{ name: string; token: string } | null>(null);
  const create = trpc.scim.createProvider.useMutation({ onSuccess: (r) => { utils.scim.listProviders.invalidate(); setOpen(false); setReveal({ name: "Just created", token: r.bearerToken }); } });
  const tog = trpc.scim.toggleProvider.useMutation({ onSuccess: () => utils.scim.listProviders.invalidate() });
  const rotate = trpc.scim.rotateToken.useMutation({ onSuccess: (r) => { utils.scim.listProviders.invalidate(); setReveal({ name: "Rotated", token: r.bearerToken }); } });
  const del = trpc.scim.deleteProvider.useMutation({ onSuccess: () => utils.scim.listProviders.invalidate() });

  const baseUrl = `${window.location.origin}/api/scim/v2`;

  return (
    <Shell title="SCIM">
      <PageHeader title="SCIM provisioning" description="Connect Okta / Azure AD / Jumpcloud to provision users into this workspace.">
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> New provider</Button>
      </PageHeader>
      <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-3">
          <Section title="SCIM endpoints">
            <div className="p-3 text-xs space-y-2 font-mono">
              <div><span className="text-muted-foreground">Base:</span> {baseUrl}</div>
              <div>GET&nbsp;&nbsp;/Users</div>
              <div>POST /Users</div>
              <div>GET&nbsp;&nbsp;/Users/:id</div>
              <div>PUT&nbsp;&nbsp;/Users/:id</div>
              <div>PATCH /Users/:id</div>
              <div>DELETE /Users/:id</div>
              <div>GET&nbsp;&nbsp;/Groups</div>
              <div>GET&nbsp;&nbsp;/ServiceProviderConfig</div>
            </div>
          </Section>
          <Section title={`Providers (${providers.data?.length ?? 0})`}>
            {(providers.data ?? []).length === 0 ? <EmptyState icon={KeyRound} title="No providers" /> : (
              <ul className="divide-y">
                {providers.data!.map((p) => (
                  <li key={p.id} className="p-3 flex items-center text-sm gap-2">
                    <Switch checked={p.enabled} onCheckedChange={(v) => tog.mutate({ id: p.id, enabled: v })} />
                    <div className="flex-1">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">created {fmtDate(p.createdAt)}</div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => rotate.mutate({ id: p.id })}>Rotate</Button>
                    <Button size="sm" variant="ghost" onClick={() => del.mutate({ id: p.id })}><Trash2 className="size-3.5" /></Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        <Section title={`Recent SCIM events (${events.data?.length ?? 0})`}>
          {(events.data ?? []).length === 0 ? <EmptyState icon={KeyRound} title="No events" /> : (
            <ul className="divide-y">
              {events.data!.map((e) => (
                <li key={e.id} className="p-3 text-xs">
                  <div className="flex items-center gap-2">
                    <StatusPill tone={(e.responseStatus ?? 0) < 300 ? "success" : "danger"}>{e.responseStatus ?? "—"}</StatusPill>
                    <span className="font-mono">{e.method} /{e.resource}</span>
                    <div className="ml-auto text-muted-foreground">{fmtDate(e.receivedAt)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <FormDialog open={open} onOpenChange={setOpen} title="New SCIM provider" isPending={create.isPending}
        onSubmit={(f) => create.mutate({ name: String(f.get("name")) })}>
        <Field name="name" label="Provider name" placeholder="Okta production" required />
      </FormDialog>

      <FormDialog open={!!reveal} onOpenChange={(v) => !v && setReveal(null)} title="Bearer token (copy now — won't be shown again)" submitLabel="Done"
        onSubmit={() => setReveal(null)}>
        <p className="text-xs text-muted-foreground">Configure your IdP with this token as the SCIM bearer credential.</p>
        <div className="font-mono text-xs bg-secondary p-3 rounded break-all">{reveal?.token}</div>
        <Button type="button" variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(reveal?.token ?? ""); toast.success("Copied"); }}><Copy className="size-3.5" /> Copy</Button>
      </FormDialog>
    </Shell>
  );
}
