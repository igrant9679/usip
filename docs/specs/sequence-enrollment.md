# Technical Spec — Sequence Enrollment & Membership Management

> **Component:** Add Contacts to Sequence + sequence-membership lifecycle (enroll, validate, status states + transitions, per-contact actions).
> **Status:** Design spec (hybrid). Canonical, provider-agnostic design + a **Velocity mapping & delta** callout per section tying it to the real `igrant9679/usip` stack (tRPC v11 + Drizzle/MySQL).
> **Decision locked — Option A (contacts-only):** every membership points at a **`contact_id`**. Prospects/leads cannot be enrolled directly; "save as contact" is mandatory first. This **reverses migration 0085** (which made `prospectId`/`leadId` first-class enrollment targets) — see deltas.
> **Sibling components:** [People Search](people-search.md) (§5/§11 the save-then-enroll + `previewEnrollment` gate), [Workspace Contacts & Accounts](workspace-contacts-accounts.md) (the contacts being enrolled), [Enrichment System](enrichment-system.md) (email must be revealed+verified to send).
> **Functional reference:** `Apollo Screenshots/03_engage` (sequence detail: Editor/Contacts/Activity/Report/Settings tabs, "Add Contacts", "Activate" toggle). Layout/UX only — no Apollo branding, icons, colors, or protected design reproduced.

---

## 0. Invariants (read first)

1. **Only saved contacts can be enrolled.** A membership requires a `contact_id`. Global people must be saved as contacts first (People Search §5). The enroll API rejects any non-contact target.
2. **Sending requires ≥1 connected email account.** Enrollment with automated email steps fails if no connected mailbox is available to the sender.
3. **Multi-mailbox rotation is supported** — a sequence can rotate across a pool of mailboxes to spread send volume.
4. **Enrollment is gated by validation.** A preview/validation pass runs before any membership is created; blocked contacts never enroll, warnings surface but allow.
5. **Membership status is a state machine** (§5) — eleven states with defined transitions; compliance events (reply/bounce/unsub/suppress) drive automatic transitions.
6. **Idempotent + bounded.** Enrollment runs as a job with an idempotency key; duplicate membership (same contact + sequence, active) is prevented.

### 🔧 Velocity mapping & delta
- Enrollment exists (`enrollments` L496) but accepts `contactId`/`leadId`/`prospectId`. **Delta (Option A):** guard the API + UI to `contact_id` only; retire/guard prospect/lead enrollment paths (reverses 0085); backfill existing prospect-targeted enrollments into contacts. Rotation already exists via `senderPools`/`senderPoolMembers`.

---

## 1. Enrollment Entry Points

| Entry point | Flow |
|---|---|
| **Contact profile** | "Add to sequence" on a single contact → wizard pre-selected to that contact. |
| **Contact search bulk action** | Select N saved contacts → `BulkActionBar` → "Add to sequence" → wizard. |
| **People search after saving** | People Search "Add to sequence" auto-saves selected people as contacts first (mandatory), then opens the wizard with the new `contact_id`s (People Search §5). |
| **List / label membership** | Enroll an entire list (`list_ids[]`) or label (`label_names[]`) — resolved to contact_ids at enroll time. |
| **Saved segment** | Enroll a dynamic segment (`saved_search_id`) — resolved to current matching contacts at enroll time. |
| **Account contacts table** | From an account profile, enroll its contacts. |
| **CSV import** | An import job's resulting contacts (`csv_import_job_id`) feed enrollment after rows are saved as contacts. |
| **API** | Programmatic enroll (scoped) — contact_ids or list/label sources. |
| **AI assistant action draft** | The assistant proposes an enrollment (contacts + sequence) as a **draft action** the user confirms — never auto-sends. |

### 🔧 Velocity mapping & delta
- Contact/People surfaces exist; the SequenceEditor has an "Add Contacts" affordance (reference). `segmentSequenceRules` (L2063) + `enrollmentTrigger` (status_change/tag_applied/score_threshold) cover list/label/segment auto-enrollment. **Delta:** unify all entry points through one wizard + `previewEnrollment`; AI-assistant draft action (proposes, user confirms).

---

## 2. Enrollment Modal / Wizard (`SequenceEnrollmentWizard`)

Steps/fields:
1. **Selected contacts count** — "{N} contacts selected" (resolved from source).
2. **Sequence selector** — active/published sequences only (`SequenceSelector`).
3. **Sender user selector** — whose identity/permissions the sends run under.
4. **Email account selector** — connected mailbox(es) for this sender (`SenderMailboxSelector`).
5. **Multi-mailbox rotation** — toggle + pool selection + per-mailbox daily cap (`MultiMailboxRotationPanel`).
6. **Start date/time** — immediate or scheduled.
7. **Timezone** — send-window timezone (defaults to sequence/workspace).
8. **Validation summary** — counts: enrollable / blocked / warnings (`EnrollmentValidationSummary`).
9. **Blocked contacts table** — per-contact block reason; cannot enroll (`BlockedContactsTable`).
10. **Warnings table** — per-contact warning (e.g. unverified email); enroll allowed (`EnrollmentWarningsTable`).
11. **Confirm enrollment** — disabled until ≥1 enrollable contact + a connected mailbox; fires the enroll job.

The wizard calls `previewEnrollment` on open (and on source/sequence change) to populate 8–10 before the user confirms.

### 🔧 Velocity mapping & delta
- The create-sequence flow + "Add Contacts" exist. **New components:** the full wizard with validation summary + blocked/warnings tables + rotation panel. Reuse `ui/dialog` (`sm:max-w-*`), `Shell`.

---

## 3. Validation Checks

Run in `previewEnrollment` (and re-checked at enroll time — TOCTOU). Each produces **block** (cannot enroll) or **warn** (enroll allowed).

| Check | Result | Source |
|---|---|---|
| Contact is saved (has `contact_id`) | block | invariant |
| Sequence exists | block (whole job) | `sequences` |
| Sequence is active/published | block (whole job) | `sequences.status='active'` |
| Contact has valid email (for email steps) | block | `contacts.email` + verification |
| Required template variables resolve | block/warn | `template_variable_resolution_logs` |
| Contact not suppressed (workspace) | block | `email_suppressions`/`are_suppression_list` |
| Contact not unsubscribed | block | suppression `reason=unsubscribe` |
| Contact has not hard-bounced | block | suppression `reason=bounce` |
| Not already active in same sequence | block (dedupe) | `enrollments` |
| Not in a conflicting sequence | block/warn | conflict rules |
| Same-account conflict rule | warn/block | account-level guard (don't double-touch one account) |
| Mailbox connected | block (whole job) | `sendingAccounts` |
| User has send permission | block | RBAC |
| User has sequence-enrollment permission | block | RBAC |
| Sending limits available | warn/block | `sendingAccountDailyStats` + `dailyCap` |

### 🔧 Velocity mapping & delta
- Suppression, sequence status, mailbox, daily caps all exist as data. **Delta:** the unified validation pass producing typed block/warn per contact, `template_variable_resolution_logs`, and conflict/same-account rules. Email-valid check ties to the Enrichment + Email-Verification subsystems.

---

## 4. Enrollment Sources

A source resolves to a concrete `contact_id[]` at enroll time (snapshot). Exactly one primary source required.

| Source | Resolution |
|---|---|
| `contact_ids[]` | explicit list (already contacts) |
| `label_names[]` | resolve label memberships → contact_ids |
| `list_ids[]` | resolve `record_list_members` → contact_ids |
| `saved_search_id` | run the saved segment → current matching contact_ids |
| `csv_import_job_id` | the contacts created by that import job |

Rule: **if `contact_ids` and `label_names`/`list_ids`/`saved_search_id`/`csv_import_job_id` are all missing → `422 no_source`.** Non-contact members of a list/label (e.g. raw prospects) are filtered out (Option A) and reported as skipped.

### 🔧 Velocity mapping & delta
- `record_lists`/`record_list_members` (L1917/1933), `clodura_saved_searches`, `contact_imports` exist. **Delta:** label resolution (labels table is a CRM-spec delta), and the contacts-only filter that drops non-contact list members.

---

## 5. Status Model + Transitions

Eleven membership states:

| State | Meaning | Terminal? |
|---|---|---|
| `scheduled` | enrolled, first step not yet due | no |
| `active` | progressing through steps | no |
| `paused` | temporarily halted (user or system) | no |
| `stopped` | halted by user; will not resume automatically | semi (resumable→active) |
| `removed` | taken out of the sequence (soft, audited) | yes |
| `finished` | completed all steps (or marked finished) | yes |
| `replied` | contact replied → exited on reply | yes |
| `bounced` | a send hard-bounced → exited | yes |
| `unsubscribed` | contact opted out → exited | yes |
| `blocked` | compliance/suppression blocked mid-flight | yes |
| `failed` | a step errored unrecoverably | semi (retry→active) |

**Valid transitions:**

```
scheduled → active | paused | stopped | removed | blocked | unsubscribed
active    → paused | stopped | finished | replied | bounced | unsubscribed | blocked | failed | removed
paused    → active (resume) | stopped | removed | finished
stopped   → active (resume) | removed
failed    → active (retry step) | removed | stopped
finished | replied | bounced | unsubscribed | blocked → removed  (only re-enroll creates a new membership)
removed   → (terminal)
```

Rules: `replied`/`bounced`/`unsubscribed`/`blocked` are **automatic** (driven by §9 jobs), exit-condition aware (`sequences.exitConditions`). Terminal states cannot resume — re-engaging requires a **new** membership. `removed` is a soft tombstone (audited), distinct from `stopped` (resumable).

### 🔧 Velocity mapping & delta
- `enrollments.status` today = **4 states** (`active/paused/finished/exited`). **Delta:** expand the enum to 11 + add a transition guard in the service layer; map legacy `exited` → one of `stopped/removed/replied/bounced/unsubscribed` based on reason. `sequences.exitConditions` already encodes reply/bounce/unsubscribe/goal/manual.

---

## 6. Sequence Status Actions

| Action | Effect | Allowed from |
|---|---|---|
| **Pause contact** | `→ paused`; halts scheduling | scheduled, active |
| **Resume contact** | `→ active`; reschedules next step | paused, stopped |
| **Stop contact** | `→ stopped`; no auto-resume | scheduled, active, paused |
| **Remove contact** | `→ removed`; soft tombstone, audited | any non-removed |
| **Mark as finished** | `→ finished`; treat as completed | scheduled, active, paused |
| **Retry failed step** | re-execute the errored step; `failed → active` | failed |
| **Move to specific step** | set `current_step = N`; reschedule | active, paused (admin) |
| **Unenroll due to compliance** | `→ blocked`; system/compliance-driven | any non-terminal |

All actions: permission-checked, audited (`audit_log`), and bulk-capable (`memberships/status`). Each writes a `sequence_membership` activity event.

### 🔧 Velocity mapping & delta
- Pause/resume-ish exist on enrollments. **Delta:** stop/remove/mark-finished/retry/move-to-step/unenroll-compliance as first-class, with transition validation + audit + activity events.

---

## 7. Data Model

| Table | Purpose | Key fields |
|---|---|---|
| **`sequences`** | the sequence | `id, workspace_id, name, status (draft|active|paused|archived), steps, enrollmentTrigger, dailyCap, exitConditions, settings, owner_user_id, enrolledCount` |
| **`sequence_steps`** | ordered steps | (today JSON on `sequences.steps`) `id, sequence_id, order, type (email|wait|task|linkedin_*), config` |
| **`sequence_memberships`** | a contact in a sequence | `id, workspace_id, sequence_id, contact_id, status, current_step, sender_user_id, mailbox_id?, scheduled_at, next_action_at, started_at, exited_at, exit_reason` |
| **`sequence_membership_steps`** ★ | per-membership per-step state | `id, membership_id, step_id, status (pending|scheduled|sent|skipped|failed), scheduled_at, executed_at, draft_id?, error` |
| **`sequence_enrollment_jobs`** ★ | one enrollment batch | `id, workspace_id, sequence_id, source json, requested_by, status, total, enrolled, blocked, warned, idempotency_key, created_at, completed_at` |
| **`sequence_enrollment_validation_results`** ★ | per-contact preview result | `id, job_id, contact_id, result (enrollable|blocked|warning), reasons[]` |
| **`sequence_mailboxes`** ★ | mailboxes a sequence rotates | `id, sequence_id, mailbox_id, daily_cap, weight, active` |
| **`email_accounts`** | connected mailboxes | `sendingAccounts` (provider, status, daily limit) |
| **`contacts`** | enrollable target | (CRM spec) |
| **`labels`** / **`label_memberships`** | label sources | (CRM spec delta) |
| **`suppression_entries`** | compliance | `email_suppressions` + `are_suppression_list` |
| **`template_variable_resolution_logs`** ★ | variable resolution per send | `id, membership_id, step_id, variable, resolved (bool), fallback_used, value_hash, resolved_at` |

### 🔧 Velocity mapping & delta
| Canonical | Velocity |
|---|---|
| `sequences` | `sequences` (L475) ✓ |
| `sequence_steps` | JSON `sequences.steps` (+ `sequence_nodes`/`sequence_edges` L1283/1306 for the visual builder) |
| `sequence_memberships` | `enrollments` (L496) — **add** `sender_user_id`, `mailbox_id`, `scheduled_at`, `exit_reason`; expand `status`; **drop** `leadId`/`prospectId` enrollment (Option A) |
| `sequence_membership_steps` | **new** (today only `current_step int`) |
| `sequence_enrollment_jobs` / `_validation_results` | **new** (the preview/enroll job + results) |
| `sequence_mailboxes` | rotation via `senderPools`/`senderPoolMembers` (L2225/2248) — bind pool↔sequence or add table |
| `email_accounts` | `sendingAccounts` (L2134) + `sendingAccountDailyStats` (L2202) |
| `labels` | **new** (CRM-spec delta); lists via `record_lists` |
| `template_variable_resolution_logs` | **new** |

---

## 8. API Endpoints

Canonical REST → tRPC. All validate workspace + permission; mutations audit.

**`POST /api/sequences/{sequenceId}/enrollment/preview`** — validate without enrolling.
- Body: `{ source: {contact_ids?|label_names?|list_ids?|saved_search_id?|csv_import_job_id?}, sender_user_id, mailbox_ids[], start_at?, timezone? }`
- Response: `{ enrollable_count, blocked:[{contact_id, reasons[]}], warnings:[{contact_id, reasons[]}], summary }`. No state change. Errors: `404 sequence`, `422 no_source`, `409 sequence_not_active`. Perm: `sequences.enroll`.

**`POST /api/sequences/{sequenceId}/enroll`** — create memberships.
- Body: `{ source, sender_user_id, mailbox_ids[], rotation?, start_at?, timezone?, confirm_token (from preview), idempotency_key }`
- Response: `{ job_id }`. **Job:** re-validates each (TOCTOU), creates `sequence_memberships` (status `scheduled`), schedules first step. Validation: contacts-only; mailbox connected; per-contact eligibility. Errors: `402`/`403`/`409 duplicate (idempotency)`. Perm: `sequences.enroll` + `send`. Async: job.

**`GET /api/sequences/{sequenceId}/enrollment-jobs/{jobId}`** — poll: `{ status, total, enrolled, blocked, warned, results[] }`. Perm: `sequences.read`.

**`POST /api/sequences/{sequenceId}/memberships/status`** — bulk status action.
- Body: `{ membership_ids[], action (pause|resume|stop|remove|mark_finished|retry|move_to_step|unenroll_compliance), step? }` → Response: `{ updated, skipped:[{id, reason}] }`. Validation: transition allowed (§5). Perm: per-action. Audit: per-row + activity.

**`POST /api/sequences/{sequenceId}/memberships/{membershipId}/pause`** — `→ paused`. Errors: `409 invalid_transition`. Perm: `sequences.manage`.
**`…/resume`** — `→ active` (reschedule). **`…/stop`** — `→ stopped`. **`…/remove`** — `→ removed` (soft). **`…/mark-finished`** — `→ finished`.

Each single-membership action: validate transition, apply, audit, emit activity, return `{ membership }`. Errors: `404`, `409 invalid_transition`, `403`.

### 🔧 Velocity mapping & delta
| REST | tRPC |
|---|---|
| preview | **new** `sequences.previewEnrollment` (shared w/ People spec) |
| enroll | extend `sequences` enroll (contacts-only guard, job, rotation) |
| enrollment-jobs/{id} | **new** (job poll) |
| memberships/status + per-action | extend enrollment status ops (today limited pause/resume) |
- Transport delta: public REST + scopes over tRPC; idempotency keys on enroll.

---

## 9. Background Jobs

| Job | Trigger | Work |
|---|---|---|
| **Enrollment validation job** | preview / pre-enroll | run §3 checks, write `sequence_enrollment_validation_results`. |
| **Membership creation job** | enroll confirm | re-validate, insert memberships (`scheduled`), bump `enrolledCount`. |
| **First-step scheduling job** | after creation | compute first `next_action_at` honoring start_at, timezone, send window, skip-weekends. |
| **Step execution job** | `next_action_at` due | resolve variables (log), pick mailbox (rotation), create/send `email_drafts`, advance `current_step`, schedule next; `sent`/`failed`. |
| **Reply detection job** | inbound mail / poll | detect replies → `replied` (if exit-on-reply). |
| **Bounce handling job** | webhook/poll | hard bounce → `bounced` + add suppression. |
| **Unsubscribe handling job** | link click / webhook | → `unsubscribed` + suppression. |
| **Status transition job** | scheduled sweep | apply due transitions (finish at last step, blocked on new suppression, etc.). |

Rotation: step-execution picks the next mailbox from `sequence_mailboxes`/pool by weight + remaining daily cap (`sendingAccountDailyStats`), skipping disconnected/exhausted mailboxes.

### 🔧 Velocity mapping & delta
- A send engine + `email_drafts` + daily stats exist. **Delta:** the explicit job set with per-membership-step tracking, variable-resolution logging, and the rotation picker reading `senderPoolMembers` + daily caps.

---

## 10. Frontend Components

```
SequenceEnrollmentWizard             // the modal/wizard (§2)
├─ SequenceSelector                  // active/published sequences
├─ SenderMailboxSelector             // sender user + connected mailbox
├─ MultiMailboxRotationPanel         // pool + per-mailbox cap/weight
├─ EnrollmentValidationSummary       // enrollable / blocked / warned counts
├─ BlockedContactsTable              // per-contact block reasons
└─ EnrollmentWarningsTable           // per-contact warnings (enroll allowed)
EnrollmentProgressToast              // async enroll job progress
SequenceMembershipTable              // the sequence's Contacts tab: status, step, mailbox, next action
└─ SequenceStatusActionMenu          // pause/resume/stop/remove/finish/retry/move/unenroll
```

State: wizard calls `previewEnrollment` on open + on source/sequence/mailbox change; confirm carries the `confirm_token`; membership table streams status via subscription.

### 🔧 Velocity mapping & delta
- `SequenceEditor` (Editor/Contacts/Activity/Report/Settings tabs) + index exist from last session. **New:** the wizard cluster + `SequenceMembershipTable` (Contacts tab) + `SequenceStatusActionMenu`. Reuse `Shell`/`PageHeader`, `ui/dialog` (`sm:max-w-*`), flex rows `shrink-0`.

---

## 11. Edge Cases

| Case | Handling |
|---|---|
| `contact_ids` and `label_names` both missing | `422 no_source`; wizard confirm disabled. |
| Sequence is paused | enroll blocked (`409 sequence_not_active`); preview shows whole-job block. |
| Mailbox disconnected | block (whole job) if no connected mailbox; rotation skips a disconnected mailbox mid-flight. |
| Selected contacts exceed max batch | enforce cap; over-cap → `422 too_many` or auto-chunk into multiple jobs (configurable); never silent truncate. |
| Partial enrollment success | job reports `{enrolled, blocked[], warned[]}`; enrollable proceed, blocked don't. |
| Labels contain suppressed contacts | suppressed filtered to blocked with reason; rest enroll. |
| Contact replies during validation | re-check at enroll (TOCTOU) → moves to `replied`/excluded; not enrolled. |
| Contact unsubscribes before first send | status `unsubscribed` before send; first-step job skips; no email sent. |
| Sequence edited after validation, before enroll | `confirm_token` carries a sequence version/hash; mismatch → `409 sequence_changed`, re-preview required. |
| User loses permission | re-check at enroll → `403`; job not created. |
| Duplicate membership | active membership for (contact, sequence) → blocked `already_enrolled`; no duplicate row. |

### 🔧 Velocity mapping & delta
- Dedupe + sequence-status partly exist. **Delta:** TOCTOU re-validation, `confirm_token` versioning, batch-cap chunking, and the suppressed-in-label filter.

---

## 12. Acceptance Criteria (Given/When/Then)

**Contacts-only**
- Given a selection containing a raw prospect, When enrolling, Then the prospect is excluded (or auto-saved as a contact first) and only `contact_id`-backed targets enroll.
- Given a list with non-contact members, When enrolling the list, Then non-contacts are reported as skipped and contacts enroll.

**Preview/validation**
- Given a contact with no valid email and an email-step sequence, When preview runs, Then the contact appears in `blocked` with reason `no_valid_email` and is not enrolled.
- Given a suppressed/unsubscribed/hard-bounced contact, When preview runs, Then each is `blocked` with its reason.
- Given a contact already active in the same sequence, When preview runs, Then `blocked: already_enrolled`.

**Enroll**
- Given a valid selection + connected mailbox + confirm_token, When enroll, Then memberships are created `scheduled`, first steps scheduled honoring timezone/send-window, and `enrolledCount` increments.
- Given no connected mailbox, When enroll, Then the whole job is blocked.

**Rotation**
- Given a sequence with a 3-mailbox pool, When steps execute, Then sends rotate across mailboxes by weight, skipping a disconnected or daily-cap-exhausted mailbox.

**Status machine**
- Given an active membership, When "Pause", Then `→ paused` and no steps schedule; When "Resume", Then `→ active` and next step reschedules.
- Given an active membership, When the contact replies (exit-on-reply on), Then `→ replied` automatically and remaining steps don't send.
- Given a `finished` membership, When "Resume", Then `409 invalid_transition` (terminal).
- Given a `failed` membership, When "Retry failed step", Then the step re-executes and `→ active`.

**Idempotency / TOCTOU**
- Given two enroll calls with the same `idempotency_key`, When both sent, Then the second returns the original `job_id`, no duplicate memberships.
- Given the sequence is edited after preview, When enroll with a stale `confirm_token`, Then `409 sequence_changed`.

**Permissions / audit**
- Given a user without `sequences.enroll`, When enroll, Then `403`.
- Given any status action, When applied, Then an `audit_log` + membership activity event are written.

---

## 13. Implementation Checklist

**Data model**
- [ ] Expand `enrollments.status` → 11 states; add `sender_user_id`, `mailbox_id`, `scheduled_at`, `exit_reason`; **guard `leadId`/`prospectId` enrollment off (Option A)** + backfill prospect-targeted rows into contacts.
- [ ] New: `sequence_membership_steps`, `sequence_enrollment_jobs`, `sequence_enrollment_validation_results`, `sequence_mailboxes`, `template_variable_resolution_logs`.
- [ ] Bind rotation: `sequence_mailboxes` ↔ `senderPools`/`senderPoolMembers`.
- [ ] Labels table (CRM-spec delta) for `label_names` sources.
- [ ] Migration in BOTH `drizzle/schema.ts` AND `server/_core/rawMigrations.ts` (next: **0094**).

**Backend (tRPC)**
- [ ] `previewEnrollment` (validation pass → results) + `enroll` (job, contacts-only guard, confirm_token versioning, idempotency).
- [ ] `enrollmentJobs.get`; bulk `memberships.status`; per-membership pause/resume/stop/remove/mark-finished with transition guard.
- [ ] Transition validator (single source of truth for §5); every mutation audits + emits activity; workspace-scoped.

**Workers**
- [ ] Enrollment-validation, membership-creation, first-step-scheduling, step-execution (variable resolution + rotation picker), reply-detection, bounce-handling, unsubscribe-handling, status-transition sweep.
- [ ] Rotation picker reads pool weights + `sendingAccountDailyStats`; skips disconnected/exhausted.

**Validation**
- [ ] §3 checks as composable validators producing typed block/warn; reused by preview + enroll (TOCTOU).
- [ ] `template_variable_resolution_logs` on each send; missing-required → block/warn.

**Compliance**
- [ ] Suppression/unsubscribe/bounce → automatic `blocked`/`unsubscribed`/`bounced` transitions + suppression writes; `unenroll_compliance` action.

**Frontend**
- [ ] `SequenceEnrollmentWizard` cluster (selector, mailbox, rotation, validation summary, blocked/warnings tables), `EnrollmentProgressToast`.
- [ ] `SequenceMembershipTable` (Contacts tab) + `SequenceStatusActionMenu`. Dialogs `sm:max-w-*`.

**Tests**
- [ ] G/W/T from §12.
- [ ] State-machine transition matrix (all legal/illegal transitions).
- [ ] Contacts-only enforcement (no prospect/lead enrollment).
- [ ] Rotation distribution + skip logic; idempotency + TOCTOU + confirm_token versioning.
- [ ] Cross-workspace isolation; partial-success reporting.

---

### Appendix — provenance of functional references
`Apollo Screenshots/03_engage/00_main-page/01_create-sequence` (sequence detail: Editor/Contacts/Activity/Report/Settings tabs, "Add Contacts" enrollment entry, "Activate" draft→active toggle, Workflows, credits counter) grounds the wizard (§2), membership table (§10), and status actions (§6). Layout/UX only; no Apollo brand assets, icons, or protected design reproduced.
