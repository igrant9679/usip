# USIP Requirements Status Notes (extracted from doc pages 10-14)

## Module 3 — Prospect Intelligence (INT-001 to INT-015)
INT-001: Aggregate public prospect info from LinkedIn, company websites, press releases, news, social media — Must Have
INT-002: Unified 360-degree Prospect Intelligence Card — Must Have
INT-003: Monitor/surface trigger events (funding, exec hires, product launches, M&A) — Must Have
INT-004: LinkedIn org chart data (reporting relationships, dept structures, team sizes) — Must Have
INT-005: Account Watch Lists + daily/real-time digest notifications — Must Have
INT-006: Aggregate prospect social media activity (LinkedIn, Twitter/X) with sentiment — Should Have
INT-007: AI Personalization Insights summary per prospect — Must Have
INT-008: Keyword-based news monitoring across source lists — Must Have
INT-009: Competitive Intelligence module — Should Have
INT-010: Mutual connections identification via LinkedIn (OAuth-based) — Should Have
INT-011: AI-written Account Research Brief (1-page executive summary, exportable PDF) — Must Have
INT-012: Technology Stack Discovery (job postings, G2, website analysis) — Must Have
INT-013: Website visitor tracking via JS pixel, correlated to CRM record — Should Have
INT-014: Tag, annotate, share research notes on prospects/accounts — Must Have
INT-015: Prospect Scoring engine (1-100, firmographic + behavioral + intent weights) — Must Have

## Module 4 — CRM & Pipeline (CRM-001 to CRM-020)
CRM-001: Full CRUD on Contacts, Accounts, Leads, Opportunities, Activities, Tasks, Notes — Must Have ✅ DONE
CRM-002: Configurable pipeline manager (user-defined stages, probability %, forecast values) — Must Have ✅ DONE
CRM-003: Log calls, emails, meetings, tasks from CRM with auto-association — Must Have ✅ DONE
CRM-004: Kanban deal board with drag-and-drop stage progression + color-coded health — Must Have ✅ DONE
CRM-005: Auto-create/update CRM records from prospecting/intelligence modules — Must Have (partial)
CRM-006: Workflow Automation rules (20+ trigger conditions, stackable actions) — Must Have ✅ DONE
CRM-007: Customizable Dashboard builder (charts, tables, funnels, metrics) — Must Have ✅ DONE
CRM-008: Standard out-of-box reports (pipeline by stage, conversion, deal velocity, quota) — Must Have (partial)
CRM-009: Quotas per user/team, monthly/quarterly/annual, real-time attainment — Must Have ✅ DONE
CRM-010: Lead Routing engine (auto-assign by geography/industry/round-robin/ownership) — Must Have ✅ DONE
CRM-011: Custom fields, custom objects, custom page layouts (no-code admin) — Must Have ✅ DONE (custom fields)
CRM-012: RBAC with org-wide defaults, object-level permissions, field-level security — Must Have ✅ DONE
CRM-013: Native CPQ module (product catalog, price books, discount approval, PDF quotes) — Should Have ✅ DONE
CRM-014: Customer Success module (health score, renewal pipeline, NPS, escalation workflows) — Should Have ✅ DONE
CRM-015: Complete audit trail (creates/updates/deletes, user, timestamp, before/after) — Must Have ✅ DONE
CRM-016: Forecasting module with AI-driven deal outcome predictions (commit/best-case/pipeline) — Must Have (partial - pipeline exists, AI forecast not yet)
CRM-017: Email campaigns from CRM contact lists with open/click/reply tracking — Must Have (partial)
CRM-018: Bi-directional calendar sync (Google Calendar, Outlook/Exchange) — Must Have (not done)
CRM-019: Territory Management (geography/industry/custom rules, assign reps) — Should Have ✅ DONE
CRM-020: Native mobile apps (iOS/Android) with offline access — Must Have (out of scope for web build)

## Module 5 — Sequence & Engagement (SEQ-001 to SEQ-010)
SEQ-001: Multi-channel Sequence Builder (email, phone, LinkedIn, SMS, direct mail) — Must Have ✅ DONE (visual canvas)
SEQ-002: Enroll individual contacts or bulk lists with personalization variable previews — Must Have (partial)
SEQ-003: Auto-pause/remove on reply detection, meeting booking, unsubscribe — Must Have (partial - status exists, no auto-trigger)
SEQ-004: A/B testing for sequence steps (email variants, auto-promote winner) — Must Have (partial)
SEQ-005: Sequence branching logic (IF/THEN with unlimited depth) — Must Have ✅ DONE (condition nodes in canvas)
SEQ-006: Dialer integration (click-to-call, call logging, voicemail drop, local presence) — Must Have (not done)
SEQ-007: LinkedIn Sales Navigator API integration — Should Have (not done)
SEQ-008: Sequence-level and account-level sending limits — Must Have (not done)
SEQ-009: Task Management queue (pending outreach tasks prioritized by prospect score) — Must Have (partial)
SEQ-010: Track email open events (pixel), link click (redirect), reply events → CRM timeline — Must Have (not done - columns exist, no writers)

## Module 6 — Analytics & Reporting (ANL-001 to ANL-008)
ANL-001: Revenue Intelligence dashboard (pipeline health, forecast accuracy, stage conversion, deal velocity) — Must Have (partial - dashboard exists, not full BI)
ANL-002: Sequence Performance analytics (open/reply/positive reply/meeting booked/unsubscribe per step) — Must Have (not done - columns exist, no tracking)
ANL-003: Contact/Account engagement scores (email interactions, website visits, social, sequence participation) — Must Have (partial)
ANL-004: No-code Report Builder (drag-drop field selection, grouping, filtering, saveable/schedulable) — Must Have (not done)
ANL-005: Sales Activity Report (dials, emails sent, meetings, demos, proposals per rep vs targets) — Must Have (not done)
ANL-006: Funnel analysis (first touch → closed-won, stage-by-stage conversion, time-in-stage) — Must Have (not done)
ANL-007: AI-generated Weekly Business Review summary emailed to managers — Should Have (not done)
ANL-008: BI tool integration (Tableau, Power BI, Looker) + data warehouse export — Should Have (not done)

## Module 7 — Integrations & Platform API (INT-P-001 to INT-P-008)
INT-P-001: Native 2-way integration with Salesforce, HubSpot, Pipedrive, Zoho, Microsoft Dynamics — Must Have (not done)
INT-P-002: Zapier/Make connector (all major platform events as triggers + write actions) — Must Have (not done)
INT-P-003: Gmail/Outlook integration (mailbox connection, email sync, inbox monitoring, send via own domain) — Must Have (not done)
INT-P-004: Webhook framework (real-time event push to external endpoints, retry logic, HMAC signing) — Must Have (partial - UI exists, no actual delivery)
INT-P-005: REST API + GraphQL API with versioning, sandbox, SDKs (Python, JS, Ruby) — Must Have (not done)
INT-P-006: Slack + Microsoft Teams integration (notifications, command-based actions, deal alerts) — Must Have (not done)
INT-P-007: SSO via SAML 2.0 and OIDC + SCIM 2.0 — Must Have (SCIM stub done, SSO not done)
INT-P-008: Video conferencing integration (Zoom, Google Meet, Teams) for one-click meeting scheduling — Must Have (not done)

## Module 8 — Security & Compliance (SEC-001 to SEC-008)
SEC-001: TLS 1.2+ in transit, AES-256 at rest — Must Have (infrastructure-level, not app-level)
SEC-002: GDPR/CCPA/CASL/CAN-SPAM compliance (consent, right-to-erasure, DPA) — Must Have (not done)
SEC-003: SOC 2 Type II certification — Must Have (infrastructure-level)
SEC-004: MFA (TOTP/SMS/hardware key), admin-mandatable org-wide — Must Have (not done)
SEC-005: Complete data isolation between tenants — Must Have ✅ DONE (workspaceId on all queries)
SEC-006: Security Event log (auth events, permission changes, data exports, API calls) — Must Have (partial - audit log done, not security-specific)
SEC-007: Data residency options (US/EU/APAC) — Should Have (not done)
SEC-008: Configurable IP allowlisting — Should Have ✅ DONE (Settings → Security)

## Capability Requirements (CAP-001 to CAP-012)
CAP-001: 100,000 concurrent users, P99 < 500ms — Must Have (infrastructure)
CAP-002: 99.9% uptime SLA — Must Have (infrastructure)
CAP-003: Data verified/refreshed on rolling 90-day basis — Must Have (not done)
CAP-004: AI email generation >70% user acceptance rate — Must Have (qualitative)
CAP-005: Full-text search < 3 seconds for 10,000 records — Must Have (partial)
CAP-006: Mobile app Lighthouse score 85+ — Must Have (mobile app not built)
CAP-007: 50M CRM records, 500 active sequences, 10TB attachments per tenant — Should Have (infrastructure)
CAP-008: 99.5% integration sync success rate — Must Have (infrastructure)
CAP-009: Bulk AI email generation 10,000/hour — Must Have (infrastructure)
CAP-010: RTO 4 hours, RPO 1 hour — Must Have (infrastructure)
CAP-011: GDPR Article 30 RoPA reports, DSAR exports — Must Have (not done)
CAP-012: UI in English, Spanish, French, German, Portuguese, Dutch, Japanese — Should Have (not done)

## Module 9 — Visual Marketing Automation (MKT-001 to MKT-028)
### 18.1 Visual Canvas Sequence Builder
MKT-001: Infinite pannable/zoomable canvas (25-200%) with drag-drop node components (Start, Email, Wait, Condition, Action, Goal) — Must Have ✅ DONE
MKT-002: ConditionNodes evaluate engagement signals (email opened, link clicked, lead replied, lead score threshold, lead status, field value) — Must Have (partial - condition nodes exist, signal evaluation not wired)
MKT-003: ActionNodes support Update Lead Status, Assign Lead, Add/Remove Tag, Create Task, Send Notification — Must Have (partial - action node type exists, sub-actions not configured)
MKT-004: Edge validation (ConditionNode requires exactly 2 outgoing edges labeled true/false) — Must Have ✅ DONE
MKT-005: Undo/redo stack (50 steps), 30s autosave, fit-to-screen — Must Have ✅ DONE
MKT-006: Sequence lifecycle Draft → Active → Paused → Archived, canvas read-only when Active/Paused — Must Have ✅ DONE
MKT-007: Automatic lead enrollment triggers per sequence (status change, tag applied, score threshold) — Must Have (not done)
MKT-008: Backend sequence execution engine on 5-min cron, batch 100, retry with exponential backoff — Must Have (not done)

### 18.2 Three-Component Lead Scoring Engine
MKT-009: Firmographic Score (max 40 pts, org type, title, seniority, data completeness) — Must Have ✅ DONE
MKT-010: Behavioral Engagement Score (max 30 pts, email opens/clicks/replies, sequence steps, decay 10%/30 days) — Must Have ✅ DONE
MKT-011: AI Fit Score (max 30 pts, structured AI run, JSON fit_score field) — Must Have ✅ DONE
MKT-012: Score Configuration UI (all weights, max caps, Sales Ready threshold, Recalculate All) — Must Have ✅ DONE
MKT-013: Lead list with colored tier badges (Cold/Warm/Hot/Sales Ready), score breakdown accordion, 90-day sparkline — Must Have ✅ DONE

### 18.3 AI Research-to-Email Draft Pipeline
MKT-014: 5-stage AI pipeline (Org Research → Contact Research → Fit Analysis JSON → 3-variant Draft Generation → Queue) — Must Have (not done)
MKT-015: Pipeline triggerable 4 ways: manual, bulk multi-select, auto-on-sequence-enroll, nightly batch above score threshold — Must Have (not done)
MKT-016: Email Draft Review Queue with bulk approval, individual draft editing, Regenerate function with revision presets — Must Have (not done)
MKT-017: Research Context accordion in review panel (org + contact + fit JSON) — Must Have (not done)

### 18.4 Dynamic Audience Segmentation
MKT-018: Visual rule-builder for named audience segments (AND/OR nested conditions, live count badge) — Must Have (not done)
MKT-019: Dynamic (re-evaluated at send time) + Static (snapshot) segment types, Lock Snapshot action — Must Have (not done)
MKT-020: 6 non-deletable System Segments auto-provisioned on org creation — Must Have (not done)
MKT-021: Segments selectable as recipient sources in Email Campaigns + Sequence Builder enrollment — Must Have (not done)

### 18.5 Visual Drag-and-Drop Email Builder
MKT-022: Three-panel email builder (block library / canvas / properties) with drag-drop Text, Image, Button, Divider, Spacer, Social Icons, Unsubscribe into 1/2/3-col row layouts — Must Have ✅ DONE
MKT-023: Serialize canvas design_data JSON → inline-CSS HTML; Send Test Email function — Must Have (partial - serialization done, Send Test Email not done)
MKT-024: Template library with visual gallery, thumbnail previews, category filters, versioning with revert — Must Have ✅ DONE
MKT-025: Desktop (600px), tablet (480px), mobile (375px) preview modes in iframe + Export HTML — Should Have (partial - desktop/mobile done, tablet not done, Export HTML not done)

### 18.6 Pre-Send Checklist & Marketing Dashboard
MKT-026: Pre-Send Checklist modal before campaign/sequence activates (subject present, unsubscribe block, SPF/DKIM/DMARC, recipient count > 0, no broken links, spam score) — Must Have (partial - campaign checklist done, not email-specific)
MKT-027: Marketing dashboard with Revenue Pipeline card, Lead Score Distribution histogram, Campaign ROI widget, AI Pipeline Status card, Sequence Health widget — Must Have (not done)
MKT-028: AI Prompt Settings with version history, A/B testing, per-segment prompt variants, auto-trigger rules — Should Have ✅ DONE (Prompt Templates page)

## Module 10 — Advanced CRM Intelligence (CRMA-001 to CRMA-013)
### 19.1 Account Hierarchy & Lead Conversion
CRMA-001: Parent-child Account relationships, hierarchy tree view, rollup ARR + contact count — Must Have ✅ DONE
CRMA-002: Formal Lead-to-Contact Conversion workflow (match/create Account, map fields, configurable) — Must Have ✅ DONE
CRMA-003: On conversion, transfer marketing activity (emails, sequences, research, AI drafts) to Contact record — Must Have (partial - conversion done, activity transfer not done)
CRMA-004: Opportunity Contact Roles (Economic Buyer, Technical Buyer, Champion, End User, Decision Maker, Other, is_primary) — Must Have ✅ DONE
CRMA-005: Opportunity Credit Splitting (multiple reps, split %, sums to 100%) — Should Have (not done)

### 19.2 AI Opportunity Intelligence
CRMA-006: AI Win Probability badge on opportunity (machine-predicted, distinct from manually entered %, based on stage/days/engagement/deal size/competitor) — Must Have (not done)
CRMA-007: Next Best Action panel on opportunity detail (AI-generated action type, description, urgency, Execute button) — Must Have (not done)
CRMA-008: Conversation Intelligence (auto-analyze meeting/call notes, extract action items as Tasks, deal signals as badges, 2-sentence AI summary on activity record) — Must Have (not done)
CRMA-009: Opportunity Stage History log (every transition: previous stage, new stage, changed-by, timestamp, days-in-stage) — Must Have (not done)

### 19.3 Account Intelligence & Generative CRM Content
CRMA-010: AI Account Brief (300-word narrative, relationship history, key contacts, open opps, risks, talking points; refreshed weekly; PDF export) — Must Have (not done)
CRMA-011: Email Effectiveness Score (1-10) on draft review panel (AI analysis of subject + body, improvement suggestions, 3 alternative subject lines) — Must Have (not done)
CRMA-012: Pipeline Health Alert system (daily check, in-app notifications for at-risk conditions: no activity 14+ days, closing this week with stage regression, significant amount change, high-value deal with no champion) — Must Have (not done)
CRMA-013: 4 Generative CRM Content actions (Account Summary Generator, Opportunity Brief Generator, Win Story Generator, Outreach Sequence Generator) — Should Have (not done)

## Module 11 — Customer Success & Expansion Revenue (CS-EXT-001 to CS-EXT-006)
CS-EXT-001: Health Score (4 components: Support Ticket Score, Engagement Score, Renewal Score, NPS Score; tiers Green 70-100, Yellow 40-69, Red 0-39; history 24 months) — Must Have ✅ DONE
CS-EXT-002: Churn Risk auto-flag (score < 40 AND renewal within 120 days → urgent Task + in-app alert) — Must Have ✅ DONE
CS-EXT-003: QBR management module (Account, Date, Attendees, Agenda, Key Wins, Challenges, Next Quarter Goals, Action Items, NPS; AI QBR Prep generator) — Must Have ✅ DONE
CS-EXT-004: Contract renewal reminders (Tasks at 90/60/30 days before end date + email notification) — Must Have (partial - renewals Kanban done, automated task creation not done)
CS-EXT-005: Contract Amendments (new amendment against parent contract, effective date, description, new ARR, amendment history chain) — Should Have ✅ DONE
CS-EXT-006: Expansion Revenue dashboard (Expansion ARR vs New Logo ARR, Cross-Sell Intelligence panel, Expansion Opportunities pipeline) — Must Have (partial - expansion potential surfaced on customer detail, not a full dashboard)

## Module 11 (continued)
CS-EXT-007: Customer Success overview dashboard (portfolio view with health score indicators, Churn Risk section, Upcoming Renewals next 90 days, NPS trend chart) — Must Have (partial - customer list + renewals Kanban done, not a unified CS dashboard)

## Module 12 — Social Publishing & Editorial Calendar (SOC-001 to SOC-007)
SOC-001: OAuth 2.0 connections to LinkedIn, Twitter/X, Facebook, Instagram for direct post publishing — Must Have (stub done - UI exists, no real OAuth)
SOC-002: Visual Publishing Calendar (month/week/day views, both social + blog/CMS content, drag-to-reschedule) — Must Have ✅ DONE (30-day calendar)
SOC-003: Post Composer with per-platform character count enforcement (LinkedIn 3,000 / Twitter 280 / Facebook 63,206 / Instagram 2,200), platform preview tab, media upload, first-comment support for LinkedIn — Must Have (partial - composer done, character limits not enforced, no media upload)
SOC-004: Generate 3 AI content variants per social campaign, select/edit/regenerate before scheduling — Must Have ✅ DONE
SOC-005: Track and display published post performance metrics (impressions, engagements, clicks, reach) — Should Have ✅ DONE (mock numbers)
SOC-006: Backend scheduled publishing endpoint + auto-publish background job, content pipeline status view, Schedule vs Publish Now split button — Must Have (partial - status flow done, no real background job)
SOC-007: Recommend optimal posting times per platform based on engagement patterns — Should Have (not done)

## Module 13 — Data Import, Prospecting & Enrichment (IMP-001 to ENR-005)
### 24.1 CSV Import
IMP-001: CSV import wizard (up to 50,000 rows), visual field-mapping interface, column-to-system-field matching — Must Have (not done)
IMP-002: Row validation before commit (duplicate emails, missing required fields, malformed emails/phones), downloadable error report — Must Have (not done)
IMP-003: Email verification on every imported email (Valid/Risky/Invalid/Unknown tags), filter/exclude before commit — Must Have (not done)
IMP-004: Duplicate detection on import (email exact match, first+last+company fuzzy match), per-row options: skip/overwrite/merge — Must Have (not done)
IMP-005: Post-import actions (assign import source tag, set record owner, enroll in sequence, add to segment) — Must Have (not done)
IMP-006: Import History log (filename, date, user, total rows, imported, skipped, errors, links to files) — Must Have (not done)

### 24.2 Clodura AI Direct Connector
CLO-001: Native Clodura AI API connector in Integrations admin panel (API key, on-demand + scheduled pulls) — Must Have (not done)
CLO-002: Clodura-powered prospect search from platform UI, results in dedicated pane, one-click import — Must Have (not done)
CLO-003: Clodura API to enrich existing contact/account records (single or batch), field-level diff for review — Must Have (not done)
CLO-004: Clodura org chart sync (reporting relationships, dept, team size), interactive expand/collapse visualization — Must Have (not done)
CLO-005: Clodura Usage Dashboard (API calls, credits consumed, records imported, monthly credit-limit alerts) — Should Have (not done)

### 24.3 LinkedIn Prospect Scraping & Capture
LNK-001: Chrome/Edge browser extension for one-click capture from LinkedIn profile pages, search pages, Sales Navigator — Must Have (not done - browser extension is out of scope for web build)
LNK-002: Extension captures Full Name, Title, Company, Location, LinkedIn URL, Connection Degree, email/phone if displayed — Must Have (not done)
LNK-003: Bulk capture from LinkedIn search result pages (up to 25 profiles per page) — Must Have (not done)
LNK-004: OAuth-based LinkedIn account connection for 1st/2nd/3rd degree connection paths — Must Have (not done)
LNK-005: Extension captures LinkedIn Company page data (employee count, HQ, industry, description, recent updates) — Should Have (not done)

### 24.4 Web Page & Directory Scraping
WEB-001: Web Scraper module (target URL, field selectors, structured extraction from company websites, directories, conference lists) — Must Have (not done)
WEB-002: Multi-page directory scraping with pagination (next-page URL template, max page count, up to 500 pages per job) — Must Have (not done)
WEB-003: Pre-built scraping connectors (Google Maps, Yellow Pages/Yelp, Crunchbase, AngelList, SAM.gov, generic HTML table) — Must Have (not done)
WEB-004: Async job queue with real-time progress, job completion report (URLs scraped, records extracted, duplicates, errors), CSV download before commit — Must Have (not done)
WEB-005: AI-assisted field extraction on raw HTML (LLM identifies/normalizes name/title/company/email/phone/address, confidence score per field) — Should Have (not done)
WEB-006: Save named Scraping Job Templates, re-run manually or weekly/monthly scheduled — Should Have (not done)

### 24.5 Email Verification
VER-001: 4-layer email verification (syntax, DNS/MX, SMTP handshake without sending, disposable/role-based detection), tags: Valid/Accept-All/Risky/Invalid/Unknown — Must Have (not done)
VER-002: Bulk email verification on any filtered contact list, background job, post-verification summary report — Must Have (not done)
VER-003: Auto re-verify on configurable schedule (default 90 days), nightly batch on stale records, hard bounce → Invalid + suppress — Must Have (not done)
VER-004: Third-party email verification API integration (ZeroBounce, NeverBounce, Kickbox) as fallback — Must Have (not done)
VER-005: Email verification status on all contact list views (colored badge), enforced at sequence enrollment, Pre-Send Checklist item — Must Have (not done)
VER-006: Catch-all mail server detection, flag as Accept-All/Unverifiable, configurable negative modifier to lead score — Should Have (not done)

### 24.6 Continuous Contact Enrichment
ENR-001: One-click Enrich button on any contact/account record (queries all connected enrichment sources, field-by-field diff view, accept/reject per field) — Must Have (not done)
ENR-002: Scheduled automatic enrichment (weekly or monthly cadence), admin defines auto-overwrite vs manual review fields, notify record owner on significant change — Must Have (not done)
ENR-003: Job-change signal detection (title/company/LinkedIn URL changes between enrichment cycles), surface as trigger event in Prospect Intelligence feed, optionally auto-enroll in re-engagement sequence — Must Have (not done)
ENR-004: Data Health Dashboard (total records, % with verified emails, % with phone numbers, % enriched last 90 days, estimated duplicate count, missing key fields, per-category Fix Now quick actions) — Must Have (not done)
ENR-005: Data provenance tracking at field level (source: CSV import/Clodura/LinkedIn/Web scrape/Manual entry/Campaign bounce, timestamp of last update, visible as tooltip) — Should Have (not done)

## Module 14 — User Management & Multi-User Platform (USR-001 to USR-013)
USR-001: Up to 50 named user accounts per tenant, license enforcement, user creation blocked at API when limit reached; user profile: First/Last Name, Email, Profile Photo, Job Title, Phone, Time Zone, Language, Notification Preferences — Must Have (partial - user management done, no 50-user limit enforcement, no profile photo/phone/TZ/language fields)
USR-002: Admins can create, edit, deactivate, permanently delete users; deactivation reassigns all open records within 60 seconds — Must Have ✅ DONE
USR-003: Bulk user import via CSV (Name, Email, Role, Team), bulk deactivation, downloadable CSV template, audit log entry per bulk op — Should Have (not done)
USR-004: Personal performance profile page (emails sent, calls logged, meetings held, sequences active, opportunities owned, quota attainment; visible to user + direct manager) — Should Have (not done)
USR-005: 4 standard roles: Super Admin, Admin, Manager, Rep — Must Have ✅ DONE
USR-006: Custom permission sets (object-level create/read/update/delete, field-level read/edit, record ownership visibility) — Must Have (not done - role-based only, no custom permission sets)
USR-007: Team Structures (create named teams, assign manager, add members, teams visible in assignment dropdowns, reporting filters) — Must Have (not done - roles exist, no formal team objects)
USR-008: Quota management (per-user, per-team; monthly/quarterly/annual; real-time attainment on dashboards) — Must Have (partial - quota field on users, no team quota or attainment dashboard)
USR-009: Cross-user task and opportunity assignment with notifications to assignee — Must Have ✅ DONE
USR-010: Per-user daily email sending limits (configurable per user, enforced at sequence send time) — Must Have (not done)
USR-011: User activity log (logins, record creates/edits, exports, admin actions, visible to Super Admin) — Must Have (partial - audit log done, not user-specific activity view)
USR-012: In-app notifications (badge count, notification center, mark-read, per-event preferences) — Must Have ✅ DONE
USR-013: Workspace-level notification preferences (per-event in-app + email toggles) — Must Have ✅ DONE

## Module 15 — AI-Native CRM & Social Engagement (AI-001 to AI-031)
(31 requirements — not yet extracted in detail; covers: AI Forecasting, Conversation Intelligence, Generative CRM Content, AI Social Engagement, AI Coaching, AI Deal Risk, Predictive Analytics)
STATUS: Largely not done. Key items:
- AI Win Probability on opportunities (CRMA-006) — not done
- Next Best Action panel (CRMA-007) — not done
- Conversation Intelligence (CRMA-008) — not done
- AI Account Brief (CRMA-010) — not done
- Pipeline Health Alerts (CRMA-012) — not done
- AI Forecast (CRM-016) — not done
- AI Social Engagement (auto-comment suggestions, engagement scoring) — not done
- AI Coaching (call analysis, objection handling suggestions) — not done
- Predictive churn + expansion scoring — not done
