/**
 * The workspace's currency, shown consistently (audit 2026-10-20, F29/R41).
 *
 * Every amount on screen goes through formatAmount (@shared/money) — directly,
 * or through Common's fmt$ — with no currency named, so setting the display
 * default once here moves them all. Mounted in AuthGate beside the branding
 * sync, above the Shell/no-Shell split. The subtree is keyed on the currency,
 * so when an admin changes it every screen redraws in the new one; while it
 * is USD (every workspace until someone chooses) the key never changes and
 * nothing remounts.
 */
import { Fragment, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { setDisplayCurrency } from "@shared/money";
import { DEFAULT_WORKSPACE_CURRENCY } from "@shared/revenueSettings";

export function useRevenueSettings() {
  return trpc.settings.revenue.useQuery(undefined, { staleTime: 5 * 60_000, retry: false });
}

export function WorkspaceCurrencySync({ children }: { children: ReactNode }) {
  const { data } = useRevenueSettings();
  const currency = data?.currency ?? DEFAULT_WORKSPACE_CURRENCY;
  // Set during render, before the children format anything.
  setDisplayCurrency(currency);
  return <Fragment key={currency}>{children}</Fragment>;
}
