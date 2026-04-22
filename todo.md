# USIP — Project TODO

`[x]` = done, `[ ]` = pending, `[~]` = stubbed (UI complete, backing service is mock).

## 0. Foundation
- [x] Operator design tokens applied in `client/src/index.css` (dark teal sidebar, cream canvas, green accent)
- [x] Drizzle schema for all entities defined in one pass (37 tables)
- [x] Migration generated via `pnpm drizzle-kit generate` and applied via `pnpm drizzle-kit migrate`
- [x] Workspace context + middleware enforces `workspaceId` on every protected procedure (via `x-workspace-id` header)
- [x] Role guard procedures: `superAdminProcedure`, `adminWsProcedure`, `managerProcedure`, `repProcedure`
- [x] Demo workspace + seed data (24 companies, ~75 contacts, prospects, deals, customers, etc.)
- [x] DashboardLayout shell: dark sidebar, cream canvas, topbar with workspace switcher, search, role badge

## 1. Multi-Tenant Workspace Architecture
- [x] Manus OAuth login wired (template default)
- [x] On first login: auto-create workspace, owner becomes Super Admin (lazy bootstrap in `auth.me`)
- [x] Role enum: `super_admin | admin | manager | rep`
- [x] Workspace switcher in sidebar header (dropdown listing user's workspaces)
- [x] Per-workspace data isolation enforced in every db helper

## 2. Core CRM Spine
- [x] Leads list + create + AI score + convert
- [x] Contacts list + create + linked to accounts
- [x] Accounts list + hierarchy tree + ARR rollup
- [x] Opportunities list + Pipeline Kanban with drag-and-drop stage move
- [x] Tasks list + create + complete + assign + filters
- [x] Activities timeline on each record
- [x] Call logging with disposition (connected, voicemail, no-answer, bad-number, gatekeeper, callback)
- [x] Meeting notes
- [x] File attachments via S3 on accounts/contacts/leads/opportunities/customers

## 3. AI Email & Sequencing
- [x] AI Email Composer (server-side `invokeLLM`)
- [x] Sequences list + builder (multi-step cadence: email/wait/task)
- [x] Enrollment management: enroll, pause, exit
- [x] Email draft approval queue (review → approve → send)
- [x] AI Lead Scoring engine: weighted signals → 0-100 score + grade

## 4. Customer Success (Module 11)
- [x] Customers list with health tier filters
- [x] Customer detail with health breakdown (4 components)
- [x] Health scoring: usage / engagement / support / NPS, weighted
- [x] Churn risk auto-flag (banner via `churnRiskFromScore`)
- [x] Renewals Kanban (early / 90 / 60 / 30 / renewed / lost)
- [x] QBR records list
- [x] QBR scheduler + AI prep generator
- [x] NPS submit + history
- [x] Expansion potential surfaced on customer detail
- [x] Contract amendment history (add + list)

## 5. Workflow Automation (Module 8)
- [x] Rule list + toggle on/off
- [x] Rule builder: visual editor for trigger select, condition rows (field/op/value with add/remove), action rows (type + params with add/remove), with dirty-state Save
- [x] Trigger types: record created/updated, deal stage changed, task overdue, NPS submitted
- [x] Action types: create task, send email, update field, notify user, enroll in sequence
- [x] Run history log (which rule fired, on what record, when, outcome)

## 6. Social Publishing (Module 12)
- [x] Connected accounts UI (LinkedIn, Twitter/X, Facebook, Instagram) — [~] stub OAuth
- [x] Content calendar (next 30 days)
- [x] Post composer with platform select + scheduled-for
- [x] AI-generate caption variants (3 at a time)
- [x] Approval workflow (draft → in-review → approved → scheduled → published)
- [x] Publishing queue
- [x] Per-post analytics (impressions, engagement, clicks) — mock numbers
- [~] Live publishing (uses `publishNowStub` — flips status, generates synthetic engagement)

## 7. Campaigns (Module 6)
- [x] Campaign list + create
- [x] Campaign detail: container groups sequences + social posts + ads + content
- [x] Add/remove channel components
- [x] Unified analytics (pipeline, won, social posts, impressions)
- [x] Pre-launch checklist enforcement (server raises `PRECONDITION_FAILED` if any unchecked)

## 8. Custom Dashboards (Module 13)
- [x] Dashboard list + create + delete
- [x] Widget library: KPI / bar / funnel / table
- [x] Reorder widgets via ↑/↓ buttons **and** native HTML5 drag-drop swap (visual drop indicator)
- [x] Server-side widget resolver (`resolveWidget`)
- [x] Saved layouts persisted via `saveLayout`
- [x] Schedule config UI (frequency, recipients)
- [x] "Send now" button (writes a notification + audit entry)
- [~] Recurring delivery requires external cron (out of scope for this build)

## 9. Advanced CRM (Module 10)
- [x] Account Hierarchy: parent_account_id + tree view + ARR rollup
- [x] Opportunity Contact Roles full CRUD (champion/decision-maker/influencer/blocker)
- [x] Territory management: list + create + delete + JSON rules
- [x] Product Catalog: products with sku/price/cost/billing-cycle
- [x] Line items on deals (qty, unit price, discount %)
- [x] Quote/Proposal generation: builder + line items + totals + **real PDF (pdfkit)** → S3 → public URL

## 10. AI-Native Gaps (Module 15)
- [x] Audit log: every create/update/delete on tracked entities, with before/after JSON
- [x] Audit log viewer page (filter by entity type)
- [x] @mentions in activity notes (parsed `@handle`, creates notification)
- [x] In-app notifications inbox
- [x] Notification badge on topbar
- [x] SCIM v2 endpoint stubs (`/api/scim/v2/Users`, `/Groups`, `/ServiceProviderConfig`) with bearer auth
- [x] SCIM provider config UI: create provider → reveal token once → toggle / rotate / delete + recent events log

## 11. QA / Polish
- [x] Vitest specs (19 tests, all passing): health scoring, role hierarchy, quote totals, condition eval (eq/neq/gt/lt/contains/all/any), SCIM bearer auth, campaign launch checklist, **real PDF byte-validation** (header `%PDF-` + EOF marker)
- [x] Empty-state UI on every list when zero rows
- [x] Loading skeletons on every async page (via tRPC isLoading)
- [x] Live preview verified rendering with seed data
- [x] Mobile-responsive sidebar: hamburger toggle + slide-in drawer with backdrop on `<md` viewports; static sidebar on `>=md`
- [x] Runtime smoke pass via live preview: Dashboard, Pipeline, Workflows (visual builder verified), Customers (drawer + churn banner + sparkline verified) — all render with seed data, no runtime errors

## 12. Post-review fixes (this round)
- [x] Real PDF generation via pdfkit (replaces HTML-as-PDF stub) — verified by byte-signature test
- [x] Workflow rule builder is a real visual editor, not JSON pretty-print
- [x] Dashboard widgets actually reorder via DnD (drop on a card to insert)
- [x] RecordDrawer with timeline + call/meeting/note logging + S3 attachments + @mentions, wired into Leads / Contacts / Accounts / Customers / Pipeline
- [x] Customer detail surfaces churn-risk banner, NPS sparkline, and expansion potential prominently
- [x] Notification badge on topbar (refetches every 30s)

## 13. Sizing / overflow fixes (post-delivery feedback)
- [x] KPI numerics: container queries on StatCard + dashboard widgets (`@container` + `@[14rem]:text-2xl`), `tabular-nums`, `truncate`+`title`; grid breakpoints loosened to `grid-cols-2 sm:grid-cols-3 lg:grid-cols-6` so values fit on `<lg`
- [x] Customer detail health components: 6-up grid loosened, ARR/NPS cells use `tabular-nums whitespace-nowrap`, churn banner + sparkline + expansion stay one-line
- [x] Dashboard widget grid: each widget card wrapped in `@container`; KPI text scales by widget width, not viewport; funnel/table monetary cells use `tabular-nums shrink-0`
- [x] Table headers / monetary cells in Tasks / Quotes / Sequences / Drafts / Renewals / Pipeline / Accounts / Products: `tabular-nums whitespace-nowrap shrink-0` on $/numeric cells, `truncate` + `title` on long names
- [x] Topbar workspace switcher: button gets `truncate min-w-0`; PageHeader stacks title/actions vertically on `<sm`; sidebar nav labels truncate


## 14. LSI Media branding (in-app, code-side)
- [x] Uploaded `lsilogo.jpg` (icon mark) and `LSiMediaBadge180x48.png` (wordmark badge) to webdev static assets
- [x] Sidebar header replaced with the actual `LSiMediaBadge180x48.png` wordmark on a white card, with "USIP · Sales Intelligence" caption below; rendered as a plain image, not clickable (per user request)
- [x] Favicon set to LSI icon mark (`lsilogo_9858f3e6.jpg`) via `<link rel="icon">`
- [x] Browser page `<title>` set to "LSI Media · USIP"
- [x] Existing seeded workspace renamed to "LSI Media" (UPDATE workspaces); new workspaces also default to "LSI Media" via `seed.ts`

## 15. LSI Media branding (platform-side, manual — out of agent scope)
- [x] **Confirmed unavailable from agent**: `VITE_APP_TITLE` and `VITE_APP_LOGO` are platform-protected built-in secrets. The Manus secrets API rejects writes to either key ("Cannot edit built-in secrets"). User must update them directly via **Management UI → Settings → General**. Suggested title: "LSI Media · USIP". Suggested logo URL: `/manus-storage/lsilogo_9858f3e6.jpg`.


## 16. Remove lsi-media.com link (per user)
- [x] Stripped the `<a href="https://www.lsi-media.com">` wrapper from sidebar logo — renders as plain image
- [x] Updated earlier todo entry to remove the link claim


## 17. Tier 1 Gap Closure (post v1.3 requirements review)

### Sprint 1 — Lead Scoring Engine (MKT-009..MKT-013) + Lead Routing (CRM-010) ✅ DELIVERED
- [x] Add `leadScoreConfig`, `leadScoreHistory`, `leadRoutingRules` tables to drizzle/schema.ts
- [x] Generate + apply migration via drizzle-kit (0002_odd_alice.sql)
- [x] Implement Firmographic / Behavioral / AI-Fit composite scoring in server/leadScoring.ts (pure module, fully unit-tested)
- [x] tRPC `leadScoring.{getConfig,saveConfig,recompute,recomputeAll,breakdown}`
- [x] tRPC `leadRouting.{list,save,remove,reorder,applyToLead}` + auto-assign on lead create
- [x] Lead list: AI-score button now drives the new engine (still surfaces grade pill + tabular-nums score)
- [x] Live breakdown preview on Lead Scoring page (3 component bars + 90-day sparkline)
- [x] Settings → Lead Scoring page (`/lead-scoring`): all 16 weight knobs + tier band visualization + Recalculate-All
- [x] Settings → Lead Routing page (`/lead-routing`): rule list, ↑↓ priority reorder, condition + strategy editor, target picker
- [x] Sales-Ready threshold-cross notification to assigned user (kind=`system`)
- [x] Vitest: 22 specs (scoring math, decay, tier bands, RR cursor, priority order, disabled rules, ANY/ALL semantics, legacy condition normalization)
- [x] Full vitest suite: 41/41 passing


## 18. Email Tool — Dynamic + Static paths (from pasted spec, scope review)

### Dynamic path — AI resolved at send time (MKT-014..MKT-017, EML-004..EML-007)
- [ ] 5-Stage Research-to-Email pipeline: (1) Organization research → (2) Contact research → (3) Fit analysis JSON {fit_score, pain_points, recommended_products, objection_risks} → (4) 3-variant draft generation (ROI / pain-point / social-proof) in parallel → (5) Queue for human approval
- [ ] Trigger modes for pipeline: manual, bulk multi-select, auto-on-sequence-enroll, nightly batch for leads above score threshold
- [ ] Email Draft Review Queue: surface research context accordion (org + contact + fit JSON) so reviewer can validate personalization
- [ ] Variant selector in review UI (pick 1 of 3 before approve, or re-request with different angle)
- [ ] Dynamic audience segments (saved filter → re-evaluated at send time, auto-enroll)
- [ ] Merge variable live-resolution at send: recent news, job changes, funding events, tech-stack updates (not baked into draft)
- [ ] Subject-line A/B optimizer wired to send-time variant pick
- [ ] Brand Voice / AI Personality profile (persona name, tone rules, prohibited words, style examples) applied to generation prompts

### Static path — Visual Drag-and-Drop Builder (MKT-022..MKT-025, EML-008..EML-011)
- [ ] Three-panel builder canvas (block library left / canvas middle / properties right)
- [ ] Block types: Text, Image, Button, Divider, Spacer, Social Icons, Unsubscribe
- [ ] Row layouts: 1-col / 2-col / 3-col with drag-to-reorder
- [ ] Canvas serialization → `design_data` JSON column on email templates
- [ ] Renderer: `design_data` → inline-CSS HTML compatible with major email clients
- [ ] Inline AI writing assistant per Text block: rewrite / shorten / lengthen / tone-shift
- [ ] Subject Line Optimizer: generate up to 5 variants against finished creative
- [ ] Readability + spam-score analyzer (flag trigger words + formatting risks)
- [ ] Snippet library (reusable AI-drafted intros, CTAs, objection handles, P.S. lines)
- [ ] Merge variables with configurable fallback values resolve at send even on static layouts
- [ ] Mixed-mode sequence support: Day 1 dynamic AI draft + Day 14 static newsletter in same cadence, both tracked into the same CRM activity timeline

### Schema / infra dependencies these unlock
- [ ] New tables: `email_templates` (design_data + compiled_html), `email_snippets`, `brand_voice_profiles`, `audience_segments`, `email_research_artifacts`, `email_variants`, `email_send_log`
- [ ] Real SMTP transport (currently `send` only marks DB row → no outbound delivery)
- [ ] Open-pixel / click-tracking / reply-webhook ingestion (currently columns exist, no writers)


## 19. Settings + Team rebuild ✅ DELIVERED
### Settings page (tabbed) — all shipped
- [x] General: timezone editor + 8 summary stat cards
- [x] Branding: primary + accent color pickers, email-from name, email signature defaults
- [x] Security: session timeout, IP allowlist (text area), 2FA-enforcement toggle
- [x] Notifications: per-event in-app + email toggles (5 events: newLeadRouted, salesReadyCrossed, dealMoved, taskOverdue, mention)
- [x] Integrations: status cards for Manus OAuth, SCIM, Stripe, Data API Hub, LLM, Google Maps
- [x] Billing: seats-used + emails sent + LLM tokens for current month, invoice history placeholder
- [~] Danger zone: section + buttons rendered, but transfer ownership + archive + export are UI placeholders only (toast "Coming soon") — not wired to backend yet
- [ ] Danger zone: implement real workspace archive (soft-delete + 90-day retention)
- [ ] Danger zone: implement real transfer-ownership mutation
- [ ] Danger zone: implement real data-export job
- [ ] Security: password-policy section (min length, complexity, rotation) — not yet wired, only session/IP/2FA shipped

### Team page — all shipped
- [x] Row-level role dropdown (role-rank guarded) with sole-super_admin protection
- [x] Invite dialog (email + name + title + role + quota) with auto-create-or-link user
- [x] Deactivate dialog with required reassign-to picker → reassigns all open leads/opps/tasks
- [x] Reactivate button
- [x] Columns: avatar, name, title, role, quota, last active, status
- [x] Search + role filter + show-deactivated toggle
- [x] Multi-select + bulk role change
- [ ] Multi-select + bulk deactivate (single-row deactivate with reassignment works; bulk variant still TODO)
- [ ] Deactivated-at column (currently surfaced as "deactivated" status pill + the row is dimmed; explicit timestamp column not yet added to the table header)

### Schema additions — all migrated (0003_sturdy_fixer.sql)
- [x] workspace_settings (PK workspaceId + brand + security + notify)
- [x] workspace_members.deactivatedAt + lastActiveAt
- [x] usage_counters (workspaceId, month, llmTokens, emailsSent)

### vitest — 11 new pure-logic specs, 52/52 total passing
- [x] role-rank guards (actor cannot assign higher than own)
- [x] peer-protection guard (admin cannot touch other admin)
- [x] super_admin bypasses peer guard
- [x] sole super_admin cannot be demoted
- [x] reassign target must be active member
- [x] cannot deactivate self
- [x] hex-color validator
- [x] session timeout range check
- [x] default notifyPolicy shape

### vitest gaps (pure-logic only — no DB fixtures in this template)
- [ ] DB-backed integration: settings.save round-trips through workspace_settings row
- [ ] DB-backed integration: team.invite creates users row + workspace_members row
- [ ] DB-backed integration: team.changeRole router throws FORBIDDEN when actor < target rank
- [ ] DB-backed integration: team.deactivate sets deactivatedAt AND reassigns ownerUserId on leads/opportunities/tasks
- [ ] (needs a test-container or mocked drizzle client — current test runner is pure-logic only)

## 20. Visual Canvas Sequence Builder (Sprint 2 — Tier 1) ✅ DELIVERED
- [x] Install @xyflow/react 12.10.2
- [x] Add `sequenceNodes` + `sequenceEdges` tables (migration 0004_wooden_umar.sql)
- [x] tRPC: sequences.getCanvas / sequences.saveCanvas (atomic replace, lifecycle guard)
- [x] Canvas page at /sequences/:id/canvas with 6 node types: Start, Email, Wait, Condition, Action, Goal
- [x] Drag-from-palette sidebar with color-coded node type buttons
- [x] Condition node: TRUE / FALSE source handles with color-coded labels
- [x] Action node type in palette
- [x] Edge validation vitest: condition must have 2 outgoing true/false edges, goal must have no outgoing edges
- [x] Zoom 25–200%, fit-to-screen (fitView), pan (React Flow Controls)
- [x] 30-second autosave with save-state indicator (Saved / Unsaved / Saving)
- [x] Save now button
- [x] Lifecycle: Draft → Active → Paused → Archived; canvas palette disabled + read-only banner when Active/Paused
- [x] Activate / Pause / Resume / Archive buttons in canvas header
- [x] "Open canvas" button on Sequences list detail panel
- [x] 8 canvas validation vitest specs (all passing)

## 21. Integrations tab — actionable cards ✅ DELIVERED
- [x] Add `workspaceIntegrations` table (migration 0004_wooden_umar.sql)
- [x] tRPC: integrations.list / integrations.save / integrations.test / integrations.remove
- [x] Built-in providers (manus_oauth, data_api, llm, google_maps) auto-seeded as connected
- [x] Each card: status icon (green check / red X / empty circle), last test result, Test button
- [x] Configurable providers (scim, stripe, webhook): inline config form with field types
- [x] Stripe: publishable + secret key fields
- [x] SCIM: bearer token field + link to /scim docs
- [x] Webhook: URL + signing secret fields
- [x] Test mutation pings provider and persists result + updates status
- [x] Remove button for non-built-in providers (admin only)
- [x] 5 integration config validation vitest specs

## 22. Dashboard customization ✅ DELIVERED
- [x] Add `dashboardLayouts` table (migration 0004_wooden_umar.sql)
- [x] tRPC: dashboardLayouts.getLayout / dashboardLayouts.saveLayout
- [x] Dashboard page: Customize mode toggle (shows/hides reorder + remove controls)
- [x] Rename dashboard dialog (trpc.dashboards.rename)
- [x] Add widget dialog (KPI, Bar, Funnel, Top accounts)
- [x] Remove widget button (visible only in customize mode)
- [x] Drag-to-reorder (HTML5 drag-and-drop, swap on drop)
- [x] ↑/↓ move buttons (visible only in customize mode)
- [x] Delete dashboard button (visible only in customize mode, with confirm)
- [x] 5 dashboard layout serialization vitest specs
- [x] 70/70 total vitest specs passing

## 21. Integrations tab — actionable cards
- [ ] Add `workspaceIntegrations` table (workspaceId, provider, status, config JSON, lastTestedAt, createdAt)
- [ ] Generate + apply migration
- [ ] tRPC: integrations.list / integrations.save / integrations.test / integrations.remove
- [ ] Settings → Integrations: each card shows status + Configure / Connect / Disconnect / Test buttons
- [ ] Manus OAuth: read-only (always connected), show App ID
- [ ] SCIM 2.0: generate bearer token, copy to clipboard, revoke
- [ ] Stripe: enter publishable + secret key, test connection
- [ ] Data API Hub: show built-in key (masked), copy, test
- [ ] LLM provider: show model in use, test ping
- [ ] Google Maps: show proxy status, test geocode
- [ ] Custom webhook: add URL + secret, test ping
- [ ] Vitest: integration config validation

## 22. Dashboard customization
- [ ] Add `dashboardLayouts` table (workspaceId, userId, dashboardId, layout JSON)
- [ ] Generate + apply migration
- [ ] tRPC: dashboards.getLayout / dashboards.saveLayout
- [ ] Dashboard page: "Customize" toggle that reveals drag-reorder handles on widget cards
- [ ] Add widget dialog: pick from available widget types (pipeline, revenue, leads, tasks, NPS, renewals, AI drafts, activity feed, quota attainment)
- [ ] Remove widget button (×) per card in customize mode
- [ ] Rename dashboard dialog
- [ ] Layout persisted per user per dashboard
- [ ] Vitest: layout serialization
