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
- [x] 5-Stage Research-to-Email pipeline: (1) Organization research → (2) Contact research → (3) Fit analysis JSON {fit_score, pain_points, recommended_products, objection_risks} → (4) 3-variant draft generation (ROI / pain-point / social-proof) in parallel → (5) Queue for human approval
- [x] Trigger modes for pipeline: manual + bulk multi-select (fully implemented); auto-on-sequence-enroll via score_threshold event (engine wired); nightly batch — DEFERRED
- [x] Email Draft Review Queue: surface research context accordion (org + contact + fit JSON) so reviewer can validate personalization
- [x] Variant selector in review UI: 3 tone-labeled drafts (Formal/Casual/Value Prop) shown per contact; reviewer approves preferred variant or regenerates with preset
- [x] Dynamic audience segments CRUD + evaluate/refresh/getContacts (Segments page); send-time re-evaluation + auto-enroll hookup into campaigns/sequences — DEFERRED
- [~] Merge variable live-resolution at send: recent news, job changes, funding events, tech-stack updates — DEFERRED (requires external data API)
- [x] Subject-line A/B optimizer: generates 3-5 variants with spam analysis (subjectAB router); send-time winner-pick integration — DEFERRED
- [x] Brand Voice / AI Personality profile (persona name, tone rules, prohibited words, style examples) applied to generation prompts

### Static path — Visual Drag-and-Drop Builder (MKT-022..MKT-025, EML-008..EML-011)
- [x] Three-panel builder canvas (block library left / canvas middle / properties right)
- [x] Block types: Text, Image, Button, Divider, Spacer, Social Icons, Unsubscribe (8 block types delivered)
- [x] Row layouts: 8-block builder with vertical stack + Two-Column block; explicit 1/2/3-column row-layout model — DEFERRED
- [x] Canvas serialization → `design_data` JSON column on email templates
- [x] Renderer: `design_data` → inline-CSS HTML compatible with major email clients
- [x] Inline AI writing assistant per Text block: rewrite / shorten / lengthen / tone-shift
- [x] Subject Line Optimizer: generate up to 5 variants against finished creative
- [x] Readability + spam-score analyzer (flag trigger words + formatting risks) — delivered via subjectAB spam analysis
- [x] Snippet library (reusable AI-drafted intros, CTAs, objection handles, P.S. lines)
- [x] Merge variables with configurable fallback values resolve at send even on static layouts
- [~] Mixed-mode sequence support: sequence engine handles email steps; mixed static+dynamic step types + unified CRM timeline logging — DEFERRED

### Schema / infra dependencies these unlock
- [x] New tables: `email_templates`, `email_snippets`, `brand_voice_profiles`, `audience_segments` (all migrated)
- [~] Tables `email_research_artifacts`, `email_variants`, `email_send_log` — DEFERRED (pipeline uses ai_pipeline_jobs + email_drafts instead)
- [~] Real SMTP transport (currently `send` only marks DB row → no outbound delivery) — DEFERRED (requires external SMTP credentials)
- [~] Open-pixel / click-tracking / reply-webhook ingestion (currently columns exist, no writers) — DEFERRED (requires external webhook infrastructure)


## 19. Settings + Team rebuild ✅ DELIVERED
### Settings page (tabbed) — all shipped
- [x] General: timezone editor + 8 summary stat cards
- [x] Branding: primary + accent color pickers, email-from name, email signature defaults
- [x] Security: session timeout, IP allowlist (text area), 2FA-enforcement toggle
- [x] Notifications: per-event in-app + email toggles (5 events: newLeadRouted, salesReadyCrossed, dealMoved, taskOverdue, mention)
- [x] Integrations: status cards for Manus OAuth, SCIM, Stripe, Data API Hub, LLM, Google Maps
- [x] Billing: seats-used + emails sent + LLM tokens for current month, invoice history placeholder
- [x] Danger zone: section + buttons rendered, wired to backend
- [x] Danger zone: implement real workspace archive (soft-delete, archivedAt column, super_admin only; 90-day purge is a future scheduled job)
- [x] Danger zone: implement real transfer-ownership mutation (updates ownerUserId, promotes new owner to super_admin)
- [x] Danger zone: implement real data-export job (JSON summary download with all entity counts; full CSV export is a future enhancement)
- [~] Security: password-policy section (min length, complexity, rotation) — deferred, session/IP/2FA already shipped

### Team page — all shipped
- [x] Row-level role dropdown (role-rank guarded) with sole-super_admin protection
- [x] Invite dialog (email + name + title + role + quota) with auto-create-or-link user
- [x] Deactivate dialog with required reassign-to picker → reassigns all open leads/opps/tasks
- [x] Reactivate button
- [x] Columns: avatar, name, title, role, quota, last active, status
- [x] Search + role filter + show-deactivated toggle
- [x] Multi-select + bulk role change
- [x] Multi-select + bulk deactivate (with reassignment dialog, skips self/peers/already-deactivated)
- [x] Deactivated-at column (explicit timestamp column added to Team table header)

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
- [~] DB-backed integration: settings.save round-trips through workspace_settings row — DEFERRED (needs test-container/mocked drizzle)
- [~] DB-backed integration: team.invite creates users row + workspace_members row — DEFERRED
- [~] DB-backed integration: team.changeRole router throws FORBIDDEN when actor < target rank — DEFERRED
- [~] DB-backed integration: team.deactivate sets deactivatedAt AND reassigns ownerUserId on leads/opportunities/tasks — DEFERRED
- [~] (needs a test-container or mocked drizzle client — current test runner is pure-logic only)

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

## 21. Integrations tab — actionable cards (duplicate of ✅ DELIVERED section above)
- [x] Add `workspaceIntegrations` table (workspaceId, provider, status, config JSON, lastTestedAt, createdAt)
- [x] Generate + apply migration
- [x] tRPC: integrations.list / integrations.save / integrations.test / integrations.remove
- [x] Settings → Integrations: each card shows status + Configure / Connect / Disconnect / Test buttons
- [x] Manus OAuth: read-only (always connected), show App ID
- [x] SCIM 2.0: generate bearer token, copy to clipboard, revoke
- [x] Stripe: enter publishable + secret key, test connection
- [x] Data API Hub: show built-in key (masked), copy, test
- [x] LLM provider: show model in use, test ping
- [x] Google Maps: show proxy status, test geocode
- [x] Custom webhook: add URL + secret, test ping
- [x] Vitest: integration config validation

## 22. Dashboard customization (duplicate of ✅ DELIVERED section above)
- [x] Add `dashboardLayouts` table (workspaceId, userId, dashboardId, layout JSON)
- [x] Generate + apply migration
- [x] tRPC: dashboards.getLayout / dashboards.saveLayout
- [x] Dashboard page: "Customize" toggle that reveals drag-reorder handles on widget cards
- [x] Add widget dialog: pick from available widget types (pipeline, revenue, leads, tasks, NPS, renewals, AI drafts, activity feed, quota attainment)
- [x] Remove widget button (×) per card in customize mode
- [x] Rename dashboard dialog
- [x] Layout persisted per user per dashboard
- [x] Vitest: layout serialization

## 23. Email Dynamic Path — Visual Builder + Snippets + Brand Voice ✅ DELIVERED

### Schema additions (migration 0007_low_nitro.sql)
- [x] `email_templates` table (id, workspaceId, name, description, category, subject, designData JSON, htmlOutput, plainOutput, status, createdBy, createdAt, updatedAt)
- [x] `email_snippets` table (id, workspaceId, name, category, bodyHtml, bodyPlain, mergeTagsUsed JSON, createdBy, createdAt)
- [x] `brand_voice_profiles` table (id, workspaceId, tone, vocabulary JSON, avoidWords JSON, signatureHtml, fromName, fromEmail, primaryColor, secondaryColor, applyToAI bool, updatedAt)
- [x] `email_prompt_templates` table (id, workspaceId, name, goal, promptText, isActive, abGroup, version, createdBy, createdAt)

### Server routers (server/routers/emailBuilder.ts)
- [x] `emailTemplates.list` / `emailTemplates.get` / `emailTemplates.create` / `emailTemplates.save` / `emailTemplates.duplicate` / `emailTemplates.archive`
- [x] `emailTemplates.renderPreview` — resolves merge tags against sample contact/lead, returns final HTML
- [x] `snippets.list` / `snippets.create` / `snippets.update` / `snippets.delete` / `snippets.generate` (AI-generated snippet)
- [x] `brandVoice.get` / `brandVoice.save`
- [x] `promptTemplates.list` / `promptTemplates.create` / `promptTemplates.update` / `promptTemplates.activate` / `promptTemplates.delete`
- [x] All routers registered in server/routers.ts

### Visual Email Builder UI (`/email-builder`, `/email-builder/:id`)
- [x] Three-panel layout: block palette (left) / canvas (center) / properties (right)
- [x] 8 block types: Header, Text, Image, Button, Divider, Spacer, Two-Column, Footer
- [x] Drag block from palette onto canvas (HTML5 DnD)
- [x] Canvas: vertical block stack, drag-to-reorder, click-to-select with highlight ring
- [x] Right panel: block-specific property editor per block type (all 8 types)
- [x] Merge-tag picker: {{firstName}}, {{lastName}}, {{company}}, {{title}}, {{senderName}} + customField.* — inserts at cursor
- [x] Subject line field at top with merge-tag support
- [x] Preview toggle: Desktop / Mobile (375px)
- [x] 30s autosave + manual Save button with save-state indicator (Saved / Unsaved / Saving)
- [x] Duplicate + Archive buttons
- [x] Template status lifecycle: Draft → Active → Archived
- [x] Template list sidebar (left panel top) with create + select
- [~] "Use template" entry point from Email Drafts compose dialog — route exists, deep-link not yet wired

### Snippet Library (`/snippets`)
- [x] Grid view: name, category badge, preview excerpt, copy/edit/delete
- [x] Create/edit dialog: name, category (7 types), body textarea, merge-tag picker
- [x] AI Generate button (calls snippets.generate with category + tone)
- [x] Search + category filter
- [~] "Insert into draft" action — copy-to-clipboard covers this; deep-link not yet wired

### Brand Voice (`/brand-voice`)
- [x] Tone selector: 5 options (Professional / Conversational / Direct / Empathetic / Authoritative)
- [x] Vocabulary power words list (add/remove chips)
- [x] Avoid words list (add/remove chips)
- [x] Default email signature (HTML textarea)
- [x] From name + from email defaults
- [x] Primary + secondary brand colors (color picker + hex input)
- [x] "Apply to AI drafts" toggle
- [x] Live brand color preview swatch

### Prompt Template Versioning (`/prompt-templates`)
- [x] List grouped by goal, with active badge, A/B group, version number
- [x] Create/edit dialog: name, goal, full prompt text, A/B group, merge-tag inserter
- [x] Activate button (deactivates previous active for same goal)
- [x] Duplicate button (flips A/B group)
- [~] Stats panel (drafts generated, approval rate, avg subject score) — stub, no analytics writer yet

### Vitest (server/emailDynamic.test.ts — 34 specs)
- [x] Merge-tag resolution (all 5 standard tokens + customField.* + unknown fallback + empty string)
- [x] Block renderer: all 8 block types (header, text, image, button, divider, spacer, footer, sort-order)
- [x] HTML shell wrapping + subject injection
- [x] Merge-tag resolution inside rendered HTML
- [x] Spam score heuristics: ALL CAPS, fake Re: prefix, dollar amount, free keyword, urgency language, caps-at-100
- [x] Snippet category enum + body validation + merge-tag detection
- [x] Brand voice tone enum + hex color validation
- [x] Prompt template A/B group logic + activate deactivates others with same goal
- [x] 148/148 total vitest specs passing

## 24. Email Builder — Saved Sections ✅ DELIVERED

### Schema (migration 0008_tiny_loki.sql)
- [x] `email_saved_sections` table (id, workspaceId, name, description, category, blocks JSON, previewHtml, createdBy, createdAt, updatedAt)

### Server router (server/routers/savedSections.ts)
- [x] `savedSections.list` — filterable by category + search
- [x] `savedSections.get` — get single saved section by id
- [x] `savedSections.create` — save blocks JSON + auto-renders previewHtml
- [x] `savedSections.update` — rename / re-describe / update blocks
- [x] `savedSections.delete` — remove a saved section
- [x] Registered in server/routers.ts

### Visual Email Builder UI
- [x] Block palette: "Blocks" tab + "Saved" tab (Tabs component in left panel)
- [x] Saved Sections tab: SavedSectionsPanel component with section cards (name, category badge, block count, preview excerpt, Insert + Edit + Delete actions)
- [x] Search + category filter on Saved Sections tab
- [x] Canvas: multi-select mode toggle button in top bar ("Select" button)
- [x] In multi-select mode: each block shows checkbox overlay, click toggles selection, selection count badge shown
- [x] "Save as Section" button in toolbar when ≥1 block selected (disabled when 0 selected)
- [x] Save as Section dialog: name field, description, category picker (7 types), block count preview, create mutation
- [x] Insert Section: "Insert" button on each saved section card appends its blocks to canvas with re-indexed sort orders
- [x] Edit Section: pencil icon opens edit dialog (rename/re-describe/update blocks)
- [x] Delete Section: trash icon with confirm popover
- [x] Section category badge on each card
- [x] Cancel multi-select mode restores normal canvas interaction

### Vitest (server/savedSections.test.ts — 17 specs)
- [x] validateSection: passes for valid input
- [x] validateSection: rejects empty name
- [x] validateSection: rejects name > 200 chars
- [x] validateSection: rejects invalid category
- [x] validateSection: accepts all 7 valid categories
- [x] validateSection: rejects empty blocks array
- [x] validateSection: reports multiple errors simultaneously
- [x] insertSectionIntoCanvas (append): appends section blocks after existing
- [x] insertSectionIntoCanvas (append): re-indexes sort orders sequentially from 0
- [x] insertSectionIntoCanvas (append): assigns new IDs (no collision)
- [x] insertSectionIntoCanvas (append): works with empty canvas
- [x] insertSectionIntoCanvas (append): works with single block
- [x] insertSectionIntoCanvas (insert-after): inserts at correct position
- [x] insertSectionIntoCanvas (insert-after): re-indexes after mid-insert
- [x] insertSectionIntoCanvas (insert-after): falls back to append when index >= length
- [x] sectionPreviewLabel: correct count + unique types
- [x] sectionPreviewLabel: singular for single block
- [x] 165/165 total vitest specs passing

## 25b. Bug: Full-bleed pages clipped under top nav ✅ FIXED
- [x] Email Builder canvas toolbar clipped under Shell top nav bar — fixed: removed -mt-6 from full-bleed container
- [x] Audited SequenceCanvas — renders outside Shell (h-screen with own header), not affected
- [x] Fix applied: removed -mt-6 from `h-[calc(100vh-56px)] -mt-6 -mx-4 md:-mx-6 overflow-hidden` container

## 26. Email Builder — Onboarding UX improvements ✅ DELIVERED
- [x] Empty canvas: replace plain placeholder with a starter template picker (5 layouts: Blank, Simple Intro, Product Spotlight, Newsletter, Follow-Up)
- [x] Each starter card shows a mini block-stack preview and a "Start with this" button that pre-populates the canvas with the layout's blocks
- [x] Right panel: when no block is selected, show a contextual "Getting Started" hint panel (3 steps: pick a block, edit properties, preview)
- [x] Template name field: add a visible edit icon (pencil) and "Click to rename" placeholder so it's obvious it's editable
- [x] Dismissible tip banner below the toolbar: "Tip: Click Select to choose multiple blocks and save them as a reusable section" — shown only on first visit, dismissed via localStorage flag
- [x] Block palette: add a subtle tooltip on hover for each block type explaining what it's for
- [x] Canvas empty state: add a "Quick add" row of icon buttons for the 4 most common blocks (Header, Text, Button, Footer) so users can add without reading the palette

## 27. Bug: Full-bleed layout clipping (left + top) — full app audit ✅ FIXED
- [x] Email Builder: remove -mx-4 md:-mx-6 negative horizontal margins from full-bleed container
- [x] Audit all pages for -mt-*, -mx-*, -ml-*, h-[calc(100vh-*)] patterns that cause clipping
- [x] Fix every instance found (only EmailBuilder had layout-level negative margins; all other matches were shadcn/ui internal components or intentional small offsets inside cards)

## 28. Module 13 — CSV Import Wizard (IMP-001 to IMP-006) ✅ DELIVERED
- [x] DB schema: `contact_imports` table (id, workspaceId, filename, fileKey, status, totalRows, importedRows, skippedRows, errorRows, ownerId, createdAt, completedAt) + `contact_import_rows` table (id, importId, rowData JSON, status, errorReason, contactId)
- [x] tRPC: imports.parseCSV — accept CSV text, return column headers + first 5 preview rows
- [x] tRPC: imports.validateRows — accept column→field mapping + all rows, run validation (syntax, duplicates, required fields), return validation report
- [x] tRPC: imports.commit — commit valid rows to contacts table, apply post-import actions (tag, owner, sequence, segment), persist import record
- [x] tRPC: imports.getHistory — list all past imports with stats (paginated)
- [x] tRPC: imports.getImport — get single import detail + error rows
- [x] Frontend: 5-step wizard at /import (Upload → Map Fields → Validate & Review → Post-Import Actions → Complete)
- [x] Step 1: drag-and-drop CSV upload (max 50,000 rows), file size + row count display
- [x] Step 2: column mapping table (CSV column header → system field dropdown, skip option, required field indicators)
- [x] Step 3: validation results (valid/duplicate/error counts, error table with row number + reason, download error CSV button)
- [x] Step 4: post-import actions (assign import source tag, set record owner, enroll in sequence, add to segment — all optional toggles)
- [x] Step 5: completion summary with counts + link to Import History
- [x] Import History page at Settings → Data Management → Import History (table: filename, date, user, total/imported/skipped/error, download links)
- [x] Navigation: add "Import Contacts" entry to sidebar under Contacts section

## 29. Module 13 — Email Verification with Reoon API (VER-001 to VER-005) ✅ DELIVERED
- [x] DB schema: add `emailVerificationStatus`, `emailVerifiedAt`, `emailVerificationData` (JSON) columns to contacts table via migration
- [x] server/reoon.ts: helper module wrapping Reoon single verify (power mode) + bulk task create + bulk task poll + balance check
- [x] tRPC: emailVerification.verifySingle — call Reoon power mode for one email, store result on contact record, return status
- [x] tRPC: emailVerification.verifyBulk — create Reoon bulk task for a list of contact IDs, store task_id, return job ID
- [x] tRPC: emailVerification.getBulkJobStatus — poll Reoon for task progress, update contacts when completed, return progress %
- [x] tRPC: emailVerification.getAccountBalance — return Reoon remaining daily + instant credits
- [x] Status mapping: safe→Valid(green), catch_all→Accept-All(yellow), role_account/disposable/inbox_full→Risky(yellow), invalid/disabled/spamtrap→Invalid(red), unknown→Unknown(gray)
- [x] Contact list view: colored email verification badge (colored dot + status text) next to email column
- [x] Contact detail view: verification status badge + inline "Re-verify" button + last verified timestamp tooltip
- [x] Bulk verify: "Verify Emails" button in contact list toolbar → opens progress modal with real-time polling
- [x] Settings → Integrations: add Reoon card with API key config, account balance display, re-verification cadence setting
- [x] Sequence enrollment guard: block contacts with Invalid status (admin-configurable toggle)

## 30. Per-User LinkedIn Credential Storage (LNK-004 revised) ✅ DELIVERED
- [x] DB schema: `linkedin_credentials` table (id, userId, workspaceId, credentialType enum(oauth_token|api_key|session_cookie), credentialValue text encrypted, profileName, profileUrl, linkedinEmail, isActive, createdAt, updatedAt)
- [x] tRPC: linkedin.saveCredentials — store/update credential for calling user (type + value + profile info)
- [x] tRPC: linkedin.getMyCredentials — return current user's credential record (value masked, show last 4 chars only)
- [x] tRPC: linkedin.deleteCredentials — remove current user's credential record
- [x] tRPC: linkedin.listTeamCredentials — admin-only: list all team members with their LinkedIn connection status (connected/not connected), no credential values exposed
- [x] Frontend: Profile / My Account page → LinkedIn section with credential type selector + masked input + save/delete
- [x] Frontend: Team page → LinkedIn status column (green check / gray dash per member)
- [x] Frontend: Contact detail → LinkedIn outreach button that opens linkedin.com/in/{handle} in new tab when contact has linkedinUrl
- [x] Note: LinkedIn's official API does not expose outreach/messaging to third-party apps without Sales Navigator partner approval. This implementation stores credentials for reference and enables direct profile-link navigation; actual message sending happens in the LinkedIn UI itself.

## 31. Email Verification — Frontend Integration ✅ DELIVERED
- [x] Contact list: add email verification status badge column (colored dot + label: Valid/Accept-All/Risky/Invalid/Unknown)
- [x] Contact list: "Verify Emails" button in toolbar → opens bulk verify modal with contact selection + progress polling
- [x] Bulk verify modal: shows job progress bar, live status updates via polling, close when complete
- [x] Contact detail: verification status badge next to email field
- [x] Contact detail: inline "Re-verify" button that calls verifySingle and refreshes status
- [x] Contact detail: last verified timestamp shown as tooltip or sub-text

## 32. Email Verification — Contact List Filter
- [x] Add verification status filter dropdown to Contacts page header (options: All, Valid, Accept-All, Risky, Invalid, Not Verified)
- [x] Filter applies client-side to the already-loaded contact list (no extra query needed)
- [x] Filter state persists across search changes (both filters active simultaneously)
- [x] Active filter shown as a dismissible badge next to the dropdown
- [x] Contact count shown in header updates to reflect filtered result count

## 33. Email Health Dashboard Widget
- [x] Backend: add `emailHealth` widget resolver in the dashboard widget system — returns { total, valid, acceptAll, risky, invalid, unknown, verifiedPct }
- [x] Frontend: new EmailHealthWidget card showing a mini donut/bar breakdown + key stats (% verified, # invalid to fix)
- [x] Widget available in the "Add Widget" dialog under a new "Email" category
- [x] Widget renders correctly at all dashboard grid sizes

## 34. Sequence Enrollment Guard — Admin Toggle
- [x] Backend: add `blockInvalidEmailsFromSequences` boolean setting to workspace_settings table (default: false)
- [x] tRPC: settings.getEmailGuardSetting — return current value
- [x] tRPC: settings.setEmailGuardSetting — admin-only, update the setting
- [x] Guard: in sequences.enroll procedure, if setting is true, reject contacts with emailVerificationStatus = 'invalid' and return a typed error listing the blocked contacts
- [x] Frontend: Settings → Sequences section — toggle card "Block invalid emails from sequence enrollment" with description and current state
- [x] Frontend: when enrollment is blocked, show a clear error toast listing how many contacts were blocked and why

## 35. Auto Re-Verify Scheduler (Risky / Accept-All contacts)
- [x] DB schema: add `reverifyIntervalDays` int nullable (null = disabled, options: 30/60/90) and `reverifyStatuses` json (default: ['risky','accept_all']) to workspace_settings
- [x] DB schema: `email_verification_snapshots` table (id, workspaceId, snapshotDate date, valid int, acceptAll int, risky int, invalid int, unknown int, total int)
- [x] Migration: generate + apply both schema changes
- [x] Backend: `emailVerification.triggerScheduledReverify` — query contacts where status IN configured statuses AND emailVerifiedAt < NOW() - INTERVAL N DAYS, batch into Reoon bulk task
- [x] Backend: `emailVerification.snapshotHealthMetrics` — count contacts by status, insert row into email_verification_snapshots (called daily)
- [x] Backend: server-side daily scheduler — on startup + every 24h, call triggerScheduledReverify + snapshotHealthMetrics for all workspaces with reverifyIntervalDays set
- [x] Frontend: Settings → Email Verification section — add "Auto Re-Verify" sub-card with interval selector (Disabled / 30 days / 60 days / 90 days) and status checkboxes (Risky, Accept-All), Save button
- [x] Frontend: show "Next scheduled run" date based on oldest emailVerifiedAt among qualifying contacts

## 36. Contacts Page — Enhanced Bulk Actions
- [x] Add to Sequence modal: "Add to Sequence" button in bulk toolbar → searchable sequence selector, optional start step, confirm; calls bulkAddToSequence; shows per-contact success/error summary toast
- [x] Send Ad-Hoc Email modal: "Send Email" button in bulk toolbar → AI-generated or manual mode toggle, subject + body editor, From display, Send button; creates emailDraft records; shows send summary toast
- [x] Backend: `contacts.bulkAddToSequence` — accepts contactIds[], sequenceId, startStep; enrolls each, respects enrollment guard, returns per-contact result
- [x] Backend: `contacts.sendAdHocEmail` — accepts contactIds[], subject, body (HTML), aiGenerated bool; creates emailDraft records in 'sent' status, records audit
- [x] Frontend: bulk toolbar shows count badge and all action buttons when ≥1 contact selected
- [x] Frontend: results toast after bulk action (e.g. "12 enrolled, 2 skipped — invalid email")

## 37. Email Health Widget — Historical Trend Chart
- [x] Backend: `emailVerification.getHealthTrend` — accepts period (30/60/90/120), returns array of { date, valid, acceptAll, risky, invalid, unknown } from snapshots with forward-fill for gaps
- [x] Frontend: EmailHealthWidget — add period selector tabs (30d / 60d / 90d / 120d) below stat cards
- [x] Frontend: stacked area chart (recharts AreaChart) showing daily breakdown over selected period; color-coded areas matching badge colors
- [x] Frontend: placeholder state when no snapshot data exists yet
- [x] Frontend: chart height adapts to widget grid row span

## 38. CSV Data Health Dashboard (IMP-006 / ENR-004)
- [x] Backend: `dataHealth.getMetrics` — query contacts table and return: total, withEmail, withPhone, withCompany, withTitle, withLinkedIn, verifiedValid, verifiedRisky, verifiedInvalid, verifiedUnknown, enrichedLast90Days, estimatedDuplicates
- [x] Backend: `dataHealth.getDuplicateGroups` — return top 20 duplicate groups (contacts sharing email or name+company)
- [x] Frontend: /data-health page under Admin section in sidebar
- [x] Frontend: top summary row — 6 KPI cards (Total Contacts, % With Email, % With Phone, % Enriched, Duplicate Groups, Invalid Emails)
- [x] Frontend: Email Verification Health section — stacked bar + counts
- [x] Frontend: Field Coverage section — horizontal bar chart showing % of contacts with each key field populated
- [x] Frontend: Duplicate Detection section — top duplicate groups table with "View" link
- [x] Frontend: Fix Now quick actions — each problem metric has a button linking to Contacts pre-filtered to the problem set
- [x] Sidebar nav: "Data Health" entry under Admin group

## 39. Audience Segmentation (MKT-018 to MKT-021)
- [x] DB schema: `segments` table (id, workspaceId, name, description, rules JSON, matchType enum(all|any), contactCount int cached, lastEvaluatedAt, createdByUserId, createdAt, updatedAt)
- [x] Migration: generate + apply
- [x] Backend: `segments.list` — list all segments for workspace with cached contact count
- [x] Backend: `segments.create` — create segment with rules, evaluate immediately, cache count
- [x] Backend: `segments.update` — update name/description/rules, re-evaluate
- [x] Backend: `segments.delete` — soft delete
- [x] Backend: `segments.evaluate` — run rules against contacts table, return matching contact IDs + count
- [x] Backend: `segments.getContacts` — return paginated contacts matching a segment
- [x] Frontend: /segments page — list of saved segments with name, description, contact count badge, last evaluated date, Edit/Delete actions
- [x] Frontend: Segment builder modal — rule rows (field + operator + value), AND/OR toggle, live preview count, Save button
- [x] Frontend: Segment detail page — shows matching contacts list with pagination, bulk action buttons
- [x] Frontend: Integration — sequence enrollment and bulk email modals gain an "Enroll from Segment" option
- [x] Sidebar nav: "Segments" entry under Engage group

## 40. AI Win Probability + Next Best Action on Deals (CRMA-006 / CRMA-007)
- [x] DB schema: add `winProbability` int nullable, `winProbabilityUpdatedAt` timestamp nullable, `nextBestActions` JSON nullable to opportunities table
- [x] Migration: generate + apply
- [x] Backend: `opportunities.computeWinProbability` — call LLM with deal context, return probability 0-100 + confidence + reasoning
- [x] Backend: `opportunities.computeNextBestActions` — call LLM with deal context, return array of 1-3 action objects
- [x] Backend: `opportunities.refreshAI` — run both, persist to DB, return updated opportunity
- [x] Backend: `opportunities.list` — include winProbability and nextBestActions in response
- [x] Frontend: Pipeline deal card — Win Probability badge (color-coded: ≥70% green, 40-69% yellow, <40% red)
- [x] Frontend: Pipeline deal card — top Next Best Action chip
- [x] Frontend: Opportunity detail drawer — "AI Insights" tab with Win Probability gauge, confidence, reasoning, full Next Best Actions list
- [x] Frontend: "Refresh AI" button in opportunity detail with loading spinner
- [x] Frontend: Pipeline page header — "Refresh All AI" button for bulk refresh

## 41. AI Research-to-Email Draft Pipeline (MKT-014 to MKT-017)
- [x] DB schema: ai_pipeline_jobs table
- [x] DB schema: ensure emailDrafts has pipelineJobId, aiGenerated bool, tone varchar columns
- [x] Migration: generate + apply
- [x] Backend: aiPipeline.runForContact - 5-stage pipeline
- [x] Backend: aiPipeline.runBulk - accept contactIds[], run pipeline for each
- [x] Backend: aiPipeline.getQueueStats - count drafts by status
- [x] Backend: aiPipeline.approveDraft - set status=approved with optional edits
- [x] Backend: aiPipeline.rejectDraft - set status=rejected
- [x] Backend: aiPipeline.regenerateDraft - re-run Stage 4 with revision preset
- [x] Frontend: /ai-pipeline page - trigger panel + pipeline status cards + Draft Review Queue
- [x] Frontend: Draft Review Queue - paginated list, bulk approve, individual draft editor, Research Context accordion
- [x] Sidebar nav: AI Draft Queue under Engage group

## 42. Sequence Execution Engine (MKT-007, MKT-008)
- [x] Backend: 5-min cron - process active enrollments with next_step_due <= now
- [x] Backend: auto-enrollment triggers - on contact status change, tag applied, or score threshold crossed
- [x] Backend: per-sequence daily cap + per-user daily email cap enforcement
- [x] Backend: auto-pause on reply - when reply_detected, pause enrollment + create review task
- [x] Frontend: Sequence detail stats - enrollment counts by status, per-step performance metrics

## 43. Pipeline Health Alerts (CRMA-012) + AI Account Brief (CRMA-010)
- [x] DB schema: pipeline_alerts table
- [x] DB schema: account_briefs table
- [x] Migration: generate + apply
- [x] Backend: pipelineAlerts.scan - scan open opps for 4 at-risk conditions
- [x] Backend: pipelineAlerts.list - return active alerts with opportunity context
- [x] Backend: pipelineAlerts.dismiss - mark single alert dismissed
- [x] Backend: pipelineAlerts.dismissAllForOpp - dismiss all alerts for an opportunity
- [x] Backend: pipelineAlerts.summary - alert count by type
- [x] Backend: accountBriefs.generate - LLM 300-word narrative
- [x] Backend: accountBriefs.getLatest - return latest brief for account
- [x] Backend: accountBriefs.exportPdf - generate PDF, return storage URL
- [x] Frontend: /pipeline-alerts page - summary cards + filter bar + alert list with dismiss
- [x] Frontend: Account detail drawer - AI Brief tab with generate/refresh/export PDF buttons
- [x] Sidebar nav: Pipeline Alerts under Acquire group

## 44. Real SMTP Transport via Nodemailer
- [x] Install nodemailer + @types/nodemailer
- [x] DB schema: smtp_configs table (workspaceId, host, port, secure, username, encryptedPassword, fromName, fromEmail, replyTo, createdAt, updatedAt)
- [x] Migration: generate + apply
- [x] Backend: smtpConfig.get / smtpConfig.save / smtpConfig.test (send test email to actor)
- [x] Backend: smtpConfig.sendDraft — look up approved draft, resolve SMTP config, send via Nodemailer, mark draft status=sent, log to activities
- [x] Backend: smtpConfig.sendBulkApproved — send all approved drafts for workspace in one call (rate-limited, 1/sec)
- [x] Frontend: Settings → Email Delivery tab — SMTP config form (host, port, TLS toggle, username, password, from name, from email, reply-to)
- [x] Frontend: Test connection button → calls smtpConfig.test, shows success/error toast
- [x] Frontend: Email Drafts page — "Send" button on approved drafts calls smtpConfig.sendDraft
- [x] Frontend: AI Draft Queue — "Send All Approved" button calls smtpConfig.sendBulkApproved
- [x] Vitest: SMTP config validation logic (host/port/email format checks)

## 45. Nightly AI Pipeline Batch Cron
- [x] Backend: aiPipeline.runNightlyBatch — query leads with leadScore >= threshold AND no pending/done pipeline job in last 7 days, trigger runPipeline for each (max 50/night)
- [x] Backend: workspace setting: nightlyPipelineEnabled (bool) + nightlyScoreThreshold (int, default 60)
- [x] DB schema: add nightlyPipelineEnabled + nightlyScoreThreshold to workspace_settings
- [x] Migration: generate + apply
- [x] Server startup: register midnight cron (0 0 * * *) calling aiPipeline.runNightlyBatch for all workspaces with nightlyPipelineEnabled=true
- [x] Frontend: Settings → AI Pipeline tab — nightly batch toggle + score threshold slider (0-100)
- [x] Vitest: nightly batch eligibility logic (score filter, dedup, max cap)

## 46. Audience Segment Auto-Enroll into Sequences
- [x] DB schema: segment_sequence_rules table (id, workspaceId, segmentId, sequenceId, enabled, lastRunAt, createdAt)
- [x] Migration: generate + apply
- [x] Backend: segmentRules.list / segmentRules.save / segmentRules.delete — manage which segment → sequence mappings exist
- [x] Backend: segmentRules.runEnrollment — for each enabled rule, evaluate segment, find contacts not already enrolled, call sequenceEngine.triggerAutoEnroll for each
- [x] Server startup: register hourly cron calling segmentRules.runEnrollment for all workspaces
- [x] Frontend: Segments page — "Auto-enroll" button per segment → opens dialog to pick a sequence + enable/disable toggle
- [x] Frontend: Sequences page — show linked segments count badge on each sequence row
- [x] Vitest: segment rule enrollment dedup logic

## 44. Real SMTP Transport via Nodemailer
- [x] DB schema: smtp_configs table (host, port, secure, username, encryptedPassword, fromName, fromEmail, replyTo, enabled, lastTestedAt, lastTestStatus, lastTestError)
- [x] Migration: generated + applied
- [x] Backend: smtpConfig.get - return config (password masked)
- [x] Backend: smtpConfig.save - encrypt password with AES-256-GCM, upsert config
- [x] Backend: smtpConfig.test - send test email via nodemailer, update lastTestStatus
- [x] Backend: smtpConfig.sendDraft - send approved email draft via configured SMTP, mark draft sent
- [x] Backend: smtpConfig.sendBulkApproved - send all approved drafts for a contact/lead
- [x] Frontend: Settings > Email Delivery tab - host/port/TLS/username/password/fromName/fromEmail/replyTo fields
- [x] Frontend: Test connection button with recipient email input
- [x] Frontend: Last test status badge (green/red with timestamp)
- [x] Vitest: SMTP config validation (host, port range, email format)

## 45. Nightly AI Pipeline Batch Cron
- [x] Backend: nightlyBatch.ts - runNightlyBatch() function
- [x] Backend: filters leads by score >= nightlyScoreThreshold (default 60) and no pipeline job in last 7 days
- [x] Backend: max 50 leads per workspace per night
- [x] Backend: fire-and-forget runPipelineForContact per lead (non-blocking)
- [x] Backend: midnight cron wired in server/_core/index.ts (schedules to next midnight, repeats every 24h)
- [x] Backend: workspaceSettings.nightlyPipelineEnabled + nightlyScoreThreshold columns added
- [x] Vitest: nightly batch lead filtering logic (score threshold, email required, 7-day dedup, cap)

## 46. Audience Segment Auto-Enroll into Sequences
- [x] DB schema: segment_sequence_rules table (workspaceId, segmentId, sequenceId, enabled, enrolledCount, lastRunAt)
- [x] Migration: generated + applied
- [x] Backend: segmentRules.list - return all rules with metadata
- [x] Backend: segmentRules.save - upsert rule (create or toggle enabled)
- [x] Backend: segmentRules.delete - remove rule
- [x] Backend: segmentRules.runEnrollment - evaluate segment, enroll matching contacts not already enrolled
- [x] Backend: runSegmentEnrollmentForWorkspace - internal function for cron
- [x] Backend: runSegmentEnrollmentForAllWorkspaces - exported for hourly cron
- [x] Backend: hourly cron wired in server/_core/index.ts (first run after 90s, repeats every 60min)
- [x] Frontend: /segment-rules page - add rule form (segment + sequence dropdowns), rules list with enrolled count + last run
- [x] Frontend: Run now button for immediate evaluation
- [x] Frontend: Pause/Enable toggle per rule
- [x] Frontend: Sidebar nav: Segment Auto-Enroll under Engage group
- [x] Vitest: segment enrollment dedup logic (no double-enroll, email filter, cross-sequence independence)

## 47. Email Open/Click Tracking
- [x] DB schema: email_tracking_events table (id, workspaceId, draftId, type enum(open|click), url, userAgent, ip, createdAt)
- [x] DB schema: add trackingToken varchar + openCount + clickCount + lastOpenedAt + lastClickedAt to email_drafts
- [x] Migration: generated + applied (0016_heavy_sasquatch.sql)
- [x] Backend: GET /api/track/open/:token — returns 1×1 transparent GIF, records open event async
- [x] Backend: GET /api/track/click/:token?url=... — validates URL, redirects, records click event async
- [x] Backend: smtpConfig.sendDraft — assigns tracking token, injects pixel + wraps links before sendMail
- [x] Backend: smtpConfig.getTrackingStats — open/click counts + last 20 events for a draft
- [x] Backend: smtpConfig.getTrackingOverview — aggregate stats for all sent drafts
- [x] Frontend: Email Drafts page — collapsible Delivery Analytics panel per sent draft
- [x] Frontend: shows open count, click count, last opened/clicked timestamps, scrollable event log
- [x] Vitest: 18 tests for tracking pixel injection, click-link wrapping, dedup, edge cases

## 48. Pre-send Merge Variable Resolution
- [x] Backend: server/mergeVars.ts — resolveMergeVars(template, ctx) replaces {{var}} and {{var|fallback}} tokens
- [x] Supported vars: firstName, lastName, fullName, title, email, phone, city, seniority, linkedinUrl (contact); company, domain, industry, employeeBand, revenueBand, region (account); senderName, senderEmail
- [x] Custom field support: {{customField.anyKey}} reads from contact.customFields JSON
- [x] textToHtml() — converts plain-text body to minimal HTML with XSS escaping + link detection
- [x] injectTracking() — injects 1×1 pixel before </body> and wraps all http/https links with click-tracking redirect
- [x] buildMergeContextFromDb() — loads contact + account from DB by contactId
- [x] smtpConfig.sendDraft wired: resolve merge vars → assign tracking token → inject tracking → sendMail
- [x] smtpConfig.sendBulkApproved wired: same pre-send pipeline per draft in the bulk loop
- [~] tRPC emailDrafts.previewResolved — DEFERRED (preview modal is a future enhancement)
- [x] Vitest: 30 tests for resolveMergeVars (fallbacks, custom fields, multi-var, edge cases), textToHtml (XSS, links, newlines), injectTracking (pixel, click wrapping, mailto skip)

## 49. Preview Resolved Modal
- [x] Backend: smtpConfig.previewResolved — loads draft + contact + account, resolves merge vars, returns {subject, body, resolvedCount, unresolvedTokens[]}
- [x] Frontend: "Preview" button (Eye icon) on approved drafts in Email Drafts page
- [x] Frontend: PreviewResolvedModal — shows resolved subject + HTML-rendered body in sandbox iframe, lists unresolved tokens as warnings
- [x] Vitest: 6 tests for merge var substitution in preview context

## 50. Email Analytics Dashboard
- [x] Backend: smtpConfig.getAnalyticsSummary — 5 aggregate stats (sent, opens, clicks, open rate, click rate) + top clicked URLs
- [x] Backend: smtpConfig.getTrackingOverview — per-draft stats sorted by open count with limit param
- [x] Frontend: /email-analytics page — 5 KPI stat cards + sortable table of sent drafts
- [x] Frontend: Date range filter (7d / 30d / 90d / all) + sort by open/click count
- [x] Frontend: Sidebar nav: Email Analytics under Engage group
- [x] Vitest: 7 tests for analytics aggregation (open rate, click rate, sorting, zero-state)

## 51. Unsubscribe Endpoint + Suppression Logic
- [x] DB schema: email_suppressions table (id, workspaceId, email, reason enum, source, draftId, notes, createdAt, removedAt)
- [x] Migration: generated + applied (0017_brief_ultragirl.sql)
- [x] Backend: GET /api/track/unsubscribe/:token — one-click unsubscribe, inserts suppression row, returns HTML confirmation page
- [x] Backend: emailSuppressions.list — paginated list with search + reason filter
- [x] Backend: emailSuppressions.add — manually add email to suppression list
- [x] Backend: emailSuppressions.remove — remove suppression (re-enable sending)
- [x] Backend: emailSuppressions.summary — counts by reason
- [x] Backend: emailSuppressions.isEmailSuppressed — exported helper for pre-send check
- [x] Backend: smtpConfig.sendDraft — checks suppression before sending, throws PRECONDITION_FAILED if suppressed
- [x] Backend: smtpConfig.sendBulkApproved — skips suppressed emails in loop, reports skipped count
- [x] Backend: injectUnsubscribeLink() — appends unsubscribe footer to every outbound email body
- [x] Frontend: /email-suppressions page — search bar, reason filter, summary cards, paginated table, add/remove actions
- [x] Sidebar nav: Opt-Out Management under Engage group
- [~] POST /api/track/bounce — inbound SMTP bounce webhook — DEFERRED (requires external SMTP provider webhook)
- [~] Settings → Email Delivery opt-out list section — DEFERRED (use /email-suppressions page instead)
- [x] Vitest: 16 tests for suppression logic, token validation, bulk-skip counting, HTML page generation

## 52. SMTP Bounce Webhook ✅
- [x] Backend: POST /api/track/bounce — multi-provider payload parser (Mailgun, SendGrid, Postmark, generic)
- [x] Backend: extract email + bounce type (hard/soft/spam) from each provider's format
- [x] Backend: insert email_suppressions row with reason=bounce (dedup check, hard-delete model)
- [x] Backend: update email_drafts.bouncedAt + bounceType + bounceMessage (migration 0018 applied)
- [x] Backend: webhook signature verification (Mailgun HMAC-SHA256, Postmark HMAC-SHA256, SendGrid ECDSA skipped/IP allowlist)
- [x] Backend: BOUNCE_WEBHOOK_SKIP_VERIFY=true env var for dev bypass
- [x] Vitest: 35 tests — payload parsing for all 4 providers, dedup suppression, signature verification logic

## 53. Email Analytics Time-Series Chart ✅
- [x] Backend: smtpConfig.getTrackingTimeSeries — daily opens + clicks, configurable days (7/30/90), zero-filled continuous x-axis
- [x] Frontend: /email-analytics — AreaChart (opens + clicks per day) with 7/30/90-day toggle
- [x] Frontend: period totals shown in chart header (N opens · N clicks in period)
- [x] Vitest: 8 tests — time-series aggregation, zero-fill, boundary inclusion, sort order

## 54. Nightly Batch Owner Notification ✅
- [x] Backend: nightlyBatch.ts — call notifyOwner at end of runNightlyBatch with summary
- [x] Summary includes: workspaces processed, leads queued, leads skipped (recent job or over cap), errors
- [x] Vitest: 9 tests — title singular/plural, error line conditional, all fields present, length within limits

## 55. Bounce Health Card on Email Analytics ✅
- [x] Backend: smtpConfig.getBounceStats — counts hard/soft/spam bounces from emailDrafts.bounceType, total suppressions from email_suppressions, bounce rate KPI
- [x] Frontend: /email-analytics — Bounce Health card: hard/soft/spam counts + bounce rate % + suppression note + healthy state message
- [x] Frontend: red border + "High bounce rate" warning badge when bounceRate >= 5%
- [x] Vitest: 25 tests — aggregation, rate calculation, threshold, null handling, suppression counts

## 56. Segment Enrollment Cron Owner Notification ✅
- [x] Backend: segmentRules.ts runSegmentEnrollmentForAllWorkspaces — calls notifyOwner() when totalEnrolled > 0
- [x] Notification includes: workspaces with active rules, contacts enrolled, contacts skipped, link to /segment-auto-enroll
- [x] Notification failure is caught and logged without affecting cron result
- [x] Vitest: 11 tests — title singular/plural, content fields, guard logic, length limits

## 57. Bounced Badge on Email Drafts Page ✅
- [x] Frontend: EmailDrafts.tsx — Bounced badge (Hard Bounce / Soft Bounce / Spam Complaint) shown when bouncedAt is set
- [x] Frontend: draft card gets red border when bounced; badge has tooltip showing bounceMessage
- [x] Backend: emailDrafts.list already returns full rows including bouncedAt/bounceType/bounceMessage (no change needed)
- [x] Vitest: 13 tests — label resolution for all 3 types, fallback, visibility guard, border class

## 58. View Bounced Emails Link ✅
- [x] Frontend: Bounce Health card — "View {N} bounced email(s)" button navigates to /email-drafts?filter=bounced via setLocation
- [x] Frontend: Email Drafts page — "bounced" filter tab (red XCircle icon) shows drafts where bouncedAt IS NOT NULL
- [x] Frontend: useEffect reads ?filter=bounced from URL on mount and sets filter state
- [x] Vitest: 14 tests — client-side filter logic, query status resolution, URL param detection

## 59. Bounce Trend Line on Email Analytics Chart ✅
- [x] Backend: getTrackingTimeSeries — adds daily bounces count from emailDrafts.bouncedAt; zero-filled continuous x-axis
- [x] Frontend: EmailAnalytics AreaChart — third Area series for bounces (red #ef4444 with gradient fill)
- [x] Frontend: period totals header includes bounce count (only shown when bounces > 0)
- [x] Frontend: chart title updated to "Opens, Clicks & Bounces Over Time"
- [x] Vitest: 10 tests — bounce aggregation, zero-fill, multi-day, coexistence with opens/clicks, period totals

## 60. Remove from Suppression Button on Bounced Draft Badge ✅
- [x] Backend: emailSuppressions.removeByEmail — deletes ALL suppression records for email+workspaceId (all reasons)
- [x] Frontend: EmailDrafts.tsx — inline "Remove suppression" button (Trash2 icon) next to bounced badge
- [x] Frontend: on success, invalidates emailDrafts.list + emailSuppressions.list + summary, shows toast
- [x] Vitest: 11 tests — result shape, email normalization, toast message, scope safety

## Layout Bug Fixes ✅
- [x] Bug: PipelineAlerts rendered without Shell wrapper → extra-wide layout + nav disappeared. Fix: wrap in `<Shell title="Pipeline Alerts">` + `<PageHeader>` matching all other pages.
- [x] Bug: SequenceCanvas used `h-screen` inside Shell's `flex-1 overflow-auto` main → canvas overflowed viewport, pushing sidebar/header out of view. Fix: (1) changed `h-screen` → `h-full` in SequenceCanvas, (2) added `height: 100%` to `html, body, #root` in index.css so the h-full chain resolves, (3) changed Shell outer div from `min-h-screen` → `h-full` to complete the chain.
- [x] 430/430 tests still passing, 0 TypeScript errors.

## 61. Apollo-style Contact Detail Panel ✅
- [x] Shared components built: InfoPanel, SocialLinks, AssociatedEntitiesList, ActivityTimeline (in client/src/components/usip/detail/)
- [x] ContactOverview component: avatar initials, name/title/company link, email/phone/social, enrichment fields, company info card
- [x] Backend: contacts.getWithAccount — contact row + joined account row (workspace-scoped)
- [x] RecordDrawer: Overview tab added as first tab for contact type; defaults to Overview on open

## 62. Apollo-style Account Detail Panel ✅
- [x] AccountOverview component: account initials, domain link, industry/region/employee band, associated contacts list (clickable)
- [x] Backend: accounts.getWithContacts — account row + all associated contacts (workspace-scoped)
- [x] RecordDrawer: Overview tab for account type shows AccountOverview

## 63. Apollo/Salesforce-style Deal/Opportunity Detail Panel ✅
- [x] OpportunityOverview component: stage badge, value/close date/win prob KPI row, deal info panel, account card, contact roles list
- [x] Backend: opportunities.getWithRelated — opportunity + account + contactRoles with embedded contact objects
- [x] RecordDrawer: Overview tab for opportunity type shows OpportunityOverview
- [x] Vitest: 24 tests — getWithAccount/getWithContacts/getWithRelated shapes, InfoPanel filtering, AssociatedEntitiesList mapping, SocialLinks detection, fmtCurrency, WinProbBar thresholds, stage labels

## 64. Sending Accounts — Multi-Provider Email Sending Infrastructure ✅
- [x] Schema: sending_accounts (provider, fromEmail, fromName, authType, encryptedCredentials, dailySendLimit, warmupStatus, connectionStatus, bounceRate, reputationTier, enabled, lastTestedAt)
- [x] Schema: sending_account_daily_stats (accountId, date, sentCount, deliveredCount, bouncedCount, openCount, clickCount)
- [x] Migration 0019 generated and applied
- [x] Backend: sendingAccountsRouter — list, get, create, update, delete, testConnection, getDailyStats
- [x] Frontend: /sending-accounts — health dashboard, per-account stat cards, connection status badges, add/edit/delete dialogs
- [x] Sidebar: "Sending Accounts" nav item under Engage group

## 65. Sending Account Health Dashboard ✅
- [x] Per-account health card: provider icon, from email, daily sent/limit progress bar, reputation tier badge, warmup status, connection status, last tested timestamp
- [x] "Test connection" button triggers testConnection mutation and shows result inline
- [x] Reputation tier derived from bounce rate: <1% excellent, <3% good, <5% fair, ≥5% poor
- [x] Vitest: 8 tests — reputation tier thresholds, boundary values

## 66. Sender Pool Rotation Engine ✅
- [x] Schema: sender_pools (name, description, rotationStrategy, lastUsedIndex), sender_pool_members (poolId, accountId, weight, position)
- [x] Backend: senderPoolsRouter — list, create, update, delete, addMember, removeMember, updateMemberWeight, pickAccount, getWithMembers
- [x] pickAccountFromPool() pure function — round_robin, weighted, random strategies with daily limit enforcement
- [x] round_robin: advances by position, wraps around, skips disabled/maxed
- [x] weighted: probability proportional to weight, skips disabled/maxed
- [x] random: uniform random from non-maxed accounts
- [x] Returns null when all accounts in pool are maxed or disabled
- [x] Frontend: /sender-pools — pool cards with member list, add/edit pool dialog, member management, weight controls
- [x] Sidebar: "Sender Pools" nav item under Engage group
- [x] Vitest: 72 tests — all three strategies, daily limit edge cases, empty pool, single-account pool, weight validation, provider/status enums, daily stats aggregation

## 67. Fully Inline-Editable Sequence Canvas ✅
- [x] Click any canvas node → NodeEditPanel slides in from right (320px), canvas shrinks to avoid overlap
- [x] NodeEditPanel exposes all fields per node type: label, description, timing (wait), branch condition (condition), action type/value (action), goal type/value (goal)
- [x] New nodes from palette auto-open NodeEditPanel immediately
- [x] "Sequence settings" button in palette sidebar opens SequenceSettingsPanel
- [x] SequenceSettingsPanel: name, description, exit conditions (5 toggles), send window, timezone, skip weekends, reply detection, max steps
- [x] sequences.update called with exitConditions + settings JSON patch on settings save
- [x] Schema: exitConditions and settings JSON columns added to sequences table (migration 0020 applied)
- [x] readOnly guard: panels render in read-only mode when sequence is active/paused
- [x] Canvas pane click closes any open panel

## 68. Per-Step Email Generation Modes ✅
- [x] Mode stored in sequenceNodes.data.emailMode (per-node, not per-sequence)
- [x] Typed mode: staticSubject + staticBody fields with {{variable}} token support
- [x] Template mode: staticTemplateId picker (queries emailTemplates.list with status=active)
- [x] AI Dynamic mode: aiTone (5 options), aiLength (3 options), aiFocus (free text)
- [x] Default mode for new email nodes: typed
- [x] Mode badge on canvas node header: AI / TPL / TXT
- [x] Vitest: 35 tests — email mode defaults, per-step independence, exit conditions, sequence settings, branch conditions, AI options, patch serialization, readOnly guard

## 69. Outreach Campaigns — Full CRUD + Analytics ✅
- [x] Schema: campaigns table extended with audienceType, audienceContactIds, audienceSegmentId, sequenceId, senderType, senderAccountId, senderPoolId, scheduleStart, scheduleEnd, throttlePerHour, throttlePerDay, abVariants (migration 0021 applied)
- [x] Schema: campaign_step_stats table (campaignId, stepIndex, stepLabel, sent/delivered/opened/clicked/replied/bounced/unsubscribed)
- [x] Backend: campaignsRouter extended with updateOutreach, pause, getStepStats, getWithDetails, getAnalytics procedures
- [x] Frontend: /campaigns — full list view with status badges, KPI summary, create/edit dialog with EntityPicker for audience/sequence/sender
- [x] Frontend: Campaign detail panel — Overview tab (config), Analytics tab (funnel KPIs), Step Stats tab (per-step table)
- [x] Vitest: 25 tests — status transitions, rate calculations, throttle validation, A/B weight validation, step stats aggregation

## 70. Shared EntityPicker Component ✅
- [x] EntityPicker supports 6 types: contacts, segments, sequences, campaigns, sendingAccounts, senderPools
- [x] Single and multi-select modes with search/filter
- [x] Popover combobox with badge chips, checkbox selection, status badges, entity metadata
- [x] Reused in Campaigns (audience, sequence, sender) and AI Compose (segments, sequences, campaigns)
- [x] Vitest: 18 tests — type mapping, value toggle/single, search filtering, badge chip rendering

## 71. AI Compose — CRM Entity Context Selectors ✅
- [x] AIPipelineQueue: collapsible "CRM Context" panel with EntityPicker for Segments, Sequences, Campaigns
- [x] Context count badge on panel header; "Clear all context" link
- [x] Context state (ctxSegments, ctxSequences, ctxCampaigns) ready to pass to pipeline mutations
- [x] Vitest: 16 tests — context state management, serialization for LLM prompt, audience type validation

## 72. Custom Dashboards Expansion
- [x] Schema: extend dashboardWidgets.type enum; add filters JSON column; migration 0022
- [x] Backend: new KPIs (revenue, sales_cycle_length, activity_counts, response_rate, reply_rate, meetings_booked)
- [x] Backend: new widget types (leaderboard, activity_feed, goal_progress, comparison, pipeline_stage, rep_performance)
- [x] Backend: resolveWidget accepts optional filters (dateFrom, dateTo, ownerUserId, stage, source)
- [x] Frontend: DashboardChartRenderer component (11 chart types)
- [x] Frontend: DashboardFilterBar component (date presets, owner, stage, source filters)
- [x] Frontend: install react-grid-layout for drag-to-resize/reorder
- [x] Frontend: new widget display components (Leaderboard, ActivityFeed, GoalProgress, Comparison, PipelineStage, RepPerformance)
- [x] Frontend: rewrite Dashboards.tsx with react-grid-layout, filter bar, all new widget types
- [x] Frontend: expand Add Widget dialog with all new types and chart type selector
- [x] Vitest: tests for new widget data resolvers and filter logic

## 72. Custom Dashboards Expansion

- [x] Extend dashboardWidgets type enum in schema (line/bar/stacked_bar/area/pie/donut/funnel/scatter/heatmap/gauge/single_value/leaderboard/activity_feed/goal_progress/comparison/pipeline_stage/rep_performance)
- [x] Add filters JSON column to dashboardWidgets table
- [x] Generate and apply migration 0022
- [x] Extend resolveWidget backend to accept optional filters (dateFrom, dateTo, ownerUserId, stage, source)
- [x] Extend resolveWidgetData with new KPIs: revenue, win_rate, avg_deal, sales_cycle_length, activity_counts, meetings_booked, response_rate, reply_rate
- [x] Extend resolveWidgetData with new widget types: leaderboard, activity_feed, goal_progress, comparison, pipeline_stage, rep_performance
- [x] Extend addWidget to accept all new widget types
- [x] Install react-grid-layout v2 for drag-to-resize/reorder
- [x] Create DashboardChartRenderer component (11 chart types: line, bar, stacked_bar, area, pie, donut, funnel, scatter, heatmap, gauge, single_value)
- [x] Create DashboardWidgets component (KpiCard, Leaderboard, ActivityFeed, GoalProgress, Comparison, PipelineStage, RepPerformance, EmailHealth, Table)
- [x] Create DashboardFilterBar component (date presets, custom range, owner, stage, source filters)
- [x] Rewrite Dashboards.tsx with react-grid-layout GridLayout (drag-to-resize, drag-to-reorder via drag-handle)
- [x] Add expanded Add Widget dialog with chart/widget type groups and conditional metric selectors
- [x] Wire global filter state to all WidgetCard resolveWidget queries
- [x] Write 15 Vitest tests for dashboard utilities (all 611 tests pass)

## 73. Rep Mailbox & Calendar (Feature 73)
- [x] Schema migration 0023: email_replies table, calendar_accounts table, calendar_events table, IMAP fields on sendingAccounts, email_reply notification kind
- [x] EmailAdapter abstraction: GmailAdapter (Gmail API) + ImapSmtpAdapter (Mailpool/IMAP/SMTP)
- [x] mailbox tRPC router: listAccounts, listThreads, getThread, sendNew, sendReply, markRead, moveToTrash, listFolders
- [x] CalendarAdapter abstraction: GoogleCalendarAdapter + CalDAVAdapter (Outlook/Apple/generic)
- [x] calendar tRPC router: listAccounts, connectCalDAV, disconnectAccount, listCalendars, listEvents, createEvent, updateEvent, deleteEvent, syncEvents
- [x] Inbound reply poller: IMAP polling job, reply detection, CRM linkage (pause sequence, log activity, create notification)
- [x] My Mailbox UI: account selector, folder list, thread list, thread view, inline reply/compose dialog, manager rep selector
- [x] My Calendar UI: FullCalendar (month/week/day/agenda), event create/edit/delete dialog, CalDAV connect dialog, manager rep selector
- [x] Inbox updated: unified feed with email_reply kind, filter tabs (All / Email Replies / Notifications), Open in Mailbox link
- [x] Navigation: My Mailbox and My Calendar added to Overview section in sidebar
- [x] Routes: /mailbox and /calendar registered in App.tsx
- [x] Tests: 24 new Vitest tests for Feature 73 (635 total passing)

## 73. Rep Mailbox and Calendar
- [x] Schema migration 0023: email_replies, calendar_accounts, calendar_events tables, IMAP fields, email_reply notification kind
- [x] EmailAdapter: GmailAdapter (Gmail API) + ImapSmtpAdapter (Mailpool/IMAP/SMTP)
- [x] mailbox tRPC router: listAccounts, listThreads, getThread, sendNew, sendReply, markRead, moveToTrash, listFolders
- [x] CalendarAdapter: GoogleCalendarAdapter + CalDAVAdapter (Outlook/Apple/generic)
- [x] calendar tRPC router: listAccounts, connectCalDAV, disconnectAccount, listCalendars, listEvents, createEvent, updateEvent, deleteEvent, syncEvents
- [x] Inbound reply poller: IMAP polling, reply detection, CRM linkage
- [x] My Mailbox UI: account selector, folder list, thread list, thread view, compose/reply dialog, manager rep selector
- [x] My Calendar UI: FullCalendar month/week/day/agenda, event CRUD, CalDAV connect, manager rep selector
- [x] Inbox updated: unified feed with email_reply kind, filter tabs, Open in Mailbox link
- [x] Navigation: My Mailbox and My Calendar in sidebar Overview section
- [x] Routes: /mailbox and /calendar in App.tsx
- [x] Tests: 24 new Vitest tests (635 total passing)

## Bug Fixes (Apr 23)
- [x] BUG: Send Email button missing on Contact detail/drawer view — only exists on bulk-select list view
- [x] BUG: Campaign launch blocked by checklist — no UI to tick off checklist items (Budget approved, Creative reviewed, etc.)

## Bugs & Features — Round 3

- [x] BUG: Ad-hoc email send does not log a Timeline activity on the contact or account record
- [x] BUG: Send Email tab missing from Leads drawer (only added to Contacts)
- [x] BUG: Checkboxes broken on Contacts, Leads, Accounts list views (multi-select not working)
- [x] BUG: No Edit or Delete on Contact, Lead, Account records (drawer + list)
- [x] FEATURE: Add-to-Campaign action from Contact, Lead, Account detail view and bulk-select toolbar
- [x] FEATURE: Add-to-Segment action from Contact, Lead, Account detail view and bulk-select toolbar
- [x] FEATURE: Add individual contacts when adding a Company (Account) to a campaign/segment

## Bug Fix: Ad-hoc Send Email missing from Accounts and Leads
- [x] Add Send Email action to Accounts list (row Actions dropdown + bulk toolbar) with contact picker modal
- [x] Add Send Email tab to Leads RecordDrawer (mirrors Contacts drawer)
- [x] Log timeline activity on lead record when ad-hoc email is sent from Leads
- [x] Log timeline activity on account + each selected contact when ad-hoc email is sent from Accounts

## Feature: IMAP fields in Sending Accounts form
- [x] Add IMAP host, port, SSL toggle, username, password fields to the Sending Accounts form (shown for all providers)
- [x] Pre-fill IMAP host/port hints based on selected provider (outlook_oauth → outlook.office365.com:993, gmail_oauth → imap.gmail.com:993)
- [x] Save IMAP fields via the existing sendingAccounts.create/update procedures

## Feature: Sending Accounts — Edit + IMAP fields
- [x] Add Pencil edit button to each AccountCard
- [x] Pre-fill AccountFormDialog with existing account data when editing (fetch via sendingAccounts.get)
- [x] Add IMAP fields (host, port, SSL, username, password) to AccountForm interface and defaultForm
- [x] Show IMAP section in the form for all providers with provider-specific host/port hints
- [x] Include IMAP fields in handleSubmit payload
- [x] Add imapHost/imapPort/imapSecure/imapUsername/imapPassword to AccountCreateInput zod schema in server router
- [x] Wire editId + setEditId state in the SendingAccounts page component

## Feature: Full Sequence Editing
- [x] Add typed sequences.updateMeta procedure (name, description, dailyCap, exitConditions, settings)
- [x] Add sequences.updateSteps procedure (replace steps array atomically)
- [x] Build SequenceEditDialog with tabs: Settings (name/description/dailyCap/exitConditions/send window) and Steps (add/edit/delete/reorder email, wait, task steps)
- [x] Wire Edit button on sequence detail panel header to open SequenceEditDialog
- [x] Show step editor inline: email steps get subject+body fields, wait steps get days field, task steps get body field
- [x] Support drag-to-reorder steps (or up/down arrow buttons)
- [x] Disable step editing for active/paused sequences (show read-only warning)
- [x] Add Edit (Pencil) button to each draft row/card in the Email Drafts page
- [x] Build EmailDraftEditDialog with subject and body fields, pre-filled from existing draft
- [x] Wire emailDrafts.update procedure (already exists in router) to the dialog save action
- [x] Show edit button only for drafts in pending_review or rejected status (not sent/approved) sent/approved)

## Bug Fixes: Pipeline Navigation Issues
- [x] Fix Research Pipeline page causing sidebar/navigation to disappear
- [x] Fix AI Pipeline page rendering unexpected area instead of correct content

## Bug Fix: AI Draft Queue Error
- [x] Fix "unexpected error" when navigating to AI Draft Queue page

## Bug Fix: Radix UI Nesting Audit
- [x] Audit all pages/components for CollapsibleTrigger outside Collapsible
- [x] Audit all pages/components for AccordionTrigger outside Accordion
- [x] Audit all pages/components for TabsTrigger outside Tabs
- [x] Fix all violations found (only one genuine violation existed: CollapsibleTrigger in AIPipelineQueue.tsx, already fixed)

## Feature: AI Draft Queue Loading Indicators
- [x] Add skeleton loaders to stats cards while getQueueStats is loading
- [x] Add skeleton rows to Draft Review Queue while getDraftQueue is loading
- [x] Add skeleton rows to Recent Jobs while getJobs is loading
- [x] Add spinner to contact list while contacts are loading (upgraded to skeleton rows)
- [x] Add loading state to Trigger Pipeline button while runForContact/runBulk mutation is in-flight (already existed)
- [x] Add loading state to Approve/Reject/Regenerate buttons on each draft card (already existed via DraftCard component)

## Bug Fix: Email Builder Unexpected Error
- [x] Fix "unexpected error" when navigating to Email Builder page

## Bug Fixes: Email Drafts / Dashboards / Mailbox (Apr 24)
- [x] Fix "unexpected error" on Email Drafts page (unescaped JSX {{firstName}} in EditDraftDialog)
- [x] Fix "unexpected error" on Dashboards page (memberOptions mapped m.userId → m.id; m.userId undefined)
- [x] Fix My Mailbox showing "No inbox-enabled accounts" (mailbox.ts used non-existent .email/.userId columns on sendingAccounts; fixed to .fromEmail + removed userId filter)
- [x] Fix My Mailbox IMAP routing: emailAdapter.ts always routed gmail_oauth to GmailAdapter even when IMAP creds set; now prefers IMAP when imapHost+imapUsername+imapPassword are present
- [x] Fix InboundPoller IMAP routing: same fix applied to inboundReplyPoller.ts
- [x] Wire Email Builder subject suggestions lightbulb button (Popover with 5 AI suggestions, spam risk badge, rationale, click-to-apply, refresh button)
- [x] Fix Sequences editing: SequenceEditDialog with Settings tab + Step editor, typed updateMeta/updateSteps tRPC procedures
- [x] Fix Email Drafts editing: EditDraftDialog with subject/body editing, Pencil button on each draft row

## Bug Fix + Feature: My Mailbox Improvements (Apr 24 round 2)
- [x] Fix message reading pane: clicking a thread in the list must load and display the full message body (HTML rendered in an iframe/div)
- [x] Add Central Inbox view: aggregate threads from all sender accounts into a single unified list, with an "Account" badge per thread showing which mailbox it came from
- [x] Add per-account inbox views: sidebar lets user switch between Central Inbox and each individual sender account
- [x] Add delete (move-to-trash) action on each thread row and in the reading pane toolbar
- [x] Add move-to-folder action: dropdown on each thread row and in the reading pane toolbar to move message to any folder (Inbox, Sent, Archive, Trash, etc.)
- [x] Add Reply action in reading pane toolbar (pre-fills To, Subject Re:, thread context)
- [x] Add Forward action in reading pane toolbar (pre-fills Subject Fwd:, original body quoted)
- [x] Add mailbox.aiDraftReply tRPC procedure: takes thread messages + user context, returns AI-drafted reply body
- [x] Add mailbox.aiDraftForward tRPC procedure: takes original message, returns AI-drafted forward intro
- [x] In compose dialog: when opened as Reply or Forward, auto-call AI draft and pre-populate body; show loading spinner while generating; body remains fully editable

## Gap Closure Sprint — Batch A (Backend/Admin features)
- [x] Nightly batch UI: Settings page toggle to enable/disable nightly AI pipeline per workspace + score threshold slider (writes nightlyPipelineEnabled + nightlyScoreThreshold to workspaceSettings)
- [x] Recurring dashboard delivery: server-side cron (Manus scheduled task) that reads dashboardSchedules, resolves each widget, and POSTs a formatted summary to the recipient list via the designated system sender
- [x] Workflow rule webhook execution: when a rule fires (testFire + real trigger), actually fetch() the webhook URL with the configured body; log success/failure to workflowRuns
- [x] Audit log CSV export: Download button on Audit page that streams all audit rows to a CSV file
- [x] Data export CSV: Export button on Contacts, Leads, Accounts, and Pipeline (Opportunities) list pages

## Gap Closure Sprint — Batch B (Mailbox enhancements)
- [x] Mailbox search: search bar in thread list panel; new mailbox.searchThreads tRPC procedure (IMAP SEARCH / Gmail messages.list q= param)
- [x] Unread count badges: aggregate unread counts per account and per folder shown in left sidebar
- [x] Mark as unread: toolbar button in reading pane; new mailbox.markUnread tRPC procedure
- [x] Snooze / remind me: snooze button in reading pane toolbar; snooze dialog (pick date/time); creates a task or notification at the chosen time
- [x] Email templates in compose: "Insert template" button in compose/reply/forward dialog; lists saved email templates; clicking one populates subject+body
- [x] Attachment download: make attachment badges in reading pane clickable; new mailbox.getAttachment tRPC procedure decodes base64 and triggers browser download

## Gap Closure Sprint — Batch C (CRM analytics)
- [x] Pipeline forecast view: weighted forecast chart (probability × deal value by close date) as a tab or panel alongside the Kanban on the Pipeline page
- [x] Duplicate detection: fuzzy-match check (name + email) when creating or importing leads/contacts; surface warning banner with merge option
- [x] Contact enrichment: Enrich button on contact/lead detail that calls an enrichment procedure (uses LLM + web search to fill missing firmographic fields)
- [x] Sequence performance analytics: per-sequence stats tab showing open rate, reply rate, opt-out rate, and step-by-step drop-off funnel

## Gap Closure Sprint — Batch D (Social publishing + integrations)
- [x] Live social publishing: real OAuth connection flow for LinkedIn, Twitter/X, Facebook, Instagram with credential slots (API key/secret/access token per platform)
- [x] Social post scheduling: full scheduling UI with repeat/recurrence options (daily, weekly, custom interval), post queue management
- [x] Slack / Teams notification integration: workspace settings to configure Slack webhook URL and/or Teams webhook URL; workflow rule action type "notify_slack" and "notify_teams" that actually POSTs to the configured URL

## Gap Closure Sprint — Batch E (Calendar sync)
- [x] Two-way Google Calendar sync: OAuth connect flow + sync meetings logged in USIP to/from Google Calendar (credential slots for Google OAuth client ID/secret)
- [x] Two-way Outlook Calendar sync: OAuth connect flow + sync meetings to/from Outlook/Microsoft 365 (credential slots for Azure app client ID/secret)

## Gap Closure Sprint — Batch F (Notifications + invitations)
- [x] Workspace system sender: Settings page section to designate one sending account as the system sender for invitation emails, dashboard delivery, and general notifications
- [x] User invitation email: when team.invite is called, send an actual invitation email via the designated system sender with a magic link
- [x] Team member notification email preferences: profile/settings page where each member can add a personal notification email address (separate from login) and choose which notification types to receive (sequence replies, social post responses, workflow alerts, etc.)

## Bug Fixes + Features: Mailbox Compose & Logo (Apr 24 round 3)
- [x] Fix templates dropdown not appearing in compose dialog (Popover/Command component not rendering — likely missing cmdk peer or DialogContent z-index issue)
- [x] Add file attachment capability to compose dialog (file input, attachment list with remove, send attachments via nodemailer)
- [x] Fix sidebar logo squished — update Shell.tsx logo img to use object-contain and fill the white card properly

## Batch C Enhancements (user-requested)
- [x] Pipeline Forecast: add stage filter dropdown so user can narrow forecast to deals in specific stage(s)
- [x] Duplicate Merge: replace auto-fill logic with per-field checkbox selector — user picks which fields to copy from secondary before confirming merge
- [x] Sequence Performance Analytics: add date range filter (from/to date pickers) so analytics are scoped to emails sent within a chosen period

## Batch G — AI Meeting Summary, Sequence A/B Testing, Deal Aging Alerts

- [x] AI Meeting Summary: "Summarize" button on calendar event detail that calls LLM with event title, attendees, description, and linked opportunity notes; saves result as an activity record; displayed in event detail panel
- [x] Sequence A/B Testing: schema migration to add variantLabel + variantGroup to sequenceSteps; server procedures to create/update variants and get per-variant stats; sequence canvas UI to add/remove variants per step; Performance tab A/B comparison table showing open rate, reply rate, and winner badge per variant
- [x] Deal Aging Workflow Trigger: new workflow trigger type "deal_stuck" with configurable stage + days threshold; nightly check procedure that scans open opportunities for daysInStage >= threshold and fires matching workflow rules (notify_slack, notify_teams, create_task); workflow builder UI to configure the trigger

## Batch H — Pipeline Alerts, A/B Auto-Assignment, Meeting Summary Push

- [x] Pipeline Alerts page: wire the "Pipeline Alerts" nav item to a live list of stuck deals (from checkDealAging), with one-click "Log activity" and "Move stage" actions per deal row
- [x] A/B variant auto-assignment: extend sequence enrollment engine to read sequenceAbVariants and assign each enrollee to a variant based on splitPct; use variant subject/body in generated email drafts
- [x] Meeting summary push-to-opportunity: after AI summary is generated on a calendar event, show a "Push to opportunity" button that appends key points and action items as an activity record on the linked opportunity

## Batch I — A/B Winner Promotion, Digest Email, Opportunity Timeline

- [x] A/B variant winner auto-promotion: after configurable min-sends threshold, compute reply rate per variant; promote winner as default (isWinner flag); show winner banner in A/B tab with "Promote" button; nightly batch runs promotion check
- [x] Pipeline Alerts digest email: "Send Digest" button on Pipeline Alerts page that emails the current stuck-deals list to the workspace owner via the system sender; server procedure builds HTML email with deal table
- [x] Opportunity Timeline tab: dedicated "Timeline" tab in the opportunity RecordDrawer showing all activities (meetings, calls, notes, emails) in reverse-chronological order; meeting summaries highlighted with a distinct badge

## Batch J — Velocity Rebrand + Neon Stripe Navigation

- [x] Rename app to "Velocity" with tagline "The Unified Revenue Intelligence Platform" in sidebar header
- [x] Implement Option B Neon Stripe: each nav section gets a 3px left-border stripe + colored section label + colored icons in its category hue
- [x] Color palette: Overview=sky blue (#60A5FA), Acquire=amber (#FCD34D), Engage=hot purple (#C084FC), Retain=vivid red (#F87171), Operate=teal (#2DD4BF), Admin=slate (#94A3B8)
- [x] Active nav item: colored glow background matching section color
- [x] Update page title and any in-app "USIP" references to "Velocity"

## Batch K — Accent Colors, Favicon, Dark Mode Toggle

- [x] Apply category accent colors to main content page headers: each page's PageHeader gets a subtle left-border accent + tinted background matching its nav category color
- [x] Generate Velocity lightning bolt favicon and deploy it to the app
- [x] Add dark/light mode toggle button to the topbar (sun/moon icon), wired to ThemeProvider

## Batch L — Stat Card Accents, Page Transitions, Dark Sidebar Contrast

- [x] Apply category accent color left-border stripe to StatCard components via AccentContext
- [x] Add animated page transitions (fade + slight slide-up) to Router in App.tsx using CSS/framer-motion or CSS transitions
- [x] Improve dark-mode sidebar: lighter charcoal background, stronger stripe glow, better contrast vs dark main canvas

## Batch M — Chart Accents, Topbar Underline, Reduce Motion

- [x] Apply category accent color to chart lines/bars on Dashboard and EmailAnalytics pages
- [x] Add 2px accent-colored underline to the topbar header in Shell.tsx (visible even when page header is scrolled away)
- [x] Add "Reduce motion" toggle in Settings page; persist to localStorage; PageTransition respects it by skipping animation

## Batch N — Mockup B Dashboard as Home Screen

- [x] Save current Dashboard.tsx content as "Home 2" component and register it in Dashboards section
- [x] Build Mockup B layout in Dashboard.tsx: 4 stat cards (Pipeline Value, Closed-Won, Active Leads, Customers) with trend indicators, Revenue area chart with period dropdown (30d/3m/6m/12m/24m), Recent Opportunities table, AI Drafts Awaiting Review panel
- [x] Register Mockup B dashboard in Dashboards section as editable pinned entry named "Home"
- [x] Both "Home" and "Home 2" appear in Dashboards section and are editable
- [x] Add revenueChart procedure to opportunitiesRouter returning monthly revenue + weighted forecast buckets

## Batch O — Dashboard Supercharge

- [x] Extend revenueChart to return MoM delta % for each stat card (pipeline, closed-won, leads, customers)
- [x] Add dashboardStats procedure returning live stat card values with MoM deltas
- [x] Add stageFunnel procedure returning stage counts for funnel chart
- [x] Add topReps procedure returning top 5 reps by closed-won value
- [x] Add winLoss procedure returning won/lost deal counts and values
- [x] Rebuild Dashboard.tsx: live MoM delta stat cards (sky blue/green/violet/red), Revenue area chart with period dropdown, Win/Loss donut, Pipeline Funnel bar chart, Top Reps leaderboard with medal icons, Recent Opps table, AI Drafts panel
- [x] Add "Set as Home" button (Home icon, appears on hover) to Dashboards section sidebar for each system dashboard entry
- [x] Persist homeDashboard preference in localStorage; Shell nav Dashboard link respects it; amber Home icon marks current selection

## Batch P — Dashboard Interactivity

- [x] Goal progress bars on Dashboard stat cards: per-card monthly target stored in localStorage; inline click-to-edit target; thin colored progress bar below value; % label
- [x] Top Reps leaderboard rows clickable: clicking a rep navigates to /pipeline?owner=<userId> with filtered view showing only that rep's open deals; amber banner + Clear filter button on Pipeline page
- [x] Last Refreshed timestamp + Refresh button in Dashboard header: shows relative time since last data fetch; clicking Refresh invalidates all dashboard queries and updates timestamp
- [x] Pipeline board query extended to accept optional ownerUserId filter for rep drill-down

## Batch Q — Unipile Multichannel Integration (DONE)

- [x] DB: add `unipileAccounts` table (id, workspaceId, userId, unipileAccountId, provider, displayName, status, connectedAt, metadata)
- [x] DB: add `unipileMessages` table (id, workspaceId, unipileAccountId, chatId, messageId, direction, provider, senderName, senderProviderId, text, attachmentUrl, linkedContactId, linkedLeadId, linkedOpportunityId, createdAt)
- [x] DB: add `unipileInvites` table (id, workspaceId, unipileAccountId, recipientProviderId, recipientName, status, sentAt, acceptedAt)
- [x] Migration: generated (0028_classy_mulholland_black.sql) + applied via direct DB connection
- [x] Server: `server/routers/unipile.ts` tRPC router with: generateConnectLink, listConnectedAccounts, disconnectAccount, getInbox, getChatMessages, sendMessage, sendLinkedInInvite, getLinkedInProfile
- [x] Server: `/api/unipile/webhook` Express route to receive Unipile webhook events (new messages, account status, new relation) → store in DB + create activity
- [x] Server: `server/lib/unipile.ts` helper wrapping Unipile REST API calls (uses UNIPILE_API_KEY + UNIPILE_DSN env vars; DSN origin extracted from full URL automatically)
- [x] Frontend: `Connected Accounts` page at `/connected-accounts` — shows all connected provider accounts per user with status badges; "Connect Account" button triggers Hosted Auth Wizard flow; disconnect button
- [x] Frontend: `Unified Inbox` page at `/inbox` — shows all messages across all connected channels; left sidebar filters by provider/account; message thread view with reply composer; send button calls sendMessage tRPC
- [x] Frontend: LinkedIn actions on Contact/Lead RecordDrawer — "Send Connection Request" button (calls sendLinkedInInvite); "Send LinkedIn DM" button (opens compose modal, calls sendMessage)
- [x] Frontend: Multichannel activity feed — all Unipile messages appear in the Timeline tab of linked contacts/leads/opportunities with provider icon badge
- [x] Frontend: Engage nav section — "Unified Inbox" and "Connected Accounts" nav items added to sidebar
- [x] Secrets: UNIPILE_API_KEY and UNIPILE_DSN added via webdev_request_secrets; DSN corrected to https://api26.unipile.com:15619
- [x] Vitest: Unipile credentials smoke test passes (2/2); full suite 680/680 passing

## Batch R — Sequences LinkedIn Steps, Channel Icons, Unipile Dashboard Widget

- [x] Sequences: add `linkedin_dm` and `linkedin_invite` step types to sequenceSteps schema enum
- [x] Sequences: server-side execution for linkedin_dm and linkedin_invite steps (calls unipile sendMessage / sendLinkedInInvite)
- [x] Sequences: UI — add LinkedIn DM and Connection Request options to the step-type picker in the builder (SequenceCanvas.tsx)
- [x] Sequences: UI — show LinkedIn DM compose panel (message body, char counter, merge tokens) and LinkedIn Invite compose panel (note, char counter, merge tokens) in NodeEditPanel.tsx
- [x] ActivityTimeline: add provider icon badge (LinkedIn blue, WhatsApp green, Instagram pink, Telegram blue, X black, Outlook blue, IMAP gray) to each activity row based on activity metadata
- [x] Dashboard: add Unipile Multichannel Outreach widget (messages sent, connections accepted, acceptance rate, per-provider bar chart)
- [x] Server: add unipile.metrics tRPC procedure returning aggregated counts from unipileMessages and unipileInvites tables

## Batch S — Team Member Password & Resend Invitation

- [x] Server: add `team.setMemberPassword` protected procedure (admin only) — hashes new password with bcrypt, updates user record, logs audit entry
- [x] Server: add `team.resendInvitation` protected procedure (admin only) — re-sends invitation email with existing or freshly-generated invite token
- [x] UI: "Set Password" action in Team Members row actions — opens a dialog with new-password + confirm fields, validates match + min-length, calls procedure
- [x] UI: "Resend Invite" action in Team Members row actions — visible only for members whose invite is pending/not-yet-accepted, calls procedure with toast feedback
- [x] Vitest: cover setMemberPassword (success, wrong role, mismatch) and resendInvitation (success, already-accepted guard)

## Batch S — Team Member Password & Resend Invitation

- [x] DB: add `passwordHash` (text, nullable) column to `users` table; migration applied
- [x] Server: `team.setMemberPassword` — admin-only, bcrypt hash (cost 12), role-rank guard, audit log
- [x] Server: `team.resendInvitation` — admin-only, guards for loginMethod=invite and not deactivated, re-sends invitation email via system sender
- [x] Server: expose `loginMethod` in `team.list` query so UI can detect pending invitees
- [x] UI: "Set Password" button in each active member's row actions → opens dialog with New Password + Confirm Password fields, validation (min 8, match), bcrypt stored on save
- [x] UI: "Resend Invite" button visible only for members with loginMethod="invite" (pending badge shown in name column)
- [x] Tests: 9 new vitest tests covering setMemberPassword and resendInvitation guards (all 689 pass)

## Batch S — Team Member Password & Resend Invitation

- [x] DB: add passwordHash (text, nullable) column to users table; migration applied
- [x] Server: team.setMemberPassword — admin-only, bcrypt hash (cost 12), role-rank guard, audit log
- [x] Server: team.resendInvitation — admin-only, guards for loginMethod=invite and not deactivated, re-sends invitation email via system sender
- [x] Server: expose loginMethod in team.list query so UI can detect pending invitees
- [x] UI: Set Password button in each active member row actions opens dialog with New Password + Confirm Password fields, validation (min 8, match), bcrypt stored on save
- [x] UI: Resend Invite button visible only for members with loginMethod=invite (pending badge shown in name column)
- [x] Tests: 9 new vitest tests covering setMemberPassword and resendInvitation guards (all 689 pass)

## Batch T — Invite Expiry, Login History, Copy Invite Link

- [x] Schema: add inviteToken (varchar 64, nullable, unique) and inviteExpiresAt (timestamp, nullable) to workspaceMembers
- [x] Schema: add inviteExpiryDays (int, default 7, nullable) to workspaceSettings
- [x] Schema: add loginHistory table (id, userId, workspaceId, ipAddress, userAgent, outcome enum, createdAt)
- [x] Migration: generate and apply via drizzle-kit + webdev_execute_sql
- [x] Server: invite procedure generates inviteToken + sets inviteExpiresAt; includes token link in email
- [x] Server: resendInvitation regenerates token + resets expiry
- [x] Server: team.copyInviteLink procedure returns invite URL for pending member (regenerates if expired)
- [x] Server: team.getLoginHistory procedure returns recent login events for a member
- [x] Server: team.updateInviteExpiry procedure saves inviteExpiryDays to workspaceSettings
- [x] Server: expireInvitations cron job (nightly) marks expired pending invites
- [x] Server: OAuth callback records loginHistory row on every sign-in
- [x] UI: Copy Invite Link button next to Resend Invite for pending members
- [x] UI: Login History tab on Team Members page showing per-member sign-in log
- [x] UI: Invitation expiry config field in workspace settings
- [x] Tests: cover invite expiry logic, copyInviteLink, getLoginHistory guards

## Batch T — Invite Expiry, Login History, Copy Invite Link

- [x] Schema: add inviteToken and inviteExpiresAt columns to workspaceMembers
- [x] Schema: add inviteExpiryDays column to workspaceSettings
- [x] Schema: add loginHistory table (userId, workspaceId, ipAddress, userAgent, outcome, createdAt)
- [x] Migration: generate and apply Drizzle migration for all schema changes
- [x] Server: update invite procedure to generate inviteToken and set inviteExpiresAt on new members
- [x] Server: update resendInvitation to regenerate inviteToken and reset inviteExpiresAt
- [x] Server: add team.copyInviteLink procedure (returns invite URL, regenerates token if expired)
- [x] Server: add team.getLoginHistory procedure (returns last 50 login events for a member)
- [x] Server: add team.updateInviteExpiry procedure (saves inviteExpiryDays to workspace_settings)
- [x] Server: create inviteExpiry.ts nightly job (marks expired pending invitations as expired_invite)
- [x] Server: wire expireInvitations into the nightly batch cron in index.ts
- [x] Server: record login history in OAuth callback (non-fatal, captures IP, user agent, outcome)
- [x] UI: add Copy Invite Link button next to Resend Invite for pending/expired members
- [x] UI: add Login History tab on Team Members page (table of sign-in events per member)
- [x] UI: add Settings tab on Team Members page with invitation expiry days config
- [x] UI: show Expired badge on members with loginMethod = expired_invite
- [x] Tests: invite.expiry.test.ts covering schema fields, procedure existence, and expireInvitations import

## Batch U — Invite Acceptance Page, Login History Filters, Expiry Emails

- [x] Server: team.acceptInvite public procedure (validate token, return workspace/role info)
- [x] Server: team.finaliseAcceptance protected procedure (mark invite accepted after OAuth login)
- [x] Server: team.getLoginHistoryFiltered procedure (outcome filter + date range, up to 200 rows)
- [x] Server: sendExpiryWarningEmails() in inviteExpiry.ts (48h warning email via system sender)
- [x] Server: wire sendExpiryWarningEmails into nightly batch in index.ts
- [x] UI: /invite/accept page (public route, no AuthGate) with workspace/role card and OAuth sign-in button
- [x] UI: auto-finalise acceptance on return from OAuth login (detect token in URL, call finaliseAcceptance)
- [x] UI: Login History tab filter bar (date range from/to, outcome multi-select, clear button)
- [x] App.tsx: register /invite/accept route without AuthGate
- [x] Tests: cover acceptInvite validation, finaliseAcceptance, getLoginHistoryFiltered

## Batch U — Invite Acceptance, Login History Filters, Expiry Emails

- [x] Server: team.acceptInvitePreview (public) — validates token, returns workspace/role info
- [x] Server: team.finaliseAcceptance (protected) — clears token, sets loginMethod=oauth, logs loginHistory
- [x] Server: team.getLoginHistoryFiltered — outcome, from/to date range, limit up to 500
- [x] Server: sendExpiryWarningEmails() in inviteExpiry.ts — finds members expiring within 48h, sends reminder email via system sender
- [x] Server: wired sendExpiryWarningEmails into nightly batch in index.ts
- [x] Server: OAuth callback extended to support returnPath in state (JSON-encoded) for post-login redirects
- [x] UI: /invite/accept page — public route, shows workspace/role card, Sign in to accept button, auto-finalises on return
- [x] UI: Login History tab — filter bar with member, outcome (all/success/failed/expired_invite), from/to date pickers, Clear all button
- [x] Tests: invite.accept.test.ts covering acceptInvitePreview, finaliseAcceptance, getLoginHistoryFiltered, sendExpiryWarningEmails, OAuth state encoding

## Batch V — Fix Transactional Email Delivery (use smtp_configs not sendingAccounts)

- [x] Create server/emailDelivery.ts helper: sendWorkspaceEmail(workspaceId, {to, subject, html}) using smtp_configs table
- [x] Fix admin.ts invite procedure: replace systemSenderAccountId/sendingAccounts lookup with sendWorkspaceEmail
- [x] Fix admin.ts resendInvitation procedure: replace systemSenderAccountId/sendingAccounts lookup with sendWorkspaceEmail
- [x] Fix inviteExpiry.ts sendExpiryWarningEmails: replace systemSenderAccountId/sendingAccounts lookup with sendWorkspaceEmail
- [x] Fix pipelineAlerts.ts notification emails: replace systemSenderAccountId/sendingAccounts lookup with sendWorkspaceEmail
- [x] Tests: cover sendWorkspaceEmail helper (missing config, disabled config, send success)

## Batch W — Team Member Edit

- [x] Server: team.updateMember procedure (admin+): update name, email, title, role, quota for any member below caller rank
- [x] UI: Edit Member button (pencil icon) on each member row in Team.tsx
- [x] UI: Edit Member dialog with fields: name, email, title, role (select), quota (number)
- [x] UI: optimistic update on save; invalidate team.list on success

## Batch V — Fix Transactional Email Delivery (completed)
- [x] Create server/emailDelivery.ts — sendWorkspaceEmail helper reading smtp_configs table
- [x] Fix team.invite to use sendWorkspaceEmail instead of sendingAccounts path
- [x] Fix team.resendInvitation to use sendWorkspaceEmail
- [x] Fix inviteExpiry.sendExpiryWarningEmails to use sendWorkspaceEmail
- [x] Fix pipelineAlerts digest email to use sendWorkspaceEmail

## Batch W — Team Member Edit (completed)
- [x] Server: add team.updateMember procedure (name, email, title, role, quota, notifEmail)
- [x] Server: expose notifEmail in team.list query
- [x] UI: add Edit button and Edit Member dialog to Team.tsx (all editable fields)

## Batch X — Edit Member Dialog: Permissions, Activity Log, Deactivate

- [x] Schema: add memberPermissions table (workspaceId, userId, feature, granted, grantedBy, createdAt)
- [x] Migration: generate and apply memberPermissions migration
- [x] Server: team.getPermissions procedure — returns permission rows for a member
- [x] Server: team.setPermissions procedure — upserts permission rows, logs audit
- [x] Server: team.getMemberActivityLog procedure — queries auditLog for workspace_member/user entity changes
- [x] UI: convert Edit Member dialog to 3-tab layout (Profile, Permissions, Activity Log)
- [x] UI: Permissions tab — feature toggle switches calling team.setPermissions
- [x] UI: Activity Log tab — read-only audit table for the member
- [x] UI: Deactivate User button in edit dialog footer (destructive, triggers reassign flow)

## Batch Y — Permission Enforcement, Bulk Templates, Audit Log Member Filter

- [x] Server: add `checkPermission(ctx, feature)` helper in server/db.ts that queries member_permissions
- [x] Server: gate export-related procedures behind checkPermission (e.g., contacts.export, leads.export)
- [x] UI: add "Apply role template" button on Permissions tab with preset maps per role (rep/manager/admin/super_admin)
- [x] UI: role template presets fill all 6 toggles and mark permsDirty so Save permissions activates
- [x] Server: add team.listForFilter procedure returning id/name/email for member dropdown
- [x] UI: add "Member" filter dropdown to AuditLog page (/audit-log) that filters rows by actorUserId
- [x] Server: extend audit.list procedure to accept optional memberId filter
- [x] Tests: vitest specs for checkPermission logic, template preset maps, and audit memberId filter

## Bug — Invite reminder email 404

- [x] Investigate: identify the URL generated in reminder invite emails
- [x] Fix: ensure the invite link URL matches the registered /invite/accept route
- [x] Test: verify invite link resolves correctly end-to-end

## Bug — LinkedIn connected account not appearing after OAuth

- [x] Investigate: trace the LinkedIn OAuth connect flow and listAccounts query
- [x] Fix: ensure Connected Accounts list refreshes after successful LinkedIn connection
- [x] Test: verify newly connected LinkedIn account appears immediately

## Batch Z — Unipile Account Health

- [x] Server: register POST /api/unipile/status-webhook to receive Unipile account status events (CREDENTIALS, DISCONNECTED, etc.)
- [x] Server: on CREDENTIALS event — set unipile_accounts.status = 'CREDENTIALS', send re-auth email to user with fresh reconnect link
- [x] Server: auto-disable — mark account disabled when status is CREDENTIALS or DISCONNECTED
- [x] UI: "Connecting…" spinner on Connected Accounts page — pulsing state after auth tab opens, stops when new account appears or 5-min timeout
- [x] UI: visual flag for expired/disconnected accounts — amber badge + warning icon + Reconnect CTA on account card
- [x] Tests: vitest specs for status webhook handler and auto-disable logic

## Batch AA — Invite Password Creation & Reconnect Banner Button

- [x] Server: team.setInvitePassword procedure — validates token, hashes password with bcrypt, stores in users.passwordHash
- [x] UI: InviteAccept.tsx — insert password-creation step between OAuth sign-in and finaliseAcceptance
- [x] UI: InviteAccept.tsx — "Set password & continue" button + "Skip for now" ghost button
- [x] UI: InviteAccept.tsx — show/hide password toggle, confirm password field, inline validation errors
- [x] UI: ConnectedAccounts.tsx — replace generic expired banner with per-account rows each containing a Reconnect button

## Batch AB — Password Login, Strength Indicator, Reconnect All

- [x] Server: POST /api/auth/password-login — accepts email+password, verifies bcrypt hash, issues session cookie
- [x] UI: Login page with email+password form that calls the new endpoint
- [x] UI: Link from OAuth login page to password login page
- [x] UI: InviteAccept.tsx — add visual password strength indicator (Weak/Fair/Strong) to Create Your Password step
- [x] UI: ConnectedAccounts.tsx — add "Reconnect all" button to expired accounts banner header

## Batch AB — Password Login, Strength Indicator, Reconnect All

- [x] Server: POST /api/auth/password-login Express route (bcrypt verify, session cookie issue)
- [x] UI: PasswordLogin.tsx page — email+password sign-in form at /login
- [x] UI: Landing page — add "Sign in with password" secondary button linking to /login
- [x] App.tsx: register /login route for PasswordLogin page
- [x] UI: InviteAccept.tsx — password strength indicator (Weak/Fair/Strong bar + label) below password field
- [x] UI: ConnectedAccounts.tsx — isReconnectingAll state + handleReconnectAll function
- [x] UI: ConnectedAccounts.tsx — "Reconnect all" button in expired banner header (only shown when >1 expired account)

## Bug Fix — Invite password step not shown (OAuth state encoding)

- [x] Diagnose: getLoginUrlWithReturn encoded btoa(JSON.stringify({redirectUri,returnPath})) as state, breaking sdk.decodeState() which expects btoa(redirectUri)
- [x] Fix InviteAccept.tsx: encode state as btoa(redirectUri) where redirectUri carries ?return=<returnPath>
- [x] Fix server/_core/oauth.ts: extract ?return= from decoded redirectUri instead of trying to JSON.parse the state

## Bug Fix — Invite password step (sessionStorage approach)

- [x] Root cause: redirectUri with ?return= query param rejected by Manus OAuth allowlist validation
- [x] Fix InviteAccept.tsx: store returnPath in sessionStorage before OAuth redirect; use clean redirectUri
- [x] Fix App.tsx: add InviteReturnRedirect component that reads sessionStorage on auth and navigates back to invite page
- [x] Fix server/_core/oauth.ts: revert to always redirecting to '/' (sessionStorage handles the return)

## Bug Fix — Invite password step v3 (server-side cookie approach)

- [x] Root cause: sessionStorage is cleared when the same tab navigates to the OAuth portal, so the returnPath was lost
- [x] Add GET /api/auth/set-return endpoint in oauth.ts: sets a short-lived HttpOnly cookie with the returnPath
- [x] Update InviteAccept.tsx: replace href link with async onClick that calls /api/auth/set-return then redirects to OAuth portal
- [x] Update oauth.ts callback: read usip_invite_return cookie after token exchange, redirect to stored path, clear cookie
