# Technical Spec — Developer API / API Keys / Webhooks / MCP-Style AI Tool Actions

> **Component:** The platform's external surface + AI action layer — scoped API keys, outbound webhooks, and a safe internal tool/action registry the AI agent uses (draft → confirm for high-impact).
> **Status:** Design spec (hybrid). Canonical, provider-agnostic design + a **Velocity mapping & delta** callout per section tying it to the real `igrant9679/usip` stack (tRPC v11 + Drizzle/MySQL).
> **Capstone.** This is the front door over the other eight specs: every AI tool maps 1:1 to a procedure already specced, every webhook event to an event already defined, every scope to a permission already referenced. Mostly greenfield (no API-key/webhook/AI-tool tables today) but little *new business logic* — it's access control + delivery + agent orchestration over existing components.
> **References:** [People Search](people-search.md), [Organization Search](organization-search.md), [Workspace Contacts & Accounts](workspace-contacts-accounts.md), [Enrichment](enrichment-system.md), [Sequence Enrollment](sequence-enrollment.md), [Email Activity](email-activity-reply-classification.md), [Tasks/Calls/Deals](tasks-calls-deals.md), [Analytics](analytics-reporting.md).
> **Functional reference:** `Apollo Screenshots/01_ai-assistant` (AI panel) + generic settings/table patterns. (No dedicated developer-settings screenshot folder; grounding thin.) Layout/UX only — no Apollo branding, icons, colors, or protected design reproduced.

---

## 0. Two AI layers + one access model (read first)

- **Help assistant** (exists) — read-only Q&A over help content (`/v2/ai-assistant` on `helpCenter`). Informational; calls no platform tools.
- **Action agent** (new) — a tool-calling agent over the **action registry** (§4). It can search/summarize/draft freely, but **high-impact actions require explicit user confirmation** via an `ai_action_draft` → approve flow (§5).
- **One access model** — every external call (public API *or* agent tool) passes the same gate: **scope check → permission check → rate limit → (compliance/credit where relevant)**. The agent runs under the user's permissions; an API key runs under its scopes. Master/elevated scope guards admin/billing.

### 🔧 Velocity mapping & delta
- Help assistant exists (`aiHelpConversations`/`aiHelpMessages`). RBAC exists (`memberPermissions`). **Delta:** the action agent, the scoped public API, the unified gate, and the draft→confirm flow.

---

## 1. Developer Settings

| Capability | Behavior |
|---|---|
| **API key creation** | generate a key (shown once, hashed at rest); assign scopes + optional expiry. |
| **API key scopes** | least-privilege scope set per key (§2). |
| **Master/elevated key** | a key carrying `admin.*`/elevated scopes; creation gated to workspace admins; stronger audit. |
| **Key expiration** | optional `expires_at`; expired keys 401 with `key_expired`. |
| **Key rotation** | issue a new secret for the same key id; grace window for the old secret; logged. |
| **Key revocation** | immediate disable; subsequent calls 401 `key_revoked`. |
| **Rate limits** | per-key + per-workspace (requests/min + burst); `429` with `Retry-After`. |
| **Usage logs** | per-call log (endpoint, scope used, status, latency, ip) for audit/debug. |
| **Webhook configuration** | create endpoints, subscribe to events, set secret. |
| **Webhook delivery logs** | per-attempt log (status, response, retries). |
| **Test webhook** | send a synthetic event to verify the endpoint + signature. |
| **API documentation links** | link to reference + the scope/event catalogs. |

### 🔧 Velocity mapping & delta
- **All new.** Closest precedents: `aiCredentials` (internal LLM keys, not public), inbound Unipile webhook (signing). Build the `/v2/...` developer settings surface + tables (§6).

---

## 2. API Scopes

Scopes map 1:1 to permissions referenced across the prior specs. Read vs write split; `admin.*` is elevated/master.

| Scope | Grants (→ spec) |
|---|---|
| `people.search` | People Search query |
| `organizations.search` | Org Search query |
| `people.enrich` / `organizations.enrich` | Enrichment (reveal gated separately by compliance) |
| `contacts.read` / `contacts.write` | CRM contacts |
| `accounts.read` / `accounts.write` | CRM accounts |
| `sequences.read` / `sequences.write` | Sequences |
| `sequence_memberships.write` | enroll / status actions |
| `tasks.read` / `tasks.write` | Tasks |
| `emails.read` / `emails.send` | Email activity / send |
| `calls.read` / `calls.write` | Calls |
| `deals.read` / `deals.write` | Deals |
| `analytics.read` | Analytics query |
| `webhooks.manage` | webhook CRUD |
| `admin.users.read` / `admin.users.write` | **elevated** — user admin (SCIM) |

Rules: write implies its read for the same resource? **No** — explicit. `emails.send`, `*.enrich` (reveal), and `admin.*` are **elevated**: require master-key designation + stronger audit, and (for send/reveal) the compliance/credit gate still applies on top of scope.

### 🔧 Velocity mapping & delta
- Permissions exist via `memberPermissions`; SCIM covers admin users. **Delta:** the scope vocabulary as a first-class catalog mapped to keys + agent tools, and the elevated-scope designation.

---

## 3. Webhook Events

Outbound events (signed, idempotent, retried). Each maps to an event defined in a prior spec.

| Event | Source spec |
|---|---|
| `enrichment.completed` / `enrichment.failed` | Enrichment (async webhook §5) |
| `contact.created` / `contact.updated` | CRM |
| `account.created` / `account.updated` | CRM |
| `sequence.enrolled` | Sequence (membership created) |
| `sequence.member_status_changed` | Sequence (status machine §5) |
| `email.sent` / `email.replied` / `email.bounced` / `email.unsubscribed` | Email Activity |
| `call.completed` | Calls |
| `task.completed` | Tasks |
| `deal.updated` | Deals |
| `crm_sync.failed` | CRM/Org (`crm_external_ids`) |
| `credit.low` | Enrichment credit ledger (threshold breach) |

Payload envelope: `{ event, event_id, workspace_id, occurred_at, data:{…}, delivery_attempt }`. Signed `X-Velocity-Signature` (HMAC of body + secret). **Idempotency** = `event_id`. Delivery: at-least-once, exponential backoff, max attempts, then dead-letter + alert.

### 🔧 Velocity mapping & delta
- **New** unified subsystem. Generalizes the Enrichment-spec `enrichment_webhook_deliveries`; reuses the Unipile signing pattern. Each producer (enrichment/email/sequence/…) emits to the bus; the delivery worker fans out to subscribed webhooks.

---

## 4. AI / MCP-Style Action Registry

Each tool = `{ name, input_schema, output_schema, required_scopes[], confirmation_required, audit_event, failures[] }`. The agent may call read/draft tools freely; `confirmation_required` tools produce an `ai_action_draft` the user must approve (§5) before execution.

| Tool | Scopes | Confirm? | Maps to | Key failures |
|---|---|---|---|---|
| `searchPeople` | `people.search` | no | People §8 | rate_limit, invalid_filters |
| `searchOrganizations` | `organizations.search` | no | Org §7 | rate_limit |
| `enrichPerson` | `people.enrich` | **yes** (reveal) | Enrichment §9 | insufficient_credits, suppressed, scope_denied |
| `enrichOrganization` | `organizations.enrich` | **yes** | Enrichment §9 | insufficient_credits |
| `createContact` | `contacts.write` | no¹ | CRM §7 | duplicate, validation |
| `updateContact` | `contacts.write` | no¹ | CRM §7 | not_found, validation |
| `createAccount` | `accounts.write` | no¹ | CRM §7 | duplicate |
| `updateAccount` | `accounts.write` | no¹ | CRM §7 | not_found |
| `createSequence` | `sequences.write` | no | Sequence | validation |
| `addContactsToSequence` | `sequence_memberships.write` | **yes** (sends) | Sequence §8 | not_saved, no_mailbox, suppressed |
| `updateSequenceMemberStatus` | `sequence_memberships.write` | **yes**² | Sequence §6 | invalid_transition |
| `createTask` | `tasks.write` | no | Tasks §6 | validation |
| `searchEmails` | `emails.read` | no | Email §9 | rate_limit |
| `sendOneOffEmailDraft` | `emails.send` | **yes** (sends) | Email | suppressed, no_mailbox |
| `searchCalls` | `calls.read` | no | Calls §6 | — |
| `createDeal` | `deals.write` | no¹ | Deals §6 | invalid_stage, owner_required |
| `queryAnalyticsReport` | `analytics.read` | no | Analytics §6 | incompatible, range_too_large |

¹ writes that create/modify records are low-impact *drafts the agent fills*, but a workspace policy can flip them to confirm-required. ² bulk/destructive transitions (stop/remove many) require confirm; single benign ones may not.

Every tool call writes an `ai_tool_call` + an `ai_audit_log`; confirm-required tools also write an `ai_action_draft`.

### 🔧 Velocity mapping & delta
- **New registry.** Each tool wraps an existing/soon-to-exist tRPC procedure from the referenced spec. The agent never gets raw DB access — only registry tools, each behind the unified gate.

---

## 5. Safety Rules for AI

**AI can (no confirmation):**
- Search permitted records, summarize, draft (emails/sequences/tasks), recommend next steps, **prepare** bulk actions (as drafts), explain analytics.

**AI cannot without explicit user confirmation:**
- **Send email**, **enroll contacts** in a sequence, **reveal phone/email** via enrichment, **export data**, **delete/suppress** records, **change CRM sync** config, **create API keys**, **buy credits**, **modify billing**.

Mechanism: a confirm-required tool call does **not execute** — it creates an `ai_action_draft` (status `pending`) with a human-readable summary + the exact payload. The UI shows an `AIActionConfirmationModal`; on approve, the draft executes under the user's permissions (re-checking scope/compliance/credits at execution — TOCTOU). On reject, it's discarded (audited). Drafts expire. The agent **cannot self-approve** and cannot escalate its own scope. API-key creation, billing, and credit purchase are **never** agent-executable (even with confirmation, they route to the human UI).

### 🔧 Velocity mapping & delta
- The draft→confirm pattern is referenced in Sequence/Task/Email specs. **Delta:** the `ai_action_drafts` table + approval endpoint + the hard "agent cannot do X at all" list (keys/billing/credits) enforced server-side.

---

## 6. Data Model

| Table | Purpose | Key fields |
|---|---|---|
| **`api_keys`** | issued keys | `id, workspace_id, name, key_hash, prefix, is_master, created_by, expires_at, last_used_at, revoked_at` |
| **`api_key_scopes`** | scopes per key | `id, api_key_id, scope` |
| **`api_usage_logs`** | per-call audit | `id, api_key_id?, user_id?, endpoint, scope_used, status, latency_ms, ip, created_at` |
| **`api_rate_limits`** | counters/config | `id, scope_key (key|workspace), window, limit, used, reset_at` |
| **`webhooks`** | endpoints | `id, workspace_id, url, secret, status (active|disabled|dead), created_by` |
| **`webhook_event_subscriptions`** | which events | `id, webhook_id, event` |
| **`webhook_deliveries`** | per-attempt | `id, webhook_id, event, event_id, attempt_no, http_status, signature, payload_hash, delivered_ok, next_retry_at, created_at` |
| **`ai_conversations`** | agent sessions | `id, workspace_id, user_id, title, created_at` |
| **`ai_messages`** | chat turns | `id, conversation_id, role (user|assistant|tool), content, created_at` |
| **`ai_tool_calls`** | tool invocations | `id, conversation_id, message_id, tool, input, output, status, latency_ms, created_at` |
| **`ai_action_drafts`** | pending high-impact actions | `id, workspace_id, user_id, tool, payload, summary, status (pending|approved|rejected|expired|executed), approved_by, decided_at, expires_at` |
| **`ai_audit_logs`** | agent audit | `id, workspace_id, actor_user_id, tool, action, draft_id?, before, after, created_at` |

### 🔧 Velocity mapping & delta
- `aiHelpConversations`/`aiHelpMessages` exist → generalize to `ai_conversations`/`ai_messages` (or add a `kind`). `audit_log` (L1000) backs `ai_audit_logs`. **All other tables new.** Migration in BOTH `drizzle/schema.ts` AND `server/_core/rawMigrations.ts` (next: **0094**).

---

## 7. API Endpoints

Canonical REST → tRPC. Developer endpoints require workspace-admin; AI endpoints run under the user.

**Developer / keys**
- `GET /api/developer/api-keys` — list (no secrets). Perm: admin.
- `POST /api/developer/api-keys` — create (returns secret once). Body `{ name, scopes[], expires_at?, is_master? }`. Master requires admin + step-up. Audit.
- `POST /api/developer/api-keys/{id}/rotate` — new secret, grace window. Audit.
- `DELETE /api/developer/api-keys/{id}` — revoke (immediate). Audit.
- `GET /api/developer/api-logs` — usage logs (filter by key/endpoint/status/date).

**Developer / webhooks**
- `GET /api/developer/webhooks` — list.
- `POST /api/developer/webhooks` — create `{ url, events[], secret? }`. Scope: `webhooks.manage`.
- `PATCH /api/developer/webhooks/{id}` — update url/events/status.
- `POST /api/developer/webhooks/{id}/test` — send synthetic event; returns delivery result.
- `GET /api/developer/webhooks/{id}/deliveries` — delivery log.

**AI**
- `POST /api/ai/chat` — agent turn; streams assistant text + tool-call proposals. Runs under user perms.
- `POST /api/ai/tool-call` — execute a (non-confirm) tool or stage a confirm-required draft. Returns result or `{ draft_id, requires_confirmation:true }`.
- `POST /api/ai/action-drafts/{id}/approve` — approve + execute a pending draft (re-check scope/compliance/credits). Body `{ decision: approve|reject }`. Audit.
- `POST /api/analytics/query` — the Analytics engine (also a tool); scope `analytics.read`.

### 🔧 Velocity mapping & delta
- AI chat exists (help). **Delta:** the developer-key/webhook endpoints, the agent tool-call + draft-approve endpoints, and the unified auth (key scopes for API callers, session perms for the agent).

---

## 8. UI Components

```
DeveloperSettingsPage                // /v2/... developer settings
├─ APIKeyTable                       // keys: name/prefix/scopes/expiry/last-used/status
│  └─ CreateAPIKeyModal              // name + ScopeSelector + expiry + master toggle (admin)
│     └─ ScopeSelector               // grouped scopes; elevated flagged
├─ APIUsageLogTable                  // per-call logs
├─ WebhookTable                      // endpoints + subscribed events + health
│  ├─ WebhookEditor                  // url, event subscriptions, secret, test
│  └─ WebhookDeliveryLog             // attempts, status, retries
AIAssistantPanel                     // the action agent chat
├─ AIActionConfirmationModal         // approve/reject a high-impact draft (summary + payload)
└─ AIToolCallLog                     // transparency: what the agent called + results
```

State: secret shown once on create (copy-then-hidden); ScopeSelector marks elevated scopes; the confirmation modal shows the exact payload + human summary before approve.

### 🔧 Velocity mapping & delta
- `/v2/ai-assistant` (help) exists → `AIAssistantPanel` is the action-agent variant. **New:** all developer-settings components. Reuse `Shell`/`PageHeader`, `ui/dialog` (`sm:max-w-*`), flex rows `shrink-0`.

---

## 9. Edge Cases

| Case | Handling |
|---|---|
| API key expired | `401 key_expired`; surface in key table; prompt rotation. |
| Scope denied | `403 scope_denied` naming the missing scope; agent surfaces "I lack permission to X." |
| Rate limit exceeded | `429` + `Retry-After`; logged; agent backs off. |
| Key leaked | revoke immediately; usage logs show source; optional auto-revoke on anomaly; alert admin. |
| Webhook endpoint failing | retry w/ backoff; after max attempts → `dead`, alert, pause deliveries; events still queryable. |
| Duplicate webhook events | consumer dedupes on `event_id`; we guarantee at-least-once, document idempotency. |
| AI action requires confirmation | tool returns `{draft_id, requires_confirmation}`; nothing executes until approve. |
| AI tool lacks permission | pre-check fails → agent explains, no draft created. |
| Enrichment credit unavailable | reveal tool → `402`; agent surfaces balance + suggests; no charge. |
| Master scope required | non-master key on elevated endpoint → `403 master_required`. |
| OAuth connection expired | integration token expired (e.g. mailbox) → tool returns `connection_expired`; prompt reconnect; sends blocked. |

### 🔧 Velocity mapping & delta
- Mailbox/OAuth-expiry handling partly exists (`integrations`). **Delta:** key/scope/rate-limit/webhook-failure/draft-confirmation handling — all new with the subsystem.

---

## 10. Acceptance Criteria (Given/When/Then)

**Keys / scopes**
- Given a key scoped `people.search` only, When it calls org search, Then `403 scope_denied`.
- Given an expired key, When it calls any endpoint, Then `401 key_expired`.
- Given a rotated key, When the old secret is used within the grace window, Then it still works; after, `401`.
- Given a revoked key, When used, Then `401 key_revoked` immediately.
- Given a non-master key, When it calls `admin.users.write`, Then `403 master_required`.

**Rate limits**
- Given a key over its per-minute limit, When it calls again, Then `429` with `Retry-After` and a usage-log entry.

**Webhooks**
- Given a webhook subscribed to `email.replied`, When a reply is classified, Then a signed delivery fires; a 500 from the endpoint triggers backoff retries logged in deliveries.
- Given the same event delivered twice, When received, Then the `event_id` lets the consumer dedupe.
- Given "Test webhook", When invoked, Then a synthetic event is delivered and the signature verifies.

**AI agent**
- Given the agent proposes `sendOneOffEmailDraft`, When called, Then it returns `requires_confirmation` + a draft; nothing sends until the user approves.
- Given the user approves the draft, When executed, Then scope/compliance/credits are re-checked (TOCTOU) and the email sends, with `ai_audit_log` + `ai_tool_call` written.
- Given the agent attempts `createApiKey`/billing, When requested, Then it is refused outright (not even draftable) and routed to the human UI.
- Given the user lacks `sequence_memberships.write`, When the agent tries `addContactsToSequence`, Then it's blocked pre-draft and the agent explains.
- Given a reveal with no credits, When `enrichPerson` runs, Then `402` and no charge.

**Audit**
- Given any tool execution or key/webhook mutation, When it succeeds, Then an audit entry (actor, action, before/after) exists.

---

## 11. Implementation Checklist

**Backend**
- [ ] Tables (§6): `api_keys`, `api_key_scopes`, `api_usage_logs`, `api_rate_limits`, `webhooks`, `webhook_event_subscriptions`, `webhook_deliveries`, `ai_conversations`/`ai_messages` (generalize help), `ai_tool_calls`, `ai_action_drafts`, `ai_audit_logs`.
- [ ] Developer endpoints (keys CRUD + rotate/revoke, logs, webhooks CRUD + test + deliveries).
- [ ] Migration in BOTH `drizzle/schema.ts` AND `server/_core/rawMigrations.ts` (next: **0094**).

**API security**
- [ ] Key issuance (hash at rest, prefix, show-once), rotation grace window, revocation, expiry; per-key + per-workspace rate limiter (token bucket); master/elevated designation + step-up; usage logging.
- [ ] Unified gate middleware: scope → permission → rate-limit → compliance/credit (where relevant); workspace scoping.

**Webhooks**
- [ ] Event bus: producers (enrichment/email/sequence/crm/credit) emit; delivery worker fans out to subscriptions; signed (HMAC), idempotent (`event_id`), backoff retry, dead-letter + alert; test-delivery path.

**AI tool registry**
- [ ] Registry of 17 tools (input/output zod schemas, required scopes, `confirmation_required`, audit event), each wrapping the referenced spec's procedure.
- [ ] Agent loop (`/api/ai/chat`) proposing tool calls; `/tool-call` executing reads / staging drafts; `/action-drafts/{id}/approve` executing with TOCTOU re-check; hard block-list (keys/billing/credits) un-draftable.

**Permissioning**
- [ ] Scope catalog (§2) mapped to `memberPermissions`; agent runs under user perms; API key under key scopes; elevated/master enforcement.

**Audit logging**
- [ ] `ai_tool_call` + `ai_audit_log` on every tool; `api_usage_logs` on every API call; `audit_log` on key/webhook mutations.

**Frontend**
- [ ] `DeveloperSettingsPage` (`APIKeyTable`/`CreateAPIKeyModal`/`ScopeSelector`/`APIUsageLogTable`/`WebhookTable`/`WebhookEditor`/`WebhookDeliveryLog`).
- [ ] `AIAssistantPanel` (action agent) + `AIActionConfirmationModal` + `AIToolCallLog`. Dialogs `sm:max-w-*`.

**Tests**
- [ ] G/W/T from §10.
- [ ] Scope/expiry/rotation/revocation/rate-limit enforcement; master-required.
- [ ] Webhook signing + idempotency + retry/dead-letter + test delivery.
- [ ] Agent draft→confirm (no execution pre-approval), TOCTOU re-check, hard block-list, scope-denied pre-draft.
- [ ] Cross-workspace isolation; audit completeness.

---

### Appendix — provenance of functional references
Grounded from `Apollo Screenshots/01_ai-assistant` (AI panel) and the generic settings/table convention across Velocity — no dedicated developer-settings or API-key screenshot folder exists, so those surfaces follow established table/modal patterns. Layout/UX only; no Apollo brand assets, icons, or protected design reproduced.
