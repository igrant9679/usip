/**
 * toolRegistry — the ONE list of every destination in the product.
 *
 * Three surfaces render from this registry and may not maintain their own
 * copies (that is how the app ended up with two nav systems and 44 rail
 * items nobody could hold in their head):
 *   - the sidebar rail (only entries flagged `primary`)
 *   - the Library page (everything, grouped, searchable)
 *   - the Cmd+K command palette (everything, fuzzy-searched)
 *
 * `primary` is a budget, not an honor: the rail exists for the daily loop
 * (what needs me → what did the machine do → the handful of places I act).
 * Everything else is one keystroke away in the palette and one click away
 * in the Library — demoted, not deleted.
 */
import type { LucideIcon } from "lucide-react";
import {
  Activity, AlertTriangle, BarChart3, Bot, Building2, CalendarClock,
  CalendarDays, ClipboardCheck, ClipboardList, Database, DollarSign, FileText,
  Filter, GitFork, Globe, Heart, HelpCircle, Home, Inbox, KanbanSquare,
  LayoutTemplate, Linkedin, ListChecks, Mail, MailOpen, MailWarning, Megaphone,
  MessageSquare, Mic2, Network, Package, PenLine, Phone, PieChart, Plug,
  Radar, Search, Send, Settings, Share2, ShieldCheck, Sparkles, Target,
  Upload, Users, Workflow, Wrench,
} from "lucide-react";

export type ToolGroup =
  | "Daily"
  | "CRM"
  | "Prospect & enrich"
  | "Engage"
  | "Win deals"
  | "Customer success"
  | "Autopilot & AI"
  | "Analytics & reporting"
  | "Inbound"
  | "Configuration";

export interface Tool {
  href: string;
  label: string;
  icon: LucideIcon;
  group: ToolGroup;
  /** One-line answer to "when do I come here?" — shown on Library cards. */
  description: string;
  /** Extra search terms for the palette (synonyms, old names). */
  keywords?: string[];
  adminOnly?: boolean;
  /** Appears in the sidebar rail. Keep this list SHORT — it is the budget. */
  primary?: boolean;
}

export const TOOL_GROUPS: ToolGroup[] = [
  "Daily",
  "CRM",
  "Prospect & enrich",
  "Engage",
  "Win deals",
  "Customer success",
  "Autopilot & AI",
  "Analytics & reporting",
  "Inbound",
  "Configuration",
];

export const TOOLS: Tool[] = [
  /* ── Daily ─────────────────────────────────────────────────────────── */
  { href: "/v2/home", label: "Home", icon: Home, group: "Daily", primary: true,
    description: "What needs you, what the autopilots did, and today's numbers." },
  { href: "/v2/ai-assistant", label: "AI Assistant", icon: Sparkles, group: "Daily", primary: true,
    description: "Ask anything about your pipeline in plain language." },
  { href: "/inbox", label: "Inbox", icon: Inbox, group: "Daily", primary: true,
    description: "Your in-app notifications and events.", keywords: ["notifications"] },
  { href: "/mailbox", label: "My Mailbox", icon: MailOpen, group: "Daily", primary: true,
    description: "Read and answer your connected email account.", keywords: ["email", "compose"] },
  { href: "/calendar", label: "My Calendar", icon: CalendarDays, group: "Daily", primary: true,
    description: "Your schedule, synced with your calendar provider." },

  /* ── CRM — the records themselves ──────────────────────────────────── */
  { href: "/v2/people", label: "People", icon: Users, group: "CRM", primary: true,
    description: "Every person record — search, filter, act.", keywords: ["contacts", "prospects"] },
  { href: "/v2/companies", label: "Companies", icon: Building2, group: "CRM", primary: true,
    description: "Every company record with its people and activity.", keywords: ["accounts"] },
  { href: "/v2/deals", label: "Deals", icon: KanbanSquare, group: "CRM", primary: true,
    description: "Your pipeline board — every open opportunity.", keywords: ["pipeline", "opportunities"] },
  { href: "/leads", label: "Leads", icon: Target, group: "CRM", primary: true,
    description: "Scored, routable leads awaiting qualification." },
  { href: "/v2/lists", label: "Lists", icon: ListChecks, group: "CRM",
    description: "Named sets of people or companies for targeting." },
  { href: "/v2/tasks", label: "Tasks", icon: ListChecks, group: "CRM",
    description: "Your to-dos, including AI-proposed drafts." },
  { href: "/v2/calls", label: "Calls", icon: Phone, group: "CRM",
    description: "Call logs, outcomes, and AI call summaries." },
  { href: "/import", label: "Import Contacts", icon: Upload, group: "CRM", primary: true,
    description: "Bring in a CSV of people or prospects.", keywords: ["csv", "upload"] },
  { href: "/customers", label: "Customers", icon: Heart, group: "CRM", primary: true,
    description: "Won accounts — health, notes, and expansion.", keywords: ["customer success", "accounts"] },

  /* ── Prospect & enrich ─────────────────────────────────────────────── */
  // Folded into Data Enrichment (2026-08-21) — the entry stays so Ctrl+K /
  // Library still find it by name; the href is the tab's canonical URL.
  { href: "/v2/data-enrichment?tab=find-prospects", label: "Find Prospects", icon: Radar, group: "Prospect & enrich", primary: true,
    description: "Source new prospects — a tab of Data Enrichment.", keywords: ["apollo", "search", "discovery"] },
  { href: "/v2/data-enrichment", label: "Data Enrichment", icon: Database, group: "Prospect & enrich", primary: true,
    description: "Fill in missing emails, titles, and companies.", keywords: ["quickenrich", "linkedin"] },
  { href: "/data-health", label: "Data Health", icon: BarChart3, group: "Prospect & enrich",
    description: "Duplicates, gaps, and import-mapping audits." },
  { href: "/v2/saved-people", label: "Saved People", icon: Users, group: "Prospect & enrich",
    description: "People you bookmarked while sourcing." },
  { href: "/v2/saved-companies", label: "Saved Companies", icon: Building2, group: "Prospect & enrich",
    description: "Companies you bookmarked while sourcing." },

  /* ── Engage ────────────────────────────────────────────────────────── */
  { href: "/v2/sequences", label: "Sequences", icon: Activity, group: "Engage", primary: true,
    description: "Multi-step outreach flows: emails, calls, LinkedIn." },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone, group: "Engage", primary: true,
    description: "Bulk sends to a segment with a chosen sender." },
  { href: "/v2/emails", label: "Emails", icon: Mail, group: "Engage", primary: true,
    description: "Outbound email activity and drafts in one stream." },
  { href: "/unified-inbox", label: "Unified Inbox", icon: MessageSquare, group: "Engage", primary: true,
    description: "LinkedIn, WhatsApp and social DMs in one place." },
  { href: "/social", label: "Social", icon: Share2, group: "Engage",
    description: "LinkedIn outreach: invites, DMs, and replies.", keywords: ["linkedin"] },
  { href: "/email-builder", label: "Email Builder", icon: LayoutTemplate, group: "Engage",
    description: "Design reusable HTML email templates block by block.", keywords: ["templates"] },
  { href: "/segments", label: "Segments", icon: Filter, group: "Engage",
    description: "Saved audience filters that power campaigns." },
  { href: "/snippets", label: "Snippets", icon: PenLine, group: "Engage",
    description: "Reusable copy blocks: openers, CTAs, objection handlers." },
  { href: "/email-drafts", label: "Email Drafts", icon: FileText, group: "Engage",
    description: "Review, edit, and send queued email drafts." },

  /* ── Win deals ─────────────────────────────────────────────────────── */
  { href: "/v2/meetings", label: "Meetings", icon: CalendarDays, group: "Win deals", primary: true,
    description: "Booked and proposed meetings; approve AI proposals.", keywords: ["demo"] },
  { href: "/v2/conversations", label: "Conversations", icon: MessageSquare, group: "Win deals", primary: true,
    description: "Inbound replies that need a human answer." },
  { href: "/pipeline-alerts", label: "Pipeline Alerts", icon: AlertTriangle, group: "Win deals",
    description: "Stuck-deal and at-risk warnings." },
  { href: "/proposals", label: "Proposals", icon: ClipboardList, group: "Win deals",
    description: "Client-facing proposals with e-sign and portal links." },
  { href: "/quotes", label: "Quotes", icon: DollarSign, group: "Win deals",
    description: "Priced quotes attached to deals." },
  { href: "/products", label: "Products", icon: Package, group: "Win deals",
    description: "Your sellable catalog, used by quotes and proposals." },
  { href: "/forecast", label: "Forecast", icon: BarChart3, group: "Win deals",
    description: "Projected revenue from the open pipeline." },

  /* ── Customer success ──────────────────────────────────────────────── */
  { href: "/renewals", label: "Renewals", icon: CalendarClock, group: "Customer success",
    description: "Contract end dates and renewal risk." },
  { href: "/qbrs", label: "QBRs", icon: ClipboardCheck, group: "Customer success",
    description: "Quarterly business review prep and history." },

  /* ── Autopilot & AI ────────────────────────────────────────────────── */
  { href: "/are", label: "Revenue Engine", icon: Bot, group: "Autopilot & AI", primary: true,
    description: "The autonomous outbound engine: source → enrich → send → book.", keywords: ["are", "hub", "autonomous"] },
  { href: "/v2/workflows", label: "Autonomy Center", icon: Workflow, group: "Autopilot & AI", primary: true,
    description: "Every Off / Approve / Auto dial in one place.", keywords: ["autopilot", "autonomy"] },
  { href: "/ai-pipeline", label: "AI Pipeline", icon: Sparkles, group: "Autopilot & AI", primary: true,
    description: "Approve or edit AI-written outreach before it sends.", keywords: ["approve", "queue", "drafts"] },
  { href: "/are/campaigns", label: "ARE Campaigns", icon: Megaphone, group: "Autopilot & AI",
    description: "The engine's campaigns — targeting, copy, funnel." },
  { href: "/are/icp", label: "ICP Agent", icon: Target, group: "Autopilot & AI",
    description: "Define and refine your ideal customer profile." },
  { href: "/are/performance", label: "Engine Performance", icon: BarChart3, group: "Autopilot & AI",
    description: "What the engine sent, booked, and learned." },
  { href: "/brand-voice", label: "Brand Voice", icon: Mic2, group: "Autopilot & AI",
    description: "Teach the AI how your company sounds." },
  { href: "/personas", label: "Personas", icon: Users, group: "Autopilot & AI",
    description: "Buyer personas the AI writes toward." },
  { href: "/workflows", label: "Workflow Rules", icon: GitFork, group: "Autopilot & AI",
    description: "If-this-then-that automations on CRM events." },
  { href: "/prompt-templates", label: "Prompt Templates", icon: FileText, group: "Autopilot & AI",
    description: "Versioned prompts behind the AI generators." },

  /* ── Analytics & reporting ─────────────────────────────────────────── */
  { href: "/v2/analytics", label: "Analytics", icon: BarChart3, group: "Analytics & reporting",
    description: "Cross-channel outreach and pipeline analytics." },
  { href: "/reports", label: "Reports", icon: FileText, group: "Analytics & reporting",
    description: "Scheduled and one-off reports, emailed to you." },
  { href: "/dashboards", label: "Dashboards", icon: PieChart, group: "Analytics & reporting",
    description: "Build your own metric dashboards." },
  { href: "/email-analytics", label: "Email Analytics", icon: Mail, group: "Analytics & reporting",
    description: "Opens, clicks, replies, bounces by send." },
  { href: "/mindmaps", label: "Mindmaps", icon: GitFork, group: "Analytics & reporting",
    description: "Freeform planning canvases." },

  /* ── Inbound ───────────────────────────────────────────────────────── */
  { href: "/v2/website-visitors", label: "Website Visitors", icon: Globe, group: "Inbound",
    description: "Companies identified on your site." },
  { href: "/v2/forms", label: "Forms", icon: FileText, group: "Inbound",
    description: "Embeddable lead-capture forms." },
  { href: "/v2/landing-pages", label: "Landing Pages", icon: LayoutTemplate, group: "Inbound", adminOnly: true,
    description: "Hosted pages with lead capture at /l/your-slug." },
  { href: "/v2/chat", label: "Chat Agents", icon: MessageSquare, group: "Inbound", adminOnly: true,
    description: "AI chat widgets that qualify and book meetings." },

  /* ── Configuration ─────────────────────────────────────────────────── */
  { href: "/v2/settings/profile", label: "Settings", icon: Settings, group: "Configuration",
    description: "Profile, workspace, integrations, billing — everything.", keywords: ["preferences", "api keys"] },
  { href: "/sending-accounts", label: "Sending Accounts", icon: Mail, group: "Configuration",
    description: "Mailboxes and API senders (SMTP, SendGrid) with caps.", keywords: ["sendgrid", "smtp"] },
  { href: "/sender-pools", label: "Sender Pools", icon: Network, group: "Configuration",
    description: "Rotate campaign sends across multiple senders." },
  { href: "/settings/linkedin-limits", label: "LinkedIn Limits", icon: Linkedin, group: "Configuration",
    description: "Per-account caps, pacing and working hours that keep LinkedIn accounts safe.",
    keywords: ["throttle", "rate limit", "invites", "ban", "restriction", "warmup"] },
  { href: "/v2/deliverability", label: "Deliverability", icon: MailWarning, group: "Configuration",
    description: "Domain health, warmup, bounce and spam monitoring." },
  { href: "/email-suppressions", label: "Suppressions", icon: ShieldCheck, group: "Configuration",
    description: "Unsubscribes and do-not-contact addresses." },
  { href: "/lead-scoring", label: "Lead Scoring", icon: Target, group: "Configuration",
    description: "Tune the grade thresholds that rank leads." },
  { href: "/lead-routing", label: "Lead Routing", icon: Sparkles, group: "Configuration",
    description: "Assignment rules for new leads." },
  { href: "/custom-fields", label: "Custom Fields", icon: Database, group: "Configuration",
    description: "Add your own fields to CRM records." },
  { href: "/team", label: "Team", icon: Users, group: "Configuration",
    description: "Members, roles, and invitations." },
  { href: "/audit", label: "Audit Log", icon: Activity, group: "Configuration",
    description: "Who changed what, when." },
  { href: "/connected-accounts", label: "Connected Accounts", icon: Plug, group: "Configuration",
    description: "OAuth links: mailboxes, calendars, LinkedIn." },
  { href: "/help", label: "Help Center", icon: HelpCircle, group: "Configuration",
    description: "Guides, articles, and product tours." },
];

/** Rail entries, in registry order. */
export const PRIMARY_TOOLS: Tool[] = TOOLS.filter((t) => t.primary);

/** Palette/Library search: label, keywords, group, description all match. */
export function searchTools(query: string, opts?: { isAdmin?: boolean }): Tool[] {
  const q = query.trim().toLowerCase();
  const pool = TOOLS.filter((t) => !t.adminOnly || opts?.isAdmin);
  if (!q) return pool;
  return pool.filter((t) =>
    t.label.toLowerCase().includes(q) ||
    t.group.toLowerCase().includes(q) ||
    t.description.toLowerCase().includes(q) ||
    (t.keywords ?? []).some((k) => k.toLowerCase().includes(q)),
  );
}
