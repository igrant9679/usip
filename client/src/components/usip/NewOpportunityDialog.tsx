/**
 * New opportunity — the one dialog the Pipeline board and the Deals board use
 * (audit 2026-10-20, R36, R103).
 *
 * What it fixes: with no accounts the bare select sent account 0; it listed
 * archived accounts, every account in the workspace at once; the stage
 * defaulted to "discovery" whether or not the pipeline had one; and an empty
 * Win % became 0. Now the account is searched (server side, 50 at a time,
 * archived left out) and required; the stage defaults to the pipeline's first
 * open stage; and an empty Win % takes that stage's default on the server.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Field, FormDialog } from "@/components/usip/Common";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

export type DialogStage = { id: string; label: string; isWon: boolean; isLost: boolean; defaultWinProb?: number | null };

/** The stage a new deal starts in: the pipeline's first open stage. */
export function firstOpenStage(stages: DialogStage[]): DialogStage | undefined {
  return stages.find((s) => !s.isWon && !s.isLost) ?? stages[0];
}

/** The create input from the form, or why it can't be sent. */
export function newOpportunityInput(
  f: { get(name: string): FormDataEntryValue | null },
  pipelineId: number | undefined,
): { ok: true; input: { name: string; accountId: number; value: number; stage: string; winProb?: number; pipelineId?: number; closeDate?: string } } | { ok: false; message: string } {
  const accountId = Number(f.get("accountId") ?? "");
  if (!Number.isInteger(accountId) || accountId <= 0) return { ok: false, message: "Choose the account this deal is with." };
  const stage = String(f.get("stage") ?? "");
  if (!stage) return { ok: false, message: "Choose a stage." };
  const wp = String(f.get("winProb") ?? "").trim();
  return {
    ok: true,
    input: {
      name: String(f.get("name") ?? "").trim(),
      accountId,
      value: Number(f.get("value") ?? 0),
      stage,
      // Empty means "the stage's default", which the server knows.
      winProb: wp === "" ? undefined : Number(wp),
      pipelineId,
      // A calendar date, "YYYY-MM-DD" (R16).
      closeDate: String(f.get("closeDate") ?? "") || undefined,
    },
  };
}

export function NewOpportunityDialog({ open, onOpenChange, stages, pipelineId, onCreated }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  stages: DialogStage[];
  pipelineId: number | undefined;
  onCreated?: (id: number) => void;
}) {
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim());
  const accounts = trpc.accounts.list.useQuery({ search: q || undefined, limit: 50 }, { enabled: open });
  const options = useMemo(() => (accounts.data ?? []).filter((a: any) => !a.archivedAt), [accounts.data]);
  const start = firstOpenStage(stages);
  const [stage, setStage] = useState<string | undefined>(undefined);
  const stageId = stage && stages.some((s) => s.id === stage) ? stage : start?.id;
  const stageDefault = stages.find((s) => s.id === stageId)?.defaultWinProb;

  const create = trpc.opportunities.create.useMutation({
    onSuccess: (r) => {
      utils.opportunities.board.invalidate();
      utils.opportunities.summary.invalidate();
      onOpenChange(false);
      setSearch("");
      setStage(undefined);
      toast.success("Opportunity created");
      onCreated?.(r.id);
    },
    onError: (e) => toast.error(e.message),
  });

  const noAccounts = !q && accounts.isSuccess && options.length === 0;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New opportunity"
      isPending={create.isPending}
      onSubmit={(f) => {
        const r = newOpportunityInput(f, pipelineId);
        if (!r.ok) { toast.error(r.message); return; }
        create.mutate(r.input);
      }}
    >
      <Field name="name" label="Name" required />
      <div className="space-y-1">
        <Label htmlFor="accountId">Account</Label>
        {noAccounts ? (
          <p className="text-sm text-muted-foreground">
            No companies yet. <Link href="/v2/companies" className="underline">Add a company</Link> first; a deal is always with one.
          </p>
        ) : (
          <>
            <Input aria-label="Search accounts" placeholder="Search accounts…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select id="accountId" name="accountId" required className="w-full text-sm rounded-md border bg-background px-3 py-2 h-10" defaultValue="">
              <option value="" disabled>{accounts.isLoading ? "Loading…" : options.length === 0 ? "No match" : "Choose an account…"}</option>
              {options.map((a: any) => <option key={a.id} value={String(a.id)}>{a.name}{a.domain ? ` (${a.domain})` : ""}</option>)}
            </select>
          </>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field name="value" label="Value ($)" type="money" required defaultValue={10000} />
        <div className="space-y-1">
          <Label htmlFor="stage">Stage</Label>
          <select id="stage" name="stage" value={stageId ?? ""} onChange={(e) => setStage(e.target.value)} className="w-full text-sm rounded-md border bg-background px-3 py-2 h-10">
            {stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <Field name="winProb" label="Win %" type="number" min={0} max={100}
          placeholder={stageDefault != null ? `${stageDefault} (stage default)` : "Stage default"} />
      </div>
      <Field name="closeDate" label="Expected close date" type="date" />
    </FormDialog>
  );
}
