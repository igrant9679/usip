/**
 * seedHelpContent.ts — SDR enablement Help Center content.
 *
 * Seeds (idempotently, per workspace):
 *   - help categories  (deduped by (workspaceId, name) — no slug column on help_categories)
 *   - help articles    (deduped by (workspaceId, slug), all status:'published')
 *   - guided tours     (deduped by (workspaceId, name); steps delete+reinsert each run)
 *
 * ⚠️ COUNTS DELIBERATELY NOT REPEATED HERE. This header used to say "9
 * categories, 39 articles, 10 tours" long after the file held 10, 52 and 58 —
 * a number in a comment is a claim nothing checks. `server/helpContent.test.ts`
 * asserts the structural invariants instead (every categorySlug resolves, every
 * slug is unique, every tourName resolves, every "Learn more" link in
 * helpText.ts points at an article that exists).
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

/* ─── Categories ─────────────────────────────────────────────────────────── */

type CatSeed = { slug: string; name: string; icon: string; sortOrder: number };

// NOTE: HelpCenter.tsx renders cat.icon as a literal string (emoji), not a
// lucide component name — so these are emojis, matching the "📁" fallback.
export const CATEGORIES: CatSeed[] = [
  { slug: "getting-started", name: "Getting Started", icon: "🚀", sortOrder: 1 },
  { slug: "prospecting", name: "Prospecting", icon: "🔍", sortOrder: 2 },
  { slug: "crm-pipeline", name: "CRM & Pipeline", icon: "📊", sortOrder: 3 },
  { slug: "sequences-email", name: "Sequences & Email", icon: "✉️", sortOrder: 4 },
  { slug: "are", name: "Autonomous Revenue Engine", icon: "🤖", sortOrder: 5 },
  { slug: "playbooks", name: "Daily Playbooks", icon: "📘", sortOrder: 6 },
  { slug: "meetings-calls", name: "Meetings & Calls", icon: "📞", sortOrder: 7 },
  { slug: "autopilots", name: "Autopilots & Automation", icon: "⚡", sortOrder: 8 },
  { slug: "team-admin", name: "Team & Admin", icon: "👥", sortOrder: 9 },
  { slug: "settings-account", name: "Settings & Account", icon: "⚙️", sortOrder: 10 },
];

/* ─── Articles ───────────────────────────────────────────────────────────── */

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

export const ARTICLES: ArticleSeed[] = [
  // Articles for what shipped in the 0130-0134 range. Written against the
  // measured behaviour of this workspace, not the intended behaviour.
  {
    slug: "website-chat-agent",
    categorySlug: "playbooks",
    title: "The website chat agent",
    summary: "Qualify visitors and book meetings without sending anything.",
    readingTimeMinutes: 3,
    tags: ["inbound", "chat", "meetings", "autonomy"],
    pageKey: "chat",
    tourName: "Your Website Chat Agent",
    bodyMarkdown: `The chat agent is the only meeting source in Velocity that sends nothing at all. A visitor lands on a page carrying the widget, the agent talks to them, and if they are a fit it captures a routed lead and — in **Autonomous** mode — offers your real calendar slots and books one.

**Set it up** at *Inbound → Chat* (admin only). Give it a display name, an opening line, and the questions it should work into the conversation. The **extra instructions** field is where guardrails go: never quote a price, never promise a savings figure, do not claim named clients. Those are read on every turn.

**Autonomy.** *Off* means the widget refuses to serve. *Approve* means it chats and captures the lead, but a qualified visitor becomes a high-priority task for a human instead of a booking. *Autonomous* means it shows genuine availability and books unattended. Start on Approve and read a few transcripts.

**Before going Autonomous**, check your booking link's timezone. It defaults to UTC, so a Mon-Fri 9-17 window offers US prospects the middle of the night.

**Install it** — this is the step that decides whether it books anything. Three ways, and you can use all three: share the /c/ link directly; turn on **Show on my Velocity-hosted pages** to put the bubble on your landing pages and every rep's booking page; or paste the one-line script into your own website before the closing body tag. The script adds a launcher bubble, does not load the chat until someone clicks it, and renders nothing at all while the agent is unpublished or Off — so turning the agent off really does remove it from your site.

**What it knows.** The agent may only state facts you have written down. Add them under *What it knows* — one per question, in your own words. This is the single most important thing you can do for answer quality: given nothing, a model fills the silence with plausible invention, and it will confidently confirm services you do not offer. Anything not written there, it says it does not know and offers to find out. Cover your service list, what happens on a first call, and how pricing works.

**If they leave without booking.** A visitor who gave an email and then vanished is the most recoverable thing the chat produces. Its own switch — *Off / Draft for me / Send it* — writes them one follow-up referencing what they actually said. Deliberately separate from the agent's own autonomy: booking a meeting someone asked for and emailing someone who walked away are different acts. Only conversations from the last 7 days are ever followed up, and never more than once.

**Asking for a person.** If a visitor asks to speak to a human, the agent stops selling and raises a high-priority task for the rep, with the transcript attached. This is not behind a switch: "Autonomous" means it books without asking, not that it refuses to fetch a person.

**It knows which page they are on.** The opening line differs on a pricing page and a careers page, and on a careers page it deliberately will not push for a meeting.

**Reading transcripts.** Every conversation is listed under the agent with its score and outcome. Open one to see exactly what was said — this is the fastest way to judge whether it is ready for Autonomous. You can delete any transcript; the lead or meeting it produced is kept.

**What it will not do.** It never invents a name, email or company; anything it did not hear from the visitor stays empty. It cannot book without an email address. And the decision to book is not the model's — it follows the mode you set.`,
  },
  {
    slug: "sendgrid-campaigns",
    categorySlug: "sequences-email",
    title: "Sending campaigns through SendGrid",
    summary: "When to use it, how to set it up, and the one thing it cannot do.",
    readingTimeMinutes: 3,
    tags: ["sendgrid", "sending", "campaigns", "deliverability"],
    pageKey: "sending-accounts",
    bodyMarkdown: `SendGrid is an alternative to sending through a mailbox. Instead of connecting an inbox, you paste an API key and Velocity posts your campaign email to SendGrid, which delivers it.

**Set it up** at *Settings → Mailboxes → SendGrid*, or from the full form at *Engage → Sending Accounts*. You need three things: the **From address**, which must already be a verified sender inside SendGrid; a **Reply-To**; and an **API key** with **Mail Send** permission. Press **Test key** — it checks both that the key works and that it is allowed to send, because a key that authenticates but lacks that permission looks fine right up until your first campaign fails.

Once saved it joins the same sending pool as your mailboxes, so sequences and campaigns can use it immediately with no further wiring.

## The one thing it cannot do

**Replies will not appear in Velocity.** An API key has no inbox behind it — there is nothing for Velocity to read. Replies go to whatever you set as **Reply-To**, and you will only see them in Velocity if that address is a mailbox you have connected separately.

This is inherent to sending by API, not a gap in Velocity. Plan for it: set Reply-To to a real mailbox, and connect that mailbox under *Settings → Mailboxes*. Otherwise the reply-detection, thread views and "what's working" numbers will all under-report, because the replies are landing somewhere Velocity cannot see.

## When to use it instead of a mailbox

**Use SendGrid** for volume, when you want sending separated from anyone's personal inbox, or when your host blocks outbound SMTP.

**Use a connected mailbox** when replies matter more than volume — which, for cold outreach that is meant to start conversations, is most of the time. A mailbox gives you reply detection for free.

**Changing the key later:** leave the API key field blank and your existing key is kept. You never see the stored key again — Velocity encrypts it and does not hand it back, even to an admin.`,
  },
  {
    slug: "how-email-finding-works",
    categorySlug: "prospecting",
    title: "How Velocity finds an email address",
    summary: "The three-step chain, what each step costs, and where prospects get stuck.",
    readingTimeMinutes: 4,
    tags: ["enrichment", "email", "linkedin", "apollo"],
    pageKey: "data-sources",
    tourName: "Turn On Email Finding",
    bodyMarkdown: `Finding a work address is a chain. Each step feeds the next, and a prospect stalls at whichever link is missing.

**1. LinkedIn gives the employer.** Sourced prospects often arrive with a name and a LinkedIn URL and nothing else. LinkedIn withholds structured work history for people outside your account's network, so the employer usually has to be read out of the profile headline — "Chief Financial Officer at Acme Foundation". Measured on real data, roughly **30%** of headlines name an employer; the rest are slogans like "Making numbers make sense!" and yield nothing. This step spends your connected LinkedIn account's daily lookup allowance.

**2. Apollo turns a company name into a domain.** This uses Apollo's organisation search and costs **no Apollo credits**. Velocity never calls Apollo's paid enrichment endpoints.

**3. Velocity derives and verifies the address.** It scrapes the company site for published addresses, generates the two or three most likely patterns from the person's name and domain (first.last, flast, firstlast cover about 80% of corporate schemes), and asks Reoon which is real. This is the only step that spends verification credits.

**Where people get stuck.** No company name and no LinkedIn URL means nothing can start. A first name without a surname cannot produce a pattern. And a rejected prospect is never worked at all — reject moves someone out of the queue entirely, so no budget is spent on them.

**Expect losses at every hop.** A realistic end-to-end yield is well under half the prospects you start with. That is the nature of the chain, not a fault in it.`,
  },
  {
    slug: "enrichment-sweep-and-backfill",
    categorySlug: "autopilots",
    title: "Enrichment Sweep and Company Backfill",
    summary: "Two data engines, two budgets, two switches — and why Approve means something different here.",
    readingTimeMinutes: 3,
    tags: ["autonomy", "enrichment", "credits"],
    pageKey: "workflows",
    tourName: "The Autonomy Control Center",
    bodyMarkdown: `Two engines in the Autonomy Control Center only fill in missing data. Neither sends anything, which changes what the controls mean.

**Company Backfill** reads employers off LinkedIn profiles for prospects that have none. It spends your connected account's daily lookup allowance (around 100/day) and defaults to a cap of 50, leaving the rest for interactive use.

**Enrichment Sweep** takes prospects that have a company and finds their address. It resolves any missing domains first (free), then verifies (spends Reoon credits).

**Approve means attended.** For every other engine, Approve means "draft it and wait for me". For these two there is no outward action to review — the only thing worth gating is unattended spend. So Approve means *runs when you press the button*, and Autonomous means *runs daily on a cap*.

**Separate switches on purpose.** They spend different budgets. One control over both is how you end up with a bill you did not choose.

**Both skip rejected prospects.** Rejecting someone removes them from all of this — no lookups, no credits, no re-research.

**Watch the first automatic run.** Company names are derived from headline prose. The parser refuses anything ambiguous rather than guessing, but spot-checking a few is cheap and worth doing.`,
  },
  {
    slug: "meet-elsie",
    categorySlug: "getting-started",
    title: "Elsie, the in-app guide",
    summary: "What the compass in the top bar does.",
    readingTimeMinutes: 1,
    tags: ["getting-started", "help", "tours"],
    pageKey: "dashboard",
    tourName: "Meet Elsie",
    bodyMarkdown: `**Elsie** is the guide built into Velocity by LSI Media. When you open a page she has a walkthrough for, she offers it — once per page per session, never repeatedly.

Accepting one starts a guided tour: the relevant control is spotlighted, a card explains it, and the tour moves between pages on its own where it needs to.

**The compass in the top bar switches her on and off.** Off genuinely means off — she stops offering and stops looking anything up. The setting lives on your account, so turning her off on one machine turns her off everywhere you sign in.

**Nothing is lost by dismissing a tour.** Every walkthrough stays available in the Help Center under Tours, so you can run any of them whenever you like.`,
  },
  {
    slug: "ai-assistant",
    categorySlug: "getting-started",
    title: "The AI Assistant: what it looks up, what it can do, and what it never will",
    summary: "Ask about your own data, have it propose real actions behind a confirm card, and know exactly where the line is.",
    readingTimeMinutes: 4,
    tags: ["ai", "assistant", "actions", "campaigns", "sequences", "lists", "tasks"],
    pageKey: "ai-assistant",
    tourName: "Ask the AI Assistant",
    bodyMarkdown: `**AI Assistant** sits in the sidebar's quick links. It does three things: it **looks things up** in your own workspace, it **proposes actions** that you confirm in the chat, and it **hands you links** to the right page.\n\n**It reads your data, not general knowledge.** Ask it to find everyone at a company, open a person and see where each fact came from, list your sequences, lists or autonomous campaigns, summarise what is waiting on you, show the deals pipeline by stage, or count who matches a filter ("CFOs in Texas with a valid email") before you act on it. For "how do I…" questions it reads the Help Center and answers from that. It never invents ids or counts — if it has not looked something up, it will look it up first.\n\n**What it can propose.** Each of these shows a **confirmation card** that states exactly what will happen, and nothing runs until you click **Confirm**:\n\n| Ask it to… | What runs on Confirm | Limit |\n|---|---|---|\n| Enroll people in a sequence | the enrolment, through the same rules as the Sequences page | 50 people |\n| Create follow-up tasks | one task per person, with type, priority and due date | 50 |\n| Add people to a list, or build a list from a filter | the list and its members — it previews the real count first | 50 / 1,000 |\n| Enrich people | the full enrichment pass — **this spends verification credits** | 25 |\n| Pause or activate a campaign | the status change on that autonomous campaign | 1 |\n| Draft meeting proposals | drafts into your approval queue; nothing is scheduled or mailed until you approve each one there | 5 |\n| **Create a campaign** | a new autonomous campaign as a **draft** from your description — targeting (titles, industries, geographies, keywords, company size), prospect count, daily cap, channels, goal and tone guidance | 1,000 prospects · 100/day |\n\n**Creating a campaign never launches it.** The draft discovers and sends nothing until you activate it — a separate step (ask the assistant to activate it, or use the campaign page) taken after you have looked at it. The assistant can only create it in **batch approval** (you approve batches) or **review & release** (you release each send); fully unattended mode is something a human sets on the campaign's settings page.\n\n**How the confirm card works.** A proposal is held by the server, not by the page: it can be confirmed **once**, it expires after **30 minutes**, and **Not now** closes it for good — ask again if you change your mind. Everything runs under *your* role and permissions, exactly as if you had done it from the page, and every confirmed action is logged. One proposal per message: it will not chain several writes behind a single click.\n\n**What it will never do**, whatever you type: send an email, LinkedIn message or reply (those stay behind the autopilot dials and your approval queues), fetch new prospects, edit or delete records, change autopilot or workspace settings, or launch a campaign. If you ask for one of these it will tell you where that lives and offer the link.\n\n**Two habits that make it useful.** Be specific — names, companies, numbers — and let it ask: when a request is missing something it needs (a campaign with no name or no targeting, a person it cannot find) it asks rather than guessing. It also knows which page you came from, so "this page" and "here" mean what you expect.`,
  },
  {
    slug: "multiple-workspaces",
    categorySlug: "settings-account",
    title: "Running multiple workspaces",
    summary: "One workspace per client, and what does not carry across.",
    readingTimeMinutes: 2,
    tags: ["settings", "workspaces", "admin"],
    pageKey: "settings",
    tourName: "Working With Multiple Workspaces",
    bodyMarkdown: `A workspace is a complete, separate world: its own members, prospects, mailboxes, API keys, autopilot settings and branding. Nothing crosses between them.

**Switching** is the control at the top of the sidebar, which lists every workspace you belong to.

**Creating one** is a super-admin action, from the same menu. You become its super admin, and it starts empty. Sample data is opt-in and off by default — a client workspace pre-filled with invented accounts is worse than an empty one, and some engines read those rows as real.

**What a new workspace does not inherit** is the part that surprises people: no Apollo key, no verification key, no connected mailbox, no brand voice. Each has to be set up per workspace. That is correct when each one is a different client, but it does mean enrichment and sending will not work in a new workspace until they are configured.`,
  },
  {
    slug: "meetings-without-outbound",
    categorySlug: "playbooks",
    title: "Getting meetings without sending anything",
    summary: "Three inbound paths that work while campaigns are paused.",
    readingTimeMinutes: 3,
    tags: ["meetings", "inbound", "playbook"],
    pageKey: "chat",
    tourName: "Booked Without Sending",
    bodyMarkdown: `If your outbound is paused — or you have not started it — three paths still produce booked meetings.

**The website chat agent** qualifies a visitor and, in Autonomous mode, books them onto your calendar directly.

**Your booking link** shows genuine open slots from your calendar. Share it, or use the bookingLink merge variable in any email so a meeting ask never renders a dead link.

**Landing pages and forms** create a routed lead on submit and can auto-enroll it into a sequence. Turn on a landing page's booking button and a visitor skips the form entirely.

All three land in the same place: a meeting on **Meetings** and on your real calendar, with the lead attached.

**Why this matters.** Outbound needs volume, deliverability and time before it produces anything. These do not. If your campaigns are paused for any reason, this is the path that still works today.`,
  },
  {
    slug: "welcome-to-velocity",
    categorySlug: "getting-started",
    title: "Start here: how Velocity actually works",
    summary: "The one idea the whole product rests on, and what to do in your first hour.",
    readingTimeMinutes: 4,
    tags: ["getting-started", "overview", "orientation"],
    pageKey: "dashboard",
    tourName: "Getting Started",
    bodyMarkdown: `Velocity has one job: **get sales meetings booked**. Everything else — the contact database, the sequences, the scoring — exists to feed that. If you only understand one thing, make it this page.

## Meetings arrive five ways

Each one is an independent engine. You do not need all five, and most people should start with one.

1. **The website chat agent** talks to visitors on your site and books them straight into a rep's calendar. It sends no email at all, so there is nothing to warm up and no deliverability risk. **This is the cheapest one to switch on.**
2. **Booking links** (/b/your-name) let someone pick a slot themselves. Also inbound, also no sending.
3. **Sequences** are multi-step email follow-ups to people you already have.
4. **Campaigns (the Autonomous Revenue Engine)** find new prospects, write to them, and work replies. This is the one that spends real sending reputation — leave it until the rest works.
5. **Meeting Autopilot** proposes and sends invites to prospects who look ready.

## The one control that matters: Off / Approve / Autonomous

Every engine has the same three-way switch, and they all live on one screen — **Automation → Autonomy Control Center**.

- **Off** — nothing happens.
- **Approve** — the AI does the work and then *stops*. It arrives as a task for you to read. Nothing is sent, nobody is contacted.
- **Autonomous** — it acts on its own and tells you afterwards.

**Approve is the setting to learn on.** It is not a half-measure — it is a dry run against your real data, showing you exactly what the AI would have said, with no way for it to reach a customer. Read a few of those tasks. When you find yourself approving everything unchanged, switch that engine to Autonomous.

## Your first hour

1. **Connect a mailbox** — *Settings → Mailboxes*. Without one, nothing can send.
2. **Turn everything to Approve** — Autonomy Control Center, "All: Approve". Now the AI starts showing its work.
3. **Set up the chat agent** — *Inbound → Chat*. Give it a persona, add a few facts under **What it knows**, publish it, and switch on "Show on my Velocity-hosted pages". You now have a meeting source that costs nothing to run.
4. **Import or find some contacts** — *Import contacts* for a CSV, or *Find Prospects* to search.
5. **Leave campaigns off** until you have watched the rest for a few days.

## When you are lost

**Hover anything.** Every item in the sidebar explains itself on hover, and the ⓘ icons next to settings explain that specific field. **Elsie** (top bar) runs guided tours of whatever page you are on. This Help Center has articles for every area, and **Ask AI** searches them in plain English.`,
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
    slug: "autonomy-map",
    categorySlug: "autopilots",
    title: "What runs autonomously (and what doesn't)",
    summary: "The honest map: what the machine does end-to-end, what stays human by design, and what's blocked.",
    readingTimeMinutes: 4,
    tags: ["autopilot", "autonomy", "overview", "ai"],
    pageKey: "workflows",
    bodyMarkdown: `With the autopilots on, everything between *"a name exists"* and *"a meeting is on the calendar"* can run itself.\n\n**Fully autonomous (flip to Auto and walk away):**\n- **ARE engine** — discovers prospects against your ICP, enriches, generates sequences, enrolls, and (in Full mode) sends.\n- **Sequence engine + AI auto-send** — cadence sends through your mailbox rotation pools, with caps, suppression, and auto-pause on reply; high-scoring AI drafts can send themselves.\n- **Conversation Autopilot** — classifies every reply (email + LinkedIn) and acts; a "willing to meet" reply automatically receives your booking link.\n- **Meetings** — the Meeting Autopilot proposes and books real calendar events; reminders go out on their own; a no-show creates the re-book task; booking links let prospects self-schedule.\n- **Social Autopilot** — LinkedIn invites (capped), pre-invite warming, opener DM on accept.\n- **Task, Deal, and Job-change Autopilots** — next-step tasks, deal nudges, re-engagement on detected company moves.\n- **Voice agents** — inbound call-backs answered by AI on the rep's behalf, transcribed, and logged to the record.\n- **Plumbing** — workflow rules, form-lead routing + funnel bridging, high-intent visitor tasks, enrichment re-checks, segment auto-enrollment, pipeline alerts, mailbox warmup, scheduled report emails.\n\nEvery autopilot defaults to **Off** with an **Approve** middle mode — autonomy is a dial you set in the Autonomy Center, not a switch someone else flipped.\n\n**Human by design:** the enrichment review queue and data conflicts, draft approval in Approve mode, and meeting dispositions.\n\n**Not autonomous (and why):** outbound AI voice calls (the vendor hasn't released the API yet), accepting inbound LinkedIn invites (no compliant API exists), one-time credentialed setup (mailboxes, LinkedIn, calendars, keys, phone numbers), billing, anonymous website-visitor identification (needs a paid data provider), and — most importantly — your **targeting and strategy**: the machine executes your ICP and sequences; defining them well is still your judgment.`,
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

  /* ── Reporting ───────────────────────────────────────────────────────────── */
  {
    slug: "reports-builder",
    categorySlug: "crm-pipeline",
    title: "The Reports builder",
    summary: "Build, save, and export custom reports on deals, leads, prospects, contacts, and activities.",
    readingTimeMinutes: 3,
    tags: ["reports", "analytics", "export", "csv"],
    bodyMarkdown: `**Reports** (sidebar → Automation and analytics) is the custom report builder.\n\n1. **Pick an object** — Deals, Leads, Prospects, Contacts, or Activities.\n2. **Choose columns** — check the fields you want; owners resolve to real names.\n3. **Stack filters** — equals / contains / greater-less / empty checks, combined with AND.\n4. **Group (optional)** — group by any column with a row **count**, or a **sum**/**average** of a numeric field (e.g. *deals by stage, sum of value* = your pipeline by stage in one click).\n5. **Sort & cap**, then **Run**.\n\n**Save** keeps the whole spec per workspace (everyone can reuse it; "Save as new" forks a loaded report). **Export CSV** downloads up to 1,000 rows of the current result.\n\n**Preset reports** — ten ready-made reports (pipeline by stage, deal value by owner, upcoming closes, won/lost deals, lead funnel, lead quality by source, prospects by email status, sendable prospects, activity volume) sit at the top of the rail: one click loads and runs, then customize and save your own variant.\n\n**Charts** — grouped reports render stat tiles (groups, total, top group + share) and a chart above the table: switch between **Bar, Line, Area, Donut, Pie, and Funnel**; your chart choice saves with the report. Flat reports show row/sum tiles and an automatic **rows-per-day trend** whenever a date column is included.\n\n**Email schedules** — the clock icon on any saved report sets a **daily, weekly (Monday), or monthly** email to any recipients. Reports arrive from your workspace's **system sender** (the same address as team invites and notifications) with a chart and the data table inline; **Send now** fires one immediately.\n\nHow it fits with the rest of reporting: **Analytics** is the fixed autonomous-funnel overview, **Dashboards** is widget/chart canvases you arrange — **Reports** is where you answer ad-hoc questions in table form and hand the CSV to whoever asked.`,
  },

  /* ── Settings & Account ──────────────────────────────────────────────────── */
  {
    slug: "mailbox-warmup",
    categorySlug: "settings-account",
    title: "Mailbox warmup",
    summary: "Ramped warmup sending that builds a new mailbox's sending reputation.",
    readingTimeMinutes: 2,
    tags: ["mailboxes", "warmup", "deliverability"],
    bodyMarkdown: `New mailboxes that suddenly send at volume get flagged. **Warmup** builds reputation first: flip the **warmup toggle** on a mailbox in **Settings → Mailboxes** and the engine sends a slowly-growing number of short, ordinary business emails from that mailbox each day — starting at ~2/day and ramping to ~40/day, spread across working hours with natural variation.\n\nWarmup mail goes to your workspace's **other connected mailboxes** (your own pool), carries no tracking, and is automatically excluded from replies/inbox views. The Mailboxes table shows live progress — *Day N · X sent today* — and after the **28-day ramp** the mailbox flips to **Warmed up** on its own. Pause anytime with the toggle.\n\nBeing straight about scope: this builds steady, authenticated sending history between real mailboxes you own. It does not fake engagement on external providers or use a third-party warmup network. Start warmup the day you connect a new mailbox, and let sequences take over once it completes.`,
  },
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
    bodyMarkdown: `**Settings → Mailboxes** manages the accounts your sequences send from. Click **Link mailbox** to start the guided wizard:\n\n1. **Link** — pick your provider. *Other (SMTP/IMAP)* connects a single account with a **live Test SMTP** check before saving, or use **Bulk Import via CSV** (sample file provided, up to 100 accounts at once).\n2. **Configure** — three quick modules: **Signature** (used on that mailbox's sends), **Sending limits** (daily cap, hourly cap, delay between emails — the defaults are deliverability-safe), and **Opt-out link** (an unsubscribe footer for that mailbox).\n3. **Finish** — the overview shows a ✓/✗ per module; *Fix Configuration Issues* jumps you to whatever's incomplete.\n\nThe mailbox table shows each account's **setup %**, daily usage against its cap, **warmup progress** (see "Mailbox warmup"), deliverability signal, and aliases. Row menu: test the connection, refresh aliases, configure, set default, or unlink. Setup progress matters — a complete configuration (signature + limits + opt-out) is what keeps your mail out of spam folders.`,
  },
  {
    slug: "ai-budget-and-usage",
    categorySlug: "settings-account",
    title: "The monthly AI budget",
    summary: "Cap what the workspace can spend on AI in a month — including the autonomous engines.",
    readingTimeMinutes: 2,
    tags: ["billing", "ai", "usage", "limits", "settings"],
    bodyMarkdown: `**Settings → Billing → Monthly AI budget** caps how many AI tokens this workspace may consume in a calendar month.\n\n**It ships switched off.** The field is empty by default, which means *unlimited*. What a sensible monthly budget looks like is a commercial decision, and a guessed number would have cut live workspaces off mid-campaign the day it deployed — so the mechanism is here and the number is yours.\n\n**It applies to the background engines too.** The ARE engine, sequence generation, the reply Autopilot and every other unattended AI caller count against the same figure. That is deliberate: a budget the autonomous engines are exempt from is not a budget, and they are the heaviest spenders in the system.\n\n**Where usage comes from.** Every AI call is metered at one funnel, so the counter on the Billing tab is the whole picture rather than a sample. It resets on the first of the month.\n\n**When the cap is reached**, AI-backed features stop and say so. Raise the number or wait for the reset — nothing is lost, and sending that does not involve AI carries on.\n\nOne deliberate exception: if the database is unreachable the check **lets calls through** rather than blocking every AI feature on top of an already-broken app.`,
  },

  /* ── Team & Admin ────────────────────────────────────────────────────────── */
  {
    slug: "team-roles-and-permissions",
    categorySlug: "team-admin",
    title: "Roles and what each one can do",
    summary: "Four roles, one rank rule, and the per-member overrides that sit on top.",
    readingTimeMinutes: 3,
    tags: ["team", "roles", "permissions", "admin"],
    bodyMarkdown: `Velocity has four roles, in rank order: **Rep → Manager → Admin → Super admin**. Almost every permission question in the product resolves through that one ranking.\n\n**The rank rule:** you can only act on people *below* you. An admin can change a rep's or a manager's role, deactivate them, or delete them — but not another admin's, and not their own. A super admin is exempt and can act on anyone. This is why an action that works on one teammate is silently unavailable on another: check their role first.\n\n**What each role adds:**\n- **Rep** — their own records, sequences and tasks. Private sequences they own are visible only to them and to managers and above.\n- **Manager** — sees every rep's work unfiltered, plus team-wide reporting.\n- **Admin** — Settings, the Team page, invitations, integrations, mailboxes, workflow rules and the autopilots.\n- **Super admin** — everything above, plus the Danger Zone (see "Archiving, transferring and exporting").\n\n**Per-member overrides.** A handful of capabilities are granted individually rather than by role, from the member's row on the Team page: exporting workspace data, managing API keys, managing integrations, and managing sequences. An override can only take away — a member still needs the role underneath it.\n\n**Two things the workspace protects on its own**, whatever your rank: it will not let you remove the last remaining super admin, and it will not let you delete the member listed as the workspace **owner**. The owner is the standing recipient for everything the autonomous engines report when no human is present, so deleting them would quietly silence the workspace's own automation. Move it deliberately with **Transfer ownership** first.`,
  },
  {
    slug: "inviting-teammates",
    categorySlug: "team-admin",
    title: "Inviting teammates",
    summary: "Send an invitation, what happens if it expires, and how to resend one.",
    readingTimeMinutes: 3,
    tags: ["team", "invite", "onboarding", "admin"],
    bodyMarkdown: `**Settings → Team → Invite** adds someone by email and role. They get a link that signs them in and joins them to this workspace at the role you chose.\n\n**Invitations expire.** The default is **7 days**, adjustable on the same page. Two things then happen on their own:\n\n- **A warning email** goes out to anyone whose invitation is inside its last **48 hours**, telling them how long is left and carrying the accept link. It is only recorded as sent if it actually left — a skipped send (no sending account configured yet, for instance) writes nothing, so the activity log never claims a reminder the invitee never got.\n- **A nightly job** marks anything past its date as *Expired*, and the Team page shows a distinct badge for it.\n\n**An expired invitation is not a dead end.** Use **Resend** on the member's row: it issues a fresh token with a new expiry and mails a new link. The person keeps the same seat and role — nothing needs deleting and recreating.\n\n**Accepting.** The link opens a page showing which workspace and role the invite is for, then signs the invitee in. The email on the invitation and the email they sign in with must match — if they do not, the page says which address the invite was sent to rather than silently joining the wrong person. That check is the reason a forwarded invite link cannot be used by whoever received it.\n\n**Setting a password later.** If someone joined through a linked provider and later needs a password, use **Resend password setup**. That issues a token scoped to password setup only — it does not re-run acceptance, and it does not change their role or their existing sign-in method.`,
  },
  {
    slug: "offboarding-a-teammate",
    categorySlug: "team-admin",
    title: "Offboarding: deactivate, reassign, delete",
    summary: "What happens to a leaver's work, exactly what moves, and the one thing reassignment cannot fix.",
    readingTimeMinutes: 5,
    tags: ["team", "offboarding", "deactivate", "reassign", "admin"],
    bodyMarkdown: `When somebody leaves, **deactivate** them on **Settings → Team**. Deactivation revokes access immediately — their session stops working, they cannot sign in again, and they disappear from assignment pickers — while keeping their history intact for reporting.\n\n**You must name someone to inherit their work.** The picker defaults to you. This is not a formality: their open work would otherwise point at a person who no longer exists in the product, and nothing else in Velocity ever repairs those columns.\n\n**Exactly what moves to the new owner:**\n\n| Moves | Scope |\n|---|---|\n| Leads, opportunities, accounts, contacts | all of them |\n| Campaigns and autonomous (ARE) campaigns | all of them |\n| Sequences they own **and** sequences assigned to them | both columns, they move independently |\n| Unfinished tasks | open work only |\n| Upcoming meetings | future only |\n\n**What deliberately does not move:** completed tasks and past meetings. Reassigning a finished task would rewrite the record of who actually did the work, and that is history rather than a workload.\n\n> ⚠️ **A meeting is not like the others.** Moving an upcoming meeting changes who owns it in Velocity. It does **not** move the calendar event off the leaver's calendar, and it does not recall the invitation already sitting in the attendee's inbox with the leaver's name on it. Velocity therefore clears the meeting's calendar link and its "invite sent" flag when it reassigns one — the new host genuinely does not have it in their calendar yet, and saying otherwise would be the comfortable lie. **Re-send those invites.**\n\n**Deactivate vs delete.** Deactivate is the normal path and is reversible — **Reactivate** restores access. Delete removes the membership row entirely and is not. Both reassign work; both refuse to remove the last super admin or the workspace owner.\n\n**Doing several at once.** Select multiple members and use **Bulk deactivate** — up to 50 at a time, with one inheritor for the batch. It skips anyone it is not allowed to touch (yourself, already-deactivated members, and anyone at or above your rank) and reports how many it skipped rather than failing the whole batch. If the batch would empty the last super-admin seat it refuses outright, before touching anything.`,
  },
  {
    slug: "notifications-and-alerts",
    categorySlug: "team-admin",
    title: "Notifications: what sends, and who decides",
    summary: "Five events, an admin policy, and a personal switch that can only turn things down.",
    readingTimeMinutes: 4,
    tags: ["notifications", "email", "alerts", "settings", "admin"],
    bodyMarkdown: `Velocity notifies on **five events**, and both the bell and the emails come from the same list:\n\n| Event | In-app | Email |\n|---|---|---|\n| A new lead is routed to me | on | off |\n| A lead becomes Sales-Ready | on | **on** |\n| A deal I own moves stage | on | off |\n| One of my tasks is overdue | on | off |\n| Someone @mentions me | on | **on** |\n\nThose are the **defaults** for a workspace that has never opened the page. All five have a real dispatch site behind them — nothing in that list is a switch that does nothing.\n\n**Two levels, and they are not equal.**\n\n1. **The workspace policy** — *Settings → Notifications*, admin only. This is the ceiling.\n2. **Your own preferences** — on your profile. You can **mute** an event your admin turned on. You cannot turn on one your admin turned off. A personal setting that silently overruled a workspace decision would make the admin panel meaningless.\n\nNever having touched your own page means "follow the workspace" for every event — not "off".\n\n**Each event has two switches — bell and email are separate channels.** Muting the bell for *A deal I own moves stage* keeps its email copy coming (and the other way round), so "in-app but no email" is a real setting. Muting both simply silences the event for you.\n\n**A different address for alerts.** Each member can set a **notification email** on their profile that differs from their sign-in address — useful if you want alerts going to a shared or monitored inbox.\n\n**Two deliberate asymmetries worth knowing**, because they explain surprises in both directions:\n\n- If the stored policy is missing or malformed, **in-app notifications still fire**. A dropped notice is a lead nobody knows arrived; noise is something you can switch off.\n- In the same situation, **email does not send**. Email is a second copy of a notice that has already been written, so silence costs nothing — whereas mailing people from a workspace that never opened the settings page is not recoverable.`,
  },
  {
    slug: "danger-zone",
    categorySlug: "team-admin",
    title: "Archiving, transferring and exporting",
    summary: "The three super-admin-only actions, and which of them you cannot undo.",
    readingTimeMinutes: 3,
    tags: ["admin", "workspace", "export", "ownership", "danger-zone"],
    bodyMarkdown: `**Settings → Danger Zone** holds three workspace-level actions. All three are **super admin only** — being an admin is not enough, and the page will say so rather than failing quietly.\n\n**Transfer ownership.** Hands the workspace to another active member. Two things happen together: the owner column moves, and the new owner is **promoted to super admin**. Half of that would be a workspace whose owner cannot administer it. You cannot transfer to yourself, to somebody who is not a member, or to a deactivated member.\n\nThis is the deliberate way to move the owner seat, and it is what the product points you at when it refuses to delete the current owner — the owner is the standing recipient for everything the autonomous engines report when nobody is present.\n\n**Export workspace data.** Returns a summary of your contacts, leads, accounts, opportunities, customers and tasks. Beyond the super-admin requirement, this one also honours the per-member **export data** permission, so it can be withheld from an individual super admin.\n\n**Archive workspace.** Enforced, and reversible: archiving locks every member below super admin out and freezes all autonomous activity — campaigns, sequences, autopilots and enrichment stop sending and spending. No data is deleted. A super admin keeps access and can **Restore workspace** from the same card at any time; the engines resume on their next run.\n\n**Remove sample data.** New workspaces are seeded with demo records so every page has something to show — fictional companies, contacts, leads, deals, a "[Demo]" outbound campaign. This button deletes all of it, shows you exactly what it found before it arms, and leaves your own data untouched. It is permanent, it is audited, and the samples never re-seed afterwards.`,
  },
  {
    slug: "onboarding-first-week",
    categorySlug: "getting-started",
    title: "Onboarding: from empty workspace to first meeting",
    summary: "The setup steps in the order they unblock each other, and how to know each one worked.",
    readingTimeMinutes: 6,
    tags: ["onboarding", "setup", "getting-started", "checklist"],
    bodyMarkdown: `Velocity works as a chain: connections feed sourcing, sourcing feeds enrichment, enrichment feeds scoring and copy, and everything the machines want you to look at lands in one panel on Home. Set it up in that order and each step proves the one before it.

## 1. Connect the accounts (Settings)

- **A mailbox or SendGrid** — *Settings → Mailboxes*. Nothing sends without one. If you use SendGrid, press **Test key** and believe it: it verifies both the key and the Mail Send permission.
- **LinkedIn** — *Settings → Integrations*. Powers profile enrichment, photos, job-change detection and Social outreach, all through the authorized vendor connection with a daily lookup budget (about 100/day).
- **Microsoft 365** (if your admin has configured it) — the Connected Accounts card. One connect gets calendar sync, OneDrive files on records, and OneNote.
- **Verification credits** — *Settings → Data enrichment*: a Reoon key for email verification, and optionally your own QuickEnrich key.

## 2. Clear the demo, keep your bearings

*Settings → Danger zone → Remove sample data* deletes the fictional records new workspaces ship with — it lists what it found before you press, and the samples never come back. Do this before importing so you never mistake a demo row for a real one.

## 3. Get people in

Three doors, use any or all:

- **Import a CSV** — *Data → Import*. Column mapping is exact-match and refuses duplicates; required fields are enforced per destination, so a bad file fails loudly at mapping time rather than quietly at send time.
- **Find prospects** — *Data → Find Prospects* searches by role and company shape.
- **Let a campaign source itself** — an Autonomous Revenue Engine campaign (*Autopilot & AI → ARE Campaigns*) discovers prospects on its own once its queue runs low; pick which sources it may use per campaign under its Settings → Prospect Sources.

## 4. Enrich and score

Select people on *Data → People* and run **Enrich ▾ → Enrich fully (all sources)**: LinkedIn profile data on file, company-name-to-domain resolution, QuickEnrich, pattern+verification, and a site scrape, reconciled field-by-field with a provenance ledger (the "Data sources" chips in a person's drawer show where each fact came from). Profiles and photos ride an async LinkedIn pass and appear when they land.

Then open *Configuration → Lead Scoring*, make sure a fit model is installed and primary, and press **Recalculate** — scores read the enriched company/title/domain fields, so recalculate after any big enrichment wave.

## 5. Choose your autonomy

*Autopilot & AI → Autonomy Center* is every dial in one place. Each autopilot is **Off / Approve / Auto**:

- **Approve** means the work happens and queues for a human — nothing reaches a prospect.
- **Auto** means it executes unattended.

A sane starting posture: everything that only *does work* (tasks, deals, enrichment sweeps, job-change detection, the inbound chat agent) on Auto; everything that *sends* (meetings, conversation replies, social touches, chat follow-up email, and the engine's own releases) on Approve until you have read a week of its output and trust it.

## 6. Open the inbound doors

- **Your booking link** (*Scheduling → Meetings*) — check the timezone before sharing it; it defaults to UTC.
- **The chat agent** (*Inbound → Chat Agents*, admin) — write down what it is allowed to know, start it on Approve, read transcripts, then promote it.
- **Landing pages** (*Inbound → Landing Pages*, admin) — capture forms feed straight into leads and the CRM bridge.

## 7. Learn the two habits

Press **Ctrl+K** anywhere to jump to any tool. And make *Home* your first stop each morning — its attention panel is the single list of everything waiting on a human: AI drafts, engine approvals, unhandled replies, proposed meetings, draft tasks, paused campaigns. If that panel is empty, the machines are handling the rest. The companion article *The operating rhythm: daily, weekly, monthly* turns this into a schedule.`,
  },
  {
    slug: "operating-rhythm",
    categorySlug: "playbooks",
    title: "The operating rhythm: daily, weekly, monthly",
    summary: "What to check every day, what only needs a weekly look, and the monthly housekeeping that keeps the engines honest.",
    readingTimeMinutes: 5,
    tags: ["routine", "playbook", "daily", "weekly", "monthly", "operations"],
    bodyMarkdown: `Velocity's autopilots are built so the product runs while you are elsewhere. What that buys you is not "no work" — it is work compressed into a short, predictable review. This is that review.

## Daily — about ten minutes

1. **Open Home.** The attention panel is the one aggregator of everything waiting on a human. Work it top to bottom:
   - **AI drafts** — approve, edit, or discard outreach the engines wrote (*Autopilot & AI → AI Pipeline*).
   - **Engine approvals** — release the day's batch if your engine runs in batch-approval mode. This is the gate outbound sends wait behind.
   - **Unhandled replies** — a human answer within a day is worth more than any sequence step. Handling a reply also stops the sequence for that person.
   - **Proposed meetings** — confirm times the Meeting Autopilot suggested.
   - **Draft tasks** — accept or dismiss the next-best-actions.
2. **Glance at Conversations** (*Scheduling → Conversations*) for anything the classifier flagged but could not act on.
3. **Check today's meetings** (*Scheduling → Meetings*) — prep notes live on the meeting record.

If the panel is empty, you are done. That is the system working, not something you missed.

## Weekly — about thirty minutes

- **Performance** (*Autopilot & AI → ARE Performance*): which subject lines and hooks are winning, which A/B variants got promoted, reply and meeting rates per campaign. Kill or rewrite what is losing; the optimisation autopilot tunes within limits, but retiring a whole angle is a human call.
- **Sequences** (*Engage → Sequences*): enrollment counts and stuck steps.
- **Data health** (*Data → Data Enrichment* and the sweep card): what the last sweeps found, credits spent, how many prospects still lack an email or a company. The People list self-heals blanks as you browse it, and the backfills run on their own schedule — what you are checking for is a stall, not doing the work yourself.
- **Pipeline** (*Scheduling → Deals*): stage-by-stage review; the Deal Autopilot advances what it can and flags what it cannot.
- **Workflow suggestions** (*Autopilot & AI → Autonomy Center*): the AI proposes new automation rules from what it sees; adopt the ones that describe something you actually do.

## Monthly — an hour, calendar it

- **Budgets.** Check the LLM token usage card and set or adjust the **Monthly AI budget** (tokens, not dollars; 0 means unlimited). Verification credits (Reoon, QuickEnrich) reset on their own monthly cycles with no rollover — if a cycle ended with credits unspent, raise the sweep's daily cap; if it ran dry early, lower it.
- **Recalculate lead scoring** (*Configuration → Lead Scoring → Recalculate*) — a month of enrichment has changed the fields the model reads.
- **Prune.** Archive campaigns that finished, retire sequences nobody enrolls into, and clear lists that served their purpose.
- **Autonomy review** (*Autonomy Center*): anything that spent a clean month on Approve with you approving everything unchanged is a candidate for Auto. Promote one dial at a time, not all of them at once — you want to notice which change caused whatever changes.
- **Export a backup** (*Settings → Danger zone → Export*) if your compliance posture wants an offline copy of record counts.

The pattern underneath all three cadences is the same: the machines act, the attention panel confesses, and your job is to read the confession — daily for sends, weekly for trends, monthly for budgets and trust.`,
  },
];

/* ─── Tours ──────────────────────────────────────────────────────────────── */

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

export const TOURS: TourSeed[] = [
  // Onboarding variations. One route in is not enough: a rep and an admin
  // need different first sessions, and returning users need neither.
  {
    name: "Meet Elsie",
    description: "How the in-app guide works, and how to switch it off.",
    type: "onboarding",
    estimatedMinutes: 1,
    pageKey: "elsie",
    route: "/v2/home",
    roleTags: ["sdr", "admin"],
    steps: [
      { title: "I'm Elsie", bodyMarkdown: "I'm the guide built into Velocity by LSI Media. When you land on a page I have a walkthrough for, I offer it once — never twice for the same page in a session.", routeTo: "/v2/home", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "The switch is always in reach", bodyMarkdown: "The compass in the top bar turns me on and off. Off means off: I stop asking and stop looking things up, rather than just hiding the card.", targetDataTourId: "sidebar-nav", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Your choice follows you", bodyMarkdown: "Turn me off on your laptop and I stay off on your phone. The setting lives on your account, not the browser.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Everything is replayable", bodyMarkdown: "Nothing here is one-shot. Every walkthrough lives in the Help Center under Tours, so dismissing one now costs you nothing later.", targetDataTourId: "help-button", visualTreatment: "pulse", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Your First 15 Minutes",
    description: "The shortest path from empty workspace to a booked meeting.",
    type: "onboarding",
    estimatedMinutes: 5,
    pageKey: "first-run",
    route: "/v2/home",
    roleTags: ["sdr"],
    steps: [
      { title: "What good looks like", bodyMarkdown: "By the end of this you will have a list worth working, one sequence running, and a way for interested people to book time with you. Everything else can wait.", routeTo: "/v2/home", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "1. Connect your mailbox and calendar", bodyMarkdown: "Nothing sends and nothing books until these are connected. It is the single most common reason a new workspace looks broken.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "2. Get people in", bodyMarkdown: "Find Prospects sources them, Import brings a list you already have, and the Revenue Engine can source continuously on its own. Any one of the three is enough to start.", targetDataTourId: "sidebar-nav", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "3. Say who you are once", bodyMarkdown: "Brand Voice and Personas are read by every AI draft in the product. Ten minutes here changes the quality of everything downstream, and skipping it is why AI copy reads generic.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "4. Let people book you", bodyMarkdown: "Your booking link shows real open slots from your calendar. Set your working hours and timezone first — the default is UTC, which offers prospects the middle of your night.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "5. Start on Approve", bodyMarkdown: "Turn the autopilots to Approve rather than Autonomous. You see everything before it goes out, and you learn what the system proposes before trusting it unattended.", routeTo: "/v2/workflows", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Admin Setup Checklist",
    description: "The workspace-level settings everything else depends on.",
    type: "onboarding",
    estimatedMinutes: 5,
    pageKey: "admin-setup",
    route: "/v2/settings/data-sources",
    roleTags: ["admin"],
    steps: [
      { title: "Set up once, for everyone", bodyMarkdown: "These are workspace-level and your reps inherit them. Getting them right now saves answering the same question repeatedly later.", routeTo: "/v2/settings/data-sources", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Data sources", bodyMarkdown: "Apollo sources prospects and resolves company domains at no credit cost. Reoon verifies the addresses Velocity derives. Neither finds an email alone.", targetDataTourId: "settings-data-sources", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Verification is the bottleneck", bodyMarkdown: "Without a verification key the finder still collects phones and social links, but resolves no addresses at all — and it fails quietly rather than loudly.", targetDataTourId: "reoon-key-card", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Brand voice before outreach", bodyMarkdown: "Every AI-written email, chat reply and proposal reads from Brand Voice. Set it before anyone starts sending, not after you dislike the drafts.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Decide the autonomy posture", bodyMarkdown: "Approve everywhere is the safe default for a new workspace. Promote engines to Autonomous one at a time, once you have seen what each proposes.", routeTo: "/v2/workflows", targetDataTourId: "autonomy-autopilots", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Workspaces are separate worlds", bodyMarkdown: "Members, mailboxes, API keys and autopilot settings do not cross between workspaces. Running one per client means configuring each one.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Booked Without Sending",
    description: "Three ways to get a meeting that need no outbound at all.",
    type: "feature",
    estimatedMinutes: 3,
    pageKey: "inbound-meetings",
    route: "/v2/chat",
    roleTags: ["sdr", "admin"],
    steps: [
      { title: "Outbound is not the only path", bodyMarkdown: "Every meeting source here works while your campaigns are paused, because none of them send anything.", routeTo: "/v2/chat", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "The chat agent", bodyMarkdown: "It qualifies a website visitor, captures a routed lead, and in Autonomous mode offers your real calendar slots and books one.", targetDataTourId: "chat-autonomy", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Your booking link", bodyMarkdown: "A shareable page showing genuine availability. Drop it into an email with the bookingLink merge variable and a prospect books without a single reply.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Landing pages and forms", bodyMarkdown: "Both create a routed lead on submit, and a landing page can show a booking button so a visitor skips straight to picking a time.", routeTo: "/v2/landing-pages", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Where they all land", bodyMarkdown: "However a meeting arrives, it appears on Meetings and on your real calendar. There is no separate inbox to remember to check.", routeTo: "/v2/meetings", targetDataTourId: "meetings-list", visualTreatment: "spotlight", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Working With Multiple Workspaces",
    description: "Run one workspace per client without mixing them up.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "workspaces",
    route: "/v2/home",
    roleTags: ["admin"],
    steps: [
      { title: "Switching", bodyMarkdown: "The control at the top of the sidebar lists every workspace you belong to and moves between them.", routeTo: "/v2/home", targetDataTourId: "sidebar-nav", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Creating one", bodyMarkdown: "Super admins get a New workspace option in that same menu. Sample data is off by default — a client workspace full of invented accounts is worse than an empty one.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Nothing is shared", bodyMarkdown: "Members, mailboxes, API keys, autopilot settings and prospects all belong to a single workspace. A new one starts genuinely empty, which is the point when each client is separate.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  // Full nav coverage. Pages without a spotlight anchor use coach steps
  // rather than a target that would resolve to nothing.
  {
    name: "Ask the AI Assistant",
    description: "Ask about your own pipeline in plain English — and have it propose actions you confirm.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "ai-assistant",
    route: "/v2/ai-assistant",
    roleTags: ["sdr"],
    steps: [
      { title: "Your data, asked in plain English", bodyMarkdown: "Ask about your own pipeline rather than reading dashboards. It answers from your records, not from general knowledge.", routeTo: "/v2/ai-assistant", targetDataTourId: "ai-assistant-panel", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Good questions to start with", bodyMarkdown: "Which deals went quiet this week. Which prospects replied but never got a follow-up. What my best source was last month. Specific beats broad.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "It can act, behind a confirm card", bodyMarkdown: "Ask it to enroll people in a sequence, create tasks, build a list, enrich people, pause or activate a campaign, draft meeting proposals — or create a new campaign as a draft. Each shows a card; nothing runs until you click Confirm. It never sends email or LinkedIn messages, and never launches a campaign.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Your Inbox",
    description: "The one place replies land.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "inbox",
    route: "/inbox",
    roleTags: ["sdr"],
    steps: [
      { title: "Everything that came back", bodyMarkdown: "Replies to your outbound arrive here, matched to the prospect and the sequence that produced them.", routeTo: "/inbox", targetDataTourId: "page-inbox", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Replies pause the sequence", bodyMarkdown: "When someone answers, their sequence stops automatically. Nobody gets a scheduled follow-up after they have already written back.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Your Mailbox",
    description: "Your connected mailbox, inside the CRM.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "mailbox",
    route: "/mailbox",
    roleTags: ["sdr"],
    steps: [
      { title: "Your real mail, in context", bodyMarkdown: "Your connected mailbox rendered next to the CRM record, so you can answer without losing what you know about the person.", routeTo: "/mailbox", targetDataTourId: "page-mailbox", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Connect one first", bodyMarkdown: "Nothing shows here until a mailbox is connected. That is also what lets Velocity send as you rather than as a robot from a shared address.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Your Calendar",
    description: "Where booked meetings actually live.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "calendar",
    route: "/calendar",
    roleTags: ["sdr"],
    steps: [
      { title: "Synced, not separate", bodyMarkdown: "This mirrors your real calendar. Meetings booked through your link or by the chat agent are written to the provider, so they appear on your phone too.", routeTo: "/calendar", targetDataTourId: "page-calendar", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "It drives availability", bodyMarkdown: "Your open booking slots are computed from this. A busy calendar is what stops a prospect booking over your existing commitments.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Companies",
    description: "Accounts as the market sees them.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "companies",
    route: "/v2/companies",
    roleTags: ["sdr"],
    steps: [
      { title: "The company view", bodyMarkdown: "People roll up to companies, so you can see every contact you hold at an account and how warm that account is overall.", routeTo: "/v2/companies", targetDataTourId: "companies-table", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Domain is the join key", bodyMarkdown: "Companies are matched on their website domain. It is also what the email finder needs, which is why a missing domain shows up in two places at once.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Lists",
    description: "Static sets you build once and reuse.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "lists",
    route: "/v2/lists",
    roleTags: ["sdr"],
    steps: [
      { title: "A list is a fixed set", bodyMarkdown: "Add people to a list and it stays as you left it. That makes it the right tool for a specific campaign, an event follow-up, or a hand-picked group.", routeTo: "/v2/lists", targetDataTourId: "lists-panel", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Lists versus segments", bodyMarkdown: "A segment is a rule that re-evaluates itself as records change. A list is a snapshot. Reach for a segment when membership should keep up on its own.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Data Enrichment",
    description: "Fill in what sourcing could not.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "data-enrichment",
    route: "/v2/data-enrichment",
    roleTags: ["admin"],
    steps: [
      { title: "Filling the gaps", bodyMarkdown: "Sourcing gets you a name and a company. This is where the rest gets filled in, and where Job Change Autopilot re-engages people who move.", routeTo: "/v2/data-enrichment", targetDataTourId: "data-enrichment-panel", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "LinkedIn never returns emails", bodyMarkdown: "The LinkedIn integration is deliberately the compliant one and carries no email addresses at all. Addresses come from the company-site finder instead.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Data Health",
    description: "Find the gaps that quietly cost you sends.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "data-health",
    route: "/data-health",
    roleTags: ["admin"],
    steps: [
      { title: "What is missing, counted", bodyMarkdown: "Missing emails, missing domains, duplicates and stale records, counted rather than guessed at.", routeTo: "/data-health", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Fix the domains first", bodyMarkdown: "A missing company domain blocks the email finder entirely, so it costs you more than a missing job title. Clear those before anything else.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Import Contacts",
    description: "Bring a list you already have.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "import",
    route: "/import",
    roleTags: ["sdr"],
    steps: [
      { title: "Map, then import", bodyMarkdown: "Upload a CSV and map your columns. Name, company and either an email or a company domain are the fields that matter.", routeTo: "/import", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Rows without an email", bodyMarkdown: "They still import, but they cannot be sequenced until an address is found. The importer warns you rather than letting you discover it later.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Matching on name and company", bodyMarkdown: "Off by default, and deliberately so. It is the setting most likely to merge two different people who happen to share a name.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Emails",
    description: "Every message Velocity sent, in one place.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "emails",
    route: "/v2/emails",
    roleTags: ["sdr"],
    steps: [
      { title: "The send log", bodyMarkdown: "Everything that went out, what it was part of, and what came back.", routeTo: "/v2/emails", targetDataTourId: "emails-list", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Opens are a weak signal", bodyMarkdown: "Mail privacy features and security scanners prefetch images, so an open is worth far less than a reply. Judge a sequence on replies and meetings.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Calls",
    description: "Logged calls and what came of them.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "calls",
    route: "/v2/calls",
    roleTags: ["sdr"],
    steps: [
      { title: "Calls on the record", bodyMarkdown: "Call activity sits on the same timeline as email and meetings, so the account history reads as one story.", routeTo: "/v2/calls", targetDataTourId: "calls-list", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Log the outcome", bodyMarkdown: "The disposition is what makes calls measurable later. An unlogged call teaches the system nothing.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "LinkedIn Network",
    description: "Social touches that run themselves.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "social",
    route: "/social",
    roleTags: ["sdr"],
    steps: [
      { title: "Social, automated carefully", bodyMarkdown: "Connect your LinkedIn account and Velocity can invite, wait for the accept, and open a conversation, at a human pace.", routeTo: "/social", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Social Autopilot", bodyMarkdown: "On Approve it drafts the invite and the opener for you to send. On Autonomous it runs the sequence itself. Set it in the Autonomy Control Center.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Email Builder",
    description: "Templates that stay on brand.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "email-builder",
    route: "/email-builder",
    roleTags: ["admin"],
    steps: [
      { title: "Build once, reuse", bodyMarkdown: "Compose a template here and it is available to every sequence and every rep, so the good version is the one that gets used.", routeTo: "/email-builder", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Merge variables", bodyMarkdown: "Fields like first name and bookingLink are filled at send time. bookingLink resolves to the sending rep own scheduling page, so a meeting ask never renders a dead link.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Campaigns",
    description: "Group your outbound and measure it together.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "campaigns",
    route: "/campaigns",
    roleTags: ["sdr"],
    steps: [
      { title: "Campaign as a container", bodyMarkdown: "A campaign groups sequences and prospects so you can judge a whole motion rather than one email at a time.", routeTo: "/campaigns", targetDataTourId: "page-campaigns", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Autonomous campaigns are separate", bodyMarkdown: "The fully autonomous engine lives in the ARE hub. This page is the classic, rep-driven kind.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Segments",
    description: "Rules that keep their own membership current.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "segments",
    route: "/segments",
    roleTags: ["sdr"],
    steps: [
      { title: "A segment is a live rule", bodyMarkdown: "Define the conditions once and membership updates itself as records change. New matching prospects join without anyone remembering to add them.", routeTo: "/segments", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Auto-enroll", bodyMarkdown: "Point a segment at a sequence and anyone who enters it is enrolled automatically. That is the closest thing here to outbound that runs itself.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Conversations",
    description: "Reply classification and what happens next.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "conversations",
    route: "/v2/conversations",
    roleTags: ["sdr"],
    steps: [
      { title: "Threads, not messages", bodyMarkdown: "Replies are grouped into conversations and classified: interested, not now, wrong person, unsubscribe.", routeTo: "/v2/conversations", targetDataTourId: "conversations-list", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Conversation Autopilot", bodyMarkdown: "It reads the reply, classifies it, and proposes the follow-up. On Approve you see the draft first; on Autonomous it acts. Wrong-person and unsubscribe are handled without you.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Pipeline Alerts",
    description: "Catch a deal going quiet before it dies.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "pipeline-alerts",
    route: "/pipeline-alerts",
    roleTags: ["sdr"],
    steps: [
      { title: "Deals that have gone still", bodyMarkdown: "Alerts fire on the patterns that precede a loss: no activity for too long, a stage held too long, a close date that keeps moving.", routeTo: "/pipeline-alerts", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Act on the oldest first", bodyMarkdown: "The alert is only useful while the deal is still warm. Working the newest ones first is how the list becomes noise.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Proposals",
    description: "Send a proposal and see when it is read.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "proposals",
    route: "/proposals",
    roleTags: ["sdr"],
    steps: [
      { title: "Build and send", bodyMarkdown: "Assemble a proposal from your product catalogue and send it as a hosted page rather than an attachment.", routeTo: "/proposals", targetDataTourId: "proposals-list", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "You see the open", bodyMarkdown: "A hosted proposal tells you when it was viewed. A silent proposal is information too.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Product Catalog",
    description: "What you sell, priced once.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "products",
    route: "/products",
    roleTags: ["admin"],
    steps: [
      { title: "One source for pricing", bodyMarkdown: "Products and prices defined here flow into quotes and proposals, so the number in front of a customer is never someone free-typing.", routeTo: "/products", targetDataTourId: "page-products", visualTreatment: "spotlight", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Customers",
    description: "Life after Closed Won.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "customers",
    route: "/customers",
    roleTags: ["sdr"],
    steps: [
      { title: "Where a won deal goes", bodyMarkdown: "Closing an opportunity creates the customer record automatically. This is the post-sale view: health, renewal risk and expansion.", routeTo: "/customers", targetDataTourId: "page-customers", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Renewals start here", bodyMarkdown: "A customer with a renewal date feeds the Renewals page. Health scores are what tell you which of those need attention early.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Renewals",
    description: "Protect the revenue you already won.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "renewals",
    route: "/renewals",
    roleTags: ["sdr"],
    steps: [
      { title: "Upcoming and at risk", bodyMarkdown: "Renewals ordered by date, flagged by health, so the ones needing a conversation surface before the date does.", routeTo: "/renewals", targetDataTourId: "page-renewals", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Cheaper than new logos", bodyMarkdown: "A renewal saved is worth more than a deal won, for the same effort. This is usually the highest-return page in the product.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "QBRs",
    description: "Business reviews with the numbers already filled in.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "qbrs",
    route: "/qbrs",
    roleTags: ["sdr"],
    steps: [
      { title: "The review, prepared for you", bodyMarkdown: "Usage, health and history are pulled together into a review you can walk a customer through, instead of rebuilding a deck each quarter.", routeTo: "/qbrs", targetDataTourId: "page-qbrs", visualTreatment: "spotlight", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Brand Voice",
    description: "Teach the AI how you sound.",
    type: "onboarding",
    estimatedMinutes: 2,
    pageKey: "brand-voice",
    route: "/brand-voice",
    roleTags: ["admin"],
    steps: [
      { title: "Why this matters more than it looks", bodyMarkdown: "Every AI-written email, chat reply and proposal reads from this. Set it once and everything downstream stops sounding generic.", routeTo: "/brand-voice", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Be specific and be negative", bodyMarkdown: "What you tell it NOT to do carries more weight than adjectives. No exclamation marks, never claim ROI numbers, do not use the word synergy.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Personas",
    description: "Who you sell to, described once.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "personas",
    route: "/personas",
    roleTags: ["admin"],
    steps: [
      { title: "Personas sharpen the writing", bodyMarkdown: "A persona captures a buyer role, what they care about, and what they are sceptical of. AI drafting reads it, so a CFO and a Head of Ops stop getting the same email.", routeTo: "/personas", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Lead Scoring",
    description: "Decide what a good lead looks like.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "lead-scoring",
    route: "/lead-scoring",
    roleTags: ["admin"],
    steps: [
      { title: "The model behind the grade", bodyMarkdown: "Scoring turns attributes and behaviour into an A-D grade, so reps work a ranked list rather than argue about priorities.", routeTo: "/lead-scoring", targetDataTourId: "page-lead-scoring", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Grades are relative", bodyMarkdown: "A grade means better than the rest of your leads, not good in absolute terms. If everything is an A, the model has stopped saying anything.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Lead Routing",
    description: "Get every lead to an owner, fast.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "lead-routing",
    route: "/lead-routing",
    roleTags: ["admin"],
    steps: [
      { title: "Rules, evaluated in order", bodyMarkdown: "Route by territory, size, industry or source. The first matching rule wins, so order is the setting people forget.", routeTo: "/lead-routing", targetDataTourId: "page-lead-routing", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Speed is the whole point", bodyMarkdown: "Inbound leads decay in minutes. Routing exists so nobody has to notice a lead arrived before it gets an owner.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Reports",
    description: "Answer a question the dashboards do not.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "reports",
    route: "/reports",
    roleTags: ["sdr", "admin"],
    steps: [
      { title: "Build and schedule", bodyMarkdown: "Reports go deeper than the dashboards and can be scheduled, so the weekly number arrives without anyone assembling it.", routeTo: "/reports", targetDataTourId: "reports-list", visualTreatment: "spotlight", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Dashboards",
    description: "Your numbers, arranged your way.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "dashboards",
    route: "/dashboards",
    roleTags: ["sdr", "admin"],
    steps: [
      { title: "Build your own view", bodyMarkdown: "Add the widgets your team actually looks at. Everything reads from the same metrics layer, so a number here always matches the same number elsewhere.", routeTo: "/dashboards", targetDataTourId: "page-dashboards", visualTreatment: "spotlight", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Mindmaps",
    description: "Think through an account visually.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "mindmaps",
    route: "/mindmaps",
    roleTags: ["sdr"],
    steps: [
      { title: "Map the account", bodyMarkdown: "Sketch org charts, buying committees and deal strategy on a canvas, next to the records they refer to.", routeTo: "/mindmaps", targetDataTourId: "mindmaps-list", visualTreatment: "spotlight", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Contacts and Accounts",
    description: "The CRM records underneath everything.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "contacts",
    route: "/contacts",
    roleTags: ["sdr"],
    steps: [
      { title: "Contacts are people you know", bodyMarkdown: "A prospect becomes a contact once there is a real relationship. Accounts are the companies they belong to.", routeTo: "/contacts", targetDataTourId: "page-contacts", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Created for you on convert", bodyMarkdown: "Converting a qualified lead creates the account, the contact and the opportunity together. You should rarely be typing these by hand.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  // Coverage for the rest of the main nav. Anchors live in the same commit.
  {
    name: "Working Your Leads",
    description: "Score, route and qualify inbound leads before they hit the pipeline.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "leads",
    route: "/leads",
    roleTags: ["sdr"],
    steps: [
      { title: "Leads are pre-CRM", bodyMarkdown: "A lead is someone who showed interest but has not been qualified yet. They are scored A-D and routed to an owner automatically, so your job here is to work the top of the list, not to sort it.", routeTo: "/leads", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Add one by hand", bodyMarkdown: "Most leads arrive from forms, landing pages, the chat agent or a reply. Use this when someone reaches you another way: a referral, an event, a phone call.", targetDataTourId: "leads-new-button", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "What happens next", bodyMarkdown: "Qualifying a lead and converting it creates the Account, Contact and Opportunity together, and moves it into the pipeline. Nothing is retyped.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Your Deal Pipeline",
    description: "Move opportunities toward close, with the AI watching for stalls.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "deals",
    route: "/v2/deals",
    roleTags: ["sdr"],
    steps: [
      { title: "Every open opportunity", bodyMarkdown: "This is the board of deals in flight. Stages come from your pipeline settings, so it matches how your team actually sells.", routeTo: "/v2/deals", targetDataTourId: "deals-board", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Deal Autopilot", bodyMarkdown: "Turned on, it watches for deals going quiet and proposes the next move. On Approve it drafts and waits for you; on Autonomous it acts. Set it in the Autonomy Control Center.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Closing a deal", bodyMarkdown: "Marking one Closed Won creates the customer record for you, so renewals and QBRs pick it up without a handoff.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Meetings, Booked For You",
    description: "Where meetings land: proposed, booked, and self-served.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "meetings",
    route: "/v2/meetings",
    roleTags: ["sdr"],
    steps: [
      { title: "Three ways a meeting appears", bodyMarkdown: "You book one manually, Meeting Autopilot proposes times and sends the invite, or someone books themselves through your link or the website chat agent. They all land here.", routeTo: "/v2/meetings", targetDataTourId: "meetings-list", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Your booking link", bodyMarkdown: "Every rep gets a shareable link showing real open slots from their calendar. Drop it into an email with the bookingLink merge variable and a prospect can book without a single back-and-forth.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Nothing double-books", bodyMarkdown: "Open slots are computed from your synced calendar minus anything already scheduled, and re-checked at the moment someone books.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Your Task Queue",
    description: "The one list that tells you what to do next.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "tasks",
    route: "/v2/tasks",
    roleTags: ["sdr"],
    steps: [
      { title: "Your working list", bodyMarkdown: "Calls, emails, follow-ups and prep, in one queue rather than scattered across records.", routeTo: "/v2/tasks", targetDataTourId: "tasks-list", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Where they come from", bodyMarkdown: "Sequences create them, workflow rules create them, and Task Autopilot proposes next-best-actions per prospect. On Approve those arrive as drafts for you to accept.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Work top-down", bodyMarkdown: "The queue is ordered so the top of the list is the best use of the next ten minutes. Trust it before you go hunting.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Capture Leads With Forms",
    description: "Public forms that create and route a lead automatically.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "forms",
    route: "/v2/forms",
    roleTags: ["admin"],
    steps: [
      { title: "Forms are inbound plumbing", bodyMarkdown: "Build a form, publish it, and every submission becomes a routed lead with no manual step in between.", routeTo: "/v2/forms", targetDataTourId: "forms-list", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Where the lead goes", bodyMarkdown: "A submission can create the lead, route it to an owner by your rules, and enroll it into a sequence, all without anyone watching.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Landing Pages",
    description: "Hosted marketing pages with capture built in.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "landing-pages",
    route: "/v2/landing-pages",
    roleTags: ["admin"],
    steps: [
      { title: "Author, publish, share", bodyMarkdown: "A landing page is hosted for you at its own public URL. Edit the hero and sections, choose the fields you want, publish, and share the link.", routeTo: "/v2/landing-pages", targetDataTourId: "landing-pages-list", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "It feeds the same pipeline", bodyMarkdown: "Submissions create routed leads exactly like forms do, and can auto-enroll into a sequence. Turn on the booking CTA and a visitor can skip straight to picking a time.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Admin only", bodyMarkdown: "Landing pages are workspace-level marketing assets, so authoring is restricted to admins.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Who Is On Your Site",
    description: "Turn anonymous traffic into named accounts.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "website-visitors",
    route: "/v2/website-visitors",
    roleTags: ["sdr", "admin"],
    steps: [
      { title: "Companies, not just hits", bodyMarkdown: "Visitors are resolved to companies where possible, so you see which accounts are reading you rather than a list of IP addresses.", routeTo: "/v2/website-visitors", targetDataTourId: "visitors-list", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Use it as a signal", bodyMarkdown: "A known account browsing your pricing is a reason to reach out today. Pair it with the chat agent so they can book a call while they are still on the page.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "People and Companies",
    description: "Your searchable record of everyone sourced.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "people",
    route: "/v2/people",
    roleTags: ["sdr"],
    steps: [
      { title: "Everyone you have found", bodyMarkdown: "Every prospect sourced or imported lives here, with an ICP-fit score and an email status badge, so you can tell at a glance who is worth working.", routeTo: "/v2/people", targetDataTourId: "people-table", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Fit and deliverability", bodyMarkdown: "Prioritise high fit with a valid email. A great-fit prospect with no verified address cannot be sequenced, so it is not yet a real option.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Find contact info", bodyMarkdown: "No email? Velocity scrapes the company site, derives the likely address patterns and verifies them. It needs a company domain to work from.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Protect Your Sending",
    description: "Deliverability is the difference between sent and read.",
    type: "onboarding",
    estimatedMinutes: 3,
    pageKey: "deliverability",
    route: "/v2/deliverability",
    roleTags: ["admin"],
    steps: [
      { title: "Why this page exists", bodyMarkdown: "You can write a perfect sequence and still land in spam. This is where you check that the machinery underneath is healthy before you scale volume.", routeTo: "/v2/deliverability", targetDataTourId: "deliverability-overview", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Warm up before you scale", bodyMarkdown: "A new sending domain needs its volume raised gradually. Jumping straight to hundreds a day is the fastest way to burn a domain you cannot un-burn.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Watch the bounces", bodyMarkdown: "Rising bounces mean your list quality slipped, not that your copy got worse. Verify addresses before sending rather than after.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Reading Your Numbers",
    description: "What is actually working, and what the numbers cannot tell you yet.",
    type: "feature",
    estimatedMinutes: 2,
    pageKey: "analytics",
    route: "/v2/analytics",
    roleTags: ["sdr", "admin"],
    steps: [
      { title: "The funnel end to end", bodyMarkdown: "Sourced, contacted, replied, meetings, closed, all measured from the source rows so no two screens disagree.", routeTo: "/v2/analytics", targetDataTourId: "analytics-overview", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Small samples lie", bodyMarkdown: "Rates computed from a handful of sends are marked low-confidence on purpose. A 50 percent reply rate from four emails is not a 50 percent reply rate.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Judge sources by meetings", bodyMarkdown: "Rank prospect sources by meetings per contacted, not by volume. The source that finds the most people is rarely the one that books the most calls.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  // ── Tours for the surfaces added after the original 10 ──────────────────
  // Every targetDataTourId below has a matching data-tour-id in the page it
  // points at. A step whose target does not resolve spotlights nothing and the
  // tour silently degrades, so anchors and steps must land in the same commit.
  {
    name: "Your Website Chat Agent",
    description: "Turn website visitors into booked meetings without sending anything.",
    type: "feature",
    estimatedMinutes: 3,
    pageKey: "chat",
    route: "/v2/chat",
    roleTags: ["sdr", "admin"],
    steps: [
      { title: "Meetings with no outbound", bodyMarkdown: "This is the one meeting source that sends nothing at all. A visitor lands on your site, the agent qualifies them, and books straight onto your calendar — no email volume, no deliverability risk, no enrichment credits.", routeTo: "/v2/chat", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Your agents", bodyMarkdown: "Each agent is a separate widget with its own persona and autonomy. The counters show conversations, leads captured, and meetings booked. Click **New** to create one.", targetDataTourId: "chat-agent-list", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Decide how far it goes", bodyMarkdown: "**Off** — the widget refuses to serve. **Approve** — it chats and captures the lead, but a qualified visitor becomes a task for a human. **Autonomous** — it shows your real open calendar slots and books the meeting itself. Start on Approve and read a few transcripts before going autonomous.", targetDataTourId: "chat-autonomy", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Teach it who is a fit", bodyMarkdown: "Your qualifying questions get worked into the conversation naturally — one at a time, never as an interrogation. The threshold is the score at which a visitor counts as qualified. Someone who explicitly asks for a meeting is offered one from 40 regardless.", targetDataTourId: "chat-qualification", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Put it where visitors are", bodyMarkdown: "An agent nobody can reach books nothing. **Show on my Velocity-hosted pages** is one click and puts the chat bubble on your landing pages and every rep's booking page. For your own website, paste the one-line script before `</body>` — it adds a bubble, loads nothing until a visitor clicks it, and shows nothing at all while this agent is unpublished or Off.", targetDataTourId: "chat-install", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Read what it actually said", bodyMarkdown: "Every conversation is kept in full, with the fit score and what it produced — a lead, a booked meeting, or neither. Read these before trusting it unattended.", visualTreatment: "coach", advanceCondition: "next_button" },
    ],
  },
  {
    name: "Turn On Email Finding",
    description: "Connect the verifier that turns a name into a sendable address.",
    type: "onboarding",
    estimatedMinutes: 2,
    pageKey: "data-sources",
    route: "/v2/settings/data-sources",
    roleTags: ["admin"],
    steps: [
      { title: "Three steps, not two", bodyMarkdown: "Finding an address is a chain, and each link feeds the next: LinkedIn gives the person's employer, Apollo turns that company name into a website domain, and Velocity then derives the likely address patterns and asks Reoon which one is real. A prospect stalls at whichever link is missing.", routeTo: "/v2/settings/data-sources", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Only the last step costs credits", bodyMarkdown: "The LinkedIn step spends from your connected account's daily lookup allowance. The domain step is free — Apollo's organisation search costs no credits. Only verification spends Reoon credits, which is why the three are controlled separately rather than behind one switch.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "The verifier key", bodyMarkdown: "Paste your Reoon key here and hit **Test & check credits** — it reports your remaining balance, so you know whether a run will resolve anything before you start one. Without a key the finder still collects phones and social links, but every email lookup stops and no address is resolved.", targetDataTourId: "reoon-key-card", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Keys are per workspace", bodyMarkdown: "These credentials belong to this workspace only. A new workspace starts with none — which is the point when you run one per client.", targetDataTourId: "settings-data-sources", visualTreatment: "pulse", advanceCondition: "next_button" },
    ],
  },
  {
    name: "The Autonomy Control Center",
    description: "One screen for every engine that runs without you.",
    type: "onboarding",
    estimatedMinutes: 3,
    pageKey: "workflows",
    route: "/v2/workflows",
    roleTags: ["sdr", "admin"],
    steps: [
      { title: "Everything autonomous, in one place", bodyMarkdown: "Each engine here runs on its own. This screen is where you decide how much rope each one gets.", routeTo: "/v2/workflows", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Off, Approve, Autonomous", bodyMarkdown: "Every engine takes the same three settings. **Off** does nothing. **Approve** does the work but leaves the last step to a human. **Autonomous** runs hands-off. The honest way to adopt these is Approve first — watch what each one proposes for a few days, then promote the ones you agree with.", targetDataTourId: "autonomy-autopilots", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Two rows mean something different", bodyMarkdown: "Most engines here send or act on your behalf. **Enrichment Sweep** and **Company Backfill** only fill in missing data, so for those two **Approve** means it runs when you press the button, rather than queuing a draft for review. The thing being gated is unattended spend, not an outward action.", targetDataTourId: "autonomy-autopilots", visualTreatment: "pulse", advanceCondition: "next_button" },
      { title: "They spend different budgets", bodyMarkdown: "Company Backfill draws on your LinkedIn account's daily lookup allowance. Enrichment Sweep spends email-verification credits. They have separate switches and separate caps on purpose — one control over two budgets is how you get a bill you did not choose.", targetDataTourId: "autonomy-autopilots", visualTreatment: "spotlight", advanceCondition: "next_button" },
      { title: "Run one now", bodyMarkdown: "When the sweep is on, a card appears here showing how many prospects are waiting, how many still need a company domain, and whether a verification key is set. The button runs one batch, so you can watch what it does before leaving it autonomous.", visualTreatment: "coach", advanceCondition: "next_button" },
      { title: "Or turn the whole stack on", bodyMarkdown: "This sets every engine to **Approve** at once — the safe setting. Nothing goes out without you seeing it first.", targetDataTourId: "autonomy-turn-on-all", visualTreatment: "arrow", advanceCondition: "next_button" },
    ],
  },
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
