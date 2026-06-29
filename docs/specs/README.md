# Velocity — Component Technical Specs

The technical model of Velocity, built up **per component** as hybrid specs: each doc gives a **canonical, provider-agnostic design** plus a 🔧 **Velocity mapping & delta** callout per section tying it to the real `igrant9679/usip` stack (tRPC v11 + Drizzle/MySQL + existing vendor services). Layout/UX references come from Apollo screenshots — **layout/UX only, no brand assets, icons, colors, or protected design**.

> **How to read a delta:** "🔧 Velocity mapping & delta" tells you what already exists in the codebase (so don't rebuild it) and what's genuinely new (the work). Across the set, the *same* new primitives recur — build those once (§ Cross-cutting primitives) and most component deltas shrink to wiring.

---

## The nine components

| # | Spec | What it covers | Maturity in code today |
|---|---|---|---|
| 1 | [people-search](people-search.md) | Global people search → masked results → save-as-contact | **Search exists** (`/v2/people` on `prospects.list`); masking + save-flow are deltas |
| 2 | [organization-search](organization-search.md) | Global company search → save-as-account (+ dedupe) | **Search exists** (`/v2/companies` on `accounts.list`); global org tables are deltas |
| 3 | [workspace-contacts-accounts](workspace-contacts-accounts.md) | Saved CRM contacts/accounts, profiles, dedupe, merge | **Most mature** — heavy mapping, concentrated deltas |
| 4 | [enrichment-system](enrichment-system.md) | Waterfall enrichment, credits, async webhook | **Primitives exist** (clodura/reoon/leadrocks + jobs); orchestration is the build |
| 5 | [sequence-enrollment](sequence-enrollment.md) | Add-to-sequence + membership lifecycle | **Engine exists** (sequences/enrollments/sender pools); 11-state model + contacts-only are deltas |
| 6 | [email-activity-reply-classification](email-activity-reply-classification.md) | Outbound log, delivery lifecycle, reply taxonomy | **Hard parts exist** (sends/tracking/replies/AI triage); surface + taxonomy are deltas |
| 7 | [tasks-calls-deals](tasks-calls-deals.md) | Tasks (expand), Deals (augment), Calls (greenfield) | **Mixed** — tasks/deals exist; calls is net-new |
| 8 | [analytics-reporting](analytics-reporting.md) | One query engine (flat/grouped/pivot) powering dashboards | **Presentation exists** (dashboards/widgets); query engine + warehouse are deltas |
| 9 | [developer-api-ai-actions](developer-api-ai-actions.md) | Scoped API keys, webhooks, MCP-style AI action registry | **Capstone, mostly greenfield**; little new business logic |

---

## Dependency graph

```
                         ┌─────────────────────────────────────────────┐
            ┌────────────┤  9. Developer API / AI Action Registry       │  (front door:
            │            └─────────────────────────────────────────────┘   exposes everything)
            │            ┌─────────────────────────────────────────────┐
            │   ┌────────┤  8. Analytics / Reporting Query Engine        │  (read-layer:
            │   │        └─────────────────────────────────────────────┘   reads all facts)
            ▼   ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │  4. Enrichment   5. Sequences   6. Email Activity   7. Tasks/Calls/Deals  │  (action layer)
   └───────────────────────────────────────────────────────────────────┘
            ▲   ▲
            │   │
   ┌───────────────────────────────────────────────────────────────────┐
   │  1. People Search     2. Org Search     3. Workspace Contacts/Accounts   │  (acquisition + base records)
   └───────────────────────────────────────────────────────────────────┘
```

- **Base (1–3):** how records enter the workspace. Global search (1,2) → save → owned CRM records (3).
- **Action layer (4–7):** what you do to owned records — enrich, sequence, email, task/call/deal.
- **Read/expose (8,9):** Analytics reads every fact the action layer emits; the Developer API / AI agent exposes all of it behind scopes + a draft→confirm gate.
- **Key invariant linking the layers:** *only saved contacts cross into the action layer.* Global people/orgs (1,2) must be saved (3) before enrichment-reveal (4) or sequence enrollment (5) — enforced as **contacts-only** in spec 5 and reject-raw-`person_id` in spec 1.

---

## Cross-cutting primitives (build once, not nine times)

These recur across most specs. Building them first collapses the per-component deltas to wiring. **Suggested build order:**

| Order | Primitive | What it is | Needed by | Status today |
|---|---|---|---|---|
| 1 | **`checkEligibility()`** | one compliance gate: permission · entitlement · credits · suppression (workspace/domain/global-unsub/DNC) · region · export · API scope | 1,2,4,5,6,9 | scattered: `email_suppressions` + `are_suppression_list` exist; unify |
| 2 | **`crm_external_ids`** | account/contact ↔ external CRM id map (sync + dedupe + "In CRM") | 2,3,7,8 | **none** — net-new table |
| 3 | **Contact/account stages + labels** | stage vocab + `stage_id` columns; `*_labels` + memberships | 3,5,6,8 | **none** (only leads/opps staged; only lists exist) |
| 4 | **Credit ledger** | `credit_reservations` + immutable `credit_ledger` (reserve→debit→release) | 2,4,8,9 | counters only (`daily_budget_cap`, `usage_counters`) |
| 5 | **Outbound webhook subsystem** | signed, idempotent, retried delivery + delivery logs; one bus, many event types | 4,6,9 (and 5,7 emit) | **none** outbound (inbound Unipile is the signing precedent) |
| 6 | **Vendor/provider abstractions** | `EnrichmentVendor` (4), `CallProvider` (7), email-provider webhooks (6) — same shape: adapter + signed callback + idempotency | 4,6,7 | services exist (clodura/reoon/leadrocks/scraper/unipile); not unified |
| 7 | **`previewEnrollment` / validation gate** | pre-action validation producing typed block/warn, re-checked at execute (TOCTOU) | 1,5,9 | **none** — net-new |
| 8 | **AI action-draft + confirm** | high-impact AI actions stage a draft → user approves → execute (TOCTOU) | 5,6,7,9 | **none** — net-new (help assistant ≠ action agent) |
| 9 | **Warehouse / search index targets** | OpenSearch people/org index (1,2) + `fact_*`/`dim_*` star schema (8) | 1,2,8 | **none** — interim is MySQL + rollups; build when scale demands |

**Recurring conventions baked into every spec** (already-known bug classes / patterns):
- Migrations go in BOTH `drizzle/schema.ts` AND `server/_core/rawMigrations.ts` — **next is 0094**.
- Every query filters by `ctx.workspace.id`; validate caller ids → 404 cross-workspace.
- Dialogs use `sm:max-w-*` (never bare `max-w-*`); flex rows under the shell need `shrink-0`.
- Bulk ops are async jobs with partial-success reporting (never silent truncation) + idempotency keys.
- Every mutation writes `audit_log` (L1000) and emits an activity event.

---

## Build-order recommendation

1. **Cross-cutting primitives 1–4** (`checkEligibility`, `crm_external_ids`, stages/labels, credit ledger) — they unblock the most components.
2. **Base records (specs 1–3)** — people/org search masking + save flows + CRM stages/labels/merge.
3. **Action layer (specs 4–7)** — enrichment waterfall, sequence enrollment (contacts-only), email activity + reply classes, calls subsystem; primitives 5–6 (webhooks, provider abstractions) land here.
4. **Read/expose (specs 8–9)** — analytics query engine over the now-populated facts; developer API + AI action registry last (it needs the procedures it wraps to exist).

> Specs 8 and 9 are deliberately last: spec 8 marks metrics **⏳ pending source** when their fact table (calls, credit_ledger, reply_classifications, crm_external_ids) isn't built; spec 9's tools map 1:1 to procedures the earlier specs define.

---

*Each spec is self-contained and cross-links its siblings. Start from the component you're building; consult this index for the shared primitive it depends on.*
