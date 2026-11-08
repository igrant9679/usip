/**
 * "Record renewal or churn" on a customer (audit 2026-10-20, F36, U26): on
 * the Renewals cards, the Customers detail panel and the company page.
 *
 * A renewal sets the new term and its ARR; a churn sets the day and the
 * reason. Both go through cs.recordRenewal / cs.recordChurn, which write the
 * contract amendment and the customer row that every ARR figure sums
 * (services/dealMetrics customerArrTotals), so the KPIs move with them.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { invalidateCustomerReads } from "@/lib/crmCache";
import { tablistProps, tabProps } from "@/lib/tabs";

export const CHURN_REASON_OPTIONS = ["Price", "Switched to a competitor", "No longer needed", "Budget cut", "Poor adoption", "Company acquired or closed"] as const;

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const storedDay = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** The new term's default: from the old end (or today), for the same length (or a year). */
export function defaultRenewalTerm(c: { contractStart?: unknown; contractEnd?: unknown }, today: Date = new Date()): { start: string; end: string } {
  const start = storedDay(c.contractEnd) ?? ymd(today);
  const oldStart = storedDay(c.contractStart);
  const oldEnd = storedDay(c.contractEnd);
  const termDays = oldStart && oldEnd ? Math.max(1, Math.round((Date.parse(oldEnd) - Date.parse(oldStart)) / 86_400_000)) : 365;
  const end = new Date(Date.parse(`${start}T00:00:00Z`) + termDays * 86_400_000).toISOString().slice(0, 10);
  return { start, end };
}

export function RecordRenewalOrChurn({ customer, accountName, size = "sm", className }: {
  customer: { id: number; arr?: unknown; contractStart?: unknown; contractEnd?: unknown; renewalStage?: string };
  accountName?: string | null;
  size?: "sm" | "xs";
  className?: string;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"renewal" | "churn">("renewal");
  const term = defaultRenewalTerm(customer);
  const [newArr, setNewArr] = useState(String(Number(customer.arr ?? 0)));
  const [termStart, setTermStart] = useState(term.start);
  const [termEnd, setTermEnd] = useState(term.end);
  const [churnedOn, setChurnedOn] = useState(ymd(new Date()));
  const [reason, setReason] = useState("");
  // Every customer read refreshes (R31): the KPIs, the boards and this company.
  const renew = trpc.cs.recordRenewal.useMutation({
    onSuccess: () => { invalidateCustomerReads(utils); toast.success("Renewal recorded"); setOpen(false); },
    onError: (e) => toast.error(e.message),
  });
  const churn = trpc.cs.recordChurn.useMutation({
    onSuccess: () => { invalidateCustomerReads(utils); toast.success("Churn recorded"); setOpen(false); },
    onError: (e) => toast.error(e.message),
  });
  const churned = customer.renewalStage === "churned";
  const arrNum = Number(newArr);
  const renewOk = newArr.trim() !== "" && Number.isFinite(arrNum) && arrNum >= 0 && !!termEnd && termEnd > termStart;
  return (
    <>
      <Button type="button" variant="outline" size="sm" className={size === "xs" ? `h-6 px-2 text-[11px] ${className ?? ""}` : className}
        onClick={() => { setMode("renewal"); setOpen(true); }}>
        Record renewal or churn
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record renewal or churn{accountName ? ` — ${accountName}` : ""}</DialogTitle>
            <DialogDescription>Updates the contract and ARR; the Customers figures follow.</DialogDescription>
          </DialogHeader>
          <div {...tablistProps("Outcome")} className="flex rounded-md border overflow-hidden text-sm">
            {(["renewal", "churn"] as const).map((m) => (
              <button key={m} {...tabProps(mode === m)} type="button" disabled={m === "churn" && churned}
                className={`flex-1 px-3 py-1.5 ${mode === m ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                onClick={() => setMode(m)}>
                {m === "renewal" ? "Renewal" : churned ? "Churned already" : "Churn"}
              </button>
            ))}
          </div>
          {mode === "renewal" ? (
            <form className="space-y-3" onSubmit={(e) => {
              e.preventDefault();
              if (renewOk) renew.mutate({ customerId: customer.id, newArr: arrNum, termStart, termEnd });
            }}>
              <label className="block text-xs font-medium">New ARR
                <Input aria-label="New ARR" type="number" min={0} step="0.01" value={newArr} onChange={(e) => setNewArr(e.target.value)} className="mt-1" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs font-medium">Term starts
                  <Input aria-label="Term starts" type="date" value={termStart} onChange={(e) => setTermStart(e.target.value)} className="mt-1" />
                </label>
                <label className="block text-xs font-medium">Term ends
                  <Input aria-label="Term ends" type="date" min={termStart} value={termEnd} onChange={(e) => setTermEnd(e.target.value)} className="mt-1" />
                </label>
              </div>
              {churned && <p className="text-xs text-muted-foreground">This customer is recorded as churned; a renewal brings them back.</p>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={!renewOk || renew.isPending}>Record renewal</Button>
              </DialogFooter>
            </form>
          ) : (
            <form className="space-y-3" onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim() && churnedOn) churn.mutate({ customerId: customer.id, churnedOn, reason: reason.trim() });
            }}>
              <label className="block text-xs font-medium">Churned on
                <Input aria-label="Churned on" type="date" value={churnedOn} onChange={(e) => setChurnedOn(e.target.value)} className="mt-1" />
              </label>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common reasons">
                {CHURN_REASON_OPTIONS.map((o) => (
                  <Button key={o} type="button" size="sm" variant={reason === o ? "default" : "outline"} className="h-7 text-xs" aria-pressed={reason === o} onClick={() => setReason(o)}>{o}</Button>
                ))}
              </div>
              <label className="block text-xs font-medium">Reason
                <Input aria-label="Churn reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} className="mt-1" placeholder="Why they left" />
              </label>
              <p className="text-xs text-muted-foreground">Their ARR leaves the ARR total and counts as churned ARR for the period.</p>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" variant="destructive" disabled={!reason.trim() || !churnedOn || churn.isPending}>Record churn</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
