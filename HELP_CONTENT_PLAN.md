# Help Content Plan — SDR Enablement (execute in a new session)

**Goal:** ship 20 help articles, 10 guided tours, and SDR daily routines, and make Ask AI
stronger (it's RAG over the articles, so the articles ARE the Ask-AI upgrade).
**Audience:** SDR team living in the app all day — Prospecting + CRM.
**Author context:** drafted with full app knowledge from the build/audit session (real flows,
recent fixes). New session should execute this spec, not re-derive it.

---

## Data model (confirmed against schema)

**`help_categories`** → seed first; articles reference `categoryId`.
**`help_articles`** columns: `workspaceId, categoryId, slug (unique per ws), title, summary,
bodyMarkdown, tags(json), status('published'), associatedTourId?, pageKey?, pageKeys(json)?,
readingTimeMinutes?`. Create via `helpCenter.upsertArticle` (adminWs) or seed.
**`tours`** columns: `workspaceId, name, description, type('onboarding'|'feature'|...),
roleTags(json), estimatedMinutes, status('published'), pageKey?`.
**`tour_steps`** columns: `tourId, sortOrder, targetSelector?, targetDataTourId?, routeTo?,
title, bodyMarkdown, visualTreatment('spotlight'|'pulse'|'arrow'|'coach'), advanceCondition
('next_button'|'element_clicked'|'route_changed'|...), skipAllowed, backAllowed`.

### Existing `data-tour-id` selectors (safe to target)
`sidebar-nav, help-button, dashboard-kpi-grid, dashboard-revenue-chart, dashboard-recent-opps,
pipeline-board, pipeline-view-toggle, pipeline-new-button, sequences-new-button,
contacts-new-button, leads-new-button, renewals-board, renewals-score-churn,
are-command-card, are-agents-section, are-active-campaigns, are-signal-feed,
ai-queue-stats, ai-queue-draft-list, ai-queue-approve-all`.
**No selectors exist** on Find Prospects, Prospects, the Enroll dialog, or Unified Inbox →
those tours use `visualTreatment:"coach"` + `routeTo` (page-level callouts), so **no new
`data-tour-id` attributes are required.** (Optional polish later: add ids there for spotlighting.)

## Seed approach (chosen: idempotent seed migration)

1. New module `server/seedHelpContent.ts`: `seedHelpContent(db, workspaceId)`.
   - Idempotent: upsert categories by `(workspaceId, slug)`, articles by `(workspaceId, slug)`,
     tours by `(workspaceId, name)`; insert steps only if the tour was just created (or
     delete+reinsert steps each run keyed by tourId for clean updates).
   - All articles `status:'published'`; tours `status:'published'`.
2. Call it from `seedWorkspace()` (so new workspaces get it) **and** add a one-time backfill in
   `runRawMigrations()` boot path for existing workspaces (loop workspaces → seedHelpContent).
   Tolerated errnos already cover re-runs.
3. Verify in Chrome: `/help` shows the categories/articles; `/help` Ask AI answers a
   prospecting question citing an article; `/tour-builder` (or the tours list) shows 10 tours.

> Mechanism note: `helpCenter.upsertArticle` already computes search indexing; if seeding raw,
> ensure `summary` + `bodyMarkdown` are populated so Ask AI retrieval works.

---

## CATEGORIES (6)
| slug | title | sortOrder |
|---|---|---|
| getting-started | Getting Started | 1 |
| prospecting | Prospecting | 2 |
| crm-pipeline | CRM & Pipeline | 3 |
| sequences-email | Sequences & Email | 4 |
| are | Autonomous Revenue Engine | 5 |
| playbooks | Daily Playbooks | 6 |

---

## ARTICLES (20 — full drafts)

> Each: `slug` · category · `readingTimeMinutes` · summary, then `bodyMarkdown`.

### GS-1 `welcome-to-velocity` · getting-started · 2 min
**Summary:** What Velocity is and how an SDR's day flows through it.
**Body:**
Velocity is your unified revenue workspace — prospecting, CRM, sequences, and inbox in one place,
so you never tab-hop between tools. As an SDR you'll spend most of your day in three areas:
**Prospects/Find Prospects** (build your list), **Sequences & Unified Inbox** (run outreach and
handle replies), and **Pipeline/Contacts** (track what's working). The left sidebar groups
everything: *Overview* (Dashboard, Inbox, Mailbox, Calendar), *Funnel* (Prospects, Leads,
Contacts), *Engage* (Sequences, Campaigns), and *Revenue Engine* (ARE). Start each day on the
**Dashboard** for your numbers, then move into prospecting. New here? Run the **Getting Started**
guided tour (Help → Tours) for a 3-minute walkthrough.

### GS-2 `navigating-the-app` · getting-started · 2 min
**Summary:** Sidebar, global search, and command bar.
**Body:**
The **sidebar** is your map — collapse it with the toggle, and it remembers your scroll position
between pages. **Global search** (top bar, or ⌘K) jumps to any record or page by name. Page
headers carry the primary action button on the right and a **sub-nav strip** beneath for related
pages (e.g. Sequences → Email Drafts / Email Analytics). The **? button** (bottom-right) opens
this Help Center from anywhere. Tip: most list pages support inline filters and CSV export from
the header.

### GS-3 `connect-email-linkedin` · getting-started · 3 min
**Summary:** Connect sending accounts and LinkedIn; why it matters for deliverability.
**Body:**
Before you send, connect your channels under **Connected Accounts** (sidebar → Engage area).
Add an email **Sending Account** (the address sequences send from) and bridge your **LinkedIn**
account at *My LinkedIn* for profile lookups and LinkedIn discovery. Watch the deliverability
signals on each sending account: warm-up status and daily send caps protect your sender
reputation. **Never blast** — Velocity enforces per-account daily caps and a suppression list
(unsubscribes + verified bounces) so you stay out of spam folders. If a LinkedIn search returns
nothing, your bridge session may have expired — reconnect it.

### PR-1 `find-prospects-discovery` · prospecting · 3 min
**Summary:** Use Find Prospects to discover net-new contacts.
**Body:**
**Find Prospects** (sidebar → Acquire) runs multi-source discovery against your ICP. Pick
**Person** or **Account** mode, fill the fields you care about (job title, seniority, industry,
location) and add keywords for intent. Click **Run discovery** — results fan out across LinkedIn,
web, and news, then get scored and de-duplicated automatically. Anything fully verified lands in
**Verified**; partial matches land in **Needs Review** for you to clean up. Click any result row
to open the full prospect. Skipped fields are ignored, so start broad and narrow if you get noise.

### PR-2 `needs-review-queue` · prospecting · 3 min
**Summary:** Triage the Needs Review queue: verify, fix, or discard.
**Body:**
The **Needs Review** tab holds prospects the system couldn't fully verify — usually a missing or
risky email, or a LinkedIn URL that didn't validate. Each card shows an **ICP-fit score**
(0–100) and a note explaining what needs attention. Click a card to open the prospect, then:
fix the email (use **Find contact info** to scrape + verify patterns), confirm the LinkedIn URL,
or **Archive** if it's junk. Prospects without a valid email can't be enrolled, so clear this
queue daily — it's where good leads hide behind a quick fix. High-fit + verified prospects are
your priority to move into a sequence.

### PR-3 `import-prospects-csv` · prospecting · 2 min
**Summary:** Bulk-import a list (LeadRocks, Apollo export, etc.).
**Body:**
Have a list already? On **Prospects**, click **Import CSV**. Map your columns (name, title,
company, email, LinkedIn URL) and import. Imported rows appear in the Prospects library with an
**email status** badge. CSV-imported prospects start without an ICP-fit score (that's only set by
Discovery), so use the email-status filter to find the deliverable ones. From there, select and
enroll into a sequence, or run **Find contact info** to verify emails before sending.

### PR-4 `understanding-scores-badges` · prospecting · 2 min
**Summary:** What the Fit score and email/verification badges mean.
**Body:**
Two signals tell you whether a prospect is worth your time. **ICP-fit score** (the colored "Fit"
number, 0–100) measures how well the prospect matches your target titles, industries, geos, and
keywords — green ≥70 (strong), amber 40–69 (moderate), red <40 (weak). **Email status** tells
you deliverability: *Valid* (safe to send), *Accept-All* / *Risky* (send with caution),
*Invalid* (don't), *Unverified* (run a check first). Prioritize **high Fit + Valid email**.
The verification badge (*Needs Review* vs *Verified*) reflects whether discovery could confirm
the record's core fields.

### PR-5 `enroll-prospects-sequence` · prospecting · 2 min
**Summary:** Move prospects into a sequence (no manual contact creation).
**Body:**
Prospects enroll into sequences **natively** — you don't need to convert them to contacts first.
From a sequence's **Enrollments → Enroll** dialog, open the **Prospects** tab, select the people
you want (those without an email are disabled), and click Enroll. The send engine reads the email
straight from the prospect record. You can also enroll from a prospect's detail page via **Add to
sequence**. Dedup is automatic — already-enrolled prospects are skipped. Watch the toast for how
many enrolled vs. were skipped or blocked for invalid email.

### CRM-1 `leads-contacts-accounts` · crm-pipeline · 3 min
**Summary:** The difference between Prospects, Leads, Contacts, and Accounts.
**Body:**
Four record types, four jobs. **Prospects** = your raw outbound list (discovery + CSV), not yet
qualified. **Leads** = inbound or qualifying individuals being scored/routed. **Contacts** =
people tied to a company **Account** you're actively working. **Accounts** = the companies, with
hierarchy and ARR rollup. Flow: a prospect who replies/qualifies becomes a lead or contact; the
contact's company is an account; deals on that account are **Opportunities** in the Pipeline.
Don't over-think it early — keep new outbound names as Prospects and promote as they engage.

### CRM-2 `managing-pipeline` · crm-pipeline · 3 min
**Summary:** Work the kanban: stages, moving deals, AI suggestions.
**Body:**
**Pipeline** shows opportunities as a kanban grouped by stage (discovery → qualified → proposal →
negotiation → won/lost). Drag a card between columns to change its stage, or — keyboard/no-mouse —
focus a card (Tab) and use the **◀ / ▶ Move** buttons on it. Cards show value, win probability,
and AI next-best-actions; if AI suggests a stage change you'll see an **Accept** chip. Use the
view toggle for the **Forecast** rollup. Every stage move is recorded in the opportunity's stage
history. Keep stages honest — the forecast and alerts depend on it.

### CRM-3 `logging-activities` · crm-pipeline · 2 min
**Summary:** Log calls, meetings, and notes on records.
**Body:**
On any contact, lead, account, or opportunity detail page, the **Activities** tab lets you log a
call (disposition, duration, outcome, notes), a meeting, or a quick note. The **Notes** tab keeps
pinnable notes. Logged activity feeds the record timeline and pipeline-health alerts (e.g. "no
activity in 14 days"). Make logging a reflex after every touch — it's what makes the CRM useful
to future-you and your manager, and it powers the stalled-deal alerts.

### CRM-4 `opportunities-deep-dive` · crm-pipeline · 2 min
**Summary:** Win probability, stages, and win/loss reasons.
**Body:**
An **Opportunity** is a deal on an account. It carries a value, a stage, and a win probability
(AI-generated when intelligence has run, else the stage default). When you move a deal to **Won**
or **Lost**, capture the **win/loss reason** in the inline editor on the detail page — this
field now persists correctly and feeds win/loss analysis. Use the **Related Tasks** widget to
keep next steps attached to the deal. Opportunities live on the Pipeline board; see CRM-2 for
moving them.

### SEQ-1 `build-a-sequence` · sequences-email · 4 min
**Summary:** Create a multi-step email/task cadence.
**Body:**
**Sequences** (sidebar → Engage) are multi-step cadences. Click **New sequence**, then add steps:
email steps (subject + body, with `{{firstName}}`, `{{company}}`, `{{senderName}}` merge fields),
**wait** steps (delays), and **task** steps (manual to-dos). Apply an Email Builder template to a
step, or write inline. Use the **Canvas** view for a visual builder or the list/Edit view —
they stay in sync. Set day caps and auto-stop rules so replies pause the sequence. When ready,
**Activate** it, then enroll prospects/contacts/leads (see PR-5). The engine creates and sends
drafts on cadence.

### SEQ-2 `email-builder-templates` · sequences-email · 3 min
**Summary:** Design reusable email templates.
**Body:**
**Email Builder** is a 3-panel drag-and-drop designer for HTML email templates — content blocks
on the left, canvas in the middle, properties on the right (all panels resize and persist). Build
reusable layouts for sequences and campaigns, preview on mobile, and **Publish** when ready
(drafts show a badge). Published and draft templates both appear in the sequence step picker.
Use the **Snippet Library** (header sub-nav) for reusable text fragments you drop into templates.

### SEQ-3 `unified-inbox` · sequences-email · 3 min
**Summary:** Handle replies across channels in one inbox.
**Body:**
The **Unified Inbox** consolidates inbound replies across every connected email account.
Conversations list on the left; open one to read the thread and reply, forward, or log it to a
CRM record without leaving the page. An inbound reply automatically **pauses** the prospect's
sequence and mirrors to the record timeline, so you won't double-touch someone who already
answered. Use the channel filter to focus. Header shortcuts: **Refresh**, **Manage Accounts**,
and **Email Drafts**.

### SEQ-4 `email-drafts-sending` · sequences-email · 3 min
**Summary:** Review AI/sequence drafts and send safely.
**Body:**
**Email Drafts** is the review queue for messages sequences and AI created. Each draft can be
edited, approved, or rejected. **Send** (single) and **Send All Approved** now require a quick
confirm — because sends are real and can't be recalled. Before sending, drafts are checked
against the **suppression list** (unsubscribes + verified bounces) and per-account daily caps.
Filter by status (pending review / approved / sent / bounced). Bounces here flow back to
deliverability data — keep an eye on the bounced tab.

### ARE-1 `are-overview` · are · 3 min
**Summary:** What the Autonomous Revenue Engine does.
**Body:**
The **Autonomous Revenue Engine (ARE)** runs prospecting on autopilot. Per campaign it
**discovers** prospects against your ICP (rotating through query "slices" for coverage),
**enriches** the best-fit ones, generates **sequences/drafts**, and — depending on autonomy mode
— sends or queues them for your approval. The ARE Hub shows the pipeline funnel (discovered →
enriched → approved → contacted → replied → meetings) and per-agent status. Think of ARE as a
junior SDR that fills your top-of-funnel while you work replies and live deals.

### ARE-2 `are-tuning-campaign` · are · 3 min
**Summary:** Configure autonomy mode, the fit gate, and throttles.
**Body:**
Open a campaign → **Settings** to tune it. **Autonomy mode**: *Full* (discover→send, no human),
*Batch approval* (you approve batches), *Review & release* (approve each). **Enrichment fit gate
(minConfidence)**: only prospects whose ICP-fit score clears this threshold get enriched — raise
it to save budget on weak fits, lower it for volume (default 40). **Auto-approve threshold**:
auto-approve prospects above a fit score. Set the **daily send cap** and channels. Targeting
(titles/industries/geos/keywords) drives discovery — weak targeting = weak prospects, so invest
here first.

### PLAY-1 `sdr-morning-routine` · playbooks · 4 min
**Summary:** The recommended morning prospecting block.
**Body:**
A repeatable morning beats heroics. **1) Dashboard (5 min):** scan your numbers and overdue
tasks. **2) Inbox & replies (15 min):** clear the **Unified Inbox** — every reply gets a response
or a logged next step; sequences auto-pause on reply so focus on movers. **3) Needs Review
(15 min):** triage the **Find Prospects → Needs Review** queue — fix emails, verify, archive junk
(see PR-2). **4) Build list (20 min):** run **Find Prospects** against today's ICP slice; enroll
high-Fit + Valid-email prospects into the right sequence (PR-5). **5) Approve drafts (10 min):**
clear **Email Drafts** / **AI Pipeline** so the engine keeps sending. Then spend the rest of the
day on live conversations and pipeline.

### PLAY-2 `crm-hygiene-eod` · playbooks · 3 min
**Summary:** End-of-day CRM hygiene checklist.
**Body:**
Five minutes at EOD keeps your pipeline trustworthy. **✓ Log every touch** — calls, meetings,
notes on the relevant record (CRM-3). **✓ Update stages** — move any opportunity that progressed;
honest stages = honest forecast (CRM-2). **✓ Capture win/loss reasons** on closed deals. **✓
Set next steps** — add a task to every active deal/contact so nothing goes dark (pipeline alerts
catch 14-day silence, but don't rely on them). **✓ Clear approvals** — leave the Email Drafts
queue empty so overnight sends fire. Consistency here is what separates the top of the
leaderboard from the rest.

### PLAY-3 `weekly-pipeline-review` · playbooks · 3 min
**Summary:** A simple weekly self-review.
**Body:**
Once a week, step back. Open **Pipeline** (Forecast view) and **Email Analytics**: Which
sequences/steps get opens and replies? Which stages are stalling (check **Pipeline Alerts**)?
Re-rank your prospecting: double down on the ICP slices and sequences that produce meetings, and
retire the ones that don't. Update your ARE campaign's fit gate/targeting based on what actually
converted. Archive dead prospects so your lists stay clean. A 20-minute weekly review compounds.

*(GS-1..3, PR-1..5, CRM-1..4, SEQ-1..4, ARE-1..2, PLAY-1..3 = 20 articles.)*

---

## GUIDED TOURS (10 — full step copy)

> step = `title` | `body` | target (`data-tour-id` or `routeTo` + coach) | advance.

### T1 `Getting Started` · onboarding · 3 min · roleTags:[sdr] · pageKey:dashboard
1. "Welcome to Velocity" | Quick 3-min tour of where you'll work each day. | coach, routeTo:/dashboard | next
2. "Your sidebar" | Everything's grouped here: Overview, Funnel, Engage, Revenue Engine. | `sidebar-nav` spotlight | next
3. "Your daily numbers" | The Dashboard is your morning home — pipeline, leads, customers. | `dashboard-kpi-grid` spotlight | next
4. "Help anytime" | Click ? for articles, Ask AI, and these tours. | `help-button` pulse | next

### T2 `Your Daily Dashboard` · feature · 2 min · pageKey:dashboard
1. "KPIs at a glance" | Pipeline value, closed-won, leads, customers — vs. goal. | `dashboard-kpi-grid` spotlight | next
2. "Revenue trend" | Track momentum month over month. | `dashboard-revenue-chart` spotlight | next
3. "Recent opportunities" | Jump straight into active deals. | `dashboard-recent-opps` spotlight | next

### T3 `Find Prospects` · feature · 3 min · pageKey:find-prospects (coach — no selectors)
1. "Discover net-new prospects" | Multi-source discovery against your ICP. | coach, routeTo:/find-prospects | route_changed
2. "Pick a mode" | Person or Account — fill only the fields you care about. | coach | next
3. "Run discovery" | Results fan out across LinkedIn, web, and news, then get scored + deduped. | coach | next
4. "Verified vs Needs Review" | Clean matches land in Verified; partials in Needs Review for you to fix. | coach | next

### T4 `Working Needs Review` · feature · 3 min · pageKey:find-prospects (coach)
1. "Why review?" | These prospects need an email fixed or a LinkedIn URL confirmed. | coach, routeTo:/find-prospects | next
2. "Read the Fit score + note" | The score (0–100) and the amber note tell you what to do. | coach | next
3. "Open & fix" | Click a card → Find contact info to verify the email, or Archive junk. | coach | next
4. "Then enroll" | High-Fit + Valid email → into a sequence. | coach | next

### T5 `Enroll into a Sequence` · feature · 2 min · pageKey:prospects (coach)
1. "From prospect to outreach" | Prospects enroll natively — no contact conversion needed. | coach, routeTo:/sequences | next
2. "Open Enroll" | In a sequence's Enrollments, click Enroll → Prospects tab. | coach | next
3. "Select & go" | Pick prospects (no-email rows are disabled), click Enroll. The engine sends. | coach | next

### T6 `Build Your First Sequence` · feature · 4 min · pageKey:sequences
1. "Create a cadence" | Multi-step email + wait + task steps. | `sequences-new-button` pulse | element_clicked
2. "Add steps" | Email (with merge fields), waits, and tasks; apply a template or write inline. | coach | next
3. "Activate & enroll" | Turn it on, then enroll prospects/contacts/leads. | coach | next

### T7 `Master the Pipeline` · feature · 3 min · pageKey:pipeline
1. "Your deals as a board" | Opportunities grouped by stage. | `pipeline-board` spotlight | next
2. "Move a deal" | Drag, or focus a card and use the ◀/▶ Move buttons. | `pipeline-board` coach | next
3. "Forecast view" | Toggle to the per-rep rollup. | `pipeline-view-toggle` spotlight | next
4. "Add an opportunity" | New deals start here. | `pipeline-new-button` pulse | next

### T8 `Handle Replies (Unified Inbox)` · feature · 3 min · pageKey:unified-inbox (coach)
1. "All replies, one place" | Inbound across every connected account. | coach, routeTo:/unified-inbox | route_changed
2. "Reply & log" | Respond, forward, or log to a CRM record without leaving. | coach | next
3. "Auto-pause" | A reply pauses that prospect's sequence automatically. | coach | next

### T9 `ARE: Autonomous Campaigns` · feature · 4 min · pageKey:are-hub
1. "Prospecting on autopilot" | ARE discovers, enriches, sequences, and (optionally) sends. | `are-command-card` spotlight | next
2. "The agents" | ICP, Enrich, and outreach agents do the work. | `are-agents-section` spotlight | next
3. "Active campaigns" | Monitor funnel flow per campaign. | `are-active-campaigns` spotlight | next
4. "Tune it" | Set autonomy mode + the enrichment fit gate in campaign Settings. | coach, routeTo:/are/campaigns | next

### T10 `AI Pipeline: Review Drafts` · feature · 3 min · pageKey:ai-pipeline
1. "AI-drafted outreach" | Review what the engine prepared. | `ai-queue-stats` spotlight | next
2. "The draft queue" | Edit, approve, or reject each. | `ai-queue-draft-list` spotlight | next
3. "Approve in bulk" | Clear the queue so sends fire. | `ai-queue-approve-all` pulse | next

---

## Ask AI enhancement
1. The 20 articles above ARE the corpus — once seeded, Ask AI retrieval improves immediately.
   Verify `summary` + `bodyMarkdown` are populated (retrieval reads them).
2. Review `helpCenter.askAI` system prompt (server/routers/helpCenter.ts ~line 260): ensure it
   (a) grounds answers in retrieved articles, (b) is SDR-task oriented ("answer as an enablement
   coach; cite the article"), (c) falls back gracefully. Add a few **suggested prompts** to the
   Ask AI tab UI seeded from common SDR questions ("How do I clear Needs Review?", "How do I
   enroll prospects?", "What's my morning routine?").
3. Optional: link each article to its tour via `associatedTourId` so Ask AI can say "…or take the
   guided tour" with a launch button.

## Acceptance checklist (new session)
- [ ] `seedHelpContent.ts` written; called from seedWorkspace + boot backfill.
- [ ] 6 categories, 20 articles (published), 10 tours (published) seeded idempotently.
- [ ] `/help` browse shows categories + articles; reading time + tags render.
- [ ] Ask AI answers "How do I work the Needs Review queue?" citing PR-2.
- [ ] Tours list shows 10; launch T3 (Find Prospects) and T7 (Pipeline) — steps land on the right
      elements / pages.
- [ ] Commit per logical chunk; verify live in Chrome (Personal Chrome, LSI Media).

---

## RESUME PROMPT (paste into the new session)
```
Continue Velocity/usip (igrant9679/usip → getvelocityai.app, repo C:\Users\Admin\usip).
Read SESSION_HANDOFF.md and HELP_CONTENT_PLAN.md at the repo root first.

Task: implement HELP_CONTENT_PLAN.md — seed 6 help categories, 20 articles, and 10 guided tours
as an idempotent seeder (server/seedHelpContent.ts), called from seedWorkspace() and a one-time
boot backfill for existing workspaces; and apply the Ask AI enhancements. Full article bodies and
tour step copy are in the plan — use them verbatim. Schema: help_categories/help_articles/tours/
tour_steps (columns listed in the plan). Tours with no data-tour-id use coach steps + routeTo.

Hard constraints (from SESSION_HANDOFF.md): no local toolchain — static review only; schema
changes go in drizzle/schema.ts AND server/_core/rawMigrations.ts; commit + push per change with
the igrant9679 identity + the Opus co-author trailer; plan-approve before large code lands; ask
which Chrome browser before driving it. Verify the acceptance checklist live in Chrome at the end.
```
