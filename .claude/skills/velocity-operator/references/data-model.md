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
   CLOSED WON  → account becomes a CUSTOMER (health, renewals, QBRs)
   CLOSED LOST → account + contact kept; a later deal is a NEW opportunity
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

### Opportunity `stage` (free text, seeded values)
`discovery` → `qualified` → `proposal` → `negotiation` → `won` | `lost`. Won turns the account into a Customer. Each opportunity carries `value`, `winProb`, `closeDate`, `daysInStage`, an AI next-step note, and a stage history table.

### Customer
- `tier`: `enterprise` | `midmarket` | `smb`
- `healthTier`: `healthy` | `watch` | `at_risk` | `critical`
- `renewalStage`: `early` → `ninety` → `sixty` → `thirty` → `at_risk` | `renewed` | `churned`

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

### Notification `kind` (Inbox `/inbox`)
`mention`, `task_assigned`, `task_due`, `deal_won`, `deal_lost`, `renewal_due`, `churn_risk`, `approval_request`, `workflow_fired`, `system`, `email_reply`, `are_event`.

### Activities (`activities`)
`type`: `call` | `meeting` | `email` | `note` | `linkedin` | `stage_change` | `system`; call dispositions: `connected`, `voicemail`, `no_answer`, `bad_number`, `gatekeeper`, `callback_requested`, `not_interested`. Logged against a contact, lead, account or opportunity (`relatedType` + `relatedId`).

### Proposals and quotes
- Proposal `status`: `draft` → `sent` → `under_review` → `accepted` | `not_accepted` | `revision_requested`; has sections (`sectionKey` + content), milestones (owner `lsi_media` | `client` | `both`), a share token for the client portal, optional link to an opportunity.
- Quote: `quoteNumber`, `status` (`draft` | `sent` | `accepted` | …), line items (`name`, `quantity`, `unitPrice`, `discountPct`, `lineTotal`), totals, terms; attached to an opportunity; products come from the catalog.

### Roles (`workspace_members.role`)
`super_admin` (everything, including workspace create/transfer/archive and demo seeding) > `admin` (settings, autonomy dials, team, sending) > `manager` (team views, approvals) > `rep` (own records and queues). Autonomy setters are admin-only; reps see the dial but cannot move it.

## Workspaces
Everything is scoped by `workspaceId`. A user can belong to several workspaces; the workspace switcher is in the top bar. `workspace_settings` holds the autonomy dials, caps, budgets, routing mode and campaign-copy defaults. Archived workspaces are excluded from every cron.

## Lists, segments, personas, ICP
- **Lists** (`record_lists` + members): hand-picked named sets of people or companies. Static. Used for targeting, the Add existing wizard's "From a list" step, and bulk actions.
- **Segments** (`audience_segments`): saved rule-based filters that stay current; feed Broadcasts and Segment Rules (auto-enroll into a sequence).
- **Personas**: buyer archetypes (titles, industries, sizes, keywords) grouped in categories; the writer and fit scoring read them.
- **ICP profile** (`icp_profiles`, versioned): the living ideal-customer profile; regenerated daily by the ICP cron from won deals and engagement; drives discovery targeting and the campaign screen floor.
- **Brand voice** (one row per workspace): tone, vocabulary, avoid-words, from-name; every AI-written email and chat reply reads it.
- **Score models** (`score_models` + `score_results`): fit scoring for people and companies; one primary per object type; ratings `excellent` | `good` | `fair` | `not_a_fit`.
