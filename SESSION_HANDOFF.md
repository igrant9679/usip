# Velocity / usip — Session Handoff (Continue from here)

Refreshed at end of the **"Apollo-clone v2 IA build"** session. Paste the bottom block into a new chat to resume.

---

## Repo + deploy

- **Repo:** `igrant9679/usip` (origin: `https://github.com/igrant9679/usip.git`)
- **Local path:** `C:\Users\Admin\usip`
- **Deploy:** Railway → `https://getvelocityai.app/` (auto-deploys on push to `main`). **Deploys are slow this session — often 3–6 min, sometimes more.** Verify in a **fresh tab**, not the first reload. Screenshot capture via the Chrome MCP is flaky (frequent `Page.captureScreenshot` timeouts) — fall back to `get_page_text` to confirm state.
- **Tip of `main`:** `2a77d06`. Everything below is deployed + verified live on `getvelocityai.app`.

## What this session was

Building out the **redesigned `/v2/*` information architecture page-by-page, cloning Apollo's UI** from screenshots. The light sectioned sidebar (`Shell.tsx`) landed in a prior session; this session filled in the pages.

**Workflow facts (important):**
- **Reference designs come from screenshots**, not live Apollo. The Claude-in-Chrome MCP can only navigate an allow-listed domain set (`getvelocityai.app` works; `app.apollo.io` and all other third-party domains return **"Navigation to this domain is not allowed"** — a managed allow-list above Chrome's own site-access; the user cannot lift it). So Apollo layouts arrive as screenshots in **`C:\Users\Admin\Downloads\Apollo Screenshots\`**, organized by section (`00_home`, `01_ai-assistant`, `02_prospect-and-enrich`, `03_engage`). Read the PNGs with the Read tool.
- **Per-page rules the user set:** reproduce **layout/UX only** (NOT Apollo's logo/brand assets); **always ignore notification/warning banners and the bottom-right "?" AI-assistant FAB**. (Also: no floating "?" help button anywhere — the global purple HelpButton was removed from App.tsx earlier.)
- **Per page:** read screenshots → build a bespoke v2 page wired to real Velocity data where it exists → `npx esbuild` parse-check → commit + push → verify live (navigate + screenshot / `get_page_text`).

## This session's work (newest first)

### Home page + layout editor — `/v2/home`  (`f2adad6`, `2a77d06`)
`client/src/pages/usip/Home.tsx`. Apollo's home: "Welcome, {name} 👋" + Edit layout / Generate Pipeline, stacked widget cards. **Edit mode**: each widget gets a drag handle (HTML5 drag reorder) + delete; a floating **"+"** pinned to the **canvas top-right** opens the **Widget library** (categorised Execution / Recommended / Summary / Reports + "Already added" chips); widgets are **vertically resizable** (native `resize: vertical` grip on the body, heights captured on mouseUp); **Cancel / Save changes**. Layout order + per-widget heights persist to **localStorage** (`velocity_home_layout_v1`, `velocity_home_heights_v1`). Widgets wired to live data where cheap (Suggested leads→prospects, Top companies→accounts, Your tasks→tasks, Sequence stats→sequences, Email stats/Data health→`dataHealth.getMetrics`); rest are compact scaffolds. **The Home nav top-link now points at `/v2/home`** (Shell.tsx); the old Dashboard stays at `/` and under "More". (localStorage persistence is a v1 — server-side would follow across devices.)

### Engage / Sequences — `/v2/sequences` + builder `/v2/sequences/:id`  (`72b8e73`, `970c6e4`)
- `SequencesV2.tsx` — Apollo Sequences index: tabs (All Sequences / Analytics / Diagnostics), left filter rail (Starred, Owned by, **Status**, Tags, Performance, Folders, Shared by — Status + Owned-by-me are functional), table wired to `sequences.list`. "Create sequence" → **choice modal** (AI-assisted / Templates / From scratch) → New Sequence dialog → `sequences.create` → navigates to the editor.
- `SequenceEditor.tsx` — the **step builder**. Tabs (Editor / Contacts / Activity / Report / Settings). Editor = ordered step list + "Add a step" picker (Automatic/Manual email, Phone call, Action item, LinkedIn invite/message, Wait), inline per-step editors (subject/body, days, notes), reorder + delete, persisting via **`sequences.updateSteps`** (step schema: email/wait/task/linkedin_dm/linkedin_invite). Settings edits name/description via `sequences.update`.

### Data enrichment — `/v2/data-enrichment`  (`a42bf33`)
`DataEnrichment.tsx`. Tabbed (Data health center / CRM / CSV / Job change alerts / Form enrichment). Health center: top stats + 6-card grid; 3 **inline-SVG donuts** (email completeness, phone completeness, enrichment freshness) + stats wired to **`dataHealth.getMetrics`**; CRM/CSV are connect/upsell landings; Job change/Form are coming-soon.

### Lists — index `/v2/lists` + detail `/v2/lists/:id`  (`d902789`, `ae260f3`)
- **New static-list backend** (segments are dynamic rule-based over contacts and can't hold explicit membership): **migration 0093** `record_lists` + `record_list_members`; new router **`server/routers/recordLists.ts`** (list/get/create/delete/members/addMembers/removeMember), registered in `server/routers.ts`. People lists hold prospects, Companies lists hold accounts.
- `Lists.tsx` — Apollo "My lists": People + Companies collapsible groups, create dialog (object picker + name), search/sort.
- `ListDetail.tsx` — breadcrumb + object badge + record count, Add-records dropdown, toolbar, members table (joined to prospect/account rows) with per-row remove, empty-state cards, and a **mini-lookup modal** (search prospects/accounts → multi-select → `addMembers`). **Full flow verified live** (created "VIP prospects", added 3 prospects).

### People Education filter made real  (`936f61c`)
**migration 0092** adds `prospects.education` (varchar 200). People page's Education filter moved out of the locked "Advanced" list into a real working text filter (+ shown in the detail panel). NULL until enrichment populates it (no extractor yet).

### Companies — `/v2/companies`  (`7e97f4e`)
`Companies.tsx`. Apollo "Find companies" — same filter-rail-as-fulcrum pattern as People, on **`trpc.accounts.list`** (already the Accounts data source; deep-links to `/accounts/:id`). All client-side filter/facet/sort/paginate; facets (Industry / # Employees / Revenue / Location) derived from the data with live counts.

### People — `/v2/people`  (`0627c9c`, density `e2d5263`)
`People.tsx`. Apollo "Find people" — the **filter rail is the fulcrum**. Wired to `trpc.prospects.list` (server filters: emailStatus/verification/promoted/hasEmail; client refinement: search/title/company/location/industry/education/tier/seniority + sort). Toolbar, results table, detail panel, AI empty state, More-filters dialog.

### AI Assistant / Deliverability / Calls / Website Visitors  (`22ffd65`)
- `/v2/ai-assistant` `AIAssistant.tsx` — working chat on `helpCenter.startConversation`/`askAI` (answers + sources + confidence). Verified live.
- `/v2/deliverability` `Deliverability.tsx` — hub over `sendingAccounts.list` + `emailSuppressions.summary` + `senderPools.list`. (30 real sending accounts in this workspace.)
- `/v2/calls` `Calls.tsx` — call queue from `tasks.list` filtered `type==='call'` + `tasks.setStatus`.
- `/v2/website-visitors` `WebsiteVisitors.tsx` — standalone scaffold (no tracking backend), install-snippet + companies table.

### Sidebar colour system  (`0b5a7f6`, `3bc2796`, `e390153`)
`Shell.tsx`: per-section colours restored (bright 500-level: Prospect blue `#3B82F6`, Engage violet `#9333EA`, Win deals emerald `#10B981`, Tools amber `#F59E0B`, Inbound teal `#14B8A6`, Saved rose `#F43F5E`); active items are tinted/shaded pills with a colour glow; **`resolveAccent(location)`** publishes a per-route accent on `AccentContext` so every PageHeader/StatCard/SubNav adopts its section hue; "More" section icons coloured by functional area via `LEGACY_COLOR_BY_HREF`.

### Section→existing-page wiring, then REVERTED  (`94d926c`, then `a3628fd`)
`94d926c` pointed the remaining v2 items at existing pages; `a3628fd` **reverted it** per the user — they want each built fresh, not linked. So those routes are **placeholders again**. Existing pages stay reachable under "More".

## 🟡 v2 route status (what's built vs placeholder)

**Built (bespoke, real data):** `/v2/home`, `/v2/ai-assistant`, `/v2/people`, `/v2/companies`, `/v2/lists` (+`/:id`), `/v2/data-enrichment`, `/v2/sequences` (+`/:id`), `/v2/calls`, `/v2/deliverability`, `/v2/website-visitors`.

**Still `<Placeholder>` (build next, page-by-page from screenshots):** `/v2/emails`, `/v2/tasks`, `/v2/meetings`, `/v2/conversations`, `/v2/deals`, `/v2/workflows`, `/v2/analytics`, `/v2/saved-people`, `/v2/saved-companies`, `/v2/forms`. (No Apollo screenshots captured for these yet — ask the user for the relevant `Apollo Screenshots\` subfolder before building each.)

## 🪤 Bug classes (do not reintroduce)
- **DialogContent `sm:max-w-lg`:** `ui/dialog.tsx` default ends with `sm:max-w-lg`; a bare `max-w-2xl` LOSES at ≥640px. Always override with the same prefix: `sm:max-w-2xl`.
- **Flex-collapse:** bare top-level flex rows under the shell need `shrink-0` or they collapse / steal clicks; `min-h-0` on flex children that scroll. The v2 pages use `flex flex-col h-full min-h-0` roots (PageTransition is `height:100%` flex-col, so `h-full` resolves).
- **Migration drift:** schema = drizzle journal ∪ `server/_core/rawMigrations.ts`. Schema changes go in BOTH `drizzle/schema.ts` AND rawMigrations. **Latest applied: 0093** (record_lists). **Next is 0094.** Idempotent (tolerated errnos 1050/1060/1061/1091/1146/1826), run ~5s post-boot.

## 🔑 Auth model (durable — read before touching auth/invites)
- **Native email + password (`server/passwordAuth.ts`). Manus/Meta OAuth was REMOVED; `/api/oauth/callback` is 410.** Do not reintroduce OAuth redirects.
- **No `/login` route.** Login/signup UI is the `Landing` component **inside `client/src/App.tsx`** (rendered by `AuthGate` when unauthenticated; posts to `/api/auth/password-login` or `/api/auth/register`; reads `?returnPath=`). `client/src/pages/PasswordLogin.tsx` is unrouted — ignore it.
- **`/api/auth/register` upgrades an invite placeholder in place.** Invite lifecycle: `openId "invite:<email>"`, `loginMethod "invite"`→`"expired_invite"` (nightly)→real method on acceptance; `inviteToken` non-null ⇔ unaccepted. 7-day expiry default.

## How this codebase works (essentials)
- **Stack:** React + Vite + wouter + tRPC v11 + Drizzle ORM (mysql2) + Express. **Node 20** in prod. esbuild does NOT typecheck but FAILS on missing exports/unresolved imports — grep before deleting an export. TS errors only surface at runtime.
- **No local run toolchain.** Verify with `npx esbuild <file>.tsx --loader:.tsx=tsx --jsx=automatic --outfile=/dev/null` (client parse) or `npx esbuild server/_core/index.ts --platform=node --packages=external --bundle --format=esm --outfile=/dev/null` (server bundle incl. schema/migrations). Then commit → push → watch Railway → check live. pnpm frozen lockfile — don't add deps.
- **tRPC:** `workspaceProcedure`; **every DB query filters by `ctx.workspace.id`**; validate caller-controlled ids (ownership → 404).
- **Reuse:** Shell / PageHeader / StatCard / `useAccentColor` from `components/usip/Shell`; shadcn `ui/*` (Button sizes incl. `icon-sm`; Dialog, DropdownMenu, Checkbox, Badge…); `cn` from `@/lib/utils`; `useAuth` from `@/_core/hooks/useAuth`; lucide-react (NO brand icons — use generic for LinkedIn). New v2 pages follow the People/Companies template (compact header `h-11` + accent top rule).

## Live data state — LSI Media (workspace id 2)
- **Prospects:** ~86 (visible on /v2/people). **Accounts/Contacts:** empty ("No accounts yet"). **Sending accounts:** 30 (Mailpool.ai). **Tasks:** several incl. call-type. **Sequences:** "AI CONSULT - INITIAL OUTREACH" (id 10, paused, 5 steps).
- **Test artifacts created this session (safe to delete):** record list **"VIP prospects"** (id 1, 3 prospects) on /v2/lists; sequence **"AI outbound sequence"** (id 11, draft, 3 steps) from the AI-assisted create test.

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
- `list_connected_browsers` → `select_browser` (the local browser, named "Browser 1" this session) → `tabs_context_mcp({createIfEmpty:true})`. Session runs as **idris** (super_admin) on getvelocityai.app.
- **Only getvelocityai.app navigates** (allow-list). Reference designs = screenshots, never live Apollo.
- Screenshots time out often when the page is busy — `get_page_text` is the reliable fallback to confirm rendered content. After a deploy, a FRESH tab avoids the stuck-renderer state.

---

## Resume prompt for the new session
```
You're continuing Velocity / usip (igrant9679/usip → getvelocityai.app on Railway).
Repo: C:\Users\Admin\usip. Tip of main: 2a77d06.

Read SESSION_HANDOFF.md at the repo root first — especially "What this session was"
(the Apollo-clone workflow), the v2 route status, "Auth model", and "Bug classes".

This session = cloning Apollo's UI into the redesigned /v2/* IA, page-by-page, from
SCREENSHOTS in C:\Users\Admin\Downloads\Apollo Screenshots\ (browser control can't reach
app.apollo.io — managed allow-list; only getvelocityai.app is navigable). Per page:
read the screenshots, build a bespoke v2 page wired to real Velocity data where it
exists, parse-check with esbuild, commit+push, verify live. ALWAYS ignore notification
banners and the bottom-right "?" FAB; layout/UX only (no Apollo brand assets).

BUILT this session (all deployed + verified): /v2/home (home + layout editor: drag/
resize/add widgets, localStorage), /v2/ai-assistant (helpCenter chat), /v2/people
(prospects; Education filter is now real via migration 0092), /v2/companies (accounts),
/v2/lists + /v2/lists/:id (NEW static-list backend — migration 0093 record_lists/
record_list_members + server/routers/recordLists.ts; add-records mini-lookup),
/v2/data-enrichment (dataHealth donuts), /v2/sequences + /v2/sequences/:id (Engage index
+ step builder on sequences.updateSteps), /v2/calls, /v2/deliverability, /v2/website-
visitors. Sidebar got per-section colours + dynamic per-route accent (resolveAccent in
Shell.tsx). Home nav now points at /v2/home (Dashboard stays at "/" + under More).

STILL PLACEHOLDER (build next, ask user for the screenshot subfolder first):
/v2/emails, /v2/tasks, /v2/meetings, /v2/conversations, /v2/deals, /v2/workflows,
/v2/analytics, /v2/saved-people, /v2/saved-companies, /v2/forms. (94d926c had wired these
to existing pages; a3628fd REVERTED that per the user — build fresh, don't link.)

Hard constraints:
- Build runs on Railway (Node 20); pnpm frozen lockfile; deploys are SLOW (3-6 min) —
  verify in a fresh tab; Chrome screenshots flake, use get_page_text.
- esbuild fails on missing exports; grep before deleting one. Verify via parse-check →
  commit+push → live check.
- Schema changes go in drizzle/schema.ts AND server/_core/rawMigrations.ts (next: 0094).
- Commit+push per change, igrant9679 identity + "Co-Authored-By: Claude Opus 4.8 (1M
  context)" trailer; stage specific files (leave HANDOFF.md / UX_AUDIT.md).
- Every DB query filters by ctx.workspace.id; validate caller ids.
- Dialogs need sm:max-w-* (never bare max-w-*); flex rows under shell need shrink-0.
- Auth is native email+password; no /login route (Landing in App.tsx); OAuth removed.

Live data: LSI Media (ws id 2). ~86 prospects; accounts/contacts empty; 30 sending
accounts; sequence id 10 paused. Test artifacts (safe to delete): list "VIP prospects"
(id 1, 3 records), sequence "AI outbound sequence" (id 11, draft).

OPEN: (1) build the remaining v2 placeholder pages from screenshots; (2) optional: delete
the two test artifacts; (3) prior-session: set UNIPILE_WEBHOOK_SECRET on Railway + re-run
3 register-webhook actions; (4) if instance crashes, grep Railway logs for [FATAL-GUARD].

After reading, briefly confirm current state, then wait for direction.
```
