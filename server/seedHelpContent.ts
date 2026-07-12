/**
 * seedHelpContent.ts — SDR enablement Help Center content.
 *
 * Seeds (idempotently, per workspace):
 *   - 9 help categories  (deduped by (workspaceId, name) — no slug column on help_categories)
 *   - 36 help articles   (deduped by (workspaceId, slug), all status:'published')
 *   - 10 guided tours    (deduped by (workspaceId, name); steps delete+reinsert each run)
 *
 * Also retires the 5 legacy demo tours that the 10 SDR tours supersede
 * (the non-overlapping legacy tours — "Adding Your First Lead", "Renewals & Churn
 * Risk AI" — are kept and still seeded by seedTours.ts).
 *
 * Ask AI is RAG over published articles, so seeding the articles IS the Ask-AI upgrade.
 *
 * Called from:
 *   - seedWorkspace()            → new workspaces get content at creation
 *   - seedHelpForAllWorkspaces() → one-time boot backfill for existing workspaces (index.ts)
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  helpArticles,
  helpCategories,
  tours,
  tourSteps,
  workspaces,
} from "../drizzle/schema";
import { getDb } from "./db";

type AnyDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/* ─── Categories (6) ─────────────────────────────────────────────────────── */

type CatSeed = { slug: string; name: string; icon: string; sortOrder: number };

// NOTE: HelpCenter.tsx renders cat.icon as a literal string (emoji), not a
// lucide component name — so these are emojis, matching the "📁" fallback.
const CATEGORIES: CatSeed[] = [
  { slug: "getting-started", name: "Getting Started", icon: "🚀", sortOrder: 1 },
  { slug: "prospecting", name: "Prospecting", icon: "🔍", sortOrder: 2 },
  { slug: "crm-pipeline", name: "CRM & Pipeline", icon: "📊", sortOrder: 3 },
  { slug: "sequences-email", name: "Sequences & Email", icon: "✉️", sortOrder: 4 },
  { slug: "are", name: "Autonomous Revenue Engine", icon: "🤖", sortOrder: 5 },
  { slug: "playbooks", name: "Daily Playbooks", icon: "📘", sortOrder: 6 },
  { slug: "meetings-calls", name: "Meetings & Calls", icon: "📞", sortOrder: 7 },
  { slug: "autopilots", name: "Autopilots & Automation", icon: "⚡", sortOrder: 8 },
  { slug: "settings-account", name: "Settings & Account", icon: "⚙️", sortOrder: 9 },
];

/* ─── Articles (36) ──────────────────────────────────────────────────────── */

type ArticleSeed = {
  slug: string;
  categorySlug: string;
  title: string;
  summary: string;
  readingTimeMinutes: number;
  tags: string[];
  pageKey?: string;
  /** Resolved to associatedTourId after tours are seeded. */
  tourName?: string;
  bodyMarkdown: string;
};

const ARTICLES: ArticleSeed[] = [
  {
    slug: "welcome-to-velocity",
    categorySlug: "getting-started",
    title: "Welcome to Velocity",
    summary: "What Velocity is and how an SDR's day flows through it.",
    readingTimeMinutes: 2,
    tags: ["getting-started", "overview", "sdr"],
    pageKey: "dashboard",
    tourName: "Getting Started",
    bodyMarkdown: `Velocity is your unified revenue workspace — prospecting, CRM, sequences, meetings, calls, and inbox in one place, so you never tab-hop between tools. As an SDR you'll spend most of your day in three areas: **Prospects/Find Prospects** (build your list), **Sequences & Conversations** (run outreach and handle replies), and **Pipeline/Contacts** (track what's working). The left sidebar starts with your personal quick links (Home, AI Assistant, Inbox, My Mailbox, My Calendar), then groups the work: *Prospect and enrich* (People, Companies, Find Prospects), *Engage* (Sequences, Emails, Calls, Tasks, Social), *Win deals* (Leads, Deals, Meetings, Conversations), *Customer success*, *Revenue Engine* (ARE), *Automation and analytics*, and *Inbound*. Much of the busywork can run on **Autopilot** — see "The Autonomy Control Center" for the Off / Approve / Auto switches. Start each day on **Home** for your numbers, then move into prospecting. New here? Run the **Getting Started** guided tour (Help Center → Tours) for a 3-minute walkthrough.`,
  },
  {
    slug: "navigating-the-app",
    categorySlug: "getting-started",
    title: "Navigating the app",
    summary: "Sidebar, global search, and command bar.",
    readingTimeMinutes: 2,
    tags: ["getting-started", "navigation"],
    bodyMarkdown: `The **sidebar** is your map — collapse it with the toggle, and it remembers your scroll position between pages. **Global search** (top bar, or ⌘K) jumps to any record or page by name. Page headers carry the primary action button on the right and a **sub-nav strip** beneath for related pages (e.g. Sequences → Email Drafts / Email Analytics). The **? button in the top bar** opens the Help drawer — articles for the page you're on, Ask AI, and guided tours — and the ? in the sidebar footer opens the full Help Center. Personal and workspace configuration lives in the **Settings hub** — open **Admin Settings** (bottom of the sidebar) → *All settings*, or head to /v2/settings. You can also pick a **colour theme** from the palette icon in the top bar; it syncs to your account. Tip: most list pages support inline filters and CSV export from the header.`,
  },
  {
    slug: "connect-email-linkedin",
    categorySlug: "getting-started",
    title: "Connect email & LinkedIn",
    summary: "Connect sending accounts and LinkedIn; why it matters for deliverability.",
    readingTimeMinutes: 3,
    tags: ["getting-started", "deliverability", "linkedin", "email"],
    pageKey: "connected-accounts",
    bodyMarkdown: `Before you send, connect your channels. **Email:** the guided way is **Settings → Mailboxes → Link mailbox** — a step-by-step wizard that connects your account (SMTP/IMAP single account or CSV bulk import), then walks you through signature, sending limits, and an opt-out link (see "Mailboxes & the guided setup wizard"). Power users can also manage sending accounts under **Connected Accounts**. **LinkedIn:** bridge your account at *My LinkedIn* for profile lookups, LinkedIn discovery, and social outreach — each team member connects their **own** LinkedIn. Watch the deliverability signals on each mailbox: setup completeness and daily send caps protect your sender reputation. **Never blast** — Velocity enforces per-account daily caps and a suppression list (unsubscribes + verified bounces) so you stay out of spam folders. If a LinkedIn search returns nothing, your bridge session may have expired — reconnect it.`,
  },
  {
    slug: "find-prospects-discovery",
    categorySlug: "prospecting",
    title: "Find Prospects: discovery",
    summary: "Use Find Prospects to discover net-new contacts.",
    readingTimeMinutes: 3,
    tags: ["prospecting", "discovery", "icp"],
    pageKey: "find-prospects",
    tourName: "Find Prospects",
    bodyMarkdown: `**Find Prospects** (sidebar → Prospect and enrich) runs multi-source discovery against your ICP. Pick **Person** or **Account** mode, fill the fields you care about (job title, seniority, industry, location) and add keywords for intent. Click **Run discovery** — results fan out across LinkedIn, web, and news, then get scored and de-duplicated automatically. Anything fully verified lands in **Verified**; partial matches land in **Needs Review** for you to clean up. Click any result row to open the full prospect. Skipped fields are ignored, so start broad and narrow if you get noise.`,
  },
  {
    slug: "needs-review-queue",
    categorySlug: "prospecting",
    title: "The Needs Review queue",
    summary: "Triage the Needs Review queue: verify, fix, or discard.",
    readingTimeMinutes: 3,
    tags: ["prospecting", "needs-review", "email-verification"],
    pageKey: "find-prospects",
    tourName: "Working Needs Review",
    bodyMarkdown: `The **Needs Review** tab holds prospects the system couldn't fully verify — usually a missing or risky email, or a LinkedIn URL that didn't validate. Each card shows an **ICP-fit score** (0–100) and a note explaining what needs attention. Click a card to open the prospect, then: fix the email (use **Find contact info** to scrape + verify patterns), confirm the LinkedIn URL, or **Archive** if it's junk. Prospects without a valid email can't be enrolled, so clear this queue daily — it's where good leads hide behind a quick fix. High-fit + verified prospects are your priority to move into a sequence.`,
  },
  {
    slug: "import-prospects-csv",
    categorySlug: "prospecting",
    title: "Import prospects from CSV",
    summary: "Bulk-import a list (LeadRocks, Apollo export, etc.).",
    readingTimeMinutes: 2,
    tags: ["prospecting", "import", "csv"],
    pageKey: "prospects",
    bodyMarkdown: `Have a list already? On **People**, open **Import → Import a CSV** (or use *Prospect and enrich → Import contacts*). Map your columns (name, title, company, email, LinkedIn URL) and import. Imported rows appear in your People list with an **email status** badge. CSV-imported prospects start without an ICP-fit score (that's only set by Discovery), so use the email-status filter to find the deliverable ones. From there, select and enroll into a sequence, or run **Find contact info** to verify emails before sending.`,
  },
  {
    slug: "understanding-scores-badges",
    categorySlug: "prospecting",
    title: "Understanding scores & badges",
    summary: "What the Fit score and email/verification badges mean.",
    readingTimeMinutes: 2,
    tags: ["prospecting", "icp", "scoring", "email-verification"],
    pageKey: "prospects",
    bodyMarkdown: `Two signals tell you whether a prospect is worth your time. **ICP-fit score** (the colored "Fit" number, 0–100) measures how well the prospect matches your target titles, industries, geos, and keywords — green ≥70 (strong), amber 40–69 (moderate), red <40 (weak). **Email status** tells you deliverability: *Valid* (safe to send), *Accept-All* / *Risky* (send with caution), *Invalid* (don't), *Unverified* (run a check first). Prioritize **high Fit + Valid email**. The verification badge (*Needs Review* vs *Verified*) reflects whether discovery could confirm the record's core fields.`,
  },
  {
    slug: "enroll-prospects-sequence",
    categorySlug: "prospecting",
    title: "Enroll prospects into a sequence",
    summary: "Move prospects into a sequence (no manual contact creation).",
    readingTimeMinutes: 2,
    tags: ["prospecting", "sequences", "enrollment"],
    pageKey: "prospects",
    tourName: "Enroll into a Sequence",
    bodyMarkdown: `Prospects enroll into sequences **natively** — you don't need to convert them to contacts first. From a sequence's **Enrollments → Enroll** dialog, open the **Prospects** tab, select the people you want (those without an email are disabled), and click Enroll. The send engine reads the email straight from the prospect record. You can also enroll from a prospect's detail page via **Add to sequence**. Dedup is automatic — already-enrolled prospects are skipped. Watch the toast for how many enrolled vs. were skipped or blocked for invalid email.`,
  },
  {
    slug: "sales-funnel-workflow",
    categorySlug: "crm-pipeline",
    title: "The sales funnel, end to end",
    summary: "How a name flows from Find Prospects to a closed Customer.",
    readingTimeMinutes: 4,
    tags: ["crm", "funnel", "workflow", "overview"],
    pageKey: "pipeline",
    bodyMarkdown: `Every record in Velocity moves through one funnel. **Find Prospects starts it** (scraped or imported names — not yet in the CRM proper), and the funnel ends with a closed **Customer**.

\`\`\`
Find Prospects  (scrape / import)        ← top of funnel
        |   outbound sequences · ARE
        v
   PROSPECT  --(replies / shows interest)-->  LEAD
                                               |  qualify
                                               v
                            Convert  -->  ACCOUNT + CONTACT + OPPORTUNITY
                                               |  pipeline stages
                                               |  (Discovery -> Qualified ->
                                               |   Proposal -> Negotiation)
                                               v
                    +-- CLOSED WON  -->  Account becomes a CUSTOMER
                    |                    (health · renewals · QBRs)
                    +-- CLOSED LOST -->  Account + Contact kept;
                                         re-engage later = a new opportunity
\`\`\`

**The one idea that makes this click:** separate the *who* from the *deal*.
**Accounts** (companies) and **Contacts** (people) are durable records that
persist across many deals. The **Opportunity** is the only thing that travels
the pipeline and closes Won or Lost.

**Step by step:**
1. **Prospect → Lead.** A prospect who replies or shows interest is converted to a **Lead** (Prospects table → *Convert to lead*). Leads are scored and routed.
2. **Lead → Opportunity.** When a lead qualifies, **Convert** it (Leads page) — this creates the **Account** (company), a primary **Contact** (person), and an **Opportunity** (the deal) in one step, and marks the lead converted.
3. **Work the Opportunity** through the Pipeline stages.
4. **Closed Won** → the account automatically becomes a **Customer**, handing off to the post-sale module (health score, renewals, QBRs). **Closed Lost** → the Account and Contact are kept for future re-engagement; you open a *new* opportunity when the time is right.

You rarely create Accounts or Contacts by hand — they're produced by converting a lead. Keep new outbound names as **Prospects** and promote them as they engage.`,
  },
  {
    slug: "leads-contacts-accounts",
    categorySlug: "crm-pipeline",
    title: "Prospects, Leads, Contacts & Accounts",
    summary: "What each record type is for, and how one becomes the next.",
    readingTimeMinutes: 3,
    tags: ["crm", "data-model"],
    pageKey: "leads",
    bodyMarkdown: `Five record types, each with one job. **Prospects** = your raw outbound list (discovery + CSV), not yet engaged. **Leads** = individuals who've shown interest and are being scored/qualified. **Accounts** = the companies you're working (hierarchy + ARR rollup). **Contacts** = the people inside those accounts. **Customers** = accounts that have closed won (post-sale: health, renewals, QBRs). The flow: a **Prospect** who engages becomes a **Lead**; a qualified Lead is **converted**, which creates the **Account + Contact + Opportunity** together; when the Opportunity is **Closed Won**, the account becomes a **Customer**. Accounts and Contacts are durable; the Opportunity is what moves through the pipeline. See "The sales funnel, end to end" for the full picture. Don't over-think it early — keep new outbound names as Prospects and promote as they engage.`,
  },
  {
    slug: "managing-pipeline",
    categorySlug: "crm-pipeline",
    title: "Managing your pipeline",
    summary: "Work the kanban: stages, moving deals, AI suggestions.",
    readingTimeMinutes: 3,
    tags: ["crm", "pipeline", "kanban"],
    pageKey: "pipeline",
    tourName: "Master the Pipeline",
    bodyMarkdown: `Your pipeline lives under **Win deals → Deals** — a kanban of opportunities grouped by stage (discovery → qualified → proposal → negotiation → won/lost), with the Deal Autopilot layered on top; the classic board also remains at /pipeline. Drag a card between columns to change its stage, or — keyboard/no-mouse — focus a card (Tab) and use the **◀ / ▶ Move** buttons on it. Cards show value, win probability, and AI next-best-actions; if AI suggests a stage change you'll see an **Accept** chip. Use the view toggle for the **Forecast** rollup. Every stage move is recorded in the opportunity's stage history. Keep stages honest — the forecast and alerts depend on it.`,
  },
  {
    slug: "logging-activities",
    categorySlug: "crm-pipeline",
    title: "Logging activities",
    summary: "Log calls, meetings, and notes on records.",
    readingTimeMinutes: 2,
    tags: ["crm", "activities", "notes"],
    bodyMarkdown: `On any contact, lead, account, or opportunity detail page, the **Activities** tab lets you log a call (disposition, duration, outcome, notes), a meeting, or a quick note. The **Notes** tab keeps pinnable notes. Logged activity feeds the record timeline and pipeline-health alerts (e.g. "no activity in 14 days"). Make logging a reflex after every touch — it's what makes the CRM useful to future-you and your manager, and it powers the stalled-deal alerts.`,
  },
  {
    slug: "opportunities-deep-dive",
    categorySlug: "crm-pipeline",
    title: "Opportunities deep dive",
    summary: "Win probability, stages, and win/loss reasons.",
    readingTimeMinutes: 2,
    tags: ["crm", "opportunities", "forecasting"],
    pageKey: "pipeline",
    bodyMarkdown: `An **Opportunity** is a deal on an account. It carries a value, a stage, and a win probability (AI-generated when intelligence has run, else the stage default). When you move a deal to **Won** or **Lost**, capture the **win/loss reason** in the inline editor on the detail page — this field now persists correctly and feeds win/loss analysis. Use the **Related Tasks** widget to keep next steps attached to the deal. Opportunities live on the Pipeline board; see "Managing your pipeline" for moving them.`,
  },
  {
    slug: "build-a-sequence",
    categorySlug: "sequences-email",
    title: "Build a sequence",
    summary: "Create a multi-step email/task cadence.",
    readingTimeMinutes: 4,
    tags: ["sequences", "outreach", "cadence"],
    pageKey: "sequences",
    tourName: "Build Your First Sequence",
    bodyMarkdown: `**Sequences** (sidebar → Engage) are multi-step cadences. Click **New sequence**, then add steps: email steps (subject + body, with \`{{firstName}}\`, \`{{company}}\`, \`{{senderName}}\` merge fields), **wait** steps (delays), and **task** steps (manual to-dos). Apply an Email Builder template to a step, or write inline. Use the **Canvas** view for a visual builder or the list/Edit view — they stay in sync. Set day caps and auto-stop rules so replies pause the sequence. When ready, **Activate** it, then enroll prospects/contacts/leads (see "Enroll prospects into a sequence"). The engine creates and sends drafts on cadence.`,
  },
  {
    slug: "email-builder-templates",
    categorySlug: "sequences-email",
    title: "Email Builder & templates",
    summary: "Design reusable email templates.",
    readingTimeMinutes: 3,
    tags: ["sequences", "email-builder", "templates"],
    bodyMarkdown: `**Email Builder** is a 3-panel drag-and-drop designer for HTML email templates — content blocks on the left, canvas in the middle, properties on the right (all panels resize and persist). Build reusable layouts for sequences and campaigns, preview on mobile, and **Publish** when ready (drafts show a badge). Published and draft templates both appear in the sequence step picker. Use the **Snippet Library** (header sub-nav) for reusable text fragments you drop into templates.`,
  },
  {
    slug: "unified-inbox",
    categorySlug: "sequences-email",
    title: "The Unified Inbox",
    summary: "Handle replies across channels in one inbox.",
    readingTimeMinutes: 3,
    tags: ["inbox", "replies", "sequences"],
    pageKey: "unified-inbox",
    tourName: "Handle Replies (Unified Inbox)",
    bodyMarkdown: `The **Unified Inbox** consolidates inbound replies across every connected email account. Conversations list on the left; open one to read the thread and reply, forward, or log it to a CRM record without leaving the page. An inbound reply automatically **pauses** the prospect's sequence and mirrors to the record timeline, so you won't double-touch someone who already answered. Use the channel filter to focus. Header shortcuts: **Refresh**, **Manage Accounts**, and **Email Drafts**.`,
  },
  {
    slug: "email-drafts-sending",
    categorySlug: "sequences-email",
    title: "Email Drafts & sending safely",
    summary: "Review AI/sequence drafts and send safely.",
    readingTimeMinutes: 3,
    tags: ["email-drafts", "sending", "deliverability"],
    pageKey: "email-drafts",
    tourName: "AI Pipeline: Review Drafts",
    bodyMarkdown: `**Email Drafts** is the review queue for messages sequences and AI created. Each draft can be edited, approved, or rejected. **Send** (single) and **Send All Approved** now require a quick confirm — because sends are real and can't be recalled. Before sending, drafts are checked against the **suppression list** (unsubscribes + verified bounces) and per-account daily caps. Filter by status (pending review / approved / sent / bounced). Bounces here flow back to deliverability data — keep an eye on the bounced tab.`,
  },
  {
    slug: "are-overview",
    categorySlug: "are",
    title: "ARE overview",
    summary: "What the Autonomous Revenue Engine does.",
    readingTimeMinutes: 3,
    tags: ["are", "automation", "overview"],
    pageKey: "are",
    tourName: "ARE: Autonomous Campaigns",
    bodyMarkdown: `The **Autonomous Revenue Engine (ARE)** runs prospecting on autopilot. Per campaign it **discovers** prospects against your ICP (rotating through query "slices" for coverage), **enriches** the best-fit ones, generates **sequences/drafts**, and — depending on autonomy mode — sends or queues them for your approval. The ARE Hub shows the pipeline funnel (discovered → enriched → approved → contacted → replied → meetings) and per-agent status. Think of ARE as a junior SDR that fills your top-of-funnel while you work replies and live deals.`,
  },
  {
    slug: "are-tuning-campaign",
    categorySlug: "are",
    title: "Tuning an ARE campaign",
    summary: "Configure autonomy mode, the fit gate, and throttles.",
    readingTimeMinutes: 3,
    tags: ["are", "automation", "configuration"],
    pageKey: "are",
    bodyMarkdown: `Open a campaign → **Settings** to tune it. **Autonomy mode**: *Full* (discover→send, no human), *Batch approval* (you approve batches), *Review & release* (approve each). **Enrichment fit gate (minConfidence)**: only prospects whose ICP-fit score clears this threshold get enriched — raise it to save budget on weak fits, lower it for volume (default 40). **Auto-approve threshold**: auto-approve prospects above a fit score. Set the **daily send cap** and channels. Targeting (titles/industries/geos/keywords) drives discovery — weak targeting = weak prospects, so invest here first.`,
  },
  {
    slug: "sdr-morning-routine",
    categorySlug: "playbooks",
    title: "SDR morning routine",
    summary: "The recommended morning prospecting block.",
    readingTimeMinutes: 4,
    tags: ["playbook", "routine", "sdr"],
    pageKey: "dashboard",
    bodyMarkdown: `A repeatable morning beats heroics. **1) Home (5 min):** scan your numbers and overdue tasks. **2) Inbox & replies (15 min):** clear **Conversations** and the **Unified Inbox** — every reply gets a response or a logged next step; sequences auto-pause on reply so focus on movers. **3) Needs Review (15 min):** triage the **Find Prospects → Needs Review** queue — fix emails, verify, archive junk (see "The Needs Review queue"). **4) Build list (20 min):** run **Find Prospects** against today's ICP slice; enroll high-Fit + Valid-email prospects into the right sequence. **5) Approve drafts (10 min):** clear **Email Drafts** / **AI Pipeline** so the engine keeps sending. Then spend the rest of the day on live conversations and pipeline.`,
  },
  {
    slug: "crm-hygiene-eod",
    categorySlug: "playbooks",
    title: "CRM hygiene (end of day)",
    summary: "End-of-day CRM hygiene checklist.",
    readingTimeMinutes: 3,
    tags: ["playbook", "crm", "hygiene"],
    bodyMarkdown: `Five minutes at EOD keeps your pipeline trustworthy. **✓ Log every touch** — calls, meetings, notes on the relevant record (see "Logging activities"). **✓ Update stages** — move any opportunity that progressed; honest stages = honest forecast. **✓ Capture win/loss reasons** on closed deals. **✓ Set next steps** — add a task to every active deal/contact so nothing goes dark (pipeline alerts catch 14-day silence, but don't rely on them). **✓ Clear approvals** — leave the Email Drafts queue empty so overnight sends fire. Consistency here is what separates the top of the leaderboard from the rest.`,
  },
  {
    slug: "weekly-pipeline-review",
    categorySlug: "playbooks",
    title: "Weekly pipeline review",
    summary: "A simple weekly self-review.",
    readingTimeMinutes: 3,
    tags: ["playbook", "pipeline", "review"],
    pageKey: "pipeline",
    bodyMarkdown: `Once a week, step back. Open **Deals** (Win deals — use the Forecast view) and **Email Analytics**: Which sequences/steps get opens and replies? Which stages are stalling (check **Pipeline Alerts**)? Re-rank your prospecting: double down on the ICP slices and sequences that produce meetings, and retire the ones that don't. Update your ARE campaign's fit gate/targeting based on what actually converted. Archive dead prospects so your lists stay clean. A 20-minute weekly review compounds.`,
  },

  /* ── Prospecting: LinkedIn enrichment + social outreach ─────────────────── */
  {
    slug: "linkedin-enrichment",
    categorySlug: "prospecting",
    title: "LinkedIn enrichment & job-change alerts",
    summary: "Enrich prospects from LinkedIn compliantly, review uncertain matches, and catch job changes.",
    readingTimeMinutes: 3,
    tags: ["prospecting", "linkedin", "enrichment", "job-change"],
    bodyMarkdown: `**LinkedIn enrichment** fills a prospect's title, company, location, and profile photo from their LinkedIn profile — via your own connected LinkedIn account (compliant API access, never scraping). Run it from any prospect (**Enrich**), from the People table's row action, or in bulk from the selection toolbar. Lookups are capped per LinkedIn account per day, so large batches run as jobs and continue after the cap resets.\n\nWhen a profile match is uncertain, the prospect lands in the **review queue** at **Data Enrichment → LinkedIn enrichment** — open each item, compare the found profile against your record, and apply or skip. Conflicts (the profile disagrees with your data) wait for your call.\n\nEnrichment also powers **Job change alerts** (Data Enrichment → Job change alerts): when a re-check detects a prospect moved companies or changed title, it's flagged in the feed, and the **Job Change Autopilot** (Off / Approve / Auto) can create a re-engagement task automatically — job changes are the warmest reason to reach back out.`,
  },
  {
    slug: "linkedin-social-outreach",
    categorySlug: "prospecting",
    title: "LinkedIn social outreach",
    summary: "Search, invite, warm, and message prospects on LinkedIn — autonomously when you want.",
    readingTimeMinutes: 4,
    tags: ["prospecting", "linkedin", "social", "outreach"],
    pageKey: "social",
    bodyMarkdown: `Velocity runs a full LinkedIn motion through each rep's **own** connected account (see *My LinkedIn* / Connected Accounts):\n\n1. **Search & import** — on **Find Prospects**, the *LinkedIn search* card queries LinkedIn (and Sales Navigator where available) and imports results as prospects.\n2. **Connection invites** — the **Social Autopilot** (Autonomy Control Center) sends invites to un-invited leads on a safe hourly cadence with a hard daily cap per workspace.\n3. **Pre-invite warming** — before inviting, the autopilot can engage a prospect's latest post (a like) so your name isn't cold.\n4. **Accept → opener DM** — when someone accepts, an AI opener DM goes out from your account (Approve or Auto, your choice).\n5. **Replies** — inbound DMs land in **Conversations → Social**, get AI-classified, and a "willing to meet" reply can automatically receive your booking link.\n\nThe **Social** page's *Network* tab shows pending invitations and connections, plus post tools (compose, like, comment) for manual engagement. Track the whole funnel — invites → accepts → replies → meetings — in **Analytics**.`,
  },

  /* ── Sequences & Email: conversations autopilot + sending prefs ─────────── */
  {
    slug: "conversations-autopilot",
    categorySlug: "sequences-email",
    title: "Conversations & the reply Autopilot",
    summary: "Every inbound reply, AI-classified and acted on — email, social, and agent calls in one place.",
    readingTimeMinutes: 3,
    tags: ["conversations", "autopilot", "replies", "ai"],
    bodyMarkdown: `**Conversations** (Engage) is where inbound replies get handled. Three channels sit in the header toggle: **Email** (sequence replies), **Social** (LinkedIn DMs), and **Calls** (AI voice-agent phone calls with transcripts).\n\nThe **reply Autopilot** classifies each inbound reply into one of eight classes (willing to meet, needs info, objection, not interested, unsubscribe, out-of-office, wrong person, other) and acts per class. Modes: **Off** (you do everything), **Approve** (AI classifies and suggests; you apply), **Auto** (AI classifies *and* acts). The flagship autonomous move: a **"willing to meet"** reply automatically sends your self-serve **booking link** — on email and social — so the prospect books a real calendar slot with zero back-and-forth.\n\nUnsubscribes are suppressed automatically, out-of-offices pause and resume later, and every handled reply is marked on the thread. Use **Classify with AI** to catch up a backlog. Watch the stat cards (unhandled / willing to meet / meetings from replies) to see the loop closing.`,
  },
  {
    slug: "email-sending-preferences",
    categorySlug: "sequences-email",
    title: "Email sending preferences & opt-out",
    summary: "Open/click tracking, one-click unsubscribe headers, and the sequence opt-out footer.",
    readingTimeMinutes: 2,
    tags: ["email", "deliverability", "compliance", "unsubscribe"],
    bodyMarkdown: `Workspace-wide sending preferences live in **Settings → Profile → Email settings** (admins only):\n\n- **Open tracking / Click tracking** — toggles the tracking pixel and wrapped links on sequence sends. Turn either off and sends go out clean.\n- **One-click unsubscribe headers** — adds RFC 8058 List-Unsubscribe headers so Gmail/Outlook show their native unsubscribe button. Recommended for high-volume senders; unsubscribes land in the suppression list automatically.\n- **Sequence opt-out message** — appends a footer after your signature in sequence emails. Write the message and mark the clickable words with \`<%\` and \`%>\` — e.g. *If you don't want to hear from me, you can <%unsubscribe here%>.* The bracket becomes a real one-click unsubscribe link tied to that recipient.\n\nEvery send already respects the **suppression list** (unsubscribes + verified bounces) and per-mailbox daily caps regardless of these settings. Your per-mailbox signature and limits are set in the Mailboxes wizard, not here.`,
  },

  /* ── Meetings & Calls ────────────────────────────────────────────────────── */
  {
    slug: "booking-links",
    categorySlug: "meetings-calls",
    title: "Self-serve booking links",
    summary: "A public scheduling page that books straight into your calendar.",
    readingTimeMinutes: 3,
    tags: ["meetings", "booking", "calendar"],
    bodyMarkdown: `Your **booking link** is a public page (velocity → /b/your-slug) where a prospect picks a time that books a **real calendar event** with you — no email ping-pong. Find and share it from **Meetings** (the booking card): copy the link, set your **availability** (working hours, days, timezone — slots respect them and daylight saving), and it's live.\n\nBookings create the calendar invite via your connected calendar, notify you in-app, and log the booker as an inbound lead with the meeting on their timeline. Double-booking is prevented against your existing events.\n\nTwo places it works automatically: the \`{{bookingLink}}\` merge field drops your link into any sequence email, and the **reply Autopilot** in Auto mode sends it when a prospect replies "happy to chat" (email or LinkedIn). Pair it with **meeting reminders** (sent automatically before the call) to cut no-shows.`,
  },
  {
    slug: "meeting-autopilot-reminders",
    categorySlug: "meetings-calls",
    title: "Meeting Autopilot, reminders & no-shows",
    summary: "AI proposes and books meetings; reminders and no-show rebounds run themselves.",
    readingTimeMinutes: 3,
    tags: ["meetings", "autopilot", "reminders", "no-show"],
    bodyMarkdown: `The **Meeting Autopilot** (Autonomy Control Center, Off / Approve / Auto) turns positive replies into booked meetings: it proposes times, and in Auto mode books the event on your connected calendar with the prospect as attendee.\n\nAround every booked meeting:\n\n- **Reminders** — each attendee gets an automatic reminder email in the day before the meeting, with join and reschedule links. Nothing to configure beyond a connected sending setup.\n- **Dispositions** — after the meeting, mark it completed/no-show on **Meetings**.\n- **No-show rebound** — marking a **no-show** auto-creates a high-priority *Re-book* follow-up task on the right record, assigned to you, so missed meetings never silently die.\n\nEach team member connects their **own** calendar (Outlook/Google) so invites come from the actual rep. Inbound self-booking is covered by your booking link (see "Self-serve booking links").`,
  },
  {
    slug: "voice-agents",
    categorySlug: "meetings-calls",
    title: "AI voice agents (Grok)",
    summary: "Phone agents that answer prospect call-backs on a rep's behalf and log transcripts to the CRM.",
    readingTimeMinutes: 4,
    tags: ["calls", "voice", "ai", "grok", "phone"],
    bodyMarkdown: `**Voice agents** are AI phone agents powered by xAI's Grok Voice. Their headline job today: when a prospect **calls back** a registered number, the agent answers **on behalf of the team member**, has a natural conversation, takes a detailed message, and logs everything.\n\n**Setup (admin, ~10 minutes):**\n1. **Settings → Voice agents** → add your **xAI API key** (from console.x.ai) and hit *Test connection*.\n2. **Create an agent** — name, voice, purpose (*Call-back* answers for a chosen member; each member can also create their own), and optional custom instructions (a professional receptionist script is used if you leave it blank).\n3. **Register your phone number** in the xAI console against the **webhook URL** shown on the page, and paste the signing secret into the agent. Done — calls to that number are now answered by the agent.\n\n**Where calls show up:** the **Calls** page (agent panel + call log with expandable transcripts), **Conversations → Calls** channel, an Inbox notification for the member each time their agent answers, and — when the caller's number matches a contact, lead, or prospect — a logged **call activity on that record's timeline** with the transcript.\n\n*Note:* automated **outbound** calling isn't available yet — xAI hasn't released the outbound-call API. The moment they do, outreach dialing lands here.`,
  },
  {
    slug: "calls-page",
    categorySlug: "meetings-calls",
    title: "The Calls page",
    summary: "Your call-task queue plus the AI voice-agent call log.",
    readingTimeMinutes: 2,
    tags: ["calls", "tasks", "voice"],
    bodyMarkdown: `**Calls** (Engage) is two things on one page:\n\n1. **Your call queue** — every task of type *call* across your records, sorted by due date, with overdue/due-today counters. Check one off and log the outcome on the record; schedule new call tasks from any contact, lead, or account.\n2. **AI voice agents** — the agent strip shows each configured Grok agent (who it answers for, its number, active/paused), and the **agent call log** lists inbound call-backs and their status, duration, and — click any row — the full **transcript digest** of what the AI discussed with the caller.\n\nManage agents (voices, instructions, numbers) via **Manage agents**, which opens Settings → Voice agents. Phone-number setup and how answering works are covered in "AI voice agents (Grok)".`,
  },

  /* ── Autopilots & Automation ─────────────────────────────────────────────── */
  {
    slug: "autonomy-control-center",
    categorySlug: "autopilots",
    title: "The Autonomy Control Center",
    summary: "Every Autopilot in one place — Off, Approve, or Auto.",
    readingTimeMinutes: 3,
    tags: ["autopilot", "automation", "ai", "autonomy"],
    pageKey: "workflows",
    bodyMarkdown: `Velocity's automation follows one convention everywhere: each feature has an **Autopilot** with three modes — **Off** (fully manual), **Approve** (AI drafts, you confirm), **Auto** (hands-off). All the switches live in the **Autonomy Center** (sidebar → Automation and analytics), and each surface also shows its own toggle.\n\nThe autopilots:\n- **Task** — drafts next-best-action tasks from record signals.\n- **Meeting** — proposes and (in Auto) books meetings from positive replies.\n- **Conversation** — classifies every inbound reply and acts per class; in Auto, a "willing to meet" reply gets your booking link instantly.\n- **Deal** — nudges stalled opportunities with suggested actions.\n- **Social** — sends LinkedIn invites, warms prospects, and opens conversations on accept.\n- **Job change** — creates re-engagement tasks when enrichment detects a company move.\n\nEverything defaults to **Off** — turn things on one at a time, run Approve mode until you trust the output, then go Auto. The goal: the machine works the funnel while you talk to humans.`,
  },
  {
    slug: "workflow-rules",
    categorySlug: "autopilots",
    title: "Workflow rules",
    summary: "If-this-then-that automation on CRM events.",
    readingTimeMinutes: 2,
    tags: ["workflows", "automation", "rules"],
    pageKey: "workflows",
    bodyMarkdown: `**Workflow rules** (sidebar → Automation and analytics → Workflow rules) are event-triggered if-this-then-that automations, separate from the AI autopilots (those live in the Autonomy Center). A rule pairs a **trigger** with one or more **actions**.\n\n**Live triggers:** *record created* (a lead is created), *stage changed* (an opportunity moves), *signal received* (a job change is detected on a prospect), and *deal stuck* (no movement past your threshold, checked on a schedule).\n\n**Actions:** call a **webhook**, post to **Slack** or **Teams**, **create a task**, or send an in-app **notification**. Conditions let you scope a rule (e.g. only deals over a value, only stage = negotiation).\n\nUse **Test fire** on any rule to run its actions immediately with sample context — it exercises the exact same code path as the real trigger, so if the test posts to Slack, the real event will too. Every run is recorded in the rule's history with success/failure.`,
  },

  /* ── CRM: landing pages & web forms ──────────────────────────────────────── */
  {
    slug: "landing-pages-web-forms",
    categorySlug: "crm-pipeline",
    title: "Landing pages, web forms & visitor tracking",
    summary: "Capture inbound interest and route it into the funnel automatically.",
    readingTimeMinutes: 3,
    tags: ["landing-pages", "forms", "inbound", "tracking"],
    bodyMarkdown: `Three inbound tools feed your funnel without manual entry:\n\n- **Landing pages** (admin) — build simple hosted pages in the Landing Pages builder; each publishes at a public /l/your-slug URL with an optional lead-capture form. Submissions become leads instantly.\n- **Web forms** — embeddable forms whose submissions run **autonomous lead routing**: the lead is created, scored, routed to an owner, and **bridged** into the funnel — a company account is found-or-created from the corporate email domain (free-mail domains never become accounts) and a linked prospect is created, ready for sequences. Review the bridge on Data Enrichment → Form enrichment.\n- **Website visitor tracking** — a first-party snippet logs page views on your site. Visits from **known** prospects (they clicked a tracked link) are attributed to their record, and a high-intent visit (pricing, demo pages) fires an automatic follow-up task. Anonymous visitor de-anonymization isn't included — Velocity only claims what it can actually see.`,
  },

  /* ── Settings & Account ──────────────────────────────────────────────────── */
  {
    slug: "settings-hub",
    categorySlug: "settings-account",
    title: "The Settings hub",
    summary: "Profile, appearance, mailboxes, voice agents, and workspace admin in one place.",
    readingTimeMinutes: 2,
    tags: ["settings", "profile", "account"],
    bodyMarkdown: `All configuration lives in the **Settings hub** — open **Admin Settings** (bottom of the sidebar) → *All settings*. The left rail groups everything:\n\n- **Personal settings** — your **Profile** (name, title, change email/password, appearance theme, multi-factor authentication, email settings) and **Mailboxes** (link and configure sending accounts via the guided wizard).\n- **Workspace settings** (admins) — workspace overview, users & teams, security, integrations, **Voice agents**, email delivery, branding, billing, and the system activity log.\n- **Data management** — custom fields, imports & exports, and data enrichment.\n\nProfile changes save with the **Save** button top-right; appearance (your colour theme) syncs to your account so it follows you across browsers. Rows that point to a dedicated page (Team, Audit, Integrations) open it directly — the search box at the top of the rail finds any setting fast.`,
  },
  {
    slug: "mfa-security",
    categorySlug: "settings-account",
    title: "Multi-factor authentication",
    summary: "Protect your account with an authenticator app.",
    readingTimeMinutes: 2,
    tags: ["security", "mfa", "2fa", "account"],
    bodyMarkdown: `Velocity supports **TOTP multi-factor authentication** — the standard authenticator-app codes (Google Authenticator, 1Password, Authy…).\n\n**Enable it:** Settings → Profile → **Multi-factor authentication** tab → *Authenticator App* → **Set up**. Add the secret to your authenticator (link or manual key), then confirm with a live 6-digit code. From then on, password sign-ins require your current code.\n\n**Disable it** from the same tab — you'll need a current code or your password. If you sign in with a linked provider instead of a password, MFA protects the password path specifically.\n\nSMS codes aren't offered (no SMS gateway is connected), and the tab says so honestly. Admins can review sign-in activity under **System activity**. One habit worth keeping: set up MFA the same day you set a password.`,
  },
  {
    slug: "mailboxes-guided-setup",
    categorySlug: "settings-account",
    title: "Mailboxes & the guided setup wizard",
    summary: "Link sending mailboxes and configure signature, limits, and opt-out — step by step.",
    readingTimeMinutes: 3,
    tags: ["mailboxes", "email", "smtp", "deliverability", "settings"],
    bodyMarkdown: `**Settings → Mailboxes** manages the accounts your sequences send from. Click **Link mailbox** to start the guided wizard:\n\n1. **Link** — pick your provider. *Other (SMTP/IMAP)* connects a single account with a **live Test SMTP** check before saving, or use **Bulk Import via CSV** (sample file provided, up to 100 accounts at once).\n2. **Configure** — three quick modules: **Signature** (used on that mailbox's sends), **Sending limits** (daily cap, hourly cap, delay between emails — the defaults are deliverability-safe), and **Opt-out link** (an unsubscribe footer for that mailbox).\n3. **Finish** — the overview shows a ✓/✗ per module; *Fix Configuration Issues* jumps you to whatever's incomplete.\n\nThe mailbox table shows each account's **setup %**, daily usage against its cap, deliverability signal, and aliases. Row menu: test the connection, refresh aliases, configure, set default, or unlink. Setup progress matters — a complete configuration (signature + limits + opt-out) is what keeps your mail out of spam folders.`,
  },
];

/* ─── Tours (10) ─────────────────────────────────────────────────────────── */

type StepSeed = {
  title: string;
  bodyMarkdown: string;
  targetDataTourId?: string;
  /** Defaults to the tour's route when omitted. */
  routeTo?: string;
  visualTreatment: "spotlight" | "pulse" | "arrow" | "coach";
  advanceCondition: "next_button" | "element_clicked" | "route_changed";
};

type TourSeed = {
  name: string;
  description: string;
  type: "onboarding" | "feature" | "whats_new" | "custom";
  estimatedMinutes: number;
  /** Bare first-path-segment key (matches routeToPageKey in HelpDrawer). */
  pageKey: string;
  /** Default route used for steps that don't override routeTo. */
  route: string;
  roleTags: string[];
  steps: StepSeed[];
};

const TOURS: TourSeed[] = [
  {
    name: "Getting Started",
    description: "Quick 3-minute tour of where you'll work each day.",
    type: "onboarding",
    estimatedMinutes: 3,
    pageKey: "dashboard",
    route: "/dashboard",
    roleTags: ["sdr"],
    steps: [
      { title: "Welcome to Velocity", bodyMarkdown: "Quick 3-min tour of where you'll work each day.", routeTo: "/dashboard", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Your sidebar", bodyMarkdown: "Quick links up top (Home, AI Assistant, Inbox, Mailbox, Calendar), then the work: Prospect and enrich, Engage, Win deals, Revenue Engine, and more.", targetDataTourId: "sidebar-nav", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Your daily numbers", bodyMarkdown: "The Dashboard is your morning home — pipeline, leads, customers.", targetDataTourId: "dashboard-kpi-grid", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Help anytime", bodyMarkdown: "Click the ? in the top bar for contextual articles, Ask AI, and these tours — on any page.", targetDataTourId: "help-button", visualTreatment: "pulse", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Your Daily Dashboard",
    description: "The KPIs, trend, and recent deals you scan every morning.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "dashboard",
    route: "/dashboard",
    roleTags: ["sdr"],
    steps: [
      { title: "KPIs at a glance", bodyMarkdown: "Pipeline value, closed-won, leads, customers — vs. goal.", targetDataTourId: "dashboard-kpi-grid", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Revenue trend", bodyMarkdown: "Track momentum month over month.", targetDataTourId: "dashboard-revenue-chart", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Recent opportunities", bodyMarkdown: "Jump straight into active deals.", targetDataTourId: "dashboard-recent-opps", visualTreatment: "spotlight", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Find Prospects",
    description: "Discover net-new prospects across multiple sources.",
    type: "feature",
    estimatedMinutes: 3,
    pageKey: "find-prospects",
    route: "/find-prospects",
    roleTags: ["sdr"],
    steps: [
      { title: "Discover net-new prospects", bodyMarkdown: "Multi-source discovery against your ICP.", routeTo: "/find-prospects", visualTreatment: "coach", advanceCondition: "route_changed" },
      { title: "Pick a mode", bodyMarkdown: "Person or Account — fill only the fields you care about.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Run discovery", bodyMarkdown: "Results fan out across LinkedIn, web, and news, then get scored + deduped.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Verified vs Needs Review", bodyMarkdown: "Clean matches land in Verified; partials in Needs Review for you to fix.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Working Needs Review",
    description: "Triage and clear the Needs Review queue.",
    type: "feature",
    estimatedMinutes: 3,
    pageKey: "find-prospects",
    route: "/find-prospects",
    roleTags: ["sdr"],
    steps: [
      { title: "Why review?", bodyMarkdown: "These prospects need an email fixed or a LinkedIn URL confirmed.", routeTo: "/find-prospects", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Read the Fit score + note", bodyMarkdown: "The score (0–100) and the amber note tell you what to do.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Open & fix", bodyMarkdown: "Click a card → Find contact info to verify the email, or Archive junk.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Then enroll", bodyMarkdown: "High-Fit + Valid email → into a sequence.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Enroll into a Sequence",
    description: "Move prospects into a sequence natively.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "prospects",
    route: "/sequences",
    roleTags: ["sdr"],
    steps: [
      { title: "From prospect to outreach", bodyMarkdown: "Prospects enroll natively — no contact conversion needed.", routeTo: "/sequences", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Open Enroll", bodyMarkdown: "In a sequence's Enrollments, click Enroll → Prospects tab.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Select & go", bodyMarkdown: "Pick prospects (no-email rows are disabled), click Enroll. The engine sends.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Build Your First Sequence",
    description: "Create a multi-step email + wait + task cadence.",
    type: "feature",
    estimatedMinutes: 4,
    pageKey: "sequences",
    route: "/sequences",
    roleTags: ["sdr"],
    steps: [
      { title: "Create a cadence", bodyMarkdown: "Multi-step email + wait + task steps.", targetDataTourId: "sequences-new-button", visualTreatment: "pulse", advanceCondition: "element_clicked" },
      { title: "Add steps", bodyMarkdown: "Email (with merge fields), waits, and tasks; apply a template or write inline.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Activate & enroll", bodyMarkdown: "Turn it on, then enroll prospects/contacts/leads.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Master the Pipeline",
    description: "Work the kanban board, move deals, and read the forecast.",
    type: "feature",
    estimatedMinutes: 3,
    pageKey: "pipeline",
    route: "/pipeline",
    roleTags: ["sdr"],
    steps: [
      { title: "Your deals as a board", bodyMarkdown: "Opportunities grouped by stage.", targetDataTourId: "pipeline-board", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Move a deal", bodyMarkdown: "Drag, or focus a card and use the ◀/▶ Move buttons.", targetDataTourId: "pipeline-board", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Forecast view", bodyMarkdown: "Toggle to the per-rep rollup.", targetDataTourId: "pipeline-view-toggle", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Add an opportunity", bodyMarkdown: "New deals start here.", targetDataTourId: "pipeline-new-button", visualTreatment: "pulse", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Handle Replies (Unified Inbox)",
    description: "Triage inbound replies across every connected account.",
    type: "feature",
    estimatedMinutes: 3,
    pageKey: "unified-inbox",
    route: "/unified-inbox",
    roleTags: ["sdr"],
    steps: [
      { title: "All replies, one place", bodyMarkdown: "Inbound across every connected account.", routeTo: "/unified-inbox", visualTreatment: "coach", advanceCondition: "route_changed" },
      { title: "Reply & log", bodyMarkdown: "Respond, forward, or log to a CRM record without leaving.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Auto-pause", bodyMarkdown: "A reply pauses that prospect's sequence automatically.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "ARE: Autonomous Campaigns",
    description: "How the Autonomous Revenue Engine runs prospecting for you.",
    type: "feature",
    estimatedMinutes: 4,
    pageKey: "are",
    route: "/are",
    roleTags: ["sdr"],
    steps: [
      { title: "Prospecting on autopilot", bodyMarkdown: "ARE discovers, enriches, sequences, and (optionally) sends.", targetDataTourId: "are-command-card", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "The agents", bodyMarkdown: "ICP, Enrich, and outreach agents do the work.", targetDataTourId: "are-agents-section", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Active campaigns", bodyMarkdown: "Monitor funnel flow per campaign.", targetDataTourId: "are-active-campaigns", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Tune it", bodyMarkdown: "Set autonomy mode + the enrichment fit gate in campaign Settings.", routeTo: "/are/campaigns", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "AI Pipeline: Review Drafts",
    description: "Review, edit, and bulk-approve AI-drafted outreach.",
    type: "feature",
    estimatedMinutes: 3,
    pageKey: "ai-pipeline",
    route: "/ai-pipeline",
    roleTags: ["sdr"],
    steps: [
      { title: "AI-drafted outreach", bodyMarkdown: "Review what the engine prepared.", targetDataTourId: "ai-queue-stats", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "The draft queue", bodyMarkdown: "Edit, approve, or reject each.", targetDataTourId: "ai-queue-draft-list", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Approve in bulk", bodyMarkdown: "Clear the queue so sends fire.", targetDataTourId: "ai-queue-approve-all", visualTreatment: "pulse", advanceCondition: "next_button" },
    ],
  },
];

/** Legacy demo tours (seedTours.ts) that the 10 SDR tours above supersede. */
const RETIRED_LEGACY_TOURS = [
  "Welcome to Velocity",
  "Building an Email Sequence",
  "Managing Your Pipeline",
  "Automated Revenue Engine (ARE)",
  "AI Draft Queue & Auto-Send",
];

/* ─── Upsert helpers ─────────────────────────────────────────────────────── */

async function upsertCategory(db: AnyDb, workspaceId: number, c: CatSeed): Promise<number> {
  const [existing] = await db
    .select({ id: helpCategories.id })
    .from(helpCategories)
    .where(and(eq(helpCategories.workspaceId, workspaceId), eq(helpCategories.name, c.name)))
    .limit(1);
  if (existing) {
    await db
      .update(helpCategories)
      .set({ icon: c.icon, sortOrder: c.sortOrder })
      .where(eq(helpCategories.id, existing.id));
    return existing.id;
  }
  const [res] = await db.insert(helpCategories).values({
    workspaceId,
    name: c.name,
    icon: c.icon,
    sortOrder: c.sortOrder,
  });
  return (res as any).insertId as number;
}

async function upsertArticle(
  db: AnyDb,
  workspaceId: number,
  a: ArticleSeed,
  categoryId: number | null,
): Promise<void> {
  const payload = {
    workspaceId,
    categoryId: categoryId ?? null,
    slug: a.slug,
    title: a.title,
    summary: a.summary,
    bodyMarkdown: a.bodyMarkdown,
    tags: a.tags,
    status: "published" as const,
    pageKey: a.pageKey ?? null,
    readingTimeMinutes: a.readingTimeMinutes,
  };
  const [existing] = await db
    .select({ id: helpArticles.id })
    .from(helpArticles)
    .where(and(eq(helpArticles.workspaceId, workspaceId), eq(helpArticles.slug, a.slug)))
    .limit(1);
  if (existing) {
    await db.update(helpArticles).set(payload).where(eq(helpArticles.id, existing.id));
  } else {
    await db.insert(helpArticles).values(payload);
  }
}

async function upsertTour(db: AnyDb, workspaceId: number, t: TourSeed): Promise<number> {
  const tourPayload = {
    workspaceId,
    name: t.name,
    description: t.description,
    type: t.type,
    roleTags: t.roleTags,
    estimatedMinutes: t.estimatedMinutes,
    status: "published" as const,
    pageKey: t.pageKey,
  };
  const [existing] = await db
    .select({ id: tours.id })
    .from(tours)
    .where(and(eq(tours.workspaceId, workspaceId), eq(tours.name, t.name)))
    .limit(1);

  let tourId: number;
  if (existing) {
    tourId = existing.id;
    await db.update(tours).set(tourPayload).where(eq(tours.id, tourId));
    // Clean re-seed of steps keyed by tourId.
    await db.delete(tourSteps).where(eq(tourSteps.tourId, tourId));
  } else {
    const [res] = await db.insert(tours).values(tourPayload);
    tourId = (res as any).insertId as number;
  }

  for (let i = 0; i < t.steps.length; i++) {
    const s = t.steps[i]!;
    await db.insert(tourSteps).values({
      tourId,
      sortOrder: i,
      title: s.title,
      bodyMarkdown: s.bodyMarkdown,
      targetDataTourId: s.targetDataTourId ?? null,
      targetSelector: null,
      routeTo: s.routeTo ?? t.route,
      visualTreatment: s.visualTreatment,
      advanceCondition: s.advanceCondition,
      skipAllowed: true,
      backAllowed: i > 0,
    });
  }
  return tourId;
}

async function retireLegacyTours(db: AnyDb, workspaceId: number): Promise<void> {
  const legacy = await db
    .select({ id: tours.id })
    .from(tours)
    .where(and(eq(tours.workspaceId, workspaceId), inArray(tours.name, RETIRED_LEGACY_TOURS)));
  if (legacy.length === 0) return;
  const ids = legacy.map((r) => r.id);
  await db.delete(tourSteps).where(inArray(tourSteps.tourId, ids));
  await db.delete(tours).where(inArray(tours.id, ids));
  console.log(`[SeedHelp] Retired ${ids.length} legacy tour(s) for workspace ${workspaceId}`);
}

/* ─── Public API ─────────────────────────────────────────────────────────── */

/**
 * Seed (idempotently) all help content for one workspace.
 */
export async function seedHelpContent(db: AnyDb, workspaceId: number): Promise<void> {
  // 1. Categories (by name) → slug→id map for article references.
  const categoryIdBySlug = new Map<string, number>();
  for (const c of CATEGORIES) {
    const id = await upsertCategory(db, workspaceId, c);
    categoryIdBySlug.set(c.slug, id);
  }

  // 2. Articles (by slug).
  for (const a of ARTICLES) {
    await upsertArticle(db, workspaceId, a, categoryIdBySlug.get(a.categorySlug) ?? null);
  }

  // 3. Retire superseded legacy tours, then seed the 10 SDR tours (by name).
  await retireLegacyTours(db, workspaceId);
  const tourIdByName = new Map<string, number>();
  for (const t of TOURS) {
    const id = await upsertTour(db, workspaceId, t);
    tourIdByName.set(t.name, id);
  }

  // 4. Link articles → their associated tour (so Ask AI / Help can offer "take the tour").
  for (const a of ARTICLES) {
    if (!a.tourName) continue;
    const tourId = tourIdByName.get(a.tourName);
    if (!tourId) continue;
    await db
      .update(helpArticles)
      .set({ associatedTourId: tourId })
      .where(and(eq(helpArticles.workspaceId, workspaceId), eq(helpArticles.slug, a.slug)));
  }
}

/**
 * One-time boot backfill: seed help content for every existing workspace.
 * Idempotent — safe to run on every startup. Called from index.ts (setTimeout).
 */
export async function seedHelpForAllWorkspaces(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const allWorkspaces = await db.select({ id: workspaces.id }).from(workspaces);
  let seeded = 0;
  for (const ws of allWorkspaces) {
    try {
      await seedHelpContent(db, ws.id);
      seeded++;
    } catch (e) {
      console.error(`[SeedHelp] workspace ${ws.id} failed:`, (e as Error)?.message ?? e);
    }
  }
  console.log(`[SeedHelp] Help content ensured for ${seeded}/${allWorkspaces.length} workspace(s)`);
}
