# Technical Spec — Tasks / Calls / Deals

> **Component:** The execution + revenue layer — Tasks (upcoming actions), Calls (dial records + outcomes), Deals (opportunities + pipeline).
> **Status:** Design spec (hybrid). Canonical, provider-agnostic design + a **Velocity mapping & delta** callout per section tying it to the real `igrant9679/usip` stack (tRPC v11 + Drizzle/MySQL).
> **Three sub-systems at different maturity:** **Tasks** ≈ exists (expand fields/vocab); **Deals** ≈ exists (augment); **Calls** ≈ greenfield (today a call is just a `task` with `type='call'`; no call/recording/transcript tables, no dialer infra).
> **Modeling decision (locked):** a **call-type task = queue intent** ("call this contact"); executing it **creates a first-class `call` record** (the dial + outcome), and the task's `disposition` mirrors the call outcome. Preserves the existing `/v2/calls` task-queue.
> **Sibling components:** [Workspace Contacts & Accounts](workspace-contacts-accounts.md) (owners/contacts/accounts), [Sequence Enrollment](sequence-enrollment.md) (sequence-generated tasks), [Email Activity](email-activity-reply-classification.md) (activity timeline).
> **Functional reference:** existing `/v2/calls` task-queue + the generic table/board convention. (Tasks/Calls/Deals aren't in the prospect/engage screenshot folders, so grounding is thin — UI follows established Velocity patterns.) Layout/UX only — no Apollo branding, icons, colors, or protected design reproduced.

---

## 0. Invariants (read first)

1. **Tasks are upcoming actions** (email X, call Y); a task is the *intent/queue item*, not the outcome.
2. **Bulk task creation = one task per contact** — N contacts → N tasks. **No silent dedupe** unless an explicit dedupe rule is enabled.
3. **A call is a first-class execution record** linked to the call-type task that queued it; it carries the dial details, status lifecycle, outcome, recording, and transcript.
4. **A deal is an opportunity on an account** with an owner, a pipeline stage, an amount/currency, and probability — feeding pipeline reporting.
5. **User IDs drive ownership/assignment** — task owner, caller, deal owner all reference workspace users.
6. **Everything is workspace-scoped**, audited, and emits `activity_events` for the contact/account timeline.

---

## 1. Task System

**Task types:**

| Canonical type | Meaning |
|---|---|
| `call` | call a contact (queues → spawns a `call`) |
| `manual_email` | hand-write/send a one-off email |
| `social_touch` | LinkedIn/social action |
| `follow_up` | generic follow-up |
| `meeting_prep` | prep before a meeting |
| `crm_update` | update CRM data |
| `generic_action` | catch-all |

**Task fields:**

| Field | Type | Notes |
|---|---|---|
| `owner_id` | user FK | assignee/caller |
| `contact_id` | contact FK | primary related contact |
| `account_id` | account FK | related account |
| `sequence_id` | sequence FK? | set when sequence-generated |
| `due_at` | datetime | when it's due |
| `priority` | enum | low/normal/high/urgent |
| `status` | enum | open/in_progress/done/cancelled/snoozed |
| `instructions` | text | what to do (body) |
| `disposition` | enum | outcome on completion (e.g. completed/no_answer/left_voicemail/rescheduled) |
| `completed_at` | datetime | when done |

### 🔧 Velocity mapping & delta
- `tasks` (L377): `type (call|email|meeting|linkedin|todo|follow_up)`, `priority (low|normal|high|urgent)` ✓, `status (open|done|cancelled)`, `dueAt`/`completedAt`/`ownerUserId` ✓, `description` = instructions, **polymorphic** `relatedType/relatedId`.
- **Delta:** expand `type` enum (add `social_touch`/`manual_email`/`meeting_prep`/`crm_update`/`generic_action`; map `linkedin→social_touch`, `email→manual_email`); add explicit `contact_id`/`account_id`/`sequence_id` (or keep polymorphic + add `contact_id`); add `disposition`; expand `status` (`in_progress`/`snoozed`). Vocab tables (`task_types`/`task_statuses`/`task_dispositions`) optional — enums fine near-term.

---

## 2. Task Creation Behavior

| Mode | Behavior |
|---|---|
| **Single task** | one task, explicit fields. |
| **Bulk task** | N selected contacts → **one task per contact** (same template: type/priority/instructions/due). Returns `{ created: N }`. |
| **Sequence-generated** | a sequence `task` step materializes a task per active membership at the step (Sequence spec §9). |
| **Manual** | rep-authored ad-hoc. |
| **AI-suggested drafts** | the assistant proposes task drafts (e.g. "follow up with these 5"); user confirms before creation — never silent. |
| **Dedupe** | **off by default.** Creating the same task twice creates two tasks. A workspace may enable an explicit dedupe rule (e.g. "skip if an open `call` task already exists for this contact"); only then is creation skipped, and the response reports `{ created, skipped:[{contact_id, reason}] }`. |

### 🔧 Velocity mapping & delta
- `tasks.create` exists; `/v2/calls` reads `tasks` filtered `type='call'`. **Delta:** explicit bulk endpoint (one-per-contact), the optional dedupe rule (off by default), and AI-draft confirm flow.

---

## 3. Call System

**Call fields:**

| Field | Type | Notes |
|---|---|---|
| `user_id` | user FK | the caller |
| `contact_id` | contact FK | callee |
| `account_id` | account FK | callee's account |
| `task_id` | task FK | the queuing call-task (nullable for ad-hoc) |
| `to_number` / `from_number` | E.164 | dialed / caller-id |
| `status` | enum | lifecycle (below) |
| `start_time` / `end_time` | datetime | dial start / hangup |
| `duration` | int (s) | derived |
| `outcome` | enum | `call_outcomes` (connected/voicemail/no_answer/wrong_number/gatekeeper/meeting_booked/not_interested) |
| `purpose` | enum | `call_purposes` (cold_call/follow_up/discovery/demo_setup/check_in) |
| `notes` | text | rep notes |
| `recording_url` | string | async (provider) |
| `transcript_status` | enum | none/pending/ready/failed |
| `logged` | bool | manually-logged vs provider-driven |

**Call statuses (lifecycle):** `queued → ringing → in-progress → completed | no_answer | failed | busy`.

```
queued → ringing → in-progress → completed
queued → ringing → no_answer | busy
queued → failed
```

Recording/transcript arrive **asynchronously** via the provider webhook after `completed` (transcript_status `pending → ready/failed`). **Recording consent** is checked/warned before recording per region (§8).

### 🔧 Velocity mapping & delta
- **Greenfield.** Today a call = a `tasks` row (`type='call'`); no call entity, statuses, recordings, transcripts, or dialer. **Delta:** the whole `calls` table + status machine + `call_provider_events` + `call_recordings` + `call_transcripts` + `call_outcomes`/`call_purposes` + a **CallProvider** abstraction (Twilio/etc.) mirroring the enrichment-vendor + email-provider webhook patterns. The call-task links via `task_id`.

---

## 4. Deal System

**Deal fields:**

| Field | Type | Notes |
|---|---|---|
| `name` | string | deal name |
| `account_id` | account FK | the company |
| `owner_id` | user FK | deal owner |
| `deal_stage_id` | stage FK/key | pipeline stage |
| `amount` | decimal | deal value |
| `currency` | ISO 4217 | per-deal currency |
| `probability` | int 0–100 | win likelihood |
| `expected_close_date` | date | forecast |
| `status` | enum | open/won/lost (derived from stage `isWon`/`isLost` + explicit close) |
| `source` | enum/string | inbound/outbound/referral/campaign |
| `related_contacts` | via roles | `deal_contact_roles` (champion/decision_maker/…) |
| `crm_external_id` | string | external CRM mapping |

Pipeline reporting: deals roll up by stage/owner/close-date for forecast (weighted by probability), velocity (days-in-stage), and win/loss.

### 🔧 Velocity mapping & delta
- `opportunities` (L228) = deals: `name, accountId, stage (varchar key), value (=amount), winProb (=probability), closeDate (=expected_close_date), pipelineId, ownerUserId, lostReason/winReason, customFields, daysInStage, lastActivityAt`. `crm_pipeline_stages` (L304) = deal_stages (key/label/sortOrder/isWon/isLost/defaultWinProb). `opportunity_contact_roles` (L348) = deal_contact_roles ✓. `dealLineItems`/`quotes`/`products` for line-item value.
- **Delta:** `currency` (single-currency today), explicit `status` (open/won/lost — derive + persist), `source`, `crm_external_id` (shared CRM-spec delta).

---

## 5. Data Model

| Table | Purpose | Velocity |
|---|---|---|
| **`tasks`** | upcoming actions | `tasks` (L377) — expand type/status, add contact_id/account_id/sequence_id/disposition |
| **`task_types`** / **`task_statuses`** / **`task_dispositions`** | vocab | enums today (optional tables) |
| **`calls`** ★ | dial execution records | **new** (`task_id`, user/contact/account, numbers, status, times, outcome, purpose, notes, recording_url, transcript_status, logged) |
| **`call_outcomes`** / **`call_purposes`** ★ | vocab | **new** |
| **`call_provider_events`** ★ | raw provider callbacks | **new** (`call_id, provider_event_id (dedupe), type, payload, occurred_at`) |
| **`call_recordings`** ★ | recording assets | **new** (`call_id, url, duration, consent_state, created_at`) |
| **`call_transcripts`** ★ | transcripts | **new** (`call_id, status, text, language, provider, created_at`) |
| **`deals`** | opportunities | `opportunities` (L228) — add currency/status/source/crm_external_id |
| **`deal_stages`** | pipeline stages | `crm_pipeline_stages` (L304) ✓ |
| **`deal_contact_roles`** | contacts on a deal | `opportunity_contact_roles` (L348) ✓ |
| **`users`** / **`contacts`** / **`accounts`** | refs | `users`/`contacts`/`accounts` ✓ |
| **`activity_events`** | timeline | `activities` (L408) ✓ |

### 🔧 Velocity mapping & delta
- Tasks/Deals/stages/roles/activities all exist. **New tables:** the entire call subsystem (`calls`, `call_outcomes`, `call_purposes`, `call_provider_events`, `call_recordings`, `call_transcripts`). Migration in BOTH `drizzle/schema.ts` AND `server/_core/rawMigrations.ts` (next: **0094**).

---

## 6. API Endpoints

Canonical REST → tRPC. Workspace-scoped; mutations audit + emit activity.

**Tasks**
- **`GET /api/tasks`** — list/filter (owner/status/type/due/contact/account/sequence). Perm: `tasks.read`.
- **`POST /api/tasks`** — create one. Body: task fields. Errors `422`. Perm: `tasks.create`.
- **`POST /api/tasks/bulk`** — one-per-contact. Body `{ contact_ids[], template:{type,priority,instructions,due_at,owner_id}, dedupe_rule? }` → `{ created, skipped[] }`. **No dedupe unless `dedupe_rule` set.** Perm: `tasks.create`+`bulk`.
- **`PATCH /api/tasks/{taskId}`** — update. Perm: `tasks.update`.
- **`POST /api/tasks/{taskId}/complete`** — `→ done`, set `completed_at` + `disposition`. Perm: `tasks.update`.
- **`POST /api/tasks/{taskId}/snooze`** — `→ snoozed`, set new `due_at`. Perm: `tasks.update`.

**Calls**
- **`POST /api/calls/search`** — filter (user/contact/account/status/outcome/date). Perm: `calls.read`.
- **`POST /api/calls/start`** — begin a call. Body `{ task_id?, contact_id, to_number, from_number, purpose }` → `{ call_id, status:'queued' }` (provider dials). Validation: valid E.164; mailbox/number connected; consent region check. Perm: `calls.create`.
- **`PATCH /api/calls/{callId}`** — update notes/status (manual log). Perm: `calls.update`.
- **`POST /api/calls/{callId}/disposition`** — set outcome (and mirror to the linked task's disposition). Body `{ outcome, notes? }`. Perm: `calls.update`.
- **`POST /api/webhooks/call-provider`** — provider lifecycle/recording/transcript callbacks. Auth: provider signature. **Idempotent on `provider_event_id`.** Updates `calls`/`call_recordings`/`call_transcripts`.

**Deals**
- **`GET /api/deals`** — list/filter (stage/owner/account/close-date/status); reporting roll-ups. Perm: `deals.read`.
- **`POST /api/deals`** — create. Body: deal fields. Validation: account exists; stage valid; owner is member. Errors `422 invalid_stage`. Perm: `deals.create`.
- **`PATCH /api/deals/{dealId}`** — update (stage change → recompute status/probability/days-in-stage; write `opportunity_stage_history`). Perm: `deals.update`.
- **`GET /api/deal-stages`** — pipeline stage vocab. Perm: `deals.read`.

### 🔧 Velocity mapping & delta
| REST | tRPC |
|---|---|
| tasks GET/POST/PATCH/complete | `tasks.*` ✓ |
| tasks/bulk + snooze | **new** (one-per-contact, snooze) |
| calls/* + webhook | **new** (call subsystem) |
| deals GET/POST/PATCH | `opportunities.*` ✓ |
| deal-stages | `crmPipelines`/`crm_pipeline_stages` ✓ |

---

## 7. UI Components

```
TasksPage                            // /v2/tasks
├─ TaskQueue                         // prioritized list (due/priority); bulk bar
└─ TaskDetailPanel                   // fields + complete/snooze + disposition

CallQueue                            // /v2/calls — call-type tasks to work
├─ ActiveCallPanel                   // in-call: status, timer, notes, contact context
├─ CallDispositionModal              // outcome + notes on hangup → mirrors task
└─ CallHistoryTable                  // past calls: status/outcome/duration/recording/transcript

DealsPage                            // /v2/deals
├─ DealPipelineBoard                 // kanban by stage (drag → stage change)
├─ DealTable                         // tabular view; filter/sort
├─ DealDetailDrawer                  // fields, contact roles, line items, stage history, activity
└─ CreateDealModal                   // name/account/owner/stage/amount/currency/close-date
```

State: filter objects URL-serializable; pipeline board optimistic-updates stage on drag then persists; active-call panel subscribes to provider status.

### 🔧 Velocity mapping & delta
- `/v2/calls` task-queue exists; `/v2/tasks` + `/v2/deals` are placeholders. **New:** `ActiveCallPanel`/`CallDispositionModal`/`CallHistoryTable` (real calls), `DealPipelineBoard`/`DealTable`/`DealDetailDrawer`/`CreateDealModal`. Reuse `Shell`/`PageHeader`, `ui/dialog` (`sm:max-w-*`), flex rows `shrink-0`.

---

## 8. Edge Cases

| Case | Handling |
|---|---|
| Duplicate task creation | allowed by default (two tasks); only an enabled dedupe rule skips, reporting `skipped[]`. |
| Contact deleted | task/call/deal keep a snapshot + show "contact removed"; relations null-safe; no crash. |
| Account deleted | deal shows "account removed"; block stage progress until re-linked (configurable). |
| User removed | owner/caller → "Unassigned (was {name})"; bulk reassign; routing skips. |
| Phone number invalid | `calls/start` validates E.164 → `422 invalid_number`; no dial. |
| Call provider unavailable | `calls/start` → `failed (provider_unavailable)`; surface retry; task stays open. |
| Call timezone mismatch | display call times in the rep's tz; store UTC; warn if dialing outside callee's local calling hours. |
| Recording consent warning | before recording, check region 1-party/2-party rule; warn/disable recording where required; store `consent_state`. |
| Deal owner missing | block create/save → `422 owner_required` (or default to creator, configurable). |
| Invalid deal stage | `422 invalid_stage` (stage not in the deal's pipeline). |
| CRM sync failure | mark `crm_external_id` sync `failed`; queue retry; surface badge; never lose the local record. |

### 🔧 Velocity mapping & delta
- Owner-removed/stage-validation patterns partly exist (CRM). **Delta:** all call-specific cases (invalid number, provider down, tz/consent) + CRM-sync failure handling (needs `crm_external_ids`).

---

## 9. Acceptance Criteria (Given/When/Then)

**Tasks**
- Given 5 selected contacts, When `POST /api/tasks/bulk` with a call template, Then **5 tasks** are created (one per contact), with no dedupe.
- Given the same bulk call run twice with dedupe **off**, When executed, Then 10 tasks exist (no silent skip).
- Given a dedupe rule "skip if open call task exists", When re-run, Then existing-contact tasks are `skipped[]` with reason and only new ones create.
- Given a call task, When completed with disposition `no_answer`, Then status `done`, `completed_at` set, disposition recorded.
- Given a task, When snoozed to tomorrow, Then status `snoozed` and `due_at` updated.

**Calls**
- Given a valid contact + E.164 number, When `calls/start`, Then a `call` is created `queued` linked to the task and the provider dials.
- Given an invalid number, When `calls/start`, Then `422 invalid_number` and no call row.
- Given a completed call, When the provider webhook delivers a recording + transcript, Then `recording_url` + `transcript_status=ready` update, deduped on `provider_event_id`.
- Given a disposition set on a call, When saved, Then the linked task's disposition mirrors it.
- Given a recording-restricted region, When starting a call, Then a consent warning shows and recording is gated.

**Deals**
- Given an account + valid stage + owner, When `POST /api/deals`, Then a deal is created and appears in the pipeline.
- Given a stage with no owner, When creating without `owner_id`, Then `422 owner_required` (unless default-to-creator configured).
- Given a deal dragged to a new stage, When persisted, Then status/probability/days-in-stage recompute and `opportunity_stage_history` records the move.
- Given an invalid stage key, When saving, Then `422 invalid_stage`.

**Cross-cutting**
- Given any task/call/deal mutation, When it succeeds, Then an `activity_event` + `audit_log` are written and the contact/account timeline reflects it.

---

## 10. Implementation Checklist

**Database**
- [ ] Expand `tasks` (type/status enums; add `contact_id`/`account_id`/`sequence_id`/`disposition`).
- [ ] New call subsystem: `calls`, `call_outcomes`, `call_purposes`, `call_provider_events`, `call_recordings`, `call_transcripts`.
- [ ] Augment `opportunities` (currency, status, source, crm_external_id).
- [ ] Migration in BOTH `drizzle/schema.ts` AND `server/_core/rawMigrations.ts` (next: **0094**).

**Backend (tRPC)**
- [ ] `tasks.bulk` (one-per-contact, optional dedupe rule), `tasks.snooze`, expanded complete (disposition).
- [ ] `calls.search/start/update/disposition` + `webhooks/call-provider` (idempotent on provider_event_id); link call↔task; mirror disposition.
- [ ] `deals.*` (status/probability/days-in-stage recompute on stage change; stage-history); `deal-stages`.
- [ ] Workspace-scoped; validate ids → 404; every mutation audits + emits activity.

**Queue / workers**
- [ ] Call lifecycle worker (status transitions), recording/transcript ingestion, sequence-task materialization, CRM-sync retry.

**Call provider abstraction**
- [ ] `CallProvider` interface (`startCall`, `hangup`, webhook normalize) with a Twilio (or chosen) adapter; consent-region rules; number validation (E.164).

**CRM sync**
- [ ] `crm_external_ids` mapping + push/pull for deals/tasks; failure badges + retry (shared with CRM/Org specs).

**Analytics**
- [ ] Pipeline reporting (forecast weighted by probability, velocity/days-in-stage, win/loss), call activity (dials/connect-rate/outcomes), task throughput.

**Frontend**
- [ ] `TasksPage`/`TaskQueue`/`TaskDetailPanel`; `CallQueue`/`ActiveCallPanel`/`CallDispositionModal`/`CallHistoryTable`; `DealsPage`/`DealPipelineBoard`/`DealTable`/`DealDetailDrawer`/`CreateDealModal`. Dialogs `sm:max-w-*`; flex rows `shrink-0`.

**Tests**
- [ ] G/W/T from §9.
- [ ] No-silent-dedupe (bulk = N tasks) + opt-in dedupe rule.
- [ ] Call status machine + provider-webhook idempotency + disposition mirroring + consent gating.
- [ ] Deal stage-change recompute + history + forecast roll-ups.
- [ ] Cross-workspace isolation; deleted-entity null-safety.

---

### Appendix — provenance of functional references
Grounded from the existing `/v2/calls` task-queue and the generic table/board/drawer convention used across People/Companies/Sequences — Tasks/Calls/Deals are not represented in the prospect/engage screenshot folders, so this component's UI follows the established Velocity CRM patterns. Layout/UX only; no Apollo brand assets, icons, or protected design reproduced.
