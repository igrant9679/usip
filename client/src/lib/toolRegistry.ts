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
 *
 * GROUPS ARE THE PRODUCTS (owner, 2026-09-02). The previous groups were
 * feature types (Engage, Win deals, Autopilot & AI…), which is a large part
 * of why nothing felt like it belonged to anything. Velocity is seven
 * products — Prospecting, CRM, Outreach, Marketing, Proposals, Dialer,
 * Customer Success — plus Daily, Analytics and Configuration as the
 * cross-cutting groups. A page belongs to the product whose job it does,
 * not to the kind of widget it is.
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
  | "Prospecting"
  | "CRM"
  | "Outreach"
  | "Marketing"
  | "Proposals"
  | "Dialer"
  | "Customer Success"
  | "Analytics"
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
  "Prospecting",
  "CRM",
  "Outreach",
  "Marketing",
  "Proposals",
  "Dialer",
  "Customer Success",
  "Analytics",
  "Configuration",
];

export const TOOLS: Tool[] = [
  /* ── Daily — the loop: what needs me, what the machine did, where I act ── */
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
  { href: "/v2/workflows", label: "Autonomy Center", icon: Workflow, group: "Daily", primary: true,
    description: "Every Off / Approve / Auto dial in one place.", keywords: ["autopilot", "autonomy"] },

  /* ── Prospecting — find people, fill in what's missing, capture inbound ── */
  { href: "/v2/data-enrichment", label: "Data Enrichment", icon: Database, group: "Prospecting", primary: true,
    description: "Fill in missing emails, titles, and companies.", keywords: ["quickenrich", "linkedin", "prospect"] },
  { href: "/v2/data-enrichment?tab=find-prospects", label: "Find Prospects", icon: Radar, group: "Prospecting",
    description: "Source new prospects — a tab of Data Enrichment.", keywords: ["apollo", "search", "discovery", "scraper"] },
  // Folded into Data Enrichment (2026-08-21) — deliberately NOT primary, so
  // the rail shows one entry for the merged surface; Ctrl+K and the Library
  // still find "Import Contacts" by name and land on its tab.
  { href: "/v2/data-enrichment?tab=import-contacts", label: "Import Contacts", icon: Upload, group: "Prospecting",
    description: "Bring in a CSV of people or prospects.", keywords: ["csv", "upload"] },
  { href: "/data-health", label: "Data Health", icon: BarChart3, group: "Prospecting",
    description: "Duplicates, gaps, and import-mapping audits." },
  { href: "/v2/saved-people", label: "Saved People", icon: Users, group: "Prospecting",
    description: "People you bookmarked while sourcing." },
  { href: "/v2/saved-companies", label: "Saved Companies", icon: Building2, group: "Prospecting",
    description: "Companies you bookmarked while sourcing." },
  // Inbound capture is prospecting too — a visitor, a form fill, a chat is a
  // person arriving instead of a person found.
  { href: "/v2/website-visitors", label: "Website Visitors", icon: Globe, group: "Prospecting",
    description: "Companies identified on your site.", keywords: ["inbound"] },
  { href: "/v2/forms", label: "Forms", icon: FileText, group: "Prospecting",
    description: "Embeddable lead-capture forms.", keywords: ["inbound"] },
  { href: "/v2/landing-pages", label: "Landing Pages", icon: LayoutTemplate, group: "Prospecting", adminOnly: true,
    description: "Hosted pages with lead capture at /l/your-slug.", keywords: ["inbound"] },
  { href: "/v2/chat", label: "Chat Agents", icon: MessageSquare, group: "Prospecting", adminOnly: true,
    description: "AI chat widgets that qualify and book meetings.", keywords: ["inbound"] },

  /* ── CRM — the records, and the spine Prospect → Lead → Opportunity ─── */
  { href: "/v2/people", label: "People", icon: Users, group: "CRM", primary: true,
    description: "Every person record — search, filter, act.", keywords: ["contacts", "prospects"] },
  { href: "/v2/companies", label: "Companies", icon: Building2, group: "CRM", primary: true,
    description: "Every company record with its people and activity.", keywords: ["accounts"] },
  { href: "/leads", label: "Leads", icon: Target, group: "CRM", primary: true,
    description: "Scored, routable leads awaiting qualification." },
  { href: "/v2/deals", label: "Deals", icon: KanbanSquare, group: "CRM", primary: true,
    description: "Your pipeline board — every open opportunity.", keywords: ["pipeline", "opportunities"] },
  { href: "/v2/lists", label: "Lists", icon: ListChecks, group: "CRM",
    description: "Named sets of people or companies for targeting." },
  { href: "/v2/tasks", label: "Tasks", icon: ListChecks, group: "CRM",
    description: "Your to-dos, including AI-proposed drafts." },
  { href: "/pipeline-alerts", label: "Pipeline Alerts", icon: AlertTriangle, group: "CRM",
    description: "Stuck-deal and at-risk warnings (also shown on Deals)." },

  /* ── Outreach — 1:1, sequenced, per-person copy; replies and meetings ── */
  { href: "/are", label: "Revenue Engine", icon: Bot, group: "Outreach", primary: true,
    description: "The autonomous outbound engine: source → enrich → send → book.", keywords: ["are", "hub", "autonomous"] },
  { href: "/are/campaigns", label: "ARE Campaigns", icon: Megaphone, group: "Outreach",
    description: "The engine's campaigns — targeting, copy, funnel." },
  { href: "/v2/sequences", label: "Sequences", icon: Activity, group: "Outreach", primary: true,
    description: "Multi-step outreach flows with one fixed message per step." },
  { href: "/v2/emails", label: "Emails", icon: Mail, group: "Outreach", primary: true,
    description: "Every email in and out — sent, drafted, queued, replied.", keywords: ["drafts", "approve"] },
  { href: "/v2/conversations", label: "Conversations", icon: MessageSquare, group: "Outreach", primary: true,
    description: "Inbound replies that need a human answer." },
  { href: "/v2/meetings", label: "Meetings", icon: CalendarDays, group: "Outreach", primary: true,
    description: "Booked and proposed meetings; approve AI proposals.", keywords: ["demo"] },
  { href: "/unified-inbox", label: "Unified Inbox", icon: MessageSquare, group: "Outreach", primary: true,
    description: "LinkedIn, WhatsApp and social DMs in one place.", keywords: ["multichannel"] },
  { href: "/social", label: "Social", icon: Share2, group: "Outreach",
    description: "LinkedIn outreach: invites, DMs, and replies.", keywords: ["linkedin", "multichannel"] },
  // Two views of the same drafts table as Emails — kept reachable until the
  // Emails page absorbs them as saved filters.
  { href: "/ai-pipeline", label: "AI Pipeline", icon: Sparkles, group: "Outreach",
    description: "Approve or edit AI-written outreach before it sends (a filter of Emails).", keywords: ["approve", "queue", "drafts"] },
  { href: "/email-drafts", label: "Email Drafts", icon: FileText, group: "Outreach",
    description: "Review, edit, and send queued email drafts (a filter of Emails)." },

  /* ── Marketing — one message to a segment ────────────────────────────── */
  // Not on the rail: the Campaigns product does not send yet (Launch flips a
  // status; nothing dispatches). It comes back to the rail the day it sends.
  { href: "/campaigns", label: "Campaigns", icon: Megaphone, group: "Marketing",
    description: "Broadcast one message to a segment. Not yet sending — audiences and copy can be prepared.", keywords: ["broadcast", "bulk", "newsletter"] },
  { href: "/segments", label: "Segments", icon: Filter, group: "Marketing",
    description: "Saved audience filters for broadcasts." },
  { href: "/email-builder", label: "Email Builder", icon: LayoutTemplate, group: "Marketing",
    description: "Design reusable HTML email templates block by block.", keywords: ["templates"] },
  { href: "/snippets", label: "Snippets", icon: PenLine, group: "Marketing",
    description: "Reusable copy blocks: openers, CTAs, objection handlers." },

  /* ── Proposals — price it, propose it, sign it ───────────────────────── */
  { href: "/proposals", label: "Proposals", icon: ClipboardList, group: "Proposals", primary: true,
    description: "Client-facing proposals with e-sign and portal links." },
  { href: "/quotes", label: "Quotes", icon: DollarSign, group: "Proposals",
    description: "Priced quotes attached to deals." },
  { href: "/products", label: "Products", icon: Package, group: "Proposals",
    description: "Your sellable catalog, used by quotes and proposals." },

  /* ── Dialer — calls, human and AI ────────────────────────────────────── */
  { href: "/v2/calls", label: "Calls", icon: Phone, group: "Dialer", primary: true,
    description: "Call queue, outcomes, voice agents, and AI call summaries.", keywords: ["telemarketing", "dialer", "voice"] },

  /* ── Customer Success — after the close ──────────────────────────────── */
  { href: "/customers", label: "Customers", icon: Heart, group: "Customer Success", primary: true,
    description: "Won accounts — health, notes, and expansion.", keywords: ["customer success", "accounts"] },
  { href: "/renewals", label: "Renewals", icon: CalendarClock, group: "Customer Success",
    description: "Contract end dates and renewal risk." },
  { href: "/qbrs", label: "QBRs", icon: ClipboardCheck, group: "Customer Success",
    description: "Quarterly business review prep and history." },

  /* ── Analytics — cross-cutting ───────────────────────────────────────── */
  { href: "/v2/analytics", label: "Analytics", icon: BarChart3, group: "Analytics",
    description: "Cross-channel outreach and pipeline analytics — the one funnel." },
  { href: "/reports", label: "Reports", icon: FileText, group: "Analytics",
    description: "Row-level reports over any object, exportable." },
  { href: "/dashboards", label: "Dashboards", icon: PieChart, group: "Analytics",
    description: "Build your own CRM metric dashboards." },
  { href: "/email-analytics", label: "Email Analytics", icon: Mail, group: "Analytics",
    description: "Opens, clicks, replies, bounces by send." },
  { href: "/are/performance", label: "Engine Performance", icon: BarChart3, group: "Analytics",
    description: "What the engine sent, booked, and learned." },
  { href: "/forecast", label: "Forecast", icon: BarChart3, group: "Analytics",
    description: "Projected revenue from the open pipeline." },
  { href: "/mindmaps", label: "Mindmaps", icon: GitFork, group: "Analytics",
    description: "Freeform planning canvases." },

  /* ── Configuration — cross-cutting ───────────────────────────────────── */
  { href: "/v2/settings/profile", label: "Settings", icon: Settings, group: "Configuration",
    description: "Profile, workspace, integrations, billing — everything.", keywords: ["preferences", "api keys"] },
  { href: "/sending-accounts", label: "Sending Accounts", icon: Mail, group: "Configuration",
    description: "Mailboxes and API senders (SMTP, SendGrid) with caps.", keywords: ["sendgrid", "smtp"] },
  { href: "/sender-pools", label: "Sender Pools", icon: Network, group: "Configuration",
    description: "Rotate campaign sends across multiple senders." },
  { href: "/v2/deliverability", label: "Deliverability", icon: MailWarning, group: "Configuration",
    description: "Domain health, warmup, bounce and spam monitoring." },
  { href: "/email-suppressions", label: "Suppressions", icon: ShieldCheck, group: "Configuration",
    description: "Unsubscribes and do-not-contact addresses." },
  { href: "/connected-accounts", label: "Connected Accounts", icon: Plug, group: "Configuration",
    description: "OAuth links: mailboxes, calendars, LinkedIn." },
  { href: "/settings/linkedin-limits", label: "LinkedIn Limits", icon: Linkedin, group: "Configuration",
    description: "Per-account caps, pacing and working hours that keep LinkedIn accounts safe.",
    keywords: ["throttle", "rate limit", "invites", "ban", "restriction", "warmup"] },
  { href: "/lead-scoring", label: "Lead Scoring", icon: Target, group: "Configuration",
    description: "Tune the grade thresholds that rank leads." },
  { href: "/lead-routing", label: "Lead Routing", icon: Sparkles, group: "Configuration",
    description: "Assignment rules for new leads." },
  // How the AI writes and decides — configuration, not a daily surface.
  { href: "/brand-voice", label: "Brand Voice", icon: Mic2, group: "Configuration",
    description: "Teach the AI how your company sounds.", keywords: ["ai"] },
  { href: "/personas", label: "Personas", icon: Users, group: "Configuration",
    description: "Buyer personas the AI writes toward.", keywords: ["ai"] },
  { href: "/are/icp", label: "ICP Agent", icon: Target, group: "Configuration",
    description: "Define and refine your ideal customer profile.", keywords: ["ai", "targeting"] },
  { href: "/prompt-templates", label: "Prompt Templates", icon: FileText, group: "Configuration",
    description: "Versioned prompts behind the AI generators.", keywords: ["ai"] },
  { href: "/workflows", label: "Workflow Rules", icon: GitFork, group: "Configuration",
    description: "If-this-then-that automations on CRM events." },
  { href: "/custom-fields", label: "Custom Fields", icon: Database, group: "Configuration",
    description: "Add your own fields to CRM records." },
  { href: "/team", label: "Team", icon: Users, group: "Configuration",
    description: "Members, roles, and invitations." },
  { href: "/audit", label: "Audit Log", icon: Activity, group: "Configuration",
    description: "Who changed what, when." },
  { href: "/help", label: "Help Center", icon: HelpCircle, group: "Configuration",
    description: "Guides, articles, and product tours.", keywords: ["support"] },
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
