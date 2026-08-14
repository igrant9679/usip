/**
 * Push people who already exist in the CRM into an ARE campaign
 * (owner ask 2026-08-14: "manually push a prospect through to generate a
 * sequence for in the ARE Hub campaigns — include those that already exist").
 *
 * Until now the only ways into a campaign were the engine minting prospects
 * itself and a CSV import. Someone already in People could not be put into a
 * campaign at all.
 *
 * Each pushed person is queued, enriched, and then has their sequence
 * generated — in that order, server-side, because sequence generation refuses
 * a prospect with no enrichment behind it.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Search, UserPlus, AlertTriangle } from "lucide-react";

export function AddExistingProspectsDialog({
  open,
  onOpenChange,
  campaignId,
  onPushed,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  campaignId: number;
  onPushed?: () => void;
}) {
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [generate, setGenerate] = useState(true);
  const [skipped, setSkipped] = useState<Array<{ prospectId: number; reason: string }>>([]);

  const list = trpc.prospects.list.useQuery(
    { page: 1, perPage: 50, search: search.trim() || undefined },
    { enabled: open },
  );
  const rows: Array<Record<string, any>> = (list.data as any)?.data ?? [];

  const push = trpc.are.prospects.pushExisting.useMutation();

  const nameOf = (p: Record<string, any>) =>
    [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email || `Prospect ${p.id}`;

  const byId = useMemo(() => new Map(rows.map((r) => [r.id as number, r])), [rows]);

  const toggle = (id: number) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const submit = async () => {
    const prospectIds = Array.from(checked);
    if (prospectIds.length === 0) { toast.error("Pick at least one prospect"); return; }
    try {
      const r = await push.mutateAsync({ campaignId, prospectIds, generateSequence: generate });
      setSkipped(r.skipped);
      if (r.added.length > 0) {
        toast.success(
          `${r.added.length} prospect${r.added.length === 1 ? "" : "s"} added` +
          (generate ? " — enriching, then generating sequences" : " — enriching"),
        );
        onPushed?.();
      }
      // Keep the dialog open when some were refused, so the reasons can be read.
      if (r.skipped.length === 0) { setChecked(new Set()); onOpenChange(false); }
      else setChecked(new Set(r.skipped.map((s) => s.prospectId)));
    } catch (e) {
      toast.error((e as Error).message || "Could not add those prospects");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add existing prospects</DialogTitle>
          <DialogDescription>
            Pick people already in your CRM to push into this campaign. Each one is enriched and then has a
            sequence generated. A prospect can only be in one campaign at a time.
          </DialogDescription>
        </DialogHeader>

        <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-2.5">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email or company"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
          />
        </div>

        {skipped.length > 0 && (
          <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
            <div className="mb-1 flex items-center gap-1.5 font-medium">
              <AlertTriangle className="size-3.5" /> {skipped.length} not added
            </div>
            <ul className="space-y-0.5">
              {skipped.slice(0, 8).map((s) => (
                <li key={s.prospectId}>
                  {nameOf(byId.get(s.prospectId) ?? { id: s.prospectId })} — {s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {list.isLoading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading prospects…
          </div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {search.trim() ? "No prospects match that search." : "No prospects in the CRM yet."}
          </p>
        ) : (
          <div className="divide-y divide-border/60 rounded-lg border border-border">
            {rows.map((p) => (
              <label key={p.id} className="flex cursor-pointer items-center gap-3 px-3 py-2">
                <Checkbox checked={checked.has(p.id)} onCheckedChange={() => toggle(p.id)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{nameOf(p)}</span>
                  <span className="block truncate text-[12px] text-muted-foreground">
                    {[p.title, p.company, p.email].filter(Boolean).join(" · ") || "—"}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}

        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-muted-foreground">
          <Checkbox checked={generate} onCheckedChange={(v) => setGenerate(v === true)} />
          Generate a sequence once enrichment finishes
        </label>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={push.isPending || checked.size === 0} onClick={submit}>
            {push.isPending ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <UserPlus className="mr-1.5 size-4" />}
            Add {checked.size || ""} to campaign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
