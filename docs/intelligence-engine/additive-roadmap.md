# Intelligence Engine — Additive Roadmap

> **Only modifications/additions.** Everything not listed here already works and stays
> untouched. Ordered by data-quality risk retired per unit of change. Each phase is
> independently shippable and independently testable. No phase deletes anything; no phase
> changes an API contract; every migration is additive.
>
> Prerequisites for reading: [current-system-map.md](current-system-map.md),
> [gap-register.md](gap-register.md).

---

## Phase 1 — Route existing flows through existing machinery (no new infrastructure)

> **STATUS: SHIPPED 2026-08-11 (`6fcd917`).** All seven items, tested
> (`server/roadmapPhase1.test.ts`, +14). Open decision #4 resolved as
> "reroute the body" — the UI workflow was preserved. tsc baseline moved
> 331 → 330 (1.6 fixed a pre-existing type error).

The merge/normalize/dedup engines are built and tested; the work is closing the bypasses.
Highest value in the whole roadmap, near-zero new surface area.

| # | Change | Files touched | Risk retired |
|---|---|---|---|
| 1.1 | Discovery v2 `persistAsProspects` emits Candidates through `mergeAll` instead of raw field writes (existing-prospect updates only; fresh inserts keep current shape + gain ledger entries) | `services/discovery/consolidate.ts` | The blind overwrite that can downgrade a Reoon-verified email |
| 1.2 | Legacy `prospects.findContactInfo` routes through `runComprehensiveEnrichment` (or the People UI stops calling it in favor of `enrichFull`) — keep the procedure, change its body | `routers/prospects.ts` | Second unprovenance write path to `prospects` |
| 1.3 | LeadRocks import runs the house normalization at the mapping seam (`cleanPlaceholder`, `stripNameCredentials`, `normalizeJobTitle`, `canonicalizeCompanyDisplayName` + one canonicalizer snapshot) | `services/leadrocks.ts` or `routers/prospectImports.ts` | The one import path outside the normalization regime |
| 1.4 | The six raw account-creation paths populate `normalizedName`/`normalizedDomain` at insert (CSV import §3B, placesSearch, crm.create/convert, leadBridge, crmMatching) — column fill only, no behavior change | `routers/imports.ts`, `routers/placesSearch.ts`, `routers/crm.ts`, `services/leadBridge.ts`, `services/crmMatching.ts` | Majority of accounts invisible to dedup + matcher |
| 1.5 | One-time backfill (script or boot cron pass): compute `normalizedName`/`normalizedDomain` for existing accounts where NULL | small migration-style backfill | Same, for the existing rows |
| 1.6 | Fix the `source:"linkedin_enrichment"` type violation in `batchService.ts:298` (add to union or correct the value) | `services/prospectFromSource.ts` or `batchService.ts` | Off-vocabulary audit rows |
| 1.7 | Move the hardcoded `domain_derived:40` into the `CONFIDENCE` table | `fieldMerge.ts`, `comprehensivePass.ts` | "One place" rule leak |

Tests: extend existing import/dedup/merge suites; add LeadRocks mapping coverage (currently zero).

## Phase 2 — Company-side provenance + record sync (small additive schema)

| # | Change | Notes |
|---|---|---|
| 2.1 | **Migration 0153 (additive):** `accounts.field_provenance` json — same shape as prospects'. Company-writing paths that already reconcile (brandReconciler, future firmographic provider) record per-field entries; legacy values get the `preexisting` baseline exactly as fieldMerge does today. **Not** a new merge engine — reuse `fieldMerge.mergeField` (it is entity-agnostic already: field names are the only prospect-specific part) | Resolves "scalar-only company confidence" without a fourth vocabulary |
| 2.2 | `mergeAccounts` repoints `brand_observations` + `organization_enrichment_events` (and `prospect_linkedin_field_changes` where account-scoped) | 3 extra UPDATE statements in the existing merge |
| 2.3 | Job-change hook re-runs company association for the affected prospect (today `associateUnlinkedProspects` skips linked rows, so a champion who moves stays on the old account) — narrow: on `company_changed`, clear/re-evaluate that one prospect's link via the existing scored matcher | `jobChangeReengagement.ts` + `associationService` (new narrow entry, e.g. `reassociateProspect`) |
| 2.4 | Wire the dormant firmographic provider seam when a provider exists — **BLOCKED on the Zernio decision** (see Open Decisions). The mapping + updateCompanyFields code is done; add technologies dedupe when it goes live | `services/company/enrichmentService.ts` |

## Phase 3 — Signal unification (wiring, not architecture)

| # | Change | Notes |
|---|---|---|
| 3.1 | `brand_change_detected` also fires `fireWorkflowRules(ws, "signal_received", {signal:"brand_change", …})` — mirrors exactly what job-change already does | `brandReconciler.ts` (+1 test); rules UI already supports signal-gated rules |
| 3.2 | Persist prospect field-history: on `replaced` decisions, append `MergeDecision.previous` to the existing-but-dead `contact_enrichment_history`-shaped store — **decision needed**: reuse that table (rename-free) vs a small `prospect_field_changes` sibling of the LinkedIn changes table. Additive either way | Gives prospects the change-timeline companies and LinkedIn fields already have |
| 3.3 | (Optional, cheap) ARE signal → workflow bridge: emit `signal_received` for a small allow-list of `are_signal_log` types (`meeting_booked`, `email_reply`) so workflow rules can react. No vocabulary merge — just a producer | `routers/are/execution.ts:465` region |

## Phase 4 — Provider benchmarking (read-layer only)

| # | Change | Notes |
|---|---|---|
| 4.1 | Hit-rate report over data that already exists: GROUP BY `field_provenance.source` (winning values) + sweeper result JSONs + `linkedin_lookup_log` statuses → one tRPC query + one Data Health card | Zero new writes; answers "which provider earns its keep" |
| 4.2 | (Optional) persist per-pass outcomes: `comprehensivePass` returns `phases` — add a compact counters row (per workspace/day/provider: attempts, hits, credits) written where the sweeper already persists its result | Only if 4.1 proves insufficient; still additive |

## Phase 5 — Freshness + housekeeping (each item independently approvable)

| # | Change | Notes |
|---|---|---|
| 5.1 | Use `lastEnrichedAt` as an optional re-enrichment gate in the sweeper candidate query (currently attempt-marker only — rows enriched long ago are never revisited) | Turns a written-only column into the freshness input it was shaped for |
| 5.2 | Unify the two free-mail domain lists (`leadBridge.ts` private set → `CONSUMER_DOMAINS`) | Two-line change |
| 5.3 | Unipile email/calendar calls get the same cap/backoff treatment the LinkedIn family has | Protects against provider throttling |
| 5.4 | Document (not merge) the four confidence vocabularies in one reference doc; converging them is **explicitly out of scope** — they serve different decisions and merging would be a rewrite |
| 5.5 | Dead-inventory dispositions — **each needs explicit approval before removal**; default is leave-in-place: `dataCleanup` router (wire a UI or remove), 16 uncalled `companies.*` procedures (most are wire-a-UI candidates: `duplicates`/merge review deserves a surface), `organization_locations` (drop or feed), Clodura tables (see Open Decisions) |

---

## Explicitly NOT being built (already handled — see gap-register final table)

- Generic vendor-waterfall abstraction (comprehensivePass IS the waterfall)
- Cross-source conflict resolution engine (fieldMerge)
- Credit reservation ledger (sweeper budgeting suffices; public-API scope excluded)
- Per-attempt recording subsystem (report over existing data instead — Phase 4)
- Clodura execution-table revival
- Brand observations / reconciliation / brand change detection (shipped 2026-08-11)
- Brandfetch asset storage (ToS-prohibited)
- A unified single confidence scale across matcher/merge/brand (deliberate non-goal)
- A global person-identity layer (real gap, but a subsystem-scale project — out of scope until the owner asks; LinkedIn-URL keying inside workspaces covers current product needs)

## Open decisions (blocking specific items only)

1. **Zernio** (blocks 2.4): zero references in the repo. What does it provide, where are the API docs, and where should it sit in the waterfall? Needs credentials + docs.
2. **Clodura** (blocks 5.5 disposition): reinstate as a live source (new adapter emitting Candidates through `mergeAll`) or formally retire (tables stay, register it as retired)?
3. **Prospect field-history store** (blocks 3.2 shape): reuse dead `contact_enrichment_history` or add a `prospect_field_changes` sibling?
4. **`findContactInfo` legacy path** (blocks 1.2 approach): reroute its body, or retire the button in favor of `enrichFull`?
