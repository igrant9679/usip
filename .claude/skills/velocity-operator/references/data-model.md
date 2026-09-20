# Velocity data model — objects, lifecycles, statuses

Read this when you need to know what a record *is*, what state it can be in, or how one object becomes another. Every enum below is copied from `drizzle/schema.ts`; if the code and this file disagree, the code wins and this file needs a fix.

## The one funnel

```
Find Prospects / Import / Campaign discovery      ← names enter here
          |
          v
   PROSPECT (People page, table `prospects`)      ← the master person record
          |  engages (reply, form, chat, booking)
          v
        LEAD (table `leads`)                      ← inbound / engaged, scored, routed
          |  Convert
          v
   ACCOUNT + CONTACT + OPPORTUNITY                ← durable company + person + the deal
          |  pipeline stages
          v
   A STAGE FLAGGED WON  → account becomes a CUSTOMER (health, renewals, QBRs)
   A STAGE FLAGGED LOST → account + contact kept, win-back task in 90 days;
                          a later deal is a NEW opportunity
```

The idea that makes the CRM click: **separate the who from the deal.** Accounts and Contacts persist across many deals. The Opportunity is the only thing that travels the pipeline and closes.

## Person-shaped objects (there are four, deliberately)

| Object | Table | Page | What it is | How it is created |
|---|---|---|---|---|
| **Person / Prospect** | `prospects` | People (`/v2/people`) | The master record for a human: name, title, email + verification status, LinkedIn, company link, confidence tier, fit score, provenance ledger. Everything else links to it. | Find Prospects, CSV import, campaign discovery, Add existing wizard, "push" from other objects |
| **Lead** | `leads` | Leads (`/leads`) | An inbound or engaged person awaiting qualification. Scored 0–100, routed to an owner. | Forms, landing pages, chat agent, booking links, "Convert to lead" from a prospect |
| **Contact** | `contacts` | Companies → people, People drawer | The durable person on an Account. Has `personProspectId` back-link to the People row. | Lead conversion, import, campaign reply promotion |
| **Campaign prospect** | `prospect_queue` | Revenue Engine campaign → Prospects tab | A person *inside one campaign*: enrichment status, sequence status, ICP score for that campaign. One human can be in several campaigns → several queue rows, all pointing at one People row. | Discovery, Add existing wizard, routing, push |

Companies mirror this: `accounts` (CRM company; page Companies) hold `contacts`; `prospects.accountId` links a person to its company; `customers` is a won account's post-sale record.

## Status vocabularies

### Lead `status`
`new` → `working` → `qualified` | `unqualified` → `converted` (conversion creates Account + Contact + Opportunity in one step and marks the lead converted).

### Pipelines and stages (`crm_pipelines`, `crm_pipeline_stages`)
A workspace has one or more named pipelines, exactly one flagged `isDefault`. Each pipeline owns an ordered list of stages: `key` (what `opportunities.stage` stores), `label`, `sortOrder`, `defaultWinProb`, and two booleans — **`isWon`** and **`isLost`**. Editable at any time at `/settings/pipelines`; a new pipeline can clone another's stages.

🔴 `isWon` / `isLost` — NOT the key — decide the revenue math. Closed-won totals, win rate, the open forecast, the Closed Won → Customer step, the closed-lost win-back task and the `is_won`/`is_lost`/`is_open` report filters all read the flags. A workspace can rename `won` to `signed` and everything keeps working. A key nothing configures falls back to name defaults (`won`/`closed_won` = won, `lost`/`closed_lost` = lost, `closed` = closed but neither), and an unrecognised key counts as OPEN — which is what a deleted stage leaves behind.

### Opportunity `stage` (free text)
Whatever key the deal's pipeline defines. The SEEDED DEFAULT pipeline uses `discovery` → `qualified` → `proposal` → `negotiation` → `won` | `lost`; those six values are a default, not the vocabulary. `opportunities.pipelineId` is nullable and nothing backfills it, so a deal with no pipeline resolves its stage flags against the workspace's default pipeline. Each opportunity carries `value`, `winProb`, `closeDate`, `daysInStage`, an AI next-step note, and a stage history table.

### Customer
- `tier`: `enterprise` | `midmarket` | `smb`
- `healthTier`: `healthy` | `watch` | `at_risk` | `critical`
- `cmUserId`: the CSM. Set once by the Closed Won → Customer step (`services/wonToCustomer.ts`) from the opportunity's owner, but only if that owner is still an active member — otherwise the acting user, or the workspace's notify recipient on the session-less share-link accept. The account's health checks, renewal stage and QBR/renewal tasks are all keyed off it, so a departed owner's id here reads as handled while nobody is watching.
- `renewalStage`: `early` → `ninety` → `sixty` → `thirty` → `at_risk` | `renewed` | `churned`. DERIVED from `contractEnd` (`@shared/renewalStage`), not set by hand: `d > 90` early, `60 < d <= 90` ninety, `30 < d <= 60` sixty, `0 < d <= 30` thirty, `d <= 0` at_risk. `at_risk` here means PAST DUE — the contract end date has gone by with no outcome recorded — and is unrelated to `healthTier`, which has its own `at_risk` value. `renewed` and `churned` are human outcomes written only by `cs.addAmendment` (type `renewal` rolls the dates forward by the customer's existing term; type `termination` churns them); nothing derived ever overwrites those two. Every `cs.*` read applies the derivation, and `services/renewalStageEngine.ts` sweeps the stored column into line every 6h.

### Task
- `type`: `call`, `email`, `meeting`, `linkedin`, `todo`, `follow_up`, `social_touch`, `manual_email`, `meeting_prep`, `crm_update`, `generic_action`
- `priority`: `low` | `normal` | `high` | `urgent`
- `status`: `open`, `in_progress`, `snoozed`, `done`, `cancelled`, and `draft` (an AI-proposed task awaiting approval; Task Autopilot in Approve mode writes these)
- `source`: `manual` | `sequence` | `ai` | `import` | `workflow`

### Meeting
- `status`: `proposed` (candidate times, nothing sent) → `invited` (invite sent) → `scheduled` (confirmed) → `completed` | `no_show` | `cancelled` | `rescheduled`
- `source`: `manual` | `ai` (Meeting Autopilot) | `are` (campaign reply) | `inbound` (booking link, chat agent, form)
- Dispositions after a meeting are free text set by the rep (`qualified`, `proposal_sent`, `not_now`, …). A no-show creates a re-book task.

### Sequence (fixed multi-step flows, `/v2/sequences`)
- Sequence `status`: `draft` | `active` | `paused` | `archived`; `visibility`: `private` | `team`
- Enrollment `status`: `active` | `paused` | `finished` | `exited`. A reply auto-pauses the enrollment.

### Revenue Engine campaign (`are_campaigns`)
- `status`: `draft` | `active` | `paused` | `completed`. Only `active` campaigns are ticked by the engine; pausing also pauses enrichment spend.
- `autonomyMode`: `full` (discover → send with no human) | `batch_approval` (a human approves enriched batches; default) | `review_release` (approve each person)
- `copyMode`: `per_person` (the model writes each sequence from the dossier) | `fixed` (one template, merge tags)
- `goalType`: `meeting_booked` | `reply` | `opportunity_created`

### Campaign prospect (`prospect_queue`)
- `enrichmentStatus`: `pending` → `enriching` → `complete` | `failed`
- `sequenceStatus`: `pending` → `approved` → `enrolled` → `completed` | `replied` | `paused` | `canceled` | `skipped` (skipped = rejected by screen or by a human; restorable)
- `prospect_intelligence` (one per queue row): the dossier, ICP score, `generatedSequence` (the written steps), `sequenceQualityScore` /40 with breakdown.
- `are_execution_queue`: one row per step per person: `scheduled` → `sent` (with `openedAt`, `openCount`, tracking token) | `skipped` | `failed`.

### Person (People row) quality fields
- `emailStatus`: `valid` | `accept_all` | `unverified` | `invalid` | `unknown` (from verification)
- `confidenceTier`: `high` | `medium` | `low` (identity confidence, from the provenance ledger)
- `verificationStatus`: `verified` | `needs_review` | `rejected` (the Needs Review queue is `needs_review`)
- `companyMatchStatus`: whether the person's company resolved to a Companies row

### Reply classification (`email_replies.replyClass`)
`willing_to_meet`, `follow_up_question`, `person_referral`, `out_of_office`, `already_left_company_or_not_right_person`, `not_interested`, `unsubscribe`, `none_of_the_above`. Sentiment: `positive` | `neutral` | `negative` | `objection`. The Conversation Autopilot acts per class (Auto: willing-to-meet gets the booking link; unsubscribe goes on the suppression list; referral creates a task).

**Scope trap:** `email_replies` holds *all* synced inbound mail, not only replies to outreach. Every "reply" count in the product is scoped by `genuineReplyScope()`; a query without it counts the whole inbox.

**Out-of-office snooze (migration 0181).** The inbound poller pauses every active enrollment for a person the instant *any* reply lands, and the send engine only ever picks up `status='active'` — so before 0181 an auto-responder ended the outreach permanently. Three columns close it: `email_replies.pausedEnrollmentIds` (json — exactly which enrollment ids *that* reply paused), `email_replies.oooReturnsAt` (the return date the auto-reply stated, when it stated one), and `enrollments.resumeAt` (when the sweep may flip the row back; `NULL` = no auto-resume). Handling an out-of-office in Conversations stamps `resumeAt` on those ids only — never a row a rep paused by hand — and `resumeDueEnrollments()` on the 5-minute sequence tick sets them back to `active` from the next unsent step. Any other class of reply, and every manual pause/resume/exit, clears the stamp.

### Notification `kind` (Inbox `/inbox`)
`mention`, `task_assigned`, `task_due`, `deal_won`, `deal_lost`, `renewal_due`, `churn_risk`, `approval_request`, `workflow_fired`, `system`, `email_reply`, `are_event`.

### Activities (`activities`)
`type`: `call` | `meeting` | `email` | `note` | `linkedin` | `stage_change` | `system`; call dispositions: `connected`, `voicemail`, `no_answer`, `bad_number`, `gatekeeper`, `callback_requested`, `not_interested`. Logged against a contact, lead, account or opportunity (`relatedType` + `relatedId`).

### Proposals and quotes
- Proposal `status`: `draft` → `sent` → `under_review` → `accepted` | `not_accepted` | `revision_requested`; has sections (`sectionKey` + content), milestones (owner `lsi_media` | `client` | `both`), a share token for the client portal, optional link to an opportunity.
- Quote: `quoteNumber`, `status` (`draft` | `sent` | `accepted` | …), line items (`name`, `quantity`, `unitPrice`, `discountPct`, `lineTotal`), totals, terms; attached to an opportunity; products come from the catalog.

### Roles (`workspace_members.role`)
`super_admin` (everything, including workspace create/transfer/archive and demo seeding) > `admin` (settings, autonomy dials, team, sending) > `manager` (team views, approvals) > `rep` (own records and queues). Autonomy setters are admin-only; reps see the dial but cannot move it.

### Per-member permissions (`member_permissions`)
One row per `(workspaceId, userId, feature)` with a `granted` boolean; set on the Team page's Permissions tab, resolved by `checkPermission` / `hasPermission` / `resolvePermissionMap` in `server/db.ts`. A row wins over the role default **in both directions** — it can refuse an admin. The six keys live in `shared/permissions.ts`:

| Key | Default for manager/rep | Enforced at |
|---|---|---|
| `export_data` | denied | `dangerZone.exportData`; `reports.exportCsv`, `reports.sendNow`, `reports.setSchedule` when freq is not `none`; `are.prospects.exportRejections` |
| `manage_api_keys` | denied | aiCredentials, apollo, prospectSources, quickenrich, reoon |
| `manage_sequences` | granted | sequences create/update/delete/fork/updateMeta/updateSteps/saveCanvas/setVisibility/assign, setStatus for every transition except `paused`, and every `sequenceAb` mutation (that router edits the subject and body a step sends) |
| `manage_integrations` | granted | integrations save/disconnect/test |
| `access_billing` | granted | `usage.currentMonth` (Settings → Billing and credits) |
| `view_all_leads` | granted | **nothing** — lead scoping is separate, unshipped work |

Admins and super admins are granted everything by default. `team.delete` clears a departed member's rows; `team.deactivate` deliberately keeps them.

## Workspaces
Everything is scoped by `workspaceId`. A user can belong to several workspaces; the workspace switcher is in the top bar. `workspace_settings` holds the autonomy dials, caps, budgets, routing mode and campaign-copy defaults. Archived workspaces are excluded from every cron.

## Lists, segments, personas, ICP
- **Lists** (`record_lists` + members): hand-picked named sets of people or companies. Static. Used for targeting, the Add existing wizard's "From a list" step, and bulk actions.
- **Segments** (`audience_segments`): saved rule-based filters that stay current; feed Broadcasts and Segment Rules (auto-enroll into a sequence).
- **Personas**: buyer archetypes (titles, industries, sizes, keywords) grouped in categories; the writer and fit scoring read them.
- **ICP profile** (`icp_profiles`, versioned): the living ideal-customer profile; regenerated daily by the ICP cron from deals in stages flagged Won (and, for the negative signal, stages flagged Lost) plus engagement; drives discovery targeting and the campaign screen floor.
- **Brand voice** (one row per workspace): tone, vocabulary, avoid-words, from-name; every AI-written email and chat reply reads it.
- **Score models** (`score_models` + `score_results`): fit scoring for people and companies; one primary per object type; ratings `excellent` | `good` | `fair` | `not_a_fit`.

## Prospect sources (vendor registry, migration 0179)
Every external prospect-data vendor is a plugin with a **capability manifest** (`shared/prospectSources.ts`): filters it honours natively vs approximates, free preview, masked preview, mobile phones, verification, batch size, geographic coverage. Vendors: **WarmySender** (leads DB, MCP; free masked search, 1 unit per net-new acquired; US/CA; business phones only), **QuickEnrich** (free discovery, credits spent later by the sweep, Reoon-gated), **Apollo** (search-only, no emails, zero credits), Hunter/Lemlist (stubs: "available, not configured").
- **Checking order** = the existing Revenue Engine → Settings "Prospect Sources & Checking Order" list; it is now the waterfall order for campaign discovery AND Source search. The waterfall stops at the batch target (campaigns: open queue slots), so a lower source is never called or paid for a person a higher one found.
- **Credentials**: `prospect_source_credentials` (encrypted JSON, status unvalidated|valid|invalid|revoked, captured scopes/tier/tool schemas, circuit-breaker counters). Apollo/QuickEnrich keep their workspace_settings columns and cards.
- **Budget ledger**: `prospect_source_budget_ledger` rows per (source, bucket, granularity, periodKey) with consumed/reserved/limit; reservation is an atomic conditional UPDATE. WarmySender leads = daily pace ⌈monthly/30⌉ + monthly on the billing anniversary + optional non-expiring purchased credits; verification from their allowance endpoint; QuickEnrich uncapped (daily pull cap is the brake).
- **Staged searches**: `prospect_search_runs` / `prospect_search_results` (net-new, masked, charged, promotedProspectId). Promotion goes through the Find Prospects consolidation (discovery run → raw finds → People with provenance).
- **Dedupe before spend**: email (never masked) → LinkedIn slug → name@domain/company, against People + every campaign queue + the run itself.
