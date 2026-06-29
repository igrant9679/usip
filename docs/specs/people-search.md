# Technical Spec — People Search / Global Prospect Search

> **Component:** People Search (global prospect database search → workspace contact creation)
> **Status:** Design spec (hybrid). Canonical, provider-agnostic design + a **Velocity mapping & delta** callout per section tying it to the real `igrant9679/usip` stack (tRPC v11 + Drizzle/MySQL + Clodura-backed prospect data).
> **Functional reference:** Apollo.io "Find people" (screenshots in `Apollo Screenshots/02_prospect-and-enrich/01_people`). Layout/UX reference only — no Apollo branding, icons, colors, or protected design is reproduced.
> **First in the per-component "technical model of the site" series** — conventions set here (doc location, the canonical-design + Velocity-mapping structure) repeat for later components.

---

## 0. Core technical model (read first)

Two record classes that must never be conflated:

| Concept | Definition | Ownership | Identity |
|---|---|---|---|
| **person** | A global prospect record from the platform-wide database. Exists independent of any workspace. | Platform | `person_id` (global, immutable) |
| **contact** | A workspace-owned saved copy of a person. Created when a workspace saves a person. | Workspace | `contact_id` (per workspace) |

Invariants enforced everywhere:

1. **Global search never auto-exposes email or phone.** Results carry *availability status* (`verified` / `likely` / `unavailable` / `locked`), never raw values.
2. **Email/phone values are revealed only through an enrichment request** — an explicit, permissioned, credit-metered, audited action.
3. **Saving a person creates a contact** (workspace-scoped). Saving does not by itself reveal contact methods.
4. **Sequence enrollment requires a saved `contact_id`** with a deliverable, non-suppressed email. A raw global `person_id` can never be enrolled.
5. **Every read/write is workspace-scoped.** Suppression, CRM-match, list-membership, and saved-status are *workspace overlays* on top of the global person.
6. **Search is anti-scraping hardened:** page caps, max result window, batch caps, per-user/per-workspace rate limits, export entitlement gates, and async jobs for anything bulk.

### 🔧 Velocity mapping & delta (model)
- **person** → `prospects` table (`drizzle/schema.ts` L3177). Velocity flattens person + employment + location + contact-methods into one row, keyed by `cloduraPersonId` (the global provider identity) + `workspaceId`. Today a prospect row is *already workspace-scoped* (it's materialized per workspace from a Clodura search), which differs from a pure global table — see §2 delta.
- **contact** → `contacts` table (L151), linked back from `prospects.linkedContactId`.
- Masked-until-revealed already exists: `prospects.email`/`phone` + `emailRevealedAt`/`phoneRevealedAt`, plus async `clodura_reveal_jobs`.
- **Delta:** Velocity has no separate global/platform DB shared across workspaces; "global people" are fetched per-workspace from Clodura and cached (`clodura_search_cache`). The canonical spec below describes the *target* global/overlay split; the mapping notes show how each piece lands on the current per-workspace materialization.

---

## 1. Functional Purpose

People Search is the **top-of-funnel discovery surface**. A sales rep uses it to find *net-new* prospects who are not yet in their CRM, qualify them against an ICP, and pull the qualified subset into their workspace as contacts they can sequence.

Primary jobs-to-be-done:

1. **Target** — express an ICP as a filter set (titles, seniority, department, geography, company firmographics, technologies, intent/job-posting signals).
2. **Triage** — scan a paginated, sortable result table; judge fit from non-PII signals (title, company, location, seniority, email/phone *availability*).
3. **Preview** — open one person to inspect employment, company insights, scores, and compliance flags before spending anything.
4. **Acquire** — save chosen people as contacts (single or bulk). Saving is the boundary crossing from "global data I'm browsing" to "records I own."
5. **Activate** — after saving, enrich (reveal email/phone), add to a list, assign an owner, and enroll into a sequence — each gated by permission, credits, and compliance.
6. **Persist intent** — save the search so the same ICP can be re-run, and so net-new deltas surface over time.

Design tension the screen must resolve: **maximize discoverability of the global database while minimizing PII exposure and abuse.** Hence masked contact methods, credit-metered reveals, and hard anti-scraping limits.

### 🔧 Velocity mapping & delta
- This is the `/v2/people` page (`client/src/pages/usip/People.tsx`), today wired to `trpc.prospects.list`. The "filter rail is the fulcrum" pattern is already implemented.
- **Delta to reach this spec:** results currently can show `email` directly when present. Target behavior masks it behind availability status + an explicit reveal (§4, §6). "Save as contact" exists conceptually via `linkedContactId` but needs the formal save-from-person flow (§5/§8).

---

## 2. Data Separation Model

Canonical normalized schema. Global tables are platform-wide and read-only to workspaces; workspace tables are owned and writable; overlay tables join the two.

### 2.1 Global (platform-owned, read-only to workspaces)

**`global_people`** — the canonical person.
| Field | Type | Notes |
|---|---|---|
| `person_id` | string PK | Stable global id |
| `first_name`, `last_name`, `full_name` | string | |
| `headline` / `current_title` | string | Denormalized convenience of current employment |
| `current_organization_id` | FK→global_organizations | Nullable (person with no company) |
| `seniority` | enum | owner, c_suite, vp, director, manager, senior, entry, intern |
| `department` | enum | engineering, sales, marketing, finance, hr, operations, it, … |
| `linkedin_url` | string | |
| `hashed_email` | string | Non-reversible hash for matching/suppression without exposing PII |
| `photo_url` | string | |
| `data_confidence` | int 0–100 | Provider confidence |
| `last_refreshed_at` | timestamp | Freshness |
| `is_deleted` | bool | GDPR/erasure tombstone |

**`global_organizations`** — the canonical company.
| Field | Type | Notes |
|---|---|---|
| `organization_id` | string PK | |
| `name`, `primary_domain` | string | |
| `industry`, `keywords[]` | string/array | |
| `employee_count`, `employee_range` | int/enum | |
| `revenue`, `revenue_range` | int/enum | |
| `hq_location_id` | FK→person_locations | |
| `founded_year`, `linkedin_url` | | |

**`person_employments`** — employment history (one current, N past).
`employment_id PK, person_id FK, organization_id FK, title, department, seniority, is_current bool, start_date, end_date`.

**`person_locations`** — normalized geo (reused by person + org HQ).
`location_id PK, raw, city, state, region, country, postal_code, lat, lng`.

**`person_contact_methods`** — the sensitive table. **Never returned by search.**
`contact_method_id PK, person_id FK, type (email|mobile|direct|hq_phone), value (encrypted at rest), status (verified|likely|unverified|invalid), source, last_verified_at`.

**`global_technographics`** — org→technology edges. `organization_id FK, technology (slug), category, detected_at`.

**`global_job_postings`** — hiring signals. `posting_id PK, organization_id FK, title, department, posted_at, location_id, url`.

### 2.2 Workspace (owned, writable)

**`workspace_contacts`** — a saved person.
`contact_id PK, workspace_id, person_id (provenance FK, nullable), account_id FK→workspace_accounts, owner_user_id, first/last/full_name, title, department, seniority, location snapshot, email (only after enrichment), phone (only after enrichment), email_status, stage, custom_fields json, source ('people_search'), created_by, created_at`.

**`workspace_accounts`** — a saved company. `account_id PK, workspace_id, organization_id (provenance FK), name, domain, owner_user_id, …`.

**`saved_searches`** — `id PK, workspace_id, user_id, name, filters json (canonical filter object), notify_on_new bool, cadence, created_at`.

**`search_history`** — `id PK, workspace_id, user_id, filters json, normalized_hash, result_count, executed_at, latency_ms`. Powers "recent searches" + rate-limit accounting.

**`enrichment_requests`** — `id PK, workspace_id, person_id|contact_id, kind (email|phone|email_phone), identifier_set json, status (pending|running|succeeded|partial|failed), credits_consumed, requested_by, requested_at, completed_at, result_summary json, error`.

**`suppression_entries`** — `id PK, workspace_id, scope (global_unsub|workspace|domain|bounce|region|manual), email|hashed_email|domain|region, reason, source, added_by, added_at`.

### 2.3 Becoming a saved contact (the boundary crossing)

```
person (global)
   │  rep clicks "Save as contact"
   ▼
[eligibility check]  ── suppression? region? plan? permission? ──► block w/ reason
   │ ok
   ▼
upsert workspace_accounts  ◄─ from global_organizations (find-or-create by domain)
   │
   ▼
insert workspace_contacts  (person_id provenance, account_id, owner, snapshot fields,
   │                         email/phone left NULL — NOT revealed by saving)
   ▼
contact_id returned  ──►  now eligible for: enrich, list-add, sequence-enroll
```

Saving copies **only non-sensitive snapshot fields**. Email/phone remain `NULL` on the contact until an enrichment request succeeds. CRM-match dedupe runs on save (by `person_id`, `hashed_email`, or `linkedin_url`) to avoid duplicate contacts.

### 🔧 Velocity mapping & delta
| Canonical | Velocity today |
|---|---|
| `global_people` + `person_employments` + `person_locations` + `person_contact_methods` | `prospects` (flat; provider id `cloduraPersonId`; contact methods inline + `email_revealed_at`/`phone_revealed_at`) |
| `global_organizations` + `global_technographics` + `global_job_postings` | No global org table. Company is denormalized on `prospects.company/companyDomain/industry`. `accounts` is workspace-owned. Technographics/job-postings: **new** (provider-sourced) |
| `workspace_contacts` / `workspace_accounts` | `contacts` (L151) / `accounts` (L123) |
| `saved_searches` | `clodura_saved_searches` (L3341) |
| `search_history` | `clodura_search_cache` (L3359, response cache) + `help_search_log`/`places_search_log`. **No** per-user history table yet — add one |
| `enrichment_requests` | `clodura_enrichment_jobs` (L3392, contact-level) + `clodura_reveal_jobs` (prospect-level reveal). `identifier_set` already exists |
| `suppression_entries` | `email_suppressions` (L2110, email-level) + `are_suppression_list` (L3066, email/linkedin/domain, richer reasons incl. `do_not_contact`) |

**Deltas to build:**
1. A real **global/overlay split** OR a documented decision to keep the per-workspace materialization (recommended near-term: keep `prospects` as the per-workspace search cache, add overlay columns for saved/CRM/suppression status rather than a new global DB).
2. `global_organizations`, `global_technographics`, `global_job_postings` as provider-fed tables (or denormalized into the search index, §9).
3. A dedicated `search_history` table (distinct from the response cache).
4. Reconcile the two suppression tables into one eligibility check (§11).

---

## 3. Search Filters

Canonical filter object (single JSON, used by API, saved_searches, and index query builder). All array filters are OR-within / AND-across.

| Filter | Type | Semantics |
|---|---|---|
| `q_keywords` | string | Full-text across name, title, company, keywords |
| `person_titles[]` | string[] | Current title match |
| `include_similar_titles` | bool | Expand titles via synonym/embedding set |
| `person_seniorities[]` | enum[] | owner…intern |
| `person_departments[]` | enum[] | function buckets |
| `person_locations[]` | LocationFilter[] | Contact location: `{region}` or `{address/zip, radius_miles}` |
| `organization_locations[]` | LocationFilter[] | Company HQ location (region or ZIP radius) |
| `q_organization_domains_list[]` | string[] | Target/exclude by company domain |
| `organization_ids[]` | string[] | Specific companies |
| `contact_email_status[]` | enum[] | verified, likely, unavailable, locked (**availability only — not values**) |
| `company_employee_ranges[]` | enum[] | 1-10, 11-50, 51-200, 201-500, 501-1k, 1k-5k, 5k-10k, 10k+ |
| `company_revenue_ranges[]` | enum[] | <1M, 1-10M, 10-50M, 50-100M, 100-500M, 500M-1B, 1B+ |
| `technologies[]` | slug[] | From technographics |
| `job_posting_signals[]` | enum[]/struct | e.g. `hiring_for_department=sales`, `posted_within_days=30` |
| `saved_contact_status` | enum | any, saved, not_saved (workspace overlay) |
| `crm_status` | enum | any, in_crm, not_in_crm (workspace overlay) |
| `suppression_exclusion` | bool | Exclude suppressed (default **true**) |
| `list_membership` | {list_id, in/not_in} | Workspace overlay |
| `owner` | user_id\|unassigned | For already-saved rows |
| `contact_stage[]` | enum[] | For already-saved rows |

Location filters support **Contact vs Account HQ** tabs and **ZIP-radius** (25/50/100/300 mi) or named region — per the reference filter panels.

Filter UX rules: locked/premium filters (e.g. technographics, intent) are visibly gated by plan entitlement (§11); applying a gated filter prompts upgrade rather than silently returning empty.

### 🔧 Velocity mapping & delta
- `prospects.list` already supports server filters `emailStatus/verification/promoted/hasEmail` and client refinement `search/title/company/location/industry/education/tier/seniority/sort` (`People.tsx`). Education filter is real (migration 0092).
- **Deltas:** `include_similar_titles` (needs synonym/embedding expansion), `technologies`, `job_posting_signals`, `company_revenue_ranges`, `organization_locations` (HQ vs contact split), `list_membership`, `crm_status`, and `suppression_exclusion` as a first-class filter. Today filtering is largely client-side over a fetched page; the index design (§9) moves these server-side.

---

## 4. Result Table

Each row is a **person** with workspace overlays. **No raw email/phone ever appears** — only masked availability.

| Column | Source | Display |
|---|---|---|
| Name | person | full name + LinkedIn affordance; click → preview drawer |
| Current title | current employment | text, truncates |
| Company | current org | name + logo affordance + domain link |
| Person location | person_location | city, state, country |
| Company HQ location | org hq_location | city, country |
| Seniority | person | badge |
| Department / function | person | badge |
| Email availability (masked) | contact_methods status | `✓ Verified` / `~ Likely` / `Unavailable` / 🔒`Access email` (no value) |
| Phone availability (masked) | contact_methods status | `Mobile · N credits` / `Unavailable` / 🔒`Access mobile` |
| Company domain | org | `acme.com` |
| Employee count | org | number / range |
| Revenue range | org | range badge |
| Technologies | technographics | chips (+N more) |
| Saved contact status | overlay | `Saved` ✓ / `Save` |
| CRM match | overlay | `In CRM` / `—` |
| Last refreshed | person.last_refreshed_at | relative time |
| Actions | — | row action menu (§5) |

Behaviors: sticky header; per-page checkbox + select-all-on-page + "select all N matches" (drives bulk jobs); column add/remove ("+ Add column"); horizontal scroll for wide column sets; masked cells are **buttons that trigger enrichment**, not values.

### 🔧 Velocity mapping & delta
- Current `People.tsx` columns: Name, Title, Fit, Company, Location, Email, Phone. Already compact/dense (recent scale fixes) and single-line names.
- **Deltas:** add Company HQ, Department, Employee count, Revenue, Technologies, Saved status, CRM match, Last refreshed; convert Email/Phone cells from value-display to **masked availability + reveal button** (`✓ Verified`, `Access email`, `Mobile · N credits`). "Fit" (confidenceScore/tier) is a Velocity-native column to retain.

---

## 5. Row & Bulk Actions

Every action runs the **action contract**: permission → credits → compliance → confirmation (if side-effectful/irreversible/credit-spending) → async dispatch → success/failure state.

| Action | Scope | Permission | Credits | Compliance | Confirm modal | Async | Success | Failure |
|---|---|---|---|---|---|---|---|---|
| **Preview person** | row | `people.read` | none | none (read) | no | sync | drawer opens | toast + retry |
| **Save as contact** | row | `contacts.create` | none | eligibility (suppress/region/plan) | no (cheap, reversible) | sync (or batched) | row → `Saved`; contact_id | "already exists" → link to contact; blocked → reason |
| **Bulk save as contacts** | selection | `contacts.create` + `bulk` | none | eligibility per-row | yes (count) | **job** | progress → "N saved, M skipped" | partial report w/ per-row reasons |
| **Enrich email** | row/contact | `enrichment.email` | yes (email cost) | eligibility | yes if credits>threshold | **job** | value revealed on contact; cell updates | insufficient credits / unavailable / suppressed |
| **Enrich phone** | row/contact | `enrichment.phone` | yes (phone cost) | eligibility | yes | **job** | phone revealed | as above |
| **Enrich email + phone** | row/contact | both | yes (sum) | eligibility | yes | **job** | both revealed (partial allowed) | partial success state |
| **Add to list (after save)** | selection | `lists.write` | none | none | no | sync/job (size) | "Added to {list}" | list not found / perm |
| **Add to sequence (after save + validation)** | selection | `sequences.enroll` | none (enroll) / yes (auto-enrich) | full enrollment eligibility (§11) | **yes (validation modal)** | **job** | "N enrolled, M blocked" | blocked reasons (unsaved/no-email/suppressed/already-enrolled) |
| **Assign owner (after save)** | selection | `contacts.assign` | none | none | no | sync/job | owner set | perm |
| **Export** | selection | `export` **entitlement** | maybe | export limits + compliance | **yes** | **job** | file ready (notification) | over limit / not entitled (§7,§11) |

Hard rule: **Enrich, Add-to-sequence, Assign-owner, and Add-to-list require a saved `contact_id`.** If invoked on an unsaved person, the flow **auto-saves first** (transparently, same eligibility) then proceeds — or, for sequence enroll, surfaces the validation modal listing which rows still need saving.

### 🔧 Velocity mapping & delta
- Save → `contacts.create` (+ find-or-create `accounts`, set `prospects.linkedContactId`).
- Enrich email/phone → `clodura_reveal_jobs` (prospect-level, pre-save reveal exists) and `clodura_enrichment_jobs` (contact-level). Credits already modeled (`credits_consumed`, `daily_budget_cap`).
- Add to list → `recordLists.addMembers` (built last session).
- Add to sequence → `sequences` + `enrollments`; **validation gate is the key delta** (must reject raw prospects, require deliverable email).
- Export → **new**: needs an export entitlement + limit + async job; today no gated export exists.

---

## 6. Enrichment Behavior

**Search never reveals email/phone.** Reveal happens only via an enrichment request, which resolves a person to contact methods using an **identifier set** (more identifiers → higher match confidence, provider waterfall):

```
identifier_set = {
  person_id?, contact_id?,
  first_name?, last_name?, full_name?,
  email?,            // a known/guessed email to verify
  hashed_email?,     // match without exposing PII
  company_domain?,
  linkedin_url?,
  organization_name?
}
```

Flow:
1. Build `identifier_set` from the person/contact.
2. **Eligibility check** (§11) — suppression, region, permission, plan, credits. Block early with a typed reason; **no credits charged on block**.
3. Create `enrichment_request` (status `pending`), enqueue job, return tracking id immediately (async).
4. Worker calls provider waterfall; on hit, **encrypt + store** value on the contact, set status, write field-level history, debit credits (only on success/partial).
5. Emit result: `succeeded` (value revealed), `partial` (email yes / phone no), `failed` (unavailable — typically **no charge**), or `blocked`.

Rules: idempotent per (contact, kind) within a freshness window (don't re-charge for a value revealed <N days ago — return cached). Bulk enrichment fans out one request per contact under a single parent job with a per-workspace daily budget cap. Raw provider responses are retained briefly then purged (`raw_response_purged_at`).

### 🔧 Velocity mapping & delta
- `clodura_enrichment_jobs.identifier_set` already implements the identifier-set concept; `trigger ∈ {manual,bulk,auto_on_create,scheduled}`; `credits_consumed`, `raw_response` + `raw_response_purged_at` already present.
- `clodura_enrichment_settings`: `auto_enrich_on_create`, `daily_budget_cap` (1500 default), `stale_threshold_days` (90) → the freshness/idempotency window and bulk budget cap already exist.
- `clodura_reveal_jobs` handles the pre-save (prospect-level) email|phone reveal with a `tracking_id` (async) — matches step 3.
- **Deltas:** formalize the typed eligibility-block reasons, the "no charge on block/unavailable" guarantee, and encryption-at-rest for revealed values (today `prospects.email` is plaintext varchar).

---

## 7. Pagination & Limit Design

| Control | Value (canonical default) | Purpose |
|---|---|---|
| `page` | 1-based | navigation |
| `per_page` | 25 (max 100) | page size cap |
| **max result window** | 50,000 matches addressable; deep pages beyond ~10k use cursor/`search_after` | anti-scrape + index health |
| total count | exact ≤10k, else `10,000+` estimate | avoid full deep counts |
| **batching (large searches)** | server slices result set; "select all N" hydrates ids server-side, never client loops | bulk without scraping page-by-page |
| **saved-search slices** | re-run returns net-new since last run (delta by `person_id` not previously seen) | monitoring |
| **rate limits** | per-user: 60 searches/min, 600/hr; per-workspace: 6,000/hr; reveal: per daily budget cap | abuse control |
| **export limits** | per plan (e.g. 1k/op, 10k/day); requires `export` entitlement; always async + audited | exfiltration control |
| **bulk action jobs** | any selection >X (e.g. 25) or "all matches" → background job w/ progress + partial reporting | resilience |

Anti-scraping posture: results are **availability-masked** (no PII to harvest); deep pagination is windowed; "select all" never returns raw rows to the client (only an opaque selection handle that server-side jobs expand); rate-limit + budget caps are enforced server-side and audited in `search_history`.

### 🔧 Velocity mapping & delta
- `prospects.list` paginates; `clodura_search_cache` (24h) already caps provider hits. `daily_budget_cap` caps reveals.
- **Deltas:** explicit `max result window` + cursor for deep pages, the opaque "select all matches" selection handle (today selection is client-held ids), per-user/workspace search rate limits, and export limits/entitlement (none today).

---

## 8. API Design

Canonical REST contracts. Each maps to a tRPC procedure (mapping note). All require an authenticated workspace context; all validate `workspace_id` server-side; all bulk/credit ops are async.

### `POST /api/search/people`
- **Body:** `{ filters: FilterObject, page, per_page, sort, selection_mode?: "page"|"all" }`
- **Response:** `{ results: PersonRow[], page, per_page, total_estimate, total_is_exact, selection_token?, facets: {…counts}, latency_ms }` — `PersonRow` carries **masked** email/phone status only.
- **Validation:** filter schema (zod); `per_page ≤ 100`; window guard.
- **Errors:** `422 invalid_filters`, `429 rate_limited`, `403 filter_not_entitled`, `504 search_timeout`.
- **Permission:** `people.read`. **Credits:** none. **Async:** no (cached, sync).

### `GET /api/people/{personId}/preview`
- **Response:** `{ person, current_employment, employments[], company_insights, scores, overlays:{saved, crm_match, suppression, lists[]}, contact_methods:{email_status, phone_status} }` — **no raw values**.
- **Errors:** `404 person_not_found`, `410 person_deleted`. **Permission:** `people.read`.

### `POST /api/contacts/save-from-person`
- **Body:** `{ person_id, list_id?, owner_user_id?, account_link?: "auto"|"none" }`
- **Response:** `{ contact_id, account_id?, created: bool, deduped_to?: contact_id }`
- **Validation:** person exists; eligibility (suppression/region/plan). **Errors:** `409 already_exists` (returns existing `contact_id`), `403 suppressed|not_entitled`. **Permission:** `contacts.create`. **Credits:** none. **Async:** sync.

### `POST /api/contacts/bulk-save-from-people`
- **Body:** `{ selection: {mode:"ids", person_ids[]} | {mode:"all", selection_token, filters}, list_id?, owner_user_id? }`
- **Response:** `{ job_id }` → poll/subscribe. **Job result:** `{ saved, skipped:[{person_id, reason}], created_account_ids[] }`.
- **Validation:** selection size vs plan; per-row eligibility in worker. **Permission:** `contacts.create`+`bulk`. **Async:** **job**.

### `POST /api/enrichment/person`
- **Body:** `{ contact_id (required) | person_id, kind: "email"|"phone"|"email_phone", identifier_set? }`
- **Response:** `{ request_id, status:"pending" }`. **Job result:** `{ status, revealed:{email?,phone?}, credits_consumed }`.
- **Validation:** contact exists & owned; eligibility; **credit pre-check** (reserve, debit on success). **Errors:** `402 insufficient_credits`, `403 suppressed|no_permission`, `404`, `409 fresh_value_exists` (returns cached). **Permission:** `enrichment.email`/`.phone`. **Credits:** yes. **Async:** **job**.

### `POST /api/enrichment/bulk-people`
- **Body:** `{ selection, kind }` → **Response:** `{ parent_job_id, estimated_credits }` (confirm modal shows estimate before dispatch). **Job:** one child request per contact under `daily_budget_cap`. **Async:** **job**.

### `POST /api/lists/{listId}/members`
- **Body:** `{ contact_ids[] }` (must be saved contacts). **Response:** `{ added, skipped }`. **Errors:** `404 list`, `422 not_contacts`. **Permission:** `lists.write`.

### `POST /api/sequences/{sequenceId}/enrollment/preview`
- **Body:** `{ selection }` → **Response:** `{ eligible:[contact_id], blocked:[{contact_id|person_id, reason}], summary:{eligible_n, blocked_n} }`. Reasons: `not_saved`, `no_email`, `unverified_email`, `suppressed`, `already_enrolled`, `missing_consent`, `region_blocked`. **No state change.** Drives the validation modal.

### `POST /api/sequences/{sequenceId}/enroll`
- **Body:** `{ contact_ids[], confirm_token (from preview) }`
- **Response:** `{ job_id }`. **Job:** re-validates each, creates `enrollments`. **Validation:** every id is a saved contact with deliverable, non-suppressed email; re-checks eligibility at enroll time (TOCTOU guard). **Errors:** `409 not_eligible` (per-row), `403`. **Permission:** `sequences.enroll`. **Async:** **job**.

### 🔧 Velocity mapping & delta
| REST | tRPC procedure |
|---|---|
| `POST /api/search/people` | `prospects.list` (extend: facets, selection_token, masking) |
| `GET /api/people/{id}/preview` | `prospects.get` + `accountBriefs`/`prospectIntelligence` |
| `POST /api/contacts/save-from-person` | `contacts.create` (new `saveFromProspect` variant; sets `linkedContactId`) |
| `POST /api/contacts/bulk-save-from-people` | new `contacts.bulkSaveFromProspects` (job) |
| `POST /api/enrichment/person` | `prospects.revealEmail/Phone` (→ `clodura_reveal_jobs`) / contact-level `clodura_enrichment_jobs` |
| `POST /api/enrichment/bulk-people` | new bulk enrich (parent job + `daily_budget_cap`) |
| `POST /api/lists/{id}/members` | `recordLists.addMembers` ✓ exists |
| `…/enrollment/preview` | **new** `sequences.previewEnrollment` (validation gate) |
| `…/enroll` | `sequences.*` enroll (add contact-required guard) |

Transport delta: Velocity is tRPC, not REST. These contracts are the *logical* API; implement as procedures with identical request/response shapes. Keep idempotency keys on all job-creating procedures.

---

## 9. Search Index Design

Target: **OpenSearch/Elasticsearch** denormalized "person" document — one doc per person, with current-company, employment, tech, job-posting, and **per-workspace overlay** data folded in so filtering + facets are a single query.

```jsonc
// index: people_v1   (alias: people → people_v1 for zero-downtime reindex)
{
  "person_id": "p_123",
  "full_name": "…", "first_name": "…", "last_name": "…",
  "name_search": "…",                         // analyzed (edge-ngram) for q_keywords
  "current_title": "…", "title_keyword": "…", // keyword for exact, text for similar
  "seniority": "vp", "department": "sales",
  "person_location": { "city","state","region","country","geo": {lat,lng} },
  "hashed_email": "…",                         // matching only; NO raw email/phone in index
  "email_status": "verified|likely|unavailable|locked",
  "phone_status": "available|unavailable|locked",
  "last_refreshed_at": "…", "is_deleted": false,

  "company": {                                 // denormalized current org
    "organization_id":"o_9","name":"…","domain":"acme.com",
    "industry":"…","keywords":["…"],
    "employee_count": 240, "employee_range":"201-500",
    "revenue": 50000000, "revenue_range":"50-100M",
    "hq_location": { "city","country","geo":{lat,lng} }
  },
  "employments": [ {"organization_id","title","department","is_current","start","end"} ],
  "technologies": ["salesforce","aws","segment"],         // from technographics
  "job_postings": [ {"department":"sales","posted_at":"…"} ],

  "workspace_overlays": {                       // nested: one entry per workspace
    "ws_2": { "saved": true, "contact_id": 88, "crm_match": true,
              "suppressed": false, "lists": [12,15], "owner_user_id": 4, "stage":"new" }
  }
}
```

Mapping/query notes:
- `workspace_overlays` is a **nested** field; overlay filters (`saved_contact_status`, `crm_status`, `list_membership`, `suppression_exclusion`, `owner`, `contact_stage`) query `nested(workspace_overlays.ws_{id})`. Keeps one shared person doc while scoping overlays.
- Geo filters use `geo_distance` for ZIP-radius (person vs company HQ).
- `q_keywords` → multi_match across `name_search`, `current_title`, `company.name`, `company.keywords`. `include_similar_titles` → expand via synonym graph / title-embedding terms.
- Facets = aggregations (industry, seniority, department, employee_range, revenue_range, technologies, location) returned with counts.
- Deep paging via `search_after` + PIT; hard `max result window` (index.max_result_window) aligned to §7.
- Reindex strategy: write to `people_v{n+1}`, swap alias; overlay updates are partial `update` by script to avoid reindexing the whole person on every save.

### 🔧 Velocity mapping & delta
- **Velocity has no OpenSearch/ES today.** Search is MySQL `prospects` + provider calls cached in `clodura_search_cache`. Overlays (saved/CRM/suppression/list) are MySQL joins.
- **Interim (no ES):** keep MySQL as source of truth; serve filters/facets via indexed columns + aggregate queries on `prospects` joined to `contacts`/`record_list_members`/suppression tables. Add covering indexes for the hot filters.
- **Target:** introduce `people_v1` as above when result-set scale or facet latency outgrows MySQL. Overlay-as-nested keeps the shared-person model while honoring §0 workspace scoping.

---

## 10. UI Component Architecture

```
PeopleSearchPage                     // route /v2/people; owns filter state, pagination, selection
├─ SearchFilterPanel                 // the fulcrum rail; collapse/expand; "clear all"; entitlement gates
│  └─ FilterGroup (×N)               // titles, seniority, dept, location(Contact|HQ tabs), firmographics,
│                                    //   technologies, job-postings, overlays(saved/CRM/list/owner/stage)
├─ PeopleToolbar                     // saved-view picker, search box, Save-as-search, Sort, Search settings
├─ BulkActionBar                     // appears on selection; save/enrich/list/sequence/owner/export; "select all N"
├─ PeopleResultsTable
│  ├─ column manager ("+ Add column")
│  └─ PeopleResultRow (×N)           // masked email/phone cells = reveal buttons; saved/CRM badges; row menu
├─ PersonPreviewDrawer               // opens on row click; employment, company insights, scores, compliance, overlays
├─ SaveContactModal                  // owner/list/account-link options; dedupe notice
├─ EnrichmentPreviewModal            // identifier set, credit estimate, eligibility result; confirm spend
├─ SequenceEnrollmentValidationModal // eligible vs blocked (with reasons) before enroll; confirm_token
└─ SaveSearchModal                   // name, notify-on-new, cadence
```

State: filter object is URL-serializable (shareable/saveable searches); selection is an opaque token for "all matches" + an id set for "page". Masked cells never hold values in client state. Modals own their own async/job subscriptions and surface partial results.

### 🔧 Velocity mapping & delta
- `People.tsx` already implements `PeopleSearchPage`, `SearchFilterPanel`/`FilterGroup` (filter rail), `PeopleToolbar` (just rebuilt to Apollo parity), `PeopleResultsTable`/`Row`, and a detail/preview panel + a More-filters dialog.
- **New components to add:** `BulkActionBar` (saved-selection actions), `SaveContactModal`, `EnrichmentPreviewModal` (credit estimate), `SequenceEnrollmentValidationModal`, `SaveSearchModal`. Reuse `ui/dialog` (remember `sm:max-w-*`), `Shell`/`PageHeader`/`useAccentColor`.

---

## 11. Compliance & Suppression

A single **eligibility check** runs before **enrich, export, save, and sequence enroll**. It is a pure function `(workspace, actor, target, action) → {allowed, reasons[]}` evaluated server-side; the worker re-checks at execution (TOCTOU). Checks, in order (fail-closed):

1. **Global unsubscribe** — person globally opted out → block enrich/enroll/export.
2. **Workspace suppression** — `suppression_entries(scope=workspace)` by email/hashed_email.
3. **Domain suppression** — competitor/customer/manual domain blocks.
4. **Bounced email suppression** — hard-bounce history blocks enroll/send.
5. **Region restriction** — GDPR/CCPA/region policy (e.g. block phone enrich in restricted regions; require lawful basis).
6. **User permission** — RBAC for the specific action (`enrichment.*`, `export`, `sequences.enroll`, …).
7. **Plan entitlement** — feature gated by plan (technographics, export, intent).
8. **Credit availability** — sufficient balance/budget for credit-metered actions.

Each failed check yields a **typed reason** surfaced in UI (modal/row). Save may be allowed while enroll is blocked (different action → different check set). DNC ("Do Not Call") flags block phone enrichment specifically.

### 🔧 Velocity mapping & delta
- Suppression today: `email_suppressions` (`unsubscribe|bounce|spam_complaint|manual`) + `are_suppression_list` (`unsubscribe|bounce|competitor|existing_customer|manual|do_not_contact`, by email/linkedin/domain).
- **Delta:** unify these behind one `checkEligibility()` used by all four actions; add region rules + global-unsub source; wire DNC → phone-enrich block; map plan entitlement + credit balance (today `daily_budget_cap` exists, no per-plan entitlement table).

---

## 12. Edge Cases

| Case | Handling |
|---|---|
| Too many results | Return windowed total (`10,000+`), prompt to narrow; allow save/enrich only via "select all N" job (still budget-capped). |
| No results | Empty state with AI suggestions / loosen-filters CTA (already in `People.tsx`). |
| Search timeout | `504 search_timeout`; serve last cached page if available; retry affordance; log to `search_history`. |
| Contact already exists | Save returns `409 already_exists` + existing `contact_id`; row shows `Saved`, links to contact (no duplicate). |
| Person has no company | `current_organization_id` null; company columns show `—`; firmographic filters simply don't match. |
| Person changed jobs | `last_refreshed_at` stale → show "may be outdated"; re-enrich updates employment; saved contact keeps snapshot + provenance. |
| Email unavailable | Reveal returns `unavailable` (typically **no charge**); cell shows `Unavailable`; enroll blocked with `no_email`. |
| Phone unavailable | As above; phone-dependent actions blocked. |
| Insufficient credits | `402 insufficient_credits` pre-dispatch; modal shows balance + needed; no job created. |
| Suppressed person | Eligibility blocks with scope reason; save may still be allowed, enrich/enroll/export blocked. |
| Lacks enrichment permission | `403 no_permission`; reveal button disabled w/ tooltip. |
| Unsaved global person → sequence | Validation modal flags `not_saved`; offers "save + enroll"; raw `person_id` never enrolled. |

### 🔧 Velocity mapping & delta
- Empty/loading/error states already exist in `People.tsx`. Deltas are the credit/suppression/validation-driven cases, which depend on §6/§11 landing.

---

## 13. Acceptance Criteria (Given/When/Then)

**Search**
- Given a rep with `people.read`, When they apply `person_titles=["VP Sales"]`, Then results contain only current-title matches and email/phone show **status only, never values**.

**Filtering**
- Given `suppression_exclusion=true` (default), When results render, Then no suppressed person appears.
- Given a plan without technographics, When the rep opens the Technologies filter, Then it's gated with an upgrade prompt (not an empty result).

**Preview**
- Given a result row, When clicked, Then the drawer shows employment, company insights, scores, compliance flags, and overlays — and **no raw email/phone**.

**Saving as contact**
- Given an unsaved person, When "Save as contact", Then a `workspace_contact` is created with `person_id` provenance, email/phone NULL, and the row flips to `Saved`.
- Given a person already saved, When "Save", Then `409 already_exists` and the existing contact is linked (no duplicate).

**Bulk saving**
- Given "select all N matches" of 5,000, When "Bulk save", Then a job processes them, returns `{saved, skipped[reason]}`, and the client never iterates pages to fetch ids.

**Enrichment**
- Given a saved contact + sufficient credits + eligibility pass, When "Enrich email", Then an async request reveals + stores the email, debits credits, writes enrichment history.
- Given an eligibility block, When "Enrich", Then it's rejected pre-charge with a typed reason and **0 credits** consumed.

**Bulk enrichment**
- Given a selection and a daily budget cap, When bulk enrich exceeds the cap, Then it processes up to the cap and reports the remainder as deferred/blocked (no silent truncation).

**Sequence validation**
- Given a mix of saved/unsaved/no-email/suppressed, When enrollment preview runs, Then each is bucketed eligible/blocked with reasons and **no enrollment** is created.
- Given the preview `confirm_token`, When enroll runs, Then only eligible saved contacts are enrolled and each is re-validated at enroll time.

**Compliance blocking**
- Given a globally-unsubscribed person, When enrich/enroll/export, Then all three are blocked while save may proceed.
- Given a DNC flag, When "Enrich phone", Then phone enrichment is blocked specifically.

**Export blocking**
- Given a rep without `export` entitlement, When "Export", Then it's blocked with an entitlement reason.
- Given an export over the plan limit, When dispatched, Then it's capped/blocked and audited.

---

## 14. Implementation Checklist

**Database**
- [ ] Decide global/overlay split vs keep per-workspace `prospects` (recommend: overlay columns + new provider tables, not a new global DB).
- [ ] Add `global_organizations`/technographics/job_postings (or index-only denormalization).
- [ ] Add `search_history` (distinct from `clodura_search_cache`).
- [ ] Add overlay columns/joins for saved/CRM/suppression/list/owner/stage.
- [ ] Encrypt revealed email/phone at rest; add region + DNC fields.
- [ ] Migration in BOTH `drizzle/schema.ts` AND `server/_core/rawMigrations.ts` (next: **0094**).

**Backend (tRPC)**
- [ ] `prospects.list` → masking, facets, selection_token, server-side overlay filters, window guard, rate limits.
- [ ] `contacts.saveFromProspect` + `bulkSaveFromProspects` (job) with dedupe + eligibility.
- [ ] Enrichment: reveal/bulk-reveal with credit reserve→debit, idempotency window, typed blocks.
- [ ] `sequences.previewEnrollment` + enroll guard (contact-required, re-validate at enroll).
- [ ] `checkEligibility()` shared by enrich/export/save/enroll.
- [ ] Export job + entitlement + limits + audit.
- [ ] Every procedure filters by `ctx.workspace.id`; validate caller ids → 404 on cross-workspace.

**Search index**
- [ ] Interim: covering indexes on hot filter columns; aggregate facet queries.
- [ ] Target: `people_v1` mapping, alias swap, nested overlay partial-update, `search_after` deep paging, geo_distance ZIP radius.

**Queue / jobs**
- [ ] Job runner for bulk save / bulk enrich / enroll / export with progress + partial reporting + idempotency keys.
- [ ] Daily budget cap enforcement (reuse `clodura_enrichment_settings.daily_budget_cap`).

**Frontend**
- [ ] Masked email/phone cells = reveal buttons (status only).
- [ ] `BulkActionBar`, `SaveContactModal`, `EnrichmentPreviewModal` (credit estimate), `SequenceEnrollmentValidationModal`, `SaveSearchModal`.
- [ ] Add columns (HQ, dept, employees, revenue, technologies, saved, CRM, refreshed).
- [ ] URL-serializable filter object; opaque selection token; entitlement-gated filters.
- [ ] Dialogs use `sm:max-w-*`; flex rows under shell `shrink-0` (bug classes).

**Compliance**
- [ ] Unify `email_suppressions` + `are_suppression_list` behind one eligibility check; add region + global-unsub + DNC.
- [ ] Plan entitlement table; credit balance source.
- [ ] Audit every enrich/export/enroll/save-block with reason.

**Analytics**
- [ ] Track search latency/volume (`search_history`), save→enrich→enroll funnel, credit spend, block reasons, export volume.

**Test**
- [ ] Given/When/Then suites from §13.
- [ ] Cross-workspace isolation tests (no overlay/PII leakage).
- [ ] Masking tests (no raw email/phone in any search/preview payload).
- [ ] TOCTOU re-validation at enroll/enrich.
- [ ] Rate-limit, budget-cap, and export-limit enforcement.

---

### Appendix — provenance of functional references
`Apollo Screenshots/02_prospect-and-enrich/01_people/00_main_page` (result table + preview drawer with masked email/phone "Access email"/"Access mobile · credits" + DNC compliance note + company insights); `…/01_filters` (Location Contact|Account-HQ tabs, ZIP-radius 25/50/100/300mi, Person-Deleted and email-status filters). Layout/UX only; no Apollo brand assets, icons, or protected design reproduced.
