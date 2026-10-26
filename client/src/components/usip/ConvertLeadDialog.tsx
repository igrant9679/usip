/**
 * Convert a lead, choosing what it becomes (audit 2026-10-20, R8).
 *
 * The Convert button used to act at once: a NEW account and contact every
 * time (a second person from Acme made a second Acme) and an invented
 * $25,000 deal. This dialog shows the accounts the lead may already be and a
 * contact that already has its address, picks the match by default, and
 * creates a deal only when asked — with the value typed here.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Converted = { accountId: number; contactId: number; opportunityId: number | null };

export function ConvertLeadDialog({
  leadId,
  onOpenChange,
  onConverted,
}: {
  /** The lead to convert; null keeps the dialog closed. */
  leadId: number | null;
  onOpenChange: (open: boolean) => void;
  onConverted?: (r: Converted) => void;
}) {
  const open = leadId != null;
  const utils = trpc.useUtils();
  const preview = trpc.leads.convertPreview.useQuery({ id: leadId ?? 0 }, { enabled: open });
  const [account, setAccount] = useState<string>("new");
  const [contact, setContact] = useState<string>("new");
  const [withDeal, setWithDeal] = useState(false);
  const [dealName, setDealName] = useState("");
  const [dealValue, setDealValue] = useState("");

  // Default to the matches once they load, for each lead opened.
  useEffect(() => {
    const d = preview.data;
    if (!d) return;
    setAccount(d.accountMatches[0] ? String(d.accountMatches[0].id) : "new");
    setContact(d.contactMatch ? String(d.contactMatch.id) : "new");
    setWithDeal(false);
    setDealName(`${d.newAccountName} – New opportunity`);
    setDealValue("");
  }, [preview.data, leadId]);

  const convert = trpc.leads.convert.useMutation({
    onSuccess: (r) => {
      utils.leads.list.invalidate();
      utils.leads.get.invalidate();
      utils.workspace.summary.invalidate();
      toast.success(r.opportunityId ? "Converted — deal created" : "Converted");
      onOpenChange(false);
      onConverted?.(r);
    },
    onError: (e) => toast.error("Convert failed", { description: e.message }),
  });

  const d = preview.data;
  const submit = () => {
    if (!leadId) return;
    if (withDeal && (dealValue.trim() === "" || !Number.isFinite(Number(dealValue)) || Number(dealValue) < 0)) {
      toast.error("Enter the deal's value (0 is fine if it is not known yet).");
      return;
    }
    convert.mutate({
      id: leadId,
      accountId: account === "new" ? null : Number(account),
      contactId: contact === "new" ? null : Number(contact),
      createOpportunity: withDeal,
      opportunityValue: withDeal ? Number(dealValue) : undefined,
      opportunityName: withDeal && dealName.trim() ? dealName.trim() : undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Convert lead</DialogTitle></DialogHeader>
        {!d ? (
          <div className="text-sm text-muted-foreground py-6">{preview.isError ? preview.error.message : "Looking for matching records…"}</div>
        ) : d.alreadyConverted ? (
          <div className="text-sm text-muted-foreground py-6">This lead was already converted.</div>
        ) : (
          <div className="space-y-4 text-sm">
            <fieldset className="space-y-1.5">
              <legend className="font-medium mb-1">Account</legend>
              {d.accountMatches.map((a) => (
                <label key={a.id} className="flex items-center gap-2">
                  <input type="radio" name="account" checked={account === String(a.id)} onChange={() => setAccount(String(a.id))} />
                  <span>Use <strong>{a.name}</strong>{a.domain ? ` (${a.domain})` : ""} <span className="text-muted-foreground">— same {a.reason}</span></span>
                </label>
              ))}
              <label className="flex items-center gap-2">
                <input type="radio" name="account" checked={account === "new"} onChange={() => setAccount("new")} />
                <span>Create a new account <strong>{d.newAccountName}</strong></span>
              </label>
            </fieldset>
            <fieldset className="space-y-1.5">
              <legend className="font-medium mb-1">Contact</legend>
              {d.contactMatch && (
                <label className="flex items-center gap-2">
                  <input type="radio" name="contact" checked={contact === String(d.contactMatch.id)} onChange={() => setContact(String(d.contactMatch!.id))} />
                  <span>Use the existing contact <strong>{d.contactMatch.firstName} {d.contactMatch.lastName}</strong> ({d.contactMatch.email})</span>
                </label>
              )}
              <label className="flex items-center gap-2">
                <input type="radio" name="contact" checked={contact === "new"} onChange={() => setContact("new")} />
                <span>Create a new contact</span>
              </label>
            </fieldset>
            <fieldset className="space-y-2">
              <label className="flex items-center gap-2 font-medium">
                <input type="checkbox" checked={withDeal} onChange={(e) => setWithDeal(e.target.checked)} />
                Also create a deal
              </label>
              {withDeal && (
                <div className="grid grid-cols-[1fr_9rem] gap-2 pl-6">
                  <div className="space-y-1">
                    <Label htmlFor="convert-deal-name">Deal name</Label>
                    <Input id="convert-deal-name" value={dealName} onChange={(e) => setDealName(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="convert-deal-value">Value ($)</Label>
                    <Input id="convert-deal-value" type="number" step="0.01" min="0" inputMode="decimal" value={dealValue} onChange={(e) => setDealValue(e.target.value)} placeholder="0.00" />
                  </div>
                  <p className="col-span-2 text-xs text-muted-foreground">Goes in the default pipeline's first stage.</p>
                </div>
              )}
            </fieldset>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!d || d.alreadyConverted || convert.isPending}>{convert.isPending ? "Converting…" : "Convert"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
