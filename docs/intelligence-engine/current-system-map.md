# Intelligence Engine — Current System Map

> **Audit date:** 2026-08-11 · **Tip audited:** `8c93386` · **Method:** three parallel full-repo
> traces (contact lifecycle, company lifecycle, cross-cutting intelligence + providers), every
> claim carries a `file:line` reference.
>
> Companion docs: [gap-register.md](gap-register.md) (capability classifications),
> [additive-roadmap.md](additive-roadmap.md) (delta plan — the ONLY things to build).

---

## 1. The record tables

| Table | Role | Provenance? |
|---|---|---|
| `prospects` (`drizzle/schema.ts:3810`) | outbound-prospecting person record | **Yes** — `field_provenance` json (migration 0151) |
| `contacts` (`schema.ts:210`) | CRM contact | No ledger; own email-verification columns |
| `leads` | CRM lead | No |
| `prospect_queue` (`schema.ts:3421`) | ARE campaign discovery queue | **No** — plain overwrite |
| `accounts` (`schema.ts:142`) | workspace company record | Scalar only — `brand_confidence`/`brand_verified_at`/`brand_override` (migration 0152) |
| `global_organizations` (+`organization_domains`, `account_domains`) | cross-workspace company identity | No |

There is **no global person identity layer** — person identity is workspace-local and split
across three tables. LinkedIn URL is the de-facto person key in several places
(`prospect_linkedin_enrichments` unique index, QuickEnrich, discovery dedupe, ARE dedupe) but
`prospects.linkedin_url` itself has **no unique index**.

---

## 2. CONTACT IMPORT — four structurally distinct paths

### 2A. Generic CSV import (`server/routers/imports.ts`) — the gold path
- **Trigger:** ImportContacts wizard → `imports.parseCSV/validateRows/commit`; destination `contacts|prospects`.
- **Normalization:** full `recordNormalize` regime per row (`mapRowToContact`, `imports.ts:50-74`): `cleanPlaceholder`, `stripNameCredentials`, `normalizeJobTitle`, `canonicalizeCompanyDisplayName`, one `companyCanonical` snapshot per run.
- **Dedup:** `classifyImportRow` (`imports.ts:174-254`) — email primary; name+company opt-in.
- **DB writes:** `contact_imports` header → bulk account resolve/create (`:601-721`, see §3B defect) → `contacts`/`prospects` in 500-row chunks with per-row fallback → `contact_import_rows` audit.
- **Deliberate contract:** `enrichmentData` left NULL on insert — it is the sweeper's "not yet attempted" marker.
- **Error handling:** width clamps everywhere; account-resolution failure swallowed so contacts land unlinked; mapping errors reject before anything is written.
- **Tests:** 7 dedicated test files.

### 2B. LeadRocks CSV import (`server/routers/prospectImports.ts`) — live, wired
- `services/leadrocks.ts` **is not orphaned**: called from `prospectImports.ts:32-35`, driven by `ProspectImportDialog.tsx`, mounted from the Prospects page.
- Format-sniffed (`looksLikeLeadRocks`); best-of-14-email-slots ranking; LeadRocks status → usip email status.
- **Dedup:** `linkedinUrl` only (in-file + against `prospects`).
- ⚠️ **Bypasses the `recordNormalize` regime entirely** — no placeholder cleaning, no title/company canonicalization, no credential stripping. The one import path outside the house normalization.
- No test coverage.

### 2C. Search-hit / scrape-derived creation (`services/prospectFromSource.ts`)
- Shared builder used by `linkedinFinder.saveSearchHits/saveAsProspect`, `placesSearch`, `urlScraper`, `linkedinEnrichment/batchService`.
- Drops non-LinkedIn URLs from `linkedinUrl` so they can't poison 2B's dedup key.
- **Dedup: none — all four call sites insert unconditionally.**
- 🚩 `batchService.ts:298` passes `source:"linkedin_enrichment"` which is **not in the `ScrapedProspectSource` union** — type violation producing an off-vocabulary audit entityType.

### 2D. ARE discovery → `prospect_queue` (`server/areEngine.ts:941`)
- 3-min cron; all **7 declared sources in `shared/areSources.ts` are genuinely run** (vocabulary is clean); dead ids (`ai_research`, `events`) normalized away.
- **Dedup:** three keys (`e:email`, `u:linkedinUrl`, `n:name@org`), seeded per campaign, applied within-tick.
- Writes `are_scrape_jobs` + `prospect_queue` (LLM-placeholder cleaning, width clamps, per-row fallback).
- `prospect_queue.sourceType` enum still carries dead values `zoominfo`, `clay`, `ai_research`.

### 2E. Discovery v2 → `prospects` (`services/discovery/consolidate.ts:249`)
- Fan-out (`Promise.allSettled`, per-source `discovery_logs`) → cluster → score → `persistAsProspects`.
- **The single largest bypass of the provenance regime:** writes raw fields straight to
  `prospects` (`:297-333`) — no `fieldMerge`, no `field_provenance`, no `recordNormalize` — and
  can overwrite a Reoon-verified email with lower-quality data.

---

## 3. COMPANY IMPORT / CREATION — seven paths, one canonical

### 3A. Canonical: `createWorkspaceAccount` via `associationService` + `matchingService`
- Chain: `companyInputFromProspect` → `findWorkspaceAccountMatch` (scored: domain +100, LinkedIn +95, exact name +50, fuzzy +35, conflicting domain −50) → auto-link policy (exact/high → link; possible → link + `needs_review`; conflict → unlinked + `conflict`; no match → create).
- Writes: `accounts`, `account_domains`, `global_organizations` + `organization_domains`, prospect linkage, `contact_account_links`, system activity. Never throws into ingestion.
- Candidate fetch is **index-driven on `normalizedName`/`normalizedDomain`** — rows missing those are invisible to it.

### 3B–3G. The six raw paths (all skip normalization → invisible to dedup/matcher)
| Path | Site | Missing |
|---|---|---|
| CSV import account resolve | `imports.ts:600-720` | own private `normDomain`; raw-column matching; **no `normalizedName/normalizedDomain`, no global org, no links** |
| Google Places save | `placesSearch.ts:218` | hand-rolled domain set dedup; no normalization |
| Manual CRM create | `crm.ts:299` (+`crm.convert:1087`) | spreads input raw |
| leadBridge find-or-create | `leadBridge.ts:68` | raw domain/name match; private FREE_MAIL list |
| crmMatching find-or-create | `crmMatching.ts:49` | raw name match |
| Prospect-import / discovery sweeps | fire-and-forget `associateUnlinkedProspects` | (these DO use the canonical path — but only for unlinked prospects) |

**Consequence:** `findDuplicateAccounts` groups only by `normalizedDomain` — accounts created by
the raw paths **can never be reported as duplicates and can never be matched**. In a
CSV-importing workspace that is the majority of rows.

**Merge:** `mergeAccounts` repoints 7 tables but **not** `brand_observations`,
`organization_enrichment_events`, or `prospect_linkedin_field_changes` — a merged account
orphans its evidence history.

---

## 4. CONTACT ENRICHMENT

### 4A. Manual single — `prospects.enrichFull` → `runComprehensiveEnrichment`
Provider order (`comprehensivePass.ts`): suppression gate → inline LinkedIn retrieve if stale
(30-day freshness, user-initiated match bonus) → harvest stored-profile candidates (+ headline
parse @60, email-domain derivation @70) → Apollo org-search domain (0 credits) → QuickEnrich
(LinkedIn-keyed, hit Reoon-power-verified) → pattern+Reoon ladder (free MX gate first; quick
stage A, power stage B, early-stop on valid) → site scrape (phone/socials, `skipIfHasEmail`) →
`domain_derived` @40 → **`mergeAll`** (one UPDATE, width-clamped, ledger + `emailStatus`).
Every provider individually try/caught into a human-readable `phases` record.

### 4B. Manual bulk — `findContactInfoBatch` (chunks of 10, ≤25/call)
Same pass with `queueLinkedInJob:false` (protects the 100/day cap); returns `needsLinkedIn` so
the client queues exactly **one** orchestrator job for the union.

### 4C. LinkedIn orchestrator (`linkedinEnrichment/orchestrator.ts`)
Job tables → health gate → compliance gate → 5-tier lookup strategy → retrieve (dead-slug
fallback) → `scoreIntendedMatch` (≥75 auto / 50-74 single-run only / conflict never) →
`applyEnrichment`: upsert `prospect_linkedin_enrichments`, **write-back through `mergeAll`**,
snapshot+diff → `prospect_linkedin_field_changes`, photo mirroring (≤43KB data URI,
user-uploads never touched), fire-and-forget scoring recalc + job-change hook.
`LINKEDIN_DAILY_CAP=100`/account, atomically reserved (`reserveSlot`), refunded on vendor
failure; every attempt logged (`linkedin_lookup_log`). People-**search** is uncapped;
profile-**fetch** is capped.

### 4D. Legacy single — `prospects.findContactInfo` 🚩
Calls `lookupContactInfo` **directly**: persists straight to `prospects`, bypassing
`fieldMerge`/provenance. Its own audit entry names itself `scraper.findContactInfo`.

### 4E. Automatic — the sweeper (`enrichmentSweeper.ts`)
6h cron, 20h re-run gate, `auto` mode only; manual button refuses when `off`. Budget: one
balance read, local decrement, `CREDIT_FLOOR=25` reserved for interactive use, cap clamp
(1..1000, default 50). Pass order: free Apollo domain resolve → QuickEnrich queue rows → ARE
queue pattern+Reoon → prospects comprehensive pass (→ `promoteProspectRow` on found email).
Pass-specific attempt markers (incl. the `quickenrich…`-prefixed marker). Result JSON always
persisted (`stoppedBecause` vocabulary) — 40 tests execute the real sweeper.
⚠️ Passes 2–3 call resolvers **directly** (no mergeAll — queue rows have no ledger).

### 4F. Automatic — ARE per-prospect agent (`are/prospects.ts:171`)
Serial, bounded, `icpMatchScore` gate. One LLM dossier → `prospect_intelligence`; email chain:
headline → inferred company → Apollo domain → pattern+Reoon. **Writes `prospect_queue` by
plain assignment — no provenance** (the table has no ledger column). Retryable LLM errors
revert to `pending`.

### 4G. Read-repair (`prospects.ts:488-572`)
Per-render heal: fills blank company/domain from stored LinkedIn profile → headline parse →
email domain; repairs credential-split name pairs. Uses the shared `CONFIDENCE` constants but
**re-implements** the merge (fill-if-empty only) with hand-rolled ledger writes.

---

## 5. COMPANY ENRICHMENT

### 5A. Manual (`companies.enrich` → `enrichCompany`)
**There is no firmographic provider.** The provider mapping seam
(`mapProviderOrganizationToVelocitySchema` → `updateCompanyFields`, 12 columns +
technologies) exists and is tested by nothing — the UI never sends `provided`. The default
branch derives `websiteUrl` + a Google-S2 favicon and stamps `dataStatus='enriched'`. Every
call logs an `organization_enrichment_events` row. Technologies insert has **no dedupe**
(repeat enrichment would append duplicates) — currently unreachable anyway.

### 5B. Automatic crons (`server/_core/index.ts`)
| Cron | Cadence | What |
|---|---|---|
| LogoBackfill (+9min, 6h) | `logoBackfill.ts` limit 50 | manifest/apple-touch icon discovery → jimp → ≤60KB PNG data URI → `accounts` + `company_logo_assets`; terminal `unavailable` state |
| **BrandReconciler** (+12min, 6h) | `brandReconciler.ts` | Brand Search sweep ≤40 @1.5s; observations → score (domain-exact 95-99, name-only ≤94, conflict ≤79) → decide (95/80/60 bands, override supremacy) → `brand_observations` + conditional `accounts` writes + enrichment-history events incl. `brand_change_detected`. Dormant without `BRANDFETCH_SEARCH_CLIENT_ID`. |
| CompanyBackfill (+18min, 6h) | queue-row LinkedIn company backfill | breaks on `rate_limited`, per-status breakdown |

### 5C. Client logo cascade — `CompanyLogo.tsx`
4 tiers: Brandfetch CDN (client-built URL, `fallback:404`, theme-aware) → stored logo →
favicon → initials. Tier advance on `onError`. `CompanyAvatar` is a documented compat shim.

---

## 6. PROVIDERS — the matrix

| Provider | Status | Config | Live call sites |
|---|---|---|---|
| **Unipile** | LIVE, broadest surface | `UNIPILE_API_KEY`+`UNIPILE_DSN` (+optional `UNIPILE_WEBHOOK_SECRET` — endpoints accept unauthenticated POSTs when unset) | LinkedIn profile/search/invites/relations/posts, email adapter, calendar adapter, 7 webhooks, social autopilot, sequences, ARE sourcing, MS bridge. Caps: 100/day profile fetch (atomic), 20/day invites, 50/day openers. **No cap/backoff on email or calendar calls.** |
| **Reoon** | LIVE | BYOK `reoonApiKeyEnc` → env fallback | quick/power ladder in scraper, comprehensive pass, sweeper; balance-aware budgeting |
| **QuickEnrich** | LIVE | BYOK + daily pull cap | comprehensive pass, sweeper, ARE discovery source |
| **Apollo (search)** | LIVE, 0-credit only | BYOK + daily cap | domain resolve ×3 call sites; ARE people search |
| **Apollo (paid match)** | EXISTS BUT UNUSED | same key | only `dataCleanup.ts` router — **no client caller anywhere**; `dryRun` defaults true |
| **LeadRocks** | LIVE (CSV parser, no API) | none | `prospectImports` — see §2B normalization gap |
| **Brandfetch** | LIVE (logo) / config-dependent (search) | 2 client IDs; logo verified live on prod | logo = client hotlink only; search = admin action + brand reconciler |
| **Google Places** | LIVE, budget-enforced | 2¢/call ledger + notifications | placesSearch router |
| **Web scrape/patterns** | LIVE | Reoon key | `resolveVerifiedEmail` + `lookupContactInfo` (MX gate first, role-account demotion, SSRF guard, 30-day domain cache) |
| **Clodura** | REMOVED — legacy schema preserved | — | 5 dead tables, prospect `clodura_*` columns, cascade-delete refs only |
| **Zernio** | **ZERO references repo-wide** | — | — |

---

## 7. CROSS-CUTTING INTELLIGENCE (summary — see gap-register for classifications)

- **Provenance:** prospects COMPLETE (13-level `CONFIDENCE`, 4 merge actions, corroboration,
  Reoon-valid lock, legacy baseline, UI chips, 17 tests). One leak: `domain_derived:40`
  hardcoded outside the table. Accounts: scalar-only. Contacts: none (the shaped-for-it
  `contact_enrichment_history` table is dead).
- **Confidence systems:** **four** disconnected numeric vocabularies — fieldMerge 0-100,
  brandReconciler 0-100 (own thresholds), matchingService additive points,
  `contactAccountLinks.confidence` decimal.
- **Freshness:** per-subsystem TTLs exist (LinkedIn 30d, brand 30d/7d, scrape cache 30d,
  daily-check 24h). `lastEnrichedAt` on prospects/accounts/global orgs is **written but never
  read as a gate** anywhere.
- **Change detection:** three mechanisms (LinkedIn snapshots/diffs — complete; job-change →
  workflow signal + autopilot; brand change → event only, **no workflow rule**). Prospect
  field-level change history is discarded (`MergeDecision.previous` computed, never persisted).
- **Signals:** two unrelated systems. Workflow `signal_received` has exactly ONE producer
  (`job_change`). ARE `are_signal_log` has 15 types and its own consumers. No shared
  vocabulary, table, or code path.
- **Benchmarking:** spend is tracked end-to-end (Reoon quick/power, QuickEnrich, LinkedIn slot
  counter, LLM token metering). **Per-provider hit-rate/quality comparison does not exist** —
  the `phases` outcome record is returned to the UI and discarded, though
  `field_provenance.source` already stores the winning source per field (a report is one
  GROUP BY away).
- **Record sync:** read-repair, enrichment writeback, microsoftBridge (self-healing),
  leadBridge, prospectPromotion, association backfills all live. Absent: prospect enrichment
  never updates accounts; an already-linked prospect whose employer changes **stays linked to
  the old account** (`associateUnlinkedProspects` filters `accountId IS NULL`); account
  enrichment propagates nothing back.

---

## 8. Dead / unpopulated inventory (candidates for wiring or approved removal)

| Item | State |
|---|---|
| `clodura_search_cache`, `clodura_saved_searches`, `clodura_reveal_jobs`, `clodura_enrichment_settings` | 0 references |
| `clodura_enrichment_jobs`, `contact_enrichment_history` | cascade-delete references only |
| `organization_locations` | 0 readers, 0 writers |
| `organization_funding_events` | read by profile, **zero writers** |
| `organization_technologies` | writer unreachable (needs `provided.technologies`; no caller sends it); the fit-score comment claiming it's consumed is wrong — scoring reads JSON fields instead |
| `routers/dataCleanup.ts` | entire router: no client caller |
| 16 `companies.*` procedures | no client caller (incl. `update`, `duplicates`, `linkContact`, logo mutations) |
| `lastEnrichedAt` ×3 tables | written, never read |
| `retrieveLinkedInProfileByIdentifier`, `reoonCreateBulkTask/GetBulkResult`, `companyLogoAssets.creditsUsed`, LeadRocks `hasPhone`/`emailRawStatus` | computed/exported, unused |
