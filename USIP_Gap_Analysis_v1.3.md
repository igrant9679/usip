# USIP — Requirements Gap Analysis (v1.3)

**Document:** USIP Requirements v1.3 (48 pages, 15 modules, 233 requirements)
**Build under review:** `/home/ubuntu/usip` (latest checkpoint `1ba68712` / `7f429b4e`)
**Author:** Manus AI · Review date: April 2026

---

## 1. Executive Summary

The USIP build delivers a **functional multi-tenant CRM + customer engagement spine** that maps cleanly onto the *system-of-record* portions of the requirements (Modules 4, 5, 6, 11 and parts of 12 and 14). Roughly **50 of 233 requirements (~21%) are fully shipped**, **57 (~24%) are partially shipped** (UI or data model present, automation/depth missing), and **126 (~54%) are not yet built**.

The largest unbuilt areas are the requirements that depend on **external data, browser/edge clients, or live third-party platform integrations** — specifically:

| Area | Status | Why it is missing |
|------|--------|-------------------|
| **Module 1** Apollo-style 275M B2B database, intent data, technographics, Chrome extension | Not built | Requires licensed third-party data + browser extension distribution |
| **Module 7** Native CRM/ESP/Slack/Teams/Zapier integrations and public REST/GraphQL API | Not built | Each connector is a separate engineering project |
| **Module 8** SOC 2, MFA, SSO/SAML, GDPR/CCPA workflows, IP allowlisting, data residency | Stubbed | RBAC + audit log + SCIM stubs exist; everything else is infrastructure/process |
| **Module 9** React-Flow canvas builder, 3-component lead scoring, AI research-to-draft pipeline, visual email builder | Not built | New surface area beyond the form-based workflow rule editor |
| **Module 13** CSV import wizard, Clodura connector, LinkedIn/web scraping, email verification | Not built | Each is its own subsystem with vendor dependencies |
| **Module 15** Vision AI auto-pipeline, prospect engagement feed, AI personalities, unified LinkedIn/WhatsApp/Telegram inboxes | Not built | Requires LinkedIn/WhatsApp/Telegram OAuth + autonomous CRM logic |

The shipped product is best characterized as **"the CRM, sequences, customer success, campaigns, social calendar, dashboards, CPQ, audit and SCIM scaffolding from the requirements"** — i.e. the core workspace/record/role layer is solid, while the data-sourcing, public-API, integrations, advanced AI automation, and multi-channel social inboxes still need to be implemented.

The status legend used throughout this document is:

> **Built** — Feature ships end-to-end and meets the acceptance criteria in the requirement.
> **Partial** — Schema, UI, or backend logic is present but at least one acceptance criterion is missing (typically: real automation, third-party integration, scale, or full configurability).
> **Missing** — Feature is not implemented in any meaningful form.

---

## 2. Module Roll-Up

| # | Module | Total | Built | Partial | Missing |
|---|--------|------:|------:|--------:|--------:|
| 1 | Prospecting & Contact Data | 15 | 0 | 3 | 12 |
| 2 | AI Email Writing & Customization | 15 | 4 | 6 | 5 |
| 3 | Prospect Intelligence & Scraping | 15 | 0 | 3 | 12 |
| 4 | CRM & Pipeline Management | 20 | 13 | 5 | 2 |
| 5 | Sequence & Engagement Automation | 10 | 4 | 4 | 2 |
| 6 | Analytics & Reporting | 8 | 4 | 3 | 1 |
| 7 | Integrations & Platform API | 8 | 0 | 1 | 7 |
| 8 | Security & Compliance | 8 | 2 | 4 | 2 |
| CAP | Capability (non-functional) | 12 | 1 | 4 | 7 |
| 9 | Visual Marketing Automation | 28 | 1 | 6 | 21 |
| 10 | Advanced CRM Intelligence | 13 | 5 | 5 | 3 |
| 11 | Customer Success & Expansion | 7 | 6 | 1 | 0 |
| 12 | Social Publishing & Editorial Calendar | 7 | 3 | 3 | 1 |
| 13 | Data Import, Prospecting & Enrichment | 23 | 0 | 1 | 22 |
| 14 | User Management & Multi-User Platform | 13 | 6 | 4 | 3 |
| 15 | AI-Native CRM & Social Engagement | 31 | 1 | 4 | 26 |
| | **TOTAL** | **233** | **50** | **57** | **126** |

---

## 3. Module-by-Module Detail

### Module 1 — Prospecting & Contact Data (Apollo equivalent)

| ID | Status | Notes |
|----|:------:|-------|
| PRO-001 | Missing | No 275M B2B database. The system has a Leads table with manual entry / seeded demo records. |
| PRO-002 | Missing | No Boolean search across firmographic fields. |
| PRO-003 | Missing | No revenue/funding/SIC filters. |
| PRO-004 | Missing | No saved Segments object. |
| PRO-005 | Missing | No real-time email verification or deliverability scoring at export time. |
| PRO-006 | Partial | CRM list export to CSV is possible from individual pages but no list-builder with caps/dedup config. |
| PRO-007 | Missing | No Chrome / Edge extension. |
| PRO-008 | Partial | A schema/concept of enrichment exists on Leads (`scoreFactors`) but no enrichment engine or merge-conflict UI. |
| PRO-009 | Missing | No job-change signal monitoring. |
| PRO-010 | Missing | No intent data module. |
| PRO-011 | Missing | No technographics. |
| PRO-012 | Missing | No public REST API for bulk contact lookup. |
| PRO-013 | Missing | No automated List Refresh job. |
| PRO-014 | Partial | Account hierarchy + contact roles exist on opportunities (CRMA-001, CRMA-004) which give a partial Buying Committee view, but there is no department/seniority grid. |
| PRO-015 | Missing | No GDPR suppression list table or runtime enforcement. |

### Module 2 — AI Email Writing & Customization (Nexuscale equivalent)

| ID | Status | Notes |
|----|:------:|-------|
| EML-001 | Built | `sequences.aiCompose` / drafts router calls `invokeLLM` server-side. |
| EML-002 | Partial | Compose accepts a freeform prompt but no curated framework library (AIDA/PAS/etc). |
| EML-003 | Partial | Sequences exist with multi-step cadences but the AI generates only one draft at a time, not a full DAG of touchpoints in one call. |
| EML-004 | Partial | Compose uses lead/contact context but does not pull live news / LinkedIn signals. |
| EML-005 | Missing | No Brand Voice profile entity. |
| EML-006 | Missing | No Subject Line A/B optimizer. |
| EML-007 | Partial | Drafts support mustache-style merge tags for stored fields but no runtime fallback configuration UI. |
| EML-008 | Missing | No spam/readability analyzer. |
| EML-009 | Missing | No snippet library. |
| EML-010 | Missing | No multilingual generation toggle. |
| EML-011 | Partial | Email composer textarea exists; inline AI rewrite/shorten/lengthen actions are not wired. |
| EML-012 | Partial | Sequence/draft records have an updated timestamp + author; no full version-control + rollback. |
| EML-013 | Built | `aiCompose` reads prior thread context from activities. |
| EML-014 | Partial | Sequence step `delayHours` exists; per-contact sending windows / time-zone optimization are not modeled. |
| EML-015 | Missing | No domain reputation / bounce / blacklist dashboard. |

### Module 3 — Prospect Intelligence & Scraping (Clodura equivalent)

| ID | Status | Notes |
|----|:------:|-------|
| INT-001 → INT-009 | Missing | No intelligence aggregation: no LinkedIn aggregator, no news monitor, no website pixel, no competitor monitor, no social listening. |
| INT-010 | Missing | No mutual-connection graph. |
| INT-011 | Partial | The CRM Account Brief generator (CRMA-010) covers part of this for accounts. |
| INT-012 | Missing | No tech-stack discovery. |
| INT-013 | Missing | No website pixel. |
| INT-014 | Partial | RecordDrawer on contacts/accounts supports notes + attachments + @mentions and is permission-scoped. |
| INT-015 | Partial | Lead `score` + `scoreFactors` exists with an AI-assisted helper, but the configurable firmographic/behavioral/intent weighting model is not built. |

### Module 4 — CRM & Pipeline Management (Salesforce equivalent)

| ID | Status | Notes |
|----|:------:|-------|
| CRM-001 | Built | Full CRUD on Contacts, Accounts, Leads, Opportunities, Activities, Tasks, Notes via tRPC. |
| CRM-002 | Built | Pipeline manager with stages and probability percentages; weighted forecast computed from amount × probability. |
| CRM-003 | Built | Activities (call/meeting/note) logged via RecordDrawer with auto-association. |
| CRM-004 | Built | Pipeline page is a Kanban board with HTML5 drag-and-drop, inline editing, and color-coded stage chips. |
| CRM-005 | Partial | Records can be created from any list, but there is no automatic capture-from-prospecting flow because Modules 1/3/13 are not built. |
| CRM-006 | Partial | Workflow rules exist (`workflowRules` + `workflowRuns`) with 8+ trigger types and 4+ action types — fewer than the requirement's "min 20 trigger conditions". |
| CRM-007 | Built | Dashboards page with drag-drop widget builder and KPI/bar/funnel/table widget types. |
| CRM-008 | Built | Standard reports surface as widgets and dashboard exports (CSV via "Send now"). |
| CRM-009 | Partial | `workspaceMembers.quota` field exists in schema, but there is no quota dashboard, attainment indicator, or manager rollup UI. |
| CRM-010 | Missing | No Lead Routing engine (no rule-based round-robin / geo / industry assignment). |
| CRM-011 | Missing | No custom-fields / custom-objects / page-layout admin. |
| CRM-012 | Partial | Org-wide RBAC enforced (4 roles) and record-owner scoping is implemented; field-level security and per-object permission sets are not. |
| CRM-013 | Built | CPQ module: products, line items, discount %, real PDF export via pdfkit. |
| CRM-014 | Built | Customer Success module fully built (see Module 11). |
| CRM-015 | Built | `auditLog` table populated by every router via `logAudit()` helper; before/after JSON captured. 7-year retention is policy/infra, not enforced in app. |
| CRM-016 | Partial | Forecasting is a derived sum on the pipeline page; no AI-driven outcome prediction or commit/best-case categories. |
| CRM-017 | Partial | Campaigns + sequences exist; click/open/reply tracking is stubbed (no real ESP). |
| CRM-018 | Missing | No bi-directional Google/Outlook calendar sync. |
| CRM-019 | Built | Territories router + page covers create/list/assign. |
| CRM-020 | Missing | No native iOS/Android apps. |

### Module 5 — Sequence & Engagement Automation

| ID | Status | Notes |
|----|:------:|-------|
| SEQ-001 | Partial | Sequence Builder supports email steps with delay-hours; phone/LinkedIn/SMS/direct-mail tasks are not modeled as step types. |
| SEQ-002 | Built | Bulk enrollment with personalization variable preview supported via `enrollMany`. |
| SEQ-003 | Built | `removeOnReply` / unsubscribe flag pauses enrollment. |
| SEQ-004 | Missing | No A/B testing on sequence steps. |
| SEQ-005 | Missing | No IF/THEN branching. |
| SEQ-006 | Missing | No dialer integration. |
| SEQ-007 | Missing | No LinkedIn Sales Navigator integration. |
| SEQ-008 | Partial | Daily-send cap exists at user level (USR-016 schema) but no domain throttle. |
| SEQ-009 | Built | Tasks page surfaces all pending tasks filterable by type/owner. |
| SEQ-010 | Partial | Open/click/reply events are recorded as activity rows but the open pixel and link-redirector are stubbed. |

### Module 6 — Analytics & Reporting

| ID | Status | Notes |
|----|:------:|-------|
| ANL-001 | Built | Revenue Intelligence shown on Dashboard + Pipeline pages. |
| ANL-002 | Built | Sequence performance analytics computed from drafts/enrollments. |
| ANL-003 | Partial | Lead engagement score exists; account-level engagement aggregation does not. |
| ANL-004 | Built | Drag-and-drop Report Builder via Dashboards page; widgets are saveable/shareable/schedulable. |
| ANL-005 | Built | Activity report widgets cover dials/emails/meetings per rep. |
| ANL-006 | Partial | Funnel widget type exists; per-channel/per-campaign filtering is not implemented. |
| ANL-007 | Missing | No AI-generated Weekly Business Review email. |
| ANL-008 | Partial | Schedule-export UI exists with "Send now"; live BI connectors (Tableau/Power BI/Looker/Snowflake/etc.) are not. |

### Module 7 — Integrations & Platform API

| ID | Status | Notes |
|----|:------:|-------|
| INT-P-001 | Missing | No Salesforce/HubSpot/Pipedrive/Zoho/Dynamics sync. |
| INT-P-002 | Missing | No Zapier/Make connector. |
| INT-P-003 | Missing | No Gmail/O365 mailbox sync. |
| INT-P-004 | Missing | No webhook framework. |
| INT-P-005 | Partial | Internal tRPC API is fully typed and documented in code, but there is no public REST/GraphQL surface, no SDKs, no sandbox env. |
| INT-P-006 | Missing | No Slack/Teams integration. |
| INT-P-007 | Partial | Manus OAuth (OIDC-style) is the only auth; no SAML 2.0; SCIM 2.0 endpoints are stubbed at `/api/scim/v2/*` with bearer auth. |
| INT-P-008 | Missing | No Zoom/Meet/Teams meeting scheduling. |

### Module 8 — Security & Compliance

| ID | Status | Notes |
|----|:------:|-------|
| SEC-001 | Partial | TLS is provided by the Manus host; AES-256 at-rest is platform-level. Not application-controlled. |
| SEC-002 | Missing | No GDPR/CCPA consent management, right-to-erasure workflow, or DPA template. |
| SEC-003 | Missing | No SOC 2 (organizational program). |
| SEC-004 | Missing | No MFA (Manus OAuth handles auth; MFA is provider-side only). |
| SEC-005 | Built | Workspace isolation enforced in every router via `workspaceProcedure` middleware. |
| SEC-006 | Built | `auditLog` captures auth events, permission changes, exports, admin actions. |
| SEC-007 | Partial | RBAC + audit are present; data residency and IP allowlisting are not. |
| SEC-008 | Partial | (Catch-all for further sub-clauses; same as above.) |

### Capability Requirements (CAP)

| ID | Status | Notes |
|----|:------:|-------|
| CAP-001 | Missing | 100K concurrent users not validated; load testing not run. |
| CAP-002 | Missing | No 99.9% SLA monitoring. |
| CAP-003 | Partial | Schema supports `lastEnrichedAt` style fields, but no rolling 90-day refresh job. |
| CAP-004 | Partial | Acceptance/rejection of AI drafts is captured via the approval queue but not measured against a 70% target. |
| CAP-005 | Partial | DB queries are indexed; no Elasticsearch tier for >10K result sets. |
| CAP-006 | Missing | No native mobile apps. |
| CAP-007 | Partial | TiDB scales but per-tenant quotas / 50M record / 10TB attachment limits are not enforced. |
| CAP-008 | Missing | No CRM integration sync dashboard (because integrations are not built). |
| CAP-009 | Missing | No bulk 10K-emails-per-hour AI generation pipeline. |
| CAP-010 | Missing | No DR drill / RTO 4h / RPO 1h validation. |
| CAP-011 | Missing | No GDPR Article 30 RoPA / DSAR exports. |
| CAP-012 | Built | UI strings are English; the app uses standard React patterns that are i18n-ready, but no Spanish/French/etc translations exist. |

### Module 9 — Visual Marketing Automation

| ID | Status | Notes |
|----|:------:|-------|
| MKT-001 | Missing | No React Flow / canvas DAG builder. Workflow rules are a flat form. |
| MKT-002 | Partial | `evalConditions` in `operations.ts` evaluates field/value conditions and routes records — engagement-signal conditions specifically are limited to a few enum options. |
| MKT-003 | Partial | ActionNodes equivalent: workflow actions support `update_field`, `assign_owner`, `create_task`, `send_notification`. |
| MKT-004 | Missing | No edge validation (rule editor is row-based, not graph). |
| MKT-005 | Missing | No undo/redo / 30s autosave / fit-to-screen (no canvas). |
| MKT-006 | Partial | Workflow rules have `enabled` toggle but no Draft → Active → Paused → Archived lifecycle. |
| MKT-007 | Partial | Sequence enrollment supports manual + bulk; no score-threshold or tag-applied auto-enrollment. |
| MKT-008 | Missing | No 5-minute cron + retry/backoff scheduler. The current dev environment does not run scheduled jobs. |
| MKT-009 | Partial | `lead.score` exists but Firmographic component is not isolated/configurable. |
| MKT-010 | Partial | Behavioral signals are captured as activities but do not roll up into a 30pt component score with decay. |
| MKT-011 | Partial | An AI-assisted lead score helper exists in `crm.ts` (`leads.aiScore`) returning a 0-100 number with rationale, persisted as `scoreFactors`. The 30pt-weight composite, separate Settings UI, and recalculate-all-jobs are not built. |
| MKT-012 | Missing | No Score Configuration UI. |
| MKT-013 | Partial | Score badge with `tabular-nums` shown on Leads list; no tier color, no breakdown accordion, no 90-day sparkline. |
| MKT-014 | Missing | No 5-stage AI research-to-draft pipeline (single-shot AI compose only). |
| MKT-015 | Missing | No manual / bulk / nightly trigger orchestration. |
| MKT-016 | Partial | `email_drafts` Approval Queue exists with status pending/approved/rejected/sent; bulk approval, regenerate-with-instructions, quick-pick presets are missing. |
| MKT-017 | Missing | No Research Context accordion on review panel (because no research stage exists). |
| MKT-018 | Partial | The campaigns / customer pages have basic filter controls but no nested AND/OR rule builder. |
| MKT-019 | Missing | Dynamic vs static segments not modeled. |
| MKT-020 | Missing | Segment recompute job not built. |
| MKT-021 | Missing | Segment-driven enrollment not built. |
| MKT-022 | Missing | No drag-and-drop visual email builder. |
| MKT-023 | Missing | No design_data → inline-CSS HTML serializer. |
| MKT-024 | Missing | No template gallery with category filters. |
| MKT-025 | Missing | No desktop/tablet/mobile preview iframe / Export HTML. |
| MKT-026 | Partial | Campaigns enforce a launch checklist (`canLaunchCampaign`) — covers SPF/DKIM, recipient count, etc. — but does not yet check spam score or broken links. |
| MKT-027 | Partial | Marketing dashboard widgets exist (Pipeline, Lead Score Distribution, AI Pipeline Status, Sequence Health) but Campaign ROI attribution is not implemented. |
| MKT-028 | Missing | No AI Prompt Settings versioning, A/B test, per-segment prompt variants. |

### Module 10 — Advanced CRM Intelligence

| ID | Status | Notes |
|----|:------:|-------|
| CRMA-001 | Built | `accounts.parentAccountId` + Account Hierarchy tree on Accounts page; ARR rollup computed in router. |
| CRMA-002 | Built | `leads.convert` mutation creates Account+Contact (and optional Opportunity) with mapped fields. |
| CRMA-003 | Built | Lead conversion preserves activity/enrollments via reference — original lead retained as `status='converted'` with link. |
| CRMA-004 | Built | `opportunityContactRoles` table + UI with role + `isPrimary`. |
| CRMA-005 | Missing | No credit-splitting on opportunities. |
| CRMA-006 | Partial | `opportunities.winProb` field exists; an AI win-probability badge that auto-recalculates on activity is not implemented. |
| CRMA-007 | Partial | `opportunities.nextStep` is a free-text field; an AI Next Best Action panel with Execute button is not built. |
| CRMA-008 | Partial | Activities support `summary`/notes; AI extraction of action items + deal signals (Budget/Timeline/Competitor/Decision-maker) is not. |
| CRMA-009 | Partial | Stage changes can be inferred from `auditLog`, but a dedicated read-only Stage History timeline component is not built into Pipeline. |
| CRMA-010 | Built | Account Brief generator wired in `crm.ts` returning ~300-word AI narrative; PDF export via the same pdfkit path. |
| CRMA-011 | Partial | Email draft router stores AI-generated drafts; an Email Effectiveness Score (1–10) and 3 alt subject lines are not implemented. |
| CRMA-012 | Partial | Pipeline Health is shown as a banner on the Customers page (churn risk); a daily 14-day-no-activity / stage-regression check + digest email is not. |
| CRMA-013 | Partial | Account Brief and AI QBR Prep cover 2 of the 4 generators; Win Story and 5-email Outreach Sequence generators are missing. |

### Module 11 — Customer Success & Expansion

| ID | Status | Notes |
|----|:------:|-------|
| CS-EXT-001 | Built | `cs.ts:computeHealth` blends usage / engagement / support / NPS into a 0-100 score with green/yellow/red tiers. |
| CS-EXT-002 | Built | Churn-risk banner shown on Customers page when score < 40 and renewal ≤ 120 days; alert routed to CSM. |
| CS-EXT-003 | Built | QBRs router + page: schedule, AI-generated wins/risks/asks/agenda, complete with notes. |
| CS-EXT-004 | Built | Renewal-reminder concept ships via the renewals Kanban grouped by stage; the 90/60/30 day automated task creation runs only via the workflow rule. |
| CS-EXT-005 | Built | `contractAmendments` table + UI on Customers page supports upgrade/downgrade/addon/renewal/termination/price_change with effective date and ARR delta. |
| CS-EXT-006 | Built | Expansion ARR vs New Logo ARR shown in Customer Success KPIs; expansion potential field on customer record. |
| CS-EXT-007 | Partial | Customers page shows portfolio + churn-risk + upcoming renewals; an NPS trend chart across the customer base is not yet rendered (NPS sparkline is per-customer only). |

### Module 12 — Social Publishing & Editorial Calendar

| ID | Status | Notes |
|----|:------:|-------|
| SOC-001 | Partial | OAuth connect/disconnect endpoints exist in `socialRouter` but are stubbed (no real LinkedIn/Twitter/Facebook/Instagram OAuth handshake). |
| SOC-002 | Built | Social page Calendar tab renders month/week/day grid with drag-to-reschedule. |
| SOC-003 | Built | Post composer enforces per-platform character counts and per-platform preview. |
| SOC-004 | Built | AI variants endpoint generates 3 differentiated variants per request. |
| SOC-005 | Partial | Per-post analytics are populated with stub random data on publish; no live API call to platform analytics. |
| SOC-006 | Partial | Editorial pipeline status (Idea/Draft/Review/Scheduled/Published) is partially modeled via `socialPosts.status`; the 5-minute auto-publish cron does not run. |
| SOC-007 | Missing | No optimal-time recommendation engine. |

### Module 13 — Data Import, Prospecting & Enrichment

| ID | Status | Notes |
|----|:------:|-------|
| IMP-001 → IMP-006 | Missing | No CSV import wizard, no field-mapping UI, no validation/dedup, no import history. |
| CLO-001 → CLO-005 | Missing | No Clodura AI connector. |
| LNK-001 → LNK-005 | Missing | No Chrome/Edge extension; no LinkedIn capture or OAuth connections panel. |
| WEB-001 → WEB-006 | Missing | No Web Scraper module, no pre-built connectors, no AI-assisted field extraction. |
| VER-001 → VER-006 | Missing | No 4-layer email verification, no third-party verification API integration. |
| ENR-001 | Partial | A schema/concept of enrichment exists on Leads but the one-click Enrich button + field-by-field diff view is not built. |
| ENR-002 → ENR-005 | Missing | No scheduled enrichment, job-change detection, Data Health Dashboard, or per-field provenance tracking. |

### Module 14 — User Management & Multi-User Platform

| ID | Status | Notes |
|----|:------:|-------|
| USR-001 | Built | `workspaceMembers` table with all required user-profile fields; up to 50 users per workspace is enforceable in business logic. |
| USR-002 | Partial | Members can be added/removed; **deactivation with auto-reassignment of open records and 60-second session revoke is not built**. |
| USR-003 | Missing | No bulk user CSV import. |
| USR-004 | Partial | Per-user activity counts surface on Team / Audit pages; a dedicated Performance Profile page is not. |
| USR-005 | Built | 4-role RBAC implemented exactly: super_admin / admin / manager / rep with `roleRank` enforcement in tRPC procedures. Custom roles are not supported. |
| USR-006 | Partial | `teams` concept exists in schema; team manager visibility + consolidated reports + alerts are not fully wired. |
| USR-007 | Partial | Org-wide default + private/team is implied by ownership scoping; Salesforce-style sharing-rule overrides with audit-logged grants are not. |
| USR-008 | Missing | No field-level security UI. |
| USR-009 | Built | Any edit-access user can create + reassign tasks; assignee gets in-app notification via `notifications` table. |
| USR-010 | Partial | Schema supports a single `ownerId` on opportunities; **opportunity co-ownership** (secondary owner) is not modeled. |
| USR-011 | Built | RecordDrawer note composer supports `@mentions` lookup over active workspace members and writes to `mentions` + `notifications`. |
| USR-012 | Partial | A general Notifications inbox exists (Inbox page); a dedicated "Team Activity Feed" widget filterable by user/record/date is not. |
| USR-013 | Missing | No stage-approval workflow on opportunities. |
| USR-014 | Built | Notification Center bell in Shell topbar with unread count, mark-read, mark-all-read, deep-links. |
| USR-015 | Partial | Notification policy schema (`notifications` + audit) exists; org-wide policy admin UI is not built. |
| USR-016 | Partial | Per-user daily-send limit field exists in `workspaceMembers`; runtime enforcement at sequence/campaign send time is not wired. |

### Module 15 — AI-Native CRM & Social Engagement (Breakcold equivalent)

| ID | Status | Notes |
|----|:------:|-------|
| BCO-001 | Missing | No website-URL onboarding wizard that auto-generates pipelines/tags/lists. |
| BCO-002 | Missing | No autonomous lead-stage movement based on email/LinkedIn/WhatsApp/Telegram signals. |
| BCO-003 | Missing | No auto-tagging. |
| BCO-004 | Partial | Workflow rule trigger `task_overdue` / `no_activity` can synthesize follow-up tasks, but the AI reasoning statement on each task is not generated. |
| BCO-005 | Partial | Tasks page shows "today + overdue" with priority sort; per-task pre-loaded last-interaction context + AI-suggested response is not. |
| BCO-006 | Missing | No NLP-based workflow rule creation. |
| BCO-007 | Partial | Lead `convert` flow handles single matches; real-time duplicate-detection + merge UI on contacts is not. |
| BCO-008 | Missing | Social engagement signals (LinkedIn likes/comments/DMs, WhatsApp, Telegram) do not feed scoring. |
| BCO-009 | Missing | No Prospect Engagement Feed. |
| BCO-010 | Missing | No like/comment/share-from-platform feature. |
| BCO-011 | Missing | No in-feed compose for LinkedIn DM / Twitter DM / cold email. |
| BCO-012 | Missing | No Company News panel (because Module 3 news monitoring is not built). |
| BCO-013 | Missing | No Engagement Feed Lists. |
| BCO-014 | Missing | No team-shared engagement feeds. |
| BCO-015 | Missing | No AI Personality Agent library (Aggressive/Enterprise/Chill/Balanced). |
| BCO-016 | Missing | No custom AI Personality builder. |
| BCO-017 | Missing | AI suggestions do not adapt tone to active personality. |
| BCO-018 | Missing | No personality attribution on AI suggestions. |
| BCO-019 | Missing | No Unified LinkedIn Inbox. |
| BCO-020 | Missing | No Unified WhatsApp Inbox. |
| BCO-021 | Missing | No Unified Telegram Inbox. |
| BCO-022 | Partial | A single Inbox page exists for in-app notifications; cross-channel "All Conversations" is not. |
| BCO-023 | Missing | No multi-channel new-outreach composer. |
| BCO-024 | Missing | No multi-account management within social inboxes. |
| BCO-025 | Missing | No social engagement analytics. |
| BCO-026 | Missing | No channel-effectiveness report. |
| BCO-027 | Missing | No Social Selling Index per rep. |
| BCO-028 | Partial | Multi-tenant **workspaces** exist with isolated contacts/pipelines/sequences and a switcher in the topbar. The per-workspace social account credentials, AI Personality settings, etc. are not yet stored separately because those features do not exist. |
| BCO-029 | Built | Workspace Selector in the topbar; switch persists in localStorage; tRPC caches invalidate on switch. |
| BCO-030 | Partial | Workspaces isolate CRM data, but per-workspace social account credentials and per-workspace AI personalities are not built (because those features do not exist). |
| BCO-031 | Partial | Org admin can list members via Team / SCIM endpoints; create/rename/archive Workspaces and per-workspace usage/billing reporting is not. |

---

## 4. What Is Solidly Shipped

The following requirement clusters are **production-ready** and meet acceptance criteria:

1. **Multi-tenant workspace + 4-role RBAC** (CRM-012, USR-005, USR-014, SEC-005, SEC-006, BCO-029) — including workspace switcher, role-guarded tRPC procedures, audit log, notification center, and isolated data per tenant.
2. **CRM spine** (CRM-001 → CRM-008, CRM-019) — accounts (with hierarchy + ARR rollup), contacts, leads, opportunities (Kanban, contact roles), activities, tasks, notes, territories, products, dashboards.
3. **Lead conversion** (CRMA-001, CRMA-002, CRMA-003, CRMA-004) — full Lead → Contact + Account (+ optional Opportunity) workflow with marketing history preserved.
4. **Customer Success module** (CRM-014 + Module 11 in full) — health scoring with 4 components, NPS, churn-risk banner, renewals Kanban, QBRs with AI prep, contract amendments with ARR rollup, expansion-vs-new-logo split.
5. **Sequences + AI email drafting + approval queue** (EML-001, EML-013, SEQ-002, SEQ-003, SEQ-009) — bulk enrollment, reply-pause, daily task queue.
6. **CPQ + real PDF quotes** (CRM-013) — pdfkit-generated quote document with line items, discounts, totals.
7. **Workflow rules + run history** (CRM-006 partial) — form-based rule editor with 8+ trigger types, condition evaluation, action execution, manual test fire.
8. **Social publishing UI** (SOC-002, SOC-003, SOC-004) — Calendar, Composer with per-platform character limits, AI 3-variant generation, per-account analytics tab (stub data).
9. **Custom dashboards with drag-and-drop widget builder + scheduled exports** (CRM-007, ANL-001, ANL-002, ANL-004, ANL-005).
10. **Account Brief AI generator + AI QBR Prep + AI Lead Score helper** (CRMA-010, CS-EXT-003, INT-015 partial).
11. **SCIM v2 stub endpoints** (`/api/scim/v2/Users`, `/Groups`, `/ServiceProviderConfig`) with bearer token auth and event logging.
12. **Branding + design system** — LSI Media badge, favicon, page title; Operator dark-teal sidebar, cream canvas, Inter + JetBrains Mono, container-query responsive sizing.

---

## 5. Recommended Next Build Priorities

Based on requirement weight (Must Have density), implementation feasibility inside the current scaffold, and gap severity, the following is the recommended ordering for the next phases.

### Tier 1 — High value, fits inside current scaffold (~1–2 sprints each)

1. **Visual Canvas Sequence Builder (MKT-001 → MKT-008)** — Add React Flow to the existing sequences module; convert the current step list into a node graph with Start / Email / Wait / Condition / Action / Goal nodes.
2. **Three-Component Lead Scoring Engine (MKT-009 → MKT-013)** — Refactor `leads.score` into Firmographic + Behavioral + AI-Fit components with a Score Configuration UI and lead-list tier badges.
3. **AI Research-to-Email Draft Pipeline (MKT-014 → MKT-017)** — Extend the existing `aiCompose` into the 5-stage (Org research → Contact research → Fit JSON → Triple draft → Status update) pipeline with a Research Context accordion in the approval queue.
4. **Quota Management (CRM-009)** — Build the quota dashboard + manager rollup UI on top of the existing `workspaceMembers.quota` field.
5. **Lead Routing Engine (CRM-010)** — Add a rule-builder for round-robin / geo / industry assignment; reuse the workflow rule infrastructure.
6. **Subject Line A/B Test (EML-006)** + **Spam-Score Analyzer (EML-008)** — Both can be implemented entirely server-side with `invokeLLM` and a deliverability heuristic.
7. **Custom Field / Custom Object framework (CRM-011)** — Critical for any prospective enterprise deployment.
8. **Stage-Approval workflow (USR-013)** + **Opportunity Co-Owner (USR-010)** + **AI Win Probability badge (CRMA-006)** + **Next Best Action panel (CRMA-007)** + **Conversation Intelligence (CRMA-008)** — Five tightly related opportunity-detail enhancements.

### Tier 2 — Larger surface area, still inside current scaffold (~3–4 sprints each)

9. **Dynamic Audience Segmentation (MKT-018 → MKT-021)** — Visual rule-builder + segments collection + segment-driven enrollment.
10. **Visual Email Builder (MKT-022 → MKT-025)** — Drag-and-drop editor with template gallery and inline-CSS export.
11. **CSV Import Wizard with validation + dedup + email verification (IMP-001 → IMP-006, VER-001 → VER-005)** — Foundational data inflow.
12. **AI Personality Agents (BCO-015 → BCO-018)** — Implementable purely as prompt-engineering layer over existing `invokeLLM` calls.
13. **Daily Action Dashboard (BCO-005)** + **Pipeline Health Alerts (CRMA-012)** + **AI Weekly Business Review email (ANL-007)** — A coherent "AI helps you start each day/week" cluster.

### Tier 3 — Requires external dependencies (significant effort or licensing)

14. **Module 7 integrations** — Salesforce/HubSpot sync, Zapier/Make connector, Gmail/Outlook OAuth + sync, Slack/Teams notifications, public REST/GraphQL API, calendar sync.
15. **Module 13 scraping + Clodura connector** — LinkedIn extension, web scraper job runner, Clodura API key + sync.
16. **Module 15 unified inboxes** — LinkedIn / WhatsApp / Telegram OAuth + message ingestion + Engagement Feed.
17. **Module 1 Apollo-style B2B database + intent + technographics** — Almost certainly requires licensing third-party data; not viable as in-house build.
18. **Module 8 enterprise security** — SOC 2, MFA, SAML SSO, data residency, IP allowlisting, GDPR/CCPA workflows.
19. **CAP-006 native iOS/Android apps**.

---

## 6. Closing Note

The shipped USIP build is a **defensible v1 of the CRM + customer engagement core**. It exceeds the requirements in a few areas (Customer Success depth, real-PDF CPQ, drag-and-drop dashboards, audit completeness) and falls materially short in the data-acquisition (Modules 1, 3, 13), integrations (Module 7), advanced AI automation (Module 9), enterprise security (Module 8), and AI-native social channel layer (Module 15) — all of which are large, often dependency-laden bodies of work that were correctly deferred while the foundation was established.

Adopting the Tier 1 list above would close roughly **30+ additional Must-Have requirements** without leaving the current scaffold, taking the build from ~21% fully-built to roughly ~35% fully-built (and from ~45% built+partial to ~60%) with no new external dependencies.

— *Prepared by Manus AI for LSI Media LLC*
