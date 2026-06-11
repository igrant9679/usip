# Velocity / usip — Session Handoff (Continue from here)

Refreshed at end of the features + full-functionality-audit session. Paste the bottom block into a new chat to resume.

---

## Repo + deploy

- **Repo:** `igrant9679/usip` (origin: `https://github.com/igrant9679/usip.git`)
- **Local path:** `C:\Users\Admin\usip`
- **Deploy:** Railway → `https://getvelocityai.app/` (auto-deploys on push to `main`; deploys ran 5–12 min this session — verify live via API probes / DOM, not the first screenshot)
- **Tip of `main`:** `5831f9f` (+ this handoff commit). All work below is deployed and the touched routers health-checked live.

## This session's work (newest first)

### Full functionality audit → fixes (`6cc4e62`→`5831f9f`)
Six parallel auditors swept server routers, email/sequence engine, ARE, client pages, schema/auth. Every headline claim was hand-verified before fixing. **All fixes below are shipped + deployed; the security ones were probed live** (bogus ids now 404; legacy template save canary passed).

- **P0 `6cc4e62` — Email Builder baked DEMO merge values into saved templates.** `renderDesignToHtml` ran `resolveMergeTags` before persisting `htmlOutput`, so saved templates contained "Alex"/"Acme Corp" (the demo map) and typo'd tags became `[brackets]`. Sequences copy `htmlOutput` → prospects would have been greeted "Hi Alex". Fixed with `opts.resolveTags=false` at the two persistence sites (previews still resolve). **All 7 live templates re-saved with `{{tags}}` intact; sequence 10's step re-synced.**
- **P0 `d342565` — cross-tenant writes:** `cs.addAmendment` (caller-controlled customerId; unscoped ARR update) and `crm.addLineItem/removeLineItem` (unvalidated opportunityId; unscoped value rewrite). Both now validate ownership (404) + scope updates.
- **P1 `b6b0d10` — merge vars:** `buildMergeContextFromDb` now accepts `{contactId, leadId, prospectId}` (lead/prospect recipients used to get an EMPTY context → literal `{{tokens}}` in sent emails); `sendDraft` (single send) now resolves vars like the bulk path; preview path's sender vars fixed (`mergeCtx.sender`, not top-level keys).
- **P1 `f7b5200` — Unipile webhook auth (OPT-IN, action required):** all event webhooks (mail/status/calendar/email-tracking) accepted unauthenticated POSTs → forged bounces/replies could suppress emails, pause sequences. Now verified against a `Unipile-Auth` header **when `UNIPILE_WEBHOOK_SECRET` is set**; register* admin actions pass it as Unipile's secretKey. Unset = unchanged behavior. **⚠️ USER ACTION: set `UNIPILE_WEBHOOK_SECRET` on Railway, then re-run the three register-webhook admin actions.** Residual: `/api/unipile/account-webhook` (Hosted-Auth notify_url) can't carry headers, stays open.
- **P1 `952c0eb`:** ARE `approveBatch` RESET the campaign counter to batch size (now recounts approved from the queue, drift-proof, workspace-scoped, returns real affectedRows); SCIM deprovision (PATCH `active:false` + DELETE) removed memberships in EVERY workspace (now scoped to the provider's workspace); `emailTemplates.save` rejected legacy `{blocks:[...]}` designData (now accepts both shapes, normalizes).
- **P1 `5831f9f` — send window was NEVER enforced:** per-sequence `sendWindowStart/End` + `skipWeekends` were editable but never consulted — emails went out any hour/day. Engine now gates email steps in the sequence's own IANA timezone (Intl-based `nowInTz`, no deps); per-sequence daily-cap key rolls at local midnight (workspace-wide cap stays UTC — no ws-level timezone exists). Sequences without saved settings now follow the editor's 08:00–18:00 default.
- **P2 `6133c0e`:** reply detection now honors each sequence's "Pause enrollment on reply" toggle (`settings.replyDetection` was a no-op — everything got paused); `bulkEnroll` now ALSO dedups by **email across contact/lead/prospect types** (a promoted prospect could be enrolled twice).
- **P2 `7661785`:** new `server/routers/are/llmJson.ts` `parseLlmJson` (strips markdown fences, throws descriptive error w/ payload snippet) at all 8 LLM JSON.parse sites; Social.tsx `connect`/`generateVariants` gained onError toasts.
- **P2 `7394c78`:** Prospects page resets to page 1 on filter change; removed dead `isRead`/`read` keys on notifications inserts (column is `readAt`).
- **Audited false alarms (do NOT re-fix):** stuck-"enriching" recovery exists (engine retries `enriching` rows each tick; failures persist `enrichmentError`); `/are/settings` is linked from ARE Hub SubNav; SequenceCanvas autosave closure is safe (timer in shared ref, react-query `mutate` safe from old closures); cs.ts:33/143 account reads aren't leaks (accountId comes from a scoped row); "two workspaces share id N" claims impossible (single auto-increment PKs).
- **Unverified agent-reported backlog (credible, NOT yet fixed):** `are/execution.ts processSignal` fetches rows by bare id (check the caller chain before "fixing"); areEngine dispatch prospect lookup by id only; per-prospect skip not validating campaignId; name+org dedup fragility (acme.com vs acme).

### Template-linked steps = Email Builder is source of truth (`09649e1`)
- Sequences right-panel Steps tab: linked steps show ONLY a clickable **"From template: <name> →"** deep-linking to `/email-builder/:id` (no subject/body dump).
- Edit dialog: linked steps render the template's CURRENT subject + formatted output **read-only** (sanitized) with the same link; **Detach** copies the template's current content for inline editing. Subject input + RichTextEditor only for unlinked steps.
- `handleSaveSteps` re-syncs linked steps from the template's current subject/htmlOutput (send engine reads steps JSON — a later template edit still needs one sequence re-save to reach in-flight sends).
- EmailClientPreview resolves linked steps against the live template list.

### Prospect-POV email preview (`6ba7083`, `d2e615f`, `1f0b9fb`, `4552b7d`)
- `client/src/components/usip/EmailClientPreview.tsx` — **Preview** button on the Sequences right panel (saved steps) AND in Edit→Steps (previews unsaved edits live).
- Gmail ↔ Outlook chrome toggle; **desktop + iPhone-app views** (Monitor/Smartphone toggle, auto-switches on mobile viewports via `useIsMobile`); step pills with day offsets from wait steps; editable "Preview as…" sample persona; client-side mirror of server mergeVars semantics (unknown tokens stay visible); bodies via `sanitizeEmailHtml`.
- Clipping lessons: 600px table templates need `[&_table]:max-w-full` (desktop) and `table-fixed w-full` (mobile frames); email canvas stays light in app dark mode on purpose.

### 🪤 NEW BUG CLASS — DialogContent `sm:max-w-lg` (memory `velocity-dialog-maxw-bugclass`)
`ui/dialog.tsx` DialogContent's default className ends with `sm:max-w-lg`; a consumer's bare `max-w-2xl` LOSES at ≥640px (different variants — tailwind-merge keeps both) → dialog silently renders 512px on desktop. **Always override with the same prefix: `sm:max-w-2xl`** (+ optional `max-w-[calc(100%-2rem)]`). A parallel-session sweep fixed all ~59 instances (`1b20ce9`, `ae1cbcf`, `83d0106`) — repo now has ZERO bare wide max-w on DialogContent. Don't reintroduce.

### Funnel/UX changes earlier in the session
- **Personas (`f7e73d9`, `42c9b5e`):** Preset library + "Your personas" cards are minimizable (chevron, localStorage `velocity_personas_presets_collapsed` / `velocity_personas_list_collapsed`), `shrink-0` (flex-collapse class), internal scroll (`max-h-[40vh]`/`[50vh]`).
- **Prospects (`2fd7bfe`):** promoted prospects leave the DEFAULT list (filter defaults to `not_promoted`); record + linkedLeadId kept, reachable via "Converted to lead"/"All prospects". Verified E2E with a temp prospect (created→promoted→disappeared→cleaned up).
- **ARE (`925ed3b`):** `are.prospects.list` excludes `sequenceStatus="skipped"` (= rejected) unless explicitly filtered — rejected prospects now appear ONLY in the Rejections tab (verified: campaign 7 went 11/11-duplicated → 0 Prospects / 11 Rejections).
- **Pipeline page data CLEARED (user-approved):** all 65 opportunities (ids 1–65, orphaned demo data) + Customer 16 (incl. QBRs/tickets/amendments via cs.delete) deleted via authenticated tRPC. Board verified 0.

## Live data state of LSI Media
- **Pipeline: 0 opportunities. Customers/Accounts/Contacts/Leads/Prospects: all 0** (orphan child rows like stage history may linger harmlessly — no FKs in schema).
- **Sequences:** 1 — "AI CONSULT - INITIAL OUTREACH" (id 10, paused), 1 email step **linked to template 6**; steps were edited down by the user mid-session.
- **Email templates:** 7 (ids 2–8); ALL re-saved this session so htmlOutput keeps `{{tags}}` (ids 6/7/8 = AI CONSULT steps; 2/3/4 legacy seeded; 5 untitled). Template 6 fixed: `{{firstName|there}}` / `{{company|your team}}`.
- ARE: 5 campaigns; campaign 7 "AI Audit - COO Operations Efficiency" has 11 rejected prospects (Rejections tab only).

## How this codebase works (essentials — unchanged)
- **Stack:** React + Vite + wouter + tRPC v11 + Drizzle ORM (mysql2) + Express. esbuild does NOT typecheck but FAILS on missing exports/unresolved imports — grep repo-wide before deleting an export. TS type errors only surface at runtime.
- Build runs on Railway (pnpm, frozen lockfile). Node 24 + Python 3.12 are installed locally but verify via: static review → commit → push → watch Railway → check live in Chrome. Don't add deps without updating pnpm-lock.yaml.
- **Schema** = drizzle journal 0000–0047 ∪ `server/_core/rawMigrations.ts` (0048+, idempotent; latest 0088; **next is 0089**). Schema changes go in `drizzle/schema.ts` AND rawMigrations.
- tRPC: `workspaceProcedure` etc.; **every DB query must filter by `ctx.workspace.id`** — the audit found unscoped ones; treat any caller-controlled id as hostile.
- Engine crons (`server/_core/index.ts`): `runAreEngine()` ~3min, `runPipelineAlertsCron()` ~15min, `processEnrollments()` (now enforces send window/timezone). `invokeLLM` outputSchema = `{name, schema}`. Email send: `sendWorkspaceEmail` / smtpConfig paths (both resolve merge vars now).
- Key gotchas live in the previous handoff's list — still valid: drizzle `.update()` returns `[ResultSetHeader, …]`; `prospects` ≠ `prospect_queue`; `getAreSettings` curated return; flex `min-h-0` trap + `shrink-0` bug class; Sheet/Dialog title rows need `pr-10`/`pr-12` clear of the close X; SubNav/PageHeader are `shrink-0`.
- **Reuse:** ConfirmButton / TableSkeleton / QueryError / SubNav / `EmailClientPreview`. Dark mode via theme tokens. New dialogs: `sm:max-w-*` overrides only.

## Git identity (every commit)
```bash
git -c user.name='igrant9679' -c user.email='206445972+igrant9679@users.noreply.github.com' \
  commit -m "$(cat <<'EOF'
<message>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
Commit + push per change. Stage specific files (parallel sessions may have dirty/untracked files — e.g. HANDOFF.md / UX_AUDIT.md at root belong to another session; leave them).

## Verification: Personal Chrome via Claude-in-Chrome MCP
- `list_connected_browsers` first and **ask which browser**; if names are generic, use `switch_browser` so the user picks in-Chrome ("Personal Chrome").
- Tools need `tabId` (`tabs_context_mcp({createIfEmpty:true})`). Driving tRPC via `javascript_tool` fetch (`/api/trpc/<proc>?batch=1...`, superjson: results under `result.data.json`, POST body `{"0":{json:{...}}}`) is the fastest server verification. Screenshots intermittently time out — retry. Long-running tabs' renderers degrade (async evals hang) — open a fresh tab. Login: user signs in themselves; the MCP tab needs its own session.
- Client-deploy canary: a behavior probe beats bundle-hash scans (entry hash doesn't change for chunk-only edits; transitive chunk scans freeze the renderer).

---

## Resume prompt for the new session
```
You're continuing Velocity / usip (igrant9679/usip → getvelocityai.app on Railway).
Repo: C:\Users\Admin\usip. Tip of main: 5831f9f (+ a handoff commit).

Read SESSION_HANDOFF.md at the repo root first (esp. the audit-fixes section and the
DialogContent sm:max-w-lg bug class).

State: a full functionality audit was completed and ALL approved fixes are shipped +
deployed (P0s: Email Builder demo-merge-value baking, two cross-tenant write holes;
P1s: lead/prospect merge vars, Unipile webhook auth (opt-in), approveBatch counter,
SCIM deprovision scope, legacy template save, send-window/timezone enforcement; P2s:
reply-pause toggle, cross-type enrollment dedup, LLM JSON parsing, pagination reset,
misc). Earlier in the session: prospect-POV email preview (Gmail/Outlook, desktop +
iPhone views), template-linked steps with Email Builder as source of truth, Personas
card minimize, promoted-prospects hidden from default list, ARE rejected-prospects
tab split, Pipeline demo data cleared, and a repo-wide dialog-width sweep. No open
task — wait for direction.

OPEN USER ACTION: set UNIPILE_WEBHOOK_SECRET on Railway, then re-run the three
register-webhook admin actions to activate webhook verification.

Unverified audit backlog (credible, not yet fixed — verify caller chains first):
are/execution.ts processSignal bare-id row fetches; areEngine dispatch prospect
lookup by id; skip mutation not validating campaignId; name+org dedup fragility.

Hard constraints (still apply):
- Build runs on Railway; pnpm frozen lockfile. Verify via static review → commit →
  push → watch Railway → check live in Chrome. Don't add deps without pnpm-lock.yaml.
- esbuild fails on missing exports; grep repo-wide before deleting an export.
- Schema changes go in drizzle/schema.ts AND server/_core/rawMigrations.ts (next: 0089).
- Commit + push per change, igrant9679 identity + Opus 4.8 co-author trailer; stage
  specific files (parallel sessions leave untracked files at root).
- Every DB query filters by ctx.workspace.id; treat caller-controlled ids as hostile.
- Plan first when non-trivial; user approves before large code lands.
- Reuse ConfirmButton / TableSkeleton / QueryError / SubNav / EmailClientPreview;
  theme tokens for dark mode; dialogs need sm:max-w-* overrides (never bare max-w-*).
- Always ask which Chrome browser before driving it (switch_browser if names generic).
- ui-ux-pro-max skill for UI/UX design work.

Live data: Pipeline/Customers/Accounts/Contacts/Leads/Prospects all EMPTY on LSI
Media. 1 paused sequence (id 10, 1 email step linked to template 6). 7 templates,
all with clean {{tags}} htmlOutput. Campaign 7 has 11 rejected prospects
(Rejections tab only).

After reading, briefly confirm current state, then wait for direction.
```
