/**
 * helpText.ts — the ONE place hover-help copy lives.
 *
 * Written because the person who commissioned this app said, plainly, that he
 * did not know how to use it. Fifty-five help articles already existed; the
 * problem was never the volume of documentation, it was that none of it was
 * where the confusion happens. This registry puts a sentence under the cursor.
 *
 * Two rules, both learned the hard way elsewhere in this codebase:
 *
 *  1. **Copy lives here, not inline at the call site.** Scattered strings go
 *     stale invisibly — the same failure as tour targets drifting from their
 *     `data-tour-id`s. One registry can be audited in one read.
 *  2. **Say what it is FOR and what it DOES, not what it is called.** "Segments:
 *     saved filters over your contacts" teaches; "Segments page" does not. If a
 *     tip only restates the label, delete it — a tooltip that says nothing
 *     trains people to stop reading tooltips.
 *
 * Keep every entry to one or two sentences. Anything longer belongs in a help
 * article, which is what `article` links to.
 */

export interface HelpEntry {
  /** One or two sentences. What it's for, in the user's language. */
  body: string;
  /** Optional help-article slug for "Learn more" (see seedHelpContent.ts). */
  article?: string;
}

/**
 * Sidebar navigation, keyed by href — `renderNavLink` in Shell.tsx is a single
 * choke point, so every item is covered from this one map.
 *
 * Ordered to mirror the sidebar so a reader can diff the two by eye.
 */
export const NAV_HELP: Record<string, HelpEntry> = {
  // ── Overview ──
  "/v2/home": { body: "Your starting point: what needs attention today, and how the pipeline moved this week.", article: "navigating-the-app" },
  "/v2/library": { body: "Every tool in the product, grouped and searchable. The sidebar shows only the daily loop — anything you can't find lives here (or press Ctrl+K)." },
  "/v2/ai-assistant": { body: "Ask questions about your own data in plain English — \"which deals slipped this month?\" — and have it propose actions (enroll, tasks, lists, enrich, pause/activate or create a campaign) that run only when you confirm.", article: "ai-assistant" },
  "/inbox": { body: "Notifications from the autonomous engines: what they did, and anything waiting on your approval." },
  "/mailbox": { body: "Your connected email inbox, inside Velocity. Replies from prospects land here." },
  "/calendar": { body: "Your meetings, including any the AI booked for you." },

  // ── Prospect and enrich ──
  "/v2/people": { body: "Every person you've imported or sourced. The contact database the rest of the app draws on.", article: "leads-contacts-accounts" },
  "/v2/companies": { body: "The organisations behind your contacts, with the enrichment data found for each.", article: "leads-contacts-accounts" },
  "/v2/lists": { body: "Hand-picked groups of contacts you want to work as a set." },
  "/v2/saved-people": { body: "People you saved from a prospect search, before deciding whether to work them." },
  "/v2/saved-companies": { body: "Companies you saved from a search, ready to pull contacts from." },
  // Re-keyed 2026-08-21: Find Prospects folded into Data Enrichment's tab;
  // navHelpFor matches EXACTLY, so the key must be the registry tool's href.
  "/v2/data-enrichment?tab=find-prospects": { body: "Search for new people who match your ideal customer, and add them to the queue.", article: "find-prospects-discovery" },
  "/v2/data-enrichment": { body: "Fill in missing details — company, job title, email — on contacts you already have.", article: "how-email-finding-works" },
  "/data-health": { body: "What's missing or wrong across your data, and what that's costing you in reach." },
  "/import": { body: "Bring contacts in from a CSV file.", article: "import-prospects-csv" },
  "/leads": { body: "Inbound people who haven't been qualified yet — from the chat agent, booking pages and forms.", article: "leads-contacts-accounts" },

  // ── Engage ──
  "/v2/sequences": { body: "Multi-step email follow-ups that run on a schedule so you don't have to chase manually.", article: "build-a-sequence" },
  "/campaigns": { body: "Outbound sending campaigns, with their own audience and sending accounts.", article: "are-tuning-campaign" },
  "/segments": { body: "Saved filters over your contacts that stay up to date as data changes." },
  "/sending-accounts": { body: "The mailboxes and services that actually send your email, with per-account daily limits.", article: "email-sending-preferences" },
  "/email-builder": { body: "Design reusable email templates and snippets.", article: "email-builder-templates" },
  "/unified-inbox": { body: "Every reply across all your sending accounts in one thread list.", article: "unified-inbox" },
  "/v2/emails": { body: "Every email sitewide — campaign and sequence steps, CRM sends, Inbox mail, proposals, system notifications and inbound replies — with what it was part of and what came back.", article: "email-drafts-sending" },
  "/v2/calls": { body: "Call logs and outcomes, including AI voice-agent calls.", article: "calls-page" },
  "/v2/tasks": { body: "Your to-do queue. AI-proposed tasks land here for approval before they become real work.", article: "autonomy-control-center" },
  "/social": { body: "LinkedIn outreach — connection requests, messages and replies.", article: "linkedin-social-outreach" },

  // ── Inbound (no outbound send required) ──
  "/v2/chat": { body: "The AI chat agent on your website. It qualifies visitors and can book meetings on its own, with no email sent.", article: "website-chat-agent" },
  "/v2/landing-pages": { body: "Public pages you host to capture leads.", article: "landing-pages-web-forms" },

  // ── Autonomy ──
  "/v2/workflows": { body: "One screen showing every autonomous feature and whether it's Off, asking your approval, or running on its own.", article: "autonomy-control-center" },
  "/are": { body: "The Autonomous Revenue Engine: it sources prospects, writes to them and books meetings with minimal input.", article: "are-overview" },
  "/are/performance": { body: "What's actually working — reply and meeting rates by sequence step and by prospect source.", article: "are-overview" },

  // ── Customers ──
  // NOTE ON KEYS: these must be the href the SIDEBAR renders, because
  // navHelpFor() is only called from renderNavLink in Shell.tsx and matches
  // exactly. "/v2/customers" and "/v2/renewals" were authored with a /v2/
  // prefix the sidebar does not use, so the copy existed, the links existed,
  // and the two never met — the tip could not appear on either page.
  // /v2/pipeline and /v2/opportunities below have NO sidebar link at all (both
  // are reached via a SubNav), so those entries are inert. Kept because the
  // copy is good and costs nothing; do not assume they display.
  "/v2/pipeline": { body: "Your deals, by stage.", article: "managing-pipeline" },
  "/v2/opportunities": { body: "Individual deals with their value, stage and history.", article: "opportunities-deep-dive" },
  "/v2/meetings": { body: "Booked meetings and the AI's meeting preparation.", article: "meeting-autopilot-reminders" },
  "/customers": { body: "Accounts that have already bought, with health scores and renewal dates." },
  "/renewals": { body: "Contracts coming up for renewal, and which are at risk of churning." },
  "/qbrs": { body: "Quarterly business reviews: the AI drafts the prep, you run the meeting." },

  "/v2/deals": { body: "Open deals and what stage each is at.", article: "managing-pipeline" },
  "/v2/conversations": { body: "Ongoing back-and-forth with prospects, and the AI's suggested replies.", article: "conversations-autopilot" },
  "/pipeline-alerts": { body: "Warnings about deals going quiet or slipping their close date." },
  "/proposals": { body: "Quotes and proposals you've sent, and whether they've been opened." },
  "/products": { body: "Your product and pricing catalogue, used when building a quote." },

  // ── Automation and analytics ──
  "/ai-pipeline": { body: "What the AI engines have queued, are working on, and have finished." },
  "/brand-voice": { body: "How the AI should sound when it writes as you. Every AI-written email and chat reply reads from this." },
  "/personas": { body: "The types of buyer you sell to. Used to tailor messaging and to score fit." },
  "/workflows": { body: "If-this-then-that rules over CRM events — e.g. when a prospect changes job, start a sequence.", article: "workflow-rules" },
  "/lead-scoring": { body: "The rules that decide a lead's 0-100 score, so the best ones surface first.", article: "understanding-scores-badges" },
  "/lead-routing": { body: "Who a new lead gets assigned to, and on what basis." },
  "/v2/analytics": { body: "Trends over time — sending volume, reply rates, pipeline created." },
  "/reports": { body: "Build your own report over any records in the system.", article: "reports-builder" },
  "/dashboards": { body: "Saved charts and numbers you want to check regularly." },
  "/mindmaps": { body: "Visual account maps — who reports to whom inside a target company." },

  // ── Inbound ──
  "/v2/website-visitors": { body: "Companies that visited your site, identified where possible, before anyone fills a form." },
  "/v2/forms": { body: "Embeddable forms that create a lead when someone submits them.", article: "landing-pages-web-forms" },

  // ── Support ──
  "/v2/deliverability": { body: "Whether your email is reaching inboxes rather than spam folders.", article: "mailbox-warmup" },
  "/help": { body: "Guides and walkthroughs. Start here if you're unsure where to begin.", article: "welcome-to-velocity" },
  "/settings": { body: "Workspace setup: mailboxes, sending, branding, team and data sources. Most one-time configuration lives here." },
};

/**
 * Inline field and control help, keyed by a stable id.
 *
 * The autonomy modes come first deliberately: Off / Approve / Auto is the single
 * concept this whole product is built on, it appears on a dozen screens, and it
 * is the one thing nobody guesses correctly the first time.
 */
export const FIELD_HELP: Record<string, HelpEntry> = {
  "autonomy.mode": {
    body: "How much this feature does without you. Off: nothing happens. Approve: it prepares the work and waits for your yes. Auto: it acts on its own and tells you afterwards.",
    article: "autonomy-control-center",
  },
  "autonomy.off": { body: "This feature does nothing at all. Safe default while you're still testing." },
  "autonomy.approval": { body: "The AI does the work but stops before anything leaves the building — you review it as a task first. The safest way to see what it WOULD do." },
  "autonomy.auto": { body: "The AI acts unattended and reports afterwards. Only turn this on once Approve mode has been producing work you'd have sent anyway." },

  "chat.qualifyThreshold": {
    body: "How convinced the agent must be before treating a visitor as a real prospect (0-100). Lower catches more meetings and more noise. Someone who explicitly asks for a meeting is offered one from 40 regardless.",
    article: "website-chat-agent",
  },
  "chat.knowledge": {
    body: "The only specifics the agent may state. Anything not written here it will say it doesn't know rather than guess — that's deliberate, and it's what stops it inventing things about your business.",
    article: "website-chat-agent",
  },
  "chat.followUp": {
    body: "When a visitor gives an email and then leaves without booking, write them one follow-up referencing what they actually said. Only conversations from the last 7 days, never more than once.",
    article: "website-chat-agent",
  },
  "chat.bookingUser": {
    body: "Whose calendar gets booked, and who owns any handoff task. Check that person's booking page has the right hours AND time zone — an unset zone means UTC, which offers US prospects 4am slots.",
    article: "booking-links",
  },

  "sending.dailyLimit": {
    body: "Most emails this mailbox may send in 24 hours. Keep it low on a new mailbox — sending too much too early is what gets an address flagged as spam.",
    article: "mailbox-warmup",
  },
  "sending.warmup": {
    body: "Gradually raises sending volume so mail providers learn to trust a new address. Worth doing before any real campaign.",
    article: "mailbox-warmup",
  },
  "sending.replyTo": {
    body: "Where replies go. It matters most for API senders like SendGrid, which have no inbox of their own — replies only reach you if this points at a mailbox you've connected.",
    article: "email-sending-preferences",
  },

  "score.fit": {
    body: "How well someone matches your ideal customer, 0-100. Derived from their title, company size and industry — not from how interested they've seemed.",
    article: "understanding-scores-badges",
  },
  "sequence.step.delay": {
    body: "How long to wait after the previous step before this one sends. Days, not hours — a same-day follow-up reads as automated.",
    article: "build-a-sequence",
  },
};

/** Look up nav help by href, tolerating a trailing slash. */
export function navHelpFor(href: string): HelpEntry | undefined {
  return NAV_HELP[href] ?? NAV_HELP[href.replace(/\/$/, "")];
}
