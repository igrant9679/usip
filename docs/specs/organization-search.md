# Technical Spec — Organization Search / Company Prospecting

> **Component:** Organization Search (global company database search → workspace account creation)
> **Status:** Design spec (hybrid). Canonical, provider-agnostic design + a **Velocity mapping & delta** callout per section tying it to the real `igrant9679/usip` stack (tRPC v11 + Drizzle/MySQL + Clodura-backed data).
> **Functional reference:** Apollo.io "Find companies" (`Apollo Screenshots/02_prospect-and-enrich/02_companies`). Layout/UX reference only — no Apollo branding, icons, colors, or protected design reproduced.
> **Sibling component:** [People Search](people-search.md) — shares the global-vs-workspace separation, credit/suppression model, and the save-then-act boundary. Org search **feeds** People search via "Find people at organization."

---

## 0. Core technical model (read first)

| Concept | Definition | Ownership | Identity |
|---|---|---|---|
| **organization** | A global company record from the platform-wide database. Exists independent of any workspace. | Platform | `organization_id` (global, immutable) |
| **account** | A workspace-owned saved company. Created when a workspace saves an organization. | Workspace | `account_id` (per workspace) |

Invariants:

1. **Organization search is separate from saved-account search.** This screen browses the *global* company DB; the Accounts/CRM screen browses *owned* accounts. They share columns but never the same query.
2. **Org search can consume credits** depending on plan and data access. Advanced filters (revenue, funding, technographics, job postings, lookalikes) are **plan-entitlement gated**; running them and enriching can debit credits.
3. **Saving an organization creates an account** (workspace-scoped, with `organization_id` provenance), running **dedupe** (§8) to avoid duplicates.
4. **Org data is firmographic, not PII** — so unlike People, columns are not masked. The sensitive boundary here is *credits + entitlement + suppression*, not PII reveal.
5. **Every read/write is workspace-scoped.** Saved-status, CRM-match, owner, stage, label/list membership, and suppression are **workspace overlays** on the global org.
6. **Anti-abuse:** page caps, max result window, batch caps, per-user/workspace rate limits, export entitlement, credit ledger, and async jobs for bulk.

### 🔧 Velocity mapping & delta (model)
- **organization** → no global org table today. Company data is denormalized on `prospects` (`cloduraOrgId`, `company`, `companyDomain`, `industry`) and materialized per-workspace. Org search currently reuses `accounts` (the `/v2/companies` page reads `trpc.accounts.list`).
- **account** → `accounts` table (`drizzle/schema.ts` L123): `name, domain, industry, employeeBand, revenueBand, region, parentAccountId, territoryId, ownerUserId, arr, color, notes, customFields`.
- **Delta:** introduce a global org source (provider-fed `global_organizations` or an org search index, §12) distinct from `accounts`; add the workspace-overlay join. Near-term, mirror the People approach: a per-workspace org search cache + overlay columns rather than a brand-new global DB.

---

## 1. Functional Purpose

Organization Search is the **account-based prospecting** entry point. Where People Search starts from individuals, this screen starts from **companies that match an ICP**, then drills into the right people inside them.

Jobs-to-be-done:

1. **Build a target account list** — express firmographic ICP (industry, size, revenue, geography, technologies used, funding stage, hiring activity).
2. **Qualify accounts** — scan firmographics + buying signals (funding raised, hiring surges, tech stack) to prioritize.
3. **Preview** — inspect one company's profile, job postings, funding history, and recommended-people count before committing.
4. **Acquire** — save matching organizations as accounts (single/bulk), with dedupe against existing accounts and CRM.
5. **Activate ABM motion** — assign owner + stage, create a deal, and **"Find people at organization"** to pull buying-committee contacts (hands off to People Search filtered to that org).
6. **Govern** — suppress domains (competitors/customers/do-not-contact), respect plan entitlement + credit budget, and export only when permitted.

The screen answers: *"Which companies should we go after, and who do we talk to inside them?"* — the top of an ABM funnel that converts global firmographic data into owned accounts with active deals.

### 🔧 Velocity mapping & delta
- This is `/v2/companies` (`client/src/pages/usip/Companies.tsx`), today on `trpc.accounts.list` with client-side facets (Industry / # Employees / Revenue / Location), deep-linking to `/accounts/:id`.
- **Delta:** split "global org search" from "saved account search." Today there is only the saved-account view; org-search-over-a-global-DB is the new capability.

---

## 2. Data Separation Model

### 2.1 Global (platform-owned, read-only to workspaces)

**`global_organizations`** — canonical company.
`organization_id PK, name, normalized_name, primary_domain, linkedin_url, industry, keywords[], sic_codes[], naics_codes[], employee_count, employee_range, revenue, revenue_range, currency, founded_year, hq_location_id FK, description, logo_url, data_confidence, last_refreshed_at, is_deleted`.

**`organization_domains`** — a company can own many domains.
`id PK, organization_id FK, domain, normalized_domain (no www/scheme), is_primary bool, type (primary|redirect|brand|subsidiary), verified_at`.

**`organization_locations`** — HQ + offices.
`location_id PK, organization_id FK, kind (hq|office), raw, city, state, region, country, postal_code, geo{lat,lng}`.

**`organization_technologies`** — technographic edges.
`id PK, organization_id FK, technology_uid, name, category, first_detected_at, last_detected_at`.

**`organization_job_postings`** — hiring signals.
`posting_id PK, organization_id FK, title, department, location_id FK, source, url, posted_at, captured_at, is_active`.

**`organization_funding_events`** — funding history.
`event_id PK, organization_id FK, round (seed|a|b|…|ipo|debt), amount, currency, announced_at, investors[], source_url`.

### 2.2 Workspace (owned, writable)

**`workspace_accounts`** — a saved company. `account_id PK, workspace_id, organization_id (provenance, nullable), name, domain, industry, employee_range, revenue_range, hq_region, parent_account_id, owner_user_id, stage, arr, custom_fields, source ('org_search'), created_by, created_at`.

**`workspace_contacts`** — people saved under an account (`account_id` FK). (See [People Search](people-search.md) §2.)

**`crm_external_ids`** — maps an account/contact to external CRM ids. `id PK, workspace_id, entity_type (account|contact), entity_id, crm_provider (salesforce|hubspot|…), external_id, last_synced_at`. Drives CRM-match overlay + dedupe (§8).

**`account_stages`** — workspace-defined stage vocabulary. `id PK, workspace_id, key, label, order, is_won, is_lost`.

**`account_labels`** — tags applied to accounts. `id PK, workspace_id, name, color`; join `account_label_assignments(account_id, label_id)`.

**`suppression_entries`** — domain-aware suppression. `id PK, workspace_id, scope (domain|global_unsub|workspace|manual), domain|email|hashed_email, reason (competitor|existing_customer|do_not_contact|bounce|manual), source, added_by, added_at`.

### 2.3 Becoming a saved account (the boundary crossing)

```
organization (global)
   │  rep clicks "Save as account"
   ▼
[dedupe §8]  ── existing account by domain/name/linkedin/crm_id? ──► return existing (409)
   │ none
   ▼
[eligibility §11/people-search] ── domain suppressed? plan? permission? ──► block w/ reason
   │ ok
   ▼
insert workspace_accounts  (organization_id provenance, snapshot firmographics,
   │                         owner?, stage?, parent link if known)
   ▼
account_id returned  ──►  now eligible for: enrich, find-people, list-add, owner, stage, deal, export
```

Saving copies firmographic snapshot fields + provenance. No credits charged for save itself (enrich/advanced-data is separate).

### 🔧 Velocity mapping & delta
| Canonical | Velocity today |
|---|---|
| `global_organizations` + domains/locations/technologies/job_postings/funding | **None** — firmographics denormalized on `prospects`; no org tables. All six are new (provider-fed or index-only, §12) |
| `workspace_accounts` | `accounts` (L123): has `domain, industry, employeeBand, revenueBand, region, parentAccountId, territoryId, ownerUserId, arr, customFields` |
| `workspace_contacts` | `contacts` (L151) with `accountId` |
| `crm_external_ids` | **None** — needs a mapping table (integrations exist but no per-entity external-id store) |
| `account_stages` | Not on `accounts`; deal stages live on `opportunities.stage` + `crm_pipeline_stages` (L304). Account-level stage is a **delta** (add column or derive) |
| `account_labels` | No tags table; `record_lists`/`record_list_members` (L1917/L1933) cover list membership; `accounts.color` is a single color. Labels = delta |
| `suppression_entries` | `are_suppression_list` (L3066) **already has `companyDomain`** + reasons `competitor|existing_customer|do_not_contact|…` — maps directly to domain suppression; `email_suppressions` (L2110) for email |

---

## 3. Search Filters

Canonical filter object (JSON; shared by API, saved searches, index query builder).

| Filter | Type | Semantics |
|---|---|---|
| `company_name` | string | name match (analyzed + keyword) |
| `q_organization_domains_list[]` | string[] | include by domain (normalized) |
| `organization_num_employees_ranges[]` | enum[] | 1-10, 11-50, 51-200, 201-500, 501-1k, 1k-5k, 5k-10k, 10k+ |
| `organization_locations[]` | LocationFilter[] | HQ region or ZIP-radius (include) |
| `organization_not_locations[]` | LocationFilter[] | HQ location **exclude** |
| `revenue_range[min]` / `[max]` | number | revenue bounds (entitlement-gated) |
| `currently_using_any_of_technology_uids[]` | uid[] | technographics (entitlement-gated) |
| `organization_ids[]` | string[] | specific companies |
| `latest_funding_amount_range[min]` / `[max]` | number | most-recent round size (entitlement-gated) |
| `job_posting_count` | {min,max} | active postings count (hiring intensity) |
| `hiring_department` | enum[] | e.g. hiring in sales/eng/marketing |
| `saved_account_status` | enum | any, saved, not_saved (overlay) |
| `crm_account_match` | enum | any, in_crm, not_in_crm (overlay) |
| `owner` | user_id\|unassigned | for already-saved (overlay) |
| `account_stage[]` | enum[] | for already-saved (overlay) |
| `label_or_list_membership` | {label_id?\|list_id?, in/not_in} | overlay |
| `suppressed_domain_exclusion` | bool | exclude suppressed domains (default **true**) |

Entitlement rule: Revenue, Funding, Technologies, Job Postings, and Lookalikes are **plan-gated** — surfaced but locked, with an upgrade prompt rather than a silent empty result (matches the reference "Unlock advanced filters … View plans").

### 🔧 Velocity mapping & delta
- `accounts.list` powers `/v2/companies` with client-side facets (Industry/#Employees/Revenue/Location). Filtering is largely client-side over a fetched page.
- **Deltas:** server-side filters; `organization_not_locations`, technographics, funding, job-posting-count, hiring-department, overlay filters (saved/CRM/owner/stage/label), and `suppressed_domain_exclusion`; plan-gating wired to an entitlement source. SIC/NAICS + Market Segments + Buying Intent exist in the reference and are candidate additions.

---

## 4. Result Table

Each row is an **organization** with workspace overlays. Firmographic values are shown directly (not PII); advanced-data columns may be entitlement/credit gated.

| Column | Source | Display |
|---|---|---|
| Company name | org | name + logo affordance; click → preview drawer |
| Domain | org primary domain | `acme.com` link |
| Industry | org | badge |
| Employee count | org | number / range |
| Revenue | org | range badge (gated) |
| HQ location | org hq location | city, country |
| Technologies | technographics | chips (+N) (gated) |
| Funding signal | latest funding event | `Series B · $40M · 3mo ago` (gated) |
| Hiring signal | active job postings | `Hiring · 12 roles` / `Hiring Sales` |
| Saved account status | overlay | `Saved` ✓ / `Save` |
| CRM match status | overlay | `In CRM` / `—` |
| Recommended people count | derived (people at org) | `48 people` → click = Find people |
| Last refreshed | org.last_refreshed_at | relative time |
| Actions | — | row action menu (§5) |

Behaviors: sticky header; per-page + select-all-N selection; column add/remove; gated columns render a lock affordance with upgrade prompt instead of a value; "Recommended people count" is the bridge to People Search.

### 🔧 Velocity mapping & delta
- `Companies.tsx` columns derive from `accounts`. Employee/Revenue come from `employeeBand`/`revenueBand`.
- **Deltas:** Technologies, Funding signal, Hiring signal, Recommended-people count, CRM match, Last refreshed, Saved status — all need the new org tables/index + overlays. Recommended-people uses `prospects` filtered by `cloduraOrgId`/domain.

---

## 5. Actions

Action contract (same as People): permission → credits → compliance → confirmation → async → success/failure.

| Action | Scope | Permission | Credits | Compliance | Confirm | Async | Notes |
|---|---|---|---|---|---|---|---|
| **Preview organization** | row | `orgs.read` | maybe (premium fields) | none | no | sync | opens drawer (§6) |
| **Save as account** | row/bulk | `accounts.create` | none | dedupe + domain suppression | bulk: yes | bulk: job | sets `organization_id` provenance |
| **Enrich organization** | row/account | `enrichment.org` | **yes** | eligibility | yes (spend) | job | refresh firmographics/tech/funding/postings |
| **Find people at organization** | row/account | `people.read` | none (search) | none | no | sync | opens People Search pre-filtered to org (`organization_ids=[id]`) |
| **Add to account list** | selection | `lists.write` | none | none | no | sync/job | `record_lists` |
| **Assign owner** | account | `accounts.assign` | none | none | no | sync | requires saved account |
| **Assign account stage** | account | `accounts.stage` | none | none | no | sync | requires saved account |
| **Create deal** | account | `deals.create` | none | none | modal | sync | creates `opportunities` row under account |
| **Suppress domain** | row/account | `compliance.suppress` | none | none | yes | sync | adds domain to suppression; excludes from future search |
| **Export** | selection | `export` **entitlement** | maybe | export limits + compliance | yes | job | gated + audited |

Hard rule: **Enrich, owner, stage, create-deal, and add-to-list require a saved `account_id`.** Invoking on an unsaved org auto-saves first (transparent, same dedupe + eligibility), then proceeds.

### 🔧 Velocity mapping & delta
- Save → `accounts.create` (+ dedupe §8, set provenance). Find-people → navigate to `/v2/people` with org filter. Add-to-list → `recordLists.addMembers`. Create-deal → `opportunities.create` (`accountId`, `stage`, `pipelineId`). Suppress-domain → `areSuppressionList` insert (domain scope).
- **Deltas:** org enrichment job (new, credit-metered), account-stage assignment (needs account-level stage), export gate.

---

## 6. Job Postings Subcomponent

A **"Current job postings"** panel inside the org preview drawer — the hiring-signal evidence surface.

- **Input:** `organization_id`.
- **Rows:** `title, location, department, source, posted_date` (+ active/expired badge). Sorted newest-first.
- **Pagination:** `page`/`per_page` (default 10, max 50), server-side; total active count in the header.
- **Hiring insights:** roll-ups above the list — total active postings, **net change vs prior period** (growth indicator), and a **department breakdown** (e.g. Sales 6, Eng 4, Marketing 2). Surfaces "hiring surge" as a buying signal.
- **Action — "Find people in this department":** each department chip deep-links to People Search pre-filtered to `organization_ids=[id]` + `person_departments=[dept]` (and optionally seniority), turning a hiring signal into a contact list.

States: no postings → empty ("No active job postings"); stale data → "as of {captured_at}" + refresh (enrich) affordance; gated → lock + upgrade if job-postings is a premium data tier.

### 🔧 Velocity mapping & delta
- **New subsystem** — no `organization_job_postings` today. Provider-fed (Clodura/other) into the org tables or the search index (§12). The "find people in department" hop reuses People Search filters (`person_departments`).

---

## 7. API Design

Canonical REST; each maps to a tRPC procedure. All validate `workspace_id`; bulk/credit ops are async.

### `POST /api/search/organizations`
- **Body:** `{ filters: OrgFilterObject, page, per_page, sort, selection_mode?: "page"|"all" }`
- **Response:** `{ results: OrgRow[], page, per_page, total_estimate, total_is_exact, selection_token?, facets:{industry,employee_range,revenue_range,technologies,location counts}, latency_ms }`
- **Pagination:** `per_page ≤ 100`; deep pages via cursor/`search_after`; `max result window` capped.
- **Errors:** `422 invalid_filters`, `429 rate_limited`, `403 filter_not_entitled`, `402 credit_limit_reached`, `504 search_timeout`.
- **Permission:** `orgs.read`. **Credits:** maybe (premium filters/data access).

### `GET /api/organizations/{organizationId}/preview`
- **Response:** `{ organization, domains[], locations[], technologies[], latest_funding, funding_events[], hiring_summary, recommended_people_count, overlays:{saved, account_id?, crm_match, suppressed, lists[], owner?, stage?} }`
- **Errors:** `404 org_not_found`, `410 org_deleted`. **Permission:** `orgs.read`. **Credits:** premium fields may meter.

### `GET /api/organizations/{organizationId}/job-postings`
- **Query:** `page, per_page`. **Response:** `{ postings:[{title,location,department,source,posted_at,is_active}], page, per_page, total_active, insights:{net_change, by_department[]} }`. **Permission:** `orgs.read` (+ entitlement if gated).

### `POST /api/organizations/{organizationId}/enrich`
- **Body:** `{ account_id?, fields?: ["firmographics"|"technologies"|"funding"|"job_postings"] }`
- **Response:** `{ request_id, status:"pending" }`. **Job result:** `{ status, updated_fields[], credits_consumed }`.
- **Validation:** eligibility; **credit pre-check** (reserve→debit on success); freshness idempotency. **Errors:** `402 insufficient_credits`, `403`, `404`, `409 fresh_data_exists`. **Async:** job.

### `POST /api/accounts/save-from-organization`
- **Body:** `{ organization_id, list_id?, owner_user_id?, stage?, parent_link?: "auto"|"none" }`
- **Response:** `{ account_id, created: bool, deduped_to?: account_id, matched_by?: "domain"|"name"|"linkedin"|"crm_id" }`
- **Validation:** org exists; **dedupe (§8)**; domain-suppression eligibility. **Errors:** `409 already_exists` (returns existing), `403 suppressed|not_entitled`. **Permission:** `accounts.create`. **Credits:** none.

### `POST /api/accounts/bulk-save-from-organizations`
- **Body:** `{ selection: {mode:"ids", organization_ids[]} | {mode:"all", selection_token, filters}, list_id?, owner_user_id?, stage? }`
- **Response:** `{ job_id }`. **Job result:** `{ saved, deduped:[{organization_id, account_id}], skipped:[{organization_id, reason}] }`. **Permission:** `accounts.create`+`bulk`. **Async:** job.

### `POST /api/accounts/{accountId}/assign-owner`
- **Body:** `{ owner_user_id }` → **Response:** `{ account_id, owner_user_id }`. **Errors:** `404`, `403`. **Permission:** `accounts.assign`.

### `POST /api/accounts/{accountId}/stage`
- **Body:** `{ stage }` (must be a valid `account_stages.key`) → **Response:** `{ account_id, stage }`. **Errors:** `422 invalid_stage`, `404`. **Permission:** `accounts.stage`.

### `POST /api/accounts/{accountId}/deals`
- **Body:** `{ name, value?, stage?, pipeline_id?, close_date?, owner_user_id? }` → **Response:** `{ deal_id, account_id }`. **Validation:** account exists & owned. **Errors:** `404 account`, `422`. **Permission:** `deals.create`.

### `POST /api/compliance/suppressions/domain`
- **Body:** `{ domain, reason (competitor|existing_customer|do_not_contact|manual), notes? }` → **Response:** `{ suppression_id, normalized_domain }`. **Effect:** excludes domain from future org search + blocks save/enrich. **Permission:** `compliance.suppress`.

### 🔧 Velocity mapping & delta
| REST | tRPC procedure |
|---|---|
| `POST /api/search/organizations` | extend `accounts.list` → new `organizations.search` (global) |
| `GET /api/organizations/{id}/preview` | new `organizations.preview` (+ `accountBriefs` L2005) |
| `GET /api/organizations/{id}/job-postings` | new `organizations.jobPostings` |
| `POST /api/organizations/{id}/enrich` | new `organizations.enrich` (credit-metered, like `clodura_enrichment_jobs`) |
| `POST /api/accounts/save-from-organization` | new `accounts.saveFromOrganization` (dedupe + provenance) |
| `…/bulk-save-from-organizations` | new `accounts.bulkSaveFromOrganizations` (job) |
| `…/{id}/assign-owner` | `accounts.update {ownerUserId}` |
| `…/{id}/stage` | `accounts.setStage` (**new** — needs account stage) |
| `…/{id}/deals` | `opportunities.create` ✓ |
| `…/suppressions/domain` | `areSuppressionList` insert (domain scope) ✓ |

Transport: implement as tRPC procedures with identical shapes; idempotency keys on job-creating procedures.

---

## 8. Matching & Dedupe Logic

On save (and bulk save), resolve whether the organization already exists as an account. Ordered waterfall (first confident match wins → return existing `account_id`):

1. **Domain (exact)** — `organization.primary_domain` == `account.domain`.
2. **Normalized domain** — strip scheme/`www.`/trailing slash, lowercase; compare normalized forms (and across `organization_domains` for multi-domain companies).
3. **CRM external id** — same `crm_external_ids.external_id` for an `account` → confident match (already in CRM).
4. **LinkedIn URL** — normalized company LinkedIn slug match.
5. **Company name (exact normalized)** — normalized_name equality (lowercase, strip legal suffixes Inc/LLC/Ltd, punctuation).
6. **Fuzzy name + HQ location** — high token-set similarity on name **AND** same HQ city/region → probable match (flag as "possible duplicate," let user confirm rather than auto-merge).
7. **Parent/subsidiary** — if the org's `parent_organization_id` already maps to an account, surface the relationship (link as child via `parent_account_id`) rather than creating an unrelated duplicate.

Rules: 1–4 auto-dedupe (return existing). 5 auto-dedupe if also same domain-or-region, else demote to 6. 6 never silently merges — returns `possible_duplicate` for user decision. Multi-domain companies: dedupe must check **all** `organization_domains`, not just primary, to avoid a brand-domain creating a second account.

### 🔧 Velocity mapping & delta
- `accounts.domain`, `accounts.name`, `accounts.parentAccountId` exist (parent/subsidiary supported). `prospects.cloduraOrgId` ties people to orgs.
- **Deltas:** `organization_domains` (multi-domain), `crm_external_ids`, normalized_name + normalized_domain columns/indexes, and a fuzzy matcher (token-set ratio). Add a normalized-domain unique-ish index on `accounts` for fast dedupe.

---

## 9. UI Component Architecture

```
OrganizationSearchPage                // route /v2/companies; owns filters, pagination, selection
├─ CompanyFilterPanel                 // the rail; entitlement-gated groups; clear-all
│  ├─ EmployeeRangeFilter             // # employees ranges
│  ├─ RevenueRangeFilter              // min/max (gated)
│  ├─ TechnologyFilter                // technology_uids multiselect (gated)
│  ├─ FundingFilter                   // latest round amount min/max (gated)
│  ├─ LocationFilter                  // HQ include / exclude, ZIP-radius
│  └─ FilterGroup (×N)                // industry/keywords, SIC/NAICS, signals, overlays
├─ CompanyToolbar                     // saved-view, search, save-as-search, sort, settings
├─ BulkActionBar                      // save / list / owner / stage / export; "select all N"
├─ CompanyResultsTable
│  └─ CompanyResultRow                // gated cells = lock+upgrade; saved/CRM badges; row menu
├─ CompanyPreviewDrawer               // firmographics, insights, funding, overlays
│  ├─ HiringSignalsPanel              // §6 job postings + insights + "find people in dept"
│  └─ (funding history, technographics, recommended people)
├─ SaveAccountModal                   // owner/stage/list/parent-link; dedupe notice
└─ FindPeopleAtCompanyModal           // confirm org→people handoff (filters preview)
```

State: filter object URL-serializable (shareable/saveable); selection = opaque token for "all" + id set for "page"; gated cells never request premium data unless entitled.

### 🔧 Velocity mapping & delta
- `Companies.tsx` already implements `OrganizationSearchPage`, `CompanyFilterPanel`/facets, `CompanyResultsTable`/`Row`, toolbar.
- **New:** `CompanyPreviewDrawer` + `HiringSignalsPanel`, `SaveAccountModal`, `FindPeopleAtCompanyModal`, and the gated filter sub-components. Reuse `ui/dialog` (`sm:max-w-*`), `Shell`/`PageHeader`/`useAccentColor`.

---

## 10. Edge Cases

| Case | Handling |
|---|---|
| Company has multiple domains | Dedupe checks all `organization_domains`; save stores primary + retains alternates; no duplicate per brand domain. |
| Domain already saved as account | `409 already_exists` + existing `account_id`; row shows `Saved`, links to account. |
| CRM duplicate exists | `crm_external_ids` match → dedupe to that account; badge `In CRM`; offer link/sync rather than new record. |
| Company has no domain | Save allowed; dedupe falls to name+HQ (fuzzy → possible-duplicate prompt); domain-dependent enrich limited. |
| Organization data stale | `last_refreshed_at` old → "as of …" + re-enrich affordance; saved account keeps snapshot + provenance. |
| No job postings | Hiring panel empty state; hiring signal column shows `—`; hiring filters simply don't match. |
| Org search credit limit reached | `402 credit_limit_reached`; premium filters/data blocked; show balance + upgrade; basic firmographic search still allowed where free. |
| Lacks export permission | `403 not_entitled`; export disabled w/ tooltip. |
| Domain suppressed | Excluded from results by default; if shown (suppression toggled off), save/enrich blocked with reason. |
| Bulk save partially succeeds | Job returns `{saved, deduped[], skipped[reason]}`; **no silent truncation**; per-row reasons surfaced. |

### 🔧 Velocity mapping & delta
- Empty/stale states partially exist in `Companies.tsx`. Credit/entitlement/dedupe cases depend on §7/§8/§11 landing.

---

## 11. Acceptance Criteria (Given/When/Then)

**Search**
- Given a rep with `orgs.read`, When they filter `organization_num_employees_ranges=["51-200"]` + `industry=SaaS`, Then results contain only matching global organizations with firmographics shown.

**Entitlement gating**
- Given a plan without Funding data, When the rep opens the Funding filter, Then it's locked with an upgrade prompt (not an empty result).
- Given a credit limit reached, When a premium-data search runs, Then `402 credit_limit_reached` and basic firmographic search still works.

**Preview + job postings**
- Given an org row, When clicked, Then the drawer shows firmographics, funding, technographics, and the job-postings panel with department breakdown and net-change insight.
- Given the Sales department chip, When clicked, Then People Search opens pre-filtered to that org + `person_departments=["sales"]`.

**Save as account + dedupe**
- Given an org whose domain matches an existing account, When "Save as account", Then `409 already_exists` and the existing account is linked (no duplicate).
- Given an org with a new domain, When "Save", Then a `workspace_account` is created with `organization_id` provenance and `matched_by=null`.
- Given a fuzzy name+HQ match, When saving, Then a `possible_duplicate` prompt asks the user to confirm rather than auto-merging.

**Bulk save**
- Given "select all N" of 2,000 orgs, When "Bulk save", Then a job returns `{saved, deduped[], skipped[reason]}` and the client never page-loops to gather ids.

**Org enrichment**
- Given a saved account + sufficient credits, When "Enrich organization", Then an async job refreshes firmographics/tech/funding, debits credits, and updates the row.
- Given a fresh value within the freshness window, When "Enrich", Then it returns cached without re-charging.

**Owner / stage / deal**
- Given a saved account, When assigning owner/stage, Then the overlay updates; When "Create deal", Then an `opportunity` is created under the account.

**Compliance**
- Given "Suppress domain" on `competitor.com`, When future searches run with default exclusion, Then that domain no longer appears and save/enrich is blocked.

**Export**
- Given a rep without `export`, When "Export", Then it's blocked with an entitlement reason.

---

## 12. Implementation Checklist

**Database**
- [ ] `global_organizations` + `organization_domains` (normalized_domain) + `organization_locations` + `organization_technologies` + `organization_job_postings` + `organization_funding_events` (or index-only denormalization).
- [ ] `crm_external_ids`, `account_stages`, `account_labels` (+ assignments).
- [ ] Add account-level `stage` + normalized_name/normalized_domain columns + dedupe indexes on `accounts`.
- [ ] Reuse `are_suppression_list` (domain) for suppression.
- [ ] Migration in BOTH `drizzle/schema.ts` AND `server/_core/rawMigrations.ts` (next: **0094**).

**Search index**
- [ ] `organizations_v1` doc denormalizing firmographics + domains + technologies + funding + job-postings + per-workspace overlays (saved/CRM/owner/stage/label/suppressed) as nested; `geo_distance` HQ radius; facets via aggregations; `search_after` deep paging; `max_result_window` cap.
- [ ] Interim (no ES): covering indexes on hot filter columns + aggregate facet queries on `accounts`/org source.

**Backend (tRPC)**
- [ ] `organizations.search` (masking n/a; entitlement + credit gates, facets, selection_token, rate limits).
- [ ] `organizations.preview` + `organizations.jobPostings` + `organizations.enrich` (credit reserve→debit, freshness idempotency).
- [ ] `accounts.saveFromOrganization` + `bulkSaveFromOrganizations` (job) with dedupe waterfall (§8).
- [ ] `accounts.setStage` / assign-owner / `opportunities.create` / domain suppression.
- [ ] Every procedure filters by `ctx.workspace.id`; validate caller ids → 404 cross-workspace.

**Frontend**
- [ ] Gated filter sub-components (Revenue/Technology/Funding) with upgrade prompts.
- [ ] `CompanyPreviewDrawer` + `HiringSignalsPanel` (job postings + insights + find-people-in-dept).
- [ ] `SaveAccountModal` (dedupe notice, parent link), `FindPeopleAtCompanyModal`, `BulkActionBar`.
- [ ] New columns (Technologies, Funding, Hiring, Recommended people, CRM, Last refreshed, Saved).
- [ ] URL-serializable filter object; opaque selection token. Dialogs `sm:max-w-*`; shell flex rows `shrink-0`.

**Worker / jobs**
- [ ] Bulk save / bulk enrich / export jobs with progress + partial reporting + idempotency keys.
- [ ] Org enrichment fan-out under a daily budget cap (reuse `clodura_enrichment_settings.daily_budget_cap`).

**Credit ledger**
- [ ] Credit balance + reserve→debit-on-success ledger; per-plan entitlement table; meter premium search/preview/enrich; surface balance in UI (reference shows a credits counter).

**Compliance**
- [ ] Domain suppression via `are_suppression_list`; default exclusion in search; block save/enrich on suppressed.
- [ ] Export entitlement + limits + audit.

**Test**
- [ ] Given/When/Then suites from §11.
- [ ] Dedupe matrix (domain/normalized/name/linkedin/crm/fuzzy/parent) incl. multi-domain.
- [ ] Cross-workspace isolation (no overlay leakage).
- [ ] Credit reserve/debit/refund-on-failure; entitlement gating; rate + export limits.
- [ ] Org→People handoff filter correctness.

---

### Appendix — provenance of functional references
`Apollo Screenshots/02_prospect-and-enrich/02_companies/00_main_page` ("Find companies": 32.5M total, credits counter, filter rail — Lists, Company, Lookalikes, Account Location, # Employees, Industry & Keywords, Market Segments, SIC and NAICS, AI Filters, Buying Intent, Website Visitors, Technologies, Revenue, Funding, Job Postings, Scores, Signals, Owner — with Revenue/Funding/Technologies/Job-Postings/Lookalikes plan-gated, "Unlock advanced filters … View plans"); `…/01_filters`. Layout/UX only; no Apollo brand assets, icons, or protected design reproduced.
