/**
 * seedHelpContent.ts — SDR enablement Help Center content.
 *
 * Seeds (idempotently, per workspace):
 *   - 6 help categories  (deduped by (workspaceId, name) — no slug column on help_categories)
 *   - 20 help articles   (deduped by (workspaceId, slug), all status:'published')
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
];

/* ─── Articles (20) ──────────────────────────────────────────────────────── */

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
    bodyMarkdown: `Velocity is your unified revenue workspace — prospecting, CRM, sequences, and inbox in one place, so you never tab-hop between tools. As an SDR you'll spend most of your day in three areas: **Prospects/Find Prospects** (build your list), **Sequences & Unified Inbox** (run outreach and handle replies), and **Pipeline/Contacts** (track what's working). The left sidebar groups everything: *Overview* (Dashboard, Inbox, Mailbox, Calendar), *Funnel* (Prospects, Leads, Contacts), *Engage* (Sequences, Campaigns), and *Revenue Engine* (ARE). Start each day on the **Dashboard** for your numbers, then move into prospecting. New here? Run the **Getting Started** guided tour (Help → Tours) for a 3-minute walkthrough.`,
  },
  {
    slug: "navigating-the-app",
    categorySlug: "getting-started",
    title: "Navigating the app",
    summary: "Sidebar, global search, and command bar.",
    readingTimeMinutes: 2,
    tags: ["getting-started", "navigation"],
    bodyMarkdown: `The **sidebar** is your map — collapse it with the toggle, and it remembers your scroll position between pages. **Global search** (top bar, or ⌘K) jumps to any record or page by name. Page headers carry the primary action button on the right and a **sub-nav strip** beneath for related pages (e.g. Sequences → Email Drafts / Email Analytics). The **? button** (bottom-right) opens this Help Center from anywhere. Tip: most list pages support inline filters and CSV export from the header.`,
  },
  {
    slug: "connect-email-linkedin",
    categorySlug: "getting-started",
    title: "Connect email & LinkedIn",
    summary: "Connect sending accounts and LinkedIn; why it matters for deliverability.",
    readingTimeMinutes: 3,
    tags: ["getting-started", "deliverability", "linkedin", "email"],
    pageKey: "connected-accounts",
    bodyMarkdown: `Before you send, connect your channels under **Connected Accounts** (sidebar → Engage area). Add an email **Sending Account** (the address sequences send from) and bridge your **LinkedIn** account at *My LinkedIn* for profile lookups and LinkedIn discovery. Watch the deliverability signals on each sending account: warm-up status and daily send caps protect your sender reputation. **Never blast** — Velocity enforces per-account daily caps and a suppression list (unsubscribes + verified bounces) so you stay out of spam folders. If a LinkedIn search returns nothing, your bridge session may have expired — reconnect it.`,
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
    bodyMarkdown: `**Find Prospects** (sidebar → Acquire) runs multi-source discovery against your ICP. Pick **Person** or **Account** mode, fill the fields you care about (job title, seniority, industry, location) and add keywords for intent. Click **Run discovery** — results fan out across LinkedIn, web, and news, then get scored and de-duplicated automatically. Anything fully verified lands in **Verified**; partial matches land in **Needs Review** for you to clean up. Click any result row to open the full prospect. Skipped fields are ignored, so start broad and narrow if you get noise.`,
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
    bodyMarkdown: `Have a list already? On **Prospects**, click **Import CSV**. Map your columns (name, title, company, email, LinkedIn URL) and import. Imported rows appear in the Prospects library with an **email status** badge. CSV-imported prospects start without an ICP-fit score (that's only set by Discovery), so use the email-status filter to find the deliverable ones. From there, select and enroll into a sequence, or run **Find contact info** to verify emails before sending.`,
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
    slug: "leads-contacts-accounts",
    categorySlug: "crm-pipeline",
    title: "Prospects, Leads, Contacts & Accounts",
    summary: "The difference between Prospects, Leads, Contacts, and Accounts.",
    readingTimeMinutes: 3,
    tags: ["crm", "data-model"],
    pageKey: "contacts",
    bodyMarkdown: `Four record types, four jobs. **Prospects** = your raw outbound list (discovery + CSV), not yet qualified. **Leads** = inbound or qualifying individuals being scored/routed. **Contacts** = people tied to a company **Account** you're actively working. **Accounts** = the companies, with hierarchy and ARR rollup. Flow: a prospect who replies/qualifies becomes a lead or contact; the contact's company is an account; deals on that account are **Opportunities** in the Pipeline. Don't over-think it early — keep new outbound names as Prospects and promote as they engage.`,
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
    bodyMarkdown: `**Pipeline** shows opportunities as a kanban grouped by stage (discovery → qualified → proposal → negotiation → won/lost). Drag a card between columns to change its stage, or — keyboard/no-mouse — focus a card (Tab) and use the **◀ / ▶ Move** buttons on it. Cards show value, win probability, and AI next-best-actions; if AI suggests a stage change you'll see an **Accept** chip. Use the view toggle for the **Forecast** rollup. Every stage move is recorded in the opportunity's stage history. Keep stages honest — the forecast and alerts depend on it.`,
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
    bodyMarkdown: `A repeatable morning beats heroics. **1) Dashboard (5 min):** scan your numbers and overdue tasks. **2) Inbox & replies (15 min):** clear the **Unified Inbox** — every reply gets a response or a logged next step; sequences auto-pause on reply so focus on movers. **3) Needs Review (15 min):** triage the **Find Prospects → Needs Review** queue — fix emails, verify, archive junk (see "The Needs Review queue"). **4) Build list (20 min):** run **Find Prospects** against today's ICP slice; enroll high-Fit + Valid-email prospects into the right sequence. **5) Approve drafts (10 min):** clear **Email Drafts** / **AI Pipeline** so the engine keeps sending. Then spend the rest of the day on live conversations and pipeline.`,
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
    bodyMarkdown: `Once a week, step back. Open **Pipeline** (Forecast view) and **Email Analytics**: Which sequences/steps get opens and replies? Which stages are stalling (check **Pipeline Alerts**)? Re-rank your prospecting: double down on the ICP slices and sequences that produce meetings, and retire the ones that don't. Update your ARE campaign's fit gate/targeting based on what actually converted. Archive dead prospects so your lists stay clean. A 20-minute weekly review compounds.`,
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
      { title: "Your sidebar", bodyMarkdown: "Everything's grouped here: Overview, Funnel, Engage, Revenue Engine.", targetDataTourId: "sidebar-nav", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Your daily numbers", bodyMarkdown: "The Dashboard is your morning home — pipeline, leads, customers.", targetDataTourId: "dashboard-kpi-grid", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Help anytime", bodyMarkdown: "Click ? for articles, Ask AI, and these tours.", targetDataTourId: "help-button", visualTreatment: "pulse", advanceCondition: "next_button" },
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
