# Technical Spec — Outreach Emails / Email Activity / Reply Classification

> **Component:** Email activity monitoring + reply classification — the outbound email log (one-off + sequence), its delivery lifecycle, and the inbound-reply taxonomy that drives follow-up.
> **Status:** Design spec (hybrid). Canonical, provider-agnostic design + a **Velocity mapping & delta** callout per section tying it to the real `igrant9679/usip` stack (tRPC v11 + Drizzle/MySQL).
> **Framing:** Velocity already ships the hard parts — send records, open/click tracking, full inbound-reply capture (IMAP/Gmail/Unipile), and an AI reply-triage table. This spec designs the **unified activity surface** + the **12-state delivery lifecycle** + the **8-class reply taxonomy with workflow effects** on top of those primitives.
> **Sibling components:** [Sequence Enrollment](sequence-enrollment.md) (sends originate from memberships/steps), [Workspace Contacts & Accounts](workspace-contacts-accounts.md) (recipient context), [Enrichment System](enrichment-system.md) (email verification before send).
> **Functional reference:** sequence **Activity/Report** tabs (`Apollo Screenshots/03_engage`) + the generic filter-rail/table convention. (No dedicated emails-activity screenshot folder exists; grounding is thinner here.) Layout/UX only — no Apollo branding, icons, colors, or protected design reproduced.

---

## 0. Two-axis status model (read first)

An outreach email carries **two orthogonal statuses** — keep both, don't collapse:

- **Approval status** (workflow): `pending_review → approved/rejected → sent` (+ `ai_pending_review`). Governs the human/AI review gate before a draft is allowed to send.
- **Delivery status** (lifecycle, §2): `draft → scheduled → queued → sent → delivered → opened → clicked → replied → bounced/failed/cancelled/unsubscribed`. Governs what happened to an approved email in transit.

A draft can be `approved` (approval axis) and `scheduled` (delivery axis) at once. The activity table shows **delivery status**; the review queue uses **approval status**.

### 🔧 Velocity mapping & delta
- `emailDrafts.status` (L518) today = the **approval** axis (`pending_review/approved/rejected/sent/ai_pending_review`). **Delta:** add a separate **delivery** status (12 states) derived from tracking/provider events; keep approval status as-is.

---

## 1. Screen Purpose

The Email Activity screen is the **outbound operations console**. Reps and managers use it to:

1. **Monitor** every outbound email — one-off and sequence — in one filterable log, across users, mailboxes, and sequences.
2. **Spot deliverability problems** — bounces, failures, disconnected mailboxes, low open rates — before they burn a domain.
3. **Triage replies** — see which emails got replies, what *kind* of reply (willing to meet vs out-of-office vs not-interested), and act on the hot ones first.
4. **Follow up** — open an email's detail drawer to read the thread, see the classification, override it if wrong, and take the next step (reply, create task, stop sequence).
5. **Stay compliant** — see unsubscribes/bounces and the automatic suppression they trigger.

The screen answers: *"What did we send, what happened to it, who replied, and what should I do next?"*

### 🔧 Velocity mapping & delta
- `/v2/emails` is a **placeholder** today. Data exists (`emailDrafts`, `emailTrackingEvents`, `emailReplies`, `mailboxAiTriage`); the unified surface is new.

---

## 2. Email States (delivery lifecycle)

| State | Meaning | Set by |
|---|---|---|
| `draft` | composed, not scheduled | compose |
| `scheduled` | has a future send time | scheduler |
| `queued` | due, handed to the send worker | send job |
| `sent` | accepted by the mailbox/provider | provider ack |
| `delivered` | provider confirmed delivery | provider webhook |
| `opened` | open tracked ≥1 | tracking pixel |
| `clicked` | link click tracked ≥1 | tracking redirect |
| `replied` | inbound reply matched to this email | reply matcher |
| `bounced` | hard/soft bounce | provider/bounce job |
| `failed` | unrecoverable send error | send worker |
| `cancelled` | cancelled before send | user/system |
| `unsubscribed` | recipient opted out (this/any email) | unsub handler |

States are **monotonic-ish along the happy path** (`sent → delivered → opened → clicked → replied`) but `opened`/`clicked`/`replied` are also **engagement flags** (an email can be delivered+opened+replied). The table shows the **furthest-reached** state; the drawer shows the full event timeline. `bounced`/`failed`/`cancelled`/`unsubscribed` are terminal for that email.

### 🔧 Velocity mapping & delta
- Open/click exist (`emailTrackingEvents`). `sent` via `emailDrafts.sentAt`; reply via `emailReplies`; bounce/unsub via `emailSuppressions`. **Delta:** `scheduled/queued/delivered/failed/cancelled` need scheduler + provider-webhook events; a derived `delivery_status` column + a `furthest_state` rollup.

---

## 3. Reply Classes

Eight classes, each with **workflow effects** (automatic on classify, subject to confidence + override):

| Class | Meaning | Workflow effect |
|---|---|---|
| `willing_to_meet` | wants a meeting / positive | **Stop sequence** (exit on reply); create high-priority follow-up task; notify owner; flag hot. |
| `follow_up_question` | asking a question | Stop sequence; create follow-up task; surface to owner. |
| `person_referral` | redirects to someone else | Stop sequence; create task "save referral as contact"; capture referred name/email if parseable. |
| `out_of_office` | auto-reply OOO | **Do not stop**; pause/snooze next step until the OOO end-date (if parseable) or N days; no task. |
| `already_left_company_or_not_right_person` | wrong person / left | Stop sequence; flag contact `wrong_person`/stale; suggest re-enrich or remove. |
| `not_interested` | explicit no | Stop sequence; mark contact `not_interested`; optional suppression by policy. |
| `unsubscribe` | opt-out request | Stop sequence; **add suppression** (`reason=unsubscribe`); set membership `unsubscribed`; block future sends. |
| `none_of_the_above` | unclassifiable | No automatic effect; route to manual review; owner decides. |

Effects are config-overridable per workspace and **only auto-applied above the confidence threshold**; below threshold → suggested, await human confirm. Manual override re-runs the effect for the corrected class (with audit).

### 🔧 Velocity mapping & delta
- `mailboxAiTriage` provides label+confidence+rationale but a **coarse vocabulary** today (interested/not_interested/meeting-ish). **Delta:** adopt the 8-class enum; implement per-class workflow effects (most reuse Sequence-Enrollment §6 actions — stop/pause/unenroll — and Enrichment for referral capture); OOO date-parse + snooze.

---

## 4. Filters

| Filter | Type | Semantics |
|---|---|---|
| `user_ids[]` | id[] | sender user |
| `email_account_ids[]` / aliases | id[] | sender mailbox/alias |
| `sequence_ids_include[]` | id[] | only these sequences (one-off = "no sequence" pseudo-id) |
| `sequence_ids_exclude[]` | id[] | exclude sequences |
| `date_range_mode` | enum | `due_at` (scheduled) **or** `completed_at` (sent) |
| `date_min` / `date_max` | datetime | bounds for the chosen mode |
| `reply_classes[]` | enum[] | §3 classes |
| `contact` | id/search | recipient contact |
| `account` | id/search | recipient account |
| `status[]` | enum[] | §2 delivery states |
| `bounce_reason` | enum/string | hard/soft/block/invalid/… |

### 🔧 Velocity mapping & delta
- Sequence/mailbox/user/contact/account are all FK-available on `emailDrafts`/`emailReplies`. **Delta:** the `due_at` vs `completed_at` mode, reply-class + bounce-reason filters, and one-off-vs-sequence partition (today `emailDrafts.sequenceId` null = one-off).

---

## 5. Email Activity Table

| Column | Source | Display |
|---|---|---|
| Recipient | `to_email` | email |
| Contact | contact link | name → contact profile |
| Account | account link | name → account |
| Subject | draft | text, truncates |
| Sequence | `sequence_id` | name / "One-off" |
| Step | `step_id`/`current_step` | "Step 2" |
| Sender user | `sender_user_id` | name |
| Sender mailbox | `mailbox_id` | address |
| Status | delivery status | `EmailStatusBadge` |
| Reply class | classification | `ReplyClassBadge` (— if no reply) |
| Scheduled time | `scheduled_at` | datetime |
| Sent/completed time | `sent_at` | datetime |
| Opens | tracking count | n |
| Clicks | tracking count | n |
| Bounce reason | bounce event | text (if bounced) |
| Last event | latest event | "Opened 2h ago" |
| Actions | — | row menu (cancel/retry/open drawer/classify) |

Behaviors: sticky header, sort by any column, per-page + select-all, row click → detail drawer.

### 🔧 Velocity mapping & delta
- Opens/clicks aggregate from `emailTrackingEvents`; reply-class from `mailboxAiTriage`; the rest from `emailDrafts`. **Delta:** the assembled view (join across 4 tables) + "last event" rollup.

---

## 6. Email Detail Drawer

Sections:
- **Email body** — rendered HTML + text.
- **Headers/metadata** — message-id, in-reply-to, mailbox, provider ids, tracking ids.
- **Recipient context** — email, verification status.
- **Contact/account context** — owner, stage, links to profiles.
- **Sequence step** — which sequence + step produced it.
- **Event timeline** — ordered `email_events` (queued→sent→delivered→opened→clicked→replied/bounced) with timestamps (`EmailEventTimeline`).
- **Reply thread** — inbound + outbound messages threaded (`ReplyThreadPanel`).
- **Classification result** — class + confidence + rationale.
- **Manual override** — change class → re-applies workflow effect (audited) (`ClassificationOverrideModal`).
- **Compliance events** — unsubscribe/bounce/suppression applied.
- **Retry / cancel controls** — retry a failed send; cancel a scheduled one.

### 🔧 Velocity mapping & delta
- Body/headers from `emailDrafts`; thread from `emailReplies` (has `messageId`/`inReplyTo`); classification from `mailboxAiTriage` (rationale exists). **Delta:** the assembled timeline + override modal + retry/cancel wiring.

---

## 7. Reply Classification Service

Pipeline:
1. **Inbound email parser** — ingest from provider (Unipile webhook / IMAP poll / Gmail API); normalize headers, strip quoted history/signatures, extract reply body; store in `inbound_replies`.
2. **Thread matching** — match the reply to the originating outreach email via `in_reply_to`/`references`/`message_id`, then by mailbox + recipient + subject heuristics; resolve `outreach_email_id` + `membership` + `contact`. On match, set the email `replied`.
3. **Classification model/service** — LLM/classifier produces one of the 8 classes + a `rationale` (existing `mailboxAiTriage` pattern). Pluggable (rules pre-filter for OOO/unsubscribe; model for the rest).
4. **Confidence score** — 0–100; ≥ threshold (default 70) → auto-apply workflow effect; below → suggest + await confirm.
5. **Manual override** — user sets the correct class; persists `source=manual`, re-applies effects, audits.
6. **Workflow trigger** — dispatch §3 effects (stop/pause/unenroll/task/notify/suppress) idempotently.
7. **Audit log** — every classification (auto + override) + every triggered effect recorded.

### 🔧 Velocity mapping & delta
- Inbound capture exists (`emailReplies` with IMAP/Gmail/message-id); AI triage exists (`mailboxAiTriage` label+confidence+rationale). **Delta:** the **thread-matcher → set `replied`** link, the 8-class model + threshold gating, override persistence, and the workflow-trigger dispatch (reuses Sequence §6 + Enrichment + suppression).

---

## 8. Data Model

| Table | Purpose | Key fields |
|---|---|---|
| **`outreach_emails`** | one sent/scheduled email | `id, workspace_id, type (one_off|sequence), contact_id, account_id?, sequence_id?, step_id?, membership_id?, sender_user_id, mailbox_id, to_email, subject, body, approval_status, delivery_status, scheduled_at, sent_at, completed_at` |
| **`email_events`** | lifecycle events | `id, email_id, type (queued|sent|delivered|open|click|reply|bounce|fail|cancel|unsub), url?, provider_event_id (dedupe), occurred_at, meta` |
| **`email_threads`** | groups messages | `id, workspace_id, thread_key, mailbox_id, contact_id?, subject, last_message_at` |
| **`email_recipients`** | recipient(s) of an email | `id, email_id, contact_id?, email, role (to|cc|bcc)` |
| **`email_accounts`** | mailboxes | `sendingAccounts` |
| **`inbound_replies`** | parsed inbound mail | `id, workspace_id, email_id? (matched), thread_id?, mailbox_id, from_email, subject, body_text/html, message_id, in_reply_to, contact_id?, received_at` |
| **`reply_classifications`** | class per reply/thread | `id, workspace_id, reply_id, thread_id, class (8-enum), confidence, rationale, source (model|manual), applied_effect, classified_at, overridden_by?` |
| **`sequence_memberships`** / **`sequence_steps`** | origin | (Sequence spec) |
| **`contacts`** / **`accounts`** | recipient context | (CRM spec) |
| **`unsubscribe_events`** | opt-out log | `id, workspace_id, email_id?, contact_id?, email, source (link|reply|manual), occurred_at` |
| **`bounce_events`** | bounce log | `id, workspace_id, email_id, type (hard|soft|block), reason, provider_code, occurred_at` |

### 🔧 Velocity mapping & delta
| Canonical | Velocity |
|---|---|
| `outreach_emails` | `emailDrafts` (L518) — **add** `delivery_status`, `scheduled_at`, `step_id`, `membership_id`, `type` |
| `email_events` | `emailTrackingEvents` (L2088, open/click only) → **extend** to full lifecycle + `provider_event_id` dedupe |
| `email_threads` | loose `threadId` strings today → **new** thin table |
| `email_recipients` | single `to_*` on draft → **new** (multi-recipient) |
| `inbound_replies` | `emailReplies` (L2271) ✓ (message-id/in-reply-to present) |
| `reply_classifications` | `mailboxAiTriage` (L3495) → **align** to 8-class enum + add `reply_id`, `source`, `applied_effect`, override |
| `unsubscribe_events` / `bounce_events` | today rolled into `emailSuppressions` (L2110) → **new** event logs (suppression stays as the list) |

---

## 9. API Endpoints

Canonical REST → tRPC. Workspace-scoped; mutations audit.

**`POST /api/emails/search`** — body: §4 filters + `page, per_page, sort` → `{ emails: EmailRow[], total, facets }`. Perm: `emails.read`.
**`GET /api/emails/{emailId}`** — full email + contexts (drawer payload). Perm: `emails.read`. Error `404`.
**`GET /api/emails/{emailId}/events`** — ordered `email_events`. Perm: `emails.read`.
**`POST /api/emails/{emailId}/cancel`** — cancel a scheduled email → `delivery_status=cancelled`. Errors `409 not_cancellable` (already sent). Perm: `emails.manage`. Audit.
**`POST /api/emails/{emailId}/retry`** — retry a `failed` send. Errors `409 not_retryable`. Perm: `emails.manage`. Audit.
**`POST /api/emails/{emailId}/reply-classification`** — manual override. Body `{ class, note? }` → `{ classification }`; re-applies effect. Perm: `emails.classify`. Audit.
**`POST /api/webhooks/email-provider`** — provider delivery/bounce/open webhook. Auth: provider signature. **Idempotent on `provider_event_id`.** Updates `email_events` + delivery status.
**`POST /api/webhooks/inbound-email`** — inbound mail (Unipile/provider) → parse → `inbound_replies` → thread-match → classify. Auth: signature. Idempotent on `message_id`.
**`POST /api/unsubscribe`** — public unsubscribe (link). Body `{ token }` → adds suppression + `unsubscribe_events` + membership `unsubscribed`. No auth (signed token). Idempotent.

### 🔧 Velocity mapping & delta
| REST | tRPC / reality |
|---|---|
| search/get/events | new `emails.*` over `emailDrafts`+`emailTrackingEvents`+`emailReplies` |
| cancel/retry | new (scheduler/send-worker controls) |
| reply-classification | extend `mailbox`/triage with override |
| webhooks/email-provider | new (delivery/bounce); open/click tracking endpoints exist |
| webhooks/inbound-email | exists via Unipile inbound + IMAP poll → formalize + classify |
| unsubscribe | exists via `emailSuppressions`; add signed-token public route + event log |

---

## 10. UI Components

```
EmailActivityPage                    // /v2/emails
├─ EmailActivityFilters              // §4 filter rail (user/mailbox/sequence±/date-mode/class/status/bounce)
├─ EmailActivityTable                // §5 columns
│  ├─ EmailStatusBadge               // delivery status
│  └─ ReplyClassBadge                // 8-class
└─ EmailDetailDrawer                 // §6
   ├─ EmailEventTimeline             // ordered lifecycle events
   ├─ ReplyThreadPanel               // inbound+outbound thread
   ├─ ClassificationOverrideModal    // change class → re-apply effect
   └─ BounceReasonPanel              // bounce detail + remediation
```

State: filter object URL-serializable; table streams status via subscription; drawer lazy-loads thread + events.

### 🔧 Velocity mapping & delta
- All **new** (page is a placeholder). Reuse `Shell`/`PageHeader`/`useAccentColor`, `ui/dialog` (`sm:max-w-*`), flex rows `shrink-0`, the filter-rail/table convention from People/Companies.

---

## 11. Edge Cases

| Case | Handling |
|---|---|
| Privacy-protected opens (MPP/Apple) | flag opens as "possibly machine-opened"; don't auto-classify engagement from a single proxy open; weight clicks/replies higher. |
| Duplicate webhook events | dedupe on `provider_event_id`/`message_id`; idempotent upsert; no double state-change. |
| Delayed bounce | bounce arriving after `delivered`/`opened` → record `bounce_event`, move to `bounced`, add suppression; timeline keeps prior events. |
| Bounce after reply | reply stands (already `replied`); bounce recorded as event + suppression but does not overwrite a genuine reply class. |
| Out-of-office reply | classify `out_of_office`; **do not stop**; snooze next step to OOO end-date/N days; no task. |
| Unsubscribe reply | classify `unsubscribe`; stop sequence; suppression + `unsubscribe_event`; membership `unsubscribed`. |
| Wrong-person reply | classify `already_left…`; stop sequence; flag contact stale/wrong; suggest re-enrich. |
| Thread matching fails | reply stored unmatched (`email_id=null`); surface in an "unmatched replies" queue for manual link; classify on best-effort by from-email→contact. |
| Mailbox disconnected | scheduled emails for it → blocked/`failed` with reason; surface reconnect CTA; rotation (if sequence) skips it. |
| Scheduled email blocked by suppression | at send time, suppression check → `cancelled` (suppressed); no send; logged. |
| Classification confidence low | below threshold → suggested class, **no auto-effect**; routed to manual review; owner confirms/overrides. |

### 🔧 Velocity mapping & delta
- Suppression-at-send + open/click exist. **Delta:** webhook dedupe, MPP open handling, unmatched-reply queue, delayed/after-reply bounce ordering, OOO snooze.

---

## 12. Acceptance Criteria (Given/When/Then)

**Activity + filters**
- Given sent emails across 3 mailboxes, When filtering `email_account_ids=[A]` + `status=[bounced]`, Then only A's bounced emails return.
- Given `date_range_mode=completed_at` + a range, When searching, Then only emails sent in that range return (not merely scheduled).
- Given `sequence_ids_exclude=[S]`, When searching, Then emails from S are excluded and one-offs remain.

**States**
- Given a scheduled email, When the mailbox is disconnected at send time, Then it moves to `failed` with a reason and is retryable.
- Given a delivered email opened twice and clicked once, When viewed, Then opens=2, clicks=1, and furthest state is `clicked`.

**Reply classification**
- Given an inbound reply matched by `in_reply_to`, When ingested, Then the originating email moves to `replied` and a classification is produced with confidence + rationale.
- Given a reply classified `unsubscribe` ≥ threshold, When processed, Then the membership → `unsubscribed`, a suppression + `unsubscribe_event` are written, and no further steps send.
- Given a reply classified `out_of_office`, When processed, Then the sequence does **not** stop and the next step is snoozed.
- Given a reply classified below threshold, When processed, Then no workflow effect auto-applies and it routes to manual review.
- Given a manual override to `willing_to_meet`, When saved, Then the sequence stops, a follow-up task is created, and the change is audited.

**Webhooks / idempotency**
- Given the same provider event delivered twice, When processed, Then it's deduped on `provider_event_id` and state changes once.
- Given a bounce arriving after a reply, When processed, Then the reply class is preserved and the bounce is recorded as an event + suppression.

**Compliance / permissions**
- Given a suppressed recipient, When a scheduled email is due, Then it's `cancelled` (suppressed), not sent.
- Given a user without `emails.classify`, When overriding a class, Then `403`.

**Cancel/retry**
- Given a scheduled email, When cancelled, Then `delivery_status=cancelled` and it never sends; When already sent, `409 not_cancellable`.

---

## 13. Implementation Checklist

**Backend**
- [ ] `emails.search/get/events/cancel/retry/reply-classification` (tRPC); two-axis status (keep approval, add delivery).
- [ ] Every mutation audits; workspace-scoped; validate ids → 404.

**Data model**
- [ ] Extend `emailDrafts` (`delivery_status`, `scheduled_at`, `step_id`, `membership_id`, `type`); extend `emailTrackingEvents` → full `email_events` + `provider_event_id` dedupe.
- [ ] New: `email_threads`, `email_recipients`, `unsubscribe_events`, `bounce_events`; align `mailboxAiTriage` → `reply_classifications` (8-enum, source, applied_effect, override).
- [ ] Migration in BOTH `drizzle/schema.ts` AND `server/_core/rawMigrations.ts` (next: **0094**).

**Email provider integration**
- [ ] Provider webhook (`/webhooks/email-provider`) for delivery/bounce/open; inbound (`/webhooks/inbound-email`) via Unipile/IMAP/Gmail; signature verify + idempotency.

**Classification service**
- [ ] Inbound parser (strip quotes/sigs), thread-matcher (in_reply_to→message_id→heuristics) that sets `replied`, 8-class model + rationale + confidence threshold, override persistence, workflow-trigger dispatcher (reuse Sequence §6 + suppression + Enrichment for referrals), OOO date-parse + snooze.

**Worker jobs**
- [ ] Send/schedule worker (status transitions), tracking ingestion, bounce/unsub handlers, reply ingestion+classification, status-rollup ("furthest state" + last-event).

**Frontend**
- [ ] `EmailActivityPage` + filters + table + `EmailStatusBadge`/`ReplyClassBadge` + `EmailDetailDrawer` (timeline, thread, override modal, bounce panel). Dialogs `sm:max-w-*`.

**Compliance**
- [ ] Suppression-at-send → `cancelled`; unsubscribe link (signed token) + events; bounce → suppression; classification-driven suppression by policy.

**Tests**
- [ ] G/W/T from §12.
- [ ] Webhook idempotency + dedupe; thread-match accuracy + unmatched queue; per-class workflow-effect correctness + threshold gating; delayed/after-reply bounce ordering; MPP open handling; cross-workspace isolation.

---

### Appendix — provenance of functional references
Grounded from the sequence **Activity/Report** tabs (`Apollo Screenshots/03_engage`) and the generic filter-rail/table convention used across People/Companies — no dedicated emails-activity screenshot folder exists, so this component's UI follows the established Velocity table/drawer pattern. Layout/UX only; no Apollo brand assets, icons, or protected design reproduced.
