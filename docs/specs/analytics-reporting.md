# Technical Spec — Analytics / Reporting Query Engine

> **Component:** A single, queryable reporting engine — `metrics × group_by × pivot_group_by × filters × date_range` → flat totals, grouped reports, and pivot/cross-tabs — that powers dashboards and ad-hoc reports from one place.
> **Status:** Design spec (hybrid). Canonical, provider-agnostic design + a **Velocity mapping & delta** callout per section tying it to the real `igrant9679/usip` stack (tRPC v11 + Drizzle/MySQL).
> **Framing:** Velocity already has the **presentation layer** (custom dashboards, a 20-type widget system whose config is already `{metric, dimension, filters}`, scheduled reports) and scattered **rollup tables** — but **no unified query engine and no star-schema warehouse**. This spec designs the engine + a declarative metric/dimension registry, with the warehouse as the *target* and OLTP+rollups as the *interim*.
> **Read-layer over the whole product:** sources come from the prior specs — [Email Activity](email-activity-reply-classification.md), [Sequence Enrollment](sequence-enrollment.md), [Tasks/Calls/Deals](tasks-calls-deals.md), [Enrichment](enrichment-system.md), [Workspace Contacts & Accounts](workspace-contacts-accounts.md). Metrics whose source table isn't built yet are marked **⏳ pending source**.
> **Functional reference:** existing `/v2/home` widgets + dataHealth donuts + the `dashboardWidgets` chart catalog. (No dedicated analytics screenshot folder; grounding is thin — UI follows established patterns.) Layout/UX only — no Apollo branding, icons, colors, or protected design reproduced.

---

## 0. Principles (read first)

1. **One engine, many surfaces.** Dashboards, the report builder, scheduled reports, and `/v2/home` widgets **all** read the same `POST /api/analytics/query`. No metric is computed two ways.
2. **Declarative registry.** Each metric maps to a SQL aggregate expression over a fact source; each dimension maps to a group-by column + a `dim_*` join. Allowed metric×dimension pairs are declared, validated, not freeform SQL.
3. **Three report shapes.** Flat total (no group_by), grouped (1 group_by), pivot/cross-tab (1 row group_by + 1 column pivot_group_by).
4. **Bounded + permissioned.** Max one `group_by`, max one `pivot_group_by`; date-range caps; row limits; manager/permission + export gates; warehouse query timeout.
5. **Honest freshness.** Every response carries a `freshness` timestamp (last rollup/materialization time) so stale data is visible, not silent.

---

## 1. Reporting Model

| Shape | Inputs | Output |
|---|---|---|
| **Flat total** | `metrics[]`, filters, date_range, no group_by | one totals row |
| **Grouped** | `metrics[]`, `group_by[1]`, filters, date_range | one row per dimension value + totals |
| **Pivot / cross-tab** | `metrics[1..]`, `group_by[1]` (rows) + `pivot_group_by[1]` (columns), filters, date_range | matrix: rows × distinct column values, cells = metric(s), with row/column/grand totals |

- `metrics[]` — one or many; pivot with >1 metric nests metric under each column value.
- `group_by[]` / `pivot_group_by[]` — arrays in the contract but **validated to ≤1 each** (§8).
- `filters[]` — `{dimension, op (eq|in|gte|lte|between|contains), value}`.
- `date_range` — `{mode (relative|absolute), preset? (today|7d|30d|qtd|ytd), from?, to?}` resolved in `timezone`.

### 🔧 Velocity mapping & delta
- `dashboardWidgets.config {metric, dimension}` + `filters {dateFrom,dateTo,ownerUserId,stage,source}` already encode a single-metric/single-dimension query. **Delta:** the engine generalizes this to multi-metric + pivot + a validated registry, and makes widgets consumers of it.

---

## 2. Report Categories

| Category | Primary fact source | Velocity source |
|---|---|---|
| **Sequence analytics** | sequence/step events | `campaignStepStats` (L810), `enrollments` |
| **Email analytics** | email send/delivery | `sendingAccountDailyStats` (L2202), `emailDrafts`, `emailTrackingEvents` |
| **Reply analytics** | inbound replies + class | `emailReplies`, `mailboxAiTriage` → ⏳ `reply_classifications` (Email spec) |
| **Call analytics** | call records | ⏳ `calls` (Tasks/Calls/Deals spec) — today only `tasks type='call'` |
| **Task analytics** | task lifecycle | `tasks` (L377) |
| **Enrichment usage** | enrichment jobs | `clodura_enrichment_jobs`, `contact_enrichment_history` |
| **Credit usage** | credit movements | ⏳ `credit_ledger` (Enrichment spec) — today `usageCounters`/`daily_budget_cap` |
| **CRM sync health** | sync attempts | ⏳ `crm_external_ids` sync (CRM/Org specs) |
| **Deal / pipeline analytics** | deals + stage moves | `opportunities` (L228), `opportunityStageHistory` |
| **Rep activity** | per-user events | join all facts on `user` |
| **Team activity** | per-team rollup | join all facts on `team` (`dim_team`) |

### 🔧 Velocity mapping & delta
- Email/sequence/task/deal categories have real sources today. **Delta:** call/credit/reply-class/crm-sync categories depend on prior-spec tables (⏳).

---

## 3. Metrics

Each metric = an aggregate expression over a fact source (registry entry: `{key, expr, source, compatible_dimensions[], format}`).

| Metric | Definition | Source (interim) |
|---|---|---|
| `emails_sent` | count sent | `sendingAccountDailyStats.sentCount` / `emailDrafts` sent |
| `emails_delivered` | count delivered | provider events / `campaignStepStats.delivered` |
| `open_rate` | opened / delivered | `emailTrackingEvents(open)` / delivered |
| `click_rate` | clicked / delivered | `emailTrackingEvents(click)` / delivered |
| `reply_rate` | replied / delivered | `emailReplies` / delivered |
| `positive_reply_rate` | positive-class replies / replies | ⏳ `reply_classifications` (willing_to_meet+follow_up) |
| `bounce_rate` | bounced / sent | `sendingAccountDailyStats.bounceCount` |
| `unsubscribe_rate` | unsub / delivered | `emailSuppressions(unsubscribe)` / `campaignStepStats.unsubscribed` |
| `meetings_booked` | meetings created | calendar/`tasks(meeting)` / reply-class `willing_to_meet` |
| `calls_completed` | calls with status completed | ⏳ `calls` |
| `call_connect_rate` | connected / dialed | ⏳ `calls` |
| `tasks_completed` | tasks done | `tasks(status=done)` |
| `contacts_enriched` | enrichment successes | `clodura_enrichment_jobs(succeeded)` |
| `credits_used` | credits consumed | ⏳ `credit_ledger` / `usageCounters` |
| `deals_created` | deals created | `opportunities` count |
| `pipeline_amount` | sum(amount) weighted? | `opportunities.value` (× `winProb` for weighted) |
| `crm_sync_failures` | failed syncs | ⏳ `crm_external_ids` sync log |

Rates are returned with numerator + denominator (so they aggregate correctly under group_by — never average-of-averages).

### 🔧 Velocity mapping & delta
- ~11/17 metrics have interim sources today; 6 are ⏳ pending prior-spec tables. **Delta:** the registry + correct rate aggregation (sum numerators/denominators per group, then divide).

---

## 4. Dimensions

Each dimension = a group-by column + a `dim_*` join (registry: `{key, column, dim_table, compatible_metrics[]}`).

| Dimension | Source |
|---|---|
| `date` | `dim_date` (day/week/month grain) |
| `user` | `dim_user` ← `users` |
| `team` | `dim_team` ← team membership |
| `sequence` | `dim_sequence` ← `sequences` |
| `mailbox` | `dim_mailbox` ← `sendingAccounts` |
| `contact_stage` | ⏳ contact stage (CRM spec) |
| `account_stage` | ⏳ account stage (CRM spec) |
| `industry` | `accounts.industry` / `prospects.industry` |
| `persona` | `personas` (L2991) |
| `reply_class` | ⏳ `reply_classifications` |
| `enrichment_type` | `clodura_enrichment_jobs.trigger` / type |
| `crm_provider` | ⏳ `crm_external_ids.crm_provider` |
| `deal_stage` | `crm_pipeline_stages` |

### 🔧 Velocity mapping & delta
- user/sequence/mailbox/industry/persona/deal_stage/enrichment_type exist. **Delta:** `dim_date` (a date spine), `dim_team`, and the ⏳ contact/account-stage, reply_class, crm_provider dims.

---

## 5. Warehouse Schema (target) + interim

**Target — star schema.** Facts (one row per event/grain) + conformed dimensions.

| Fact | Grain | Measures |
|---|---|---|
| `fact_email_events` | email event | sent/delivered/opened/clicked/replied/bounced/unsub flags |
| `fact_sequence_events` | membership-step | enrolled/advanced/finished/exited |
| `fact_call_events` | call | dialed/connected/duration/outcome |
| `fact_task_events` | task | created/completed/disposition |
| `fact_enrichment_events` | enrichment request | matched/email_found/phone_found/credits |
| `fact_credit_events` | ledger entry | reserve/debit/release amount |
| `fact_crm_sync_events` | sync attempt | success/failure/provider |
| `fact_deal_events` | deal/stage-move | created/amount/stage_from/stage_to/won/lost |
| `dim_user`/`dim_team`/`dim_contact`/`dim_account`/`dim_sequence`/`dim_mailbox`/`dim_date` | conformed dims | keys + descriptive attrs |

Each fact carries FKs to the relevant dims + `workspace_id` + `event_date` for partition/range.

**Interim (no warehouse):** the query engine reads **OLTP + existing rollups** —
- email/sequence ← `campaignStepStats`, `sendingAccountDailyStats`, `emailDrafts`, `emailTrackingEvents`, `emailReplies`
- tasks ← `tasks`; deals ← `opportunities` + `opportunityStageHistory`; enrichment ← `clodura_enrichment_jobs`; usage ← `usageCounters`
- nightly **materialized rollups** for hot metrics (a `mv_*` table per category) refreshed by an aggregation job; `freshness` = last refresh.

### 🔧 Velocity mapping & delta
- **No `fact_*`/`dim_*` today.** `campaignStepStats`/`sendingAccountDailyStats`/`usageCounters` are proto-facts. **Delta:** introduce the star schema when OLTP aggregation latency/scale demands; until then the registry points at OLTP + `mv_*` rollups (same posture as the People-spec OpenSearch target).

---

## 6. API Endpoint — `POST /api/analytics/query`

**Request:**
```jsonc
{
  "metrics": ["emails_sent","reply_rate"],
  "group_by": ["sequence"],              // ≤1
  "pivot_group_by": ["date"],            // ≤1 (optional)
  "filters": [ {"dimension":"mailbox","op":"in","value":[12,15]} ],
  "date_range": {"mode":"relative","preset":"30d"},
  "timezone": "America/New_York",
  "limit": 100,
  "sort": [ {"key":"emails_sent","dir":"desc"} ]
}
```

**Response:**
```jsonc
{
  "query_id": "q_…",
  "columns": [ {"key":"sequence","type":"dimension"},
               {"key":"emails_sent","type":"metric","format":"int"},
               {"key":"reply_rate","type":"metric","format":"percent"} ],
  "rows": [ {"sequence":"AI Outreach","emails_sent":1200,"reply_rate":0.08} ],
  "totals": {"emails_sent":4300,"reply_rate":0.07},
  "metadata": {"shape":"grouped","row_count":12,"truncated":false,"timezone":"…"},
  "freshness": "2026-06-29T06:00:00Z"
}
```

Pivot shape: `columns` expands to one column per distinct `pivot_group_by` value (× metric); `rows` carry the matrix; `totals` includes row/column/grand totals. Permissions + validation run before execution (§8); `query_id` is logged for audit/repro.

### 🔧 Velocity mapping & delta
- **New** `analytics.query` tRPC procedure (the engine). Compiles the request → a parameterized SQL aggregate over the registry sources (never freeform SQL), workspace-scoped.

---

## 7. Dashboard Endpoints (typed wrappers over `/query`)

Pre-baked metric/dimension combos for common cards; each calls the engine internally.

| Endpoint | Returns |
|---|---|
| `GET /api/analytics/sequence-summary` | per-sequence sent/open/reply/positive/bounce |
| `GET /api/analytics/email-performance` | sent/delivered/open/click/reply/bounce over time |
| `GET /api/analytics/rep-activity` | per-user emails/calls/tasks/meetings |
| `GET /api/analytics/enrichment-usage` | enrichment counts + credits by type/date |
| `GET /api/analytics/crm-sync-health` | sync success/failure by provider |
| `GET /api/analytics/pipeline` | pipeline_amount + deals by stage/owner; forecast |

All accept `date_range`, `timezone`, and scope filters; all return the same `{columns, rows, totals, freshness}` envelope.

### 🔧 Velocity mapping & delta
- `dashboards`/`dashboardWidgets`/`reportSchedules` exist. **Delta:** these endpoints replace bespoke per-widget logic; `dashboardWidgets.config` maps onto query params; `reportSchedules` renders via the same endpoints.

---

## 8. Query Validation

| Check | Rule |
|---|---|
| Allowed metric/dimension combos | each metric's `compatible_dimensions` must include the requested group_by/pivot/filter dims → else `422 incompatible`. |
| Max one group_by | `group_by.length ≤ 1` → else `422 too_many_group_by`. |
| Max one pivot_group_by | `pivot_group_by.length ≤ 1` → else `422 too_many_pivot`. |
| Date range limits | bounded (e.g. ≤ 2 years; pivot ≤ 1 year) → else `422 range_too_large`. |
| User permissions | rep sees own/team data; **manager** required for cross-rep/team reports → else `403`. |
| Row limits | cap rows (e.g. 10k); `truncated=true` flag if exceeded; never silent. |
| Export permissions | export requires `export` entitlement + a stricter row cap → else `403`. |

All validation runs **before** query execution; failures return typed reasons.

### 🔧 Velocity mapping & delta
- **New** validation layer keyed off the registry + RBAC. Manager-scope and export entitlement are shared deltas with other specs.

---

## 9. UI Components

```
AnalyticsPage                        // /v2/analytics
├─ ReportBuilder                     // assemble a query
│  ├─ MetricSelector                 // pick metrics (registry-driven)
│  ├─ DimensionSelector              // group_by + pivot_group_by (incompatible options disabled)
│  ├─ FilterBuilder                  // dimension/op/value rows
│  └─ DateRangePicker                // preset + custom + timezone
├─ PivotTable                        // rows × columns matrix w/ totals
├─ ChartRenderer                     // bar/line/funnel/etc. (reuse widget chart types)
├─ DrilldownDrawer                   // click a cell → underlying rows (query with the cell's filters)
└─ ExportReportButton                // CSV/XLSX (entitlement + row cap)
```

State: the builder produces the §6 request object (URL-serializable + saveable as a dashboard widget); incompatible metric/dimension options are disabled live via the registry; drilldown re-queries with the clicked cell's dimension filters.

### 🔧 Velocity mapping & delta
- The 20-type widget chart catalog (`dashboardWidgets.type`) + `/v2/home` exist → reuse for `ChartRenderer`. **New:** `ReportBuilder`/`MetricSelector`/`DimensionSelector`/`FilterBuilder`/`PivotTable`/`DrilldownDrawer`. Dialogs `sm:max-w-*`; flex rows `shrink-0`.

---

## 10. Edge Cases

| Case | Handling |
|---|---|
| Invalid metric/dimension pair | `422 incompatible` pre-execution; UI disables incompatible options so it's hard to reach. |
| No data | empty `rows`, zeroed `totals`, `row_count=0`; UI shows an explicit empty state (not a broken chart). |
| Stale data | `freshness` older than threshold → UI "as of {time}" badge + manual refresh; never present stale as live. |
| User lacks manager permission | cross-rep/team query → `403`; builder hides team/cross-rep dims for non-managers. |
| Deleted sequence in historical report | `dim_sequence` retains the row (snapshot name + `is_deleted`); report shows "{name} (deleted)" — history isn't lost. |
| Timezone boundary mismatch | all bucketing resolved in the request `timezone`; document that day boundaries shift totals; store UTC, group in tz. |
| Export too large | over the export row cap → `413/403 export_too_large`; offer a narrower range or async export job. |
| Warehouse/query timeout | `504 query_timeout`; suggest narrowing range/dims; log slow `query_id`; serve last `mv_*` rollup if available. |

### 🔧 Velocity mapping & delta
- Empty/stale states partly exist on `/v2/home`. **Delta:** the deleted-dimension snapshot (`dim_*` retains tombstoned rows), tz-aware bucketing, and export/timeout guards.

---

## 11. Acceptance Criteria (Given/When/Then)

**Shapes**
- Given `metrics=[emails_sent]`, no group_by, When queried, Then a single totals row returns (flat).
- Given `group_by=[sequence]`, When queried, Then one row per sequence + a totals row.
- Given `group_by=[sequence]` + `pivot_group_by=[date]`, When queried, Then a matrix of sequences × dates with row/column/grand totals.

**Validation**
- Given `group_by=[user,team]`, When queried, Then `422 too_many_group_by`.
- Given a metric incompatible with a dimension, When queried, Then `422 incompatible` and no execution.
- Given a 5-year range, When queried, Then `422 range_too_large`.

**Rate correctness**
- Given `open_rate` grouped by sequence, When computed, Then each row divides that sequence's opens by its delivered (not an average of per-email rates), and totals use summed numerators/denominators.

**Permissions**
- Given a non-manager requesting cross-rep `rep-activity`, When queried, Then `403`.
- Given a user without export entitlement, When exporting, Then `403`.

**Freshness / parity**
- Given the same query from a dashboard widget and the report builder, When run, Then identical numbers (one engine) and a `freshness` timestamp.
- Given a stale rollup, When queried, Then `freshness` reflects the last refresh and the UI flags it.

**History**
- Given a deleted sequence, When a historical report covers it, Then it appears as "{name} (deleted)" with its past numbers intact.

**Drilldown**
- Given a pivot cell, When clicked, Then `DrilldownDrawer` queries the underlying rows with that cell's dimension filters applied.

---

## 12. Implementation Checklist

**Warehouse / data**
- [ ] Define the metric/dimension **registry** (keys → SQL aggregate expr + compatible dims + format).
- [ ] Interim: `mv_*` materialized rollups per category over OLTP (`campaignStepStats`/`sendingAccountDailyStats`/`tasks`/`opportunities`/`clodura_enrichment_jobs`).
- [ ] `dim_date` spine + `dim_team`; tombstone-retaining `dim_*` for deleted entities.
- [ ] Target: `fact_*` star schema when scale demands; ETL from OLTP.
- [ ] Migration in BOTH `drizzle/schema.ts` AND `server/_core/rawMigrations.ts` (next: **0094**).

**Aggregation jobs**
- [ ] Nightly (and incremental) rollup refresh writing `mv_*` + a `freshness` marker.
- [ ] Backfill job for historical facts.

**Backend query API**
- [ ] `analytics.query` (compile request → parameterized SQL over the registry; flat/grouped/pivot; rate num/denom; `query_id` audit).
- [ ] Dashboard wrapper endpoints (§7) calling the engine; `reportSchedules` rendering via them.
- [ ] Validation layer (§8) + manager/export RBAC; workspace-scoped everywhere.

**Frontend report builder**
- [ ] `ReportBuilder` (MetricSelector/DimensionSelector/FilterBuilder/DateRangePicker), `PivotTable`, `ChartRenderer` (reuse widget chart types), `DrilldownDrawer`, `ExportReportButton`.
- [ ] Live registry-driven incompatible-option disabling; save query → dashboard widget.

**Permissions**
- [ ] Rep/manager scoping; export entitlement + stricter caps; per-workspace isolation.

**Tests**
- [ ] G/W/T from §11.
- [ ] Shape correctness (flat/grouped/pivot + totals); rate aggregation (num/denom, no avg-of-avg).
- [ ] Validation (group_by/pivot caps, incompatible pairs, range/row/export limits).
- [ ] Dashboard↔builder parity (one engine, identical numbers); freshness reporting.
- [ ] Deleted-dimension history; tz-boundary bucketing; cross-workspace isolation.

---

### Appendix — provenance of functional references
Grounded from the existing `dashboardWidgets` chart catalog (20 types incl. kpi/bar/line/funnel/heatmap/leaderboard/pipeline_stage/rep_performance/email_health), `/v2/home` layout editor, and the dataHealth donuts — no dedicated analytics screenshot folder exists, so the report-builder/pivot UI follows established Velocity dashboard patterns. Layout/UX only; no Apollo brand assets, icons, or protected design reproduced.
