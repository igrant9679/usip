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
