/**
 * Edit a lead: name, email, phone, title, company, source, status and owner.
 * Shared by the Leads list and the lead's own page (audit 2026-10-20, R81),
 * which had no edit at all. The patch comes from lib/leadEdit: a cleared field
 * is saved as cleared.
 */
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LEAD_EDIT_STATUSES, leadEditPatch, type LeadEditValues } from "@/lib/leadEdit";

export function EditLeadDialog({ lead, open, onOpenChange, onSaved }: { lead: any; open: boolean; onOpenChange: (v: boolean) => void; onSaved?: () => void }) {
  const utils = trpc.useUtils();
  const { data: members = [] } = trpc.workspace.members.useQuery(undefined, { enabled: open });
  const updateMut = trpc.leads.update.useMutation({
    onSuccess: () => { toast.success("Lead updated"); utils.leads.invalidate(); onSaved?.(); onOpenChange(false); },
    onError: (e: any) => toast.error(e.message),
  });
  const converted = lead?.status === "converted";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit Lead</DialogTitle></DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const values = Object.fromEntries(Array.from(f.entries()).map(([k, v]) => [k, String(v)])) as LeadEditValues;
            updateMut.mutate({ id: lead.id, patch: leadEditPatch(values, lead) as any });
          }}
          className="space-y-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <Field name="firstName" label="First name" required defaultValue={lead?.firstName} />
            <Field name="lastName" label="Last name" required defaultValue={lead?.lastName} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field name="email" label="Email" type="email" defaultValue={lead?.email} />
            <Field name="phone" label="Phone" type="tel" defaultValue={lead?.phone} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field name="title" label="Title" defaultValue={lead?.title} />
            <Field name="company" label="Company" defaultValue={lead?.company} />
          </div>
          <Field name="source" label="Source" defaultValue={lead?.source} />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="lead-status">Status</Label>
              {/* Converting is its own step (the Convert dialog), so it is not offered here. */}
              <select id="lead-status" name="status" defaultValue={lead?.status ?? "new"} disabled={converted}
                className="w-full border rounded-md px-3 py-2 text-sm h-9 bg-background capitalize">
                {converted && <option value="converted">converted</option>}
                {LEAD_EDIT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lead-owner">Owner</Label>
              <select id="lead-owner" name="ownerUserId" defaultValue={lead?.ownerUserId ?? ""}
                className="w-full border rounded-md px-3 py-2 text-sm h-9 bg-background">
                {lead?.ownerUserId == null && <option value="">Unassigned</option>}
                {(members as any[]).map((m) => <option key={m.id} value={m.id}>{m.name ?? m.email}</option>)}
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={updateMut.isPending}>Save</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field(props: { name: string; label: string; type?: string; required?: boolean; defaultValue?: string | null }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={`lead-${props.name}`}>{props.label}</Label>
      <Input id={`lead-${props.name}`} name={props.name} type={props.type ?? "text"} required={props.required} defaultValue={props.defaultValue ?? ""} />
    </div>
  );
}
