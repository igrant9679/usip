/**
 * seedHelpOperatorManual.ts — the "Operator's Manual" Help Center category.
 *
 * Owner ask 2026-09-08: a complete, detailed manual for using, controlling and
 * getting the most out of Velocity — every page, the data model, the Revenue
 * Engine, the autopilots, and daily / weekly / monthly routines with
 * repeatable processes — built into the Help Center (and, through
 * help_lookup / Ask AI, into the AI Assistant).
 *
 * Same knowledge, three homes, kept in step by hand:
 *   - .claude/skills/velocity-operator/   (the skill any Claude instance reads)
 *   - server/productKnowledge.ts          (the assistant's compact digest)
 *   - this file                           (what users read in /help)
 *
 * Articles are markdown; HelpArticle.tsx renders headings, lists, fenced code,
 * **bold**, `code`, [links](/path) and simple pipe tables. Seeded slugs are
 * overwritten on every boot (see seedHelpContent.ts), so an admin who wants to
 * customise one of these should copy it to a new slug.
 */

export type OperatorArticle = {
  slug: string;
  categorySlug: "operator-manual";
  title: string;
  summary: string;
  readingTimeMinutes: number;
  tags: string[];
  pageKey?: string;
  bodyMarkdown: string;
};

export const OPERATOR_CATEGORY = { slug: "operator-manual", name: "Operator's Manual", icon: "📖", sortOrder: 0 } as const;

export const OPERATOR_ARTICLES: OperatorArticle[] = [
  {
    slug: "om-how-velocity-fits-together",
    categorySlug: "operator-manual",
    title: "How Velocity fits together",
    summary: "The five ideas behind every page: meeting engines, the Off/Approve/Auto dial, the attention panel, who-vs-deal, and the three things called sequences.",
    readingTimeMinutes: 6,
    tags: ["operator-manual", "overview", "model", "getting-started"],
    pageKey: "home",
    bodyMarkdown: `Velocity has one job: **get sales meetings booked**. The People database, sequences, scoring and the autonomous engine exist to feed that. If you hold five ideas in your head, every page in the product becomes obvious.

## 1. Meetings arrive five ways

Each is an independent engine. You do not need all five, and most teams should start with the two that send nothing.

| Engine | Where | Sends anything? | Best for |
|---|---|---|---|
| Website chat agent | Prospecting → Chat Agents | No | Inbound visitors, zero deliverability risk |
| Booking links | Outreach → Meetings (/b/your-slug) | No | Anyone you are already talking to |
| Sequences | Outreach → Sequences | Yes, fixed steps | People you already have |
| Revenue Engine campaigns | Outreach → Campaigns | Yes, written per person | Net-new outbound at scale |
| Meeting Autopilot | Autonomy Center | Yes, invites | Prospects who look ready |

## 2. One dial everywhere: Off / Approve / Auto

Every autonomous feature has the same three-way switch, and they all live on **Daily → Autonomy Center**.

- **Off** — nothing happens.
- **Approve** — the AI does the work and then stops. It arrives as a draft task, a draft email, a proposed meeting or a suggestion. Nothing reaches a prospect.
- **Auto** — it acts on its own and tells you afterwards.

Approve is not a half-measure. It is a dry run on your real data. Learn on Approve; when you find yourself approving everything unchanged, promote that one dial to Auto. Only admins can move dials.

## 3. Home is where the machines confess

**Daily → Home** carries the attention panel: the single list of everything waiting on a human — AI drafts, engine approvals, unhandled replies, proposed meetings, draft tasks, paused campaigns, routing suggestions, campaign proposals — plus a 24-hour digest of what was sent, discovered, replied and booked. An empty panel is the system working, not something you missed. Every routine in this manual starts there.

## 4. Separate the who from the deal

A name enters as a **Person** (CRM → People). When it engages it becomes a **Lead** (CRM → Leads). Converting a lead creates an **Account** (company), a **Contact** (person on that account) and an **Opportunity** (the deal) in one step. Accounts and Contacts persist for years; only the Opportunity travels the pipeline and closes Won or Lost. Won turns the account into a **Customer** with health, renewals and QBRs.

## 5. Three things get called "sequences"

- **Sequences** (Outreach → Sequences): fixed multi-step flows; the same steps go to everyone you enroll; a reply pauses that person.
- **Revenue Engine campaigns** (Outreach → Campaigns): autonomous outbound that finds people, writes to each one from a dossier, sends, and works replies.
- A campaign's **Sequences tab**: the written steps for that campaign's people.
- **Broadcasts** (Marketing → Broadcasts): one message to a segment; audiences and copy only, not sending yet.

When someone says "add them to the sequence", ask which page they mean.

## Where to go next

- [Every page, explained](/help/articles/om-page-directory)
- [The daily routine](/help/articles/om-daily-routine), [the weekly routine](/help/articles/om-weekly-routine), [the monthly and quarterly routine](/help/articles/om-monthly-routine)
- [The Revenue Engine, end to end](/help/articles/om-revenue-engine-lifecycle)
- [The autopilots and what runs on a schedule](/help/articles/om-autopilots-and-schedules)
- [Glossary](/help/articles/om-glossary) and [Troubleshooting](/help/articles/om-troubleshooting)`,
  },
  {
    slug: "om-page-directory",
    categorySlug: "operator-manual",
    title: "Every page, explained",
    summary: "Section by section: what each page is for, what you see on it, and the actions that matter.",
    readingTimeMinutes: 14,
    tags: ["operator-manual", "pages", "navigation", "reference"],
    pageKey: "library",
    bodyMarkdown: `The sidebar shows the daily loop; **Ctrl+K** (the Library) lists every tool. Hover any sidebar item for its one-line help; the **?** in the top bar opens the Help drawer for the page you are on. Pages marked *admin* are hidden from reps.

## Daily

**Home** (/v2/home) — the attention panel (everything waiting on a human), the 24-hour digest, and what the autopilots did. Work it top to bottom; each row links to its queue.

**Dashboard** (/dashboard) — pipeline at a glance: revenue by period, win/loss, stage funnel, top reps, recent deals. Read-only.

**AI Assistant** (/v2/ai-assistant) — chat over your own data. It searches people and companies, lists sequences, lists and campaigns, reads the pipeline, runs read-only queries over every core table, looks up help, and hands you links. It can *propose* actions — enroll, tasks, add to list, enrich, pause or activate a campaign, draft a campaign, propose meetings, build a list from a filter, pin a company brand, update or archive prospects — which run only when you press Confirm. It cannot send email or LinkedIn messages.

**Inbox** (/inbox) — your notifications: mentions, tasks assigned or due, deals won or lost, renewals due, churn risk, approval requests, workflow fired, email replies, engine events.

**My Mailbox** (/mailbox) — your connected email account inside Velocity. **My Calendar** (/calendar) — your schedule synced from your calendar provider, including meetings the AI booked.

**Autonomy Center** (/v2/workflows) — every Off / Approve / Auto dial on one screen, plus AI-suggested workflow rules. Admin-only to change.

## Prospecting

**Data Enrichment** (/v2/data-enrichment) — the hub. *Enrich* fills missing emails, titles and companies (select people → Enrich ▾ → Enrich fully). *Find Prospects* searches new people by role and company shape. *Import Contacts* brings in a CSV with exact-match column mapping and per-destination required fields. *Data Health* shows duplicates, gaps and import audits. The **Enrichment sweep** and **Company backfill** cards run backlog email-finding and LinkedIn company backfill on their own dials and daily caps.

**Website Visitors** (/v2/website-visitors) — companies and known contacts seen on your site with intent (pricing and demo pages are high). **Forms** (/v2/forms) — embeddable capture forms; submissions create and route leads. **Landing Pages** (/v2/landing-pages, admin) — hosted pages at /l/your-slug with a capture form, optional booking button and the chat bubble. **Chat Agents** (/v2/chat, admin) — the website chat widget: persona, greeting, qualifying questions, what it knows, booking user, its own Off / Approve / Auto dial, and a follow-up dial for visitors who left an email without booking.

## CRM

**People** (/v2/people) — the master person table. Filters for title, seniority, company, email status, confidence tier, verification, list and campaign membership; the **Add to ▾** menu adds to a list, enrolls in a sequence, adds to a campaign (the Add existing wizard), enriches, verifies, converts to a lead, creates a task or archives. The person drawer shows the dossier, the data-source chips (where each fact came from), memberships and the timeline. **Needs Review** is the verification filter.

**Companies** (/v2/companies) — every company with its people, enrichment, brand identity (pin the right logo and domain; pins beat every provider), deals and activity.

**Leads** (/leads) — inbound and engaged people awaiting qualification: score, owner, status new → working → qualified or unqualified → converted. **Convert** creates the account, contact and opportunity together.

**Deals** (/v2/deals) — the kanban of open opportunities by stage with value, win probability, days in stage and next step; list and forecast views; the **Pipeline Alerts** strip for stale, low-probability, no-champion and slipped deals.

**Lists** (/v2/lists) — named static sets of people or companies for targeting and bulk actions. **Tasks** (/v2/tasks) — your queue, including AI-proposed draft tasks awaiting approval.

## Outreach

**Revenue Engine** (/are) — the hub: funnel from discovered to meetings, per-campaign status, engine logs, ICP link, routing suggestions and campaign proposals.

**Campaigns** (/are/campaigns) — the engine's campaigns. Detail tabs: Prospects (queue, approve, reject, restore, Add existing), Sequences (each person's written steps with a quality score), Step performance (sends, opens, replies and meetings per step, table and funnel), A/B (variants and winners), Signals (opens, clicks, replies, bounces), Rejections (auto-screened people with reasons), Sources, Logs, Settings. See [The Revenue Engine, end to end](/help/articles/om-revenue-engine-lifecycle).

**Sequences** (/v2/sequences) — fixed multi-step flows with merge tags, delays and subject tests; enroll people or lists; drafts land in Email Drafts when review is required.

**Emails** (/v2/emails) — every email in and out, sitewide. **AI Pipeline** and **Email Drafts** are saved filters of this page where you approve, edit or discard.

**Conversations** (/v2/conversations) — inbound replies that need a human, classified with sentiment and a suggested reply. Handling one stops the sequence for that person.

**Meetings** (/v2/meetings) — proposed, invited, scheduled, completed, no-show. Confirm AI proposals here. Your **booking link** lives here: set its timezone (it defaults to UTC).

**Unified Inbox** (/unified-inbox) — LinkedIn, WhatsApp and social DMs. **Social** (/social) — LinkedIn invites, DMs and replies under the Social Autopilot and LinkedIn Limits.

## Marketing, Proposals, Dialer, Customer Success

**Broadcasts** (/campaigns) prepare one message to a segment (not yet sending). **Segments** (/segments) are saved audiences that stay current; **Segment Rules** auto-enroll matches into a sequence.

**Proposals** (/proposals) are client-facing documents with sections, milestones, a portal link and e-sign; **Quotes** (/quotes) price a deal from the **Products** (/products) catalog.

**Calls** (/v2/calls) is the call queue and log, plus AI voice agents that answer call-backs and log transcripts.

**Customers** (/customers) are won accounts with health tiers; **Renewals** (/renewals) track contract stages from 90 days out; **QBRs** (/qbrs) hold AI-drafted prep and history.

## Analytics

**Analytics** (/v2/analytics) is the one cross-channel funnel. **Reports** (/reports) is the row-level builder with schedules. **Dashboards** (/dashboards) hold custom boards. **Engine Performance** (/are/performance) shows what the engine sent, booked and learned. **Forecast** (/forecast) projects revenue from the open pipeline. **Email Analytics** covers drafts and CRM sends only.

## Configuration

**Settings** (/v2/settings/profile) — personal (profile, mailboxes, phone numbers, notifications, social accounts, MFA) and workspace (overview, users and teams, security, integrations, voice agents, data sources, email delivery, branding, billing and credits, data management, danger zone).

**Email Sending** (/sending-accounts) with **Sender Pools**, **Deliverability** and **Suppressions** — set a display name on every sender; it is the From header and the signature.

**Connected Accounts**, **LinkedIn Limits**, **Lead Scoring** (recalculate after enrichment waves), **Lead Routing**, **Brand Voice**, **Personas**, **ICP Agent**, **Prompt Templates**, **Workflow Rules**, **Custom Fields**, **Team**, **Audit Log**, **Help Center**.

## Public pages

/b/slug booking, /c/slug chat, /l/slug landing page, and proposal portal links. None require a login.`,
  },
  {
    slug: "om-data-model",
    categorySlug: "operator-manual",
    title: "Records and their lifecycles",
    summary: "People, Leads, Contacts, Accounts, Deals, Customers, Tasks, Meetings, campaign prospects — what each is and every status it can have.",
    readingTimeMinutes: 8,
    tags: ["operator-manual", "data", "statuses", "reference"],
    pageKey: "people",
    bodyMarkdown: `## The funnel every record moves through

\`\`\`
Find Prospects / Import / Campaign discovery
        |
        v
    PERSON (People)  --engages-->  LEAD  --Convert-->  ACCOUNT + CONTACT + OPPORTUNITY
                                                             |  stages
                                                             v
                                       WON -> CUSTOMER      LOST -> account kept
\`\`\`

## Four person-shaped records, on purpose

| Record | Page | What it is | Created by |
|---|---|---|---|
| Person | People | The master record: email and its status, LinkedIn, company, confidence, fit score, provenance | Find Prospects, import, discovery, wizard |
| Lead | Leads | Engaged or inbound, awaiting qualification; scored and routed | Forms, pages, chat, booking, Convert to lead |
| Contact | Companies → people | The durable person on an account | Lead conversion, import |
| Campaign prospect | Campaign → Prospects | That person inside one campaign, with its own enrichment and sequence status | Discovery, Add existing, routing, proposals |

One human can be in several campaigns; each membership is its own row pointing back at one Person.

## Statuses

**Lead**: new → working → qualified or unqualified → converted.

**Opportunity stage**: discovery → qualified → proposal → negotiation → won or lost. Each deal has value, win probability, close date, days in stage and an AI next step.

**Customer**: tier enterprise / midmarket / smb; health healthy / watch / at risk / critical; renewal stage early → 90 days → 60 → 30 → at risk → renewed or churned.

**Task**: open, in progress, snoozed, done, cancelled, and **draft** (AI-proposed, awaiting approval). Types include call, email, meeting, LinkedIn, follow-up, meeting prep, CRM update.

**Meeting**: proposed (candidate times, nothing sent) → invited → scheduled → completed, no-show, cancelled or rescheduled. Source: manual, AI, campaign reply, inbound.

**Sequence**: draft, active, paused, archived. **Enrollment**: active, paused, finished, exited; a reply pauses.

**Campaign**: draft → active → paused or completed. Only active campaigns run; pausing also stops enrichment spend. Autonomy: full, batch approval (default), review and release.

**Campaign prospect**: enrichment pending → enriching → complete or failed; sequence pending → approved → enrolled → completed, replied, paused, canceled, or skipped (rejected; restorable from the Rejections tab). Each has a dossier, an ICP score and, once written, a sequence with a quality score out of 40. Each step becomes a scheduled row that turns into sent (with opens) or skipped.

**Person quality**: email status valid / accept-all / unverified / invalid; confidence tier high / medium / low; verification verified / needs review / rejected.

**Reply classes**: willing to meet, follow-up question, referral, out of office, left company or wrong person, not interested, unsubscribe, other. Sentiment positive / neutral / negative / objection.

## Roles

super_admin (everything, including creating and transferring workspaces) → admin (settings, dials, team, sending) → manager (team views and approvals) → rep (own records and queues). Dials are admin-only.

## Lists, segments, personas, ICP, brand voice

Lists are hand-picked and static. Segments are rule-based and stay current. Personas describe the buyers the AI writes toward. The ICP profile is regenerated daily from won deals and engagement and drives discovery targeting. Brand voice (tone, vocabulary, avoid-words, from-name) is read by every AI-written email and chat reply.`,
  },
  {
    slug: "om-revenue-engine-lifecycle",
    categorySlug: "operator-manual",
    title: "The Revenue Engine, end to end",
    summary: "Campaign anatomy, the seven-phase engine loop, how people enter, the human gates, how to read a campaign, and the checks before you go live.",
    readingTimeMinutes: 10,
    tags: ["operator-manual", "are", "campaigns", "engine"],
    pageKey: "are",
    bodyMarkdown: `The Revenue Engine is the one part of Velocity that spends real sending reputation. Understand it before you switch a campaign to active.

## Campaign anatomy

- **Targeting** — titles, industries, geographies, keywords, company size, personas. Drives discovery and the fit screen. Weak targeting makes weak prospects; invest here first.
- **Prospect sources** — which discovery sources the campaign may use. An explicitly empty list means **no discovery**: use that for a curated campaign you seed by hand.
- **Target prospect count** — discovery runs only while working prospects are below it.
- **Copy mode** — per person (the writer reads the dossier, your brief, brand voice and personas) or fixed (one template with merge tags).
- **Sequence prompt** — the brief in the writer's ear. State in one plain sentence what you do, give the voice, and give the do-not list: no invented programs or numbers the dossier does not show, one meaning across all steps (a new angle is a new question, not a new product), no credentials in names.
- **Cadence** — steps with day offsets (default gap seven days), email or LinkedIn, optional A/B variants per step.
- **Autonomy** — full (discover to send with no human), batch approval (you approve enriched batches; the default), review and release (you approve each person).
- **Screen** — the enrichment fit gate (default 40), the auto-approve threshold, and the auto-reject floor (fit below 30 is skipped with a reason in Rejections).
- **Daily send cap**, sender or pool, suppression list, goal.

## The engine loop (every three minutes)

1. **Enrich** — pending people across all active campaigns, one at a time, best fit first.
2. **Screen** — approve or reject per the autonomy mode and thresholds.
3. **Write** — a sequence for each approved person; a judge that can see the dossier scores it out of 40.
4. **Enroll** — steps become scheduled sends on the cadence. Steps already sent are kept on re-enrol.
5. **Dispatch** — due steps send through the pool within the daily cap and outside the suppression list; the sender's display name becomes the From header and the signature; tracking is injected.
6. **Complete** and recount the funnel.
7. **Discover** — if the queue is drained and below target, pull from one source.

The Logs tab shows each phase per tick. A paused campaign runs none of this and spends nothing.

## How people enter a campaign

- **Discovery** as above.
- **Add existing** (Prospects tab): a three-step wizard. *Select* from a table with search, filters and select-all, or from a list. *Verify* shows duplicates already in this campaign and where each person is in other campaigns and sequences. *Add* pushes in batches; pushed people are enriched one at a time in the background.
- **Campaign routing** (Autonomy Center dial): every 30 minutes, people in no campaign are matched to the best-fit active campaign — suggested in Approve, enrolled in Auto, within a daily cap.
- **Campaign proposals** (same dial): hourly, people no active campaign fits are clustered into proposed new campaigns with a name, targeting, a drafted brief and the people. Create (born as a draft with its people pending), redraft, or reject from the hub.
- **The AI Assistant** can draft a campaign or propose enrollments; both wait for your confirm.

## The human gates

In batch approval, the engine enriches and then waits. On the Prospects tab, select the rows and press **Approve**; that is the gate every send waits behind. Approve exactly the people you looked at: discovery may have added strangers since, so check the count before you press. Reject sends a row to Rejections with a reason; Restore brings it back. The Home attention panel counts pending approvals per campaign.

## Reading a campaign

- **Prospects** — enrichment and sequence status per person, fit score, filters.
- **Sequences** — every written step with subject, body, day, variant and the quality score; regenerate or edit.
- **Step performance** — sends, opens, replies and meetings per step and variant in a sortable, filterable table, plus the funnel diagram.
- **Signals** — opens, clicks, replies, bounces and unsubscribes as they arrive.
- **A/B** — variants per step and the promoted winner.
- **Rejections** — who was screened out and why; restore real fits.
- **Logs** — what the engine did each tick.

## Replies and the sender

A reply marks the person replied, stops their remaining steps and lands in Conversations classified. Mailboxes are polled every minute. **SendGrid senders have no inbox**: set their Reply-To to a mailbox that is connected under Settings → Mailboxes, or replies will never appear. Set a **display name** on every sender; it is the From header and fills the signature.

## Before you set a campaign active

1. Sender display names set; reply mailbox connected.
2. Sources are what you intend (empty for curated).
3. The prompt has your voice and the do-not list.
4. Daily cap set (start at 20 to 30).
5. Booking link timezone set.
6. Read the first three written sequences; fix the prompt and regenerate before approving.
7. Approve a first batch of about ten, watch Signals for 48 hours, then widen.

See the process [Launch a Revenue Engine campaign](/help/articles/om-process-launch-campaign).`,
  },
  {
    slug: "om-autopilots-and-schedules",
    categorySlug: "operator-manual",
    title: "The autopilots and what runs on a schedule",
    summary: "Every dial with what Approve produces and what Auto does, the jobs that run in the background and how often, workflow rules, and the budgets that cap them.",
    readingTimeMinutes: 8,
    tags: ["operator-manual", "autopilot", "automation", "schedule", "budget"],
    pageKey: "workflows",
    bodyMarkdown: `## The dials

All on **Daily → Autonomy Center**; admin-only. Everything defaults to Off except Optimisation, which defaults to Approve.

| Dial | Approve produces | Auto does |
|---|---|---|
| Task Autopilot | draft next-best-action tasks | open tasks |
| Meeting Autopilot | proposed meetings with candidate times | sends the invite |
| Conversation Autopilot | classifies every reply with a suggested answer | acts per class: willing-to-meet gets your booking link, unsubscribe goes on suppression, referral becomes a task |
| Deal Autopilot | next-step notes and win probability | also creates follow-up tasks |
| Social Autopilot | draft invite tasks | sends LinkedIn invites within caps, opener on accept |
| Job-change Autopilot | re-engagement tasks when a move is detected | starts the re-engage sequence |
| Chat agent | chats, captures the lead, qualified visitor becomes a task | books the meeting itself |
| Chat follow-up | drafts one follow-up to a visitor who left an email and did not book | sends that email |
| Enrichment sweep | attended runs only | unattended backlog email-finding every six hours |
| Company backfill | attended | unattended LinkedIn company backfill (about 100 lookups a day) |
| Campaign routing and proposals | suggestions and proposed campaigns on the hub | enrolls best-fit people, within a daily cap |
| Optimisation | proposals from outcomes | edits sequences within limits; auto-reverts what made outbound worse |
| Email AI auto-send | off | high-scoring AI drafts send themselves |

A sane starting posture: everything that only does work (tasks, deals, sweeps, backfill, job change, the chat agent) on Auto; everything that sends (meetings, conversation replies, social, chat follow-up, email auto-send, campaigns in full mode) on Approve until you have read a week of its output. Promote one dial at a time so you can tell which change caused what.

## What runs in the background

| Job | Every | What it does |
|---|---|---|
| Revenue Engine tick | 3 min | enrich, screen, write, enroll, dispatch, recount, discover |
| Sequence engine | 5 min | advance enrollments, then the AI auto-send pass |
| Reply poller | 1 min | pull new replies from connected mailboxes |
| Conversation autopilot | 5 min | classify and act on replies |
| Pipeline alerts | 15 min | stale, low-probability, no-champion, slipped deals |
| Chat follow-up | 15 min | one follow-up per abandoned qualified chat |
| Task autopilot, campaign routing, warmup, calendar and OneNote sync, company-name verification | 30 min | |
| Meeting autopilot | 45 min | propose meetings for ready prospects |
| Segment rules, scheduled reports, campaign proposals, meeting reminders, deal autopilot, social autopilot | hourly | |
| Enrichment sweep, company backfill, photo and logo backfill, brand reconcile | 6 h | data-quality backfills |
| Attribution of optimisations | 12 h | judge and revert |
| Optimisation, ICP inference, nightly AI batch, LinkedIn job-change check, hygiene backfills | daily | |

Archived workspaces are excluded from every job.

## Workflow rules

**Configuration → Workflow Rules** are deterministic if-this-then-that automations, separate from the AI dials. Triggers: record created, stage changed, signal received (job change), deal stuck, task overdue, field equals, schedule. Actions: webhook, Slack, Teams, create task, notify, update field. **Test fire** runs the real path. The Autonomy Center also suggests rules from what it observes; adopt the ones that describe something you actually do.

## Budgets and caps

- **Monthly AI budget** (Settings → Billing and credits): tokens; 0 means unlimited.
- **Verification credits** (Reoon) and **QuickEnrich** lookups: monthly cycles, no rollover; the sweep's daily cap tunes spend.
- **LinkedIn**: about 100 lookups a day per connected account; invite caps on LinkedIn Limits.
- **Daily send caps** per campaign and per sender; sender pools spread load.
- Interactive AI calls are rate-limited per user (about 30 a minute); background jobs are not.`,
  },
  {
    slug: "om-daily-routine",
    categorySlug: "operator-manual",
    title: "The daily routine",
    summary: "The ten-minute loop everyone runs from Home, plus the SDR, AE, customer-success and admin blocks, and the end-of-day close.",
    readingTimeMinutes: 7,
    tags: ["operator-manual", "routine", "daily", "playbook"],
    pageKey: "home",
    bodyMarkdown: `The pattern under every routine: the machines act, the attention panel confesses, a human reads the confession. Daily is for sends and replies.

## Everyone: the ten-minute loop

1. **Home → attention panel**, top to bottom. Each row is a queue; empty the queue, not the row.
   - **AI drafts** (Emails → AI Pipeline): approve, edit or discard. Read at least two in full every day; you are training your own trust.
   - **Engine approvals** (campaign → Prospects): release the batch if the campaign runs batch approval. Nothing sends until you do.
   - **Unhandled replies** (Conversations): answer within one business day. A human reply beats any sequence step, and handling one stops the sequence for that person.
   - **Proposed meetings** (Meetings): confirm or decline the candidate times.
   - **Draft tasks** (Tasks): accept or dismiss the next-best actions.
   - **Routing suggestions and campaign proposals** (Revenue Engine hub): decide; the engine keeps proposing until you do.
2. **Inbox**: read the engine events. Anything red (bounce spike, failed send, expired credential) is fixed before noon.
3. **Today's meetings** (Meetings or My Calendar): open each record for the prep note; afterwards set the disposition and log the activity.
4. **Tasks due today**: work them or reschedule with a reason.

If the panel is empty, you are done with this block.

## SDR block (about 45 minutes)

1. **Needs Review** (People, verification filter): fix emails, verify, archive junk. 15 minutes.
2. **Find Prospects** against today's ICP slice — one title, one industry, one region — into a named list. 15 minutes.
3. **Enroll** the high-fit, valid-email people into the right sequence or campaign from People → Add to ▾. For campaigns use the Add existing wizard so duplicates and other memberships are visible before you commit. 10 minutes.
4. **Social**: accepts and replies, within LinkedIn Limits. 5 minutes.

## AE block (about 30 minutes)

1. **Deals**: every open deal has a dated next step and an owner; move stages honestly.
2. **Pipeline Alerts**: clear each alert by acting or by acknowledging with a note.
3. **Proposals and Quotes**: anything sent more than five days ago without an open gets a call task.
4. Log every touch on the record; it feeds the Deal Autopilot and the forecast.

## Customer success (about 15 minutes)

1. Customers at risk or critical get a touch today.
2. Renewals at 30 days or at risk have an owner and a dated plan.
3. QBRs due this month: review the AI prep draft and schedule the meeting.

## Admin (about 5 minutes)

1. Deliverability: bounce and spam rates, warmup progress, any sender in error.
2. Sending accounts: no single campaign saturating a daily limit; display names set on every sender.
3. Audit Log: skim for surprises — deletions, role changes, dial flips.

## End of day (5 minutes, everyone)

- Every touch logged; every active deal and hot contact has a dated next step.
- Stages honest; win and loss reasons captured on closed deals.
- AI Pipeline and Email Drafts empty so overnight sends fire.
- No approval requests left unread in Inbox.`,
  },
  {
    slug: "om-weekly-routine",
    categorySlug: "operator-manual",
    title: "The weekly routine",
    summary: "The 45-minute review of what is working: engine performance, campaign health, sequences, replies, data, pipeline, leads, inbound, dials and reports.",
    readingTimeMinutes: 6,
    tags: ["operator-manual", "routine", "weekly", "playbook"],
    pageKey: "are-performance",
    bodyMarkdown: `Same day every week, 30 to 60 minutes. Weekly is for trends: what to double down on and what to retire.

1. **Engine Performance** and each active campaign's **Step performance**: which steps and variants get opens and replies. Retire losers, promote winners on the A/B tab. The optimisation dial tunes within limits; retiring a whole angle is your call.
2. **Campaign health** (Campaigns): per campaign — working count against target, enrichment backlog, the quality-score spread (open two low-twenties sequences and read them), Rejections for false negatives (restore real fits), sources still what you intend, daily cap sane, status as expected — nothing active that should be paused.
3. **Sequences**: enrollment counts, stuck steps, drafts sitting in Email Drafts.
4. **Conversations**: classification quality. Correct anything misclassified. If "needs classify" grows, the classifier is starved or a mailbox is disconnected.
5. **Data health** (Data Enrichment → Data Health, the sweep and backfill cards): what the sweeps found, credits spent, how many people still lack an email or a company. You are checking for a stall, not doing the work.
6. **Pipeline** (Deals and Forecast): stage by stage; slipped close dates; deals with no activity in 14 days; forecast against quota. Update win probabilities honestly.
7. **Leads**: anything still new after two days is a routing problem (Lead Routing) or a capacity problem.
8. **Inbound**: the high-intent visitor list, form submissions, three chat transcripts (promote the agent's dial if you approved everything unchanged), landing-page views against submits.
9. **Autonomy Center**: adopt or dismiss the suggested workflow rules; confirm every dial is still where you meant it.
10. **Reports**: run the saved weekly reports — open pipeline by stage, leads created, calls and meetings — and schedule them to email if the same people read them every week.
11. **Managers**: per rep, replies handled, meetings held, tasks overdue; rebalance load.

Close the week when: performance read, losers retired, pipeline honest, leads routed, data not stalled, dials verified.`,
  },
  {
    slug: "om-monthly-routine",
    categorySlug: "operator-manual",
    title: "The monthly and quarterly routine",
    summary: "Budgets, scoring, ICP, pruning, promoting one dial, deliverability, prompts, customer health, hygiene, access, backup — and the quarterly strategy half-day.",
    readingTimeMinutes: 6,
    tags: ["operator-manual", "routine", "monthly", "quarterly", "playbook"],
    pageKey: "settings",
    bodyMarkdown: `Monthly is for budgets and trust. Calendar 60 to 90 minutes.

1. **Budgets** (Settings → Billing and credits): AI token usage against the monthly budget; verification and QuickEnrich credit cycles have no rollover — if a cycle ended with credits unspent raise the sweep's daily cap, if it ran dry early lower it; LinkedIn lookup usage.
2. **Recalculate lead scoring** (Lead Scoring → Recalculate) and confirm the primary model is still right. A month of enrichment changed the fields it reads.
3. **ICP review** (ICP Agent): read this month's profile against last month's. If won deals moved it, adjust campaign targeting and consider running campaign proposals.
4. **Prune**: complete or archive finished campaigns; archive sequences nobody enrolls into; delete lists that served their purpose; clear Needs Review to zero once.
5. **Autonomy review**: any dial that spent a clean month on Approve with everything approved unchanged is a candidate for Auto. Promote one per month and write down the date.
6. **Deliverability month-end**: domain health, warmup graduations, suppression growth, unsubscribes by campaign; retire any sender with rising bounces.
7. **Brand voice and personas**: update avoid-words from what replies complained about; add personas for segments that converted.
8. **Prompts**: fold the month's lessons into the campaign sequence prompts as do-not lines; regenerate unsent steps if the change is material.
9. **Customer success**: health tiers reviewed; renewals 90 days out have plans; next month's QBRs scheduled.
10. **Data hygiene**: duplicates in Data Health; company brand pins and merges; departed contacts re-routed.
11. **Team and access**: roles right-sized; departed members deactivated and reassigned; MFA on for admins.
12. **Backup**: Danger zone → Export if compliance wants an offline copy; skim the month's Audit Log.

## Quarterly (half a day)

- **Targeting strategy**: which ICP slices produced meetings and revenue; rewrite campaign targeting; retire angles; plan next quarter's campaigns (one launch process each).
- **Sequence library**: bake A/B winners into fixed sequences.
- **Forecast accuracy**: compare last quarter's forecast to actuals; adjust stage win probabilities.
- **People and structure**: onboard and offboard, seat count, separate workspaces if brands or regions diverge.
- **Demo workspace** refresh if you demo the product.

Close the month when: budgets set, scores recalculated, ICP reviewed, pruned, one dial promoted or explicitly not, deliverability reviewed, prompts updated, access right-sized.`,
  },
  {
    slug: "om-process-launch-campaign",
    categorySlug: "operator-manual",
    title: "Process: launch a Revenue Engine campaign",
    summary: "The repeatable eight-step launch, from a one-sentence audience to a widened daily cap, with the definition of done.",
    readingTimeMinutes: 5,
    tags: ["operator-manual", "process", "campaign", "are"],
    pageKey: "are-campaigns",
    bodyMarkdown: `1. **Define the audience in one sentence** — who, and why now. Check the ICP profile agrees; add a persona if one is missing.
2. **Create the campaign** (Campaigns → New): name; goal; targeting; **sources** as an explicit list (choose existing people only for a curated campaign — an empty list means no discovery); target count; copy mode per person; the **sequence prompt** with one plain sentence of what you do, the voice, and the do-not list (no invented programs or numbers, one meaning across steps, no credentials in names); cadence of five to seven steps at five-to-seven-day gaps; channels; daily cap of 20 to 30; autonomy batch approval.
3. **Sender**: choose the pool or sender; confirm display names are set; make sure the reply mailbox is connected (for SendGrid, point Reply-To at a connected mailbox); set your booking link timezone.
4. **Seed people**: Add existing from a list (the Verify step shows duplicates and other memberships) or let discovery run.
5. **Set active**. Watch Logs for the first tick and Prospects for enrichment. Open the first three written sequences and read them; fix the prompt and regenerate before approving anything.
6. **Approve the first batch of about ten** — exactly those rows. Watch Step performance and Signals for 48 hours for bounces and opens.
7. **Widen**: approve larger batches; raise the daily cap when the bounce rate is low and replies arrive.
8. **Weekly**: run the campaign-health items of the weekly routine.

Definition of done: sender display names set, reply mailbox connected, sources intended, prompt carries voice and do-not list, cap set, first three sequences read, first batch approved by name, replies handled within a day.`,
  },
  {
    slug: "om-process-list-to-meeting",
    categorySlug: "operator-manual",
    title: "Process: from a list to a meeting",
    summary: "Build, enrich, verify, score, enroll, handle the reply, book, convert.",
    readingTimeMinutes: 3,
    tags: ["operator-manual", "process", "sequences", "prospecting"],
    pageKey: "people",
    bodyMarkdown: `1. **Build the list**: Find Prospects or People filters → Add to ▾ → List.
2. **Enrich fully**; verify emails; clear Needs Review for the list.
3. **Score**: recalculate fit; keep good and excellent with a valid email.
4. **Enroll**: People → Add to ▾ → Sequence, or a campaign through the Add existing wizard. Drafts appear in Email Drafts if the sequence requires review.
5. **Replies** land in Conversations; handle them. Willing to meet gets the booking link or proposed times (Meeting Autopilot can do it in Auto).
6. **Meeting held**: set the disposition, log the activity, convert the lead, work the opportunity.

Every step is visible on the person's drawer: memberships, timeline, and where each fact came from.`,
  },
  {
    slug: "om-process-inbound-and-replies",
    categorySlug: "operator-manual",
    title: "Process: inbound leads and reply handling",
    summary: "What happens when a form, page, chat or booking creates a lead, the same-day SLA, and the per-class playbook for replies.",
    readingTimeMinutes: 4,
    tags: ["operator-manual", "process", "inbound", "replies", "conversations"],
    pageKey: "conversations",
    bodyMarkdown: `## Inbound leads

1. A form, landing page, chat session or booking creates a **Lead** (auto-create) and routes it (Lead Routing). Check routing weekly.
2. The owner works the lead the same day. High-intent visits and qualified chats create a call task automatically; log the call.
3. **Qualify → Convert** (account, contact and opportunity in one step) or unqualify with a reason.
4. Chat-qualified visitors: in Approve the agent raises a high-priority task; in Auto it books the meeting. Read the transcript before the meeting either way.

## Replies (Conversations)

Newest first. Read the class, the sentiment and the suggested reply, then act:

| Class | Do |
|---|---|
| Willing to meet | propose times or send the booking link (the Meeting Autopilot does this in Auto) |
| Follow-up question | answer in your voice, log it |
| Referral | create the referred person in People and a task to reach them |
| Out of office | snooze until the return date |
| Left company or wrong person | mark the contact departed; the job-change flow finds the new role |
| Not interested | mark it, respect it |
| Unsubscribe | goes on suppression (automatic in Auto) |

Handling a reply marks it handled and stops the sequence for that person. Correct a wrong classification when you see one; the counts on Home depend on it.`,
  },
  {
    slug: "om-process-pipeline-and-forecast",
    categorySlug: "operator-manual",
    title: "Process: weekly pipeline and forecast review",
    summary: "Deals by stage, alerts, autopilot suggestions, forecast honesty, and proposal follow-ups.",
    readingTimeMinutes: 3,
    tags: ["operator-manual", "process", "pipeline", "forecast", "deals"],
    pageKey: "deals",
    bodyMarkdown: `1. **Deals** by stage, sorted by days in stage. Every deal: a dated next step, a named champion, a realistic close date. Move stages honestly; stage history is kept.
2. **Pipeline Alerts** cleared; Deal Autopilot suggestions accepted or dismissed.
3. **Forecast**: commit against best case; adjust win probabilities; note slips with reasons.
4. **Proposals and Quotes**: follow up on anything sent more than five days ago; check portal opens.
5. **Log** every call, meeting and note on the record; the autopilot and the forecast read them.

Managers: compare forecast to actuals at quarter end and adjust stage probabilities.`,
  },
  {
    slug: "om-process-team-and-hygiene",
    categorySlug: "operator-manual",
    title: "Process: teammates, offboarding, data hygiene, dial changes",
    summary: "Four small repeatable processes admins run: onboarding a rep, offboarding one, the hygiene sweep, and changing a dial safely.",
    readingTimeMinutes: 4,
    tags: ["operator-manual", "process", "team", "admin", "hygiene"],
    pageKey: "team",
    bodyMarkdown: `## New teammate

1. Team → Invite: email, name, role (super_admin, admin, manager, rep), title.
2. They connect a mailbox (and LinkedIn if they prospect); set the sender display name; set their booking-link timezone.
3. Assign lists and territories (Lead Routing); add their sender to pools if campaigns send as them.
4. Point them at Home, the Getting Started category, and Elsie's first tour.

## Offboarding

1. Team → deactivate; reassign owned leads, deals, tasks, meetings and booking links.
2. Remove their sender from pools; disconnect their mailbox; revoke LinkedIn.
3. Check nothing still acts as them: campaigns sending from their account, a chat agent booking to them, report recipients.

## Data hygiene sweep

1. Data Health: merge duplicates; fix import-mapping issues.
2. Needs Review to zero.
3. Companies: pin the correct brand and domain where enrichment guessed; merge duplicates.
4. Recalculate scores; refresh segments.

## Changing a dial safely

1. Read a week of that feature's Approve output first.
2. Flip one dial; write the date somewhere you will see it next month.
3. Watch Home's digest and the feature's page for three days; revert if quality drops.`,
  },
  {
    slug: "om-glossary",
    categorySlug: "operator-manual",
    title: "Glossary",
    summary: "Every term you will meet in Velocity, defined in one line.",
    readingTimeMinutes: 5,
    tags: ["operator-manual", "glossary", "reference"],
    bodyMarkdown: `- **Attention panel** — the list on Home of everything waiting on a human.
- **Add existing** — the campaign wizard that adds people you already have, with duplicate and membership checks.
- **Approve mode** — the AI works and stops; drafts and proposals, nothing sent.
- **ARE / Revenue Engine** — the autonomous outbound engine behind Campaigns.
- **Autonomy Center** — the page holding every Off / Approve / Auto dial.
- **Batch approval** — a campaign mode where a human releases enriched batches before anything sends.
- **Booking link** — your public /b/slug scheduling page.
- **Brand pin** — a manual company logo or domain that overrides every enrichment provider.
- **Brand voice** — tone, vocabulary and avoid-words every AI-written message reads.
- **Broadcast** — one message to a segment (Marketing); not yet sending.
- **Campaign proposal** — an engine-suggested new campaign for people no active campaign fits.
- **Campaign routing** — matching unenrolled people to the best-fit active campaign.
- **Chat agent** — the website widget that qualifies visitors and can book meetings without sending.
- **Confidence tier** — how sure the identity of a person is, from the provenance ledger.
- **Conversion** — turning a lead into an account, contact and opportunity in one step.
- **Daily cap** — the maximum sends per day for a campaign or sender.
- **Dial** — the Off / Approve / Auto switch on a feature.
- **Discovery** — a campaign sourcing new people while its working count is below target.
- **Dossier** — the enriched profile the writer reads before writing to a person.
- **Draft task** — an AI-proposed task awaiting approval.
- **Enrichment** — filling missing emails, titles and companies from providers, reconciled with provenance.
- **Fit gate** — the score a person must reach before the campaign spends enrichment on them.
- **Fit score** — how well a person or company matches your primary scoring model.
- **Full mode** — a campaign that discovers and sends with no human gate.
- **ICP** — the ideal customer profile, regenerated daily from wins and engagement.
- **Job change** — a detected move to a new company; triggers re-engagement.
- **Lead** — an engaged or inbound person awaiting qualification.
- **List** — a hand-picked static set of people or companies.
- **Merge tag** — a placeholder such as first name or company filled at send time.
- **Needs Review** — people whose identity or email needs a human check.
- **Opportunity / deal** — the record that travels the pipeline and closes.
- **Persona** — a buyer archetype the AI writes toward.
- **Person** — the master record on the People page.
- **Prospect queue** — a person's membership in one campaign.
- **Provenance** — where each fact on a record came from (the data-source chips).
- **Quality score** — the judge's score out of 40 for a written sequence.
- **Rejections** — people a campaign screened out, with reasons; restorable.
- **Review and release** — a campaign mode where each person's sequence is approved individually.
- **Segment** — a saved rule-based audience that stays current.
- **Sender display name** — the From name and the signature on every send.
- **Sender pool** — a group of senders campaigns rotate through.
- **Sequence** — a fixed multi-step flow you enroll people into.
- **Signals** — opens, clicks, replies, bounces and unsubscribes.
- **Step performance** — per-step sends, opens, replies and meetings for a campaign.
- **Suppression list** — addresses that must never be emailed.
- **Sweep** — the background job that finds emails for the backlog.
- **Warmup** — gradual ramp of a new mailbox's sending volume.
- **Workflow rule** — a deterministic if-this-then-that automation.
- **Workspace** — one company's data; a user can belong to several.`,
  },
  {
    slug: "om-troubleshooting",
    categorySlug: "operator-manual",
    title: "Troubleshooting: symptom, cause, fix",
    summary: "The problems people actually hit, and the page that fixes each one.",
    readingTimeMinutes: 5,
    tags: ["operator-manual", "troubleshooting", "support"],
    bodyMarkdown: `| Symptom | Likely cause | Fix |
|---|---|---|
| Nothing sends | no enabled sender, campaign paused or draft, daily cap hit, batch not approved, drafts not approved | Email Sending; campaign status; approve the batch; empty AI Pipeline and Email Drafts; read the Logs tab |
| Blank signature or no sender name | the sender has no display name | Email Sending → set a display name on every sender |
| Replies not in Velocity | SendGrid has no inbox; Reply-To mailbox not connected; poller mailbox disconnected | Settings → Mailboxes: connect the Reply-To mailbox; Connected Accounts |
| Booking link offers night-time slots | timezone defaults to UTC | Meetings → booking link → timezone |
| Strangers appeared in a curated campaign | discovery ran because working count was below target and sources defaulted | set sources to existing-only (empty list = no discovery); reject the strangers; lower the target |
| People stuck pending | below the fit gate, enrichment failed, or the campaign is paused | Rejections tab shows gate skips; adjust the gate; resume the campaign |
| Quality scores all identical | stale totals | ask an admin to run the quality repair, then regenerate |
| Emails invent programs or numbers | the brief overrode the dossier | add do-not lines to the sequence prompt; regenerate unsent steps |
| Campaign proposal says "Model draft unavailable" | rate limit during drafting | press Redraft |
| Proposals cluster badly | people lack industry or country | enrich companies first |
| A dial snaps back | dials are admin-only | ask an admin |
| Help article edits vanish after a deploy | seeded articles are rewritten at boot | create your own article with a new slug |
| Import put the wrong column in email | headers must match exactly; two columns cannot claim one field | fix headers and re-map |
| Names carry PMP, MBA and the like | LinkedIn suffixes | the name cleaner runs on import and enrichment; fix legacy rows via Data Health |
| Company shows the wrong brand | enrichment guessed from a mailbox domain or slug | pin the brand on the company |
| LinkedIn actions fail | disconnected or caps reached | Connected Accounts; LinkedIn Limits |
| AI features stop mid-day | monthly AI budget exhausted or provider key missing | Billing and credits; Integrations |
| A campaign is active that should be paused | someone resumed it | check the Audit Log; pause it; do not trust a note that says paused |

Still stuck: Ask AI in the Help Center searches every article, and the AI Assistant can read your live data to see what a queue actually contains.`,
  },
];
