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
  "/v2/ai-assistant": { body: "Ask questions about your own data in plain English — \"which deals slipped this month?\" — instead of building a report.", article: "ask-the-ai-assistant" },
  "/inbox": { body: "Notifications from the autonomous engines: what they did, and anything waiting on your approval.", article: "your-inbox" },
  "/mailbox": { body: "Your connected email inbox, inside Velocity. Replies from prospects land here.", article: "your-mailbox" },
  "/calendar": { body: "Your meetings, including any the AI booked for you.", article: "your-calendar" },

  // ── Prospect and enrich ──
  "/v2/people": { body: "Every person you've imported or sourced. The contact database the rest of the app draws on.", article: "leads-contacts-accounts" },
  "/v2/companies": { body: "The organisations behind your contacts, with the enrichment data found for each.", article: "companies" },
  "/v2/lists": { body: "Hand-picked groups of contacts you want to work as a set.", article: "lists" },
  "/find-prospects": { body: "Search for new people who match your ideal customer, and add them to the queue.", article: "find-prospects-discovery" },
  "/v2/data-enrichment": { body: "Fill in missing details — company, job title, email — on contacts you already have.", article: "how-email-finding-works" },
  "/data-health": { body: "What's missing or wrong across your data, and what that's costing you in reach.", article: "data-health" },
  "/import": { body: "Bring contacts in from a CSV file.", article: "import-prospects-csv" },
  "/leads": { body: "Inbound people who haven't been qualified yet — from the chat agent, booking pages and forms.", article: "leads-contacts-accounts" },

  // ── Engage ──
  "/v2/sequences": { body: "Multi-step email follow-ups that run on a schedule so you don't have to chase manually.", article: "build-a-sequence" },
  "/campaigns": { body: "Outbound sending campaigns, with their own audience and sending accounts.", article: "are-tuning-campaign" },
  "/segments": { body: "Saved filters over your contacts that stay up to date as data changes.", article: "segments" },
  "/sending-accounts": { body: "The mailboxes and services that actually send your email, with per-account daily limits.", article: "email-sending-preferences" },
  "/email-builder": { body: "Design reusable email templates and snippets.", article: "email-builder-templates" },
  "/unified-inbox": { body: "Every reply across all your sending accounts in one thread list.", article: "unified-inbox" },
  "/v2/emails": { body: "Individual emails sent and drafted, including anything awaiting your approval.", article: "email-drafts-sending" },
  "/v2/calls": { body: "Call logs and outcomes, including AI voice-agent calls.", article: "calls-page" },
  "/v2/tasks": { body: "Your to-do queue. AI-proposed tasks land here for approval before they become real work.", article: "autopilots" },
  "/social": { body: "LinkedIn outreach — connection requests, messages and replies.", article: "linkedin-social-outreach" },

  // ── Inbound (no outbound send required) ──
  "/v2/chat": { body: "The AI chat agent on your website. It qualifies visitors and can book meetings on its own, with no email sent.", article: "website-chat-agent" },
  "/v2/landing-pages": { body: "Public pages you host to capture leads.", article: "landing-pages-web-forms" },

  // ── Autonomy ──
  "/v2/workflows": { body: "One screen showing every autonomous feature and whether it's Off, asking your approval, or running on its own.", article: "autonomy-control-center" },
  "/are": { body: "The Autonomous Revenue Engine: it sources prospects, writes to them and books meetings with minimal input.", article: "are-overview" },
  "/are/performance": { body: "What's actually working — reply and meeting rates by sequence step and by prospect source.", article: "are-overview" },

  // ── Customers ──
  "/v2/pipeline": { body: "Your deals, by stage.", article: "managing-pipeline" },
  "/v2/opportunities": { body: "Individual deals with their value, stage and history.", article: "opportunities-deep-dive" },
  "/v2/meetings": { body: "Booked meetings and the AI's meeting preparation.", article: "meetings-calls" },
  "/v2/customers": { body: "Accounts that have already bought.", article: "customers" },
  "/v2/renewals": { body: "Contracts coming up for renewal.", article: "renewals" },

  // ── Support ──
  "/v2/deliverability": { body: "Whether your email is reaching inboxes rather than spam folders.", article: "mailbox-warmup" },
  "/help": { body: "Guides and walkthroughs. Start here if you're unsure where to begin.", article: "getting-started" },
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
