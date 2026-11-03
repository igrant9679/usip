# Prospect sources — registry, waterfall, budget ledger

How Velocity gets prospect data from external vendors, and how to add one.
Everything lives in `server/services/prospectSources/`; the shared
vocabulary is `shared/prospectSources.ts`; the UI is the **Source search**
tab of Data Enrichment plus the cards under Settings → Data sources.

## The model in one paragraph

Every vendor is a plugin implementing `ProspectSource`. It declares a
**capability manifest** (which filters it honours natively, which it only
approximates, whether preview is free, whether previews mask the email,
coverage). A search runs down the workspace's sources **in order and stops
at the batch target** (the waterfall), skipping any source without a key,
without the filters the query needs, over budget, or paused by its circuit
breaker. Dedupe against People and every campaign queue runs **before** any
billable step. Units are **reserved** in the budget ledger before a vendor
call and **committed** to what the vendor actually charged; each vendor
declares its own reset semantics. One vendor failing degrades a run, never
fails it.

## Files

| File | Role |
|---|---|
| `shared/prospectSources.ts` | `FilterType`, `SourceCapabilities`, `SearchCriteria`, `matchCapabilities`, `filterUnion`, `rankSourcesForQuery`, the slug list |
| `types.ts` | `ProspectSource` interface + DTOs (`ProspectRecord`, `SearchResultPage`, `AcquisitionResult`, `BudgetSnapshot`, `BudgetPeriod`, `VendorFailure`) |
| `registry.ts` | `SOURCE_FACTORIES` (slug → adapter), `describeSources` (UI), `eligibleFor` (the waterfall's input) |
| `executor.ts` | `runWaterfall` — the loop; `mergeAcquired` |
| `ledger.ts` | `reserve` / `commit` / `release` / `remainingUnits` / `markExhausted` over `prospect_source_budget_ledger` |
| `credentials.ts` | encrypted per-workspace credentials (`prospect_source_credentials`) + legacy resolvers for Apollo/QuickEnrich |
| `circuit.ts` | per-workspace, per-vendor breaker (3 failures → 15 min, doubling to 2 h) |
| `dedupe.ts` | identity keys shared with `services/are/queueIdentity` + the workspace-wide `Deduper` |
| `vendorHttp.ts` | the one outbound HTTP path: classification, retry/backoff honouring Retry-After, safe log line |
| `bridge.ts` | campaign targeting → `SearchCriteria`; `ProspectRecord` → queue/raw-find row |
| `searchRuns.ts` | staged searches (`prospect_search_runs` / `_results`), promotion into People, maintenance |
| `adapters/warmysender.ts` | MCP (leads) + REST (verification) client and adapter |
| `adapters/quickenrich.ts`, `adapters/apollo.ts` | thin adapters over the existing clients |
| `adapters/leadocean.ts` | REST client and adapter; the one source that bills its previews |
| `adapters/stubs.ts` | Hunter, Lemlist — registered, `not_implemented` |
| `server/routers/prospectSources.ts` | tRPC surface |

Consumers: `areEngine.runDiscovery` (campaign discovery is now a waterfall
across **all** sources; the `warmysender` branch calls the registry) and the
Source search page.

## Adding a vendor

1. Add the slug to `PROSPECT_SOURCE_SLUGS` in `shared/prospectSources.ts`.
   If campaigns should be able to tick it, also add an entry to
   `shared/areSources.ts`, a branch in `areEngine.runDiscovery`'s
   `taskFactories` (the `Record` type makes a missing branch a compile
   error), the `sourceType` enum on `prospect_queue` and `are_scrape_jobs`
   (migration + schema — the enum-insert class), and the mapping in
   `routers/are/scraper.ts`.
2. Write `adapters/<slug>.ts` returning a `ProspectSource`:
   - `capabilities(creds?)` — declare honestly. A filter the vendor only
     keyword-matches is *approximated*, not supported; the UI shows it as a
     weaker match and the ranker prefers native sources for that filter.
   - `budgetPeriods({ now, credentials })` — the ledger rows that apply
     right now. Return `[]` if the vendor is metered elsewhere (legacy
     daily pull caps) and report headroom through `remainingBudget()`.
   - `search()` — free where the vendor allows; set `alreadyCharged: true`
     when it is not, and the executor skips `acquire()`.
   - `acquire()` — billable; return `unitsSpent` as the vendor charged it.
   - `validateCredentials()` — return `discovered` facts (scopes, tier,
     schemas) and they are merged into the credential's config.
   - `acquisition: "on_demand" | "none"`; `credentialMode: "table" | "legacy"`.
   - Use `vendorFetch` for every call. Never log a key or a response body.
3. Add one line to `SOURCE_FACTORIES` in `registry.ts`.
4. Add a settings card if the vendor needs configuration beyond a key
   (copy `WarmySenderSourceCard.tsx`), and mount it in `SettingsHub.tsx` and
   `ARESettings.tsx`.
5. Pin the wiring in `server/prospectSources.test.ts` ("wiring" block).

Nothing in the search page, the executor or the ledger changes.

## Dedupe keys

`e:<email>` (never a masked one) · `u:<linkedin slug>` · `n:<canonical name>@<domain or company>`.
Exact after normalisation, never edit-distance. Vendors with masked
previews rely on keys 2–3, which is why LinkedIn URL and name+domain matter.

## Budget ledger

Row = (workspace, source, bucket, granularity, periodKey). `unitsReserved`
is held by in-flight runs; `unitsConsumed` is spend. Reservation is a
conditional `UPDATE … WHERE unitsLimit IS NULL OR consumed + reserved + n <= limit`
— `affectedRows` is the verdict, so concurrent runs cannot oversell. Plan
rows (daily, monthly) must all admit a hold; otherwise the credits row is
tried (purchased credits skip the daily pace). A vendor refusal for
allowance closes today's row (`markExhausted`). Stale holds (> 2 h) are
released by the 6-hourly maintenance.

Reset semantics per vendor:

- **WarmySender leads** — monthly on the billing anniversary (configured on
  the card; calendar month when unknown), paced daily at ⌈monthly/30⌉;
  purchased credits never expire. The vendor publishes no remaining-lead
  endpoint, so leads are tracked from what Velocity spends.
- **WarmySender verification** — `GET /verification/allowance` is
  authoritative; the ledger mirrors local spend.
- **QuickEnrich** — uncapped by credits (no balance endpoint); the existing
  daily pull cap (`workspace_settings.quickenrichDailyPullCap`, metered via
  `are_scrape_jobs`) is the brake.
- **Apollo** — search-only, zero credits; existing daily record cap.
- **LeadOcean** — no ledger rows (`budgetPeriods` is empty), because a preview spends too and the ledger only holds units for an acquiring run. The optional daily cap on people pulled reads today's `search_records` from `spend_ledger`; plan and limits are read from `GET /v1/account`, never assumed.

## LeadOcean specifics (read from the spec 2026-11-02, not yet run against a real key)

- Base `https://api.leadocean.io`, header `x-api-key`. Spec at `/openapi.json`, prose at `/llms-full.txt`. Per-workspace key only: `credentialMode: "table"`, no env fallback, and status reads return `configured` with no masked value (`writeOnlyKey`).
- **A person costs two records:** one search row, one lookup. `supportsFreePreview` is false, so the source is opt-in everywhere: `ARE_OPT_IN_SOURCES` keeps it out of `ARE_DEFAULT_SOURCES` (the new-campaign default and the fallback for a null source list), `eligibleFor` skips it unless a run names it, and Source search starts it unticked. The executor adds `page.unitsSpent` to the lookups and does not overfetch it. `alreadyCharged` stays false because the row is not the deliverable.
- **Free calls, in order, per `search()`:** `/v1/account` (held if paced), then `count=true, limit=1` (refuses when `meta.unsupportedFilters` names a filter, because LeadOcean returns the rows anyway, unfiltered on it). A company-side filter such as `hqState` is dropped when it matches more than 50,000 employers: add an industry or company size. `meta.total` null with `totalWithheld.reason: viewed_set_too_large` is not a refusal.
- **No stored cursors.** `search()` walks pages internally (`order=stable` on every page, `limit` at most 100, a short `walkCapped` page continues, 410 restarts) and always returns `nextCursor: null`. What moves a campaign forward between ticks is the viewed list, named per workspace (`velocity-ws-<id>`), because lists live on the LeadOcean account and one key may serve several workspaces. Every delivered row is marked; a lookup that never ran forgets its person again. A deploy between the search and its lookups strands at most that page, whose rows are already billed. Source search keeps its stagings reachable: an earlier run can be reopened and promoted from.
- **State:** there is no person-level filter, so `stateProvince` is approximated and sends `hqState` + `hqCountry`. Each row records `rawSourcePayload.placeCheck` (inside / outside / unknown) from `profile_data.profile_address`, whose shape the spec does not give, using `placeFit`. The campaign's screen drops `outside` before the lookup.
- **Which lookup:** `/v2/people/email/work` by default (one address, verified / catch_all_valid / catch_all, never a phone). The spec does not mention AppSumo's phone-reveal meter at all, and says `/v1/people/enrich` with `reveal_email` returns every email and phone, so that door may spend one. It runs only when phones are on or an accepted status is one the work door never returns. A thin row has no name, so it first takes `/v1/people/enrich` with `reveal_email: false`, then the work door: two records instead of one. A lookup billed with nothing to take is remembered on the staged row (`noAddressFound`), so promoting it again cannot buy it twice.
- **Statuses:** `verified` by default. `invalid`, `disposable`, `spam_trap` and `abuse` are never accepted, in the settings vocabulary, the search filter or the address check. Search's status is an upper bound, so the address is checked again on the lookup. `emailVerifiedAt` stays null: Velocity's own gate decides what can be mailed.
- **Limits:** `X-Quota-State`, `meta.notice`, 429 `fair_use_paced` and 429 `key_quota` all read as held: not retried (`vendorFetch`'s `noRetry`), no breaker (`VendorFailure.held`), and the engine waits until the reset instead of recording an empty run. A paced 200 keeps the rows already paid for and adds a note. A 429 asking for more than a few seconds reads as a pace even with no header or code. A hold during lookups still queues who was bought, and the source waits. A tick where nothing was asked does not count as an empty run. 402 is `budget_exhausted`, and on a plan that refuses past its records a search buys only the rows it can afford to look up (half of what is left). 401 and 403 mark the key invalid.
- **Test connection** only reads `/v1/account` and `/v1/usage`, so it can run on save and in the six-hourly maintenance without spending. Only an allowlist of the account document is stored: the same read holds the account's email and the key's prefix, and credential config is visible to every workspace member.

## WarmySender specifics (verified 2026-09-14)

- REST base `https://warmysender.com/api/v1` (OpenAPI at `/api/v1/openapi.json`,
  public). **No leads endpoints exist in REST**; the leads database is only
  on the MCP server `POST https://warmysender.com/mcp` (Streamable HTTP,
  JSON-RPC 2.0, same `ws_…` bearer key). The adapter runs
  `initialize` → `tools/list` → `tools/call`.
- Tools: `search_leads` (leads:read, free, masked), `save_leads` /
  `export_leads` (leads:write, 1 unit per new lead). The adapter acquires
  with `export_leads`.
- Tool parameter names are only visible with a key: **Test connection**
  captures the schemas into the credential config, and the argument
  builder maps filters onto them (tolerant candidate names, documented
  names as fallback). Job title is *approximated* until a captured schema
  proves a native title parameter — then it is promoted.
- Rate limits: REST 60/240/480 per minute per workspace by plan (`Retry-After`);
  MCP read 120/min, write 30/min, bulk 5/min (`retry_after_seconds`).
- Errors: `{ error: { code, message } }` — `unauthorized`,
  `insufficient_scope` (terminal, reissue the key), `rate_limited`,
  `allowance_exhausted`, `exceeds_today`, `verifier_access_required`.
- Coverage: US + Canada deepest; business phones only (`supportsMobilePhone: false`).
