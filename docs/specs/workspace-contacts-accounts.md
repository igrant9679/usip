# Technical Spec — Workspace Contacts & Accounts

> **Component:** Workspace CRM — saved Contacts (people) and Accounts (companies) owned by a workspace.
> **Status:** Design spec (hybrid). Canonical, provider-agnostic design + a **Velocity mapping & delta** callout per section tying it to the real `igrant9679/usip` stack (tRPC v11 + Drizzle/MySQL).
> **Inverse of the search specs:** this is the **most mature area of the existing codebase** — Velocity already ships a CRM. So mapping callouts lean "*already exists — here's the gap*," and the deltas are concentrated (contact/account stages, labels, `crm_external_ids`, first-class calls, create-time dedupe).
> **Sibling components:** [People Search](people-search.md) and [Organization Search](organization-search.md) — global search is **separate** from this screen. A global person becomes a **contact** here; a global organization becomes an **account** here.
> **Functional reference:** Apollo contact/account records + lists (`Apollo Screenshots/02_prospect-and-enrich/03_lists`, plus the People preview drawer). Layout/UX only — no Apollo branding, icons, colors, or protected design reproduced.

---

## 0. Scope boundary (read first)

- **Contact search searches only saved contacts. Account search searches only saved accounts.** Neither touches the global database. Global people/orgs are searched in the separate search components and *cross the boundary* by being saved (creating a contact/account).
- **Everything here is workspace-owned and writable**, workspace-scoped on every read/write (`ctx.workspace.id`).
- **Creating contacts/accounts supports optional deduplication** (`run_dedupe`). When on and a duplicate is found, return the existing record + reason instead of creating.
- Contacts/accounts carry: owner, stage, labels/lists, custom fields, activity, CRM external IDs, enrichment history, and sequence/deal relationships.

---

## 1. Workspace CRM Concepts

| Concept | Definition |
|---|---|
| **Contact** | A saved person record owned by the workspace. Created by saving a global person, importing, or manual entry. Has identity, contact methods, owner, stage, labels, custom fields, activity, and relationships to accounts/sequences/deals. |
| **Account** | A saved company record owned by the workspace. Created by saving a global org, importing, or manual entry. Has firmographics, owner, stage, labels, custom fields, child contacts, deals, and activity. |
| **Owner** | The workspace user responsible for a record (`owner_user_id`). Drives "my contacts/accounts" views, routing, and permissions. Nullable (unassigned). |
| **Stage** | A workspace-defined lifecycle bucket for a contact (e.g. New → Working → Qualified → Customer) or account (e.g. Target → Engaged → Opportunity → Customer). Defined per workspace as a stage vocabulary; the record holds a `stage_id`. Distinct from **deal** stage (pipeline). |
| **Label / List** | **Label** = a lightweight tag (many-to-many, color) for ad-hoc grouping/segmentation. **List** = an explicit, named, ordered membership collection (static). Both are many-to-many; a record can hold N labels and belong to N lists. |
| **Custom field** | A workspace-admin-defined attribute (text/number/date/bool/select/multiselect/url) on contact or account, with a typed value per record. |
| **CRM external ID** | A mapping of a contact/account to its id in an external CRM (Salesforce/HubSpot/…), enabling sync + dedupe + "In CRM" badges. |
| **Global person link** | Provenance pointer from a contact back to the global `person_id` it was saved from (and the reverse overlay). Enables re-enrichment and "saved" overlays on search. |
| **Global organization link** | Provenance pointer from an account back to the global `organization_id`. Same purpose for companies. |
| **Activity event** | A timestamped record of something that happened on a contact/account (email sent/opened/clicked, call logged, task completed, note added, stage changed, enrichment applied). The timeline is the ordered stream of activity events + audit entries. |

### 🔧 Velocity mapping & delta
- Contact/Account/Owner/Activity/Custom-field/Deal-stage all exist. **Deltas:** contact/account **Stage** (vocab + column — today only `leads`/`opportunities` are staged), **Label** (no tag table; only lists via `record_lists`), **CRM external ID** (none), and the global-link provenance tables (today `prospects.linkedContactId` / `prospects.cloduraOrgId`).

---

## 2. Contact Data Model

Canonical tables (one row per contact unless noted). Workspace-scoped.

| Table | Purpose | Key fields |
|---|---|---|
| **`workspace_contacts`** | the contact | `contact_id PK, workspace_id, account_id?, person_id? (global link), first_name, last_name, full_name, title, company, owner_user_id, stage_id?, email?, phone?, email_status, source, custom_fields, created_by, created_at, updated_at` |
| **`global_people`** | provenance source (read-only) | `person_id PK` (see People Search §2) |
| **`contact_methods`** | N emails/phones per contact | `id PK, contact_id, type (email|mobile|direct|other), value (encrypted), status, is_primary, verified_at, source` |
| **`contact_stages`** | per-workspace stage vocabulary | `id PK, workspace_id, key, label, order, is_terminal` |
| **`contact_labels`** | tag definitions | `id PK, workspace_id, name, color` |
| **`contact_label_memberships`** | M:N contact↔label | `contact_id, label_id, added_by, added_at` |
| **`contact_custom_field_values`** | typed custom values | `id PK, workspace_id, contact_id, field_def_id, value_text/number/date/bool/json` (see §0 decision — Velocity uses JSON) |
| **`contact_account_links`** | contact↔account (M:N, a person can sit at multiple accounts) | `id PK, contact_id, account_id, role, is_primary, created_at` |
| **`sequence_memberships`** | enrollment in sequences | `id PK, contact_id, sequence_id, status (active|paused|finished|bounced|opted_out), current_step, enrolled_at` |
| **`outreach_emails`** | emails sent to the contact | `id PK, contact_id, sequence_id?, direction, subject, status (sent|delivered|opened|clicked|replied|bounced), sent_at, opened_at, clicked_at` |
| **`calls`** | logged calls | `id PK, contact_id, owner_user_id, direction, outcome, duration_s, recording_url?, notes, occurred_at` |
| **`tasks`** | tasks on the contact | `id PK, contact_id?, account_id?, type, title, due_at, status, owner_user_id` |
| **`notes`** | free-text notes | `id PK, contact_id?, account_id?, body, author_id, created_at` |
| **`crm_external_ids`** | external CRM mapping | `id PK, workspace_id, entity_type='contact', entity_id, crm_provider, external_id, last_synced_at` |
| **`enrichment_requests`** | enrichment jobs + history | request: see People Search §2; history: `id PK, contact_id, field_name, old_value, new_value, source, applied_at` |
| **`audit_logs`** | mutation log | `id PK, workspace_id, actor_user_id, action, entity_type, entity_id, before, after, ip, ua, created_at` |

### 🔧 Velocity mapping & delta
| Canonical | Velocity today |
|---|---|
| `workspace_contacts` | `contacts` (L151) — **add `stage_id`, `person_id` provenance, `source`** |
| `global_people` | `prospects` (L3177, `cloduraPersonId`) |
| `contact_methods` | inline `contacts.email`/`phone` + verification cols. N-methods table is a **delta** (today single email/phone) |
| `contact_stages` | **delta** (contacts unstaged; pattern exists via `crm_pipeline_stages`) |
| `contact_labels` / `_memberships` | **delta** (lists exist via `record_lists`/`record_list_members`, L1917/1933; labels new) |
| `contact_custom_field_values` | `custom_field_defs` (L1514) + **values in `contacts.customFields` JSON** (keep JSON; normalized table optional) |
| `contact_account_links` | `contacts.accountId` is **single** FK today → M:N link table is a **delta** (needed for "contact at multiple accounts") |
| `sequence_memberships` | `enrollments` (L496) |
| `outreach_emails` | `email_drafts` (L518) + sending records + `activities` |
| `calls` | **delta** — today `tasks` where `type='call'` (powers `/v2/calls`); promote to first-class or keep as task+activity |
| `tasks` / `notes` | `tasks` (L377) / `crm_notes` (L268) |
| `crm_external_ids` | **delta** (none) |
| `enrichment_requests` + history | `clodura_enrichment_jobs` (L3392) + `contact_enrichment_history` (L3419) ✓ |
| `audit_logs` | `audit_log` (L1000) ✓ (`before`/`after` JSON, actor, entityType/Id) |

---

## 3. Account Data Model

| Table | Purpose | Key fields |
|---|---|---|
| **`workspace_accounts`** | the account | `account_id PK, workspace_id, organization_id? (global link), name, normalized_name, domain, normalized_domain, industry, employee_range, revenue_range, hq_region, phone, raw_address, parent_account_id, owner_user_id, stage_id?, arr, custom_fields, source, created_by, created_at, updated_at` |
| **`global_organizations`** | provenance (read-only) | `organization_id PK` (see Org Search §2) |
| **`account_stages`** | per-workspace stage vocabulary | `id PK, workspace_id, key, label, order, is_terminal` |
| **`account_labels`** / **`account_label_memberships`** | tags + M:N | as contacts |
| **`account_custom_field_values`** | typed custom values | as contacts (Velocity: JSON) |
| **`account_contacts`** | account↔contact (M:N, same as `contact_account_links`) | `account_id, contact_id, role, is_primary` |
| **`deals`** | opportunities under the account | `deal_id PK, account_id, name, stage, value, pipeline_id, owner_user_id, close_date` |
| **`tasks`** / **`notes`** / **`calls`** / **`outreach_emails`** | account-scoped activity | `account_id` FK |
| **`crm_external_ids`** | external CRM mapping | `entity_type='account'` |
| **`enrichment_requests`** | org enrichment jobs | see Org Search §7 |
| **`audit_logs`** | mutation log | shared `audit_log` |

### 🔧 Velocity mapping & delta
| Canonical | Velocity today |
|---|---|
| `workspace_accounts` | `accounts` (L123) — has `domain, industry, employeeBand, revenueBand, region, parentAccountId, ownerUserId, arr, customFields`. **Add `stage_id`, `organization_id` provenance, `normalized_domain/name`, `phone`, `raw_address`, `source`** |
| `account_stages` / `account_labels` | **deltas** (none) |
| `account_contacts` | reverse of `contacts.accountId` (single today) → M:N delta |
| `deals` | `opportunities` (L228) ✓ + `crm_pipeline_stages` + `opportunity_stage_history` |
| `account_custom_field_values` | `custom_field_defs` + `accounts.customFields` JSON |
| `crm_external_ids` | **delta** |
| `audit_logs` | `audit_log` ✓ |

---

## 4. Contact Search Behavior

**Searches only `workspace_contacts`** (never global). Canonical request:

| Param | Type | Semantics |
|---|---|---|
| `q_keywords` | string | full-text across `full_name`, `title`, `company`, `email` |
| `contact_stage_ids[]` | id[] | stage filter |
| `contact_label_ids[]` | id[] | label/list membership |
| `owner_ids[]` | id[]\|unassigned | owner |
| `activity_date` | range | last activity within range |
| `email_opened_date` / `email_clicked_date` | range | engagement windows (from `outreach_emails`) |
| `created_date` / `updated_date` | range | record lifecycle |
| `sort_by_field` | enum | name/company/owner/stage/last_activity/created/updated |
| `sort_ascending` | bool | direction |
| `page` / `per_page` | int | pagination (per_page ≤ 100) |

Response: `{ contacts: ContactRow[], page, per_page, total, facets?:{stage,owner,label counts} }`. Fast (owned data, indexed) — no provider calls, no credits.

### 🔧 Velocity mapping & delta
- `contacts.list` exists. **Deltas:** stage filter (no stage), label filter (labels new), engagement-date filters (join `outreach_emails`/`activities`), facet counts. Add covering indexes on `(workspace_id, owner_user_id)`, `(workspace_id, stage_id)`, `(workspace_id, updated_at)`.

---

## 5. Account Search Behavior

**Searches only `workspace_accounts`.** Canonical request:

| Param | Type | Semantics |
|---|---|---|
| `q_organization_name` | string | name match (also domain) |
| `account_stage_ids[]` | id[] | stage filter |
| `account_label_ids[]` | id[] | label/list membership |
| `owner_ids[]` | id[]\|unassigned | owner |
| `last_activity_date` | range | recency |
| `created_date` / `updated_date` | range | lifecycle |
| `page` / `per_page` | int | pagination |

Response: `{ accounts: AccountRow[], page, per_page, total, facets? }`.

### 🔧 Velocity mapping & delta
- `accounts.list` exists (powers `/v2/companies` saved view & `/accounts`). **Deltas:** stage/label filters + last-activity (join `activities`/`opportunities`). Indexes on owner/stage/updated.

---

## 6. Create / Update Behavior

### 6.1 Contacts
- **Accepted fields:** `first_name, last_name, email, phone, title, company, owner_user_id, stage_id, label_ids[], custom_fields`.
- **`run_dedupe` (optional, default true):** before insert, match against existing contacts:
  1. exact email, 2. normalized email, 3. `person_id` provenance, 4. exact `full_name` + same `account_id`/company.
  - **If matched:** return `{ contact: existing, deduped: true, duplicate_reason }` — **no insert**.
  - **Else:** insert; apply labels/custom fields; write `audit_log(create)`; emit `contact.created` activity.
- **Update (PATCH):** partial; validates stage_id/owner exist; sanitizes email/phone; writes `audit_log(update)` with `before`/`after`; emits `stage_changed`/`owner_changed` activity events as applicable.

### 6.2 Accounts
- **Accepted fields:** `name, domain, owner_user_id, stage_id, phone, raw_address, custom_fields`.
- **Sanitization:** phone → E.164 normalize; **domain → strip protocol + `www.` + path, lowercase** → `normalized_domain`; `name → normalized_name` (lowercase, strip legal suffixes/punct).
- **`run_dedupe` (optional, default true):** waterfall (see Org Search §8): 1. domain, 2. normalized_domain (across all known domains), 3. CRM external id, 4. exact normalized_name, 5. fuzzy name + HQ region (→ possible-duplicate prompt, no silent merge).
  - **If matched:** return existing + reason. **Else:** insert + audit + `account.created` activity.
- **Update (PATCH):** partial; re-sanitize domain/phone on change; audit before/after.

### 🔧 Velocity mapping & delta
- Contact/account create/update exist (`contacts.create/update`, `accounts.create/update`). **Deltas:** formal `run_dedupe` option + typed `duplicate_reason`, domain/name normalization columns, phone E.164 sanitization, and emitting stage/owner-change activity events. Account dedupe waterfall is shared with the Org spec.

---

## 7. API Endpoints

Canonical REST → tRPC procedures. All validate `workspace_id`; all mutations write `audit_log`.

### Contacts

**`POST /api/contacts`** — create.
- Body: `{ first_name, last_name, email?, phone?, title?, company?, owner_user_id?, stage_id?, label_ids?[], custom_fields?, run_dedupe?=true }`
- Response: `{ contact, created: bool, deduped?: bool, duplicate_reason? }`
- Validation: name required; email/phone format; stage/owner exist. Perm: `contacts.create`. Errors: `409 duplicate` (returns existing), `422`. Audit: `create`.

**`POST /api/contacts/bulk`** — create many.
- Body: `{ contacts: ContactInput[], run_dedupe?=true }` → Response: `{ job_id }` (async). Job result: `{ created, deduped:[{input_index, contact_id, reason}], failed:[{input_index, error}] }`. Perm: `contacts.create`+`bulk`. **Partial success reported, never silent.** Audit: per-row `create`.

**`GET /api/contacts/{contactId}`** — full record + relations (methods, labels, custom fields, owner, stage, account links, sequences, deals, crm ids). Perm: `contacts.read`. Error: `404`.

**`PATCH /api/contacts/{contactId}`** — partial update. Body: any subset of editable fields. Response: `{ contact }`. Validation: referenced ids exist; sanitize. Perm: `contacts.update`. Errors: `404`, `422`. Audit: `update` (before/after).

**`POST /api/contacts/search`** — §4 request/response. Perm: `contacts.read`. No audit (read).

**`POST /api/contacts/{contactId}/merge`** — merge duplicate into survivor.
- Body: `{ merge_from_contact_id }` → Response: `{ survivor_contact_id, merged_fields, moved:{activities,tasks,notes,sequences,deals} }`. Validation: both exist, same workspace, not same id. Re-parents all child records to survivor, tombstones the loser, records provenance. Perm: `contacts.merge`. Errors: `404`, `409 already_merged`. Audit: `update` (merge) on both.

**`POST /api/contacts/update-stage`** — bulk stage set. Body: `{ contact_ids[], stage_id }` → Response: `{ updated, skipped:[{id,reason}] }`. Validation: stage exists. Perm: `contacts.update`. Audit: per-row `update` + `stage_changed` activity.

**`POST /api/contacts/update-owner`** — bulk owner set. Body: `{ contact_ids[], owner_user_id|null }` → Response: `{ updated, skipped }`. Validation: owner is workspace member. Perm: `contacts.assign`. Audit: per-row + `owner_changed`.

### Accounts

**`POST /api/accounts`** — create. Body: `{ name, domain?, owner_user_id?, stage_id?, phone?, raw_address?, custom_fields?, run_dedupe?=true }` → Response: `{ account, created, deduped?, duplicate_reason?, matched_by? }`. Validation: name required; domain/phone sanitized. Perm: `accounts.create`. Errors: `409 duplicate`, `422`. Audit: `create`.

**`POST /api/accounts/bulk`** — async create many → `{ job_id }`; result `{ created, deduped[], failed[] }`. Perm: `accounts.create`+`bulk`. Audit: per-row.

**`GET /api/accounts/{accountId}`** — full record + relations (contacts, deals, labels, custom fields, owner, stage, crm ids, activity summary). Perm: `accounts.read`. Error: `404`.

**`PATCH /api/accounts/{accountId}`** — partial update (re-sanitize domain/phone). Perm: `accounts.update`. Errors: `404`,`422`. Audit: `update`.

**`POST /api/accounts/search`** — §5. Perm: `accounts.read`.

**`POST /api/accounts/update-stage`** — bulk stage. Body: `{ account_ids[], stage_id }` → `{ updated, skipped }`. Perm: `accounts.update`. Audit + `stage_changed`.

**`POST /api/accounts/update-owner`** — bulk owner. Body: `{ account_ids[], owner_user_id|null }` → `{ updated, skipped }`. Perm: `accounts.assign`. Audit + `owner_changed`.

### 🔧 Velocity mapping & delta
| REST | tRPC |
|---|---|
| contacts create/get/patch/search | `contacts.create/get/update/list` ✓ |
| `contacts/bulk` | `imports`/`contactImports` (L1742) partially; formal bulk-create job is a delta |
| `contacts/{id}/merge` | **delta** (no merge today) |
| contacts update-stage/owner | `contacts.update` ✓ (stage needs the new column) |
| accounts create/get/patch/search | `accounts.create/get/update/list` ✓ |
| accounts update-stage/owner | `accounts.update` ✓ (stage delta) |

All map cleanly to tRPC procedures with identical shapes; add idempotency keys to bulk/job-creating procedures.

---

## 8. Profile Pages

### `ContactProfilePage`
Sections (all sourced from §2 tables):
- **Identity** — name, title, company, photo, primary email/phone (decrypted on demand, permissioned).
- **Ownership** — owner (assignable inline).
- **Stage** — current stage (changeable inline) + stage history.
- **Labels** — chips (add/remove).
- **Enrichment history** — field-level changes from `contact_enrichment_history` (what changed, source, when).
- **Source attribution** — origin (saved from global person, imported, manual) + `person_id` provenance link.
- **Contact methods** — all emails/phones + verification status; reveal/enrich affordance.
- **CRM sync** — `crm_external_ids` (provider, external id, last synced) + "In CRM" + push/pull affordance.
- **Timeline** — merged stream of activity events + audit entries (emails, opens/clicks, calls, tasks, notes, stage/owner changes, enrichment), reverse-chron, filterable by type.
- **Tasks** — open/done tasks; create inline.
- **Notes** — threaded notes; add inline.
- **Sequences** — enrollments + status + step; enroll/pause/remove (enroll requires deliverable email — see People Search §11).
- **Deals** — opportunities the contact is a role on.
- **Audit history** — raw mutation log (before/after) for admins.

### `AccountProfilePage`
- **Identity** — name, domain, industry, size/revenue, HQ, logo.
- **Ownership / Stage / Labels** — as contact.
- **Enrichment history / Source attribution** — org provenance (`organization_id`) + firmographic refresh history.
- **CRM sync** — account `crm_external_ids`.
- **Timeline** — account-level activity (across its contacts + deals).
- **Contacts** — `AccountContactsTable` (people at this account; add/remove; "find more people" → People Search filtered to org).
- **Deals** — `AccountDealsPanel` (open/won/lost, value, stage, next step).
- **Tasks / Notes** — account-scoped.
- **Audit history**.

### 🔧 Velocity mapping & delta
- Existing `/accounts/:id` and contact detail surfaces cover much of this (activities, tasks, notes, opportunities, enrichment history). **Deltas:** stage section + history, labels, `crm_external_ids` sync panel, raw audit panel, and the M:N account↔contact (today single FK).

---

## 9. UI Component Architecture

```
ContactsPage                         // route /v2/people? No — saved contacts view (CRM)
├─ ContactsTable                     // saved-contact rows; stage/owner/label cols; bulk bar
└─ ContactProfilePage                // /contacts/:id
   ├─ ContactHeader                  // identity, owner, stage, labels (inline-editable)
   ├─ ContactTimeline                // merged activity + audit stream
   ├─ ContactEnrichmentPanel         // methods + enrichment history + reveal/enrich
   └─ ContactCRMPanel                // crm_external_ids + sync status/actions

AccountsPage                         // saved accounts view (CRM)
├─ AccountsTable                     // saved-account rows; stage/owner/label cols; bulk bar
└─ AccountProfilePage                // /accounts/:id
   ├─ AccountHeader                  // identity, owner, stage, labels
   ├─ AccountContactsTable           // people at this account (M:N) + find-more
   └─ AccountDealsPanel              // opportunities + create-deal
```

Shared: `BulkActionBar` (stage/owner/label/export), inline editors (owner picker, stage picker, label chips), custom-field renderer (driven by `custom_field_defs`). State: search filters URL-serializable; profile tabs lazy-loaded.

### 🔧 Velocity mapping & delta
- `accounts`/`contacts` list + detail pages exist; `Companies.tsx`/`People.tsx` are the search variants (global), distinct from these **saved-CRM** views.
- **New/relabeled:** dedicated saved `ContactsTable`/`AccountsTable` (vs the global search tables), `ContactTimeline` (merge activity+audit), `ContactCRMPanel`, stage/label inline editors. Reuse `Shell`/`PageHeader`/`useAccentColor`, `ui/dialog` (`sm:max-w-*`), custom-field defs.

---

## 10. Edge Cases

| Case | Handling |
|---|---|
| Duplicate contact | `run_dedupe` returns existing + `duplicate_reason`; UI offers "open existing" or "create anyway" (force flag). |
| Duplicate account | Dedupe waterfall (§6.2); confident match returns existing; fuzzy → possible-duplicate prompt. |
| Contact linked to multiple accounts | `contact_account_links` M:N; one marked `is_primary`; profile shows all; account profile lists the contact under each. |
| Missing account | Contact with null `account_id`/no links → "No account" state; firmographic-derived fields blank; can link later. |
| Contact has stale company | `company` snapshot ≠ current employment; show "may be outdated" + re-enrich; keep snapshot + provenance. |
| Account has no domain | Allowed; dedupe falls to name+region (fuzzy); domain-dependent enrich limited; `normalized_domain` null. |
| CRM external ID conflict | Two records claim same `external_id` → block + surface conflict; require manual resolution; never silently overwrite mapping. |
| Stage deleted | Records referencing a deleted stage fall back to `stage_id=null` ("No stage") or a migrated default; stage filter excludes; no orphan crash. |
| Owner removed | `owner_user_id` of a deactivated user → record shows "Unassigned (was {name})"; bulk-reassign affordance; routing skips. |
| Custom field deleted | `custom_field_defs` removal hides the field; stored JSON value retained but not rendered (recoverable if def restored). |
| User lacks permission | `403` with required-permission reason; inline editors disabled w/ tooltip. |
| Partial bulk update success | Job returns `{updated, skipped:[{id,reason}], failed:[...]}`; **no silent truncation**; per-row reasons. |

### 🔧 Velocity mapping & delta
- Owner-removed/custom-field-deleted partially handled (deactivation + def-driven rendering). **Deltas:** stage-deleted fallback (stages new), CRM-id conflict, M:N multi-account, formal merge.

---

## 11. Acceptance Criteria (Given/When/Then)

**Contact create + dedupe**
- Given `run_dedupe=true` and an existing contact with the same email, When `POST /api/contacts`, Then the existing contact is returned with `deduped=true` + `duplicate_reason="email"` and **no new row** is created.
- Given no match, When create, Then a new contact is inserted, labels/custom fields applied, and an `audit_log(create)` row is written.

**Account create + sanitize + dedupe**
- Given `domain="https://www.Acme.com/about"`, When create, Then `normalized_domain="acme.com"` and dedupe matches an existing `acme.com` account → existing returned with `matched_by="normalized_domain"`.
- Given `phone="(415) 555-0100"`, When create, Then it's stored E.164-normalized.

**Search isolation**
- Given a workspace, When `POST /api/contacts/search`, Then only saved `workspace_contacts` are returned — never global people.
- Given `account_stage_ids=[X]`, When account search, Then only accounts in stage X return.

**Update stage/owner (bulk)**
- Given 50 selected contacts, When `update-stage`, Then all valid ones move stage, each emits a `stage_changed` activity + `audit_log(update)`, and any invalid id is reported in `skipped`.
- Given a non-member `owner_user_id`, When `update-owner`, Then it's rejected with `422` and no change.

**Merge**
- Given two duplicate contacts, When `merge`, Then activities/tasks/notes/sequences/deals re-parent to the survivor, the loser is tombstoned, and both get an audit entry.

**Profile**
- Given a contact profile, When loaded, Then identity, owner, stage, labels, enrichment history, source attribution, contact methods, CRM sync, timeline, tasks, notes, sequences, deals, and audit history all render from their tables.

**Edge / permissions**
- Given a deleted stage, When viewing affected records, Then they show "No stage" and the app does not error.
- Given a user without `contacts.update`, When editing, Then inline editors are disabled and the API returns `403`.

**Audit**
- Given any create/update/merge/stage/owner change, When it succeeds, Then an `audit_log` row with actor, action, before/after exists.

---

## 12. Implementation Checklist

**Database**
- [ ] Add `stage_id` to `contacts` + `accounts`; create `contact_stages` / `account_stages` vocab tables.
- [ ] `contact_labels` / `account_labels` + `*_label_memberships` (M:N).
- [ ] `contact_account_links` / `account_contacts` (M:N) — migrate `contacts.accountId` to a link + keep a primary.
- [ ] `crm_external_ids` (entity_type, provider, external_id, unique per provider+entity).
- [ ] `normalized_domain` + `normalized_name` columns on `accounts` (+ indexes); `person_id`/`organization_id` provenance columns.
- [ ] Decide `calls` first-class vs `tasks(type='call')`; `contact_methods` N-table vs inline (keep inline near-term).
- [ ] Keep custom-field **values in JSON** (`custom_field_defs` drives schema); add normalized values table only if indexed per-value querying is required.
- [ ] Search indexes: `(ws, owner)`, `(ws, stage)`, `(ws, updated_at)`, `(ws, normalized_domain)`.
- [ ] Migration in BOTH `drizzle/schema.ts` AND `server/_core/rawMigrations.ts` (next: **0094**).

**Backend (tRPC)**
- [ ] `run_dedupe` + typed `duplicate_reason` on `contacts.create` / `accounts.create`; phone/domain/name sanitization.
- [ ] `contacts.bulk` / `accounts.bulk` async jobs with partial-success reporting.
- [ ] `contacts.merge` (re-parent children, tombstone, provenance).
- [ ] Bulk `update-stage` / `update-owner` (validate refs, skip-with-reason).
- [ ] Stage/label filters + engagement-date joins in `contacts.list` / `accounts.list`.
- [ ] Every mutation writes `audit_log` (before/after) and emits activity events; every query filters by `ctx.workspace.id`; validate caller ids → 404 cross-workspace.

**Frontend**
- [ ] Saved `ContactsTable` / `AccountsTable` (distinct from global search tables) with stage/owner/label columns + `BulkActionBar`.
- [ ] `ContactProfilePage` (Header, Timeline, EnrichmentPanel, CRMPanel) + `AccountProfilePage` (Header, ContactsTable, DealsPanel).
- [ ] Inline editors (owner/stage pickers, label chips), custom-field renderer from `custom_field_defs`.
- [ ] Merge UI + possible-duplicate prompt. Dialogs `sm:max-w-*`; shell flex rows `shrink-0`.

**Queue / workers**
- [ ] Bulk create/update jobs; merge re-parenting job for large records; idempotency keys.

**Audit logging**
- [ ] Centralize via a single `writeAudit(entityType, action, before, after)` helper used by all mutations (reuse `audit_log` L1000).

**Permissions**
- [ ] RBAC: `contacts.*` / `accounts.*` (read/create/update/assign/merge/delete) + workspace scoping; inline-editor gating mirrors API perms.

**Tests**
- [ ] Given/When/Then suites from §11.
- [ ] Dedupe matrices (contact: email/normalized/person_id/name+account; account: domain/normalized/crm/name/fuzzy).
- [ ] Search isolation (saved-only; no global leakage) + cross-workspace isolation.
- [ ] Merge integrity (no orphaned children, no double-count).
- [ ] Audit completeness (every mutation logged); stage-deleted/owner-removed/custom-field-deleted resilience.

---

### Appendix — provenance of functional references
Apollo saved contact/account records + lists (`Apollo Screenshots/02_prospect-and-enrich/03_lists`) and the People preview drawer (identity, contact methods, scores, company insights, source) ground the profile-page layout (§8) and table/timeline structure. Layout/UX only; no Apollo brand assets, icons, or protected design reproduced.
