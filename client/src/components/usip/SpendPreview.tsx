/**
 * Spend said before it happens (audit 2026-10-20, F8, U16).
 *
 *   SourceBudgetLine   under a discovery launcher's button: each paid source's
 *                      allowance left today and the AI calls the run can make
 *   confirmPaidLookup  the confirmation every paid lookup asks first: how many,
 *                      in the vendor's unit, and what is left today
 *
 * Numbers come from spend.budgets, which reads the caps and ledgers the
 * sources enforce; the sentences come from @shared/spendPreview.
 */
import { trpc } from "@/lib/trpc";
import { confirmAction } from "@/components/usip/Common";
import { launcherBudgetLine, paidLookupText, type Allowance } from "@shared/spendPreview";

export function useSourceBudgets() {
  return trpc.spend.budgets.useQuery(undefined, { staleTime: 30_000, retry: false });
}

/** "Apollo: 120 of 500 left today · LinkedIn: 80 of 100 lookups left today · up to 1 AI call". */
export function SourceBudgetLine({ sources }: { sources: readonly string[] }) {
  const q = useSourceBudgets();
  const line = launcherBudgetLine(sources, q.data);
  if (!line) return null;
  return <div className="text-[11px] text-muted-foreground">Before you run: {line}</div>;
}

/**
 * Ask before spending: "Verify 40 addresses? This spends up to 40 Reoon
 * credits. 310 of today's 500 are left." Runs `onConfirm` only on yes.
 */
export function confirmPaidLookup(
  opts: { title: string; vendor: string; count: number; unit: string; perItem?: number; allowance?: Allowance; note?: string; confirmLabel?: string },
  onConfirm: () => void,
) {
  confirmAction({
    title: opts.title,
    description: paidLookupText(opts),
    confirmLabel: opts.confirmLabel ?? "Spend and run",
  }, onConfirm);
}
