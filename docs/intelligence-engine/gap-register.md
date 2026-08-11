# Intelligence Engine — Gap Register

> Classification of every target capability against the code at tip `8c93386` (2026-08-11).
> Vocabulary: **COMPLETE** · **PARTIAL** · **EXISTS BUT UNUSED** · **EXISTS BUT DUPLICATED** ·
> **NEEDS EXTENSION** · **MISSING** · **BLOCKED**.
> Evidence for every row is in [current-system-map.md](current-system-map.md).

## External sources

| Capability | Class | Notes |
|---|---|---|
| **Unipile** | **COMPLETE** (minor NEEDS EXTENSION) | Full surface live: LinkedIn profile/search/invites/posts, email + calendar adapters, 7 webhooks, social autopilot, sequences, ARE sourcing. Caps on the LinkedIn family only — email/calendar calls have no rate limit/backoff. Webhook endpoints accept unauthenticated POSTs when `UNIPILE_WEBHOOK_SECRET` unset (warns loudly). |
| **Clodura** | **EXISTS BUT UNUSED** (removed) | Integration deliberately removed; 5 dead tables + legacy `clodura_*` prospect columns preserved per the additive rules. Reinstating = a new adapter emitting Candidates through `mergeAll`. **Decision needed: reinstate or formally retire.** |
| **LeadRocks** | **PARTIAL** | Live CSV import path (format sniff, 14-slot email ranking, status mapping, linkedinUrl dedup). Gaps: bypasses the `recordNormalize`/`personName` regime; no API integration (CSV only); zero test coverage. |
| **Reoon** | **COMPLETE** | BYOK + env fallback, quick/power ladder, MX pre-gate, balance-aware sweeper budgeting, verdict→confidence mapping into the ledger. |
| **Zernio** | **MISSING + BLOCKED** | Zero references repo-wide — no adapter, no config, no docs. Blocked on owner input: what Zernio provides, API docs, credentials, and where it should sit in the waterfall. |
| **Brandfetch** | **COMPLETE** | Logo layer verified live on prod; Brand Search behind admin action + brand reconciler; ToS-compliant (hotlink-only, no stored bytes); structural guard keeps prospect enrichment away from it. Search client ID on prod not yet externally verifiable. |
| **Web/search intelligence** | **PARTIAL** | Discovery v2 (web/news/google_business/linkedin/apollo fan-out), site scraper + email patterns, Google Places (budget-enforced). Gaps: no firmographic provider for accounts; `organization_technologies`/`funding_events`/`locations` unpopulated; website visitor tracking never joined to companies (deliberate: no IP→company vendor); Discovery v2 persistence bypasses the merge layer. |

## Internal intelligence

| Capability | Class | Notes |
|---|---|---|
| **Source provenance** | **PARTIAL** | Prospects: COMPLETE (field_provenance ledger, 13-level CONFIDENCE, UI chips, 17 tests; one leak — `domain_derived:40` hardcoded outside the table). Accounts: scalar `brand_confidence` only, no per-field ledger. Contacts: none (`contact_enrichment_history` shaped for it, dead). `prospect_queue`: none. |
| **Observations / evidence** | **PARTIAL** | `brand_observations` (companies) and `prospect_linkedin_enrichments`+snapshots (people) are complete evidence stores; `enrichment_data`/`domain_scrape_cache` hold raw payloads. No unified observation model across entity types — acceptable; the two live models are consistent internally. Dead evidence tables listed in the map §8. |
| **Canonical contact/company values** | **PARTIAL / EXISTS BUT DUPLICATED** | `recordNormalize` + `companyCanonical` + `mergeAll` form the canonical pipeline — but 4 paths bypass it (Discovery v2 persist, LeadRocks import, `findContactInfo` legacy, ARE queue writeback) and 6 of 7 account-creation paths skip `normalizedName/normalizedDomain`, making rows invisible to dedup/matching. |
| **Identity resolution** | **PARTIAL** | Company side: scored matcher + global orgs + alias tables + auto-link policy = solid. Person side: workspace-local only, no global person identity, LinkedIn URL is de-facto key without a unique index, **four** parallel person-dedup implementations, **two** parallel account-resolution paths (`crmMatching` vs `matchingService`). |
| **Reconciliation** | **COMPLETE where wired / EXISTS BUT DUPLICATED at seams** | `fieldMerge` (prospects) and `brandReconciler` (company brand) are both complete observations→decision engines with tests. Duplication: read-repair re-implements merge rules; Discovery v2 blind-overwrites; sweeper passes 2–3 write directly. |
| **Enrichment orchestration** | **PARTIAL** | `comprehensivePass` is the intended single entry with correct provider ordering and per-phase error isolation; sweeper budget accounting is complete (40 tests). But 5+ paths bypass the pass (see canonical-values row). |
| **Change detection** | **PARTIAL / EXISTS BUT DUPLICATED** | LinkedIn field snapshots/diffs COMPLETE. Brand change: event only — fires no workflow rule (unlike job change). Prospect field-change timeline: MISSING — `MergeDecision.previous` computed then discarded. Three mechanisms share no abstraction (acceptable) but signal emission is inconsistent. |
| **Company web intelligence** | **PARTIAL** | Logo pipeline + brand identity live. Firmographic enrichment has a mapped provider seam (`mapProviderOrganizationToVelocitySchema`) with **no provider behind it** (EXISTS BUT UNUSED); technologies/funding/locations tables unpopulated; visitor→company join absent. |
| **Sales signals** | **PARTIAL / EXISTS BUT DUPLICATED** | Two disconnected systems: workflow `signal_received` (sole producer: `job_change`) and ARE `are_signal_log` (15 types, own consumers: metrics, hook enhancement, meeting dedupe). No shared vocabulary. Brand change and ARE signals cannot drive workflow rules. |
| **Provider benchmarking** | **MISSING** | Spend fully tracked per provider (Reoon quick/power, QuickEnrich, LinkedIn slots, Apollo derived-usage, LLM tokens). Quality/hit-rate comparison absent: `phases` outcomes discarded; `field_provenance.source` already stores winning-source-per-field (report is one GROUP BY away); `linkedin_lookup_log` is audit-only. |
| **Freshness / confidence** | **PARTIAL / EXISTS BUT DUPLICATED** | TTLs exist per subsystem (LinkedIn 30d, brand 30d + 7d negative, scrape cache 30d, daily-check 24h) but `lastEnrichedAt` (×3 tables) is written and never read as a gate. Four disconnected confidence vocabularies (fieldMerge, brandReconciler thresholds, matchingService points, link confidence decimal). Two email-verification models with different status vocabularies (`prospects.emailStatus` valid/accept_all/… vs `contacts.emailVerificationStatus` safe/catch_all/…). |
| **Synchronized contact/company records** | **PARTIAL** | Live: read-repair, mergeAll writeback, microsoftBridge (self-healing), leadBridge, prospectPromotion, association backfills. Gaps: prospect enrichment never updates accounts; already-linked prospects with changed employer stay linked to the old account; account merge orphans evidence tables (`brand_observations`, `organization_enrichment_events`, `prospect_linkedin_field_changes`); account enrichment propagates nothing to people. |

## Notable EXISTS-BUT-UNUSED inventory (full list in map §8)

- Apollo paid `/people/match`: complete implementation, admin-only router, **no UI caller**.
- Firmographic provider mapping seam: complete, nothing feeds it.
- 16 `companies.*` tRPC procedures without client callers (incl. `duplicates`, `update`, `linkContact`, logo mutations).
- `contact_enrichment_history`: the contacts-side provenance table, unwired.
- `lastEnrichedAt` as an input; `MergeDecision.previous`; `companyLogoAssets.creditsUsed`.

## Previous-proposal items ALREADY HANDLED — do **not** build

From `docs/specs/enrichment-system.md` (the waterfall spec, written against the removed
Clodura stack) and the 2026-08-11 Brandfetch briefing:

| Proposal item | Verdict | Where it lives now |
|---|---|---|
| Generic vendor waterfall orchestrator (`EnrichmentVendor` interface, per-field iteration) | **Do not build** | `comprehensivePass.ts` IS the waterfall — ordered, budget-aware, phase-isolated. Extend it; do not wrap it in a generic interface. |
| Cross-source conflict resolution | **Do not build** | `fieldMerge.ts` — confidence table, corroboration, Reoon-valid lock, recency. |
| Per-attempt records + validations tables | **Do not build as specced** | `phases` + `linkedin_lookup_log` + `field_provenance` carry the data; the benchmarking gap (roadmap P4) is a *report*, not a new attempt-recording subsystem. |
| Credit ledger with reservations/estimates | **Do not build** | Sweeper budget accounting (balance read + local decrement + credit floor + caps) covers every live need. A reservation ledger only matters for the public-API spec, which is out of scope here. |
| Reviving `clodura_*` execution tables | **Do not build** | Integration removed; tables preserved as legacy per additive rules. |
| Brand observations / canonical brand identity / change detection (Brandfetch briefing) | **Built** | Migration 0152 + `brandReconciler.ts` (2026-08-11). |
| Storing Brandfetch assets ("store copies when permitted") | **Do not build — prohibited** | Their ToS forbids it; hotlink architecture shipped and live. |
| Native-DB-first lookup via `clodura_search_cache`/`domain_scrape_cache` | **Half-superseded** | `domain_scrape_cache` live (30d); the Clodura cache is dead. |
| `hashed_email` identifier, API scopes, webhook completion, bulk-of-10 contract | **Out of scope** | Belong to the public developer-API spec (spec #9), not the intelligence engine. |
