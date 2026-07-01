# Velocity / usip — Session Handoff (Continue from here)

Refreshed at the end of the **"People top-action controls + full compliant LinkedIn enrichment system (Unipile, one-click)"** session. Paste the bottom block into a new chat to resume.

---

## Repo + deploy

- **Repo:** `igrant9679/usip` (origin: `https://github.com/igrant9679/usip.git`)
- **Local path:** `C:\Users\Admin\usip`
- **Deploy:** Railway → `https://getvelocityai.app/` (auto-deploys on push to `main`). **Deploys are slow — 3–6 min.** Verify in a **fresh tab**. Chrome MCP screenshots flake (`Page.captureScreenshot` timeouts) — fall back to `get_page_text`, or measure with the `javascript_tool` (`getBoundingClientRect`), or call tRPC endpoints directly via `fetch` (see Verification).
- **Tip of `main`:** `c46c84f`. Everything below is pushed.

## What this session was

Two big threads, both shipped + verified live:
1. **People page top-action controls** — built out the five toolbar controls + the selected-row toolbar to match the Apollo reference, and made the results table **column-driven**.
2. **A complete, compliant LinkedIn enrichment system** on the **authorized Unipile** vendor layer (NO scraping) — from schema → services → router → daily worker → UI indicators across the People experience → a batch-import page → and finally a **one-click "Enrich"** workflow (no upload/paste/manual-match for confident records) + admin cleanup procedures.

## This session's work (newest first)

### LinkedIn enrichment — one-click "Enrich" + cleanup  (`c46c84f`, `600ae63`, `34bb48c`, `40d5867`, `b138073`)
The user clicks **Enrich** and Velocity runs the whole workflow automatically — no URL upload, no manual matching for confident records.
- **Migration 0096** — `linkedin_enrichment_jobs` + `linkedin_enrichment_job_items` (prospect-oriented Enrich jobs; the URL-upload batch tables stay for the admin import page).
- **`server/services/linkedinEnrichment/`** new: `lookupStrategy.ts` (resolves how to enrich WITHOUT a URL: existing prospect URL → CRM/`enrichmentData` → prior enrichment → provider URL → **authorized Unipile name/company lookup** → `unavailable`), `orchestrator.ts` (`runForProspects`/`runForList` → creates a job + items, processes **async** via an unawaited `processJob`; per prospect: eligibility → strategy → Unipile retrieve → **intended-prospect** match → auto-apply/needs_review/conflict/unavailable → persist; one failure never blocks the batch; successful enrichment auto-enables daily monitoring because the daily worker picks up any enrichment row). `unipileProfile.retrieveByNameCompany` + `mapper.mapSearchHitToProfile` (classic people-search when no URL). `matching.scoreIntendedMatch` (validates vs the INTENDED prospect: +50 user-initiated, −60/−35 conflicts; auto-apply ≥75, or 50–74 only on a single-prospect run; `<50`/conflict → needs_review/conflict, never overwrites).
- **Router** procedures: `run`, `runForList`, `getJob`, `getJobItems` (health-gated, activity-logged) + **admin cleanup**: `deleteBatch`, `deleteJob`, `deleteProspectEnrichment` (removes enrichment + snapshots + change history; clears an enrichment-sourced photo back to `unknown`; preserves user uploads).
- **Frontend**: shared **`useEnrichJob()`** hook (runs the orchestrator, polls `getJob`, toasts progress `enriched·needs review·conflict·skipped·failed`, invalidates caches). **Enrich buttons**: People **bulk** menu (see NEXT note), **open drawer**, **full-profile** panel empty-state, ListDetail **"Enrich all"** (people lists).
- ⚠️ Per user: the People **bulk** Enrich dropdown now shows only **"Enrich emails"** and **"Enrich job change"** (both still `toast` placeholders) — the dedicated "Enrich LinkedIn profiles" item was **removed as redundant** (enrichment auto-uses the LinkedIn profile). So the *bulk* one-click LinkedIn run currently has no button; single-prospect (drawer/full profile) + whole-list ("Enrich all") remain.
- **Verified live:** one-click `run` on prospect 102 → strategy `existing_prospect_linkedin_url` auto-resolved → `exact_match` (score 205) → `enriched`, job completed with zero manual steps. Enrich buttons render in drawer + (former) bulk menu. All session test artifacts then **deleted** via the cleanup procs.

### LinkedIn enrichment — import page + indicators + backend  (`b654635`, `a3b5a19`, `893a037`, `5afedd1`)
- **Migration 0095** — 6 tables: `linkedin_enrichment_batches`/`_batch_rows`, `prospect_linkedin_enrichments`, `prospect_linkedin_field_snapshots`, `prospect_linkedin_field_changes`, `linkedin_daily_check_jobs`. Int PKs (the spec's UUID/Postgres DDL adapted to this schema's convention).
- **Backend** (`server/services/linkedinEnrichment/`): `mapper.ts` (URL validate/normalize + Unipile→Velocity map), `unipileProfile.ts` (`retrieveLinkedInProfileByUrl`/`ByIdentifier` — wraps the existing rate-limited `services/linkedinLookup`), `matching.ts` (scored DB-wide match + `canAutoApply`), `snapshot.ts` (snapshot hash + change detection with **noise suppression** — case/whitespace/punctuation/array-reorder), `enrichmentService.ts` (upsert enrichment, snapshots, field-changes, compact change-summary selectors, acknowledge; **mirrors a permitted photo through the existing `profileImage` compliance gate** as `source=enrichment_provider`, never over a user upload), `health.ts`, `dailyCheck.ts` (per-workspace worker; skips <24h/suppressed; respects the per-account cap). Daily worker scheduled ~01:00 in `server/_core/index.ts`.
- **Indicators across the 4 surfaces** — `client/src/components/usip/people/LinkedInEnrichment.tsx`: `LinkedInUpdateIndicator` (compact priority-coloured pill + click popover w/ field·old→new·date·*Source: Unipile* + "Mark as seen"; generic `Link2` icon), `LinkedInEnrichmentSummaryCard` (open drawer), `LinkedInEnrichmentFullPanel` (full profile). Wired into the People table name cell + ListDetail name cell (batched `getChangeSummaries`), the People click-drawer, and ProspectDetail.
- **Import page** `/v2/data-enrichment/linkedin` (entry: People → Import → "Enrich from LinkedIn") — health banner, daily-check card, paste box + CSV upload → `createBatch` validation preview → `runBatch` → result counts + **inline** match-review (Match #id / Create new / Skip).
- **Compliance (durable):** retrieval is **Unipile-only** (rate-limited, audited) — no scraping/browser-automation/HTML-parsing. Suppressed/`rejected` prospects are never refreshed/displayed. Enrichment is **optional metadata** — failures never block the People experience. Photos: user chose to store the Unipile `profile_picture_url` and display it through the compliance gate as an authorized-provider image.

### People top-action controls + selection toolbar  (`9515321`)
Extracted into `client/src/components/usip/people/`. `peopleShared.tsx` (column registry driving the table, field catalogue, sort, helpers). **Default view** (popover: search, tabs, System pill, Create saved search), **Research with AI** (purple dropdown → placeholder modal; Assistant → `/v2/ai-assistant`), **Create workflow** (dropdown → modal + selection empty-state popover), **Sort** (popover: field Select + direction + Apply-disabled-until-field), **Search settings** (right Sheet, settings/create modes, **Fields** panel reorders/removes columns + Add-fields catalogue, **Filters** panel removable pills). **SelectionToolbar** (Clear/Save/Email/Sequence/Workflow/Add to list/Export/Enrich/Research with AI/Push to CRM/More — Sequence + Add-to-list wired to real routers; rest placeholders). Table is now **column-driven** from `COLUMN_REGISTRY` + `visibleColumns` with a `+ Add column` header.

## 🟡 v2 route status

**Built (bespoke, real data):** `/v2/home`, `/v2/ai-assistant`, `/v2/people` (now with the full top-action controls + LinkedIn indicators), `/v2/companies`, `/v2/lists` (+`/:id`, with "Enrich all" + indicators), `/v2/data-enrichment` (+**`/linkedin`** import page — NEW), `/v2/sequences` (+`/:id`), `/v2/calls`, `/v2/deliverability`, `/v2/website-visitors`.

**Still `<Placeholder>`:** `/v2/emails`, `/v2/tasks`, `/v2/meetings`, `/v2/conversations`, `/v2/deals`, `/v2/workflows`, `/v2/analytics`, `/v2/saved-people`, `/v2/saved-companies`, `/v2/forms`. (Build from `docs/specs/` + the matching `Apollo Screenshots/` subfolder.)

## 🔌 Unipile integration (reuse — do NOT duplicate)
A full Unipile integration already exists and is reused everywhere: `server/lib/unipile.ts` (client), `server/routers/unipile.ts`, `server/unipileWebhook.ts`, the `unipile_accounts` table (LINKEDIN), `ConnectedAccounts.tsx` UI, env `UNIPILE_API_KEY`/`UNIPILE_DSN`/`UNIPILE_WEBHOOK_SECRET`. **`server/services/linkedinLookup.ts`** is the compliant, rate-limited URL→profile retrieval layer (per-account daily cap via `linkedin_daily_usage`, audit via `linkedin_lookup_log`) that ALL enrichment retrieval routes through. Live workspace (LSI Media, ws 2) has one connected LinkedIn account ("Idris Grant", OK).

## 🪤 Bug classes (do not reintroduce)
- **DialogContent `sm:max-w-*`:** `ui/dialog.tsx` default ends `sm:max-w-lg`; a bare `max-w-2xl` LOSES at ≥640px. Always use the `sm:` prefix.
- **Flex-collapse:** bare top-level flex rows under the shell need `shrink-0`; `min-h-0` on scrolling flex children.
- **Migration drift:** schema = drizzle journal ∪ `server/_core/rawMigrations.ts`. Changes go in BOTH `drizzle/schema.ts` AND rawMigrations. **Latest applied: 0096** (LinkedIn enrichment jobs). **Next is 0097.** Idempotent (errnos 1050/1060/1061/1091/1146/1826 tolerated), runs ~5s post-boot. Repo uses **int AUTO_INCREMENT PKs** everywhere — adapt UUID-style specs to int.

## 🔑 Auth model (durable)
- **Native email + password (`server/passwordAuth.ts`). Manus/Meta OAuth REMOVED; `/api/oauth/callback` is 410.** No `/login` route — login/signup is the `Landing` component **inside `client/src/App.tsx`**. `/api/auth/register` upgrades an invite placeholder in place. Roles: `super_admin > admin > manager > rep` (`workspaceMembers.role`; helpers `adminWsProcedure`/`superAdminProcedure` in `server/_core/workspace.ts`).

## How this codebase works (essentials)
- **Stack:** React + Vite + wouter + tRPC v11 + Drizzle (mysql2) + Express. **Node 20** prod.
- **No local run/test toolchain.** `npm`/`vitest` deps are **not installed** — only the standalone `esbuild` binary runs via `npx`. **Verify by parse-check:**
  - client: `npx esbuild <file>.tsx --loader:.tsx=tsx --jsx=automatic --bundle --packages=external --alias:@=./client/src --outfile=/dev/null` (the `--alias` makes esbuild resolve `@/…` to the real UI files, catching missing named exports; without it `@/` is treated as external and only syntax is checked).
  - server bundle: `npx esbuild server/_core/index.ts --platform=node --packages=external --bundle --format=esm --outfile=/dev/null` (incl. schema/migrations/routers).
  - esbuild does NOT typecheck, and won't catch an *undefined-but-unimported* JSX identifier — so keep imports honest. The build is `vite build` (esbuild transpile, no `tsc`), so unused imports/type errors don't fail it, but **unresolved imports/exports do**. Drizzle inserts use `as never` casts (matches existing code). Tests (`*.test.ts`, vitest) ship for CI, can't run locally.
- **tRPC:** `workspaceProcedure`; **every DB query filters by `ctx.workspace.id`**; validate caller ids → 404. `ctx.workspace.id`, `ctx.user.id`, `ctx.member.role`. Register routers in `server/routers.ts`.
- **Reuse:** `Shell`/`PageHeader`/`StatCard`/`useAccentColor` from `components/usip/Shell`; shadcn `ui/*` (incl. `command`, `popover`, `sheet`, `select`, `tabs`, `scroll-area`); `cn` from `@/lib/utils`; `useAuth` from `@/_core/hooks/useAuth` (role on `user.role`); lucide-react ^0.453 (**NO brand icons** — generic `Link2` for LinkedIn; `FunctionSquare` renamed → use `Sigma`); `recordAudit` from `server/audit.ts`; activities via `db.insert(activities)` (`type: "linkedin"`, `relatedType: "prospect"`).

## Live data state — LSI Media (workspace id 2)
- **Prospects:** ~86 (`/v2/people`), all with LinkedIn URLs. **Accounts/Contacts:** empty. **Sending accounts:** 30. **Sequences:** id 10 paused. **1 connected LinkedIn Unipile account** ("Idris Grant"). No prospect currently has LinkedIn enrichment (this session's test enrichments on 93/102 were cleaned up).
- **Old test artifacts (safe to delete):** record list **"VIP prospects"** (id 1, ~3 members); sequence **"AI outbound sequence"** (id 11, draft).

## Git identity (every commit)
```bash
git -c user.name='igrant9679' -c user.email='206445972+igrant9679@users.noreply.github.com' \
  commit -m "$(cat <<'EOF'
<message>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
Commit + push per change. **Stage specific files** (never `git add -A`). Untracked `HANDOFF.md` / `UX_AUDIT.md` at root belong to another session — leave them.

## Verification: Chrome via Claude-in-Chrome MCP
- `list_connected_browsers` → `select_browser` ("Browser 1") → `tabs_context_mcp({createIfEmpty:true})`. Runs as **idris** (super_admin) on getvelocityai.app.
- **Only getvelocityai.app navigates** (allow-list). Apollo references are SCREENSHOTS in `C:\Users\Admin\Downloads\Apollo Screenshots\`.
- Screenshots flake — prefer `javascript_tool` measurement or **calling tRPC directly**: `GET /api/trpc/<proc>?input=<encoded {"json":input}>` for queries, `POST /api/trpc/<proc>` body `{"json":input}` for mutations (same-origin cookies = authenticated). A query returning `null` comes back as `{result:{data:{json:null}}}` — read `.result.data.json`, don't `??`-chain it (that mis-reads null as missing). Deploy probe (backend-only): an unauth POST/GET to a new proc returns `UNAUTHORIZED` once deployed vs `NOT_FOUND` ("No procedure found") on the old build.
- Gotchas: a **backgrounded** automation tab pauses Radix exit animations (a *closed* dialog/sheet stays mounted with `data-state="closed"`) and Radix **DropdownMenu** opens on `pointerdown` not synthetic `.click()` (Popover/Dialog/Sheet open on click). REPL `let`/`const` persist across `javascript_tool` calls — wrap snippets in `await (async () => {…})()`.

---

## Open items
1. **Build the remaining v2 placeholder pages** from `docs/specs/` + the matching `Apollo Screenshots/` subfolder.
2. **LinkedIn enrichment minor gaps:** People **row-kebab** Enrich (rows currently open the drawer, which has Enrich); a **bulk** one-click LinkedIn Enrich entry (removed from the Enrich menu as redundant — decide if/where it belongs); the **account-contacts** table Enrich (optional); a **job-results review side-panel** (today: completion toast with counts; `needs_review`/`conflict` items persist in `linkedin_enrichment_job_items`). Richer profile fields (experience/skills/company) need a Sales-Navigator-tier Unipile call — the classic profile only returns name/headline/location/photo.
3. **Promote the remaining client-side People filters** (ICP tier, seniority, sort) to server-side (text filters already are).
4. Optionally delete the two old test artifacts (list id 1, sequence id 11).
5. Prior-session: set `UNIPILE_WEBHOOK_SECRET` on Railway + re-run 3 register-webhook actions (if not done).
6. If the instance crashes, grep Railway logs for `[FATAL-GUARD]`.

---

## Resume prompt for the new session
```
You're continuing Velocity / usip (igrant9679/usip → getvelocityai.app on Railway).
Repo: C:\Users\Admin\usip. Tip of main: c46c84f.

Read SESSION_HANDOFF.md at the repo root first — especially "What this session was",
the Unipile integration (reuse, don't duplicate), "Bug classes", "How this codebase
works" (no local test toolchain; verify via esbuild parse-check + direct tRPC fetch),
and the LinkedIn enrichment sections.

Context: Apollo is the functional reference, delivered as SCREENSHOTS in
C:\Users\Admin\Downloads\Apollo Screenshots\ (browser control can't reach app.apollo.io;
only getvelocityai.app is navigable). Reproduce layout/UX only — no Apollo brand assets,
icons, colors, or wording.

This session shipped:
- People page top-action controls (Default view / Research with AI / Create workflow /
  Sort / Search settings) + selected-row toolbar, and a COLUMN-DRIVEN results table.
  Modular components under client/src/components/usip/people/.
- A complete compliant LinkedIn enrichment system on the AUTHORIZED Unipile layer (NO
  scraping): migrations 0095 + 0096; services under server/services/linkedinEnrichment/
  (mapper, unipileProfile, matching, snapshot, enrichmentService, health, dailyCheck,
  lookupStrategy, orchestrator); router linkedinEnrichment (status, batch import, run/
  runForList/getJob/getJobItems, prospect enrichment/changes/acknowledge/manualRefresh,
  dailyCheck run/status, admin deleteBatch/deleteJob/deleteProspectEnrichment); a daily
  monitoring worker wired into _core/index.ts (~01:00); compact update indicators across
  the People tab, list views, open drawer, and full profile; an import page at
  /v2/data-enrichment/linkedin; and a ONE-CLICK "Enrich" flow (no upload/paste/manual
  match for confident records) with an orchestrator + intended-prospect matching + a
  useEnrichJob() hook + Enrich buttons on the open drawer, full profile, and list
  ("Enrich all"). Verified live end-to-end.

⚠️ Compliance (must hold): LinkedIn retrieval is Unipile-ONLY, reusing the existing
rate-limited server/services/linkedinLookup — NO scraping, browser automation, cookies,
session hijacking, or HTML parsing. Suppressed/rejected prospects are never refreshed or
displayed. Enrichment is optional metadata; failures never block the People page. Photos
come only via the profileImage compliance gate (Unipile image as authorized provider, or
user upload). Direct LinkedIn scraping was declined earlier and stays declined; the
compliant Unipile path is the approved replacement and is now built.

Hard constraints:
- Build runs on Railway (Node 20); deploys SLOW (3-6 min) — verify in a fresh tab;
  Chrome screenshots flake (use get_page_text / javascript_tool / direct tRPC fetch).
- No local test deps — only `npx esbuild` runs. Verify client via
  `npx esbuild <f>.tsx --loader:.tsx=tsx --jsx=automatic --bundle --packages=external --alias:@=./client/src --outfile=/dev/null`
  and server via `npx esbuild server/_core/index.ts --platform=node --packages=external --bundle --format=esm --outfile=/dev/null`.
  Then commit+push, watch Railway, live-check. Tests ship for CI.
- Schema changes go in drizzle/schema.ts AND server/_core/rawMigrations.ts (next: 0097).
  Int AUTO_INCREMENT PKs.
- Commit+push per change, igrant9679 identity + "Co-Authored-By: Claude Opus 4.8 (1M
  context)" trailer; stage specific files (leave HANDOFF.md / UX_AUDIT.md).
- Every DB query filters by ctx.workspace.id; validate caller ids.
- Dialogs need sm:max-w-* (never bare max-w-*); flex rows under shell need shrink-0.
- lucide ^0.453: no brand icons (Link2 for LinkedIn); FunctionSquare→Sigma.
- Auth is native email+password; no /login route (Landing in App.tsx); OAuth removed.

Live data: LSI Media (ws 2). ~86 prospects (all have LinkedIn URLs); accounts/contacts
empty; 30 sending accounts; sequence id 10 paused; 1 connected LinkedIn Unipile account
("Idris Grant"). No prospect currently has LinkedIn enrichment (test data cleaned). Old
test artifacts (safe to delete): list "VIP prospects" (id 1), sequence id 11.

Built v2: home, ai-assistant, people, companies, lists(+/:id), data-enrichment
(+/linkedin), sequences(+/:id), calls, deliverability, website-visitors.
Still placeholder (build from docs/specs/ + screenshots): emails, tasks, meetings,
conversations, deals, workflows, analytics, saved-people, saved-companies, forms.

OPEN: (1) build remaining v2 placeholders; (2) LinkedIn minor gaps — row-kebab Enrich,
a bulk one-click LinkedIn Enrich entry (removed from the Enrich menu as redundant),
account-contacts Enrich, a job-results review side-panel, richer profile fields (Sales-
Nav-tier); (3) promote remaining client-side People filters (tier/seniority/sort) to
server-side; (4) delete 2 old test artifacts (list id 1, sequence id 11); (5)
UNIPILE_WEBHOOK_SECRET on Railway + 3 register-webhook actions; (6) [FATAL-GUARD] in logs
if it crashes.

After reading, briefly confirm current state, then wait for direction.
```
