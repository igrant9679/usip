/**
 * One sub-navigation for the pages that decide who gets a lead and how it
 * ranks (audit 2026-10-20, P123: Lead Routing had one and Lead Scoring none).
 * Every page in the cluster renders the same list, its own entry included.
 */
export const LEAD_ASSIGNMENT_NAV = [
  { href: "/lead-scoring", label: "Lead Scoring", title: "The grade thresholds that rank leads — one workflow with routing" },
  { href: "/lead-routing", label: "Lead Routing", title: "Rules that assign each new lead to a rep" },
  { href: "/territories", label: "Territories", title: "Define territories used by routing rules (geo / industry / vertical)" },
];
