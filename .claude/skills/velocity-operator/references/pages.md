# Velocity page directory — every page, what it is for, how to use it

Organised the way the sidebar rail and the Library (`/v2/library`, Ctrl+K) organise it. `★` = on the sidebar rail. `[admin]` = admin-only. Hover any rail item in the app for its one-line help; the `?` in the top bar opens the Help drawer for the current page.

Table of contents: Daily · Prospecting · CRM · Outreach · Marketing · Proposals · Dialer · Customer Success · Analytics · Configuration · Public pages.

---

## Daily

### ★ Home — `/v2/home`
The first stop every day. Three things:
1. **Attention panel** — the single aggregator of everything waiting on a human (`attention.summary`): AI drafts, engine approvals by campaign, unhandled replies, proposed meetings, draft tasks, paused campaigns, sequence drafts, social replies, optimisation recommendations, chat follow-ups, routing suggestions, campaign proposals. `totalNeedingYou` is the sum. Empty panel = the machines are handling it.
2. **24-hour digest** — emails sent, prospects discovered, replies received, meetings booked.
3. **What the autopilots did** — the recent engine and autopilot events.
Work it top to bottom; each row links to the queue it came from.

### ★ Dashboard — `/dashboard`
Pipeline at a glance: revenue by period, win/loss, stage funnel, top reps, recent deals. Read-only. Good for a manager's Monday glance; `/dashboards` is where custom boards live.

### ★ AI Assistant — `/v2/ai-assistant`
The conversational operator, reachable from every page (top-bar sparkles button or **Ctrl+J** opens a drawer; this path is the full page; one conversation follows the user across pages). It looks things up (people, companies, sequences, lists, campaigns, pipeline, attention panel, read-only queries over every core table), runs and saves reports, recommends with the numbers behind it, asks a focused question with option buttons when a decision changes the outcome, and walks through what it does. It can **propose** almost any app action: purpose-built tools (enroll, tasks, lists, batches by criteria into campaigns/sequences/lists, create sequence, draft campaign, queue/log calls, propose meetings, enrich, update/archive people, pin a brand) plus a generic catalog of every allowlisted tRPC mutation (`list_actions` → `run_action`); up to three proposals per turn, each a confirm card. Reads execute immediately. Sends only from the approval queues (send approved drafts, approve-and-send proposed meetings; the card says "Sends email now"); never composes-and-sends email or LinkedIn messages, never places calls, never deletes, never touches team/credentials/billing/workspace settings.

### ★ Inbox — `/inbox`
In-app notifications: mentions, task assigned/due, deal won/lost, renewal due, churn risk, approval requests, workflow fired, email replies, engine events, system. Per user. Mark read as you go; unread count shows on the rail.

### ★ My Mailbox — `/mailbox`
Your connected email account read inside Velocity. Prospect replies land here and in Conversations. Send one-off mail from a record instead of from here when you want it logged against the record.

### ★ My Calendar — `/calendar`
Your schedule synced from your calendar provider (Microsoft 365 via Connected Accounts). Meetings the AI booked appear here. Prep notes live on the Meeting record, not the calendar event.

### ★ Autonomy Center — `/v2/workflows`
Every Off / Approve / Auto dial on one screen: Task, Meeting, Conversation, Deal, Social, Job change, Chat agent, Chat follow-up, Enrichment sweep, Company backfill, Campaign routing, Optimisation, Email AI auto-send. "All: Approve" and "All: Off" act on every dial. Also shows AI-proposed workflow rules to adopt. Admin-only to change. See `automation.md`.

---

## Prospecting

### ★ Data Enrichment — `/v2/data-enrichment`
Hub with tabs:
- **Enrich** — fill missing emails, titles, companies on people you have. Select on People → **Enrich ▾ → Enrich fully (all sources)**. Sources reconcile field by field with a provenance ledger.
- **Find Prospects** (`?tab=find-prospects`) — search new people by role and company shape (QuickEnrich, Apollo search-only, LinkedIn); results go to People or a list.
- **Import Contacts** (`?tab=import-contacts`) — CSV in. Mapping is exact-match on headers, refuses two columns to one field, enforces required fields per destination (People / Leads / Contacts). Bad files fail at mapping time.
- **Data Health** (`?tab=data-health-center`) — duplicates, gaps, import-mapping audits, what missing data costs in reach.
- The **Enrichment sweep** and **Company backfill** cards: backlog email-finding (Reoon credits) and LinkedIn company backfill (~100 lookups/day), each with its own dial and daily cap.

### Saved People / Saved Companies — `/v2/lists?type=people|companies`
Bookmarks from sourcing, before deciding whether to work them. Same page as Lists with a filter.

### Website Visitors — `/v2/website-visitors`
Companies and known contacts identified on your site, with intent (high = pricing/demo pages). High-intent known visitors create tasks. Anonymous identification needs a paid provider and is not on.

### Forms — `/v2/forms`
Embeddable lead-capture forms; each submission creates a lead (auto-create) and routes it (auto-route). Submissions tab per form. The webform bridge can feed the CRM funnel directly.

### [admin] Landing Pages — `/v2/landing-pages`
Hosted pages at `/l/your-slug` with headline, sections, a capture form, optional booking CTA and the chat bubble. Submissions create leads. Publish/unpublish per page.

### [admin] Chat Agents — `/v2/chat`
Website chat widgets (`/c/your-slug` and hosted pages). Persona, greeting, qualifying questions with weights, qualify threshold, knowledge base ("What it knows" — the only facts it may state), booking user, mode Off/Approve/Auto, follow-up mode for visitors who left an email and did not book. Sessions list with transcript, score, intent, outcome. The only meeting source that sends nothing.

---

## CRM

### ★ People — `/v2/people`
The master person table. Search, filters (title, seniority, company, email status, confidence tier, verification, list, campaign membership), column chooser, saved views. Row actions and bulk **Add to ▾** menu: add to list, enroll in sequence, add to campaign (opens the Add existing wizard), enrich, verify email, convert to lead, create task, archive. The person drawer shows the dossier, data-source chips (provenance), campaign and sequence memberships, activity timeline, fit score. Needs Review is a filter (`verificationStatus = needs_review`).

### ★ Companies — `/v2/companies`
Every company with its people, enrichment (industry, size, revenue, HQ, tech), brand identity (logo/domain with pin/merge), account stage, score, deals and activity. Brand pins override every enrichment provider.

### ★ Leads — `/leads`
Inbound and engaged people awaiting qualification. Score 0–100 (Lead Scoring), owner (Lead Routing), status new → working → qualified/unqualified → converted. **Convert** creates Account + Contact + Opportunity in one step. AI Pipeline nightly batch drafts outreach for leads above the score threshold.

### ★ Deals — `/v2/deals`
Kanban board of open opportunities by stage; list and forecast views. Drag between stages; each card shows value, win probability, days in stage, next step, owner. **Pipeline Alerts** strip (`#alerts`): stale (no touch 14 days), low probability, no champion, slipped close date. Deal Autopilot writes next-step notes and win-prob; in Auto it creates follow-up tasks.

### ★ Lists — `/v2/lists`
Named static sets of people or companies. Create from a filter (AI Assistant or People bulk action), add/remove members, use as the source in the Add existing wizard, bulk enroll, export.

### ★ Tasks — `/v2/tasks`
Your to-do queue: open, in progress, snoozed, done. AI-proposed **draft** tasks land here for approval (Task Autopilot in Approve). Types cover call, email, meeting, LinkedIn, follow-up, meeting prep, CRM update. Overdue tasks fire the `task_overdue` workflow trigger.

---

## Outreach

### ★ Revenue Engine — `/are`
The hub for the autonomous outbound engine: funnel (discovered → enriched → approved → contacted → replied → meetings), per-campaign status, engine logs, ICP agent link, campaign proposals (engine-suggested new campaigns) and routing suggestions when the Campaign Routing dial is on. See `revenue-engine.md`.

### ★ Campaigns — `/are/campaigns`
List of Revenue Engine campaigns with status, funnel counters and autonomy mode. **New campaign** wizard: name, goal, targeting (titles, industries, geos, keywords, company size), prospect sources, copy mode and sequence prompt, cadence, daily send cap, channels, autonomy mode, target prospect count. Campaign detail tabs: **Prospects** (queue with enrichment/sequence status, approve/reject/restore, Add existing wizard, enrich, regenerate), **Sequences** (each person's written steps with quality score), **Step performance** (table + funnel of sends/opens/replies per step, filter and sort), **A/B** (variants per step, winners), **Signals** (opens, clicks, replies, bounces), **Rejections** (auto-screened people with reasons), **Sources/Scraper** (discovery jobs), **Logs** (engine phases per tick), **Settings**.

### ★ Sequences — `/v2/sequences`
Fixed multi-step flows: the same steps to everyone enrolled, with merge tags. Build steps (email / LinkedIn / task / wait), delays, A/B subject tests, enroll people or lists, see enrollment counts and stuck steps. Drafts awaiting review appear in Email Drafts. A reply pauses the enrollment. Not the same thing as a Revenue Engine campaign (which writes per person and can source its own people) or a Broadcast.

### ★ Emails — `/v2/emails`
Every email sitewide: campaign and sequence steps, CRM sends, inbox mail, proposals, system mail, inbound replies. Filters by source, status, account. **AI Pipeline** (`?status=awaiting&source=ai_draft`) and **Email Drafts** (`?status=awaiting&source=sequence`) are saved filters of this page: approve, edit, discard.

### ★ Conversations — `/v2/conversations`
Inbound replies that need a human: classified (willing to meet, question, referral, OOO, left company, not interested, unsubscribe, other) with sentiment, confidence and a suggested reply. Handle = reply, book, task, or dismiss; handling stops the sequence for that person. Social replies have their own list. Stats: total, unhandled, willing-to-meet, needs-classify.

### ★ Meetings — `/v2/meetings`
Proposed (AI candidate times to confirm), invited, scheduled, completed, no-show, cancelled. Confirm AI proposals here; reminders send 1–24h before; a no-show creates a re-book task. Your booking link (`/b/your-slug`) is managed here: title, duration, window, **timezone (defaults to UTC — set it)**.

### ★ Unified Inbox — `/unified-inbox`
LinkedIn, WhatsApp and social DMs in one thread list, via the Unipile connection.

### ★ Social — `/social`
LinkedIn outreach: search, invites (capped, warmed), DMs, opener on accept, replies. Social Autopilot dial. LinkedIn Limits page sets per-account caps and working hours.

---

## Marketing

### Broadcasts — `/campaigns`
One message to a segment. **Not yet sending** — prepare audiences and copy here; live outreach runs as Revenue Engine campaigns or sequences.

### Segments — `/segments` · Segment Rules — `/segment-rules`
Saved rule-based audiences that stay current (match all/any, rules over person and company fields); Segment Rules auto-enroll matching people into a sequence hourly.

---

## Proposals

### ★ Proposals — `/proposals`
Client-facing proposals with sections, milestones, budget, requirements, a portal share link, e-sign, expiry with extension requests, score snapshots. Link to an opportunity.

### Quotes — `/quotes` · Products — `/products`
Priced quotes attached to deals with line items from the Products catalog; totals, discounts, terms, sent/accepted states.

---

## Dialer

### ★ Calls — `/v2/calls`
Call queue and log with outcomes and durations; AI voice agents (inbound call-back receptionist: greets, confirms, books) with transcripts and summaries logged to the record. Outbound AI dialing is not available (vendor API unpublished).

---

## Customer Success

### ★ Customers — `/customers`
Won accounts: tier, health tier (healthy / watch / at risk / critical), ARR, notes, expansion. Churn-risk notifications come from here.

### Renewals — `/renewals` · QBRs — `/qbrs`
Renewal stages (early → 90 → 60 → 30 → at risk → renewed/churned) with contract end dates; QBR prep drafted by AI, history per customer.

---

## Analytics

### ★ Analytics — `/v2/analytics`
The one cross-channel funnel: sending volume, opens, replies, meetings, pipeline created, over time and by campaign/sequence/source.

### ★ Reports — `/reports`
Row-level report builder over any object (columns, filters, group by, sort), CSV export, saved reports, schedules (daily/weekly/monthly email to recipients), presets.

### ★ Dashboards — `/dashboards`
Custom CRM metric boards with widgets.

### Email Analytics — `/email-analytics`
Opens, clicks, replies, bounces by send — drafts and CRM sends only; campaign sends are in Analytics and Engine Performance.

### ★ Engine Performance — `/are/performance`
What the engine sent, booked and learned: reply and meeting rates by step, by source, by A/B variant; promoted winners; optimisation proposals and their attribution verdicts.

### ★ Forecast — `/forecast`
Projected revenue from the open pipeline, weighted by stage and win probability.

### Mindmaps — `/mindmaps`
Freeform planning canvases and account maps.

---

## Configuration

### Settings hub — `/v2/settings/profile`
Personal: Profile, Mailboxes, Phone numbers, Notifications, Social accounts, Multi-factor authentication, Email settings. Workspace: Overview, Users and teams, Security, Integrations, Voice agents, Data sources, Email delivery, Branding, Billing and credits (AI monthly token budget, verification credits), System activity, Data management (Custom fields, Imports and exports, Data enrichment, Danger zone: remove sample data, export, archive, transfer ownership).

### Email Sending cluster
- **Email Sending / Sending Accounts** — `/sending-accounts`: mailboxes (Gmail/Outlook/SMTP) and SendGrid senders, from name (**set a display name on every sender**, it is the From header and the `{{senderName}}` signature), daily limits, warmup, reply-to, test send.
- **Sender Pools** — `/sender-pools`: rotate campaign sends across senders.
- **Deliverability** — `/v2/deliverability`: domain health (SPF/DKIM/DMARC), warmup progress, bounce and spam rates.
- **Suppressions** — `/email-suppressions`: unsubscribes and do-not-contact; honoured by every sender.

### Connected Accounts — `/connected-accounts`
OAuth links: mailboxes, Microsoft 365 (calendar, OneDrive, OneNote), LinkedIn via Unipile.

### LinkedIn Limits — `/settings/linkedin-limits`
Per-account invite/message caps, pacing, working hours.

### Lead Scoring — `/lead-scoring` · Lead Routing — `/lead-routing`
Fit and engagement models with grade thresholds (install defaults, set primary, **Recalculate** after enrichment waves); assignment rules for new leads (round-robin, territory, owner rules).

### Brand Voice — `/brand-voice` · Personas — `/personas` · ICP Agent — `/are/icp`
How the AI sounds; who it writes to; the living ideal-customer profile (current version, history, regenerate, override, restore).

### Prompt Templates — `/prompt-templates`
Versioned prompts behind the AI generators (sequence writer, reply drafts, QBR prep). Edit with care; the campaign's own **sequence prompt** (voice + do-not list) overrides per campaign.

### Workflow Rules — `/workflows`
If-this-then-that on CRM events: triggers record created, stage changed, signal received (job change), deal stuck, task overdue; actions webhook, Slack, Teams, create task, notify. **Test fire** runs the real path.

### Custom Fields — `/custom-fields` · Team — `/team` · Audit Log — `/audit` · Help Center — `/help`
Your own fields on records; members, roles, invites, deactivate/reassign/delete; who changed what; guides, articles, tours and Ask AI.

---

## Public pages (no login)
- `/b/<slug>` — booking page (self-serve scheduling; books a real calendar event).
- `/c/<slug>` — chat agent page.
- `/l/<slug>` — landing page with capture form.
- Proposal portal links (share token) for clients.
- `/api/health` — build commit and status (ops).
