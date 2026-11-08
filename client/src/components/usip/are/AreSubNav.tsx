/**
 * The Revenue Engine's sub-nav, the same on each of its pages (audit
 * 2026-10-20, A76). The hub, What's Working and the campaign list each built
 * their own, with different items in a different order, and the hub's had no
 * way back to itself. The ICP Agent keeps the Research sub-nav: it is the ICP
 * page of Research, linked from here.
 */
import { SubNav } from "@/components/usip/Shell";

export const ARE_SUB_NAV = [
  { href: "/are", label: "Hub", title: "Revenue Engine command centre" },
  { href: "/are/campaigns", label: "Campaigns", title: "All Revenue Engine campaigns" },
  { href: "/are/approvals", label: "Approvals", title: "Every prospect waiting for a decision, across campaigns" },
  { href: "/are/performance", label: "What's Working", title: "Measured performance — which steps and sources actually book meetings" },
  { href: "/are/icp", label: "ICP Agent", title: "The Ideal Customer Profile the engine scores against" },
  { href: "/are/settings", label: "ARE Settings", title: "Revenue Engine defaults, caps and sources" },
];

export function AreSubNav() {
  return <SubNav items={ARE_SUB_NAV} />;
}
