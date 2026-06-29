# Technical Spec — Enrichment System (People, Contact, Organization, Account)

> **Component:** Original waterfall enrichment system — demographic/firmographic resolution + email/phone discovery + verification, credit-metered and auditable, with async webhook completion.
> **Status:** Design spec (hybrid). Canonical, provider-agnostic design + a **Velocity mapping & delta** callout per section tying it to the real `igrant9679/usip` stack (tRPC v11 + Drizzle/MySQL + existing vendor services).
> **Framing:** Velocity already has the enrichment **primitives** (jobs, async reveal, field history, email verification, multiple vendor services, budget/freshness settings). This spec designs the **orchestration layer** on top: a generic vendor waterfall with per-attempt records, a credit **ledger** with reservations, and an outbound **webhook**. *Extend, don't replace* — the `clodura_*` tables stay as execution records.
> **Sibling components:** [People Search](people-search.md) (§6 enrichment), [Organization Search](organization-search.md) (§7 enrich + credit ledger), [Workspace Contacts & Accounts](workspace-contacts-accounts.md) (enrichment history). This spec is the shared engine those components call.
> **Functional reference:** `Apollo Screenshots/02_prospect-and-enrich/04_data-enrichment` (Data-health center, CRM, CSV, Job-change, Form). Layout/UX only — no Apollo branding, icons, colors, or protected design reproduced.

---

## 0. Principles (read first)

1. **Better identifiers → higher match confidence.** The engine takes whatever identifiers are supplied and resolves the strongest match; more/stronger identifiers raise the confidence score and reduce ambiguity.
2. **Private data is opt-in.** Personal emails and phone numbers are **never revealed by default** — only when explicitly requested (`reveal_personal_emails` / `reveal_phone_number`) **and** allowed by the compliance gate.
3. **Sync fast, async deep.** Demographic/firmographic data returns **synchronously**; email/phone **discovery** (the waterfall) can complete **asynchronously** via webhook.
4. **Everything is recorded.** Each request captures the data-source attempts, per-source statuses, values returned, the final selected value, and credit usage — a full audit trail.
5. **Credits are reserved, then debited by rule.** Credits are reserved up-front (estimate), debited only per configured rules on actual success, released on failure — and every movement is auditable in a ledger.
6. **Idempotent + bounded.** Requests carry idempotency keys; bulk requests are capped (**10 per request** for people and orgs); webhooks deliver idempotently with retry/backoff.

---

## 1. Enrichment Types

| Type | Cardinality | Sync/Async | Description |
|---|---|---|---|
| **Person enrichment** | 1 person | sync demo + async discovery | Resolve a person → demographic fields; optionally discover/reveal email & phone. |
| **Bulk people enrichment** | ≤ **10** people/request | sync per-record demo + async discovery | Same, batched; one parent request, N child results. |
| **Organization enrichment** | 1 company | sync firmographic | Resolve a company → firmographics, tech, funding, postings. |
| **Bulk organization enrichment** | ≤ **10** orgs/request | sync | Batched firmographic enrichment. |
| **Email discovery** | per person | async (waterfall) | Find a deliverable email via vendor waterfall. Gated by `reveal_personal_emails`. |
| **Phone discovery** | per person | async (waterfall) | Find a phone via waterfall. Gated by `reveal_phone_number`. |
| **Email verification** | per email | async | Validate deliverability (safe/invalid/risky/catch-all/unknown). |
| **Phone validation** | per phone | sync/async | Validate line type/reachability + normalize E.164. |
| **CRM enrichment** | bulk over CRM records | async job | Enrich existing CRM contacts/accounts in place; write enrichment history. |
| **CSV enrichment** | bulk over uploaded file | async job | Map columns → identifiers → enrich → return enriched CSV. |
| **API enrichment** | external caller | sync+webhook | The above exposed as a scoped public API for programmatic use. |

### 🔧 Velocity mapping & delta
- **Exists:** person/contact enrichment (`clodura_enrichment_jobs`), email/phone discovery (`clodura_reveal_jobs`, `kind email|phone`), **email verification** (`email_verification_jobs` + Reoon), CSV (`server/services/csv.ts`), CRM/CSV surfaces (`/v2/data-enrichment` tabs).
- **Delta:** the **bulk-of-10** contract, **org** enrichment as a first-class type, **phone validation** (no phone vendor today), and **API enrichment** (public scoped API).

---

## 2. Input Identifiers

The engine accepts any subset; the resolver uses all provided to disambiguate.

| Identifier | Use |
|---|---|
| `person_id` | global person provenance (strongest person key) |
| `contact_id` | workspace contact (enrich-in-place target) |
| `first_name`, `last_name`, `full_name` | name resolution |
| `email` | direct key + verification seed |
| `hashed_email` | privacy-preserving match (no PII exposure) |
| `linkedin_url` | high-signal person/org key |
| `organization_name` | company resolution |
| `company_domain` | strong org key (normalized) |
| `organization_id` | global org provenance |
| `account_id` | workspace account (enrich-in-place target) |
| `website` | org key (normalized → domain) |
| `crm_external_id` | external CRM mapping key |

**Identifier strength → match confidence:** keys are weighted (e.g. `person_id`/`linkedin_url`/`email` > `full_name`+`company_domain` > `full_name` alone). The resolver computes a confidence score from the strongest matched identifier set; **insufficient identifiers** (e.g. only a first name) fail fast (§11).

### 🔧 Velocity mapping & delta
- `clodura_enrichment_jobs.identifier_set` (JSON) already carries this set; `prospects.cloduraPersonId`/`cloduraOrgId`, `contacts.id`, `accounts.id`, `company_domain` all exist. **Delta:** `hashed_email`, `crm_external_id` (needs the `crm_external_ids` table from the CRM spec), and a formal identifier-weighting function.

---

## 3. Request Parameters

```jsonc
{
  "identifiers": { /* §2 */ },
  "reveal_personal_emails": false,     // opt-in; gated
  "reveal_phone_number": false,        // opt-in; gated
  "run_waterfall_email": false,        // run multi-vendor email discovery
  "run_waterfall_phone": false,        // run multi-vendor phone discovery
  "webhook_url": "https://…",          // async completion delivery (optional)
  "input_source": "ui|csv|crm|api|sequence",
  "requested_fields": ["title","seniority","company","email","phone","technologies","funding"],
  "credit_estimate_only": false,       // dry-run: return estimate, reserve nothing
  "idempotency_key": "uuid"            // dedupe identical requests
}
```

Rules: if `reveal_*` is false, the engine returns **availability/status only**, never the value. `run_waterfall_*` requires the matching `reveal_*` + entitlement. `credit_estimate_only=true` returns the estimate without reserving. Identical `idempotency_key` within a window returns the original request (no double charge).

### 🔧 Velocity mapping & delta
- `reveal`/async exist via `clodura_reveal_jobs`; `requested_fields` partially implied. **Delta:** the explicit `run_waterfall_*` toggles, `webhook_url`, `credit_estimate_only` dry-run, and first-class `idempotency_key`.

---

## 4. Synchronous Response

Returned immediately (the demographic/firmographic part).

```jsonc
{
  "request_id": "req_…",
  "match_status": "matched|ambiguous|not_found",
  "confidence_score": 0,                       // 0–100
  "demographic": { "first_name","last_name","title","seniority","department","location","linkedin_url" },
  "firmographic": { "company","domain","industry","employee_range","revenue_range","hq_location","technologies","funding" },
  "waterfall": { "email":"pending|skipped|n/a", "phone":"pending|skipped|n/a" },
  "validation_errors": [ { "field","code","message" } ],
  "unprocessed_requested_attributes": ["phone"],   // requested but deferred to async or blocked
  "estimated_credit_reservation": { "demographic":1, "email":2, "phone":3, "total":6, "reservation_id":"rsv_…" }
}
```

If `webhook_url` was supplied and waterfall is `pending`, the deep result arrives later (§5). If no waterfall was requested, `waterfall` fields are `n/a` and the response is terminal.

### 🔧 Velocity mapping & delta
- The sync demographic/firmographic shape maps to a `clodura_enrichment_jobs` immediate read. **Delta:** `unprocessed_requested_attributes`, the `estimated_credit_reservation` block (needs the ledger), and explicit `match_status=ambiguous`.

---

## 5. Asynchronous Webhook Response

Delivered to `webhook_url` when the waterfall completes (signed; idempotent).

```jsonc
{
  "request_id": "req_…",
  "completion_status": "succeeded|partial|failed",
  "totals": { "records_requested": 10, "records_enriched": 8, "records_not_found": 2,
              "email_enriched_count": 7, "phone_enriched_count": 5 },
  "records": [
    {
      "input_index": 0, "match_status": "matched", "confidence_score": 92,
      "data_sources_attempted": ["native_db","clodura","leadrocks","scraper"],
      "source_statuses": [
        { "source":"native_db","status":"miss","latency_ms":12 },
        { "source":"clodura","status":"hit","latency_ms":840,"values":{"email":"a@x.com"} },
        { "source":"leadrocks","status":"skipped_stop_condition" }
      ],
      "values_returned": { "email":["a@x.com","a@personal.com"], "phone":["+1…"] },
      "final_selected_values": { "email":"a@x.com","email_status":"verified","phone":"+1…","phone_status":"valid" },
      "credit_consumption": { "email":2,"phone":3,"verification":1,"total":6 }
    }
  ],
  "credit_consumption_details": { "reserved":60,"consumed":48,"released":12,"ledger_entries":["led_…"] },
  "completed_at": "2026-06-29T12:00:00Z"
}
```

Delivery: HMAC-signed (`X-Velocity-Signature`), idempotency key = `request_id`, retried with exponential backoff; every attempt recorded in `enrichment_webhook_deliveries`.

### 🔧 Velocity mapping & delta
- **Mostly delta.** `clodura_reveal_jobs` completes internally with `trackingId` but does not deliver an outbound webhook. The per-source `source_statuses`/`values_returned`/`final_selected_values` require the new `enrichment_vendor_attempts` table. Signing precedent: inbound Unipile webhook + `UNIPILE_WEBHOOK_SECRET`.

---

## 6. Waterfall Orchestration

Per requested field (email, phone, demographic, firmographic), iterate an **ordered vendor list** until a stop condition is met.

```
for field in requested_fields:
  for vendor in waterfall(field):                 # ordered by cost↑ / reliability↓
    if budget_exhausted(): break
    attempt = vendor.fetch(identifiers, field)    # record enrichment_vendor_attempts
    record(attempt)                                # source, status, latency, raw value, credits
    if attempt.hit:
      v = validate(field, attempt.value)           # record enrichment_validations
      if v.valid and v.confidence >= THRESHOLD:
        select(field, attempt.value, source)        # final_selected_value + field_source_attribution
        debit_credits(vendor, field)                # reserve→debit on success
        break                                        # stop condition: validated hit
      else: continue                                 # invalid/low-confidence → next vendor
  if not selected(field): mark_not_found(field)
```

- **Native database lookup first** — check Velocity's own data (`prospects`/`contacts`/caches) before paid vendors (free, fastest).
- **Vendor source attempts** — each vendor is a pluggable adapter; attempts recorded with status (`hit|miss|error|timeout|skipped_stop_condition`).
- **Validation after each source** — email → verify (Reoon); phone → validate; demographic → confidence/plausibility. Only validated values can be selected.
- **Stop conditions** — first validated hit ≥ threshold; or budget cap; or vendor list exhausted.
- **Confidence threshold** — configurable (default 70); below threshold → keep trying.
- **Retry/backoff** — transient vendor errors retried with exponential backoff (capped); permanent errors skip to next vendor.
- **Partial success** — email found, phone not → `partial`; record what succeeded, charge only for what succeeded.
- **Idempotent webhook delivery** — at-least-once with `request_id` dedupe key.
- **Audit trail** — `enrichment_requests` → `enrichment_vendor_attempts` → `enrichment_validations` → `field_source_attribution` + `credit_ledger` form the complete record.

### 🔧 Velocity mapping & delta
- **Adapters already exist** as concrete services: `server/services/` → **clodura**, **reoon.ts** (email verify), **leadrocks.ts**, **scraper/** (domain scrape), **googlePlaces.ts**, **linkedinLookup.ts**/Unipile, **discovery/**. Today they're invoked ad-hoc per feature.
- **Delta:** a generic `EnrichmentVendor` interface (`fetch(identifiers, field) → Attempt`) + an orchestrator that iterates per field, recording `enrichment_vendor_attempts`/`enrichment_validations`, applying stop conditions + threshold + the ledger. Native-DB-first lookup uses existing `clodura_search_cache`/`domain_scrape_cache`.

---

## 7. Compliance Gate

A single `checkEligibility(workspace, actor, target, action, scope)` runs **before** any enrichment (and re-checks in-worker before each reveal). Fail-closed, ordered:

1. **User permission** — RBAC for `enrichment.email`/`.phone`/`.org`/`bulk`/`api`.
2. **Plan entitlement** — feature gated by plan (waterfall, phone, API).
3. **Available credits** — sufficient balance/budget to reserve the estimate.
4. **Workspace suppression** — target on workspace suppression list.
5. **Global unsubscribe** — globally opted-out person.
6. **Domain suppression** — target's domain suppressed (competitor/customer/manual).
7. **Do-not-contact status** — DNC flag → block phone discovery specifically.
8. **Region restrictions** — GDPR/CCPA/region policy (e.g. block phone reveal in restricted regions; require lawful basis).
9. **Export restrictions** — if the enrichment feeds an export, export entitlement + limits apply.
10. **API scope** — for API callers, the API key must carry the required scope (`enrichment:read`/`:reveal`).

Each failure returns a typed reason; **no credits are reserved or charged on a block.** Save/demographic may be allowed while reveal is blocked.

### 🔧 Velocity mapping & delta
- Suppression sources exist: `email_suppressions` (L2110), `are_suppression_list` (L3066, incl. `do_not_contact`, domain). Budget via `clodura_enrichment_settings.daily_budget_cap`.
- **Delta:** unify into one `checkEligibility`; add global-unsub source, region rules, plan-entitlement table, and **API scopes**. (Shared delta across all four component specs.)

---

## 8. Data Model

**Extend, don't replace.** New orchestration tables (★) sit alongside existing execution records.

| Table | Purpose | Key fields |
|---|---|---|
| **`enrichment_requests`** | one row per request (umbrella) | `request_id PK, workspace_id, type (person|bulk_people|org|bulk_org|email|phone|verify|csv|crm|api), input_source, status (pending|running|partial|succeeded|failed|cancelled), reveal_personal_emails, reveal_phone_number, run_waterfall_email, run_waterfall_phone, webhook_url, idempotency_key, requested_by, api_key_id?, created_at, completed_at` |
| **`enrichment_request_inputs`** ★ | N inputs per request (bulk ≤10) | `id PK, request_id, input_index, identifiers json, contact_id?, account_id?, person_id?, organization_id?` |
| **`enrichment_results`** | per-input result | `id PK, request_id, input_index, match_status, confidence_score, demographic json, firmographic json, final_values json, completion_status` |
| **`enrichment_vendor_attempts`** ★ | per-source attempt | `id PK, request_id, input_index, field (email|phone|demo|firmo), vendor (native_db|clodura|leadrocks|reoon|scraper|google_places|unipile), status (hit|miss|error|timeout|skipped), latency_ms, value json, credits, attempted_at` |
| **`enrichment_validations`** ★ | validation per candidate | `id PK, request_id, input_index, field, candidate_value, validator (reoon|phone_validator|heuristic), result (valid|invalid|risky|unknown), confidence, validated_at` |
| **`enrichment_webhook_deliveries`** ★ | outbound delivery log | `id PK, request_id, url, attempt_no, http_status, signature, payload_hash, delivered_ok, error, next_retry_at, created_at` |
| **`credit_reservations`** ★ | hold credits at request time | `reservation_id PK, workspace_id, request_id, amount_estimated, amount_consumed, amount_released, status (held|settled|expired|released), expires_at, created_at` |
| **`credit_ledger`** ★ | immutable credit movements | `id PK, workspace_id, request_id?, reservation_id?, delta (signed), balance_after, reason (reserve|debit|release|grant|adjust), source, actor_user_id?, created_at` |
| **`contact_methods`** | revealed emails/phones | `id PK, contact_id?, person_id?, type, value (encrypted), status, source, is_primary, verified_at` |
| **`field_source_attribution`** | which source won each field | `id PK, workspace_id, entity_type, entity_id, field_name, value, source, vendor, confidence, applied_at` |
| **`suppression_entries`** | compliance source | (see CRM spec / `are_suppression_list` + `email_suppressions`) |

### 🔧 Velocity mapping & delta
| Canonical | Velocity |
|---|---|
| `enrichment_requests` | extend `clodura_enrichment_jobs` (L3392) + `clodura_reveal_jobs` (L3320) under one umbrella |
| `enrichment_request_inputs` / `enrichment_results` | **new** (bulk-of-10 needs N inputs/results; today JSON `identifier_set`) |
| `enrichment_vendor_attempts` / `enrichment_validations` | **new** (the waterfall record) — validation partly in `email_verification_*` |
| `enrichment_webhook_deliveries` | **new** |
| `credit_reservations` / `credit_ledger` | **new** (today `daily_budget_cap`/`credits_consumed`/`usage_counters`) |
| `contact_methods` | inline on `contacts`/`prospects` today (+ `email_revealed_at`/`phone_revealed_at`) |
| `field_source_attribution` | `contact_enrichment_history` (L3419) covers contact-field history; generalize to all entities |

---

## 9. API Endpoints

Canonical REST (public, scoped) → tRPC internally. All validate workspace + scope; all mutations audit; all credit ops use the ledger.

**`POST /api/enrichment/person`** — enrich one person.
- Body: §3 (single `identifiers`). Response: §4 (sync) + async webhook (§5) if waterfall + `webhook_url`.
- Validation: ≥1 sufficient identifier; reveal flags require entitlement. Perm/scope: `enrichment.person` / `enrichment:reveal`. Credits: reserve→debit. Errors: `402 insufficient_credits`, `403 blocked|scope_denied`, `422 insufficient_identifiers`, `409 duplicate (idempotency)`.

**`POST /api/enrichment/people/bulk`** — ≤**10** people.
- Body: `{ records: PersonInput[≤10], …shared params }`. Validation: `records.length ≤ 10`. Response: `{ request_id, results: SyncResult[] }` + webhook for waterfall. Errors: `422 too_many_records (>10)`. Perm: `enrichment.person`+`bulk`.

**`POST /api/enrichment/organization`** — enrich one org. Body/response firmographic (sync). Perm: `enrichment.org`.

**`POST /api/enrichment/organizations/bulk`** — ≤**10** orgs. `422 too_many_records` if >10. Perm: `enrichment.org`+`bulk`.

**`GET /api/enrichment/jobs/{requestId}`** — poll a request: status, per-input results, vendor attempts, credit summary. Perm: `enrichment.read`. Error: `404`.

**`POST /api/enrichment/jobs/{requestId}/cancel`** — cancel a running request; releases held credits. Response: `{ status:"cancelled", credits_released }`. Errors: `409 already_terminal`. Perm: `enrichment.write`.

**`GET /api/enrichment/history`** — paginated request history (filter by type/status/date/actor). Perm: `enrichment.read`.

**`GET /api/enrichment/credits`** — balance, reservations, recent ledger. Response: `{ balance, held, monthly_cap, recent_ledger[] }`. Perm: `billing.read`.

**`POST /api/webhooks/enrichment-results`** — **inbound** vendor callback (e.g. Clodura reveal completion) → updates results, settles ledger, fans out the **outbound** customer webhook. Auth: vendor signature. Idempotent on vendor task id.

### 🔧 Velocity mapping & delta
| REST | tRPC / reality |
|---|---|
| person / people/bulk | `prospects.revealEmail/Phone` + `clodura_enrichment_jobs`; bulk-of-10 is new |
| organization(s) | **new** org enrichment (Org spec §7) |
| jobs/{id} + cancel | `clodura_reveal_jobs` status read; cancel is new (release credits) |
| history | `clodura_enrichment_jobs` list |
| credits | **new** (ledger) — today no balance endpoint |
| webhooks/enrichment-results | inbound vendor callback exists conceptually (reveal completion); outbound fan-out is new |
- Transport delta: public REST gateway + API-key scopes over the tRPC procedures.

---

## 10. Frontend Components

```
EnrichmentPage                       // /v2/data-enrichment (tabs: Health / CRM / CSV / Job-change / Form)
├─ SingleEnrichmentForm              // identifiers + reveal toggles + requested fields
├─ BulkEnrichmentModal               // ≤10 records (paste/select); CSV hands off to job
├─ CreditPreviewPanel                // estimate (dry-run) before confirm; balance + reservation
├─ WaterfallStatusBadge             // per-field: pending / hit / not-found / skipped
├─ EnrichmentJobProgress             // async progress (records enriched / email+phone counts)
├─ EnrichmentResultsTable            // per-record results; final values + status
├─ SourceAttemptTimeline             // ordered vendor attempts (native→clodura→leadrocks→…) w/ status+latency
├─ FieldConfidenceBadge              // per-field confidence + winning source
├─ WebhookDeliveryLog                // outbound delivery attempts + retries + signature
└─ EnrichmentHistoryDrawer           // past requests; filter; re-run; export
```

State: credit preview is a **dry-run** call (`credit_estimate_only`) before commit; results stream via job subscription; masked values shown only when reveal allowed. `SourceAttemptTimeline` reads `enrichment_vendor_attempts`; `FieldConfidenceBadge` reads `field_source_attribution`.

### 🔧 Velocity mapping & delta
- `/v2/data-enrichment` (`DataEnrichment.tsx`) exists with the tabs + dataHealth donuts. **New:** `SingleEnrichmentForm`, `BulkEnrichmentModal`, `CreditPreviewPanel`, `SourceAttemptTimeline`, `WebhookDeliveryLog`, `EnrichmentHistoryDrawer`. Reuse `Shell`/`PageHeader`, `ui/dialog` (`sm:max-w-*`).

---

## 11. Edge Cases

| Case | Handling |
|---|---|
| Ambiguous match | `match_status="ambiguous"`; return candidate set + confidences; **don't auto-charge** for reveal until disambiguated; UI asks to pick. |
| No match | `match_status="not_found"`; demographic empty; reveal skipped; **no reveal credits** charged (demographic attempt may or may not charge per rule). |
| Insufficient identifiers | `422 insufficient_identifiers` pre-reservation; nothing charged. |
| Insufficient credits | `402` at reservation; no job created; show balance + needed. |
| Vendor timeout | attempt recorded `timeout`; retry/backoff then skip to next vendor; never blocks the whole waterfall. |
| Webhook unavailable | delivery retried with backoff; logged in `enrichment_webhook_deliveries`; result still pollable via `GET jobs/{id}`. |
| Partial bulk success | per-input results; `completion_status="partial"`; totals report enriched vs not-found; charge only successes. |
| Duplicate request | same `idempotency_key` → return original `request_id`, no new reservation/charge. |
| Suppressed target | compliance block w/ reason; reveal skipped; no charge; demographic may still return. |
| Unsupported region | region block on phone/email reveal; typed reason; no charge. |
| API scope denied | `403 scope_denied`; nothing charged. |
| Credit reservation expired | reservation `expired` → released to ledger; request fails `failed (reservation_expired)`; re-request needed. |
| Source returned conflicting values | validation + confidence pick the winner; all candidates retained in `values_returned`; winner in `final_selected_values` + `field_source_attribution`; conflict noted. |

### 🔧 Velocity mapping & delta
- Not-found/partial partly handled in reveal jobs. **Delta:** reservation-expiry, idempotency dedupe, conflict resolution across sources, and API-scope denial — all depend on the new ledger/attempt/scope machinery.

---

## 12. Acceptance Criteria (Given/When/Then)

**Reveal opt-in**
- Given `reveal_personal_emails=false`, When enrich a person, Then the response returns email **status only**, no value, and no email-reveal credits are charged.
- Given `reveal_phone_number=true` + entitlement + credits, When enrich, Then the phone waterfall runs and a value (if found) is returned async via webhook.

**Sync + async split**
- Given a person enrichment with `run_waterfall_email=true` + `webhook_url`, When called, Then demographic fields return synchronously with `waterfall.email="pending"`, and a signed webhook later delivers the email result.

**Bulk cap**
- Given a bulk request of 11 people, When `POST /api/enrichment/people/bulk`, Then `422 too_many_records` and nothing is charged.
- Given 10 people where 8 match, When complete, Then totals show `records_enriched=8, records_not_found=2` with per-input results.

**Waterfall + attempts**
- Given native DB misses and Clodura hits a validated email, When the waterfall runs, Then `enrichment_vendor_attempts` records native_db=miss + clodura=hit, the email is validated, later vendors are `skipped_stop_condition`, and `field_source_attribution` credits Clodura.

**Confidence**
- Given only `first_name`, When enrich, Then `422 insufficient_identifiers`.
- Given `linkedin_url` + `company_domain`, When enrich, Then `confidence_score` is higher than name-only.

**Credits / ledger**
- Given `credit_estimate_only=true`, When called, Then an estimate returns and **no reservation** is created.
- Given a successful reveal, When complete, Then the ledger shows reserve → debit (consumed) → release (unused), and balance reconciles.
- Given a vendor failure, When the field is not found, Then reserved-but-unused credits are **released**, not debited.

**Compliance**
- Given a suppressed domain, When enrich-reveal, Then it's blocked with a typed reason and 0 credits charged.
- Given a DNC flag, When `reveal_phone_number=true`, Then phone discovery is blocked specifically while email may proceed.

**Idempotency / webhook**
- Given two requests with the same `idempotency_key`, When both sent, Then the second returns the original `request_id` with no new charge.
- Given a webhook endpoint returning 500, When delivery fails, Then it's retried with backoff and each attempt is logged; the result remains pollable.

**Cancel**
- Given a running request, When cancelled, Then held credits are released and status is `cancelled`.

---

## 13. Implementation Checklist

**Database**
- [ ] New tables: `enrichment_request_inputs`, `enrichment_vendor_attempts`, `enrichment_validations`, `enrichment_webhook_deliveries`, `credit_reservations`, `credit_ledger`, `field_source_attribution` (generalized).
- [ ] Extend `clodura_enrichment_jobs`/`clodura_reveal_jobs` into the `enrichment_requests` umbrella (type, reveal/waterfall flags, webhook_url, idempotency_key, api_key_id).
- [ ] Encrypt `contact_methods.value`; add `hashed_email` matching path.
- [ ] Migration in BOTH `drizzle/schema.ts` AND `server/_core/rawMigrations.ts` (next: **0094**).

**Backend (tRPC)**
- [ ] `enrichment.person` / `people.bulk` (≤10) / `organization` / `organizations.bulk` (≤10) / `jobs.get` / `jobs.cancel` / `history` / `credits`.
- [ ] Idempotency-key dedupe; `credit_estimate_only` dry-run.
- [ ] Every mutation audits; every query filters by `ctx.workspace.id`.

**Queue / worker**
- [ ] Waterfall orchestrator (per-field vendor iteration, stop conditions, threshold, retry/backoff, partial success).
- [ ] Bulk fan-out under `daily_budget_cap`; reservation settlement on completion.

**Vendor abstraction**
- [ ] `EnrichmentVendor` interface `{ supports(field), fetch(identifiers, field) → Attempt, cost(field) }`.
- [ ] Adapters: `native_db`, `clodura`, `leadrocks`, `reoon` (validate), `scraper`, `google_places`, `unipile` (wrap existing `server/services/*`).
- [ ] Per-field ordered waterfall config (cost/reliability), per-workspace overridable.

**Webhook**
- [ ] Outbound signed (HMAC) delivery + idempotency (`request_id`) + exponential-backoff retry + `enrichment_webhook_deliveries` log.
- [ ] Inbound vendor callback (`/api/webhooks/enrichment-results`) settles results + ledger, fans out the customer webhook. (Reuse the Unipile webhook-secret pattern.)

**Credit ledger**
- [ ] Reserve → debit-on-success → release-on-fail; immutable ledger; balance materialization; monthly cap + per-action cost config; `GET /credits`.

**Compliance**
- [ ] Unified `checkEligibility` (permission, entitlement, credits, suppression×3, global-unsub, DNC, region, export, API scope); re-check in worker; typed reasons; no-charge-on-block.

**Frontend**
- [ ] `SingleEnrichmentForm`, `BulkEnrichmentModal`, `CreditPreviewPanel`, `WaterfallStatusBadge`, `EnrichmentJobProgress`, `EnrichmentResultsTable`, `SourceAttemptTimeline`, `FieldConfidenceBadge`, `WebhookDeliveryLog`, `EnrichmentHistoryDrawer` on `/v2/data-enrichment`.

**Testing**
- [ ] G/W/T suites from §12.
- [ ] Reveal-opt-in masking (no value/charge when `reveal=false`).
- [ ] Waterfall stop-condition + conflict-resolution correctness.
- [ ] Ledger reconciliation (reserve/debit/release/expire) + idempotency dedupe.
- [ ] Webhook retry/backoff + signature verification; cross-workspace isolation; bulk-cap enforcement.

---

### Appendix — provenance of functional references
`Apollo Screenshots/02_prospect-and-enrich/04_data-enrichment` — `00_data-health-center` (completeness donuts + stats), `01_crm` (CRM enrichment connect/upsell), `02_csv` (CSV upload→enrich), `03_job-change-alerts`, `04_form-enrichment` — ground the enrichment types (§1) and frontend surfaces (§10). Layout/UX only; no Apollo brand assets, icons, or protected design reproduced.
